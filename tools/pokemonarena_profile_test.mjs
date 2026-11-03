#!/usr/bin/env node
// POKEMONARENA PROFILE / STORE / TEAM CODE / IDENTITY TEST  (stage C3 / workstream R2)
//
// Proves that pokemonarena/js/profile.js, store.js, teamcode.js and identity.js do what they claim, against the REAL pack
// decoded from the pinned ROM where rules matter, and that the checks themselves can fail:
//
//   * ONE SUITE of named checks (`profile/...`, `team/...`, `identity/...`, `store/...`, `purity/...`) is defined as data and
//     can be run against ANY set of module sources. First against the real files, then against each MUTANT.
//   * MUTANTS: one-snippet edits of the four modules (a dropped guard, a flipped order, a checksum that is never compared,
//     a probe that no longer writes, ...). Each names the check(s) that MUST fail for it. The harness refuses a mutant whose
//     target snippet is not found exactly the stated number of times, so a refactor cannot silently turn one into a no-op.
//   * TWINS: the unmutated sources go through the SAME loader (data: URL imports) and must pass every check silently.
//   * DATA MUTANTS: a damaged fixture / expectation must make the golden checks fail.
//   * COVERAGE: every code in PROFILE_CODES, IMPORT_CODES, TEAMCODE_ERRORS and every identity state has a case that fires it
//     (and the matrix fails if a code is added without one).
//   * GOLDEN FIXTURES live in tools/fixtures/pokemonarena/ (synthetic: ids and counts only, no ROM content). The expected
//     v2 documents were written by hand from the v1 inputs, not captured from the code under test.
//   * CONTRACT: the adapter contract in store.js runs against the in-memory adapter here, against three deliberately broken
//     adapters (which must each fail named cases), and against REAL IndexedDB in tools/pokemonarena_idb_smoke_test.mjs.
//
// WHAT THIS DOES NOT PROVE (also printed at the end): real IndexedDB behaviour (that is the smoke test), cross-browser
// behaviour (Chrome only), that the ROM-font charset covers every glyph a player may want, or that ECDSA identity means
// anything beyond key continuity (there is no server to say whose key it is).
//
// USAGE   node tools/pokemonarena_profile_test.mjs        (from anywhere; exits non-zero on any failure)
// ENV     ARENA_ROM   path to the ROM (default gba/gbaWasm/roms/Pokemon SoulGold (v1.1.1).gba)
//         ARENA_FUZZ  fuzz iterations scale (default 1)
//
// Reads the ROM and the fixtures, writes nothing. Pure ASCII.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as STATS from '../pokemonarena/js/stats.js';
import * as RULES from '../pokemonarena/js/rules.js';
import * as CHARSET from '../pokemonarena/js/charset.js';
import { loadPack } from '../pokemonarena/js/tables.js';
import * as ROMJS from '../pokemonarena/js/rom.js';
const { PINNED } = ROMJS;

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const JS = path.join(root, 'pokemonarena', 'js');
const FX = path.join(here, 'fixtures', 'pokemonarena');
const ROM_PATH = process.env.ARENA_ROM || path.join(root, 'gba', 'gbaWasm', 'roms', 'Pokemon SoulGold (v1.1.1).gba');
const FUZZ = Math.max(1, Number(process.env.ARENA_FUZZ || 1));
const canon = STATS.canonicalJSON;

// ---------------------------------------------------------------------------------------------
// tiny harness
// ---------------------------------------------------------------------------------------------
let passed = 0, failed = 0;
const failures = [];
function t(name, ok, detail = '') {
  if (ok === true) { passed++; console.log(`  ok   ${name}`); }
  else {
    failed++;
    const why = typeof ok === 'string' ? ok : detail;
    failures.push(`${name}: ${why}`);
    console.log(`  FAIL ${name}${why ? '  -- ' + why : ''}`);
  }
}
const head = (s) => console.log(`\n== ${s}`);
const J = (x) => JSON.stringify(x);
const eqv = (got, want) => (canon(got) === canon(want) ? true : `got ${J(got)} want ${J(want)}`);
const all = async (xs, fn) => { for (const x of xs) { const r = await fn(x); if (r !== true) return r; } return true; };
const throwsKind = async (fn, code) => { try { await fn(); return 'did not throw'; } catch (e) { return (code === undefined || e.code === code) ? true : `threw ${e && e.name}/${e && e.code}: ${e && e.message}`; } };

if (!fs.existsSync(ROM_PATH)) { console.error(`ROM not found: ${ROM_PATH}  (set ARENA_ROM)`); process.exit(2); }
const rom = fs.readFileSync(ROM_PATH);
const pack = loadPack(rom);
(function deepFreeze(o) { if (o !== null && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const k of Object.keys(o)) deepFreeze(o[k]); } return o; })(pack);

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let x = a; x = Math.imul(x ^ (x >>> 15), x | 1); x ^= x + Math.imul(x ^ (x >>> 7), x | 61); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
}
const clone = (o) => JSON.parse(JSON.stringify(o));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readFx = (n) => JSON.parse(fs.readFileSync(path.join(FX, n), 'utf8'));
const FIX = {
  v1full: readFx('profile-v1-full.json'), v1fullExp: readFx('profile-v1-full.expected-v3.json'),
  v1bad: readFx('profile-v1-bad.json'), v1badExp: readFx('profile-v1-bad.expected-v3.json'),
  v2: readFx('profile-v2-current.json'), v2exp: readFx('profile-v2-current.expected-v3.json'), cur: readFx('profile-v3-current.json'), fut: readFx('profile-v4-future.json'),
};
const NOW = 1700000999999;
function detDeps(seed = 1, t0 = NOW) {
  const r = mulberry32(seed);
  let tm = t0;
  return { now: () => tm, randomBytes: (n) => Uint8Array.from({ length: n }, () => Math.floor(r() * 256)), advance: (d) => { tm += d; } };
}

// ---------------------------------------------------------------------------------------------
// random data for the team-code fuzz (every character is checked against the module's own text rule first)
// ---------------------------------------------------------------------------------------------
const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 !?.-,/';
function rndText(rng, max, allowEmpty = true) {
  const n = Math.floor(rng() * (max + 1));
  let s = '';
  for (let i = 0; i < (allowEmpty ? n : Math.max(1, n)); i++) s += ALPHA[Math.floor(rng() * ALPHA.length)];
  return s;
}
const LAYER_SETS = [[], ['lv5'], ['lv100'], ['item-clause'], ['no-species-clause'], ['strict-champions'], ['lv5', 'item-clause'], ['lv100', 'item-clause', 'no-species-clause'], ['strict-champions', 'item-clause']];
const rulesetOf = (layers) => RULES.resolveRuleset(['arena-gen3-standard', ...layers].join('+')).id;
function rndMon(P, rng, d) {
  const pick = (a) => a[Math.floor(rng() * a.length)];
  const ev = {}, iv = {};
  for (const k of STATS.STAT_ORDER) { ev[k] = Math.floor(rng() * 256); iv[k] = Math.floor(rng() * 32); }
  const nm = 1 + Math.floor(rng() * 4);
  return P.createMon({
    species: 1 + Math.floor(rng() * 1577), nickname: rndText(rng, 10), level: 1 + Math.floor(rng() * 100), nature: Math.floor(rng() * 25),
    abilitySlot: Math.floor(rng() * 3), heldItem: rng() < 0.3 ? 0 : Math.floor(rng() * 930), ev, iv, gender: pick(['M', 'F', '-']), shiny: rng() < 0.2,
    friendship: Math.floor(rng() * 256), moves: Array.from({ length: nm }, () => ({ id: 1 + Math.floor(rng() * 935), ppUps: Math.floor(rng() * 4) })),
  }, d);
}
function rndTeam(P, rng, d) {
  const n = 1 + Math.floor(rng() * 6);
  return { name: rndText(rng, 16), ruleset: rulesetOf(LAYER_SETS[Math.floor(rng() * LAYER_SETS.length)]), romSha256: PINNED.sha256, mons: Array.from({ length: n }, () => rndMon(P, rng, d)) };
}

// ---------------------------------------------------------------------------------------------
// the suite (data): { id, cost, fn(ctx) -> true | string } ; ctx = { P, T, I, S, pack, rom, FIX }
// ---------------------------------------------------------------------------------------------
const suite = [];
const add = (id, fn, cost = 'cheap') => { if (suite.some((c) => c.id === id)) throw new Error('duplicate check id ' + id); suite.push({ id, cost, fn }); };

// ---- shared builders ---------------------------------------------------------------------------
function goodProfile(ctx) {
  const o = ctx.P.openProfileDocument(clone(FIX.cur), { deps: detDeps() });
  if (!o.ok || o.problems.length) throw new Error('fixture cur did not open cleanly');
  return o.profile;
}
function makeProfile(ctx, d, nMons = 3, opts = {}) {
  const { P } = ctx;
  const p = P.createProfile({ trainerName: opts.trainerName || 'ASH' }, d);
  const rng = mulberry32(opts.seed || 5);
  const ids = [];
  for (let i = 0; i < nMons; i++) {
    const m = rndMon(P, rng, d);
    p.box.push(m);
    ids.push(m.id);
  }
  if (nMons >= 2) p.teams.push(P.createTeam({ name: 'TEAM ONE', monIds: ids.slice(0, Math.min(6, nMons)) }, d));
  p.stats.wins = 3;
  return p;
}
const withoutRev = (p) => { const c = clone(p); delete c.rev; return c; };
const textOf = (bytes) => new TextDecoder().decode(bytes);
async function gz(bytes) { return new Uint8Array(zlib.gzipSync(bytes)); }

// =============================================================================================
// A. PROFILE: migration, normalisation, shape
// =============================================================================================
add('profile/migrate/v1-full-golden', (c) => {
  const o = c.P.openProfileDocument(clone(c.FIX.v1full), { deps: detDeps() });
  if (!o.ok) return 'did not open: ' + J(o);
  const bad = eqv(o.profile, c.FIX.v1fullExp);
  if (bad !== true) return 'profile: ' + bad.slice(0, 600);
  if (o.migratedFrom !== 1 || o.changed !== true || o.readOnly !== false) return `flags ${J({ m: o.migratedFrom, c: o.changed, r: o.readOnly })}`;
  if (o.problems.length !== 0 || o.quarantined.length !== 0) return 'unexpected problems ' + J(o.problems);
  return c.P.checkProfile(o.profile).length === 0 ? true : 'migrated profile fails checkProfile';
});
add('profile/migrate/v1-bad-golden', (c) => {
  const o = c.P.openProfileDocument(clone(c.FIX.v1bad), { deps: detDeps() });
  if (!o.ok) return 'did not open: ' + J(o);
  const e = c.FIX.v1badExp;
  const bad = eqv(o.profile, e.profile);
  if (bad !== true) return 'profile: ' + bad.slice(0, 600);
  const q = o.quarantined.map((x) => ({ kind: x.kind, index: x.index, codes: [...new Set(x.problems.map((p) => p.code))].sort() }));
  const qb = eqv(q, e.quarantined);
  if (qb !== true) return 'quarantined: ' + qb;
  const pc = [...new Set(o.problems.map((p) => p.code))].sort();
  return eqv(pc, e.problemCodes);
});
add('profile/quarantine/keeps-the-raw-record-untouched', (c) => {
  const src = clone(c.FIX.v1bad);
  const o = c.P.openProfileDocument(src, { deps: detDeps() });
  const q = o.quarantined;
  if (q.length !== 3) return 'expected 3 quarantined, got ' + q.length;
  if (!(q[0].raw && q[0].raw.id === 'm_bad' && q[0].raw.species === 0 && q[0].raw.level === 0 && q[0].raw.ev.hp === 4 && q[0].raw.abilitySlot === 0)) return 'raw of the shape-bad mon was altered: ' + J(q[0].raw);
  if (q[1].raw !== 'this is not a record') return 'raw of the non-object entry altered';
  if (q[2].raw.species !== 4 || q[2].raw.id !== 'm_ok') return 'raw of the duplicate-id record altered';
  return o.profile.box.length === 1 && o.profile.box[0].species === 3 ? true : 'the good record was not kept as it was';
});
add('profile/migrate/current-is-a-fixed-point', (c) => {
  const o = c.P.openProfileDocument(clone(c.FIX.cur), { deps: detDeps() });
  if (!o.ok || o.changed || o.migratedFrom !== null || o.problems.length) return 'a current document was changed: ' + J({ ok: o.ok, ch: o.changed, p: o.problems });
  return eqv(o.profile, c.FIX.cur);
});
add('profile/migrate/idempotent', (c) => all(['v1full', 'v1bad', 'v2', 'cur'], (k) => {
  const a = c.P.openProfileDocument(clone(c.FIX[k]), { deps: detDeps() });
  const b = c.P.openProfileDocument(clone(a.profile), { deps: detDeps() });
  if (!b.ok || b.changed || b.problems.length || b.migratedFrom !== null) return `${k}: second pass changed something ${J({ ch: b.changed, p: b.problems })}`;
  const m1 = c.P.migrateProfile(clone(a.profile));
  if (m1.steps !== 0 || m1.changed) return `${k}: migrateProfile of a current document ran ${m1.steps} steps`;
  const n = c.P.normalizeProfile(clone(a.profile), { deps: detDeps() });
  return n.ok && n.problems.length === 0 && canon(n.profile) === canon(a.profile) ? true : `${k}: normalize is not idempotent`;
}));
add('profile/migrate/newer-document-is-read-only-and-untouched', (c) => {
  const o = c.P.openProfileDocument(clone(c.FIX.fut), { deps: detDeps() });
  if (!o.ok || o.readOnly !== true || o.changed !== false || o.migratedFrom !== null) return 'flags ' + J(o);
  const same = eqv(o.profile, c.FIX.fut);
  if (same !== true) return 'the newer document was altered: ' + same;
  const m = c.P.migrateProfile(clone(c.FIX.fut));
  return m.readOnly === true && m.steps === 0 && m.from === 4 ? true : 'migrateProfile ' + J({ ro: m.readOnly, s: m.steps });
});
add('profile/migrate/refuses-an-unusable-version', (c) => all([[undefined, 'profile.version'], [0, 'profile.version'], [-1, 'profile.version'], [1.5, 'profile.version'], ['2', 'profile.version'], [null, 'profile.version']], ([v, code]) => {
  const doc = { app: 'pokemonarena', id: 'p_x' };
  if (v !== undefined) doc.schemaVersion = v;
  const r = c.P.openProfileDocument(doc, {});
  if (r.ok || r.code !== code) return `schemaVersion ${J(v)} -> ${J(r)}`;
  const m = c.P.migrateProfile(doc); // the migration layer must refuse on its own, not lean on the normaliser's later check
  if (m.ok || m.code !== code) return `migrateProfile with schemaVersion ${J(v)} -> ${J(m)}`;
  for (const junk of [null, 5, 'x', [], [1]]) { const q = c.P.openProfileDocument(junk, {}); if (q.ok || q.code !== 'profile.shape') return `junk ${J(junk)} -> ${J(q)}`; }
  return true;
}));
add('profile/migrate/unknown-fields-carried-to-the-same-level', (c) => {
  const o = c.P.openProfileDocument(clone(c.FIX.v1full), { deps: detDeps() }).profile;
  const checks = [
    [o._unknown.flavor === 'vanilla' && o._unknown.carry === 'me', 'root bag'],
    [o.teams[1]._unknown.color === 'red' && o.teams[1]._unknown.v1FormatId === 'singles-3v3-l50-cup', 'team bag'],
    [J(o.box[0]._unknown.futureField) === '[1,2]' && o.box[0]._unknown.notes === 'my ace' && o.box[0]._unknown.training.sp.hp === 2, 'mon bag'],
    [o.settings._unknown.uiScale === 2, 'settings bag'],
    [J(o.stats._unknown.v1ByFormat) === J({ 'mystery-cup': { w: 1, l: 0 } }), 'stats bag'],
    [J(o._unknown.history) === J(c.FIX.v1full.history), 'history list moved to the bag, not dropped'],
  ];
  const bad = checks.find((x) => !x[0]);
  if (bad) return 'lost: ' + bad[1];
  // and it survives a full save/export/import cycle
  const e = c.P.buildExport(o, { deps: detDeps() });
  const text = c.P.serializeExport(e);
  return c.P.parseExport(text, {}).then((r) => (r.ok && canon(r.profile._unknown) === canon(o._unknown) && canon(r.profile.box[0]._unknown) === canon(o.box[0]._unknown) ? true : 'bag did not survive export/import'));
});
add('profile/migrate/no-prototype-pollution-from-hostile-keys', (c) => {
  const doc = JSON.parse('{"app":"pokemonarena","schemaVersion":2,"id":"p_h","rev":1,"createdAt":1,"updatedAt":1,"romSha256":"' + PINNED.sha256 + '","trainerName":"H","avatar":{"kind":"preset","id":0},"settings":{},"teams":[],"box":[],"stats":{},"identity":{"publicKeyJwk":null,"previousKeys":[]},"__proto__":{"polluted":true},"constructor":{"x":1}}');
  const o = c.P.openProfileDocument(doc, { deps: detDeps() });
  if (!o.ok) return 'did not open: ' + J(o);
  if (({}).polluted !== undefined || Object.prototype.polluted !== undefined) return 'Object.prototype was polluted';
  if (o.profile.polluted !== undefined) return 'the profile object inherited a polluted property';
  return Object.prototype.hasOwnProperty.call(o.profile._unknown, '__proto__') && o.profile._unknown.constructor.x === 1 ? true : 'hostile keys were not kept as plain data in the bag';
});

// ---- fuzz: no input makes open throw, and everything that opens is valid and stable --------------
function junkValue(rng) {
  const J2 = [null, 0, -1, 1.5, '', 'x', [], {}, true, false, 1e30, '{PK}', [1, 2], { a: 1 }, 'a'.repeat(300), 255, 256, 65536, 4294967296, -0.5, { kty: 'EC', d: 'x' }];
  return J2[Math.floor(rng() * J2.length)];
}
function mutateDoc(doc, rng) {
  const d = clone(doc);
  const n = 1 + Math.floor(rng() * 3);
  for (let i = 0; i < n; i++) {
    let node = d;
    const depth = Math.floor(rng() * 4);
    for (let k = 0; k < depth; k++) {
      const keys = node !== null && typeof node === 'object' ? Object.keys(node) : [];
      if (!keys.length) break;
      const nx = node[keys[Math.floor(rng() * keys.length)]];
      if (nx !== null && typeof nx === 'object') node = nx; else break;
    }
    const keys = node !== null && typeof node === 'object' ? Object.keys(node) : [];
    if (!keys.length) continue;
    const key = keys[Math.floor(rng() * keys.length)];
    if (rng() < 0.3) { if (Array.isArray(node)) node.splice(Number(key), 1); else delete node[key]; } else node[key] = junkValue(rng);
  }
  return d;
}
add('profile/fuzz/open-never-throws-and-output-is-valid-and-stable', (c) => {
  const rng = mulberry32(1234);
  const bases = [c.FIX.v1full, c.FIX.v1bad, c.FIX.v2, c.FIX.cur];
  let opened = 0, refused = 0, quarantinedTotal = 0;
  for (let i = 0; i < 700 * FUZZ; i++) {
    const doc = mutateDoc(bases[i % 4], rng);
    let r;
    try { r = c.P.openProfileDocument(doc, { deps: detDeps() }); } catch (e) { return `iteration ${i}: threw ${e.message} for ${J(doc).slice(0, 200)}`; }
    if (!r.ok) {
      if (r.code === 'profile.normalize' || r.code === 'profile.migrate') return `iteration ${i}: an internal exception was swallowed (${r.code}: ${r.message}) for ${J(doc).slice(0, 200)}`;
      refused++;
      continue;
    }
    opened++;
    if (r.readOnly) continue;
    quarantinedTotal += r.quarantined.length;
    const bad = c.P.checkProfile(r.profile);
    if (bad.length) return `iteration ${i}: opened but invalid: ${bad[0].code} ${bad[0].path}`;
    const again = c.P.openProfileDocument(clone(r.profile), { deps: detDeps() });
    if (!again.ok || again.changed || again.problems.length) return `iteration ${i}: output is not a fixed point (${J(again.problems.slice(0, 2))})`;
    if (canon(again.profile) !== canon(r.profile)) return `iteration ${i}: second pass differs`;
  }
  return opened > 100 && refused > 5 && quarantinedTotal > 5 ? true : `fuzz exercised too little: opened ${opened}, refused ${refused}, quarantined ${quarantinedTotal}`;
});

// ---- the shape matrix: every PROFILE_CODES code has a bad input that fires it -------------------
const SHAPE_CASES = {
  'profile.shape': [(g) => { g.extra = 1; }, []],
  'profile.version': [(g) => { g.schemaVersion = 4; }, []],
  'profile.app': [(g) => { g.app = 'arena'; }, []],
  'profile.id': [(g) => { g.id = 'bad id!'; }, []],
  'profile.rom': [(g) => { g.romSha256 = 'XYZ'; }, []],
  'profile.private-key': [(g) => { g.identity.publicKeyJwk = { ...g.identity.publicKeyJwk, d: 'abc' }; }, ['profile.identity']],
  'profile.rev': [(g) => { g.rev = -1; }, []],
  'profile.time': [(g) => { g.createdAt = 'x'; }, []],
  'profile.trainer-name': [(g) => { g.trainerName = ''; }, []],
  'profile.avatar': [(g) => { g.avatar = { kind: 'x', id: 1 }; }, []],
  'profile.settings': [(g) => { g.settings.animations = 'x'; }, []],
  'profile.teams': [(g) => { g.teams = 'no'; }, []],
  'profile.box': [(g) => { g.box = 'no'; g.teams = []; }, []],
  'profile.stats': [(g) => { g.stats.wins = -1; }, []],
  'profile.identity': [(g) => { g.identity.previousKeys = 'x'; }, []],
  'profile.unknown-bag': [(g) => { g._unknown = 5; }, []],
  'team.shape': [(g) => { g.teams[0] = 5; }, []],
  'team.id': [(g) => { g.teams[0].id = '!'; }, []],
  'team.name': [(g) => { g.teams[0].name = ''; }, []],
  'team.ruleset': [(g) => { g.teams[0].ruleset = 'nope'; }, []],
  'team.mon-ids': [(g) => { g.teams[0].monIds = ['m_a', 'm_a']; }, []],
  'team.missing-mon': [(g) => { g.teams[0].monIds = ['m_a', 'ghost']; }, []],
  'team.duplicate-id': [(g) => { g.teams.push(clone(g.teams[0])); }, []],
  'mon.shape': [(g) => { g.box[0].bogus = 1; }, []],
  'mon.id': [(g) => { g.box[0].id = 'bad id'; }, ['team.missing-mon']],
  'mon.duplicate-id': [(g) => { g.box[1].id = g.box[0].id; }, ['team.missing-mon']],
  'mon.species': [(g) => { g.box[0].species = 0; }, []],
  'mon.nickname': [(g) => { g.box[0].nickname = 'x'.repeat(11); }, []],
  'mon.level': [(g) => { g.box[0].level = 101; }, []],
  'mon.nature': [(g) => { g.box[0].nature = 25; }, []],
  'mon.ability-slot': [(g) => { g.box[0].abilitySlot = 3; }, []],
  'mon.held-item': [(g) => { g.box[0].heldItem = -1; }, []],
  'mon.moves': [(g) => { g.box[0].moves = []; }, []],
  'mon.move': [(g) => { g.box[0].moves = [{ id: 0, ppUps: 0 }]; }, []],
  'mon.ev': [(g) => { g.box[0].ev.hp = 256; }, []],
  'mon.iv': [(g) => { g.box[0].iv.hp = 32; }, []],
  'mon.gender': [(g) => { g.box[0].gender = 'X'; }, []],
  'mon.shiny': [(g) => { g.box[0].shiny = 1; }, []],
  'mon.friendship': [(g) => { g.box[0].friendship = 256; }, []],
  'mon.original-trainer': [(g) => { g.box[0].originalTrainer.tid = -1; }, []],
  'mon.origin': [(g) => { g.box[0].origin = 'x'; }, []],
  'mon.provenance': [(g) => { g.box[0].provenance.pid = -1; }, []],
  'mon.time': [(g) => { g.box[0].createdAt = -1; }, []],
  'mon.unknown-bag': [(g) => { g.box[0]._unknown = 3; }, []],
};
add('profile/shape/matrix-every-code-has-a-firing-case', (c) => {
  const codes = Object.keys(c.P.PROFILE_CODES).filter((k) => k !== 'mon.gender-species');
  const missing = codes.filter((k) => !SHAPE_CASES[k]);
  if (missing.length) return 'PROFILE_CODES has codes with no matrix case: ' + missing.join(', ');
  const extra = Object.keys(SHAPE_CASES).filter((k) => !codes.includes(k));
  if (extra.length) return 'matrix cases for codes PROFILE_CODES does not have: ' + extra.join(', ');
  const good = goodProfile(c);
  const quiet = c.P.checkProfile(clone(good));
  if (quiet.length) return 'the good twin is not silent: ' + J(quiet);
  for (const code of codes) {
    const [mutate, also] = SHAPE_CASES[code];
    const g = clone(good);
    mutate(g);
    const got = [...new Set(c.P.checkProfile(g).map((x) => x.code))].sort();
    const want = [code, ...also].sort();
    if (J(got) !== J(want)) return `${code}: fired ${J(got)}, wanted ${J(want)}`;
  }
  return true;
});
add('profile/shape/object-entries-have-the-stated-paths', (c) => {
  const good = goodProfile(c);
  const g = clone(good);
  g.box[1].ev.spa = 300;
  g.teams[0].name = 'x'.repeat(17);
  g.settings.defaultRuleset = 'arena-gen3-standard+lv100+lv5';
  const paths = c.P.checkProfile(g).map((x) => x.path).sort();
  return eqv(paths, ['box[1].ev.spa', 'settings.defaultRuleset', 'teams[0].name']);
});
add('profile/text/rule-pins', (c) => {
  const T = c.P.textIssue;
  const pins = [['Pika', 10, null], ['', 10, null], ['ABCDEFGHIJ', 10, null], ['ABCDEFGHIJK', 10, 'length'], ['{PK}MN', 10, 'chars'], ['a\nb', 10, 'chars'], ['a\u0000b', 10, 'chars'], ['\ud83d\ude00', 10, 'charset'],
    ['it\u2019s', 10, 'charset'], ["it's", 10, null], ['Zo\u00eb', 10, null], ['a}', 10, 'chars'], [5, 10, 'type'], [null, 10, 'type'], ['\u30dd', 10, 'charset']];
  return all(pins, ([s, max, want]) => (T(s, max) === want ? true : `textIssue(${J(s)}) = ${J(T(s, max))}, wanted ${J(want)}`));
});
add('profile/ids/newId-and-isId', (c) => {
  const d = detDeps(7);
  const a = c.P.newId('m', d), b = c.P.newId('m', d);
  if (a === b || !/^m_[0-9a-f]{16}$/.test(a)) return `ids ${a} ${b}`;
  const pins = [['m_abc-1', true], ['', false], ['a b', false], ['a'.repeat(40), true], ['a'.repeat(41), false], ['a:b', false], [5, false], ['m\u00e9', false]];
  return all(pins, ([s, w]) => (c.P.isId(s) === w ? true : `isId(${J(s)})`));
});

// ---- rules bridge (uses the real pack) --------------------------------------------------------
// rules.js now carries an ENGINE layer: a species whose every ability or move the battle engine cannot run yet is excluded, and blankRec() refuses it
// (RangeError). The checks below that build a blank record pick from the species that are playable under EVERY preset they use.
const EX_ANY = new Set();
for (const rs of ['arena-gen3-standard', 'arena-gen3-standard+strict-champions', 'arena-gen3-standard+lv5', 'arena-gen3-standard+lv100', 'arena-gen3-standard+item-clause']) {
  if (typeof RULES.engineExcludedSpecies === 'function') for (const e of RULES.engineExcludedSpecies(pack, rs)) EX_ANY.add(e.id);
}
const USABLE = pack.roster.filter((id) => !EX_ANY.has(id));
function speciesWithRatio(r) { return USABLE.map((i) => pack.species[i]).find((s) => s.genderRatio === r); }
add('profile/rules/bridge-maps-fields-exactly', (c) => {
  const m = c.P.createMon({ species: 6, heldItem: 4, nature: 3, abilitySlot: 2, level: 77, moves: [{ id: 10, ppUps: 2 }, { id: 11, ppUps: 0 }], ev: { hp: 1, atk: 2, def: 3, spa: 4, spd: 5, spe: 6 }, iv: { hp: 6, atk: 5, def: 4, spa: 3, spd: 2, spe: 1 } }, detDeps());
  const r = c.P.toRulesRec(m);
  const want = { species: 6, level: 77, nature: 3, abilitySlot: 2, item: 4, moves: [10, 11], ivs: { hp: 6, atk: 5, def: 4, spa: 3, spd: 2, spe: 1 }, evs: { hp: 1, atk: 2, def: 3, spa: 4, spd: 5, spe: 6 } };
  const bad = eqv(r, want);
  if (bad !== true) return bad;
  r.ivs.hp = 99;
  if (m.iv.hp !== 6) return 'toRulesRec aliased the record';
  const strict = c.P.toRulesRec({ ...m, iv: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 }, ev: { hp: 252, atk: 0, def: 4, spa: 12, spd: 0, spe: 0 } }, RULES.STRICT_RULESET_ID);
  return eqv(strict.points, { hp: 32, atk: 0, def: 1, spa: 2, spd: 0, spe: 0 });
});
add('profile/rules/blankRec-records-validate-under-every-preset', (c) => {
  const presets = ['arena-gen3-standard', RULES.STRICT_RULESET_ID, 'arena-gen3-standard+lv5', 'arena-gen3-standard+lv100'];
  const rng = mulberry32(99);
  for (let i = 0; i < 60; i++) {
    const sid = USABLE[Math.floor(rng() * USABLE.length)];
    for (const rs of presets) {
      const rec = RULES.blankRec(sid, pack, rs);
      const mon = c.P.createMon({ species: rec.species, level: rec.level, nature: rec.nature, abilitySlot: rec.abilitySlot, heldItem: rec.item, moves: rec.moves, ev: rec.evs || { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 }, iv: rec.ivs || { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 }, gender: pack.species[sid].genderRatio === 255 ? '-' : pack.species[sid].genderRatio === 254 ? 'F' : 'M' }, detDeps());
      const v = c.P.validateStoredMon(mon, pack, rs);
      if (!v.ok) return `species ${sid} under ${rs}: ${J(v.reasons)}`;
    }
  }
  return true;
});
add('profile/rules/stored-mon-reports-rule-violations-with-codes', (c) => {
  const genderOf = (sid) => (pack.species[sid].genderRatio === 255 ? '-' : pack.species[sid].genderRatio === 254 ? 'F' : 'M');
  const sid = USABLE[10];
  const std = RULES.blankRec(sid, pack, 'arena-gen3-standard');
  const base = { species: sid, level: std.level, nature: 0, abilitySlot: std.abilitySlot, heldItem: 0, moves: std.moves, gender: genderOf(sid) };
  const ok = c.P.createMon(base, detDeps());
  if (!c.P.validateStoredMon(ok, pack, 'arena-gen3-standard').ok) return 'the good twin is not silent';
  const overEv = c.P.createMon({ ...base, ev: { hp: 255, atk: 255, def: 255, spa: 0, spd: 0, spe: 0 } }, detDeps());
  const a = c.P.validateStoredMon(overEv, pack, 'arena-gen3-standard').reasons.map((r) => r.code);
  if (J(a) !== '["ev.total"]') return 'EV total 765 should give exactly ev.total: ' + J(a);
  const unknownMove = c.P.createMon({ ...base, moves: [{ id: 60000, ppUps: 0 }] }, detDeps());
  const um = c.P.validateStoredMon(unknownMove, pack, 'arena-gen3-standard').reasons.map((r) => r.code);
  if (J(um) !== '["move.unknown"]') return 'an unknown move id should give exactly move.unknown: ' + J(um);
  const ste = RULES.blankRec(sid, pack, RULES.STRICT_RULESET_ID);
  const strictBase = { species: sid, level: 50, nature: 0, abilitySlot: ste.abilitySlot, heldItem: 0, moves: ste.moves, gender: genderOf(sid), iv: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 } };
  const onGrid = c.P.createMon({ ...strictBase, ev: { hp: 252, atk: 0, def: 4, spa: 12, spd: 0, spe: 0 } }, detDeps());
  const sg = c.P.validateStoredMon(onGrid, pack, RULES.STRICT_RULESET_ID);
  if (!sg.ok) return 'a spread on the 4-then-8 grid should be legal under strict: ' + J(sg.reasons);
  const offGrid = c.P.createMon({ ...strictBase, ev: { hp: 5, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 } }, detDeps());
  const og = c.P.validateStoredMon(offGrid, pack, RULES.STRICT_RULESET_ID).reasons;
  return og.length === 1 && og[0].code === 'points.ev-mismatch' && og[0].path === 'evs.hp' ? true : 'an off-grid EV should give exactly points.ev-mismatch at evs.hp: ' + J(og);
});
add('profile/rules/gender-is-checked-against-the-species-ratio', (c) => {
  const sp255 = speciesWithRatio(255), sp0 = speciesWithRatio(0), sp254 = speciesWithRatio(254), sp127 = speciesWithRatio(127);
  const mk = (sp, gender) => {
    const rec = RULES.blankRec(sp.id, pack, 'arena-gen3-standard');
    return c.P.createMon({ species: sp.id, level: rec.level, abilitySlot: rec.abilitySlot, moves: rec.moves, gender }, detDeps());
  };
  const codes = (sp, g) => c.P.validateStoredMon(mk(sp, g), pack, 'arena-gen3-standard').reasons.map((r) => r.code).filter((x) => x === 'mon.gender-species').length;
  const exp = [[sp255, '-', 0], [sp255, 'M', 1], [sp255, 'F', 1], [sp0, 'M', 0], [sp0, 'F', 1], [sp0, '-', 1], [sp254, 'F', 0], [sp254, 'M', 1], [sp127, 'M', 0], [sp127, 'F', 0], [sp127, '-', 1]];
  return all(exp, ([sp, g, n]) => (codes(sp, g) === n ? true : `species ratio ${sp.genderRatio} gender ${g}: ${codes(sp, g)} gender reasons, wanted ${n}`));
});
add('profile/rules/validateMonList-equals-validateTeam-plus-gender', (c) => {
  const rng = mulberry32(31);
  for (let i = 0; i < 40; i++) {
    const mons = [];
    const n = 1 + Math.floor(rng() * 6);
    for (let k = 0; k < n; k++) {
      const sid = USABLE[Math.floor(rng() * USABLE.length)];
      const rec = RULES.blankRec(sid, pack, 'arena-gen3-standard');
      mons.push(c.P.createMon({ species: sid, level: rec.level, abilitySlot: rec.abilitySlot, moves: rec.moves, heldItem: rng() < 0.5 ? 0 : 1 + Math.floor(rng() * 20), gender: 'M' }, detDeps()));
    }
    const rs = i % 2 ? RULES.STRICT_RULESET_ID : 'arena-gen3-standard+item-clause'; // strict needs the derived points, so it exercises the bridge's ruleset argument
    const mine = c.P.validateMonList(mons, pack, rs);
    const ref = (m) => { const r0 = { species: m.species, level: m.level, nature: m.nature, abilitySlot: m.abilitySlot, item: m.heldItem, moves: m.moves.map((x) => x.id), ivs: { ...m.iv }, evs: { ...m.ev } }; if (rs === RULES.STRICT_RULESET_ID) r0.points = STATS.evsToPoints(r0.evs, r0.ivs); return r0; };
    const direct = RULES.validateTeam(mons.map(ref), pack, rs); // an independent construction of the rules.js record, not toRulesRec itself
    const mineNoGender = mine.reasons.filter((r) => r.code !== 'mon.gender-species');
    if (canon(mineNoGender) !== canon(direct.reasons)) return `team ${i}: ${J(mineNoGender).slice(0, 200)} vs ${J(direct.reasons).slice(0, 200)}`;
  }
  return true;
});

// =============================================================================================
// B. EXPORT / IMPORT
// =============================================================================================
add('profile/export/round-trip-plain-and-gz-after-canonicalisation', async (c) => {
  const p = makeProfile(c, detDeps(3), 5);
  p.rev = 9;
  const want = withoutRev(p);
  for (const gzip of [false, true]) {
    const e = await c.P.exportBytes(p, { gzip, deps: detDeps(4) });
    if (e.gzip !== gzip) return `gzip flag ${e.gzip}`;
    const isGz = e.bytes[0] === 0x1f && e.bytes[1] === 0x8b;
    if (isGz !== gzip) return 'gzip magic does not match the flag';
    const r = await c.P.parseExport(e.bytes, {});
    if (!r.ok) return `gzip=${gzip}: ${J(r).slice(0, 300)}`;
    if (r.checksum !== 'ok' || r.gzip !== gzip || r.profile.rev !== 0) return 'flags ' + J({ cs: r.checksum, g: r.gzip, rev: r.profile.rev });
    const got = withoutRev(r.profile);
    if (canon(got) !== canon(want)) return `gzip=${gzip}: profile changed in the round trip`;
    if (r.problems.length || r.quarantined.length) return 'problems on a clean round trip';
  }
  return true;
});
add('profile/export/gzip-request-falls-back-to-plain-json-without-CompressionStream', async (c) => {
  const p = makeProfile(c, detDeps(3), 2);
  const saved = globalThis.CompressionStream;
  globalThis.CompressionStream = undefined;
  try {
    const e = await c.P.exportBytes(p, { gzip: true, deps: detDeps() });
    if (e.gzip !== false || e.bytes[0] !== 0x7b || e.mime !== 'application/json' || !e.name.endsWith('.pokemonarena.json')) return 'fallback shape ' + J({ gzip: e.gzip, b0: e.bytes[0], mime: e.mime, name: e.name });
    const r = await c.P.parseExport(e.bytes, {});
    return r.ok && !r.gzip ? true : 'the fallback file does not parse: ' + J(r).slice(0, 150);
  } finally { globalThis.CompressionStream = saved; }
});
add('profile/export/envelope-and-file-name', async (c) => {
  const p = makeProfile(c, detDeps(3), 2, { trainerName: 'A B/C' });
  const e = c.P.buildExport(p, { deps: detDeps(1) });
  if (e.format !== 'pokemonarena-profile' || e.exportVersion !== 1 || e.schemaVersion !== 3 || e.exportedAt !== NOW || e.romSha256 !== PINNED.sha256) return 'envelope ' + J({ ...e, profile: '...' });
  if ('rev' in e.profile) return 'rev leaked into the export';
  if (!/^sha256:[0-9a-f]{64}$/.test(e.checksum)) return 'checksum shape ' + e.checksum;
  const name = c.P.exportFileName(p, { gzip: true, now: Date.UTC(2026, 10, 1) });
  const name2 = c.P.exportFileName({ trainerName: '' }, { now: Date.UTC(2026, 0, 5) });
  return name === 'pokemonarena-A-B-C-20261101.pokemonarena.json.gz' && name2 === 'pokemonarena-profile-20260105.pokemonarena.json' ? true : `names ${name} ${name2}`;
});
add('profile/schema/no-derived-stat-fields-are-modelled', (c) => {
  const m = c.P.createMon({ species: 6, moves: [1] }, detDeps());
  const want = ['abilitySlot', 'createdAt', 'ev', 'friendship', 'gender', 'heldItem', 'id', 'iv', 'level', 'moves', 'nature', 'nickname', 'originalTrainer', 'origin', 'provenance', 'shiny', 'species', 'updatedAt'].sort();
  if (J(Object.keys(m).sort()) !== J(want)) return 'a record has keys ' + J(Object.keys(m).sort());
  for (const derived of ['maxHp', 'hp', 'atk', 'def', 'spa', 'spd', 'spe', 'stats', 'hiddenPower', 'effectiveEv', 'points']) {
    const bad = { ...clone(m), [derived]: 123 };
    const codes = c.P.checkMon(bad).map((x) => x.code);
    if (J(codes) !== '["mon.shape"]') return derived + ' is accepted as a stored field: ' + J(codes);
  }
  const o = c.P.normalizeProfile({ ...clone(goodProfile(c)), box: [{ ...clone(m), maxHp: 999 }] }, { deps: detDeps() });
  return o.ok && o.profile.box[0]._unknown.maxHp === 999 && !('maxHp' in o.profile.box[0]) ? true : 'a derived field was promoted to a schema field instead of being carried in the bag';
});
add('profile/export/checksum-covers-the-profile', async (c) => {
  const p = makeProfile(c, detDeps(3), 2);
  const e = c.P.buildExport(p, { deps: detDeps() });
  const e2 = c.P.buildExport({ ...p, trainerName: 'ZZZ' }, { deps: detDeps() });
  const e3 = c.P.buildExport(p, { deps: detDeps() });
  return e.checksum !== e2.checksum && e.checksum === e3.checksum ? true : 'checksum does not track the profile content';
});

async function exportText(c, p) { return c.P.serializeExport(c.P.buildExport(p, { deps: detDeps() })); }
function rechecksum(e) { e.checksum = 'sha256:' + ROMJS.sha256Hex(new TextEncoder().encode(canon(e.profile))); return e; }
const IMPORT_CASES = {
  'import.input': async () => 42,
  'import.empty': async () => '',
  'import.too-large': async (c, p) => (await exportText(c, p)) + ' '.repeat(10),
  'import.gzip-unsupported': null, // fired below with DecompressionStream removed
  'import.gzip-corrupt': async (c, p) => { const g = await gz(Buffer.from(await exportText(c, p))); return g.slice(0, g.length - 20); },
  'import.not-text': async () => new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]),
  'import.corrupt': async (c, p) => { const s = await exportText(c, p); return s.slice(0, Math.floor(s.length / 2)); },
  'import.not-an-export': async () => '{"hello":"world"}',
  'import.export-version-newer': async (c, p) => { const e = c.P.buildExport(p, { deps: detDeps() }); e.exportVersion = 2; return c.P.serializeExport(e); },
  'import.checksum': async (c, p) => (await exportText(c, p)).replace('"trainerName": "ASH"', '"trainerName": "ASG"'),
  'import.envelope-mismatch': async (c, p) => { const e = c.P.buildExport(p, { deps: detDeps() }); e.romSha256 = '0'.repeat(64); return c.P.serializeExport(e); },
  'import.newer-schema': async (c, p) => { const e = c.P.buildExport(p, { deps: detDeps() }); e.profile.schemaVersion = 4; e.schemaVersion = 4; return c.P.serializeExport(rechecksum(e)); },
  'import.private-key': async (c, p) => { const e = c.P.buildExport(p, { deps: detDeps() }); e.profile.identity.publicKeyJwk = { kty: 'EC', crv: 'P-256', x: 'A'.repeat(43), y: 'B'.repeat(43), d: 'C'.repeat(43) }; return c.P.serializeExport(e); },
  'import.invalid-profile': async (c, p) => { const e = c.P.buildExport(p, { deps: detDeps() }); e.profile.id = 'bad id!'; return c.P.serializeExport(rechecksum(e)); },
  'import.rom-mismatch': async (c, p) => { const e = c.P.buildExport(p, { deps: detDeps() }); e.profile.romSha256 = 'f'.repeat(64); e.romSha256 = 'f'.repeat(64); return c.P.serializeExport(rechecksum(e)); },
  'import.internal': null, // no input reaches it by design; asserted unreachable below
};
add('profile/import/refusals-matrix-every-code-has-a-firing-case', async (c) => {
  const codes = Object.keys(c.P.IMPORT_CODES);
  const missing = codes.filter((k) => !(k in IMPORT_CASES));
  if (missing.length) return 'IMPORT_CODES has codes with no case: ' + missing.join(', ');
  const p = makeProfile(c, detDeps(3), 3);
  const good = await c.P.parseExport(await exportText(c, p), {});
  if (!good.ok) return 'the good twin is not accepted: ' + J(good).slice(0, 200);
  for (const code of codes) {
    if (code === 'import.internal') continue;
    let input, opts = {};
    if (code === 'import.gzip-unsupported') {
      input = await gz(Buffer.from(await exportText(c, p)));
      const saved = globalThis.DecompressionStream;
      globalThis.DecompressionStream = undefined;
      try { const r = await c.P.parseExport(input, {}); if (r.ok || r.code !== code) return `${code}: ${J(r).slice(0, 200)}`; } finally { globalThis.DecompressionStream = saved; }
      continue;
    }
    input = await IMPORT_CASES[code](c, p);
    if (code === 'import.too-large') opts = { maxBytes: 1000 };
    const r = await c.P.parseExport(input, opts);
    if (r.ok || r.code !== code) return `${code}: got ${r.ok ? 'ok' : r.code} (${(r.message || '').slice(0, 120)})`;
  }
  return true;
});
add('profile/import/truncation-is-reported-as-likely-truncated', async (c) => {
  const p = makeProfile(c, detDeps(3), 3);
  const s = await exportText(c, p);
  for (const frac of [0.9, 0.5, 0.1]) {
    const r = await c.P.parseExport(s.slice(0, Math.floor(s.length * frac)), {});
    if (r.ok || r.code !== 'import.corrupt' || r.likelyTruncated !== true) return `at ${frac}: ${J(r).slice(0, 200)}`;
  }
  const g = await gz(Buffer.from(s));
  for (const cut of [1, 8, 40, Math.floor(g.length / 2)]) {
    const r = await c.P.parseExport(g.slice(0, g.length - cut), {});
    if (r.ok || (r.code !== 'import.gzip-corrupt' && r.code !== 'import.corrupt')) return `gz minus ${cut}: ${J(r).slice(0, 200)}`;
  }
  return true;
});
add('profile/import/oversize-and-decompression-bomb-are-capped', async (c) => {
  const big = new Uint8Array(c.P.EXPORT_MAX_BYTES + 1).fill(32);
  const r1 = await c.P.parseExport(big, {});
  if (r1.ok || r1.code !== 'import.too-large') return 'plain oversize: ' + J(r1).slice(0, 150);
  const bomb = await gz(Buffer.alloc(40 * 1024 * 1024, 32));
  if (bomb.length > 200000) return 'test bomb is not small';
  const t0 = Date.now();
  const r2 = await c.P.parseExport(bomb, {});
  if (r2.ok || r2.code !== 'import.too-large') return 'gzip bomb: ' + J(r2).slice(0, 150);
  return Date.now() - t0 < 5000 ? true : `the bomb took ${Date.now() - t0} ms`;
});
add('profile/import/checksum-override-is-explicit', async (c) => {
  const p = makeProfile(c, detDeps(3), 2);
  const edited = (await exportText(c, p)).replace('"trainerName": "ASH"', '"trainerName": "BSH"');
  const r0 = await c.P.parseExport(edited, {});
  if (r0.ok || r0.code !== 'import.checksum' || r0.reason !== 'mismatch') return 'edited file accepted: ' + J(r0).slice(0, 150);
  const r1 = await c.P.parseExport(edited, { allowChecksumMismatch: true });
  if (!r1.ok || r1.checksum !== 'overridden' || r1.profile.trainerName !== 'BSH') return 'override: ' + J(r1).slice(0, 200);
  const e = c.P.buildExport(p, { deps: detDeps() });
  delete e.checksum;
  const r2 = await c.P.parseExport(c.P.serializeExport(e), {});
  return !r2.ok && r2.code === 'import.checksum' && r2.reason === 'missing' ? true : 'a file without a checksum: ' + J(r2).slice(0, 150);
});
add('profile/import/rom-mismatch-is-refused-unless-allowed', async (c) => {
  const p = makeProfile(c, detDeps(3), 2);
  const other = { ...clone(p), romSha256: 'e'.repeat(64) };
  const text = await exportText(c, other);
  const r = await c.P.parseExport(text, {});
  if (r.ok || r.code !== 'import.rom-mismatch') return 'accepted a profile for another ROM: ' + J(r).slice(0, 150);
  const r2 = await c.P.parseExport(text, { allowRomMismatch: true });
  const r3 = await c.P.parseExport(text, { expectRomSha256: 'e'.repeat(64) });
  return r2.ok && r3.ok ? true : 'override paths: ' + J([r2.code, r3.code]);
});
// The nesting-depth guard (profile.js tooDeep, PROFILE_LIMITS.depthMax = 48) was not pinned by any check: a mutant that multiplied the
// limit by 1000 passed all 263. It guards two doors (openProfileDocument/normalizeProfile on the profile, parseExport on the envelope), and the
// envelope sits ONE level above the profile, so a chain that the profile door accepts can still be refused at the envelope door. Both edges are pinned.
function deepSettings(c, k) { // a profile whose settings.x is a chain of k nested objects; the deepest object sits at depth 2 + (k - 1) in the profile
  const d = clone(c.FIX.cur);
  let x = {};
  for (let i = 1; i < k; i++) x = { x };
  d.settings.x = x;
  return d;
}
add('profile/depth/the-profile-door-refuses-a-chain-one-past-the-limit-and-accepts-the-limit', (c) => {
  const lim = c.P.PROFILE_LIMITS.depthMax;
  const okDoc = deepSettings(c, lim - 2), badDoc = deepSettings(c, lim - 1); // deepest object at depth lim - 1 / lim
  const a = c.P.openProfileDocument(okDoc), b = c.P.openProfileDocument(badDoc);
  if (!a.ok) return 'a chain exactly at the limit was refused: ' + J(a).slice(0, 160);
  if (b.ok || b.code !== 'profile.shape') return 'a chain one past the limit was accepted: ' + J(b).slice(0, 160);
  if (c.P.tooDeep(okDoc) || !c.P.tooDeep(badDoc)) return 'tooDeep() disagrees with the door';
  return true;
});
add('profile/depth/a-hostile-chain-of-100000-levels-is-refused-without-recursion', (c) => {
  let x = {};
  for (let i = 0; i < 100000; i++) x = { x };
  const d = clone(c.FIX.cur);
  d.settings.x = x;
  const t0 = Date.now();
  let r;
  try { r = c.P.openProfileDocument(d); } catch (e) { return 'threw ' + e.name + ': ' + e.message; }
  if (r.ok) return 'accepted';
  return Date.now() - t0 < 5000 && c.P.tooDeep(d) ? true : 'too slow or tooDeep() disagrees';
});
add('profile/depth/the-envelope-door-is-a-separate-guard', async (c) => {
  const lim = c.P.PROFILE_LIMITS.depthMax;
  // k chosen so the PROFILE door accepts (deepest depth lim - 1 inside the profile) but the ENVELOPE door sees it one level deeper (depth lim)
  const prof = deepSettings(c, lim - 2);
  const env = c.P.buildExport(prof, { deps: detDeps() });
  const text = c.P.serializeExport(env);
  const r = await c.P.parseExport(text, {});
  if (r.ok || r.code !== 'import.corrupt' || !/deeply/.test(r.message)) return 'the envelope guard did not fire: ' + J(r).slice(0, 200);
  // and one level shallower is fine end to end
  const ok = await c.P.parseExport(c.P.serializeExport(c.P.buildExport(deepSettings(c, lim - 3), { deps: detDeps() })), {});
  return ok.ok ? true : 'a chain inside both limits was refused: ' + J(ok).slice(0, 200);
});
add('team/code/the-default-is-the-pinned-rom', async (c) => {
  const base = { name: 'PIN', ruleset: rulesetOf([]), romSha256: PINNED.sha256, mons: [GOLD_MON()] };
  const own = await c.T.encodeTeamCode(base);
  const foreign = await c.T.encodeTeamCode({ ...base, romSha256: 'f'.repeat(64) });
  const r = {
    ownNoArg: await c.T.decodeTeamCode(own), ownEmpty: await c.T.decodeTeamCode(own, {}),
    foreignNoArg: await c.T.decodeTeamCode(foreign), foreignEmpty: await c.T.decodeTeamCode(foreign, {}),
    foreignAllowed: await c.T.decodeTeamCode(foreign, { allowRomMismatch: true }), foreignNull: await c.T.decodeTeamCode(foreign, { expectRomSha256: null }),
    foreignNamed: await c.T.decodeTeamCode(foreign, { expectRomSha256: 'f'.repeat(64) }),
  };
  if (!r.ownNoArg.ok || !r.ownEmpty.ok) return 'a card for the pinned ROM was refused with no options: ' + J([r.ownNoArg.code, r.ownEmpty.code]);
  if (r.foreignNoArg.ok || r.foreignNoArg.code !== 'code.rom' || r.foreignEmpty.ok || r.foreignEmpty.code !== 'code.rom') return 'a card for ANOTHER ROM was accepted with no options: ' + J([r.foreignNoArg.code, r.foreignEmpty.code]);
  if (!r.foreignAllowed.ok || !r.foreignNull.ok || !r.foreignNamed.ok) return 'the explicit overrides do not work: ' + J([r.foreignAllowed.code, r.foreignNull.code, r.foreignNamed.code]);
  return true;
});
add('profile/import/old-schema-files-are-migrated', async (c) => {
  // wrap the v1 fixture as an export file (the envelope and checksum are over the document as it is)
  const e = { format: 'pokemonarena-profile', exportVersion: 1, schemaVersion: 1, exportedAt: 5, romSha256: c.FIX.v1full.romHash, profile: clone(c.FIX.v1full) };
  delete e.profile.rev; // exports never carry the store's rev
  rechecksum(e);
  const r = await c.P.parseExport(JSON.stringify(e), { deps: detDeps() });
  if (!r.ok) return J(r).slice(0, 300);
  const want = clone(c.FIX.v1fullExp);
  want.rev = 0;
  return r.migratedFrom === 1 && canon(r.profile) === canon(want) ? true : 'migrated import differs from the golden';
});
add('profile/import/rules-report-flags-without-aborting', async (c) => {
  const sid = USABLE[20];
  const rec = RULES.blankRec(sid, pack, 'arena-gen3-standard');
  const p = c.P.createProfile({ trainerName: 'ASH' }, detDeps());
  const mk = (over) => c.P.createMon({ species: sid, level: rec.level, abilitySlot: rec.abilitySlot, moves: rec.moves, gender: pack.species[sid].genderRatio === 255 ? '-' : pack.species[sid].genderRatio === 254 ? 'F' : 'M', ...over }, detDeps(9));
  p.box.push(mk({}), mk({ ev: { hp: 255, atk: 255, def: 255, spa: 0, spd: 0, spe: 0 } }));
  p.box[1].id = 'm_over';
  const r = await c.P.parseExport(await exportText(c, p), { pack });
  if (!r.ok) return J(r).slice(0, 200);
  if (r.profile.box.length !== 2) return 'a rules-illegal record was removed from the box';
  const okFlags = r.rules.mons.map((m) => m.ok);
  return J(okFlags) === '[true,false]' && r.rules.mons[1].reasons.some((x) => x.code === 'ev.total') ? true : 'rules report ' + J(r.rules.mons.map((m) => [m.id, m.ok, m.reasons.map((x) => x.code)]));
});

add('profile/import/species-the-rom-lacks-are-set-aside-with-a-named-code', async (c) => {
  // species 21 is an EMPTY slot of this ROM's table and 5000 is past its end: well-formed records for Pokemon that do not exist here. Without a pack
  // they import as they are (control); with one they are set aside like any damaged record, and leave their team.
  const emptySlot = pack.species.findIndex((x, i) => i > 0 && x === null);
  if (emptySlot < 1) return 'this ROM has no empty species slot to test with';
  const d = detDeps(31);
  const p = makeProfile(c, d, 3, { seed: 12 });
  p.box[1].species = emptySlot; p.box[2].species = 5000;
  const text = await exportText(c, p);
  const plain = await c.P.parseExport(text, {});
  if (!plain.ok || plain.profile.box.length !== 3) return 'control: without a pack nothing is set aside ' + J(plain).slice(0, 200);
  const r = await c.P.parseExport(text, { pack });
  if (!r.ok) return J(r).slice(0, 200);
  if (r.profile.box.length !== 1) return 'box has ' + r.profile.box.length + ' records, wanted 1';
  const codes = r.quarantined.filter((q) => q.kind === 'mon').map((q) => q.problems[0].code);
  if (J(codes) !== J(['mon.species-unknown', 'mon.species-unknown'])) return 'quarantine codes ' + J(codes);
  const keep = new Set(r.profile.box.map((m) => m.id));
  if (r.profile.teams.some((t) => t.monIds.some((id) => !keep.has(id)))) return 'a team still points at a set-aside record';
  if (r.profile.teams[0].monIds.length !== 1) return 'team keeps ' + r.profile.teams[0].monIds.length + ' ids, wanted 1';
  if (c.P.checkProfile(r.profile).length) return 'the profile that is left does not pass checkProfile';
  if (r.rules.mons.length !== 1 || r.rules.mons[0].id !== r.profile.box[0].id) return 'the rules report must cover exactly the records that were kept: ' + J(r.rules.mons.map((m) => m.id));
  return true;
});
add('profile/limits/a-profile-holds-sixteen-teams', async (c) => {
  const d = detDeps(32);
  const p = makeProfile(c, d, 3, { seed: 13 });
  const ids = p.box.map((m) => m.id);
  while (p.teams.length < 16) p.teams.push(c.P.createTeam({ name: 'T' + p.teams.length, monIds: ids.slice(0, 1) }, d));
  if (c.P.checkProfile(p).length) return 'sixteen teams must pass: ' + J(c.P.checkProfile(p)[0]);
  p.teams.push(c.P.createTeam({ name: 'T17', monIds: ids.slice(0, 1) }, d));
  const bad = c.P.checkProfile(p);
  if (!bad.some((x) => x.code === 'profile.teams')) return 'seventeen teams must be refused: ' + J(bad.map((x) => x.code));
  // an import of 20 teams keeps 16 and sets the other 4 aside (named), instead of showing "20 of 16"
  while (p.teams.length < 20) p.teams.push(c.P.createTeam({ name: 'T' + p.teams.length, monIds: ids.slice(0, 1) }, d));
  const e = c.P.buildExport({ ...p, teams: p.teams.slice(0, 16) }, { deps: detDeps() });
  e.profile.teams = JSON.parse(JSON.stringify(p.teams));
  e.checksum = 'sha256:' + ROMJS.sha256Hex(new TextEncoder().encode(canon(e.profile)));
  const r = await c.P.parseExport(c.P.serializeExport(e), { pack });
  if (!r.ok) return J(r).slice(0, 200);
  const dropped = r.quarantined.filter((q) => q.kind === 'team');
  return r.profile.teams.length === 16 && dropped.length === 4 && dropped.every((q) => q.problems[0].code === 'profile.teams') ? true : 'kept ' + r.profile.teams.length + ' teams, set aside ' + dropped.length;
});

// ---- import planning --------------------------------------------------------------------------
function plansFixture(c) {
  const d = detDeps(21);
  const a = makeProfile(c, d, 4, { seed: 11 });
  a.identity.publicKeyJwk = { kty: 'EC', crv: 'P-256', x: 'A'.repeat(43), y: 'B'.repeat(43) };
  a.rev = 5;
  const b = clone(a);
  b.id = 'p_incoming';
  b.rev = 0;
  b.identity.publicKeyJwk = { kty: 'EC', crv: 'P-256', x: 'C'.repeat(43), y: 'D'.repeat(43) };
  return { a, b, d };
}
add('profile/import/plan-new-gets-a-fresh-id-and-keeps-the-public-identity-copy', (c) => {
  const { b, d } = plansFixture(c);
  const r = c.P.planImport(null, b, 'new', d);
  if (!r.ok || r.profile.id === 'p_incoming' || !c.P.isId(r.profile.id) || r.profile.rev !== 0) return J(r).slice(0, 200);
  if (r.report.identity !== 'incoming-copy' || r.profile.identity.publicKeyJwk.x !== 'C'.repeat(43)) return 'identity ' + r.report.identity;
  return r.report.addedMons === 4 && r.report.boxSize === 4 && r.profile.updatedAt === NOW ? true : 'report ' + J(r.report);
});
add('profile/import/plan-merge-dedupes-and-remaps', (c) => {
  const { a, b, d } = plansFixture(c);
  const inc = clone(b);
  // 0: identical to an existing record (same id, same content) -> skipped
  // 1: same pid+otId as an existing record under a DIFFERENT id -> skipped, team ids remapped to the existing one
  a.box[1].provenance = { pid: 111, otId: 222 };
  inc.box[1] = { ...clone(a.box[1]), id: 'm_other_id' };
  // 2: same id as an existing record but different content -> added under a fresh id
  inc.box[2] = { ...clone(inc.box[2]), nickname: 'DIFF' };
  // 3: brand new id -> added as is
  inc.box[3] = { ...clone(inc.box[3]), id: 'm_brand_new' };
  inc.teams = [{ id: 't_inc', name: 'INCOMING', ruleset: 'arena-gen3-standard', monIds: [inc.box[0].id, 'm_other_id', inc.box[2].id, 'm_brand_new'] }, { id: a.teams[0].id, name: 'CLASH', ruleset: 'arena-gen3-standard', monIds: [inc.box[0].id] }];
  const r = c.P.planImport(a, inc, 'merge', d);
  if (!r.ok) return J(r);
  const rp = r.report;
  if (rp.addedMons !== 2 || rp.skippedMons.length !== 2 || rp.remappedMons !== 1) return 'report ' + J(rp);
  if (r.profile.box.length !== 6) return 'box size ' + r.profile.box.length;
  if (r.profile.id !== a.id || r.profile.rev !== 5 || r.profile.identity.publicKeyJwk.x !== 'A'.repeat(43)) return 'merge changed identity/rev/id';
  const t = r.profile.teams.find((x) => x.id === 't_inc');
  if (!t || rp.addedTeams !== 1 || rp.skippedTeams.length !== 1) return 'teams ' + J(r.profile.teams.map((x) => x.id));
  const freshId = r.profile.box.find((m) => m.nickname === 'DIFF').id;
  if (freshId === inc.box[2].id) return 'a clashing id was reused for different content';
  if (!t.monIds.includes(a.box[1].id) || !t.monIds.includes(freshId) || !t.monIds.includes('m_brand_new') || t.monIds.includes('m_other_id')) return 'team ids not remapped: ' + J(t.monIds);
  return c.P.checkProfile(r.profile).length === 0 ? true : 'merged profile invalid: ' + J(c.P.checkProfile(r.profile)[0]);
});
add('profile/import/plan-replace-keeps-id-rev-created-and-local-identity', (c) => {
  const { a, b, d } = plansFixture(c);
  b.box = b.box.slice(0, 2);
  b.teams = [];
  const r = c.P.planImport(a, b, 'replace', d);
  if (!r.ok) return J(r);
  const p = r.profile;
  if (p.id !== a.id || p.rev !== 5 || p.createdAt !== a.createdAt || p.box.length !== 2 || p.teams.length !== 0) return 'replace fields ' + J({ id: p.id, rev: p.rev, n: p.box.length });
  if (p.identity.publicKeyJwk.x !== 'A'.repeat(43) || r.report.identity !== 'kept-local') return 'the local identity was not kept';
  const a2 = clone(a);
  a2.identity = { publicKeyJwk: null, previousKeys: [] };
  const r2 = c.P.planImport(a2, b, 'replace', d);
  return r2.ok && r2.report.identity === 'adopted-incoming' && r2.profile.identity.publicKeyJwk.x === 'C'.repeat(43) ? true : 'identity adoption: ' + J(r2.report);
});
add('profile/import/plan-refuses-mismatches-and-overflow', (c) => {
  const { a, b, d } = plansFixture(c);
  const o = clone(b); o.romSha256 = 'f'.repeat(64);
  const r1 = c.P.planImport(a, o, 'merge', d);
  if (r1.ok || r1.code !== 'plan.rom-mismatch') return 'rom mismatch: ' + J(r1);
  if (c.P.planImport(null, b, 'merge', d).ok) return 'merge without an existing profile was planned';
  if (c.P.planImport(a, b, 'overwrite', d).code !== 'plan.mode') return 'unknown mode accepted';
  if (c.P.planImport(a, { nope: 1 }, 'new', d).code !== 'plan.incoming') return 'malformed incoming accepted';
  const big = clone(a);
  const filler = clone(big.box[0]);
  for (let i = 0; big.box.length < c.P.PROFILE_LIMITS.boxMax; i++) big.box.push({ ...clone(filler), id: 'f_' + i });
  const fresh = clone(b);
  fresh.box.forEach((m, i) => { m.id = 'n_' + i; });
  fresh.teams = [];
  const r2 = c.P.planImport(big, fresh, 'merge', d);
  return !r2.ok && r2.code === 'plan.box-full' ? true : 'box overflow: ' + J(r2).slice(0, 150);
});
add('profile/export/never-writes-private-key-material', (c) => {
  const p = makeProfile(c, detDeps(3), 2);
  p.identity.publicKeyJwk = { kty: 'EC', crv: 'P-256', x: 'A'.repeat(43), y: 'B'.repeat(43) };
  const text = c.P.serializeExport(c.P.buildExport(p, { deps: detDeps() }));
  if (/"d"\s*:/.test(text)) return 'a "d" member is in the export text';
  const leak = clone(p);
  leak.identity.publicKeyJwk.d = 'secret';
  if (c.P.exportableProfile.length !== 1) return 'exportableProfile arity changed';
  try { c.P.buildExport(leak, {}); return 'a private JWK was exported'; } catch (e) { if (e.code !== 'profile.private-key') return 'wrong error ' + e.code; }
  const nested = clone(p);
  nested.box[0]._unknown = { deep: [{ kty: 'EC', crv: 'P-256', d: 'secret', x: 'a', y: 'b' }] };
  try { c.P.buildExport(nested, {}); return 'a private JWK hidden in the bag was exported'; } catch (e) { return e.code === 'profile.private-key' ? true : 'wrong error ' + e.code; }
});

// =============================================================================================
// C. TEAM CODE
// =============================================================================================
const enc = (s) => new TextEncoder().encode(s);
const NON_GLYPH = [...Array(0xfd).keys()].map((i) => i + 1).find((i) => CHARSET.CHARSET[i] === null);
const GOLD_MON = () => ({
  species: 291, heldItem: 1110, level: 50, nature: 7, abilitySlot: 1, gender: 'F', shiny: true, friendship: 200,
  ev: { hp: 1, atk: 2, def: 3, spa: 4, spd: 5, spe: 6 }, iv: { hp: 1, atk: 2, def: 3, spa: 4, spd: 5, spe: 6 },
  moves: [{ id: 258, ppUps: 3 }, { id: 772, ppUps: 2 }], nickname: 'AB',
});
// header: version 1, base 0, layer bits lv5(1)+item-clause(4) = 5, romId 80 71 e2 c3, name length 2, 'T1' = ce a2, count 1
const GOLD_HEX = '010005' + '8071e2c3' + '02' + 'cea2' + '01'
  + '2301' + '5604' + '32' + '07' + '15' + 'c8' + '010203060405' + '410c430a' + '0201040300000000' + '0b' + 'bbbcffffffffffffffff';
add('team/crc16/known-vector-and-sensitivity', (c) => {
  if (c.T.crc16(enc('123456789')) !== 0x29b1) return 'crc16("123456789") = 0x' + c.T.crc16(enc('123456789')).toString(16);
  if (c.T.crc16(new Uint8Array(0)) !== 0xffff) return 'empty input must give the init value 0xffff';
  const base = enc('ARENA1.abcdef');
  const v = c.T.crc16(base);
  for (let i = 0; i < base.length; i++) for (let bit = 0; bit < 8; bit++) { const m = Uint8Array.from(base); m[i] ^= 1 << bit; if (c.T.crc16(m) === v) return `a flipped bit ${bit} of byte ${i} left the CRC unchanged`; }
  return true;
});
add('team/base64url/round-trip-and-strictness', (c) => {
  const rng = mulberry32(8);
  for (let n = 0; n < 70; n++) {
    const b = Uint8Array.from({ length: n }, () => Math.floor(rng() * 256));
    const s = c.T.b64urlEncode(b);
    if (/[^A-Za-z0-9_-]/.test(s)) return 'non-url alphabet in ' + s;
    const back = c.T.b64urlDecode(s);
    if (!back || J([...back]) !== J([...b])) return `length ${n} did not round trip`;
  }
  if (c.T.b64urlEncode(enc('Man')) !== 'TWFu' || c.T.b64urlEncode(enc('Ma')) !== 'TWE' || c.T.b64urlEncode(enc('M')) !== 'TQ') return 'RFC 4648 vectors';
  const bad = ['TQ=', 'TQ==', 'TR', 'TWF', 'T', 'TWFuT', 'TW+u', 'TW/u', 'TW u', 'TQ\u00e9', '=', 'TWE=', 'TS'];
  // 'TR' / 'TS' / 'TWF' carry non-zero leftover bits; 'T' and 'TWFuT' have length % 4 == 1
  for (const s of bad) if (c.T.b64urlDecode(s) !== null) return `accepted non-canonical ${J(s)}`;
  return c.T.b64urlDecode('') !== null && c.T.b64urlDecode('').length === 0 && c.T.b64urlDecode(5) === null ? true : 'empty / non-string handling';
});
add('team/binary/golden-layout-pins-rom-order-and-bit-positions', (c) => {
  const team = { name: 'T1', ruleset: rulesetOf(['lv5', 'item-clause']), romSha256: PINNED.sha256, mons: [GOLD_MON()] };
  const bin = c.T.encodeTeamBinary(team);
  const hex = Array.from(bin, (b) => b.toString(16).padStart(2, '0')).join('');
  if (hex !== GOLD_HEX) {
    let i = 0;
    while (i < hex.length && hex[i] === GOLD_HEX[i]) i++;
    return `byte ${Math.floor(i / 2)} differs: got ${hex.slice(Math.max(0, i - 6), i + 10)} want ${GOLD_HEX.slice(Math.max(0, i - 6), i + 10)} (full got ${hex})`;
  }
  if (bin.length !== 8 + 2 + 1 + c.T.MON_BYTES || c.T.MON_BYTES !== 37) return 'sizes';
  const d = c.T.decodeTeamBinary(bin);
  if (!d.ok) return J(d);
  return d.team.name === 'T1' && d.team.ruleset === team.ruleset && d.team.romId === '8071e2c3' && canon(d.team.mons[0]) === canon(c.T.battleView(GOLD_MON())) ? true : 'decoded ' + J(d.team).slice(0, 300);
});
add('team/binary/round-trip-fuzz-and-decode-is-canonical', (c) => {
  const rng = mulberry32(77);
  const d = detDeps(5);
  let sizes = 0;
  for (let i = 0; i < 400 * FUZZ; i++) {
    const team = rndTeam(c.P, rng, d);
    const bin = c.T.encodeTeamBinary(team);
    if (bin.length > c.T.MAX_BINARY_BYTES) return `team ${i}: ${bin.length} bytes exceeds MAX_BINARY_BYTES`;
    sizes += bin.length;
    const r = c.T.decodeTeamBinary(bin);
    if (!r.ok) return `team ${i}: ${J(r)}`;
    if (r.team.name !== team.name || r.team.ruleset !== team.ruleset || r.team.romId !== team.romSha256.slice(0, 8)) return `team ${i}: header changed`;
    if (canon(r.team.mons) !== canon(team.mons.map(c.T.battleView))) return `team ${i}: mons changed`;
    const again = c.T.encodeTeamBinary({ name: r.team.name, ruleset: r.team.ruleset, romSha256: PINNED.sha256, mons: r.team.mons });
    if (J([...again]) !== J([...bin])) return `team ${i}: encode(decode(b)) != b`;
  }
  return sizes > 0 ? true : 'no data';
});
add('team/binary/every-single-byte-corruption-is-rejected-or-canonical', (c) => {
  const team = { name: 'CANON', ruleset: rulesetOf(['item-clause']), romSha256: PINNED.sha256, mons: [GOLD_MON(), { ...GOLD_MON(), nickname: '', moves: [{ id: 5, ppUps: 0 }], species: 9 }] };
  const bin = c.T.encodeTeamBinary(team);
  let accepted = 0, rejected = 0;
  for (let i = 0; i < bin.length; i++) {
    for (const v of [0, 1, 2, 3, 0x7f, 0x80, 0xfe, 0xff, bin[i] ^ 1, bin[i] ^ 0x40]) {
      if (v === bin[i]) continue;
      const m = Uint8Array.from(bin); m[i] = v;
      const r = c.T.decodeTeamBinary(m);
      if (!r.ok) { rejected++; continue; }
      accepted++;
      const again = c.T.encodeTeamBinary({ name: r.team.name, ruleset: r.team.ruleset, romSha256: PINNED.sha256, mons: r.team.mons });
      // bytes 3..6 are the romId (the header, not a mon field): the decoder returns it separately, so mask it on both sides
      const a = [...again], b = [...m];
      for (let k = 3; k < 7; k++) { a[k] = 0; b[k] = 0; }
      if (J(a) !== J(b)) return `byte ${i} -> ${v}: accepted but not canonical (re-encodes differently)`;
    }
  }
  return accepted > 0 && rejected > 100 ? true : `accepted ${accepted} rejected ${rejected}`;
});
add('team/binary/refusal-matrix-names-the-field', (c) => {
  const team = { name: 'T1', ruleset: rulesetOf([]), romSha256: PINNED.sha256, mons: [GOLD_MON()] };
  const bin = c.T.encodeTeamBinary(team);
  const M0 = 8 + 2 + 1; // offset of the first mon
  const mut = (f) => { const b = Uint8Array.from(bin); f(b); return b; };
  const cases = [
    ['binary.version', mut((b) => { b[0] = 2; })],
    ['binary.ruleset', mut((b) => { b[1] = 1; })],
    ['binary.ruleset', mut((b) => { b[2] = 0x20; })],
    ['binary.ruleset', mut((b) => { b[2] = 0x03; })], // lv5 + lv100 conflict
    ['binary.name', mut((b) => { b[7] = 17; })],
    ['binary.name', mut((b) => { b[8] = 0xff; })],
    ['binary.count', mut((b) => { b[10] = 0; })],
    ['binary.count', mut((b) => { b[10] = 7; })],
    ['binary.length', new Uint8Array([1, 0, 0])],
    ['binary.length', Uint8Array.from([...bin, 0])],
    ['binary.length', bin.slice(0, bin.length - 1)],
    ['binary.mon', mut((b) => { b[M0] = 0; b[M0 + 1] = 0; })], // species 0
    ['binary.mon', mut((b) => { b[M0 + 4] = 0; })],
    ['binary.mon', mut((b) => { b[M0 + 4] = 101; })],
    ['binary.mon', mut((b) => { b[M0 + 5] = 25; })],
    ['binary.mon', mut((b) => { b[M0 + 6] |= 0x20; })], // reserved flag bit
    ['binary.mon', mut((b) => { b[M0 + 6] = (b[M0 + 6] & ~3) | 3; })], // ability slot 3
    ['binary.mon', mut((b) => { b[M0 + 6] = (b[M0 + 6] & ~12) | 12; })], // gender 3
    ['binary.mon', mut((b) => { b[M0 + 17] |= 0x40; })], // iv reserved bits
    ['binary.mon', mut((b) => { b[M0 + 18] = 0; b[M0 + 19] = 0; })], // no first move
    ['binary.mon', mut((b) => { b[M0 + 24] = 9; })], // move slot 3 filled while slot 2 is empty
    ['binary.mon', mut((b) => { b[M0 + 26] |= 0x30; })], // ppUps on empty slot 2
    ['binary.mon', mut((b) => { b[M0 + 27 + 5] = 0x41; })], // junk after the terminator
    ['binary.mon', mut((b) => { b[M0 + 27] = NON_GLYPH; })], // a byte that is no charset glyph
  ];
  for (const [code, bytes] of cases) {
    const r = c.T.decodeTeamBinary(bytes);
    if (r.ok || r.code !== code) return `wanted ${code}, got ${r.ok ? 'ok' : r.code + ' (' + r.message + ')'}`;
  }
  const detail = c.T.decodeTeamBinary(mut((b) => { b[M0 + 5] = 25; }));
  return detail.index === 0 && detail.field === 'nature' ? true : 'a mon refusal must name the index and field: ' + J(detail);
});
add('team/binary/encode-refusals', (c) => {
  const ok = { name: 'T', ruleset: rulesetOf([]), romSha256: PINNED.sha256, mons: [GOLD_MON()] };
  const bad = (edit) => { const t = clone(ok); edit(t); return t; };
  const cases = [
    ['encode.team', null], ['encode.team', { name: 'x', ruleset: rulesetOf([]) }],
    ['encode.name', bad((t) => { t.name = 'x'.repeat(17); })], ['encode.name', bad((t) => { t.name = '{PK}'; })],
    ['encode.ruleset', bad((t) => { t.ruleset = 'nope'; })],
    ['encode.rom', bad((t) => { t.romSha256 = 'nope'; })],
    ['encode.count', bad((t) => { t.mons = []; })], ['encode.count', bad((t) => { t.mons = Array(7).fill(GOLD_MON()); })],
    ['encode.mon', bad((t) => { t.mons[0].level = 101; })], ['encode.mon', bad((t) => { t.mons[0].moves = []; })], ['encode.mon', bad((t) => { t.mons[0].ev.hp = 256; })],
    ['encode.mon', bad((t) => { t.mons[0].iv.spe = 32; })], ['encode.mon', bad((t) => { t.mons[0].nickname = 'ABCDEFGHIJK'; })], ['encode.mon', bad((t) => { t.mons[0].gender = 'X'; })],
    ['encode.mon', bad((t) => { t.mons[0].moves[0].ppUps = 4; })], ['encode.mon', bad((t) => { delete t.mons[0].ev.spd; })],
  ];
  for (const [code, team] of cases) {
    try { c.T.encodeTeamBinary(team); return `${code}: encoded a bad team`; } catch (e) { if (e.code !== code) return `wanted ${code}, got ${e.code}: ${e.message}`; }
  }
  return c.T.encodeTeamBinary(ok).length > 0 ? true : 'the good twin did not encode';
});
add('team/ruleset-bits/every-layer-has-a-bit-and-all-combinations-round-trip', (c) => {
  for (const ly of RULES.RULESET_LAYERS) if (!c.T.LAYER_BITS.includes(ly)) return `layer ${ly} has no bit in teamcode.js`;
  if (c.T.LAYER_BITS.length !== RULES.RULESET_LAYERS.length) return 'LAYER_BITS has an entry rules.js does not know';
  let valid = 0;
  for (let mask = 0; mask < 1 << c.T.LAYER_BITS.length; mask++) {
    const layers = c.T.LAYER_BITS.filter((_, i) => mask & (1 << i));
    let id = null;
    try { id = RULES.resolveRuleset(['arena-gen3-standard', ...layers].join('+')).id; } catch (_e) { id = null; }
    const back = c.T.rulesetFromBytes(0, mask);
    if (id === null) { if (back !== null) return `mask ${mask} is a conflicting combination but decodes to ${back}`; continue; }
    valid++;
    if (back !== id) return `mask ${mask}: ${id} came back as ${back}`;
    const fwd = c.T.rulesetToBytes(id);
    if (fwd.bits !== mask || fwd.base !== 0) return `${id}: bits ${fwd.bits} != ${mask}`;
  }
  return valid >= 9 && c.T.rulesetFromBytes(1, 0) === null && c.T.rulesetFromBytes(0, 1 << c.T.LAYER_BITS.length) === null ? true : 'valid combinations ' + valid;
});
add('team/code/round-trip-and-size', async (c) => {
  const rng = mulberry32(5150);
  const d = detDeps(2);
  let maxChars = 0, maxBin = 0;
  for (let i = 0; i < 60 * FUZZ; i++) {
    const team = rndTeam(c.P, rng, d);
    const code = await c.T.encodeTeamCode(team);
    if (!/^ARENA1\.[A-Za-z0-9_-]+\.[0-9a-f]{4}$/.test(code)) return `shape ${code}`;
    const r = await c.T.decodeTeamCode(code, {});
    if (!r.ok) return `team ${i}: ${J(r)}`;
    if (canon(r.team.mons) !== canon(team.mons.map(c.T.battleView))) return `team ${i}: mons changed`;
    const bin = c.T.encodeTeamBinary(team);
    if (J([...r.binary]) !== J([...bin])) return `team ${i}: the code does not carry the card bytes`;
    if (r.hash !== c.T.cardHash(bin)) return 'hash';
    maxChars = Math.max(maxChars, code.length); maxBin = Math.max(maxBin, bin.length);
  }
  console.log(`  info largest code ${maxChars} chars, largest card ${maxBin} bytes (cap ${c.T.MAX_BINARY_BYTES})`);
  return maxChars <= c.T.MAX_CODE_CHARS && maxBin <= c.T.MAX_BINARY_BYTES ? true : 'size cap';
});
add('team/code/encode-says-so-when-the-browser-cannot-compress', async (c) => {
  const saved = globalThis.CompressionStream;
  globalThis.CompressionStream = undefined;
  try {
    const r = await throwsKind(() => c.T.encodeTeamCode({ name: 'X', ruleset: rulesetOf([]), romSha256: PINNED.sha256, mons: [GOLD_MON()] }), 'code.unsupported');
    return r === true ? true : r;
  } finally { globalThis.CompressionStream = saved; }
});
add('team/code/a-browser-with-gzip-but-no-deflate-raw-is-reported-as-unsupported', async (c) => {
  const RealC = globalThis.CompressionStream, RealD = globalThis.DecompressionStream;
  const picky = (Real) => class extends Real { constructor(format) { if (format === 'deflate-raw') throw new TypeError('Unsupported compression format: deflate-raw'); super(format); } };
  const team = { name: 'OLD', ruleset: rulesetOf([]), romSha256: PINNED.sha256, mons: [GOLD_MON()] };
  const code = await c.T.encodeTeamCode(team); // made while the real streams are in place
  globalThis.CompressionStream = picky(RealC);
  globalThis.DecompressionStream = picky(RealD);
  try {
    const e = await throwsKind(() => c.T.encodeTeamCode(team), 'code.unsupported');
    if (e !== true) return 'encode: ' + e;
    const d = await c.T.decodeTeamCode(code, {});
    if (d.ok || d.code !== 'code.unsupported') return 'decode: ' + J(d).slice(0, 150);
    const x = await c.P.exportBytes(makeProfile(c, detDeps(3), 2), { gzip: true, deps: detDeps() }); // gzip still works in such a browser
    return x.gzip === true ? true : 'gzip export should still be available';
  } finally { globalThis.CompressionStream = RealC; globalThis.DecompressionStream = RealD; }
});
add('team/code/pasted-forms-are-tolerated', async (c) => {
  const team = { name: 'PASTE', ruleset: rulesetOf([]), romSha256: PINNED.sha256, mons: [GOLD_MON(), GOLD_MON()] };
  const code = await c.T.encodeTeamCode(team);
  const forms = [` ${code}\n`, code.replace(/(.{20})/g, '$1\n'), code.replace('.', ' . '), code.slice(0, -4) + code.slice(-4).toUpperCase(), '\t' + code + '\r\n'];
  for (const f of forms) { const r = await c.T.decodeTeamCode(f, {}); if (!r.ok) return `rejected ${J(f).slice(0, 60)}: ${J(r)}`; }
  return true;
});
add('team/code/every-single-character-error-is-caught', async (c) => {
  const d = detDeps(2);
  const rng = mulberry32(2024);
  const codes = [await c.T.encodeTeamCode({ name: 'ERRS', ruleset: rulesetOf([]), romSha256: PINNED.sha256, mons: [GOLD_MON()] }), await c.T.encodeTeamCode(rndTeam(c.P, rng, d))];
  const ALPHA64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let tried = 0;
  for (const code of codes) {
    const firstDot = code.indexOf('.');
    const lastDot = code.lastIndexOf('.');
    for (let i = firstDot + 1; i < lastDot; i++) {
      for (const ch of ALPHA64) {
        if (ch === code[i]) continue;
        const bad = code.slice(0, i) + ch + code.slice(i + 1);
        const r = await c.T.decodeTeamCode(bad, {});
        tried++;
        if (r.ok) return `substituting ${J(ch)} at ${i} was accepted`;
        if (r.code !== 'code.crc') return `substitution at ${i}: expected code.crc, got ${r.code}`;
      }
    }
    for (let k = 1; k <= 12; k++) { // truncation of the payload (the dots and check kept)
      const bad = code.slice(0, lastDot - k) + code.slice(lastDot);
      const r = await c.T.decodeTeamCode(bad, {});
      tried++;
      if (r.ok) return `dropping the last ${k} payload characters was accepted`;
    }
    for (let i = firstDot + 1; i < lastDot; i += 7) { // insertion and deletion in the middle
      const del = code.slice(0, i) + code.slice(i + 1);
      const ins = code.slice(0, i) + 'A' + code.slice(i);
      for (const bad of [del, ins]) { const r = await c.T.decodeTeamCode(bad, {}); tried++; if (r.ok) return `an insertion or deletion at ${i} was accepted`; }
    }
    const crc = code.slice(lastDot + 1);
    for (let i = 0; i < 4; i++) for (const ch of '0123456789abcdef') {
      if (ch === crc[i]) continue;
      const r = await c.T.decodeTeamCode(code.slice(0, lastDot + 1) + crc.slice(0, i) + ch + crc.slice(i + 1), {});
      tried++;
      if (r.ok) return `a wrong check digit ${ch} at ${i} was accepted`;
    }
  }
  console.log(`  info ${tried} corrupted codes tried, none accepted`);
  return true;
});

const codeOf = (T, payloadText, prefix = 'ARENA1') => { const head = prefix + '.' + payloadText; return head + '.' + T.crc16(enc(head)).toString(16).padStart(4, '0'); };
const codeFrom = (T, rawBytes) => codeOf(T, T.b64urlEncode(rawBytes));
const rawDeflate = (bytes) => new Uint8Array(zlib.deflateRawSync(bytes));
add('team/code/error-matrix-every-code-has-a-firing-case', async (c) => {
  const T = c.T;
  const codes = Object.keys(T.TEAMCODE_ERRORS);
  const team = { name: 'ERR', ruleset: rulesetOf([]), romSha256: PINNED.sha256, mons: [GOLD_MON()] };
  const good = await T.encodeTeamCode(team);
  const bin = T.encodeTeamBinary(team);
  const NAME_LEN = 3, COUNT_AT = 8 + NAME_LEN, MON_AT = 9 + NAME_LEN;
  const withByte = (i, v) => Uint8Array.from(bin, (b, k) => (k === i ? v : b));
  const bomb = codeFrom(T, rawDeflate(Buffer.alloc(700 * 1024, 0)));
  if (bomb.length > T.MAX_CODE_CHARS) return 'the test bomb is longer than a legal code: ' + bomb.length;
  const cases = {
    'code.empty': ['   '], 'code.too-long': ['A'.repeat(1025)], 'code.format': ['ARENA1.abc'], 'code.prefix': ['NOPE1.abc.0000'], 'code.version': ['ARENA2.abc.0000'],
    'code.chars': ['ARENA1.ab*c.0000'], 'code.crc-format': ['ARENA1.abc.zz'], 'code.crc': [good.slice(0, -4) + (good.endsWith('0000') ? '1111' : '0000')],
    'code.base64': [codeOf(T, 'TR')], // 'TR' carries non-zero leftover bits; the check value is right, so only canonicality fails
    'code.inflate': [codeFrom(T, Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0xff]))], 'code.too-large': [bomb],
    'code.rom': [good, { expectRomSha256: 'f'.repeat(64) }],
    'code.unsupported': [good],
    'binary.length': [codeFrom(T, rawDeflate(Uint8Array.from([1, 0, 0])))],
    'binary.version': [codeFrom(T, rawDeflate(withByte(0, 9)))], 'binary.ruleset': [codeFrom(T, rawDeflate(withByte(1, 5)))],
    'binary.name': [codeFrom(T, rawDeflate(withByte(7, 30)))], 'binary.count': [codeFrom(T, rawDeflate(withByte(COUNT_AT, 0)))],
    'binary.mon': [codeFrom(T, rawDeflate(withByte(MON_AT + 4, 0)))], // level 0
  };
  const missing = codes.filter((k) => !k.startsWith('encode.') && !cases[k]);
  if (missing.length) return 'TEAMCODE_ERRORS codes with no case: ' + missing.join(', ');
  for (const code of codes) {
    if (code.startsWith('encode.')) continue; // exercised by team/binary/encode-refusals
    const [input, opts] = cases[code];
    let r;
    if (code === 'code.unsupported') {
      const saved = globalThis.DecompressionStream;
      globalThis.DecompressionStream = undefined;
      try { r = await T.decodeTeamCode(input, opts || {}); } finally { globalThis.DecompressionStream = saved; }
    } else r = await T.decodeTeamCode(input, opts || {});
    if (r.ok || r.code !== code) return code + ': got ' + (r.ok ? 'ok' : r.code) + ' (' + r.message + ')';
  }
  return true;
});
add('team/code/decompression-is-capped-before-memory-grows', async (c) => {
  const bomb = codeFrom(c.T, rawDeflate(Buffer.alloc(740 * 1024, 0))); // ~3000x the largest legal card, still a legal-length code
  if (bomb.length > c.T.MAX_CODE_CHARS) return 'test bomb is not a legal-length code: ' + bomb.length;
  const t0 = Date.now();
  const r = await c.T.decodeTeamCode(bomb, {});
  return !r.ok && r.code === 'code.too-large' && Date.now() - t0 < 3000 ? true : J(r) + ' in ' + (Date.now() - t0) + ' ms';
});
add('team/code/card-hash-is-the-sha256-of-the-card-bytes', async (c) => {
  const nodeCrypto = await import('node:crypto');
  const rng = mulberry32(3);
  for (let i = 0; i < 8; i++) {
    const bin = c.T.encodeTeamBinary(rndTeam(c.P, rng, detDeps(i + 1)));
    const want = nodeCrypto.createHash('sha256').update(bin).digest('hex');
    if (c.T.cardHash(bin) !== want) return 'cardHash differs from sha256 of the card bytes';
    const r = await c.T.decodeTeamCode(await c.T.encodeTeamCode(c.T.decodeTeamBinary(bin).ok ? { name: '', ruleset: rulesetOf([]), romSha256: PINNED.sha256, mons: [rndMon(c.P, rng, detDeps(9))] } : null), {});
    if (!r.ok || r.hash !== nodeCrypto.createHash('sha256').update(r.binary).digest('hex')) return 'decodeTeamCode().hash is not the sha256 of its own binary';
  }
  return true;
});
add('team/code/rom-id-is-checked-when-asked', async (c) => {
  const team = { name: 'ROM', ruleset: rulesetOf([]), romSha256: PINNED.sha256, mons: [GOLD_MON()] };
  const code = await c.T.encodeTeamCode(team);
  const yes = await c.T.decodeTeamCode(code, { expectRomSha256: PINNED.sha256 });
  const no = await c.T.decodeTeamCode(code, { expectRomSha256: '0'.repeat(64) });
  const other = await c.T.decodeTeamCode(await c.T.encodeTeamCode({ ...team, romSha256: 'a'.repeat(64) }), { expectRomSha256: PINNED.sha256 });
  return yes.ok && !no.ok && no.code === 'code.rom' && !other.ok && other.code === 'code.rom' ? true : 'rom checks ' + J([yes.ok, no.code, other.code]);
});
add('team/validate/a-pasted-code-validates-exactly-like-the-same-team-in-the-box', async (c) => {
  const rng = mulberry32(606);
  const d = detDeps(4);
  const presets = ['arena-gen3-standard', 'arena-gen3-standard+item-clause', 'arena-gen3-standard+lv100'];
  let legal = 0, illegal = 0;
  for (let i = 0; i < 25; i++) {
    const n = 1 + Math.floor(rng() * 6);
    const mons = [];
    for (let k = 0; k < n; k++) {
      const sid = USABLE[Math.floor(rng() * USABLE.length)];
      const rs = presets[i % 3];
      const rec = RULES.blankRec(sid, pack, rs);
      const m = c.P.createMon({ species: sid, nickname: rndText(rng, 10), level: rec.level, nature: Math.floor(rng() * 25), abilitySlot: rec.abilitySlot, moves: i % 4 === 3 && k === 0 ? [{ id: 1 + Math.floor(rng() * 900), ppUps: 0 }] : rec.moves,
        heldItem: rng() < 0.3 ? 0 : 1 + Math.floor(rng() * 20), gender: pack.species[sid].genderRatio === 255 ? '-' : pack.species[sid].genderRatio === 254 ? 'F' : 'M' }, d);
      mons.push(m);
    }
    const ruleset = presets[i % 3];
    const team = { name: 'VAL', ruleset, romSha256: PINNED.sha256, mons };
    const inBox = c.P.validateMonList(mons, pack, ruleset);
    const dec = await c.T.decodeTeamCode(await c.T.encodeTeamCode(team), {});
    if (!dec.ok) return `team ${i}: ${J(dec)}`;
    const viaCode = c.T.validateDecodedTeam(dec.team, pack);
    if (canon(viaCode.reasons) !== canon(inBox.reasons)) return `team ${i}: ${J(viaCode.reasons).slice(0, 200)} vs ${J(inBox.reasons).slice(0, 200)}`;
    if (inBox.ok) legal++; else illegal++;
  }
  return legal > 3 && illegal > 3 ? true : `exercised only ${legal} legal and ${illegal} illegal teams`;
});
add('team/helpers/profile-team-to-code-and-back-into-a-box', async (c) => {
  const p = makeProfile(c, detDeps(3), 4);
  const team = c.T.teamFromProfile(p, p.teams[0].id);
  if (team.mons.length !== 4 || team.name !== 'TEAM ONE') return 'teamFromProfile';
  const code = await c.T.encodeTeamCode(team);
  const dec = await c.T.decodeTeamCode(code, { expectRomSha256: p.romSha256 });
  const mons = c.T.monsFromDecoded(dec.team, detDeps(9));
  const probs = mons.flatMap((m) => c.P.checkMon(m));
  if (probs.length) return 'imported records are not well formed: ' + J(probs[0]);
  if (!mons.every((m) => m.origin === 'custom' && m.provenance.source === 'team-code' && c.P.isId(m.id))) return 'provenance / origin';
  return canon(mons.map(c.T.battleView)) === canon(team.mons.map(c.T.battleView)) ? true : 'battle view changed';
});

// =============================================================================================
// D. IDENTITY
// =============================================================================================
const slotOf = async (c, p) => c.I.keySlot(p.id, await c.I.keyIdOf(p.identity.publicKeyJwk));
function fakeKeys(persistent = true) {
  const m = new Map();
  return { persistent, map: m, get: async (id) => m.get(id), put: async (id, rec) => { m.set(id, { ...rec, id }); }, delete: async (id) => { m.delete(id); } };
}
async function newIdentityProfile(c, keys, d = detDeps()) {
  const p = c.P.createProfile({ trainerName: 'ID' }, d);
  const r = await c.I.ensureIdentity(p, keys, d);
  return r.profile;
}
const RECEIPT = () => ({ v: 1, kind: 'match-result', matchId: 'abc123', ruleset: 'arena-gen3-standard', winner: 0, seed: 123456, turns: 17, players: [{ keyId: 'a', name: 'ASH' }, { keyId: 'b', name: 'GARY' }] });
add('identity/generate/private-key-is-not-extractable', async (c) => {
  const id = await c.I.generateIdentity();
  if (id.privateKey.extractable !== false || id.privateKey.type !== 'private') return 'private key ' + id.privateKey.extractable;
  try { await crypto.subtle.exportKey('jwk', id.privateKey); return 'the private key was exportable'; } catch (_e) { /* expected */ }
  try { await crypto.subtle.exportKey('pkcs8', id.privateKey); return 'the private key was exportable as pkcs8'; } catch (_e) { /* expected */ }
  if (!c.P.isPublicJwk(id.publicKeyJwk) || 'd' in id.publicKeyJwk) return 'public JWK shape ' + J(id.publicKeyJwk);
  const again = await c.I.keyIdOf(id.publicKeyJwk);
  const other = await c.I.generateIdentity();
  return /^[0-9a-f]{16}$/.test(id.keyId) && again === id.keyId && other.keyId !== id.keyId ? true : 'keyId ' + id.keyId;
});
add('identity/jwk/strictness', async (c) => {
  const id = await c.I.generateIdentity();
  const j = id.publicKeyJwk;
  const bad = [[{ ...j, d: 'x' }, 'identity.private-jwk'], [{ ...j, k: 'x' }, 'identity.private-jwk'], [{ ...j, extra: 1 }, 'identity.jwk'], [{ ...j, crv: 'P-384' }, 'identity.jwk'], [{ ...j, kty: 'RSA' }, 'identity.jwk'],
    [{ ...j, x: j.x.slice(1) }, 'identity.jwk'], [{ kty: 'EC', crv: 'P-256', x: j.x }, 'identity.jwk'], [null, 'identity.jwk'], ['x', 'identity.jwk']];
  for (const [jwk, code] of bad) { const r = await throwsKind(() => c.I.keyIdOf(jwk), code); if (r !== true) return `${J(jwk).slice(0, 60)}: ${r}`; }
  const n = c.I.normalizePublicJwk({ ...j });
  return J(Object.keys(n).sort()) === '["crv","kty","x","y"]' ? true : 'normalised shape';
});
add('identity/receipt/signed-by-one-profile-verifies', async (c) => {
  const keys = fakeKeys();
  const p = await newIdentityProfile(c, keys);
  const entry = await c.I.signReceipt(p, keys, RECEIPT());
  const doc = c.I.makeReceiptDoc(RECEIPT(), [entry]);
  const v = await c.I.verifyReceipt(doc);
  if (!v.ok || v.signatures.length !== 1 || !v.signatures[0].ok || !/^[0-9a-f]{64}$/.test(v.digest)) return J(v);
  const st = await c.I.identityStatus(p, keys);
  return entry.keyId === st.keyId && J(entry.publicKeyJwk) === J(p.identity.publicKeyJwk) && c.T.b64urlDecode(entry.sig).length === 64 ? true : 'entry fields ' + J(entry).slice(0, 200);
});
add('identity/receipt/two-party-receipt-and-required-signers', async (c) => {
  const ka = fakeKeys(), kb = fakeKeys();
  const pa = await newIdentityProfile(c, ka), pb = await newIdentityProfile(c, kb);
  const ea = await c.I.signReceipt(pa, ka, RECEIPT()), eb = await c.I.signReceipt(pb, kb, RECEIPT());
  const doc = c.I.makeReceiptDoc(RECEIPT(), [ea, eb]);
  const both = await c.I.verifyReceipt(doc, { minSignatures: 2, requireKeyIds: [ea.keyId, eb.keyId] });
  if (!both.ok) return 'both parties: ' + J(both.reasons);
  const onlyA = c.I.makeReceiptDoc(RECEIPT(), [ea]);
  const need2 = await c.I.verifyReceipt(onlyA, { minSignatures: 2 });
  if (need2.ok) return 'one signature satisfied minSignatures 2';
  const needB = await c.I.verifyReceipt(onlyA, { requireKeyIds: [eb.keyId] });
  if (needB.ok) return 'a required signer who did not sign was accepted';
  const forged = c.I.makeReceiptDoc(RECEIPT(), [ea, { ...eb, sig: eb.sig.slice(0, 10) + (eb.sig[10] === 'A' ? 'B' : 'A') + eb.sig.slice(11) }]);
  const vf = await c.I.verifyReceipt(forged); // minSignatures defaults to 1, which the first (good) signature satisfies
  if (vf.ok) return 'a document with one good and one forged signature verified';
  const dup = c.I.makeReceiptDoc(RECEIPT(), [ea, ea]);
  const vd = await c.I.verifyReceipt(dup, { minSignatures: 2 });
  return vd.ok ? 'the same key counted twice' : true;
});
add('identity/receipt/tamper-matrix', async (c) => {
  const keys = fakeKeys();
  const p = await newIdentityProfile(c, keys);
  const entry = await c.I.signReceipt(p, keys, RECEIPT());
  const mallory = await c.I.generateIdentity();
  const good = c.I.makeReceiptDoc(RECEIPT(), [entry]);
  if (!(await c.I.verifyReceipt(good)).ok) return 'the untouched twin does not verify';
  const flipSig = (s, i, to) => s.slice(0, i) + to + s.slice(i + 1);
  const tamper = {
    'winner flipped': (d) => { d.receipt.winner = 1; },
    'seed changed': (d) => { d.receipt.seed = 123457; },
    'player renamed': (d) => { d.receipt.players[0].name = 'EVIL'; },
    'field added': (d) => { d.receipt.extra = 1; },
    'field removed': (d) => { delete d.receipt.turns; },
    'kind changed': (d) => { d.receipt.kind = 'other'; },
    'array order swapped': (d) => { d.receipt.players.reverse(); },
    'signature bit flipped': (d) => { d.signatures[0].sig = flipSig(d.signatures[0].sig, 10, d.signatures[0].sig[10] === 'A' ? 'B' : 'A'); },
    'signature truncated': (d) => { d.signatures[0].sig = d.signatures[0].sig.slice(0, -4); },
    'signature empty': (d) => { d.signatures[0].sig = ''; },
    'signature not a string': (d) => { d.signatures[0].sig = 5; },
    'attacker key swapped in with its own id': (d) => { d.signatures[0].publicKeyJwk = mallory.publicKeyJwk; d.signatures[0].keyId = mallory.keyId; },
    'attacker key swapped in, id kept': (d) => { d.signatures[0].publicKeyJwk = mallory.publicKeyJwk; },
    'keyId changed, key kept': (d) => { d.signatures[0].keyId = mallory.keyId; },
    'public key not P-256': (d) => { d.signatures[0].publicKeyJwk = { ...d.signatures[0].publicKeyJwk, crv: 'P-384' }; },
    'private member smuggled in': (d) => { d.signatures[0].publicKeyJwk = { ...d.signatures[0].publicKeyJwk, d: 'x' }; },
    'receipt version changed': (d) => { d.receipt.v = 2; },
    'signatures not an array': (d) => { d.signatures = {}; },
    'no signatures': (d) => { d.signatures = []; },
    'document is not an object': () => null,
  };
  for (const [name, f] of Object.entries(tamper)) {
    let d = JSON.parse(JSON.stringify(good));
    const r = f(d);
    if (r === null) d = null;
    const v = await c.I.verifyReceipt(d);
    if (v.ok) return `"${name}" still verifies`;
  }
  // a signature made over the same JSON WITHOUT the domain tag must not verify as a receipt (replay across purposes)
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const exported = await crypto.subtle.exportKey('jwk', kp.publicKey);
  const jwk = c.I.normalizePublicJwk({ kty: exported.kty, crv: exported.crv, x: exported.x, y: exported.y });
  const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, enc(canon(RECEIPT()))));
  const replay = c.I.makeReceiptDoc(RECEIPT(), [{ keyId: await c.I.keyIdOf(jwk), publicKeyJwk: jwk, sig: c.T.b64urlEncode(raw) }]);
  if ((await c.I.verifyReceipt(replay)).ok) return 'a signature over the receipt without the domain tag verifies';
  const tagged = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, enc(c.I.RECEIPT_DOMAIN + canon(RECEIPT()))));
  const okDoc = c.I.makeReceiptDoc(RECEIPT(), [{ keyId: await c.I.keyIdOf(jwk), publicKeyJwk: jwk, sig: c.T.b64urlEncode(tagged) }]);
  return (await c.I.verifyReceipt(okDoc)).ok ? true : 'the independently built correct signature does not verify (domain bytes differ from the documented ones)';
});
add('identity/receipt/shape-limits', async (c) => {
  const cases = [{ v: 2, kind: 'x' }, { v: 1 }, { v: 1, kind: '' }, { v: 1, kind: 'x', n: NaN }, { v: 1, kind: 'x', u: undefined }, { v: 1, kind: 'x', big: 'y'.repeat(5000) }, [], null, 'x'];
  for (const r of cases) if (c.I.receiptProblems(r).length === 0) return `accepted ${J(r).slice(0, 60)}`;
  if (c.I.receiptProblems(RECEIPT()).length) return 'the good receipt has problems';
  const keys = fakeKeys();
  const p = await newIdentityProfile(c, keys);
  const e = await throwsKind(() => c.I.signReceipt(p, keys, { v: 2, kind: 'x' }), 'identity.receipt');
  if (e !== true) return e;
  const d1 = await c.I.receiptDigest({ b: 2, a: 1, v: 1, kind: 'k' }), d2 = await c.I.receiptDigest({ kind: 'k', v: 1, a: 1, b: 2 });
  return d1 === d2 ? true : 'digest depends on key order';
});
add('identity/status/states-are-measured-by-doing', async (c) => {
  const d = detDeps();
  const keys = fakeKeys();
  const p0 = c.P.createProfile({ trainerName: 'ST' }, d);
  const none = await c.I.identityStatus(p0, keys);
  if (none.state !== 'none') return 'none: ' + none.state;
  const created = await c.I.ensureIdentity(p0, keys, d);
  const p = created.profile;
  const ok = await c.I.identityStatus(p, keys);
  if (ok.state !== 'ok' || !created.created) return 'ok: ' + ok.state;
  const eph = await c.I.identityStatus(p, fakeKeysShare(keys, false));
  if (eph.state !== 'ephemeral') return 'ephemeral: ' + eph.state;
  const empty = fakeKeys();
  const nokey = await c.I.identityStatus(p, empty);
  if (nokey.state !== 'no-key') return 'no-key: ' + nokey.state;
  const other = fakeKeys();
  const q = await newIdentityProfile(c, other, detDeps(2));
  other.map.set((await slotOf(c, p)), { ...other.map.get((await slotOf(c, q))), id: (await slotOf(c, p)) }); // somebody else's private key in this profile's slot
  const mism = await c.I.identityStatus(p, other);
  if (mism.state !== 'mismatch') return 'mismatch: ' + mism.state;
  const broken = fakeKeys();
  broken.map.set((await slotOf(c, p)), { id: (await slotOf(c, p)), privateKey: { not: 'a key' } });
  const unus = await c.I.identityStatus(p, broken);
  if (unus.state !== 'unusable') return 'unusable: ' + unus.state;
  const badJwk = clone(p);
  badJwk.identity.publicKeyJwk = { kty: 'EC', crv: 'P-256', x: 'A'.repeat(43), y: 'A'.repeat(43) }; // well formed, but not a point on the curve
  const unknownKey = await c.I.identityStatus(badJwk, keys);
  if (unknownKey.state !== 'no-key') return 'a JWK nobody holds a key for must read as no-key, got ' + unknownKey.state;
  keys.map.set(c.I.keySlot(p.id, await c.I.keyIdOf(badJwk.identity.publicKeyJwk)), { ...keys.map.get(await slotOf(c, p)) }); // now a private key exists for it, but the public half is not a valid key
  const inv = await c.I.identityStatus(badJwk, keys);
  const invalid2 = clone(p);
  invalid2.identity.publicKeyJwk = { nonsense: true };
  const inv2 = await c.I.identityStatus(invalid2, keys);
  const throws = { persistent: true, get: async () => { throw new Error('idb gone'); } };
  const unus2 = await c.I.identityStatus(p, throws);
  const seen = new Set([none.state, ok.state, eph.state, nokey.state, mism.state, unus.state, inv.state, inv2.state, unus2.state]);
  for (const s of c.I.IDENTITY_STATES) if (!seen.has(s)) return `state "${s}" has no firing case (saw ${[...seen].join(', ')})`;
  return inv.state === 'invalid' && inv2.state === 'invalid' && unus2.state === 'unusable' ? true : `invalid ${inv.state}, invalid2 ${inv2.state}, unusable2 ${unus2.state}`;
});
function fakeKeysShare(keys, persistent) { return { persistent, get: keys.get, put: keys.put, delete: keys.delete }; }
add('identity/ensure/only-creates-from-none-never-replaces', async (c) => {
  const d = detDeps();
  const keys = fakeKeys();
  const p = await newIdentityProfile(c, keys);
  const jwk = p.identity.publicKeyJwk;
  const again = await c.I.ensureIdentity(p, keys, d);
  if (again.created || J(again.profile.identity.publicKeyJwk) !== J(jwk)) return 'ensure on an ok identity changed it';
  const lost = fakeKeys();
  const r1 = await c.I.ensureIdentity(p, lost, d);
  if (r1.created || r1.status.state !== 'no-key' || lost.map.size !== 0) return `no-key: created=${r1.created} state=${r1.status.state} keys=${lost.map.size}`;
  const other = fakeKeys();
  const q = await newIdentityProfile(c, other, detDeps(3));
  other.map.set((await slotOf(c, p)), { ...other.map.get((await slotOf(c, q))), id: (await slotOf(c, p)) });
  const before = other.map.get((await slotOf(c, p)));
  const sizeBefore = other.map.size;
  const r2 = await c.I.ensureIdentity(p, other, d);
  if (r2.created || r2.status.state !== 'mismatch' || other.map.get((await slotOf(c, p))) !== before || other.map.size !== sizeBefore) return 'mismatch case replaced or added a key';
  return true;
});
add('identity/ensure/racing-tabs-each-keep-their-own-key-and-nothing-is-overwritten', async (c) => {
  const d = detDeps();
  const keys = fakeKeys();
  const p = c.P.createProfile({ trainerName: 'RACE' }, d);
  // two tabs hold the same stale copy (no identity yet) and both call ensureIdentity before either saves
  const a = await c.I.ensureIdentity(p, keys, d);
  const b = await c.I.ensureIdentity(p, keys, d);
  if (!a.created || !b.created || J(a.profile.identity.publicKeyJwk) === J(b.profile.identity.publicKeyJwk)) return 'the two tabs should each have made their own key';
  if (keys.map.size !== 2) return 'expected two key slots, got ' + keys.map.size;
  // whichever profile save wins, the winner's profile finds ITS key: the loser's key sitting in the store does not disturb it
  const sa = await c.I.identityStatus(a.profile, keys), sb = await c.I.identityStatus(b.profile, keys);
  if (sa.state !== 'ok' || sb.state !== 'ok' || sa.keyId === sb.keyId) return 'statuses ' + J([sa.state, sb.state]);
  const again = await c.I.ensureIdentity(a.profile, keys, d);
  if (again.created || keys.map.size !== 2) return 'ensure on a finished identity created something';
  // the signature made through the winner verifies under the winner's key only
  const entry = await c.I.signReceipt(a.profile, keys, RECEIPT());
  return entry.keyId === sa.keyId && (await c.I.verifyReceipt(c.I.makeReceiptDoc(RECEIPT(), [entry]), { requireKeyIds: [sa.keyId] })).ok ? true : 'signing through the winner';
});
add('identity/rotate/needs-an-explicit-acknowledgement-and-keeps-the-old-key', async (c) => {
  const keys = fakeKeys();
  const p = await newIdentityProfile(c, keys);
  const entry = await c.I.signReceipt(p, keys, RECEIPT());
  const doc = c.I.makeReceiptDoc(RECEIPT(), [entry]);
  const oldSlot = await slotOf(c, p);
  const slotsBefore = keys.map.size;
  for (const arg of [undefined, {}, { acknowledgeLoss: false }, { acknowledgeLoss: 'yes' }, { acknowledgeLoss: 1 }]) {
    const r = await throwsKind(() => c.I.rotateIdentity(p, keys, arg), 'identity.ack-required');
    if (r !== true) return `${J(arg)}: ${r}`;
  }
  const rot = await c.I.rotateIdentity(p, keys, { acknowledgeLoss: true, reason: 'lost device', now: 777 });
  if (rot.status.state !== 'ok' || J(rot.profile.identity.publicKeyJwk) === J(p.identity.publicKeyJwk)) return 'rotation did not produce a new working key';
  const prev = rot.profile.identity.previousKeys;
  if (prev.length !== 1 || J(prev[0].publicKeyJwk) !== J(p.identity.publicKeyJwk) || prev[0].retiredAt !== 777 || prev[0].reason !== 'lost device') return 'previousKeys ' + J(prev);
  if (rot.retired !== entry.keyId) return 'retired key id';
  if (c.P.checkProfile({ ...rot.profile, rev: 0 }).length) return 'rotated profile invalid: ' + J(c.P.checkProfile(rot.profile)[0]);
  const v = await c.I.verifyReceipt(doc);
  if (!v.ok) return 'an earlier receipt stopped verifying after rotation';
  const e2 = await c.I.signReceipt(rot.profile, keys, RECEIPT());
  if (e2.keyId === entry.keyId) return 'the new key signed with the old id';
  // nothing was overwritten or deleted: the retired private key is still in its own slot, next to the new one
  return keys.map.has(oldSlot) && keys.map.size === slotsBefore + 1 ? true : 'rotation touched the old key slot (size ' + keys.map.size + ')';
});
add('identity/export-policy/public-key-travels-private-key-does-not', async (c) => {
  const keys = fakeKeys();
  const p = await newIdentityProfile(c, keys);
  const e = c.P.buildExport(p, { deps: detDeps() });
  const text = c.P.serializeExport(e);
  if (/"d"\s*:/.test(text) || !text.includes(p.identity.publicKeyJwk.x)) return 'the export must contain the public JWK and no "d"';
  const r = await c.P.parseExport(text, {});
  if (!r.ok) return J(r).slice(0, 200);
  const there = fakeKeys(); // another browser: no private key
  const st = await c.I.identityStatus(r.profile, there);
  if (st.state !== 'no-key' || st.keyId !== (await c.I.identityStatus(p, keys)).keyId) return 'on a browser without the key the state must be no-key, got ' + st.state;
  let threw = null;
  try { await c.I.signReceipt(r.profile, there, RECEIPT()); } catch (e2) { threw = e2; }
  return threw && threw.code === 'identity.cannot-sign' ? true : 'signing without the key must refuse: ' + (threw && threw.message);
});
add('identity/notice-states-the-per-browser-limit', (c) => (/browser profile only/.test(c.I.IDENTITY_NOTICE) && /private key never/.test(c.I.IDENTITY_NOTICE) ? true : 'IDENTITY_NOTICE no longer says the identity is per browser profile and that the private key never travels'));

// =============================================================================================
// E. STORE (memory adapter)
// =============================================================================================
let storeSeq = 0;
const uniqueName = (tag) => `t-${tag}-${storeSeq++}`;
async function openMem(c, tag, extra = {}) {
  const name = extra.name || uniqueName(tag);
  const adapter = c.S.createMemoryAdapter({ name, durable: true });
  const store = await c.S.openStore({ adapter, channel: extra.channel === undefined ? false : extra.channel, deps: extra.deps || detDeps(Math.floor(Math.random() * 1e6) + 1), storage: extra.storage });
  return { store, name, adapter };
}
const memCtx = (c) => ({ make: async (name) => { const a = c.S.createMemoryAdapter({ name }); await a.open(); return a; }, destroy: async (name) => c.S.dropMemoryDb(name) });

add('store/contract/memory-adapter-passes-every-case', async (c) => {
  const res = await c.S.runAdapterContract(memCtx(c));
  const bad = res.filter((r) => !r.ok);
  return bad.length === 0 && res.length >= 12 ? true : bad.map((r) => r.name + ': ' + r.detail).join(' | ') || `only ${res.length} cases`;
});
add('store/crud/create-save-load-and-compare-and-swap-between-two-stores', async (c) => {
  const a = await openMem(c, 'cas');
  const b = await openMem(c, 'cas2', { name: a.name });
  const p1 = await a.store.createProfile({ trainerName: 'ONE' });
  if (p1.rev !== 1) return 'create gave rev ' + p1.rev;
  const la = (await a.store.loadProfile(p1.id)).profile;
  const lb = (await b.store.loadProfile(p1.id)).profile;
  la.trainerName = 'FROMA';
  const sa = await a.store.saveProfile(la);
  if (sa.rev !== 2) return 'save A rev ' + sa.rev;
  lb.trainerName = 'FROMB';
  const conflict = await throwsKind(() => b.store.saveProfile(lb), 'store.conflict');
  if (conflict !== true) return 'B overwrote A: ' + conflict;
  let ce;
  try { await b.store.saveProfile(lb); } catch (e) { ce = e; }
  if (!(ce instanceof c.S.ConflictError) || ce.detail.expectedRev !== 1 || ce.detail.actualRev !== 2 || ce.detail.current.trainerName !== 'FROMA') return 'ConflictError detail ' + J(ce && ce.detail).slice(0, 200);
  const re = (await b.store.loadProfile(p1.id)).profile;
  if (re.trainerName !== 'FROMA' || re.rev !== 2) return 'reload after conflict';
  re.trainerName = 'FROMB';
  const sb = await b.store.saveProfile(re);
  const dup = await throwsKind(() => a.store.saveProfile({ ...p1, rev: 0 }), 'store.conflict'); // create over an existing id
  if (dup !== true) return 'create-over-existing: ' + dup;
  return sb.rev === 3 && (await a.store.loadProfile(p1.id)).profile.trainerName === 'FROMB' ? true : 'final state';
});
add('store/crud/save-returns-a-copy-and-never-aliases-the-stored-doc', async (c) => {
  const { store } = await openMem(c, 'alias');
  const p = await store.createProfile({ trainerName: 'AL' });
  p.trainerName = 'MUT';
  const l1 = (await store.loadProfile(p.id)).profile;
  if (l1.trainerName !== 'AL') return 'mutating the returned profile changed the store';
  l1.box.push({ junk: 1 });
  const l2 = (await store.loadProfile(p.id)).profile;
  return l2.box.length === 0 ? true : 'mutating a loaded profile changed the store';
});
add('store/crud/invalid-profiles-are-refused-and-leave-the-store-alone', async (c) => {
  const { store } = await openMem(c, 'valid');
  const p = await store.createProfile({ trainerName: 'OK' });
  const bad = clone(p);
  bad.box.push({ id: 'x' });
  const e = await throwsKind(() => store.saveProfile(bad), 'store.invalid');
  if (e !== true) return e;
  const bad2 = clone(p); bad2.schemaVersion = 1;
  const e2 = await throwsKind(() => store.saveProfile(bad2), 'store.invalid');
  if (e2 !== true) return 'older schemaVersion: ' + e2;
  const hist = await store.listHistory(p.id);
  return hist.length === 0 && (await store.loadProfile(p.id)).profile.rev === 1 ? true : 'the store changed after refused saves';
});
add('store/history/ring-keeps-the-last-five-replaced-revisions-and-restore-adds-a-revision', async (c) => {
  const { store } = await openMem(c, 'ring');
  let p = await store.createProfile({ trainerName: 'R1' });
  for (let i = 2; i <= 9; i++) { p.trainerName = 'R' + i; p = await store.saveProfile(p); }
  if (p.rev !== 9) return 'rev ' + p.rev;
  const h = await store.listHistory(p.id);
  if (J(h.map((x) => x.rev)) !== '[8,7,6,5,4]') return 'history revs ' + J(h.map((x) => x.rev));
  const restored = await store.restoreRevision(p.id, 6);
  if (restored.rev !== 10 || restored.trainerName !== 'R6') return `restore -> rev ${restored.rev} name ${restored.trainerName}`;
  const h2 = await store.listHistory(p.id);
  if (J(h2.map((x) => x.rev)) !== '[9,8,7,6,5]') return 'history after restore ' + J(h2.map((x) => x.rev));
  if (h2[0].reason !== 'restore-of-6' || h2[1].reason !== 'save') return 'reasons ' + J(h2.map((x) => x.reason));
  const nf = await throwsKind(() => store.restoreRevision(p.id, 1), 'store.not-found');
  if (nf !== true) return 'an evicted revision: ' + nf;
  const cf = await throwsKind(() => store.restoreRevision(p.id, 6, { expectedRev: 3 }), 'store.conflict');
  return cf === true ? true : 'expectedRev: ' + cf;
});
add('store/history/other-profiles-have-separate-rings', async (c) => {
  const { store } = await openMem(c, 'rings');
  let a = await store.createProfile({ trainerName: 'AAA' });
  let b = await store.createProfile({ trainerName: 'BBB' });
  for (let i = 0; i < 7; i++) { a.trainerName = 'A' + i; a = await store.saveProfile(a); }
  b.trainerName = 'B1'; b = await store.saveProfile(b);
  const ha = await store.listHistory(a.id), hb = await store.listHistory(b.id);
  return ha.length === 5 && hb.length === 1 && hb[0].rev === 1 ? true : `ring sizes ${ha.length}/${hb.length}`;
});
add('store/migration/writes-back-with-the-old-revision-kept-in-history', async (c) => {
  const { store, adapter } = await openMem(c, 'mig');
  await adapter.transact(['profiles'], 'readwrite', (tx) => tx.put('profiles', clone(c.FIX.v1full)));
  const r = await store.loadProfile('p_fixture01');
  if (!r.ok || r.migratedFrom !== 1 || r.readOnly || r.profile.rev !== 8 || r.profile.schemaVersion !== 3) return 'load ' + J({ ok: r.ok, mf: r.migratedFrom, rev: r.profile && r.profile.rev });
  const h = await store.listHistory('p_fixture01');
  if (h.length !== 1 || h[0].rev !== 7 || h[0].reason !== 'migration') return 'history ' + J(h);
  const stored = await adapter.transact(['profileHistory'], 'readonly', (tx) => tx.get('profileHistory', c.S.historyKey('p_fixture01', 7)));
  if (!stored || canon(stored.doc) !== canon(c.FIX.v1full)) return 'the pre-migration document in history is not the original v1 bytes';
  const again = await store.loadProfile('p_fixture01');
  if (again.profile.rev !== 8 || again.migratedFrom !== null) return 'a second load wrote again (rev ' + again.profile.rev + ')';
  const want = clone(c.FIX.v1fullExp);
  want.rev = 8;
  want.updatedAt = NOW;
  return canon(withoutRev({ ...again.profile, updatedAt: 0 })) === canon(withoutRev({ ...want, updatedAt: 0 })) ? true : 'migrated + stored profile differs from the golden';
});
add('store/newer-document/read-only-and-never-rewritten', async (c) => {
  const { store, adapter } = await openMem(c, 'newer');
  await adapter.transact(['profiles'], 'readwrite', (tx) => tx.put('profiles', clone(c.FIX.fut)));
  const before = await adapter.transact(['profiles'], 'readonly', (tx) => tx.get('profiles', 'p_future'));
  const r = await store.loadProfile('p_future');
  if (!r.ok || !r.readOnly || r.migratedFrom !== null) return 'load ' + J(r).slice(0, 200);
  const list = await store.listProfiles();
  if (!(list.length === 1 && list[0].readOnly === true && list[0].corrupt === false && list[0].schemaVersion === 4)) return 'listProfiles ' + J(list);
  const forged = { ...goodProfile(c), id: 'p_future', rev: 4 };
  const e1 = await throwsKind(() => store.saveProfile(forged), 'store.read-only');
  const e2 = await throwsKind(() => store.saveProfile({ ...r.profile }), 'store.read-only');
  const e3 = await throwsKind(() => store.deleteProfile('p_future'), 'store.read-only');
  const e4 = await throwsKind(() => store.restoreRevision('p_future', 1), 'store.not-found');
  if (e1 !== true || e2 !== true || e3 !== true || e4 !== true) return 'refusals: ' + J([e1, e2, e3, e4]);
  const after = await adapter.transact(['profiles'], 'readonly', (tx) => tx.get('profiles', 'p_future'));
  const h = await store.listHistory('p_future');
  return canon(after) === canon(before) && h.length === 0 ? true : 'the newer document was modified';
});
add('store/quarantine/shape-bad-records-are-moved-with-their-raw-json', async (c) => {
  const { store, adapter } = await openMem(c, 'quar');
  await adapter.transact(['profiles'], 'readwrite', (tx) => tx.put('profiles', clone(c.FIX.v1bad)));
  const r = await store.loadProfile('p_fixture02');
  if (!r.ok || r.quarantined.length !== 3 || r.profile.box.length !== 1) return 'load ' + J({ ok: r.ok, q: r.quarantined && r.quarantined.length });
  const q = await store.listQuarantine('p_fixture02');
  if (q.length !== 3 || q[0].raw.id !== 'm_bad' || q.find((x) => x.raw === 'this is not a record') === undefined) return 'quarantine rows ' + J(q.map((x) => x.kind + x.index)).slice(0, 200);
  const h = await store.listHistory('p_fixture02');
  if (h.length !== 1 || h[0].reason !== 'migration') return 'the pre-migration document is not in history: ' + J(h);
  // and a CURRENT-version document with a shape-bad record is repaired the same way, with reason "repair"
  const v2 = clone(c.FIX.cur);
  v2.id = 'p_v2bad';
  v2.box[1].level = 0;
  v2.teams[0].monIds = ['m_a'];
  await adapter.transact(['profiles'], 'readwrite', (tx) => tx.put('profiles', v2));
  const r2 = await store.loadProfile('p_v2bad');
  const h2 = await store.listHistory('p_v2bad');
  if (!r2.ok || r2.profile.box.length !== 1 || r2.quarantined.length !== 1 || h2.length !== 1 || h2[0].reason !== 'repair' || h2[0].rev !== 12) return 'v2 repair: ' + J({ ok: r2.ok, n: r2.profile && r2.profile.box.length, h: h2 });
  const stored = await adapter.transact(['profileHistory'], 'readonly', (tx) => tx.get('profileHistory', c.S.historyKey('p_v2bad', 12)));
  if (!stored || stored.doc.box[1].level !== 0) return 'the history copy must be the document as it was, bad record included';
  await store.clearQuarantine(q[0].qid);
  return (await store.listQuarantine()).length === 3 ? true : 'clearQuarantine';
});
add('store/quarantine/an-unreadable-document-is-reported-copied-and-left-in-place', async (c) => {
  const { store, adapter } = await openMem(c, 'corrupt');
  await adapter.transact(['profiles'], 'readwrite', async (tx) => { await tx.put('profiles', { id: 'p_junk', schemaVersion: 'banana' }); await tx.put('profiles', { id: 'p_nover', weird: true }); });
  const r = await store.loadProfile('p_junk');
  if (r.ok || r.code !== 'profile.version' || !r.quarantineId) return 'load ' + J(r).slice(0, 200);
  const list = await store.listProfiles();
  if (list.length !== 2 || !list.every((x) => x.corrupt)) return 'listProfiles should flag both as corrupt: ' + J(list);
  const q = await store.listQuarantine('p_junk');
  const still = await adapter.transact(['profiles'], 'readonly', (tx) => tx.get('profiles', 'p_junk'));
  const nf = await store.loadProfile('p_missing');
  return q.length === 1 && q[0].kind === 'document' && q[0].raw && q[0].raw.schemaVersion === 'banana' && still && still.schemaVersion === 'banana' && nf.code === 'store.not-found' ? true : 'copy / left in place / not-found';
});
add('store/restore/can-repair-an-unreadable-current-document-from-history', async (c) => {
  const { store, adapter } = await openMem(c, 'repair');
  let p = await store.createProfile({ trainerName: 'FINE' });
  p.trainerName = 'FINE2'; p = await store.saveProfile(p);
  await adapter.transact(['profiles'], 'readwrite', (tx) => tx.put('profiles', { id: p.id, garbage: true })); // current document destroyed
  const lost = await store.loadProfile(p.id);
  if (lost.ok) return 'a destroyed document loaded';
  const back = await store.restoreRevision(p.id, 1);
  const h = await store.listHistory(p.id);
  return back.trainerName === 'FINE' && back.rev > 2 && h.some((x) => x.rev === 2) ? true : `restore -> ${J({ n: back.trainerName, rev: back.rev })} history ${J(h.map((x) => x.rev))}`;
});
add('store/load/repairs-an-unusable-rev-without-losing-the-document', async (c) => {
  const { store, adapter } = await openMem(c, 'badrev');
  const doc = clone(c.FIX.cur);
  doc.id = 'p_badrev';
  doc.rev = 'seven';
  await adapter.transact(['profiles'], 'readwrite', (tx) => tx.put('profiles', doc));
  const r = await store.loadProfile('p_badrev');
  if (!r.ok || r.repaired < 1 || r.profile.rev < 1) return 'load ' + J({ ok: r.ok, rep: r.repaired, rev: r.profile && r.profile.rev });
  const h = await store.listHistory('p_badrev');
  const stored = h.length === 1 ? await adapter.transact(['profileHistory'], 'readonly', (tx) => tx.get('profileHistory', c.S.historyKey('p_badrev', h[0].rev))) : null;
  if (!stored || stored.doc.rev !== 'seven') return 'the original document (with its unusable rev) must be in history: ' + J(h);
  return h[0].reason === 'repair' && r.profile.rev === h[0].rev + 1 ? true : 'revision numbering after repair: ' + J({ hist: h, rev: r.profile.rev });
});
add('store/save/is-atomic-a-failure-mid-commit-leaves-neither-history-nor-profile-changed', async (c) => {
  const name = uniqueName('atomic');
  const inner = c.S.createMemoryAdapter({ name, durable: true });
  let failAt = 0;
  const wrapped = { ...inner, kind: 'memory', durable: true, readOnly: false, open: () => inner.open(), close: () => inner.close(),
    transact: (names, mode, fn) => inner.transact(names, mode, (tx) => { let puts = 0; return fn({ ...tx, put: async (s, v) => { puts++; if (failAt && puts === failAt) throw new Error('disk on fire'); return tx.put(s, v); } }); }) };
  const store = await c.S.openStore({ adapter: wrapped, channel: false, deps: detDeps(5) });
  let p = await store.createProfile({ trainerName: 'ATOM' });
  p.trainerName = 'CHANGED';
  for (const at of [1, 2]) {
    failAt = at;
    const e = await throwsKind(() => store.saveProfile(p));
    if (e !== true) return `failAt ${at}: ${e}`;
  }
  failAt = 0;
  const h = await store.listHistory(p.id);
  const cur = (await store.loadProfile(p.id)).profile;
  if (h.length !== 0 || cur.rev !== 1 || cur.trainerName !== 'ATOM') return `partial commit: history ${h.length}, rev ${cur.rev}, name ${cur.trainerName}`;
  if (store.status.notSaved !== true || !/write-failed/.test(store.status.reason)) return 'a failed write must set the sticky not-saved flag';
  return (await store.saveProfile(p)).rev === 2 ? true : 'the next save should work';
});
add('store/probe/a-working-store-is-saved-and-a-broken-one-falls-back-to-memory-loudly', async (c) => {
  const good = await openMem(c, 'pgood');
  const gs = good.store.status;
  if (gs.notSaved || gs.mode !== 'memory' || gs.durable !== true || !gs.probe.ok || gs.fellBack) return 'healthy status ' + J(gs);
  const mk = (name, over) => {
    const inner = c.S.createMemoryAdapter({ name: uniqueName(name), durable: true });
    return { ...inner, kind: 'indexeddb', durable: true, readOnly: false, open: () => inner.open(), close: () => inner.close(), transact: (n, m, f) => inner.transact(n, m, (tx) => f(over(tx, m))) , _inner: inner };
  };
  const cases = [
    ['write throws', { kind: 'indexeddb', open: async () => {}, close: async () => {}, transact: async () => { throw new Error('QuotaExceededError'); } }, /write/],
    ['open throws', { kind: 'indexeddb', open: async () => { throw new Error('SecurityError: blocked'); }, close: async () => {}, transact: async () => {} }, /SecurityError/],
    ['writes are silently dropped', mk('drop', (tx, m) => ({ ...tx, put: async () => {} })), /compare/],
    ['reads return something else', mk('other', (tx) => ({ ...tx, get: async (s, k) => (k.startsWith('__probe__') ? { key: k, value: 'WRONG' } : tx.get(s, k)) })), /compare/],
    ['delete does nothing', mk('nodel', (tx) => ({ ...tx, delete: async () => {} })), /verify-gone/],
  ];
  let caseNo = 0;
  for (const [what, adapter, re] of cases) {
    const s = await c.S.openStore({ adapter, channel: false, deps: detDeps(60 + caseNo++) });
    const st = s.status;
    if (st.mode !== 'memory' || st.notSaved !== true || st.fellBack !== true || !re.test(st.reason)) return `${what}: status ${J({ mode: st.mode, ns: st.notSaved, fb: st.fellBack, reason: st.reason })}`;
    const p = await s.createProfile({ trainerName: 'MEM' });
    if (p.rev !== 1 || !(await s.loadProfile(p.id)).ok) return `${what}: the memory fallback does not work`;
    if (s.status.notSaved !== true) return `${what}: notSaved was cleared by a successful in-memory save`;
  }
  return true;
});
add('store/probe/a-browser-that-throws-when-indexedDB-is-read-falls-back-to-memory', async (c) => {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  Object.defineProperty(globalThis, 'indexedDB', { get() { throw new DOMException('Access to the storage is denied', 'SecurityError'); }, configurable: true });
  try {
    let store, threw = null;
    try { store = await c.S.openStore({ channel: false, dbName: uniqueName('blocked') }); } catch (e) { threw = e; }
    if (threw) return 'openStore threw instead of falling back: ' + threw.name + ': ' + threw.message;
    const s = store.status;
    if (s.mode !== 'memory' || !s.notSaved || !/storage-unavailable/.test(s.reason || '')) return 'status ' + J(s);
    const p = await store.createProfile({ trainerName: 'MEM' });
    return p.rev === 1 && (await store.listProfiles()).length === 1 ? true : 'the memory fallback does not work';
  } finally { if (had) Object.defineProperty(globalThis, 'indexedDB', had); else delete globalThis.indexedDB; }
});
add('store/delete/delete-everything-empties-every-store-in-one-transaction', async (c) => {
  const { store } = await openMem(c, 'wipe');
  const a = await store.createProfile({ trainerName: 'AAA' }), b = await store.createProfile({ trainerName: 'BBB' });
  a.trainerName = 'A2'; await store.saveProfile(a);
  await store.keys.put(a.id + ':k1', { privateKey: null, publicKeyJwk: null, createdAt: 1 });
  await store.setActiveId(a.id);
  await store.setMeta('somethingElse', 7);
  await store.applyImport(c.P.planImport(b, { ...JSON.parse(JSON.stringify(b)), trainerName: 'B2' }, 'replace', detDeps())).catch(() => null);
  const raw = { id: 'p_bad', schemaVersion: 2 };
  await store.adapter.transact(['quarantine'], 'readwrite', (tx) => tx.put('quarantine', { qid: 'q1', at: 1, profileId: 'p_bad', kind: 'document', index: -1, raw, problems: [] }));
  const n = await store.deleteEverything();
  const left = await store.adapter.transact(Object.keys(c.S.STORES), 'readonly', async (tx) => { const out = {}; for (const s of Object.keys(c.S.STORES)) out[s] = (await tx.list(s)).length; return out; });
  const again = await store.deleteEverything();
  return n === 2 && again === 0 && Object.values(left).every((x) => x === 0) && (await store.getActiveId()) === null ? true : 'left ' + J(left) + ' removed ' + n + '/' + again;
});
add('store/probe/an-open-that-never-finishes-falls-back-instead-of-hanging', async (c) => {
  const hang = { kind: 'indexeddb', durable: true, open: () => new Promise(() => {}), close: async () => {}, transact: async () => { throw new Error('never opened'); } };
  const t0 = Date.now();
  const s = await Promise.race([c.S.openStore({ adapter: hang, channel: false, openTimeoutMs: 40, deps: detDeps(77) }), sleep(3000).then(() => null)]);
  if (!s) return 'openStore did not return within 3 s for an adapter whose open() never resolves';
  const st = s.status;
  if (st.mode !== 'memory' || !st.notSaved || !st.fellBack || !/timed out/.test(st.reason)) return 'status ' + J(st);
  return Date.now() - t0 < 2000 ? true : 'took ' + (Date.now() - t0) + ' ms';
});
add('store/probe/memory-only-storage-is-flagged-not-saved', async (c) => {
  const s = await c.S.openStore({ adapter: c.S.createMemoryAdapter({ name: uniqueName('nd') }), channel: false, deps: detDeps(7) });
  const st = s.status;
  return st.notSaved === true && st.durable === false && /memory-only/.test(st.reason) && st.fellBack === undefined ? true : 'status ' + J(st);
});
add('store/status/a-programming-error-does-not-flip-the-not-saved-flag', async (c) => {
  const { store } = await openMem(c, 'prog');
  const e = await throwsKind(() => store._tx(['meta'], 'readwrite', () => { throw new TypeError('bug'); }));
  return e === true && store.status.notSaved === false ? true : 'a TypeError set notSaved';
});
add('store/persistence/request-hook', async (c) => {
  const mkStorage = (o) => ({ ...(o.persisted !== undefined ? { persisted: async () => o.persisted } : {}), persist: o.persist });
  const run = async (storage) => { const { store } = await openMem(c, 'persist', { storage }); const r = await store.requestPersistence(); return { r, st: store.status.persistence, meta: await store.getMeta('persistGranted') }; };
  const a = await run(mkStorage({ persisted: false, persist: async () => true }));
  if (!(a.r.supported && a.r.requested && a.r.granted === true && a.meta === true && a.st.granted === true)) return 'granted ' + J(a);
  const b = await run(mkStorage({ persisted: false, persist: async () => false }));
  if (!(b.r.requested && b.r.granted === false && b.meta === false)) return 'denied ' + J(b);
  let called = 0;
  const cc = await run(mkStorage({ persisted: true, persist: async () => { called++; return true; } }));
  if (called !== 0 || cc.r.granted !== true || cc.r.requested !== false || cc.r.alreadyPersisted !== true) return 'already persisted ' + J(cc);
  const d = await run(mkStorage({ persist: async () => { throw new Error('nope'); } }));
  if (d.r.granted !== null || !/nope/.test(d.r.error)) return 'throwing persist ' + J(d);
  const e = await run(null);
  return e.r.supported === false && e.r.granted === null ? true : 'no StorageManager ' + J(e);
});
add('store/sync/broadcast-reaches-the-other-instance-and-marks-it-stale', async (c) => {
  const a = await openMem(c, 'bc', { channel: BroadcastChannel });
  const b = await openMem(c, 'bc2', { name: a.name, channel: BroadcastChannel });
  try {
    if (!a.store.status.sync.enabled || !b.store.status.sync.enabled) return 'sync not enabled: ' + J(a.store.status.sync);
    const got = [];
    b.store.on('external', (m) => got.push(m));
    const p = await a.store.createProfile({ trainerName: 'SYNC' });
    for (let i = 0; i < 40 && !got.length; i++) await sleep(25);
    if (!got.length || got[0].t !== 'saved' || got[0].id !== p.id || got[0].rev !== 1) return 'no/odd message: ' + J(got);
    const held = { ...p, rev: 0 };
    if (!b.store.isStale(held)) return 'a copy older than the announced rev must be stale';
    if (b.store.isStale({ ...p, rev: 1 })) return 'a current copy must not be stale';
    const selfEcho = [];
    a.store.on('external', (m) => selfEcho.push(m));
    await a.store.saveProfile(p);
    await sleep(80);
    return selfEcho.length === 0 ? true : 'an instance heard its own message';
  } finally { await a.store.close(); await b.store.close(); }
});
add('store/sync/disabled-channel-is-reported', async (c) => {
  const { store } = await openMem(c, 'nobc', { channel: false });
  const s = store.status.sync;
  return s.enabled === false && /not available/.test(s.reason) ? true : J(s);
});
add('store/import/apply-takes-an-automatic-backup-that-restores-exactly', async (c) => {
  const { store } = await openMem(c, 'imp');
  let cur = await store.createProfile({ trainerName: 'LOCAL' });
  const rng = mulberry32(4);
  const d = detDeps(8);
  for (let i = 0; i < 3; i++) cur.box.push(rndMon(c.P, rng, d));
  cur = await store.saveProfile(cur);
  const incoming = makeProfile(c, detDeps(12), 2, { trainerName: 'INCOMING', seed: 71 });
  const text = c.P.serializeExport(c.P.buildExport(incoming, { deps: detDeps() }));
  const parsed = await c.P.parseExport(text, {});
  const before = canon(withoutRev(cur));
  const plan = c.P.planImport(cur, parsed.profile, 'replace', d);
  const saved = await store.applyImport(plan);
  if (saved.trainerName !== 'INCOMING' || saved.id !== cur.id || saved.rev !== cur.rev + 1 || saved.box.length !== 2) return 'replace result ' + J({ n: saved.trainerName, rev: saved.rev });
  const backup = await store.getAutoBackup(cur.id);
  if (!backup || backup.reason !== 'pre-import-replace' || !backup.file || backup.file.format !== 'pokemonarena-profile') return 'no automatic backup: ' + J(backup).slice(0, 200);
  const h = await store.listHistory(cur.id);
  if (!h.length || h[0].reason !== 'import-replace') return 'history entry for the import: ' + J(h);
  // restore: parse the backup file and replace again
  const back = await c.P.parseExport(JSON.stringify(backup.file), {});
  if (!back.ok) return 'the backup does not parse: ' + J(back).slice(0, 200);
  const plan2 = c.P.planImport(saved, back.profile, 'replace', d);
  const restored = await store.applyImport(plan2);
  if (canon(withoutRev({ ...restored, updatedAt: cur.updatedAt, rev: 0 })) !== canon(withoutRev({ ...cur, updatedAt: cur.updatedAt, rev: 0 }))) return 'the restored profile differs from the one before the import';
  void before;
  const m = c.P.planImport(restored, parsed.profile, 'merge', d);
  const merged = await store.applyImport(m);
  const nw = c.P.planImport(null, parsed.profile, 'new', d);
  const created = await store.applyImport(nw);
  const all = await store.listProfiles();
  return merged.box.length === restored.box.length + 2 && created.id !== cur.id && all.length === 2 && (await store.getAutoBackup(created.id)) === undefined ? true : 'merge/new results ' + J({ mb: merged.box.length, all: all.length });
});
add('store/import/apply-detects-a-concurrent-change', async (c) => {
  const a = await openMem(c, 'impc');
  const b = await openMem(c, 'impc2', { name: a.name });
  const cur = await a.store.createProfile({ trainerName: 'CC' });
  const incoming = makeProfile(c, detDeps(12), 2, { seed: 72 });
  const parsed = await c.P.parseExport(c.P.serializeExport(c.P.buildExport(incoming, { deps: detDeps() })), {});
  const plan = c.P.planImport(cur, parsed.profile, 'merge', detDeps(2));
  const other = (await b.store.loadProfile(cur.id)).profile;
  other.trainerName = 'ELSEWHERE';
  await b.store.saveProfile(other);
  const e = await throwsKind(() => a.store.applyImport(plan), 'store.conflict');
  if (e !== true) return 'the stale plan was applied: ' + e;
  const now = (await a.store.loadProfile(cur.id)).profile;
  return now.trainerName === 'ELSEWHERE' && now.box.length === 0 && (await a.store.getAutoBackup(cur.id)) === undefined ? true : 'a refused import left a backup / changed data';
});
add('store/delete/removes-the-profile-its-history-and-its-keys-only', async (c) => {
  const { store } = await openMem(c, 'del');
  let a = await store.createProfile({ trainerName: 'AAA' });
  const b = await store.createProfile({ trainerName: 'BBB' });
  a.trainerName = 'A2'; a = await store.saveProfile(a);
  for (const slot of [a.id + ':k1', a.id + ':k2', b.id + ':k1']) await store.keys.put(slot, { privateKey: null, publicKeyJwk: null, createdAt: 1 });
  await store.setActiveId(a.id);
  const existed = await store.deleteProfile(a.id);
  const again = await store.deleteProfile(a.id);
  const ok = existed === true && again === false && (await store.loadProfile(a.id)).code === 'store.not-found' && (await store.listHistory(a.id)).length === 0
    && (await store.keys.get(a.id + ':k1')) === undefined && (await store.keys.get(a.id + ':k2')) === undefined && (await store.keys.get(b.id + ':k1')) !== undefined
    && (await store.getActiveId()) === null && (await store.loadProfile(b.id)).ok;
  return ok ? true : 'delete left or removed the wrong things';
});
add('store/keys/interface', async (c) => {
  const { store } = await openMem(c, 'keys');
  if (store.keys.persistent !== true) return 'persistent flag';
  await store.keys.put('p1:k1', { privateKey: null, publicKeyJwk: { a: 1 }, createdAt: 1 });
  const got = await store.keys.get('p1:k1');
  await store.keys.put('p1:k1', { privateKey: null, publicKeyJwk: { a: 3 }, createdAt: 3 });
  const got2 = await store.keys.get('p1:k1');
  await store.keys.delete('p1:k1');
  const s2 = await c.S.openStore({ adapter: c.S.createMemoryAdapter({ name: uniqueName('kn') }), channel: false });
  return got.publicKeyJwk.a === 1 && got.id === 'p1:k1' && got2.publicKeyJwk.a === 3 && (await store.keys.get('p1:k1')) === undefined && s2.keys.persistent === false && !('putIfAbsent' in store.keys) ? true : 'keys semantics';
});
add('store/readonly-database/is-reported-and-refuses-writes', async (c) => {
  const name = uniqueName('rodb');
  const w = c.S.createMemoryAdapter({ name, durable: true });
  const s0 = await c.S.openStore({ adapter: w, channel: false, deps: detDeps(1) });
  const p = await s0.createProfile({ trainerName: 'RO' });
  const ro = c.S.createMemoryAdapter({ name, durable: true, readOnly: true });
  const s = await c.S.openStore({ adapter: ro, channel: false, deps: detDeps(2) });
  const st = s.status;
  if (!st.readOnly || !st.notSaved || !/newer-than-app/.test(st.reason)) return 'status ' + J(st);
  if (st.fellBack) return 'a read-only database must be read, not replaced by memory';
  const loaded = await s.loadProfile(p.id);
  const e = await throwsKind(() => s.saveProfile({ ...loaded.profile }), 'store.read-only');
  return loaded.ok && e === true ? true : 'read / refuse: ' + e;
});

// ---- the adapter contract must be able to fail: three broken adapters -----------------------------
function brokenAdapter(kind, name) {
  const stores = new Map(Object.keys(STATS_STORES).map((s) => [s, new Map()]));
  const a = {
    kind: 'memory', durable: true, readOnly: false, async open() {}, async close() { a.closed = true; },
    transact(names, mode, fn) {
      if (a.closed) return Promise.reject(new Error('closed'));
      const run = async () => {
        const snapshot = new Map();
        for (const n of names) { if (!stores.has(n)) throw new Error('NotFoundError ' + n); snapshot.set(n, new Map(stores.get(n))); }
        const tx = {
          async get(s, k) { const v = stores.get(s).get(k); return kind === 'noclone' ? v : (v === undefined ? undefined : structuredClone(v)); },
          async put(s, v) { if (mode !== 'readwrite' && kind !== 'readonly-writes') throw new Error('ReadOnly'); stores.get(s).set(v[STATS_STORES[s]], kind === 'noclone' ? v : structuredClone(v)); },
          async delete(s, k) { if (mode !== 'readwrite') throw new Error('ReadOnly'); stores.get(s).delete(k); },
          async list(s, { gte, lt, limit } = {}) { const out = [...stores.get(s).entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1)).filter(([k]) => (gte === undefined || k >= gte) && (lt === undefined || k < lt)).map(([, v]) => structuredClone(v)); return limit ? out.slice(0, limit) : out; },
        };
        try { return await fn(tx); } catch (e) { if (kind !== 'norollback') for (const [n, m] of snapshot) stores.set(n, m); throw e; }
      };
      if (kind === 'noserial') return run(); // concurrent read-modify-write interleaves: lost updates
      a.q = (a.q || Promise.resolve()).then(run, run);
      return a.q;
    },
  };
  return a;
}
const STATS_STORES = { profiles: 'id', profileHistory: 'hkey', meta: 'key', quarantine: 'qid', keys: 'id' };
add('store/contract/broken-adapters-are-caught-by-named-cases', async (c) => {
  const expect = { norollback: 'contract/error-rolls-back-every-write-and-propagates', noclone: 'contract/put-get-roundtrip-and-copy-semantics', noserial: 'contract/read-modify-write-is-serialised-no-lost-update' };
  const mkCtx = (kind) => { const dbs = new Map(); return { make: async (name) => { if (!dbs.has(name)) dbs.set(name, brokenAdapter(kind, name)); const a = dbs.get(name); a.closed = false; return a; }, destroy: async (name) => dbs.delete(name) }; };
  const control = await c.S.runAdapterContract(mkCtx('none'));
  const cb = control.filter((r) => !r.ok);
  if (cb.length) return 'the correct control adapter fails: ' + cb.map((r) => r.name + ': ' + r.detail).join(' | ');
  for (const [kind, name] of Object.entries(expect)) {
    const res = await c.S.runAdapterContract(mkCtx(kind));
    const f = res.filter((r) => !r.ok).map((r) => r.name);
    if (!f.includes(name)) return `${kind}: ${name} did not fail (failed: ${f.join(', ') || 'nothing'})`;
  }
  return true;
});

// =============================================================================================
// F. STATIC / PURITY
// =============================================================================================
add('purity/no-ambient-clock-or-randomness-outside-defaultDeps', (c) => {
  const S = c.sources;
  const count = (src, re) => (src.match(re) || []).length;
  const problems = [];
  if (count(S.profile, /Date\.now\(/g) !== 1) problems.push('profile.js must call Date.now exactly once (inside defaultDeps)');
  for (const f of ['profile', 'teamcode', 'identity', 'store']) {
    if (count(S[f], /Math\.random/g)) problems.push(f + '.js uses Math.random');
    if (f !== 'profile' && count(S[f], /Date\.now|new Date\(/g)) problems.push(f + '.js reads the clock directly');
    const code = S[f].split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    if (/\b(document\.(getElementById|querySelector|createElement|body|cookie)|window\.|localStorage|sessionStorage|XMLHttpRequest|fetch\()/.test(code)) problems.push(f + '.js touches a browser global that is not its business');
  }
  return problems.length ? problems.join('; ') : true;
});
add('purity/ascii-only', (c) => all(Object.entries(c.sources), ([name, src]) => { const i = [...src].findIndex((ch) => ch.charCodeAt(0) > 126 || (ch.charCodeAt(0) < 32 && ch !== '\n' && ch !== '\r' && ch !== '\t')); return i < 0 ? true : `${name}.js has a non-ASCII character at ${i}`; }));
add('purity/public-api-present', (c) => {
  const need = {
    P: ['APP_ID', 'SCHEMA_VERSION', 'PROFILE_CODES', 'IMPORT_CODES', 'MIGRATIONS', 'createProfile', 'createMon', 'createTeam', 'checkProfile', 'checkMon', 'checkTeam', 'migrateProfile', 'normalizeProfile', 'openProfileDocument', 'toRulesRec', 'validateStoredMon',
      'validateMonList', 'validateProfileAgainstPack', 'buildExport', 'serializeExport', 'exportBytes', 'parseExport', 'planImport', 'recordMatch', 'resetRecord', 'exportableProfile', 'containsPrivateJwk', 'isPublicJwk', 'textIssue', 'newId', 'b64urlEncode', 'b64urlDecode'],
    T: ['TEAMCODE_PREFIX', 'TEAMCODE_ERRORS', 'LAYER_BITS', 'BASE_IDS', 'MON_BYTES', 'MAX_BINARY_BYTES', 'crc16', 'encodeTeamBinary', 'decodeTeamBinary', 'encodeTeamCode', 'decodeTeamCode', 'cardHash', 'battleView', 'teamFromProfile', 'validateDecodedTeam', 'monsFromDecoded', 'rulesetToBytes', 'rulesetFromBytes'],
    I: ['IDENTITY_NOTICE', 'IDENTITY_STATES', 'RECEIPT_DOMAIN', 'generateIdentity', 'keyIdOf', 'identityStatus', 'ensureIdentity', 'rotateIdentity', 'signReceipt', 'verifyReceipt', 'makeReceiptDoc', 'receiptBytes', 'receiptDigest', 'normalizePublicJwk'],
    S: ['STORES', 'HISTORY_KEEP', 'createMemoryAdapter', 'createIdbAdapter', 'openStore', 'ArenaStore', 'probeAdapter', 'ADAPTER_CONTRACT', 'runAdapterContract', 'ConflictError', 'ReadOnlyError', 'ValidationError', 'historyKey', 'dropMemoryDb'],
  };
  const miss = [];
  for (const [k, list] of Object.entries(need)) for (const n of list) if (!(n in c[k])) miss.push(k + '.' + n);
  return miss.length === 0 ? true : 'missing exports: ' + miss.join(', ');
});

// ---------------------------------------------------------------------------------------------
// loading module variants from source text (data: URLs, nothing written to disk)
// ---------------------------------------------------------------------------------------------
const SRC = {};
for (const n of ['profile', 'teamcode', 'identity', 'store']) SRC[n] = fs.readFileSync(path.join(JS, n + '.js'), 'utf8');
const fileUrl = (n) => pathToFileURL(path.join(JS, n)).href;
const FIXED = { './stats.js': fileUrl('stats.js'), './rules.js': fileUrl('rules.js'), './charset.js': fileUrl('charset.js'), './rom.js': fileUrl('rom.js'), './career_stats.js': fileUrl('career_stats.js') };
const dataUrl = (src) => 'data:text/javascript;base64,' + Buffer.from(src, 'utf8').toString('base64');
function rewrite(code, map, who) {
  return code.replace(/from '(\.\/[a-z_]+\.js)'/g, (m, spec) => { if (!map[spec]) throw new Error(`${who}: no mapping for import ${spec}`); return `from '${map[spec]}'`; });
}
async function loadVariant(src) {
  const profileUrl = dataUrl(rewrite(src.profile, FIXED, 'profile'));
  const withP = { ...FIXED, './profile.js': profileUrl };
  const [T, I, S] = await Promise.all([import(dataUrl(rewrite(src.teamcode, withP, 'teamcode'))), import(dataUrl(rewrite(src.identity, withP, 'identity'))), import(dataUrl(rewrite(src.store, withP, 'store')))]);
  return { P: await import(profileUrl), T, I, S, sources: src, pack, rom, FIX };
}
async function runSuite(suiteList, ctxBase, only) {
  const results = [];
  for (const c of suiteList) {
    if (only && !only.has(c.id)) continue;
    let r;
    const t0 = process.hrtime.bigint();
    try { r = await c.fn(ctxBase); } catch (e) { r = `threw ${e && e.name}: ${e && e.message}`; }
    results.push({ id: c.id, ok: r === true, detail: r === true ? '' : String(r), ms: Number(process.hrtime.bigint() - t0) / 1e6 });
  }
  return results;
}

// ---------------------------------------------------------------------------------------------
// the mutants: { id, file, from, to, count, expect: [check ids that MUST fail] }
// ---------------------------------------------------------------------------------------------
const MUTANTS = [];
const mut = (id, file, from, to, expect, count = 1) => MUTANTS.push({ id, file, from, to, expect, count });
const GOLD1 = 'profile/migrate/v1-full-golden';
const BAGS = 'profile/migrate/unknown-fields-carried-to-the-same-level';
const MATRIX = 'profile/shape/matrix-every-code-has-a-firing-case';
const IMPORTS = 'profile/import/refusals-matrix-every-code-has-a-firing-case';
const MERGE = 'profile/import/plan-merge-dedupes-and-remaps';
// ---- profile.js
mut('P01 migration drops the v1 history list instead of bagging it', 'profile', "if (hasOwn.call(o, 'history')) { bagSet(o, 'history', o.history); delete o.history; }", "if (hasOwn.call(o, 'history')) { delete o.history; }", [GOLD1, BAGS]);
mut('P02 migration loses the romHash -> romSha256 rename', 'profile', "if (hasOwn.call(o, 'romHash')) { o.romSha256 = o.romHash; delete o.romHash; }", "if (hasOwn.call(o, 'romHash')) { delete o.romHash; }", [GOLD1]);
mut('P03 migration maps every ability slot to 0', 'profile', "if (isObj(a) && hasOwn.call(a, 'slot')) m.abilitySlot = a.slot;", "if (isObj(a) && hasOwn.call(a, 'slot')) m.abilitySlot = 0;", [GOLD1]);
mut('P04 migration forgets to rename provenance.saveSha', 'profile', "m.provenance.saveSha256 = m.provenance.saveSha; delete m.provenance.saveSha;", "delete m.provenance.saveSha;", [GOLD1]);
mut('P05 an unmapped v1 format silently becomes the default ruleset', 'profile', "return typeof f === 'string' && hasOwn.call(V1_FORMATS, f) ? V1_FORMATS[f] : null; }", "return typeof f === 'string' && hasOwn.call(V1_FORMATS, f) ? V1_FORMATS[f] : DEFAULT_RULESET_ID; }", [GOLD1, 'profile/migrate/v1-bad-golden']);
mut('P06 migration drops training instead of bagging it', 'profile', "if (hasOwn.call(m, 'training')) { bagSet(m, 'training', m.training); delete m.training; }", "if (hasOwn.call(m, 'training')) { delete m.training; }", [GOLD1, BAGS]);
mut('P07 a NEWER document is treated as writable', 'profile', 'to: from, steps: 0, changed: false, readOnly: true }', 'to: from, steps: 0, changed: false, readOnly: false }', ['profile/migrate/newer-document-is-read-only-and-untouched']);
mut('P08 the migration loop runs one step too far', 'profile', 'while (v < current) {', 'while (v <= current) {', ['profile/migrate/current-is-a-fixed-point', 'profile/migrate/idempotent']);
mut('P09 containsPrivateJwk no longer looks for d', 'profile', "const PRIVATE_JWK_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'k', 'oth'];", "const PRIVATE_JWK_MEMBERS = ['p', 'q', 'dp', 'dq', 'qi', 'k', 'oth'];", ['profile/export/never-writes-private-key-material', MATRIX, IMPORTS]);
mut('P10 containsPrivateJwk does not descend', 'profile', 'for (const k of Object.keys(v)) stack.push(v[k]);', '{}', ['profile/export/never-writes-private-key-material']);
mut('P11 text rule accepts alias spellings (U+2019)', 'profile', "if (defaultCodec.decode(bytes) !== s) return 'charset';", '', ['profile/text/rule-pins']);
mut('P12 text rule accepts charset token braces', 'profile', "if (/[{}]/.test(s) || CONTROL_RE.test(s)) return 'chars';", "if (CONTROL_RE.test(s)) return 'chars';", ['profile/text/rule-pins']);
mut('P13 level upper bound off by one', 'profile', 'if (!isInt(m.level, LIMITS.levelMin, LIMITS.levelMax))', 'if (!isInt(m.level, LIMITS.levelMin, LIMITS.levelMax + 1))', [MATRIX]);
mut('P14 EV upper bound off by one', 'profile', "checkStatBlock(m.ev, `${path}.ev`, LIMITS.evMax, 'mon.ev', add);", "checkStatBlock(m.ev, `${path}.ev`, LIMITS.evMax + 1, 'mon.ev', add);", [MATRIX]);
mut('P15 IV upper bound off by one', 'profile', "checkStatBlock(m.iv, `${path}.iv`, LIMITS.ivMax, 'mon.iv', add);", "checkStatBlock(m.iv, `${path}.iv`, LIMITS.ivMax + 1, 'mon.iv', add);", [MATRIX]);
mut('P16 genderless is no longer a gender', 'profile', "export const GENDERS = Object.freeze(['M', 'F', '-']);", "export const GENDERS = Object.freeze(['M', 'F']);", ['profile/migrate/v1-bad-golden']);
mut('P17 nature upper bound off by one', 'profile', 'if (!isInt(m.nature, 0, 24))', 'if (!isInt(m.nature, 0, 25))', [MATRIX]);
mut('P18 ability slot 3 allowed', 'profile', 'if (!isInt(m.abilitySlot, 0, 2))', 'if (!isInt(m.abilitySlot, 0, 3))', [MATRIX]);
mut('P19 an empty moveset allowed', 'profile', 'm.moves.length < 1 ||', 'm.moves.length < 0 ||', [MATRIX]);
mut('P20 duplicate mon ids not reported by the strict check', 'profile', "if (isObj(m) && isId(m.id)) { if (ids.has(m.id)) add(", "if (isObj(m) && isId(m.id)) { if (false) add(", [MATRIX]);
mut('P21 normalisation keeps a duplicate-id record', 'profile', 'if (seen.has(r.mon.id)) {', 'if (false) {', ['profile/migrate/v1-bad-golden']);
mut('P22 normalisation keeps team members that are not in the box', 'profile', 'if (!boxIds.has(id)) { P(', 'if (false) { P(', ['profile/migrate/v1-bad-golden']);
mut('P23 a mon unknown-field bag is dropped', 'profile', 'bag = mergeBag(bag, unknownOf(raw, MON_KEYS));', 'bag = mergeBag(bag, null);', [GOLD1, BAGS]);
mut('P24 hostile keys are assigned through __proto__', 'profile', 'Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });', 'o[k] = v;', ['profile/migrate/no-prototype-pollution-from-hostile-keys']);
mut('P25 the export checksum does not cover the profile', 'profile', "const checksum = 'sha256:' + sha256Hex(enc(canonicalJSON(p)));", "const checksum = 'sha256:' + sha256Hex(enc(canonicalJSON({})));", ['profile/export/checksum-covers-the-profile']);
mut('P26 a checksum mismatch is ignored', 'profile', 'if (env.checksum !== want) {', 'if (false) {', ['profile/import/checksum-override-is-explicit', IMPORTS]);
mut('P27 the file size cap is gone', 'profile', "if (bytes.length > maxBytes) return fail('too-large'", "if (false) return fail('too-large'", ['profile/import/oversize-and-decompression-bomb-are-capped', IMPORTS]);
mut('P28 gzip output is uncapped', 'profile', "bytes = await decompressBytes(bytes, 'gzip', maxBytes); gz = true;", "bytes = await decompressBytes(bytes, 'gzip', undefined); gz = true;", ['profile/import/oversize-and-decompression-bomb-are-capped']);
mut('P29 a cut-off file is never reported as likely truncated', 'profile', 'likelyTruncated: !/[}\\]]\\s*$/.test(text)', 'likelyTruncated: false', ['profile/import/truncation-is-reported-as-likely-truncated']);
mut('P30 merge does not dedupe by pid + otId', 'profile', 'if (k && byKey.has(k)) {', 'if (false) {', [MERGE]);
mut('P31 merge reuses an id that clashes with different content', 'profile', "fresh.id = newId('m', d);", 'fresh.id = m.id;', [MERGE]);
mut('P32 replace always adopts the incoming identity', 'profile', 'if (existing.identity.publicKeyJwk) { p.identity = clone(existing.identity);', 'if (false) { p.identity = clone(existing.identity);', ['profile/import/plan-replace-keeps-id-rev-created-and-local-identity']);
mut('P33 merge ignores a ROM mismatch', 'profile', "if (existing.romSha256 !== incoming.romSha256) return { ok: false, code: 'plan.rom-mismatch'", "if (false) return { ok: false, code: 'plan.rom-mismatch'", ['profile/import/plan-refuses-mismatches-and-overflow']);
mut('P34 the gender check is gone', 'profile', "const bad = want ? mon.gender !== want : mon.gender === '-';", 'const bad = false;', ['profile/rules/gender-is-checked-against-the-species-ratio']);
mut('P35 the held item is not passed to rules.js', 'profile', 'item: mon.heldItem,', 'item: 0,', ['profile/rules/bridge-maps-fields-exactly']);
mut('P36 points are derived from the wrong block', 'profile', 'rec.points = evsToPoints(rec.evs, rec.ivs);', 'rec.points = evsToPoints(rec.ivs, rec.ivs);', ['profile/rules/bridge-maps-fields-exactly']);
mut('P37 rev leaks into the export', 'profile', '  delete p.rev;\n  return p;', '  return p;', ['profile/export/envelope-and-file-name']);
mut('P38 export no longer refuses private key material', 'profile', "if (containsPrivateJwk(profile)) throw new ProfileError('profile.private-key', 'refusing to export a profile that contains private key material');", '', ['profile/export/never-writes-private-key-material']);
mut('P39 import accepts private key material in a file', 'profile', "if (containsPrivateJwk(env)) return fail('private-key'", "if (false) return fail('private-key'", [IMPORTS]);
mut('P40 a profile for another ROM is accepted', 'profile', 'if (expectRom && opened.profile.romSha256 !== expectRom && !opts.allowRomMismatch)', 'if (false)', ['profile/import/rom-mismatch-is-refused-unless-allowed', IMPORTS]);
mut('P41 a newer-schema file is not refused', 'profile', 'if (Number.isInteger(sv) && sv > SCHEMA_VERSION) return fail(', 'if (false) return fail(', [IMPORTS]);
mut('P42 isPublicJwk tolerates extra members', 'profile', "if (keys.length !== 4 || !['kty', 'crv', 'x', 'y'].every((k) => keys.includes(k))) return false;", "if (!['kty', 'crv', 'x', 'y'].every((k) => keys.includes(k))) return false;", [MATRIX, 'identity/jwk/strictness']);
mut('P43 merged teams keep the incoming mon ids', 'profile', 'nt.monIds = [...new Set(t.monIds.map((id) => idMap.get(id)).filter(Boolean))];', 'nt.monIds = t.monIds.slice();', [MERGE]);
mut('P44 base64url decode accepts stray bits', 'profile', 'if (n % 4 === 3 && (vals[n - 1] & 0x03) !== 0) return null;', '', ['team/base64url/round-trip-and-strictness']);
mut('P45 base64url encode uses the standard alphabet', 'profile', "const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';", "const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';", ['team/base64url/round-trip-and-strictness']);
mut('P46 the team ruleset id is not checked', 'profile', "if (!rulesetOk(t.ruleset)) add('team.ruleset'", "if (false) add('team.ruleset'", [MATRIX]);
mut('P59 a derived stat name becomes a schema field', 'profile', "const MON_KEYS = ['id', 'species',", "const MON_KEYS = ['maxHp', 'id', 'species',", ['profile/schema/no-derived-stat-fields-are-modelled']);
mut('P61 the depth limit is a thousand times too lax', 'profile', 'if (d >= limit) return true;', 'if (d >= limit * 1000) return true;', ['profile/depth/the-profile-door-refuses-a-chain-one-past-the-limit-and-accepts-the-limit', 'profile/depth/the-envelope-door-is-a-separate-guard']);
mut('P62 the depth limit is off by one (too strict)', 'profile', 'if (d >= limit) return true;', 'if (d >= limit - 1) return true;', ['profile/depth/the-profile-door-refuses-a-chain-one-past-the-limit-and-accepts-the-limit']);
mut('P63 the depth limit is off by one (too lax)', 'profile', 'if (d >= limit) return true;', 'if (d > limit) return true;', ['profile/depth/the-profile-door-refuses-a-chain-one-past-the-limit-and-accepts-the-limit']);
mut('P64 normalisation does not check the depth', 'profile', 'if (tooDeep(input)) return fatal(', 'if (false) return fatal(', ['profile/depth/the-profile-door-refuses-a-chain-one-past-the-limit-and-accepts-the-limit']);
mut('P66 the depth walk becomes recursive and only checks the limit on the way back up (a hostile chain overflows the stack)', 'profile', 'export function tooDeep(value, limit = PROFILE_LIMITS.depthMax) {', "export function tooDeep(value, limit = PROFILE_LIMITS.depthMax) {\n  const rec = (v, d) => { if (v === null || typeof v !== 'object') return false; for (const k of Object.keys(v)) if (rec(v[k], d + 1)) return true; return d >= limit; };\n  return rec(value, 0);\n}\nexport function tooDeepWalk(value, limit = PROFILE_LIMITS.depthMax) {", ['profile/depth/a-hostile-chain-of-100000-levels-is-refused-without-recursion']);
mut('P65 the export envelope does not check the depth', 'profile', "if (tooDeep(env)) return fail('corrupt', 'the file is nested too deeply');", '', ['profile/depth/the-envelope-door-is-a-separate-guard']);
mut('SX1 the IndexedDB factory is read when the adapter is made, outside open()', 'store', "  let db = null;\n  let closed = true;\n  let closeRequested = false;\n  const a = {\n    kind: 'indexeddb'", "  const factoryEager = idbFactory || globalThis.indexedDB;\n  let db = null;\n  let closed = true;\n  let closeRequested = false;\n  const a = {\n    kind: 'indexeddb'", ['store/probe/a-browser-that-throws-when-indexedDB-is-read-falls-back-to-memory']);
mut('SX2 delete-everything skips the identity keys', 'store', "      for (const [s, kp] of Object.entries(STORES)) {\n        const rows = await tx.list(s);\n        if (s === 'profiles') profiles = rows.length;", "      for (const [s, kp] of Object.entries(STORES).filter(([n]) => n !== 'keys')) {\n        const rows = await tx.list(s);\n        if (s === 'profiles') profiles = rows.length;", ['store/delete/delete-everything-empties-every-store-in-one-transaction']);
mut('SX3 delete-everything leaves the quarantine', 'store', "      for (const [s, kp] of Object.entries(STORES)) {\n        const rows = await tx.list(s);\n        if (s === 'profiles') profiles = rows.length;", "      for (const [s, kp] of Object.entries(STORES).filter(([n]) => n !== 'quarantine')) {\n        const rows = await tx.list(s);\n        if (s === 'profiles') profiles = rows.length;", ['store/delete/delete-everything-empties-every-store-in-one-transaction']);
mut('SX4 delete-everything forgets to count what it removed', 'store', "if (s === 'profiles') profiles = rows.length;", '', ['store/delete/delete-everything-empties-every-store-in-one-transaction']);
mut('P60 a gzip request without CompressionStream throws instead of falling back', 'profile', "if (opts.gzip && compressionAvailable('gzip')) {", 'if (opts.gzip) {', ['profile/export/gzip-request-falls-back-to-plain-json-without-CompressionStream']);
// ---- teamcode.js
mut('T01 encode writes EVs in UI order', 'teamcode', 'ROM_STAT_ORDER.forEach((k, n) => { out[o + 8 + n] = m.ev[k]; });', "ROM_STAT_ORDER.forEach((k, n) => { out[o + 8 + n] = m.ev[['hp', 'atk', 'def', 'spa', 'spd', 'spe'][n]]; });", ['team/binary/golden-layout-pins-rom-order-and-bit-positions', 'team/binary/round-trip-fuzz-and-decode-is-canonical']);
mut('T02 decode reads EVs in UI order', 'teamcode', 'ROM_STAT_ORDER.forEach((k, n) => { ev[k] = b[o + 8 + n]; });', "['hp', 'atk', 'def', 'spa', 'spd', 'spe'].forEach((k, n) => { ev[k] = b[o + 8 + n]; });", ['team/binary/golden-layout-pins-rom-order-and-bit-positions', 'team/binary/round-trip-fuzz-and-decode-is-canonical']);
mut('T03 IV fields are 4 bits apart instead of 5', 'teamcode', 'iv |= m.iv[k] << (5 * n);', 'iv |= m.iv[k] << (4 * n);', ['team/binary/golden-layout-pins-rom-order-and-bit-positions']);
mut('T04 IV reserved bits are not checked', 'teamcode', "if (ivw >>> 30) return bad('iv', 'has reserved bits set');", '', ['team/binary/refusal-matrix-names-the-field', 'team/binary/every-single-byte-corruption-is-rejected-or-canonical']);
mut('T05 reserved flag bits are not checked', 'teamcode', "if (flags & 0xe0) return bad('flags', 'has reserved bits set');", '', ['team/binary/refusal-matrix-names-the-field', 'team/binary/every-single-byte-corruption-is-rejected-or-canonical']);
mut('T06 gender code 3 is accepted', 'teamcode', "if (g === 3) return bad('gender', 'is 3');", '', ['team/binary/refusal-matrix-names-the-field']);
mut('T07 ability slot 3 is accepted', 'teamcode', "if (abilitySlot === 3) return bad('abilitySlot', 'is 3');", '', ['team/binary/refusal-matrix-names-the-field']);
mut('T08 non-contiguous moves are accepted', 'teamcode', "if (ids[n] !== 0) return bad('moves', 'is not contiguous');", '', ['team/binary/refusal-matrix-names-the-field', 'team/binary/every-single-byte-corruption-is-rejected-or-canonical']);
mut('T09 PP-ups on an empty move slot are accepted', 'teamcode', "if (((pp >> (2 * n)) & 3) !== 0) return bad('ppUps', 'is set for an empty move slot');", '', ['team/binary/refusal-matrix-names-the-field', 'team/binary/every-single-byte-corruption-is-rejected-or-canonical']);
mut('T10 junk after a nickname terminator is accepted', 'teamcode', "if (b[o + 27 + n] !== 0xff) return bad('nickname', 'has non-padding bytes after its terminator');", 'if (false) return bad();', ['team/binary/refusal-matrix-names-the-field', 'team/binary/every-single-byte-corruption-is-rejected-or-canonical']);
mut('T11 trailing bytes after the last mon are accepted', 'teamcode', "if (bytes.length !== 9 + n + count * MON_BYTES) return derr('binary.length'", "if (bytes.length < 9 + n + count * MON_BYTES) return derr('binary.length'", ['team/binary/refusal-matrix-names-the-field', 'team/binary/every-single-byte-corruption-is-rejected-or-canonical']);
mut('T12 the check value is never compared', 'teamcode', "if (crcHex(enc(parts[0] + '.' + parts[1])) !== parts[2].toLowerCase()) return derr('code.crc'", "if (false) return derr('code.crc'", ['team/code/every-single-character-error-is-caught', 'team/code/error-matrix-every-code-has-a-firing-case']);
mut('T13 the check value excludes the prefix (decode side only)', 'teamcode', "crcHex(enc(parts[0] + '.' + parts[1]))", 'crcHex(enc(parts[1]))', ['team/code/round-trip-and-size']);
mut('P47 base64url decode accepts stray bits (2-char tail)', 'profile', 'if (n % 4 === 2 && (vals[n - 1] & 0x0f) !== 0) return null;', '', ['team/base64url/round-trip-and-strictness', 'team/code/error-matrix-every-code-has-a-firing-case']);
mut('T15 inflate is not capped', 'teamcode', "bin = await decompressBytes(deflated, 'deflate-raw', MAX_BINARY_BYTES);", "bin = await decompressBytes(deflated, 'deflate-raw');", ['team/code/decompression-is-capped-before-memory-grows', 'team/code/error-matrix-every-code-has-a-firing-case']);
mut('T16 CRC polynomial 0x1021 -> 0x1020', 'teamcode', '((c << 1) ^ 0x1021) & 0xffff', '((c << 1) ^ 0x1020) & 0xffff', ['team/crc16/known-vector-and-sensitivity']);
mut('T17 pasted whitespace is no longer ignored', 'teamcode', "const t = text.replace(/\\s+/g, '');", 'const t = text.trim();', ['team/code/pasted-forms-are-tolerated']);
mut('T18 a different-version code is reported as a bad prefix', 'teamcode', "derr('code.version',", "derr('code.prefix',", ['team/code/error-matrix-every-code-has-a-firing-case']);
mut('T19 unused ruleset layer bits are ignored', 'teamcode', 'if (bits >> LAYER_BITS.length) return null;', '', ['team/ruleset-bits/every-layer-has-a-bit-and-all-combinations-round-trip', 'team/binary/refusal-matrix-names-the-field']);
mut('T20 the ROM id is never compared', 'teamcode', 'if (expectRom !== null && !opts.allowRomMismatch && r.team.romId !== String(expectRom).slice(0, 8))', 'if (false)', ['team/code/rom-id-is-checked-when-asked', 'team/code/the-default-is-the-pinned-rom']);
mut('T38 decodeTeamCode no longer defaults to the pinned ROM (the verifier-found footgun)', 'teamcode', 'const expectRom = opts.expectRomSha256 === undefined ? PINNED.sha256 : opts.expectRomSha256;', 'const expectRom = opts.expectRomSha256 === undefined ? null : opts.expectRomSha256;', ['team/code/the-default-is-the-pinned-rom']);
mut('T39 allowRomMismatch is ignored', 'teamcode', 'if (expectRom !== null && !opts.allowRomMismatch && r.team.romId', 'if (expectRom !== null && r.team.romId', ['team/code/the-default-is-the-pinned-rom']);
mut('T40 an explicit expectRomSha256: null is treated as the pin', 'teamcode', 'const expectRom = opts.expectRomSha256 === undefined ? PINNED.sha256 : opts.expectRomSha256;', 'const expectRom = opts.expectRomSha256 == null ? PINNED.sha256 : opts.expectRomSha256;', ['team/code/the-default-is-the-pinned-rom']);
mut('T37 the stream check only looks for the constructor, not the format', 'teamcode', "if (!streamSupported('Compression', 'deflate-raw')) fail('code.unsupported', 'this browser cannot compress team codes');", "if (typeof CompressionStream !== 'function') fail('code.unsupported', 'this browser cannot compress team codes');", ['team/code/a-browser-with-gzip-but-no-deflate-raw-is-reported-as-unsupported']);
mut('T36 encode does not notice a browser without CompressionStream', 'teamcode', "if (!streamSupported('Compression', 'deflate-raw')) fail('code.unsupported', 'this browser cannot compress team codes');", '', ['team/code/encode-says-so-when-the-browser-cannot-compress']);
mut('T21 unencodable text is encoded anyway', 'teamcode', 'if (why) fail(code, `${what}: ${why}`);', 'if (false) fail(code, `${what}: ${why}`);', ['team/binary/encode-refusals']);
mut('T22 seven Pokemon fit in a card', 'teamcode', 'team.mons.length > TEAM_MAX_MONS) fail(', 'team.mons.length > TEAM_MAX_MONS + 1) fail(', ['team/binary/encode-refusals']);
mut('T24 the card hash skips the first byte', 'teamcode', 'export function cardHash(bytes) { return sha256Hex(bytes); }', 'export function cardHash(bytes) { return sha256Hex(bytes.subarray(1)); }', ['team/code/card-hash-is-the-sha256-of-the-card-bytes']);
mut('T25 species 0 is accepted', 'teamcode', "if (species < 1) return bad('species', 'is 0');", '', ['team/binary/refusal-matrix-names-the-field']);
mut('T26 level 101 is accepted', 'teamcode', 'if (level < 1 || level > 100) return bad(', 'if (level < 1 || level > 101) return bad(', ['team/binary/refusal-matrix-names-the-field']);
mut('T27 PP-ups are packed one bit apart', 'teamcode', 'pp |= mv.ppUps << (2 * n);', 'pp |= mv.ppUps << n;', ['team/binary/golden-layout-pins-rom-order-and-bit-positions']);
mut('T28 genders M and F swap codes', 'teamcode', "export const GENDER_CODE = Object.freeze({ M: 0, F: 1, '-': 2 });", "export const GENDER_CODE = Object.freeze({ M: 1, F: 0, '-': 2 });", ['team/binary/golden-layout-pins-rom-order-and-bit-positions']);
mut('T29 the nickname terminator is 0x00', 'teamcode', 'out[o + 27 + n] = n < nick.length ? nick[n] : 0xff;', 'out[o + 27 + n] = n < nick.length ? nick[n] : 0x00;', ['team/binary/golden-layout-pins-rom-order-and-bit-positions']);
mut('T30 romId bytes are written in reverse', 'teamcode', 'for (let i = 0; i < 4; i++) out[3 + i] = parseInt(rom.slice(2 * i, 2 * i + 2), 16);', 'for (let i = 0; i < 4; i++) out[6 - i] = parseInt(rom.slice(2 * i, 2 * i + 2), 16);', ['team/binary/golden-layout-pins-rom-order-and-bit-positions']);
// (T23, 'a 17-byte team name length is accepted', was tried and is EQUIVALENT: decodeTeamBinary's textIssue() rejects a 17-character name
//  with the same binary.name code, so the length guard is defence in depth. Treat any later change to either guard as unguarded.)
// ---- identity.js
mut('I01 the receipt domain tag is dropped from the signed bytes', 'identity', 'return enc(RECEIPT_DOMAIN + canonicalJSON(receipt));', 'return enc(canonicalJSON(receipt));', ['identity/receipt/tamper-matrix']);
mut('I02 the keyId is not checked against the key', 'identity', "if ((await keyIdOf(jwk)) !== s.keyId) throw new Error('keyId does not match the public key');", '', ['identity/receipt/tamper-matrix']);
mut('I03 one key may sign twice', 'identity', "if (seen.has(s.keyId)) throw new Error('this key signed twice');", '', ['identity/receipt/two-party-receipt-and-required-signers']);
mut('I04 required signers are ignored', 'identity', 'for (const id of opts.requireKeyIds || []) if', 'for (const id of []) if', ['identity/receipt/two-party-receipt-and-required-signers']);
mut('I05 minSignatures is ignored', 'identity', 'if (valid.length < min) reasons.push(', 'if (false) reasons.push(', ['identity/receipt/two-party-receipt-and-required-signers']);
mut('I06 a forged extra signature does not sink the document', 'identity', 'for (const r of results) if (!r.ok) reasons.push(', 'for (const r of []) if (!r.ok) reasons.push(', ['identity/receipt/two-party-receipt-and-required-signers']);
mut('I07 the private key is generated extractable', 'identity', "const kp = await subtle().generateKey(ALGORITHM, false, ['sign', 'verify']);", "const kp = await subtle().generateKey(ALGORITHM, true, ['sign', 'verify']);", ['identity/generate/private-key-is-not-extractable']);
mut('I08 identityStatus reports ok without measuring', 'identity', 'let state = await roundTrip(rec.privateKey, jwk);', "let state = 'ok';", ['identity/status/states-are-measured-by-doing']);
mut('I09 ensureIdentity replaces any identity that is not ok', 'identity', "if (status.state !== 'none') return { profile, created: false, status };", "if (status.state === 'ok') return { profile, created: false, status };", ['identity/ensure/only-creates-from-none-never-replaces']);
mut('I10 rotation does not need an acknowledgement', 'identity', 'if (acknowledgeLoss !== true) throw', 'if (acknowledgeLoss === undefined) throw', ['identity/rotate/needs-an-explicit-acknowledgement-and-keeps-the-old-key']);
mut('I11 rotation forgets the retired key', 'identity', 'if (old) {', 'if (false) {', ['identity/rotate/needs-an-explicit-acknowledgement-and-keeps-the-old-key']);
mut('I12 a private-member JWK is no longer called out', 'identity', "throw new IdentityError('identity.private-jwk', 'refusing a JWK that carries private members');", "throw new IdentityError('identity.jwk', 'refusing a JWK that carries private members');", ['identity/jwk/strictness']);
mut('I13 signing is attempted even without a usable key', 'identity', "if (st.state !== 'ok' && st.state !== 'ephemeral') throw new IdentityError('identity.cannot-sign'", "if (false) throw new IdentityError('identity.cannot-sign'", ['identity/export-policy/public-key-travels-private-key-does-not']);
mut('I14 receipt size cap is gone', 'identity', 'enc(canon).length > RECEIPT_MAX_BYTES', 'enc(canon).length > RECEIPT_MAX_BYTES * 100', ['identity/receipt/shape-limits']);
mut('I15 receipt version is not checked', 'identity', "if (receipt.v !== 1) p.push('v must be 1');", '', ['identity/receipt/shape-limits']);
mut('I16 memory-only keys are reported as ok', 'identity', "if (state === 'ok' && keys.persistent === false) state = 'ephemeral';", '', ['identity/status/states-are-measured-by-doing']);
mut('I17 the exported JWK keeps key_ops and ext', 'identity', 'const publicKeyJwk = normalizePublicJwk({ kty: exported.kty, crv: exported.crv, x: exported.x, y: exported.y });', 'const publicKeyJwk = exported;', ['identity/generate/private-key-is-not-extractable']);
// ---- store.js
mut('S01 compare-and-swap is skipped', 'store', "const conflict = profile.rev === 0 ? exists && (valid || !allowCorrupt) : !valid || cur.rev !== profile.rev;", 'const conflict = false;', ['store/crud/create-save-load-and-compare-and-swap-between-two-stores', 'store/import/apply-detects-a-concurrent-change']);
mut('S02 create over an existing id is allowed', 'store', 'const conflict = profile.rev === 0 ? exists && (valid || !allowCorrupt)', 'const conflict = profile.rev === 0 ? false', ['store/crud/create-save-load-and-compare-and-swap-between-two-stores']);
mut('S03 the history ring keeps 10', 'store', 'export const HISTORY_KEEP = 5;', 'export const HISTORY_KEEP = 10;', ['store/history/ring-keeps-the-last-five-replaced-revisions-and-restore-adds-a-revision']);
mut('S04 the history ring is never pruned', 'store', 'Math.max(0, keep.length - HISTORY_KEEP)', 'Math.max(0, keep.length - 100000)', ['store/history/ring-keeps-the-last-five-replaced-revisions-and-restore-adds-a-revision']);
mut('S05 the replaced revision is not written to history', 'store', "await tx.put('profileHistory', { hkey: historyKey(profile.id, histRev)", "await tx.get('profileHistory', { hkey: historyKey(profile.id, histRev)", ['store/history/ring-keeps-the-last-five-replaced-revisions-and-restore-adds-a-revision', 'store/migration/writes-back-with-the-old-revision-kept-in-history']);
mut('S06 a newer document can be overwritten', 'store', "if (exists && cur !== null && typeof cur === 'object' && Number.isInteger(cur.schemaVersion) && cur.schemaVersion > SCHEMA_VERSION) {", 'if (false) {', ['store/newer-document/read-only-and-never-rewritten']);
mut('S07 saving a newer-schema profile is not refused as read-only', 'store', "if (profile && typeof profile === 'object' && Number.isInteger(profile.schemaVersion) && profile.schemaVersion > SCHEMA_VERSION) {", 'if (false) {', ['store/newer-document/read-only-and-never-rewritten']);
mut('S08 loading a newer document is not read-only', 'store', 'if (opened.readOnly) return { ok: true, profile: opened.profile, readOnly: true,', 'if (false) return { ok: true, profile: opened.profile, readOnly: true,', ['store/newer-document/read-only-and-never-rewritten']);
mut('S09 quarantined records are not stored', 'store', "for (const q of qs) await tx.put('quarantine', q);", '', ['store/quarantine/shape-bad-records-are-moved-with-their-raw-json']);
mut('S10 the probe does nothing at all (a presence check)', 'store', '  const d = deps || defaultDeps();\n  const token', '  return { ok: true };\n  const d = deps || defaultDeps();\n  const token', ['store/probe/a-working-store-is-saved-and-a-broken-one-falls-back-to-memory-loudly']);
mut('S11 the probe does not check that delete worked', 'store', "if (gone !== undefined) return { ok: false, step, error: 'the probe record is still there after delete' };", '', ['store/probe/a-working-store-is-saved-and-a-broken-one-falls-back-to-memory-loudly']);
mut('S12 the probe does not compare what it read back', 'store', "if (!got || got.value !== token) return { ok: false, step: 'compare'", "if (false) return { ok: false, step: 'compare'", ['store/probe/a-working-store-is-saved-and-a-broken-one-falls-back-to-memory-loudly']);
mut('S13 a fallback to memory is not flagged not-saved', 'store', "status.notSaved = true;\n    status.reason = 'storage-unavailable: ' + describe(e);", "status.notSaved = false;\n    status.reason = 'storage-unavailable: ' + describe(e);", ['store/probe/a-working-store-is-saved-and-a-broken-one-falls-back-to-memory-loudly']);
mut('S14 memory-only storage is not flagged not-saved', 'store', 'if (!status.durable && !status.notSaved) { status.notSaved = true;', 'if (!status.durable && !status.notSaved) { status.notSaved = false;', ['store/probe/memory-only-storage-is-flagged-not-saved']);
mut('S15 a failed write does not set the not-saved flag', 'store', "if (mode === 'readwrite' && !(e instanceof StoreError) &&", 'if (false && !(e instanceof StoreError) &&', ['store/save/is-atomic-a-failure-mid-commit-leaves-neither-history-nor-profile-changed']);
mut('S16 a programming error sets the not-saved flag', 'store', ' && !(e instanceof TypeError || e instanceof RangeError || e instanceof ReferenceError || e instanceof SyntaxError)) this._flagNotSaved(', ') this._flagNotSaved(', ['store/status/a-programming-error-does-not-flip-the-not-saved-flag']);
mut('S17 an already-persisted store still asks to persist', 'store', 'if (out.alreadyPersisted) out.granted = true;', 'if (false) out.granted = true;', ['store/persistence/request-hook']);
mut('S18 a throwing persist() propagates', 'store', 'catch (e) { out.error = describe(e); }', 'catch (e) { throw e; }', ['store/persistence/request-hook']);
mut('S19 saves are not broadcast', 'store', '_announce(msg) { if (this._ch) {', '_announce(msg) { if (false) {', ['store/sync/broadcast-reaches-the-other-instance-and-marks-it-stale']);
mut('S20 isStale is true for a current copy', 'store', 'return (this._seen.get(profile.id) || 0) > profile.rev;', 'return (this._seen.get(profile.id) || 0) >= profile.rev;', ['store/sync/broadcast-reaches-the-other-instance-and-marks-it-stale']);
mut('S21 no automatic backup before an import overwrites', 'store', "if (backup) await tx.put('meta', { key: 'autoBackup:'", "if (false) await tx.put('meta', { key: 'autoBackup:'", ['store/import/apply-takes-an-automatic-backup-that-restores-exactly']);
mut('S22 a restore reuses the old revision number', 'store', 'newRev = histRev + 1;', 'newRev = histRev;', ['store/history/ring-keeps-the-last-five-replaced-revisions-and-restore-adds-a-revision']);
mut('S23 deleting a profile leaves its history', 'store', "for (const h of await tx.list('profileHistory', historyRange(id))) await tx.delete('profileHistory', h.hkey);", '', ['store/delete/removes-the-profile-its-history-and-its-keys-only']);
mut('S24 deleting a profile leaves its keys', 'store', "for (const k of await tx.list('keys', historyRange(id))) await tx.delete('keys', k.id);", '', ['store/delete/removes-the-profile-its-history-and-its-keys-only']);
mut('S25 the memory adapter writes through (no rollback)', 'store', 'work.set(n, new Map(db.stores.get(n)));', 'work.set(n, db.stores.get(n));', ['store/contract/memory-adapter-passes-every-case', 'store/save/is-atomic-a-failure-mid-commit-leaves-neither-history-nor-profile-changed']);
mut('S26 the memory adapter returns stored objects by reference', 'store', 'async get(s, k) { return clone(st(s).get(k)); },', 'async get(s, k) { return st(s).get(k); },', ['store/contract/memory-adapter-passes-every-case']);
mut('S27 the memory adapter does not serialise transactions', 'store', 'const p = db.lock.then(run);', 'const p = run();', ['store/contract/memory-adapter-passes-every-case']);
mut('S28 a failed probe does not fall back to memory', 'store', "adapter = createMemoryAdapter({ name: 'memory-fallback-' + newId('f', deps) });", 'adapter = adapter;', ['store/probe/a-working-store-is-saved-and-a-broken-one-falls-back-to-memory-loudly']);
mut('S29 a read-only database is probed with a write', 'store', 'if (adapter.readOnly) { // a database written by a newer build', 'if (false) { // a database written by a newer build', ['store/readonly-database/is-reported-and-refuses-writes']);
mut('S30 deleting a profile ignores read-only documents', 'store', "if (cur !== undefined && typeof cur === 'object' && Number.isInteger(cur.schemaVersion) && cur.schemaVersion > SCHEMA_VERSION) {\n        throw new ReadOnlyError(`profile ${id} was saved by a newer build and is read-only here`, { id });\n      }", '', ['store/newer-document/read-only-and-never-rewritten']);
mut('S31 a repair cannot replace a record whose rev is unusable', 'store', 'return this._commit(tx, opened.profile, { reason: why, backup: null, allowCorrupt: true });', 'return this._commit(tx, opened.profile, { reason: why, backup: null, allowCorrupt: false });', ['store/load/repairs-an-unusable-rev-without-losing-the-document']);
// ---- one mutant for each check that no mutant above names (a check nobody can make fail is decoration)
mut('P48 quarantine loses the raw record', 'profile', "if (r.problems.length) { quarantined.push({ kind: 'mon', index: i, raw, problems: r.problems });", "if (r.problems.length) { quarantined.push({ kind: 'mon', index: i, raw: null, problems: r.problems });", ['profile/quarantine/keeps-the-raw-record-untouched']);
mut('P49 a non-integer schemaVersion is accepted', 'profile', 'if (!Number.isInteger(from) || from < 1)', 'if (from < 1)', ['profile/migrate/refuses-an-unusable-version']);
mut('P50 normalisation trusts a non-array box', 'profile', 'const rawBox = Array.isArray(input.box) ? input.box : [];', 'const rawBox = input.box || [];', ['profile/fuzz/open-never-throws-and-output-is-valid-and-stable']);
mut('P51 stat-block problem paths lose the stat key', 'profile', "add(code, `${path}.${k}`, `${path}.${k} must be an integer 0..${hi}`); ok = false;", "add(code, path, `${path}.${k} must be an integer 0..${hi}`); ok = false;", ['profile/shape/object-entries-have-the-stated-paths']);
mut('P52 ids may be 41 characters', 'profile', 'const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;', 'const ID_RE = /^[A-Za-z0-9_-]{1,41}$/;', ['profile/ids/newId-and-isId']);
mut('P53 the rules bridge always reports species 1', 'profile', 'species: mon.species, level: mon.level, nature: mon.nature, abilitySlot: mon.abilitySlot, item: mon.heldItem,', 'species: 1, level: mon.level, nature: mon.nature, abilitySlot: mon.abilitySlot, item: mon.heldItem,', ['profile/rules/blankRec-records-validate-under-every-preset', 'profile/rules/bridge-maps-fields-exactly']);
mut('P54 points are derived from the IVs (strict-champions)', 'profile', 'rec.points = evsToPoints(rec.evs, rec.ivs);', 'rec.points = evsToPoints(rec.ivs, rec.ivs);', ['profile/rules/stored-mon-reports-rule-violations-with-codes', 'profile/rules/validateMonList-equals-validateTeam-plus-gender']);
mut('P55 gzip export is flagged but not compressed', 'profile', "bytes = await compressBytes(bytes, 'gzip'); gz = true; }", 'gz = true; }', ['profile/export/round-trip-plain-and-gz-after-canonicalisation']);
mut('P56 an old-schema envelope is checked against the raw document', 'profile', 'env.romSha256 !== opened.profile.romSha256', 'env.romSha256 !== env.profile.romSha256', ['profile/import/old-schema-files-are-migrated']);
mut('P57 the rules report is never produced', 'profile', 'res.rules = validateProfileAgainstPack(profile, opts.pack, opts.ruleset);', 'res.rules = undefined;', ['profile/import/rules-report-flags-without-aborting']);
mut('P67 the unknown-species pass is never run', 'profile', 'setAsideUnknownSpecies(profile, opts.pack, res.quarantined);', '', ['profile/import/species-the-rom-lacks-are-set-aside-with-a-named-code']);
mut('P68 every species is kept (the table is not asked)', 'profile', 'if (Number.isInteger(m.species) && pack.species[m.species]) return true;', 'return true;', ['profile/import/species-the-rom-lacks-are-set-aside-with-a-named-code']);
mut('P69 a set-aside record stays on its team', 'profile', 'if (gone.size) profile.teams = profile.teams.map(', 'if (false) profile.teams = profile.teams.map(', ['profile/import/species-the-rom-lacks-are-set-aside-with-a-named-code']);
mut('P70 a profile may hold 17 teams', 'profile', 'teamsMax: 16,', 'teamsMax: 17,', ['profile/limits/a-profile-holds-sixteen-teams']);
mut('P58 an imported copy keeps the incoming id', 'profile', "p.id = newId('p', d);\n    p.rev = 0;", 'p.rev = 0;', ['profile/import/plan-new-gets-a-fresh-id-and-keeps-the-public-identity-copy']);
mut('T31 an incoming card is validated under the default ruleset', 'teamcode', 'return validateMonList(team.mons, pack, team.ruleset);', "return validateMonList(team.mons, pack, 'arena-gen3-standard');", ['team/validate/a-pasted-code-validates-exactly-like-the-same-team-in-the-box']);
mut('T32 mons imported from a code lose their provenance', 'teamcode', "provenance: { source: 'team-code' } }, deps));", '}, deps));', ['team/helpers/profile-team-to-code-and-back-into-a-box']);
mut('T33 a clock read appears in teamcode.js', 'teamcode', 'const bin = encodeTeamBinary(team);\n  if (!streamSupported', 'const bin = (Date.now(), encodeTeamBinary(team));\n  if (!streamSupported', ['purity/no-ambient-clock-or-randomness-outside-defaultDeps']);
mut('T34 a non-ASCII character appears in a comment', 'teamcode', '// pokemonarena/js/teamcode.js -- the team code', '// pokemonarena/js/teamcode.js -- the team cod\u00e9', ['purity/ascii-only']);
mut('T35 an export is renamed', 'teamcode', 'export function cardHash(bytes)', 'export function cardHash2(bytes)', ['purity/public-api-present']);
mut('I18 a signature entry carries the wrong public key', 'identity', 'return { keyId: st.keyId, publicKeyJwk: st.publicKeyJwk, sig: b64urlEncode(sig) };', 'return { keyId: st.keyId, publicKeyJwk: { ...st.publicKeyJwk, x: st.publicKeyJwk.y }, sig: b64urlEncode(sig) };', ['identity/receipt/signed-by-one-profile-verifies']);
mut('I19 a second key overwrites the first (one shared slot)', 'identity', 'await keys.put(keySlot(profile.id, id.keyId), { profileId: profile.id, keyId: id.keyId, privateKey: id.privateKey, publicKeyJwk: id.publicKeyJwk, createdAt: now });', 'await keys.put(profile.id, { profileId: profile.id, keyId: id.keyId, privateKey: id.privateKey, publicKeyJwk: id.publicKeyJwk, createdAt: now });', ['identity/ensure/racing-tabs-each-keep-their-own-key-and-nothing-is-overwritten']);
mut('I21 rotation deletes the retired private key', 'identity', 'const id = await generateIdentity();\n  await keys.put(keySlot(profile.id, id.keyId), { profileId: profile.id, keyId: id.keyId, privateKey: id.privateKey, publicKeyJwk: id.publicKeyJwk, createdAt: t });', 'const id = await generateIdentity();\n  if (profile.identity.publicKeyJwk) await keys.delete(keySlot(profile.id, await keyIdOf(profile.identity.publicKeyJwk)));\n  await keys.put(keySlot(profile.id, id.keyId), { profileId: profile.id, keyId: id.keyId, privateKey: id.privateKey, publicKeyJwk: id.publicKeyJwk, createdAt: t });', ['identity/rotate/needs-an-explicit-acknowledgement-and-keeps-the-old-key']);
mut('I20 the identity notice stops saying it is per browser profile', 'identity', 'stored in this browser profile only.', 'stored somewhere.', ['identity/notice-states-the-per-browser-limit']);
mut('S32 the memory adapter stores objects by reference', 'store', 'const c = clone(v); st(s).set(keyOf(s, c), c);', 'st(s).set(keyOf(s, v), v);', ['store/crud/save-returns-a-copy-and-never-aliases-the-stored-doc']);
mut('S33 saveProfile does not validate', 'store', "if (problems.length) throw new ValidationError('profile is not well formed: '", "if (false) throw new ValidationError('profile is not well formed: '", ['store/crud/invalid-profiles-are-refused-and-leave-the-store-alone']);
mut('S34 one history range covers every profile', 'store', 'const historyRange = (id) => ({ gte: `${id}:`, lt: `${id};` });', "const historyRange = (id) => ({ gte: ':', lt: ';' });", ['store/history/other-profiles-have-separate-rings']);
mut('S35 an unreadable document is not copied to quarantine', 'store', "kind: 'document', index: -1, raw, problems: opened.problems }", "kind: 'document', index: -1, raw: null, problems: opened.problems }", ['store/quarantine/an-unreadable-document-is-reported-copied-and-left-in-place']);
mut('S36 a restore cannot replace an unreadable current document', 'store', 'return this._commit(tx, restored, { reason: `restore-of-${rev}`, backup: null, allowCorrupt: true });', 'return this._commit(tx, restored, { reason: `restore-of-${rev}`, backup: null, allowCorrupt: false });', ['store/restore/can-repair-an-unreadable-current-document-from-history']);
mut('S37 a disabled channel gives no reason', 'store', "} else status.sync.reason = 'BroadcastChannel is not available';", "} else status.sync.reason = '';", ['store/sync/disabled-channel-is-reported']);
mut('S38 deleting a key does nothing', 'store', "delete: (id) => self._tx(['keys'], 'readwrite', (tx) => tx.delete('keys', id)),", "delete: (id) => self._tx(['keys'], 'readwrite', (tx) => tx.get('keys', id)),", ['store/keys/interface']);
mut('S40 memory-only keys claim to be persistent', 'store', 'get persistent() { return self._status.durable && !self._status.notSaved; },', 'get persistent() { return true; },', ['store/keys/interface']);
mut('S41 there is no time limit on opening storage', 'store', "    })(), timeoutMs, 'opening storage');", "    })(), 2147483647, 'opening storage');", ['store/probe/an-open-that-never-finishes-falls-back-instead-of-hanging']);
mut('S39 the lost-update contract case always passes', 'store', 'return n === 25 ? true : `25 concurrent increments produced ${n}`;', 'return true;', ['store/contract/broken-adapters-are-caught-by-named-cases']);

// ---------------------------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------------------------
const main = async () => {
  const t0 = Date.now();
  console.log(`pokemonarena profile/store/teamcode/identity test -- node ${process.version}, ${suite.length} named checks, ${MUTANTS.length} source mutants`);
  const ids = suite.map((c) => c.id);

  head('A. THE REAL MODULES');
  const realCtx = await loadRealCtx();
  const realResults = await runSuite(suite, realCtx);
  for (const r of realResults) t(r.id, r.ok ? true : r.detail);
  console.log(`  info suite wall time ${Date.now() - t0} ms; slowest checks: ${realResults.slice().sort((a, b) => b.ms - a.ms).slice(0, 4).map((r) => r.id.split('/').slice(-1)[0].slice(0, 40) + ' ' + r.ms.toFixed(0) + 'ms').join(', ')}`);

  head('B. TWIN: the unmutated sources through the mutant loader');
  const twin = await loadVariant({ ...SRC });
  const twinResults = await runSuite(suite, twin);
  const twinFail = twinResults.filter((r) => !r.ok);
  t(`the unedited twin passes all ${twinResults.length} checks (the loader adds no behaviour)`, twinFail.length === 0, twinFail.map((r) => r.id + ': ' + r.detail).join(' | '));

  head('C. SOURCE MUTANTS (' + MUTANTS.length + '): each must make its NAMED check(s) fail');
  const idSet = new Set(ids);
  const trippedBy = new Map();
  let caught = 0;
  const bad = [];
  for (const m of MUTANTS) {
    if (!m.expect.every((e) => idSet.has(e))) { t(`${m.id}: expected check names exist`, false, m.expect.filter((e) => !idSet.has(e)).join(', ')); continue; }
    const src = SRC[m.file];
    const hits = src.split(m.from).length - 1;
    if (hits !== m.count) { t(`${m.id}: mutation target found ${m.count}x in ${m.file}.js`, false, `found ${hits}x: ${J(m.from.slice(0, 80))}`); continue; }
    const mutated = { ...SRC, [m.file]: src.split(m.from).join(m.to) };
    let variant;
    try { variant = await loadVariant(mutated); } catch (e) { t(`${m.id}: mutant loads`, false, e.message.split('\n')[0]); continue; }
    const res = await runSuite(suite, variant, new Set(m.expect));
    const failedIds = res.filter((r) => !r.ok).map((r) => r.id);
    for (const f of failedIds) if (!trippedBy.has(f)) trippedBy.set(f, m.id);
    const missed = m.expect.filter((e) => !failedIds.includes(e));
    if (missed.length === 0) { caught++; t(`${m.id}  -> caught by ${m.expect.join(' + ')}`, true); }
    else { bad.push(m.id); t(`${m.id}: NOT caught by ${missed.join(', ')}`, false, failedIds.length ? `it did trip: ${failedIds.slice(0, 4).join(', ')}` : 'it tripped nothing'); }
  }
  t(`all ${MUTANTS.length} source mutants caught (${caught} caught)`, caught === MUTANTS.length, bad.join(', '));
  const unnamed = ids.filter((i) => !MUTANTS.some((m) => m.expect.includes(i)));
  t(`every one of the ${ids.length} checks is named by at least one mutant (a check nobody can make fail is decoration)`, unnamed.length === 0, unnamed.join(', '));
  const byFile = {};
  for (const m of MUTANTS) byFile[m.file] = (byFile[m.file] || 0) + 1;
  console.log(`  info mutants per module: ${J(byFile)}`);

  head('D. DATA MUTANTS: a damaged fixture must trip the golden checks');
  const dataCases = [
    ['D1 expected v2 loses a bag entry', (F) => { delete F.v1fullExp._unknown.flavor; }, ['profile/migrate/v1-full-golden', 'profile/migrate/unknown-fields-carried-to-the-same-level'].slice(0, 1)],
    ['D2 expected v2 has a wrong ruleset id', (F) => { F.v1fullExp.teams[0].ruleset = 'arena-gen3-standard+lv5'; }, ['profile/migrate/v1-full-golden']],
    ['D3 v1 input mon has a different slot (expected unchanged)', (F) => { F.v1full.box[0].ability.slot = 0; }, ['profile/migrate/v1-full-golden']],
    ['D4 v1-bad expectation forgets a quarantined record', (F) => { F.v1badExp.quarantined.pop(); }, ['profile/migrate/v1-bad-golden']],
    ['D5 current fixture gets an extra field the schema does not know', (F) => { F.cur.surprise = 1; }, ['profile/migrate/current-is-a-fixed-point']],
    ['D6 the newer fixture is no longer newer', (F) => { F.fut.schemaVersion = 3; }, ['profile/migrate/newer-document-is-read-only-and-untouched']],
  ];
  let dcaught = 0;
  for (const [id, edit, expect] of dataCases) {
    const F2 = { v1full: clone(FIX.v1full), v1fullExp: clone(FIX.v1fullExp), v1bad: clone(FIX.v1bad), v1badExp: clone(FIX.v1badExp), v2: clone(FIX.v2), v2exp: clone(FIX.v2exp), cur: clone(FIX.cur), fut: clone(FIX.fut) };
    edit(F2);
    const res = await runSuite(suite, { ...realCtx, FIX: F2 }, new Set(expect));
    const failedIds = res.filter((r) => !r.ok).map((r) => r.id);
    const missed = expect.filter((e) => !failedIds.includes(e));
    if (missed.length === 0) { dcaught++; t(`${id}  -> caught by ${expect.join(' + ')}`, true); } else t(`${id}: NOT caught by ${missed.join(', ')}`, false, 'it tripped ' + (failedIds.join(', ') || 'nothing'));
  }
  t(`all ${dataCases.length} data mutants caught`, dcaught === dataCases.length);

  head('RESULT');
  console.log(`  ${passed} passed, ${failed} failed  (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  console.log('  NOT proven here: real IndexedDB (tools/pokemonarena_idb_smoke_test.mjs); cross-browser behaviour (Chrome only); that the ROM-font charset');
  console.log('  covers every glyph a player may want; that an ECDSA identity means more than key continuity (no server says whose key it is); hostile-peer');
  console.log('  anti-cheat (validation is consistency between honest clients).');
  if (failed) { console.log('\nFAILURES:'); for (const f of failures) console.log('  ' + f); process.exit(1); }
};

async function loadRealCtx() {
  const P = await import(fileUrl('profile.js'));
  const T = await import(fileUrl('teamcode.js'));
  const I = await import(fileUrl('identity.js'));
  const S = await import(fileUrl('store.js'));
  return { P, T, I, S, sources: SRC, pack, rom, FIX };
}

main().catch((e) => { console.error(e); process.exit(2); });

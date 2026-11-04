// tools/pokemonarena_tower_profile_test.mjs -- the Pokemon Tower in the PROFILE (schema 5), in Node: the migration from every older schema, the repair of a damaged Tower record, export / import / merge / replace,
// the store's own Tower transaction, and the proof that the Tower and the battle record never touch each other.
//
//   node tools/pokemonarena_tower_profile_test.mjs             the cases
//   node tools/pokemonarena_tower_profile_test.mjs --mutants   ALSO break profile.js / store.js / tower_record.js / tower_session.js one way at a time; every break must fail a NAMED group
//
// REAL USERS' STORED PROFILES ARE AT STAKE, so this file is conservative: every migration is proved to keep every value it does not own (the fixtures in tools/fixtures/pokemonarena are derived from the schema-4
// ones by editing the JSON, never by running the code under test), a damaged Tower record is proved to cost the player at most that one field, and nothing here can pass if `stats` (totals, byCpu, online,
// recent) changes because of a Tower step, or `tower` changes because of a battle.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const SRC = path.join(root, 'pokemonarena', 'js');
const FX = path.join(here, 'fixtures', 'pokemonarena');
const ROM_PATH = process.env.ARENA_ROM || path.join(root, 'gba', 'gbaWasm', 'roms', 'Pokemon SoulGold (v1.1.1).gba');
const WANT_MUTANTS = process.argv.includes('--mutants');
const ONLY = process.argv.slice(2).filter((a) => /^--only=/.test(a)).map((a) => a.slice(7).split(',')).flat();

let pass = 0, fail = 0; const failures = [];
function ok(cond, name, detail) { if (cond) { pass++; if (process.env.ARENA_VERBOSE) console.log('ok  ', name); } else { fail++; failures.push(name + (detail ? ' :: ' + detail : '')); if (!process.env.ARENA_QUIET) console.log('FAIL', name, detail || ''); } }
const J = (x) => JSON.stringify(x);
const clone = (x) => JSON.parse(JSON.stringify(x));
const canon = (x) => { const walk = (v) => (Array.isArray(v) ? v.map(walk) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, walk(v[k])])) : v); return JSON.stringify(walk(x)); };
const readFx = (n) => JSON.parse(fs.readFileSync(path.join(FX, n), 'utf8'));
const imp = (dir, f, bust) => import(pathToFileURL(path.join(dir, f)).href + (bust ? '?x=' + bust : ''));
async function loadStack(dir, bust) {
  const [P, ST, R, SS, T, HD, A] = await Promise.all(['profile.js', 'store.js', 'tower_record.js', 'tower_session.js', 'tower.js', 'hub_data.js', 'career_stats.js'].map((f) => imp(dir, f, bust)));
  return { P, ST, R, SS, T, HD, A };
}
const FIX = { v1full: readFx('profile-v1-full.json'), v1fullExp: readFx('profile-v1-full.expected-v5.json'), v1bad: readFx('profile-v1-bad.json'), v1badExp: readFx('profile-v1-bad.expected-v5.json'), v2: readFx('profile-v2-current.json'), v2exp: readFx('profile-v2-current.expected-v5.json'),
  v3: readFx('profile-v3-current.json'), v4: readFx('profile-v4-current.json'), cur: readFx('profile-v5-current.json'), tower: readFx('profile-v5-tower.json'), fut: readFx('profile-v6-future.json') };
const NOW = 1700000999999;
let counter = 0;
const deps = () => ({ now: () => NOW, randomBytes: (n) => Uint8Array.from({ length: n }, (_, i) => (i * 37 + (++counter) * 11 + 5) & 255) });
function onlineMatch(i, over = {}) {
  return { id: 'on' + i + '_3v3_AQ111', at: 1700000600000 + i, fmt: '3v3', cpu: 'online', opp: 'Mallory', ruleset: 'arena-gen3-standard', result: 'w', turns: 12, playMs: 90000, mvp: 9, team: [9, 94], species: [9], moves: [[11, 3]],
    me: { kos: 2, faints: 1, dealt: 300, taken: 100, hits: 5, crits: 1, superEffective: 2, resisted: 0, noEffect: 0, misses: 1, statusInflicted: 0, healed: 0, switches: 1, koStreak: 1, biggestHit: { sp: 9, mv: 11, dmg: 120, pct: 50, vs: 94 } }, foeFaints: 2, ...over };
}
const sleepTick = () => new Promise((r) => setImmediate(r));

async function suite(S, tag, opt = {}) {
  const { P, ST, R, SS, T, HD } = S;
  const t = (s) => (tag ? '[' + tag + '] ' : '') + s;
  const grp = (g) => !opt.groups || opt.groups.includes(g);
  const N = (full, fast) => (opt.fast ? fast : full);
  const open = (doc) => P.openProfileDocument(clone(doc), { deps: deps() });
  const statsOf = (p) => canon(p.stats), towerOf = (p) => canon(p.tower);
  const EMPTY = () => ({ v: 1, best: { '3v3': 0, '6v6': 0 }, winsByFormat: { '3v3': 0, '6v6': 0 }, runs: 0, wins: 0, floors: 0, bosses: 0, buffsSeen: {}, achievements: {}, current: null, last: null });

  /* P. the schema, the migration, the repair */
  if (grp('P')) {
    ok(P.SCHEMA_VERSION === 5 && typeof P.MIGRATIONS[4] === 'function' && Object.keys(P.MIGRATIONS).join() === '1,2,3,4', t('P1 the current schema is 5 and there is a migration out of every older one (1, 2, 3 and 4)'), String(P.SCHEMA_VERSION));
    const fresh = P.createProfile({ trainerName: 'ASH' }, deps());
    ok(J(fresh.tower) === J(EMPTY()) && P.checkProfile(fresh).length === 0 && P.checkProfile({ ...fresh, tower: undefined }).some((x) => x.code === 'profile.tower') && P.checkProfile({ ...fresh, tower: { ...EMPTY(), runs: -1 } }).some((x) => x.code === 'profile.tower'), t('P2 a new profile starts with an empty Tower record, and a profile without one (or with a bad one) is not well formed'), J(P.checkProfile({ ...fresh, tower: undefined })));
    // v4 -> v5
    const o4 = open(FIX.v4);
    ok(o4.ok && o4.migratedFrom === 4 && o4.changed === true && !o4.readOnly && !o4.problems.length && !o4.quarantined.length && canon(o4.profile) === canon(FIX.cur), t('P3 a stored v4 profile comes up as the v5 fixture, value for value (nothing repaired, nothing set aside)'), J({ ok: o4.ok, mf: o4.migratedFrom, p: o4.problems.length }));
    const back = clone(o4.profile); delete back.tower; back.schemaVersion = 4;
    ok(canon(back) === canon(FIX.v4), t('P4 take away what v5 adds and put back the version: what is left is the v4 document, value for value (every battle record, team and Pokemon kept)'), '');
    const m4 = P.MIGRATIONS[4], input = clone(FIX.v4), copy = clone(input), once = m4(input);
    ok(canon(input) === canon(copy) && once.schemaVersion === 5 && J(once.tower) === J(EMPTY()) && canon(m4({ ...clone(once), schemaVersion: 4 })) === canon(once), t('P5 the v4 -> v5 migration is pure (it never writes its input) and a fixed point (run on its own output it changes nothing)'), '');
    const withTower = clone(FIX.v4); withTower.tower = clone(FIX.tower.tower);
    const keep = m4(withTower), junk = [5, 'x', null, [], { v: 2 }, { ...EMPTY(), runs: -1 }];
    let junkWhy = '';
    for (const j of junk) { const d = clone(FIX.v4); d.tower = j; const r = m4(d); if (J(r.tower) !== J(EMPTY()) || canon(r._unknown && r._unknown.v4Tower) !== canon(j)) junkWhy = junkWhy || 'junk ' + J(j) + ' -> ' + J(r.tower) + ' bag ' + J(r._unknown); }
    ok(canon(keep.tower) === canon(FIX.tower.tower) && !junkWhy, t('P6 a v4 document that already has a well-formed `tower` keeps it; anything else under that name is kept in the unknown bag and the record starts empty'), junkWhy);
    for (const [k, doc, want] of [['v1full', FIX.v1full, FIX.v1fullExp], ['v2', FIX.v2, FIX.v2exp], ['v3', FIX.v3, FIX.cur]]) { const o = open(doc); ok(o.ok && canon(o.profile) === canon(want) && J(o.profile.tower) === J(EMPTY()), t('P7 a stored ' + k + ' profile comes up as its golden v5 profile, with an empty Tower record'), k); }
    const ob = open(FIX.v1bad); ok(ob.ok && canon(ob.profile) === canon(FIX.v1badExp.profile) && J(ob.profile.tower) === J(EMPTY()), t('P8 the damaged v1 fixture still opens to its golden v5 profile (the records set aside are the same ones)'), '');
    const oldBuild = P.migrateProfile(clone(FIX.cur), { 1: P.MIGRATIONS[1], 2: P.MIGRATIONS[2], 3: P.MIGRATIONS[3] }, 4), fut = P.migrateProfile(clone(FIX.fut));
    ok(oldBuild.ok && oldBuild.readOnly === true && oldBuild.steps === 0 && oldBuild.from === 5 && canon(oldBuild.profile) === canon(FIX.cur) && fut.readOnly === true && fut.from === 6 && open(FIX.fut).readOnly === true && canon(open(FIX.fut).profile) === canon(FIX.fut), t('P9 a build that only knows v4 opens a v5 profile read-only and untouched; this build does the same for a v6 one'), J({ ro: oldBuild.readOnly, from: oldBuild.from }));
    // the populated fixture is a fixed point; repair
    const op = open(FIX.tower);
    ok(op.ok && !op.changed && op.migratedFrom === null && !op.problems.length && canon(op.profile) === canon(FIX.tower) && P.checkProfile(op.profile).length === 0, t('P10 a profile with a populated Tower record (a run under way, the last run, unknown fields) opens unchanged'), J(op.problems.slice(0, 2)));
    const damaged = [['a number', 5], ['null', null], ['a list', [1, 2]], ['another version', { v: 2, anything: true }], ['best as text', { ...clone(FIX.tower.tower), best: 'x' }], ['a bad buff id', { ...clone(FIX.tower.tower), buffsSeen: { 'Bad Id': 1, 'power-training': 2 } }], ['a run that is not a run', { ...clone(FIX.tower.tower), current: { floor: 1 } }], ['a last run that is text', { ...clone(FIX.tower.tower), last: 'x' }]];
    let dmgWhy = '';
    for (const [name, tw] of damaged) {
      const d = clone(FIX.tower); d.tower = tw; const o = open(d);
      if (!o.ok) { dmgWhy = dmgWhy || name + ': did not open ' + J(o).slice(0, 120); continue; }
      const again = open(o.profile);
      if (P.checkProfile(o.profile).length || !o.problems.some((x) => x.code === 'profile.tower') || again.changed || statsOf(o.profile) !== statsOf(FIX.tower) || canon(o.profile.teams) !== canon(FIX.tower.teams) || canon(o.profile.box) !== canon(FIX.tower.box)) dmgWhy = dmgWhy || name + ': ' + J({ bad: P.checkProfile(o.profile).slice(0, 1), probs: o.problems.map((x) => x.code), again: again.changed });
      if (!o.profile.tower._unknown || !o.profile.tower._unknown.towerRejected) dmgWhy = dmgWhy || name + ': the damaged value was not kept in the bag';
    }
    ok(!dmgWhy, t('P11 a damaged Tower record opens anyway (reported as repaired), is well formed and a fixed point, keeps the damaged value in its bag, and the rest of the profile (record, teams, box) is untouched'), dmgWhy);
    // fuzz INSIDE the tower: whatever happens there, nothing else changes
    const rng = (() => { let a = 99; return () => { a = (a + 0x6d2b79f5) >>> 0; let x = a; x = Math.imul(x ^ (x >>> 15), x | 1); x ^= x + Math.imul(x ^ (x >>> 7), x | 61); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; }; })();
    const junkOf = () => [null, -1, 'x', 1e12, {}, [], true, 2.5, { a: 1 }][Math.floor(rng() * 9)];          // (fresh values every time: a shared object could end up inside itself)
    let fuzzWhy = '';
    for (let i = 0; i < N(500, 60) && !fuzzWhy; i++) {
      const d = clone(FIX.tower); const walk = (o, depth) => { const ks = Object.keys(o || {}); if (!ks.length || depth > 4 || rng() < 0.2) return; const k = ks[Math.floor(rng() * ks.length)], v = o[k]; if (rng() < 0.35) o[k] = junkOf(); else if (rng() < 0.15) delete o[k]; else if (v && typeof v === 'object') walk(v, depth + 1); };
      walk(d.tower, 0); walk(d.tower, 0);
      let o; try { o = open(d); } catch (e) { fuzzWhy = 'threw ' + e.message; break; }
      if (!o.ok) { fuzzWhy = 'did not open: ' + o.code; break; }
      if (P.checkProfile(o.profile).length) fuzzWhy = 'opened but invalid: ' + P.checkProfile(o.profile)[0].code;
      else if (statsOf(o.profile) !== statsOf(FIX.tower) || canon(o.profile.teams) !== canon(FIX.tower.teams) || canon(o.profile.box) !== canon(FIX.tower.box) || o.profile.trainerName !== FIX.tower.trainerName) fuzzWhy = 'damage in the Tower changed something that is not the Tower';
      else { const again = open(o.profile); if (again.changed || again.problems.length) fuzzWhy = 'not a fixed point'; }
    }
    ok(!fuzzWhy, t('P12 ' + N(500, 60) + ' random edits inside the Tower record (any field, any depth) always open to a well-formed, stable profile and never change the battle record, the teams, the box or the name'), fuzzWhy);
  }

  /* X. export, import, merge, replace, "keep my edits" */
  if (grp('X')) {
    const p0 = clone(FIX.tower); p0.rev = 6;
    for (const gzip of [false, true]) {
      const e = await P.exportBytes(p0, { gzip, deps: { now: () => NOW } }), r = await P.parseExport(e.bytes, {});
      ok(r.ok && !r.problems.length && !r.quarantined.length && canon({ ...r.profile, rev: 0 }) === canon({ ...p0, rev: 0 }) && r.profile.tower.current.seed === FIX.tower.tower.current.seed, t('X1 a profile with a populated Tower record exports and imports back unchanged (' + (gzip ? 'gzip' : 'plain') + '): the run under way, the last run, the unknown fields'), J(r).slice(0, 200));
    }
    const env = P.buildExport(p0, { deps: { now: () => NOW } }); env.profile.tower.runs += 1;
    const tampered = await P.parseExport(P.serializeExport(env), {});
    ok(!tampered.ok && tampered.code === 'import.checksum', t('X2 the export checksum covers the Tower record: editing it in the file is caught'), J(tampered).slice(0, 120));
    // a v4 file is an old-schema file: it migrates
    const e4 = { format: 'pokemonarena-profile', exportVersion: 1, schemaVersion: 4, exportedAt: 5, romSha256: FIX.v4.romSha256, profile: clone(FIX.v4) }; delete e4.profile.rev;
    const sum = (() => { const c = P.buildExport(P.openProfileDocument(clone(FIX.cur), {}).profile, { deps: { now: () => 5 } }); return c.checksum; })(); void sum;
    const e4c = (() => { const x = clone(e4); const b = P.buildExport({ ...clone(FIX.v4), schemaVersion: 4 }, { deps: { now: () => 5 } }); x.checksum = b.checksum; return x; })();
    const r4 = await P.parseExport(JSON.stringify(e4c), { deps: deps() });
    ok(r4.ok && r4.migratedFrom === 4 && canon({ ...r4.profile, rev: 0 }) === canon({ ...FIX.cur, rev: 0 }), t('X3 a file exported by the last build (schema 4) imports as a migrated v5 profile with an empty Tower record'), J(r4).slice(0, 160));
    // the import plan
    const incoming = clone(FIX.tower); incoming.rev = 0; incoming.id = 'p_incoming'; incoming.tower.runs = 9; incoming.tower.wins = 0; incoming.tower.winsByFormat = { '3v3': 0, '6v6': 0 };
    const existing = clone(FIX.cur); existing.rev = 4; existing.tower = clone(FIX.tower.tower); existing.tower.runs = 2; existing.tower.achievements = { 'first-floor': 5 };
    const pn = P.planImport(null, incoming, 'new', deps()), pr = P.planImport(existing, incoming, 'replace', deps()), pm = P.planImport(existing, incoming, 'merge', deps());
    ok(pn.ok && pn.report.tower === 'copied' && canon(pn.profile.tower) === canon(incoming.tower) && pn.profile.id !== incoming.id, t('X4 a NEW profile from a file carries the file\'s Tower record'), J(pn.report));
    ok(pr.ok && pr.report.tower === 'replaced' && canon(pr.profile.tower) === canon(incoming.tower) && pr.profile.id === existing.id && pr.profile.rev === existing.rev, t('X5 REPLACE: the file\'s Tower record takes its place (the id and revision stay), and the report says so'), J(pr.report));
    ok(pm.ok && pm.report.tower === 'kept-local' && canon(pm.profile.tower) === canon(existing.tower) && statsOf(pm.profile) === statsOf(existing), t('X6 MERGE leaves the active profile\'s Tower record and battle record exactly as they were (the file\'s are not added), and the report says so'), J(pm.report));
    const pm2 = P.planImport(pm.profile, incoming, 'merge', deps());
    ok(pm2.ok && canon(pm2.profile.tower) === canon(existing.tower), t('X7 merging the same file again changes nothing about the Tower (no counter can be counted twice)'), '');
    // "keep my edits": the Team Builder's save over a newer revision
    const mine = clone(FIX.cur); mine.teams = []; mine.trainerName = 'MINE';
    const stored = clone(FIX.tower); stored.rev = 9;
    const kept = P.withStoredRecord(mine, stored);
    ok(kept.trainerName === 'MINE' && canon(kept.tower) === canon(stored.tower) && statsOf(kept) === statsOf(stored) && kept.tower !== stored.tower && kept.stats !== stored.stats && canon(mine.tower) === canon(FIX.cur.tower), t('X8 "Keep my edits here" carries the STORED Tower record and battle record into the edited profile (copies, not shared), and touches nothing of the edit'), '');
  }

  /* B. the battle record and the Tower never touch each other */
  if (grp('B')) {
    const p = (() => { const x = clone(FIX.tower); x.rev = 3; return x; })();
    const rec = P.recordMatch(p, onlineMatch(1));
    ok(rec.ok && canon(rec.profile.tower) === canon(p.tower) && rec.profile.stats.totals.kos !== p.stats.totals.kos && rec.profile.stats.byCpu.online.w === p.stats.byCpu.online.w + 1, t('B1 recording a battle changes the battle record and never the Tower record'), J(rec).slice(0, 160));
    const rs = P.resetRecord(p);
    ok(canon(rs.tower) === canon(p.tower) && statsOf(rs) !== statsOf(p) && rs.stats.totals.kos === 0 && rs.stats.byCpu.online.w === 0 && rs.stats.recent.length === 0, t('B2 RESET RECORD empties the battle record and never touches the Tower record'), '');
    // a Tower step through the profile functions: only `tower` moves
    const tw = clone(p.tower), after = SS.reduceGiveUp(tw, { seed: tw.current.seed, now: 5 });
    const next = { ...clone(p), tower: after.tower };
    ok(after.applied && P.checkProfile(next).length === 0 && statsOf(next) === statsOf(p) && canon(next.teams) === canon(p.teams) && canon(next.box) === canon(p.box) && canon(next.stats.totals) === canon(p.stats.totals) && canon(next.stats.byCpu) === canon(p.stats.byCpu) && canon(next.stats.byCpu.online) === canon(p.stats.byCpu.online) && canon(next.stats.recent) === canon(p.stats.recent), t('B3 a Tower step (here: giving a run up) changes `tower` and nothing else: stats.totals, byCpu, byCpu.online and recent are byte-identical'), '');
  }

  /* S. the store: the Tower's own transaction, and everything around it */
  if (grp('S')) {
    const mem = async (name) => { const adapter = ST.createMemoryAdapter({ name: name + '-' + (++counter), durable: true }); const store = await ST.openStore({ adapter, channel: false, deps: deps() }); return { store, adapter }; };
    const seed = async (store, mod) => { const c = await store.createProfile({ trainerName: 'ASH' }); const x = { ...c, ...(mod ? mod(c) : {}) }; return x === c ? c : store.saveProfile(x, { reason: 'seed' }); };
    {
      const { store } = await mem('tu');
      const c = await seed(store, (x) => ({ stats: { ...x.stats, wins: 3 } }));
      const hist0 = (await store.listHistory(c.id)).length, ev = [];
      store.on('external', () => {}); void ev;
      const r = await store.towerUpdate(c.id, (tower) => ({ tower: { ...tower, runs: 1, floors: 4 }, tag: 'x' }));
      const l = await store.loadProfile(c.id);
      ok(r.ok && r.saved && r.saved.rev === c.rev + 1 && r.before.runs === 0 && r.after.runs === 1 && r.result.tag === 'x' && l.profile.tower.runs === 1 && l.profile.tower.floors === 4 && statsOf(l.profile) === statsOf(c) && canon(l.profile.teams) === canon(c.teams) && (await store.listHistory(c.id)).length === hist0, t('S1 the store\'s Tower transaction writes the Tower record, moves the revision once, makes NO history entry (the ring is for the player\'s edits), hands back before / after / the caller\'s result, and leaves the battle record and teams as they were'), J({ rev: r.saved && r.saved.rev, h: (await store.listHistory(c.id)).length }));
      const none = await store.towerUpdate(c.id, () => null), refusedStep = await store.towerUpdate(c.id, () => ({ applied: false, why: 'no' })), same = await store.loadProfile(c.id);
      ok(none.ok && none.saved === null && refusedStep.saved === null && refusedStep.result.why === 'no' && none.after.runs === 1 && same.profile.rev === r.saved.rev, t('S2 a change that returns nothing, or a step that was refused (no new record), writes nothing: the revision does not move'), '');
      let refused = null; try { await store.towerUpdate(c.id, (tower) => ({ tower: { ...tower, runs: -5 } })); } catch (e) { refused = e; }
      const still = await store.loadProfile(c.id);
      ok(refused && refused.code === 'store.invalid' && still.profile.tower.runs === 1 && still.profile.rev === r.saved.rev, t('S3 a record that would not be well formed is refused whole (ValidationError) and the store is as it was'), String(refused && refused.code));
      let nf = null; try { await store.towerUpdate('p_nobody', (x) => ({ tower: x })); } catch (e) { nf = e; }
      ok(nf && nf.code === 'store.not-found', t('S4 a profile that does not exist is NotFound'), String(nf && nf.code));
    }
    {
      const { store } = await mem('conc');
      const c = await seed(store);
      await Promise.all(Array.from({ length: N(25, 6) }, () => store.towerUpdate(c.id, (tower) => ({ tower: { ...tower, runs: tower.runs + 1, floors: tower.floors + 2 } }))));
      const l = await store.loadProfile(c.id);
      ok(l.profile.tower.runs === N(25, 6) && l.profile.tower.floors === N(50, 12) && l.profile.rev === c.rev + N(25, 6), t('S5 ' + N(25, 6) + ' Tower steps sent at the same moment are ALL kept (each is one read-change-write transaction: none is lost to another)'), J(l.profile.tower));
    }
    {
      const { store, adapter } = await mem('ro');
      await adapter.transact(['profiles'], 'readwrite', (tx) => tx.put('profiles', clone(FIX.fut)));
      let e = null; try { await store.towerUpdate(FIX.fut.id, (x) => ({ tower: x })); } catch (x) { e = x; }
      const raw = await adapter.transact(['profiles'], 'readonly', (tx) => tx.get('profiles', FIX.fut.id));
      ok(e && e.code === 'store.read-only' && canon(raw) === canon(FIX.fut), t('S6 a profile of a newer build is read-only to the Tower too: refused, and byte-for-byte as it was'), String(e && e.code));
    }
    {
      const { store, adapter } = await mem('mig');
      await adapter.transact(['profiles'], 'readwrite', (tx) => tx.put('profiles', clone(FIX.v4)));
      const up = await store.towerUpdate(FIX.v4.id, (tower) => ({ tower: { ...tower, runs: 1 } }));
      const l = await store.loadProfile(FIX.v4.id), h = await store.listHistory(FIX.v4.id);
      ok(up.ok && l.profile.schemaVersion === 5 && l.profile.tower.runs === 1 && statsOf(l.profile) === statsOf(FIX.v4) && h.length === 1 && h[0].reason === 'migration', t('S7 a stored v4 profile is upgraded the first time a Tower step touches it (the v4 document goes to history), and the step is then applied; its battle record comes through unchanged'), J(h));
    }
    {
      const { store } = await mem('rest');
      const c = await seed(store, (x) => ({ teams: [], box: [], stats: { ...x.stats, wins: 1 } }));
      await store.towerUpdate(c.id, (tower) => ({ tower: { ...tower, runs: 3, achievements: { 'first-floor': 9 } } }));
      const cur = await store.loadProfile(c.id), edited = { ...cur.profile, trainerName: 'EDIT1' };
      await store.saveProfile(edited, { reason: 'edit' });
      await store.recordMatch(c.id, onlineMatch(1));
      await store.towerUpdate(c.id, (tower) => ({ tower: { ...tower, runs: 4 } }));
      const l1 = await store.loadProfile(c.id), h = await store.listHistory(c.id), editRev = h.find((x) => x.reason === 'edit');
      const back = await store.restoreRevision(c.id, editRev.rev);
      ok(back.tower.runs === 4 && back.stats.byCpu.online.w === 1 && l1.profile.tower.runs === 4 && back.trainerName === 'ASH' && l1.profile.trainerName === 'EDIT1', t('S8 going back to an older revision (a restore) keeps the CURRENT Tower record and the current battle record: neither is taken back with the edit'), J({ t: back.tower.runs, w: back.stats.byCpu.online.w }));
      await store.recordMatch(c.id, onlineMatch(2));
      const l2 = await store.loadProfile(c.id);
      ok(l2.profile.tower.runs === 4 && l2.profile.stats.byCpu.online.w === 2, t('S9 recording a battle after a Tower step keeps the Tower record, and a Tower step after a battle keeps the record: the two writers do not overwrite each other'), '');
    }
    {
      const { store } = await mem('inter');
      const c = await seed(store);
      const ref = P.openProfileDocument(clone(c), {}).profile; let expected = ref;
      const order = [];
      for (let i = 0; i < N(12, 4); i++) order.push(i % 3 === 0 ? 'm' : 't');
      for (const k of order) {
        if (k === 'm') { const mt = onlineMatch(1 + order.indexOf(k) + Math.random() * 0 + (expected.stats.recent.length)); const r = await store.recordMatch(c.id, mt); void r; expected = P.recordMatch(expected, mt).profile; }
        else { const r = await store.towerUpdate(c.id, (tower) => ({ tower: { ...tower, runs: tower.runs + 1 } })); void r; expected = { ...expected, tower: { ...expected.tower, runs: expected.tower.runs + 1 } }; }
      }
      const l = await store.loadProfile(c.id);
      ok(canon(l.profile.stats) === canon(expected.stats) && canon(l.profile.tower) === canon(expected.tower), t('S10 any interleaving of battles and Tower steps ends with the battle record the battles alone give and the Tower record the Tower steps alone give'), '');
    }
  }

  /* T. the Tower session over a real store: a whole climb, and the hub's reader */
  if (grp('T')) {
    const pack = opt.pack, teamsOf = (n) => S.matchctl ? null : null; void teamsOf;
    const adapter = ST.createMemoryAdapter({ name: 'tw-' + (++counter), durable: true }), store = await ST.openStore({ adapter, channel: false, deps: deps() });
    const c = await store.createProfile({ trainerName: 'ASH' });
    const before = await store.loadProfile(c.id);
    const persist = SS.storePersist(store, c.id);
    let clock = 1000; const sess = SS.createTowerSession({ pack, persist, now: () => (clock += 7) });
    const s0 = await sess.startRun({ seed: 321, format: '3v3', team: null });
    let steps = 0, tw = await persist.read();
    for (let g = 0; g < 80 && tw.current; g++) {
      const cur = tw.current;
      if (cur.phase === 'offer') await sess.pick({ seed: 321, id: cur.offer[0].id });
      else await sess.finishFloor({ floor: cur.floor, seed: 321, result: { floor: cur.floor, result: cur.floor < 9 ? 'w' : 'l', turns: 6, faints: cur.floor % 2 } });
      tw = await persist.read(); steps++;
    }
    const after = await store.loadProfile(c.id), h = await store.listHistory(c.id), viaPersist = await persist.update(() => null);
    ok(viaPersist.tower && viaPersist.tower.runs === 1 && s0.applied && tw.current === null && after.profile.tower.runs === 1 && after.profile.tower.best['3v3'] === 8 && after.profile.tower.last.cleared === 8 && statsOf(after.profile) === statsOf(before.profile) && canon(after.profile.teams) === canon(before.profile.teams) && canon(after.profile.box) === canon(before.profile.box) && after.profile.rev > before.profile.rev && h.length === 0 && canon(after.profile.stats.totals) === canon(before.profile.stats.totals) && P.checkProfile(after.profile).length === 0, t('T1 a whole Tower climb ' + steps + ' steps long, written step by step into a real profile through the store, leaves the battle record (totals, byCpu, online, recent), the teams and the box byte-identical, makes no history entries, and ends well formed with the run folded in'), J({ runs: after.profile.tower.runs, best: after.profile.tower.best, h: h.length }));
    const data = await HD.readHubData(store, pack, { towerSummary: SS.summarizeTower }), noData = await HD.readHubData(store, pack, {});
    ok(data.profiles[0].tower && data.profiles[0].tower.last && data.profiles[0].tower.last.cleared === 8 && data.profiles[0].tower.achievements.length === 51 && noData.profiles[0].tower === null, t('T2 the hub\'s reader gives each profile its Tower summary when it is given the summariser, and null when it is not (the hub then waits for the Tower\'s code)'), J(data.profiles[0].tower && Object.keys(data.profiles[0].tower)));
    const bad = await HD.readHubData(store, pack, { towerSummary: () => { throw new Error('boom'); } });
    ok(bad.state === 'ready' && bad.profiles.length === 1 && bad.profiles[0].tower === null, t('T3 a summariser that throws costs the hub that profile\'s Tower summary, never the profile list'), bad.state);
    // a saved team through the real profile: a snapshot, independent of later edits
    const p0 = await store.loadProfile(c.id), prof = { ...p0.profile };
    const mon = (name) => { const sid = pack.species.findIndex((s) => s && s.legal && s.name === name); const rec = opt.rules.blankRec(sid, pack, 'arena-gen3-standard'), ratio = pack.species[sid].genderRatio; return P.createMon({ species: sid, level: rec.level, nature: rec.nature, abilitySlot: rec.abilitySlot, heldItem: rec.item, moves: rec.moves, ev: rec.evs, iv: rec.ivs, gender: ratio === 255 ? '-' : ratio === 254 ? 'F' : 'M' }, deps()); };
    const mons = ['Pikachu', 'Charizard', 'Snorlax'].map(mon); prof.box = mons; prof.teams = [P.createTeam({ name: 'SQUAD', monIds: mons.map((m) => m.id) }, deps())];
    const snap = SS.teamSnapshot(prof, prof.teams[0].id), snapJ = J(snap);
    prof.box[0].ev.hp = 7; prof.teams[0].name = 'RENAMED';
    const st = SS.reduceStart(clone(P.openProfileDocument(clone(FIX.cur), {}).profile.tower), { pack, seed: 5, format: '3v3', team: snap, now: 1 });
    ok(snap.name === 'SQUAD' && snap.recs.length === 3 && snap.recs[0].species === mons[0].species && snap.recs[0].moves.every((m) => typeof m.id === 'number') && J(snap) === snapJ && st.applied && st.tower.current.team.recs.length === 3, t('T4 a saved team becomes a Tower team as a snapshot in the engine\'s own record form, a legal run can start with it, and editing the saved team later does not reach the snapshot'), J(st.why || ''));
    let tnf = null; try { SS.teamSnapshot(prof, 'nope'); } catch (e) { tnf = e; }
    ok(tnf instanceof RangeError, t('T5 a team that is not there is a RangeError'), String(tnf));
  }
}

/* ------------------------------------------------------------------------------------------------ mutants */
const MUTANTS = [
  { id: 'migrate-drops-tower', why: 'the v4 -> v5 migration forgets to add the Tower record', file: 'profile.js', from: '  } else o.tower = emptyTower();\n  return o;', to: '  }\n  return o;', groups: ['P'] },
  { id: 'migrate-overwrites-tower', why: 'a v4 document that already has a good Tower record loses it', file: 'profile.js', from: "if (checkTowerShape(o.tower).length) { bagSet(o, 'v4Tower', o.tower); o.tower = emptyTower(); }", to: "{ bagSet(o, 'v4Tower', o.tower); o.tower = emptyTower(); }", groups: ['P'] },
  { id: 'migrate-loses-junk', why: 'a junk `tower` of a v4 document is thrown away instead of kept', file: 'profile.js', from: "bagSet(o, 'v4Tower', o.tower); o.tower = emptyTower(); }\n  } else", to: "o.tower = emptyTower(); }\n  } else", groups: ['P'] },
  { id: 'migrate-says-v4', why: 'the migration forgets to say schema 5', file: 'profile.js', from: 'o.schemaVersion = 5;\n  if (hasOwn.call(o, \'tower\')) {', to: 'o.schemaVersion = 4;\n  if (hasOwn.call(o, \'tower\')) {', groups: ['P'] },
  { id: 'migrate-writes-input', why: 'the migration writes into its input', file: 'profile.js', from: 'function migrate4to5(d) {\n  const o = clone(d);', to: 'function migrate4to5(d) {\n  const o = d;', groups: ['P'] },
  { id: 'normalize-resets-tower', why: 'opening a profile throws its Tower record away', file: 'profile.js', from: '    out.tower = tw.value;\n', to: '    out.tower = emptyTower();\n', groups: ['P'] },
  { id: 'normalize-loses-rejected', why: 'a damaged Tower value is not kept in the bag', file: 'profile.js', from: "if (Object.keys(tw.rejected).length) out.tower._unknown = mergeBag(isObj(out.tower._unknown) ? out.tower._unknown : null, { towerRejected: tw.rejected });", to: '', groups: ['P'] },
  { id: 'check-ignores-tower', why: 'a profile with a bad Tower record is well formed', file: 'profile.js', from: "for (const why of checkTowerShape(p.tower).slice(0, 3)) add('profile.tower', 'tower', 'tower: ' + why);", to: '', groups: ['P'] },
  { id: 'create-without-tower', why: 'a new profile has no Tower record', file: 'profile.js', from: 'identity: emptyIdentity(), tower: emptyTower(),\n  };', to: 'identity: emptyIdentity(),\n  };', groups: ['P'] },
  { id: 'merge-overwrites-tower', why: 'a merge replaces the active profile\'s Tower record with the file\'s', file: 'profile.js', from: "  report.record = 'kept-local';", to: "  p.tower = clone(incoming.tower);\n  report.record = 'kept-local';", groups: ['X'] },
  { id: 'replace-keeps-local-tower', why: 'a replace keeps the old Tower record', file: 'profile.js', from: "    report.record = 'replaced';\n    report.tower = 'replaced';", to: "    p.tower = clone(existing.tower);\n    report.record = 'replaced';\n    report.tower = 'replaced';", groups: ['X'] },
  { id: 'new-drops-tower', why: 'a new profile from a file does not carry the file\'s Tower record', file: 'profile.js', from: "    p.id = newId('p', d);\n    p.rev = 0;", to: "    p.tower = emptyTower();\n    p.id = newId('p', d);\n    p.rev = 0;", groups: ['X'] },
  { id: 'keep-my-edits-drops-tower', why: '"Keep my edits here" erases the stored Tower record', file: 'profile.js', from: "tower: stored.tower === undefined ? clone(mine.tower) : clone(stored.tower) };", to: "tower: clone(mine.tower) };", groups: ['X'] },
  { id: 'record-match-clears-tower', why: 'recording a battle empties the Tower record', file: 'profile.js', from: '  const next = clone(profile);\n  next.stats = f.stats;\n  const bad = checkProfile(next);', to: '  const next = clone(profile);\n  next.stats = f.stats;\n  next.tower = emptyTower();\n  const bad = checkProfile(next);', groups: ['B'] },
  { id: 'reset-record-clears-tower', why: 'RESET RECORD empties the Tower record too', file: 'profile.js', from: '  next.stats = emptyStats();\n  if (keepBag)', to: '  next.stats = emptyStats();\n  next.tower = emptyTower();\n  if (keepBag)', groups: ['B'] },
  { id: 'tower-update-touches-stats', why: 'a Tower step writes the battle record too', file: 'store.js', from: "      next.tower = r.tower;\n      const bad = checkProfile(next);", to: "      next.tower = r.tower;\n      next.stats = { ...next.stats, wins: next.stats.wins + 1 };\n      const bad = checkProfile(next);", groups: ['S', 'T'] },
  { id: 'tower-update-makes-history', why: 'every Tower step pushes a revision of the player\'s edits out of the history ring', file: 'store.js', from: "reason: 'tower', backup: null, allowCorrupt: true, history: false });", to: "reason: 'tower', backup: null, allowCorrupt: true, history: true });", groups: ['S', 'T'] },
  { id: 'tower-update-not-atomic', why: 'a Tower step reads the profile outside the write transaction (two at once lose one)', file: 'store.js', from: "      const stored = await tx.get('profiles', id);\n      if (stored === undefined) throw new NotFoundError(`no profile ${id}`, { id });\n      const doc = openProfileDocument(stored, { deps: this.deps });", to: "      const stored = this.__stale || (this.__stale = await tx.get('profiles', id));\n      if (stored === undefined) throw new NotFoundError(`no profile ${id}`, { id });\n      const doc = openProfileDocument(stored, { deps: this.deps });", groups: ['S'] },
  { id: 'tower-update-skips-validation', why: 'a malformed Tower record is written', file: 'store.js', from: "if (bad.length) throw new ValidationError('the Tower record would not be well formed: '", to: "if (false) throw new ValidationError('the Tower record would not be well formed: '", groups: ['S'] },
  { id: 'tower-update-writes-newer', why: 'a Tower step overwrites a profile of a newer build', file: 'store.js', from: "if (doc.readOnly) throw new ReadOnlyError(`profile ${id} was saved by a newer build and is read-only here`, { id, schemaVersion: doc.profile.schemaVersion });", to: '', groups: ['S'] },
  { id: 'tower-update-always-writes', why: 'a change that returns nothing still moves the revision', file: 'store.js', from: "if (!r || !r.tower) return { saved: null, before, after: before, result: r || null };", to: "if (!r) return { saved: null, before, after: before, result: null };\n      if (!r.tower) r.tower = before;", groups: ['S'] },
  { id: 'restore-takes-tower-back', why: 'restoring an old revision of the teams takes the Tower record back with it', file: 'store.js', from: 'if (now && now.ok && !now.readOnly) restored.tower = now.profile.tower;', to: '', groups: ['S'] },
  { id: 'session-persist-aliases', why: 'the store persist hands the session a record it can write into', file: 'tower_session.js', from: "async update(fn) { const r = await store.towerUpdate(profileId, (tower) => fn(tower)); return { result: r.result, tower: r.after }; },", to: "async update(fn) { const r = await store.towerUpdate(profileId, (tower) => fn(tower)); return { result: r.result, tower: null }; },", groups: ['T'] },
  { id: 'snapshot-shares', why: 'a Tower team is not a snapshot of the saved team', file: 'tower_session.js', from: 'return { name: String(t.name).slice(0, 24), recs: r.recs, meta: r.meta };', to: 'return { name: String(t.name).slice(0, 24), recs: t.mons, meta: r.meta };', groups: ['T'] },
  { id: 'hub-reader-no-summary', why: 'the hub reader gives profiles no Tower summary', file: 'hub_data.js', from: 'try { tower = opts.towerSummary(p.tower, pack); } catch (_e) { tower = null; }', to: 'tower = null;', groups: ['T'] },
  { id: 'hub-reader-lets-it-throw', why: 'a throwing summariser takes the whole profile list down', file: 'hub_data.js', from: 'try { tower = opts.towerSummary(p.tower, pack); } catch (_e) { tower = null; }', to: 'tower = opts.towerSummary(p.tower, pack);', groups: ['T'] },
];

async function runMutants() {
  const out = [];
  for (const mu of MUTANTS) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-tpmut-'));
    try {
      for (const f of fs.readdirSync(SRC)) { const p = path.join(SRC, f); if (fs.statSync(p).isFile()) fs.copyFileSync(p, path.join(dir, f)); }
      const target = path.join(dir, mu.file), text = fs.readFileSync(target, 'utf8'), n = text.split(mu.from).length - 1;
      if (n !== 1) { out.push({ id: mu.id, killed: false, why: 'THE MUTANT DID NOT APPLY (pattern found ' + n + 'x)' }); continue; }
      fs.writeFileSync(target, text.replace(mu.from, () => mu.to));
      const before = { pass, fail, nf: failures.length }, saveQ = process.env.ARENA_QUIET; process.env.ARENA_QUIET = '1';
      let threw = null;
      try { const S2 = await loadStack(dir, mu.id); S2.matchctl = S0.matchctl; await suite(S2, mu.id, { groups: mu.groups, fast: true, dir, pack: PACK, rules: RULES }); } catch (e) { threw = e; }
      const failed = fail - before.fail, killedBy = failures.slice(before.nf).map((f) => f.replace(/^\[[^\]]*\]\s*/, '').split(' ')[0]);
      pass = before.pass; fail = before.fail; failures.length = before.nf; process.env.ARENA_QUIET = saveQ || '';
      out.push({ id: mu.id, killed: failed > 0 || !!threw, why: mu.why, killedBy, threw: threw ? String(threw.message || threw).slice(0, 100) : null });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  return out;
}

/* ------------------------------------------------------------------------------------------------ main */
const S0 = await loadStack(SRC);
const tables = await imp(SRC, 'tables.js'), RULES = await imp(SRC, 'rules.js');
S0.matchctl = await imp(SRC, 'matchctl.js');
const PACK = tables.loadPack(fs.readFileSync(ROM_PATH), { verify: 'header', dexText: false });
const t0 = Date.now();
await suite(S0, '', { groups: ONLY.length ? ONLY : null, pack: PACK, rules: RULES, dir: SRC });
console.log(`tower profile: ${pass} passed, ${fail} failed (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
let survived = 0;
if (WANT_MUTANTS) {
  const keepFail = fail, keepFailures = failures.slice(), tm = Date.now();
  const res = await runMutants();
  fail = keepFail; failures.length = 0; failures.push(...keepFailures);
  for (const m of res) { console.log((m.killed ? 'killed  ' : 'SURVIVED') + ' ' + m.id + ' -- ' + m.why + (m.killed ? '  [' + [...new Set(m.killedBy || [])].slice(0, 4).join(' ') + (m.threw ? ' threw: ' + m.threw : '') + ']' : '  <-- the suite did not notice')); if (!m.killed) survived++; }
  console.log(`mutants: ${res.length - survived}/${res.length} killed (${((Date.now() - tm) / 1000).toFixed(1)} s)`);
}
void sleepTick;
if (fail || survived) { console.log('\nFAILURES:\n  ' + failures.join('\n  ')); process.exit(1); }

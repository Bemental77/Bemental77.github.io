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
      if (cur.phase === 'offer') await sess.pick({ seed: 321, id: cur.offer[0].id, floor: cur.floor, offer: SS.offerKey(cur) });
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

  /* D. a hostile or hand-edited Tower record can never lock the Tower, and cannot fill the store (real import, real store, real session) */
  if (grp('D')) {
    const pack = opt.pack, LIM = R.TOWER_LIMITS;
    const mem = async (name) => { const adapter = ST.createMemoryAdapter({ name: name + '-' + (++counter), durable: true }); const store = await ST.openStore({ adapter, channel: false, deps: deps() }); return { store, adapter }; };
    const withTower = (mod) => { const d = clone(FIX.tower); d.tower.current = null; mod(d.tower); return d; };
    const kinds = {
      '400 junk buff ids': (x) => { for (let i = 0; i < 400; i++) x.buffsSeen['zz-' + i] = 1; },
      '500 junk achievements': (x) => { for (let i = 0; i < 500; i++) x.achievements['zz-' + i] = 1; },
      'runs at a billion': (x) => { x.runs = 1e9; },
      'wins at a billion in both formats': (x) => { x.winsByFormat = { '3v3': 1e9, '6v6': 1e9 }; x.wins = 2e9; x.runs = 1e9; },
    };
    // the real route: the file the checksum covers -> parseExport -> the store -> a climb through the real transaction (store.towerUpdate: compare-and-set, validated)
    for (const [name, mod] of Object.entries(kinds)) {
      let why = '';
      try {
        const d = withTower(mod), bytes = (await P.exportBytes({ ...clone(d), tower: d.tower }, { gzip: false, deps: { now: () => NOW } })).bytes, parsed = await P.parseExport(bytes, {});
        if (!parsed.ok) why = 'the file was refused: ' + parsed.code;
        else {
          const t = parsed.profile.tower;
          if (Object.keys(t.buffsSeen).length > LIM.buffsKeep || Object.keys(t.achievements).length > LIM.achievementsKeep || t.runs > LIM.counterKeep || R.checkTowerShape(t).length) why = 'the imported record is not inside the repair limits';
          else if (!t.last || !Object.keys(t.achievements).length || !t._unknown) why = 'the rest of the climb (the last run, the achievements, the unknown fields) was thrown away with the bad field';
          const { store, adapter } = await mem('hostile');
          const id = (await store.createProfile({ trainerName: 'ASH' })).id;
          await adapter.transact(['profiles'], 'readwrite', (tx) => tx.put('profiles', { ...parsed.profile, id, rev: 1 }));
          const persist = SS.storePersist(store, id), sess = SS.createTowerSession({ pack, persist, now: () => 5000 });
          const s0 = await sess.startRun({ seed: 321, format: '3v3', team: null });
          let tw = await persist.read(); const steps = [];
          for (let g = 0; g < 40 && tw.current; g++) {
            const cur = tw.current;
            const r = cur.phase === 'offer' ? await sess.pick({ seed: 321, id: cur.offer[0].id, floor: cur.floor, offer: SS.offerKey(cur) }) : await sess.finishFloor({ floor: cur.floor, seed: 321, result: { floor: cur.floor, result: cur.floor < 5 ? 'w' : 'l', turns: 6, faints: 1 } });
            steps.push(r && r.applied); tw = await persist.read();
          }
          const s1 = await sess.startRun({ seed: 322, format: '6v6', team: null }), gu = await sess.giveUp({ seed: 322 }), st2 = await sess.startRun({ seed: 323, format: '3v3', team: null }), rp = await sess.startRun({ seed: 324, format: '3v3', team: null, replace: true });
          const l = await store.loadProfile(id);
          if (!s0.applied || !steps.length || !steps.every(Boolean) || tw.current !== null || tw.runs < 1) why = why || 'the climb did not record: ' + J({ s0: s0.applied, steps, cur: !!tw.current, runs: tw.runs });
          else if (!s1.applied || !gu.applied || !st2.applied || !rp.applied || !l.ok || l.profile.tower.current.seed !== 324) why = why || 'give up / start over failed: ' + J([s1.applied, gu.applied, st2.applied, rp.applied]);
        }
      } catch (e) { why = 'threw ' + e.message; }
      ok(!why, t('D1 a file with ' + name + ' imports, and the Tower still works on the profile it made: start, win, take a ball, lose, start again, give up, start over (nothing throws a ValidationError)'), why);
    }
    // a bag of unknown values does not grow without bound, however it is filled; the climb is kept
    {
      const d = withTower((x) => { for (let i = 0; i < 20000; i++) x.buffsSeen['zz-' + i] = 1; x._unknown = { futureTowerThing: { keep: 'me' }, huge: 'x'.repeat(2e6) }; });
      const t0 = Date.now(), o = open(d), ms = Date.now() - t0, again = open(o.profile);
      const bag = o.profile.tower._unknown || {}, size = JSON.stringify(bag).length;
      ok(o.ok && size <= LIM.bagMax && !('huge' in bag) && P.checkProfile(o.profile).length === 0 && !again.changed && !again.problems.length && canon(again.profile) === canon(o.profile) && canon(o.profile.stats) === canon(FIX.tower.stats) && o.profile.tower.last && ms < 2000, t('D2 20000 junk ids and a 2 MB value in the Tower record: the profile opens (in ' + ms + ' ms), the record\'s bag is held to ' + LIM.bagMax + ' characters (' + size + '), opening it again changes nothing, and the battle record is untouched'), J({ ok: o.ok, size, bad: P.checkProfile(o.profile).length, changed: again.changed }));
    }
    {
      const d = withTower((x) => { x._unknown = { huge: 'x'.repeat(2e6), futureTowerThing: { keep: 'me' } }; });
      const o = open(d), bag = o.profile.tower._unknown || {};
      ok(o.ok && JSON.stringify(bag).length <= LIM.bagMax && 'futureTowerThing' in bag && !('huge' in bag) && !open(o.profile).changed, t('D2b a 2 MB value in the Tower record\'s own bag (nothing else wrong with it) is dropped on opening and the small unknown field next to it is kept'), J(Object.keys(bag)));
    }
    // the reject (what the repair could not keep) is cut down ON ITS OWN before it joins the bag: a huge one must not push the record's own older unknown values out of it
    {
      const d = withTower((x) => { for (let i = 0; i < 20000; i++) x.buffsSeen['zz-' + i] = 1; x._unknown = { futureThing: { keep: 'me' }, n: 5 }; });
      const o = open(d), bag = o.profile.tower._unknown || {}, rej = bag.towerRejected || {}, again = open(o.profile);
      ok(o.ok && J(bag.futureThing) === J({ keep: 'me' }) && bag.n === 5 && JSON.stringify(bag).length <= LIM.bagMax && Array.isArray(rej._dropped) && rej._dropped.includes('buffsSeen') && !('buffsSeen' in rej) && Object.keys(o.profile.tower.buffsSeen).length === LIM.buffsKeep && P.checkProfile(o.profile).length === 0 && !again.changed && canon(again.profile) === canon(o.profile), t('D2c 20000 junk buff ids beside a legitimate unknown value (futureThing): the huge reject is cut down alone (the field it held is named in _dropped), the record\'s own unknown values stay, the bag fits, and opening the result again changes nothing'), J({ ok: o.ok, keys: Object.keys(bag), dropped: rej._dropped, size: JSON.stringify(bag).length }));
    }
    {
      const junk = (x) => { for (let i = 0; i < 1000; i++) x.buffsSeen['zz-' + i] = 1; };
      const alone = open(withTower(junk)), beside = open(withTower((x) => { junk(x); x._unknown = { futureThing: 'f'.repeat(60000) }; }));
      const a = (alone.profile.tower._unknown || {}).towerRejected || {}, b = beside.profile.tower._unknown || {}, bj = b.towerRejected || {};
      ok(alone.ok && a.buffsSeen && Object.keys(a.buffsSeen).length === 1000 + Object.keys(FIX.tower.tower.buffsSeen).length - LIM.buffsKeep && !('_dropped' in a) && beside.ok && b.futureThing === 'f'.repeat(60000) && !('buffsSeen' in bj) && Array.isArray(bj._dropped) && bj._dropped.includes('buffsSeen') && JSON.stringify(b).length <= LIM.bagMax && P.checkProfile(beside.profile).length === 0, t('D2d a reject that fits by itself (about 750 ids kept whole) but not beside 60 KB the record already holds is the one that gives way: the record\'s own value is kept whole, the reject is named in _dropped'), J({ alone: Object.keys(a), beside: Object.keys(b), dropped: bj._dropped }));
    }
    // a stored run that passes the shallow check and not the deep parser: it is shown as broken, and DROP THIS RUN / NEW RUN work through the real store
    {
      const deep = { 'an empty history row': (c) => { c.history = [{}]; }, 'a buff that does not exist': (c) => { c.held = [{ id: 'no-such-buff', p: 1 }]; } };
      for (const [name, mod] of Object.entries(deep)) {
        let why = '';
        try {
          const { store, adapter } = await mem('deep'), id = (await store.createProfile({ trainerName: 'ASH' })).id, persist = SS.storePersist(store, id), sess = SS.createTowerSession({ pack, persist, now: () => 5000 });
          await sess.startRun({ seed: 51, format: '3v3', team: null });
          const doc = (await store.loadProfile(id)).profile; mod(doc.tower.current);
          await adapter.transact(['profiles'], 'readwrite', (tx) => tx.put('profiles', { ...doc, id, rev: doc.rev + 1 }));
          const sum = SS.summarizeTower((await store.loadProfile(id)).profile.tower, pack);
          if (!sum.run || sum.run.broken !== true) why = 'the run is not shown as broken: ' + J(sum.run).slice(0, 60);
          const g = await sess.giveUp({ seed: 51 });
          if (!why && !(g.applied && (await persist.read()).current === null && (await persist.read()).runs === 0)) why = 'DROP THIS RUN did not drop it: ' + J(g).slice(0, 80);
          // a second broken run, then NEW RUN over it
          await sess.startRun({ seed: 52, format: '3v3', team: null });
          const doc2 = (await store.loadProfile(id)).profile; mod(doc2.tower.current);
          await adapter.transact(['profiles'], 'readwrite', (tx) => tx.put('profiles', { ...doc2, id, rev: doc2.rev + 1 }));
          const r = await sess.startRun({ seed: 53, format: '3v3', team: null, replace: true });
          if (!why && !(r.applied && (await persist.read()).current.seed === 53 && (await persist.read()).runs === 0)) why = 'NEW RUN did not start over it: ' + J(r).slice(0, 80);
        } catch (e) { why = 'threw ' + e.message; }
        ok(!why, t('D3 a stored run with ' + name + ' is shown as broken, DROP THIS RUN removes it and NEW RUN starts over it, through the real store (it used to throw a TypeError and lock the Tower)'), why);
      }
    }
    {
      const { store, adapter } = await mem('nullrow'), id = (await store.createProfile({ trainerName: 'ASH' })).id, persist = SS.storePersist(store, id), sess = SS.createTowerSession({ pack, persist, now: () => 5000 });
      await sess.startRun({ seed: 61, format: '3v3', team: null });
      const doc = (await store.loadProfile(id)).profile; doc.tower.current.history = [null]; doc.tower.current.held = [null];
      await adapter.transact(['profiles'], 'readwrite', (tx) => tx.put('profiles', { ...doc, id, rev: doc.rev + 1 }));
      const l = await store.loadProfile(id), r = await sess.startRun({ seed: 62, format: '3v3', team: null });
      ok(l.ok && l.profile.tower.current === null && J(l.profile.tower._unknown && l.profile.tower._unknown.towerRejected && l.profile.tower._unknown.towerRejected.current && l.profile.tower._unknown.towerRejected.current.history) === '[null]' && r.applied && (await persist.read()).current.seed === 62, t('D3b a stored run with null rows is not kept as a run at all (it is handed back in the record\'s bag), so the Tower is free: a new run starts at once without anything to drop'), J(l.profile.tower.current).slice(0, 60));
    }
    // the v4 -> v5 migration never loses a value: the junk `tower` takes a FREE name in the unknown bag
    {
      const has = (o, v) => JSON.stringify(o).includes(v);
      const a = clone(FIX.v4); a.tower = 'junk-tower'; a._unknown = { ...(a._unknown || {}), v4Tower: 'player-value-1' };
      const oa = open(a);
      ok(oa.ok && has(oa.profile, 'player-value-1') && has(oa.profile, 'junk-tower') && oa.profile._unknown.v4Tower === 'player-value-1' && oa.profile._unknown.v4Tower_2 === 'junk-tower' && J(oa.profile.tower) === J(EMPTY()) && P.checkProfile(oa.profile).length === 0, t('D4 a v4 file with a junk `tower` AND its own unknown value named v4Tower keeps BOTH (the junk goes under v4Tower_2)'), J(oa.profile && oa.profile._unknown).slice(0, 160));
      const b = clone(FIX.v4); b.tower = 12345; b.v4Tower = 'player-value-2';
      const ob = open(b);
      ok(ob.ok && has(ob.profile, 'player-value-2') && has(ob.profile, '12345') && P.checkProfile(ob.profile).length === 0 && !open(ob.profile).changed, t('D5 a v4 file with a junk `tower` AND a stray top-level key named v4Tower keeps both values, and opening the result again changes nothing'), J(ob.profile && ob.profile._unknown).slice(0, 160));
      const c = clone(FIX.v4); c.tower = 'junk-tower'; c._unknown = { ...(c._unknown || {}), v4Tower: 'one', v4Tower_2: 'two' };
      const oc = open(c);
      ok(oc.ok && has(oc.profile, 'one') && has(oc.profile, 'two') && has(oc.profile, 'junk-tower') && oc.profile._unknown.v4Tower_3 === 'junk-tower', t('D6 ... and the next free name is taken when v4Tower_2 is taken too'), J(oc.profile && oc.profile._unknown).slice(0, 160));
    }
  }
}

/* ------------------------------------------------------------------------------------------------ mutants */
const MUTANTS = [
  { id: 'migrate-drops-tower', why: 'the v4 -> v5 migration forgets to add the Tower record', file: 'profile.js', from: '  } else o.tower = emptyTower();\n  return o;', to: '  }\n  return o;', groups: ['P'] },
  { id: 'migrate-overwrites-tower', why: 'a v4 document that already has a good Tower record loses it', file: 'profile.js', from: 'if (checkTowerShape(o.tower).length) {\n', to: '{\n', groups: ['P'] },
  { id: 'migrate-loses-junk', why: 'a junk `tower` of a v4 document is thrown away instead of kept', file: 'profile.js', from: 'bagSet(o, key, o.tower); o.tower = emptyTower();', to: 'o.tower = emptyTower();', groups: ['P'] },
  { id: 'migrate-says-v4', why: 'the migration forgets to say schema 5', file: 'profile.js', from: 'o.schemaVersion = 5;\n  if (hasOwn.call(o, \'tower\')) {', to: 'o.schemaVersion = 4;\n  if (hasOwn.call(o, \'tower\')) {', groups: ['P'] },
  { id: 'migrate-writes-input', why: 'the migration writes into its input', file: 'profile.js', from: 'function migrate4to5(d) {\n  const o = clone(d);', to: 'function migrate4to5(d) {\n  const o = d;', groups: ['P'] },
  { id: 'migrate-key-ignores-the-bag', why: 'the junk `tower` is filed under a name the player\'s own unknown value already holds (and overwrites it)', file: 'profile.js', from: '(isObj(o._unknown) && hasOwn.call(o._unknown, key)) || hasOwn.call(o, key)', to: 'hasOwn.call(o, key)', groups: ['D'] },
  { id: 'migrate-key-ignores-a-root-key', why: 'the junk `tower` is filed under a name a stray top-level key of the file already holds (and that key\'s value is lost)', file: 'profile.js', from: '(isObj(o._unknown) && hasOwn.call(o._unknown, key)) || hasOwn.call(o, key)', to: '(isObj(o._unknown) && hasOwn.call(o._unknown, key))', groups: ['D'] },
  { id: 'migrate-key-takes-the-second-name-always', why: 'every junk `tower` goes under v4Tower_2', file: 'profile.js', from: "let key = 'v4Tower';", to: "let key = 'v4Tower_2';", groups: ['P', 'D'] },
  { id: 'rejected-bag-uncapped', why: 'what the repair hands back is parked in the bag whatever its size', file: 'profile.js', from: 'const bag = capBag(mergeBag(prior, rej ? { towerRejected: rej } : null));', to: 'const bag = mergeBag(prior, rej ? { towerRejected: tw.rejected } : null);', groups: ['D'] },
  { id: 'rejected-merged-whole', why: 'the reject joins the bag whole, so a huge one pushes the record\'s own older unknown values out before it goes itself', file: 'profile.js', from: 'rej = fitRejected(tw.rejected, prior)', to: 'rej = tw.rejected', groups: ['D'] },
  { id: 'reject-ignores-the-bag-it-joins', why: 'the reject is fitted to the whole allowance, not to the room the bag has left', file: 'tower_record.js', from: "const fits = (o) => held + bagCost('towerRejected', o) <= max;", to: "const fits = (o) => bagCost('towerRejected', o) <= max;", groups: ['D'] },
  { id: 'reject-drops-silently', why: 'the fields of a reject that are left out are named nowhere', file: 'tower_record.js', from: "setOwn(out, '_dropped', dropped.slice(0, 16).map((k) => String(k).slice(0, 24)));", to: '', groups: ['D'] },
  { id: 'tower-repair-bag-uncapped', why: 'the Tower record\'s own unknown bag has no size limit', file: 'tower_record.js', from: 'if (b2) b2 = capBag(b2);', to: '', groups: ['D'] },
  { id: 'repair-keeps-buffs-to-the-check-limit', why: 'the repair keeps as many buff ids as the check allows (the next real one locks the Tower)', file: 'tower_record.js', from: 'kept < TOWER_LIMITS.buffsKeep', to: 'kept < TOWER_LIMITS.buffsMax', groups: ['D'] },
  { id: 'repair-keeps-achievements-to-the-check-limit', why: 'the repair keeps as many achievements as the check allows', file: 'tower_record.js', from: 'kept < TOWER_LIMITS.achievementsKeep', to: 'kept < TOWER_LIMITS.achievementsMax', groups: ['D'] },
  { id: 'repair-keeps-counters-to-the-check-limit', why: 'the repair keeps a counter at the check\'s limit', file: 'tower_record.js', from: 'if (isInt(src[k], 0, TOWER_LIMITS.counterKeep)) out[k] = src[k];', to: 'if (isInt(src[k], 0, TOWER_LIMITS.counterMax)) out[k] = src[k];', groups: ['D'] },
  { id: 'repair-lets-wins-add-up-past-the-limit', why: 'the wins of the two formats may add up past the limit (the repair then empties the whole record)', file: 'tower_record.js', from: "perFormat('winsByFormat', Math.floor(TOWER_LIMITS.counterKeep / cfg.formats.length));", to: "perFormat('winsByFormat', TOWER_LIMITS.counterMax);", groups: ['D'] },
  { id: 'shape-allows-null-history-rows', why: 'a stored run with null rows in its history passes the shallow check', file: 'tower_record.js', from: 'if (!r.team.recs.every(isObj) || !r.held.every(isObj) || !r.history.every(isObj)) return false;', to: '', groups: ['D'] },
  { id: 'drop-folds-an-unreadable-run', why: 'DROP THIS RUN folds a run that cannot be read (a TypeError inside the store transaction)', file: 'tower_session.js', from: 'if (!countable(cur, cfg)) return dropped(tower, cur);', to: 'if (false) return dropped(tower, cur);', groups: ['D'] },
  { id: 'new-run-folds-an-unreadable-run', why: 'NEW RUN over a run that cannot be read folds it', file: 'tower_session.js', from: 't = countable(tower.current, cfg) ? conclude(', to: 't = true ? conclude(', groups: ['D'] },
  { id: 'normalize-resets-tower', why: 'opening a profile throws its Tower record away', file: 'profile.js', from: '    out.tower = tw.value;\n', to: '    out.tower = emptyTower();\n', groups: ['P'] },
  { id: 'normalize-loses-rejected', why: 'a damaged Tower value is not kept in the bag', file: 'profile.js', from: 'const bag = capBag(mergeBag(prior, rej ? { towerRejected: rej } : null));', to: 'const bag = capBag(mergeBag(prior, null));', groups: ['P'] },
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

#!/usr/bin/env node
// tools/pokemonarena_trainer_card_test.mjs -- PROFILE SCHEMA 6 (the trainer card) and the trainer app's save API, in Node, fast (no ROM, no browser).
//
//   C  THE CARD        trainer_card.js: every key, every bad value of each, the strict check, the repair, the patch, cardOf on null / an old document / junk.
//   M  THE MIGRATION   profile.js 5 -> 6: pure (never writes its input), a fixed point, real v5 fixtures migrate and validate with every other value kept, a junk `card`
//                      of a v5 document is kept in the unknown bag, the strict check and the repair know `card` (code profile.card), unknown card keys survive
//                      normalise -> export -> import, new / replace / merge carry the card as they carry the name and the portrait, createProfile(init.card),
//                      and an OLDER build (one whose current version is 5) opens a v6 document read-only.
//   E  THE EDITOR      editor_state.js { type: 'card', patch }: validated by checkCardPatch, undo / redo restore the card, a no-op is no edit, card._unknown is kept.
//   H  THE HUB DATA    hub_data.js readHubData: each profile summary carries avatar { kind, id } and card.
//   S  THE SAVE API    trainer_store.js against a memory-backed store: createTrainer (made active in the same transaction), updateTrainer (a patch; never touches teams,
//                      box, stats, tower, identity; a no-op writes nothing; reads again after another tab saved; read-only / not-found / unreadable / not-saved /
//                      conflict), setActiveTrainer, listTrainers, a stored v5 profile upgraded (the v5 one to history) before the card is written.
//
//   node tools/pokemonarena_trainer_card_test.mjs             the cases
//   node tools/pokemonarena_trainer_card_test.mjs --mutants   ALSO break trainer_card.js / profile.js / store.js / hub_data.js / editor_state.js / trainer_store.js one guard at a time
//                                                             (in a temp copy of pokemonarena/js); every break must fail one of the NAMED checks it lists
//   node tools/pokemonarena_trainer_card_test.mjs --browser   ALSO group B, in a REAL headless muted Chrome (tools/headless_cdp.mjs, throwaway profile) against REAL IndexedDB:
//                      B1 a stored v5 profile is upgraded to 6 ONCE by store.js (the v5 document to history as "migration"), teams / box / record / Tower kept;
//                      B2 after a reload it is NOT migrated again; B3 trainer_store.js writes its card there and createTrainer makes a new trainer active;
//                      B4 the REAL hub page (/pokemonarena/) upgrades a v5 profile in the real 'pokemonarena' database once, and a reload of the hub does not again.
//                      Starts tools/devserver.mjs on ARENA_PORT (default 8141; refuses to run if something already listens there) and Chrome on ARENA_CDP (default 9341).
// Pure ASCII. Writes only a temp copy of pokemonarena/js (for the mutants).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const SRC = path.join(root, 'pokemonarena', 'js');
const FX = path.join(here, 'fixtures', 'pokemonarena');
const WANT_MUTANTS = process.argv.includes('--mutants');
const WANT_BROWSER = process.argv.includes('--browser');

let results = [];
const J = (x) => JSON.stringify(x);
const clone = (x) => JSON.parse(JSON.stringify(x));
const canon = (x) => { const walk = (v) => (Array.isArray(v) ? v.map(walk) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, walk(v[k])])) : v); return JSON.stringify(walk(x)); };
const readFx = (n) => JSON.parse(fs.readFileSync(path.join(FX, n), 'utf8'));
const FIX = { v5: readFx('profile-v5-current.json'), v5tower: readFx('profile-v5-tower.json'), v4: readFx('profile-v4-current.json'), v2: readFx('profile-v2-current.json') };
const imp = (dir, f, bust) => import(pathToFileURL(path.join(dir, f)).href + (bust ? '?m=' + bust : ''));
async function loadStack(dir, bust) {
  const [C, P, S, H, E, T] = await Promise.all(['trainer_card.js', 'profile.js', 'store.js', 'hub_data.js', 'editor_state.js', 'trainer_store.js'].map((f) => imp(dir, f, bust)));
  return { C, P, S, H, E, T };
}
const NOW = 1700000999999;
let counter = 0;
const deps = () => ({ now: () => NOW, randomBytes: (n) => Uint8Array.from({ length: n }, (_, i) => (i * 37 + (++counter) * 11 + 5) & 255) });
const PACK = { species: [], moves: [] };          // readHubData only reads the pack for teams; the profiles here have none

async function check(name, fn) {
  let r;
  try { r = await fn(); } catch (e) { r = 'threw ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e); }
  results.push({ name, ok: r === true, detail: r === true ? '' : String(r).slice(0, 400) });
}

async function suite(X) {
  const { C, P, S, H, E, T } = X;
  const memStore = async (o = {}) => {
    const name = 'tc-' + (++counter) + '-' + Math.random().toString(36).slice(2);
    const inner = S.createMemoryAdapter({ name, durable: o.durable !== false });
    const adapter = o.wrap ? o.wrap(inner) : inner;
    const store = await S.openStore({ adapter, channel: false, deps: deps() });
    return { store, inner, name, raw: (id) => inner.transact(['profiles'], 'readonly', (tx) => tx.get('profiles', id)), put: (doc) => inner.transact(['profiles'], 'readwrite', (tx) => tx.put('profiles', doc)), done: async () => { await store.close(); S.dropMemoryDb(name); } };
  };
  const v6 = (over = {}) => { const o = P.openProfileDocument(clone(FIX.v5), { deps: deps() }); const p = o.profile; Object.assign(p, over); return p; };

  /* ---------------------------------------------------------------------------------------------- C: the card */
  const GOOD = { made: [true, false], look: [null, 'w000000', 'wzzzzzz', 'w0a1b2c'], front: [null, 0, 7, 255], back: [null, 0, 1, 255], partner: [null, 1, 25, 65535] };
  const BAD = { made: [0, 1, 'true', null, undefined, {}], look: ['', 'w00000', 'w0000000', 'W000000', 'x000000', 'w00000A', 5, {}], front: [-1, 256, 1.5, '3', NaN, true, {}], back: [-1, 256, 0.5, '0', false], partner: [0, -1, 65536, 2.5, '25', true] };
  await check('C1 the empty card is { made: false, look: null, front: null, back: null, partner: null }, the keys are in that order, and it is a fresh object each time', () => {
    const a = C.emptyCard(), b = C.emptyCard();
    return J(a) === J({ made: false, look: null, front: null, back: null, partner: null }) && J(C.CARD_KEYS) === J(Object.keys(a)) && a !== b && C.cardIssues(a).length === 0 ? true : J(a);
  });
  await check('C2 every key takes every good value (the strict check and the patch agree)', () => {
    for (const k of C.CARD_KEYS) for (const v of GOOD[k]) {
      const card = { ...C.emptyCard(), [k]: v };
      if (C.cardFieldIssue(k, v) !== null || C.cardIssues(card).length) return k + '=' + J(v) + ' refused: ' + J(C.cardIssues(card));
      const pt = C.checkCardPatch({ [k]: v });
      if (!pt.ok || pt.patch[k] !== v) return 'patch ' + k + '=' + J(v) + ' ' + J(pt);
    }
    return true;
  });
  await check('C3 every key refuses every bad value, in the strict check (path card.<key>), the patch (key named) and the repair (back to the empty value, the key reported)', () => {
    for (const k of C.CARD_KEYS) for (const v of BAD[k]) {
      const card = { ...C.emptyCard(), [k]: v };
      const is = C.cardIssues(card);
      if (!(is.length === 1 && is[0].path === 'card.' + k)) return 'check ' + k + '=' + String(v) + ' ' + J(is);
      const pt = C.checkCardPatch({ [k]: v });
      if (pt.ok || pt.key !== k) return 'patch ' + k + '=' + String(v) + ' ' + J(pt);
      const r = C.repairCard({ ...C.emptyCard(), front: 9, [k]: v });
      if (r.card[k] !== C.emptyCard()[k] || !r.repaired.includes(k) || (k !== 'front' && r.card.front !== 9)) return 'repair ' + k + '=' + String(v) + ' ' + J(r);
    }
    return true;
  });
  await check('C4 the strict check: a card that is not an object, a missing key, an unknown key are each refused; _unknown is allowed', () => {
    const notObj = [null, 5, 'x', [], undefined].every((v) => C.cardIssues(v).length === 1 && C.cardIssues(v)[0].path === 'card');
    const miss = C.cardIssues({ made: false, look: null, front: null, back: null });
    const extra = C.cardIssues({ ...C.emptyCard(), glow: 1 });
    const bag = C.cardIssues({ ...C.emptyCard(), _unknown: { glow: 1 } });
    return notObj && miss.length === 1 && miss[0].path === 'card.partner' && extra.length === 1 && extra[0].path === 'card.glow' && bag.length === 0 ? true : J([notObj, miss, extra, bag]);
  });
  await check('C5 the repair keeps every good value and reports only what it changed; junk in, the empty card out', () => {
    const full = { made: true, look: 'w00001a', front: 12, back: 1, partner: 249 };
    const r = C.repairCard(full), j = C.repairCard('junk'), part = C.repairCard({ made: true });
    return J(r.card) === J(full) && r.repaired.length === 0 && J(j.card) === J(C.emptyCard()) && part.card.made === true && J(part.repaired) === J(['look', 'front', 'back', 'partner']) ? true : J([r, j, part]);
  });
  await check('C6 a patch: only CARD_KEYS, each valid; an empty patch is ok; a non-object is refused; the patch is a copy holding exactly the keys given', () => {
    const e = C.checkCardPatch({}), n = C.checkCardPatch(null), a = C.checkCardPatch([]), u = C.checkCardPatch({ glow: 1 }), w = C.checkCardPatch({ _unknown: {} });
    const src = { front: 3, made: true }, g = C.checkCardPatch(src);
    return e.ok && J(e.patch) === '{}' && !n.ok && n.key === null && !a.ok && !u.ok && u.key === 'glow' && !w.ok && g.ok && g.patch !== src && J(g.patch) === J(src) ? true : J([e, n, a, u, w, g]);
  });
  await check('C7 cardOf: no profile, a profile from before schema 6, a junk card -> the empty card; a good card -> its five keys (no _unknown); isMade', () => {
    const empty = J(C.emptyCard());
    const ok1 = [null, undefined, {}, FIX.v5, { card: 'x' }, { card: null }, { card: [] }].every((p) => J(C.cardOf(p)) === empty);
    const good = { made: true, look: null, front: 5, back: 0, partner: null, _unknown: { z: 1 } };
    const c = C.cardOf({ card: good }), half = C.cardOf({ card: { made: true, front: 'x' } });
    return ok1 && J(c) === J({ made: true, look: null, front: 5, back: 0, partner: null }) && half.made === true && half.front === null && C.isMade({ card: good }) && !C.isMade(FIX.v5) && !C.isMade(null) ? true : J([ok1, c, half]);
  });

  /* ---------------------------------------------------------------------------------------------- M: the migration and the schema */
  await check('M1 the current schema is 6 and there is a migration out of every older one (1..5)', () => (P.SCHEMA_VERSION === 6 && J(Object.keys(P.MIGRATIONS)) === J(['1', '2', '3', '4', '5']) && typeof P.MIGRATIONS[5] === 'function' ? true : J([P.SCHEMA_VERSION, Object.keys(P.MIGRATIONS)])));
  await check('M2 the 5 -> 6 migration is pure (its input is never written), adds the empty card, says 6, keeps every other value, and is a fixed point', () => {
    const input = clone(FIX.v5), copy = clone(input), once = P.MIGRATIONS[5](input);
    const back = clone(once); delete back.card; back.schemaVersion = 5;
    const twice = P.MIGRATIONS[5]({ ...clone(once), schemaVersion: 5 });
    return canon(input) === canon(copy) && once !== input && once.schemaVersion === 6 && J(once.card) === J(C.emptyCard()) && canon(back) === canon(FIX.v5) && canon(twice) === canon(once) ? true : J([once.schemaVersion, once.card]);
  });
  await check('M3 a v5 document that already holds a GOOD card keeps it; a JUNK card goes to the unknown bag (under a free name) and the card starts empty; non-object input never throws', () => {
    const good = { ...clone(FIX.v5), card: { made: true, look: null, front: 4, back: 0, partner: null } };
    const g = P.MIGRATIONS[5](good);
    const junk = { ...clone(FIX.v5), card: { made: 'yes' } }, j = P.MIGRATIONS[5](junk);
    const taken = { ...clone(FIX.v5), card: 7, _unknown: { v5Card: 'mine' } }, t = P.MIGRATIONS[5](taken);
    const odd = [null, 5, 'x', []].map((v) => P.MIGRATIONS[5](v));
    return J(g.card) === J(good.card) && J(j.card) === J(C.emptyCard()) && J(j._unknown.v5Card) === J({ made: 'yes' }) && t._unknown.v5Card === 'mine' && t._unknown.v5Card_2 === 7 && J(odd) === J([null, 5, 'x', []]) ? true : J([g.card, j._unknown, t._unknown, odd]);
  });
  await check('M4 a REAL v5 profile (fixtures profile-v5-current / profile-v5-tower) opens as a valid v6 one: migrated from 5, nothing repaired, the card empty, every other value as it was', () => {
    for (const fx of [FIX.v5, FIX.v5tower]) {
      const o = P.openProfileDocument(clone(fx), { deps: deps() });
      if (!o.ok || o.migratedFrom !== 5 || o.readOnly || !o.changed || o.problems.length) return 'open ' + J({ ok: o.ok, mf: o.migratedFrom, p: o.problems });
      if (P.checkProfile(o.profile).length) return 'check ' + J(P.checkProfile(o.profile));
      const back = clone(o.profile); delete back.card; back.schemaVersion = 5;
      if (J(o.profile.card) !== J(C.emptyCard()) || canon(back) !== canon(fx)) return 'values changed for ' + fx.id;
      const again = P.openProfileDocument(clone(o.profile), { deps: deps() });
      if (!again.ok || again.changed || again.migratedFrom !== null) return 'not a fixed point';
    }
    return true;
  });
  await check('M5 the chain from v2 and v4 lands on 6 with the empty card (every older migration still runs as it did)', () => {
    const a = P.openProfileDocument(clone(FIX.v2), { deps: deps() }), b = P.openProfileDocument(clone(FIX.v4), { deps: deps() });
    return a.ok && b.ok && a.profile.schemaVersion === 6 && b.profile.schemaVersion === 6 && a.migratedFrom === 2 && b.migratedFrom === 4 && J(a.profile.card) === J(C.emptyCard()) && J(b.profile.card) === J(C.emptyCard()) && b.profile.tower && P.checkProfile(a.profile).length === 0 ? true : J([a.ok, b.ok, a.code, b.code]);
  });
  await check('M6 the strict check knows `card`: missing, junk, a bad field, an unknown key, a non-object _unknown -> code profile.card (listed in PROFILE_CODES); a good card with a bag passes', () => {
    if (!P.PROFILE_CODES['profile.card']) return 'profile.card is not in PROFILE_CODES';
    const base = v6();
    const cases = [(p) => { delete p.card; }, (p) => { p.card = 'x'; }, (p) => { p.card.front = -1; }, (p) => { p.card.glow = 1; }, (p) => { p.card._unknown = 5; }, (p) => { delete p.card.made; }];
    for (const [i, f] of cases.entries()) { const p = clone(base); f(p); const is = P.checkProfile(p); if (!is.length || !is.every((x) => x.code === 'profile.card')) return 'case ' + i + ' ' + J(is); }
    const good = clone(base); good.card = { made: true, look: 'w000003', front: 1, back: 1, partner: 6, _unknown: { glow: 1 } };
    return P.checkProfile(good).length === 0 ? true : J(P.checkProfile(good));
  });
  await check('M7 the repair (normalise) of a v6 document: a bad field becomes its empty value and is reported (profile.card, with the old value); a missing / junk card becomes the empty card; unknown card keys go to card._unknown; the result is a fixed point', () => {
    const p = v6(); p.card = { made: true, look: 'nope', front: 7, back: 1, partner: 0, glow: 'x', _unknown: { old: 1 } };
    const n = P.normalizeProfile(clone(p), { deps: deps() });
    if (!n.ok) return 'not ok ' + J(n.problems);
    const c = n.profile.card, rep = n.problems.filter((x) => x.code === 'profile.card').map((x) => x.path).sort();
    if (J({ ...c, _unknown: undefined }) !== J({ made: true, look: null, front: 7, back: 1, partner: null, _unknown: undefined }) || J(c._unknown) !== J({ old: 1, glow: 'x' })) return 'card ' + J(c);
    if (J(rep) !== J(['card.look', 'card.partner'])) return 'reported ' + J(n.problems);
    const n2 = P.normalizeProfile(clone(n.profile), { deps: deps() });
    const miss = v6(); delete miss.card; const m = P.normalizeProfile(miss, { deps: deps() });
    const junk = v6(); junk.card = [1]; const jj = P.normalizeProfile(junk, { deps: deps() });
    const wrapped = v6(); wrapped.card = { ...C.emptyCard(), _unknown: 'str' }; const ww = P.normalizeProfile(wrapped, { deps: deps() });
    return n2.ok && n2.problems.length === 0 && canon(n2.profile) === canon(n.profile) && m.ok && J(m.profile.card) === J(C.emptyCard()) && m.problems.some((x) => x.code === 'profile.card' && x.path === 'card')
      && jj.ok && J(jj.profile.card) === J(C.emptyCard()) && ww.ok && J(ww.profile.card._unknown) === J({ _unknown: 'str' }) ? true : J([n2.problems, m.problems, jj.ok, ww.profile && ww.profile.card]);
  });
  await check('M8 createProfile: no init.card = the empty card; init.card is merged over the empty card; a bad or unknown card key throws ProfileError (profile.card)', () => {
    const a = P.createProfile({ trainerName: 'A' }, deps()), b = P.createProfile({ trainerName: 'B', card: { made: true, front: 3 } }, deps());
    const bad = [{ front: 'x' }, { glow: 1 }, 'x'].map((card) => { try { P.createProfile({ trainerName: 'C', card }, deps()); return 'no throw'; } catch (e) { return e.name === 'ProfileError' && e.problems.some((x) => x.code === 'profile.card') ? 'ok' : e.message; } });
    return a.schemaVersion === 6 && J(a.card) === J(C.emptyCard()) && J(b.card) === J({ made: true, look: null, front: 3, back: null, partner: null }) && J(bad) === J(['ok', 'ok', 'ok']) ? true : J([a.card, b.card, bad]);
  });
  await check('M9 the card survives export -> import whole, its unknown keys too; new and replace carry the file\'s card (as the name and the portrait), merge keeps the profile\'s own', async () => {
    const p = v6({ trainerName: 'CARDY' }); p.card = { made: true, look: 'w00000b', front: 9, back: 1, partner: 25, glow: 'x' };
    const n = P.normalizeProfile(clone(p), { deps: deps() });
    const ex = P.serializeExport(P.buildExport(n.profile, { deps: deps() }));
    const im = await P.parseExport(ex, { deps: deps() });
    if (!im.ok) return 'import ' + J(im);
    const want = { made: true, look: 'w00000b', front: 9, back: 1, partner: 25, _unknown: { glow: 'x' } };
    if (canon(im.profile.card) !== canon(want)) return 'imported card ' + J(im.profile.card);
    const mine = v6({ trainerName: 'MINE' }); mine.card = { made: true, look: null, front: 2, back: 0, partner: null };
    const nw = P.planImport(null, im.profile, 'new', deps()), rp = P.planImport(mine, im.profile, 'replace', deps()), mg = P.planImport(mine, im.profile, 'merge', deps());
    return nw.ok && rp.ok && mg.ok && canon(nw.profile.card) === canon(want) && canon(rp.profile.card) === canon(want) && rp.profile.trainerName === 'CARDY' && canon(mg.profile.card) === canon(mine.card) && mg.profile.trainerName === 'MINE' ? true : J([nw.ok, rp.ok, mg.ok, mg.profile && mg.profile.card]);
  });
  await check('M10 an OLDER build (current version 5) opens a v6 document READ-ONLY and leaves it untouched; this build opens a v7 one read-only too', () => {
    const doc = v6(); doc.card.made = true;
    const old = { ...P.MIGRATIONS }; delete old[5];
    const r = P.migrateProfile(clone(doc), old, 5);
    const fut = { ...clone(doc), schemaVersion: 7, card: 'a v7 card' }, f = P.openProfileDocument(fut, { deps: deps() });
    return r.ok && r.readOnly === true && canon(r.profile) === canon(doc) && f.ok && f.readOnly && f.profile.card === 'a v7 card' ? true : J([r, f.readOnly]);
  });

  /* ---------------------------------------------------------------------------------------------- E: the editor's reducer */
  await check('E1 { type: card, patch } changes only the keys given, is one undo step labelled "change trainer card", and undo / redo restore the card', () => {
    let s = E.initialState(v6());
    s = E.reduce(s, { type: 'card', patch: { front: 5, made: true } }, {});
    if (s.error || s.profile.card.front !== 5 || s.profile.card.made !== true || s.profile.card.back !== null || s.undo.length !== 1 || s.undo[0].label !== 'change trainer card' || !E.isDirty(s)) return 'apply ' + J([s.error, s.profile.card, s.undo.length]);
    const u = E.reduce(s, { type: 'undo' }, {}), r = E.reduce(u, { type: 'redo' }, {});
    return J(u.profile.card) === J(C.emptyCard()) && r.profile.card.front === 5 && P.checkProfile(r.profile).length === 0 && P.checkProfile(u.profile).length === 0 ? true : J([u.profile.card, r.profile.card]);
  });
  await check('E2 a bad patch is REFUSED (the profile is the same object; card.value / card.key / card.shape) and a patch that changes nothing is no edit', () => {
    const s = E.initialState(v6());
    const a = E.reduce(s, { type: 'card', patch: { front: 999 } }, {}), b = E.reduce(s, { type: 'card', patch: { glow: 1 } }, {}), c = E.reduce(s, { type: 'card', patch: 'x' }, {}), d = E.reduce(s, { type: 'card', patch: { made: false } }, {});
    return a.profile === s.profile && a.error.code === 'card.value' && a.error.key === 'front' && b.profile === s.profile && b.error.code === 'card.key' && c.profile === s.profile && c.error.code === 'card.shape' && d.profile === s.profile && d.undo.length === 0 && !d.error ? true : J([a.error, b.error, c.error, d.undo.length]);
  });
  await check('E3 the card\'s unknown keys (a newer build\'s) are kept through a card edit; a read-only profile refuses it', () => {
    const p = v6(); p.card = { ...C.emptyCard(), _unknown: { glow: 'x' } };
    const s = E.reduce(E.initialState(p), { type: 'card', patch: { partner: 25 } }, {});
    const ro = E.initialState(v6(), { readOnly: true }), r = E.reduce(ro, { type: 'card', patch: { partner: 25 } }, {});
    return J(s.profile.card._unknown) === J({ glow: 'x' }) && s.profile.card.partner === 25 && r.profile === ro.profile && r.error && r.error.code === 'profile.readonly' ? true : J([s.profile.card, r.error]);
  });

  /* ---------------------------------------------------------------------------------------------- H: the hub's data */
  await check('H1 readHubData: each profile summary carries avatar { kind, id } and card (cardOf); a newer build\'s document gets the default portrait and the empty card', async () => {
    const M = await memStore();
    try {
      const a = await M.store.createProfile({ trainerName: 'ASH', avatar: { kind: 'preset', id: 7 }, card: { made: true, front: 3 } });
      await M.put({ ...v6({ id: 'p_newer', trainerName: 'NEWER' }), schemaVersion: 7, avatar: { kind: 'hat', id: 3 }, card: 'y' });
      const d = await H.readHubData(M.store, PACK);
      const A = d.profiles.find((p) => p.id === a.id), N = d.profiles.find((p) => p.id === 'p_newer');
      return A && N && J(A.avatar) === J({ kind: 'preset', id: 7 }) && J(A.card) === J({ made: true, look: null, front: 3, back: null, partner: null }) && N.readOnly && J(N.avatar) === J({ kind: 'preset', id: 0 }) && J(N.card) === J(C.emptyCard()) ? true : J(d.profiles.map((p) => [p.id, p.avatar, p.card]));
    } finally { await M.done(); }
  });

  /* ---------------------------------------------------------------------------------------------- S: the save API */
  await check('S1 createTrainer makes a profile with the name, portrait and card given (card over the empty card) and makes it ACTIVE; notSaved false in a store that keeps profiles', async () => {
    const M = await memStore();
    try {
      const r = await T.createTrainer(M.store, { name: 'ASH', avatar: { kind: 'preset', id: 51 }, card: { look: 'w000001', made: true } });
      const raw = r.ok ? await M.raw(r.id) : null;
      return r.ok && r.notSaved === false && (await M.store.getActiveId()) === r.id && raw && raw.trainerName === 'ASH' && J(raw.avatar) === J({ kind: 'preset', id: 51 }) && J(raw.card) === J({ made: true, look: 'w000001', front: null, back: null, partner: null }) && raw.rev === 1 && P.checkProfile(raw).length === 0 && r.profile.id === r.id ? true : J(r);
    } finally { await M.done(); }
  });
  await check('S2 createTrainer refuses a bad name / portrait / card with codes name / avatar / card, and writes nothing', async () => {
    const M = await memStore();
    try {
      const bad = [[{ name: '' }, 'name'], [{ name: '   ' }, 'name'], [{ name: 'ABCDEFGHIJK' }, 'name'], [{ name: 'A{B' }, 'name'], [{}, 'name'], [{ name: 5 }, 'name'], [{ name: 'OK', avatar: { kind: 'preset', id: 52 } }, 'avatar'], [{ name: 'OK', avatar: { kind: 'preset', id: -1 } }, 'avatar'],
        [{ name: 'OK', avatar: { kind: 'mon', id: 0 } }, 'avatar'], [{ name: 'OK', avatar: { kind: 'x', id: 1 } }, 'avatar'], [{ name: 'OK', avatar: { kind: 'preset', id: 1, z: 1 } }, 'avatar'], [{ name: 'OK', card: { front: 'x' } }, 'card'], [{ name: 'OK', card: { glow: 1 } }, 'card'], [{ name: 'OK', teams: [] }, 'store']];
      for (const [inp, code] of bad) { const r = await T.createTrainer(M.store, inp); if (r.ok || r.code !== code || typeof r.message !== 'string') return J(inp) + ' -> ' + J(r); }
      const ten = await T.createTrainer(M.store, { name: 'ABCDEFGHIJ', avatar: { kind: 'mon', id: 25 } });
      return (await M.store.listProfiles()).length === 1 && ten.ok && (await M.store.getActiveId()) === ten.id ? true : 'stored ' + (await M.store.listProfiles()).length;
    } finally { await M.done(); }
  });
  await check('S3 createTrainer in a browser that keeps nothing (memory only) still makes the trainer for the visit and says notSaved: true', async () => {
    const M = await memStore({ durable: false });
    try { const r = await T.createTrainer(M.store, { name: 'MEM' }); return r.ok && r.notSaved === true ? true : J(r); } finally { await M.done(); }
  });
  await check('S4 updateTrainer: a card PATCH changes only its keys (the other choices on the card stay); name and portrait change; teams, box, stats, tower and identity are exactly as they were; one write (rev + 1), the old revision in history', async () => {
    const M = await memStore();
    try {
      await M.put(v6({ rev: 3, card: { made: false, look: 'w000005', front: null, back: 1, partner: 9 } }));
      const id = FIX.v5.id, before = await M.raw(id);
      const r = await T.updateTrainer(M.store, id, { name: 'RED', avatar: { kind: 'preset', id: 9 }, card: { made: true, front: 4 } });
      const after = await M.raw(id), h = await M.store.listHistory(id);
      const same = ['teams', 'box', 'stats', 'tower', 'identity', 'settings', '_unknown', 'createdAt', 'romSha256'].every((k) => canon(after[k]) === canon(before[k]));
      return r.ok && r.changed && same && after.rev === 4 && after.trainerName === 'RED' && J(after.avatar) === J({ kind: 'preset', id: 9 }) && J(after.card) === J({ made: true, look: 'w000005', front: 4, back: 1, partner: 9 }) && h.length === 1 && h[0].reason === 'trainer' && canon(r.profile) === canon(after) ? true : J([r.code, same, after.rev, h]);
    } finally { await M.done(); }
  });
  await check('S5 updateTrainer with nothing different writes NOTHING (changed: false, the revision does not move); a bad patch is refused before anything is read', async () => {
    const M = await memStore();
    try {
      const c = await T.createTrainer(M.store, { name: 'ASH', card: { front: 2 } });
      const a = await T.updateTrainer(M.store, c.id, { name: 'ASH', card: { front: 2 } }), b = await T.updateTrainer(M.store, c.id, {});
      const bad = await T.updateTrainer(M.store, c.id, { card: { back: 'x' } }), badN = await T.updateTrainer(M.store, c.id, { name: '' }), badA = await T.updateTrainer(M.store, c.id, { avatar: { kind: 'preset', id: 99 } }), badK = await T.updateTrainer(M.store, c.id, { box: [] });
      const raw = await M.raw(c.id);
      return a.ok && a.changed === false && b.ok && b.changed === false && raw.rev === 1 && bad.code === 'card' && bad.key === 'back' && badN.code === 'name' && badA.code === 'avatar' && badK.code === 'store' ? true : J([a, b.changed, raw.rev, bad, badN.code, badA.code, badK.code]);
    } finally { await M.done(); }
  });
  await check('S6 the card\'s and the portrait\'s unknown keys (a newer build\'s) survive an update', async () => {
    const M = await memStore();
    try {
      const p = v6(); p.card = { ...C.emptyCard(), _unknown: { glow: 'x' } }; p.avatar = { kind: 'preset', id: 1, _unknown: { hat: 2 } };
      await M.put(p);
      const r = await T.updateTrainer(M.store, p.id, { card: { made: true }, avatar: { kind: 'preset', id: 2 } }), raw = await M.raw(p.id);
      return r.ok && J(raw.card._unknown) === J({ glow: 'x' }) && raw.card.made === true && J(raw.avatar) === J({ kind: 'preset', id: 2, _unknown: { hat: 2 } }) ? true : J([r, raw.card, raw.avatar]);
    } finally { await M.done(); }
  });
  await check('S7 ANOTHER TAB saves between the read and the write: updateTrainer reads again and applies its change on top (both changes kept, nothing lost)', async () => {
    const M = await memStore();
    try {
      const c = await T.createTrainer(M.store, { name: 'ASH' });
      let raced = 0;
      const tab = { get status() { return M.store.status; }, loadProfile: (id) => M.store.loadProfile(id), listProfiles: () => M.store.listProfiles(), getActiveId: () => M.store.getActiveId(),
        saveProfile: async (p, o) => { if (!raced++) { const l = await M.store.loadProfile(p.id); await M.store.saveProfile({ ...l.profile, trainerName: 'OTHER', settings: { ...l.profile.settings, textSpeed: 'fast' } }, { reason: 'edit' }); } return M.store.saveProfile(p, o); } };
      const r = await T.updateTrainer(tab, c.id, { card: { partner: 25 } }), raw = await M.raw(c.id);
      return r.ok && raced === 2 && raw.trainerName === 'OTHER' && raw.settings.textSpeed === 'fast' && raw.card.partner === 25 && raw.rev === 3 ? true : J([r.code, raced, raw.trainerName, raw.card, raw.rev]);
    } finally { await M.done(); }
  });
  await check('S8 a tab that ALWAYS loses the race gets code conflict after TRAINER_RETRIES tries, and nothing it meant is written', async () => {
    const M = await memStore();
    try {
      const c = await T.createTrainer(M.store, { name: 'ASH' });
      let tries = 0;
      const tab = { get status() { return M.store.status; }, loadProfile: (id) => M.store.loadProfile(id), saveProfile: async () => { tries++; throw new S.ConflictError('someone else saved first'); } };
      const r = await T.updateTrainer(tab, c.id, { card: { partner: 25 } }), raw = await M.raw(c.id);
      return !r.ok && r.code === 'conflict' && tries === T.TRAINER_RETRIES && T.TRAINER_RETRIES >= 2 && raw.card.partner === null ? true : J([r, tries]);
    } finally { await M.done(); }
  });
  await check('S9 a profile saved by a NEWER build is refused (read-only) and no write is even attempted; it is listed (readOnly: true) and may be made active', async () => {
    const M = await memStore();
    try {
      const fut = { ...v6({ id: 'p_fut' }), schemaVersion: P.SCHEMA_VERSION + 1, card: { made: true, sparkle: 1 } }; await M.put(fut);
      let saves = 0;
      const spy = { get status() { return M.store.status; }, loadProfile: (id) => M.store.loadProfile(id), saveProfile: (p, o) => { saves++; return M.store.saveProfile(p, o); } };
      const r = await T.updateTrainer(spy, 'p_fut', { card: { made: true }, name: 'X' }), raw = await M.raw('p_fut');
      const list = await T.listTrainers(M.store), act = await T.setActiveTrainer(M.store, 'p_fut');
      const row = list.find((x) => x.id === 'p_fut');
      return !r.ok && r.code === 'read-only' && saves === 0 && canon(raw) === canon(fut) && row && row.readOnly === true && J(row.card) === J({ made: true, look: null, front: null, back: null, partner: null }) && act.ok && (await M.store.getActiveId()) === 'p_fut' ? true : J([r, row, act]);
    } finally { await M.done(); }
  });
  await check('S10 not-found and unreadable: no such id -> not-found (update and switch); a stored document that cannot be read -> unreadable (update and switch); neither is listed', async () => {
    const M = await memStore();
    try {
      await M.put({ id: 'p_junk', schemaVersion: 'banana' }); await M.put({ ...v6({ id: 'p_badapp' }), app: 'other' });
      const a = await T.updateTrainer(M.store, 'p_none', { name: 'X' }), b = await T.setActiveTrainer(M.store, 'p_none'), c = await T.updateTrainer(M.store, 'p_junk', { name: 'X' }), d = await T.setActiveTrainer(M.store, 'p_junk'), e = await T.updateTrainer(M.store, 'p_badapp', { name: 'X' }), f = await T.updateTrainer(M.store, '', { name: 'X' });
      const list = await T.listTrainers(M.store);
      return a.code === 'not-found' && b.code === 'not-found' && c.code === 'unreadable' && d.code === 'unreadable' && e.code === 'unreadable' && f.code === 'not-found' && list.length === 0 && (await M.store.getActiveId()) === null ? true : J([a.code, b.code, c.code, d.code, e.code, f.code, list]);
    } finally { await M.done(); }
  });
  await check('S11 the browser REFUSES a write (a full disk): create, update and switch say not-saved, nothing changes, and store.status.notSaved is set', async () => {
    let failing = false;
    const M = await memStore({ wrap: (inner) => ({ ...inner, get kind() { return inner.kind; }, get durable() { return inner.durable; }, get readOnly() { return inner.readOnly; }, open: () => inner.open(), close: () => inner.close(), transact: (n, m, fn) => (failing && m === 'readwrite' ? Promise.reject(Object.assign(new Error('the disk is full'), { name: 'QuotaExceededError' })) : inner.transact(n, m, fn)) }) });
    try {
      const c = await T.createTrainer(M.store, { name: 'ASH' });
      failing = true;
      const a = await T.createTrainer(M.store, { name: 'BOB' }), u = await T.updateTrainer(M.store, c.id, { card: { made: true } }), s = await T.setActiveTrainer(M.store, c.id);
      failing = false;
      const raw = await M.raw(c.id);
      return c.ok && a.code === 'not-saved' && u.code === 'not-saved' && s.code === 'not-saved' && raw.card.made === false && (await M.store.listProfiles()).length === 1 && M.store.status.notSaved === true ? true : J([a.code, u.code, s.code, raw.card]);
    } finally { await M.done(); }
  });
  await check('S12 a stored v5 profile: updateTrainer upgrades it first (the v5 document goes to history as "migration"), then writes the card; its teams, box and record come through unchanged', async () => {
    const M = await memStore();
    try {
      await M.put(clone(FIX.v5));
      const r = await T.updateTrainer(M.store, FIX.v5.id, { card: { made: true, look: 'w000002' } });
      const raw = await M.raw(FIX.v5.id), h = (await M.inner.transact(['profileHistory'], 'readonly', (tx) => tx.list('profileHistory'))).sort((x, y) => x.rev - y.rev);
      const kept = ['teams', 'box', 'stats', 'tower', 'identity', 'trainerName', 'avatar'].every((k) => canon(raw[k]) === canon(FIX.v5[k]));
      return r.ok && raw.schemaVersion === 6 && raw.card.made === true && raw.card.look === 'w000002' && kept && h.length === 2 && h[0].reason === 'migration' && h[0].doc.schemaVersion === 5 && canon(h[0].doc) === canon(FIX.v5) && h[1].reason === 'trainer' ? true : J([r.code, raw.schemaVersion, kept, h.map((x) => [x.reason, x.doc.schemaVersion])]);
    } finally { await M.done(); }
  });
  await check('S13 listTrainers: every readable trainer with { id, name, avatar, card, readOnly, active }; setActiveTrainer switches; listTrainers of a broken store is [] (never throws)', async () => {
    const M = await memStore();
    try {
      const a = await T.createTrainer(M.store, { name: 'ASH', avatar: { kind: 'preset', id: 4 }, card: { made: true } }), b = await T.createTrainer(M.store, { name: 'BOB' });
      const l1 = await T.listTrainers(M.store), s = await T.setActiveTrainer(M.store, a.id), l2 = await T.listTrainers(M.store);
      const A = l1.find((x) => x.id === a.id);
      const broken = await T.listTrainers({ listProfiles: async () => { throw new Error('gone'); } });
      return l1.length === 2 && A && J(Object.keys(A).sort()) === J(['active', 'avatar', 'card', 'id', 'name', 'readOnly']) && A.name === 'ASH' && J(A.avatar) === J({ kind: 'preset', id: 4 }) && A.card.made === true && A.readOnly === false && A.active === false && l1.find((x) => x.id === b.id).active === true
        && s.ok && l2.find((x) => x.id === a.id).active === true && l2.find((x) => x.id === b.id).active === false && J(broken) === '[]' ? true : J([l1, s, l2, broken]);
    } finally { await M.done(); }
  });
  await check('S14 every refusal code is in TRAINER_CODES with a sentence, and the error mapping is the documented one (conflict / read-only / not-found / store / not-saved)', async () => {
    const want = ['name', 'avatar', 'card', 'read-only', 'not-found', 'unreadable', 'not-saved', 'conflict', 'store'];
    if (J(Object.keys(T.TRAINER_CODES).sort()) !== J(want.slice().sort()) || !want.every((k) => typeof T.TRAINER_CODES[k] === 'string' && T.TRAINER_CODES[k].length > 5)) return J(T.TRAINER_CODES);
    const thrower = (e) => ({ get status() { return { notSaved: false }; }, createActiveProfile: async () => { throw e; } });
    const map = [[new S.ConflictError('c'), 'conflict'], [new S.ReadOnlyError('r'), 'read-only'], [new S.NotFoundError('n'), 'not-found'], [new S.ValidationError('v', []), 'store'], [new S.ClosedError(), 'store'], [new TypeError('t'), 'store'], [Object.assign(new Error('aborted'), { name: 'AbortError' }), 'not-saved']];
    for (const [e, code] of map) { const r = await T.createTrainer(thrower(e), { name: 'ASH' }); if (r.ok || r.code !== code) return e.name + ' -> ' + J(r); }
    return true;
  });
  await check('S16 a stored v5 profile whose UPGRADE cannot be written (the write-back fails once): updateTrainer says not-saved and writes nothing; the next try upgrades it (history "migration") and writes the card', async () => {
    let failNext = 0;
    const M = await memStore({ wrap: (inner) => ({ ...inner, get kind() { return inner.kind; }, get durable() { return inner.durable; }, get readOnly() { return inner.readOnly; }, open: () => inner.open(), close: () => inner.close(), transact: (n, m, fn) => (failNext > 0 && m === 'readwrite' ? (failNext--, Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))) : inner.transact(n, m, fn)) }) });
    try {
      await M.put(clone(FIX.v5));
      failNext = 1;
      const a = await T.updateTrainer(M.store, FIX.v5.id, { card: { made: true } }), raw1 = await M.raw(FIX.v5.id);
      const b = await T.updateTrainer(M.store, FIX.v5.id, { card: { made: true } }), raw2 = await M.raw(FIX.v5.id), h = await M.store.listHistory(FIX.v5.id);
      return !a.ok && a.code === 'not-saved' && raw1.schemaVersion === 5 && canon(raw1) === canon(FIX.v5) && b.ok && raw2.schemaVersion === 6 && raw2.card.made === true && J(h.map((x) => x.reason).sort()) === J(['migration', 'trainer']) ? true : J([a.code, raw1.schemaVersion, b.code, raw2.schemaVersion, h]);
    } finally { await M.done(); }
  });
  await check('S15 the store\'s createActiveProfile writes the profile and the active pointer in ONE transaction: a database that refuses writes gets neither', async () => {
    const M = await memStore();
    try {
      const ro = S.createMemoryAdapter({ name: M.name, durable: true, readOnly: true }); await ro.open();
      const st2 = await S.openStore({ adapter: ro, channel: false, deps: deps() });
      const r = await T.createTrainer(st2, { name: 'ASH' });
      const ok = await T.createTrainer(M.store, { name: 'BOB' });
      return !r.ok && r.code === 'read-only' && (await M.store.listProfiles()).length === 1 && (await M.store.getActiveId()) === ok.id ? true : J([r, ok]);
    } finally { await M.done(); }
  });
}

/* ------------------------------------------------------------------------------------------------ mutants: [id, file, from, to, [checks that must catch it]] */
const MUTANTS = [
  // trainer_card.js
  ['card-made-anything', 'trainer_card.js', "case 'made': return typeof v === 'boolean' ? null :", "case 'made': return true ? null :", ['C3']],
  ['card-look-any-string', 'trainer_card.js', "(typeof v === 'string' && CARD_LOOK_RE.test(v))", "(typeof v === 'string')", ['C3']],
  ['card-front-unbounded', 'trainer_card.js', "case 'front': return v === null || isInt(v, 0, CARD_LIMITS.front)", "case 'front': return v === null || Number.isFinite(v)", ['C3']],
  ['card-back-unbounded', 'trainer_card.js', "case 'back': return v === null || isInt(v, 0, CARD_LIMITS.back)", "case 'back': return v === null || typeof v !== 'string'", ['C3']],
  ['card-partner-zero', 'trainer_card.js', "isInt(v, 1, CARD_LIMITS.partner)", "isInt(v, 0, CARD_LIMITS.partner)", ['C3']],
  ['card-missing-key-ok', 'trainer_card.js', "if (!Object.prototype.hasOwnProperty.call(card, k)) { out.push({ path: 'card.' + k, message: 'card.' + k + ' is missing' }); continue; }", "if (!Object.prototype.hasOwnProperty.call(card, k)) continue;", ['C4', 'M6']],
  ['card-unknown-key-ok', 'trainer_card.js', "for (const k of Object.keys(card)) if (!CARD_KEYS.includes(k) && k !== '_unknown') out.push(", "for (const k of Object.keys(card)) if (false) out.push(", ['C4', 'M6']],
  ['card-repair-drops-good', 'trainer_card.js', "if (Object.prototype.hasOwnProperty.call(src, k) && !cardFieldIssue(k, src[k])) card[k] = src[k];", "if (false) card[k] = src[k];", ['C5', 'C3']],
  ['card-patch-any-key', 'trainer_card.js', "if (!CARD_KEYS.includes(k)) return { ok: false, key: k, message: 'unknown card key ' + k };", '', ['C6', 'E2', 'S2'], ['trainer_card.js', "default: return 'unknown card key ' + key;", 'default: return null;']],
  ['card-patch-any-value', 'trainer_card.js', "    if (why) return { ok: false, key: k, message: why };\n    out[k] = patch[k];", '    out[k] = patch[k];', ['C3', 'E2', 'S2']],
  ['cardOf-trusts-junk', 'trainer_card.js', 'return repairCard(c).card;', 'return c;', ['C7']],
  // profile.js
  ['schema-still-5', 'profile.js', 'export const SCHEMA_VERSION = 6;', 'export const SCHEMA_VERSION = 5;', ['M1']],
  ['no-migration-5', 'profile.js', ', 5: migrate5to6 });', ' });', ['M1', 'M4']],
  ['migration-no-card', 'profile.js', '  } else o.card = emptyCard();\n  return o;\n}', '  }\n  return o;\n}', ['M2', 'M4']],
  ['migration-overwrites-good-card', 'profile.js', '    if (cardIssues(o.card).length) {\n      let key', '    {\n      let key', ['M3']],
  ['migration-loses-junk-card', 'profile.js', 'bagSet(o, key, o.card); o.card = emptyCard();', 'o.card = emptyCard();', ['M3']],
  ['migration-card-key-ignores-the-bag', 'profile.js', "(isObj(o._unknown) && hasOwn.call(o._unknown, key)) || hasOwn.call(o, key); i++) key = 'v5Card_' + i;", "hasOwn.call(o, key); i++) key = 'v5Card_' + i;", ['M3']],
  ['migration-writes-its-input', 'profile.js', 'function migrate5to6(d) {\n  const o = clone(d);', 'function migrate5to6(d) {\n  const o = d;', ['M2']],
  ['migration-says-5', 'profile.js', '  o.schemaVersion = 6;\n  if (hasOwn.call(o, \'card\')) {', '  o.schemaVersion = 5;\n  if (hasOwn.call(o, \'card\')) {', ['M2', 'M4']],
  ['check-ignores-card', 'profile.js', "  for (const x of cardIssues(p.card)) add('profile.card', x.path, x.message);\n", '', ['M6']],
  ['check-ignores-card-bag', 'profile.js', "if (isObj(p.card) && hasOwn.call(p.card, '_unknown') && !isObj(p.card._unknown)) add(", 'if (false) add(', ['M6']],
  ['card-code-unlisted', 'profile.js', "  'profile.card': 'card is not a well-formed trainer card", "  'profile.cardx': 'card is not a well-formed trainer card", ['M6']],
  ['repair-drops-card-bag', 'profile.js', '    if (bag && Object.keys(bag).length) out.card._unknown = bag;\n', '', ['M7', 'M9', 'S6']],
  ['repair-silent', 'profile.js', "    for (const k of r.repaired) P('repaired', 'profile.card',", "    for (const k of []) P('repaired', 'profile.card',", ['M7']],
  ['create-ignores-init-card', 'profile.js', 'card: init.card === undefined ? emptyCard() : isObj(init.card) ? { ...emptyCard(), ...init.card } : init.card,', 'card: emptyCard(),', ['M8', 'S1']],
  // store.js
  ['create-not-active', 'store.js', "      await tx.put('meta', { key: 'activeProfileId', value: s.id });\n", '', ['S1', 'S13']],
  // hub_data.js
  ['hub-no-card', 'hub_data.js', 'avatar: avatarOf(p), card: cardOf(p), readOnly', 'readOnly', ['H1']],
  ['hub-avatar-trusts-junk', 'hub_data.js', "return a && typeof a === 'object' && (a.kind === 'preset' || a.kind === 'mon')", "return a && (true || a.kind === 'mon')", ['H1', 'S9']],
  // editor_state.js
  ['editor-card-unchecked', 'editor_state.js', '    const c = checkCardPatch(action.patch);\n    if (!c.ok) return reject(', '    const c = { ok: true, patch: action.patch };\n    if (!c.ok) return reject(', ['E2']],
  ['editor-undo-keeps-card', 'editor_state.js', "card: Object.prototype.hasOwnProperty.call(snapshot, 'card') ? snapshot.card : current.card,", 'card: current.card,', ['E1']],
  ['editor-card-drops-bag', 'editor_state.js', 'P.card._unknown && typeof P.card._unknown === \'object\') card._unknown = P.card._unknown;', 'false) card._unknown = P.card._unknown;', ['E3']],
  ['editor-card-noop-is-edit', 'editor_state.js', "if (CARD_KEYS.every((k) => !Object.prototype.hasOwnProperty.call(c.patch, k) || c.patch[k] === cur[k])) return { ...state, error: null, notice: null, result: null };", '', ['E2']],
  // trainer_store.js
  ['ts-name-unchecked', 'trainer_store.js', "  if (why === 'length') return `A name has at most ${PROFILE_LIMITS.trainerName} letters.`;\n  if (why) return 'That name uses a letter the game cannot write.';\n", '', ['S2']],
  ['ts-name-blank-ok', 'trainer_store.js', "  if (name.trim() === '') return 'A name cannot be empty.';\n", '', ['S2', 'S5']],
  ['ts-avatar-off-by-one', 'trainer_store.js', 'a.id < AVATAR_PRESETS ? null', 'a.id <= AVATAR_PRESETS ? null', ['S2']],
  ['ts-avatar-extra-keys', 'trainer_store.js', "if (!isObj(a) || Object.keys(a).some((k) => k !== 'kind' && k !== 'id')) return", 'if (!isObj(a)) return', ['S2']],
  ['ts-card-unchecked', 'trainer_store.js', "if (o.card !== undefined) { const c = checkCardPatch(o.card); if (!c.ok) return fail('card', c.message, { key: c.key }); change.card = c.patch; }", 'if (o.card !== undefined) { change.card = o.card; }', ['S2', 'S5']],
  ['ts-other-keys-ok', 'trainer_store.js', "for (const k of Object.keys(o)) if (k !== 'name' && k !== 'avatar' && k !== 'card') return fail(", 'for (const k of Object.keys(o)) if (false) return fail(', ['S2', 'S5']],
  ['ts-create-not-active', 'trainer_store.js', 'const saved = await store.createActiveProfile(init);', 'const saved = await store.createProfile(init);', ['S1', 'S13']],
  ['ts-no-retry', 'trainer_store.js', "      if (e && e.code === 'store.conflict') continue;", '', ['S7', 'S8']],
  ['ts-writes-read-only', 'trainer_store.js', "    if (l.readOnly) return fail('read-only');\n", '', ['S9']],
  ['ts-ignores-unsaved-upgrade', 'trainer_store.js', "    if (l.unsaved) return fail('not-saved',", "    if (false) return fail('not-saved',", ['S16']],
  ['ts-unreadable-is-not-found', 'trainer_store.js', "return l && l.code === 'store.not-found' ? fail('not-found') : fail('unreadable', null, { profileCode: l ? l.code : null });", "return fail('not-found');", ['S10']],
  ['ts-drops-card-bag', 'trainer_store.js', "      if (isObj(p.card) && isObj(p.card._unknown)) next.card._unknown = p.card._unknown;", '', ['S6']],
  ['ts-drops-avatar-bag', 'trainer_store.js', '    if (isObj(p.avatar) && isObj(p.avatar._unknown)) next.avatar._unknown = p.avatar._unknown;', '', ['S6']],
  ['ts-card-replaces-not-patches', 'trainer_store.js', '      next.card = { ...cur, ...change.card };', '      next.card = { ...emptyCard(), ...change.card };', ['S7', 'S4']],
  ['ts-noop-writes', 'trainer_store.js', '  return changed ? next : null;', '  return next;', ['S5']],
  ['ts-conflict-is-store', 'trainer_store.js', "  if (c === 'store.conflict') return fail('conflict', null, { detail: describe(e) });\n", '', ['S14']],
  ['ts-write-failure-is-store', 'trainer_store.js', "  return fail('not-saved', null, { detail: describe(e) });          // the browser refused", "  return fail('store', null, { detail: describe(e) });          // the browser refused", ['S11', 'S14']],
  ['ts-switch-to-corrupt', 'trainer_store.js', "  if (row.corrupt) return fail('unreadable');\n", '', ['S10']],
  ['ts-list-hides-read-only', 'trainer_store.js', '    if (!r || !r.ok) continue;\n    const p = r.profile;', '    if (!r || !r.ok || r.readOnly) continue;\n    const p = r.profile;', ['S9']],
  ['ts-list-throws', 'trainer_store.js', '  try { list = await store.listProfiles(); } catch (_e) { return out; }', '  list = await store.listProfiles();', ['S13']],
];

async function runMutants() {
  const out = [];
  for (const [id, file, from, to, want, also] of MUTANTS) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-tcmut-'));
    try {
      for (const f of fs.readdirSync(SRC)) { const p = path.join(SRC, f); if (fs.statSync(p).isFile()) fs.copyFileSync(p, path.join(dir, f)); }
      const target = path.join(dir, file), text = fs.readFileSync(target, 'utf8'), n = text.split(from).length - 1;
      if (n !== 1) { out.push({ id, killed: false, why: 'THE MUTANT DID NOT APPLY (pattern found ' + n + 'x)' }); continue; }
      fs.writeFileSync(target, text.replace(from, () => to));
      if (also) { const t2 = path.join(dir, also[0]), x2 = fs.readFileSync(t2, 'utf8'); if (x2.split(also[1]).length - 1 !== 1) { out.push({ id, killed: false, why: 'THE MUTANT\'S SECOND EDIT DID NOT APPLY' }); continue; } fs.writeFileSync(t2, x2.replace(also[1], () => also[2])); }
      const keep = results; results = [];
      let threw = null;
      try { await suite(await loadStack(dir, id)); } catch (e) { threw = e; }
      const failed = results.filter((r) => !r.ok).map((r) => r.name.split(' ')[0]);
      results = keep;
      const named = failed.filter((f) => want.includes(f));
      out.push({ id, killed: named.length > 0, why: named.length ? 'caught by ' + named.join(' ') : threw ? 'threw ' + String(threw.message || threw).slice(0, 80) + ' (no named check failed)' : 'no named check (' + want.join(' ') + ') failed; others failing: ' + (failed.join(' ') || 'none') });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  return out;
}

/* ------------------------------------------------------------------------------------------------ B: real IndexedDB in a real Chrome */
async function browserSuite() {
  const net = await import('node:net'), { spawn } = await import('node:child_process'), { withBrowser } = await import('./headless_cdp.mjs');
  const PORT = Number(process.env.ARENA_PORT || 8141), CDP = Number(process.env.ARENA_CDP || 9341), BASE = 'http://localhost:' + PORT;
  const listening = (p) => new Promise((res) => { const s = net.connect(p, '127.0.0.1'); s.once('connect', () => { s.destroy(); res(true); }); s.once('error', () => res(false)); });
  if (await listening(PORT)) { results.push({ name: 'B0 the devserver port is free', ok: false, detail: 'something already listens on ' + PORT + ' (a stale server would make this test read another tree); set ARENA_PORT' }); return; }
  const server = spawn(process.execPath, [path.join(here, 'devserver.mjs')], { cwd: root, env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore', windowsHide: true });
  try {
    for (let i = 0; i < 80 && !(await listening(PORT)); i++) await new Promise((r) => setTimeout(r, 150));
    await withBrowser({ port: CDP, width: 960, height: 640 }, async (page) => {
      const V5 = clone(FIX.v5), DBN = 'tc-browser-' + Date.now().toString(36);
      await page.navigate(BASE + '/pokemonarena/js/trainer_card.js');          // any page of the origin: the store is imported into it
      const run = (body) => page.eval('(async () => { const S = await import("/pokemonarena/js/store.js"); const TS = await import("/pokemonarena/js/trainer_store.js"); ' + body + ' })()');
      const readBack = (db, id) => 'let raw, hist; { const rb = await S.openStore({ dbName: ' + J(db) + ', channel: false }); raw = await rb.adapter.transact(["profiles"], "readonly", (tx) => tx.get("profiles", ' + J(id) + ')); hist = await rb.adapter.transact(["profileHistory"], "readonly", (tx) => tx.list("profileHistory")); await rb.close(); }';
      const keptOf = (raw) => ['teams', 'box', 'stats', 'tower', 'identity', 'trainerName', 'avatar', 'settings', '_unknown'].filter((k) => canon(raw[k]) !== canon(V5[k]));
      // B1
      const b1 = await run('const store = await S.openStore({ dbName: ' + J(DBN) + ', channel: false }); await store.adapter.transact(["profiles"], "readwrite", (tx) => tx.put("profiles", ' + J(V5) + ')); const r1 = await store.loadProfile(' + J(V5.id) + '); const r2 = await store.loadProfile(' + J(V5.id) + '); const st = store.status; await store.close(); ' + readBack(DBN, V5.id) + ' return { mode: st.mode, notSaved: st.notSaved, r1: { ok: r1.ok, mf: r1.migratedFrom, rev: r1.profile && r1.profile.rev }, r2: { ok: r2.ok, mf: r2.migratedFrom, rev: r2.profile && r2.profile.rev }, raw, hist };');
      const h1 = b1.hist.filter((h) => h.id === V5.id);
      results.push({ name: 'B1 REAL IndexedDB: a stored v5 profile is upgraded to 6 ONCE (the v5 document to history as "migration"), with the empty card; its teams, box, record, Tower record, name and portrait are kept', ok: b1.mode === 'indexeddb' && !b1.notSaved && b1.r1.ok && b1.r1.mf === 5 && b1.r1.rev === V5.rev + 1 && b1.r2.ok && b1.r2.mf === null && b1.r2.rev === V5.rev + 1 && b1.raw.schemaVersion === 6 && J(b1.raw.card) === J({ made: false, look: null, front: null, back: null, partner: null }) && h1.length === 1 && h1[0].reason === 'migration' && canon(h1[0].doc) === canon(V5) && keptOf(b1.raw).length === 0, detail: J({ mode: b1.mode, ns: b1.notSaved, r1: b1.r1, r2: b1.r2, sv: b1.raw && b1.raw.schemaVersion, hist: h1.map((h) => [h.rev, h.reason, h.doc.schemaVersion]), changed: b1.raw ? keptOf(b1.raw) : null }) });
      // B2: a reload, then the same database again
      await page.navigate(BASE + '/pokemonarena/js/trainer_card.js');
      const b2 = await run('const store = await S.openStore({ dbName: ' + J(DBN) + ', channel: false }); const r = await store.loadProfile(' + J(V5.id) + '); await store.close(); ' + readBack(DBN, V5.id) + ' return { mf: r.migratedFrom, rev: r.profile.rev, raw, hist };');
      results.push({ name: 'B2 after a RELOAD the v6 profile is read as it is: not migrated again, the revision does not move, one history entry', ok: b2.mf === null && b2.rev === V5.rev + 1 && b2.raw.rev === V5.rev + 1 && b2.hist.filter((h) => h.id === V5.id).length === 1, detail: J({ mf: b2.mf, rev: b2.rev, hist: b2.hist.length }) });
      // B3: the trainer app's save API on real IndexedDB
      const b3 = await run('const store = await S.openStore({ dbName: ' + J(DBN) + ', channel: false }); const u = await TS.updateTrainer(store, ' + J(V5.id) + ', { card: { made: true, front: 4, look: "w000002" } }); const c = await TS.createTrainer(store, { name: "NEWBIE", card: { made: true } }); const act = await store.getActiveId(); const list = await TS.listTrainers(store); await store.close(); ' + readBack(DBN, V5.id) + ' await new Promise((r) => { const q = indexedDB.deleteDatabase(' + J(DBN) + '); q.onsuccess = q.onerror = q.onblocked = () => r(); }); return { u: { ok: u.ok, code: u.code }, c: { ok: c.ok, id: c.id, code: c.code }, act, list, raw, hist };');
      results.push({ name: 'B3 REAL IndexedDB: trainer_store.js writes the card of the upgraded profile (history: migration, trainer) without touching its teams or record, and createTrainer makes a new trainer the active one', ok: b3.u.ok && b3.c.ok && b3.act === b3.c.id && b3.raw.card.made === true && b3.raw.card.front === 4 && keptOf(b3.raw).length === 0 && J(b3.hist.filter((h) => h.id === V5.id).map((h) => h.reason)) === J(['migration', 'trainer']) && b3.list.length === 2 && b3.list.some((x) => x.id === b3.c.id && x.active && x.name === 'NEWBIE'), detail: J({ u: b3.u, c: b3.c, act: b3.act, card: b3.raw && b3.raw.card, hist: b3.hist && b3.hist.map((h) => h.reason), list: b3.list }) });
      // B4: the real hub page, the real database
      const HV5 = { ...clone(FIX.v5), id: 'p_hubv5' };
      await page.eval('(async () => { try { localStorage.setItem("arena.welcome", "off"); } catch (_e) {} const S = await import("/pokemonarena/js/store.js"); const store = await S.openStore({ channel: false }); await store.adapter.transact(["profiles"], "readwrite", (tx) => tx.put("profiles", ' + J(HV5) + ')); await store.setActiveId("p_hubv5"); await store.close(); return true; })()');
      await page.navigate(BASE + '/pokemonarena/');
      const probe = '(async () => { const S = await import("/pokemonarena/js/store.js"); ' + readBack('pokemonarena', 'p_hubv5') + ' return { sv: raw && raw.schemaVersion, rev: raw && raw.rev, raw, hist: hist.filter((h) => h.id === "p_hubv5").map((h) => ({ reason: h.reason, sv: h.doc.schemaVersion, doc: h.doc })) }; })()';
      let hub = null;
      for (let i = 0; i < 120; i++) { try { hub = await page.eval(probe); } catch (_e) { hub = null; } if (hub && hub.sv === 6) break; await new Promise((r) => setTimeout(r, 500)); }
      results.push({ name: 'B4 the REAL HUB PAGE upgrades a v5 profile stored in the real "pokemonarena" database to 6 when it reads it (the v5 document to history as "migration"), keeping its teams and record', ok: !!hub && hub.sv === 6 && hub.rev === HV5.rev + 1 && hub.hist.length === 1 && hub.hist[0].reason === 'migration' && hub.hist[0].sv === 5 && canon(hub.hist[0].doc) === canon(HV5) && canon(hub.raw.teams) === canon(HV5.teams) && canon(hub.raw.stats) === canon(HV5.stats) && canon(hub.raw.box) === canon(HV5.box), detail: J(hub && { sv: hub.sv, rev: hub.rev, hist: hub.hist.map((h) => [h.reason, h.sv]) }) });
      await page.navigate(BASE + '/pokemonarena/');
      await new Promise((r) => setTimeout(r, 6000));          // the hub reads its data again after the ROM loads
      const again = await page.eval(probe);
      const title = await page.eval('document.title');
      results.push({ name: 'B5 a RELOAD of the hub reads the upgraded profile without migrating it again (same revision, still one history entry)', ok: again.sv === 6 && again.rev === HV5.rev + 1 && again.hist.length === 1, detail: J({ sv: again.sv, rev: again.rev, hist: again.hist.length, title }) });
    });
  } catch (e) {
    results.push({ name: 'B9 the browser part ran to the end', ok: false, detail: String(e && e.stack ? e.stack : e).slice(0, 400) });
  } finally { try { process.kill(server.pid); } catch (_e) { /* gone */ } }
}

const t0 = Date.now();
await suite(await loadStack(SRC));
if (WANT_BROWSER) await browserSuite();
const failed = results.filter((r) => !r.ok);
for (const r of results) if (!r.ok || process.env.ARENA_VERBOSE) console.log((r.ok ? 'ok   ' : 'FAIL ') + r.name + (r.ok ? '' : '\n       ' + r.detail));
console.log(`trainer card: ${results.length - failed.length} passed, ${failed.length} failed (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
let survived = 0;
if (WANT_MUTANTS) {
  const tm = Date.now(), res = await runMutants();
  for (const m of res) { console.log((m.killed ? 'killed   ' : 'SURVIVED ') + m.id + ' -- ' + m.why); if (!m.killed) survived++; }
  console.log(`mutants: ${res.length - survived}/${res.length} killed (${((Date.now() - tm) / 1000).toFixed(1)} s)`);
}
process.exit(failed.length || survived ? 1 : 0);

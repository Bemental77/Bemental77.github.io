// tools/pokemonarena_online_prefs_test.mjs -- THE ONLINE PREFERENCES (pokemonarena/js/online_prefs.js: which team and what battle size this browser plays online with), in Node.
//
//   node tools/pokemonarena_online_prefs_test.mjs             the cases
//   node tools/pokemonarena_online_prefs_test.mjs --mutants   ALSO break online_prefs.js one way at a time; every break must fail a case
//
// What is proved: the stored value is read back exactly, and nothing that is not a preference is ever believed (junk, another shape, a team key that is not one, a size that is not one, a storage
// that throws); a write changes only what it names, forgets on null, refuses a value that is not one WITHOUT writing, and leaves no empty record behind; and what the battle page pre-selects
// (preselect): the preferred team while the page still lists it, the page's own first choice when it is gone or not legal any more, an address's own team and format before any preference, the
// preferred size, the old default otherwise, and never 3v3 for a team of fewer than three. The page half (online.js really selecting it, an accepted challenge really playing it) is
// tools/pokemonarena_online_page_test.mjs, group `tokens` (cases TP).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const SRC = path.join(root, 'pokemonarena', 'js');
const WANT_MUTANTS = process.argv.includes('--mutants');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, detail) { if (cond) pass++; else { fail++; failures.push(name + (detail ? ' :: ' + detail : '')); if (!process.env.ARENA_QUIET) console.log('FAIL', name, detail || ''); } }
const J = (x) => JSON.stringify(x);
const memStorage = (init = {}) => { const store = { ...init }; return { store, getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } }; };

async function suite(OP, PR) {
  const K = OP.ONLINE_TEAM_KEY, SAVED = 'saved:p_ab12:t_cd34';
  /* A. reading */
  {
    ok(K === 'arena.online.team' && J(OP.ONLINE_FMTS) === J(['3v3', '6v6']), 'A1 the preferences live under arena.online.team; the sizes are 3v3 and 6v6', K);
    ok(J(OP.readOnlinePrefs(memStorage())) === J({ teamKey: null, fmt: null }) && J(OP.readOnlinePrefs(null)) === J({ teamKey: null, fmt: null }), 'A2 nothing stored, or no storage: no preference', '');
    ok(J(OP.readOnlinePrefs(memStorage({ [K]: J({ teamKey: SAVED, fmt: '6v6' }) }))) === J({ teamKey: SAVED, fmt: '6v6' }), 'A3 a stored team and size are read back', '');
    ok(J(OP.readOnlinePrefs(memStorage({ [K]: J({ teamKey: 'random', fmt: null }) }))) === J({ teamKey: 'random', fmt: null }), 'A4 "a random team" is a preference too, and a size may be missing', '');
    const junk = ['', 'x', '7', 'null', '[]', '["saved:a:b","6v6"]', '{"teamKey":7}', J({ teamKey: 'paste', fmt: '9v9' }), J({ teamKey: 'url', fmt: 3 }), J({ teamKey: 'saved:a', fmt: '3V3' }), J({ teamKey: 'saved:a:b:c' }), J({ teamKey: 'saved:a b:c' }), J({ teamKey: 'saved::t' }), J({ teamKey: 'saved:' + 'p'.repeat(41) + ':t' }), J({ teamKey: 'SAVED:a:b' }), J({ teamKey: ' random' }), J({ key: SAVED, fmt: '6v6 ' })];
    const believed = junk.filter((j) => J(OP.readOnlinePrefs(memStorage({ [K]: j }))) !== J({ teamKey: null, fmt: null }));
    ok(believed.length === 0, 'A5 nothing that is not a preference is believed (' + junk.length + ' kinds of junk: another shape, a team key that is not one, a size that is not one)', J(believed));
    ok(J(OP.readOnlinePrefs(memStorage({ [K]: J({ teamKey: 'nope', fmt: '3v3' }) }))) === J({ teamKey: null, fmt: '3v3' }) && J(OP.readOnlinePrefs(memStorage({ [K]: J({ teamKey: SAVED, fmt: 'nope' }) }))) === J({ teamKey: SAVED, fmt: null }), 'A6 each field is judged by itself: a bad team key does not cost the size, nor a bad size the team', '');
    ok(J(OP.readOnlinePrefs(memStorage({ [K]: J({ teamKey: SAVED, fmt: '6v6', pad: 'x'.repeat(500) }) }))) === J({ teamKey: null, fmt: null }), 'A7 a stored value far longer than a preference is not one of ours', '');
    const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
    ok(J(OP.readOnlinePrefs(blocked)) === J({ teamKey: null, fmt: null }) && OP.writeOnlinePrefs(blocked, { fmt: '3v3' }) === false, 'A8 a storage that throws reads as no preference and writes nothing', '');
  }
  /* B. the team key */
  {
    ok(OP.savedTeamKey('p_ab12', 't_cd34') === SAVED && J(OP.parseTeamKey(SAVED)) === J({ kind: 'saved', profileId: 'p_ab12', teamId: 't_cd34' }) && J(OP.parseTeamKey('random')) === J({ kind: 'random' }), 'B1 a saved team\'s key is saved:<profile id>:<team id>, and it reads back', '');
    ok([['', 't'], ['p', ''], ['p:q', 't'], ['p', 't t'], [7, 't'], [null, null], ['p'.repeat(41), 't']].every(([a, b]) => OP.savedTeamKey(a, b) === null) && ['paste', 'url', '', null, undefined, 7, 'saved:a', 'random '].every((k) => OP.parseTeamKey(k) === null), 'B2 ids that are not ids make no key, and "paste" / "url" / anything else is not a team key', '');
    const ids = ['p_ab12', 'T-9', 'a', 'x'.repeat(40), 'x'.repeat(41), '', 'a b', 'a:b', String.fromCharCode(0xe9), 'a.b'];
    const differ = ids.filter((id) => PR.isId(id) !== (OP.savedTeamKey(id, 't') !== null) || PR.isId(id) !== (OP.savedTeamKey('p', id) !== null));
    ok(differ.length === 0, 'B3 a key takes exactly the ids profile.js calls ids (' + ids.length + ' compared, both positions)', J(differ));
  }
  /* C. writing */
  {
    const m = memStorage();
    ok(OP.writeOnlinePrefs(m, { teamKey: SAVED, fmt: '6v6' }) === true && J(JSON.parse(m.store[K])) === J({ teamKey: SAVED, fmt: '6v6' }), 'C1 a write stores the team and the size', J(m.store));
    ok(OP.writeOnlinePrefs(m, { fmt: '3v3' }) === true && J(OP.readOnlinePrefs(m)) === J({ teamKey: SAVED, fmt: '3v3' }), 'C2 a write changes only what it names: the size alone leaves the team', J(m.store));
    ok(OP.writeOnlinePrefs(m, { teamKey: 'random' }) === true && J(OP.readOnlinePrefs(m)) === J({ teamKey: 'random', fmt: '3v3' }), 'C3 ... and the team alone leaves the size', J(m.store));
    const before = m.store[K];
    const refused = [{ teamKey: 'paste' }, { teamKey: 'saved:a' }, { teamKey: 7 }, { fmt: '9v9' }, { fmt: 3 }, { teamKey: SAVED, fmt: 'nope' }, { teamKey: 'nope', fmt: '6v6' }, { teamKey: undefined }, { fmt: undefined }];
    ok(refused.every((p) => OP.writeOnlinePrefs(m, p) === false) && m.store[K] === before, 'C4 a value that is not one is refused and NOTHING is written (not even the good half of the patch)', J(m.store));
    ok(OP.writeOnlinePrefs(m, null) === false && OP.writeOnlinePrefs(m, 'x') === false && OP.writeOnlinePrefs(null, { fmt: '3v3' }) === false && m.store[K] === before, 'C5 no patch, or no storage: nothing', '');
    ok(OP.writeOnlinePrefs(m, { teamKey: null }) === true && J(OP.readOnlinePrefs(m)) === J({ teamKey: null, fmt: '3v3' }), 'C6 null forgets a field', J(m.store));
    ok(OP.writeOnlinePrefs(m, { fmt: null }) === true && !(K in m.store), 'C7 and when nothing is left to prefer the key is removed, not left holding an empty record', J(m.store));
    ok(OP.writeOnlinePrefs(m, {}) === true && !(K in m.store), 'C8 an empty patch changes nothing', J(m.store));
    const junk = memStorage({ [K]: 'garbage' });
    ok(OP.writeOnlinePrefs(junk, { fmt: '6v6' }) === true && J(OP.readOnlinePrefs(junk)) === J({ teamKey: null, fmt: '6v6' }), 'C9 a write over junk starts from no preference', J(junk.store));
    const deaf = memStorage(); deaf.setItem = () => {};
    ok(OP.writeOnlinePrefs(deaf, { fmt: '6v6' }) === false, 'C10 a storage that does not keep what it is given is reported (false), not assumed', '');
    const other = memStorage({ 'arena.online.name': 'RED', 'arena.open': '1' });
    OP.writeOnlinePrefs(other, { teamKey: SAVED }); OP.writeOnlinePrefs(other, { teamKey: null });
    ok(other.store['arena.online.name'] === 'RED' && other.store['arena.open'] === '1' && Object.keys(other.store).length === 2, 'C11 no other key of the browser is touched (the trainer name stays where it is)', J(other.store));
  }
  /* D. what the battle page pre-selects */
  {
    const A = 'saved:p1:t1', B = 'saved:p1:t2', C = 'saved:p2:t9';
    const list = [{ key: A, size: 6 }, { key: B, size: 3 }, { key: C, size: 2 }, { key: 'random', size: 6 }, { key: 'paste', size: 6 }];
    const pre = (prefs, choices = list, o = {}) => OP.preselect(prefs, choices, o);
    ok(J(pre({ teamKey: null, fmt: null })) === J({ teamKey: A, fmt: '6v6' }) && J(pre(null)) === J({ teamKey: A, fmt: '6v6' }) && J(pre(undefined)) === J({ teamKey: A, fmt: '6v6' }), 'D1 with no preference the page selects what it always did: its first team, 6v6 for a saved team of six', J(pre({ teamKey: null, fmt: null })));
    ok(J(pre({ teamKey: B, fmt: null })) === J({ teamKey: B, fmt: '3v3' }), 'D2 the preferred team is selected when the page lists it (and a team of three defaults to 3v3)', J(pre({ teamKey: B, fmt: null })));
    ok(J(pre({ teamKey: 'saved:p1:gone', fmt: null })) === J({ teamKey: A, fmt: '6v6' }), 'D3 a preferred team that is gone (or not legal any more: the page lists legal teams only) falls back to the first team', J(pre({ teamKey: 'saved:p1:gone', fmt: null })));
    ok(J(pre({ teamKey: 'random', fmt: null })) === J({ teamKey: 'random', fmt: '3v3' }), 'D4 "a random team" can be preferred; its default size is 3v3', J(pre({ teamKey: 'random', fmt: null })));
    ok(J(pre({ teamKey: A, fmt: '3v3' })) === J({ teamKey: A, fmt: '3v3' }) && J(pre({ teamKey: 'random', fmt: '6v6' })) === J({ teamKey: 'random', fmt: '6v6' }) && J(pre({ teamKey: null, fmt: '3v3' })) === J({ teamKey: A, fmt: '3v3' }), 'D5 the preferred size is selected, whichever team it is with', '');
    ok(J(pre({ teamKey: A, fmt: '3v3' }, list, { formatParam: '6v6' })) === J({ teamKey: A, fmt: '6v6' }) && J(pre({ teamKey: A, fmt: '6v6' }, list, { formatParam: '3v3' })) === J({ teamKey: A, fmt: '3v3' }), 'D6 the address\'s format= comes before the preferred size (an accepted challenge is 3v3 whatever is preferred)', '');
    ok(J(pre({ teamKey: A, fmt: '3v3' }, list, { formatParam: 'nope' })) === J({ teamKey: A, fmt: '3v3' }) && J(pre({ teamKey: A, fmt: null }, list, { formatParam: null })) === J({ teamKey: A, fmt: '6v6' }), 'D7 a format= that is not one is no format', '');
    ok(J(pre({ teamKey: C, fmt: '3v3' })) === J({ teamKey: C, fmt: '6v6' }) && J(pre({ teamKey: C, fmt: null }, list, { formatParam: '3v3' })) === J({ teamKey: C, fmt: '6v6' }), 'D8 a team of fewer than three is never 3v3, whatever the preference or the address says', J(pre({ teamKey: C, fmt: '3v3' })));
    const withUrl = [{ key: 'url', size: 6 }, ...list];
    ok(J(pre({ teamKey: B, fmt: null }, withUrl)) === J({ teamKey: 'url', fmt: '6v6' }), 'D9 an address that brings its own team keeps it: the preference does not override the address', J(pre({ teamKey: B, fmt: null }, withUrl)));
    ok(J(pre({ teamKey: 'paste', fmt: null })) === J({ teamKey: A, fmt: '6v6' }) && J(pre({ teamKey: 7, fmt: 7 })) === J({ teamKey: A, fmt: '6v6' }), 'D10 a preference that is not one selects the first team', '');
    const onlyRandom = [{ key: 'random', size: 6 }, { key: 'paste', size: 6 }];
    ok(J(pre({ teamKey: A, fmt: null }, onlyRandom)) === J({ teamKey: 'random', fmt: '3v3' }), 'D11 a browser with no saved team left selects the random team (3v3), whatever was preferred', J(pre({ teamKey: A, fmt: null }, onlyRandom)));
    ok(J(pre({ teamKey: A, fmt: null }, [])) === J({ teamKey: null, fmt: '3v3' }) && J(pre({ teamKey: A, fmt: null }, null)) === J({ teamKey: null, fmt: '3v3' }), 'D12 an empty list selects nothing and does not throw', '');
    // through the storage, end to end: what the hub wrote is what the battle page selects
    const m = memStorage();
    OP.writeOnlinePrefs(m, { teamKey: B, fmt: '6v6' });
    ok(J(OP.preselect(OP.readOnlinePrefs(m), list, {})) === J({ teamKey: B, fmt: '6v6' }), 'D13 what the hub wrote is what the battle page selects', J(m.store));
  }
}

/* ------------------------------------------------------------------------------------------------ the mutants */
const MUTANTS = [
  { id: 'read-any-team', why: 'any string is believed as a team key', from: 'if (isTeamKey(j.teamKey)) out.teamKey = j.teamKey;', to: "if (typeof j.teamKey === 'string') out.teamKey = j.teamKey;" },
  { id: 'read-any-fmt', why: 'any value is believed as a battle size', from: 'if (isFmt(j.fmt)) out.fmt = j.fmt;', to: 'if (j.fmt) out.fmt = j.fmt;' },
  { id: 'read-array', why: 'an array is read as a record', from: "if (!j || typeof j !== 'object' || Array.isArray(j)) return out;", to: 'if (!j) return out;', also: [{ from: "if (isTeamKey(j.teamKey)) out.teamKey = j.teamKey;", to: "if (isTeamKey(j.teamKey) || isTeamKey(j[0])) out.teamKey = j.teamKey || j[0];" }] },
  { id: 'read-any-length', why: 'a stored value of any length is parsed', from: "if (typeof raw !== 'string' || !raw || raw.length > MAX_STORED) return out;", to: "if (typeof raw !== 'string' || !raw) return out;" },
  { id: 'read-throws', why: 'a storage that throws breaks the page', from: "  } catch (_e) { /* blocked or corrupt: no preference */ }\n", to: "  } finally { /* nothing */ }\n" },
  { id: 'key-paste', why: '"paste" counts as a team key', from: "  if (teamKey === RANDOM_TEAM) return { kind: 'random' };", to: "  if (teamKey === RANDOM_TEAM || teamKey === 'paste') return { kind: 'random' };" },
  { id: 'key-loose-ids', why: 'a saved key takes ids that are not ids', from: "const ID = '[A-Za-z0-9_-]{1,40}';", to: "const ID = '[^:]{1,60}';" },
  { id: 'write-unchecked-team', why: 'a write stores a team key that is not one', from: "if ('teamKey' in patch) { if (patch.teamKey !== null && !isTeamKey(patch.teamKey)) return false; next.teamKey = patch.teamKey; }", to: "if ('teamKey' in patch) { next.teamKey = patch.teamKey; }" },
  { id: 'write-unchecked-fmt', why: 'a write stores a size that is not one', from: "if ('fmt' in patch) { if (patch.fmt !== null && !isFmt(patch.fmt)) return false; next.fmt = patch.fmt; }", to: "if ('fmt' in patch) { next.fmt = patch.fmt; }" },
  { id: 'write-clobbers', why: 'a write of one field forgets the other', from: 'const next = readOnlinePrefs(storage);', to: 'const next = { teamKey: null, fmt: null };' },
  { id: 'write-leaves-empty', why: 'forgetting everything leaves an empty record behind', from: 'if (next.teamKey === null && next.fmt === null) storage.removeItem(ONLINE_TEAM_KEY);\n    else storage', to: 'storage' },
  { id: 'write-unverified', why: 'a write that did not stick is reported as done', from: "    const now = readOnlinePrefs(storage);\n    return now.teamKey === next.teamKey && now.fmt === next.fmt;", to: '    return true;' },
  { id: 'pre-ignores-team', why: 'the preferred team is never selected', from: "const wanted = first.key === 'url' || !isTeamKey(p.teamKey) ? null : list.find((c) => c.key === p.teamKey) || null;", to: 'const wanted = null;' },
  { id: 'pre-keeps-missing', why: 'a preferred team the page does not list is selected anyway', from: 'const sel = wanted || first;', to: "const sel = wanted || (typeof p.teamKey === 'string' ? { key: p.teamKey, size: 6 } : first);" },
  { id: 'pre-overrides-address-team', why: 'the preference overrides the team an address brings', from: "const wanted = first.key === 'url' || !isTeamKey(p.teamKey) ? null : list.find((c) => c.key === p.teamKey) || null;", to: 'const wanted = !isTeamKey(p.teamKey) ? null : list.find((c) => c.key === p.teamKey) || null;' },
  { id: 'pre-any-key', why: 'a preference that is not a team key ("paste") is selected when the page happens to list that key', from: "const wanted = first.key === 'url' || !isTeamKey(p.teamKey) ? null : list.find((c) => c.key === p.teamKey) || null;", to: "const wanted = first.key === 'url' ? null : list.find((c) => c.key === p.teamKey) || null;" },
  { id: 'pre-ignores-fmt', why: 'the preferred size is never selected', from: "isFmt(o.formatParam) ? o.formatParam : isFmt(p.fmt) ? p.fmt : size >= 6 && own ? '6v6' : '3v3';", to: "isFmt(o.formatParam) ? o.formatParam : size >= 6 && own ? '6v6' : '3v3';" },
  { id: 'pre-pref-beats-address', why: 'the preferred size overrides the address\'s format', from: "isFmt(o.formatParam) ? o.formatParam : isFmt(p.fmt) ? p.fmt : size >= 6 && own ? '6v6' : '3v3';", to: "isFmt(p.fmt) ? p.fmt : isFmt(o.formatParam) ? o.formatParam : size >= 6 && own ? '6v6' : '3v3';" },
  { id: 'pre-small-team-3v3', why: 'a team of two can be sent into 3v3', from: "  if (size < 3) fmt = '6v6';\n", to: '' },
  { id: 'pre-default-of-first', why: 'the default size is the first team\'s, not the selected team\'s', from: 'const size = Number.isInteger(sel.size) ? sel.size : 6;', to: 'const size = Number.isInteger(first.size) ? first.size : 6;' },
  { id: 'pre-random-6v6', why: 'a random team defaults to 6v6', from: "const own = sel.key !== RANDOM_TEAM && sel.key !== 'paste';", to: 'const own = true;' },
];

async function loadFrom(dir, file) { return import(pathToFileURL(path.join(dir, file)).href + '?x=' + Math.random().toString(36).slice(2)); }
async function runMutants() {
  const out = [];
  for (const mu of MUTANTS) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-prefs-mut-'));
    try {
      for (const f of ['online_prefs.js', 'profile.js']) fs.copyFileSync(path.join(SRC, f), path.join(dir, f));
      const target = path.join(dir, 'online_prefs.js');
      let text = fs.readFileSync(target, 'utf8'), bad = null;
      for (const step of [mu, ...(mu.also || [])]) { const n = text.split(step.from).length - 1; if (n !== 1) { bad = 'PATTERN FOUND ' + n + 'x (the mutant did not apply once): ' + step.from.slice(0, 50); break; } text = text.replace(step.from, () => step.to); }
      if (bad) { out.push({ id: mu.id, killed: false, why: bad }); continue; }
      fs.writeFileSync(target, text);
      const before = fail, saveQ = process.env.ARENA_QUIET; process.env.ARENA_QUIET = '1';
      let threw = null;
      try { await suite(await loadFrom(dir, 'online_prefs.js'), PR); } catch (e) { threw = e; }
      out.push({ id: mu.id, killed: fail > before || !!threw, why: mu.why, threw: threw ? String(threw.message || threw).slice(0, 80) : null });
      fail = before; failures.length = Math.min(failures.length, before);
      process.env.ARENA_QUIET = saveQ || '';
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  return out;
}

const OP = await import(pathToFileURL(path.join(SRC, 'online_prefs.js')).href);
const PR = await import(pathToFileURL(path.join(SRC, 'profile.js')).href);
const t0 = Date.now();
await suite(OP, PR);
console.log(`online prefs: ${pass} passed, ${fail} failed (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
let survived = 0;
if (WANT_MUTANTS) {
  const keep = fail, keepFailures = failures.slice();
  const res = await runMutants();
  fail = keep; failures.length = 0; failures.push(...keepFailures);
  for (const m of res) { console.log((m.killed ? 'killed  ' : 'SURVIVED') + ' ' + m.id + ' -- ' + m.why + (m.threw ? ' (threw: ' + m.threw + ')' : '') + (m.killed ? '' : '  <-- the suite did not notice')); if (!m.killed) survived++; }
  console.log(`mutants: ${res.length - survived}/${res.length} killed`);
}
if (fail || survived) { console.log('\nFAILURES:\n  ' + failures.join('\n  ')); process.exit(1); }

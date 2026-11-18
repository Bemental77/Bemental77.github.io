// pokemonarena/js/online_prefs.js -- THE ONLINE PREFERENCES: which team and what battle size this browser plays online with (pokemonarena/INAPP.md "Contract 2").
//
// Pure ES module (browser + Node): no DOM, no clock, no network; the storage is injected. tools/pokemonarena_online_prefs_test.mjs runs it in Node.
//
// WHY IT EXISTS. All choosing happens in the hub's picture (the `online` app: TEAM, SIZE), but the battle is another page. A preference is not a token: it starts nothing, it only says what the
// battle page PRE-SELECTS where it pre-selects today (js/online.js setupForm), and what the page an accepted challenge opens plays with. The trainer NAME is not here: it stays where it is
// (localStorage 'arena.online.name', online.js: only a name the player typed).
//
//   localStorage 'arena.online.team' = '{"teamKey":"saved:<profileId>:<teamId>","fmt":"6v6"}'
//     teamKey   'saved:<profileId>:<teamId>' (the keys online.js gives its saved teams) | 'random' | null (no preference)
//     fmt       '3v3' | '6v6' | null
//
//   readOnlinePrefs(storage)          -> { teamKey, fmt }   never throws; anything that is not a preference reads as null
//   writeOnlinePrefs(storage, patch)  -> boolean            patch: { teamKey?, fmt? }; a key left out keeps what is stored, null forgets it; a value that is not one is refused (nothing is written)
//   preselect(prefs, choices, o)      -> { teamKey, fmt }   what the battle page selects: the preferred team when the page still lists it, else the page's own first choice (today's default)

export const ONLINE_TEAM_KEY = 'arena.online.team';
export const ONLINE_FMTS = Object.freeze(['3v3', '6v6']);
export const RANDOM_TEAM = 'random';
const ID = '[A-Za-z0-9_-]{1,40}';                                   // what profile.js isId accepts (a test compares the two)
const SAVED_RE = new RegExp('^saved:(' + ID + '):(' + ID + ')$');
const MAX_STORED = 400;                                            // a stored value longer than this is not one of ours

/** 'saved:<profileId>:<teamId>' for a saved team, or null when either id is not an id. */
export function savedTeamKey(profileId, teamId) {
  const k = 'saved:' + profileId + ':' + teamId;
  return typeof profileId === 'string' && typeof teamId === 'string' && SAVED_RE.test(k) ? k : null;
}
/** -> { kind: 'saved', profileId, teamId } | { kind: 'random' } | null (not a team key). */
export function parseTeamKey(teamKey) {
  if (teamKey === RANDOM_TEAM) return { kind: 'random' };
  const m = typeof teamKey === 'string' ? SAVED_RE.exec(teamKey) : null;
  return m ? { kind: 'saved', profileId: m[1], teamId: m[2] } : null;
}
const isTeamKey = (k) => parseTeamKey(k) !== null;
const isFmt = (f) => ONLINE_FMTS.includes(f);

/** The stored preferences. Never throws and never trusts the stored value: a blocked storage, junk, or a field that is not one reads as null. */
export function readOnlinePrefs(storage) {
  const out = { teamKey: null, fmt: null };
  try {
    const raw = storage ? storage.getItem(ONLINE_TEAM_KEY) : null;
    if (typeof raw !== 'string' || !raw || raw.length > MAX_STORED) return out;
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object' || Array.isArray(j)) return out;
    if (isTeamKey(j.teamKey)) out.teamKey = j.teamKey;
    if (isFmt(j.fmt)) out.fmt = j.fmt;
  } catch (_e) { /* blocked or corrupt: no preference */ }
  return out;
}

/**
 * Change the stored preferences. patch: { teamKey?, fmt? }: a key that is left out keeps what is stored; null forgets it; anything else must be a team key / a format, or NOTHING is written.
 * -> true when the storage now holds what was asked for.
 */
export function writeOnlinePrefs(storage, patch) {
  try {
    if (!storage || !patch || typeof patch !== 'object') return false;
    const next = readOnlinePrefs(storage);
    if ('teamKey' in patch) { if (patch.teamKey !== null && !isTeamKey(patch.teamKey)) return false; next.teamKey = patch.teamKey; }
    if ('fmt' in patch) { if (patch.fmt !== null && !isFmt(patch.fmt)) return false; next.fmt = patch.fmt; }
    if (next.teamKey === null && next.fmt === null) storage.removeItem(ONLINE_TEAM_KEY);
    else storage.setItem(ONLINE_TEAM_KEY, JSON.stringify({ teamKey: next.teamKey, fmt: next.fmt }));
    const now = readOnlinePrefs(storage);
    return now.teamKey === next.teamKey && now.fmt === next.fmt;
  } catch (_e) { return false; }
}

/**
 * WHAT THE BATTLE PAGE PRE-SELECTS (online.js setupForm; the page an accepted challenge opens plays with exactly this).
 *   prefs    readOnlinePrefs(...)
 *   choices  the page's own team list, in its own order: [{ key, size }]. The first one is what the page selected before there were preferences. A saved team is on the list only while it
 *            exists and is legal, so "the preferred team is gone or not legal" is simply "its key is not on the list".
 *   o        { formatParam }: the address's format= ('6v6' | '3v3' | anything else = none)
 * -> { teamKey, fmt }
 *   teamKey  an address that brings its own team (the page lists it first, key 'url') keeps it; else the preferred team when it is on the list; else the first on the list
 *   fmt      the address's format; else the preferred size; else the default for the team selected (6v6 for a team of six that is the player's own, 3v3 otherwise). A team of fewer than three
 *            Pokemon cannot play 3v3: it is always 6v6
 */
export function preselect(prefs, choices, o = {}) {
  const list = Array.isArray(choices) ? choices.filter((c) => c && typeof c.key === 'string') : [];
  if (!list.length) return { teamKey: null, fmt: '3v3' };
  const p = prefs && typeof prefs === 'object' ? prefs : {};
  const first = list[0];
  const wanted = first.key === 'url' || !isTeamKey(p.teamKey) ? null : list.find((c) => c.key === p.teamKey) || null;
  const sel = wanted || first;
  const size = Number.isInteger(sel.size) ? sel.size : 6;
  const own = sel.key !== RANDOM_TEAM && sel.key !== 'paste';
  let fmt = isFmt(o.formatParam) ? o.formatParam : isFmt(p.fmt) ? p.fmt : size >= 6 && own ? '6v6' : '3v3';
  if (size < 3) fmt = '6v6';
  return { teamKey: sel.key, fmt };
}

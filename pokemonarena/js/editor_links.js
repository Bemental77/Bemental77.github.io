// pokemonarena/js/editor_links.js -- the links the editor builds to other pokemonarena pages, and the router's hash grammar.
//
// Pure ES module (browser + Node): strings in, strings out, no DOM. Kept apart so a test can assert the exact query the "Test battle" button
// produces without a browser, and so the contract with the battle page lives in ONE place:
//
//   battle.html?team=<ARENA1.* team code>&foe=random|<ARENA1.* code>&seed=<u32>&format=6v6|3v3&cpu=easy|normal|hard
//
// With no params battle.html starts a Quick Battle; a bad ?team= is that page's problem (it shows an error screen and never executes the
// value). THIS side's job is to produce only values it has validated: a team code that looks like a team code, a seed that is an unsigned
// 32-bit integer, and the three enumerations spelled exactly as the contract spells them.

export const BATTLE_PAGE = '/pokemonarena/battle.html';
export const FORMATS = Object.freeze(['6v6', '3v3']);
export const CPU_LEVELS = Object.freeze(['easy', 'normal', 'hard']);
export const CODE_RE = /^ARENA1\.[A-Za-z0-9_-]+\.[0-9a-fA-F]{4}$/;
export const MAX_URL_CODE_CHARS = 1024;

/**
 * The battle format a team of this size defaults to: exactly three Pokemon play 3v3 (battle.html needs three on each side to pick three);
 * every other size plays 6v6, which means "every Pokemon of both teams" (so a team of one or two is fine there, and battle.html refuses
 * 3v3 for it). Corrected in W1: this used to answer 3v3 for one or two Pokemon, which the battle page then refused.
 */
export function formatForTeamSize(n) { return n === 3 ? '3v3' : '6v6'; }
/** The formats a team of this size may choose: 3v3 needs at least three Pokemon. */
export function formatsForTeamSize(n) { return n >= 3 ? ['6v6', '3v3'] : ['6v6']; }

export const isTeamCode = (s) => typeof s === 'string' && s.length <= MAX_URL_CODE_CHARS && CODE_RE.test(s);
const isU32 = (n) => Number.isInteger(n) && n >= 0 && n <= 0xffffffff;

/**
 * Build the battle URL. opts: team (code, required), foe ('random' | a team code; default 'random'), seed (u32; omitted when undefined),
 * format ('6v6' | '3v3'), cpu ('easy' | 'normal' | 'hard'), base (default BATTLE_PAGE). Throws RangeError on any value outside the contract,
 * so a bug cannot ship a malformed link.
 */
export function battleUrl({ team, foe = 'random', seed, format, cpu, base = BATTLE_PAGE } = {}) {
  if (!isTeamCode(team)) throw new RangeError('team must be an ARENA1 team code');
  if (foe !== 'random' && !isTeamCode(foe)) throw new RangeError('foe must be "random" or an ARENA1 team code');
  const q = [['team', team], ['foe', foe]];
  if (seed !== undefined) { if (!isU32(seed)) throw new RangeError('seed must be an unsigned 32-bit integer'); q.push(['seed', String(seed)]); }
  if (format !== undefined) { if (!FORMATS.includes(format)) throw new RangeError('format must be 6v6 or 3v3'); q.push(['format', format]); }
  if (cpu !== undefined) { if (!CPU_LEVELS.includes(cpu)) throw new RangeError('cpu must be easy, normal or hard'); q.push(['cpu', cpu]); }
  return base + '?' + q.map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
}

/** The inverse, for tests and for a page that wants to show what a link carries. Returns { team, foe, seed, format, cpu } (absent = undefined). */
export function parseBattleUrl(url) {
  const i = String(url).indexOf('?');
  const q = new URLSearchParams(i < 0 ? '' : String(url).slice(i + 1));
  const out = { path: i < 0 ? String(url) : String(url).slice(0, i), team: q.get('team') || undefined, foe: q.get('foe') || undefined, format: q.get('format') || undefined, cpu: q.get('cpu') || undefined };
  out.seed = q.has('seed') ? Number(q.get('seed')) : undefined;
  return out;
}

/** A fresh seed from a byte source (crypto.getRandomValues in the page): an unsigned 32-bit integer. */
export function seedFrom(randomBytes) { const b = randomBytes(4); return ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0; }

// ---------------------------------------------------------------------------------------------
// the editor's own route grammar (location.hash)
// ---------------------------------------------------------------------------------------------

export const TABS = Object.freeze(['build', 'moves', 'stats']);
const ID = '[A-Za-z0-9_-]{1,40}';

/** '#/team/t_1/mon/m_2/stats' -> { name: 'mon', teamId, monId, tab }. Anything unknown parses to the profile screen. */
export function parseRoute(hash) {
  const h = String(hash || '').replace(/^#/, '');
  let m;
  if ((m = new RegExp(`^/team/(${ID})/mon/(${ID})(?:/(build|moves|stats))?$`).exec(h))) return { name: 'mon', teamId: m[1], monId: m[2], tab: m[3] || 'build' };
  if ((m = new RegExp(`^/team/(${ID})$`).exec(h))) return { name: 'team', teamId: m[1] };
  if (h === '/teams') return { name: 'teams' };
  if (h === '/import') return { name: 'import' };
  return { name: 'profiles' };
}
export function routeHash(r) {
  if (r.name === 'import') return '#/import';
  if (r.name === 'mon') return `#/team/${r.teamId}/mon/${r.monId}${r.tab && r.tab !== 'build' ? '/' + r.tab : ''}`;
  if (r.name === 'team') return `#/team/${r.teamId}`;
  if (r.name === 'teams') return '#/teams';
  return '#/profiles';
}

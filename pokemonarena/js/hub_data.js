// pokemonarena/js/hub_data.js -- what the hub (and the battle page's "Edit team" button) needs from the browser-local store: the player's
// profiles and teams as short summaries, a team code for one team, and the URLs that lead into battle.html and editor.html.
//
// ES module (browser + Node 24; the store is injected, so Node tests pass a memory-backed one). Nothing here touches the DOM, a clock or
// Math.random: a seed is passed in. Nothing leaves the browser.
//
//   const store = await openStore();
//   const data = await readHubData(store, pack, { towerSummary });   // { state, profiles: [{ id, name, readOnly, teams: [{ id, name, size, legal, problems, names, lead, ruleset }], record: { battles, resettable, pages }, tower }], activeId, notSaved }
//      `towerSummary(towerRecord, pack)` (tower_session.js summarizeTower) is passed in by the page once the Tower's code has loaded, so the hub does not carry the engine just to list teams; until then `tower` is null.
//   const r = await teamCodeFor(store, profileId, teamId); // { ok: true, code } | { ok: false, message }
//   battleHref({ mode: 'team', code, format: '3v3', cpu: 'normal', seed })   // '/pokemonarena/battle.html?team=...'
//   await findTeamForCode(store, code)                    // { profileId, teamId } | null  (which saved team a battle was started with)

import { teamMons, validateMonList } from './profile.js';
import { buildRecordPages, buildRecordNotice } from './record_model.js';
import { battleCount } from './career_stats.js';
import { teamFromProfile, encodeTeamCode } from './teamcode.js';
import { battleUrl, BATTLE_PAGE, FORMATS, CPU_LEVELS } from './editor_links.js';

export const EDITOR_PAGE = '/pokemonarena/editor.html';
export const HUB_PAGE = '/pokemonarena/';

// Pokemon that stand on the title screen, by name (resolved against the pack, so a species this ROM lacks is skipped, never guessed by number)
export const MASCOT_NAMES = Object.freeze(['Pikachu', 'Charizard', 'Blastoise', 'Venusaur', 'Lapras', 'Snorlax', 'Gengar', 'Lucario', 'Garchomp', 'Rayquaza', 'Lugia', 'Metagross', 'Salamence', 'Eevee', 'Gyarados']);

/** The mascot species ids this pack can draw, in MASCOT_NAMES order. */
export function mascotIds(pack) {
  const out = [];
  for (const n of MASCOT_NAMES) { const id = pack.species.findIndex((s) => s && s.legal && s.name === n); if (id > 0) out.push(id); }
  return out;
}
/** One of them for a given day number (days since the epoch): the title screen changes day to day, and a test can pass a fixed day. */
export function pickMascot(pack, day) {
  const ids = mascotIds(pack);
  if (!ids.length) { const first = pack.species.findIndex((s) => s && s.legal); return first > 0 ? first : 1; }
  return ids[((Math.floor(day) % ids.length) + ids.length) % ids.length];
}

const speciesName = (pack, id) => (pack.species[id] && pack.species[id].name) || '?';

/** Summaries of every readable profile: for each team its size, whether it is legal under its own ruleset, and the Pokemon names. Never throws. */
export async function readHubData(store, pack, opts = {}) {
  const out = { state: 'ready', profiles: [], activeId: null, notSaved: false, note: '' };
  try {
    const st = store.status || {};
    out.notSaved = !!st.notSaved;
    out.activeId = await store.getActiveId().catch(() => null);
    const list = await store.listProfiles();
    for (const s of list) {
      if (!s || !s.id || s.corrupt) continue;
      let r;
      try { r = await store.loadProfile(s.id); } catch (_e) { continue; }
      if (!r || !r.ok) continue;
      const p = r.profile;
      const teams = [];
      for (const t of p.teams) {
        const mons = teamMons(p, t.id);
        let legal = false, problems = 1;
        try { const v = validateMonList(mons, pack, t.ruleset); legal = v.ok && mons.length > 0; problems = v.ok ? 0 : v.reasons.length; } catch (_e) { legal = false; problems = 1; }
        const lead = mons[0] ? { species: mons[0].species, shiny: !!mons[0].shiny, gender: mons[0].gender === 'M' || mons[0].gender === 'F' ? mons[0].gender : null } : null;
        teams.push({ id: t.id, name: t.name, size: mons.length, legal, problems, names: mons.map((m) => (m.nickname ? m.nickname : speciesName(pack, m.species))), lead, ruleset: t.ruleset });
      }
      // ST1: the battle record, as pages for the RECORD screen (a profile of a newer build, or one whose record cannot be read, gets a page that says so)
      let record;
      try {
        record = r.readOnly ? { battles: 0, resettable: false, pages: buildRecordNotice('readonly') }
          : { battles: battleCount(p.stats), resettable: true, pages: buildRecordPages(p.stats, { speciesName: (id) => speciesName(pack, id), moveName: (id) => (pack.moves[id] && pack.moves[id].name) || '?', tzMinutes: opts.tzMinutes | 0, resettable: true }) };
      } catch (_e) { record = { battles: 0, resettable: false, pages: buildRecordNotice('unavailable') }; }
      // the Tower's climb of this profile, summarised for the Tower screens (null while the Tower's code loads, or for a profile of a newer build, whose Tower record this build cannot read)
      let tower = null;
      if (!r.readOnly && typeof opts.towerSummary === 'function') { try { tower = opts.towerSummary(p.tower, pack); } catch (_e) { tower = null; } }
      out.profiles.push({ id: p.id, name: p.trainerName, readOnly: !!r.readOnly, teams, record, tower });
    }
    if (st.notSaved && !out.profiles.length) { out.state = 'unavailable'; out.note = 'This browser is not keeping profiles.'; }
  } catch (e) {
    out.state = 'unavailable'; out.profiles = []; out.note = 'Storage could not be read.';
    out.error = String(e && e.message ? e.message : e);
  }
  return out;
}

/** The ARENA1.* code of one saved team (what battle.html?team= takes). */
export async function teamCodeFor(store, profileId, teamId) {
  try {
    const r = await store.loadProfile(profileId);
    if (!r || !r.ok) return { ok: false, message: 'That profile could not be read.' };
    const code = await encodeTeamCode(teamFromProfile(r.profile, teamId));
    return { ok: true, code };
  } catch (e) { return { ok: false, message: 'This team cannot be turned into a code: ' + (e && e.message ? e.message : e) }; }
}

/** battle.html's address. mode 'quick' = random teams (no team parameter); mode 'team' needs `code`. Throws RangeError on a value outside the contract. */
export function battleHref({ mode, code, format, cpu, seed }) {
  if (!FORMATS.includes(format)) throw new RangeError('format must be 6v6 or 3v3');
  if (!CPU_LEVELS.includes(cpu)) throw new RangeError('cpu must be easy, normal or hard');
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new RangeError('seed must be an unsigned 32-bit integer');
  if (mode === 'team') return battleUrl({ team: code, foe: 'random', seed, format, cpu });
  if (mode === 'quick') return BATTLE_PAGE + '?format=' + format + '&cpu=' + cpu + '&seed=' + seed;
  throw new RangeError('mode must be quick or team');
}

/** The team builder's address for one team (the profile must be the store's active one for the editor to open it). */
export function editorHref(teamId) { return teamId && /^[A-Za-z0-9_-]{1,40}$/.test(teamId) ? EDITOR_PAGE + '#/team/' + teamId : EDITOR_PAGE; }

/**
 * Which saved team was battle.html started with? Looks through every readable profile (the active one first) for a team whose code is
 * exactly `code`. Returns { profileId, teamId } or null (the code came from somewhere else, or the team was edited since).
 */
export async function findTeamForCode(store, code) {
  if (typeof code !== 'string' || !code) return null;
  try {
    const activeId = await store.getActiveId().catch(() => null);
    const list = (await store.listProfiles()).filter((s) => s && s.id && !s.corrupt).sort((a, b) => (a.id === activeId ? -1 : 0) - (b.id === activeId ? -1 : 0));
    for (const s of list) {
      const r = await store.loadProfile(s.id);
      if (!r || !r.ok) continue;
      for (const t of r.profile.teams) {
        let c = null;
        try { c = await encodeTeamCode(teamFromProfile(r.profile, t.id)); } catch (_e) { c = null; }
        if (c === code) return { profileId: s.id, teamId: t.id };
      }
    }
  } catch (_e) { /* fall through */ }
  return null;
}

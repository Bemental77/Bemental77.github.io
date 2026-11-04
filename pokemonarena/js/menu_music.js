// pokemonarena/js/menu_music.js -- WHAT THE MENUS PLAY, and the player's say in it (the music changer of the audio bar, audiobar.js).
//
// A menu page (the hub, the team editor) tells the sound system which SCREEN it is ("hub", "editor"); music_director.js turns that into a song through music_map.js. This file
// sits between the two: the player may pick another song for every menu, or none.
//
//   const mm = createMenuMusic({ director, mixer, storage, getMap, soundtrack });
//   mm.set('hub')            the page says which screen it is -> the song for it (the player's pick, else the screen's own) is asked of the director
//   mm.choose('town')        'auto' (the screen's own song) | 'off' (no music on the menus; their sound effects stay) | a music_map key from mm.options()
//   mm.step(+1)              the next entry of [Automatic, each song, Off] (-1 the previous), wrapping
//   mm.options()             the songs this soundtrack can play on a menu: [{ key, name, label, index }]   mm.state()   mm.on(fn)   mm.refresh()
//
// WHICH SONGS. Exactly the ones music_map.js has for the soundtrack in use that LOOP and are background music (a menu song that ends after one pass, or a fanfare, would leave
// the menu silent): hub, editor, preview, town, pokecenter, lab, title, evolution, hof, result_*, victory*, battle_*, in that order, each song once (hub and pokecenter are the
// same ROM song; the first key in the order names it). A song a soundtrack lacks (Ultra Violet has no rival battle theme) is simply not offered while it is in use.
// THE NAMES are written for the player (TRACK_NAMES below: "Battle: wild Pokemon"), NOT taken from music_map.js: its `doc` strings are developer notes ("loops in the ROM; it is a BGM, not a
// fanfare") and its ROM labels are table entries ("MUS-POKE-CENTER (loops, calm, 9 tracks)"). The ROM's label still rides along in each option as `label` (data for tests and tools, not shown).
//
// OFF means no MUSIC, not no sound: on a page that plays sound effects (the hub: its cursor / select / back sounds) they keep working, because that page's director is built with `effects: true`
// (music_director.js; sound_system.js sets it for the hub and the battle page): it loads the engine as soon as the sound can play whether or not a song is wanted, so Off works after a reload with
// Off stored too (nothing here has to ask for it). The team editor plays no sound effect, so its director is built without it and Off there loads no engine at all.
//
// SCOPE. Only menu pages call set(). The battle page chooses its music by the battle (music_director.js battle()/result()) and never touches this, so the pick cannot change
// battle, preview or result music.
//
// STORED as localStorage['arena.menumusic'] = JSON {v:1, pick}. A bad or hostile value is repaired to 'auto' and never throws; a pick naming a key the current soundtrack lacks keeps
// being stored but plays the screen's own song until a soundtrack that has it is chosen again (state().missing is true then and the bar says so). Import-safe in Node: nothing touches
// window/document/localStorage at import.

export const MENU_MUSIC_KEY = 'arena.menumusic';
export const PICK_AUTO = 'auto';
export const PICK_OFF = 'off';
const KEY_RE = /^[a-z][a-z0-9_]{0,31}$/;
export const DEFAULTS = Object.freeze({ v: 1, pick: PICK_AUTO });
/** The order the changer offers songs in: calm screens first, then the rest of the looping background music. */
export const TRACK_ORDER = Object.freeze([
  'hub', 'editor', 'preview', 'town', 'pokecenter', 'lab', 'title', 'evolution', 'hof', 'result_win', 'result_lose',
  'victory', 'victory_gym', 'victory_league', 'battle_easy', 'battle_normal', 'battle_hard', 'battle_final', 'battle_rival', 'battle_villain', 'battle_frontier', 'battle_legendary',
]);

/** Anything -> { settings:{v:1, pick}, problems }. A pick must be 'auto', 'off' or a key-shaped string. Never throws. */
export function normalizeMenuMusic(raw) {
  const problems = [];
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : (raw === undefined || raw === null ? {} : (problems.push('value'), {}));
  let pick = DEFAULTS.pick;
  if (typeof o.pick === 'string' && (o.pick === PICK_AUTO || o.pick === PICK_OFF || KEY_RE.test(o.pick))) pick = o.pick;
  else if (o.pick !== undefined) problems.push('pick');
  return { settings: { v: 1, pick }, problems };
}
function safeStorage() { try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch (_e) { return null; } }
/** -> { settings, source: 'stored' | 'default' | 'repaired' | 'invalid' | 'unreadable', problems } */
export function readMenuMusic(storage) {
  const st = storage === undefined ? safeStorage() : storage;
  if (!st) return { settings: { ...DEFAULTS }, source: 'unreadable', problems: [] };
  let text = null;
  try { text = st.getItem(MENU_MUSIC_KEY); } catch (_e) { return { settings: { ...DEFAULTS }, source: 'unreadable', problems: [] }; }
  if (text === null || text === undefined) return { settings: { ...DEFAULTS }, source: 'default', problems: [] };
  if (typeof text !== 'string' || text.length > 1000) return { settings: { ...DEFAULTS }, source: 'invalid', problems: ['size'] };
  let j;
  try { j = JSON.parse(text); } catch (_e) { return { settings: { ...DEFAULTS }, source: 'invalid', problems: ['json'] }; }
  const r = normalizeMenuMusic(j);
  return { settings: r.settings, source: r.problems.length ? 'repaired' : 'stored', problems: r.problems };
}
export function writeMenuMusic(storage, s) {
  const st = storage === undefined ? safeStorage() : storage;
  if (!st) return false;
  try { st.setItem(MENU_MUSIC_KEY, JSON.stringify({ v: 1, pick: s.pick })); return true; } catch (_e) { return false; }
}

const humanize = (key) => { const t = String(key).replace(/_/g, ' '); return t.charAt(0).toUpperCase() + t.slice(1); };
/**
 * What the player reads for each song of the changer: short, plain, the SAME on both soundtracks (the song behind a key differs between SoulGold and Ultra Violet, the kind of song does not).
 * A key that is not here (a future music_map key) is spelled out from the key. tools/pokemonarena_audiobar_test.mjs checks that no name carries developer prose.
 */
export const TRACK_NAMES = Object.freeze({
  hub: 'Pokemon Center', editor: "Professor's lab", preview: 'Trainer encounter', town: 'Town theme', pokecenter: 'Pokemon Center', lab: "Professor's lab", title: 'Title screen',
  evolution: 'Evolution', hof: 'Hall of Fame', result_win: 'Result: win', result_lose: 'Result: loss',
  victory: 'Victory: trainer battle', victory_gym: 'Victory: gym leader', victory_league: 'Victory: Elite Four',
  battle_easy: 'Battle: wild Pokemon', battle_normal: 'Battle: trainer', battle_hard: 'Battle: gym leader', battle_final: 'Battle: champion', battle_rival: 'Battle: rival',
  battle_villain: 'Battle: villain team', battle_frontier: 'Battle: Frontier Brain', battle_legendary: 'Battle: legendary Pokemon',
});
/** The player-facing name of a music_map key (TRACK_NAMES), else the key spelled out. `map` is accepted for the old signature and not read: the map's own descriptions are developer notes. */
export function nameOf(_map, key) {
  return Object.prototype.hasOwnProperty.call(TRACK_NAMES, key) ? TRACK_NAMES[key] : humanize(key);
}
/** The songs a menu may play for `soundtrack` (see the header). `map` = the music_map.js namespace (or a stand-in with songFor and, optionally, MUSIC_KEYS / MAP). */
export function trackOptions(map, soundtrack) {
  if (!map || typeof map.songFor !== 'function') return [];
  const order = TRACK_ORDER.slice();
  if (Array.isArray(map.MUSIC_KEYS)) for (const k of map.MUSIC_KEYS) if (!order.includes(k) && !/^se_/.test(k)) order.push(k);
  const out = [], seen = new Set();
  for (const key of order) {
    let r = null;
    try { r = map.songFor(soundtrack, key); } catch (_e) { r = null; }
    if (!r || !Number.isInteger(r.index) || r.index < 0 || r.loops !== true || r.jingle === true || seen.has(r.index)) continue;
    seen.add(r.index);
    out.push({ key, name: nameOf(map, key), label: typeof r.label === 'string' ? r.label : '', index: r.index });
  }
  return out;
}

export function createMenuMusic(opts = {}) {
  const director = opts.director;
  if (!director || typeof director.set !== 'function') throw new Error('createMenuMusic({ director }) needs the music director');
  const mixer = opts.mixer || null;
  const storage = opts.storage !== undefined ? opts.storage : safeStorage();
  const getMap = typeof opts.getMap === 'function' ? opts.getMap : () => null;
  const soundtrack = typeof opts.soundtrack === 'function' ? opts.soundtrack : () => (mixer ? mixer.soundtrack() : 'soulgold');
  const win = opts.window !== undefined ? opts.window : (typeof window !== 'undefined' ? window : null);
  const read = readMenuMusic(storage);
  const M = { pick: read.settings.pick, screen: null, source: read.source, listeners: new Set(), applied: undefined, destroyed: false };
  if (read.source === 'repaired' || read.source === 'invalid') writeMenuMusic(storage, { pick: M.pick });
  const emit = () => { for (const f of Array.from(M.listeners)) { try { f(state()); } catch (_e) { /* a listener must not break the music */ } } };

  const options = () => trackOptions(getMap(), soundtrack());
  /** The key the director is asked for on the current screen: null = silence. */
  function effective() {
    if (M.screen === null) return null;
    if (M.pick === PICK_OFF) return null;
    if (M.pick === PICK_AUTO) return M.screen;
    if (!getMap()) return M.pick;                         // the song table is not loaded yet: nothing can play before it is, so keep the player's pick rather than flash the screen's own song
    return options().some((o) => o.key === M.pick) ? M.pick : M.screen;
  }
  function apply() {
    if (M.destroyed || M.screen === null) return;
    const k = effective();
    M.applied = k;
    if (k === null) director.stop(); else director.set(k);          // Off = no MUSIC (stop): a director built with effects:true (the hub) still loads its engine whenever the sound can play, its sound effects need it
  }
  /** What the player reads for the pick: Automatic, Off, or the song's name (known before the song table has loaded: the names do not come from it). */
  const pickName = () => (M.pick === PICK_OFF ? 'Off' : M.pick === PICK_AUTO ? 'Automatic' : nameOf(null, M.pick));
  /** The stored pick is a song the soundtrack in use lacks (only knowable once the song table has loaded): the screen's own song plays instead. */
  const missing = (opts) => !!getMap() && M.pick !== PICK_AUTO && M.pick !== PICK_OFF && !opts.some((o) => o.key === M.pick);
  const state = () => { const opts = options(); return { pick: M.pick, screen: M.screen, effective: effective(), source: M.source, options: opts, pickName: pickName(), missing: missing(opts) }; };

  function choose(pick) {
    if (M.destroyed) return false;
    const p = String(pick);
    if (p !== PICK_AUTO && p !== PICK_OFF && !options().some((o) => o.key === p)) return false;
    if (p === M.pick) return true;
    M.pick = p;
    writeMenuMusic(storage, { pick: p });
    apply(); emit();
    return true;
  }
  /** Step through [Automatic, each song, Off]; dir +1 / -1, wrapping. A pick the soundtrack lacks counts as Automatic. */
  function step(dir) {
    const cycle = [PICK_AUTO, ...options().map((o) => o.key), PICK_OFF];
    let i = cycle.indexOf(M.pick); if (i < 0) i = 0;
    const next = cycle[(i + (dir < 0 ? -1 : 1) + cycle.length) % cycle.length];
    return choose(next) ? next : null;
  }
  function set(screenKey) {
    if (typeof screenKey !== 'string' || !screenKey) throw new Error('set(screenKey): a screen key is needed');
    M.screen = screenKey;
    apply();
    emit();
  }
  function refresh() { if (M.destroyed) return; apply(); emit(); }

  const offs = [];
  if (mixer && typeof mixer.on === 'function') offs.push(mixer.on((ev) => { if (ev.type === 'soundtrack') refresh(); }));
  // another tab changed the pick
  if (win && typeof win.addEventListener === 'function') {
    const onStorage = (e) => {
      if (M.destroyed || !e || (e.key !== MENU_MUSIC_KEY && e.key !== null)) return;
      const r = readMenuMusic(storage);
      if (r.settings.pick !== M.pick) { M.pick = r.settings.pick; apply(); emit(); }
    };
    win.addEventListener('storage', onStorage);
    offs.push(() => win.removeEventListener('storage', onStorage));
  }
  function destroy() { M.destroyed = true; for (const o of offs.splice(0)) { try { o(); } catch (_e) { /* ignore */ } } M.listeners.clear(); }

  return {
    set, choose, step, options, state, refresh, destroy,
    pick: () => M.pick, screen: () => M.screen,
    on: (fn) => { M.listeners.add(fn); return () => M.listeners.delete(fn); },
  };
}

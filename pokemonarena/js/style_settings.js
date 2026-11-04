// pokemonarena/js/style_settings.js -- the BATTLE STYLE setting: SWITCH (the default; the hack's own Options row calls it "Shift", and the pause menu shows the ROM's word) or SET.
//
// Pure ES module (browser + Node): no DOM. The only storage touched is the object the caller passes (localStorage in the page, a Map-like in tests). Written like anim_settings.js.
//
//   const cfg = createStyleSettings({ storage: localStorage, search: location.search });
//   cfg.get()            -> { style: 'switch' }                 (a fresh copy)
//   cfg.set({ style: 'set' }) -> same shape; persisted to localStorage key `arena.battlestyle` as the plain word 'switch' or 'set'
//   cfg.toggle()         what the pause menu's BATTLE STYLE row calls
//   cfg.queryErrors      problems found in the address (`?style=`); the page shows an error screen for them
//
// WHAT IT MEANS (the Gen 3 option of the same name): SWITCH asks "Will you switch your Pokemon?" when the CPU trainer is about to send out its next Pokemon after one fainted, and lets
// you change yours before it comes in, for free (no turn is used). SET never asks. A battle against a person has no such question whatever this says. Query: `?style=switch|set` overrides
// the stored value for this page load only (it is not written back).

export const STYLE_KEY = 'arena.battlestyle';
export const STYLES = Object.freeze(['switch', 'set']);
export const DEFAULT_STYLE = 'switch';

// text from storage -> a style; anything that is not exactly one of the two words (junk, JSON, an empty string, something long) is the default
export function parseStyle(raw) {
  return typeof raw === 'string' && STYLES.includes(raw) ? raw : DEFAULT_STYLE;
}

// `?style=switch|set` -> { style?, errors[] }. A value that is not exactly one of the two forms is an error (never echoed).
export function parseStyleQuery(search) {
  const out = { errors: [] };
  let q;
  try { q = new URLSearchParams(search || ''); } catch (_e) { return out; }
  if (q.has('style')) { const v = q.get('style'); if (v === 'switch' || v === 'set') out.style = v; else out.errors.push('style'); }
  return out;
}

export function createStyleSettings(o = {}) {
  const storage = o.storage || null;
  let stored = DEFAULT_STYLE;
  if (storage) { try { stored = parseStyle(storage.getItem(STYLE_KEY)); } catch (_e) { stored = DEFAULT_STYLE; } }
  const q = parseStyleQuery(o.search || '');
  const cur = { style: q.style !== undefined ? q.style : stored };
  const listeners = [];
  const save = () => { if (!storage) return; try { storage.setItem(STYLE_KEY, cur.style); } catch (_e) { /* private mode: the setting lasts for this page only */ } };
  const api = {
    get: () => Object.assign({}, cur),
    set(patch) {
      if (patch && STYLES.includes(patch.style)) cur.style = patch.style;
      save();
      for (const f of listeners.slice()) { try { f(api.get()); } catch (_e) { /* a listener must not break the setting */ } }
      return api.get();
    },
    toggle() { return api.set({ style: cur.style === 'switch' ? 'set' : 'switch' }); },
    onChange(f) { listeners.push(f); },
    queryErrors: q.errors.slice(),
  };
  return api;
}

// pokemonarena/js/anim_settings.js -- the battle animation settings: ON/OFF, BATTLE SPEED, and the optional press-to-skip.
//
// Pure ES module (browser + Node): no DOM. The only storage touched is the object the caller passes (localStorage in the page, a Map-like in tests).
//
//   const cfg = createAnimSettings({ storage: localStorage, search: location.search });
//   cfg.get()            -> { v: 1, on: true, speed: 1, skip: false }        (a fresh copy)
//   cfg.set({ speed: 2 }) -> same shape; persisted to localStorage key `arena.anim` as JSON { v, on, speed } (skip is never persisted)
//   cfg.toggleOn(), cfg.cycleSpeed()   what the pause-menu rows call
//   cfg.queryErrors      problems found in the address (`?anim=`, `?speed=`, `?animskip=`); the page may ignore or show them
//
// The contract (workflows/pokemonarena-anim.md): `arena.anim` = { v: 1, on: true, speed: 1 | 2 | 4 }. Animations are ON by default (they are the game).
// A press during an animation does NOT skip it unless `skip` is set (`?animskip=1`, never stored, used by the tests and as an accessibility switch).
// Query: `?anim=0|1` and `?speed=1|2|4` override the stored value for this page load only (they are not written back). `speed` is also the text-speed
// parameter of battle.html (slow / mid / fast); the two vocabularies do not overlap, so battle_boot.js reads each form into its own setting.

export const ANIM_KEY = 'arena.anim';
export const ANIM_SPEEDS = Object.freeze([1, 2, 4]);
export const ANIM_VERSION = 1;

export function defaultAnim() { return { v: ANIM_VERSION, on: true, speed: 1, skip: false }; }

// text from storage -> a clean settings object; anything wrong (not JSON, wrong version, wrong types) falls back to the defaults field by field
export function parseAnim(raw) {
  const d = defaultAnim();
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 200) return d;
  let o;
  try { o = JSON.parse(raw); } catch (_e) { return d; }
  if (!o || typeof o !== 'object' || o.v !== ANIM_VERSION) return d;
  if (o.on === true || o.on === false) d.on = o.on;
  if (ANIM_SPEEDS.includes(o.speed)) d.speed = o.speed;
  return d;
}

// `?anim=0|1` / `?speed=1|2|4` / `?animskip=0|1` -> { anim?, speed?, skip?, errors[] }. A value that is not exactly one of the forms is an error (never echoed).
export function parseAnimQuery(search) {
  const out = { errors: [] };
  let q;
  try { q = new URLSearchParams(search || ''); } catch (_e) { return out; }
  if (q.has('anim')) { const v = q.get('anim'); if (v === '0' || v === '1') out.anim = v === '1'; else out.errors.push('anim'); }
  if (q.has('speed')) {
    const v = q.get('speed');
    if (v === '1' || v === '2' || v === '4') out.speed = Number(v);
    else if (v !== 'slow' && v !== 'mid' && v !== 'fast') out.errors.push('speed');       // slow / mid / fast is the text speed, handled elsewhere
  }
  if (q.has('animskip')) { const v = q.get('animskip'); if (v === '0' || v === '1') out.skip = v === '1'; else out.errors.push('animskip'); }
  return out;
}

export function createAnimSettings(o = {}) {
  const storage = o.storage || null;
  let stored = defaultAnim();
  if (storage) { try { stored = parseAnim(storage.getItem(ANIM_KEY)); } catch (_e) { stored = defaultAnim(); } }
  const q = parseAnimQuery(o.search || '');
  const cur = Object.assign({}, stored);
  if (q.anim !== undefined) cur.on = q.anim;
  if (q.speed !== undefined) cur.speed = q.speed;
  if (q.skip !== undefined) cur.skip = q.skip;
  const listeners = [];
  const save = () => { if (!storage) return; try { storage.setItem(ANIM_KEY, JSON.stringify({ v: ANIM_VERSION, on: cur.on, speed: cur.speed })); } catch (_e) { /* private mode: the setting lasts for this page only */ } };
  const api = {
    get: () => Object.assign({}, cur),
    set(patch) {
      if (patch && (patch.on === true || patch.on === false)) cur.on = patch.on;
      if (patch && ANIM_SPEEDS.includes(patch.speed)) cur.speed = patch.speed;
      if (patch && (patch.skip === true || patch.skip === false)) cur.skip = patch.skip;
      save();
      for (const f of listeners.slice()) { try { f(api.get()); } catch (_e) { /* a listener must not break the setting */ } }
      return api.get();
    },
    toggleOn() { return api.set({ on: !cur.on }); },
    cycleSpeed() { return api.set({ speed: ANIM_SPEEDS[(ANIM_SPEEDS.indexOf(cur.speed) + 1) % ANIM_SPEEDS.length] }); },
    onChange(f) { listeners.push(f); },
    queryErrors: q.errors.slice(),
  };
  return api;
}

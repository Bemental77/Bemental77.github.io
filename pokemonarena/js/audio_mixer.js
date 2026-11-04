// pokemonarena/js/audio_mixer.js -- the ONE audio context of a Pokemon Arena page, and the three volume buses the whole game plays through.
//
//   master  ->  context.destination
//   music   ->  master        the ROM's songs (music.js plays into this node)
//   fx      ->  master        cries, the ROM's sound effects (cries.js takes opts.destination; music.js playEffect takes fxDestination)
//
// WHAT THIS FILE GUARANTEES (each item is a named check in tools/pokemonarena_sound_test.mjs)
//   * NOTHING IS HEARD BEFORE THE BROWSER ALLOWS IT, AND THE MUSIC STARTS THE MOMENT IT DOES. A bare mixer creates no AudioContext until the visitor has acted (a click, a tap
//     or a key press: attach() listens for those and only then calls unlock()). A PAGE'S mixer (sound_system.js passes earlyStart) also TRIES AT ONCE, at attach(): it creates the
//     context and asks it to resume. The browser decides: with the site's autoplay permission, or when the visitor's click on the previous page of this site carried over (Chrome keeps
//     sticky user activation across a same-origin navigation: measured in tools/pokemonarena_autoplay_test.mjs, MUSIC.md), the context is running at load and the music starts as soon as
//     its song is ready; otherwise it stays suspended and the listeners armed below start it on the visitor's very FIRST gesture ANYWHERE on the page (key, mouse, pointer, touch),
//     with no need to press a Sound button. A controller button is NOT a browser user activation (the pages try it anyway; a browser that counts it starts the sound), so a controller-only
//     visitor sees a "press any key, or click or tap" prompt (sound_system.js) and says so in the README. A browser with no Web Audio at all gets no prompt (a click cannot help).
//   * ONE context per page, ever. A page's mixer (earlyStart) creates it at load unless the visitor muted the sound or the tab is hidden (a hidden tab tries again the moment it is shown); every
//     other case creates it the first time the visitor acts, EVEN IF the sound is muted: a muted page that is later unmuted with a controller still works, because the context was allowed to
//     start while a gesture was available.
//   * Volume changes are ramps (no clicks): every gain moves with cancelScheduledValues + setValueAtTime + linearRampToValueAtTime over rampMs.
//     A context double that only has .value (the test doubles older than this file) still works: the value is assigned.
//   * Mute really silences: master gain ramps to exactly 0, and after the ramp the context is SUSPENDED (no CPU for a muted page). Unmute
//     resumes it first, then ramps up. Mute is the single stored boolean `muted`, not a volume of 0, so the sliders keep their positions.
//   * A hidden tab suspends the context (music.js is told through the 'hidden' event and pauses its own scheduling); coming back resumes it
//     unless muted.
//   * Settings persist in localStorage['arena.audio'] = JSON {v:1, master, music, fx, muted, soundtrack}. A bad or hostile value is repaired
//     field by field and never throws. The OLD key 'arena.sound' ('1' on, '0' off) is migrated ONCE (when arena.audio does not exist); the old key
//     is left untouched for pages cached from before this change.
//   * DEFAULT POLICY (the user wants music, at half the slider): sound is ON by default: master 0.5, music 0.6, fx 0.8, muted false, soundtrack soulgold. These apply only when NOTHING is
//     stored: a stored choice (any field of arena.audio) always wins and is never overwritten, so a visitor who muted or set another volume keeps it (they were written as 0.7 / 0.6 / 0.8 by
//     every earlier build, and still read that way). The settings schema is unchanged (v:1).
//   * LEVEL. The synthesizer's own output (music.js at gain 1) is calibrated to the real game's output through the mGBA oracle (MUSIC.md: RMS ratio median 1.004), so a bus
//     gain of 1.0 IS the level the real game plays at. THE UNITY POSITIONS ARE THE POSITIONS THAT GIVE GAIN 1.0: master 0.7, music 0.6, fx 0.8 (UNITY below; they used to be the defaults. The
//     law that gave 0.49 x 0.36 = 0.176 before them was 15 dB under the game, which is why the music was nearly inaudible). A NEW visitor now starts Master at 0.5 (a deliberately quieter start:
//     gain (0.5 / 0.7)^2 = 0.51, about 6 dB under the real game's level) with Music and Effects at their unity positions. gainFor(position, bus): below the unity position a SQUARE law
//     ((v / unity)^2: loudness is judged roughly logarithmically), above it a straight climb to GAIN_MAX (+3 dB) at 1.0, so master and music together can reach +6 dB over
//     the game. A SOFT LIMITER (a WaveShaper, identity below 0.8, saturating to 0.95) sits between the master bus and the speakers, so cry + effects + music together never
//     clip even at the top of the sliders. The state snapshot reports positions and gains.
//
// Import-safe in Node: nothing touches window/document/localStorage at import. Everything environmental is injectable
// (createMixer({ window, document, storage, createContext, now })); tests pass a recording double and never reach a device.

export const AUDIO_KEY = 'arena.audio';
export const LEGACY_SOUND_KEY = 'arena.sound';
export const BUSES = Object.freeze(['master', 'music', 'fx']);
// keep in step with music_map.js SOUNDTRACKS (tools/pokemonarena_sound_test.mjs compares the two when music_map.js exists)
export const SOUNDTRACK_IDS = Object.freeze(['soulgold', 'ultraviolet']);
export const DEFAULTS = Object.freeze({ v: 1, master: 0.5, music: 0.6, fx: 0.8, muted: false, soundtrack: 'soulgold' });      // what a visitor with NOTHING stored starts with
/** The slider positions whose gain is exactly 1.0 (the real game's level). The gain law is anchored here, NOT on DEFAULTS: moving the starting volume must not move the law. */
export const UNITY = Object.freeze({ master: 0.7, music: 0.6, fx: 0.8 });
export const VOLUME_STEP = 5;                 // percent per step of a slider / key press
export const RAMP_MS = 30;                    // gain ramp length: long enough to be click-free, short enough to feel instant
export const DUCK_LEVEL = 0.5;                // music level while a menu / pause screen asks for ducking

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const GAIN_MAX = Math.pow(10, 3 / 20);   // +3 dB at slider position 1.0 (per bus)
/** Slider position (0..1) -> linear gain for a bus (master, music or fx; default master): 1.0 at the bus's unity position (UNITY), the square law below it, a straight climb to GAIN_MAX above. */
export function gainFor(v, bus = 'master') {
  const x = clamp01(Number(v) || 0), v0 = bus === 'music' ? UNITY.music : bus === 'fx' ? UNITY.fx : UNITY.master;
  if (x <= v0) return (x / v0) * (x / v0);
  return 1 + (GAIN_MAX - 1) * ((x - v0) / (1 - v0));
}
/** The soft limiter's transfer curve over input -1..1: identity up to LIMIT_KNEE, then saturating toward LIMIT_CEIL. */
export const LIMIT_KNEE = 0.8, LIMIT_CEIL = 0.95;
export function limit(x) { const a = Math.abs(x); if (a <= LIMIT_KNEE) return x; const y = LIMIT_KNEE + (LIMIT_CEIL - LIMIT_KNEE) * Math.tanh((a - LIMIT_KNEE) / (LIMIT_CEIL - LIMIT_KNEE)); return x < 0 ? -y : y; }
export function limiterCurve(n = 4097) { const c = new Float32Array(n); for (let i = 0; i < n; i++) c[i] = limit(-1 + (2 * i) / (n - 1)); return c; }
/** 0..100 integer percent <-> 0..1 (two decimals, so 5% steps are exact in JSON). */
export const toPercent = (v) => Math.round(clamp01(Number(v) || 0) * 100);
export const fromPercent = (p) => Math.round(Math.min(100, Math.max(0, Number(p) || 0))) / 100;

/* ------------------------------------------------------------------------------------------------ settings */

function repairNumber(x, dflt, problems, name) {
  if (typeof x !== 'number' || !Number.isFinite(x)) { if (x !== undefined) problems.push(name); return dflt; }
  if (x < 0 || x > 1) { problems.push(name); return clamp01(x); }
  return Math.round(x * 100) / 100;
}
/** Anything -> a valid settings object. `problems` lists the fields that were wrong (an absent field is not a problem). Never throws. */
export function normalizeSettings(raw) {
  const problems = [];
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : (raw === undefined || raw === null ? {} : (problems.push('value'), {}));
  const s = {
    v: 1,
    master: repairNumber(o.master, DEFAULTS.master, problems, 'master'),
    music: repairNumber(o.music, DEFAULTS.music, problems, 'music'),
    fx: repairNumber(o.fx, DEFAULTS.fx, problems, 'fx'),
    muted: typeof o.muted === 'boolean' ? o.muted : (o.muted !== undefined && problems.push('muted'), DEFAULTS.muted),
    soundtrack: SOUNDTRACK_IDS.includes(o.soundtrack) ? o.soundtrack : (o.soundtrack !== undefined && problems.push('soundtrack'), DEFAULTS.soundtrack),
  };
  return { settings: s, problems };
}

function safeStorage() { try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch (_e) { return null; } }

/**
 * Read the stored settings. source: 'stored' (arena.audio), 'migrated' (from the old arena.sound), 'default' (nothing stored),
 * 'repaired' (arena.audio existed but had bad fields), 'invalid' (arena.audio is not JSON: defaults), 'unreadable' (storage throws / is absent).
 */
export function readSettings(storage) {
  const st = storage === undefined ? safeStorage() : storage;
  if (!st) return { settings: { ...DEFAULTS }, source: 'unreadable', problems: [] };
  let text = null;
  try { text = st.getItem(AUDIO_KEY); } catch (_e) { return { settings: { ...DEFAULTS }, source: 'unreadable', problems: [] }; }
  if (text !== null && text !== undefined) {
    if (typeof text !== 'string' || text.length > 4000) return { settings: { ...DEFAULTS }, source: 'invalid', problems: ['size'] };
    let j;
    try { j = JSON.parse(text); } catch (_e) { return { settings: { ...DEFAULTS }, source: 'invalid', problems: ['json'] }; }
    const r = normalizeSettings(j);
    return { settings: r.settings, source: r.problems.length ? 'repaired' : 'stored', problems: r.problems };
  }
  let legacy = null;
  try { legacy = st.getItem(LEGACY_SOUND_KEY); } catch (_e) { legacy = null; }
  if (legacy === '1') return { settings: { ...DEFAULTS, muted: false }, source: 'migrated', problems: [] };
  if (legacy === '0') return { settings: { ...DEFAULTS, muted: true }, source: 'migrated', problems: [] };
  return { settings: { ...DEFAULTS }, source: 'default', problems: [] };
}
export function writeSettings(storage, s) {
  const st = storage === undefined ? safeStorage() : storage;
  if (!st) return false;
  try { st.setItem(AUDIO_KEY, JSON.stringify({ v: 1, master: s.master, music: s.music, fx: s.fx, muted: !!s.muted, soundtrack: s.soundtrack })); return true; } catch (_e) { return false; }
}

/* ------------------------------------------------------------------------------------------------ the mixer */

// Move an AudioParam to `v`. immediate (or a double with no automation methods): assign. Otherwise a click-free linear ramp from where it is now.
function moveParam(param, v, ctx, immediate, rampS) {
  if (!param) return;
  const can = typeof param.linearRampToValueAtTime === 'function' && typeof param.setValueAtTime === 'function';
  if (immediate || !can || !ctx) { try { if (typeof param.cancelScheduledValues === 'function') param.cancelScheduledValues(0); param.value = v; } catch (_e) { /* a closed context */ } return; }
  try {
    const t = Number.isFinite(ctx.currentTime) ? ctx.currentTime : 0;
    if (typeof param.cancelScheduledValues === 'function') param.cancelScheduledValues(t);
    param.setValueAtTime(Number.isFinite(param.value) ? param.value : v, t);
    param.linearRampToValueAtTime(v, t + rampS);
  } catch (_e) { try { param.value = v; } catch (_e2) { /* ignore */ } }
}

export function createMixer(opts = {}) {
  const win = opts.window !== undefined ? opts.window : (typeof window !== 'undefined' ? window : null);
  const doc = opts.document !== undefined ? opts.document : (typeof document !== 'undefined' ? document : null);
  const storage = opts.storage !== undefined ? opts.storage : safeStorage();
  const rampMs = Number.isFinite(opts.rampMs) ? opts.rampMs : RAMP_MS;
  const earlyStart = opts.earlyStart === true;           // try to start the context at attach(), without waiting for a gesture (the browser decides: see the header)
  const setT = opts.setTimeout || ((fn, ms) => setTimeout(fn, ms));
  const clearT = opts.clearTimeout || ((h) => clearTimeout(h));
  const makeContext = opts.createContext || (() => {
    const C = win && (win.AudioContext || win.webkitAudioContext);
    if (!C) return null;
    try { return new C({ latencyHint: 'playback' }); } catch (_e) { try { return new C(); } catch (_e2) { return null; } }
  });

  const read = readSettings(storage);
  const S = {
    settings: read.settings, source: read.source, problems: read.problems,
    ctx: null, nodes: null, ctxError: null,
    hidden: !!(doc && doc.hidden), duck: 1, unlocks: 0, resumes: 0, suspends: 0,
    storageOk: !!storage && read.source !== 'unreadable', writes: 0, destroyed: false,
    suspendTimer: null, suspending: false, listeners: new Set(), detach: [],
  };
  // the first read of a migrated value writes the new key at once, so the migration happens exactly once
  if (read.source === 'migrated' || read.source === 'repaired' || read.source === 'invalid') persist();

  function persist() {
    if (!storage) { S.storageOk = false; return false; }
    const ok = writeSettings(storage, S.settings);
    S.storageOk = ok; if (ok) S.writes++;
    return ok;
  }
  function emit(type, extra) {
    const ev = Object.assign({ type }, extra || {});
    for (const fn of Array.from(S.listeners)) { try { fn(ev); } catch (e) { if (typeof console !== 'undefined') console.error('[audio_mixer] listener failed:', e); } }
  }

  /* ---- targets ---- */
  const targets = () => ({
    master: S.settings.muted ? 0 : gainFor(S.settings.master, 'master'),
    music: gainFor(S.settings.music, 'music') * S.duck,
    fx: gainFor(S.settings.fx, 'fx'),
  });
  function applyGains(immediate) {
    if (!S.nodes) return;
    const t = targets();
    for (const b of BUSES) moveParam(S.nodes[b] && S.nodes[b].gain, t[b], S.ctx, immediate, rampMs / 1000);
  }

  /* ---- context state ---- */
  const wantRunning = () => !S.destroyed && !S.hidden && !S.settings.muted;
  function clearSuspendTimer() { if (S.suspendTimer !== null) { clearT(S.suspendTimer); S.suspendTimer = null; } }
  function safeResume() {
    const c = S.ctx; if (!c) return;
    if (c.state === 'closed') return;
    clearSuspendTimer();
    if (c.state === 'running') { return; }
    S.resumes++;
    try { const p = c.resume(); if (p && typeof p.then === 'function') p.then(afterState, afterState); else afterState(); } catch (_e) { /* not allowed to start yet */ }
  }
  // a state change: tell the listeners, and once the context is RUNNING stop waiting for a user activation
  // A suspend() that was still in flight when the sound became wanted again (mute then unmute, hide then show, within a few ms) would otherwise leave the
  // page silent for good: when it lands and the sound is wanted, resume.
  function afterState() {
    const was = S.suspending; S.suspending = false;
    if (S.ctx && S.ctx.state === 'running') removeActivation();
    else if (was && S.ctx && S.ctx.state === 'suspended' && wantRunning()) { safeResume(); return; }
    emit('state');
  }
  function safeSuspend() {
    const c = S.ctx; if (!c || c.state !== 'running') return;
    S.suspends++; S.suspending = true;
    try { const p = c.suspend(); if (p && typeof p.then === 'function') p.then(() => emit('state'), () => {}); else emit('state'); } catch (_e) { /* ignore */ }
  }
  // after a mute / hide ramp, stop the context so a silent page costs no CPU
  function suspendSoon() {
    clearSuspendTimer();
    if (!S.ctx || S.ctx.state !== 'running') return;
    S.suspendTimer = setT(() => { S.suspendTimer = null; if (!wantRunning()) safeSuspend(); }, rampMs + 25);
  }
  function buildGraph(ctx) {
    const master = ctx.createGain(), music = ctx.createGain(), fx = ctx.createGain();
    music.connect(master); fx.connect(master);
    S.nodes = { master, music, fx };
    // master -> soft limiter -> speakers (a context double without createWaveShaper keeps master -> speakers)
    let out = ctx.destination;
    if (typeof ctx.createWaveShaper === 'function') { try { const ws = ctx.createWaveShaper(); ws.curve = limiterCurve(); ws.oversample = 'none'; ws.connect(ctx.destination); out = ws; S.nodes.limiter = ws; } catch (_e) { out = ctx.destination; } }
    master.connect(out);
    applyGains(true);
  }

  /** Create the context (once) and start it. Call ONLY from a user activation (the attach() listeners and UI click handlers do). */
  function unlock() {
    if (S.destroyed) return false;
    if (!S.ctx) {
      let c = null;
      try { c = makeContext(); } catch (_e) { c = null; }
      if (!c) { S.ctxError = 'unsupported'; emit('error', { reason: 'unsupported' }); return false; }
      S.ctx = c; S.unlocks++;
      try { buildGraph(c); } catch (e) { S.ctxError = 'graph'; S.ctx = null; S.nodes = null; try { c.close && c.close(); } catch (_e) { /* ignore */ } emit('error', { reason: 'graph' }); return false; }
      try { c.onstatechange = () => { if (S.ctx && S.ctx.state === 'running' && !wantRunning()) suspendSoon(); afterState(); }; } catch (_e) { /* a double without it */ }
      emit('unlock');
    }
    if (wantRunning()) safeResume();
    else { applyGains(true); if (S.ctx.state === 'running') suspendSoon(); }
    return true;
  }

  /* ---- settings ---- */
  function setVolume(bus, v, o) {
    if (!BUSES.includes(bus)) throw new Error('unknown bus ' + JSON.stringify(bus) + ' (master, music or fx)');
    const x = Number(v);
    if (!Number.isFinite(x)) throw new Error('volume ' + v + ' is not a number');
    const val = Math.round(clamp01(x) * 100) / 100;
    if (S.settings[bus] === val) return val;
    S.settings[bus] = val;
    applyGains(false);
    if (!o || o.persist !== false) persist();
    emit('volume', { bus, value: val });
    return val;
  }
  function setMuted(m) {
    const next = !!m;
    if (S.settings.muted === next) return next;
    S.settings.muted = next;
    persist();
    if (S.ctx) {
      if (next) { applyGains(false); suspendSoon(); }
      else { clearSuspendTimer(); safeResume(); applyGains(false); }
    }
    emit('mute', { muted: next });
    return next;
  }
  function setSoundtrack(name) {
    if (!SOUNDTRACK_IDS.includes(name)) throw new Error('unknown soundtrack ' + JSON.stringify(name));
    if (S.settings.soundtrack === name) return name;
    S.settings.soundtrack = name; persist();
    emit('soundtrack', { soundtrack: name });
    return name;
  }
  function duck(level) {
    const f = level === true ? DUCK_LEVEL : level === false || level === undefined || level === null ? 1 : clamp01(Number(level));
    if (S.duck === f) return f;
    S.duck = f; applyGains(false); emit('duck', { level: f });
    return f;
  }
  function setHidden(h) {
    const next = !!h;
    if (S.hidden === next) return;
    S.hidden = next;
    if (next) { clearSuspendTimer(); safeSuspend(); emit('hidden'); }
    else {
      if (S.ctx && wantRunning()) safeResume();
      else if (earlyStart && S.detach.length && !S.settings.muted && !S.ctx && !S.ctxError) unlock();       // a page that LOADED hidden (a background tab) had no early try; it gets it now, when it is shown
      emit('visible');
    }
  }

  /* ---- reading ---- */
  const ctxState = () => (S.ctx ? S.ctx.state : null);
  const running = () => !!S.ctx && S.ctx.state === 'running';
  /** Is it audible right now (a running context, not muted, tab visible)? Everything that would START a sound asks this first. */
  const canPlay = () => running() && !S.settings.muted && !S.hidden && !S.destroyed;
  /** Does the page still need a user activation to make sound (and would sound be wanted)? Drives the "press any key" prompt. */
  const needsActivation = () => !S.destroyed && !S.settings.muted && !running() && !S.ctxError;       // (a browser with no Web Audio, or a graph that cannot be built: no click will fix it, so nothing asks for one)
  function snapshot() {
    const t = targets();
    return {
      v: 1,
      settings: { master: S.settings.master, music: S.settings.music, fx: S.settings.fx, muted: S.settings.muted, soundtrack: S.settings.soundtrack },
      gains: { master: t.master, music: t.music, fx: t.fx },
      duck: S.duck,
      ctx: ctxState(), created: !!S.ctx, unlocks: S.unlocks, resumes: S.resumes, suspends: S.suspends,
      hidden: S.hidden, canPlay: canPlay(), needsActivation: needsActivation(), ctxError: S.ctxError,
      storage: { ok: S.storageOk, source: S.source, problems: S.problems.slice(), writes: S.writes },
    };
  }

  /* ---- page wiring ---- */
  // Events that count as a user activation in browsers (HTML "activation triggering input event"): keydown (not Esc), mousedown, pointerdown of a
  // mouse, pointerup of a touch / pen, touchend. The listeners stay until the context is RUNNING, so a first attempt that the browser refused is retried.
  function onActivation(e) {
    if (S.destroyed) return;
    if (e && e.type === 'keydown' && e.key === 'Escape') return;
    if (e && e.type === 'pointerdown' && e.pointerType && e.pointerType !== 'mouse') return;
    if (e && e.type === 'pointerup' && (!e.pointerType || e.pointerType === 'mouse')) return;
    unlock();
  }
  let activationOn = false;
  // 'touchstart' is armed too (a first touch ANYWHERE is the visitor's first gesture); the browser only lets the context start from the events above it that count as an activation, and the listeners stay
  // armed until the context is running, so a touchstart the browser refuses is followed by the touchend / pointerup that it accepts.
  const ACT_EVENTS = ['keydown', 'mousedown', 'pointerdown', 'pointerup', 'touchstart', 'touchend'];
  function addActivation() {
    if (activationOn || !win || typeof win.addEventListener !== 'function') return;
    activationOn = true;
    for (const t of ACT_EVENTS) win.addEventListener(t, onActivation, true);
  }
  function removeActivation() {
    if (!activationOn || !win) return;
    activationOn = false;
    for (const t of ACT_EVENTS) win.removeEventListener(t, onActivation, true);
  }
  function onVisibility() { setHidden(!!(doc && doc.hidden)); }
  function onStorageEvent(e) {
    if (!e || (e.key !== AUDIO_KEY && e.key !== null)) return;
    const r = readSettings(storage);
    const old = S.settings;
    S.settings = r.settings; S.source = r.source; S.problems = r.problems;
    applyGains(false);
    if (old.muted !== S.settings.muted) { if (S.ctx) { if (S.settings.muted) suspendSoon(); else { clearSuspendTimer(); safeResume(); } } emit('mute', { muted: S.settings.muted }); }
    if (old.soundtrack !== S.settings.soundtrack) emit('soundtrack', { soundtrack: S.settings.soundtrack });
    emit('volume', { bus: '*', value: null });
  }
  /** Start listening for the first activation, the tab being hidden, and another tab changing the settings. Returns detach(). */
  function attach() {
    if (S.detach.length) return () => detach();
    addActivation();
    if (doc && typeof doc.addEventListener === 'function') { doc.addEventListener('visibilitychange', onVisibility); S.detach.push(() => doc.removeEventListener('visibilitychange', onVisibility)); }
    if (win && typeof win.addEventListener === 'function') {
      win.addEventListener('storage', onStorageEvent); S.detach.push(() => win.removeEventListener('storage', onStorageEvent));
    }
    onVisibility();
    // THE EARLY TRY. A muted visitor has nothing to start (their first gesture still creates the context, so a controller can unmute later); a hidden tab waits to be shown.
    // The context is created and asked to resume NOW; whether it runs is the browser's decision, and either answer is fine: running -> the music starts as soon as its song is ready;
    // suspended -> it is the very first gesture on the page that resumes it (the listeners above), which is what the visitor sees as "the music starts when I first touch the page".
    if (earlyStart && !S.settings.muted && !S.hidden && !S.ctx && !S.ctxError) unlock();
    return () => detach();
  }
  function detach() { removeActivation(); for (const f of S.detach.splice(0)) { try { f(); } catch (_e) { /* ignore */ } } }
  function destroy() {
    S.destroyed = true; detach(); clearSuspendTimer();
    if (S.ctx) { try { const p = S.ctx.close && S.ctx.close(); if (p && p.catch) p.catch(() => {}); } catch (_e) { /* ignore */ } }
    S.listeners.clear();
  }

  return {
    // --- the contract names ---
    unlock, setVolume, setMuted, getAudioState: snapshot,
    // --- reading ---
    volume: (bus) => { if (!BUSES.includes(bus)) throw new Error('unknown bus ' + JSON.stringify(bus)); return S.settings[bus]; },
    muted: () => S.settings.muted, soundtrack: () => S.settings.soundtrack,
    settings: () => ({ ...S.settings }),
    toggleMuted: () => setMuted(!S.settings.muted),
    ctx: () => S.ctx, nodes: () => S.nodes,
    /** The node a producer connects to: 'music' or 'fx' (or 'master'). null before the first activation. */
    destination: (bus) => (S.nodes && S.nodes[bus] ? S.nodes[bus] : null),
    running, canPlay, needsActivation, hidden: () => S.hidden,
    // --- changing ---
    setSoundtrack, duck, setHidden,
    // --- events: on(fn) -> off ---
    on(fn) { if (typeof fn !== 'function') throw new Error('on(fn): fn must be a function'); S.listeners.add(fn); return () => S.listeners.delete(fn); },
    attach, detach, destroy, destroyed: () => S.destroyed,
    // test seam: simulate the browser's own events
    _onActivation: onActivation, _onVisibility: onVisibility,
  };
}

/* ------------------------------------------------------------------------------------------------ the page singleton */

let singleton = null;
/** The page's one mixer (created on first use). Pages call getMixer().attach() once; nothing else needs the factory. */
export function getMixer(opts) { if (!singleton || singleton.destroyed()) singleton = createMixer(opts); return singleton; }
export function resetMixerForTests() { if (singleton) { try { singleton.destroy(); } catch (_e) { /* ignore */ } } singleton = null; }
export const unlock = () => getMixer().unlock();
export const setVolume = (bus, v) => getMixer().setVolume(bus, v);
export const setMuted = (m) => getMixer().setMuted(m);
export const getAudioState = () => getMixer().getAudioState();

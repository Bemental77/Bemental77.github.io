// pokemonarena/js/music_director.js -- WHICH song plays WHEN. Screens say what they are ("hub", "preview", "battle", "result"); this file turns that
// into a music_map.js key, asks music.js to play it, and keeps the song in step with the mixer (muted / hidden tab / not unlocked yet -> paused).
//
//   const d = createDirector({ mixer, songFor, loadMusic, romFor, soundtrack: () => mixer.soundtrack() });
//   d.set('hub')                     // the background song for a screen (a music_map key)
//   d.battle('hard')                 // 'battle_hard'
//   d.result('win' | 'lose' | 'draw') // the victory / defeat fanfare, then the result music when a fanfare that ends has ended
//   d.playSfx('se_select', { pan })  // a sound effect by music_map key        d.playEffectIndex(index, pan)  // by song-table index (the animator)
//   d.duck(true)                     // pause menu: music at half level         d.stop()   d.dispose()   d.state()
//
// RULES (each one is a named check in tools/pokemonarena_sound_test.mjs)
//   * NEVER BLOCKS THE UI. music.js is imported and its songs are decoded after the page is up; until the first song is ready the game is silent. Every
//     failure (module missing, ROM unreadable, a song that throws) is caught, recorded in state().error and leaves the game playable and silent.
//   * Nothing plays before the visitor has acted: sync() starts nothing unless mixer.canPlay() (a running context, not muted, tab visible).
//   * ONE desired song at a time. Asking for the song that is already playing does nothing (no restart); a screen change crossfades (music.js does it).
//   * A key the soundtrack has no song for falls back along FALLBACKS (battle_hard -> battle_normal -> battle_easy ...) and, failing that, to silence.
//   * A jingle (victory / defeat) plays once; when music.js reports it ended (onEnded(index)) the result music for the same outcome starts. A draw has no jingle.
//   * Mute / hidden tab / suspended context PAUSE the song (music.pause) and resume it where it was (music.resume); a soundtrack change disposes the
//     engine and builds a new one on the new ROM, then plays the same desired key.
//   * Sound effects are dropped (not queued) while !canPlay() or before the engine is ready: a late hit sound is worse than none.

/** Where each key falls back to, in order, when the soundtrack has no song for it. Documented in the README ("what is approximate"). */
export const FALLBACKS = Object.freeze({
  hub: ['hub'],
  editor: ['editor', 'hub'],
  preview: ['preview', 'hub'],
  battle_easy: ['battle_easy', 'battle_normal', 'battle_hard'],
  battle_normal: ['battle_normal', 'battle_easy', 'battle_hard'],
  battle_hard: ['battle_hard', 'battle_normal', 'battle_easy'],
  victory_sting: ['victory_sting', 'victory'],
  defeat: ['defeat'],
  result_win: ['result_win', 'hub'],
  result_lose: ['result_lose', 'hub'],
});
/**
 * What the result screen plays, in ONE place (the picks themselves live in music_map.js, also in one place). first = a short fanfare, then = the music that follows it.
 * music_map.js: victory_sting is the ROM's obtain-badge fanfare (it ends), defeat is its too-bad fanfare (ends); victory / victory_gym / victory_league are LOOPING songs,
 * so they are never waited on; result_win / result_lose are mood picks (Hall of Fame, Lavender; low / medium confidence).
 */
export const RESULT_PLAN = Object.freeze({
  win: Object.freeze({ first: 'victory_sting', then: 'result_win' }),
  lose: Object.freeze({ first: 'defeat', then: 'result_lose' }),
  draw: Object.freeze({ first: null, then: 'result_lose' }),
});
export const CPU_LEVELS = Object.freeze(['easy', 'normal', 'hard']);
export const FADE = Object.freeze({ fadeInMs: 400, crossfadeMs: 600, fadeOutMs: 600 });

/** First key of the chain that the soundtrack has a song for -> { key, song } (song = songFor's record), or null. */
export function resolveKey(songFor, soundtrack, key, fallbacks = FALLBACKS) {
  const chain = fallbacks[key] || [key];
  for (const k of chain) {
    let song = null;
    try { song = songFor(soundtrack, k); } catch (_e) { song = null; }
    if (song && Number.isInteger(song.index) && song.index >= 0) return { key: k, song };
  }
  return null;
}

export function createDirector(opts = {}) {
  const mixer = opts.mixer;
  if (!mixer || typeof mixer.canPlay !== 'function') throw new Error('createDirector({ mixer }) needs the audio mixer');
  const songFor = typeof opts.songFor === 'function' ? opts.songFor : () => null;
  // (soundtrack, key) -> { key, song } | null. music_map.js has its own fallback chains (resolveSong); the page passes that, a bare songFor gets this file's FALLBACKS.
  const resolveFn = typeof opts.resolve === 'function' ? opts.resolve : (st, key) => resolveKey(songFor, st, key);
  const loadMusic = typeof opts.loadMusic === 'function' ? opts.loadMusic : null;     // async (soundtrack) -> { createMusic } module namespace, or throws
  const romFor = typeof opts.romFor === 'function' ? opts.romFor : null;                // async (soundtrack) -> Uint8Array of that soundtrack's ROM, or throws
  const soundtrackNow = typeof opts.soundtrack === 'function' ? opts.soundtrack : () => mixer.soundtrack();
  const logCap = opts.logCap || 200;

  const D = {
    want: null,                 // { key, then } the song the screen asked for ('then' = the key to start when a jingle ends)
    cur: null,                  // { key, usedKey, index, soundtrack, jingle, loops } what music.play was last told to play
    music: null, musicFor: null, loading: null, gen: 0,
    paused: false, error: null, log: [], sfx: [], disposed: false, ducked: false, plays: 0, stops: 0, ended: 0,
  };
  const note = (arr, rec) => { arr.push(rec); if (arr.length > logCap) arr.shift(); };
  const fail = (where, e) => { D.error = { where, message: String(e && e.message ? e.message : e).slice(0, 200) }; };

  /* ---- the engine ---- */
  function ensureMusic() {
    const st = soundtrackNow();
    if (D.music && D.musicFor === st) return Promise.resolve(D.music);
    if (D.loading && D.loading.st === st) return D.loading.p;
    if (D.music) { try { D.music.dispose(); } catch (_e) { /* ignore */ } D.music = null; D.musicFor = null; D.cur = null; }
    if (!loadMusic || !romFor) return Promise.resolve(null);
    const gen = ++D.gen;
    const p = (async () => {
      try {
        const [mod, rom] = await Promise.all([loadMusic(st), romFor(st)]);
        if (gen !== D.gen || D.disposed) return null;
        const ctx = mixer.ctx();
        if (!ctx || !mixer.destination('music')) return null;
        const music = await mod.createMusic({
          ctx, destination: mixer.destination('music'), fxDestination: mixer.destination('fx'), rom, soundtrack: st,
          onEnded: (index) => onEnded(index), onError: (e) => fail('music', e),
        });
        if (gen !== D.gen || D.disposed) { try { music.dispose(); } catch (_e) { /* ignore */ } return null; }
        D.music = music; D.musicFor = st; D.error = null;
        return music;
      } catch (e) { if (gen === D.gen) fail('load', e); return null; }
      finally { if (D.loading && D.loading.gen === gen) D.loading = null; }
    })();
    D.loading = { st, p, gen };
    return p;
  }

  /* ---- deciding what should be playing ---- */
  function sync() { return syncInner().catch((e) => { fail('sync', e); }); }       // a failure in here is recorded, never an unhandled rejection in the page
  async function syncInner() {
    if (D.disposed) return;
    if (!mixer.canPlay()) { pauseNow(); return; }
    if (!D.want) { stopNow(); return; }
    const want = D.want;
    const st = soundtrackNow();
    const music = await ensureMusic();
    if (!music || D.disposed || want !== D.want || !mixer.canPlay()) { if (music && !mixer.canPlay()) pauseNow(); return; }
    const r = resolveFn(st, want.key);
    if (!r) { if (D.cur) stopNow(); return; }
    if (D.cur && D.cur.index === r.song.index && D.cur.soundtrack === st) {
      if (D.paused) { D.paused = false; try { music.resume(); } catch (e) { fail('resume', e); } }
      return;
    }
    try {
      music.play(r.song.index, { fadeInMs: FADE.fadeInMs, crossfadeMs: FADE.crossfadeMs });
      D.plays++; D.paused = false;
      D.cur = { key: want.key, usedKey: r.key, index: r.song.index, soundtrack: st, jingle: !!r.song.jingle, loops: !!r.song.loops, label: r.song.label || '' };
      note(D.log, { op: 'play', key: want.key, usedKey: r.key, index: r.song.index, soundtrack: st, jingle: !!r.song.jingle });
    } catch (e) { fail('play', e); D.cur = null; }
  }
  function pauseNow() {
    if (D.music && D.cur && !D.paused) { try { D.music.pause(); D.paused = true; note(D.log, { op: 'pause' }); } catch (e) { fail('pause', e); } }
  }
  function stopNow(o) {
    if (D.music && D.cur) { try { D.music.stop({ fadeOutMs: (o && o.fadeOutMs) !== undefined ? o.fadeOutMs : FADE.fadeOutMs }); D.stops++; note(D.log, { op: 'stop' }); } catch (e) { fail('stop', e); } }
    D.cur = null; D.paused = false;
  }
  function onEnded(index) {
    D.ended++;
    note(D.log, { op: 'ended', index });
    const w = D.want;
    if (D.cur && D.cur.index === index) D.cur = null;
    if (w && w.then) { D.want = { key: w.then }; sync(); }
  }

  /* ---- the screens' API ---- */
  function set(key, then) {
    if (typeof key !== 'string' || !key) throw new Error('set(key): key must be a non-empty string');
    const same = D.want && D.want.key === key && D.want.then === then;
    D.want = { key, then };
    note(D.log, { op: 'want', key, then: then || null, same: !!same });
    if (!same || D.paused || !D.cur) sync();
  }
  function battle(cpu) { return set('battle_' + (CPU_LEVELS.includes(cpu) ? cpu : 'normal')); }
  /**
   * outcome: 'win' | 'lose' | 'draw'. A fanfare the soundtrack lacks is skipped straight to the result music. A fanfare that ENDS (a jingle, non-looping) hands over to the
   * result music when music.js reports it ended; a victory THEME that loops (SoulGold's trainer-victory song does) simply is the result music and nothing follows it.
   */
  function result(outcome) {
    const plan = RESULT_PLAN[outcome === 'win' || outcome === 'lose' ? outcome : 'draw'];
    const jingle = plan.first, after = plan.then;
    const j = jingle ? resolveFn(soundtrackNow(), jingle) : null;
    if (j) {
      if (j.song.loops && !j.song.jingle) return set(jingle);
      const a = resolveFn(soundtrackNow(), after);
      if (a && a.song.index === j.song.index) return set(jingle);        // the result music IS the fanfare: nothing to hand over to
      return set(jingle, after);
    }
    return set(after);
  }
  function stop(o) { D.want = null; note(D.log, { op: 'want', key: null }); stopNow(o); }
  function duck(on) { D.ducked = !!on; mixer.duck(on ? true : false); }

  /* ---- sound effects ---- */
  function playEffectIndex(index, pan, volume) {
    const rec = { index, pan: pan === undefined ? 0 : pan, played: false };
    if (!mixer.canPlay() || !D.music || !Number.isInteger(index) || index < 0 || typeof D.music.playEffect !== 'function') { rec.why = !mixer.canPlay() ? 'silent' : !D.music ? 'engine-not-ready' : 'bad-index'; note(D.sfx, rec); return null; }
    try { const h = D.music.playEffect(index, { pan: rec.pan, volume: volume === undefined ? 1 : volume }); rec.played = !(h && h.ignored); if (!rec.played) rec.why = 'ignored-by-engine'; note(D.sfx, rec); return h || true; }       // the engine may refuse (a higher-priority effect is still sounding on that player): handle.ignored
    catch (e) { fail('effect', e); rec.why = 'threw'; note(D.sfx, rec); return null; }
  }
  /** A sound effect by music_map key ('se_cursor', 'se_hit_super' ...). A key the soundtrack lacks is simply silent. */
  function playSfx(key, o) {
    let r = null;
    try { r = songFor(soundtrackNow(), key); } catch (_e) { r = null; }
    if (!r || !Number.isInteger(r.index)) { note(D.sfx, { key, played: false, why: 'no-song' }); return null; }
    const h = playEffectIndex(r.index, o && o.pan, o && o.volume);
    D.sfx[D.sfx.length - 1].key = key;
    return h;
  }

  /* ---- the mixer drives pause / resume / soundtrack changes ---- */
  const off = mixer.on((ev) => {
    if (D.disposed) return;
    if (ev.type === 'soundtrack') { stopNow({ fadeOutMs: 0 }); D.gen++; if (D.music) { try { D.music.dispose(); } catch (_e) { /* ignore */ } D.music = null; D.musicFor = null; } D.loading = null; sync(); return; }
    if (ev.type === 'unlock' || ev.type === 'state' || ev.type === 'mute' || ev.type === 'hidden' || ev.type === 'visible') sync();
  });

  function dispose() {
    D.disposed = true; D.gen++; off();
    if (D.music) { try { D.music.dispose(); } catch (_e) { /* ignore */ } }
    D.music = null; D.cur = null; D.want = null;
  }
  const state = () => ({
    want: D.want ? { ...D.want } : null, cur: D.cur ? { ...D.cur } : null, paused: D.paused, ducked: D.ducked, engine: !!D.music, loading: !!D.loading,
    engineState: (() => { try { return D.music && typeof D.music.state === 'function' ? D.music.state() : null; } catch (_e) { return null; } })(),       // music.js state(): index, playing, paused, underruns, bufferedMs ...
    soundtrack: soundtrackNow(), error: D.error, plays: D.plays, stops: D.stops, ended: D.ended,
    log: D.log.slice(), sfx: D.sfx.slice(),
  });

  return { set, battle, result, stop, duck, playSfx, playEffectIndex, sync, dispose, state, resolve: (key) => resolveFn(soundtrackNow(), key), _ensureMusic: ensureMusic };
}

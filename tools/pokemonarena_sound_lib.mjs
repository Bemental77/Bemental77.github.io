// tools/pokemonarena_sound_lib.mjs -- TEST-ONLY helpers shared by tools/pokemonarena_sound_test.mjs (Node) and tools/pokemonarena_sound_page_test.mjs (Chrome):
//   * installFakeAudio(scope, log): a recording AudioContext double with real-shaped AudioParam automation. It can NEVER reach a device.
//   * AUDIO_DOUBLE_SRC: the same function as a string, to inject into a page before any page script runs (the page uses the identical code).
//   * makeStubMusic(log) / makeStubMap(): stand-ins with the EXACT signatures of the shared contract (pokemonarena-music.md) for music.js and
//     music_map.js, used until / besides the real modules. STUB_MODULES_SRC injects them as window.__arenaSoundModules.
// Pure ASCII.

/* eslint-disable no-undef */
export function installFakeAudio(scope, log) {
  let ids = 0;
  class Param {
    constructor(v) { this._v = v; this.calls = []; this.target = v; }
    get value() { return this._v; }
    set value(v) { this._v = v; this.target = v; }
    cancelScheduledValues(t) { this.calls.push(['cancel', t]); }
    setValueAtTime(v, t) { this.calls.push(['set', v, t]); this._v = v; }
    linearRampToValueAtTime(v, t) { this.calls.push(['ramp', v, t]); this.target = v; this._v = v; }
  }
  class Node {
    constructor(ctx, kind) { this.ctx = ctx; this.kind = kind; this.id = ++ids; this.out = []; }
    connect(n) { this.out.push(n); log.connects.push([this.id, n && n.id !== undefined ? n.id : 'destination']); return n; }
    disconnect() { log.disconnects++; }
  }
  class Gain extends Node { constructor(ctx) { super(ctx, 'gain'); this.gain = new Param(1); log.gain++; log.gains.push(this); } }
  class Shaper extends Node { constructor(ctx) { super(ctx, 'waveshaper'); this.curve = null; this.oversample = '2x'; log.waveShapers.push(this); } }
  class Source extends Node {
    constructor(ctx) { super(ctx, 'source'); this.buffer = null; this.playbackRate = { value: 1 }; this.onended = null; log.createBufferSource++; log.sources.push(this); }
    start(when) { log.start++; log.starts.push(when); }
    stop() { log.stops++; }
  }
  class FakeCtx {
    constructor(opts) {
      log.ctor++; log.ctorArgs.push(opts === undefined ? null : opts);
      this.state = 'suspended'; this.currentTime = 0; this.sampleRate = 48000; this.destination = { id: 'destination', kind: 'destination' }; this.onstatechange = null;
      log.ctxs.push(this);
    }
    _set(state) { if (this.state === state) return; this.state = state; if (typeof this.onstatechange === 'function') this.onstatechange(); }
    resume() { log.resume++; return Promise.resolve().then(() => { this._set('running'); }); }
    suspend() { log.suspend++; return Promise.resolve().then(() => { this._set('suspended'); }); }
    close() { log.close++; this.state = 'closed'; return Promise.resolve(); }
    createGain() { return new Gain(this); }
    createBuffer(ch, len, rate) { log.createBuffer++; log.rates.push(rate); const d = new Float32Array(len); return { numberOfChannels: ch, length: len, sampleRate: rate, duration: len / rate, getChannelData: () => d }; }
    createBufferSource() { return new Source(this); }
    createWaveShaper() { return new Shaper(this); }
  }
  Object.assign(log, { ctor: 0, ctorArgs: [], ctxs: [], gain: 0, gains: [], connects: [], disconnects: 0, createBuffer: 0, createBufferSource: 0, sources: [], start: 0, starts: [], stops: 0, resume: 0, suspend: 0, close: 0, rates: [], waveShapers: [] });
  scope.AudioContext = FakeCtx; scope.webkitAudioContext = FakeCtx;
  return FakeCtx;
}
export const newAudioLog = () => ({});

// the same double, as a page-injectable string. window.__snd is the log (plain data + the live ctx objects).
export const AUDIO_DOUBLE_SRC = `(() => { if (/[?&]realaudio=1/.test(location.search)) return;       // the one scenario that runs the REAL AudioContext (Chrome is muted: --mute-audio)
  const log = window.__snd = {}; (${installFakeAudio.toString()})(window, log); })();`;

/* ------------------------------------------------------------------------------------------------ stand-ins for the contract modules */

const jt = (index, label, o) => Object.assign({ index, loops: true, jingle: false, label }, o || {});
export const STUB_SONGS = Object.freeze({
  soulgold: Object.freeze({
    hub: jt(10, 'SG hub'), editor: jt(11, 'SG editor'), preview: jt(12, 'SG preview'),
    battle_easy: jt(20, 'SG wild'), battle_normal: jt(21, 'SG trainer'), battle_hard: jt(22, 'SG gym'),
    victory_sting: jt(30, 'SG victory sting', { loops: false, jingle: true }), victory: jt(32, 'SG victory theme'), defeat: jt(31, 'SG defeat', { loops: false, jingle: true }),
    result_win: jt(40, 'SG result win'), result_lose: jt(41, 'SG result lose'),
    se_cursor: jt(200, 'SG cursor', { loops: false, jingle: true }), se_select: jt(201, 'SG select', { loops: false, jingle: true }), se_back: jt(202, 'SG back', { loops: false, jingle: true }),
    se_hit_normal: jt(203, 'SG hit', { loops: false, jingle: true }), se_hit_super: jt(204, 'SG hit super', { loops: false, jingle: true }), se_hit_weak: jt(205, 'SG hit weak', { loops: false, jingle: true }),
    se_faint: jt(206, 'SG faint', { loops: false, jingle: true }), se_ball_open: jt(207, 'SG ball open', { loops: false, jingle: true }),
  }),
  // Ultra Violet deliberately lacks battle_hard, the jingles and most effects: the director's fallbacks are tested against it
  ultraviolet: Object.freeze({
    hub: jt(110, 'UV hub'), battle_easy: jt(120, 'UV wild'), battle_normal: jt(121, 'UV trainer'), result_win: jt(140, 'UV result'),
    se_cursor: jt(300, 'UV cursor', { loops: false, jingle: true }),
  }),
});
export function makeStubMap(songs = STUB_SONGS) {
  return {
    SOUNDTRACKS: ['soulgold', 'ultraviolet'],
    MUSIC_KEYS: Object.keys(songs.soulgold),
    ROM_PROFILES: { soulgold: { size: 33554432, sha256: 'x'.repeat(64) }, ultraviolet: { size: 16777216, sha256: null } },
    songFor(soundtrack, key) { const t = songs[soundtrack]; return t && Object.prototype.hasOwnProperty.call(t, key) ? { ...t[key] } : null; },
  };
}
// a stand-in for music.js with the contract's signatures; every call is recorded in `log`
export function makeStubMusic(log) {
  Object.assign(log, { create: [], play: [], stop: [], pause: 0, resume: 0, dispose: 0, effect: [], instances: [], failCreate: false });
  return {
    async createMusic({ ctx, destination, fxDestination, rom, soundtrack, onEnded, onError }) {
      if (log.failCreate) throw new Error('stub engine refused to start');
      log.create.push({ soundtrack, romLen: rom ? rom.length : -1, dest: destination ? destination.id : null, fx: fxDestination ? fxDestination.id : null, hasCtx: !!ctx });
      let cur = null, paused = false;
      const m = {
        play(index, o) { log.play.push({ index, soundtrack, fadeInMs: o && o.fadeInMs, crossfadeMs: o && o.crossfadeMs }); cur = index; paused = false; },
        stop(o) { log.stop.push(o || {}); cur = null; },
        pause() { log.pause++; paused = true; }, resume() { log.resume++; paused = false; },
        dispose() { log.dispose++; },
        state() { return { index: cur, playing: cur !== null && !paused, loops: true, positionMs: 0 }; },
        playEffect(index, o) { log.effect.push({ index, pan: o && o.pan, volume: o && o.volume }); return { stop() {} }; },
        _end(index) { if (typeof onEnded === 'function') onEnded(index === undefined ? cur : index); },
        _error(e) { if (typeof onError === 'function') onError(e); },
      };
      log.instances.push(m);
      return m;
    },
  };
}
// injected into a page: window.__arenaSoundModules -> stand-ins; window.__sndMusic is the log; window.__sndMusicEnd(index) ends the jingle
export const STUB_MODULES_SRC = `(() => {
  if (/[?&]nostubs=1/.test(location.search)) return;       // the REAL music.js / music_map.js session
  const jt = ${jt.toString()};
  const SONGS = ${JSON.stringify(STUB_SONGS)};
  const mk = ${makeStubMusic.toString()};
  const mapMk = ${makeStubMap.toString()};
  const log = window.__sndMusic = {};
  const music = mk(log);
  const map = mapMk(SONGS);
  window.__sndMusicEnd = (i) => { const m = log.instances[log.instances.length - 1]; if (m) m._end(i); };
  window.__arenaSoundModules = { music: async () => music, map: async () => map, uvRom: async (onProgress) => { onProgress(1, 2); onProgress(2, 2); window.__sndUvFetched = (window.__sndUvFetched || 0) + 1; if (window.__sndUvFail) throw new Error('stub server answered 404'); return new Uint8Array(16777216); } };
})();`;

// pokemonarena/js/music.js -- the ROM's own music (and sound effects) in the browser: createMusic / renderSong / listSongs.
//
// ES module for browsers AND Node. It never creates an AudioContext and never opens a device: the page hands in `ctx`
// (an AudioContext, or the recording test double in music_test_double.js) and `destination` (an AudioNode).
//
//   import { createMusic, renderSong, listSongs } from './music.js';
//   const music = await createMusic({ ctx, destination: musicBus, fxDestination: fxBus, rom, soundtrack: 'soulgold', onEnded, onError });
//   music.play(802, { fadeInMs: 400, crossfadeMs: 600 });     // song-table index; crossfades from the current song
//   music.playEffect(34, { pan: 0, volume: 1 });              // a sound effect on its own player, routed to fxDestination
//   music.stop({ fadeOutMs: 600 });  music.pause();  music.resume();  music.dispose();
//   music.state();   // { index, playing, loops, positionMs, paused, underruns, effects, ... }
//
//   // pure, deterministic, offline (every test and the oracle comparison use these):
//   const { left, right, meta } = renderSong(rom, 802, { seconds: 10, sampleRate: 32768 });
//
// Everything is decoded from the ROM bytes at runtime (mp2k.js parses, mp2k_synth.js sequences and mixes). No ROM bytes,
// samples or rendered audio live in the repository.
//
// REAL-TIME DESIGN (see MUSIC.md "Real-time buffering, seams, and start-up cost"): the synth runs on the main thread in 0.25 s chunks rendered AT THE
// AudioContext'S OWN SAMPLE RATE (never resampled by the browser: Chrome doubled the boundary sample of rate-converted chunks on a 48000 Hz context), each chunk one
// AudioBuffer scheduled back-to-back on a whole context frame, and the scheduler keeps >= 1.0 s of audio queued ahead of ctx.currentTime (top-up every 100 ms; play()
// renders only the first chunk). A busy tab therefore has to stall for more than a second before the music glitches; a missed top-up that lets the queue run dry is
// counted in state().underruns and the stream resumes from "now" instead of bursting. renderSong stays at 32768 Hz: the deterministic reference for goldens and the oracle.
// Worst-case render cost and the seams are measured in tools/pokemonarena_music_test.mjs.

import { Mp2kRom, Mp2kError } from './mp2k.js';
import { SongEngine, analyzeSong, DEFAULT_MIXER, FRAME_HZ } from './mp2k_synth.js';

export { Mp2kError, analyzeSong, FRAME_HZ };

export const MUSIC_SAMPLE_RATE = 32768;

/**
 * Mixer settings of each ROM's running game, MEASURED from the oracle (gSoundInfo in RAM after boot, see MUSIC.md
 * "Mixer profiles"): maxChans = direct-sound channels, masterVol, mixRate = pcmFreq (13379 Hz = frequency index 4).
 * `steal` is the tie-break when every direct-sound channel is busy and an equal-priority note arrives ("A": the earlier track may take it,
 * "S": never); it is NOT understood, it was chosen per ROM by oracle score (MUSIC.md "voice stealing").
 */
export const MIXER_PROFILES = Object.freeze({
  soulgold: Object.freeze({ maxChans: 12, masterVol: 12, mixRate: 13379, reverb: 0, steal: 'A', mono: false }),   // gSoundInfo.mode = 0: stereo
  ultraviolet: Object.freeze({ maxChans: 5, masterVol: 12, mixRate: 13379, reverb: 0, steal: 'S', mono: true }),   // gSoundInfo.mode = 1: the real output is mono (L == R in every one of 73 music songs + 7 effects captured)
});

const romCache = new WeakMap();

/** Wrap raw ROM bytes (cached per buffer object so repeated renderSong calls do not re-scan). */
export function openRom(rom, opts) {
  if (rom instanceof Mp2kRom) return rom;
  const key = rom && rom.buffer ? rom : null;
  if (key && !(opts && opts.hint) && romCache.has(key)) return romCache.get(key);
  const r = new Mp2kRom(rom, opts);
  if (key && !(opts && opts.hint)) romCache.set(key, r);
  return r;
}

/** Which soundtrack's mixer profile fits this ROM: by header game code (BPEE = SoulGold, PUVV = Ultra Violet), else null (then DEFAULT_MIXER applies). */
export function detectSoundtrack(rom) {
  const r = rom instanceof Mp2kRom ? rom : openRom(rom);
  const code = String.fromCharCode(r.bytes[0xAC], r.bytes[0xAD], r.bytes[0xAE], r.bytes[0xAF]);
  if (code === 'BPEE') return 'soulgold';
  if (code === 'PUVV') return 'ultraviolet';
  return null;
}

function mixerFor(r, soundtrack, override) {
  const st = soundtrack || detectSoundtrack(r);
  return { ...DEFAULT_MIXER, ...(st && MIXER_PROFILES[st] ? MIXER_PROFILES[st] : {}), ...(override || {}) };
}

/** [{ index, tracks, priority, reverb, player, empty }] for every entry of the ROM's song table (cheap: headers only). */
export function listSongs(rom, opts = {}) {
  const r = openRom(rom);
  const out = [];
  for (let i = 0; i < r.songCount; i++) {
    let h;
    try { h = r.song(i); } catch (e) { out.push({ index: i, error: e.code || String(e.message) }); continue; }
    const row = { index: i, tracks: h.trackCount, priority: h.priority, reverb: h.reverbSet ? h.reverb : null, player: h.player, empty: h.empty };
    if (opts.analyze && !h.empty) {
      try { const a = analyzeSong(r, i); row.lengthMs = a.lengthMs; row.loops = a.loops; row.loopStartMs = a.loopStartMs; row.loopLengthMs = a.loopLengthMs; row.bpm = a.firstBpm; row.notes = a.notes; }
      catch (e) { row.error = e.code || String(e.message); }
    }
    out.push(row);
  }
  return out;
}

/**
 * Deterministic offline render of any song-table index (music, jingles and sound effects alike).
 *   opts.seconds     exact duration to render (zero-padded after a jingle's tail has died). Default: a jingle's length + 0.5 s
 *                    tail, or intro + `loops` passes of the loop body for a looping song.
 *   opts.loops       passes of the loop body when `seconds` is not given (default 1).
 *   opts.sampleRate  8000..192000 (default 32768).
 *   opts.soundtrack  'soulgold' | 'ultraviolet' (mixer profile; default: detected from the ROM header).
 *   opts.mixer       explicit mixer overrides { maxChans, masterVol, mixRate, reverb, pcmGain, psgGain }.
 *   opts.only        'ds' | 'sq' | 'wave' | 'noise' | 'psg': render one voice family (calibration/tests).
 *   opts.maxSeconds  budget (default 600): a request above it throws Mp2kError('render-budget').
 * Returns { left, right: Float32Array, meta }.
 */
export function renderSong(rom, index, opts = {}) {
  const r = openRom(rom);
  const sampleRate = opts.sampleRate || MUSIC_SAMPLE_RATE;
  const maxSeconds = opts.maxSeconds || 600;
  const a = analyzeSong(r, index);
  let seconds = opts.seconds;
  if (seconds === undefined) {
    const loops = opts.loops === undefined ? 1 : opts.loops;
    if (a.loops) seconds = (a.loopStartMs + Math.max(1, loops) * a.loopLengthMs) / 1000 + 0.2;
    else seconds = a.lengthMs / 1000 + 0.5;
  }
  if (!(seconds > 0) || !isFinite(seconds)) throw new Mp2kError('render-budget', `seconds must be a positive number, got ${seconds}`);
  if (seconds > maxSeconds) throw new Mp2kError('render-budget', `render of ${seconds}s exceeds the ${maxSeconds}s budget`, { seconds, maxSeconds });
  const n = Math.round(seconds * sampleRate);
  const eng = new SongEngine(r, index, { sampleRate, mixer: mixerFor(r, opts.soundtrack, opts.mixer), only: opts.only, tempoScale: opts.tempoScale });
  const left = new Float32Array(n), right = new Float32Array(n);
  const got = eng.read(left, right, 0, n);
  let peak = 0;
  for (let i = 0; i < got; i++) { const l = Math.abs(left[i]), rr = Math.abs(right[i]); if (l > peak) peak = l; if (rr > peak) peak = rr; }
  const meta = {
    index, soundtrack: opts.soundtrack || detectSoundtrack(r), sampleRate, seconds, frames: n, rendered: got,
    tracks: a.tracks, tempo: a.firstBpm, tempoChanges: a.tempo, priority: a.priority, reverb: a.reverb, player: r.song(index).player,
    loops: a.loops, loopStartMs: a.loopStartMs, loopLengthMs: a.loopLengthMs, lengthMs: a.lengthMs, jingle: a.jingle, notes: a.notes,
    peak, maxPolyphony: eng.stats.maxPoly, stolen: eng.stats.stolen, dropped: eng.stats.dropped, badVoices: eng.stats.badVoice, voiceNotes: eng.stats.kinds,
  };
  return { left, right, meta };
}

// ---------------------------------------------------------------------------------------------------------------
// real time
// ---------------------------------------------------------------------------------------------------------------

const CHUNK_SECONDS = 0.25;
const LOOKAHEAD_SECONDS = 1.0;
const START_DELAY_SECONDS = 0.05;
const PUMP_MS = 100;
const MAX_EFFECTS = 8;

/**
 * One playing song (BGM or SE): its engine, a gain node, and the queue of scheduled buffers.
 *
 * SCHEDULING IS DONE IN WHOLE CONTEXT FRAMES AT THE CONTEXT'S OWN SAMPLE RATE. The first version rendered 32768 Hz buffers and let the browser
 * resample them; Chrome's AudioBufferSourceNode then rendered one extra output frame at the end of every rate-converted buffer, which landed on the
 * first frame of the next buffer and DOUBLED it (a one-sample click every 0.25 s on a 48000 Hz context, measured; MUSIC.md "Seams"). Buffers that
 * already have the context's rate are not resampled, so chunk N ends on exactly the frame chunk N+1 starts on.
 */
class Voice {
  constructor(owner, index, header, destination, opts) {
    this.owner = owner; this.ctx = owner.ctx; this.index = index; this.header = header;
    this.rate = owner.bufferRate;
    this.engine = new SongEngine(owner.r, index, { sampleRate: this.rate, mixer: owner.mixerFor(opts.reverbFallback) });
    this._analysis = null;
    this.gain = this.ctx.createGain();
    this.gain.gain.value = 0;
    let tail = this.gain;
    if (opts.pan !== undefined && typeof this.ctx.createStereoPanner === 'function') {
      this.panner = this.ctx.createStereoPanner();
      this.panner.pan.value = opts.pan;
      this.gain.connect(this.panner);
      tail = this.panner;
    }
    tail.connect(destination);
    this.tail = tail;
    this.queue = [];            // { buffer, startFrame, frames, src, l, r }
    this.nextFrame = -1;        // context frame (integer) at which the next chunk starts; -1 before the first chunk
    this.startedAt = 0;         // context time of the first chunk
    this.rendered = 0;          // seconds of audio produced
    this.finished = false;      // engine produced its last sample
    this.endTime = 0;
    this.level = opts.volume === undefined ? 1 : opts.volume;
    this.paused = false;
    this.pausedAtFrame = 0;
    this.disposed = false;
    this.endedNotified = false;
  }
  /** Loop/length analysis of the song: computed on first use (a few ms), not on the start-up path. */
  get analysis() { if (!this._analysis) this._analysis = this.owner.analysisOf(this.index); return this._analysis; }
  get nextStart() { return this.nextFrame < 0 ? 0 : this.nextFrame / this.rate; }
  fadeTo(value, ms, now) {
    const g = this.gain.gain;
    if (typeof g.cancelScheduledValues === 'function') g.cancelScheduledValues(now);
    if (ms > 0) { g.setValueAtTime(g.value, now); g.linearRampToValueAtTime(value, now + ms / 1000); }
    else g.setValueAtTime(value, now);
  }
  /**
   * Render and schedule chunks until >= LOOKAHEAD_SECONDS are queued ahead of the context clock, at most `maxChunks` per call so one call never
   * becomes a long task (default: 2 chunks when less than 0.5 s is queued, else 1).
   */
  pump(now, maxChunks) {
    if (this.disposed || this.paused) return;
    const rate = this.rate;
    while (this.queue.length && this.queue[0].startFrame + this.queue[0].frames <= now * rate) this.queue.shift();
    if (this.finished) return;
    if (this.nextFrame < 0) { this.nextFrame = Math.ceil((now + START_DELAY_SECONDS) * rate); this.startedAt = this.nextFrame / rate; this.legacyT = now + START_DELAY_SECONDS; }
    else if (this.nextFrame < now * rate) { this.owner.underruns++; this.nextFrame = Math.ceil((now + 0.02) * rate); }
    const allowed = maxChunks || (this.nextFrame / rate - now < 0.5 ? 2 : 1);
    let made = 0;
    while (this.nextFrame / rate - now < LOOKAHEAD_SECONDS && !this.finished && made++ < allowed) {
      const n = Math.round(CHUNK_SECONDS * rate);
      const l = new Float32Array(n), r = new Float32Array(n);
      const got = this.engine.read(l, r, 0, n);
      if (got < n) this.finished = true;
      if (got === 0) { this.endTime = this.nextFrame / rate; break; }
      this._schedule(l, r, got, this.nextFrame);
      this.nextFrame += got;
      this.rendered += got / rate;
      if (this.finished) this.endTime = this.nextFrame / rate;
    }
  }
  _schedule(l, r, frames, startFrame) {
    const buf = this.ctx.createBuffer(2, frames, this.rate);
    const ll = frames === l.length ? l : l.subarray(0, frames), rr = frames === r.length ? r : r.subarray(0, frames);
    if (buf.copyToChannel) { buf.copyToChannel(ll, 0); buf.copyToChannel(rr, 1); }
    else { buf.getChannelData(0).set(ll); buf.getChannelData(1).set(rr); }
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.gain);
    let when = startFrame / this.rate;
    if (this.owner.legacy) { when = this.legacyT; this.legacyT += frames / this.rate; }   // TEST HOOK (_bufferRate): the pre-fix scheduling, start = now + 0.05 + k * 0.25 s as floats
    src.start(when);
    this.queue.push({ buffer: buf, startFrame, frames, src, l: ll, r: rr });
  }
  positionMs(now) { return this.startedAt ? Math.max(0, Math.round((now - this.startedAt) * 1000)) : 0; }
  pause(now) {
    if (this.paused || this.disposed) return;
    this.paused = true; this.pausedAtFrame = Math.floor(now * this.rate);
    this.fadeTo(0, 0, now);
    for (const q of this.queue) { try { q.src.stop(now); } catch (e) { /* already stopped */ } }
  }
  resume(now) {
    if (!this.paused || this.disposed) return;
    this.paused = false;
    const pending = this.queue.filter((q) => q.startFrame + q.frames > this.pausedAtFrame);
    this.queue = [];
    let t = Math.ceil((now + START_DELAY_SECONDS) * this.rate);
    for (const q of pending) {
      const played = Math.max(0, this.pausedAtFrame - q.startFrame);
      const frames = q.frames - played;
      if (frames <= 0) continue;
      this._schedule(q.l.subarray(played), q.r.subarray(played), frames, t);
      t += frames;
    }
    this.nextFrame = t;
    if (this.finished) this.endTime = this.nextFrame / this.rate;
    this.fadeTo(this.level, 30, now);
  }
  dispose(now, fadeMs) {
    if (this.disposed) return;
    this.disposed = true;
    const stopAt = now + Math.max(0, fadeMs) / 1000 + 0.02;
    if (fadeMs > 0) this.fadeTo(0, fadeMs, now);
    for (const q of this.queue) { try { q.src.stop(stopAt); } catch (e) { /* not started */ } }
    this.queue = [];
    const g = this.gain, t = this.tail;
    this.owner.later(() => { try { g.disconnect(); if (t !== g) t.disconnect(); } catch (e) { /* ignore */ } }, (fadeMs + 60));
  }
}

/**
 * Create the music player. `rom` is the ROM bytes (Uint8Array/ArrayBuffer) or an Mp2kRom.
 *   ctx            AudioContext (or music_test_double.js's recording double). Never created here.
 *   destination    AudioNode that receives the BGM (MU3 passes the Music bus gain node).
 *   fxDestination  AudioNode for sound effects (default: destination).
 *   soundtrack     'soulgold' | 'ultraviolet' (mixer profile).
 *   onEnded(index) a non-looping song (jingle) has finished playing out.
 *   onError(err)   a song failed to parse/render; the game stays silent, never throws into the UI.
 *   timers         { setInterval, clearInterval, setTimeout, clearTimeout } (tests inject fakes).
 *   hint           optional { offset, count } song-table location. NOT needed: the two shipped ROMs are recognised by header code + size and their table is
 *                  verified in about a millisecond (any mismatch falls back to the ~100 ms whole-ROM scan).
 *   _bufferRate    TEST HOOK: force the AudioBuffer rate (e.g. 32768, the pre-fix behaviour that Chrome resamples with an audible seam on a 48000 Hz context).
 */
export async function createMusic({ ctx, destination, fxDestination, rom, soundtrack, onEnded, onError, timers, hint, _bufferRate } = {}) {
  if (!ctx || typeof ctx.createGain !== 'function') throw new Mp2kError('no-context', 'createMusic needs an AudioContext (or the test double) as `ctx`');
  if (!destination) throw new Mp2kError('no-destination', 'createMusic needs a `destination` node');
  const T = timers || { setInterval: (f, ms) => setInterval(f, ms), clearInterval: (h) => clearInterval(h), setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (h) => clearTimeout(h) };
  const r = openRom(rom, hint ? { hint } : undefined);
  const st = soundtrack || detectSoundtrack(r);
  const analysisCache = new Map();
  // AudioBuffers are rendered AT THE CONTEXT'S RATE so the browser never resamples a chunk (see class Voice); an unusable rate falls back to 32768
  const bufferRate = _bufferRate || (ctx.sampleRate >= 8000 && ctx.sampleRate <= 192000 ? Math.round(ctx.sampleRate) : MUSIC_SAMPLE_RATE);
  const owner = {
    ctx, r, underruns: 0, bufferRate, legacy: !!_bufferRate,
    mixerFor: (reverbFallback) => { const m = mixerFor(r, st); if (reverbFallback !== undefined) m.reverb = reverbFallback; return m; },
    analysisOf: (i) => { let a = analysisCache.get(i); if (!a) { a = analyzeSong(r, i); analysisCache.set(i, a); } return a; },
    later: (fn, ms) => T.setTimeout(fn, ms),
  };
  let bgm = null;           // the Voice that is current
  let fading = [];          // voices crossfading out
  let paused = false;
  let disposed = false;
  const players = new Map();  // SE player index -> { voice, priority }
  const effects = new Set();
  let timer = null;
  let lastReverb = 0;

  const safeLoops = (v) => { try { return v.analysis.loops; } catch (e) { return false; } };
  const fail = (e) => { if (typeof onError === 'function') { try { onError(e); } catch (x) { /* never throw into the page */ } } };

  function tick() {
    if (disposed) return;
    const now = ctx.currentTime;
    if (bgm) {
      try {
        bgm.pump(now);
        if (bgm.finished && !bgm.endedNotified && !paused && now >= bgm.endTime && bgm.endTime > 0) {
          bgm.endedNotified = true;
          const idx = bgm.index;
          if (typeof onEnded === 'function') { try { onEnded(idx); } catch (x) { /* never throw into the scheduler */ } }
        }
      } catch (e) { fail(e); const dead = bgm; bgm = null; dead.dispose(now, 0); }   // a song that cannot be rendered is dropped, silently for the page
    }
    for (const v of [...effects]) {
      try {
        v.pump(now);
        if (v.finished && now >= v.endTime && v.endTime > 0) { effects.delete(v); v.dispose(now, 0); for (const [p, e] of players) if (e.voice === v) players.delete(p); }
      } catch (e) { fail(e); effects.delete(v); v.dispose(now, 0); for (const [p, en] of players) if (en.voice === v) players.delete(p); }
    }
    // a voice that is fading out keeps being fed until its fade is over, so a long fade never runs dry
    fading = fading.filter((v) => { if (v.fadeUntil <= now) { v.dispose(now, 0); return false; } try { v.pump(now); } catch (e) { fail(e); v.dispose(now, 0); return false; } return true; });
  }
  function ensureTimer() { if (!timer) timer = T.setInterval(tick, PUMP_MS); }

  const music = {
    /** Start song `index` on the BGM player, crossfading from the current one. Never throws: failures go to onError. */
    play(index, { fadeInMs = 400, crossfadeMs = 600 } = {}) {
      if (disposed) return false;
      let voice;
      try {
        const h = r.song(index);
        if (h.empty) { fail(new Mp2kError('empty-song', `song ${index} has no tracks`, { index })); return false; }
        voice = new Voice(owner, index, h, destination, { reverbFallback: lastReverb });
      } catch (e) { fail(e); return false; }
      const now = ctx.currentTime;
      if (bgm) { const old = bgm; old.fadeUntil = now + crossfadeMs / 1000 + 0.05; old.fadeTo(0, crossfadeMs, now); fading.push(old); }
      bgm = voice;
      if (voice.header.reverbSet) lastReverb = voice.header.reverb;
      voice.fadeTo(voice.level, fadeInMs, now);
      paused = false;
      try { voice.pump(now, 1); } catch (e) { fail(e); bgm = null; voice.dispose(now, 0); return false; }   // ONE chunk on the call itself (short task); the 100 ms timer tops up to 1 s
      ensureTimer();
      T.setTimeout(() => { try { void voice.analysis; } catch (e) { /* surfaced by state() as loops:false */ } }, 150);   // loop analysis off the start-up path
      return true;
    },
    stop({ fadeOutMs = 600 } = {}) {
      if (disposed || !bgm) return;
      const now = ctx.currentTime;
      const v = bgm; bgm = null; paused = false;
      v.fadeUntil = now + fadeOutMs / 1000 + 0.05;
      v.fadeTo(0, fadeOutMs, now);
      fading.push(v);
    },
    pause() {
      if (disposed || paused) return;
      paused = true;
      const now = ctx.currentTime;
      if (bgm) bgm.pause(now);
      for (const v of effects) v.pause(now);
    },
    resume() {
      if (disposed || !paused) return;
      paused = false;
      const now = ctx.currentTime;
      if (bgm) bgm.resume(now);
      for (const v of effects) v.resume(now);
    },
    dispose() {
      if (disposed) return;
      const now = ctx.currentTime;
      disposed = true;
      if (timer) { T.clearInterval(timer); timer = null; }
      if (bgm) bgm.dispose(now, 0);
      for (const v of fading) v.dispose(now, 0);
      for (const v of effects) v.dispose(now, 0);
      bgm = null; fading = []; effects.clear(); players.clear();
    },
    state() {
      const now = ctx.currentTime;
      const v = bgm;
      return {
        index: v ? v.index : null,
        playing: !!v && !paused && !(v.finished && now >= v.endTime && v.endTime > 0),
        loops: v ? safeLoops(v) : false,
        positionMs: v ? v.positionMs(now) : 0,
        paused, underruns: owner.underruns, effects: effects.size, crossfading: fading.length,
        soundtrack: st, bufferRate, bufferedMs: v ? Math.max(0, Math.round((v.nextStart - now) * 1000)) : 0, disposed,
      };
    },
    /**
     * Play a song-table entry (normally a sound effect) on its own player, overlapping the BGM, routed to fxDestination.
     *   pan     -1..1, or the engine's -63..63 (any |pan| > 1 is read as engine units and divided by 63). 0 = centre.
     *   volume  0..1 (default 1).
     * The engine's player rule is modelled: each SE player (the entry's `player` 1..3; player 0 entries use player 1) runs one
     * song at a time and a new song replaces it only when its header priority is >= the playing one's; otherwise the new
     * effect is ignored (handle.ignored = true). At most 8 effects sound at once (CPU guard); the 9th is ignored.
     * Returns a handle { index, player, ignored, stop(), done }.
     */
    playEffect(index, { pan = 0, volume = 1 } = {}) {
      const handle = { index, player: 0, ignored: false, done: false, stop() { } };
      if (disposed) { handle.ignored = true; handle.done = true; return handle; }
      let h;
      try { h = r.song(index); } catch (e) { fail(e); handle.ignored = true; handle.done = true; return handle; }
      if (h.empty) { handle.ignored = true; handle.done = true; return handle; }
      const player = h.player >= 1 && h.player <= 3 ? h.player : 1;
      handle.player = player;
      const cur = players.get(player);
      const now = ctx.currentTime;
      if (cur && !cur.voice.disposed && !(cur.voice.finished && now >= cur.voice.endTime) && cur.priority > h.priority) { handle.ignored = true; handle.done = true; return handle; }
      if (!cur && effects.size >= MAX_EFFECTS) { handle.ignored = true; handle.done = true; return handle; }
      if (cur) { effects.delete(cur.voice); cur.voice.dispose(now, 5); players.delete(player); }
      let voice;
      try {
        const p = Math.abs(pan) > 1 ? Math.max(-1, Math.min(1, pan / 63)) : pan;
        voice = new Voice(owner, index, h, fxDestination || destination, { pan: p, volume: Math.max(0, Math.min(1, volume)), reverbFallback: lastReverb });
      } catch (e) { fail(e); handle.ignored = true; handle.done = true; return handle; }
      voice.fadeTo(voice.level, 0, now);
      try { voice.pump(now, 1); } catch (e) { fail(e); voice.dispose(now, 0); handle.ignored = true; handle.done = true; return handle; }
      effects.add(voice);
      players.set(player, { voice, priority: h.priority });
      ensureTimer();
      handle.stop = () => { if (!voice.disposed) { effects.delete(voice); voice.dispose(ctx.currentTime, 30); handle.done = true; if (players.get(player) && players.get(player).voice === voice) players.delete(player); } };
      return handle;
    },
    /** Test hook: run one scheduler pass now (tests drive time themselves). */
    _tick: tick,
  };
  return music;
}

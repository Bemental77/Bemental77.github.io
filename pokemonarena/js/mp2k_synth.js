// pokemonarena/js/mp2k_synth.js -- the m4a / MP2K ("Sappy") sequencer + software mixer, pure and deterministic.
//
// Pure ES module for browsers AND Node. No DOM, no AudioContext, no clock, no Math.random: the same ROM, song index and
// options always produce the SAME float samples (music.golden.json pins hashes of them). Input is a Mp2kRom (mp2k.js).
//
// WHAT THIS REPRODUCES FROM THE GBA ENGINE (all of it re-implemented first-party from the engine's documented behaviour
// and checked against the game's own engine running in the mGBA oracle: tools/pokemonarena_music_oracle.mjs):
//   * the tick model: 24 ticks per quarter note, `tempoC += tempoD*tempoU/256; while (tempoC >= 150) tick()`, run once per
//     video frame (59.7275 Hz), with the engine's order inside a tick (channel gate countdown, then track commands, then
//     the track wait counter, then the LFO);
//   * the command set (notes with gate-time, TIE/EOT, rests, TEMPO, VOICE, VOL, PAN, BEND, BENDR, MOD, MODT, LFOS, LFODL,
//     TUNE, KEYSH, PRIO, GOTO, PATT/PEND, REPT, FINE, XCMD echo) with running status;
//   * track volume/pan/pitch maths (TrkVolPitSet), per-channel volume (ChnVolSet), the direct-sound envelope in the
//     engine's per-frame steps (attack add, decay multiply, sustain level, release multiply), linear-interpolated PCM
//     playback with loop points, fixed-frequency voices, DPCM-compressed samples, key-split and rhythm voicegroups,
//     programmable-wave / square / noise "CGB" voices with the engine's frame-stepped envelope, and the engine's
//     frame-delay reverb.
// WHAT IS APPROXIMATE is listed in pokemonarena/MUSIC.md ("Deviations from the real engine").

import { Mp2kError } from './mp2k.js';

export const FRAME_HZ = 16777216 / 280896; // 59.7275...: the video frame rate the engine is driven at
export const TICKS_PER_QUARTER = 24;
// gClockTable: note lengths and rests (cmd - 0xCF for notes, cmd - 0x80 for rests)
export const CLOCK = Object.freeze([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24,
  28, 30, 32, 36, 40, 42, 44, 48, 52, 54, 56, 60, 64, 66, 68, 72, 76, 78, 80, 84, 88, 90, 92, 96]);
// GB noise register (NR43) per key 21..80, the engine's gNoiseTable: shift 0xD..0, divisor 7..4 then 3..0
const NOISE_TABLE = (() => { const t = []; for (let s = 0xD; s >= 0; s--) for (let d = 7; d >= 4; d--) t.push((s << 4) | d); t.push(3, 2, 1, 0); return Object.freeze(t); })();
const DUTY = Object.freeze([[0, 0, 0, 0, 0, 0, 0, 1], [1, 0, 0, 0, 0, 0, 0, 1], [1, 0, 0, 0, 0, 1, 1, 1], [0, 1, 1, 1, 1, 1, 1, 0]]);
// Wave-channel output level (SOUND3CNT_H volume code) for a 4-bit envelope value, MEASURED against the oracle with `--wave-map`: settled frames only (the
// synth's envelope constant over 5 frames and the register's code constant over 5 frames), natural songs plus patched copies whose wave notes sweep
// every envelope value. Observed: env 2,3,4 -> 25% (1684 frames); 6,7,8,9 -> 50% (1833); 10,11,12,13 -> 75% (the register's bit 15 "force 75%", 535);
// 14,15 -> 100% (68). Not observed in the settled data: env 0 (silence), 1 and 5 - env 1 -> mute and env 5 -> 25% come from the independent verifier's
// register trace (MUver/wavemap2.mjs) and the 4-wide steps; the table is a 4-step quantiser (thresholds 2, 6, 10, 14).
export const CGB3VOL = Object.freeze([0, 0, 0.25, 0.25, 0.25, 0.25, 0.5, 0.5, 0.5, 0.5, 0.75, 0.75, 0.75, 0.75, 1, 1]);

export const DEFAULT_MIXER = Object.freeze({
  maxChans: 12,       // direct-sound channels (SoundInfo.maxChans)
  masterVol: 12,      // SoundInfo.masterVol, 0..15
  mixRate: 13379,     // SoundInfo.pcmFreq: the rate fixed-frequency voices play at
  reverb: 0,          // used when the song header does not set the reverb byte's top bit
  pcmGain: 0.75,      // output-stage scale measured against the mGBA oracle (MUSIC.md "calibration")
  psgGain: 1,         // overall scale of the PSG (square/wave/noise) voices relative to direct sound
  dsDelay: 1,         // frames the direct-sound mix is delayed relative to the PSG (the console's sound-DMA buffering)
  psgReverb: false,   // whether the PSG goes through the reverb (false = it does not: the reverb works on the PCM buffer only)
  mono: false,        // the mixer's mono mode (gSoundInfo.mode & 1): true/'avg' = both channels carry (L+R)/2, 'R'/'L' = experiments
  waveOctave: 0,      // programmable-wave channel pitch offset in octaves (see MUSIC.md)
});

const SF = { START: 1, ATTACK: 2, DECAY: 3, SUSTAIN: 4, RELEASE: 5, ECHO: 6 };

function newTrack(cmd) {
  return {
    exist: true, cmd, wait: 0, patLevel: 0, patStack: [0, 0, 0], repeatCount: 0, gateTime: 0, key: 0, velocity: 0, runningStatus: 0,
    keyShift: 0, tune: 0, bend: 0, bendRange: 2, vol: 0, volX: 64, pan: 0, priority: 0, lfoSpeed: 22, lfoSpeedC: 0, lfoDelay: 0, lfoDelayC: 0,
    mod: 0, modT: 0, modM: 0, echoVolume: 0, echoLength: 0, tone: null, volMR: 0, volML: 0, pitchTotal: 0, volChg: true, pitChg: true,
    ended: false, loops: 0, visited: null,
  };
}

/**
 * One song playing. `read(L, R, off, n)` fills up to n frames and returns how many it wrote (fewer only when the song
 * has ended and its tail has died away; 0 afterwards). The engine advances in whole video frames, like the original.
 */
export class SongEngine {
  constructor(r, songIndex, opts = {}) {
    const h = r.song(songIndex);
    this.r = r;
    this.index = songIndex;
    this.header = h;
    this.sampleRate = opts.sampleRate || 32768;
    if (!(this.sampleRate >= 8000 && this.sampleRate <= 192000)) throw new Mp2kError('sample-rate', `sample rate ${this.sampleRate} outside 8000..192000`);
    const mx = { ...DEFAULT_MIXER, ...(opts.mixer || {}) };
    this.mx = mx;
    const mp = r.table && r.table.mplay;
    this.maxTracks = opts.maxTracks || (mp && mp.players[h.player] ? mp.players[h.player].maxTracks : 16);
    this.reverb = h.reverbSet ? h.reverb : mx.reverb;
    this.dry = !!opts.dryRun;
    this.analysis = !!opts.analysis;
    this.only = opts.only || null; // 'ds' | 'psg' | null: render one voice family only (calibration and tests)
    // sequencer state (MPlayStart)
    this.tempoScale = opts.tempoScale || 1; // tests only: a deliberately wrong tempo (negative control)
    this.tempoD = 150; this.tempoU = 0x100; this.tempoI = Math.round(150 * this.tempoScale); this.tempoC = 0; this.clock = 0;
    this.tracks = [];
    for (let i = 0; i < h.trackCount && i < this.maxTracks; i++) {
      const t = newTrack(h.tracks[i]);
      t.index = i;
      if (this.analysis) t.visited = new Map();
      this.tracks.push(t);
    }
    this.voicegroup = h.voicegroup;
    this.ds = [];            // active direct-sound channels
    this.cgb = [null, null, null, null];   // sq1, sq2, wave, noise
    this.seq = 0;
    this.frame = 0;
    this.finished = h.trackCount === 0;
    this.tailFrames = 0;
    // output frame (samples of the current engine frame not yet consumed)
    this.fl = new Float32Array(0); this.fr = new Float32Array(0); this.fpos = 0; this.flen = 0;
    this.hist = new Array(16).fill(null);
    this.sampleAcc = 0; // fractional sample carry for frame lengths
    this.samplesOut = 0;
    this.stats = { notes: 0, dropped: 0, stolen: 0, maxPoly: 0, badVoice: 0, frames: 0, kinds: { ds: 0, sq1: 0, sq2: 0, wave: 0, noise: 0 } };
    this.nz = 0x7fff;
    this.cmdBudget = 0;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // sequencer
  // ---------------------------------------------------------------------------------------------------------------

  _tick() {
    const r = this.r;
    for (const t of this.tracks) {
      if (!t.exist) continue;
      // channel gate countdown (before commands, as the engine does)
      for (let i = 0; i < this.ds.length; i++) { const c = this.ds[i]; if (c.track === t && c.gate > 0 && c.st !== SF.RELEASE && c.st !== SF.ECHO && !c.stop) { if (--c.gate === 0) c.stop = true; } }
      for (let k = 0; k < 4; k++) { const c = this.cgb[k]; if (c && c.track === t && c.gate > 0 && !c.stop && c.st !== SF.RELEASE) { if (--c.gate === 0) c.stop = true; } }
      let guard = 0;
      while (t.wait === 0 && t.exist) {
        if (++guard > 4096) throw new Mp2kError('seq-runaway', `song ${this.index} track ${t.index}: more than 4096 zero-length commands in one tick (loop without a wait?)`, { index: this.index, track: t.index });
        if (t.visited && !t.visited.has(t.cmd)) t.visited.set(t.cmd, this.frame);
        let ev = r.u8(t.cmd);
        if (ev < 0x80) ev = t.runningStatus;
        else { t.cmd++; if (ev >= 0xBD) t.runningStatus = ev; }
        if (ev >= 0xCF) this._note(t, ev - 0xCF);
        else if (ev >= 0xB1) this._cmd(t, ev);
        else t.wait = CLOCK[ev - 0x80];
      }
      if (t.exist) t.wait--;
      // LFO (once per tick)
      if (t.exist && t.lfoSpeed !== 0 && t.mod !== 0) {
        if (t.lfoDelayC > 0) t.lfoDelayC--;
        else {
          t.lfoSpeedC = (t.lfoSpeedC + t.lfoSpeed) & 0xFF;
          let p = t.lfoSpeedC;
          let v = p < 0x40 ? p : p < 0xC0 ? 128 - p : p - 256; // triangle -64..64
          const m = (t.mod * v) >> 6;
          if (m !== t.modM) { t.modM = m; if (t.modT === 0) t.pitChg = true; else t.volChg = true; }
        }
      }
    }
    this.clock++;
  }

  _arg(t) { const v = this.r.u8(t.cmd); t.cmd++; return v; }

  _cmd(t, ev) {
    const r = this.r;
    switch (ev) {
      case 0xB1: // FINE
        for (const c of this.ds) if (c.track === t && !c.stop) c.stop = true;
        for (let k = 0; k < 4; k++) { const c = this.cgb[k]; if (c && c.track === t) c.stop = true; }
        t.exist = false; t.ended = true;
        break;
      case 0xB2: { // GOTO
        const p = r.u32(t.cmd);
        t.cmd = r.off(p); t.loops++; t.lastTarget = t.cmd; if (t.loops === 1) t.firstLoopFrame = this.frame;
        break;
      }
      case 0xB3: { // PATT
        const p = r.u32(t.cmd);
        if (t.patLevel < 3) { t.patStack[t.patLevel++] = t.cmd + 4; t.cmd = r.off(p); }
        else { t.exist = false; t.ended = true; }
        break;
      }
      case 0xB4: // PEND
        if (t.patLevel > 0) t.cmd = t.patStack[--t.patLevel];
        break;
      case 0xB5: { // REPT
        const n = r.u8(t.cmd);
        if (n === 0) { t.cmd = r.off(r.u32(t.cmd + 1)); t.loops++; t.lastTarget = t.cmd; if (t.loops === 1) t.firstLoopFrame = this.frame; }
        else {
          t.repeatCount++;
          if (t.repeatCount < n) t.cmd = r.off(r.u32(t.cmd + 1));
          else { t.repeatCount = 0; t.cmd += 5; }
        }
        break;
      }
      case 0xB9: t.cmd += 3; break; // MEMACC (writes game RAM; ignored)
      case 0xBA: t.priority = this._arg(t); break;
      case 0xBB: { const v = this._arg(t); this.tempoD = v * 2; this.tempoI = Math.round(((this.tempoD * this.tempoU) >> 8) * this.tempoScale); break; }
      case 0xBC: t.keyShift = (this._arg(t) << 24) >> 24; t.pitChg = true; break;
      case 0xBD: { const n = this._arg(t); t.tone = this._toneAt(n); break; }
      case 0xBE: t.vol = this._arg(t); t.volChg = true; break;
      case 0xBF: t.pan = this._arg(t) - 64; t.volChg = true; break;
      case 0xC0: t.bend = this._arg(t) - 64; t.pitChg = true; break;
      case 0xC1: t.bendRange = this._arg(t); t.pitChg = true; break;
      case 0xC2: t.lfoSpeed = this._arg(t); if (!t.lfoSpeed) this._clearModM(t); break;
      case 0xC3: t.lfoDelay = this._arg(t); t.lfoDelayC = t.lfoDelay; if (!t.lfoDelay) this._clearModM(t); break;
      case 0xC4: t.mod = this._arg(t); if (!t.mod) this._clearModM(t); break;
      case 0xC5: { const v = this._arg(t); if (v !== t.modT) { this._clearModM(t); t.modT = v; } break; }
      case 0xC8: t.tune = this._arg(t) - 64; t.pitChg = true; break;
      case 0xCD: { // XCMD: one command byte, one parameter byte
        const x = this._arg(t), p = this._arg(t);
        if (x === 0x08) t.echoVolume = p; else if (x === 0x09) t.echoLength = p;
        break;
      }
      case 0xCE: { // EOT
        let key = t.key;
        if (r.u8(t.cmd) < 0x80) { key = r.u8(t.cmd); t.cmd++; }
        for (const c of this.ds) if (c.track === t && !c.stop && c.midiKey === key && c.st !== SF.RELEASE) { c.stop = true; break; }
        for (let k = 0; k < 4; k++) { const c = this.cgb[k]; if (c && c.track === t && !c.stop && c.midiKey === key) { c.stop = true; break; } }
        break;
      }
      default: break; // 0xB6-B8, 0xC6, 0xC7, 0xC9-0xCC: unused slots, no arguments
    }
  }

  _clearModM(t) { t.modM = 0; if (t.modT === 0) t.pitChg = true; else t.volChg = true; }

  _toneAt(n) {
    if (this.voicegroup < 0) return null;
    const o = this.voicegroup + 12 * n;
    if (o + 12 > this.r.length) return null;
    return this.r.voice(this.voicegroup, n);
  }

  _note(t, cmd) {
    const r = this.r;
    let gate = CLOCK[cmd];
    let b = r.u8(t.cmd);
    if (b < 0x80) {
      t.key = b; t.cmd++;
      b = r.u8(t.cmd);
      if (b < 0x80) {
        t.velocity = b; t.cmd++;
        b = r.u8(t.cmd);
        if (b < 0x80) { gate += b; t.cmd++; }
      }
    }
    t.gateTime = gate;
    this.stats.notes++;
    let tone = t.tone;
    if (!tone) { this.stats.badVoice++; return; }
    let key = t.key;
    let forcedPan = 0;
    let pitchKey = key;
    if (tone.kind === 'split' || tone.kind === 'rhythm') {
      if (tone.group < 0) { this.stats.badVoice++; return; }
      let idx;
      if (tone.kind === 'split') { if (tone.splitTable < 0) { this.stats.badVoice++; return; } idx = r.u8(tone.splitTable + key); }
      else idx = key;
      const so = tone.group + 12 * idx;
      if (so + 12 > r.length) { this.stats.badVoice++; return; }
      const sub = r.voice(tone.group, idx);
      if (sub.kind === 'split' || sub.kind === 'rhythm') { this.stats.badVoice++; return; }
      if (tone.kind === 'rhythm') {
        if (sub.panSweep & 0x80) forcedPan = ((sub.panSweep & 0x7F) - 0x40) * 2;
        pitchKey = sub.key; // a drum sample's pitch comes from its own voice entry
      }
      tone = sub;
    }
    if (this.stats.kinds[tone.kind] !== undefined) this.stats.kinds[tone.kind]++;
    if (tone.kind === 'ds') this._startDs(t, tone, key, pitchKey, forcedPan);
    else if (tone.kind === 'sq1' || tone.kind === 'sq2' || tone.kind === 'wave' || tone.kind === 'noise') this._startCgb(t, tone, key);
    else this.stats.badVoice++;
    t.volChg = true; t.pitChg = true;
  }

  _startDs(t, tone, key, pitchKey, forcedPan) {
    const r = this.r;
    if (tone.wave < 0) { this.stats.badVoice++; return; }
    let wave;
    try { wave = r.wave(tone.wave); } catch (e) { this.stats.badVoice++; return; }
    // SoulGold's streamed-audio stubs (song-table 559..609) use a wave whose sample count is 0 at 44100 Hz; the real engine outputs a
    // near-constant DC level for them (measured), not audio. Not reproduced: counted as an unsupported voice and silent.
    if (wave.size === 0) { this.stats.badVoice++; this.stats.zeroWave = (this.stats.zeroWave || 0) + 1; return; }
    const prio = t.priority;
    if (this.ds.length >= this.mx.maxChans) {
      // All channels busy. Victim order: a releasing channel, then the lowest priority, then (policy A) the latest track and the oldest note.
      // A LIVE channel may only be taken by a note of strictly higher priority, or - policy 'A' - of equal priority from an equal-or-earlier
      // track; policy 'S' never takes an equal-priority channel. The tie-break is not understood (MUSIC.md "voice stealing"); the policy is
      // chosen per ROM in MIXER_PROFILES from oracle scores.
      const pol = this.mx.steal || 'A';
      let best = -1, bk = null;
      for (let i = 0; i < this.ds.length; i++) {
        const c = this.ds[i];
        const rel = c.stop || c.st === SF.RELEASE || c.st === SF.ECHO ? 0 : 1;
        // policy A: latest track first, then the oldest note; policy S: the newest note first (both measured, see MUSIC.md)
        const k = pol === 'S' ? [rel, c.priority, -c.seq, -c.track.index] : [rel, c.priority, -c.track.index, c.seq];
        let less = !bk;
        if (bk) for (let q = 0; q < 4; q++) { if (k[q] !== bk[q]) { less = k[q] < bk[q]; break; } }
        if (less) { best = i; bk = k; }
      }
      const v = this.ds[best];
      const ok = bk[0] === 0 || prio > v.priority || (pol === 'A' && prio === v.priority && t.index <= v.track.index);
      if (ok) { this.ds.splice(best, 1); this.stats.stolen++; if (bk[0] === 1) this.stats.stolenLive = (this.stats.stolenLive || 0) + 1; }
      else { this.stats.dropped++; return; }
    }
    const c = {
      kind: 'ds', track: t, wave, fixed: tone.fixed, midiKey: t.key, key: pitchKey, velocity: t.velocity, priority: prio, gate: t.gateTime,
      att: tone.attack, dec: tone.decay, sus: tone.sustain, rel: tone.release, env: 0, st: SF.START, stop: false, pos: 0, step: 0,
      rhythmPan: forcedPan, rightVol: 0, leftVol: 0, seq: this.seq++, echoV: t.echoVolume, echoL: t.echoLength, pitchSemis: 0, volDirty: true,
    };
    this.ds.push(c);
    if (this.ds.length > this.stats.maxPoly) this.stats.maxPoly = this.ds.length;
  }

  _startCgb(t, tone, key) {
    const slotIdx = tone.kind === 'sq1' ? 0 : tone.kind === 'sq2' ? 1 : tone.kind === 'wave' ? 2 : 3;
    const cur = this.cgb[slotIdx];
    if (cur && !cur.stop && cur.st !== SF.RELEASE && !(t.priority > cur.priority || (t.priority === cur.priority && t.index <= cur.track.index))) { this.stats.dropped++; return; }
    let waveBytes = null;
    if (tone.kind === 'wave') {
      if (tone.wave < 0 || tone.wave + 16 > this.r.length) { this.stats.badVoice++; return; }
      waveBytes = this.r.bytes.subarray(tone.wave, tone.wave + 16);
    }
    this.cgb[slotIdx] = {
      kind: tone.kind, slot: slotIdx, track: t, midiKey: t.key, key, velocity: t.velocity, priority: t.priority, gate: t.gateTime,
      att: tone.attack & 7, dec: tone.decay & 7, sus: tone.sustain & 15, rel: tone.release & 7, duty: tone.duty | 0, period: tone.period | 0,
      length: tone.length, waveBytes, st: SF.START, stop: false, vol: 0, eg: 0, sg: 0, counter: 0, phase: 0, lfsr: 0x7fff, rightVol: 0, leftVol: 0,
      panL: true, panR: true, freq: 0, lenLeft: -1, seq: this.seq++, echoV: 0,
      sw: tone.kind === 'sq1' ? (tone.panSweep & 0x7F) : 0, swAcc: 0, reg: 0, dead: false,   // square 1 frequency sweep (NR10 = the voice's pan_sweep byte)
    };
    if (tone.kind === 'sq1' && (tone.panSweep & 0x70)) this.stats.sweepNotes = (this.stats.sweepNotes || 0) + 1;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // per-frame update: volumes, pitch, envelopes (MP2KPlayerMain tail + SoundMain + CgbSound)
  // ---------------------------------------------------------------------------------------------------------------

  _trackUpdate() {
    for (const t of this.tracks) {
      if (!t.exist && !this._hasChans(t)) continue;
      if (t.volChg) {
        let x = (t.vol * t.volX) >> 5;
        if (t.modT === 1) x = (x * (t.modM + 128)) >> 7;
        let y = 2 * t.pan;
        if (t.modT === 2) y += t.modM;
        if (y < -128) y = -128; else if (y > 127) y = 127;
        t.volMR = ((y + 128) * x) >> 8;
        t.volML = ((127 - y) * x) >> 8;
      }
      if (t.pitChg) {
        const bend = t.bend * t.bendRange;
        let x = (t.tune + bend) * 4 + (t.keyShift << 8);
        if (t.modT === 0) x += 16 * t.modM;
        t.pitchTotal = x; // 1/256 semitone
      }
    }
    for (const c of this.ds) {
      const t = c.track;
      if (t.volChg || c.volDirty) {
        const fp = c.rhythmPan;
        let rv = ((fp + 128) & 0xFF) * c.velocity * t.volMR / 16384; let lv = ((127 - fp) & 0xFF) * c.velocity * t.volML / 16384;
        rv = rv | 0; lv = lv | 0;
        c.rightVol = rv > 255 ? 255 : rv; c.leftVol = lv > 255 ? 255 : lv; c.volDirty = false;
      }
      if (t.pitChg || c.st === SF.START) {
        c.pitchSemis = (c.key - 60) + t.pitchTotal / 256;
        const f = c.fixed ? this.mx.mixRate : c.wave.freq * Math.pow(2, c.pitchSemis / 12);
        c.step = f / this.sampleRate;
      }
    }
    for (let k = 0; k < 4; k++) {
      const c = this.cgb[k];
      if (!c) continue;
      const t = c.track;
      if (t.volChg || c.st === SF.START) {
        const fp = 0;
        let rv = ((fp + 128) & 0xFF) * c.velocity * t.volMR / 16384; let lv = ((127 - fp) & 0xFF) * c.velocity * t.volML / 16384;
        rv = rv | 0; lv = lv | 0;
        c.rightVol = rv > 255 ? 255 : rv; c.leftVol = lv > 255 ? 255 : lv;
        const hardL = c.leftVol / 2 >= c.rightVol, hardR = c.rightVol / 2 >= c.leftVol;
        c.panR = !hardL; c.panL = !hardR;   // (also in mono mode: enabling the PSG on both sides at full level scored lower against the oracle than keeping the pan, then averaging)
        let eg = (c.rightVol + c.leftVol) >> 4; if (eg > 15) eg = 15;
        c.eg = eg; c.sg = (eg * c.sus + 15) >> 4;
      }
      if (t.pitChg || c.st === SF.START) {
        const semis = (c.key) + t.pitchTotal / 256;
        if (c.kind === 'noise') {
          let kk = Math.round(semis); if (kk <= 20) kk = 0; else { kk -= 21; if (kk > 59) kk = 59; }
          const nr = NOISE_TABLE[kk], s = nr >> 4, d = nr & 7;
          c.freq = 524288 / ((d === 0 ? 0.5 : d) * Math.pow(2, s + 1));
        } else {
          // Square frequency register (NR13/14) = floor(2048 - 131072 / f), f equal-tempered A=440 at the continuous pitch (key + bend/tune/vibrato).
          // MEASURED on the oracle for every key 36..108 with a patched one-note-per-key song: the divisor is ceil(131072/f) (e.g. key 87 -> 106, 93 -> 75,
          // 105 -> 38; of the 28 keys in 56..108 where ceil and round differ, the oracle follows ceil on 27). A bent note (song 4: key 96 bent -0.34 semitone) lands on the oracle's
          // 2048 Hz with the continuous formula but not with linear interpolation between per-semitone registers (tried, rejected).
          const ks = Math.max(semis, 36);
          const f = 440 * Math.pow(2, (ks - 69) / 12);
          let n = this.mx.psgReg === 'round' ? 2048 - Math.round(131072 / f) : Math.floor(2048 - 131072 / f);   // 'round' = the pre-measurement rule, kept only as a test mutant
          if (n < 0) n = 0; if (n > 2047) n = 2047;
          c.freq = 131072 / (2048 - n); c.reg = n;
          if (c.kind === 'wave') c.freq = (c.freq / 2) * Math.pow(2, this.mx.waveOctave);
        }
      }
    }
    for (const t of this.tracks) { t.volChg = false; t.pitChg = false; }
  }

  _hasChans(t) {
    for (const c of this.ds) if (c.track === t) return true;
    for (let k = 0; k < 4; k++) if (this.cgb[k] && this.cgb[k].track === t) return true;
    return false;
  }

  _dsEnvelopes() {
    const out = [];
    for (let i = 0; i < this.ds.length; i++) {
      const c = this.ds[i];
      let alive = true;
      if (c.st === SF.START) {
        if (c.stop) alive = false;
        else {
          c.env = c.att; c.st = SF.ATTACK;
          if (c.att === 255 || c.env >= 255) { c.env = 255; c.st = SF.DECAY; }
        }
      } else if (c.stop && c.st !== SF.RELEASE && c.st !== SF.ECHO) {
        c.st = SF.RELEASE;
        // release is applied from the next line on, as a multiply per frame
        c.env = (c.env * c.rel) >> 8;
        if (c.env <= c.echoV) { if (c.echoL > 0 && c.echoV > 0) { c.env = c.echoV; c.st = SF.ECHO; c.echoLeft = c.echoL; } else alive = false; }
      } else if (c.st === SF.RELEASE) {
        c.env = (c.env * c.rel) >> 8;
        if (c.env <= c.echoV) { if (c.echoL > 0 && c.echoV > 0) { c.env = c.echoV; c.st = SF.ECHO; c.echoLeft = c.echoL; } else alive = false; }
      } else if (c.st === SF.ECHO) {
        if (--c.echoLeft <= 0) alive = false;
      } else if (c.st === SF.ATTACK) {
        c.env += c.att;
        if (c.env >= 255) { c.env = 255; c.st = SF.DECAY; }
      } else if (c.st === SF.DECAY) {
        c.env = (c.env * c.dec) >> 8;
        if (c.env <= c.sus) { c.env = c.sus; if (c.sus === 0) alive = false; else c.st = SF.SUSTAIN; }
      }
      if (c.env === 0 && c.st !== SF.START) alive = alive && c.st === SF.ATTACK; // fully silent after release / sustain 0
      if (alive) out.push(c);
    }
    this.ds = out;
  }

  /** Square 1 frequency sweep (NR10): every T/128 s the 11-bit register x becomes x +- (x >> shift); an increase past 2047 silences the channel. Stepped per video frame with a fractional accumulator. */
  _sweep(c) {
    const T = (c.sw >> 4) & 7, shift = c.sw & 7, dec = (c.sw & 8) !== 0;
    if (!T || c.dead || !c.reg || this.mx.sweep === false) return;
    c.swAcc += (128 / T) / FRAME_HZ;
    let steps = Math.floor(c.swAcc); c.swAcc -= steps;
    while (steps-- > 0) {
      const d = c.reg >> shift;
      const nr = dec ? c.reg - d : c.reg + d;
      if (nr > 2047) { c.dead = true; return; }
      if (nr < 1) return;
      c.reg = nr; c.freq = 131072 / (2048 - nr);
    }
  }

  _cgbEnvelopes() {
    for (let k = 0; k < 4; k++) {
      const c = this.cgb[k];
      if (!c) continue;
      if (c.st === SF.START) {
        if (c.stop) { this.cgb[k] = null; continue; }
        c.counter = c.att;
        c.lenLeft = c.length > 0 ? ((c.kind === 'wave' ? 256 : 64) - (c.length & (c.kind === 'wave' ? 255 : 63))) * (FRAME_HZ / 256) : -1;
        if (c.att > 0) { c.vol = 0; c.st = SF.ATTACK; } else { c.vol = c.eg; c.st = SF.DECAY; c.counter = c.dec; if (c.vol <= c.sg) { c.vol = c.sg; c.st = SF.SUSTAIN; } }
        c.phase = 0; c.lfsr = 0x7fff;
        continue;
      }
      if (c.sw & 0x70) this._sweep(c);
      if (c.stop && c.st !== SF.RELEASE) { c.st = SF.RELEASE; c.counter = c.rel; if (c.rel === 0) { this.cgb[k] = null; continue; } }
      if (c.lenLeft >= 0) { c.lenLeft -= 1; if (c.lenLeft <= 0) { this.cgb[k] = null; continue; } }
      if (c.st === SF.ATTACK) {
        if (--c.counter <= 0) { c.vol++; c.counter = c.att; if (c.vol >= c.eg) { c.vol = c.eg; c.st = SF.DECAY; c.counter = c.dec; } }
      } else if (c.st === SF.DECAY) {
        if (c.dec === 0) { c.vol = c.sg; c.st = SF.SUSTAIN; }
        else if (--c.counter <= 0) { c.vol--; c.counter = c.dec; if (c.vol <= c.sg) { c.vol = c.sg; c.st = SF.SUSTAIN; } }
      } else if (c.st === SF.RELEASE) {
        if (--c.counter <= 0) { c.vol--; c.counter = c.rel; if (c.vol <= 0) { this.cgb[k] = null; continue; } }
      }
      if (c.st === SF.SUSTAIN && c.sg === 0 && c.vol === 0) this.cgb[k] = null;
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // frame production
  // ---------------------------------------------------------------------------------------------------------------

  _active() {
    for (const t of this.tracks) if (t.exist) return true;
    return this.ds.length > 0 || this.cgb.some(Boolean);
  }

  _makeFrame() {
    // one engine frame: sequencer, parameters, envelopes, then the mix for this frame's samples
    this.tempoC += this.tempoI;
    while (this.tempoC >= 150) { this._tick(); this.tempoC -= 150; }
    this._trackUpdate();
    this._dsEnvelopes();
    this._cgbEnvelopes();
    this.frame++;
    this.stats.frames++;
    const ideal = (this.frame * this.sampleRate) / FRAME_HZ;
    const n = Math.round(ideal) - this.samplesOut;
    this.samplesOut += n;
    if (this.fl.length < n) { this.fl = new Float32Array(n + 8); this.fr = new Float32Array(n + 8); }
    this.flen = n; this.fpos = 0;
    const L = this.fl, R = this.fr;
    for (let i = 0; i < n; i++) { L[i] = 0; R[i] = 0; }
    if (!this.dry) {
      if (!this.only || this.only === 'ds') this._mixDs(L, R, n); else this._silentDs(n);
      this.pn = 0; if (this.only !== 'ds') this._mixCgb(n);
      this._reverb(L, R, n);
    }
    if (!this._active()) this.tailFrames++;
  }

  _mixDs(L, R, n) {
    const mv = this.mx.masterVol, gain = this.mx.pcmGain / 256;
    for (const c of this.ds) {
      const w = c.wave, d = w.data, size = w.size;
      const x = (c.env * (mv + 1)) >> 4;
      const eR = ((c.rightVol * x) >> 8) * gain, eL = ((c.leftVol * x) >> 8) * gain;
      if (eR === 0 && eL === 0) { this._advance(c, n); continue; }
      let pos = c.pos; const step = c.step, loops = w.loops, ls = w.loopStart;
      if (c.fixed) {
        for (let i = 0; i < n; i++) {
          let ip = pos | 0;
          if (ip >= size) { if (loops) { pos = ls + (pos - size); ip = pos | 0; if (ip >= size) ip = ls; } else { c.st = SF.RELEASE; c.env = 0; break; } }
          const s = d[ip];
          L[i] += s * eL; R[i] += s * eR;
          pos += step;
        }
      } else {
        for (let i = 0; i < n; i++) {
          let ip = pos | 0;
          if (ip >= size) { if (loops) { pos = ls + (pos - size); ip = pos | 0; if (ip >= size) { pos = ls; ip = ls; } } else { c.env = 0; c.st = SF.RELEASE; c.rel = 0; break; } }
          const s0 = d[ip];
          let ip1 = ip + 1; if (ip1 >= size) ip1 = loops ? ls : ip;
          const fr = pos - ip;
          const s = s0 + (d[ip1] - s0) * fr;
          L[i] += s * eL; R[i] += s * eR;
          pos += step;
        }
      }
      c.pos = pos;
    }
  }

  _silentDs(n) { for (const c of this.ds) this._advance(c, n); }

  _advance(c, n) { c.pos += c.step * n; const w = c.wave; if (c.pos >= w.size) { if (w.loops) { const span = w.size - w.loopStart; c.pos = w.loopStart + ((c.pos - w.loopStart) % span); } else { c.env = 0; c.st = SF.RELEASE; c.rel = 0; } } }

  _mixCgb(n) {
    // PSG voices. Level measured against the mGBA oracle: a square at envelope volume v is a unipolar 0 / (3*v) pulse in
    // units of 1/128 full scale (e.g. v=10 -> 0.2344 in the oracle's output), i.e. 3 LSB per volume step. The oracle (and
    // mGBA) keep the pulse's DC; a real GBA AC-couples its output, and a DC step on every note is a click, so this
    // synth removes the DC with a one-pole high pass (~10 Hz) -- a deliberate, documented deviation.
    if (!this.pl || this.pl.length < n) { this.pl = new Float32Array(n + 8); this.pr = new Float32Array(n + 8); }
    const L = this.pl, R = this.pr;
    for (let i = 0; i < n; i++) { L[i] = 0; R[i] = 0; }
    this.pn = n;
    const P = 3 * this.mx.psgGain;
    const sr = this.sampleRate;
    for (let k = 0; k < 4; k++) {
      const c = this.cgb[k];
      if (!c || c.st === SF.START) continue;
      if (c.dead) continue;
      if (this.only && this.only !== 'psg' && this.only !== c.kind && !(this.only === 'sq' && (c.kind === 'sq1' || c.kind === 'sq2'))) continue;
      const f = c.freq;
      if (c.kind === 'sq1' || c.kind === 'sq2') {
        const a = c.vol * P;
        if (a === 0) { c.phase += (f / sr) * n; c.phase -= Math.floor(c.phase); continue; }
        const pat = DUTY[c.duty & 3];
        const dp = f / sr; // cycles per output sample
        let ph = c.phase;
        for (let i = 0; i < n; i++) {
          const s = squareAvg(pat, ph, dp) * a; // area-average of the 8-step pulse over this output sample (box filter)
          if (c.panL) L[i] += s; if (c.panR) R[i] += s;
          ph += dp; if (ph >= 1) ph -= Math.floor(ph);
        }
        c.phase = ph;
      } else if (c.kind === 'wave') {
        const a = CGB3VOL[c.vol] * P; // nibble (0..15) scaled by the wave channel's 100/50/25 % volume code
        if (a === 0) continue;
        const wb = c.waveBytes, dp = f / sr; let ph = c.phase;
        for (let i = 0; i < n; i++) {
          const idx = (ph * 32) | 0;
          const byte = wb[idx >> 1];
          const nib = (idx & 1) ? (byte & 15) : (byte >> 4);
          const s = nib * a;
          if (c.panL) L[i] += s; if (c.panR) R[i] += s;
          ph += dp; if (ph >= 1) ph -= Math.floor(ph);
        }
        c.phase = ph;
      } else {
        // noise: the LFSR is clocked at c.freq (524288 / (r * 2^(s+1)) Hz); the output is high while bit 0 is clear. Each output sample is the mean of the
        // LFSR output at TWO instants (mid-sample and end of sample): a point-sampled LFSR is white up to Nyquist (too much top end against the oracle:
        // +2..4 dB in the 4.8-9.6 kHz octave) and a full-sample box average droops too early (-5..-8 dB there); two points sit between them.
        const a = c.vol * P;
        if (a === 0) continue;
        const clk = f / sr; let acc = c.phase; let lfsr = c.lfsr; const narrow = c.period === 1;
        const mode = this.mx.noiseSample || 'half';
        const step = (steps) => { if (steps > 64) steps = 64; for (let q = 0; q < steps; q++) { const bit = (lfsr ^ (lfsr >> 1)) & 1; lfsr = (lfsr >> 1) | (bit << (narrow ? 6 : 14)); if (narrow) lfsr &= 0x7f; } };
        for (let i = 0; i < n; i++) {
          let v;
          if (mode === 'half') {
            acc += clk * 0.5; let st = acc | 0; acc -= st; step(st);
            const v1 = (lfsr & 1) ? 0 : 1;
            acc += clk * 0.5; st = acc | 0; acc -= st; step(st);
            v = (v1 + ((lfsr & 1) ? 0 : 1)) * 0.5;
          } else if (mode === 'avg') {
            let sum = 0, cnt = 0; acc += clk; let st = acc | 0; acc -= st;
            if (st === 0) { sum = (lfsr & 1) ? 0 : 1; cnt = 1; }
            else { if (st > 64) st = 64; for (let q = 0; q < st; q++) { const bit = (lfsr ^ (lfsr >> 1)) & 1; lfsr = (lfsr >> 1) | (bit << (narrow ? 6 : 14)); if (narrow) lfsr &= 0x7f; sum += (lfsr & 1) ? 0 : 1; cnt++; } }
            v = sum / cnt;
          } else { acc += clk; const st = acc | 0; acc -= st; step(st); v = (lfsr & 1) ? 0 : 1; }
          const s2 = v * a;
          if (c.panL) L[i] += s2; if (c.panR) R[i] += s2;
        }
        c.phase = acc; c.lfsr = lfsr;
      }
    }
    const k = 1 - Math.exp(-2 * Math.PI * 10 / sr);
    let lpL = this.hpL || 0, lpR = this.hpR || 0;
    for (let i = 0; i < n; i++) {
      lpL += (L[i] - lpL) * k; lpR += (R[i] - lpR) * k;
      L[i] -= lpL; R[i] -= lpR;
    }
    this.hpL = lpL; this.hpR = lpR;
  }

  _reverb(L, R, n) {
    // The engine's reverb, as MEASURED from the running game (tools/pokemonarena_music_oracle.mjs, impulse-response
    // identification of the oracle's output against this synth's dry render): two echo taps, one and two frames
    // after the sound-DMA period (7 and 8 video frames), each of gain reverb/256, fed from the OUTPUT (so they feed back).
    const PL = this.pl, PR = this.pr, havePsg = this.pn === n && !!PL;
    if (this.mx.mono) {
      const m = this.mx.mono;
      for (let i = 0; i < n; i++) { const v = m === 'R' ? R[i] : m === 'L' ? L[i] : (L[i] + R[i]) * 0.5; L[i] = v; R[i] = v; }
      if (havePsg) for (let i = 0; i < n; i++) { const v = m === 'R' ? PR[i] : m === 'L' ? PL[i] : (PL[i] + PR[i]) * 0.5; PL[i] = v; PR[i] = v; }
    }
    // The direct-sound mix goes through the sound-DMA buffer (one video frame later than the PSG, whose registers are written at once): delay it by one frame
    if (this.mx.dsDelay) {
      const cl = this.dsCl, cr = this.dsCr;
      if (cl && cl.n > 0) { const tl = new Float32Array(n), tr = new Float32Array(n); for (let i = 0; i < n; i++) { const j = i < cl.n ? i : cl.n - 1; tl[i] = cl.l[j]; tr[i] = cl.r[j]; } this.dsCl = { l: Float32Array.from(L.subarray(0, n)), r: Float32Array.from(R.subarray(0, n)), n }; L.set(tl); R.set(tr); }
      else { this.dsCl = { l: Float32Array.from(L.subarray(0, n)), r: Float32Array.from(R.subarray(0, n)), n }; this.dsCr = null; for (let i = 0; i < n; i++) { L[i] = 0; R[i] = 0; } }
    }
    if (this.mx.psgReverb && havePsg) for (let i = 0; i < n; i++) { L[i] += PL[i]; R[i] += PR[i]; }
    const rv = this.reverb, H = this.hist;
    if (rv > 0) {
      const c = rv / 256;
      const f7 = H[(this.frame - 7) & 15], f8 = H[(this.frame - 8) & 15];
      for (let i = 0; i < n; i++) {
        let w = 0, v = 0;
        if (f7 && f7.n > 0) { const j = i < f7.n ? i : f7.n - 1; w += f7.l[j]; v += f7.r[j]; }
        if (f8 && f8.n > 0) { const j = i < f8.n ? i : f8.n - 1; w += f8.l[j]; v += f8.r[j]; }
        L[i] += w * c; R[i] += v * c;
      }
    }
    // this frame's output (dry + reverb, before the 8-bit clip) is what later frames echo
    let slot = H[this.frame & 15];
    if (!slot || slot.l.length < n) { slot = H[this.frame & 15] = { l: new Float32Array(n + 8), r: new Float32Array(n + 8), n: 0 }; }
    slot.n = n; slot.l.set(L.subarray(0, n)); slot.r.set(R.subarray(0, n));
    // 8-bit output clip (the engine's PCM buffer is signed 8 bit), then to float; a PSG that did not go through the reverb is added after
    const addPsg = havePsg && !this.mx.psgReverb;
    for (let i = 0; i < n; i++) {
      let l = L[i], r = R[i];
      l = l > 127 ? 127 : l < -128 ? -128 : l; r = r > 127 ? 127 : r < -128 ? -128 : r;
      l /= 128; r /= 128;
      if (addPsg) { l += PL[i] / 128; r += PR[i] / 128; l = l > 1 ? 1 : l < -1 ? -1 : l; r = r > 1 ? 1 : r < -1 ? -1 : r; }
      L[i] = l; R[i] = r;
    }
  }

  get done() { return this.tailFrames > 0 && !this._active() && this.fpos >= this.flen; }

  /** Fill up to `n` stereo frames. Returns the number written; fewer than `n` means the song has ended. */
  read(L, R, off, n) {
    let w = 0;
    while (w < n) {
      if (this.fpos >= this.flen) {
        if (this.finished) break;
        if (this.tailFrames > 0 && !this._active()) { this.finished = true; break; }
        this._makeFrame();
        if (this.flen === 0) continue;
      }
      const take = Math.min(n - w, this.flen - this.fpos);
      for (let i = 0; i < take; i++) { L[off + w + i] = this.dry ? 0 : this.fl[this.fpos + i]; R[off + w + i] = this.dry ? 0 : this.fr[this.fpos + i]; }
      this.fpos += take; w += take;
    }
    return w;
  }
}

// mean of the 8-step pattern over the phase interval [ph, ph+dp) (cycles); dp may exceed 1 for very high notes
function squareAvg(pat, ph, dp) {
  if (dp >= 1) { let s = 0; for (let i = 0; i < 8; i++) s += pat[i]; return s / 8; }
  const a = ph * 8, b = (ph + dp) * 8;
  return (cum(pat, b) - cum(pat, a)) / (b - a);
}
// integral of the pattern from 0 to x (in steps), periodic with period 8
function cum(pat, x) {
  const whole = Math.floor(x / 8); let rem = x - whole * 8;
  let tot = whole * pat.reduce((p, q) => p + q, 0);
  const full = rem | 0;
  for (let i = 0; i < full; i++) tot += pat[i];
  tot += pat[full & 7] * (rem - full);
  return tot;
}

/**
 * Walk a song's sequence data WITHOUT mixing and report its structure. The walk ends when every track has ended (a
 * jingle) or every still-running track has executed a GOTO/REPT-0 once (a looping song: length = intro + one pass).
 * Returns { index, tracks, priority, reverb, loops, loopingTracks, lengthMs, loopStartMs, loopLengthMs, tempo:[{atMs,bpm}],
 *           notes, jingle, firstBpm, frames, endedByFine, hitLimit }.
 * loopStartMs is when the LAST looping track first reached its loop target (all tracks are inside the loop from then on);
 * loopLengthMs is the longest per-track loop body.
 */
export function analyzeSong(r, index, opts = {}) {
  const h = r.song(index);
  const eng = new SongEngine(r, index, { sampleRate: 32768, dryRun: true, analysis: true });
  const maxFrames = Math.ceil((opts.maxSeconds || 1800) * FRAME_HZ);
  const tempo = [];
  let lastBpm = null, endFrame = -1, hitLimit = false;
  for (let f = 0; f < maxFrames; f++) {
    eng.tempoC += eng.tempoI;
    while (eng.tempoC >= 150) { eng._tick(); eng.tempoC -= 150; }
    eng.frame++;
    if (eng.tempoD !== lastBpm) { lastBpm = eng.tempoD; if (tempo.length < 16) tempo.push({ atFrame: f, bpm: eng.tempoD }); }
    const running = eng.tracks.filter((t) => t.exist);
    if (running.length === 0) { endFrame = f + 1; break; }
    if (running.every((t) => t.loops > 0)) { endFrame = f + 1; break; }
  }
  if (endFrame < 0) { endFrame = maxFrames; hitLimit = true; }
  const ms = (frames) => Math.round((frames / FRAME_HZ) * 1000);
  const loopers = eng.tracks.filter((t) => t.loops > 0);
  let loopStart = 0, loopLen = 0;
  for (const t of loopers) {
    const startF = t.visited && t.visited.has(t.lastTarget) ? t.visited.get(t.lastTarget) : 0;
    if (startF > loopStart) loopStart = startF;
    const len = (t.firstLoopFrame || endFrame) - startF;
    if (len > loopLen) loopLen = len;
  }
  return {
    index, tracks: h.trackCount, priority: h.priority, reverb: h.reverbSet ? h.reverb : null, loops: loopers.length > 0, loopingTracks: loopers.length,
    lengthMs: ms(endFrame), loopStartMs: loopers.length ? ms(loopStart) : null, loopLengthMs: loopers.length ? ms(loopLen) : null,
    tempo: tempo.map((t) => ({ atMs: ms(t.atFrame), bpm: t.bpm })), firstBpm: tempo.length ? tempo[0].bpm : 150, notes: eng.stats.notes,
    jingle: loopers.length === 0, frames: endFrame, endedByFine: eng.tracks.filter((t) => t.ended).length, hitLimit, kinds: { ...eng.stats.kinds }, badVoices: eng.stats.badVoice,
  };
}

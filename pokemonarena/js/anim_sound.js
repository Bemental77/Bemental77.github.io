// pokemonarena/js/anim_sound.js -- how long a sound effect keeps playing, estimated from the song's own header in the ROM.
//
// The ROM's animation script ends with `end`, which waits until IsSEPlaying() is false (and `waitsound` does the same), so an animation's length includes the tail of its last
// sound effect. The engine has no sound hardware: it answers that question from this estimate instead. It is a deliberately small parse of the MP2K ("m4a") song format -- only
// what decides WHEN a track finishes: the WAIT commands (tick lengths), TEMPO, loops (GOTO / REPT) and calls (PATT / PEND) -- not the notes, voices or the mixer.
//
//   songInfo(rom, songIndex)  -> { index, player, tracks, ticks, frames, loops, error } for one entry of the ROM's song table
//   defaultIsSEPlaying(rom, songIndex, elapsedFrames) -> boolean   (the default for ctx.isSEPlaying)
//
// What is measured and what is assumed (ANIM.md, "Sound-effect waits"):
//   * the format: one track pointer per track after the 8-byte header (u8 trackCount, u8 blockCount, u8 priority, u8 reverb, u32 voicegroup); commands 0x80..0xB0 wait
//     gClockTable[cmd - 0x80] ticks, 0xB1 ends the track, 0xBB sets the tempo to value*2 BPM. This is the public m4a format and the pokeemerald / pokefirered song data,
//     checked here against the ROM's own song table.
//   * the tick rate: the player runs once per VBlank; at the default tempo 150 (value 75) one tick is one frame, and tempo T (= value*2) advances T/150 ticks per frame.
//   * IsSEPlaying looks at the SE1 and SE2 players only (song-table field `ms` 1 and 2), not at the music player or SE3.
//   * a song that never reaches FINE (a GOTO loop) is capped at SE_CAP_FRAMES so a script cannot wait forever on a looping jingle.
// Everything else (note release tails, a higher-priority song cutting a lower one) is NOT modelled.

export const SONG_TABLE = 0x15e8ed8;          // ROM offset of gSongTable (8-byte entries {u32 header*, u16 player, u16 player2}); read from SongNumStart's literal pool (0x095e8ed8)
export const SE_CAP_FRAMES = 600;
// IsSEPlaying stays true for ONE more frame than the tick arithmetic says (the player processes its first tick on the VBlank after SongNumStart, and IsSEPlaying sees the status flag until
// the player's next run). Measured on 297 cached real-game animations (every third cached move, OR1): the real `end` finishes exactly on the estimated frame for 185/203/178 of 297 moves
// per shard with no latency, 221/242/228 with 1 frame, 225/218/204 with 2, 172/193/167 with 3 -- so 1.
export const SE_LATENCY = 1;
const CLOCKS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 28, 30, 32, 36, 40, 42, 44, 48, 52, 54, 56, 60, 64, 66, 68, 72, 76, 78, 80, 84, 88, 90, 92, 96];
const u32 = (rom, o) => (rom[o] | (rom[o + 1] << 8) | (rom[o + 2] << 16) | (rom[o + 3] << 24)) >>> 0;
const romOff = (p) => ((p >>> 0) >= 0x08000000 && (p >>> 0) < 0x0a000000 ? (p >>> 0) - 0x08000000 : -1);
const cache = new WeakMap();

/** One track: total ticks of WAITs and the tempo changes (tick -> value). Follows GOTO once (a loop is reported, not unrolled), PATT/PEND calls and REPT repeats. */
function walkTrack(rom, start) {
  const tempos = [];
  let ticks = 0, loops = false, steps = 0;
  const calls = [];                       // PATT return addresses
  const rept = new Map();                 // REPT site -> remaining count
  const seen = new Set();
  let o = start;
  while (o >= 0 && o < rom.length && steps++ < 20000) {
    const c = rom[o++];
    if (c < 0x80) continue;                                // a running-status data byte: no time
    if (c <= 0xb0) { ticks += CLOCKS[c - 0x80]; continue; }
    switch (c) {
      case 0xb1: return { ticks, tempos, loops };          // FINE
      case 0xb2: { const t = romOff(u32(rom, o)); o += 4; if (seen.has(t)) { loops = true; return { ticks, tempos, loops }; } seen.add(t); o = t; break; }   // GOTO: a second visit is a loop
      case 0xb3: { const t = romOff(u32(rom, o)); o += 4; if (calls.length > 4) return { ticks, tempos, loops: true }; calls.push(o); o = t; break; }
      case 0xb4: if (!calls.length) return { ticks, tempos, loops }; o = calls.pop(); break;
      case 0xb5: {                                         // REPT count, ptr: repeat the pattern at ptr `count` times, then fall through
        const site = o - 1, n = rom[o], t = romOff(u32(rom, o + 1)); o += 5;
        if (!rept.has(site)) rept.set(site, n);
        const left = rept.get(site);
        if (left > 1) { rept.set(site, left - 1); o = t; } else rept.delete(site);
        break;
      }
      case 0xb9: o += 3; break;
      case 0xbb: tempos.push([ticks, rom[o] * 2]); o += 1; break;                                   // TEMPO: value * 2 BPM
      case 0xba: case 0xbc: case 0xbd: case 0xbe: case 0xbf: case 0xc0: case 0xc1: case 0xc2: case 0xc3: case 0xc4: case 0xc5: case 0xc8: o += 1; break;
      case 0xcd: o += 2; break;
      case 0xce: if (rom[o] < 0x80) o += 1; break;
      default: { let n = 0; while (n < 3 && rom[o] < 0x80) { o++; n++; } }                           // TIE (0xCF) and the notes (0xD0..0xFF): key, velocity, gate time
    }
  }
  return { ticks, tempos, loops: true };
}

/** Frames until every track of the song has finished, at the song's tempo (default 150). */
export function songInfo(rom, index) {
  let m = cache.get(rom); if (!m) { m = new Map(); cache.set(rom, m); }
  if (m.has(index)) return m.get(index);
  const out = { index, player: -1, tracks: 0, ticks: 0, frames: 0, loops: false, error: null };
  const e = SONG_TABLE + 8 * index;
  if (!Number.isInteger(index) || index < 0 || e + 8 > rom.length) { out.error = 'song index out of range'; m.set(index, out); return out; }
  const h = romOff(u32(rom, e));
  out.player = rom[e + 4] | (rom[e + 5] << 8);
  if (h < 0 || h + 8 > rom.length) { out.error = 'no song header'; m.set(index, out); return out; }
  const n = rom[h];
  out.tracks = n;
  const trackInfo = [];
  for (let i = 0; i < n && i < 16; i++) { const t = romOff(u32(rom, h + 8 + 4 * i)); if (t >= 0) trackInfo.push(walkTrack(rom, t)); }
  const tempos = [];
  let maxTicks = 0;
  for (const t of trackInfo) { maxTicks = Math.max(maxTicks, t.ticks); out.loops = out.loops || t.loops; for (const x of t.tempos) tempos.push(x); }
  tempos.sort((a, b) => a[0] - b[0]);
  out.ticks = maxTicks; out.tempos = [...new Set(tempos.map((t) => t[1]))];
  // frames = integral of (150 / tempo) per tick over [0, maxTicks]
  let frames = 0, at = 0, tempo = 150;
  for (const [tick, val] of tempos) { if (tick >= maxTicks) break; frames += (tick - at) * 150 / tempo; at = tick; if (val > 0) tempo = val; }
  frames += (maxTicks - at) * 150 / tempo;
  out.frames = out.loops ? Math.max(Math.ceil(frames), SE_CAP_FRAMES) : Math.ceil(frames);
  m.set(index, out);
  return out;
}

/** A Pokemon cry's length in frames: the species record's cryId (+0x40 of the 0x118-byte record at ROM 0x7c7310), gCryTable[cryId - 1] (12-byte ToneData at ROM 0x15cb0dc, wave pointer at +4), the wave
 *  header {u16 type, u16 status, u32 rate * 1024, u32 loopStart, u32 sampleCount}: seconds = sampleCount / rate, frames = seconds * 59.7275. null when the species has no cry. (cries.js decodes the
 *  same table for playback; this reads only the two numbers that decide how long the cry's task waits.) */
export const CRY_SPECIES_TABLE = 0x7c7310, CRY_TABLE = 0x15cb0dc, FPS = 59.7275;
export function cryFrames(rom, species) {
  const rec = CRY_SPECIES_TABLE + 0x118 * species;
  if (!Number.isInteger(species) || species < 1 || rec + 0x42 > rom.length) return null;
  const cryId = rom[rec + 0x40] | (rom[rec + 0x41] << 8);
  if (cryId < 1 || cryId > 737) return null;
  const w = romOff(u32(rom, CRY_TABLE + 12 * (cryId - 1) + 4));
  if (w < 0 || w + 16 > rom.length) return null;
  const rate = u32(rom, w + 4) / 1024, n = u32(rom, w + 12);
  return rate > 0 && n > 0 ? Math.ceil(n / rate * FPS) : null;
}

/** Default ctx.isSEPlaying: true while `elapsedFrames` is below the song's estimated length, for songs on the SE1 / SE2 players (IsSEPlaying ignores the others). */
export function defaultIsSEPlaying(rom, index, elapsedFrames) {
  const s = songInfo(rom, index);
  if (s.error || (s.player !== 1 && s.player !== 2)) return false;
  return elapsedFrames < Math.min(s.frames + SE_LATENCY, SE_CAP_FRAMES);
}

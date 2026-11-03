// pokemonarena/js/mp2k.js -- ROM-side parsing for the GBA "m4a" / MP2K ("Sappy") sound engine.
//
// Pure ES module for browsers AND Node: no `node:` imports, no DOM, no globals read at import time. It holds
// structure knowledge only (record layouts, validity rules, codec rules); every byte it returns is decoded from the
// ROM image it is handed, at runtime. Nothing here is a sample, a song or an offset taken on trust: the song table is
// FOUND by scanning for the m4a structures (see findSongTable) and cross-checked against the game's own code.
//
// The structures (all little-endian, ROM pointers are 0x08000000 + file offset):
//   song table  gSongTable[]  8-byte entries { u32 header*, u16 player, u16 player2 }
//   song header { u8 trackCount, u8 blockCount, u8 priority, u8 reverb, u32 voicegroup*, u32 track*[trackCount] }
//   voice       12-byte ToneData { u8 type, u8 key, u8 length, u8 pan_sweep, u32 wave*|sub-group*|square-noise-cfg, u8 attack, u8 decay, u8 sustain, u8 release }
//               (key-split voices carry a u32 key->voice table pointer in the word where attack..release normally sit)
//   wave        16-byte header { u16 type (1 = DPCM compressed), u16 status (0x4000 = loops), u32 freq*1024, u32 loopStart, u32 size } + data
//   player table gMPlayTable[4] 12-byte entries { u32 info*(RAM), u32 tracks*(RAM), u8 maxTracks, u8, u16 }
//
// Everything is bounds-checked: a bad pointer, an impossible track count or a run past the ROM end raises a typed
// Mp2kError (code is machine readable) -- never an infinite loop, never a silent zero.

export const ROM_BASE = 0x08000000;

export class Mp2kError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'Mp2kError';
    this.code = code;
    this.details = details || null;
  }
}

const hex = (n) => '0x' + (n >>> 0).toString(16);

// ToneData.type
export const VT = Object.freeze({ CGB_MASK: 0x07, FIX: 0x08, REV: 0x10, CMP: 0x20, SPLIT: 0x40, RHYTHM: 0x80 });
// the DPCM delta table of the compressed-sample codec (two byte-identical copies sit in the ROMs; see cries.js notes)
export const DPCM_DELTA = Object.freeze(Array.from({ length: 16 }, (_, i) => (i < 8 ? i * i : -((16 - i) * (16 - i)))));

const MAX_TRACKS = 16;

// Song tables of the two ROMs this site ships, keyed by header game code + file size. They were FOUND by findSongTable (see MUSIC.md) and are only
// a fast path: the table is re-verified entry by entry (verifyTable, well under 1 ms) and any mismatch falls back to the whole-ROM scan, so a
// patched ROM that moved its table is still found. Without this the first activation ran a ~100 ms scan on the main thread.
const KNOWN_TABLES = Object.freeze([
  Object.freeze({ code: 'BPEE', size: 33554432, offset: 0x15e8ed8, count: 988 }),   // Pokemon SoulGold v1.1.1
  Object.freeze({ code: 'PUVV', size: 16777216, offset: 0x4a32cc, count: 347 }),     // Pokemon Ultra Violet
]);
const MAX_WAVE_SAMPLES = 0x200000;

/**
 * A ROM image with the m4a song table located. Cheap to construct when `hint` ({offset,count}) is given and verifies;
 * otherwise runs the whole-ROM scan once (about 100-200 ms for 32 MiB).
 */
export class Mp2kRom {
  constructor(rom, opts = {}) {
    const bytes = rom instanceof Uint8Array ? rom : ArrayBuffer.isView(rom) ? new Uint8Array(rom.buffer, rom.byteOffset, rom.byteLength) : rom instanceof ArrayBuffer ? new Uint8Array(rom) : null;
    if (!bytes) throw new Mp2kError('rom-type', 'ROM must be a Uint8Array, Buffer, ArrayBuffer or typed-array view');
    if (bytes.length < 0x200 || bytes.length > 0x02000000) throw new Mp2kError('rom-size', `ROM length ${bytes.length} is outside 512 B .. 32 MiB`);
    this.bytes = bytes;
    this.length = bytes.length;
    this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this._waves = new Map();
    this._headers = new Map();
    this.table = opts.table || null;
    if (!this.table && opts.hint) this.table = verifyTable(this, opts.hint.offset, opts.hint.count);
    if (!this.table && !opts.noKnown && bytes.length >= 0xB0) {
      const code = String.fromCharCode(bytes[0xAC], bytes[0xAD], bytes[0xAE], bytes[0xAF]);
      const k = KNOWN_TABLES.find((x) => x.code === code && x.size === bytes.length);
      if (k) { try { this.table = verifyTable(this, k.offset, k.count); this.tableSource = 'known'; } catch (e) { this.table = null; } }
    }
    if (!this.table) { this.table = findSongTable(bytes); this.tableSource = 'scan'; }
    else if (!this.tableSource) this.tableSource = 'hint';
    this.songCount = this.table.count;
  }
  u8(o) { this._chk(o, 1); return this.bytes[o]; }
  s8(o) { this._chk(o, 1); return (this.bytes[o] << 24) >> 24; }
  u16(o) { this._chk(o, 2); return this.dv.getUint16(o, true); }
  u32(o) { this._chk(o, 4); return this.dv.getUint32(o, true); }
  _chk(o, n) { if (!(o >= 0 && o + n <= this.length) || (o | 0) !== o) throw new Mp2kError('oob', `read of ${n} byte(s) at ${hex(o)} is outside the ROM (${this.length} bytes)`, { offset: o }); }
  isPtr(v) { return v >= ROM_BASE && v - ROM_BASE < this.length; }
  /** ROM pointer -> file offset (throws on anything outside the cartridge). */
  off(p) { if (!this.isPtr(p)) throw new Mp2kError('bad-ptr', `${hex(p)} is not a ROM pointer`, { pointer: p }); return p - ROM_BASE; }

  /** Song header + table entry for song-table index `i`. Dummy entries (track count 0) are valid, silent songs. */
  song(i) {
    if (!Number.isInteger(i) || i < 0 || i >= this.songCount) throw new Mp2kError('song-index', `song index ${i} is outside 0..${this.songCount - 1}`, { index: i });
    let h = this._headers.get(i);
    if (h) return h;
    const e = this.table.offset + 8 * i;
    const hp = this.u32(e), player = this.u16(e + 4), player2 = this.u16(e + 6);
    if (!this.isPtr(hp)) throw new Mp2kError('bad-ptr', `song ${i}: header pointer ${hex(hp)} is not a ROM pointer`, { index: i });
    const ho = hp - ROM_BASE;
    this._chk(ho, 8);
    const trackCount = this.bytes[ho];
    h = { index: i, entryOffset: e, headerOffset: ho, player, player2, trackCount, blockCount: this.bytes[ho + 1], priority: this.bytes[ho + 2], reverbByte: this.bytes[ho + 3], reverbSet: (this.bytes[ho + 3] & 0x80) !== 0, reverb: this.bytes[ho + 3] & 0x7f, voicegroup: -1, tracks: [], empty: trackCount === 0 };
    if (trackCount > MAX_TRACKS) throw new Mp2kError('track-count', `song ${i}: ${trackCount} tracks (max ${MAX_TRACKS})`, { index: i, trackCount });
    if (trackCount > 0) {
      this._chk(ho, 8 + 4 * trackCount);
      const vg = this.u32(ho + 4);
      if (!this.isPtr(vg)) throw new Mp2kError('bad-ptr', `song ${i}: voicegroup pointer ${hex(vg)} is not a ROM pointer`, { index: i });
      h.voicegroup = vg - ROM_BASE;
      for (let t = 0; t < trackCount; t++) {
        const tp = this.u32(ho + 8 + 4 * t);
        if (!this.isPtr(tp)) throw new Mp2kError('bad-ptr', `song ${i} track ${t}: pointer ${hex(tp)} is not a ROM pointer`, { index: i, track: t });
        h.tracks.push(tp - ROM_BASE);
      }
    }
    this._headers.set(i, h);
    return h;
  }

  /** Voice `n` of the voicegroup at file offset `vg`. Decoded record; never throws for an unknown `type` (kind 'invalid'). */
  voice(vg, n) {
    const o = vg + 12 * n;
    this._chk(o, 12);
    return decodeVoice(this, o);
  }

  /** Decoded sample (cached): { offset, compressed, loops, loopStart, size, freq (Hz), data: Int8Array(size) }. */
  wave(wo) {
    let w = this._waves.get(wo);
    if (w) return w;
    this._chk(wo, 16);
    const type = this.u16(wo), status = this.u16(wo + 2), freqFixed = this.u32(wo + 4), loopStart = this.u32(wo + 8), size = this.u32(wo + 12);
    if (size > MAX_WAVE_SAMPLES) throw new Mp2kError('wave-size', `wave at ${hex(wo)}: ${size} samples exceeds ${MAX_WAVE_SAMPLES}`, { offset: wo, size });
    const loops = (status & 0x4000) !== 0;
    let data;
    if (type === 1) {
      const blocks = Math.ceil(size / 64);
      this._chk(wo + 16, blocks * 33);
      data = decodeDpcm(this.bytes, wo + 16, size);
    } else if (type === 0) {
      this._chk(wo + 16, size);
      data = new Int8Array(size);
      for (let i = 0; i < size; i++) data[i] = this.bytes[wo + 16 + i] << 24 >> 24;
    } else {
      throw new Mp2kError('wave-type', `wave at ${hex(wo)}: type ${type} (expected 0 PCM or 1 DPCM)`, { offset: wo, type });
    }
    if (loops && loopStart >= size) throw new Mp2kError('wave-loop', `wave at ${hex(wo)}: loop start ${loopStart} >= size ${size}`, { offset: wo });
    w = { offset: wo, compressed: type === 1, loops, loopStart: loops ? loopStart : 0, size, freq: freqFixed / 1024, freqFixed, data };
    this._waves.set(wo, w);
    return w;
  }
}

/** Decode the 4-bit DPCM codec used by compressed m4a samples (33-byte blocks -> 64 samples). */
export function decodeDpcm(bytes, start, size) {
  const out = new Int8Array(size);
  const D = DPCM_DELTA;
  let src = start;
  for (let p = 0; p < size; p += 64, src += 33) {
    let s = (bytes[src] << 24) >> 24;
    out[p] = s;
    let q = p + 1;
    if (q < size) { s = ((s + D[bytes[src + 1] & 15]) << 24) >> 24; out[q++] = s; }
    for (let k = 2; k < 33 && q < size; k++) {
      const b = bytes[src + k];
      s = ((s + D[b >> 4]) << 24) >> 24; out[q++] = s;
      if (q < size) { s = ((s + D[b & 15]) << 24) >> 24; out[q++] = s; }
    }
  }
  return out;
}

/** ToneData record at file offset `o` -> a plain object the sequencer copies. */
export function decodeVoice(r, o) {
  const type = r.u8(o), key = r.u8(o + 1), length = r.u8(o + 2), panSweep = r.u8(o + 3), w4 = r.u32(o + 4), w8 = r.u32(o + 8);
  const v = { offset: o, type, key, length, panSweep, word4: w4, word8: w8, attack: r.u8(o + 8), decay: r.u8(o + 9), sustain: r.u8(o + 10), release: r.u8(o + 11), kind: 'invalid', fixed: (type & VT.FIX) !== 0, reverse: (type & VT.REV) !== 0, cmpFlag: (type & VT.CMP) !== 0 };
  if (type === 0x40 || (type & 0xC0) === 0x40) { v.kind = 'split'; v.group = r.isPtr(w4) ? w4 - ROM_BASE : -1; v.splitTable = r.isPtr(w8) ? w8 - ROM_BASE : -1; }
  else if ((type & 0xC0) === 0x80 || type === 0x80) { v.kind = 'rhythm'; v.group = r.isPtr(w4) ? w4 - ROM_BASE : -1; }
  else if ((type & 0xC0) === 0) {
    const c = type & VT.CGB_MASK;
    if (c === 0) { v.kind = 'ds'; v.wave = r.isPtr(w4) ? w4 - ROM_BASE : -1; }
    else if (c === 1) { v.kind = 'sq1'; v.duty = w4 & 3; }
    else if (c === 2) { v.kind = 'sq2'; v.duty = w4 & 3; }
    else if (c === 3) { v.kind = 'wave'; v.wave = r.isPtr(w4) ? w4 - ROM_BASE : -1; }
    else if (c === 4) { v.kind = 'noise'; v.period = w4 & 1; }
  }
  return v;
}

// ---------------------------------------------------------------------------------------------------------------
// Song-table location
// ---------------------------------------------------------------------------------------------------------------

/** Classify the 8-byte slot at file offset `o`: 'song' (valid header), 'dummy' (header of zero tracks) or null. */
function classifySlot(bytes, dv, L, o) {
  if (o + 8 > L) return null;
  const hp = dv.getUint32(o, true);
  if (hp < ROM_BASE || hp - ROM_BASE + 8 > L || (hp & 3) !== 0) return null;
  const p1 = dv.getUint16(o + 4, true), p2 = dv.getUint16(o + 6, true);
  if (p1 >= 16 || p2 >= 16) return null;
  const h = hp - ROM_BASE, tc = bytes[h];
  if (tc === 0) {
    // a song with no tracks (mus_dummy and friends): all-zero header, or a zero-track header that still carries a voicegroup pointer
    if (dv.getUint32(h, true) === 0) return 'dummy';
    const vg0 = dv.getUint32(h + 4, true);
    return bytes[h + 1] === 0 && vg0 >= ROM_BASE && vg0 - ROM_BASE < L ? 'dummy' : null;
  }
  if (tc > MAX_TRACKS || h + 8 + 4 * tc > L) return null;
  const vg = dv.getUint32(h + 4, true);
  if (vg < ROM_BASE || vg - ROM_BASE >= L) return null;
  for (let t = 0; t < tc; t++) {
    const tp = dv.getUint32(h + 8 + 4 * t, true);
    if (tp < ROM_BASE || tp - ROM_BASE >= L) return null;
  }
  return 'song';
}

function tableStats(bytes, dv, L, offset) {
  let songs = 0, dummies = 0, n = 0;
  for (;;) {
    const c = classifySlot(bytes, dv, L, offset + 8 * n);
    if (!c) break;
    if (c === 'song') songs++; else dummies++;
    n++;
  }
  return { songs, dummies, count: n };
}

/**
 * Scan the whole ROM for the m4a song table: the longest run of valid 8-byte entries (header pointer to a header with
 * 1..16 valid track pointers and a valid voicegroup pointer, or to an all-zero "dummy" header; player indices < 16).
 * Then cross-check with the game's own code: a literal-pool word equal to the table address, with the player table
 * pointer next to it. Returns { offset, count, songs, dummies, codeRefs:[file offsets of the literal], mplay:{offset, players:[{info,tracks,maxTracks}]}|null }.
 */
export function findSongTable(rom, opts = {}) {
  const bytes = rom instanceof Uint8Array ? rom : new Uint8Array(rom.buffer || rom, rom.byteOffset || 0, rom.byteLength);
  const L = bytes.length;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, L);
  const minSongs = opts.minSongs || 24;
  let best = null;
  for (let o = 0; o + 8 <= L; o += 4) {
    const c = classifySlot(bytes, dv, L, o);
    if (!c) continue;
    const st = tableStats(bytes, dv, L, o);
    if (st.songs >= minSongs && (!best || st.songs > best.songs)) best = { offset: o, ...st };
    o += 8 * Math.max(0, st.count - 1);
  }
  if (!best) throw new Mp2kError('no-song-table', 'no m4a song table found: no run of valid song-table entries');
  return finishTable(bytes, dv, L, best);
}

function verifyTable(r, offset, count) {
  if (!Number.isInteger(offset) || !Number.isInteger(count) || offset < 0 || offset + 8 * count > r.length) throw new Mp2kError('hint', 'song table hint is outside the ROM');
  const st = tableStats(r.bytes, r.dv, r.length, offset);
  if (st.count < count) throw new Mp2kError('hint', `song table hint ${hex(offset)} x${count}: only ${st.count} valid entries there`);
  return finishTable(r.bytes, r.dv, r.length, { offset, songs: st.songs, dummies: st.dummies, count: st.count });
}

function scanRefs(dv, L, target) { const refs = []; for (let o = 0; o + 4 <= L; o += 4) if (dv.getUint32(o, true) === target) refs.push(o); return refs; }

function finishTable(bytes, dv, L, t) {
  const target = ROM_BASE + t.offset;
  // the player table normally sits directly below the song table (12 bytes x 4); check that first - it costs nothing
  let mplay = null, refs = null;
  if (t.offset >= 48) { const players = readPlayers(dv, t.offset - 48); if (players) mplay = { offset: t.offset - 48, players }; }
  if (!mplay) {
    // otherwise find it through the game's own code: a literal-pool word equal to the table address with the player table pointer next to it
    refs = scanRefs(dv, L, target);
    for (const o of refs) {
      for (const d of [-4, 4]) {
        const p = o + d >= 0 && o + d + 4 <= L ? dv.getUint32(o + d, true) : 0;
        const mo = p - ROM_BASE;
        if (p >= ROM_BASE && mo + 48 <= L) { const players = readPlayers(dv, mo); if (players) { mplay = { offset: mo, players }; break; } }
      }
      if (mplay) break;
    }
  }
  const out = { offset: t.offset, count: t.count, songs: t.songs, dummies: t.dummies, mplay };
  // codeRefs (file offsets of the literal-pool words equal to the table address) is a cross-check for tests and tooling: computed on first read
  Object.defineProperty(out, 'codeRefs', { enumerable: true, configurable: true, get() { if (!refs || refs.length === 0) refs = scanRefs(dv, L, target); return refs; } });
  return out;
}

function readPlayers(dv, mo) {
  const players = [];
  for (let k = 0; k < 4; k++) {
    const info = dv.getUint32(mo + 12 * k, true), tracks = dv.getUint32(mo + 12 * k + 4, true), maxTracks = dv.getUint8(mo + 12 * k + 8);
    const inRam = (v) => (v >>> 24) === 0x03 || (v >>> 24) === 0x02;
    if (!inRam(info) || !inRam(tracks) || maxTracks < 1 || maxTracks > MAX_TRACKS) return null;
    players.push({ info, tracks, maxTracks });
  }
  return players;
}

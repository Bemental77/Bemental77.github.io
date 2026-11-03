// pokemonarena/js/cries.js -- Pokemon cries of the SoulGold v1.1.1 ROM, decoded at runtime from the ROM bytes.
//
// Pure ES module for browsers AND Node: no `node:` imports, no Buffer, no DOM at import time, no globals read
// while loading. Holds offsets, strides and codec rules only -- never a sample, never ROM-derived content. Every
// function is deterministic and side-effect free except playCry (which starts one AudioBufferSourceNode and must
// only be called by product code AFTER a user gesture; see "AUDIO RULE" below).
//
//   import { loadPackAsync } from './tables.js';
//   import { cryForSpecies, cryToAudioBuffer, playCry, isSoundOn } from './cries.js';
//   const cry = cryForSpecies(pack, rom, 25);                // { cryId, sampleRate, pcm: Int8Array, loop, ... }
//   if (cry && isSoundOn()) playCry(audioCtx, cry, { gain: 0.5 });          // normal (send-out) cry
//   if (cry && isSoundOn()) playCry(audioCtx, cry, { mode: 'faint' });      // faint cry (lower, slower)
//
// ---------------------------------------------------------------------------------------------------------------
// WHAT IS CONFIRMED BY STRUCTURE (checked against the pinned ROM by tools/pokemonarena_cries_test.mjs) AND WHAT IS
// ONLY INFERRED. Nothing here is taken on trust from a document.
//
// CONFIRMED, from the ROM's own bytes:
//  * gCryTable: 737 ToneData entries x 12 bytes at file offset 0x15cb0dc. Every entry is `20 3c 00 00 <wave ptr>
//    ff 00 ff 00` (type 0x20, key 60, flat envelope: attack 255, decay 0, sustain 255, release 0). The next 737
//    entries (0x15cd368, type 0x30 = 0x20|0x10 "reverse" flag) point at the SAME 737 waves. A whole-ROM scan finds
//    exactly one run of 737 forward entries (scanForCryTable) and it starts here.
//  * Each wave is a 16-byte header {u16 type = 1 (compressed), u16 status = 0 (no loop), u32 rate*1024, u32
//    loopStart = 0, u32 sampleCount} followed by ceil(sampleCount/64) blocks of 33 bytes. The 737 waves are
//    sorted, distinct, and packed back to back (each ends within 0..3 bytes of the next one's start).
//  * The DPCM codec. Block = 33 bytes -> 64 samples: byte 0 is the first sample (raw signed 8 bit); byte 1 holds ONE
//    delta index in its LOW nibble (the high nibble is 0 in all 168,630 blocks -- the encoder never uses it); bytes 2..32
//    hold two delta indices each, HIGH nibble first. sample[n] = sample[n-1] + DELTA[index], wrapped to 8 bits, and
//    every block restarts from its own raw first byte. DELTA[i] = i*i for i < 8 and -((16-i)^2) for i >= 8
//    (0,1,4,9,16,25,36,49,-64,-49,-36,-25,-16,-9,-4,-1); two byte-identical 16-byte copies of that table sit in
//    the ROM (0x76474c, 0x287f34) and the decoder reads them. The ROM's own ARM routine at 0x287ee4 (hand-disassembled
//    while writing this) performs the same accumulation: `mov lr,#0x40` / `subs lr,lr,#2` (64 samples per block),
//    byte 0 loaded raw, byte 1 indexed straight into the delta table, then for each following byte
//    `ldrb r2,[ip,r3,lsr #4]` (HIGH nibble, added first) before `and r3,r3,#0xf` / `ldrb r1,[ip,r3]` (low nibble);
//    its caller at 0x287fd0 steps blocks with `mov r1,#0x21 ; mla` (33 bytes). Caveat: that routine's sample stores
//    are `nop`s (it hands back the last two samples in r1/r2), so it confirms the arithmetic, the nibble order and the
//    33/64 framing, not an output-buffer layout.
//  * Species -> cry. A Thumb function at ROM 0x1f3338 (pokeemerald's GetCryIdBySpecies, by position and behaviour)
//    reads the u16 at species-record +0x40 (record = 0x7c7310 + 0x118*id, the same table tables.js decodes) and returns
//    0 when it is greater than 0x2e1 (737). The function at 0x2440b8 (pokeemerald's PlayCryInternal) then computes
//    `index = cryId - 1`, times 12, plus gCryTable (or gCryTable_Reverse for the echo modes); its literal pool at
//    0x2442b0/0x2442b8 holds both table addresses. All 1038 legal species carry a cryId in 1..737 and all 737 ids are
//    used. (The function NAMES are labels from memory of the pret decompilation; the addresses and behaviour are what
//    was read from this ROM.)
//  * The per-mode parameters of that function (jump table at 0xf3c55c, 14 modes). Mode 0 (normal) uses pitch 15360 =
//    60 * 256 (the neutral value, key 60 = the ToneData key above), length 210, release 0; mode 5 uses pitch 14440,
//    length 210, release 200. NOT verified: that the game's faint cry is mode 5. That is inferred from its position in
//    the jump table (vanilla order NORMAL, DOUBLES, ENCOUNTER, HIGH_PITCH, ECHO_START, FAINT, ...) and from 14440 being
//    the only lower-pitch case with release 200; the call sites were NOT traced.
//
// INFERRED / NOT REPRODUCED (read this before claiming "sounds like the game"):
//  * RATE. A wave's rate field (10512, 13379, 13000 or 11025 Hz here) is the rate at which the sample plays when the
//    note is key 60. 10512 and 13379 are two of the standard m4a mixer rates. Neutral pitch 15360 decomposes in the
//    ROM's pitch setter (the function at 0x1a1454 that the third call in 0x2440b8 reaches) into key (15360+128)>>8 = 60
//    and a centred fine-tune ((15360+128)>>1 & 0x7f = 64), so the normal cry
//    plays at exactly the wave's own rate and we hand the browser that rate untouched. That the m4a pitch->rate law is
//    2^((pitch-15360)/3072) for OTHER pitches (used for 'faint') is the nominal reading (256 units per semitone);
//    the fine-tune scaling inside the ROM's mixer was not reverse engineered, so the faint rate (about 0.8125x) may be
//    off by a fraction of a semitone.
//  * The GBA mixer resamples to its own output rate (13379 Hz in-game) and then to the console DAC; the browser
//    resamples from the wave rate to the device rate with its own filter. Interpolation, DAC filtering and the game's
//    master/cry volume are not reproduced. `DEFAULT_CRY_GAIN` is a comfortable listening level, not the game's.
//  * The cry "song" parameters length (210 ticks in normal mode), release, chorus (a second detuned voice) and the
//    reverse-table echo modes are not reproduced. The longest decoded cry is 3.44 s; whether the game's 210-tick length
//    would cut any cry short depends on the cry song's tempo, which was not read, so truncation is unmeasured.
//  * Samples are 8-bit signed; they are converted with x/128 (so -128 maps to -1 exactly and +127 to 0.9921875).
//
// AUDIO RULE (binding): sound is MUTED by default. localStorage key `arena.sound` === '1' turns it on, and only
// product code, after a user gesture, may create/resume an AudioContext and call playCry. Nothing in this file creates
// an AudioContext, opens a device or starts a source on its own; cryToAudioBuffer only builds an AudioBuffer.

import { PINNED, identify, assertPinned, toBytes } from './rom.js';

// ---------------------------------------------------------------------------------------------------------------
// Pins for the one ROM this page is built for. tools/pokemonarena_cries_test.mjs fails if these drift from
// pokemonarena/cries.golden.json or from what the ROM actually contains.
// ---------------------------------------------------------------------------------------------------------------

export const CRY_LAYOUT = Object.freeze({
  table: Object.freeze({ offset: 0x15cb0dc, stride: 12, count: 737 }),   // gCryTable
  reverse: Object.freeze({ offset: 0x15cd368 }),                          // gCryTable_Reverse (same waves, REV flag)
  deltaTable: Object.freeze({ offsets: Object.freeze([0x76474c, 0x287f34]), size: 16 }),
  entry: Object.freeze({ type: 0x20, reverseType: 0x30, key: 0x3c }),     // ToneData header bytes
  wave: Object.freeze({ headerBytes: 16, blockBytes: 33, blockSamples: 64, maxSamples: 0x100000 }),
  speciesCryIdField: 0x40,                                                // u16 inside the 0x118-byte species record
});

export const DELTA = Object.freeze(Array.from({ length: 16 }, (_, i) => (i < 8 ? i * i : -((16 - i) * (16 - i)))));

export const CRY_MIN_RATE = 8000;   // Web Audio AudioBuffer sampleRate lower bound
export const CRY_MAX_RATE = 96000;  // ... and upper bound

/** Raised for every refusal in this module. `code` is machine-readable (tests and UIs switch on it). */
export class CryError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'CryError';
    this.code = code;
    this.details = details || null;
  }
}
/** The cry table (or one of its waves) is not what the pinned ROM contains. */
export class CryTableError extends CryError {
  constructor(code, message, details) {
    super(code, message, details);
    this.name = 'CryTableError';
  }
}

const hex = (n) => '0x' + n.toString(16);

// ---------------------------------------------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------------------------------------------

function view(bytes) { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }

function entryShape(dv, bytes, o, type) {
  // `20 3c 00 00 <ptr into ROM> ff 00 ff 00` (or type 0x30 for the reverse table)
  if (o < 0 || o + 12 > bytes.length) return false;
  if (bytes[o] !== type || bytes[o + 1] !== CRY_LAYOUT.entry.key || bytes[o + 2] !== 0 || bytes[o + 3] !== 0) return false;
  if (bytes[o + 8] !== 0xff || bytes[o + 9] !== 0 || bytes[o + 10] !== 0xff || bytes[o + 11] !== 0) return false;
  const p = dv.getUint32(o + 4, true);
  return p >= 0x08000000 && p < 0x08000000 + bytes.length;
}

/**
 * Find a run of at least `minCount` forward cry-table entries by scanning the whole ROM (4-byte aligned). Used by the
 * test to prove the pinned offset is where the structure is, and by tooling; locateCryTable does NOT need it.
 * Returns [{ offset, count }].
 */
export function scanForCryTable(rom, minCount = 64) {
  const bytes = toBytes(rom), dv = view(bytes), runs = [];
  const T = CRY_LAYOUT.entry.type;
  for (let o = 0; o + 12 <= bytes.length; o += 4) {
    if (!entryShape(dv, bytes, o, T)) continue;
    let n = 0, p = o;
    while (entryShape(dv, bytes, p, T)) { n++; p += 12; }
    if (n >= minCount) runs.push({ offset: o, count: n });
    o = p - 4;
  }
  return runs;
}

function checkRom(bytes, verify) {
  if (verify === 'none') return;
  if (verify === 'sha256') { assertPinned(bytes, { hash: 'sha256' }); return; }
  if (verify !== 'header') throw new TypeError(`unknown verify mode ${verify}`);
  if (bytes.length !== PINNED.length) throw new CryError('rom-length', `ROM is ${bytes.length} bytes; the pinned image is ${PINNED.length}`, { length: bytes.length });
  const id = identify(bytes, { hash: 'none' });
  if (!id.ok) throw new CryError('rom-header', `not the pinned ROM: ${id.reasons.join('; ')}`, { reasons: id.reasons });
}

/**
 * Locate and structurally validate the cry table. Returns a plain object other functions reuse:
 *   { offset, stride, count, reverseOffset, waves: Uint32Array(count) /* FILE offsets of each wave header *\/,
 *     waveStart, waveEnd, deltaOffset }
 * Throws CryError('rom-length'|'rom-header') for a wrong image and CryTableError for a table that is not the one pinned:
 *   code 'wrong-length' (declared count disagrees with the run of entries actually in the ROM),
 *        'bad-entry' (an entry is not `20 3c 00 00 <ptr> ff 00 ff 00`), 'reverse-mismatch', 'wave-header',
 *        'wave-gap' (waves overlap or leave a gap > 3 bytes), 'delta-table'.
 * opts: { verify: 'header' (default) | 'sha256' | 'none',  layout: { table:{offset,stride,count}, reverse:{offset} } override }
 */
export function locateCryTable(rom, opts = {}) {
  const bytes = toBytes(rom);
  checkRom(bytes, opts.verify || 'header');
  const L = opts.layout || CRY_LAYOUT;
  const { offset, stride, count } = L.table;
  const revOff = L.reverse ? L.reverse.offset : offset + count * stride;
  if (stride !== 12) throw new CryTableError('bad-entry', `table stride ${stride} != 12`);
  if (!Number.isInteger(count) || count < 1) throw new CryTableError('wrong-length', `table count ${count} is not a positive integer`);
  const dv = view(bytes);
  const F = CRY_LAYOUT.entry.type, R = CRY_LAYOUT.entry.reverseType;
  const waves = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    const o = offset + i * stride;
    if (!entryShape(dv, bytes, o, F)) {
      // an entry that is shaped like the REVERSE table means the declared count runs past the forward table
      if (entryShape(dv, bytes, o, R)) throw new CryTableError('wrong-length', `declared count ${count} but entry ${i} (${hex(o)}) already belongs to the reverse table: the forward table has ${i} entries`, { index: i, offset: o });
      throw new CryTableError('bad-entry', `entry ${i} at ${hex(o)} is not 20 3c 00 00 <ptr> ff 00 ff 00`, { index: i, offset: o });
    }
    waves[i] = dv.getUint32(o + 4, true) - 0x08000000;
  }
  // the entry just past the table must NOT be another forward entry (that would mean the table is longer than declared)
  if (entryShape(dv, bytes, offset + count * stride, F)) {
    throw new CryTableError('wrong-length', `declared count ${count} but entry ${count} is another forward cry entry: the table is longer`, { index: count });
  }
  // reverse table: same count, same wave pointers
  for (let i = 0; i < count; i++) {
    const o = revOff + i * stride;
    if (!entryShape(dv, bytes, o, R) || dv.getUint32(o + 4, true) - 0x08000000 !== waves[i]) {
      throw new CryTableError('reverse-mismatch', `reverse entry ${i} at ${hex(o)} does not mirror forward entry ${i}`, { index: i, offset: o });
    }
  }
  // waves: valid headers, then non-overlapping, packed (each ends within 0..3 bytes of the next start in file order)
  const W = CRY_LAYOUT.wave;
  const order = Array.from(waves.keys()).sort((a, b) => waves[a] - waves[b]);
  let prevEnd = -1, prevIdx = -1;
  for (const i of order) {
    const w = waves[i];
    if (w + W.headerBytes > bytes.length) throw new CryTableError('wave-header', `wave ${i} header at ${hex(w)} runs past the ROM`, { index: i });
    const type = dv.getUint16(w, true), status = dv.getUint16(w + 2, true), loopStart = dv.getUint32(w + 8, true), n = dv.getUint32(w + 12, true);
    const rate = dv.getUint32(w + 4, true) / 1024;
    if (type !== 1) throw new CryTableError('wave-header', `wave ${i} at ${hex(w)}: type ${type} != 1 (compressed DPCM)`, { index: i });
    if (status !== 0 && status !== 0x4000) throw new CryTableError('wave-header', `wave ${i}: status ${hex(status)} is neither 0 nor 0x4000`, { index: i });
    if (n < 1 || n > W.maxSamples) throw new CryTableError('wave-header', `wave ${i}: sample count ${n} outside 1..${W.maxSamples}`, { index: i });
    if (status === 0x4000 && loopStart >= n) throw new CryTableError('wave-header', `wave ${i}: loop start ${loopStart} >= ${n} samples`, { index: i });
    if (!(rate >= CRY_MIN_RATE && rate <= CRY_MAX_RATE)) throw new CryTableError('wave-header', `wave ${i}: rate ${rate} Hz outside ${CRY_MIN_RATE}..${CRY_MAX_RATE}`, { index: i });
    const end = w + W.headerBytes + W.blockBytes * Math.ceil(n / W.blockSamples);
    if (end > bytes.length) throw new CryTableError('wave-header', `wave ${i}: data runs past the ROM`, { index: i });
    if (prevIdx >= 0) {
      const gap = w - prevEnd;
      if (gap < 0 || gap > 3) throw new CryTableError('wave-gap', `wave ${i} starts ${gap} bytes after wave ${prevIdx} ends (expected 0..3)`, { index: i, previous: prevIdx, gap });
    }
    prevEnd = end; prevIdx = i;
  }
  // the codec's delta table, read from the ROM, must be the quadratic table this module decodes with
  let deltaOffset = -1;
  for (const d of CRY_LAYOUT.deltaTable.offsets) {
    let same = d + 16 <= bytes.length;
    for (let k = 0; same && k < 16; k++) if (((bytes[d + k] << 24) >> 24) !== DELTA[k]) same = false;
    if (same) { deltaOffset = d; break; }
  }
  if (deltaOffset < 0) throw new CryTableError('delta-table', 'no copy of the DPCM delta table at the pinned offsets matches 0,1,4,9,16,25,36,49,-64,...,-1');
  return { offset, stride, count, reverseOffset: revOff, waves, waveStart: waves[order[0]], waveEnd: prevEnd, deltaOffset };
}

// ---------------------------------------------------------------------------------------------------------------
// Decode
// ---------------------------------------------------------------------------------------------------------------

/**
 * Decode one cry. `cryId` is the 1-based id stored in a species record (tables.js pack.species[id].cryId); table index
 * is cryId - 1 (PlayCryInternal subtracts one). Returns
 *   { cryId, index, wave, rateFixed, sampleRate, sampleCount, durationSeconds, pcm: Int8Array, loop: null | {start,end} }
 * `sampleRate` is in Hz (rateFixed / 1024). `loop` is null when the wave has no loop flag (all 737 here).
 * opts: { table (from locateCryTable, saves re-validating), verify, layout }
 * Throws CryError('cry-id') for an id outside 1..count (0 means "no cry"; use cryForSpecies to get null instead).
 */
export function decodeCry(rom, cryId, opts = {}) {
  const bytes = toBytes(rom);
  const table = opts.table || locateCryTable(bytes, opts);
  if (!Number.isInteger(cryId) || cryId < 1 || cryId > table.count) {
    throw new CryError('cry-id', `cry id ${cryId} is not an integer in 1..${table.count}`, { cryId });
  }
  const index = cryId - 1, w = table.waves[index];
  const dv = view(bytes);
  const n = dv.getUint32(w + 12, true), rateFixed = dv.getUint32(w + 4, true), status = dv.getUint16(w + 2, true);
  const W = CRY_LAYOUT.wave;
  if (dv.getUint16(w, true) !== 1 || n < 1 || n > W.maxSamples) throw new CryTableError('wave-header', `wave for cry ${cryId} at ${hex(w)} is not a type-1 wave of 1..${W.maxSamples} samples`, { cryId });
  const blocks = Math.ceil(n / W.blockSamples);
  if (w + W.headerBytes + blocks * W.blockBytes > bytes.length) throw new CryTableError('wave-header', `wave for cry ${cryId} runs past the ROM`, { cryId });
  const D = DELTA;
  const pcm = new Int8Array(n);
  let src = w + W.headerBytes;
  for (let p = 0; p < n; p += W.blockSamples, src += W.blockBytes) {
    let s = bytes[src];                       // first sample, raw (Int8Array store wraps it to signed)
    pcm[p] = s;
    s = (s << 24) >> 24;
    let q = p + 1;
    if (q < n) { s = ((s + D[bytes[src + 1] & 15]) << 24) >> 24; pcm[q++] = s; }   // byte 1: low nibble only
    for (let j = 2; j < W.blockBytes && q < n; j++) {
      const b = bytes[src + j];
      s = ((s + D[b >> 4]) << 24) >> 24; pcm[q++] = s;                              // high nibble first
      if (q < n) { s = ((s + D[b & 15]) << 24) >> 24; pcm[q++] = s; }
    }
  }
  const sampleRate = rateFixed / 1024;
  const loop = status === 0x4000 ? { start: dv.getUint32(w + 8, true), end: n } : null;
  return { cryId, index, wave: w, rateFixed, sampleRate, sampleCount: n, durationSeconds: n / sampleRate, pcm, loop };
}

/**
 * The cry of a species, or null when it has none (null/removed species slot, species 0, cryId 0, or a cryId past the
 * table -- the ROM's GetCryIdBySpecies returns 0 for > 737, and the game plays nothing). Adds `speciesId` to the result.
 * `pack` is the object from tables.js loadPack(); only pack.species[id].cryId is read.
 */
export function cryForSpecies(pack, rom, speciesId, opts = {}) {
  const sp = pack && pack.species ? pack.species[speciesId] : null;
  if (!sp || !(speciesId >= 1)) return null;
  const table = opts.table || locateCryTable(rom, opts);
  const id = sp.cryId;
  if (!Number.isInteger(id) || id < 1 || id > table.count) return null;
  const cry = decodeCry(rom, id, { ...opts, table });
  cry.speciesId = speciesId;
  return cry;
}

// ---------------------------------------------------------------------------------------------------------------
// Playback. None of this runs at import. cryToAudioBuffer builds a buffer and starts NOTHING; playCry starts exactly
// one source and is for product code after a user gesture.
// ---------------------------------------------------------------------------------------------------------------

export const SOUND_KEY = 'arena.sound';
export const DEFAULT_CRY_GAIN = 0.5;

/** m4a pitch values used by the game (1/256 semitone units; 15360 = 60*256 = the wave's own rate). */
export const CRY_PITCH = Object.freeze({ normal: 15360, faint: 14440 });
/** Nominal m4a pitch -> playback-rate law: 256 pitch units per semitone. See the INFERRED notes at the top of the file. */
export function cryPlaybackRate(pitch) {
  if (!Number.isFinite(pitch)) throw new CryError('pitch', `pitch ${pitch} is not a finite number`);
  return Math.pow(2, (pitch - CRY_PITCH.normal) / (256 * 12));
}

/** int8 PCM -> Float32 in [-1, 127/128]. */
export function cryToFloat32(cry) {
  const pcm = cry && cry.pcm;
  if (!pcm || !pcm.length) throw new CryError('cry', 'cry has no samples');
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / 128;
  return out;
}

/**
 * Build a mono AudioBuffer at the wave's OWN sample rate (the browser resamples to the device; the pitch is untouched).
 * Does not create a source and does not start anything. `audioCtx` only needs createBuffer(channels, length, rate)
 * (an OfflineAudioContext is enough). Throws CryError('rate') when the rate is outside what Web Audio accepts.
 */
export function cryToAudioBuffer(audioCtx, cry) {
  if (!audioCtx || typeof audioCtx.createBuffer !== 'function') throw new CryError('audio-context', 'audioCtx.createBuffer is not available');
  const f = cryToFloat32(cry);
  const rate = cry.sampleRate;
  if (!(rate >= CRY_MIN_RATE && rate <= CRY_MAX_RATE)) throw new CryError('rate', `sample rate ${rate} Hz is outside ${CRY_MIN_RATE}..${CRY_MAX_RATE}`);
  const buf = audioCtx.createBuffer(1, f.length, rate);
  buf.getChannelData(0).set(f);
  return buf;
}

/**
 * Start one cry. Returns a handle { source, gainNode, buffer, duration, stop() } or null when it did not start.
 *   opts.gain          0..1, default DEFAULT_CRY_GAIN (a bad value throws, it is never silently clamped)
 *   opts.when          AudioContext time to start at (default audioCtx.currentTime)
 *   opts.mode          'normal' (default) | 'faint'   -> playback rate from CRY_PITCH
 *   opts.pitch         explicit m4a pitch value (overrides mode)
 *   opts.destination   node to connect to (default audioCtx.destination)
 *   opts.buffer        a buffer from cryToAudioBuffer, to avoid rebuilding it on every play
 * It returns null WITHOUT starting anything when the context is 'closed' or not 'running' (a suspended context queues
 * the source and blasts it later, all at once, when it is resumed): the caller resumes the context inside its user
 * gesture first. PRODUCT CODE ONLY; no test may call this with a real AudioContext.
 */
export function playCry(audioCtx, cry, opts = {}) {
  if (!audioCtx || typeof audioCtx.createBufferSource !== 'function') throw new CryError('audio-context', 'audioCtx.createBufferSource is not available');
  const gain = opts.gain === undefined ? DEFAULT_CRY_GAIN : opts.gain;
  if (!(typeof gain === 'number' && gain >= 0 && gain <= 1)) throw new CryError('gain', `gain ${gain} is not a number in 0..1`);
  const mode = opts.mode === undefined ? 'normal' : opts.mode;
  if (opts.pitch === undefined && !Object.prototype.hasOwnProperty.call(CRY_PITCH, mode)) throw new CryError('mode', `unknown cry mode ${JSON.stringify(mode)}`);
  const rate = cryPlaybackRate(opts.pitch === undefined ? CRY_PITCH[mode] : opts.pitch);
  if (audioCtx.state !== 'running') return null;
  const buffer = opts.buffer || cryToAudioBuffer(audioCtx, cry);
  const source = audioCtx.createBufferSource();
  source.buffer = buffer;
  if (source.playbackRate) source.playbackRate.value = rate;
  if (cry.loop) { source.loop = true; source.loopStart = cry.loop.start / cry.sampleRate; source.loopEnd = cry.loop.end / cry.sampleRate; }   // no cry in the pinned ROM loops
  const gainNode = audioCtx.createGain();
  gainNode.gain.value = gain;
  source.connect(gainNode);
  gainNode.connect(opts.destination || audioCtx.destination);
  source.onended = () => { try { source.disconnect(); gainNode.disconnect(); } catch (_e) { /* already gone */ } };
  const when = opts.when === undefined ? audioCtx.currentTime : opts.when;
  source.start(when);
  return {
    source, gainNode, buffer, duration: buffer.duration / rate,
    stop() { try { source.stop(); } catch (_e) { /* already stopped */ } },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The sound switch. Default is OFF (muted). `storage` is injectable so tests and non-browser callers never touch globals.
// ---------------------------------------------------------------------------------------------------------------

function defaultStorage() {
  try { return typeof globalThis !== 'undefined' && globalThis.localStorage ? globalThis.localStorage : null; } catch (_e) { return null; }
}
/** True only when localStorage['arena.sound'] === '1'. Any failure (no storage, private mode, throwing getter) is "off". */
export function isSoundOn(storage) {
  try { const s = storage === undefined ? defaultStorage() : storage; return !!s && s.getItem(SOUND_KEY) === '1'; } catch (_e) { return false; }
}
export function setSoundOn(on, storage) {
  try { const s = storage === undefined ? defaultStorage() : storage; if (!s) return false; s.setItem(SOUND_KEY, on ? '1' : '0'); return true; } catch (_e) { return false; }
}
/** playCry gated by the sound switch: returns null (and starts nothing) while sound is off. */
export function playCryIfSoundOn(audioCtx, cry, opts = {}) {
  if (!isSoundOn(opts.storage)) return null;
  return playCry(audioCtx, cry, opts);
}

// ---------------------------------------------------------------------------------------------------------------
// Tooling
// ---------------------------------------------------------------------------------------------------------------

/** 8-bit unsigned mono WAV file bytes of a decoded cry (scratch / inspection use only; nothing in the product calls it). */
export function cryToWav(cry) {
  const n = cry.pcm.length, rate = Math.round(cry.sampleRate);
  const out = new Uint8Array(44 + n), dv = new DataView(out.buffer);
  const tag = (o, s) => { for (let i = 0; i < 4; i++) out[o + i] = s.charCodeAt(i); };
  tag(0, 'RIFF'); dv.setUint32(4, 36 + n, true); tag(8, 'WAVE'); tag(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true); dv.setUint32(28, rate, true); dv.setUint16(32, 1, true); dv.setUint16(34, 8, true);
  tag(36, 'data'); dv.setUint32(40, n, true);
  for (let i = 0; i < n; i++) out[44 + i] = (cry.pcm[i] + 128) & 255;
  return out;
}

/** Per-cry hash input for goldens: header fields then the raw int8 samples, so a rate/length/id change is caught too. */
export function cryHashBytes(cry) {
  const n = cry.pcm.length, out = new Uint8Array(16 + n), dv = new DataView(out.buffer);
  dv.setUint32(0, cry.cryId, true); dv.setUint32(4, cry.rateFixed, true); dv.setUint32(8, n, true);
  dv.setUint32(12, cry.loop ? cry.loop.start : 0xffffffff, true);
  out.set(new Uint8Array(cry.pcm.buffer, cry.pcm.byteOffset, n), 16);
  return out;
}

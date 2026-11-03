/* gba/mgba/room.js - the GBA link-cable ROOM protocol (stage GR1 = plan G4). PURE ES MODULE: no DOM, no `node:`, no network, no storage,
 * no clock, no randomness. Everything that touches the outside world is passed in (the core factory, the rom bytes, a codec, a
 * journal record to persist). tools/gba_room_protocol_test.mjs loads this file in Node, in a data: URL (for the mutants) and in headless
 * Chrome (--browser), and checks it against the REAL lib/netplay.js Lockstep engine and REAL mGBA cores.
 *
 * WHAT A ROOM IS. N players (2..4), each on their OWN machine; every machine runs ALL N linked GBA cores in one wasm instance (plan O1) and
 * only per-frame input words and one-time per-seat battery images cross the wire. The room is deterministic delay-lockstep at EXACTLY
 * 1.000x hardware (59.7275 Hz): nothing in this module fast-forwards, and `inputDelay` is a latency knob, never a speed knob.
 *
 * WHAT THIS MODULE GUARANTEES, in the order a room uses it:
 *   1. CONFIG   (makeConfig / encodeConfig / decodeConfig / discString / compareDisc / explainBarrierFailure)
 *      One canonical description of the machine: game, ROM md5, core build md5, seat count, pinned RTC (epoch + fixed UTC offset), save
 *      type per seat, input delay, protocol version, room id. Every field that must match goes into the DISC STRING the lockstep barrier
 *      compares (lib/netplay.js _checkBarrier compares the raw strings), so a mismatch is refused before frame 0 and NAMED
 *      (ROOM_ROM / ROOM_CORE / ROOM_SEATS / ROOM_CLOCK / ROOM_SAVETYPE / ROOM_VERSION / ...), with a sentence and a code.
 *      `inputDelay` and the `players` labels are deliberately NOT folded: the host retunes the delay mid-room and a returning page
 *      has a new peer id; neither can change what the machine computes.
 *   2. SAVES    (makeSaveEntry / verifySaveSet / chooseContribution / readRoomConfig)
 *      Every machine simulates every seat, so every machine needs every seat's battery image at frame 0. Each peer contributes the
 *      image of ITS OWN seat through lib/netplay.js `contributeCards` (the engine chunks it at 12 KiB, reassembles it by LENGTH, and
 *      fingerprints port:size:rawHash). The engine does NOT check chunk contents or the type of the thing: this module wraps each image
 *      in a self-describing envelope (seat, save type, size, per-chunk hashes, whole-image hash, optional room config) and verifies
 *      everything on receipt - tampered chunk, wrong size, wrong save type, missing seat, duplicate seat claim are each refused BY NAME.
 *      The raw hash is `Lockstep.cardHash` (FNV-1a 32 over the RAW image, never the compressed form).
 *   3. MACHINE  (bootMachine / RoomMachine)
 *      One function builds the machine the same way on every peer (create -> setRtc -> loadRom -> setSave per seat), and one method runs a
 *      frame from the engine's agreed input image. A returning page replays through exactly this path, so replay == live.
 *   4. END      (endInit / endStep / endCapture / endLocalCtl / planCommit / commitSteps / runSteps / endRecover / recoverPlan)
 *      Saves are committed to storage ONLY at a clean room end that every peer reaches, and only the LOCAL seat is ever written. The
 *      handshake is IN-BAND: it rides the 22 spare bits of every seat's per-frame input word (the one channel lib/netplay.js's star
 *      topology relays to everyone - a custom message would not reach the other guests). Because the input image of every applied
 *      frame is identical on every machine, so is the handshake's outcome, and a page that replays the room re-derives it.
 *      A page that dies in the middle is repaired from a journal that THIS module makes (staged / last-symbol / committing / committed, each
 *      carrying the local seat's image only): commitSteps lists the storage operations in order, runSteps executes them through the page's
 *      io, recoverPlan decides what a restarted page does with the record it finds (finish the commit, ask the player about an in-doubt
 *      room, or discard). The record kinds and the recovery table are documented at endRecover; the policy in README.md "Rooms".
 *   5. POLICY   (lockstepOptions / DISCONNECT_POLICY / CHECKPOINT_POLICY / replayCost)
 *      Delay lockstep, rsReplay ON, checkpoints OFF, rollback OFF. The numbers and the reasons are in gba/mgba/README.md "Rooms".
 *   6. BUDGET   (section 10 below: seatCap / defaultInputDelay / framesPerTick / CostRing / RateMeter / PaceWatch / paceNotice, stage GR3)
 *      How many seats a device can hold at EXACTLY 1.000x, the input delay a room starts at, and the plain-words notice for a slow device. Pure
 *      arithmetic over measured numbers (README "Budget"); nothing in it can raise the guest rate - spare time is a CAPACITY, never a rate.
 *
 * INPUT WORD (PAD_BYTES = 4, little-endian, one per seat per frame; `padBytes: 4` in the lockstep options):
 *     bits  0..9   the ten GBA keys (A B Select Start Right Left Up Down R L; 1 = pressed) - what core.setKeys() takes
 *     bits 10..25  payload (16 bits)             \  the in-band control symbol; all zero in an ordinary frame
 *     bits 26..27  position (0..3)               /
 *     bits 28..29  reserved, must be zero
 *     bits 30..31  kind: 0 idle, 1 WANT-END, 2 DIGEST, 3 invalid
 * A neutral (limp / dropped / not yet sampled) seat is the all-zero word: no keys, idle.
 */

// ---------------------------------------------------------------------------------------------------------------------------------
// 0. constants
// ---------------------------------------------------------------------------------------------------------------------------------
export const PROTOCOL_VERSION = 1;
export const PROTOCOL_TAG = 'gba' + PROTOCOL_VERSION;
export const MIN_SEATS = 2;
export const MAX_SEATS = 4;
export const PAD_BYTES = 4;
export const KEY_MASK = 0x3FF;
export const GBA_CLOCK_HZ = 16777216;              // the ARM7TDMI clock
export const GBA_CYCLES_PER_FRAME = 280896;        // VIDEO_TOTAL_LENGTH = 228 lines x 1232 cycles
export const GBA_HZ = GBA_CLOCK_HZ / GBA_CYCLES_PER_FRAME;   // 59.7275...: the ONLY frame rate a room has (gate 9: guest rate == hardware rate)
export const WIRE_CHUNK = 12 * 1024;               // = lib/netplay.js CARD_CHUNK: the engine's wire piece size (an envelope chunk is the same size, not at the same offset)
export const HASH_EVERY = 60;                      // fingerprint cadence (frames); lib/netplay.js default
export const DELAY_MIN = 1, DELAY_MAX = 30, DELAY_DEFAULT = 3;
export const SAVE_CAPS = Object.freeze({ flash: 128 * 1024, sram: 32 * 1024, eeprom: 8 * 1024 });
export const END_HOLD_FRAMES = 30;                 // every seat must hold WANT-END this many consecutive applied frames (about 0.5 s)
export const END_DIGEST_TIMEOUT = 900;             // applied frames after the agreed frame in which every seat's digest must arrive (about 15 s)
export const DIGEST_POSITIONS = 4;                 // 4 x 16 bits = a 64-bit digest, sent as a self-describing cycle

export const ERROR_CODES = Object.freeze([
  'ROOM_VERSION', 'ROOM_GAME', 'ROOM_NOT_ROOMABLE', 'ROOM_ROM', 'ROOM_CORE', 'ROOM_SEATS', 'ROOM_CLOCK', 'ROOM_SAVETYPE', 'ROOM_DELAY',
  'ROOM_ID', 'ROOM_ENCODING', 'ROOM_SAVESET',
  'SAVE_ENVELOPE', 'SAVE_ENC', 'SAVE_INFLATE', 'SAVE_TOO_BIG', 'SAVE_BAD_SIZE', 'SAVE_WRONG_TYPE', 'SAVE_TAMPERED_CHUNK', 'SAVE_BAD_HASH',
  'SAVE_MISSING_SEAT', 'SAVE_DUPLICATE_SEAT', 'SAVE_SEAT_CLAIM', 'SAVE_SEAT_RANGE', 'SAVE_CFG_MISSING', 'SAVE_REFUSED_BY_CORE',
  'SEATS_RANGE', 'SEATS_GAP', 'SEATS_HOST', 'SEATS_MULTI',
  'COMMIT_NOT_CLEAN', 'COMMIT_STORED_INVALID', 'COMMIT_BAD_STEP', 'END_MISMATCH', 'END_TIMEOUT', 'END_CONFLICT',
]);

export class RoomError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'RoomError';
    this.code = code;
    this.detail = detail || {};
    this.field = (detail && detail.field) || null;
  }
}
function fail(code, message, detail) { throw new RoomError(code, message, detail); }

function toU8(b) {
  if (b instanceof Uint8Array) return b;
  if (b && b.buffer instanceof ArrayBuffer) return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  if (b instanceof ArrayBuffer) return new Uint8Array(b);
  throw new TypeError('expected a Uint8Array or ArrayBuffer');
}
const isHex = (s, n) => typeof s === 'string' && s.length === n && /^[0-9a-f]+$/.test(s);
const isInt = (x) => typeof x === 'number' && Number.isInteger(x);
const eqBytes = (a, b) => { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };

// ---------------------------------------------------------------------------------------------------------------------------------
// 1. hashes (the same functions lib/netplay.js uses, so a fingerprint computed here is the one the engine compares)
// ---------------------------------------------------------------------------------------------------------------------------------
const FNV_SEED = 0x811c9dc5;
const fnvStep = (h, v) => Math.imul((h ^ v) >>> 0, 0x01000193) >>> 0;
const hex8 = (n) => ('0000000' + (n >>> 0).toString(16)).slice(-8);
/** FNV-1a 32 over bytes (lib/netplay.js fnvBytes). */
export function fnv1a(u8, seed) { let h = (seed === undefined ? FNV_SEED : seed) >>> 0; for (let i = 0; i < u8.length; i++) h = fnvStep(h, u8[i]); return h >>> 0; }
/** FNV-1a 32 over the char codes of a string (what Lockstep.cardSetHash does). */
export function fnvString(s, seed) { let h = (seed === undefined ? FNV_SEED : seed) >>> 0; for (let i = 0; i < s.length; i++) h = fnvStep(h, s.charCodeAt(i)); return h >>> 0; }
/** = Lockstep.cardHash(u8): 8 hex digits, FNV-1a 32 over the RAW bytes. */
export function cardHash(u8) { return hex8(fnv1a(toU8(u8))); }
/** = Lockstep.cardSetHash(set): the fingerprint the barrier compares. `set` = { port: { size, hash } }. Omits `enc` and the bytes, as the engine does. */
export function cardSetHash(set) {
  if (!set) return null;
  const ports = Object.keys(set).map((p) => p | 0).sort((a, b) => a - b);
  let s = '';
  for (const p of ports) s += p + ':' + (set[p].size | 0) + ':' + set[p].hash + ';';
  return hex8(fnvString(s));
}
/** FNV over the little-endian bytes of 32-bit words (the room fingerprint fold). */
export function foldWords(words) { let h = FNV_SEED; for (const w of words) for (let b = 0; b < 4; b++) h = fnvStep(h, (w >>> (8 * b)) & 255); return h >>> 0; }

const MD5_S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
const MD5_K = new Int32Array(64);
for (let i = 0; i < 64; i++) MD5_K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;
/** MD5 (RFC 1321) of bytes -> 32 hex digits. Pure JS so a page can hash the ROM and the wasm it actually loaded (SubtleCrypto has no MD5). */
export function md5(input) {
  const u8 = toU8(input);
  let a0 = 0x67452301 | 0, b0 = 0xefcdab89 | 0, c0 = 0x98badcfe | 0, d0 = 0x10325476 | 0;
  const M = new Int32Array(16);
  const run = () => {
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      let f, g;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) & 15; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) & 15; }
      else { f = c ^ (b | ~d); g = (7 * i) & 15; }
      f = (f + a + MD5_K[i] + M[g]) | 0;
      a = d; d = c; c = b;
      const s = MD5_S[((i >> 4) << 2) | (i & 3)];
      b = (b + ((f << s) | (f >>> (32 - s)))) | 0;
    }
    a0 = (a0 + a) | 0; b0 = (b0 + b) | 0; c0 = (c0 + c) | 0; d0 = (d0 + d) | 0;
  };
  const len = u8.length, full = Math.floor(len / 64);
  for (let k = 0; k < full; k++) {
    const o = k * 64;
    for (let w = 0; w < 16; w++) { const j = o + w * 4; M[w] = u8[j] | (u8[j + 1] << 8) | (u8[j + 2] << 16) | (u8[j + 3] << 24); }
    run();
  }
  const rest = len - full * 64, tail = new Uint8Array(rest < 56 ? 64 : 128);
  tail.set(u8.subarray(full * 64));
  tail[rest] = 0x80;
  const bits = len * 8, lo = bits >>> 0, hi = Math.floor(bits / 4294967296) >>> 0;
  for (let b = 0; b < 4; b++) { tail[tail.length - 8 + b] = (lo >>> (8 * b)) & 255; tail[tail.length - 4 + b] = (hi >>> (8 * b)) & 255; }
  for (let o = 0; o < tail.length; o += 64) {
    for (let w = 0; w < 16; w++) { const j = o + w * 4; M[w] = tail[j] | (tail[j + 1] << 8) | (tail[j + 2] << 16) | (tail[j + 3] << 24); }
    run();
  }
  let out = '';
  for (const v of [a0, b0, c0, d0]) for (let b = 0; b < 4; b++) out += ('0' + ((v >>> (8 * b)) & 255).toString(16)).slice(-2);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 2. the title table (every ROM the site ships) and the ROOMABLE catalogue (only titles with a PASSING link row)
// ---------------------------------------------------------------------------------------------------------------------------------
/** Save chips. `code` = MgbaCore.SAVE_TYPES (the test diffs them); `sizes` = the only image lengths that chip can hold; `cap` = SAVE_CAPS bucket. */
export const SAVE_TYPES = Object.freeze({
  none:      Object.freeze({ code: 0, sizes: Object.freeze([0]), cap: 'sram' }),
  sram:      Object.freeze({ code: 1, sizes: Object.freeze([0x8000]), cap: 'sram' }),
  flash512:  Object.freeze({ code: 2, sizes: Object.freeze([0x10000]), cap: 'flash' }),
  flash1m:   Object.freeze({ code: 3, sizes: Object.freeze([0x20000]), cap: 'flash' }),
  eeprom8k:  Object.freeze({ code: 4, sizes: Object.freeze([0x2000]), cap: 'eeprom' }),
  eeprom512: Object.freeze({ code: 5, sizes: Object.freeze([0x200]), cap: 'eeprom' }),
  sram512:   Object.freeze({ code: 6, sizes: Object.freeze([0x200]), cap: 'sram' }),
});
const SAVE_NAME_BY_CODE = Object.freeze(Object.fromEntries(Object.entries(SAVE_TYPES).map(([k, v]) => [v.code, k])));

/**
 * One row per ROM the site ships, keyed by the catalogue title (gba/gbaWasm/dist/romlist.js `title`). `saveTag` is what the cartridge's own
 * save library string says (core.info.saveTag, measured); `saveType`/`saveBytes` are the room's battery contract for the title. `blank` says
 * what a peer with NO stored save contributes: a 0xFF-filled image of `saveBytes` (measured equivalent to never calling setSave for every
 * title with a battery; see tools/gba_room_protocol_test.mjs 'blank'), or nothing at all for a title with no battery.
 */
export const TITLES = Object.freeze({
  'Super Bust-A-Move': Object.freeze({ file: 'Super Bust-A-Move (U).gba', romMd5: '00b3169c025d8000f8944e2e8b81c2b5', romBytes: 4194304, saveTag: 'none', saveType: 'none', saveBytes: 0, rtc: false,
    blank: 'no battery: the cartridge carries no save-library string (core.info.saveTag "none") and never touches save memory, and mGBA accepts a setSave() of ANY size for it (nothing to check against) - so a seat contributes a 0-byte image, room.js enforces that size, and nobody calls setSave' }),
  'Kirby Nightmare in Dreamland': Object.freeze({ file: 'Kirby - Nightmare in Dream Land (U).gba', romMd5: '35ae64b0f27e60107c14ab956f6cdf70', romBytes: 8388608, saveTag: 'sram', saveType: 'sram', saveBytes: 0x8000, rtc: false,
    blank: '32 KiB of 0xFF (a never-saved SRAM chip)' }),
  'Sonic Advance 3': Object.freeze({ file: 'Sonic Advance 3 (U).gba', romMd5: 'e0533faf6aa36e3111669574f1c5df92', romBytes: 16777216, saveTag: 'flash512', saveType: 'flash512', saveBytes: 0x10000, rtc: false,
    blank: '64 KiB of 0xFF (an erased Flash 512 Kbit chip)' }),
  'Monster Rancher Advance 2': Object.freeze({ file: 'Monster Rancher Advance 2 (U).gba', romMd5: 'c92823ec801e976852b67ac3f10723a7', romBytes: 8388608, saveTag: 'sram', saveType: 'sram', saveBytes: 0x8000, rtc: false,
    blank: '32 KiB of 0xFF (not roomable: its link row is could-not-reach)' }),
  'Sim City 2000': Object.freeze({ file: 'Sim City 2000 (U).gba', romMd5: '139b7e51d2f49dffeede13e464bafeea', romBytes: 4194304, saveTag: 'eeprom', saveType: null, saveBytes: null, rtc: false,
    blank: 'unresolved: EEPROM is 512 B or 8 KiB and mGBA decides at the game\'s first access (forcing either differs from auto, measured); not roomable, so never needed' }),
  'Pokemon SoulGold': Object.freeze({ file: 'Pokemon SoulGold (v1.1.1).gba', romMd5: 'b2c5caf9bc6dd28a44052427ee3ab1b7', romBytes: 33554432, saveTag: 'flash1m', saveType: 'flash1m', saveBytes: 0x20000, rtc: true,
    blank: '128 KiB of 0xFF (an erased Flash 1 Mbit chip); the only title with an RTC, so the room clock pin is load-bearing (not roomable yet: Cable Club not run)' }),
  'PKMN Ultra Violet': Object.freeze({ file: 'pokemonUltraViolet.gba', romMd5: '48f5c9500f409dd2e14e297e81aa764c', romBytes: 16777216, saveTag: 'flash1m', saveType: 'flash1m', saveBytes: 0x20000, rtc: false,
    blank: '128 KiB of 0xFF (not roomable yet: no link row)' }),
});

/**
 * The G1 link results, verbatim from tools/gba_link_smoke.mjs TITLES (id, rom file, seats, recorded outcome). The test diffs this list against
 * that file, so it cannot be edited into saying more than the rig measured. A title is ROOMABLE only if it has at least one row whose
 * outcome is 'linked'.
 */
export const LINK_ROWS = Object.freeze([
  Object.freeze({ id: 'sbam-2p', rom: 'Super Bust-A-Move (U).gba', seats: 2, outcome: 'linked' }),
  Object.freeze({ id: 'kirby-2p', rom: 'Kirby - Nightmare in Dream Land (U).gba', seats: 2, outcome: 'linked' }),
  Object.freeze({ id: 'kirby-3p', rom: 'Kirby - Nightmare in Dream Land (U).gba', seats: 3, outcome: 'linked' }),
  Object.freeze({ id: 'kirby-4p', rom: 'Kirby - Nightmare in Dream Land (U).gba', seats: 4, outcome: 'linked' }),
  Object.freeze({ id: 'sa3-2p', rom: 'Sonic Advance 3 (U).gba', seats: 2, outcome: 'linked' }),
  Object.freeze({ id: 'mra2-2p', rom: 'Monster Rancher Advance 2 (U).gba', seats: 2, outcome: 'could-not-reach' }),
]);

/** Pure: the catalogue of titles that have a passing row, with the seat counts that passed. Exported so the test can feed it mutated rows. */
export function deriveRoomable(rows, titles) {
  const out = {};
  for (const key of Object.keys(titles)) {
    const t = titles[key];
    const linked = rows.filter((r) => r.rom === t.file && r.outcome === 'linked');
    if (!linked.length) continue;
    if (t.saveType === null) continue;                       // no battery contract, no room
    const counts = [...new Set(linked.map((r) => r.seats))].sort((a, b) => a - b);
    out[key] = Object.freeze({ counts: Object.freeze(counts), min: counts[0], max: counts[counts.length - 1], rows: Object.freeze(linked.map((r) => r.id)) });
  }
  return out;
}
export const ROOMABLE = Object.freeze(deriveRoomable(LINK_ROWS, TITLES));

// A game name arrives from a peer's config. `TITLES['constructor']` is Object, `TITLES['__proto__']` is Object.prototype and
// `TITLES['toString']` is a function - all truthy - so every lookup by a name that is not ours goes through an OWN-property check.
const own = (o, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);
const titleOf = (game) => (own(TITLES, game) ? TITLES[game] : null);
const roomableOf = (game) => (own(ROOMABLE, game) ? ROOMABLE[game] : null);

/** Why a title is not in ROOMABLE (the sentence a lobby shows). null when it is roomable. */
export function whyNotRoomable(game) {
  const t = titleOf(game);
  if (!t) return 'unknown title "' + String(game).slice(0, 64) + '"';
  if (roomableOf(game)) return null;
  const rows = LINK_ROWS.filter((r) => r.rom === t.file);
  if (rows.length) return game + ' has no passing link row (' + rows.map((r) => r.id + ' = ' + r.outcome).join(', ') + ')';
  return game + ' has no link row at all: nobody has shown it reaching a linked state';
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 3. seat rules and the lobby predicate
// ---------------------------------------------------------------------------------------------------------------------------------
/** Seat counts that PASSED for the title; seat 0 is the host and the SIO master (the bridge gives seat i wire id i). */
export function seatRules(game) {
  const r = roomableOf(game);
  if (!r) fail('ROOM_NOT_ROOMABLE', whyNotRoomable(game) || 'not roomable', { field: 'game', game: String(game).slice(0, 64) });
  return { game, min: r.min, max: r.max, counts: r.counts.slice(), hostSeat: 0, masterSeat: 0 };
}
const listCounts = (c) => (c.length === 1 ? c[0] + ' players' : c.slice(0, -1).join(', ') + ' or ' + c[c.length - 1] + ' players');

/**
 * Is this roster something the room may start on? `roster` = lib/netplay.js `ls.roster` (port -> peer id | null). The occupied seats must be
 * exactly 0..N-1 (the bridge makes N cores with wire ids 0..N-1: a hole would be a phantom player), N must be a seat count that passed, the
 * host must hold seat 0, and a machine may hold only one seat.
 */
export function checkRoster(game, roster, opts) {
  const o = opts || {};
  const rules = seatRules(game);
  const occ = [];
  for (let p = 0; p < roster.length; p++) if (roster[p] != null) occ.push(p);
  const n = occ.length;
  for (let i = 0; i < n; i++) if (occ[i] !== i) fail('SEATS_GAP', 'seat ' + (i + 1) + ' is empty while seat ' + (occ[i] + 1) + ' is taken - the cable needs players in seats 1..' + n + ' with no gap', { field: 'seats', occupied: occ });
  if (new Set(occ.map((p) => roster[p])).size !== n) fail('SEATS_MULTI', 'one machine holds more than one seat - a GBA room is one player per machine', { field: 'seats', occupied: occ });
  if (rules.counts.indexOf(n) < 0) fail('SEATS_RANGE', game + ' has been shown linking for ' + listCounts(rules.counts) + '; this room has ' + n, { field: 'seats', seats: n, allowed: rules.counts.slice() });
  if (o.hostPeer != null && roster[0] !== o.hostPeer) fail('SEATS_HOST', 'the host must hold seat 1 (the link master)', { field: 'seats' });
  return { ok: true, seats: n, localSeat: o.me != null ? roster.indexOf(o.me) : -1 };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 4. room config, canonical encoding, the DISC STRING
// ---------------------------------------------------------------------------------------------------------------------------------
const CONFIG_KEYS = ['v', 'game', 'romMd5', 'coreBuildMd5', 'seats', 'fixedEpochMs', 'tzOffsetMin', 'saveTypes', 'inputDelay', 'roomId', 'players'];

/** Validate (and freeze a copy of) a config. Throws RoomError with the machine code of the FIRST thing wrong. */
export function validateConfig(cfg) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) fail('ROOM_ENCODING', 'the room config is not an object', { field: 'config' });
  if (cfg.v !== PROTOCOL_VERSION) fail('ROOM_VERSION', 'the room speaks protocol ' + cfg.v + ' and this page speaks ' + PROTOCOL_VERSION + ' - one of you has an out-of-date page; reload it', { field: 'version', mine: PROTOCOL_VERSION, theirs: cfg.v });
  const t = titleOf(cfg.game);
  if (!t) fail('ROOM_GAME', 'unknown game "' + String(cfg.game).slice(0, 64) + '"', { field: 'game' });
  if (!roomableOf(cfg.game)) fail('ROOM_NOT_ROOMABLE', whyNotRoomable(cfg.game), { field: 'game' });
  if (!isHex(cfg.romMd5, 32)) fail('ROOM_ROM', 'romMd5 is not 32 lowercase hex digits', { field: 'rom' });
  if (cfg.romMd5 !== t.romMd5) fail('ROOM_ROM', 'the room names ROM ' + cfg.romMd5 + ' but ' + cfg.game + ' on this site is ' + t.romMd5, { field: 'rom', mine: t.romMd5, theirs: cfg.romMd5 });
  if (!isHex(cfg.coreBuildMd5, 32)) fail('ROOM_CORE', 'coreBuildMd5 is not 32 lowercase hex digits', { field: 'core' });
  if (!isInt(cfg.seats) || roomableOf(cfg.game).counts.indexOf(cfg.seats) < 0) fail('ROOM_SEATS', cfg.game + ' has been shown linking for ' + listCounts(roomableOf(cfg.game).counts) + ', not ' + cfg.seats, { field: 'seats', seats: cfg.seats });
  if (!isInt(cfg.fixedEpochMs) || Math.abs(cfg.fixedEpochMs) > 9e15) fail('ROOM_CLOCK', 'fixedEpochMs must be a whole number of milliseconds (|ms| <= 9e15)', { field: 'clock' });
  if (!isInt(cfg.tzOffsetMin) || Math.abs(cfg.tzOffsetMin) > 1440) fail('ROOM_CLOCK', 'tzOffsetMin must be a whole number of minutes east of UTC (|min| <= 1440)', { field: 'clock' });
  if (!Array.isArray(cfg.saveTypes) || cfg.saveTypes.length !== cfg.seats || cfg.saveTypes.some((s) => s !== t.saveType)) fail('ROOM_SAVETYPE', 'every seat of ' + cfg.game + ' must use save type "' + t.saveType + '", got ' + JSON.stringify(cfg.saveTypes), { field: 'saveType' });
  if (!isInt(cfg.inputDelay) || cfg.inputDelay < DELAY_MIN || cfg.inputDelay > DELAY_MAX) fail('ROOM_DELAY', 'inputDelay must be a whole number of frames in ' + DELAY_MIN + '..' + DELAY_MAX, { field: 'inputDelay' });
  if (!isHex(cfg.roomId, 16)) fail('ROOM_ID', 'roomId must be 16 lowercase hex digits', { field: 'room' });
  if (!Array.isArray(cfg.players) || cfg.players.length !== cfg.seats || cfg.players.some((s) => typeof s !== 'string' || s.length > 32)) fail('ROOM_ENCODING', 'players must be one string (<= 32 chars) per seat', { field: 'players' });
  return Object.freeze(Object.assign({}, cfg, { saveTypes: Object.freeze(cfg.saveTypes.slice()), players: Object.freeze(cfg.players.slice()) }));
}

/** Build a validated config. Defaults: the title's ROM md5 and save type, tz 0, delay 3, blank player labels. `roomId` and `coreBuildMd5` have no default. */
export function makeConfig(o) {
  const t = titleOf(o && o.game);
  if (!t) fail('ROOM_GAME', 'unknown game "' + String(o && o.game).slice(0, 64) + '"', { field: 'game' });
  const seats = o.seats;
  return validateConfig({
    v: PROTOCOL_VERSION, game: o.game, romMd5: o.romMd5 === undefined ? t.romMd5 : o.romMd5, coreBuildMd5: o.coreBuildMd5, seats,
    fixedEpochMs: o.fixedEpochMs, tzOffsetMin: o.tzOffsetMin === undefined ? 0 : o.tzOffsetMin,
    saveTypes: o.saveTypes === undefined ? new Array(isInt(seats) && seats > 0 ? seats : 0).fill(t.saveType) : o.saveTypes,
    inputDelay: o.inputDelay === undefined ? DELAY_DEFAULT : o.inputDelay, roomId: o.roomId,
    players: o.players === undefined ? new Array(isInt(seats) && seats > 0 ? seats : 0).fill('') : o.players,
  });
}

/** The ONE canonical text of a config: fixed key order, no whitespace. decodeConfig(encodeConfig(c)) deep-equals c. */
export function encodeConfig(cfg) {
  const c = validateConfig(cfg), o = {};
  for (const k of CONFIG_KEYS) o[k] = c[k];
  return JSON.stringify(o);
}
/** Strict inverse: unknown keys, reordered keys, extra whitespace or a failed validation are ROOM_ENCODING / the validation's own code. */
export function decodeConfig(text) {
  let o;
  try { o = JSON.parse(text); } catch (e) { fail('ROOM_ENCODING', 'the room config is not valid JSON', { field: 'config' }); }
  const c = validateConfig(o);
  if (encodeConfig(c) !== text) fail('ROOM_ENCODING', 'the room config is not in canonical form (unknown, missing or reordered fields)', { field: 'config' });
  return c;
}

const DISC_FIELDS = ['g', 'rom', 'core', 'n', 'clk', 'st', 'room', 'sav'];
/**
 * THE STRING THE LOCKSTEP BARRIER COMPARES (ls.declareReady(disc)). Folds every field that must match for two machines to compute the same
 * thing: protocol tag, game, ROM md5, core build md5, seat count, pinned clock, save type per seat, room id, and the agreed save-set
 * fingerprint (Lockstep.cardSetHash, which omits `enc` - so the clock and save types MUST be here, not left to it).
 * NOT folded, on purpose: inputDelay (the host retunes it mid-room) and players (a returning page has a new peer id).
 */
export function discString(cfg, setHash) {
  const c = validateConfig(cfg);
  return [PROTOCOL_TAG, 'g=' + encodeURIComponent(c.game), 'rom=' + c.romMd5, 'core=' + c.coreBuildMd5, 'n=' + c.seats,
    'clk=' + c.fixedEpochMs + '@' + c.tzOffsetMin, 'st=' + c.saveTypes.join(','), 'room=' + c.roomId, 'sav=' + (setHash || '-')].join('|');
}
/** Parse a disc string back into its fields (null when it is not a gba disc at all). */
export function parseDisc(s) {
  if (typeof s !== 'string') return null;
  const parts = s.split('|');
  if (!/^gba\d+$/.test(parts[0])) return null;
  const out = Object.create(null);                       // a peer chooses the keys: no prototype to pollute or shadow
  out.tag = parts[0];
  for (const p of parts.slice(1)) { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i)] = p.slice(i + 1); }
  return out;
}
/** The field names of a disc string in the order they appear (after the tag); a part with no `name=` reads as ''. */
const discFieldNames = (s) => s.split('|').slice(1).map((p) => { const i = p.indexOf('='); return i > 0 ? p.slice(0, i) : ''; });
const clip = (s, n) => { s = String(s); return s.length > n ? s.slice(0, n) + '...' : s; };
const SENTENCE = {
  ROOM_VERSION: (m, t) => 'different room protocol: you speak ' + m + ' and they speak ' + t + ' - one of you has an out-of-date page; reload it',
  ROOM_GAME: (m, t) => 'different game: you loaded "' + m + '" and they loaded "' + t + '"',
  ROOM_ROM: (m, t) => 'different ROM file: yours is ' + m + ' and theirs is ' + t + ' - every player must run the identical game file',
  ROOM_CORE: (m, t) => 'different emulator build: yours is ' + m + ' and theirs is ' + t + ' - one of you has a cached or out-of-date page; reload it',
  ROOM_SEATS: (m, t) => 'different number of players: you set up ' + m + ' and they set up ' + t,
  ROOM_CLOCK: (m, t) => 'different cartridge clock: yours is ' + m + ' and theirs is ' + t + ' - games that read the clock would run differently',
  ROOM_SAVETYPE: (m, t) => 'different save type: yours is ' + m + ' and theirs is ' + t,
  ROOM_ID: (m, t) => 'different room: yours is ' + m + ' and theirs is ' + t,
  ROOM_SAVESET: (m, t) => 'the players hold different save files for this room: yours fingerprint ' + m + ' and theirs ' + t,
};
const DISC_FIELD_META = [['g', 'ROOM_GAME', 'game'], ['rom', 'ROOM_ROM', 'rom'], ['core', 'ROOM_CORE', 'core'], ['n', 'ROOM_SEATS', 'seats'], ['clk', 'ROOM_CLOCK', 'clock'],
  ['st', 'ROOM_SAVETYPE', 'saveType'], ['room', 'ROOM_ID', 'room'], ['sav', 'ROOM_SAVESET', 'saves']];
/**
 * Every way two disc strings differ, BY NAME: [{ code, field, mine, theirs, message }]. [] ONLY when the strings are identical. A protocol-tag
 * mismatch stops the comparison. Two strings that differ in something that is not one of the known fields - a field this page does not know,
 * the same fields in another order, a repeated field, text that is not `name=value` - are NAMED too (ROOM_ENCODING, field 'disc'): a barrier
 * refusal always carries an explanation. `message` quotes the peer's text (clipped); a page must show it as text, never as HTML.
 */
export function compareDisc(mine, theirs) {
  if (mine === theirs) return [];
  const a = parseDisc(mine), b = parseDisc(theirs);
  if (!a || !b) return [{ code: 'ROOM_GAME', field: 'game', mine: String(mine), theirs: String(theirs), message: 'the other player is not on a GBA room (' + clip(theirs, 80) + ')' }];
  if (a.tag !== b.tag) return [{ code: 'ROOM_VERSION', field: 'version', mine: a.tag, theirs: b.tag, message: SENTENCE.ROOM_VERSION(a.tag, b.tag) }];
  const out = [];
  for (const [k, code, field] of DISC_FIELD_META) {
    if (a[k] !== b[k]) out.push({ code, field, mine: a[k], theirs: b[k], message: SENTENCE[code](a[k], b[k]) });
  }
  const fm = discFieldNames(mine), ft = discFieldNames(theirs), why = [];
  const strange = (names) => names.filter((n, i) => n === '' || DISC_FIELDS.indexOf(n) < 0 || names.indexOf(n) !== i);
  const sm = strange(fm), st = strange(ft);
  if (st.length) why.push('they send ' + (st.length > 1 ? 'fields' : 'a field') + ' this page cannot read: ' + st.map((n) => '"' + clip(n, 24) + '"').join(', '));
  if (sm.length) why.push('this page sends ' + (sm.length > 1 ? 'fields' : 'a field') + ' they cannot read: ' + sm.map((n) => '"' + clip(n, 24) + '"').join(', '));
  const kn = (names) => names.filter((n) => DISC_FIELDS.indexOf(n) >= 0).join();
  if (!why.length && kn(fm) !== kn(ft)) why.push('the same fields arrive in a different order (yours ' + kn(fm) + '; theirs ' + kn(ft) + ')');
  if (why.length || !out.length) {
    out.push({ code: 'ROOM_ENCODING', field: 'disc', mine: String(mine), theirs: String(theirs),
      message: 'the two room descriptions differ in how they are written, not in a setting: ' + (why.length ? why.join('; ') : 'the strings are not identical but every field this page knows is equal') + ' - one of you has a different version of the page; reload it' });
  }
  return out;
}
/** For the barrier-failed event ({ expected, discs: { peer: disc } }): who differs and how, by name. [{ peer, mismatches: [...] }] */
export function explainBarrierFailure(mineDisc, discs) {
  const out = [];
  for (const peer of Object.keys(discs || {})) { const m = compareDisc(mineDisc, discs[peer]); if (m.length) out.push({ peer, mismatches: m }); }
  return out;
}
/** What THIS machine actually loaded versus what the room's config says (the check that runs before the barrier). Returns [] or the mismatches. */
export function checkLocalAgainstConfig(cfg, local) {
  const out = [], c = validateConfig(cfg);
  const add = (code, field, mine, theirs) => out.push({ code, field, mine, theirs, message: SENTENCE[code](mine, theirs) });
  if (local.game !== undefined && local.game !== c.game) add('ROOM_GAME', 'game', local.game, c.game);
  if (local.romMd5 !== undefined && local.romMd5 !== c.romMd5) add('ROOM_ROM', 'rom', local.romMd5, c.romMd5);
  if (local.coreBuildMd5 !== undefined && local.coreBuildMd5 !== c.coreBuildMd5) add('ROOM_CORE', 'core', local.coreBuildMd5, c.coreBuildMd5);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 5. save images: the per-title contract, the codec, the envelope, verification
// ---------------------------------------------------------------------------------------------------------------------------------
export function saveSpec(game) {
  const t = titleOf(game);
  if (!t) fail('ROOM_GAME', 'unknown game "' + String(game).slice(0, 64) + '"', { field: 'game' });
  if (t.saveType === null) fail('SAVE_WRONG_TYPE', game + ' has no resolved battery type (its EEPROM size is decided by the game at runtime)', { field: 'saveType' });
  return { type: t.saveType, bytes: t.saveBytes, code: SAVE_TYPES[t.saveType].code, tag: t.saveTag };
}
/** The blank battery a peer with no stored save contributes for its seat: 0xFF x saveBytes (empty for a title with no battery). */
export function blankSave(game) { return new Uint8Array(saveSpec(game).bytes).fill(0xFF); }
/** Is this stored image acceptable for the title? { ok, why }. A title with no battery accepts only null / empty. */
export function checkStoredImage(game, bytes) {
  const s = saveSpec(game), n = bytes ? toU8(bytes).length : 0;
  if (n !== s.bytes) return { ok: false, why: 'the stored save is ' + n + ' bytes and ' + game + ' keeps ' + s.bytes };
  return { ok: true, why: null };
}
/**
 * What this peer puts into the room for ITS seat. A stored image of the right size is contributed as is; none -> the blank chip; a stored image
 * of the WRONG size is NOT contributed and NOT overwritten (`source: 'rejected-stored'` makes planCommit refuse to write the seat back).
 */
export function chooseContribution(game, stored) {
  const spec = saveSpec(game);
  if (stored == null || toU8(stored).length === 0) {
    if (spec.bytes === 0) return { raw: new Uint8Array(0), source: 'none', warn: null };
    return { raw: blankSave(game), source: 'blank', warn: null };
  }
  const s = toU8(stored), chk = checkStoredImage(game, s);
  if (chk.ok) return { raw: s.slice(), source: 'stored', warn: null };
  return { raw: blankSave(game), source: 'rejected-stored', warn: chk.why + ' - contributing a blank save for this room and leaving the stored one untouched' };
}

/** Compression, injected so this module owns no environment: gzip through CompressionStream when the host has it, raw otherwise. */
export const webCodec = {
  available() { return typeof CompressionStream === 'function' && typeof DecompressionStream === 'function'; },
  async deflate(u8) {
    const cs = new CompressionStream('gzip'), w = cs.writable.getWriter();
    const writing = w.write(u8).then(() => w.close());
    const parts = [], r = cs.readable.getReader();
    for (;;) { const x = await r.read(); if (x.done) break; parts.push(x.value); }
    await writing;
    return concat(parts);
  },
  /** Inflate with a hard output cap: stops READING (and cancels) the moment more than `max` bytes come out, so a bomb never allocates. */
  async inflate(u8, max) {
    const ds = new DecompressionStream('gzip'), w = ds.writable.getWriter();
    const writing = w.write(u8).then(() => w.close()).catch(() => {});
    const parts = [], r = ds.readable.getReader();
    let total = 0;
    try {
      for (;;) {
        const x = await r.read(); if (x.done) break;
        total += x.value.length;
        if (total > max) { await r.cancel().catch(() => {}); fail('SAVE_BAD_SIZE', 'the save inflates past its ' + max + ' byte limit', { field: 'saveSize', max }); }
        parts.push(x.value);
      }
    } catch (e) {
      if (e instanceof RoomError) throw e;
      fail('SAVE_INFLATE', 'the save could not be decompressed: ' + ((e && e.message) || e), { field: 'saveEncoding' });
    }
    await writing;
    return concat(parts);
  },
};
function concat(parts) { let n = 0; for (const p of parts) n += p.length; const out = new Uint8Array(n); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; }

const MAGIC = [0x47, 0x42, 0x53, PROTOCOL_VERSION + 0x30];       // "GBS1"
const HDR = 28;
const CFG_MAX = 4096;      // bytes of room config an envelope may carry (the largest valid config is about 1.3 KiB; tools/gba_room_protocol_test.mjs computes it)
/**
 * The largest envelope an HONEST peer can produce for a chip whose battery cap is `cap`: header + config + one 4-byte hash per wire piece +
 * a payload that is never larger than the raw image (makeSaveEntry only keeps the gzip form when it is smaller). Anything longer is refused
 * SAVE_TOO_BIG before it is parsed or hashed. ⚠ This bounds THIS module's work, not the engine's memory: lib/netplay.js reassembles a card
 * (`_cardTake`) from the announced piece count and length with no cap of its own, before any page code sees the bytes - see ROOM_CARD_LIMITS.
 */
export function maxEnvelopeBytes(cap) { return HDR + CFG_MAX + 4 * Math.ceil(cap / WIRE_CHUNK) + cap; }
/** What a transport-level guard (lib/netplay.js, or a page hooking a raw room message) can enforce BEFORE assembling a card; room.js enforces the same numbers after. */
export const ROOM_CARD_LIMITS = Object.freeze({ maxCardBytes: maxEnvelopeBytes(SAVE_CAPS.flash), maxPieces: Math.ceil(maxEnvelopeBytes(SAVE_CAPS.flash) / WIRE_CHUNK), maxCards: MAX_SEATS });
const CODEC_RAW = 0, CODEC_GZIP = 1;
const ENC = { [CODEC_RAW]: PROTOCOL_TAG + ';raw', [CODEC_GZIP]: PROTOCOL_TAG + ';gzip' };
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const put32 = (b, o, v) => { b[o] = v & 255; b[o + 1] = (v >>> 8) & 255; b[o + 2] = (v >>> 16) & 255; b[o + 3] = (v >>> 24) & 255; };
const utf8 = typeof TextEncoder === 'function' ? new TextEncoder() : null;
const utf8d = typeof TextDecoder === 'function' ? new TextDecoder('utf-8', { fatal: true }) : null;

/**
 * Wrap one seat's image into a lib/netplay.js `contributeCards` entry { port, size, hash, enc, bytes }.
 *   size = RAW length, hash = Lockstep.cardHash(raw) (the engine fingerprints exactly these), enc = 'gba1;gzip' | 'gba1;raw',
 *   bytes = the ENVELOPE (header + per-chunk FNV hashes of the compressed payload + the payload), chunked by the engine at WIRE_CHUNK.
 * The HOST passes `config` and it rides in the envelope of seat 0, so every joiner learns the clock, room id and seat count through the same
 * verified path (readRoomConfig) instead of a second transport.
 */
export async function makeSaveEntry({ game, seat, raw, config, codec }) {
  const spec = saveSpec(game), r = toU8(raw);
  if (!isInt(seat) || seat < 0 || seat >= MAX_SEATS) fail('SAVE_SEAT_RANGE', 'seat ' + seat + ' is outside 0..' + (MAX_SEATS - 1), { field: 'seat', seat });
  if (r.length > SAVE_CAPS[SAVE_TYPES[spec.type].cap]) fail('SAVE_TOO_BIG', 'a ' + r.length + ' byte save is over the ' + SAVE_CAPS[SAVE_TYPES[spec.type].cap] + ' byte limit for ' + spec.type, { field: 'saveSize', seat });
  if (r.length !== spec.bytes) fail('SAVE_BAD_SIZE', 'seat ' + (seat + 1) + ': a ' + r.length + ' byte save cannot be a ' + spec.type + ' battery (' + spec.bytes + ' bytes)', { field: 'saveSize', seat });
  const cd = codec === undefined ? webCodec : codec;
  let id = CODEC_RAW, payload = r;
  if (cd && r.length && cd.available()) { const z = await cd.deflate(r); if (z.length < r.length) { id = CODEC_GZIP; payload = z; } }
  const cfgBytes = config ? utf8.encode(encodeConfig(config)) : new Uint8Array(0);
  if (cfgBytes.length > CFG_MAX) fail('SAVE_ENVELOPE', 'the room config does not fit the envelope', { field: 'config' });
  const n = payload.length ? Math.ceil(payload.length / WIRE_CHUNK) : 0;
  const env = new Uint8Array(HDR + cfgBytes.length + 4 * n + payload.length);
  env.set(MAGIC, 0); env[4] = seat; env[5] = spec.code; env[6] = id; env[7] = cfgBytes.length ? 1 : 0;
  put32(env, 8, r.length); put32(env, 12, payload.length); put32(env, 16, WIRE_CHUNK); put32(env, 20, fnv1a(r));
  env[24] = n & 255; env[25] = (n >>> 8) & 255; env[26] = cfgBytes.length & 255; env[27] = (cfgBytes.length >>> 8) & 255;
  env.set(cfgBytes, HDR);
  const hOff = HDR + cfgBytes.length, pOff = hOff + 4 * n;
  for (let i = 0; i < n; i++) put32(env, hOff + 4 * i, fnv1a(payload.subarray(i * WIRE_CHUNK, Math.min(payload.length, (i + 1) * WIRE_CHUNK))));
  env.set(payload, pOff);
  return { port: seat, size: r.length, hash: cardHash(r), enc: ENC[id], bytes: env };
}

/** Parse an envelope's HEADER and tables (no inflate). Throws SAVE_ENVELOPE on anything malformed. */
export function parseSaveEnvelope(bytes) {
  const b = toU8(bytes);
  if (b.length < HDR) fail('SAVE_ENVELOPE', 'the save envelope is ' + b.length + ' bytes, shorter than its ' + HDR + ' byte header', { field: 'saveEnvelope' });
  // "GBS" + a different version digit is a peer on another protocol version: name it as such (the config's own version check would say so
  // too, but the envelope is parsed first).
  if (b[0] === MAGIC[0] && b[1] === MAGIC[1] && b[2] === MAGIC[2] && b[3] >= 0x30 && b[3] <= 0x39 && b[3] !== MAGIC[3]) fail('ROOM_VERSION', 'the room speaks protocol ' + (b[3] - 0x30) + ' and this page speaks ' + PROTOCOL_VERSION + ' - one of you has an out-of-date page; reload it', { field: 'version', mine: PROTOCOL_VERSION, theirs: b[3] - 0x30 });
  for (let i = 0; i < 4; i++) if (b[i] !== MAGIC[i]) fail('SAVE_ENVELOPE', 'the save envelope does not start with "GBS' + PROTOCOL_VERSION + '" (wrong protocol version or not a room save)', { field: 'saveEnvelope' });
  const e = { seat: b[4], saveTypeCode: b[5], codec: b[6], flags: b[7], rawSize: u32(b, 8), payloadSize: u32(b, 12), chunkSize: u32(b, 16), imageHash: u32(b, 20), chunkCount: b[24] | (b[25] << 8), cfgLen: b[26] | (b[27] << 8) };
  if (e.codec !== CODEC_RAW && e.codec !== CODEC_GZIP) fail('SAVE_ENC', 'unknown save codec ' + e.codec, { field: 'saveEncoding' });
  if (e.chunkSize !== WIRE_CHUNK) fail('SAVE_ENVELOPE', 'chunk size ' + e.chunkSize + ' is not the ' + WIRE_CHUNK + ' byte wire piece', { field: 'saveEnvelope' });
  if (e.rawSize > SAVE_CAPS.flash || e.payloadSize > SAVE_CAPS.flash + 1024) fail('SAVE_TOO_BIG', 'the save claims ' + e.rawSize + ' bytes (' + e.payloadSize + ' on the wire); the limit is ' + SAVE_CAPS.flash, { field: 'saveSize' });
  if (e.chunkCount !== (e.payloadSize ? Math.ceil(e.payloadSize / WIRE_CHUNK) : 0)) fail('SAVE_ENVELOPE', 'the save envelope lists ' + e.chunkCount + ' chunks for ' + e.payloadSize + ' payload bytes', { field: 'saveEnvelope' });
  if (b.length !== HDR + e.cfgLen + 4 * e.chunkCount + e.payloadSize) fail('SAVE_ENVELOPE', 'the save envelope is ' + b.length + ' bytes but its header accounts for ' + (HDR + e.cfgLen + 4 * e.chunkCount + e.payloadSize), { field: 'saveEnvelope' });
  e.cfgText = null;
  if (e.cfgLen) {
    try { e.cfgText = utf8d.decode(b.subarray(HDR, HDR + e.cfgLen)); } catch (x) { fail('SAVE_ENVELOPE', 'the embedded room config is not UTF-8', { field: 'config' }); }
  }
  const hOff = HDR + e.cfgLen;
  e.chunkHashes = [];
  for (let i = 0; i < e.chunkCount; i++) e.chunkHashes.push(u32(b, hOff + 4 * i));
  e.payload = b.subarray(hOff + 4 * e.chunkCount);
  return e;
}

/** Verify ONE contributed entry against the room config. Resolves { seat, raw, hash, saveType, codec } or throws a RoomError naming the problem. */
export async function verifySaveEntry({ config, port, entry, codec }) {
  const cfg = validateConfig(config);
  if (!isInt(port) || port < 0 || port >= cfg.seats) fail('SAVE_SEAT_RANGE', 'port ' + port + ' is outside this room\'s ' + cfg.seats + ' seats', { field: 'seat', seat: port });
  if (!entry || !(entry.bytes instanceof Uint8Array) || typeof entry.hash !== 'string' || typeof entry.enc !== 'string') fail('SAVE_ENVELOPE', 'seat ' + (port + 1) + ': the entry is not { size, hash, enc, bytes }', { field: 'saveEnvelope', seat: port });
  const who = 'seat ' + (port + 1);
  // The ABSOLUTE bound comes first (it protects the parse and the hashes from a giant buffer). The per-chip size and type are judged after the
  // parse, so a flash image sent into an SRAM room is named for what it is (SAVE_WRONG_TYPE) rather than only as large.
  const bound = ROOM_CARD_LIMITS.maxCardBytes;
  if (entry.bytes.length > bound) fail('SAVE_TOO_BIG', who + '\'s save arrived as ' + entry.bytes.length + ' bytes; no honest save is over ' + bound, { field: 'saveSize', seat: port, got: entry.bytes.length, max: bound });
  const env = parseSaveEnvelope(entry.bytes);
  if (env.seat !== port) fail('SAVE_SEAT_CLAIM', who + '\'s save says it belongs to seat ' + (env.seat + 1), { field: 'seat', seat: port, claimed: env.seat });
  const typeName = SAVE_NAME_BY_CODE[env.saveTypeCode];
  if (typeName !== cfg.saveTypes[port]) fail('SAVE_WRONG_TYPE', who + '\'s save is a ' + (typeName || 'type ' + env.saveTypeCode) + ' battery and the room needs ' + cfg.saveTypes[port], { field: 'saveType', seat: port, got: typeName, want: cfg.saveTypes[port] });
  const chip = SAVE_TYPES[cfg.saveTypes[port]];
  if (env.rawSize > SAVE_CAPS[chip.cap]) fail('SAVE_TOO_BIG', who + '\'s save claims ' + env.rawSize + ' bytes; the limit for ' + cfg.saveTypes[port] + ' is ' + SAVE_CAPS[chip.cap], { field: 'saveSize', seat: port });
  if (chip.sizes.indexOf(env.rawSize) < 0) fail('SAVE_BAD_SIZE', who + '\'s save is ' + env.rawSize + ' bytes and a ' + cfg.saveTypes[port] + ' battery is ' + chip.sizes.join(' or '), { field: 'saveSize', seat: port, got: env.rawSize });
  if ((entry.size | 0) !== env.rawSize) fail('SAVE_BAD_SIZE', who + '\'s entry declares ' + entry.size + ' bytes and its envelope ' + env.rawSize, { field: 'saveSize', seat: port });
  if (entry.enc !== ENC[env.codec]) fail('SAVE_ENC', who + '\'s entry says "' + entry.enc + '" and its envelope says "' + ENC[env.codec] + '"', { field: 'saveEncoding', seat: port });
  for (let i = 0; i < env.chunkCount; i++) {
    const piece = env.payload.subarray(i * WIRE_CHUNK, Math.min(env.payload.length, (i + 1) * WIRE_CHUNK));
    if (fnv1a(piece) !== env.chunkHashes[i]) fail('SAVE_TAMPERED_CHUNK', who + '\'s save: chunk ' + (i + 1) + ' of ' + env.chunkCount + ' does not match its hash - it was corrupted or altered in transit', { field: 'saveChunk', seat: port, chunk: i, chunks: env.chunkCount });
  }
  let raw;
  if (env.codec === CODEC_RAW) raw = env.payload.slice();
  else {
    const cd = codec === undefined ? webCodec : codec;
    if (!cd || !cd.available()) fail('SAVE_ENC', 'this browser cannot read a gzip-compressed save', { field: 'saveEncoding', seat: port });
    raw = await cd.inflate(env.payload, env.rawSize);
  }
  if (raw.length !== env.rawSize) fail('SAVE_BAD_SIZE', who + '\'s save inflated to ' + raw.length + ' bytes and declared ' + env.rawSize, { field: 'saveSize', seat: port, got: raw.length });
  const h = cardHash(raw);
  if (h !== entry.hash || fnv1a(raw) !== env.imageHash) fail('SAVE_BAD_HASH', who + '\'s save fingerprints ' + h + ' and the room said ' + entry.hash, { field: 'saveHash', seat: port, got: h, want: entry.hash });
  return { seat: port, raw, hash: h, saveType: typeName, codec: env.codec };
}

/** The host's config out of a card set (seat 0's envelope). Throws SAVE_CFG_MISSING when absent. */
export function readRoomConfig(set) {
  const e = set && set[0];
  if (!e || !(e.bytes instanceof Uint8Array)) fail('SAVE_MISSING_SEAT', 'the room has no save for seat 1, so it carries no room config', { field: 'seat', seat: 0 });
  const env = parseSaveEnvelope(e.bytes);
  if (!env.cfgText) fail('SAVE_CFG_MISSING', 'seat 1 (the host) did not put the room config into its save envelope', { field: 'config' });
  return decodeConfig(env.cfgText);
}

/**
 * Verify the WHOLE agreed set (`ls.cards`, { port: { size, hash, enc, bytes } }) against the config: exactly seats 0..N-1, each seat claimed
 * once and by the right port, every entry valid. `engineSetHash` (ls.cardSetHash) is compared with the recomputed fingerprint when given.
 * Resolves { images: [Uint8Array x N], hashes: [8-hex x N], setHash, config }.
 */
export async function verifySaveSet({ config, set, engineSetHash, codec }) {
  const cfg = validateConfig(config);
  const ports = Object.keys(set || {}).map((p) => p | 0).sort((a, b) => a - b);
  for (const p of ports) if (p < 0 || p >= cfg.seats) fail('SAVE_SEAT_RANGE', 'the room holds a save for seat ' + (p + 1) + ' but has only ' + cfg.seats + ' seats', { field: 'seat', seat: p });
  for (let s = 0; s < cfg.seats; s++) if (!set || !set[s]) fail('SAVE_MISSING_SEAT', 'the room has no save for seat ' + (s + 1) + ' yet', { field: 'seat', seat: s });
  const claims = new Map();
  for (const p of ports) {
    const e = set[p];
    if (!e || !(e.bytes instanceof Uint8Array)) fail('SAVE_ENVELOPE', 'seat ' + (p + 1) + ': the entry carries no bytes', { field: 'saveEnvelope', seat: p });
    if (e.bytes.length > ROOM_CARD_LIMITS.maxCardBytes) fail('SAVE_TOO_BIG', 'seat ' + (p + 1) + '\'s save arrived as ' + e.bytes.length + ' bytes; no honest save is over ' + ROOM_CARD_LIMITS.maxCardBytes, { field: 'saveSize', seat: p, got: e.bytes.length, max: ROOM_CARD_LIMITS.maxCardBytes });
    const env = parseSaveEnvelope(e.bytes);
    if (claims.has(env.seat)) fail('SAVE_DUPLICATE_SEAT', 'seats ' + (claims.get(env.seat) + 1) + ' and ' + (p + 1) + ' both claim to hold seat ' + (env.seat + 1) + '\'s save', { field: 'seat', seat: env.seat, ports: [claims.get(env.seat), p] });
    claims.set(env.seat, p);
  }
  const images = [], hashes = [];
  for (let s = 0; s < cfg.seats; s++) {
    const v = await verifySaveEntry({ config: cfg, port: s, entry: set[s], codec });
    images.push(v.raw); hashes.push(v.hash);
  }
  const setHash = cardSetHash(set);
  if (engineSetHash != null && engineSetHash !== setHash) fail('ROOM_SAVESET', 'the engine fingerprints the card set ' + engineSetHash + ' and the entries recompute to ' + setHash, { field: 'saves', mine: setHash, theirs: engineSetHash });
  return { images, hashes, setHash, config: cfg };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 6. input words and the in-band END channel
// ---------------------------------------------------------------------------------------------------------------------------------
const KIND_IDLE = 0, KIND_WANT = 1, KIND_DIGEST = 2;
export const KIND = Object.freeze({ IDLE: KIND_IDLE, WANT: KIND_WANT, DIGEST: KIND_DIGEST });

/** keys (10 bits) + an optional control symbol { kind, pos, payload } -> one unsigned 32-bit input word. */
export function encodeWord(keys, sym) {
  let w = keys & KEY_MASK;
  if (sym) {
    if (sym.kind === KIND_WANT) w |= KIND_WANT << 30;
    else if (sym.kind === KIND_DIGEST) w |= (KIND_DIGEST << 30) | ((sym.pos & 3) << 26) | ((sym.payload & 0xFFFF) << 10);
  }
  return w >>> 0;
}
/** One input word -> { keys, kind, pos, payload, bad }. `bad` = reserved bits set, kind 3, or fields that must be zero are not; a bad symbol reads as IDLE. */
export function decodeWord(word) {
  const w = word >>> 0, keys = w & KEY_MASK, kind = w >>> 30, pos = (w >>> 26) & 3, payload = (w >>> 10) & 0xFFFF, resv = (w >>> 28) & 3;
  let bad = resv !== 0 || kind === 3;
  if ((kind === KIND_IDLE || kind === KIND_WANT) && (pos !== 0 || payload !== 0)) bad = true;
  if (bad) return { keys, kind: KIND_IDLE, pos: 0, payload: 0, bad: true };
  return { keys, kind, pos, payload, bad: false };
}
export function wordToBytes(word) { const b = new Uint8Array(PAD_BYTES); put32(b, 0, word >>> 0); return b; }
export function bytesToWord(u8, off) { const o = off | 0; return u32(u8, o); }
/** A plain pad (no control symbol) for a 10-bit key mask. */
export function padFromKeys(keys) { return wordToBytes(encodeWord(keys, null)); }

/** The 64-bit digest of the end-of-room state, as DIGEST_POSITIONS 16-bit payloads. Binds the room id, the agreed frame and every seat's image hash. */
export function endDigest(roomId, frame, imageHashes) {
  const text = roomId + '|' + frame + '|' + imageHashes.join(',');
  const a = fnvString(text), b = fnvString(text, 0x9747b28c);
  return [a >>> 16, a & 0xFFFF, b >>> 16, b & 0xFFFF];
}

export function endInit({ seats, hold, timeout }) {
  return {
    v: 1, n: seats, hold: hold === undefined ? END_HOLD_FRAMES : hold, timeout: timeout === undefined ? END_DIGEST_TIMEOUT : timeout,
    phase: 'run', streak: new Array(seats).fill(0), F: null, G: null, capture: null,
    got: Array.from({ length: seats }, () => new Array(DIGEST_POSITIONS).fill(null)), bad: 0, why: null,
  };
}
const endClone = (s) => Object.assign({}, s, { streak: s.streak.slice(), got: s.got.map((g) => g.slice()) });
function endUnclean(s, code, message, detail) { s.phase = 'unclean'; s.why = { code, message, detail: detail || {} }; return { state: s, event: { type: 'unclean', code, message, detail: detail || {} } }; }

/**
 * ONE APPLIED FRAME of the end handshake. `syms` = decodeWord() of every seat's input word in the image the engine handed out for frame `f`.
 * Pure and deterministic: every machine that applies the same frames reaches the same phase at the same frame. Returns { state, event } where
 * event is null | { type: 'agreed', frame } (capture NOW, after running frame `frame`) | { type: 'commit', frame, F } | { type: 'unclean', code, ... }.
 *   run     -> digest   when EVERY seat has shown WANT for `hold` consecutive frames; F = that frame
 *   digest  -> commit   when every seat's 4-position digest has arrived and equals this machine's own
 *           -> unclean  on a mismatch (END_MISMATCH), a seat contradicting itself (END_CONFLICT) or no completion within `timeout` frames (END_TIMEOUT)
 */
export function endStep(state, f, syms) {
  if (state.phase === 'commit' || state.phase === 'unclean') return { state, event: null };
  const s = endClone(state);
  for (const y of syms) if (y.bad) s.bad++;
  if (s.phase === 'run') {
    for (let i = 0; i < s.n; i++) s.streak[i] = syms[i].kind === KIND_WANT ? s.streak[i] + 1 : 0;
    if (s.streak.every((x) => x >= s.hold)) { s.phase = 'digest'; s.F = f; return { state: s, event: { type: 'agreed', frame: f } }; }
    return { state: s, event: null };
  }
  for (let i = 0; i < s.n; i++) {
    const y = syms[i];
    if (y.kind !== KIND_DIGEST) continue;
    const cur = s.got[i][y.pos];
    if (cur === null) s.got[i][y.pos] = y.payload;
    else if (cur !== y.payload) return endUnclean(s, 'END_CONFLICT', 'seat ' + (i + 1) + ' sent two different values for digest position ' + y.pos, { seat: i, pos: y.pos });
  }
  const complete = s.got.every((g) => g.every((x) => x !== null));
  if (complete && s.capture) {
    const wrong = [];
    for (let i = 0; i < s.n; i++) if (s.got[i].some((x, k) => x !== s.capture.digest[k])) wrong.push(i);
    if (wrong.length) return endUnclean(s, 'END_MISMATCH', 'the players do not agree on the saves at the end of the room (seat' + (wrong.length > 1 ? 's ' : ' ') + wrong.map((i) => i + 1).join(', ') + ' differ' + (wrong.length > 1 ? '' : 's') + ' from this machine)', { seats: wrong });
    s.phase = 'commit'; s.G = f;
    return { state: s, event: { type: 'commit', frame: f, F: s.F } };
  }
  if (f - s.F >= s.timeout) {
    const waiting = []; for (let i = 0; i < s.n; i++) if (s.got[i].some((x) => x === null)) waiting.push(i);
    return endUnclean(s, 'END_TIMEOUT', 'the room did not finish ending: ' + (s.capture ? 'seat' + (waiting.length > 1 ? 's ' : ' ') + waiting.map((i) => i + 1).join(', ') + ' never completed the handshake' : 'this machine never captured its saves'), { seats: waiting, captured: !!s.capture });
  }
  return { state: s, event: null };
}
/** After running the agreed frame: record this machine's own end-of-room hashes (one 8-hex per seat) and digest. */
export function endCapture(state, { roomId, frame, imageHashes }) {
  if (state.phase !== 'digest' || state.F !== frame || state.capture) return state;
  const s = endClone(state);
  s.capture = { frame, imageHashes: imageHashes.slice(), digest: endDigest(roomId, frame, imageHashes) };
  return s;
}
/**
 * The control symbol THIS machine's seat puts into the pad it samples for frame `sampleFrame` (= ls.frame at beginFrame). Idempotent per frame
 * number (the engine may retry a stalled frame, or fill skipped frames with the last pad). `journal` is non-null on every sample that carries the
 * LAST digest position (position 3): the page MUST persist it durably (idempotently) before using that pad - once that symbol is out, the other
 * machines can commit without ever hearing from this one again.
 */
export function endLocalCtl(state, sampleFrame, want) {
  if (state.phase === 'run') return { sym: want ? { kind: KIND_WANT } : null, journal: null };
  if (state.phase === 'digest') {
    if (!state.capture || sampleFrame <= state.F) return { sym: { kind: KIND_WANT }, journal: null };
    const k = (sampleFrame - state.F - 1) % DIGEST_POSITIONS;
    // EVERY sample that carries the last position needs the journal (not only the first): the engine may skip a sample frame, in which case the
    // first position-3 symbol that actually leaves is a later cycle's. Persisting the same record again is idempotent.
    const last = k === DIGEST_POSITIONS - 1;
    return { sym: { kind: KIND_DIGEST, pos: k, payload: state.capture.digest[k] }, journal: last ? { state: 'last-symbol', F: state.F, digest: state.capture.digest.slice() } : null };
  }
  return { sym: null, journal: null };
}
/** The storage key of the end-of-room journal: ONE record per game per browser (a machine is in one room at a time), found at page start before any room exists. */
export function journalKey(game) { return 'gba-room-journal:' + game; }
/**
 * What to do with a journal record found at page start (see the policy in gba/mgba/README.md "Rooms"):
 *   none / committed / aborted -> 'none'          staged      -> 'discard'   (no peer can commit without this page's last symbol)
 *   last-symbol                -> 'in-doubt'      committing  -> 'finish-commit' (the decision was reached; the write is idempotent)
 * 'in-doubt' is the irreducible two-generals window: the last symbol may or may not have reached the others. Never auto-apply, never auto-drop
 * (recoverPlan asks the player, unless applying would change nothing). The record kinds, in the order a room writes them:
 *   staged      room.js (RoomMachine.step, on the capture frame)   { room, seat, F, source, initialHash, imageHash }       no image: nothing to recover
 *   last-symbol room.js (RoomMachine.localPad, EVERY sample that carries digest position 3)  { ..., image, imageHash, digest }   the LOCAL seat's image
 *   committing  room.js (RoomMachine.commitPlan().journalBefore)    { ..., key, image, imageHash, previousHash, skip }    the LOCAL seat's image
 *   committed   room.js (commitPlan().journalAfter)                  { room, seat, F }     the room is over for this machine
 *   aborted     recoverPlan                                          { room, seat, F, why }
 */
export function endRecover(rec) {
  if (!rec || !rec.state) return { action: 'none' };
  switch (rec.state) {
    case 'staged': return { action: 'discard' };
    case 'last-symbol': return { action: 'in-doubt' };
    case 'committing': return { action: 'finish-commit' };
    default: return { action: 'none' };
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 7. persistence policy: what may be written, and only ever the LOCAL seat
// ---------------------------------------------------------------------------------------------------------------------------------
/**
 * The storage plan for a CLEAN end. Pure data: { writes: [{ key, bytes }], backups: [{ key, bytes }], skip }.
 *   - only `localSeat`'s final image is ever in `writes`; a peer's seat image is never persisted;
 *   - unless the end was clean (endState.phase === 'commit') nothing is written (COMMIT_NOT_CLEAN);
 *   - an unchanged image is not rewritten (skip: 'unchanged'); a stored save the room could not use (source 'rejected-stored') is never overwritten;
 *   - the previous stored image is kept under `<key>.pre-room` before it is replaced.
 */
export function planCommit({ endState, localSeat, finalImage, initialImage, key, previous, source }) {
  if (!endState || endState.phase !== 'commit') fail('COMMIT_NOT_CLEAN', 'the room did not end cleanly, so nothing is written', { field: 'commit', phase: endState && endState.phase });
  if (!isInt(localSeat) || localSeat < 0 || localSeat >= endState.n) fail('SAVE_SEAT_RANGE', 'local seat ' + localSeat + ' is outside this room', { field: 'seat' });
  if (source === 'rejected-stored') return { writes: [], backups: [], skip: 'stored-invalid' };
  const fin = toU8(finalImage), ini = toU8(initialImage);
  if (fin.length === 0) return { writes: [], backups: [], skip: 'no-battery' };
  if (eqBytes(fin, ini)) return { writes: [], backups: [], skip: 'unchanged' };
  const backups = previous && toU8(previous).length ? [{ key: key + '.pre-room', bytes: toU8(previous).slice() }] : [];
  return { writes: [{ key, bytes: fin.slice() }], backups, skip: null };
}

/**
 * The ORDERED storage operations of a commit - the unit a crash can fall between. Each op is assumed atomic on its own and NOTHING else is
 * (a page that has a transaction may run them in one; this module does not rely on it):
 *   1. journal 'committing'   the decision and the image to write are durable BEFORE anything else changes
 *   2. put <key>.pre-room     the previous image (only if there was one)
 *   3. put <key>              the final image of the LOCAL seat - the only value ever written under the player's key
 *   4. journal 'committed'    the room is over for this machine
 * A crash after any prefix is repaired by recoverPlan(): the 'committing' record is enough to finish the job and the finish never makes the
 * backup from a value it has already replaced.
 */
export function commitSteps(plan) {
  const steps = [{ op: 'journal', record: plan.journalBefore }];
  for (const b of plan.backups) steps.push({ op: 'put', key: b.key, bytes: b.bytes });
  for (const w of plan.writes) steps.push({ op: 'put', key: w.key, bytes: w.bytes });
  steps.push({ op: 'journal', record: plan.journalAfter });
  return steps;
}
/**
 * Execute storage steps through `io = { journal(record), put(key, bytes) }` (the page's IndexedDB; this module owns no storage). `limit` runs only
 * the first `limit` steps - how a test makes the machine die between two writes. Returns the number executed.
 */
export function runSteps(steps, io, limit) {
  const n = limit === undefined ? steps.length : Math.max(0, Math.min(steps.length, limit | 0));
  for (let i = 0; i < n; i++) {
    const s = steps[i];
    if (s.op === 'journal') io.journal(s.record);
    else if (s.op === 'put') io.put(s.key, s.bytes);
    else fail('COMMIT_BAD_STEP', 'unknown storage step "' + s.op + '"', { field: 'commit' });
  }
  return n;
}
const stepJournal = (record) => ({ op: 'journal', record });
const abortedRecord = (rec, why) => ({ state: 'aborted', room: rec.room, seat: rec.seat, F: rec.F, why });
/** Finish (or complete the in-doubt) commit of a 'committing' / 'last-symbol' record. Pure; see recoverPlan. */
function finishPlan(rec, key, stored, action) {
  const invalid = (why) => ({ action: 'journal-invalid', outcome: null, steps: [], why });
  let image;
  try { image = toU8(rec.image); } catch (e) { return invalid('the journal record carries no image'); }
  if (typeof key !== 'string' || !key) return invalid('no storage key was given');
  if (rec.key !== undefined && rec.key !== key) return invalid('the journal was written for key "' + rec.key + '", not "' + key + '"');
  if (!isHex(rec.imageHash, 8) || cardHash(image) !== rec.imageHash) return invalid('the journal image does not match its own hash');
  const committed = stepJournal({ state: 'committed', room: rec.room, seat: rec.seat, F: rec.F });
  const done = (outcome, steps) => ({ action, outcome, steps: steps.concat([committed]) });
  if (rec.skip || rec.source === 'rejected-stored') return done('skipped:' + (rec.skip || 'stored-invalid'), []);
  if (image.length === 0) return done('skipped:no-battery', []);
  const have = stored && toU8(stored).length ? toU8(stored) : null, sh = have ? cardHash(have) : null;
  if (sh === rec.imageHash) return done('already-written', []);
  const before = rec.previousHash !== undefined ? rec.previousHash : (rec.source === 'stored' ? rec.initialHash : null);
  if (sh !== before) return { action, outcome: 'stored-changed', steps: [stepJournal(abortedRecord(rec, 'stored-changed'))] };
  const steps = [];
  if (have) steps.push({ op: 'put', key: key + '.pre-room', bytes: have.slice() });
  steps.push({ op: 'put', key, bytes: image.slice() });
  return done('completed', steps);
}
/**
 * What a page does with the journal record it finds at start. Pure: returns { action, outcome, steps } and the page runs `steps` through
 * runSteps. `stored` = what storage holds under `key` now. `choice` = the player's answer to an in-doubt room ('apply' | 'discard' | undefined).
 *   none                  nothing to do.
 *   discard               a 'staged' record: the page died before its last symbol left, so no peer can have committed -> journal 'aborted'.
 *   finish-commit         a 'committing' record: the decision was reached here; complete the writes (idempotent) and mark committed.
 *   in-doubt              a 'last-symbol' record: the others may or may not have committed. Applying changes nothing when this machine's image is
 *                         already what is stored, when storage was changed by someone else since (stored-changed) or when the title has no
 *                         battery / the stored save was never usable: those resolve themselves, with no question asked.
 *                         Otherwise { needsChoice: true } until the player says 'apply' (finish the commit) or 'discard' (journal aborted).
 *   journal-invalid       the record is damaged (image does not match its hash, wrong key): NOTHING is written, the page tells the player.
 * 'stored-changed' (outcome): storage holds neither the pre-room nor the final value - something else wrote it since; the room's image is NOT
 * written over it and the record is closed 'aborted'.
 */
export function recoverPlan({ record, key, stored, choice }) {
  const a = endRecover(record).action;
  if (a === 'none') return { action: 'none', outcome: null, steps: [] };
  if (a === 'discard') return { action: 'discard', outcome: 'discarded', steps: [stepJournal(abortedRecord(record, 'staged-only'))] };
  if (a === 'finish-commit') return finishPlan(record, key, stored, 'finish-commit');
  if (choice === 'discard') return { action: 'in-doubt', outcome: 'user-discarded', steps: [stepJournal(abortedRecord(record, 'user-discarded'))] };
  const p = finishPlan(record, key, stored, 'in-doubt');
  if (p.action === 'journal-invalid' || p.outcome === 'already-written' || p.outcome === 'stored-changed' || p.outcome.indexOf('skipped:') === 0) return p;
  if (choice === 'apply') return p;
  return { action: 'in-doubt', outcome: 'needs-choice', needsChoice: true, steps: [], wouldDo: p.outcome };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 8. the machine: one function that builds it the same way everywhere, one method that runs a frame
// ---------------------------------------------------------------------------------------------------------------------------------
export function fieldNames(seats) { const f = []; for (let i = 0; i < seats; i++) f.push('seat' + i); f.push('link'); return f; }

/**
 * Build the room's machine. Every peer calls this with the same config and the same `images` (verifySaveSet().images), so every peer gets the
 * identical state at frame 0. `MgbaCore` = gba/mgba/mgba_core.js; `wasmBinary` = the bytes of dist/mgba_core.wasm THIS page loaded (its md5
 * must equal config.coreBuildMd5 - the core that runs is the core that is checked). Resolves a RoomMachine.
 */
export async function bootMachine({ MgbaCore, coreOptions, config, rom, images, localSeat, wasmBinary, source }) {
  const cfg = validateConfig(config), t = titleOf(cfg.game);
  if (!isInt(localSeat) || localSeat < 0 || localSeat >= cfg.seats) fail('SAVE_SEAT_RANGE', 'local seat ' + localSeat + ' is outside 0..' + (cfg.seats - 1), { field: 'seat' });
  const romBytes = toU8(rom);
  if (romBytes.length !== t.romBytes || md5(romBytes) !== cfg.romMd5) fail('ROOM_ROM', 'the ROM this page loaded is not the one the room names (' + cfg.romMd5 + ')', { field: 'rom', mine: md5(romBytes), theirs: cfg.romMd5 });
  if (!wasmBinary) fail('ROOM_CORE', 'bootMachine needs the wasm bytes it will run, to check them against the room (config.coreBuildMd5)', { field: 'core' });
  const wm = md5(toU8(wasmBinary));
  if (wm !== cfg.coreBuildMd5) fail('ROOM_CORE', 'the emulator core this page loaded is build ' + wm + ' and the room needs ' + cfg.coreBuildMd5, { field: 'core', mine: wm, theirs: cfg.coreBuildMd5 });
  if (!Array.isArray(images) || images.length !== cfg.seats) fail('SAVE_MISSING_SEAT', 'bootMachine needs one save image per seat', { field: 'seat' });
  const core = await MgbaCore.create(Object.assign({}, coreOptions || {}, { seats: cfg.seats, wasmBinary: toU8(wasmBinary) }));
  try {
    core.setRtc({ fixedEpochMs: cfg.fixedEpochMs, tzOffsetMin: cfg.tzOffsetMin });
    const info = core.loadRom(romBytes, { saveType: 'auto' });
    if (info.saveTag !== t.saveTag) fail('ROOM_ROM', 'the cartridge\'s save library says "' + info.saveTag + '" and the title table says "' + t.saveTag + '"', { field: 'rom' });
    if (t.saveBytes) {
      for (let s = 0; s < cfg.seats; s++) {
        if (images[s].length !== t.saveBytes) fail('SAVE_BAD_SIZE', 'seat ' + (s + 1) + '\'s image is ' + images[s].length + ' bytes, expected ' + t.saveBytes, { field: 'saveSize', seat: s });
        if (!core.setSave(s, images[s])) fail('SAVE_REFUSED_BY_CORE', 'the emulator refused seat ' + (s + 1) + '\'s save', { field: 'saveType', seat: s });
      }
    }
  } catch (e) { core.close(); throw e; }
  return new RoomMachine(core, cfg, localSeat, images.map((x) => toU8(x).slice()), source || 'stored');
}

export class RoomMachine {
  constructor(core, config, localSeat, initialImages, source) {
    this.core = core; this.config = config; this.seats = config.seats; this.localSeat = localSeat;
    this.initial = initialImages; this.source = source;
    this.frame = 0;                                   // applied frames == the engine's ls.frame between frames
    this.end = endInit({ seats: config.seats });
    this.captured = null;                             // { frame, images: [Uint8Array], hashes: [8-hex] } at the agreed frame
    this.wantEnd = false;
    this.incidents = 0;
    this.staged = null;                               // the 'staged' journal record, made once on the capture frame
  }
  /** The player pressed / released "end the room". Held every frame while on; it is a vote, and it can be withdrawn until everyone has voted. */
  setWantEnd(on) { this.wantEnd = !!on; }
  /**
   * The pad for the frame the engine is about to SAMPLE (pass ls.frame). { pad: Uint8Array(PAD_BYTES), journal }: persist `journal` durably
   * (if non-null) BEFORE handing `pad` to ls.beginFrame. The record is a 'last-symbol' record (see endRecover) and carries the LOCAL seat's
   * final image only - never a peer's (a peer's image is not this player's to keep, and recoverPlan would write it under this player's key).
   */
  localPad(keys, sampleFrame) {
    const r = endLocalCtl(this.end, sampleFrame, this.wantEnd);
    return { pad: wordToBytes(encodeWord(keys, r.sym)), journal: r.journal ? Object.assign(this._rec(), { image: this._finalLocal(), imageHash: this.captured.hashes[this.localSeat] }, r.journal) : null };
  }
  _finalLocal() { return this.captured ? this.captured.images[this.localSeat].slice() : null; }
  /** The fields every journal record shares: which room, which seat, and what this machine started the room with (so recovery can tell 'the same save' from 'someone changed it'). */
  _rec() {
    if (this._initialHash === undefined) this._initialHash = cardHash(this.initial[this.localSeat]);      // 32 KiB of FNV once, not on every journal sample
    return { room: this.config.roomId, seat: this.localSeat, source: this.source, initialHash: this._initialHash };
  }
  /**
   * Run ONE applied frame from the engine's agreed input image (r.image: portCount x PAD_BYTES). Never loops, never speeds up: one call == one
   * emulated frame. Returns { status, frame, event, journal } - a non-zero status is a core INCIDENT the page must surface; `journal` is non-null
   * exactly once, on the capture frame (the 'staged' record: persist it, it is how a page that dies before its last digest symbol is told apart from a
   * page that never joined the end).
   */
  step(image) {
    const n = this.seats, f = this.frame, syms = [];
    if (!image || image.length < n * PAD_BYTES) throw new RangeError('step() needs the engine\'s input image: at least ' + n + ' seats x ' + PAD_BYTES + ' bytes (padBytes must be ' + PAD_BYTES + '), got ' + (image ? image.length : 'none'));
    for (let i = 0; i < n; i++) { const d = decodeWord(bytesToWord(image, i * PAD_BYTES)); syms.push(d); this.core.setKeys(i, d.keys); }
    const r = endStep(this.end, f, syms);
    this.end = r.state;
    const status = this.core.runFrame();
    this.frame = f + 1;
    if (status) this.incidents++;
    let journal = null;
    if (r.event && r.event.type === 'agreed') journal = this._capture(f);
    return { status, frame: f, event: r.event, journal };
  }
  _capture(F) {
    const images = [], hashes = [];
    for (let i = 0; i < this.seats; i++) {
      const x = this.core.exportSave(i);
      const img = x ? x : this.initial[i].slice();
      images.push(img); hashes.push(cardHash(img));
    }
    this.captured = { frame: F, images, hashes };
    this.end = endCapture(this.end, { roomId: this.config.roomId, frame: F, imageHashes: hashes });
    this.staged = Object.assign({ state: 'staged' }, this._rec(), { F, imageHash: hashes[this.localSeat] });
    return this.staged;
  }
  /** The engine fingerprint for this frame: one word per seat (full 0x61000-byte state hash) and the link layer's. Compare ONLY machines that ran the same sequence from frame 0. */
  fingerprint() {
    const words = [];
    for (let i = 0; i < this.seats; i++) words.push(this.core.hash(i));
    words.push(this.core.hashLink());
    return { words, hash: foldWords(words) };
  }
  /** The storage plan after a clean end (see planCommit). `key` = the player's battery key; `previous` = what storage holds now. */
  commitPlan({ key, previous }) {
    if (!this.captured) fail('COMMIT_NOT_CLEAN', 'the room has not reached its end', { field: 'commit' });
    const L = this.localSeat, plan = planCommit({ endState: this.end, localSeat: L, finalImage: this.captured.images[L], initialImage: this.initial[L], key, previous, source: this.source });
    const prev = previous && toU8(previous).length ? toU8(previous) : null;
    plan.journalBefore = Object.assign({ state: 'committing', F: this.end.F, key }, this._rec(), { image: this.captured.images[L].slice(), imageHash: this.captured.hashes[L], previousHash: prev ? cardHash(prev) : null, skip: plan.skip });
    plan.journalAfter = { state: 'committed', room: this.config.roomId, seat: L, F: this.end.F };
    plan.steps = commitSteps(plan);
    return plan;
  }
  close() { if (this.core) { this.core.close(); this.core = null; } }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 9. disconnect / rejoin policy (decision + numbers: gba/mgba/README.md "Rooms")
// ---------------------------------------------------------------------------------------------------------------------------------
/**
 * The options every peer hands to Session.startLockstep / new Lockstep BEFORE it knows the room config (a joiner learns the config from the
 * save exchange, after its engine exists). Delay lockstep only: no rollback, replay ON, checkpoints OFF. The host's delay and hash cadence win
 * ('lsgo'); once the config is known set `ls.fieldNames = fieldNames(config.seats)` so a desync names `seat1` / `link` instead of `w1`.
 */
export function baseLockstepOptions() {
  return { portCount: MAX_SEATS, padBytes: PAD_BYTES, delay: DELAY_DEFAULT, hashEvery: HASH_EVERY, rollback: 0, rollbackOk: false, rsReplay: true, rsCheckpoint: false,
    fieldNames: null, frameHz: GBA_HZ };
}
/** The host's options, from its config (its input delay and the fingerprint field names for N seats). */
export function lockstepOptions(config) {
  const cfg = validateConfig(config);
  return Object.assign(baseLockstepOptions(), { delay: cfg.inputDelay, fieldNames: fieldNames(cfg.seats) });
}
/*
 * THE rsReplay DECISION RESTS ON DESKTOP NUMBERS ONLY. Replaying a recorded room ran at 2.5x hardware for Kirby x4 and 3.7-15.6x for the other
 * rows on the one Windows desktop it was measured on (tools/gba_room_protocol_test.mjs section "policy"; the table is in gba/mgba/README.md
 * "Rooms"), so a returning DESKTOP page outruns the room and catches up. A phone has not been measured. By the closed form in replayCost() a
 * device that replays Kirby x4 at less than 1.0x hardware can never catch up, and at 1.5x needs 2x as long as at 2.0x; a phone 4-6x slower than this
 * desktop would sit below 1.0x on Kirby x4 (2.5x / 4..6 = 0.42..0.63x) - that is an INFERENCE from one ratio, not a measurement. (Such a phone could
 * not hold 1.000x LIVE with four Kirby seats either, so it would not be in that room; a phone that holds the room live but replays slowly is the
 * unmeasured middle.) GR3 (the device budget) owns measuring it; until then a page must show the catch-up as an explicit, cancellable state.
 */
export const DISCONNECT_POLICY = Object.freeze({
  rollback: false, rsReplay: true, rsCheckpoint: false,
  unmeasured: 'No phone or low-end device has been measured. The catch-up estimate is replayCost() applied to a desktop capacity; it says nothing about a device slower than about 2.5x below this desktop on Kirby x4.',
  why: 'A returning page replays the room from frame 0 through the same step() path as live play. Checkpoints are OFF because an mGBA savestate does not round-trip bit-exactly: ' +
    'a restored instance and a continuing one diverge (hashGame differs on Sonic Advance 3, a ROOMABLE title), and a restored page would raise false desyncs against the host. ' +
    'Rollback is OFF for the same reason (it restores a state before every re-simulation) and because the in-band END channel needs every applied frame to be final.',
});
export const CHECKPOINT_POLICY = Object.freeze({
  enabled: false,
  tripwire: 'tools/gba_room_protocol_test.mjs section "policy" measures restored-vs-continuing divergence on Sonic Advance 3; when it stops diverging, revisit this decision',
});
/**
 * Seconds a returning page needs to catch up to a room that has been running `roomFrames` frames, replaying at `replayFps` frames per second
 * (a measured capacity for that title and seat count) while the room keeps advancing at GBA_HZ. Infinity when replay cannot outrun the room.
 */
export function replayCost({ roomFrames, replayFps }) {
  const gain = replayFps - GBA_HZ;
  return gain > 0 ? roomFrames / gain : Infinity;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 10. THE DEVICE BUDGET (stage GR3 = plan G6): how many seats a device can hold at EXACTLY 1.000x, the input delay a room starts at, and
//     the plain-words notice a live room shows when its rate falls below hardware because one device cannot keep up.
//
// NOTHING IN THIS SECTION CAN MAKE A ROOM RUN FASTER. Cost, headroom and capacity are measurements of how much spare time a device has; the
// room's rate is fixed at GBA_HZ by the page's clock and can only be LOWERED by a slow device (a stall). Every function here is pure: the
// clock is injected (`now`), the numbers come from tools/gba_room_budget_measure.mjs and are documented in gba/mgba/README.md "Budget".
// ---------------------------------------------------------------------------------------------------------------------------------
export const FRAME_MS = 1000 / GBA_HZ;               // 16.7427...: one emulated frame of wall time at exactly 1.000x
export const LONG_TASK_MS = 50;                      // the browser's own long-task line: a task longer than this delays a touch or a key
export const TICK_MAX_FRAMES = 4;                    // GR2's starting value for the frames one rAF tick may run (script.js ROOM_MAX_FRAMES)

/** Linear-interpolated percentile (the "type 7" rule) of an ASCENDING array; p in 0..100. null for an empty array. */
export function percentile(sorted, p) {
  const n = sorted.length;
  if (!n) return null;
  if (n === 1) return sorted[0];
  const r = (Math.max(0, Math.min(100, p)) / 100) * (n - 1), lo = Math.floor(r), hi = Math.min(n - 1, lo + 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (r - lo);
}

/**
 * A ring of the last `size` per-frame costs (milliseconds of main-thread time one applied room frame took). push() is O(1); summary() sorts a
 * copy and is meant for a report, not for the frame loop. `ema` is the running mean the page publishes as its capacity.
 */
export class CostRing {
  constructor(size) {
    this.size = size > 0 ? size | 0 : 8192;
    this.buf = new Float32Array(this.size);
    this.n = 0; this.max = 0; this.sum = 0; this.ema = 0;
  }
  push(ms) {
    if (typeof ms !== 'number' || !(ms >= 0) || !isFinite(ms)) return false;
    this.buf[this.n % this.size] = ms;
    this.n++; this.sum += ms;
    if (ms > this.max) this.max = ms;
    this.ema = this.n === 1 ? ms : this.ema + (ms - this.ema) / 32;
    return true;
  }
  /** The retained samples, oldest first. */
  samples() {
    const k = Math.min(this.n, this.size), out = new Float32Array(k), start = this.n > this.size ? this.n % this.size : 0;
    for (let i = 0; i < k; i++) out[i] = this.buf[(start + i) % this.size];
    return out;
  }
  /** {n, kept, mean, p50, p95, p99, max, maxEver, over}: `over` = retained samples above `overMs` (default: one frame). */
  summary(overMs) {
    const s = this.samples(), lim = overMs === undefined ? FRAME_MS : overMs;
    if (!s.length) return { n: this.n, kept: 0, mean: null, p50: null, p95: null, p99: null, max: null, maxEver: this.max, over: 0, overMs: lim };
    const a = Array.from(s).sort((x, y) => x - y);
    let sum = 0, over = 0;
    for (const v of a) { sum += v; if (v > lim) over++; }
    return { n: this.n, kept: a.length, mean: sum / a.length, p50: percentile(a, 50), p95: percentile(a, 95), p99: percentile(a, 99), max: a[a.length - 1], maxEver: this.max, over, overMs: lim };
  }
}

/** Spare time as a CAPACITY: how many times over the device could make one frame in the time one frame lasts. A capacity is never a rate. */
export function headroomOf(costMs) { return costMs > 0 && isFinite(costMs) ? FRAME_MS / costMs : null; }
/** The one sentence shape for presented frames and capacity (CLAUDE.md gate 9): "N presented, Mx headroom". Never "Nx realtime". */
export function presentedText(presentedPerSec, headroom) {
  const p = typeof presentedPerSec === 'number' && isFinite(presentedPerSec) ? presentedPerSec.toFixed(1) : '?';
  return p + ' presented, ' + (headroom > 0 && isFinite(headroom) ? (headroom >= 10 ? headroom.toFixed(0) : headroom.toFixed(1)) : '?') + 'x headroom';
}

/**
 * How many frames one rAF tick may run: as many as fit under the browser's long-task line at this device's measured cost, never more than
 * TICK_MAX_FRAMES and never fewer than one. It can only LOWER GR2's cap of four, so it cannot let the guest run faster; a tick that is cut
 * short drops its unspent credit (the page counts it as time lost, not as time to repay).
 */
export function framesPerTick(costMs, opts) {
  const o = opts || {}, cap = o.maxFrames > 0 ? o.maxFrames | 0 : TICK_MAX_FRAMES, line = o.longTaskMs > 0 ? o.longTaskMs : LONG_TASK_MS;
  if (!(costMs > 0) || !isFinite(costMs)) return cap;
  return Math.max(1, Math.min(cap, Math.floor(line / costMs)));
}

// ---- the speed test: a fixed workload, timed with an injected clock ----------------------------------------------------------------
/**
 * The calibration workload: a fixed amount of 32-bit integer work with data-dependent loads, the same kind of work a CPU emulator does (no
 * floating point, no allocation in the loop). Returns a checksum so the loop cannot be removed as dead code. The page and the measurement rig run
 * THIS function, so a ratio between them is a ratio of the same work.
 */
export function calibrationWork(iterations) {
  const mem = new Int32Array(2048);
  for (let i = 0; i < mem.length; i++) mem[i] = Math.imul(i + 1, 0x9e3779b1);
  let x = 0x1234567, acc = 0;
  for (let i = 0; i < iterations; i++) {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    const j = x & 2047;
    acc = (acc + mem[j]) | 0;
    mem[(j + 1) & 2047] = acc ^ x;
  }
  return acc;
}
export const CALIBRATION = Object.freeze({
  trials: 7, iterations: 3000000,
  reliableSpread: 0.35,           // (median - min) / min above this and the reading is not trusted (the machine was busy while it ran)
  refMs: 5.5,                     // ms of the best trial on the reference desktop: the median of 30 best-of-7 readings, tools/gba_room_budget_measure.mjs --mode calib (README "Budget")
});
/**
 * Run the speed test: one warm-up trial (the engine's first run of a loop is not its steady state), then `trials` timed ones. The BEST trial is
 * the reading - interference from other work can only add time - and the spread says whether to trust it. `slowdown` is best / refMs: 1.0 is the
 * reference desktop, 4.0 is a device four times slower at this kind of work. null when there is no reference yet.
 */
export function calibrate(now, opts) {
  const o = Object.assign({}, CALIBRATION, opts || {}), ts = [];
  calibrationWork(o.iterations);
  for (let i = 0; i < o.trials; i++) { const t0 = now(); calibrationWork(o.iterations); ts.push(now() - t0); }
  return interpretCalibration(ts, o.refMs, o.reliableSpread);
}
export function interpretCalibration(ts, refMs, reliableSpread) {
  const a = ts.slice().sort((x, y) => x - y), best = a[0], med = percentile(a, 50);
  const spread = best > 0 ? (med - best) / best : Infinity;
  const slowdown = refMs > 0 && best > 0 ? best / refMs : null;
  return { bestMs: best, medianMs: med, spread, trials: ts.length, slowdown, reliable: best > 0 && spread <= (reliableSpread === undefined ? CALIBRATION.reliableSpread : reliableSpread) };
}

// ---- the cost model and the seat cap -----------------------------------------------------------------------------------------------
/**
 * Main-thread ms per applied room frame on the REFERENCE desktop (shared Windows desktop, headless Chrome 156 / SwiftShader), in the busiest
 * scene reached, measured by tools/gba_room_budget_measure.mjs: p50 and p95 over >= 3000 frames, engine + core step + audio + the amortised
 * canvas upload. NOT a device number. Filled from that rig's output; `source` names the run.
 */
export const COST_REFERENCE = Object.freeze({
  source: 'tools/gba_room_budget_measure.mjs plan 1 (cells), 2026-11-02, Windows 11 / Ryzen 7 3800X, Chrome 156 SwiftShader, 3000 frames of the final scene + the whole scripted walk, Windows CPU busy 6-71%',
  // per title, per seat count: p50 and p95 of `total` (ms per room frame), the larger of the final scene and the walk, averaged over the room's pages
  perf: Object.freeze({
    'Super Bust-A-Move': Object.freeze({ 2: Object.freeze({ p50: 2.3, p95: 3.1 }) }),
    'Kirby Nightmare in Dreamland': Object.freeze({ 2: Object.freeze({ p50: 3.65, p95: 5.4 }), 3: Object.freeze({ p50: 5.2, p95: 7.87 }), 4: Object.freeze({ p50: 6.72, p95: 10.35 }) }),
    'Sonic Advance 3': Object.freeze({ 2: Object.freeze({ p50: 2.6, p95: 3.55 }) }),
  }),
});
/** Fraction of a frame's wall time a room's p95 cost may use before the cap refuses the seat count (set from the throttled arm's knee). */
export const USABLE_FRACTION = 0.75;
/** What the reported memory (navigator.deviceMemory, a rounded hint, absent on Safari and Firefox) is allowed to do. Conservative; not measured on any low-memory device. */
export const MEMORY_RULE = Object.freeze({ noRoomAtOrBelowGB: 0.5, twoSeatsAtOrBelowGB: 1, heapMiB: 192 });
export const CAP_CODES = Object.freeze(['SEATS_DEVICE_MEMORY', 'SEATS_DEVICE_SLOW', 'SEATS_DEVICE_UNMEASURED']);

/** Predicted reference-desktop cost of `seats` seats of `game`, scaled by a device's `slowdown`. null when the table has nothing for the title. Seat counts between measured ones are interpolated, beyond them extrapolated per seat. */
export function predictCost(game, seats, slowdown) {
  const row = own(COST_REFERENCE.perf, game) ? COST_REFERENCE.perf[game] : null;
  if (!row) return null;
  const ns = Object.keys(row).map(Number).sort((a, b) => a - b);
  if (!ns.length) return null;
  const at = (n, k) => row[n][k];
  const pick = (k) => {
    if (row[seats]) return at(seats, k);
    if (ns.length === 1) return at(ns[0], k) * seats / ns[0];
    let lo = ns[0], hi = ns[1];
    for (let i = 0; i < ns.length - 1; i++) if (seats >= ns[i]) { lo = ns[i]; hi = ns[i + 1]; }
    return at(lo, k) + (at(hi, k) - at(lo, k)) * (seats - lo) / (hi - lo);
  };
  const f = slowdown > 0 ? slowdown : 1;
  return { p50Ms: pick('p50') * f, p95Ms: pick('p95') * f, slowdown: f };
}

/**
 * The seat counts a device may OFFER. `deviceMemoryGB`: navigator.deviceMemory or null. `slowdown`: calibrate().slowdown (null when the speed test
 * could not run or could not be trusted). Returns { game, byCount: { n: {ok, code, reason, predictedMs, headroom} }, counts, maxSeats, basis }.
 * A refused count carries the sentence the host reads; `code` is one of CAP_CODES. Conservative by construction: with no usable speed reading only
 * two seats are offered.
 */
export function seatCap(o) {
  const game = o && o.game, rules = roomableOf(game);
  if (!rules) fail('ROOM_NOT_ROOMABLE', whyNotRoomable(game) || 'not roomable', { field: 'game' });
  const mem = typeof o.deviceMemoryGB === 'number' && o.deviceMemoryGB > 0 ? o.deviceMemoryGB : null;
  const sd = typeof o.slowdown === 'number' && o.slowdown > 0 && isFinite(o.slowdown) ? o.slowdown : null;
  const usable = USABLE_FRACTION > 0 ? USABLE_FRACTION : 0.5;
  const byCount = {}, counts = rules.counts.slice();
  for (const n of counts) {
    let ok = true, code = null, reason = '';
    const pred = sd != null ? predictCost(game, n, sd) : null;
    if (mem != null && mem <= MEMORY_RULE.noRoomAtOrBelowGB) {
      ok = false; code = 'SEATS_DEVICE_MEMORY';
      reason = 'this device reports about ' + mem + ' GB of memory in all, and a room needs one fixed ' + MEMORY_RULE.heapMiB + ' MB block for the game, so it cannot host a room';
    } else if (mem != null && mem <= MEMORY_RULE.twoSeatsAtOrBelowGB && n > 2) {
      ok = false; code = 'SEATS_DEVICE_MEMORY';
      reason = 'this device reports about ' + mem + ' GB of memory in all; with the ' + MEMORY_RULE.heapMiB + ' MB the game needs, it is offered rooms of two players only';
    } else if (pred) {
      if (pred.p95Ms > usable * FRAME_MS) {
        ok = false; code = 'SEATS_DEVICE_SLOW';
        // an overloaded room ran at about 0.9 x one frame / its typical frame cost (README "Budget", throttle table), never above 1
        const full = Math.min(1, 0.9 * FRAME_MS / pred.p50Ms);
        reason = n + ' players would need about ' + pred.p95Ms.toFixed(1) + ' ms of this device for each frame of ' + game + ' at its busiest (a typical frame ' + pred.p50Ms.toFixed(1) + ' ms), and a frame lasts ' + FRAME_MS.toFixed(1) + ' ms'
          + (full < 1 ? ', so the game would run at about ' + full.toFixed(2) + 'x of full speed for everyone' : ', so its busiest frames would not fit and the room would stutter');
      }
    } else if (sd == null && n > 2) {
      ok = false; code = 'SEATS_DEVICE_UNMEASURED';
      reason = 'this device\'s speed could not be measured, so only rooms of two players are offered until it can';
    }
    byCount[n] = { ok, code, reason, predictedMs: pred ? pred.p95Ms : null, headroom: pred ? headroomOf(pred.p95Ms) : null };
  }
  const okCounts = counts.filter((n) => byCount[n].ok);
  return { game, counts, byCount, okCounts, maxSeats: okCounts.length ? Math.max.apply(null, okCounts) : 0,
    basis: { memoryGB: mem, slowdown: sd, usableFraction: usable, frameMs: FRAME_MS, referenceSource: COST_REFERENCE.source } };
}
/** The one paragraph the host reads under the seat picker: every refused count with its reason, nothing when all are offered. */
export function seatCapText(cap) {
  const refused = cap.counts.filter((n) => !cap.byCount[n].ok);
  if (!refused.length) return '';
  const groups = [];
  for (const n of refused) {
    const r = cap.byCount[n].reason, g = groups.find((x) => x.reason === r);
    if (g) g.ns.push(n); else groups.push({ ns: [n], reason: r });
  }
  const list = (ns) => (ns.length === 1 ? String(ns[0]) : ns.slice(0, -1).join(', ') + ' and ' + ns[ns.length - 1]);
  return groups.map((g) => (g.ns.length === 1 ? g.ns[0] + ' players is not offered: ' : list(g.ns) + ' players are not offered: ') + g.reason + '.').join(' ');
}

// ---- the input delay a room starts at ---------------------------------------------------------------------------------------------
export const DELAY_RULE = Object.freeze({
  floor: 2,                       // never start below this many frames: the engine's own minimum (Lockstep minDelay 2). README "Budget": 1 frame stalled at a 6x throttle, 2 did not
  costAddsDelay: false,           // MEASURED, then left out: on an overloaded Kirby room 2 -> 8 frames of delay removed every stall and gave back at most 1.5% of the rate for ~100 ms of latency (README "Budget", delay sweep)
});
/**
 * The input delay (frames) a room STARTS at. `budgetsMs`: each other player's round-trip budget as lib/netplay.js `Lockstep.rttBudget` makes it
 * (outliers dropped, a jitter margin added). The rule is the engine's own (`Lockstep.recommendDelayForRoom`: the worst budget, plus the second worst in
 * a room of three or four, because a guest-to-guest input crosses the host), floored at 2 frames. `costMs` (this device's ms per frame) is REPORTED as
 * `costRatio` and does not change the answer: the sweep in README "Budget" found that more delay on a device that is short of power removes stalls and
 * recovers almost none of the rate. THE DELAY IS A LATENCY KNOB: a late peer STALLS the lockstep, it never makes anyone run faster, and the engine
 * raises (and gives back) this value by itself from the stalls it sees. Returns { delay, link, costRatio, floor, roomRttMs, why }.
 */
export function defaultInputDelay(o) {
  const opt = o || {}, F = opt.frameMs > 0 ? opt.frameMs : FRAME_MS;
  const bs = (opt.budgetsMs || []).filter((x) => typeof x === 'number' && x >= 0 && isFinite(x)).sort((a, b) => b - a);
  let link = null, room = null;
  if (bs.length) { room = bs.length > 1 ? Math.max(bs[0], bs[0] + bs[1]) : bs[0]; link = Math.max(1, Math.min(30, Math.ceil(room / 2 / F) + 1)); }
  const ratio = opt.costMs > 0 ? opt.costMs / F : 0;
  const base = link == null ? DELAY_DEFAULT : link;
  const delay = Math.max(DELAY_MIN, Math.min(DELAY_MAX, Math.max(DELAY_RULE.floor, base)));
  const why = link == null ? 'no round trip was measured, so the default of ' + DELAY_DEFAULT + ' frames'
    : 'a worst round trip of ' + Math.round(room) + ' ms needs ' + link + ' frames' + (delay > base ? ', raised to the floor of ' + DELAY_RULE.floor : '');
  return { delay, link, costRatio: ratio, floor: DELAY_RULE.floor, roomRttMs: room, why };
}

// ---- the live pace: how fast is the room really going, and who is the slow one --------------------------------------------------
/** The room's rate as a fraction of hardware over the last `spanMs`, from (time, applied frame) samples. null until the span is covered. A rate, not a capacity. */
export class RateMeter {
  constructor(spanMs) { this.spanMs = spanMs > 0 ? spanMs : 8000; this.s = []; }
  push(tMs, frame) {
    this.s.push([tMs, frame]);
    while (this.s.length > 2 && tMs - this.s[1][0] >= this.spanMs) this.s.shift();
    const a = this.s[0], b = this.s[this.s.length - 1];
    if (b[0] - a[0] < this.spanMs * 0.8 || b[0] <= a[0]) return null;
    return ((b[1] - a[1]) / ((b[0] - a[0]) / 1000)) / GBA_HZ;
  }
}
/**
 * Debounce for the "this device cannot keep up" notice. A room is SLOW when its rate has stayed below `slowBelow` on every reading for
 * `slowAfterMs`, and OK again after `okAfterMs` at or above `okAbove`; the first `graceMs` (loading, first frames) never count. A dip of a few
 * seconds - one stall, one garbage collection - never raises the notice.
 */
export class PaceWatch {
  constructor(o) {
    const p = o || {};
    this.slowBelow = p.slowBelow > 0 ? p.slowBelow : 0.95; this.okAbove = p.okAbove > 0 ? p.okAbove : 0.98;
    this.slowAfterMs = p.slowAfterMs >= 0 ? p.slowAfterMs : 5000; this.okAfterMs = p.okAfterMs >= 0 ? p.okAfterMs : 4000; this.graceMs = p.graceMs >= 0 ? p.graceMs : 10000;
    this.t0 = null; this.below = null; this.above = null; this.slow = false; this.episodes = 0;
  }
  feed(tMs, rate) {
    if (this.t0 == null) this.t0 = tMs;
    let changed = false;
    if (typeof rate === 'number' && isFinite(rate) && tMs - this.t0 >= this.graceMs) {
      if (rate < this.slowBelow) {
        this.above = null; if (this.below == null) this.below = tMs;
        if (!this.slow && tMs - this.below >= this.slowAfterMs) { this.slow = true; changed = true; this.episodes++; }
      } else {
        this.below = null;
        if (rate >= this.okAbove) { if (this.above == null) this.above = tMs; if (this.slow && tMs - this.above >= this.okAfterMs) { this.slow = false; changed = true; } }
        else this.above = null;
      }
    }
    return { slow: this.slow, changed };
  }
}
const seatName = (p) => 'Seat ' + (p + 1);
const rateTxt = (x) => (x >= 10 ? x.toFixed(1) : x.toFixed(2)) + 'x';
/**
 * The plain-words notice for a room running below hardware speed. `verdict` is lib/netplay.js `Lockstep.paceVerdict(report, rate, opts)` (who the
 * room is waiting on, from every console's own published capacity); this function only turns it into words and a way out. It never suggests a
 * way to run faster: the room is as fast as its slowest device and there is no other fix than a smaller room or one player fewer.
 *   ctx: { rate, localSeat, seats, isHost, minSeats, slowBelow }
 * Returns { level: 'device'|'link'|'unknown', kind, culprit (seat index or null), self (this device is the culprit), culprits (seat indexes), headline, detail, text, actions }.
 */
export function paceNotice(verdict, ctx) {
  const c = ctx || {}, v = verdict || { kind: 'unknown' }, rate = c.rate, rt = typeof rate === 'number' ? rateTxt(rate) : '?';
  const below = c.slowBelow > 0 ? c.slowBelow : 0.95;
  const seats = c.seats | 0, minSeats = c.minSeats > 0 ? c.minSeats | 0 : MIN_SEATS;
  const smaller = c.isHost && seats - 1 >= minSeats ? seats - 1 : null;
  const out = { level: 'unknown', kind: v.kind, culprit: null, self: false, culprits: [], headline: '', detail: '', text: '', actions: [{ id: 'leave', label: 'Leave the room' }] };
  if (smaller != null) out.actions.push({ id: 'smaller', label: 'Start a smaller room', seats: smaller });
  const slowCaps = (v.caps || []).filter((x) => x.cap && x.cap < below && x.ports && x.ports.length).sort((a, b) => a.cap - b.cap);
  // A console whose OWN measured capacity is below full speed is slow whatever else the engine saw. When every device is slow they all wait on each
  // other, and the engine's waiting-share rule then reads that as "the connection" - which would blame the network for a CPU - so capacity is read first.
  if (slowCaps.length || v.kind === 'self' || v.kind === 'device' || v.kind === 'all-slow') {
    out.level = 'device';
    const pick = slowCaps.length ? slowCaps[0] : null;
    const port = pick ? pick.ports[0] : (v.port != null ? v.port : null);
    out.culprits = slowCaps.map((x) => x.ports[0]).sort((a, b) => a - b);
    if (!out.culprits.length && port != null) out.culprits = [port];
    out.culprit = port;
    out.self = out.culprits.length > 1 ? out.culprits.indexOf(c.localSeat) >= 0 : (pick ? !!pick.me : (v.kind === 'self' || (port != null && port === c.localSeat)));
    if (out.culprits.length > 1) {
      out.headline = out.culprits.map(seatName).join(', ').replace(/, ([^,]*)$/, ' and $1') + ' are too slow for this room: the game runs at ' + rt + ' for everyone.';
      out.detail = 'Each of those devices can make only part of the frames the game needs, and the room goes at the speed of the slowest. Nothing can speed it up; a smaller room or a faster device can.';
    } else {
      const who = port == null ? 'A device' : out.self ? 'This device' + (c.localSeat != null && c.localSeat >= 0 ? ' (' + seatName(c.localSeat) + ')' : '') : seatName(port) + '\'s device';
      out.headline = who + ' is too slow for this room: the game runs at ' + rt + ' for everyone.';
      const cap = pick ? pick.cap : (v.cap || null);
      // a device that averages MORE than a full speed of frames but still holds the room back is losing time in bursts (other work on it), not short of power
      out.detail = (cap ? (cap < 1 ? who + ' can make about ' + cap.toFixed(2) + 'x of the frames the game needs. ' : who + ' makes enough frames on average but keeps falling behind in bursts, so something else on it is taking the time. ') : '')
        + 'The room goes at the speed of its slowest device; nothing can make it faster than that.';
    }
    out.detail += out.self ? (c.isHost ? ' Leave, or open a smaller room.' : ' Leaving lets everyone else play at full speed.')
      : (c.isHost ? ' You can start a smaller room without that player, or leave.' : ' You can leave, or ask the host to start a smaller room.');
  } else if (v.kind === 'link' || v.kind === 'network') {
    out.level = 'link'; out.culprit = v.port != null ? v.port : null; out.self = out.culprit != null && out.culprit === c.localSeat;
    out.headline = (v.kind === 'link' && out.culprit != null ? (out.self ? 'This device\'s connection' : seatName(out.culprit) + '\'s connection') : 'The connection') + ' is slower than the room\'s input delay covers: the game runs at ' + rt + ' for now.';
    out.detail = 'This is the network, not a device. The room raises its input delay by itself until the inputs arrive in time' + (typeof c.delay === 'number' ? ' (now ' + c.delay + ' frames)' : '') + '.';
  } else {
    out.level = 'unknown';
    out.headline = 'The room runs at ' + rt + ' of full speed, below the ' + below.toFixed(2) + 'x it should hold.';
    out.detail = 'The room cannot yet tell which device is slow. It goes at the speed of its slowest device.';
  }
  out.text = out.headline + ' ' + out.detail;
  return out;
}

// pokemonarena/js/teamcode.js -- the team code ("ARENA1.<payload>.<crc>") and the binary team card behind it.
//
// Pure ES module (browser + Node 24). The binary layer is synchronous and has no ambient dependencies; the text code
// adds deflate-raw through CompressionStream / DecompressionStream (so those two functions are async).
//
// ONE PAYLOAD, TWO USES. The binary team card (encodeTeamBinary) is what a pasted code carries inside, and it is the
// payload that will travel as the in-battle team card. Both consumers therefore decode the SAME bytes with the SAME
// function, so a code that pastes cleanly can never validate differently from the card that crosses the wire.
//
// TEXT CODE:   'ARENA1' + '.' + base64url(deflate-raw(binary)) + '.' + crc16
//   * base64url without padding, strict (a payload whose last character carries stray bits is refused).
//   * crc16 = CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF) of the ASCII text 'ARENA1.<payload>', four lowercase
//     hex digits (upper case is accepted when reading). It catches typos and truncation; it is NOT authentication.
//   * whitespace anywhere in a pasted code is ignored.
//   * decompression is capped at MAX_BINARY_BYTES, so a hostile code cannot inflate into memory.
//
// BINARY CARD (all multi-byte integers little-endian; the whole thing is fixed-width per record):
//   0      u8   version                = 1
//   1      u8   ruleset base id        0 = 'arena-gen3-standard'
//   2      u8   ruleset layer bits     bit i set = LAYER_BITS[i] applied; unused high bits MUST be 0
//   3      4B   romId                  the first 4 bytes of the ROM's SHA-256, in hex order
//   7      u8   name length n          0..16
//   8      nB   team name              Gen-3 charset bytes, one per character, no terminator
//   8+n    u8   mon count              1..6
//   then per mon, 37 bytes:
//     0   u16  species
//     2   u16  held item (0 = none)
//     4   u8   level 1..100
//     5   u8   nature 0..24
//     6   u8   flags: bits0-1 ability slot (0..2), bits2-3 gender (0 M, 1 F, 2 genderless), bit4 shiny, bits5-7 = 0
//     7   u8   friendship
//     8   6B   EVs   in ROM struct order hp, atk, def, spe, spa, spd
//     14  u32  IVs   5 bits each in ROM order: hp bits 0-4, atk 5-9, def 10-14, spe 15-19, spa 20-24, spd 25-29; bits 30-31 = 0
//     18  8B   four u16 move ids (1..4 moves, then zeros)
//     26  u8   PP-ups, two bits per move slot (slot i = bits 2i..2i+1); an empty slot's bits MUST be 0
//     27  10B  nickname in Gen-3 charset, then 0xFF padding to 10 bytes (all 0xFF = no nickname)
//   Six mons plus an average header is about 240-260 bytes before deflate.
// The ROM order for EVs / IVs is pinned on purpose: the profile keeps keyed objects, the UI shows hp/atk/def/spa/spd/spe,
// and only this layer has a fixed order. A mutation test swaps it and must see the byte offsets change.
//
// DECODING IS CANONICAL. decodeTeamBinary refuses every byte string that encodeTeamBinary could not have produced
// (reserved bits, non-contiguous moves, non-0xFF padding after a nickname, ...), so encode(decode(b)) === b for every
// accepted b. That makes the card hash well defined: two peers holding the same team always hash the same bytes.
//
// WHAT IS NOT CARRIED: original trainer, origin, provenance, ids, timestamps. A team code is a battle card, not a
// backup; use the profile export for that.

import { ROM_STAT_ORDER } from './stats.js';
import { resolveRuleset, RULESET_LAYERS } from './rules.js';
import { defaultCodec } from './charset.js';
import { PINNED, sha256Hex } from './rom.js';
import { textIssue, createMon, validateMonList, compressBytes, decompressBytes, streamSupported, b64urlEncode, b64urlDecode, PROFILE_LIMITS } from './profile.js';

export { b64urlEncode, b64urlDecode };

export const TEAMCODE_PREFIX = 'ARENA1';
export const TEAM_BINARY_VERSION = 1;
export const TEAM_NAME_MAX = 16;
export const TEAM_MAX_MONS = 6;
export const MON_BYTES = 37;
export const NICK_BYTES = 10;
export const MAX_BINARY_BYTES = 1 + 1 + 1 + 4 + 1 + TEAM_NAME_MAX + 1 + TEAM_MAX_MONS * MON_BYTES; // 247
export const MAX_CODE_CHARS = 1024;
/** Index = the byte stored. Append only; a reorder would change the meaning of every code ever shared. */
export const BASE_IDS = Object.freeze(['arena-gen3-standard']);
/** Index = the bit stored. Append only (a test requires every layer rules.js defines to have a bit here). */
export const LAYER_BITS = Object.freeze(['lv5', 'lv100', 'item-clause', 'no-species-clause', 'strict-champions']);
export const GENDER_CODE = Object.freeze({ M: 0, F: 1, '-': 2 });
const GENDER_FROM = Object.freeze(['M', 'F', '-']);

export const TEAMCODE_ERRORS = Object.freeze({
  'encode.team': 'the team object is not {name, ruleset, mons[]}',
  'encode.name': 'the team name is longer than 16 characters or not ROM-font text',
  'encode.ruleset': 'the ruleset is not one a code can carry',
  'encode.rom': 'romSha256 is not 64 lowercase hex digits',
  'encode.count': 'a team card holds 1..6 Pokemon',
  'encode.mon': 'a Pokemon field is out of range or not encodable',
  'code.empty': 'the code is empty',
  'code.too-long': 'the code is longer than 1024 characters',
  'code.format': 'the code is not three dot-separated parts',
  'code.prefix': 'the code does not start with ARENA1',
  'code.version': 'the code is for a different version (ARENA2, ...)',
  'code.chars': 'the payload has characters outside the base64url alphabet',
  'code.crc-format': 'the check value is not four hex digits',
  'code.crc': 'the check value does not match: a character was mistyped or the code was cut short',
  'code.base64': 'the payload is not canonical base64url',
  'code.unsupported': 'this browser cannot decompress team codes',
  'code.inflate': 'the payload does not decompress',
  'code.too-large': 'the payload decompresses to more than a team card can hold',
  'code.rom': 'the team is for a different ROM than expected',
  'binary.length': 'the card is too short, too long, or has trailing bytes',
  'binary.version': 'unknown card version',
  'binary.ruleset': 'the ruleset bytes name no valid ruleset',
  'binary.name': 'the team name bytes are not canonical ROM-font text',
  'binary.count': 'the Pokemon count is not 1..6',
  'binary.mon': 'a Pokemon record is not canonical',
});

export class TeamCodeError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'TeamCodeError';
    this.code = code;
    this.detail = detail || null;
  }
}

const hasOwn = Object.prototype.hasOwnProperty;
const isObj = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const enc = (s) => new TextEncoder().encode(s);

// ---------------------------------------------------------------------------------------------
// checksums and base64url
// ---------------------------------------------------------------------------------------------

/** CRC-16/CCITT-FALSE. crc16('123456789') === 0x29b1. */
export function crc16(bytes) {
  let c = 0xffff;
  for (let i = 0; i < bytes.length; i++) {
    c ^= bytes[i] << 8;
    for (let k = 0; k < 8; k++) c = (c & 0x8000) ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
  }
  return c;
}
const crcHex = (bytes) => crc16(bytes).toString(16).padStart(4, '0');

// ---------------------------------------------------------------------------------------------
// ruleset <-> (base byte, layer bits)
// ---------------------------------------------------------------------------------------------

export function rulesetToBytes(id) {
  let r;
  try { r = resolveRuleset(id); } catch (e) { throw new TeamCodeError('encode.ruleset', 'unknown ruleset ' + String(id)); }
  const parts = r.id.split('+');
  const base = BASE_IDS.indexOf(parts[0]);
  if (base < 0) throw new TeamCodeError('encode.ruleset', 'base ruleset ' + parts[0] + ' has no code');
  let bits = 0;
  for (const ly of parts.slice(1)) {
    const b = LAYER_BITS.indexOf(ly);
    if (b < 0) throw new TeamCodeError('encode.ruleset', 'ruleset layer ' + ly + ' has no code bit');
    bits |= 1 << b;
  }
  return { base, bits, id: r.id };
}
export function rulesetFromBytes(base, bits) {
  if (base >= BASE_IDS.length) return null;
  if (bits >> LAYER_BITS.length) return null;
  const layers = RULESET_LAYERS.filter((ly) => { const b = LAYER_BITS.indexOf(ly); return b >= 0 && (bits & (1 << b)); });
  try { return resolveRuleset([BASE_IDS[base], ...layers].join('+')).id; } catch (_e) { return null; }
}

// ---------------------------------------------------------------------------------------------
// binary encode
// ---------------------------------------------------------------------------------------------

const fail = (code, message, detail) => { throw new TeamCodeError(code, message, detail); };

function encodeText(s, max, code, what) {
  const why = textIssue(s, max);
  if (why) fail(code, `${what}: ${why}`);
  return defaultCodec.encode(s, { terminate: false });
}

function encodeMon(m, i, out, o) {
  const bad = (field, msg) => fail('encode.mon', `mon ${i}: ${field} ${msg}`, { index: i, field });
  if (!isObj(m)) bad('record', 'is not an object');
  if (!isInt(m.species, 1, 65535)) bad('species', 'must be an integer 1..65535');
  if (!isInt(m.heldItem, 0, 65535)) bad('heldItem', 'must be an integer 0..65535');
  if (!isInt(m.level, 1, 100)) bad('level', 'must be an integer 1..100');
  if (!isInt(m.nature, 0, 24)) bad('nature', 'must be an integer 0..24');
  if (!isInt(m.abilitySlot, 0, 2)) bad('abilitySlot', 'must be 0, 1 or 2');
  if (!hasOwn.call(GENDER_CODE, m.gender)) bad('gender', 'must be "M", "F" or "-"');
  if (typeof m.shiny !== 'boolean') bad('shiny', 'must be a boolean');
  if (!isInt(m.friendship, 0, 255)) bad('friendship', 'must be an integer 0..255');
  if (!isObj(m.ev) || !isObj(m.iv)) bad('ev/iv', 'must be keyed objects');
  for (const k of ROM_STAT_ORDER) {
    if (!isInt(m.ev[k], 0, 255)) bad(`ev.${k}`, 'must be an integer 0..255');
    if (!isInt(m.iv[k], 0, 31)) bad(`iv.${k}`, 'must be an integer 0..31');
  }
  if (!Array.isArray(m.moves) || m.moves.length < 1 || m.moves.length > 4) bad('moves', 'must be 1..4 entries');
  for (const mv of m.moves) if (!isObj(mv) || !isInt(mv.id, 1, 65535) || !isInt(mv.ppUps, 0, 3)) bad('moves', 'entries must be {id: 1..65535, ppUps: 0..3}');
  let nick;
  try { nick = encodeText(m.nickname, PROFILE_LIMITS.nickname, 'encode.mon', `mon ${i}: nickname`); } catch (e) { if (e instanceof TeamCodeError) throw new TeamCodeError('encode.mon', e.message, { index: i, field: 'nickname' }); throw e; }

  out[o] = m.species & 255; out[o + 1] = m.species >> 8;
  out[o + 2] = m.heldItem & 255; out[o + 3] = m.heldItem >> 8;
  out[o + 4] = m.level;
  out[o + 5] = m.nature;
  out[o + 6] = m.abilitySlot | (GENDER_CODE[m.gender] << 2) | (m.shiny ? 16 : 0);
  out[o + 7] = m.friendship;
  ROM_STAT_ORDER.forEach((k, n) => { out[o + 8 + n] = m.ev[k]; });
  let iv = 0;
  ROM_STAT_ORDER.forEach((k, n) => { iv |= m.iv[k] << (5 * n); });
  out[o + 14] = iv & 255; out[o + 15] = (iv >>> 8) & 255; out[o + 16] = (iv >>> 16) & 255; out[o + 17] = (iv >>> 24) & 255;
  let pp = 0;
  m.moves.forEach((mv, n) => { out[o + 18 + 2 * n] = mv.id & 255; out[o + 19 + 2 * n] = mv.id >> 8; pp |= mv.ppUps << (2 * n); });
  out[o + 26] = pp;
  for (let n = 0; n < NICK_BYTES; n++) out[o + 27 + n] = n < nick.length ? nick[n] : 0xff;
}

/** team = { name, ruleset, romSha256?, mons[] } (mons are profile records). Throws TeamCodeError('encode.*'). */
export function encodeTeamBinary(team) {
  if (!isObj(team) || !Array.isArray(team.mons)) fail('encode.team', 'expected {name, ruleset, mons[]}');
  const nameBytes = encodeText(team.name === undefined ? '' : team.name, TEAM_NAME_MAX, 'encode.name', 'team name');
  const rs = rulesetToBytes(team.ruleset);
  const rom = team.romSha256 === undefined ? PINNED.sha256 : team.romSha256;
  if (typeof rom !== 'string' || !/^[0-9a-f]{64}$/.test(rom)) fail('encode.rom', 'romSha256 must be 64 lowercase hex digits');
  if (team.mons.length < 1 || team.mons.length > TEAM_MAX_MONS) fail('encode.count', `a team card holds 1..${TEAM_MAX_MONS} Pokemon, got ${team.mons.length}`);
  const out = new Uint8Array(8 + nameBytes.length + 1 + team.mons.length * MON_BYTES);
  out[0] = TEAM_BINARY_VERSION; out[1] = rs.base; out[2] = rs.bits;
  for (let i = 0; i < 4; i++) out[3 + i] = parseInt(rom.slice(2 * i, 2 * i + 2), 16);
  out[7] = nameBytes.length;
  out.set(nameBytes, 8);
  out[8 + nameBytes.length] = team.mons.length;
  let o = 9 + nameBytes.length;
  team.mons.forEach((m, i) => { encodeMon(m, i, out, o); o += MON_BYTES; });
  return out;
}

// ---------------------------------------------------------------------------------------------
// binary decode (never throws; strict and canonical)
// ---------------------------------------------------------------------------------------------

const derr = (code, message, detail) => ({ ok: false, code, message, ...(detail || {}) });

function decodeMon(b, o, i) {
  const bad = (field, msg) => derr('binary.mon', `mon ${i}: ${field} ${msg}`, { index: i, field });
  const species = b[o] | (b[o + 1] << 8);
  if (species < 1) return bad('species', 'is 0');
  const heldItem = b[o + 2] | (b[o + 3] << 8);
  const level = b[o + 4];
  if (level < 1 || level > 100) return bad('level', 'is outside 1..100');
  const nature = b[o + 5];
  if (nature > 24) return bad('nature', 'is outside 0..24');
  const flags = b[o + 6];
  if (flags & 0xe0) return bad('flags', 'has reserved bits set');
  const abilitySlot = flags & 3;
  if (abilitySlot === 3) return bad('abilitySlot', 'is 3');
  const g = (flags >> 2) & 3;
  if (g === 3) return bad('gender', 'is 3');
  const shiny = (flags & 16) !== 0;
  const friendship = b[o + 7];
  const ev = {}, iv = {};
  ROM_STAT_ORDER.forEach((k, n) => { ev[k] = b[o + 8 + n]; });
  const ivw = (b[o + 14] | (b[o + 15] << 8) | (b[o + 16] << 16) | (b[o + 17] << 24)) >>> 0;
  if (ivw >>> 30) return bad('iv', 'has reserved bits set');
  ROM_STAT_ORDER.forEach((k, n) => { iv[k] = (ivw >>> (5 * n)) & 31; });
  const ids = [0, 1, 2, 3].map((n) => b[o + 18 + 2 * n] | (b[o + 19 + 2 * n] << 8));
  const pp = b[o + 26];
  let count = 0;
  while (count < 4 && ids[count] !== 0) count++;
  if (count === 0) return bad('moves', 'has no first move');
  for (let n = count; n < 4; n++) {
    if (ids[n] !== 0) return bad('moves', 'is not contiguous');
    if (((pp >> (2 * n)) & 3) !== 0) return bad('ppUps', 'is set for an empty move slot');
  }
  const moves = [];
  for (let n = 0; n < count; n++) moves.push({ id: ids[n], ppUps: (pp >> (2 * n)) & 3 });
  // nickname: charset bytes, then 0xFF padding to the end
  let end = 0;
  while (end < NICK_BYTES && b[o + 27 + end] !== 0xff) end++;
  for (let n = end; n < NICK_BYTES; n++) if (b[o + 27 + n] !== 0xff) return bad('nickname', 'has non-padding bytes after its terminator');
  const nb = b.subarray(o + 27, o + 27 + end);
  const nickname = defaultCodec.decode(nb);
  if (textIssue(nickname, NICK_BYTES) !== null || nickname.length !== end) return bad('nickname', 'is not canonical ROM-font text');
  return { ok: true, mon: { species, nickname, level, nature, abilitySlot, heldItem, moves, ev, iv, gender: GENDER_FROM[g], shiny, friendship } };
}

/** { ok:true, team:{name, ruleset, romId, mons[]} } | { ok:false, code, message, ... }. Never throws. */
export function decodeTeamBinary(bytes) {
  if (!(bytes instanceof Uint8Array)) return derr('binary.length', 'expected bytes');
  if (bytes.length < 9 || bytes.length > MAX_BINARY_BYTES) return derr('binary.length', `a card is 9..${MAX_BINARY_BYTES} bytes, got ${bytes.length}`);
  if (bytes[0] !== TEAM_BINARY_VERSION) return derr('binary.version', `unknown card version ${bytes[0]}`);
  const ruleset = rulesetFromBytes(bytes[1], bytes[2]);
  if (ruleset === null) return derr('binary.ruleset', 'the ruleset bytes name no valid ruleset');
  const n = bytes[7];
  if (n > TEAM_NAME_MAX || bytes.length < 9 + n) return derr('binary.name', 'the name length is out of range');
  const nameBytes = bytes.subarray(8, 8 + n);
  const name = defaultCodec.decode(nameBytes);
  if (textIssue(name, TEAM_NAME_MAX) !== null || name.length !== n) return derr('binary.name', 'the team name is not canonical ROM-font text');
  const count = bytes[8 + n];
  if (count < 1 || count > TEAM_MAX_MONS) return derr('binary.count', `the Pokemon count ${count} is not 1..${TEAM_MAX_MONS}`);
  if (bytes.length !== 9 + n + count * MON_BYTES) return derr('binary.length', `expected ${9 + n + count * MON_BYTES} bytes for ${count} Pokemon, got ${bytes.length}`);
  const mons = [];
  let o = 9 + n;
  for (let i = 0; i < count; i++, o += MON_BYTES) {
    const r = decodeMon(bytes, o, i);
    if (!r.ok) return r;
    mons.push(r.mon);
  }
  let romId = '';
  for (let i = 3; i < 7; i++) romId += bytes[i].toString(16).padStart(2, '0');
  return { ok: true, team: { name, ruleset, romId, mons } };
}

/** The fields a card carries, taken from a full profile record (what decode(encode(m)) must equal). */
export function battleView(m) {
  return {
    species: m.species, nickname: m.nickname, level: m.level, nature: m.nature, abilitySlot: m.abilitySlot, heldItem: m.heldItem,
    moves: m.moves.map((x) => ({ id: x.id, ppUps: x.ppUps })), ev: { ...m.ev }, iv: { ...m.iv }, gender: m.gender, shiny: m.shiny, friendship: m.friendship,
  };
}

/** SHA-256 (hex) of the card bytes: the stable identity of a team for a disc string / commit. */
export function cardHash(bytes) { return sha256Hex(bytes); }

// ---------------------------------------------------------------------------------------------
// the text code
// ---------------------------------------------------------------------------------------------

export async function encodeTeamCode(team) {
  const bin = encodeTeamBinary(team);
  if (!streamSupported('Compression', 'deflate-raw')) fail('code.unsupported', 'this browser cannot compress team codes');
  const deflated = await compressBytes(bin, 'deflate-raw');
  const head = TEAMCODE_PREFIX + '.' + b64urlEncode(deflated);
  return head + '.' + crcHex(enc(head));
}

/**
 * { ok:true, team, binary, hash } | { ok:false, code, message }. Never throws.
 * ROM PIN: the card must have been built for the PINNED ROM unless the caller says otherwise. opts.expectRomSha256 names a different
 * ROM to require; opts.allowRomMismatch (or expectRomSha256: null) turns the check off for a tool that inspects foreign cards. A caller that
 * says nothing gets the pin: the binding decision is that online features refuse every other ROM, so forgetting the option must not open the door.
 */
export async function decodeTeamCode(text, opts = {}) {
  try {
    if (typeof text !== 'string') return derr('code.empty', 'expected a string');
    const t = text.replace(/\s+/g, '');
    if (t === '') return derr('code.empty', 'the code is empty');
    if (t.length > MAX_CODE_CHARS) return derr('code.too-long', `the code is ${t.length} characters; the cap is ${MAX_CODE_CHARS}`);
    const parts = t.split('.');
    if (parts.length !== 3) return derr('code.format', 'a team code has the form ARENA1.<payload>.<check>');
    if (parts[0] !== TEAMCODE_PREFIX) return /^ARENA\d+$/.test(parts[0]) ? derr('code.version', `${parts[0]} codes are not supported by this build`) : derr('code.prefix', 'the code does not start with ARENA1');
    if (!/^[A-Za-z0-9_-]+$/.test(parts[1])) return derr('code.chars', 'the payload has characters outside the base64url alphabet');
    if (!/^[0-9a-fA-F]{4}$/.test(parts[2])) return derr('code.crc-format', 'the check value must be four hex digits');
    if (crcHex(enc(parts[0] + '.' + parts[1])) !== parts[2].toLowerCase()) return derr('code.crc', 'the check value does not match: a character was mistyped or the code was cut short');
    const deflated = b64urlDecode(parts[1]);
    if (deflated === null) return derr('code.base64', 'the payload is not canonical base64url');
    if (!streamSupported('Decompression', 'deflate-raw')) return derr('code.unsupported', 'this browser cannot decompress team codes');
    let bin;
    try { bin = await decompressBytes(deflated, 'deflate-raw', MAX_BINARY_BYTES); }
    catch (e) { return e && e.tooLarge ? derr('code.too-large', 'the payload decompresses to more than a team card can hold') : derr('code.inflate', 'the payload does not decompress'); }
    const r = decodeTeamBinary(bin);
    if (!r.ok) return r;
    const expectRom = opts.expectRomSha256 === undefined ? PINNED.sha256 : opts.expectRomSha256;
    if (expectRom !== null && !opts.allowRomMismatch && r.team.romId !== String(expectRom).slice(0, 8)) return derr('code.rom', 'this team was built for a different ROM', { have: r.team.romId, want: String(expectRom).slice(0, 8) });
    return { ok: true, team: r.team, binary: bin, hash: cardHash(bin) };
  } catch (e) {
    return derr('code.inflate', 'unexpected failure: ' + (e && e.message ? e.message : String(e)));
  }
}

// ---------------------------------------------------------------------------------------------
// helpers around a profile
// ---------------------------------------------------------------------------------------------

/** { name, ruleset, romSha256, mons[] } for one of a profile's teams. */
export function teamFromProfile(profile, teamId) {
  const t = profile.teams.find((x) => x.id === teamId);
  if (!t) throw new RangeError('no team ' + String(teamId));
  const byId = new Map(profile.box.map((m) => [m.id, m]));
  return { name: t.name, ruleset: t.ruleset, romSha256: profile.romSha256, mons: t.monIds.map((id) => byId.get(id)).filter(Boolean) };
}

/** Rules-level check of a decoded card (the opponent's incoming team): rules.js team + mon rules plus the gender check. */
export function validateDecodedTeam(team, pack) {
  return validateMonList(team.mons, pack, team.ruleset);
}

/** Full profile records for the mons of a decoded card (origin 'custom', provenance.source 'team-code'), ready for a box. */
export function monsFromDecoded(team, deps) {
  return team.mons.map((m) => createMon({ ...m, origin: 'custom', provenance: { source: 'team-code' } }, deps));
}

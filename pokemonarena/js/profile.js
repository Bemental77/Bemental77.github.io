// pokemonarena/js/profile.js -- the profile document: schema, migrations, validation, export/import, merge.
//
// Pure ES module (browser + Node 24). No DOM, no IndexedDB, no timers. The only ambient globals it touches are
// `crypto.getRandomValues` and `Date.now` inside defaultDeps() (everything else takes `deps = { now, randomBytes }`),
// plus TextEncoder/TextDecoder and, for .gz files only, CompressionStream / DecompressionStream.
//
// WHAT A PROFILE IS. There is no server: a profile is one JSON document that lives in the visitor's browser
// (store.js) and can be exported to a file (below). It holds the visitor's Pokemon box, their teams, their settings,
// self-reported battle stats and the PUBLIC half of their signing identity (identity.js). Nothing in it is ROM-derived
// content: species / move / item ids are numbers that index the tables the page decodes at runtime from the ROM.
//
// DERIVED STATS ARE NEVER STORED. A record keeps the inputs (species, level, nature, ability slot, item, moves, EVs,
// IVs, gender, shiny, friendship); max HP, Atk, ..., Hidden Power, effective EVs and the Champions-style "points" view
// are computed by stats.js from the record plus the pack. EV and IV are KEYED objects {hp, atk, def, spe, spa, spd}
// because the ROM struct order (hp, atk, def, spe, spa, spd) differs from the order every UI shows (hp, atk, def,
// spa, spd, spe); a fixed-order array exists only inside the binary team code (teamcode.js), where the order is pinned.
//
// SCHEMA VERSIONS. CURRENT = 5.
//   v1  the draft layout written down by the planning stage (docs/gba-link-and-arena-plan.md, research finding F5):
//       app 'arena', romHash, settings.defaultFormat, teams[].formatId, stats.byFormat, box[].ability = {slot},
//       box[].training = {sp}, box[].provenance.saveSha, a history[] list. No UI code was released against it; it is
//       kept readable because the plan names it and because it is the one real migration that proves the machinery.
//   v2  this module's layout (romSha256, ruleset ids as rules.js defines them, abilitySlot, identity, no history).
//   v3  the career record: `stats` gains firstMatchAt, playMs, byFormat, byCpu, totals, bests, fav and recent (career_stats.js says what each holds and its
//       limits). Nothing else changes. The migration keeps every v2 counter and fills the new keys with zeros; a v2 document that already carried a key of
//       that name has it moved into the unknown bag first. An older build opens a v3 document read-only (it is "newer"), as for any future version.
//   v4  online play: a battle against a person is kept like any other. `stats.byCpu` gains an `online` record {w, l, dr, f} (next to easy / normal / hard) and a `stats.recent`
//       entry may be an online match (cpu 'online' plus `opp`, the opponent's name). Nothing else changes. The migration adds byCpu.online = zeros and keeps every other value; a v3
//       document that already had a byCpu.online which is not a {w, l, dr, f} record keeps it in the unknown bag first. A build that only knows v3 opens a v4 document read-only.
//       NOTE for whoever deploys this: a stored v3 profile is upgraded the first time this build loads it (store.loadProfile writes a changed document back, the v3 one going to history).
//   v5  the Pokemon Tower: a top-level `tower` section (tower_record.js has its layout: best floor per format, runs, wins, buffs seen, achievements earned, the run under way, a summary of the last run). It is the
//       Tower's own record and NOTHING ELSE: a Tower battle is never written into `stats` (totals, byCpu, online, recent are the regular career's), and recording a match or resetting the record never touches `tower`.
//       The migration adds `tower` = an empty record and keeps every other value; a v4 document that already had a key of that name (it was not valid v4) keeps it in the unknown bag first. A build that only
//       knows v4 opens a v5 document read-only. NOTE for whoever deploys this: a stored v4 profile is upgraded the first time this build loads it (the v4 one going to history), as the v3 ones were.
// MIGRATIONS are pure functions of their input (they clone first and never throw on JSON input), run in order until
// schemaVersion == CURRENT, and the whole chain is idempotent (a current document is returned unchanged). Fields the
// next version does not model are NOT dropped: they are moved into the unknown-field bag `_unknown`.
// A document NEWER than this build is never migrated, rewritten or down-converted: it opens read-only (store.js) and
// export of it still works.
//
// THE UNKNOWN-FIELD BAG. Any key an object of the schema does not know is carried under `_unknown` on that same
// object (profile root, a Pokemon record, a team, and the small fixed sub-objects), untouched by normalisation and
// exported again where it was found. `_unknown` is present only when it holds something.
//
// TWO KINDS OF "INVALID". (1) SHAPE: wrong type / out of range / unencodable text. A record that fails shape is moved
// out of the box into the quarantine list with its raw JSON and the reasons, never silently repaired. (2) RULES:
// legality against a pack and a ruleset (rules.js validateMon). The box may hold records that are illegal for the
// strict ruleset; editing never deletes or clamps data. Legality bites at the team screen and at the battle gate.
//
// WHAT THE EXPORT CHECKSUM IS NOT. It is a SHA-256 of the canonical profile JSON. It detects truncation and hand
// edits that keep the JSON parseable. It is not authentication: anyone can edit a file and recompute it.

import { STAT_ORDER, LIMITS, canonicalJSON, evsToPoints } from './stats.js';
import { resolveRuleset, validateMon, validateTeam, DEFAULT_RULESET_ID } from './rules.js';
import { defaultCodec } from './charset.js';
import { PINNED, sha256Hex } from './rom.js';
import { emptyCareer, CAREER_KEYS, checkCareer, normalizeCareer, foldMatch, matchIssue, battleCount } from './career_stats.js';
import { emptyTower, checkTowerShape, normalizeTower, capBag, fitRejected } from './tower_record.js';

// ---------------------------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------------------------

export const APP_ID = 'pokemonarena';
export const SCHEMA_VERSION = 5;
export const EXPORT_FORMAT = 'pokemonarena-profile';
export const EXPORT_VERSION = 1;
export const EXPORT_MAX_BYTES = 8 * 1024 * 1024;
export const FILE_SUFFIX = '.pokemonarena.json';

export const PROFILE_LIMITS = Object.freeze({
  trainerName: 10, nickname: 10, teamName: 16, otName: 10,
  idLength: 40, boxMax: 2000, teamsMax: 16, teamSize: 6, movesMax: 4, ppUpsMax: 3,
  u8: 255, u16: 65535, u32: 4294967295, depthMax: 48, byRulesetMax: 64, previousKeysMax: 16,
});
export const ORIGINS = Object.freeze(['rental', 'save-import', 'custom']);
export const GENDERS = Object.freeze(['M', 'F', '-']);
export const SETTING_ENUMS = Object.freeze({
  animations: Object.freeze(['full', 'fast', 'off']),
  textSpeed: Object.freeze(['slow', 'mid', 'fast']),
  trainingMode: Object.freeze(['gen3', 'champions']),
});

/** Every shape / document problem code this module can emit. The test requires a bad-input case for each. */
export const PROFILE_CODES = Object.freeze({
  'profile.shape': 'the profile is not an object',
  'profile.version': 'schemaVersion is not the current version (migrate first)',
  'profile.app': 'app is not "pokemonarena"',
  'profile.id': 'id is not a valid identifier',
  'profile.rom': 'romSha256 is not 64 lowercase hex digits',
  'profile.private-key': 'private key material (a JWK with d/p/q/...) is present; it is never accepted or exported',
  'profile.rev': 'rev is not a non-negative integer',
  'profile.time': 'createdAt / updatedAt is not a non-negative integer',
  'profile.trainer-name': 'trainerName is empty, too long or not ROM-font text',
  'profile.avatar': 'avatar is not {kind: "preset"|"mon", id: integer}',
  'profile.settings': 'settings is not an object, or a setting has an invalid value',
  'profile.teams': 'teams is not an array, or has too many entries',
  'profile.box': 'box is not an array, or has too many entries',
  'profile.stats': 'stats is not an object, or a counter is not a non-negative integer',
  'profile.identity': 'identity is not {publicKeyJwk, previousKeys}, or a JWK is not a public P-256 key',
  'profile.tower': 'tower is not a well-formed Tower record (tower_record.js)',
  'profile.unknown-bag': '_unknown is present and is not an object',
  'team.shape': 'a team is not an object',
  'team.id': 'team id is not a valid identifier',
  'team.name': 'team name is empty, too long or not ROM-font text',
  'team.ruleset': 'team ruleset is not a ruleset id rules.js can resolve',
  'team.mon-ids': 'team monIds is not an array of at most 6 distinct box ids',
  'team.missing-mon': 'a team lists a mon id that is not in the box',
  'team.duplicate-id': 'two teams share an id',
  'mon.shape': 'the record is not an object',
  'mon.id': 'id is not a valid identifier',
  'mon.duplicate-id': 'two records share an id',
  'mon.species': 'species is not an integer 1..65535',
  'mon.nickname': 'nickname is too long or not ROM-font text',
  'mon.level': 'level is not an integer 1..100',
  'mon.nature': 'nature is not an integer 0..24',
  'mon.ability-slot': 'abilitySlot is not 0, 1 or 2',
  'mon.held-item': 'heldItem is not an integer 0..65535',
  'mon.moves': 'moves is not an array of 1..4 entries',
  'mon.move': 'a move is not {id: integer 1..65535, ppUps: integer 0..3}',
  'mon.ev': 'ev is not a keyed object of six integers 0..255',
  'mon.iv': 'iv is not a keyed object of six integers 0..31',
  'mon.gender': 'gender is not "M", "F" or "-"',
  'mon.shiny': 'shiny is not a boolean',
  'mon.friendship': 'friendship is not an integer 0..255',
  'mon.original-trainer': 'originalTrainer is not {name, tid, sid}',
  'mon.origin': 'origin is not rental, save-import or custom',
  'mon.provenance': 'provenance is not an object with well-typed known fields',
  'mon.time': 'createdAt / updatedAt is not a non-negative integer',
  'mon.unknown-bag': '_unknown is present and is not an object',
  'mon.gender-species': 'the gender is impossible for the species (pack check)',
});

export class ProfileError extends Error {
  constructor(code, message, problems) {
    super(message);
    this.name = 'ProfileError';
    this.code = code;
    this.problems = problems || [];
  }
}

// ---------------------------------------------------------------------------------------------
// small utilities
// ---------------------------------------------------------------------------------------------

const hasOwn = Object.prototype.hasOwnProperty;
const isObj = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const clone = (o) => JSON.parse(JSON.stringify(o));
const enc = (s) => new TextEncoder().encode(s);
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
export const isId = (s) => typeof s === 'string' && ID_RE.test(s);
const SHA_RE = /^[0-9a-f]{64}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;
const TIME_MAX = 8.64e15; // the largest Date value; anything above is not a timestamp

function setOwn(o, k, v) { // never assigns through __proto__
  Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
}
function unknownOf(src, known) {
  let bag = null;
  for (const k of Object.keys(src)) {
    if (known.includes(k)) continue;
    if (k === '_unknown') continue;
    bag = bag || {};
    setOwn(bag, k, src[k]);
  }
  return bag;
}
function mergeBag(a, b) { // keys already in `a` win
  if (!b) return a;
  const o = a ? { ...a } : {};
  for (const k of Object.keys(b)) if (!hasOwn.call(o, k)) setOwn(o, k, b[k]);
  return o;
}

/** Nesting deeper than `limit` (iterative: no recursion, so hostile input cannot overflow the stack). */
export function tooDeep(value, limit = PROFILE_LIMITS.depthMax) {
  const stack = [[value, 0]];
  while (stack.length) {
    const [v, d] = stack.pop();
    if (v !== null && typeof v === 'object') {
      if (d >= limit) return true;
      for (const k of Object.keys(v)) stack.push([v[k], d + 1]);
    }
  }
  return false;
}

const PRIVATE_JWK_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'k', 'oth'];
/** True if ANY object anywhere in `value` looks like a JWK carrying private / secret members. */
export function containsPrivateJwk(value) {
  const stack = [value];
  let n = 0;
  while (stack.length && n++ < 200000) {
    const v = stack.pop();
    if (v === null || typeof v !== 'object') continue;
    if (!Array.isArray(v) && hasOwn.call(v, 'kty') && PRIVATE_JWK_MEMBERS.some((m) => hasOwn.call(v, m))) return true;
    for (const k of Object.keys(v)) stack.push(v[k]);
  }
  return false;
}

// ---- base64url (RFC 4648 section 5, no padding), strict on decode: shared by team codes and receipt signatures
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64_INDEX = (() => { const t = new Int16Array(128).fill(-1); for (let i = 0; i < 64; i++) t[B64.charCodeAt(i)] = i; return t; })();

export function b64urlEncode(bytes) {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) { const n = bytes[i] << 16; out += B64[n >> 18] + B64[(n >> 12) & 63]; }
  else if (rest === 2) { const n = (bytes[i] << 16) | (bytes[i + 1] << 8); out += B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63]; }
  return out;
}
/** Strict: only the alphabet, no padding, and the unused trailing bits of the last character must be zero. Returns null if not canonical. */
export function b64urlDecode(s) {
  if (typeof s !== 'string') return null;
  const n = s.length;
  if (n % 4 === 1) return null;
  const vals = new Array(n);
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i);
    const v = c < 128 ? B64_INDEX[c] : -1;
    if (v < 0) return null;
    vals[i] = v;
  }
  if (n % 4 === 2 && (vals[n - 1] & 0x0f) !== 0) return null;
  if (n % 4 === 3 && (vals[n - 1] & 0x03) !== 0) return null;
  const out = new Uint8Array(Math.floor(n * 3 / 4));
  let o = 0;
  let i = 0;
  for (; i + 3 < n; i += 4) {
    const v = (vals[i] << 18) | (vals[i + 1] << 12) | (vals[i + 2] << 6) | vals[i + 3];
    out[o++] = v >> 16; out[o++] = (v >> 8) & 255; out[o++] = v & 255;
  }
  if (n % 4 === 2) out[o++] = (vals[i] << 2) | (vals[i + 1] >> 4);
  else if (n % 4 === 3) { out[o++] = (vals[i] << 2) | (vals[i + 1] >> 4); out[o++] = ((vals[i + 1] & 15) << 4) | (vals[i + 2] >> 2); }
  return out;
}

export function defaultDeps() {
  return {
    now: () => Date.now(),
    randomBytes: (n) => { const b = new Uint8Array(n); globalThis.crypto.getRandomValues(b); return b; },
  };
}
function depsOf(d) {
  const base = defaultDeps();
  return { now: (d && d.now) || base.now, randomBytes: (d && d.randomBytes) || base.randomBytes };
}
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
/** prefix + '_' + 16 hex digits from deps.randomBytes(8). */
export function newId(prefix, deps) {
  return `${prefix}_${hex(depsOf(deps).randomBytes(8))}`;
}

/** null if `s` is acceptable ROM-font text of at most `max` characters, else a short reason. The ROM font is the
 *  Gen-3 charset (charset.js): every character must encode, and must decode back to the SAME character (so alias
 *  spellings such as U+2019, which the encoder maps to the apostrophe tile, are rejected rather than silently changed
 *  on the first round trip through a team code). Braces are refused: they are charset.js token syntax. */
export function textIssue(s, max) {
  if (typeof s !== 'string') return 'type';
  if (s.length > max) return 'length';
  if (/[{}]/.test(s) || CONTROL_RE.test(s)) return 'chars';
  let bytes;
  try { bytes = defaultCodec.encode(s, { terminate: false }); } catch (_e) { return 'charset'; }
  if (defaultCodec.decode(bytes) !== s) return 'charset';
  return null;
}

// ---------------------------------------------------------------------------------------------
// defaults and constructors
// ---------------------------------------------------------------------------------------------

export function defaultSettings() {
  return { defaultRuleset: DEFAULT_RULESET_ID, animations: 'full', textSpeed: 'mid', sound: true, reducedMotion: false, trainingMode: 'gen3', backupNudgeDays: 14 };
}
export function emptyStats() {
  return { wins: 0, losses: 0, draws: 0, forfeits: 0, streak: 0, best: 0, lastMatchAt: null, byRuleset: {}, ...emptyCareer() };
}
export function emptyIdentity() { return { publicKeyJwk: null, previousKeys: [] }; }
function statBlock(v) { const o = {}; for (const k of STAT_ORDER) o[k] = v; return o; }

/** A new, unsaved (rev 0) profile. */
export function createProfile(init = {}, deps) {
  const d = depsOf(deps);
  const now = d.now();
  const p = {
    app: APP_ID, schemaVersion: SCHEMA_VERSION, id: init.id || newId('p', d), rev: 0,
    createdAt: now, updatedAt: now, romSha256: init.romSha256 || PINNED.sha256,
    trainerName: init.trainerName === undefined ? 'TRAINER' : init.trainerName,
    avatar: init.avatar || { kind: 'preset', id: 0 },
    settings: { ...defaultSettings(), ...(init.settings || {}) },
    teams: [], box: [], stats: emptyStats(), identity: emptyIdentity(), tower: emptyTower(),
  };
  const bad = checkProfile(p);
  if (bad.length) throw new ProfileError('profile.invalid', 'createProfile: ' + bad.map((x) => x.code + ' ' + x.path).join(', '), bad);
  return p;
}

/** A new Pokemon record. `f` supplies species (required) and any other field; moves may be ids or {id, ppUps}. */
export function createMon(f, deps) {
  const d = depsOf(deps);
  const now = d.now();
  const m = {
    id: f.id || newId('m', d), species: f.species, nickname: f.nickname === undefined ? '' : f.nickname,
    level: f.level === undefined ? 50 : f.level, nature: f.nature === undefined ? 0 : f.nature,
    abilitySlot: f.abilitySlot === undefined ? 0 : f.abilitySlot, heldItem: f.heldItem === undefined ? 0 : f.heldItem,
    moves: (f.moves || []).map((x) => (typeof x === 'number' ? { id: x, ppUps: 0 } : { id: x.id, ppUps: x.ppUps === undefined ? 0 : x.ppUps })),
    ev: f.ev ? { ...f.ev } : statBlock(0), iv: f.iv ? { ...f.iv } : statBlock(31),
    gender: f.gender === undefined ? '-' : f.gender, shiny: !!f.shiny, friendship: f.friendship === undefined ? 70 : f.friendship,
    originalTrainer: f.originalTrainer ? { ...f.originalTrainer } : { name: '', tid: 0, sid: 0 },
    origin: f.origin || 'custom', provenance: f.provenance ? { ...f.provenance } : {}, createdAt: now, updatedAt: now,
  };
  const bad = checkMon(m, 'mon');
  if (bad.length) throw new ProfileError('mon.invalid', 'createMon: ' + bad.map((x) => x.code + ' ' + x.path).join(', '), bad);
  return m;
}

export function createTeam(f, deps) {
  const t = { id: f.id || newId('t', deps), name: f.name === undefined ? 'TEAM' : f.name, ruleset: f.ruleset || DEFAULT_RULESET_ID, monIds: (f.monIds || []).slice() };
  const bad = checkTeam(t, 'team', null);
  if (bad.length) throw new ProfileError('team.invalid', 'createTeam: ' + bad.map((x) => x.code + ' ' + x.path).join(', '), bad);
  return t;
}

// ---------------------------------------------------------------------------------------------
// strict shape checks (no repair): the single definition of "well-formed", used at save time and by normalisation
// ---------------------------------------------------------------------------------------------

const reporter = (list, path0) => (code, path, message, extra) => list.push({ code, path: path === undefined ? path0 : path, message, ...(extra || {}) });

function checkStatBlock(block, path, hi, code, add) {
  if (!isObj(block)) { add(code, path, `${path} must be an object keyed hp/atk/def/spe/spa/spd`); return false; }
  let ok = true;
  for (const k of STAT_ORDER) {
    if (!hasOwn.call(block, k)) { add(code, `${path}.${k}`, `${path}.${k} is missing`); ok = false; }
    else if (!isInt(block[k], 0, hi)) { add(code, `${path}.${k}`, `${path}.${k} must be an integer 0..${hi}`); ok = false; }
  }
  for (const k of Object.keys(block)) if (!STAT_ORDER.includes(k)) { add(code, `${path}.${k}`, `${path}.${k} is not a stat key`); ok = false; }
  return ok;
}

const MON_KEYS = ['id', 'species', 'nickname', 'level', 'nature', 'abilitySlot', 'heldItem', 'moves', 'ev', 'iv', 'gender', 'shiny',
  'friendship', 'originalTrainer', 'origin', 'provenance', 'createdAt', 'updatedAt'];
const PROV_KEYS = ['source', 'saveSha256', 'slot', 'box', 'pid', 'otId'];
const OT_KEYS = ['name', 'tid', 'sid'];

function checkProvenance(p, path, add) {
  if (!isObj(p)) { add('mon.provenance', path, 'provenance must be an object'); return; }
  const bad = (k, why) => add('mon.provenance', `${path}.${k}`, `${path}.${k} ${why}`);
  if (hasOwn.call(p, 'source') && !(typeof p.source === 'string' && p.source.length >= 1 && p.source.length <= 32 && !CONTROL_RE.test(p.source))) bad('source', 'must be a short string');
  if (hasOwn.call(p, 'saveSha256') && !(typeof p.saveSha256 === 'string' && SHA_RE.test(p.saveSha256))) bad('saveSha256', 'must be 64 lowercase hex digits');
  for (const k of ['slot', 'box']) if (hasOwn.call(p, k) && !isInt(p[k], 0, PROFILE_LIMITS.u16)) bad(k, 'must be an integer 0..65535');
  for (const k of ['pid', 'otId']) if (hasOwn.call(p, k) && !isInt(p[k], 0, PROFILE_LIMITS.u32)) bad(k, 'must be an integer 0..4294967295');
  if (hasOwn.call(p, '_unknown') && !isObj(p._unknown)) add('mon.unknown-bag', `${path}._unknown`, '_unknown must be an object');
  for (const k of Object.keys(p)) if (!PROV_KEYS.includes(k) && k !== '_unknown') bad(k, 'is not a provenance field; unknown keys belong in _unknown');
}

/** Shape problems of one Pokemon record ([] = well formed). Pack / ruleset questions are NOT asked here. */
export function checkMon(m, path = 'mon') {
  const list = [];
  const add = reporter(list, path);
  if (!isObj(m)) { add('mon.shape', path, 'the record must be an object'); return list; }
  if (!isId(m.id)) add('mon.id', `${path}.id`, 'id must match [A-Za-z0-9_-]{1,40}');
  if (!isInt(m.species, 1, PROFILE_LIMITS.u16)) add('mon.species', `${path}.species`, 'species must be an integer 1..65535');
  { const why = textIssue(m.nickname, PROFILE_LIMITS.nickname); if (why) add('mon.nickname', `${path}.nickname`, `nickname: ${why}`); }
  if (!isInt(m.level, LIMITS.levelMin, LIMITS.levelMax)) add('mon.level', `${path}.level`, `level must be an integer ${LIMITS.levelMin}..${LIMITS.levelMax}`);
  if (!isInt(m.nature, 0, 24)) add('mon.nature', `${path}.nature`, 'nature must be an integer 0..24');
  if (!isInt(m.abilitySlot, 0, 2)) add('mon.ability-slot', `${path}.abilitySlot`, 'abilitySlot must be 0, 1 or 2');
  if (!isInt(m.heldItem, 0, PROFILE_LIMITS.u16)) add('mon.held-item', `${path}.heldItem`, 'heldItem must be an integer 0..65535');
  if (!Array.isArray(m.moves) || m.moves.length < 1 || m.moves.length > PROFILE_LIMITS.movesMax) add('mon.moves', `${path}.moves`, 'moves must be an array of 1..4 entries');
  else {
    m.moves.forEach((mv, i) => {
      const p = `${path}.moves[${i}]`;
      const keysOk = isObj(mv) && Object.keys(mv).length === 2 && hasOwn.call(mv, 'id') && hasOwn.call(mv, 'ppUps');
      if (!keysOk || !isInt(mv.id, 1, PROFILE_LIMITS.u16) || !isInt(mv.ppUps, 0, PROFILE_LIMITS.ppUpsMax)) add('mon.move', p, 'a move must be {id: 1..65535, ppUps: 0..3}');
    });
  }
  checkStatBlock(m.ev, `${path}.ev`, LIMITS.evMax, 'mon.ev', add);
  checkStatBlock(m.iv, `${path}.iv`, LIMITS.ivMax, 'mon.iv', add);
  if (!GENDERS.includes(m.gender)) add('mon.gender', `${path}.gender`, 'gender must be "M", "F" or "-"');
  if (typeof m.shiny !== 'boolean') add('mon.shiny', `${path}.shiny`, 'shiny must be a boolean');
  if (!isInt(m.friendship, 0, PROFILE_LIMITS.u8)) add('mon.friendship', `${path}.friendship`, 'friendship must be an integer 0..255');
  { const ot = m.originalTrainer;
    if (!isObj(ot)) add('mon.original-trainer', `${path}.originalTrainer`, 'originalTrainer must be {name, tid, sid}');
    else {
      const why = textIssue(ot.name, PROFILE_LIMITS.otName);
      if (why) add('mon.original-trainer', `${path}.originalTrainer.name`, `originalTrainer.name: ${why}`);
      for (const k of ['tid', 'sid']) if (!isInt(ot[k], 0, PROFILE_LIMITS.u16)) add('mon.original-trainer', `${path}.originalTrainer.${k}`, `originalTrainer.${k} must be an integer 0..65535`);
      for (const k of Object.keys(ot)) if (!OT_KEYS.includes(k) && k !== '_unknown') add('mon.original-trainer', `${path}.originalTrainer.${k}`, 'unexpected key');
    }
  }
  if (!ORIGINS.includes(m.origin)) add('mon.origin', `${path}.origin`, 'origin must be rental, save-import or custom');
  checkProvenance(m.provenance, `${path}.provenance`, add);
  for (const k of ['createdAt', 'updatedAt']) if (!isInt(m[k], 0, TIME_MAX)) add('mon.time', `${path}.${k}`, `${k} must be a non-negative integer`);
  if (hasOwn.call(m, '_unknown') && !isObj(m._unknown)) add('mon.unknown-bag', `${path}._unknown`, '_unknown must be an object');
  for (const k of Object.keys(m)) if (!MON_KEYS.includes(k) && k !== '_unknown') add('mon.shape', `${path}.${k}`, `unexpected key ${k}: unknown keys belong in _unknown`);
  return list;
}

function rulesetOk(id) {
  if (typeof id !== 'string') return false;
  try { return resolveRuleset(id).id === id; } catch (_e) { return false; }
}

const TEAM_KEYS = ['id', 'name', 'ruleset', 'monIds'];
/** Shape problems of one team. `boxIds` (a Set) additionally checks that every listed mon exists; null skips that. */
export function checkTeam(t, path = 'team', boxIds = null) {
  const list = [];
  const add = reporter(list, path);
  if (!isObj(t)) { add('team.shape', path, 'a team must be an object'); return list; }
  if (!isId(t.id)) add('team.id', `${path}.id`, 'id must match [A-Za-z0-9_-]{1,40}');
  { const why = typeof t.name === 'string' && t.name.trim() === '' ? 'empty' : textIssue(t.name, PROFILE_LIMITS.teamName); if (why) add('team.name', `${path}.name`, `name: ${why}`); }
  if (!rulesetOk(t.ruleset)) add('team.ruleset', `${path}.ruleset`, 'ruleset must be a canonical ruleset id');
  if (!Array.isArray(t.monIds) || t.monIds.length > PROFILE_LIMITS.teamSize || !t.monIds.every(isId) || new Set(t.monIds).size !== t.monIds.length) add('team.mon-ids', `${path}.monIds`, 'monIds must be at most 6 distinct valid ids');
  else if (boxIds) for (const id of t.monIds) if (!boxIds.has(id)) add('team.missing-mon', `${path}.monIds`, `mon ${id} is not in the box`, { monId: id });
  if (hasOwn.call(t, '_unknown') && !isObj(t._unknown)) add('profile.unknown-bag', `${path}._unknown`, '_unknown must be an object');
  for (const k of Object.keys(t)) if (!TEAM_KEYS.includes(k) && k !== '_unknown') add('team.shape', `${path}.${k}`, `unexpected key ${k}: unknown keys belong in _unknown`);
  return list;
}

/** A JWK is accepted only as {kty:'EC', crv:'P-256', x, y} with 43-char base64url coordinates and nothing private. */
export function isPublicJwk(j) {
  if (!isObj(j)) return false;
  const keys = Object.keys(j);
  if (keys.length !== 4 || !['kty', 'crv', 'x', 'y'].every((k) => keys.includes(k))) return false;
  return j.kty === 'EC' && j.crv === 'P-256' && /^[A-Za-z0-9_-]{43}$/.test(j.x) && /^[A-Za-z0-9_-]{43}$/.test(j.y);
}

const PROFILE_KEYS = ['app', 'schemaVersion', 'id', 'rev', 'createdAt', 'updatedAt', 'romSha256', 'trainerName', 'avatar', 'settings', 'teams', 'box', 'stats', 'identity', 'tower'];
const SETTINGS_KEYS = ['defaultRuleset', 'animations', 'textSpeed', 'sound', 'reducedMotion', 'trainingMode', 'backupNudgeDays'];
const STATS_KEYS = ['wins', 'losses', 'draws', 'forfeits', 'streak', 'best', 'lastMatchAt', 'byRuleset', ...CAREER_KEYS];
const COUNTERS = ['wins', 'losses', 'draws', 'forfeits', 'streak', 'best'];

function checkSettings(s, add) {
  if (!isObj(s)) { add('profile.settings', 'settings', 'settings must be an object'); return; }
  if (!rulesetOk(s.defaultRuleset)) add('profile.settings', 'settings.defaultRuleset', 'defaultRuleset must be a canonical ruleset id');
  for (const k of Object.keys(SETTING_ENUMS)) if (!SETTING_ENUMS[k].includes(s[k])) add('profile.settings', `settings.${k}`, `${k} must be one of ${SETTING_ENUMS[k].join(', ')}`);
  for (const k of ['sound', 'reducedMotion']) if (typeof s[k] !== 'boolean') add('profile.settings', `settings.${k}`, `${k} must be a boolean`);
  if (!isInt(s.backupNudgeDays, 0, 365)) add('profile.settings', 'settings.backupNudgeDays', 'backupNudgeDays must be an integer 0..365');
  for (const k of Object.keys(s)) if (!SETTINGS_KEYS.includes(k) && k !== '_unknown') add('profile.settings', `settings.${k}`, `unexpected key ${k}`);
}
function checkStats(s, add) {
  if (!isObj(s)) { add('profile.stats', 'stats', 'stats must be an object'); return; }
  for (const k of COUNTERS) if (!isInt(s[k], 0, Number.MAX_SAFE_INTEGER)) add('profile.stats', `stats.${k}`, `${k} must be a non-negative integer`);
  if (!(s.lastMatchAt === null || isInt(s.lastMatchAt, 0, TIME_MAX))) add('profile.stats', 'stats.lastMatchAt', 'lastMatchAt must be null or a non-negative integer');
  if (!isObj(s.byRuleset)) add('profile.stats', 'stats.byRuleset', 'byRuleset must be an object');
  else {
    const ks = Object.keys(s.byRuleset);
    if (ks.length > PROFILE_LIMITS.byRulesetMax) add('profile.stats', 'stats.byRuleset', 'too many entries');
    for (const k of ks) {
      const e = s.byRuleset[k];
      if (!rulesetOk(k) || !isObj(e) || !isInt(e.w, 0, Number.MAX_SAFE_INTEGER) || !isInt(e.l, 0, Number.MAX_SAFE_INTEGER) || Object.keys(e).length !== 2) add('profile.stats', `stats.byRuleset.${k}`, 'entries are {w, l} keyed by a canonical ruleset id');
    }
  }
  checkCareer(s, add);
  for (const k of Object.keys(s)) if (!STATS_KEYS.includes(k) && k !== '_unknown') add('profile.stats', `stats.${k}`, `unexpected key ${k}`);
}
function checkIdentity(i, add) {
  if (!isObj(i)) { add('profile.identity', 'identity', 'identity must be an object'); return; }
  if (!(i.publicKeyJwk === null || isPublicJwk(i.publicKeyJwk))) add('profile.identity', 'identity.publicKeyJwk', 'publicKeyJwk must be null or a public P-256 JWK');
  if (!Array.isArray(i.previousKeys) || i.previousKeys.length > PROFILE_LIMITS.previousKeysMax) add('profile.identity', 'identity.previousKeys', 'previousKeys must be an array of at most 16 entries');
  else i.previousKeys.forEach((k, n) => {
    if (!isObj(k) || Object.keys(k).some((x) => x !== 'publicKeyJwk' && x !== 'retiredAt' && x !== 'reason') || !isPublicJwk(k.publicKeyJwk) || !isInt(k.retiredAt, 0, TIME_MAX) || !(k.reason === undefined || (typeof k.reason === 'string' && k.reason.length <= 40 && !CONTROL_RE.test(k.reason)))) add('profile.identity', `identity.previousKeys[${n}]`, 'entries are {publicKeyJwk, retiredAt, reason?}');
  });
  for (const k of Object.keys(i)) if (k !== 'publicKeyJwk' && k !== 'previousKeys' && k !== '_unknown') add('profile.identity', `identity.${k}`, `unexpected key ${k}`);
}

/** Strict shape problems of a whole profile document at CURRENT version ([] = well formed). */
export function checkProfile(p) {
  const list = [];
  const add = reporter(list, '');
  if (!isObj(p)) { add('profile.shape', '', 'a profile must be an object'); return list; }
  if (p.schemaVersion !== SCHEMA_VERSION) add('profile.version', 'schemaVersion', `schemaVersion must be ${SCHEMA_VERSION}`);
  if (p.app !== APP_ID) add('profile.app', 'app', `app must be "${APP_ID}"`);
  if (!isId(p.id)) add('profile.id', 'id', 'id must match [A-Za-z0-9_-]{1,40}');
  if (!isInt(p.rev, 0, Number.MAX_SAFE_INTEGER)) add('profile.rev', 'rev', 'rev must be a non-negative integer');
  for (const k of ['createdAt', 'updatedAt']) if (!isInt(p[k], 0, TIME_MAX)) add('profile.time', k, `${k} must be a non-negative integer`);
  if (typeof p.romSha256 !== 'string' || !SHA_RE.test(p.romSha256)) add('profile.rom', 'romSha256', 'romSha256 must be 64 lowercase hex digits');
  { const why = typeof p.trainerName === 'string' && p.trainerName.trim() === '' ? 'empty' : textIssue(p.trainerName, PROFILE_LIMITS.trainerName); if (why) add('profile.trainer-name', 'trainerName', `trainerName: ${why}`); }
  if (!isObj(p.avatar) || !['preset', 'mon'].includes(p.avatar.kind) || !isInt(p.avatar.id, 0, PROFILE_LIMITS.u16)
    || Object.keys(p.avatar).some((k) => k !== 'kind' && k !== 'id' && k !== '_unknown')) add('profile.avatar', 'avatar', 'avatar must be {kind: "preset"|"mon", id}');
  checkSettings(p.settings, add);
  checkStats(p.stats, add);
  checkIdentity(p.identity, add);
  for (const why of checkTowerShape(p.tower).slice(0, 3)) add('profile.tower', 'tower', 'tower: ' + why);
  if (containsPrivateJwk(p)) add('profile.private-key', 'identity', 'private key material is present');
  if (!Array.isArray(p.box) || p.box.length > PROFILE_LIMITS.boxMax) add('profile.box', 'box', `box must be an array of at most ${PROFILE_LIMITS.boxMax} records`);
  const ids = new Set();
  if (Array.isArray(p.box)) p.box.forEach((m, i) => {
    for (const x of checkMon(m, `box[${i}]`)) list.push(x);
    if (isObj(m) && isId(m.id)) { if (ids.has(m.id)) add('mon.duplicate-id', `box[${i}].id`, `duplicate mon id ${m.id}`); ids.add(m.id); }
  });
  if (!Array.isArray(p.teams) || p.teams.length > PROFILE_LIMITS.teamsMax) add('profile.teams', 'teams', `teams must be an array of at most ${PROFILE_LIMITS.teamsMax} entries`);
  else {
    const tids = new Set();
    p.teams.forEach((t, i) => {
      for (const x of checkTeam(t, `teams[${i}]`, ids)) list.push(x);
      if (isObj(t) && isId(t.id)) { if (tids.has(t.id)) add('team.duplicate-id', `teams[${i}].id`, `duplicate team id ${t.id}`); tids.add(t.id); }
    });
  }
  if (hasOwn.call(p, '_unknown') && !isObj(p._unknown)) add('profile.unknown-bag', '_unknown', '_unknown must be an object');
  for (const k of Object.keys(p)) if (!PROFILE_KEYS.includes(k) && k !== '_unknown') add('profile.shape', k, `unexpected key ${k}: unknown keys belong in _unknown`);
  return list;
}

// ---------------------------------------------------------------------------------------------
// migrations
// ---------------------------------------------------------------------------------------------

/** v1 format ids (the planning draft) -> ruleset ids. Only the unambiguous ones; others keep the default ruleset and
 *  the original id is carried in the bag, never guessed at. */
const V1_FORMATS = Object.freeze({ 'singles-6v6-l50': 'arena-gen3-standard', 'open-l100': 'arena-gen3-standard+lv100' });
function mapFormat(f) { return typeof f === 'string' && hasOwn.call(V1_FORMATS, f) ? V1_FORMATS[f] : null; }
function bagSet(o, k, v) { if (!isObj(o._unknown)) { const prior = hasOwn.call(o, '_unknown') ? o._unknown : undefined; o._unknown = {}; if (prior !== undefined) setOwn(o._unknown, '_unknown', prior); } setOwn(o._unknown, k, v); }

function migrate1to2(d) {
  const o = clone(d);
  if (!isObj(o)) return o;
  o.app = APP_ID;
  o.schemaVersion = 2;
  if (hasOwn.call(o, 'romHash')) { o.romSha256 = o.romHash; delete o.romHash; }
  if (isObj(o.settings) && hasOwn.call(o.settings, 'defaultFormat')) {
    const f = o.settings.defaultFormat;
    delete o.settings.defaultFormat;
    const r = mapFormat(f);
    if (r) o.settings.defaultRuleset = r; else bagSet(o.settings, 'v1DefaultFormat', f);
  }
  if (Array.isArray(o.teams)) for (const t of o.teams) {
    if (!isObj(t) || !hasOwn.call(t, 'formatId')) continue;
    const f = t.formatId;
    delete t.formatId;
    const r = mapFormat(f);
    if (r) t.ruleset = r; else { t.ruleset = DEFAULT_RULESET_ID; bagSet(t, 'v1FormatId', f); }
  }
  if (isObj(o.stats) && hasOwn.call(o.stats, 'byFormat')) {
    const bf = o.stats.byFormat;
    delete o.stats.byFormat;
    const by = {};
    const lost = {};
    if (isObj(bf)) for (const k of Object.keys(bf)) {
      const r = mapFormat(k), e = bf[k];
      if (r && isObj(e) && Number.isInteger(e.w) && Number.isInteger(e.l)) { const cur = hasOwn.call(by, r) ? by[r] : { w: 0, l: 0 }; setOwn(by, r, { w: cur.w + e.w, l: cur.l + e.l }); }
      else setOwn(lost, k, e);
    } else if (bf !== undefined) setOwn(lost, '_raw', bf);
    o.stats.byRuleset = by;
    if (Object.keys(lost).length) bagSet(o.stats, 'v1ByFormat', lost);
  }
  if (Array.isArray(o.box)) for (const m of o.box) {
    if (!isObj(m)) continue;
    if (hasOwn.call(m, 'ability')) {
      const a = m.ability;
      delete m.ability;
      if (isObj(a) && hasOwn.call(a, 'slot')) m.abilitySlot = a.slot; else bagSet(m, 'v1Ability', a);
    }
    if (hasOwn.call(m, 'training')) { bagSet(m, 'training', m.training); delete m.training; }
    if (hasOwn.call(m, 'notes')) { bagSet(m, 'notes', m.notes); delete m.notes; }
    if (isObj(m.provenance) && hasOwn.call(m.provenance, 'saveSha')) { m.provenance.saveSha256 = m.provenance.saveSha; delete m.provenance.saveSha; }
  }
  if (hasOwn.call(o, 'history')) { bagSet(o, 'history', o.history); delete o.history; }
  if (!hasOwn.call(o, 'identity')) o.identity = emptyIdentity();
  return o;
}

/** v2 -> v3: the career keys appear in `stats`, zeroed. Every v2 key keeps its value. A v2 document that already had a key with a v3 name (it was not valid v2 either)
 *  keeps that value in the unknown bag under the same name, and the key starts empty. */
function migrate2to3(d) {
  const o = clone(d);
  if (!isObj(o)) return o;
  o.schemaVersion = 3;
  if (isObj(o.stats)) {
    const fresh = emptyCareer();
    for (const k of CAREER_KEYS) {
      if (hasOwn.call(o.stats, k)) bagSet(o.stats, k, o.stats[k]);
      setOwn(o.stats, k, fresh[k]);
    }
  }
  return o;
}

/** v3 -> v4: a battle against a person has its own row in stats.byCpu. Every v3 key keeps its value. An existing `online` that is already a {w, l, dr, f} record of counters stays
 *  (the chain v2 -> v3 -> v4 passes through here with the one migrate2to3 just wrote, and a second run must change nothing); anything else under that name is kept in the unknown bag. */
function migrate3to4(d) {
  const o = clone(d);
  if (!isObj(o)) return o;
  o.schemaVersion = 4;
  if (isObj(o.stats) && isObj(o.stats.byCpu)) {
    const cur = o.stats.byCpu.online;
    const rec = isObj(cur) && Object.keys(cur).length === 4 && ['w', 'l', 'dr', 'f'].every((k) => hasOwn.call(cur, k) && isInt(cur[k], 0, Number.MAX_SAFE_INTEGER));
    if (!rec) {
      if (hasOwn.call(o.stats.byCpu, 'online')) bagSet(o.stats, 'v3ByCpuOnline', cur);
      setOwn(o.stats.byCpu, 'online', { w: 0, l: 0, dr: 0, f: 0 });
    }
  }
  return o;
}

/** v4 -> v5: the Tower's record appears, empty. Every v4 key keeps its value. A `tower` that is already a well-formed Tower record stays (the chain passes through here with the one a second run just wrote, and a
 *  second run must change nothing); anything else under that name is kept in the unknown bag. */
function migrate4to5(d) {
  const o = clone(d);
  if (!isObj(o)) return o;
  o.schemaVersion = 5;
  if (hasOwn.call(o, 'tower')) {
    if (checkTowerShape(o.tower).length) {
      // a free name for the junk: `v4Tower` may already be taken by the player's own unknown value (in the bag, or as a stray top-level key that the normaliser will move into the bag), and writing over it would lose that value
      let key = 'v4Tower';
      for (let i = 2; (isObj(o._unknown) && hasOwn.call(o._unknown, key)) || hasOwn.call(o, key); i++) key = 'v4Tower_' + i;
      bagSet(o, key, o.tower); o.tower = emptyTower();
    }
  } else o.tower = emptyTower();
  return o;
}

/** version -> function taking a document of that version and returning one of the NEXT version. Pure; never throws. */
export const MIGRATIONS = Object.freeze({ 1: migrate1to2, 2: migrate2to3, 3: migrate3to4, 4: migrate4to5 });

/**
 * Bring a stored / imported document to CURRENT.
 *   { ok:true,  profile, from, to, steps, changed, readOnly:false }   migrated (or already current)
 *   { ok:true,  profile, from, readOnly:true, changed:false }          NEWER than this build: returned as is (a copy)
 *   { ok:false, code, message }                                         no usable schemaVersion
 */
export function migrateProfile(doc, migrations = MIGRATIONS, current = SCHEMA_VERSION) {
  if (!isObj(doc)) return { ok: false, code: 'profile.shape', message: 'a profile must be an object' };
  const from = doc.schemaVersion;
  if (!Number.isInteger(from) || from < 1) return { ok: false, code: 'profile.version', message: 'schemaVersion must be a positive integer' };
  if (from > current) return { ok: true, profile: clone(doc), from, to: from, steps: 0, changed: false, readOnly: true };
  let v = from, d = doc, steps = 0;
  while (v < current) {
    const fn = migrations[v];
    if (typeof fn !== 'function') return { ok: false, code: 'profile.version', message: `no migration from schemaVersion ${v}` };
    d = fn(d);
    steps++;
    v++;
    if (!isObj(d) || d.schemaVersion !== v) return { ok: false, code: 'profile.version', message: `migration ${v - 1} did not produce schemaVersion ${v}` };
  }
  return { ok: true, profile: steps === 0 ? clone(doc) : d, from, to: current, steps, changed: steps > 0, readOnly: false };
}

// ---------------------------------------------------------------------------------------------
// normalisation: a CURRENT-version document -> a well-formed one, quarantining what cannot be repaired
// ---------------------------------------------------------------------------------------------

/**
 * Normalise a document already at SCHEMA_VERSION.
 * { ok:true, profile, problems, quarantined } | { ok:false, code, problems }
 *   problems     [{ severity: 'repaired'|'quarantined'|'error', code, path, message }]
 *   quarantined  [{ kind: 'mon'|'team', index, raw, problems }]   raw JSON of what was removed, as it stood after migration
 * Idempotent: normalising its own output returns the same profile and no problems.
 */
export function normalizeProfile(input, opts = {}) {
  const d = depsOf(opts.deps);
  const problems = [], quarantined = [];
  const P = (severity, code, path, message, extra) => problems.push({ severity, code, path, message, ...(extra || {}) });
  const fatal = (code, path, message) => { P('error', code, path, message); return { ok: false, code, problems, quarantined }; };
  if (!isObj(input)) return fatal('profile.shape', '', 'a profile must be an object');
  if (input.schemaVersion !== SCHEMA_VERSION) return fatal('profile.version', 'schemaVersion', `expected schemaVersion ${SCHEMA_VERSION}; migrate first`);
  if (input.app !== APP_ID) return fatal('profile.app', 'app', `app must be "${APP_ID}"`);
  if (!isId(input.id)) return fatal('profile.id', 'id', 'id must match [A-Za-z0-9_-]{1,40}');
  if (typeof input.romSha256 !== 'string' || !SHA_RE.test(input.romSha256)) return fatal('profile.rom', 'romSha256', 'romSha256 must be 64 lowercase hex digits');
  if (containsPrivateJwk(input)) return fatal('profile.private-key', 'identity', 'private key material is present in the document');
  if (tooDeep(input)) return fatal('profile.shape', '', 'the document is nested too deeply');

  const now = d.now();
  const out = { app: APP_ID, schemaVersion: SCHEMA_VERSION, id: input.id };
  if (isInt(input.rev, 0, Number.MAX_SAFE_INTEGER)) out.rev = input.rev; else { out.rev = 0; if (hasOwn.call(input, 'rev')) P('repaired', 'profile.rev', 'rev', 'rev reset to 0'); }
  for (const k of ['createdAt', 'updatedAt']) {
    if (isInt(input[k], 0, TIME_MAX)) out[k] = input[k];
    else { out[k] = now; P('repaired', 'profile.time', k, `${k} was missing or invalid; set to now`); }
  }
  out.romSha256 = input.romSha256;
  { const why = typeof input.trainerName === 'string' && input.trainerName.trim() === '' ? 'empty' : textIssue(input.trainerName, PROFILE_LIMITS.trainerName);
    if (why) { out.trainerName = 'TRAINER'; P('repaired', 'profile.trainer-name', 'trainerName', `trainerName was invalid (${why}); set to TRAINER`, { was: input.trainerName }); } else out.trainerName = input.trainerName; }
  if (isObj(input.avatar) && ['preset', 'mon'].includes(input.avatar.kind) && isInt(input.avatar.id, 0, PROFILE_LIMITS.u16)) {
    out.avatar = { kind: input.avatar.kind, id: input.avatar.id };
    const bag = mergeBag(isObj(input.avatar._unknown) ? input.avatar._unknown : null, unknownOf(input.avatar, ['kind', 'id']));
    if (bag) out.avatar._unknown = bag;
  } else { out.avatar = { kind: 'preset', id: 0 }; P('repaired', 'profile.avatar', 'avatar', 'avatar was missing or invalid; set to the default'); }

  // settings
  { const def = defaultSettings();
    const src = isObj(input.settings) ? input.settings : {};
    if (!isObj(input.settings)) P('repaired', 'profile.settings', 'settings', 'settings was missing or invalid; defaults used');
    const s = {};
    if (hasOwn.call(src, 'defaultRuleset') && typeof src.defaultRuleset === 'string') {
      let id = null; try { id = resolveRuleset(src.defaultRuleset).id; } catch (_e) { id = null; }
      if (id) s.defaultRuleset = id; else { s.defaultRuleset = def.defaultRuleset; P('repaired', 'profile.settings', 'settings.defaultRuleset', 'unknown ruleset id; default used', { was: src.defaultRuleset }); }
    } else { s.defaultRuleset = def.defaultRuleset; if (isObj(input.settings)) P('repaired', 'profile.settings', 'settings.defaultRuleset', 'missing; default used'); }
    for (const k of Object.keys(SETTING_ENUMS)) {
      if (SETTING_ENUMS[k].includes(src[k])) s[k] = src[k]; else { s[k] = def[k]; if (isObj(input.settings)) P('repaired', 'profile.settings', `settings.${k}`, `${k} missing or invalid; default used`, { was: src[k] }); }
    }
    for (const k of ['sound', 'reducedMotion']) { if (typeof src[k] === 'boolean') s[k] = src[k]; else { s[k] = def[k]; if (isObj(input.settings)) P('repaired', 'profile.settings', `settings.${k}`, `${k} missing or invalid; default used`, { was: src[k] }); } }
    if (isInt(src.backupNudgeDays, 0, 365)) s.backupNudgeDays = src.backupNudgeDays; else { s.backupNudgeDays = def.backupNudgeDays; if (isObj(input.settings)) P('repaired', 'profile.settings', 'settings.backupNudgeDays', 'missing or invalid; default used', { was: src.backupNudgeDays }); }
    const bag = mergeBag(isObj(src._unknown) ? src._unknown : null, unknownOf(src, SETTINGS_KEYS));
    if (bag) s._unknown = bag;
    out.settings = s;
  }

  // stats
  { const src = isObj(input.stats) ? input.stats : {};
    if (!isObj(input.stats)) P('repaired', 'profile.stats', 'stats', 'stats was missing or invalid; zeroed');
    const s = emptyStats();
    for (const k of COUNTERS) { if (isInt(src[k], 0, Number.MAX_SAFE_INTEGER)) s[k] = src[k]; else if (isObj(input.stats)) P('repaired', 'profile.stats', `stats.${k}`, `${k} missing or invalid; set to 0`, { was: src[k] }); }
    if (src.lastMatchAt === null || isInt(src.lastMatchAt, 0, TIME_MAX)) s.lastMatchAt = src.lastMatchAt;
    else if (src.lastMatchAt !== undefined) P('repaired', 'profile.stats', 'stats.lastMatchAt', 'invalid; set to null', { was: src.lastMatchAt });
    const lost = {};
    if (isObj(src.byRuleset)) {
      for (const k of Object.keys(src.byRuleset)) {
        const e = src.byRuleset[k];
        if (rulesetOk(k) && isObj(e) && Object.keys(e).length === 2 && isInt(e.w, 0, Number.MAX_SAFE_INTEGER) && isInt(e.l, 0, Number.MAX_SAFE_INTEGER) && Object.keys(s.byRuleset).length < PROFILE_LIMITS.byRulesetMax) setOwn(s.byRuleset, k, { w: e.w, l: e.l });
        else setOwn(lost, k, e);
      }
      if (Object.keys(lost).length) P('quarantined', 'profile.stats', 'stats.byRuleset', 'entries that are not {w, l} under a canonical ruleset id were kept in the unknown bag', { keys: Object.keys(lost) });
    } else if (hasOwn.call(src, 'byRuleset')) { setOwn(lost, '_raw', src.byRuleset); P('repaired', 'profile.stats', 'stats.byRuleset', 'byRuleset was not an object; kept in the unknown bag'); }
    const car = normalizeCareer(src, P, isObj(input.stats));          // v3: the career keys (career_stats.js); what cannot be repaired goes to the unknown bag below
    for (const k of CAREER_KEYS) s[k] = car.value[k];
    let bag = mergeBag(isObj(src._unknown) ? src._unknown : null, unknownOf(src, STATS_KEYS));
    if (Object.keys(lost).length) bag = mergeBag(bag, { byRulesetRejected: lost });
    if (Object.keys(car.rejected).length) bag = mergeBag(bag, { careerRejected: car.rejected });
    if (bag) s._unknown = bag;
    out.stats = s;
  }

  // tower (v5): repaired field by field; what cannot be kept goes to the record's own unknown bag, never lost silently
  { const tw = normalizeTower(input.tower, P, true);
    out.tower = tw.value;
    if (Object.keys(tw.rejected).length) {          // (what could not be kept goes in the record's bag, which is held to tower_record.js TOWER_LIMITS.bagMax: a hostile file cannot park megabytes there)
      const prior = isObj(out.tower._unknown) ? out.tower._unknown : null, rej = fitRejected(tw.rejected, prior);          // (the reject is cut down on its own first: merged in whole, a huge one would push the record's own older unknown values out of the bag)
      const bag = capBag(mergeBag(prior, rej ? { towerRejected: rej } : null));
      if (bag && Object.keys(bag).length) out.tower._unknown = bag; else delete out.tower._unknown;
    }
  }

  // identity
  { const src = isObj(input.identity) ? input.identity : null;
    const id = emptyIdentity();
    if (input.identity !== undefined && !src) P('repaired', 'profile.identity', 'identity', 'identity was not an object; reset');
    if (src) {
      if (src.publicKeyJwk === null || src.publicKeyJwk === undefined) id.publicKeyJwk = null;
      else if (isPublicJwk(src.publicKeyJwk)) id.publicKeyJwk = { kty: 'EC', crv: 'P-256', x: src.publicKeyJwk.x, y: src.publicKeyJwk.y };
      else P('error', 'profile.identity', 'identity.publicKeyJwk', 'publicKeyJwk is not a public P-256 key; identity cleared (the file or store held something else)');
      if (Array.isArray(src.previousKeys)) {
        src.previousKeys.slice(0, PROFILE_LIMITS.previousKeysMax).forEach((k, n) => {
          if (isObj(k) && Object.keys(k).every((x) => x === 'publicKeyJwk' || x === 'retiredAt' || x === 'reason') && isPublicJwk(k.publicKeyJwk) && isInt(k.retiredAt, 0, TIME_MAX) && (k.reason === undefined || (typeof k.reason === 'string' && k.reason.length <= 40 && !CONTROL_RE.test(k.reason)))) {
            const e = { publicKeyJwk: { kty: 'EC', crv: 'P-256', x: k.publicKeyJwk.x, y: k.publicKeyJwk.y }, retiredAt: k.retiredAt };
            if (k.reason !== undefined) e.reason = k.reason;
            id.previousKeys.push(e);
          } else P('error', 'profile.identity', `identity.previousKeys[${n}]`, 'not {publicKeyJwk, retiredAt, reason?}; dropped');
        });
        if (src.previousKeys.length > PROFILE_LIMITS.previousKeysMax) P('error', 'profile.identity', 'identity.previousKeys', 'more than 16 previous keys; the extras were dropped');
      }
      const bag = mergeBag(isObj(src._unknown) ? src._unknown : null, unknownOf(src, ['publicKeyJwk', 'previousKeys']));
      if (bag) id._unknown = bag;
    }
    out.identity = id;
  }

  // box
  const box = [];
  const seen = new Set();
  const rawBox = Array.isArray(input.box) ? input.box : [];
  if (input.box !== undefined && !Array.isArray(input.box)) P('repaired', 'profile.box', 'box', 'box was not an array; emptied (the value is quarantined)');
  if (input.box !== undefined && !Array.isArray(input.box)) quarantined.push({ kind: 'box', index: -1, raw: input.box, problems: [{ code: 'profile.box', path: 'box', message: 'box was not an array' }] });
  rawBox.forEach((raw, i) => {
    if (box.length >= PROFILE_LIMITS.boxMax) { quarantined.push({ kind: 'mon', index: i, raw, problems: [{ code: 'profile.box', path: `box[${i}]`, message: 'box is full' }] }); P('quarantined', 'profile.box', `box[${i}]`, 'box is full'); return; }
    const r = normalizeMon(raw, d, `box[${i}]`);
    if (r.problems.length) { quarantined.push({ kind: 'mon', index: i, raw, problems: r.problems }); for (const x of r.problems) P('quarantined', x.code, x.path, x.message); return; }
    if (seen.has(r.mon.id)) { const pr = [{ code: 'mon.duplicate-id', path: `box[${i}].id`, message: `duplicate mon id ${r.mon.id}` }]; quarantined.push({ kind: 'mon', index: i, raw, problems: pr }); P('quarantined', pr[0].code, pr[0].path, pr[0].message); return; }
    seen.add(r.mon.id);
    box.push(r.mon);
  });
  out.box = box;

  // teams
  const teams = [];
  const tseen = new Set();
  const rawTeams = Array.isArray(input.teams) ? input.teams : [];
  if (input.teams !== undefined && !Array.isArray(input.teams)) { P('repaired', 'profile.teams', 'teams', 'teams was not an array; emptied (the value is quarantined)'); quarantined.push({ kind: 'teams', index: -1, raw: input.teams, problems: [{ code: 'profile.teams', path: 'teams', message: 'teams was not an array' }] }); }
  rawTeams.forEach((raw, i) => {
    if (teams.length >= PROFILE_LIMITS.teamsMax) { quarantined.push({ kind: 'team', index: i, raw, problems: [{ code: 'profile.teams', path: `teams[${i}]`, message: 'too many teams' }] }); P('quarantined', 'profile.teams', `teams[${i}]`, 'too many teams'); return; }
    const r = normalizeTeam(raw, seen, `teams[${i}]`, P);
    if (r.problems.length) { quarantined.push({ kind: 'team', index: i, raw, problems: r.problems }); for (const x of r.problems) P('quarantined', x.code, x.path, x.message); return; }
    if (tseen.has(r.team.id)) { const pr = [{ code: 'team.duplicate-id', path: `teams[${i}].id`, message: `duplicate team id ${r.team.id}` }]; quarantined.push({ kind: 'team', index: i, raw, problems: pr }); P('quarantined', pr[0].code, pr[0].path, pr[0].message); return; }
    tseen.add(r.team.id);
    teams.push(r.team);
  });
  out.teams = teams;

  // root unknown bag
  { let bag = null;
    if (hasOwn.call(input, '_unknown')) {
      if (isObj(input._unknown)) bag = input._unknown;
      else { bag = {}; setOwn(bag, '_unknown', input._unknown); P('repaired', 'profile.unknown-bag', '_unknown', '_unknown was not an object; wrapped'); }
    }
    bag = mergeBag(bag, unknownOf(input, PROFILE_KEYS));
    if (bag && Object.keys(bag).length) out._unknown = bag;
  }
  const rest = checkProfile(out);
  if (rest.length) return fatal(rest[0].code, rest[0].path, 'internal: normalised profile still invalid: ' + rest.map((x) => x.code + ' ' + x.path).join(', '));
  return { ok: true, profile: out, problems, quarantined };
}

function normalizeMon(raw, d, path) {
  if (!isObj(raw)) return { mon: null, problems: [{ code: 'mon.shape', path, message: 'the record must be an object' }] };
  const now = d.now();
  const m = {};
  for (const k of MON_KEYS) if (hasOwn.call(raw, k)) setOwn(m, k, raw[k]);
  // optional fields with a documented default; everything else is required and never invented
  if (!hasOwn.call(m, 'nickname')) m.nickname = '';
  if (!hasOwn.call(m, 'heldItem')) m.heldItem = 0;
  if (!hasOwn.call(m, 'shiny')) m.shiny = false;
  if (!hasOwn.call(m, 'friendship')) m.friendship = 70;
  if (!hasOwn.call(m, 'originalTrainer')) m.originalTrainer = { name: '', tid: 0, sid: 0 };
  if (!hasOwn.call(m, 'origin')) m.origin = 'custom';
  if (!hasOwn.call(m, 'provenance')) m.provenance = {};
  for (const k of ['createdAt', 'updatedAt']) if (!hasOwn.call(m, k)) m[k] = now;
  if (isObj(m.originalTrainer)) {
    const ot = { ...m.originalTrainer };
    const bag = mergeBag(isObj(ot._unknown) ? ot._unknown : null, unknownOf(ot, OT_KEYS));
    for (const k of Object.keys(ot)) if (!OT_KEYS.includes(k)) delete ot[k];
    if (bag) ot._unknown = bag;
    m.originalTrainer = ot;
  }
  if (isObj(m.provenance)) {
    const pv = { ...m.provenance };
    const bag = mergeBag(isObj(pv._unknown) ? pv._unknown : null, unknownOf(pv, PROV_KEYS));
    for (const k of Object.keys(pv)) if (!PROV_KEYS.includes(k)) delete pv[k];
    if (bag) pv._unknown = bag;
    m.provenance = pv;
  }
  let bag = null;
  if (hasOwn.call(raw, '_unknown')) {
    if (isObj(raw._unknown)) bag = raw._unknown;
    else { bag = {}; setOwn(bag, '_unknown', raw._unknown); }
  }
  bag = mergeBag(bag, unknownOf(raw, MON_KEYS));
  if (bag && Object.keys(bag).length) m._unknown = bag;
  const problems = checkMon(m, path);
  return { mon: problems.length ? null : m, problems };
}

function normalizeTeam(raw, boxIds, path, P) {
  if (!isObj(raw)) return { team: null, problems: [{ code: 'team.shape', path, message: 'a team must be an object' }] };
  const t = {};
  for (const k of TEAM_KEYS) if (hasOwn.call(raw, k)) setOwn(t, k, raw[k]);
  if (typeof t.ruleset === 'string') { try { t.ruleset = resolveRuleset(t.ruleset).id; } catch (_e) { /* left as is; checkTeam reports it */ } }
  if (Array.isArray(t.monIds)) {
    const keep = [];
    for (const id of t.monIds) {
      if (!isId(id)) { keep.push(id); continue; }
      if (!boxIds.has(id)) { P('repaired', 'team.missing-mon', `${path}.monIds`, `mon ${id} is not in the box; removed from the team`, { monId: id }); continue; }
      keep.push(id);
    }
    t.monIds = keep;
  }
  let bag = null;
  if (hasOwn.call(raw, '_unknown')) { if (isObj(raw._unknown)) bag = raw._unknown; else { bag = {}; setOwn(bag, '_unknown', raw._unknown); } }
  bag = mergeBag(bag, unknownOf(raw, TEAM_KEYS));
  if (bag && Object.keys(bag).length) t._unknown = bag;
  const problems = checkTeam(t, path, boxIds);
  return { team: problems.length ? null : t, problems };
}

/** Open a stored document for use: migrate (if older), normalise, report. Never throws on any input.
 *  { ok:true, profile, readOnly, migratedFrom|null, changed, problems, quarantined }  |  { ok:false, code, message, problems } */
export function openProfileDocument(doc, opts = {}) {
  let mig;
  try { mig = migrateProfile(doc); } catch (e) { return { ok: false, code: 'profile.migrate', message: 'migration threw: ' + (e && e.message), problems: [] }; }
  if (!mig.ok) return { ok: false, code: mig.code, message: mig.message, problems: [{ severity: 'error', code: mig.code, path: 'schemaVersion', message: mig.message }] };
  if (mig.readOnly) return { ok: true, profile: mig.profile, readOnly: true, migratedFrom: null, changed: false, problems: [], quarantined: [] };
  let norm;
  try { norm = normalizeProfile(mig.profile, opts); } catch (e) { return { ok: false, code: 'profile.normalize', message: 'normalisation threw: ' + (e && e.message), problems: [] }; }
  if (!norm.ok) return { ok: false, code: norm.code, message: norm.problems[0] ? norm.problems[0].message : 'invalid profile', problems: norm.problems };
  const changed = mig.changed || norm.problems.length > 0 || canonicalJSON(norm.profile) !== canonicalJSON(doc);
  return { ok: true, profile: norm.profile, readOnly: false, migratedFrom: mig.changed ? mig.from : null, changed, problems: norm.problems, quarantined: norm.quarantined };
}

// ---------------------------------------------------------------------------------------------
// rules bridge: a stored record -> the record rules.js validates
// ---------------------------------------------------------------------------------------------

/** The record rules.js reads: ev/iv become evs/ivs, heldItem becomes item, moves become plain ids. When the ruleset
 *  is in points mode (strict-champions) `points` is derived from the EVs; an EV not on the 4-then-8 grid then
 *  surfaces as a points.ev-mismatch reason instead of being silently rounded. */
export function toRulesRec(mon, ruleset) {
  const rec = {
    species: mon.species, level: mon.level, nature: mon.nature, abilitySlot: mon.abilitySlot, item: mon.heldItem,
    moves: Array.isArray(mon.moves) ? mon.moves.map((m) => m.id) : mon.moves, ivs: { ...mon.iv }, evs: { ...mon.ev },
  };
  const R = ruleset === undefined || ruleset === null ? null : (typeof ruleset === 'string' ? resolveRuleset(ruleset) : ruleset);
  if (R && R.points) {
    try { rec.points = evsToPoints(rec.evs, rec.ivs); } catch (_e) { /* a malformed block is reported by rules.js as ev.missing / ev.range */ }
  }
  return rec;
}

/** rules.js validateMon + the one check rules.js cannot make because it is about the profile record: gender against
 *  the species' gender ratio (255 = genderless, 0 = male only, 254 = female only). */
export function validateStoredMon(mon, pack, ruleset) {
  const v = validateMon(toRulesRec(mon, ruleset), pack, ruleset);
  const reasons = v.reasons.slice();
  const sp = Number.isInteger(mon.species) ? pack.species[mon.species] : null;
  if (sp && sp.legal) {
    const r = sp.genderRatio;
    const want = r === 255 ? '-' : r === 0 ? 'M' : r === 254 ? 'F' : null;
    const bad = want ? mon.gender !== want : mon.gender === '-';
    if (bad) reasons.push({ code: 'mon.gender-species', path: 'gender', message: want ? `this species is always "${want}"` : 'this species has two genders; "-" is for genderless species only' });
  }
  return { ok: reasons.length === 0, reasons };
}

/** Rules-level report for a whole profile: every box record under `ruleset` (default: the profile's default), and
 *  every team under its own ruleset. Collects; never aborts. */
export function validateProfileAgainstPack(profile, pack, ruleset) {
  const rs = ruleset || profile.settings.defaultRuleset;
  const mons = profile.box.map((m, i) => ({ index: i, id: m.id, ...validateStoredMon(m, pack, rs) }));
  const byId = new Map(profile.box.map((m) => [m.id, m]));
  const teams = profile.teams.map((t) => {
    const v = validateMonList(t.monIds.map((id) => byId.get(id)), pack, t.ruleset);
    return { id: t.id, ok: v.ok, reasons: v.reasons };
  });
  return { ok: mons.every((m) => m.ok) && teams.every((t) => t.ok), mons, teams };
}

/** A list of profile records (a team, or a decoded card) as one team under `ruleset`: rules.js validateTeam (team size,
 *  species clause, item clause, every mon's rules) plus the gender check. Reasons carry `mon` = the index. */
export function validateMonList(mons, pack, ruleset) {
  const R = typeof ruleset === 'string' ? resolveRuleset(ruleset) : ruleset;
  const v = validateTeam(mons.map((m) => toRulesRec(m, R)), pack, R);
  const extra = [];
  mons.forEach((m, i) => {
    for (const r of validateStoredMon(m, pack, R).reasons) if (r.code === 'mon.gender-species') extra.push({ ...r, path: `mons[${i}].${r.path}`, mon: i });
  });
  const reasons = v.reasons.concat(extra);
  return { ok: reasons.length === 0, reasons, mons: v.mons };
}

export function teamMons(profile, teamId) {
  const t = profile.teams.find((x) => x.id === teamId);
  if (!t) return [];
  const byId = new Map(profile.box.map((m) => [m.id, m]));
  return t.monIds.map((id) => byId.get(id)).filter(Boolean);
}

// ---------------------------------------------------------------------------------------------
// export / import
// ---------------------------------------------------------------------------------------------

/** A deep copy safe to write to a file: no store-managed `rev`, and never any private key material. */
export function exportableProfile(profile) {
  if (containsPrivateJwk(profile)) throw new ProfileError('profile.private-key', 'refusing to export a profile that contains private key material');
  const p = clone(profile);
  delete p.rev;
  return p;
}

export function buildExport(profile, opts = {}) {
  const d = depsOf(opts.deps);
  const p = exportableProfile(profile);
  const checksum = 'sha256:' + sha256Hex(enc(canonicalJSON(p)));
  return { format: EXPORT_FORMAT, exportVersion: EXPORT_VERSION, schemaVersion: p.schemaVersion, exportedAt: d.now(), romSha256: p.romSha256, profile: p, checksum };
}
export function serializeExport(obj) { return JSON.stringify(obj, null, 1) + '\n'; }

export function exportFileName(profile, { gzip = false, now = defaultDeps().now() } = {}) {
  const slug = String(profile && profile.trainerName ? profile.trainerName : 'profile').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'profile';
  const dt = new Date(now);
  const ymd = `${dt.getUTCFullYear()}${String(dt.getUTCMonth() + 1).padStart(2, '0')}${String(dt.getUTCDate()).padStart(2, '0')}`;
  return `pokemonarena-${slug}-${ymd}${FILE_SUFFIX}${gzip ? '.gz' : ''}`;
}

async function streamBytes(stream, cap) {
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (cap !== undefined && total > cap) { try { await reader.cancel(); } catch (_e) { /* ignore */ } const e = new Error('output exceeds cap'); e.tooLarge = true; throw e; }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}
export async function compressBytes(bytes, format) {
  const cs = new CompressionStream(format);
  const w = cs.writable.getWriter();
  w.write(bytes).catch(() => {});
  w.close().catch(() => {});
  return streamBytes(cs.readable);
}
/** Decompress with a hard cap on the OUTPUT size (a gzip bomb stops at the cap). Throws on corrupt / truncated input. */
export async function decompressBytes(bytes, format, cap) {
  const ds = new DecompressionStream(format);
  const w = ds.writable.getWriter();
  w.write(bytes).catch(() => {});
  w.close().catch(() => {});
  return streamBytes(ds.readable, cap);
}
/** Does this browser have CompressionStream / DecompressionStream AND accept this format? ('deflate-raw' arrived later than
 *  'gzip' in some engines, so the constructor existing is not enough.) kind is 'Compression' or 'Decompression'. */
export function streamSupported(kind, format) {
  const C = globalThis[kind + 'Stream'];
  if (typeof C !== 'function') return false;
  try { new C(format); return true; } catch (_e) { return false; }
}
export const compressionAvailable = (format = 'gzip') => streamSupported('Compression', format) && streamSupported('Decompression', format);

/** { bytes, gzip, name, mime }. gzip:true falls back to plain JSON (gzip:false in the result) where CompressionStream is absent. */
export async function exportBytes(profile, opts = {}) {
  const d = depsOf(opts.deps);
  const now = d.now();
  const text = serializeExport(buildExport(profile, { deps: { now: () => now } }));
  let bytes = enc(text);
  let gz = false;
  if (opts.gzip && compressionAvailable('gzip')) { bytes = await compressBytes(bytes, 'gzip'); gz = true; }
  return { bytes, gzip: gz, name: exportFileName(profile, { gzip: gz, now }), mime: gz ? 'application/gzip' : 'application/json' };
}

function toU8(input) {
  if (typeof input === 'string') return enc(input);
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  return null;
}

export const IMPORT_CODES = Object.freeze({
  'import.input': 'the input is not a string / bytes',
  'import.empty': 'the file is empty',
  'import.too-large': 'the file (or its decompressed form) is larger than the cap',
  'import.gzip-unsupported': 'the file is gzip and this browser cannot decompress it',
  'import.gzip-corrupt': 'the gzip stream is truncated or corrupt',
  'import.not-text': 'the file is not valid UTF-8 text',
  'import.corrupt': 'the file is not valid JSON (likelyTruncated says whether it simply stops early)',
  'import.not-an-export': 'the JSON is not a pokemonarena profile export',
  'import.export-version-newer': 'the export envelope is newer than this build understands',
  'import.checksum': 'the checksum is missing or does not match the profile',
  'import.envelope-mismatch': 'the envelope disagrees with the profile it wraps',
  'import.newer-schema': 'the profile was saved by a newer build; update the app',
  'import.private-key': 'the file contains private key material and is refused',
  'import.invalid-profile': 'the profile cannot be migrated or normalised',
  'import.rom-mismatch': 'the profile is for a different ROM than the pinned one',
  'import.internal': 'unexpected failure while reading the file',
});

/**
 * A record is a well-formed Pokemon of NO Pokemon this ROM has (species 21 is an empty slot in the table, 5000 is past its end): it cannot be
 * drawn, edited or fought with, and the rules module can only say "unknown species". With a pack in hand an import sets such records aside
 * (quarantined, kind 'mon', code mon.species-unknown) exactly like a record that fails the structural checks, and removes them from every team.
 * Mutates `profile` (a fresh object from openProfileDocument) and appends to `quarantined`. Returns the number set aside.
 */
export function setAsideUnknownSpecies(profile, pack, quarantined) {
  const gone = new Set();
  profile.box = profile.box.filter((m, i) => {
    if (Number.isInteger(m.species) && pack.species[m.species]) return true;
    gone.add(m.id);
    quarantined.push({ kind: 'mon', index: i, raw: m, problems: [{ code: 'mon.species-unknown', path: `box[${i}].species`, message: `species ${m.species} is not a Pokemon in this ROM` }] });
    return false;
  });
  if (gone.size) profile.teams = profile.teams.map((t) => (t.monIds.some((id) => gone.has(id)) ? { ...t, monIds: t.monIds.filter((id) => !gone.has(id)) } : t));
  return gone.size;
}

/**
 * Read an export file. Never throws; returns { ok:false, code, message, ... } or
 * { ok:true, profile (rev 0), migratedFrom, problems, quarantined, rules?, checksum:'ok'|'overridden', gzip, size }.
 * opts: maxBytes, expectRomSha256, allowRomMismatch, allowChecksumMismatch, deps, pack (then every record and team is
 * also checked against rules.js and the report is returned as `rules`), ruleset.
 */
export async function parseExport(input, opts = {}) {
  const fail = (code, message, extra) => ({ ok: false, code: 'import.' + code, message, ...(extra || {}) });
  try {
    const maxBytes = opts.maxBytes === undefined ? EXPORT_MAX_BYTES : opts.maxBytes;
    let bytes = toU8(input);
    if (!bytes) return fail('input', 'expected a string or bytes');
    if (bytes.length === 0) return fail('empty', 'the file is empty');
    if (bytes.length > maxBytes) return fail('too-large', `the file is ${bytes.length} bytes; the cap is ${maxBytes}`, { size: bytes.length, max: maxBytes });
    let gz = false;
    if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
      if (!streamSupported('Decompression', 'gzip')) return fail('gzip-unsupported', 'this browser cannot decompress .gz files; use the plain .json export');
      try { bytes = await decompressBytes(bytes, 'gzip', maxBytes); gz = true; }
      catch (e) { return e && e.tooLarge ? fail('too-large', `the decompressed file is larger than ${maxBytes} bytes`, { max: maxBytes }) : fail('gzip-corrupt', 'the .gz file is truncated or corrupt'); }
    }
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch (_e) { return fail('not-text', 'the file is not valid UTF-8 text'); }
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    let env;
    try { env = JSON.parse(text); } catch (_e) { return fail('corrupt', 'the file is not valid JSON', { likelyTruncated: !/[}\]]\s*$/.test(text) }); }
    if (!isObj(env) || env.format !== EXPORT_FORMAT || !Number.isInteger(env.exportVersion) || env.exportVersion < 1 || !isObj(env.profile)) return fail('not-an-export', 'this is not a pokemonarena profile export');
    if (env.exportVersion > EXPORT_VERSION) return fail('export-version-newer', `export version ${env.exportVersion} is newer than this build (${EXPORT_VERSION})`, { exportVersion: env.exportVersion });
    if (tooDeep(env)) return fail('corrupt', 'the file is nested too deeply');
    if (containsPrivateJwk(env)) return fail('private-key', 'the file contains private key material; it was not imported');
    let canon;
    try { canon = canonicalJSON(env.profile); } catch (_e) { return fail('corrupt', 'the profile cannot be canonicalised'); }
    const want = 'sha256:' + sha256Hex(enc(canon));
    let checksum = 'ok';
    if (env.checksum !== want) {
      if (!opts.allowChecksumMismatch) return fail('checksum', typeof env.checksum === 'string' ? 'the checksum does not match: the file was edited or damaged' : 'the file has no checksum', { reason: typeof env.checksum === 'string' ? 'mismatch' : 'missing' });
      checksum = 'overridden';
    }
    const sv = env.profile.schemaVersion;
    if (Number.isInteger(sv) && sv > SCHEMA_VERSION) return fail('newer-schema', `the profile was saved by a newer build (schema ${sv}; this build reads up to ${SCHEMA_VERSION})`, { schemaVersion: sv });
    const opened = openProfileDocument(env.profile, { deps: opts.deps });
    if (!opened.ok) return fail('invalid-profile', opened.message, { problems: opened.problems, profileCode: opened.code });
    if (env.schemaVersion !== sv || env.romSha256 !== opened.profile.romSha256) return fail('envelope-mismatch', 'the envelope does not match the profile inside it');
    const expectRom = opts.expectRomSha256 === undefined ? PINNED.sha256 : opts.expectRomSha256;
    if (expectRom && opened.profile.romSha256 !== expectRom && !opts.allowRomMismatch) return fail('rom-mismatch', 'this profile was made for a different ROM than the pinned Pokemon SoulGold v1.1.1', { have: opened.profile.romSha256, want: expectRom });
    const profile = opened.profile;
    profile.rev = 0;
    const res = { ok: true, profile, migratedFrom: opened.migratedFrom, problems: opened.problems, quarantined: opened.quarantined, checksum, gzip: gz, size: bytes.length };
    if (opts.pack) {
      setAsideUnknownSpecies(profile, opts.pack, res.quarantined);
      res.rules = validateProfileAgainstPack(profile, opts.pack, opts.ruleset);
    }
    return res;
  } catch (e) {
    return fail('internal', 'unexpected failure: ' + (e && e.message ? e.message : String(e)));
  }
}

// ---------------------------------------------------------------------------------------------
// import planning: new / merge / replace (pure; store.js applies the result with a backup)
// ---------------------------------------------------------------------------------------------

export const IMPORT_MODES = Object.freeze(['new', 'merge', 'replace']);

function monKey(m) {
  const p = m.provenance;
  return p && Number.isInteger(p.pid) && Number.isInteger(p.otId) ? `pid:${p.pid}:${p.otId}` : null;
}

/**
 * Decide the profile an import produces. `existing` is the current profile (null for mode 'new'), `incoming` the
 * result of parseExport. Returns { ok:true, profile, report } or { ok:false, code, message }.
 *   new      a copy with a fresh id, rev 0. Its identity travels as the PUBLIC key only; this browser holds no private
 *            key for it, so identity.js reports 'no-key' until the visitor rotates (an explicit act).
 *   merge    incoming records are ADDED to the existing box; duplicates (same pid+otId, else same id with the same
 *            content) are skipped; an id clash with different content gets a fresh id. Existing teams, settings,
 *            stats and identity are untouched; incoming teams are added when their id is free.
 *   replace  the incoming content replaces the existing one but keeps id, rev, createdAt and the LOCAL identity
 *            (identity belongs to the browser holding the key, not to the data). If the existing profile has no
 *            identity the incoming public key is adopted. THE BATTLE RECORD (stats) is the file's, whole: a replace says so in the preview and the backup keeps the old one.
 *            A new profile carries the file's record with it; a merge leaves the record of the active profile exactly as it is (report.record says which).
 * The store takes an automatic backup of `existing` before applying merge / replace.
 */
export function planImport(existing, incoming, mode, deps) {
  const d = depsOf(deps);
  if (!IMPORT_MODES.includes(mode)) return { ok: false, code: 'plan.mode', message: 'mode must be new, merge or replace' };
  if (!isObj(incoming) || checkProfile(incoming).length) return { ok: false, code: 'plan.incoming', message: 'the incoming profile is not well formed' };
  const now = d.now();
  const report = { mode, addedMons: 0, skippedMons: [], remappedMons: 0, addedTeams: 0, skippedTeams: [], boxSize: 0, identity: 'incoming-copy', record: 'copied', recordBattles: battleCount(incoming.stats), tower: 'copied', towerRuns: incoming.tower ? incoming.tower.runs : 0 };
  if (mode === 'new') {
    const p = clone(incoming);
    p.id = newId('p', d);
    p.rev = 0;
    p.updatedAt = now;
    report.addedMons = p.box.length;
    report.addedTeams = p.teams.length;
    report.boxSize = p.box.length;
    return { ok: true, profile: p, report };
  }
  if (!isObj(existing) || checkProfile(existing).length) return { ok: false, code: 'plan.existing', message: 'there is no well-formed profile to ' + mode + ' into' };
  if (existing.romSha256 !== incoming.romSha256) return { ok: false, code: 'plan.rom-mismatch', message: 'the two profiles are for different ROMs' };
  if (mode === 'replace') {
    const p = clone(incoming);
    p.id = existing.id;
    p.rev = existing.rev;
    p.createdAt = existing.createdAt;
    p.updatedAt = now;
    if (existing.identity.publicKeyJwk) { p.identity = clone(existing.identity); report.identity = 'kept-local'; } else report.identity = 'adopted-incoming';
    report.record = 'replaced';
    report.tower = 'replaced';
    report.addedMons = p.box.length;
    report.addedTeams = p.teams.length;
    report.boxSize = p.box.length;
    return { ok: true, profile: p, report };
  }
  // merge
  const p = clone(existing);
  p.updatedAt = now;
  const byId = new Map(p.box.map((m) => [m.id, m]));
  const byKey = new Map();
  for (const m of p.box) { const k = monKey(m); if (k) byKey.set(k, m); }
  const idMap = new Map(); // incoming mon id -> the id it has in the merged box
  for (const m of incoming.box) {
    const k = monKey(m);
    if (k && byKey.has(k)) { idMap.set(m.id, byKey.get(k).id); report.skippedMons.push({ id: m.id, reason: 'same pid and otId already in the box' }); continue; }
    const clash = byId.get(m.id);
    if (clash) {
      if (canonicalJSON(clash) === canonicalJSON(m)) { idMap.set(m.id, clash.id); report.skippedMons.push({ id: m.id, reason: 'identical record already in the box' }); continue; }
      const fresh = clone(m);
      fresh.id = newId('m', d);
      if (p.box.length >= PROFILE_LIMITS.boxMax) return { ok: false, code: 'plan.box-full', message: `the merged box would exceed ${PROFILE_LIMITS.boxMax} records` };
      p.box.push(fresh); byId.set(fresh.id, fresh); idMap.set(m.id, fresh.id); report.addedMons++; report.remappedMons++;
      continue;
    }
    if (p.box.length >= PROFILE_LIMITS.boxMax) return { ok: false, code: 'plan.box-full', message: `the merged box would exceed ${PROFILE_LIMITS.boxMax} records` };
    const add = clone(m);
    p.box.push(add); byId.set(add.id, add); idMap.set(m.id, add.id); if (k) byKey.set(k, add); report.addedMons++;
  }
  const teamIds = new Set(p.teams.map((t) => t.id));
  for (const t of incoming.teams) {
    if (teamIds.has(t.id)) { report.skippedTeams.push({ id: t.id, reason: 'a team with this id already exists' }); continue; }
    if (p.teams.length >= PROFILE_LIMITS.teamsMax) return { ok: false, code: 'plan.teams-full', message: `the merged profile would exceed ${PROFILE_LIMITS.teamsMax} teams` };
    const nt = clone(t);
    nt.monIds = [...new Set(t.monIds.map((id) => idMap.get(id)).filter(Boolean))];
    p.teams.push(nt); teamIds.add(nt.id); report.addedTeams++;
  }
  report.boxSize = p.box.length;
  report.identity = 'kept-local';
  report.record = 'kept-local';                   // a merge never touches the battle record: the file's record is NOT added (merging the same file twice must not count its battles twice)
  report.tower = 'kept-local';                    // ... nor the Tower's record (its counters would count twice the same way); the profile's own Tower climb is exactly as it was
  return { ok: true, profile: p, report };
}

// ---------------------------------------------------------------------------------------------
// the battle record: one finished match into a profile (pure; store.js recordMatch applies it inside one transaction)
// ---------------------------------------------------------------------------------------------

/**
 * Fold a finished match (career_stats.js matchFromSummary) into a COPY of the profile (a current-version, well-formed profile).
 * -> { ok:true, profile, duplicate, callouts } | { ok:false, code, message }. A match whose id is already in stats.recent changes nothing (duplicate:true).
 * The profile's rev / updatedAt are left for the store to set.
 */
export function recordMatch(profile, match) {
  const why = matchIssue(match);
  if (why) return { ok: false, code: 'record.match', message: 'the match is not recordable (' + why + ')' };
  if (!isObj(profile) || profile.schemaVersion !== SCHEMA_VERSION) return { ok: false, code: 'record.profile', message: 'the profile is not at the current schema version' };
  const f = foldMatch(profile.stats, match, rulesetOk(match.ruleset) ? resolveRuleset(match.ruleset).id : null);
  const next = clone(profile);
  next.stats = f.stats;
  const bad = checkProfile(next);
  if (bad.length) return { ok: false, code: 'record.invalid', message: 'the record would not be well formed: ' + bad.slice(0, 2).map((x) => x.code + ' ' + x.path).join(', ') };
  return { ok: true, profile: next, duplicate: f.duplicate, callouts: f.callouts };
}

/**
 * `mine` with the battle record AND the Tower record of `stored` (a profile as the store holds it NOW). The Team Builder never edits `stats` or `tower`, so when its save deliberately overrides the store's
 * compare-and-swap ("Keep my edits here" after another tab saved first) it must carry the record that is stored now: another tab may have written a battle (online or against the CPU)
 * in the meantime, and the copy this tab loaded long ago would erase it. Pure: neither argument is modified; the record is copied, never shared.
 */
export function withStoredRecord(mine, stored) {
  return { ...mine, stats: clone(stored.stats), tower: stored.tower === undefined ? clone(mine.tower) : clone(stored.tower) };
}

/** A copy of the profile with its battle record emptied (RESET RECORD). Everything else is untouched. */
export function resetRecord(profile) {
  const next = clone(profile);
  const keepBag = isObj(next.stats) && isObj(next.stats._unknown) ? next.stats._unknown : null;
  next.stats = emptyStats();
  if (keepBag) next.stats._unknown = keepBag;
  return next;
}

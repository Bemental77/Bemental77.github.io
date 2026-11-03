#!/usr/bin/env node
// tools/pokemonarena_music_map_test.mjs - checks pokemonarena/js/music_map.js (stage MU2).
//
// Static checks (no ROM needed): module shape, every key has an entry or an explicit null with a reason,
// confidence labels, 'low' entries are flagged UNVERIFIED-GUESS, fallback chains terminate.
// ROM checks (need the ROMs; SKIPPED LOUDLY and counted when a ROM is absent):
//   * size + sha256 of each ROM profile, song-table plausibility (entry count, dummy slot 0, headers valid)
//   * every mapped index is inside the song table and its header parses (track count, voicegroup/track pointers)
//   * loops / jingle flags equal the header-derived truth (a track whose main stream ends in GOTO loops;
//     all tracks ending in FINE = jingle)  -> "jingles are non-looping, loops loop"
//   * code anchors: the song constants the ROM's own battle selector / victory handler contain (decoded from the
//     THUMB code between two addresses) include the index the map gives for the key
//   * fanfare keys equal the value in the ROM's sFanfares table
//   * SoulGold labels that carry a MUS-/SE- name equal the ROM's own song-name table entry
//   * Ultra Violet entries that claim a SoulGold twin really have a byte-identical (pointer-normalised) stream
// Every important check has a negative control: a mutated copy of the map or of the ROM bytes must trip a NAMED
// check; the unmutated twin must stay quiet.
//
// ENV  ARENA_ROM     SoulGold path (default gba/gbaWasm/roms/Pokemon SoulGold (v1.1.1).gba)
//      ARENA_ROM_UV  Ultra Violet path (default gba/gbaWasm/roms/pokemonUltraViolet.gba)
// Exit code 0 only when nothing failed and every negative control tripped its check.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROM_PATHS = {
  soulgold: process.env.ARENA_ROM || path.join(root, 'gba', 'gbaWasm', 'roms', 'Pokemon SoulGold (v1.1.1).gba'),
  ultraviolet: process.env.ARENA_ROM_UV || path.join(root, 'gba', 'gbaWasm', 'roms', 'pokemonUltraViolet.gba'),
};
const MAP_URL = pathToFileURL(path.join(root, 'pokemonarena', 'js', 'music_map.js')).href;

// ------------------------------------------------------------------ tiny ROM helpers (independent of MU1's decoder)
const rd32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const rd16 = (b, o) => b[o] | (b[o + 1] << 8);
const inRom = (b, p) => p >= 0x08000000 && p < 0x08000000 + b.length;
const CLOCK = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 28, 30, 32, 36, 40, 42, 44, 48, 52, 54, 56, 60, 64, 66, 68, 72, 76, 78, 80, 84, 88, 90, 92, 96];

// Walks a track's main command stream until FINE (0xB1) or GOTO (0xB2). PATT calls are not followed.
// Returns { end: 'fine'|'goto'|'run', norm: Uint8Array (pointer operands zeroed) }.
function walkTrack(b, start) {
  const out = [];
  let o = start;
  let end = 'run';
  for (let steps = 0; steps < 400000 && o < b.length; steps++) {
    const c = b[o];
    if (c < 0x80) { out.push(c); o++; continue; }
    if (c <= 0xB0) { out.push(c); o++; continue; }
    if (c === 0xB1) { out.push(c); end = 'fine'; break; }
    if (c === 0xB2) { out.push(c, 0, 0, 0, 0); end = 'goto'; break; }
    if (c === 0xB3) { out.push(c, 0, 0, 0, 0); o += 5; continue; }
    if (c === 0xB4) { out.push(c); o++; continue; }
    if (c === 0xB5) { out.push(c, b[o + 1], 0, 0, 0, 0); o += 6; continue; }
    if (c === 0xB9) { out.push(c, b[o + 1], b[o + 2], b[o + 3]); o += 4; continue; }
    if (c >= 0xBA && c <= 0xCC) { out.push(c, b[o + 1]); o += 2; continue; }
    if (c === 0xCD) { out.push(c, b[o + 1], b[o + 2]); o += 3; continue; }
    if (c === 0xCE) { out.push(c); o++; if (b[o] < 0x80) { out.push(b[o]); o++; } continue; }
    if (c === 0xCF) { out.push(c); o++; let n = 0; while (b[o] < 0x80 && n < 2) { out.push(b[o]); o++; n++; } continue; }
    if (c >= 0xD0) { out.push(c); o++; let n = 0; while (b[o] < 0x80 && n < 3) { out.push(b[o]); o++; n++; } continue; }
    out.push(c); o++;
  }
  return { end, norm: Uint8Array.from(out) };
}

// Song header at table index -> { valid, ptr, nt, tracks:[{end,norm}], loops, sig } (never throws)
function songAt(rom, profile, idx) {
  const e = profile.songTableOffset + 8 * idx;
  if (idx < 0 || idx >= profile.songCount || e + 8 > rom.length) return { valid: false, why: 'index outside the song table' };
  const ptr = rd32(rom, e);
  if (!inRom(rom, ptr)) return { valid: false, why: 'song header pointer outside ROM', ptr };
  const o = ptr - 0x08000000;
  const nt = rom[o];
  if (nt < 1 || nt > 16) return { valid: false, why: 'track count ' + nt, ptr };
  if (!inRom(rom, rd32(rom, o + 4))) return { valid: false, why: 'voicegroup pointer outside ROM', ptr };
  const tracks = [];
  for (let i = 0; i < nt; i++) {
    const t = rd32(rom, o + 8 + 4 * i);
    if (!inRom(rom, t)) return { valid: false, why: 'track pointer outside ROM', ptr };
    tracks.push(walkTrack(rom, t - 0x08000000));
  }
  const loops = tracks.some((t) => t.end === 'goto');
  const h = crypto.createHash('sha1');
  for (const t of tracks) h.update(t.norm).update('|');
  h.update('#' + nt);
  return { valid: true, ptr, nt, tracks, loops, sig: h.digest('hex'), ms: rd16(rom, e + 4), me: rd16(rom, e + 6) };
}

// Song constants (350..1100 for SoulGold, 200..400 for UV) a THUMB code range builds: ldr-literal values and
// movs/lsls, movs/adds pairs. Used to prove that the ROM's selector really contains the mapped index.
function codeConstants(rom, startAddr, endAddr, lo, hi) {
  const found = new Set();
  const s = startAddr - 0x08000000;
  const e = endAddr - 0x08000000;
  for (let o = s; o < e; o += 2) {
    const h = rd16(rom, o);
    if ((h >> 11) === 9) { // ldr rd,[pc,#imm8*4]
      const a = (((0x08000000 + o + 4) & ~3) + (h & 255) * 4) - 0x08000000;
      if (a + 4 <= rom.length) { const v = rd32(rom, a); if (v >= lo && v <= hi) found.add(v); }
    } else if ((h >> 11) === 4) { // movs rd,#imm8
      const rd = (h >> 8) & 7;
      const imm = h & 255;
      const h2 = rd16(rom, o + 2);
      if ((h2 >> 11) === 0 && ((h2 >> 3) & 7) === rd && (h2 & 7) === rd) { const v = imm << ((h2 >> 6) & 31); if (v >= lo && v <= hi) found.add(v); }
      else if ((h2 >> 11) === 6 && ((h2 >> 8) & 7) === rd) { const v = imm + (h2 & 255); if (v >= lo && v <= hi) found.add(v); }
      else if (imm >= lo && imm <= hi) found.add(imm);
    }
  }
  return found;
}

// Code ranges (GBA addresses) the keys' indexes must appear in. Independent of the map's evidence strings.
const CODE_CHECKS = {
  soulgold: [
    { range: [0x081EFBEC, 0x081EFE9C], what: 'GetBattleBGM', keys: ['battle_easy', 'battle_normal', 'battle_hard', 'battle_final', 'battle_rival', 'battle_villain', 'battle_frontier', 'battle_legendary'], lo: 350, hi: 1100 },
    { range: [0x0808B810, 0x0808B9D0], what: 'victory handler', keys: ['victory', 'victory_gym', 'victory_league'], lo: 350, hi: 1100 },
  ],
  ultraviolet: [
    { range: [0x08043FD4, 0x08044074], what: 'GetBattleBGM', keys: ['battle_easy', 'battle_normal', 'battle_hard', 'battle_final'], lo: 200, hi: 400 },
    { range: [0x08015690, 0x08015780], what: 'victory handler', keys: ['victory', 'victory_gym'], lo: 200, hi: 400, min: 2 },
  ],
};

// The ROMs' own class -> song switch tables. table = GBA address of a u32[] jump table indexed by (class - first);
// the target code's returned song constant must equal the map index for the key. 'direct' = a code address that
// returns the constant. Trainer classes were pinned by the trainers-table checks below (names -> class bytes).
const SELECTORS = {
  soulgold: [
    { what: 'battle selector', table: 0x087C6E3C, first: 3, count: 78, lo: 350, hi: 1100, cases: [['battle_hard', 31], ['battle_hard', 32], ['battle_final', 38], ['battle_rival', 50], ['battle_villain', 68], ['battle_villain', 80], ['battle_frontier', 58], ['battle_frontier', 64], ['battle_normal', 20]], direct: [['battle_easy', 0x081EFD44]] },
    { what: 'victory handler', table: 0x0843ABB8, first: 31, count: 23, lo: 350, hi: 1100, cases: [['victory_gym', 32], ['victory_league', 31], ['victory_league', 38], ['victory', 40]], direct: [] },
  ],
  ultraviolet: [
    { what: 'battle selector', table: 0x08044034, first: 83, count: 8, lo: 200, hi: 400, cases: [['battle_hard', 84], ['battle_hard', 87], ['battle_final', 90], ['battle_normal', 85]], direct: [['battle_easy', 0x0804406C]] },
    { what: 'victory handler', table: 0x08015734, first: 83, count: 8, lo: 200, hi: 400, cases: [['victory_gym', 84], ['victory_gym', 90], ['victory', 85]], direct: [] },
  ],
};
// first trainer with this name must have this class byte (pins the class numbers used above to real trainers)
const TRAINER_EXPECT = {
  soulgold: [['Falkner', 32], ['Bruno', 31], ['Lance', 38], ['Grunt', 68], ['Giovanni', 80]],
  ultraviolet: [['BROCK', 84], ['LORELEI', 87], ['GRUNT', 85]],
};
const SG_FANFARE_STOCK_NAMES = ['MUS-LEVEL-UP', 'MUS-OBTAIN-ITEM', 'MUS-EVOLVED', 'MUS-OBTAIN-TMHM', 'MUS-HEAL', 'MUS-OBTAIN-BADGE', 'MUS-MOVE-DELETED', 'MUS-OBTAIN-BERRY', 'MUS-AWAKEN-LEGEND', 'MUS-SLOTS-JACKPOT', 'MUS-SLOTS-WIN', 'MUS-TOO-BAD', 'MUS-RG-POKE-FLUTE', 'MUS-RG-OBTAIN-KEY-ITEM', 'MUS-RG-DEX-RATING', 'MUS-OBTAIN-B-POINTS', 'MUS-OBTAIN-SYMBOL', 'MUS-REGISTER-MATCH-CALL'];

// key -> sFanfares entry number per ROM
const FANFARE_ENTRY = {
  soulgold: { levelup: 0, item: 1, evolved: 2, tm: 3, heal: 4, badge: 5, move_deleted: 6, berry: 7, key_item: 13, se_levelup: 0 },
  ultraviolet: { levelup: 0, item: 1, evolved: 2, tm: 3, heal: 4, badge: 5, move_deleted: 6, berry: 7, key_item: 12, se_levelup: 0 },
};

// Gen3 charset (just what the song names need)
function decodeGen3(b, o, max = 48) {
  let s = '';
  for (let i = 0; i < max; i++) {
    const c = b[o + i];
    if (c === 0xFF) break;
    if (c >= 0xBB && c <= 0xD4) s += String.fromCharCode(65 + c - 0xBB);
    else if (c >= 0xD5 && c <= 0xEE) s += String.fromCharCode(97 + c - 0xD5);
    else if (c >= 0xA1 && c <= 0xAA) s += String.fromCharCode(48 + c - 0xA1);
    else if (c === 0xAE) s += '-';
    else if (c === 0) s += ' ';
    else s += '?';
  }
  return s.trim();
}
function sgSongName(rom, profile, idx) {
  const t = idx >= 1 && idx <= profile.seNamePointerTable.count ? { off: profile.seNamePointerTable.offset, i: idx - 1 }
    : (idx >= 350 && idx - profile.musNamePointerTable.firstSong < profile.musNamePointerTable.count ? { off: profile.musNamePointerTable.offset, i: idx - profile.musNamePointerTable.firstSong } : null);
  if (!t) return null;
  const p = rd32(rom, t.off + 4 * t.i);
  if (!inRom(rom, p)) return null;
  return decodeGen3(rom, p - 0x08000000);
}

// ------------------------------------------------------------------ the checks
// rec(name, ok, detail) records one check. `M` is the (possibly mutated) data; `roms` = { soulgold?:Buffer, ultraviolet?:Buffer }.
function runChecks(M, roms, rec, skip) {
  const REQUIRED_MUSIC = ['hub', 'editor', 'preview', 'battle_easy', 'battle_normal', 'battle_hard', 'battle_final', 'victory', 'defeat', 'result_win', 'result_lose', 'heal', 'levelup', 'hof', 'title'];
  const REQUIRED_SFX = ['se_cursor', 'se_select', 'se_back', 'se_hit_normal', 'se_hit_super', 'se_hit_weak', 'se_faint', 'se_ball_throw', 'se_ball_open', 'se_levelup', 'se_lowhp', 'se_exp', 'se_error'];
  const CONF = new Set(['high', 'medium', 'low']);

  rec('shape/soundtracks', JSON.stringify(M.SOUNDTRACKS) === JSON.stringify(['soulgold', 'ultraviolet']), JSON.stringify(M.SOUNDTRACKS));
  for (const k of REQUIRED_MUSIC) rec('coverage/required-music-key:' + k, M.MUSIC_KEYS.includes(k) && !!M.MAP[k], k);
  for (const k of REQUIRED_SFX) rec('coverage/required-sfx-key:' + k, M.SFX_KEYS.includes(k) && !!M.MAP[k], k);
  rec('shape/ALL_KEYS-matches-MAP', JSON.stringify([...M.ALL_KEYS].sort()) === JSON.stringify(Object.keys(M.MAP).sort()), 'ALL_KEYS vs MAP keys');

  for (const key of M.ALL_KEYS) {
    const row = M.MAP[key];
    for (const sk of M.SOUNDTRACKS) {
      const e = row && row[sk];
      if (!e) { rec(`entry/${sk}/${key}/present`, false, 'missing entry (must be an entry or an explicit {none:reason})'); continue; }
      if (e.none !== undefined) {
        rec(`entry/${sk}/${key}/null-has-reason`, typeof e.none === 'string' && e.none.length >= 20, String(e.none));
        continue;
      }
      rec(`entry/${sk}/${key}/fields`, Number.isInteger(e.index) && e.index > 0 && typeof e.loops === 'boolean' && typeof e.jingle === 'boolean' && e.loops === !e.jingle && typeof e.label === 'string' && e.label.length > 0, JSON.stringify(e).slice(0, 100));
      rec(`entry/${sk}/${key}/confidence`, CONF.has(e.confidence), String(e.confidence));
      rec(`entry/${sk}/${key}/evidence`, typeof e.evidence === 'string' && e.evidence.length >= 20, 'evidence string too short');
      if (e.confidence === 'low') rec(`entry/${sk}/${key}/low-is-flagged`, /UNVERIFIED-GUESS/.test(e.evidence), 'a low-confidence key must say UNVERIFIED-GUESS');
      if (e.index > M.ROM_PROFILES[sk].songCount - 1) rec(`entry/${sk}/${key}/index-in-profile-table`, false, `index ${e.index} >= songCount ${M.ROM_PROFILES[sk].songCount}`);
    }
  }
  // fallback chains terminate and reference known keys
  for (const [k, chain] of Object.entries(M.FALLBACKS)) {
    rec(`fallback/${k}/known`, !!M.MAP[k] && chain.every((c) => !!M.MAP[c] && c !== k), chain.join(','));
  }
  for (const sk of M.SOUNDTRACKS) {
    let unresolved = [];
    for (const k of M.MUSIC_KEYS) { if (!M.resolveSong(sk, k)) unresolved.push(k); }
    rec(`fallback/${sk}/every-music-key-resolves-or-is-explained`, unresolved.every((k) => M.MAP[k][sk].none !== undefined), unresolved.join(','));
  }

  // ---------------- ROM checks
  for (const sk of M.SOUNDTRACKS) {
    const rom = roms[sk];
    const prof = M.ROM_PROFILES[sk];
    if (!rom) { skip(`rom/${sk}`, 'ROM not found: ' + ROM_PATHS[sk]); continue; }
    rec(`rom/${sk}/size`, rom.length === prof.size, `${rom.length} vs ${prof.size}`);
    rec(`rom/${sk}/sha256`, crypto.createHash('sha256').update(rom).digest('hex') === prof.sha256, 'sha256 differs from the profile');
    rec(`rom/${sk}/profile-offset-matches-address`, prof.songTableAddress === 0x08000000 + prof.songTableOffset, 'songTableAddress != 0x08000000 + songTableOffset');
    rec(`rom/${sk}/header-code`, Buffer.from(rom.slice(0xAC, 0xB0)).toString('latin1') === prof.gameCode, 'game code');
    // song table: slot 0 is a dummy, the rest mostly valid songs
    let valid = 0;
    for (let i = 1; i < prof.songCount; i++) if (songAt(rom, prof, i).valid) valid++;
    rec(`rom/${sk}/song-table-has-songs`, valid >= (sk === 'soulgold' ? 690 : 340), `${valid} valid songs`);
    rec(`rom/${sk}/song-table-slot0-dummy`, !songAt(rom, prof, 0).valid, 'slot 0 must be the dummy song');
    // m4aSongNumStart's literal pool holds the song table address: proves songTableOffset is the table the code uses
    const fn = prof.codeAnchors.m4aSongNumStart - 0x08000000;
    let poolHit = false;
    for (let o = fn; o < fn + 0x60; o += 4) if (rd32(rom, o) === prof.songTableAddress) poolHit = true;
    rec(`rom/${sk}/m4aSongNumStart-pool-holds-song-table`, poolHit, 'no literal == songTableAddress within 0x60 bytes of m4aSongNumStart');

    for (const key of M.ALL_KEYS) {
      const e = M.MAP[key] && M.MAP[key][sk];
      if (!e || e.none !== undefined) continue;
      const s = songAt(rom, prof, e.index);
      rec(`rom/${sk}/${key}/header-parses`, s.valid, s.why || '');
      if (!s.valid) continue;
      rec(`rom/${sk}/${key}/loops-flag-matches-header`, s.loops === e.loops, `header loops=${s.loops} map loops=${e.loops}`);
      rec(`rom/${sk}/${key}/jingle-is-nonlooping`, e.jingle === !s.loops, `jingle=${e.jingle} header loops=${s.loops}`);
    }
    // code anchors
    for (const cc of CODE_CHECKS[sk]) {
      const consts = codeConstants(rom, cc.range[0], cc.range[1], cc.lo, cc.hi);
      rec(`rom/${sk}/${cc.what}/decoded-some-constants`, consts.size >= (cc.min || 3), `${consts.size} song constants decoded`);
      for (const key of cc.keys) {
        const e = M.MAP[key] && M.MAP[key][sk];
        if (!e || e.none !== undefined) continue;
        rec(`code/${sk}/${key}/index-is-a-constant-of-${cc.what.replace(/ /g, '-')}`, consts.has(e.index), `index ${e.index} not among {${[...consts].sort((a, b) => a - b).join(',')}}`);
      }
    }
    // fanfare tables
    const ft = prof.fanfareTable;
    for (const [key, n] of Object.entries(FANFARE_ENTRY[sk])) {
      const e = M.MAP[key] && M.MAP[key][sk];
      if (!e || e.none !== undefined) continue;
      const played = sk === 'soulgold' ? rd16(rom, ft.offset + ft.stride * n + 2) : rd16(rom, ft.offset + ft.stride * n);
      rec(`fanfare/${sk}/${key}/equals-sFanfares-entry-${n}`, played === e.index, `table says ${played}, map says ${e.index}`);
    }
    // trainers table: names -> class bytes
    const tt = prof.trainerTable;
    for (const [nm, cls] of TRAINER_EXPECT[sk]) {
      let got = null;
      for (let i = 0; i < tt.count; i++) { if (decodeGen3(rom, tt.offset + tt.stride * i + tt.nameOffset, 12) === nm) { got = rom[tt.offset + tt.stride * i + tt.classByteOffset]; break; } }
      rec(`trainers/${sk}/${nm}-has-class-${cls}`, got === cls, `first trainer named ${nm} has class ${got}`);
    }
    // class -> song switch tables
    for (const sel of SELECTORS[sk]) {
      for (const [key, cls] of sel.cases) {
        const e = M.MAP[key] && M.MAP[key][sk];
        if (!e || e.none !== undefined) continue;
        const idx = cls - sel.first;
        // classes outside the table take the default; the table's own default entries are checked via in-range cases
        const target = (idx >= 0 && idx < sel.count) ? (rd32(rom, sel.table - 0x08000000 + 4 * idx) & ~1) : null;
        const consts = target ? codeConstants(rom, target, target + 8, sel.lo, sel.hi) : new Set();
        rec(`selector/${sk}/${sel.what.replace(/ /g, '-')}/${key}/class-${cls}-returns-the-mapped-index`, consts.has(e.index), `target 0x${(target || 0).toString(16)} returns {${[...consts].join(',')}} map says ${e.index}`);
      }
      for (const [key, addr] of sel.direct) {
        const e = M.MAP[key] && M.MAP[key][sk];
        if (!e || e.none !== undefined) continue;
        const consts = codeConstants(rom, addr, addr + 8, sel.lo, sel.hi);
        rec(`selector/${sk}/${sel.what.replace(/ /g, '-')}/${key}/direct-return-0x${addr.toString(16)}`, consts.has(e.index), `returns {${[...consts].join(',')}} map says ${e.index}`);
      }
    }
    // SoulGold: names from the ROM's own name tables
    if (sk === 'soulgold') {
      // the name table's indexing is proven by the stock column of sFanfares (18 songs whose names are known)
      const stock = [];
      for (let n = 0; n < 18; n++) stock.push(sgSongName(rom, prof, rd16(rom, prof.fanfareTable.offset + prof.fanfareTable.stride * n)));
      rec('names/soulgold/sFanfares-stock-songs-carry-MUS-names', JSON.stringify(stock) === JSON.stringify(SG_FANFARE_STOCK_NAMES), stock.join(','));
      for (const key of M.ALL_KEYS) {
        const e = M.MAP[key].soulgold;
        if (!e || e.none !== undefined) continue;
        const m = /\b((?:SE|MUS)-[A-Z0-9][A-Z0-9-]*[A-Z0-9])/.exec(e.label);
        if (!m) continue;
        const rn = sgSongName(rom, prof, e.index);
        rec(`name/soulgold/${key}/label-equals-ROM-name-table`, rn === m[1], `label ${m[1]} vs ROM ${rn}`);
      }
    }
  }
  // Ultra Violet twin claims (need both ROMs)
  if (roms.soulgold && roms.ultraviolet) {
    const sgP = M.ROM_PROFILES.soulgold;
    const uvP = M.ROM_PROFILES.ultraviolet;
    for (const key of M.ALL_KEYS) {
      const e = M.MAP[key].ultraviolet;
      if (!e || e.none !== undefined) continue;
      const m = /SoulGold (?:song )?(\d+)/.exec(e.label);
      if (!m || !/twin|byte-identical/.test(e.label)) continue;
      const u = songAt(roms.ultraviolet, uvP, e.index);
      const g = songAt(roms.soulgold, sgP, +m[1]);
      rec(`twin/ultraviolet/${key}/stream-identical-to-soulgold-${m[1]}`, u.valid && g.valid && u.sig === g.sig, `UV ${e.index} sig ${u.sig} vs SG ${m[1]} sig ${g.sig}`);
    }
  } else {
    skip('twin/ultraviolet', 'needs both ROMs');
  }
}

// ------------------------------------------------------------------ driver
const M = await import(MAP_URL);
const data = {
  SOUNDTRACKS: M.SOUNDTRACKS, MUSIC_KEYS: M.MUSIC_KEYS, SFX_KEYS: M.SFX_KEYS, ALL_KEYS: M.ALL_KEYS,
  ROM_PROFILES: M.ROM_PROFILES, MAP: M.MAP, FALLBACKS: M.FALLBACKS, resolveSong: M.resolveSong,
};
const roms = {};
for (const sk of ['soulgold', 'ultraviolet']) if (fs.existsSync(ROM_PATHS[sk])) roms[sk] = fs.readFileSync(ROM_PATHS[sk]);

let pass = 0, fail = 0, skipped = 0;
const failures = [];
const skips = [];
const rec = (name, ok, detail) => { if (ok) pass++; else { fail++; failures.push(name + ' :: ' + detail); } };
const skip = (name, why) => { skipped++; skips.push(name + ' :: ' + why); };
runChecks(data, roms, rec, skip);

// API behaviour of the real module
rec('api/songFor-shape', (() => { const s = M.songFor('soulgold', 'battle_easy'); return s && s.index === 887 && s.loops === true && s.jingle === false && typeof s.label === 'string'; })(), 'songFor(soulgold,battle_easy)');
rec('api/songFor-null-for-explained-gap', M.songFor('ultraviolet', 'battle_villain') === null && /generic trainer theme/.test(M.whyNull('ultraviolet', 'battle_villain')), 'ultraviolet battle_villain');
rec('api/songFor-unknown-key', M.songFor('soulgold', 'nope') === null && /unknown key/.test(M.whyNull('soulgold', 'nope')), 'unknown key');
rec('api/songFor-unknown-soundtrack', M.songFor('nope', 'hub') === null && /unknown soundtrack/.test(M.whyNull('nope', 'hub')), 'unknown soundtrack');
rec('api/resolveSong-falls-back', (() => { const r = M.resolveSong('ultraviolet', 'battle_villain'); return r && r.key === 'battle_normal' && r.requested === 'battle_villain'; })(), 'villain -> normal');
rec('api/importing-twice-yields-identical-data', JSON.stringify((await import(MAP_URL + '?again=1')).MAP) === JSON.stringify(M.MAP), 'second import differs');
const frozenCheck = JSON.stringify(M.MAP);
M.songFor('soulgold', 'hub'); M.resolveSong('soulgold', 'hub');
rec('api/songFor-does-not-mutate-MAP', JSON.stringify(M.MAP) === frozenCheck, 'MAP changed');

const pristineFailures = failures.length;
const pristinePass = pass;
let mutantsRun = 0, mutantsTripped = 0;

// ------------------------------------------------------------------ negative controls
// Each mutant must make the NAMED check fail; the unmutated run above must have stayed quiet.
const clone = (o) => structuredClone(o);
function runMutant(label, mutate, mustFail, { needRom } = {}) {
  if (needRom && !roms[needRom]) { skip('mutant/' + label, 'needs ROM ' + needRom); return; }
  mutantsRun++;
  const d = clone({ SOUNDTRACKS: data.SOUNDTRACKS, MUSIC_KEYS: data.MUSIC_KEYS, SFX_KEYS: data.SFX_KEYS, ALL_KEYS: data.ALL_KEYS, ROM_PROFILES: data.ROM_PROFILES, MAP: data.MAP, FALLBACKS: data.FALLBACKS });
  d.resolveSong = data.resolveSong; // resolves against the pristine map, mutants only target data checks
  const r = {};
  for (const k of Object.keys(roms)) r[k] = roms[k];
  const mutated = mutate(d, r) || {};
  const got = [];
  runChecks(d, mutated.roms || r, (name, ok, detail) => { if (!ok) got.push(name); }, () => {});
  const hit = got.some((n) => n === mustFail || n.startsWith(mustFail));
  if (hit) { pass++; mutantsTripped++; } else { fail++; failures.push(`mutant "${label}" did NOT trip a check starting with "${mustFail}" (tripped: ${got.slice(0, 5).join('; ') || 'nothing'})`); }
}

runMutant('battle_easy index -1 (no longer a constant of the selector)', (d) => { d.MAP.battle_easy.soulgold.index -= 1; }, 'code/soulgold/battle_easy/index-is-a-constant-of-GetBattleBGM', { needRom: 'soulgold' });
runMutant('UV battle_hard index -1', (d) => { d.MAP.battle_hard.ultraviolet.index -= 1; }, 'code/ultraviolet/battle_hard/index-is-a-constant-of-GetBattleBGM', { needRom: 'ultraviolet' });
runMutant('victory index points at another song', (d) => { d.MAP.victory.soulgold.index = 900; }, 'code/soulgold/victory/index-is-a-constant-of-victory-handler', { needRom: 'soulgold' });
runMutant('heal flag flipped to looping', (d) => { d.MAP.heal.soulgold.loops = true; d.MAP.heal.soulgold.jingle = false; }, 'rom/soulgold/heal/loops-flag-matches-header', { needRom: 'soulgold' });
runMutant('battle_normal marked as a jingle', (d) => { d.MAP.battle_normal.soulgold.loops = false; d.MAP.battle_normal.soulgold.jingle = true; }, 'rom/soulgold/battle_normal/loops-flag-matches-header', { needRom: 'soulgold' });
runMutant('se_cursor index out of the table', (d) => { d.MAP.se_cursor.ultraviolet.index = 99999; }, 'entry/ultraviolet/se_cursor/index-in-profile-table');
runMutant('se_cursor index points at a dummy slot', (d) => { d.MAP.se_cursor.soulgold.index = 300; }, 'rom/soulgold/se_cursor/header-parses', { needRom: 'soulgold' });
runMutant('levelup points at the unreplaced stock fanfare', (d) => { d.MAP.levelup.soulgold.index = 367; }, 'fanfare/soulgold/levelup/equals-sFanfares-entry-0', { needRom: 'soulgold' });
runMutant('UV heal fanfare off by one', (d) => { d.MAP.heal.ultraviolet.index = 257; }, 'fanfare/ultraviolet/heal/equals-sFanfares-entry-4', { needRom: 'ultraviolet' });
runMutant('ROM profile sha256 wrong', (d) => { d.ROM_PROFILES.soulgold.sha256 = '0'.repeat(64); }, 'rom/soulgold/sha256', { needRom: 'soulgold' });
runMutant('song table offset wrong', (d) => { d.ROM_PROFILES.soulgold.songTableOffset += 8; }, 'rom/soulgold/profile-offset-matches-address', { needRom: 'soulgold' });
runMutant('SoulGold label names the wrong song', (d) => { d.MAP.se_error.soulgold.label = 'SE-SUCCESS (wrong)'; }, 'name/soulgold/se_error/label-equals-ROM-name-table', { needRom: 'soulgold' });
runMutant('UV twin claim names the wrong SoulGold song', (d) => { d.MAP.hub.ultraviolet.label = 'FRLG POKE-CENTER (twin of SoulGold 516 MUS-RG-SS-ANNE)'; }, 'twin/ultraviolet/hub/stream-identical-to-soulgold-516', { needRom: 'ultraviolet' });
runMutant('required key removed', (d) => { delete d.MAP.defeat; d.ALL_KEYS = d.ALL_KEYS.filter((k) => k !== 'defeat'); d.MUSIC_KEYS = d.MUSIC_KEYS.filter((k) => k !== 'defeat'); }, 'coverage/required-music-key:defeat');
runMutant('entry deleted for a soundtrack', (d) => { delete d.MAP.hub.ultraviolet; }, 'entry/ultraviolet/hub/present');
runMutant('null entry without a reason', (d) => { d.MAP.battle_villain.ultraviolet = { none: '' }; }, 'entry/ultraviolet/battle_villain/null-has-reason');
runMutant('low-confidence entry without UNVERIFIED-GUESS', (d) => { d.MAP.result_lose.soulgold.evidence = 'sounds sad to me, trust me please ok'; }, 'entry/soulgold/result_lose/low-is-flagged');
runMutant('bad confidence value', (d) => { d.MAP.hub.soulgold.confidence = 'certain'; }, 'entry/soulgold/hub/confidence');
runMutant('loops/jingle both true', (d) => { d.MAP.hub.soulgold.jingle = true; d.MAP.hub.soulgold.loops = true; }, 'entry/soulgold/hub/fields');
runMutant('corrupted ROM byte in the SoulGold fanfare table', (d, r) => {
  const copy = Buffer.from(r.soulgold);
  copy[d.ROM_PROFILES.soulgold.fanfareTable.offset + 8 * 4 + 2] ^= 1; // heal's played-song field
  return { roms: { ...r, soulgold: copy } };
}, 'fanfare/soulgold/heal/equals-sFanfares-entry-4', { needRom: 'soulgold' });
runMutant('corrupted ROM byte in the song table (heal header pointer)', (d, r) => {
  const copy = Buffer.from(r.soulgold);
  const p = d.ROM_PROFILES.soulgold.songTableOffset + 8 * d.MAP.heal.soulgold.index + 3;
  copy[p] = 0x00; // top byte of the pointer: no longer a ROM address
  return { roms: { ...r, soulgold: copy } };
}, 'rom/soulgold/heal/header-parses', { needRom: 'soulgold' });
runMutant('corrupted code: selector constant replaced in the ROM', (d, r) => {
  const copy = Buffer.from(r.soulgold);
  // the literal 0x377 (887) at 0x081EFE1C is the wild-battle return value
  const a = 0x1EFE1C;
  if (copy.readUInt32LE(a) === 887) copy.writeUInt32LE(886, a);
  return { roms: { ...r, soulgold: copy } };
}, 'code/soulgold/battle_easy/index-is-a-constant-of-GetBattleBGM', { needRom: 'soulgold' });

runMutant('selector jump-table entry for class 32 retargeted to the default', (d, r) => {
  const copy = Buffer.from(r.soulgold);
  copy.writeUInt32LE(0x081EFD0B, 0x7C6E3C + 4 * (32 - 3));
  return { roms: { ...r, soulgold: copy } };
}, 'selector/soulgold/battle-selector/battle_hard/class-32-returns-the-mapped-index', { needRom: 'soulgold' });
runMutant('UV victory table: champion class retargeted to the default', (d, r) => {
  const copy = Buffer.from(r.ultraviolet);
  copy.writeUInt32LE(0x0801575F, 0x15734 + 4 * (90 - 83));
  return { roms: { ...r, ultraviolet: copy } };
}, 'selector/ultraviolet/victory-handler/victory_gym/class-90-returns-the-mapped-index', { needRom: 'ultraviolet' });
runMutant('trainer class byte corrupted (Falkner no longer class 32)', (d, r) => {
  const copy = Buffer.from(r.soulgold);
  copy[0x497FBC + 52 * 19 + 28] = 33;
  return { roms: { ...r, soulgold: copy } };
}, 'trainers/soulgold/Falkner-has-class-32', { needRom: 'soulgold' });
runMutant('song-name table shifted by one entry', (d) => { d.ROM_PROFILES.soulgold.musNamePointerTable.offset += 4; }, 'names/soulgold/sFanfares-stock-songs-carry-MUS-names', { needRom: 'soulgold' });

// ------------------------------------------------------------------ report
console.log(`pokemonarena_music_map_test: ${pass} passed, ${fail} failed, ${skipped} skipped`);
console.log(`  unmutated run: ${pristinePass} checks passed, ${pristineFailures} failed (must be 0)`);
console.log(`  negative controls: ${mutantsTripped}/${mutantsRun} mutants tripped their named check`);
if (skipped) { console.log('SKIPPED (loud):'); for (const s of skips) console.log('  SKIP ' + s); }
if (fail) { console.log('FAILURES:'); for (const f of failures) console.log('  FAIL ' + f); }
console.log(`ROMs: soulgold=${roms.soulgold ? 'present' : 'ABSENT'} ultraviolet=${roms.ultraviolet ? 'present' : 'ABSENT'}`);
process.exit(fail ? 1 : 0);

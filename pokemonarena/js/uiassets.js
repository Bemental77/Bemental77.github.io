// pokemonarena/js/uiassets.js
//
// Locates and decodes the battle UI art and fonts of the SoulGold v1.1.1 ROM, at runtime, from the ROM bytes the
// caller supplies. Pure ES module (browser + Node): Uint8Array / DataView only. Nothing ROM-derived is stored
// here: the file holds hand-written code, ROM OFFSETS, and layout rules only. Every offset was found by
// enumerating the ROM's compressed blobs / literal-pool references and then confirmed by decoding the asset and
// looking at it (tools/pokemonarena_ui_assets_test.mjs writes the contact sheets; ui_assets.golden.json holds the
// per-asset hashes, no pixels).
//
//   import { loadUiAssets, ROM_SHA256 } from './uiassets.js';
//   const ui = loadUiAssets(romBytes);          // throws UiAssetError on a wrong length / header
//   const a = ui.get('icon.types');             // { width, height, pixels (indices), palette (u16 BGR555), meta }
//   const text = ui.renderText('normal', 'What will PIKACHU do?', { fg: [24,24,24], shadow: [208,208,200] });
//
// Asset keys (ui.keys()):  see ASSET_DEFS below; each entry documents its offsets, compression, size, bpp and
// palette source in `manifest` form (ui.manifest()).

import {
  GfxError, smolDecode, smolTilemapDecode, tilesToBitmap, renderTilemap, cropBitmap, readPalette,
  paletteToRGBA, bitmapToRGBA, decodeGlyph2bpp,
} from './gfxcodec.js';

export class UiAssetError extends Error {
  constructor(msg) { super(msg); this.name = 'UiAssetError'; }
}

export const ROM_LENGTH = 33554432;
export const ROM_SHA256 = '8071e2c348d54c3ec7b78b53837c5cbd757d5cfc461a50fa5ffbc9f5ab35060a';
export const ROM_MD5 = 'b2c5caf9bc6dd28a44052427ee3ab1b7';
export const ROM_TITLE = 'POKEMON EMER';   // header 0xA0..0xAB
export const ROM_GAME_CODE = 'BPEE';       // header 0xAC..0xAF

function ascii(rom, o, n) { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(rom[o + i]); return s; }

// Cheap structural check (length + cartridge header). The caller should additionally verify ROM_SHA256 with
// WebCrypto before enabling online features; offsets below are specific to that exact build.
export function validateRom(rom) {
  if (!(rom instanceof Uint8Array)) throw new UiAssetError('ROM must be a Uint8Array');
  if (rom.length !== ROM_LENGTH) throw new UiAssetError('ROM length ' + rom.length + ' != ' + ROM_LENGTH + ' (expected the 32 MiB SoulGold v1.1.1 image)');
  const title = ascii(rom, 0xA0, 12), code = ascii(rom, 0xAC, 4);
  if (title !== ROM_TITLE || code !== ROM_GAME_CODE) {
    throw new UiAssetError('ROM header is "' + title + '"/"' + code + '", expected "' + ROM_TITLE + '"/"' + ROM_GAME_CODE + '"');
  }
  return true;
}

const u16 = (rom, o) => rom[o] | (rom[o + 1] << 8);
const u32 = (rom, o) => (rom[o] | (rom[o + 1] << 8) | (rom[o + 2] << 16) | (rom[o + 3] << 24)) >>> 0;
const romOff = (rom, p) => {
  if (p < 0x08000000 || p >= 0x08000000 + rom.length) throw new UiAssetError('pointer 0x' + p.toString(16) + ' is not a ROM address');
  return p - 0x08000000;
};

/* ---------------------------------------------------------------------------------------------- text */

// Gen-3 character codes for the ASCII a UI string needs. 0xF9 xx is the engine's "extra symbol" prefix: it
// selects glyph 0x100+xx (Lv / PP / ID / No. and the arrow glyphs). Verified by rendering every glyph of the
// normal font (contact sheet font_normal_all.png in the test output).
const CHARMAP = (() => {
  const m = new Map();
  m.set(' ', [0x00]); m.set('!', [0xAB]); m.set('?', [0xAC]); m.set('.', [0xAD]); m.set('-', [0xAE]);
  m.set(',', [0xB8]); m.set('/', [0xBA]); m.set(':', [0xF0]); m.set('\'', [0xB4]); m.set('"', [0xB1]);
  m.set('&', [0x2D]); m.set('+', [0x2E]); m.set('=', [0x35]); m.set(';', [0x36]); m.set('%', [0x5B]);
  m.set('(', [0x5C]); m.set(')', [0x5D]); m.set('é', [0x1B]); m.set('…', [0xB0]);
  m.set('×', [0xB9]); m.set('♂', [0xB5]); m.set('♀', [0xB6]); m.set('▶', [0xEF]);
  for (let i = 0; i < 10; i++) m.set(String(i), [0xA1 + i]);
  for (let i = 0; i < 26; i++) { m.set(String.fromCharCode(65 + i), [0xBB + i]); m.set(String.fromCharCode(97 + i), [0xD5 + i]); }
  return m;
})();
const TOKENS = {
  LV: [0xF9, 0x05], PP: [0xF9, 0x06], ID: [0xF9, 0x07], NO: [0xF9, 0x08],
  UP: [0xF9, 0x00], DOWN: [0xF9, 0x01], LEFT: [0xF9, 0x02], RIGHT: [0xF9, 0x03],
  CURSOR: [0xEF], MALE: [0xB5], FEMALE: [0xB6], PK: [0x53], MN: [0x54], E: [0x1B],
};

// "What will PIKACHU do?" -> glyph ids (0..511). {LV} {PP} {ID} {NO} {CURSOR} {MALE} {FEMALE} {E}(e-acute) are
// tokens; unknown characters throw rather than silently dropping.
export function encodeText(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '{') {
      const j = str.indexOf('}', i);
      const name = j > 0 ? str.slice(i + 1, j).toUpperCase() : '';
      if (!TOKENS[name]) throw new UiAssetError('unknown text token ' + str.slice(i, j + 1));
      const t = TOKENS[name];
      if (t[0] === 0xF9) out.push(0x100 + t[1]); else out.push(t[0]);
      i = j; continue;
    }
    const c = CHARMAP.get(ch);
    if (!c) throw new UiAssetError('no Gen-3 charset code for ' + JSON.stringify(ch));
    out.push(c[0]);
  }
  return out;
}

// Gen-3 character codes (as stored in ROM strings, 0xFF terminated) -> JS string, for the characters the map
// covers; unknown codes become '?'. Used for species / move names.
const REVERSE = (() => { const r = new Map(); for (const [k, v] of CHARMAP) if (v.length === 1 && !r.has(v[0])) r.set(v[0], k); return r; })();
export function decodeGen3String(rom, off, maxLen = 32) {
  let s = '';
  for (let i = 0; i < maxLen; i++) {
    const b = rom[off + i];
    if (b === 0xFF) break;
    s += REVERSE.get(b) || '?';
  }
  return s;
}

/* -------------------------------------------------------------------------------------------- fonts */
// The font glyph arrays sit at a 0x8200 pitch: [512 width bytes][512 glyphs * 64 bytes]. The font ids are the
// ids of the ROM's FontInfo table (ROM 0x111ab64, 12-byte entries) and sGlyphWidthFuncs (ROM 0x1118ad0); each
// id's glyph/width pair was resolved through the GetGlyphWidth_* literal pools (0x25a6d0..0x25a7b4), not guessed.
export const FONT_INFO_TABLE = 0x111ab64;
export const FONT_DEFS = [
  { name: 'small',       id: 0,  glyphs: 0x626524 },
  { name: 'normal',      id: 1,  glyphs: 0x60df24 },
  { name: 'short',       id: 2,  glyphs: 0x616124 },
  { name: 'narrow',      id: 7,  glyphs: 0x61e324 },
  { name: 'smallNarrow', id: 8,  glyphs: 0x62e724 },
  { name: 'font10',      id: 10, glyphs: 0x605d24 },
  { name: 'font11',      id: 11, glyphs: 0x5fdb24 },
  { name: 'font12',      id: 12, glyphs: 0x5f5924 },
  { name: 'font13',      id: 13, glyphs: 0x5ed724 },
];
const GLYPH_COUNT = 512;

function readFontInfo(rom, id) {
  const o = FONT_INFO_TABLE + id * 12;
  const s8 = (v) => (v > 127 ? v - 256 : v);
  return {
    fontFunction: u32(rom, o), maxLetterWidth: rom[o + 4], maxLetterHeight: rom[o + 5],
    letterSpacing: s8(rom[o + 6]), lineSpacing: s8(rom[o + 7]),
    fgColor: rom[o + 8], bgColor: rom[o + 9], shadowColor: rom[o + 10],
  };
}

function makeFont(rom, def) {
  const cache = new Map();
  const widthsOff = def.glyphs - 0x200;
  return {
    name: def.name, id: def.id, glyphsOffset: def.glyphs, widthsOffset: widthsOff,
    info: readFontInfo(rom, def.id),
    width(g) { return rom[widthsOff + g]; },
    // 16x16 cell of roles 0/1/2 (see gfxcodec.decodeGlyph2bpp)
    glyph(g) {
      let c = cache.get(g);
      if (!c) { c = decodeGlyph2bpp(rom, def.glyphs + g * 64); cache.set(g, c); }
      return c;
    },
  };
}

// Width in pixels of a glyph-id list / string (sum of the ROM width table plus the FontInfo letterSpacing).
export function measureGlyphs(font, ids) {
  let w = 0;
  for (const g of ids) w += font.width(g) + font.info.letterSpacing;
  return w;
}

// Draw glyph ids into a role bitmap {width,height,pixels}: later glyphs overwrite earlier non-zero pixels the
// way the engine's window buffer does. Height is the 16-row glyph cell.
export function drawGlyphs(font, ids, opts = {}) {
  const pad = opts.pad === undefined ? 2 : opts.pad;          // glyphs can ink 1-2 px past their advance width
  const w = measureGlyphs(font, ids) + pad, h = 16;
  const pixels = new Uint8Array(w * h);
  let x = 0;
  for (const g of ids) {
    const gl = font.glyph(g);
    const gw = Math.min(16, font.width(g));       // FA1: the game blits only the glyph's own width of its 16-px cell (CopyGlyphToWindow); the cell's right half can hold stray ink past it
    for (let y = 0; y < h; y++) {
      for (let gx = 0; gx < gw; gx++) {
        const v = gl.pixels[y * 16 + gx];
        if (v && x + gx < w) pixels[y * w + x + gx] = v;
      }
    }
    x += font.width(g) + font.info.letterSpacing;
  }
  return { width: w, height: h, pixels };
}

/* ------------------------------------------------------------------------------------ asset manifest */
//
// Each def: { key, group, desc, offsets:{}, compression, bpp, palette:'<source>', notes, decode(rom) }
// decode returns { width, height, pixels, palette (Uint16Array|null), meta (Uint8Array|null) }.

const PAL_HEALTHBOX = 0x72140c;   // sprite palette tag 0xD6FF (SpritePalette record at 0x437730)
const PAL_HPBAR = 0x716bdc;       // sprite palette tag 0xD704 (record at 0x437738): green / yellow / red HP bar colours
const PAL_TEXTBOX = 0x73a130;     // 32 colours, banks 0 and 1 of the battle textbox
export const BATTLE_TEXT_PALETTE = 0x6cd02c;   // 16 colours: text colours of the battle windows (white 0xE, dark 0xC/0xD, light grey 0xF)

const TEXTBOX_TILES = 0x73a170, TEXTBOX_TILEMAP = 0x73a09c;
const WINDOW_FRAME_TILES = 0x111d218;
const WINDOW_FRAME_PALETTE = 0x111b8d8;        // FA1: the window-frame palette the real game puts in BG palette bank 1 (see textboxParts)
export const WINDOW_TEMPLATES = 0x430278;      // 8-byte WindowTemplate entries (sStandardBattleWindowTemplates), 0xFF terminated at +0x...
const ENV_RECORDS = 0x430498, ENV_STRIDE = 0x40, ENV_SLOTS = 40;

function bm(width, height, pixels, palette, meta = null) { return { width, height, pixels, palette, meta }; }

function fontSheet(rom, def) {
  const f = makeFont(rom, def);
  const cols = 16, rows = GLYPH_COUNT / cols;
  const W = cols * 16, H = rows * 16;
  const pixels = new Uint8Array(W * H);
  for (let g = 0; g < GLYPH_COUNT; g++) {
    const gl = f.glyph(g);
    const ox = (g % cols) * 16, oy = Math.floor(g / cols) * 16;
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) pixels[(oy + y) * W + ox + x] = gl.pixels[y * 16 + x];
  }
  const widths = new Uint8Array(GLYPH_COUNT);
  for (let g = 0; g < GLYPH_COUNT; g++) widths[g] = f.width(g);
  return bm(W, H, pixels, null, widths);
}

function tileRun(rom, off, count, perRow, paletteOff) {
  const rows = Math.ceil(count / perRow);
  const b = tilesToBitmap(rom.subarray(off, off + count * 32), perRow, rows);
  return bm(b.width, b.height, b.pixels, readPalette(rom, paletteOff, 16));
}

// The healthbox "element" graphics (HP label, HP bar fill steps, EXP bar fill steps) are NOT stored as independent 8x8
// tiles. They are stored as one vertical column of 8-px-wide art in which each element is a ~7-row block that starts
// part-way down a tile and spills into the top rows of the NEXT tile:
//   * the "H" of the label is the lower 4 rows of the tile at 0x7202a0 + the upper 3 rows of the tile at 0x7202c0
//     (the H's two stems and bottom border run straight across that tile boundary); the "P" is the lower 4 rows of
//     0x7202c0 + the upper rows of 0x7202e0 (which is where the P's leg, '1cc11111', sits);
//   * every HP fill step is rows 4..7 of its tile (dark, dark, fill, fill) + rows 0..3 of the next tile (dark, dark,
//     shadow, transparent): rows 3 of every such tile is the transparent separator row between two blocks;
//   * the EXP steps are the same idea one row earlier (rows 3..7 + rows 0..2), their separator being row 2.
// Drawn tile-by-tile (the old decode) this gave a dark "lid" with floating dashes and a bar with no bottom border.
// Measured, not recalled: the continuity of the strokes across each boundary, and the separator rows, are in the
// ROM bytes (tools/pokemonarena_ui_assets_test.mjs asserts both, with a mutant that breaks them).
// `phase` = the row of tile e where element e starts. The rows that spill past the end of a strip come from `tailOff`
// (a tile whose rows 0..phase-1 are the generic block bottom), never from whatever file happens to follow in ROM.
// Returns an indexed bitmap `count` elements wide, 8 rows tall.
export function stackedElements(rom, off, count, phase, tailOff) {
  const w = count * 8, pixels = new Uint8Array(w * 8);
  for (let e = 0; e < count; e++) {
    for (let y = 0; y < 8; y++) {
      const srow = phase + y;
      const toff = srow >= 8 ? (e + 1 < count ? off + (e + 1) * 32 : tailOff) : off + e * 32;
      const r = srow & 7;
      for (let x = 0; x < 8; x++) {
        const b = rom[toff + r * 4 + (x >> 1)];
        pixels[y * w + e * 8 + x] = (x & 1) ? (b >> 4) : (b & 15);
      }
    }
  }
  return { width: w, height: 8, pixels };
}

function elementRun(rom, off, count, phase, tailOff, paletteOff) {
  const b = stackedElements(rom, off, count, phase, tailOff);
  return bm(b.width, b.height, b.pixels, readPalette(rom, paletteOff, 16));
}

function smolSheet(rom, off, tilesW, tilesH, paletteOff, opts) {
  const d = smolDecode(rom, off).data;
  const b = tilesToBitmap(d, tilesW, tilesH, opts);
  return bm(b.width, b.height, b.pixels, readPalette(rom, paletteOff, 16));
}

function textboxParts(rom) {
  const tiles = Uint8Array.from(smolDecode(rom, TEXTBOX_TILES).data);
  // FA1: BG tiles 0x12..0x1a of the real battle screen are the player's WINDOW FRAME graphics, not the ones in the textbox tileset: 9 raw 4bpp tiles at ROM
  // 0x111d218 (the frame type whose palette is 0x111b8d8), copied with colour index 0 turned into 15. Found by matching the real VRAM tile 0x12 against every
  // 32-byte window of the ROM up to a one-to-one nibble remap (the only hits: 0x111d218 with 0 -> 15, and the neighbouring frame type 0x111d0f8).
  for (let k = 0; k < 9 * 32; k++) { const b = rom[WINDOW_FRAME_TILES + k], lo = b & 15, hi = b >> 4; tiles[0x12 * 32 + k] = (lo === 0 ? 15 : lo) | ((hi === 0 ? 15 : hi) << 4); }
  const map = smolTilemapDecode(rom, TEXTBOX_TILEMAP).entries;
  // FA1: BG palette bank 1 of the real battle screen is NOT the second bank of 0x73a130: the game loads the player's WINDOW FRAME palette there (the menu-window ring
  // is blue-white in the real frames, black in the old decode). The oracle's palette RAM bank 1 matches ROM 0x111b8d8 byte for byte (the first frame type's 16 colours);
  // bank 0 still equals 0x73a130 bank 0.
  const pal = new Uint16Array(32);
  pal.set(readPalette(rom, PAL_TEXTBOX, 16), 0); pal.set(readPalette(rom, WINDOW_FRAME_PALETTE, 16), 16);
  pal[16] = pal[2];       // colour 0 of the frame bank is transparent: the real frame shows the 0x4a4252 base (bank 0 colour 2) through it
  return { tiles, map, palette: pal };
}
// The three battle windows live on different rows of the one 32x64 tilemap (BG0 pages): message box rows 14-19,
// action prompt + action menu rows 34-39, move/PP/type windows rows 54-59, x = 0..29 (30 tiles = 240 px).
const TEXTBOX_REGIONS = { message: 14, actionMenu: 34, moves: 54 };
function textboxRegion(rom, name) {
  const { tiles, map, palette } = textboxParts(rom);
  const full = renderTilemap(tiles, map, 32, 64);
  const c = cropBitmap(full, 0, TEXTBOX_REGIONS[name] * 8, 240, 48);
  return bm(c.width, c.height, c.pixels, palette);
}

// Battle environment record: 5 pointers {tileset(smol), tilemap(smolTM 32x32), entryTileset(smol),
// entryTilemap(smolTM 64x32), palette(raw, up to 5 banks)}. A scene is two BG layers over a backdrop: the
// "entry" layer (far/ground, uses palette banks 0 and 2) with the main terrain layer on top (its tilemap
// stores palette bank 4, which maps to palette bank 0). Pixel value 0 is transparent in both layers.
function envRecordOffsets(rom, i) {
  const o = ENV_RECORDS + i * ENV_STRIDE;
  const p = [0, 1, 2, 3, 4].map((k) => u32(rom, o + 4 * k));
  if (!p.every((v) => v >= 0x08000000 && v < 0x08000000 + rom.length)) return null;
  return p.map((v) => v - 0x08000000);
}
export function envScene(rom, i) {
  const p = envRecordOffsets(rom, i);
  if (!p) throw new UiAssetError('no battle environment record ' + i);
  const W = 240, H = 160;
  const tiles = smolDecode(rom, p[0]).data, tm = smolTilemapDecode(rom, p[1]).entries;
  const etiles = smolDecode(rom, p[2]).data, em = smolTilemapDecode(rom, p[3]).entries;
  const raw = readPalette(rom, p[4], 80);
  const pal = new Uint16Array(256);
  for (let k = 0; k < 80; k++) pal[k] = raw[k];                       // entry layer: bank b -> raw bank b
  const ent = cropBitmap(renderTilemap(etiles, em, 64, 32), 0, 0, W, H);
  const main = cropBitmap(renderTilemap(tiles, tm, 32, 32), 0, 0, W, H);
  const pixels = new Uint8Array(W * H);
  for (let k = 0; k < W * H; k++) {
    if (ent.pixels[k] & 15) pixels[k] = ent.pixels[k];
    const m = main.pixels[k];
    if (m & 15) pixels[k] = (m & 15);                                // main layer bank 4 -> raw bank 0
  }
  return bm(W, H, pixels, pal);
}

export const ASSET_DEFS = [];
function def(d) { ASSET_DEFS.push(d); }

for (const f of FONT_DEFS) {
  def({
    key: 'font.' + f.name, group: 'R1 fonts', desc: 'font id ' + f.id + ' glyph sheet: 512 glyphs, 16 per row, 16x16 cells; meta = 512 advance widths',
    offsets: { glyphs: f.glyphs, widths: f.glyphs - 0x200, fontInfo: FONT_INFO_TABLE + f.id * 12 }, compression: 'none (raw)', bpp: 2,
    palette: 'none: pixel values are roles 0 bg, 1 foreground, 2 shadow (3 folded to 0)', width: 256, height: 512,
    notes: 'ids from FontInfo @0x111ab64 / sGlyphWidthFuncs @0x1118ad0; glyph+width pair resolved via GetGlyphWidth literal pools',
    decode: (rom) => fontSheet(rom, f),
  });
}
def({
  key: 'battle.textPalette', group: 'R2 textbox', desc: 'battle window text colour palette (white 0xE, dark 0xC/0xD, light grey 0xF)',
  offsets: { palette: BATTLE_TEXT_PALETTE }, compression: 'none', bpp: 4, palette: 'self', width: 16, height: 1,
  notes: 'found as a literal-pool target of the battle window setup code at 0x5b008; assignment of fg/bg/shadow indices per window is NOT read from ROM',
  decode: (rom) => bm(16, 1, new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]), readPalette(rom, BATTLE_TEXT_PALETTE, 16)),
});
def({
  key: 'textbox.tiles', group: 'R2 textbox', desc: 'battle textbox tile set, 16x16 tiles',
  offsets: { tiles: TEXTBOX_TILES, palette: PAL_TEXTBOX }, compression: 'smol mode 6', bpp: 4, palette: '0x73a130, 32 colours (2 banks)', width: 128, height: 128,
  decode: (rom) => { const p = textboxParts(rom); const b = tilesToBitmap(p.tiles, 16, 16); return bm(128, 128, b.pixels, p.palette); },
});
for (const [name, row] of Object.entries(TEXTBOX_REGIONS)) {
  def({
    key: 'textbox.' + name, group: 'R2 textbox', desc: 'composited battle window art, tilemap rows ' + row + '..' + (row + 5) + ' x 0..29 (pixel = bank*16+index)',
    offsets: { tiles: TEXTBOX_TILES, tilemap: TEXTBOX_TILEMAP, palette: PAL_TEXTBOX, windowTemplates: WINDOW_TEMPLATES }, compression: 'smol mode 6 tiles + smol mode 8 tilemap',
    bpp: 4, palette: '0x73a130, 32 colours', width: 240, height: 48,
    notes: name === 'message' ? 'B_WIN_MSG interior x2..27, y15..18 (tiles)' : name === 'actionMenu' ? 'left box = B_WIN_ACTION_PROMPT (x1,y35,14x4), right box = B_WIN_ACTION_MENU (x17,y35,12x4); y offsets are tilemap rows' : 'B_WIN_MOVE_NAME_1..4, PP, type windows at rows 55-58',
    decode: (rom) => textboxRegion(rom, name),
  });
}
const HB_SHEETS = [
  ['singlesPlayer', 0x716f38, 16, 8], ['singlesOpponent', 0x716e68, 16, 4], ['doublesPlayer', 0x716db0, 16, 4],
  ['doublesOpponent', 0x716ce8, 16, 4], ['safari', 0x716c1c, 16, 8],
];
for (const [name, off, tw, th] of HB_SHEETS) {
  def({
    key: 'healthbox.' + name, group: 'R3 healthbox', desc: 'healthbox frame sprite sheet (' + name + '): 64x32 OAM chunks (8x4 tiles) laid out 2 per row, chunk k at (k%2*64, floor(k/2)*32)',
    offsets: { sheet: off, spriteSheetRecords: 0x437748, palette: PAL_HEALTHBOX }, compression: 'smol mode 6', bpp: 4, palette: '0x72140c (tag 0xD6FF)',
    width: tw * 8, height: th * 8,
    notes: 'ROM stores each 64x32 chunk as one sprite in 1D tile order (gbagfx -mwidth 8 -mheight 4); chunk0|chunk1 = the frame row, chunk2|chunk3 (singles player / safari) = the second row; per-sprite screen offsets are in code, not data',
    decode: (rom) => smolSheet(rom, off, tw, th, PAL_HEALTHBOX, { metaW: 8, metaH: 4 }),
  });
}
// [key, tile run start, element count, row phase, tail tile, palette, description]
const BARS = [
  ['hpGreen', 0x7202e0, 9, 4, 0x7202e0 + 32, PAL_HPBAR, 'HP bar fill steps 0..8 px, green (idx a/b)'],
  ['hpYellow', 0x7208c0, 9, 4, 0x7208c0 + 32, PAL_HPBAR, 'HP bar fill steps 0..8 px, yellow (idx d/c)'],
  ['hpRed', 0x7209e0, 9, 4, 0x7209e0 + 32, PAL_HPBAR, 'HP bar fill steps 0..8 px, red (idx f/e)'],
  ['expBar', 0x720400, 9, 3, 0x720400 + 32, PAL_HEALTHBOX, 'EXP bar fill steps 0..8 px, blue (idx 9/b)'],
  ['hpLabel', 0x7202a0, 2, 4, 0x7202e0, PAL_HPBAR, '"H" and "P" label, 8x8 each (HP-bar palette: orange idx c on dark)'],
];
for (const [name, off, n, phase, tail, pal, desc] of BARS) {
  def({
    key: 'healthbox.' + name, group: 'R3 healthbox', desc: desc + ' (' + n + ' elements in a row; each is rows ' + phase + '..7 of its stored tile + rows 0..' + (phase - 1) + ' of the next)',
    offsets: { tiles: off, palette: pal, table: 0x720280, tail }, compression: 'none (raw, vertically stacked element column; see stackedElements)', bpp: 4,
    palette: '0x' + pal.toString(16), width: n * 8, height: 8,
    notes: 'assembled across tile boundaries (stackedElements): a stored tile on its own is NOT a drawable element',
    decode: (rom) => elementRun(rom, off, n, phase, tail, pal),
  });
}
// Healthbox status labels: six 24x8 labels (PSN PAR SLP FRZ BRN + a sixth that reads FSB/FRB), each THREE elements wide,
// in four background colours. Each element is assembled across the tile boundary like the HP label (stackedElements,
// phase 3: a dark top border row, six text rows, a dark bottom border row). The first element of the first variant
// is the tile at 0x720520 (the tile run after the 9 EXP steps); the older start 0x720540 was one tile late, which cut the
// first letter and is why the labels read as scrambled.
[['status1', 0x720520], ['status2', 0x720bc0], ['status3', 0x720e00], ['status4', 0x721040]].forEach(([name, off], i) => {
  def({
    key: 'healthbox.' + name, group: 'R4 status icons', desc: 'healthbox status label strip: PSN PAR SLP FRZ BRN + sixth label, 6 labels x 3 elements (24x8 each), background colour variant ' + (i + 1),
    offsets: { tiles: off, palette: PAL_HEALTHBOX, table: 0x720280, tail: off + 32 }, compression: 'none (raw, vertically stacked element column; see stackedElements)', bpp: 4,
    palette: '0x72140c (bg idx c blue / d green / e red / f light blue)',
    width: 144, height: 8, notes: 'assembled across tile boundaries, phase 3; label k = elements 3k..3k+2; the sixth label is not one of the five vanilla statuses (reads FSB/FRB)',
    decode: (rom) => elementRun(rom, off, 18, 3, off + 32, PAL_HEALTHBOX),
  });
});
def({
  key: 'icon.types', group: 'R6 type icons', desc: 'type badges, 26 stacked 32x16 (NONE NRM FIT FLY PSN GRD ROC BUG GST STL MYS FIR WAT GRS ELE PSY ICE DRG DRK FAI STR COO BEA CUT SMA TOU)',
  offsets: { sheet: 0x6a3ef8, palette: 0x6a3ed8, pointer: 0xf21860 }, compression: 'smol mode 6', bpp: 4, palette: '0x6a3ed8 (16 colours)', width: 32, height: 416,
  decode: (rom) => smolSheet(rom, 0x6a3ef8, 4, 52, 0x6a3ed8),
});
def({
  key: 'icon.category', group: 'R6 type icons', desc: 'move category icons, 3 stacked 16x16 (order as stored: red burst, blue ring, grey swirl)',
  offsets: { sheet: 0x6a47a0, palette: 0x6a4894, pointer: 0xf21888 }, compression: 'smol mode 6', bpp: 4, palette: '0x6a4894 (16 colours)', width: 16, height: 48,
  notes: 'order Physical/Special/Status inferred from the icon art, not from a ROM table',
  decode: (rom) => smolSheet(rom, 0x6a47a0, 2, 6, 0x6a4894),
});
def({
  key: 'icon.status', group: 'R4 status icons', desc: 'party-menu status icons, 8 stacked 32x8 (PSN PAR SLP FRZ BRN PKRS FNT FRB)',
  offsets: { sheet: 0x6a48d4, palette: 0x6a48b4 }, compression: 'smol mode 6', bpp: 4, palette: '0x6a48b4 (16 colours)', width: 32, height: 64,
  decode: (rom) => smolSheet(rom, 0x6a48d4, 4, 8, 0x6a48b4),
});
def({
  key: 'battle.ballStatusBar', group: 'R8 party tray', desc: 'ball status bar (party tray) tiles, 8x2 view',
  offsets: { sheet: 0x6c6ef4, palette: PAL_HEALTHBOX }, compression: 'smol mode 5/6', bpp: 4, palette: '0x72140c', width: 64, height: 16,
  notes: 'located via the SpriteSheet record at 0x439ad8; internal layout unverified',
  decode: (rom) => smolSheet(rom, 0x6c6ef4, 8, 2, PAL_HEALTHBOX),
});
// FA1: the foe's ground shadow. SpriteSheet record at ROM 0x4377b8 = { ptr 0x086c6f48, size 0x400, tag 0xd759 }; found by decoding every ROM pointer in the
// data area with smolDecode and matching the 4 tiles the real game's VRAM holds under its shadow sprite. 32 tiles = four 64x8 shapes (tile base 8 * class);
// a species picks its class (+0xa4 of its record, see speciesgfx.js). Drawn with the healthbox sprite palette (colour index 1 = dark grey).
def({
  key: 'battle.shadow', group: 'R8 battle sprites', desc: 'foe ground shadow shapes: 4 stacked 64x8 (class 0..3), pixel index 1 = shadow',
  offsets: { sheet: 0x6c6f48, record: 0x4377b8, palette: PAL_HEALTHBOX }, compression: 'smol', bpp: 4, palette: '0x72140c', width: 64, height: 32,
  notes: 'rows of 8 tiles: tiles 8s..8s+3 are the left 32x8 sprite, 8s+4..8s+7 the right one',
  decode: (rom) => smolSheet(rom, 0x6c6f48, 8, 4, PAL_HEALTHBOX),
});
// battle environments: every record whose five pointers are valid AND which decodes cleanly
export const ENV_INDICES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22];
for (const i of ENV_INDICES) {
  def({
    key: 'env.' + i, group: 'R7 battle backgrounds', desc: 'battle environment record ' + i + ' composite (entry layer + terrain layer), 240x160; index 0 transparent, backdrop colour not located',
    offsets: { record: ENV_RECORDS + i * ENV_STRIDE }, compression: 'smol mode 6 tiles + smol mode 8 tilemaps', bpp: 4, palette: 'record pointer 5 (raw, 5 banks)', width: 240, height: 160,
    notes: 'platform art is part of these tilesets; sky/backdrop colour is not stored in the record',
    decode: (rom) => envScene(rom, i),
  });
}

export function manifest() {
  return ASSET_DEFS.map((d) => ({
    key: d.key, group: d.group, desc: d.desc, offsets: d.offsets, compression: d.compression, bpp: d.bpp,
    palette: d.palette, width: d.width, height: d.height, notes: d.notes || '',
  }));
}

/* ------------------------------------------------------------------------------------------ loader */

export function loadUiAssets(rom) {
  validateRom(rom);
  const defs = new Map(ASSET_DEFS.map((d) => [d.key, d]));
  const cache = new Map();
  const fonts = new Map();
  const api = {
    rom,
    keys: () => ASSET_DEFS.map((d) => d.key),
    manifest,
    get(key) {
      let v = cache.get(key);
      if (!v) {
        const d = defs.get(key);
        if (!d) throw new UiAssetError('unknown asset key ' + key);
        v = d.decode(rom);
        cache.set(key, v);
      }
      return v;
    },
    font(name) {
      let f = fonts.get(name);
      if (!f) {
        const d = FONT_DEFS.find((x) => x.name === name || x.id === name);
        if (!d) throw new UiAssetError('unknown font ' + name);
        f = makeFont(rom, d);
        fonts.set(name, f);
      }
      return f;
    },
    // window rectangles in tiles, read from the ROM's WindowTemplate table (bg, left, top, width, height, palette, baseBlock)
    windowTemplates() {
      const out = [];
      for (let i = 0; i < 26; i++) {
        const o = WINDOW_TEMPLATES + i * 8;
        if (rom[o] === 0xFF) break;
        out.push({ index: i, bg: rom[o], left: rom[o + 1], top: rom[o + 2], width: rom[o + 3], height: rom[o + 4], paletteNum: rom[o + 5], baseBlock: u16(rom, o + 6) });
      }
      return out;
    },
    // 16 text colours as [r,g,b] triples (index = palette index)
    textColors() {
      const p = paletteToRGBA(readPalette(rom, BATTLE_TEXT_PALETTE, 16));
      const out = [];
      for (let i = 0; i < 16; i++) out.push([p[4 * i], p[4 * i + 1], p[4 * i + 2]]);
      return out;
    },
    measureText(fontName, str) { return measureGlyphs(api.font(fontName), encodeText(str)); },
    // role bitmap of a string (0 transparent, 1 fg, 2 shadow)
    drawText(fontName, str) { return drawGlyphs(api.font(fontName), encodeText(str)); },
    // RGBA of a string with the given colours ([r,g,b]); bg null = transparent
    renderText(fontName, str, colors = {}) {
      const fg = colors.fg || [24, 24, 24], shadow = colors.shadow || [208, 208, 200], bg = colors.bg || null;
      const t = api.drawText(fontName, str);
      const rgba = new Uint8Array(t.width * t.height * 4);
      for (let i = 0; i < t.pixels.length; i++) {
        const v = t.pixels[i];
        const c = v === 1 ? fg : v === 2 ? shadow : bg;
        if (c) { rgba[4 * i] = c[0]; rgba[4 * i + 1] = c[1]; rgba[4 * i + 2] = c[2]; rgba[4 * i + 3] = 255; }
      }
      return { width: t.width, height: t.height, rgba };
    },
    // HP / EXP bar: returns an indexed bitmap (tilesW*8 x 8) of fill state from `pixels` filled px (0..tilesW*8)
    renderBar(kind, filledPx, tilesW) {
      const strip = api.get(kind === 'exp' ? 'healthbox.expBar' : 'healthbox.' + kind);   // kind: hpGreen|hpYellow|hpRed|exp
      const out = new Uint8Array(tilesW * 8 * 8);
      let left = Math.max(0, Math.min(tilesW * 8, filledPx | 0));
      for (let t = 0; t < tilesW; t++) {
        const fill = Math.min(8, left); left -= fill;
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) out[y * tilesW * 8 + t * 8 + x] = strip.pixels[y * 72 + fill * 8 + x];
      }
      return { width: tilesW * 8, height: 8, pixels: out, palette: strip.palette };
    },
    rgba(asset, opts) { return bitmapToRGBA(asset, asset.palette, opts); },
  };
  return api;
}

export { GfxError };

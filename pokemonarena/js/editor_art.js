// pokemonarena/js/editor_art.js -- the ROM art the profile / team editor draws, decoded lazily from the ROM bytes the caller passes in.
//
// Pure ES module (browser + Node): returns plain { width, height, rgba } images and never touches the DOM, except paintCanvas() which only
// runs where a canvas exists. Nothing here is ROM content: only offsets (already pinned in uiassets.js / speciesgfx.js) and drawing rules.
//
//   import { createArtKit, paintCanvas } from './editor_art.js';
//   const art = createArtKit(romBytes);              // throws on a wrong ROM (loadUiAssets validates length + header)
//   art.typeBadge(11)                                 // ROM type badge (Fire), 32x16
//   art.monIcon(25, { frame: 0 })                     // the ROM party icon, 32x32, decoded ONLY when asked (no 1038-icon pass at load)
//   art.statBar(value, max)                           // a bar built from the ROM's own HP-bar tiles
//
// EVERY PICTURE THE EDITOR SHOWS COMES FROM HERE (type badges, move-category icons, party icons, front sprites, HP bars, the arrows on a
// nature, ROM-font numbers). Plain DOM text is used only for form labels and values, which the brief accepts on editor pages.
//
// WHAT IS APPROXIMATE (the page repeats this in its About box):
//   * the type-badge palette choice is the battle UI's measured one (table at ROM 0x4d877d, indexed typeId - 1), not read from a hardware trace;
//   * the move-category order (Physical / Special / Status = red burst / blue ring / grey swirl) was inferred from the art by uiassets.js;
//   * 51 species have no party icon in the ROM; for those the editor shows the ROM front sprite shrunk 2:1 (nearest neighbour), say so in
//     `iconSource`, and never draws a stand-in.

import { loadUiAssets } from './uiassets.js';
import { speciesGfx, speciesRecord, ICON_PALETTE_TABLE, trainerHead as romTrainerHead, TRAINER_HEAD_COUNT, MAX_SPECIES_ID } from './speciesgfx.js';
import { tilesToBitmap, cropBitmap, readPalette, bitmapToRGBA, paletteToRGBA } from './gfxcodec.js';

const TYPE_PALETTE_TABLE = 0x4d877d, TYPE_PALETTE_COUNT = 19, TYPE_PALETTE_BANKS = [0x6a3e98, 0x6a3eb8, 0x6a3ed8];
export const BAR_TILES = 8;                       // a stat bar is 8 tiles = 64 px wide
export const BAR_PX = BAR_TILES * 8;
export const TYPE_BADGE_W = 32, TYPE_BADGE_H = 16;
export const CATEGORY_NAMES = Object.freeze(['Physical', 'Special', 'Status']);

const u32 = (rom, o) => (rom[o] | (rom[o + 1] << 8) | (rom[o + 2] << 16) | (rom[o + 3] << 24)) >>> 0;
const romOff = (rom, p) => (p >= 0x08000000 && p < 0x08000000 + rom.length ? p - 0x08000000 : 0);

/** HP-bar colour for a fraction (the ROM has green / yellow / red strips): > 50% green, > 20% yellow, else red. Same thresholds as the battle UI. */
export function barKind(value, max) {
  if (!(max > 0)) return 'hpRed';
  const f = Math.floor((Math.max(0, Math.min(value, max)) * 48) / max);
  return f > 24 ? 'hpGreen' : f > 9 ? 'hpYellow' : 'hpRed';
}
/** Filled pixels of a 64 px bar for value/max, never 0 for a positive value (like the engine's bar). */
export function barPixels(value, max, px = BAR_PX) {
  if (!(max > 0) || !(value > 0)) return 0;
  const r = Math.floor((Math.min(value, max) * px) / max);
  return r === 0 ? 1 : r;
}

export function createArtKit(rom) {
  const ui = loadUiAssets(rom);
  const cache = new Map();
  const memo = (key, make, cap = 4096) => {
    let v = cache.get(key);
    if (v === undefined) {
      v = make();
      if (cache.size >= cap) cache.delete(cache.keys().next().value);
      cache.set(key, v);
    }
    return v;
  };

  const typeBanks = TYPE_PALETTE_BANKS.map((o) => readPalette(rom, o, 16));
  let typeSheet = null;
  function typeBadge(typeId) {
    const k = Math.max(0, Math.min(25, typeId | 0));
    return memo('type:' + k, () => {
      typeSheet = typeSheet || ui.get('icon.types');
      const slot = k >= 1 && k <= TYPE_PALETTE_COUNT ? rom[TYPE_PALETTE_TABLE + k - 1] : 13;
      const bank = typeBanks[Math.max(0, Math.min(2, slot - 13))];
      return { width: TYPE_BADGE_W, height: TYPE_BADGE_H, rgba: bitmapToRGBA({ width: TYPE_BADGE_W, height: TYPE_BADGE_H, pixels: typeSheet.pixels.subarray(k * TYPE_BADGE_W * TYPE_BADGE_H, (k + 1) * TYPE_BADGE_W * TYPE_BADGE_H) }, bank, { transparent0: true }) };
    });
  }

  function categoryIcon(cat) {
    const c = Math.max(0, Math.min(2, cat | 0));
    return memo('cat:' + c, () => {
      const sheet = ui.get('icon.category');
      return { width: 16, height: 16, rgba: bitmapToRGBA({ width: 16, height: 16, pixels: sheet.pixels.subarray(c * 256, (c + 1) * 256) }, sheet.palette, { transparent0: true }) };
    });
  }

  // ---- party icons: only the icon is decoded (speciesGfx would also inflate the front and back pictures)
  function iconSharedPalette(idx) { return readPalette(rom, romOff(rom, u32(rom, ICON_PALETTE_TABLE + idx * 8)), 16); }
  // A species id that is not an integer slot of the ROM table (a hand-edited file, a stale profile) has NO picture: null, never a throw, so one
  // bad record cannot blank a whole screen. The callers draw their own "no picture" mark from the ROM font.
  const knownId = (id) => Number.isInteger(id) && id >= 1 && id <= MAX_SPECIES_ID;
  function monIconFrames(id, shiny) {
    if (!knownId(id)) return null;
    return memo('icon:' + id + ':' + (shiny ? 1 : 0), () => {
      const r = speciesRecord(rom, id);
      if (!r || !r.icon) return null;
      const sheet = tilesToBitmap(rom.subarray(r.icon, r.icon + 1024), 4, 8);
      const pal = r.iconPal ? readPalette(rom, r.iconPal, 16) : iconSharedPalette(r.iconPalIndex);
      const shinyPal = r.iconShinyPal ? readPalette(rom, r.iconShinyPal, 16) : pal;
      const p = shiny ? shinyPal : pal;
      return [0, 32].map((y) => ({ width: 32, height: 32, rgba: bitmapToRGBA(cropBitmap(sheet, 0, y, 32, 32), p, { transparent0: true }) }));
    });
  }
  /** { width: 32, height: 32, rgba, source: 'icon' | 'front' } or null for a removed slot. */
  function monIcon(id, opts = {}) {
    const frames = monIconFrames(id, !!opts.shiny);
    if (frames) { const f = frames[(opts.frame | 0) % 2]; return { width: 32, height: 32, rgba: f.rgba, source: 'icon' }; }
    const spr = frontSprite(id, { shiny: !!opts.shiny });
    if (!spr) return null;
    const src = spr.frames[0], out = new Uint8Array(32 * 32 * 4);
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) for (let c = 0; c < 4; c++) out[(y * 32 + x) * 4 + c] = src.rgba[((y * 2) * 64 + x * 2) * 4 + c];
    return { width: 32, height: 32, rgba: out, source: 'front' };
  }

  // ---- front sprites (the editor header): 1 or 2 frames of 64x64
  const spriteLru = [];
  function frontSprite(id, opts = {}) {
    if (!knownId(id)) return null;
    const key = 'spr:' + id + ':' + (opts.shiny ? 1 : 0) + ':' + (opts.female ? 1 : 0);
    let v = cache.get(key);
    if (v === undefined) {
      const g = speciesGfx(rom, id, { female: !!opts.female });
      if (!g) v = null;
      else {
        const pal = opts.shiny ? g.palettes.shiny : g.palettes.normal;
        v = { id, name: g.name, width: 64, height: 64, frames: g.front.frames.map((bm) => ({ width: 64, height: 64, rgba: bitmapToRGBA(bm, pal, { transparent0: true }) })) };
      }
      cache.set(key, v);
      spriteLru.push(key);
      while (spriteLru.length > 24) cache.delete(spriteLru.shift());
    }
    return v;
  }

  /** One of the ROM's 52 trainer head portraits, 64x64 (a profile avatar). */
  function trainerHead(index) {
    const i = ((index | 0) % TRAINER_HEAD_COUNT + TRAINER_HEAD_COUNT) % TRAINER_HEAD_COUNT;
    return memo('head:' + i, () => { const t = romTrainerHead(rom, i); return { width: 64, height: 64, rgba: bitmapToRGBA(t.bitmap, t.palette, { transparent0: true }) }; });
  }

  // ---- bars built from the ROM's HP-bar tiles. renderBar returns an indexed 64x8 bitmap + its palette; index 0 stays transparent.
  function bar(kind, filledPx, tiles = BAR_TILES) {
    const k = Math.max(0, Math.min(tiles * 8, filledPx | 0));
    return memo('bar:' + kind + ':' + tiles + ':' + k, () => {
      const b = ui.renderBar(kind, k, tiles);
      return { width: b.width, height: b.height, rgba: bitmapToRGBA(b, b.palette, { transparent0: true }) };
    });
  }
  /** A stat bar: colour by fraction, fill by value/max. */
  function statBar(value, max, tiles = BAR_TILES) {
    return bar(barKind(value, max), barPixels(value, max, tiles * 8), tiles);
  }

  // ---- ROM-font text (numbers next to the bars, the nature arrows). colours are [r,g,b].
  function text(font, str, colors) {
    const key = 'txt:' + font + ':' + str + ':' + JSON.stringify(colors || null);
    return memo(key, () => {
      const t = ui.renderText(font, str, colors || {});
      return { width: t.width, height: t.height, rgba: t.rgba };
    }, 2048);
  }
  const textWidth = (font, str) => ui.measureText(font, str);

  return { ui, typeBadge, categoryIcon, trainerHead, monIcon, monIconFrames, frontSprite, bar, statBar, text, textWidth, cacheSize: () => cache.size, paletteRGB: (pal) => paletteToRGBA(pal) };
}

/** Draw an { width, height, rgba } image onto a canvas, sizing the canvas (backing store) to the image. Returns the canvas. */
export function paintCanvas(canvas, img) {
  if (canvas.width !== img.width) canvas.width = img.width;
  if (canvas.height !== img.height) canvas.height = img.height;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, img.width, img.height);
  ctx.putImageData(new ImageData(new Uint8ClampedArray(img.rgba.buffer, img.rgba.byteOffset, img.rgba.byteLength), img.width, img.height), 0, 0);
  return canvas;
}

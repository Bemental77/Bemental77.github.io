// pokemonarena/js/battle_ui.js -- the Gen-3 style 240x160 battle screen, composed ONLY from the ROM's own art.
//
// Pure ES module (browser + Node): no DOM, no node: imports. Holds code, layout numbers and rules only; every pixel
// it draws comes from the SoulGold v1.1.1 ROM bytes the caller passes in (terrain, mon sprites, healthbox frames,
// HP/EXP bar tiles, fonts, textbox frames, type icons). tools/pokemonarena_battle_ui_test.mjs proves that by zeroing
// those ROM bytes and showing the output change.
//
//   import { createBattleUi, ScriptedBattle } from './battle_ui.js';
//   const ui = createBattleUi(romBytes);                 // throws on a wrong ROM
//   const frame = ui.render(view);                       // { width:240, height:160, rgba:Uint8Array }
//   const battle = new ScriptedBattle(ui, { player: 25, foe: 129, level: 50 });
//   battle.press('a'); battle.tick(); ui.render(battle.view());
//
// The module has three layers:
//   1. bar rules   (hpFillPixels, hpBarColor, drainFrames, expFillPixels)  integer-only, pure, no ROM
//   2. the renderer (createBattleUi)                                          ROM bytes -> RGBA
//   3. the scripted-battle state machine (ScriptedBattle)                         buttons + 60 Hz ticks -> view
//
// ---------------------------------------------------------------------------------------------------------------
// WHAT IS EXACT AND WHAT IS APPROXIMATE (the stage report repeats this; keep them in step)
//   FROM THE ROM, by decoding it: terrain art (record at 0x430498 stride 0x40), mon sprites and palettes (species
//   table 0x7c7310), healthbox frame art, HP bar tiles (green/yellow/red strips), EXP bar tiles, the "HP" label,
//   the status icons, the textbox frames (tiles 0x73a170 + tilemap 0x73a09c + palette 0x73a130), the window
//   rectangles (WindowTemplate table 0x430278), the 16 text colours (0x6cd02c), the fonts and their width tables,
//   the type badges (0x6a3ef8), species/move names, base stats, move type/power/PP, the type chart (tables.js).
//   FA1 (see pokemonarena/FIDELITY.md for the evidence of every line): the HP bar's pixels, colour and drain are the ROM's own routines, PORTED and checked against the
//   ROM's code RUN in an interpreter (tools/pokemonarena_fidelity_test.mjs section A); the healthbox positions, text offsets, fonts, status labels, shiny palette, foe
//   shadow, text-box text, menu words, cursors, PP colours and move-name fonts are compared PIXEL BY PIXEL with the real game's frames (section B: 0 differing pixels
//   on the reference scenarios). STILL NOT FROM THE ROM: the party / team-preview / result screens' layout, the slide-in / faint / message-hold timings, the EXP value
//   (the arena has none), the real move menu's "L MOVE INFO" button and foe "?" tag (not drawn), and the night tint the real game applies by its clock.
// ---------------------------------------------------------------------------------------------------------------

import { loadUiAssets, encodeText, decodeGen3String, UiAssetError } from './uiassets.js';
import { speciesGfx } from './speciesgfx.js';
import {
  smolDecode, smolTilemapDecode, renderTilemap, readPalette, paletteToRGBA, bitmapToRGBA,
} from './gfxcodec.js';
import { createTypewriter, TEXT_SPEED } from './textfx.js';
import { ballGfx } from './anim_mon.js';
import { createPageDrawer } from './page_draw.js';

export const SCREEN_W = 240, SCREEN_H = 160;

// The ROM's party-menu art, located 2026-11-01 (S1 fixer). Offsets only; every pixel is decoded at runtime from the visitor's ROM.
// EVIDENCE it is the party menu: the code literal pool at ROM 0x17f0a8..0x17f0b0 (beside the EWRAM party-menu state pointers
// 0x02038xxx) holds the tileset 0x73c850 (smol, 64 tiles), the tilemap 0x73c564 (smol, 32x32) and a raw 16-bank palette 0x73c650;
// the same pool points at WindowTemplate arrays whose entries (left 1 top 0 w 14 h 5, left 15 top 1, ... left 15 top 11) are exactly
// the six slot panels the tilemap draws; the tilemap also carries the blue CANCEL button (tile rows 17-18, tile cols 23-29) which
// palette bank 2 recolours red-outlined (the selected cancel). Palette banks: 0 grey-panel scheme, 1 normal teal, 2 teal + selected
// cancel, 3 green/grey. sha1 of the decoded tile bytes / tilemap / palette are pinned in tools/pokemonarena_battle_ui_test.mjs.
export const PARTY_ART = Object.freeze({
  tilemap: 0x73c564, tiles: 0x73c850, palette: 0x73c650,
  slot: Object.freeze({ x0: 8, y0: 2, x1: 119, y1: 39, seed: Object.freeze([60, 20]) }),     // left column, first slot (flood-fill window)
  cancel: Object.freeze({ x: 184, y: 136, w: 56, h: 16 }),
  bgTile: 1,                                                                                  // the flat frame-outside tile
  bankNormal: 1, bankSelectedCancel: 2, bankGrey: 0,
});
// The foe healthbox frame art (healthbox.singlesOpponent): rows/cols used for the RAIN / TRICK ROOM tag plate (see drawTags).
export const TAG_PLATE = Object.freeze({ top: 4, bottom: 2, side: 2, midCol: 30, midRow: 8 });
export const HP_BAR_PX = 48;           // 6 tiles x 8 px
export const EXP_BAR_PX = 64;          // 8 tiles x 8 px
export const TEXTBOX_Y = 112;          // the three battle windows occupy the bottom 48 px (tilemap rows 14-19)

/* =================================================================================================== bar rules */

// THE HP BAR RULES BELOW ARE THE ROM'S OWN (FA1, verified by RUNNING the ROM's THUMB functions in tools/pokemonarena_fidelity_cpu.mjs and
// comparing; see pokemonarena/FIDELITY.md): the bar is drawn by MoveBattleBar @0x08085ecc, which calls CalcNewBarValue @0x080839e4 (the drain
// step) and CalcBarFilledPixels @0x0808434c (HP -> pixels) and picks the colour from the animated HP value itself.
export const HP_BAR_FIRST = -32768;   // the sentinel CalcNewBarValue finds in a fresh bar's currValue
const clampI = (v, lo, hi) => (v > hi ? hi : v < lo ? lo : v);

// CalcBarFilledPixels: filled pixels of the 48-px bar. `curr` is the bar's animated value as the ROM holds it (HP, or HP << 8 when
// maxHp < 48); `target` is the HP the bar is heading for (the bar never shows 0 pixels while the TARGET is above 0).
export function barFill(curr, maxHp, target) {
  if (!(maxHp > 0)) return 0;
  const q = Math.trunc((curr * HP_BAR_PX) / maxHp);
  const px = maxHp >= HP_BAR_PX ? q & 255 : (q >> 8) & 255;
  return px === 0 && target > 0 ? 1 : px;
}
// The static case (a bar at rest on `hp`).
export function hpFillPixels(hp, maxHp, scale = HP_BAR_PX) {
  if (!(maxHp > 0)) return 0;
  const h = Math.max(0, Math.min(hp, maxHp));
  if (scale !== HP_BAR_PX) { const r = Math.floor((h * scale) / maxHp); return r === 0 && h > 0 ? 1 : r; }      // GetScaledHPFraction @0x08086c84 (party menu etc.)
  return barFill(maxHp < HP_BAR_PX ? h << 8 : h, maxHp, h);
}

// MoveBattleBar's colour choice (and GetHPBarLevel @0x08086cac, which the party menu uses): on the HP value, not on pixels.
// full (or max <= 1) green; > max/2 green; > max/5 yellow; else red. `curr` as in barFill.
export function hpBarColorAt(curr, maxHp) {
  const c = maxHp <= HP_BAR_PX - 1 ? curr >> 8 : curr;
  if (c === maxHp || c > Math.trunc(maxHp / 2)) return 'hpGreen';
  if (c > Math.trunc(maxHp / 5)) return 'hpYellow';
  return maxHp > 1 ? 'hpRed' : 'hpGreen';
}
export function hpBarColor(hp, maxHp) { return hpBarColorAt(maxHp < HP_BAR_PX ? hp << 8 : hp, maxHp); }

// HP per frame the bar moves (MoveBattleBar's toAdd): maxHp / 24 for maxHp > 23, else 1.
export const hpBarToAdd = (maxHp) => (maxHp > 23 ? Math.floor(maxHp / 24) & 0xffff : 1);
// A bar going from HP `from` to HP `to`. Call hpBarStep once per frame; it returns the HP to print that frame, or -1 when the bar has arrived
// (CalcNewBarValue). st.curr is the value the pixels are drawn from; st.target the HP it is heading for.
export function hpBarInit(maxHp, from, to) {
  const max = maxHp | 0, old = from | 0, tgt = clampI(to | 0, 0, max);
  return { max, old, recv: old - (to | 0), curr: HP_BAR_FIRST, target: tgt };
}
export function hpBarStep(st) {
  const max = st.max, nv = clampI(st.old - st.recv, 0, max);
  if (st.curr === HP_BAR_FIRST) st.curr = max < HP_BAR_PX ? st.old << 8 : st.old;
  if (max < HP_BAR_PX) {                                  // fixed point: the bar spends 48 frames from full to empty, 1 pixel a frame
    if ((st.curr >> 8) === nv && (st.curr & 255) === 0) return -1;
    const stepQ = Math.trunc((max << 8) / HP_BAR_PX);
    if (st.recv >= 0) {
      const c = st.curr - stepQ, r = (c >> 8) + ((c & 255) !== 0 ? 1 : 0);
      if (r > nv) { st.curr = c; return r; }
      st.curr = nv << 8; return nv;
    }
    const c = st.curr + stepQ, r = c >> 8;
    if (r >= nv) { st.curr = nv << 8; return nv; }
    st.curr = c; return r;
  }
  if (st.curr === nv) return -1;
  const add = hpBarToAdd(max);
  let c = st.recv >= 0 ? st.curr - add : st.curr + add;
  if (st.recv >= 0 ? c < nv : c > nv) c = nv;
  st.curr = c; return c;
}
// The displayed HP values of a whole drain (or fill), one per frame, ending exactly on `to` (the -1 frame that ends the bar is not listed).
export function drainFrames(from, to, maxHp) {
  const out = [];
  if (from === to) return out;
  const st = hpBarInit(maxHp === undefined ? Math.max(from, to) : maxHp, from, to);
  for (let guard = 0; guard < 4096; guard++) { const v = hpBarStep(st); if (v === -1) break; out.push(v); }
  return out;
}

// FA1: the ROM's PP colour state (GetCurrentPpToMaxPpState @0x08094dc8, found by running every function of the first 4 MB over the PP values read off the real move menu;
// the sweep in tools/pokemonarena_fidelity_test.mjs runs the ROM function against this port). 3 normal, 0 yellow, 1 orange, 2 red.
export function ppState(cur, max) {
  if (max === cur) return 3;
  if (max <= 2) return cur > 1 ? 3 : 2 - cur;
  if (max <= 7) return cur <= 2 ? 2 - cur : 3;
  if (cur === 0) return 2;
  if (cur <= (max >> 2)) return 1;
  return cur <= (max >> 1) ? 0 : 3;
}

// EXP bar: pixels of 64 for `into` exp points gained since the current level began out of `span` needed.
export function expFillPixels(into, span, scale = EXP_BAR_PX) {
  if (!(span > 0)) return 0;
  return Math.max(0, Math.min(scale, Math.floor((Math.max(0, into) * scale) / span)));
}

/* ============================================================================================ pixel plumbing */

class Frame {
  constructor(w = SCREEN_W, h = SCREEN_H) { this.width = w; this.height = h; this.rgba = new Uint8Array(w * h * 4); }
  get data() { return this.rgba; }                       // AN1: ImageData-shaped alias, so an animation layer can draw onto this frame as onto a canvas ImageData
  // AN1: draw an RGBA sprite (sw x sh) centred on (cx, cy) scaled (scaleX, scaleY), rotated by `rot` radians, blended at `alpha`; nearest-neighbour, the way an
  // affine OBJ is sampled. The destination box is the sprite's bounding circle, so a rotated or enlarged sprite is not cut.
  blitAffine(sw, sh, src, cx, cy, o = {}) {
    const sx = o.scaleX === 0 ? 1e-6 : (o.scaleX === undefined ? 1 : o.scaleX), sy = o.scaleY === 0 ? 1e-6 : (o.scaleY === undefined ? 1 : o.scaleY);
    const cos = Math.cos(o.rot || 0), sin = Math.sin(o.rot || 0), alpha = o.alpha === undefined ? 1 : Math.max(0, Math.min(1, o.alpha));
    const rx = Math.ceil(Math.hypot(sw * Math.abs(sx), sh * Math.abs(sy)) / 2) + 1, ry = rx, clipY1 = o.clipY1 === undefined ? this.height : o.clipY1;
    for (let dy = -ry; dy <= ry; dy++) {
      const Y = Math.round(cy) + dy; if (Y < 0 || Y >= this.height || Y >= clipY1) continue;
      for (let dx = -rx; dx <= rx; dx++) {
        const X = Math.round(cx) + dx; if (X < 0 || X >= this.width) continue;
        // inverse map: undo the scale, then the rotation
        const ux = (dx * cos + dy * sin) / sx, uy = (-dx * sin + dy * cos) / sy;
        const px = Math.floor(ux + sw / 2), py = Math.floor(uy + sh / 2);
        if (px < 0 || py < 0 || px >= sw || py >= sh) continue;
        const s = (py * sw + px) * 4; if (src[s + 3] === 0) continue;
        const d = (Y * this.width + X) * 4;
        if (alpha >= 1) { this.rgba[d] = src[s]; this.rgba[d + 1] = src[s + 1]; this.rgba[d + 2] = src[s + 2]; }
        else { this.rgba[d] = Math.round(this.rgba[d] * (1 - alpha) + src[s] * alpha); this.rgba[d + 1] = Math.round(this.rgba[d + 1] * (1 - alpha) + src[s + 1] * alpha); this.rgba[d + 2] = Math.round(this.rgba[d + 2] * (1 - alpha) + src[s + 2] * alpha); }
        this.rgba[d + 3] = 255;
      }
    }
  }
  clear(c) {
    for (let i = 0; i < this.width * this.height; i++) { const o = i * 4; this.rgba[o] = c[0]; this.rgba[o + 1] = c[1]; this.rgba[o + 2] = c[2]; this.rgba[o + 3] = 255; }
  }
  rect(x0, y0, w, h, c) {
    for (let y = Math.max(0, y0); y < Math.min(this.height, y0 + h); y++) for (let x = Math.max(0, x0); x < Math.min(this.width, x0 + w); x++) {
      const o = (y * this.width + x) * 4; this.rgba[o] = c[0]; this.rgba[o + 1] = c[1]; this.rgba[o + 2] = c[2]; this.rgba[o + 3] = 255;
    }
  }
  // src RGBA (sw x sh); alpha 0 skipped; clipY1 (exclusive) / clipY0 limit the rows written
  blit(sw, sh, src, dx, dy, clipY0 = 0, clipY1 = this.height) {
    for (let y = 0; y < sh; y++) {
      const Y = dy + y; if (Y < Math.max(0, clipY0) || Y >= Math.min(this.height, clipY1)) continue;
      for (let x = 0; x < sw; x++) {
        const X = dx + x; if (X < 0 || X >= this.width) continue;
        const s = (y * sw + x) * 4; if (src[s + 3] === 0) continue;
        const o = (Y * this.width + X) * 4; this.rgba[o] = src[s]; this.rgba[o + 1] = src[s + 1]; this.rgba[o + 2] = src[s + 2]; this.rgba[o + 3] = 255;
      }
    }
  }
  // role bitmap (0 clear, 1 fg, 2 shadow) in the given colours
  blitRoles(bm, dx, dy, fg, shadow, clipX0 = 0, clipX1 = this.width, clipY0 = 0, clipY1 = this.height) {
    for (let y = 0; y < bm.height; y++) {
      const Y = dy + y; if (Y < 0 || Y >= this.height || Y < clipY0 || Y >= clipY1) continue;
      for (let x = 0; x < bm.width; x++) {
        const v = bm.pixels[y * bm.width + x]; if (!v) continue;
        const X = dx + x; if (X < 0 || X >= this.width || X < clipX0 || X >= clipX1) continue;
        const c = v === 1 ? fg : shadow; if (!c) continue;
        const o = (Y * this.width + X) * 4; this.rgba[o] = c[0]; this.rgba[o + 1] = c[1]; this.rgba[o + 2] = c[2]; this.rgba[o + 3] = 255;
      }
    }
  }
}

// indexed bitmap + palette(BGR555 Uint16Array) -> RGBA; index 0 of each 16-colour bank is transparent unless opaque0
function toRGBA(bm, pal, opaque0 = false) { return bitmapToRGBA(bm, pal, { transparent0: !opaque0 }); }

/* ======================================================================================= terrain / sprites */

const ENV_RECORDS = 0x430498, ENV_STRIDE = 0x40;
const TYPE_PALETTE_TABLE = 0x4d877d, TYPE_PALETTE_COUNT = 19, TYPE_PALETTE_BANKS = [0x6a3e98, 0x6a3eb8, 0x6a3ed8];
const u32 = (rom, o) => (rom[o] | (rom[o + 1] << 8) | (rom[o + 2] << 16) | (rom[o + 3] << 24)) >>> 0;

// The settled battle background of environment record i (0 tall grass, 1 long grass, 2 sand, 3 underwater, 4 water,
// 5 pond, 6 mountain, 7 cave, 8 building, 9 plain, 10-22 gym/stadium variants; names are my reading of the art).
// Record = 5 ROM pointers {tiles, tilemap, entryTiles, entryTilemap, palette}. MEASURED (contact sheet
// env_sheet.png): the 64x32 "entry" tilemap is TWO 32x32 screen blocks, not one 64-wide map; block 0 is the complete
// scene (sky, trees, both platforms); the first pair of pointers is only the intro streak / grass-blade overlay. The
// palette is 3 banks; entry-block tiles use bank 2 = raw bank 0. Index 0 is transparent (rows 112+ of most scenes,
// which the textbox covers); drawn here as the backdrop colour.
export const ENV_COUNT = 23;
export function envBackground(rom, i, backdrop = [0, 0, 0]) {
  const o = ENV_RECORDS + i * ENV_STRIDE;
  const p = [0, 1, 2, 3, 4].map((k) => u32(rom, o + 4 * k));
  if (!p.every((v) => v >= 0x08000000 && v < 0x08000000 + rom.length)) throw new UiAssetError('no battle environment record ' + i);
  const tiles = smolDecode(rom, p[2] - 0x08000000).data;
  const map = smolTilemapDecode(rom, p[3] - 0x08000000).entries.subarray(0, 1024);
  const pal = readPalette(rom, p[4] - 0x08000000, 48);
  const sheet = renderTilemap(tiles, map, 32, 32);
  const rgbaPal = paletteToRGBA(pal);
  const out = new Uint8Array(SCREEN_W * SCREEN_H * 4);
  for (let y = 0; y < SCREEN_H; y++) for (let x = 0; x < SCREEN_W; x++) {
    const v = sheet.pixels[y * 256 + x], ix = v & 15, bank = v >> 4, raw = bank >= 2 && bank <= 4 ? bank - 2 : 0;
    const q = (y * SCREEN_W + x) * 4;
    if (!ix) { out[q] = backdrop[0]; out[q + 1] = backdrop[1]; out[q + 2] = backdrop[2]; out[q + 3] = 255; continue; }
    const pi = raw * 16 + ix; out[q] = rgbaPal[pi * 4]; out[q + 1] = rgbaPal[pi * 4 + 1]; out[q + 2] = rgbaPal[pi * 4 + 2]; out[q + 3] = 255;
  }
  return { width: SCREEN_W, height: SCREEN_H, rgba: out };
}

/* ====================================================================================== layout (see header) */

export const LAYOUT = Object.freeze({
  // sprite centres (the ROM's battler coordinate table at 0x427fb8: u16 pairs (72,80) player and (176,40) foe for singles, found by AN2; every sprite position here was also
  // compared with the real game's OAM and matches) and the 64x64 bitmap size
  foeCenter: [176, 40], playerCenter: [72, 80], spriteSize: 64,
  // healthbox sprite positions: read off the real game's OAM (see below), not the vanilla centres
  foeBoxTL: [2, 14], playerBoxTL: [136, 72],        // FA1: read off the REAL game's OAM at rest, e.g. at a battle message (healthbox sprites at (2,14) / (136,72)); was recollection (12,14) / (126,72). While the action menu waits the real player box bobs 72 <-> 73.
  // inside a healthbox frame, relative to the frame's top-left. The bar / label / EXP numbers are DERIVED from the
  // frame art (measured on the decoded frame, see tools/pokemonarena_battle_ui_test.mjs 'healthbox geometry'):
  //   * the frame carries a 6-row end cap for the HP bar, rows 17..22, at x=88 (foe) / x=96 (player): the bar's
  //     48 px therefore end at x=87 / 95, i.e. barX = 40 / 48, and the 16 px 'HP' label sits just left of it;
  //   * the label and every bar element are 7-row blocks (dark, dark, fill, fill, dark, dark, shadow) whose first row
  //     is the cap's first row, y=17 (they are assembled across tile boundaries, see uiassets stackedElements);
  //   * the player frame's EXP recess is rows 35..36 between two dark frame lines at rows 34 and 37, x=32..95; the
  //     EXP element (rows: light, light, DARK, fill, fill, DARK, light, clear) lands its two dark rows on exactly
  //     those frame lines when its top is y=32, and its 64 px fill the recess when x=32.
  // FA1: the text offsets (name, level, HP numbers) were fitted against the real game's frames (oracle, tools/pokemonarena_fidelity_test.mjs): 0 differing
  // pixels in the name / gender / level / HP-number rows on the reference scenarios. The foe box shows no HP numbers and no EXP bar.
  foe: { nameX: 8, nameY: 3, lvRight: 88, lvY: 3, barX: 40, barY: 17, labelX: 24, labelY: 17, statusX: 8, statusY: 16 },
  player: { nameX: 16, nameY: 3, lvRight: 96, lvY: 3, barX: 48, barY: 17, labelX: 32, labelY: 17, hpNumRight: 96, hpNumY: 21, expX: 32, expY: 32, statusX: 16, statusY: 24 },
});

const FRAME_COLORS = Object.freeze({ backdrop: [0, 0, 0] });

/* ================================================================================================= renderer */

// A string safe for the ROM charset: characters the font map does not know become '?'.
const okChar = new Map();
export function safeText(str) {
  let out = '';
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '{') { const j = str.indexOf('}', i); if (j > i) { out += str.slice(i, j + 1); i = j; continue; } }
    let ok = okChar.get(ch);
    if (ok === undefined) { try { encodeText(ch); ok = true; } catch (_e) { ok = false; } okChar.set(ch, ok); }
    out += ok ? ch : '?';
  }
  return out;
}

export function createBattleUi(rom) {
  const ui = loadUiAssets(rom);                              // validates length + header
  const tc = ui.textColors();                                // 16 [r,g,b] from ROM 0x6cd02c
  const TEXT = { dark: tc[12], white: tc[14], shadow: tc[15], red: tc[1], orange: tc[3] };
  // FA1: the healthbox text is drawn with the healthbox sprite palette (ROM 0x72140c = OBJ palette 4 in the real game, verified against the
  // oracle's palette RAM): 1 dark text, 3 shadow, 11 male symbol (cyan-blue), 10 female symbol (pink). It used the HP-bar palette 0x716bdc before, which
  // made the shadow too dark and both gender symbols orange.
  const hpPal = ui.get('healthbox.singlesOpponent').palette;  // ROM 0x72140c
  const hpRgb = paletteToRGBA(hpPal);
  const hpCol = (i) => [hpRgb[i * 4], hpRgb[i * 4 + 1], hpRgb[i * 4 + 2]];
  const HB = { text: hpCol(1), shadow: hpCol(3), male: hpCol(11), female: hpCol(10) };       // male = index 11 (the real game's frame shows 64,200,248), female = 10

  // FA1: a shiny Pokemon's healthbox is drawn with a second palette -- OBJ palette 6 in the real game (the box sprites switch from palette 4 to 6), which is the ROM
  // SpritePalette record 0x437740 = { ptr 0x08716bbc, tag 0xd70d }: the same art in gold. Found with the oracle (startBattle shinyPid) by comparing palette RAM.
  const SHINY_BOX_PAL = 0x716bbc;
  const shinyBoxPal = readPalette(rom, SHINY_BOX_PAL, 16), shinyRgb = paletteToRGBA(shinyBoxPal), shCol = (i) => [shinyRgb[i * 4], shinyRgb[i * 4 + 1], shinyRgb[i * 4 + 2]];
  const HBS = { text: shCol(1), shadow: shCol(3), male: shCol(11), female: shCol(10) };
  const envCache = new Map(), spriteCache = new Map(), artCache = new Map();

  function env(i) { let e = envCache.get(i); if (!e) { e = envBackground(rom, i, FRAME_COLORS.backdrop); envCache.set(i, e); } return e; }

  // 64x64 RGBA of a mon sprite
  function sprite(id, side, opts = {}) {
    const key = id + ':' + side + ':' + (opts.shiny ? 1 : 0) + ':' + (opts.female ? 1 : 0) + ':' + (opts.frame || 0);
    let s = spriteCache.get(key);
    if (!s) {
      const g = speciesGfx(rom, id, { female: !!opts.female });
      if (!g) throw new UiAssetError('species ' + id + ' has no graphics (removed slot)');
      const frames = side === 'foe' ? g.front.frames : g.back.frames;
      const bm = frames[Math.min(opts.frame || 0, frames.length - 1)];
      const pal = opts.shiny ? g.palettes.shiny : g.palettes.normal;
      s = { rgba: toRGBA(bm, pal), name: g.name, yOffset: side === 'foe' ? g.yOffsets.front : g.yOffsets.back, elevation: g.elevation, shadow: g.shadow };
      spriteCache.set(key, s);
    }
    return s;
  }

  // healthbox frame art as an RGBA image: chunks are 64x32 sprites in 1D tile order; the player box is a 64x64 left
  // sprite (chunk0 over chunk1) plus a 64x64 right sprite (chunk2 over chunk3) -- verified by edge continuity in
  // hb_layout.png; the opponent box is chunk0 | chunk1.
  function healthboxArt(side, shiny = false) {
    const akey = side + (shiny ? ':shiny' : '');
    let a = artCache.get(akey);
    if (!a) {
      const sheet = ui.get('healthbox.' + (side === 'player' ? 'singlesPlayer' : 'singlesOpponent'));
      const W = sheet.width, H = sheet.height, chunks = (W / 64) * (H / 32);
      const dst = side === 'player' ? [[0, 0], [0, 32], [64, 0], [64, 32]] : [[0, 0], [64, 0]];
      const px = new Uint8Array(128 * (side === 'player' ? 64 : 32));
      const outW = 128;
      for (let k = 0; k < chunks; k++) {
        const sx = (k % 2) * 64, sy = Math.floor(k / 2) * 32, [dx, dy] = dst[k];
        for (let y = 0; y < 32; y++) for (let x = 0; x < 64; x++) px[(dy + y) * outW + dx + x] = sheet.pixels[(sy + y) * W + sx + x];
      }
      const h = side === 'player' ? 64 : 32;
      a = { width: outW, height: h, rgba: toRGBA({ width: outW, height: h, pixels: px }, shiny ? shinyBoxPal : sheet.palette) };
      artCache.set(akey, a);
    }
    return a;
  }

  const tileStripRGBA = new Map();
  function stripRGBA(key) { let s = tileStripRGBA.get(key); if (!s) { const sh = key.endsWith(':shiny'), a = ui.get('healthbox.' + key.replace(':shiny', '')); s = { a, rgba: toRGBA(a, sh ? shinyBoxPal : a.palette) }; tileStripRGBA.set(key, s); } return s; }       // key + ':shiny' = the gold box palette (the EXP bar shares the box sprite's palette)

  // one 8x8 tile `fill` (0..8) of a bar strip, RGBA
  function barTile(key, fill) {
    const { a, rgba } = stripRGBA(key);
    const out = new Uint8Array(8 * 8 * 4);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { const s = (y * a.width + fill * 8 + x) * 4, d = (y * 8 + x) * 4; out[d] = rgba[s]; out[d + 1] = rgba[s + 1]; out[d + 2] = rgba[s + 2]; out[d + 3] = rgba[s + 3]; }
    return out;
  }
  // a whole bar: `tiles` tiles, `filled` pixels, blitted at (x,y)
  function drawBar(frame, key, filled, tiles, x, y) {
    let left = Math.max(0, Math.min(tiles * 8, filled | 0));
    for (let t = 0; t < tiles; t++) { const fill = Math.min(8, left); left -= fill; frame.blit(8, 8, barTile(key, fill), x + t * 8, y); }
  }

  // text helpers
  const widthOf = (font, s) => ui.measureText(font, safeText(s));
  function fitFont(s, maxPx, fonts = ['normal', 'narrow', 'smallNarrow']) {
    for (const f of fonts) if (widthOf(f, s) <= maxPx) return f;
    return fonts[fonts.length - 1];
  }
  // the longest prefix of s that fits maxPx in this font (a last resort after fitFont: a name that is wider than its
  // slot even in the narrowest font is cut, never drawn into the neighbouring widget)
  function fitText(font, s, maxPx) {
    let t = safeText(s);
    while (t.length > 0 && widthOf(font, t) > maxPx) t = t.slice(0, -1);
    return t;
  }
  function text(frame, font, s, x, y, fg, shadow) { frame.blitRoles(ui.drawText(font, safeText(s)), x, y, fg, shadow); }

  // Type badges: the sheet is 26 stacked 32x16 badges (index = this ROM's type id) drawn with ONE of THREE 16-colour
  // palettes. Which one is the u8 table at ROM 0x4d877d (values 13/14/15 = OBJ palette slot; pokeemerald
  // sMoveTypeToOamPaletteNum), indexed from NORMAL, i.e. by typeId - 1. MEASURED, not recalled: decoding the sheet
  // with table[typeId] makes Fire purple-pink and Water crimson, with table[typeId - 1] every one of the 20 type
  // colours is the natural one (types5.png). uiassets.js only knows the third palette (0x6a3ed8).
  const typeBadges = ui.get('icon.types');
  const typePalBanks = TYPE_PALETTE_BANKS.map((o) => readPalette(rom, o, 16));
  const typeCache = new Map();
  function typeBadgeRGBA(typeId) {
    const k = Math.max(0, Math.min(25, typeId | 0));
    let b = typeCache.get(k);
    if (!b) {
      const slot = k >= 1 && k <= TYPE_PALETTE_COUNT ? rom[TYPE_PALETTE_TABLE + k - 1] : 13;
      const bank = typePalBanks[Math.max(0, Math.min(2, slot - 13))];
      b = bitmapToRGBA({ width: 32, height: 16, pixels: typeBadges.pixels.subarray(k * 32 * 16, (k + 1) * 32 * 16) }, bank, { transparent0: true });
      typeCache.set(k, b);
    }
    return b;
  }
  function typeBadge(frame, typeId, x, y) { frame.blit(32, 16, typeBadgeRGBA(typeId), x, y); }
  // Status labels shown IN the healthbox in place of the 'HP' label: the ROM's own 24x8 labels (healthbox.status1..4,
  // six labels per strip, three 8-px elements each). Which colour variant goes with which side is an INFERENCE (strip 1
  // for the player = battler 0, strip 2 for the foe = battler 1); the ROM does not say.
  // FA1: the strip's background is palette index 12 + battler (12 = battler 0 = the player, 13 = the foe in singles), and the game OVERWRITES that
  // palette entry with the status's colour when it draws the label (UpdateStatusIconInHealthbox @0x08084d4c: PSN 0x6198, PAR 0x0ef7, SLP 0x4694,
  // FRZ 0x72d1, BRN 0x29dc, read from its literal pool and confirmed against the real game's palette RAM). The ROM palette alone gave blue / green.
  const STATUS_LABEL = { PSN: 0, PAR: 1, SLP: 2, FRZ: 3, BRN: 4, FRB: 5 };
  const STATUS_COLOR = { PSN: 0x6198, PAR: 0x0ef7, SLP: 0x4694, FRZ: 0x72d1, BRN: 0x29dc, FRB: 0x72d1 };
  const statusStrip = { player: stripRGBA('status1'), foe: stripRGBA('status2') };
  const statusCache = new Map();
  function statusStripFor(side, st, shiny = false) {
    const key = side + ':' + st + (shiny ? ':shiny' : ''); let s = statusCache.get(key);
    if (!s) {
      // the game also remaps two nibbles of every label row as it copies the tiles (UpdateStatusIconInHealthbox @0x08084f0a: 5 -> 4 and 6 -> 2), so the strip's
      // white letters (6) are drawn with palette index 2 and their dark shadow (5) with index 4
      const a0 = statusStrip[side].a, pal = Uint16Array.from(shiny ? shinyBoxPal : a0.palette); pal[side === 'player' ? 12 : 13] = STATUS_COLOR[st];
      // (a SHINY box's labels are not remapped: white letters and dark shadow stay indices 6 and 5 of the gold palette -- measured on the real game)
      const px = shiny ? Uint8Array.from(a0.pixels) : Uint8Array.from(a0.pixels, (v) => (v === 5 ? 4 : v === 6 ? 2 : v));
      const a = { width: a0.width, height: a0.height, pixels: px, palette: pal };
      s = { a, rgba: toRGBA(a, pal) }; statusCache.set(key, s);
    }
    return s;
  }
  let capTile = null;
  function capTileRGBA() {
    if (!capTile) {
      const px = new Uint8Array(64), o = 0x72028c + 68 * 32;                  // one 4bpp tile: low nibble = left pixel
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { const b = rom[o + y * 4 + (x >> 1)]; px[y * 8 + x] = (x & 1) ? b >> 4 : b & 15; }
      capTile = toRGBA({ width: 8, height: 8, pixels: px }, ui.get('healthbox.hpLabel').palette);       // drawn with the HP-bar palette like the bar sprites it belongs to
    }
    return capTile;
  }
  function statusLabel(frame, side, st, x, y, shiny = false) {
    const k = STATUS_LABEL[st]; if (k === undefined) return false;
    const { a, rgba } = statusStripFor(side, st, shiny);
    const w = 24, out = new Uint8Array(w * 8 * 4);
    for (let yy = 0; yy < 8; yy++) for (let xx = 0; xx < w; xx++) { const sx = (k * 24 + xx), s = (yy * a.width + sx) * 4, d = (yy * w + xx) * 4; out[d] = rgba[s]; out[d + 1] = rgba[s + 1]; out[d + 2] = rgba[s + 2]; out[d + 3] = rgba[s + 3]; }
    frame.blit(w, 8, out, x, y); return true;
  }

  // The "HP" label: two 8x8 elements assembled across tile boundaries by uiassets (healthbox.hpLabel), drawn with the
  // HP-bar palette (ROM 0x716bdc, index 12 = orange) that the asset now carries.
  const labelHP = ui.get('healthbox.hpLabel'), labelRGBA = toRGBA(labelHP, labelHP.palette);

  // Where the healthbox's text goes (frame-local px). The level is right-aligned; the name + gender symbol get whatever
  // room is left of it: the 'small' font if it fits, else the narrow one, else the name is cut. The slot ends 2 px
  // before the level text, so the two can never overlap whatever the species name or the digit count (Lv5 .. Lv100).
  function healthboxText(side, mon) {
    const L = LAYOUT[side];
    const lv = '{LV}' + mon.level, lw = widthOf('small', lv), lvX = L.lvRight - lw;
    const hasGender = mon.gender === 'M' || mon.gender === 'F';
    const nameFont = widthOf('small', mon.name) <= 50 ? 'small' : 'font11';
    const gSym = hasGender ? (mon.gender === 'M' ? '{MALE}' : '{FEMALE}') : null, gW = hasGender ? widthOf(nameFont, gSym) : 0;       // the symbol is a glyph of the name's own font
    const nameX = L.nameX, avail = lvX - 2 - nameX - (hasGender ? gW + 1 : 0);
    // FA1: the real game sets the name in the 'small' font while it is at most 50 px wide and in the narrower font 11 above that (measured on 18 names of 51..60 px:
    // 51 px already switches); it never truncates. The arena still cuts a name that would run into the level (only reachable for names wider than any ROM species name).
    const shown = fitText(nameFont, mon.name, avail);
    const nameRight = nameX + widthOf(nameFont, shown);
    const gX = nameRight;            // FA1: the real game's gender symbol follows the name with no gap (it is the next glyph of the same string)
    return { lv, lvX, nameX, nameFont, shown, truncated: shown !== safeText(mon.name), gSym, gX, right: hasGender ? gX + gW : nameRight, avail };
  }
  // FA1: the font of a move name in its 64 px window, as the real game does it (measured on 31 real move menus, 0 differing pixels): the 'narrow' font (FontInfo id 7)
  // when the name fits in 64 px, else the narrower font 10; never wrapped, never scrolled: a name wider than the window (154 of the pack's 935) is clipped at its edge,
  // exactly as the game's text window clips it. (The earlier two-line / scrolling layouts were this UI's own invention.)
  function moveNameSlot(nm, maxPx = 64) {
    const s = safeText(nm), w = widthOf('narrow', s);
    return w <= maxPx ? { font: 'narrow', shown: s, lines: [s], width: w } : { font: 'font10', shown: s, lines: [s], width: widthOf('font10', s) };
  }

  function drawHealthbox(frame, side, mon, tl0) {
    const tl = [tl0[0] + (mon.boxDx | 0), tl0[1] + (mon.boxDy | 0)];   // boxDx: the healthbox slides in with its Pokemon; boxDy: its idle bob while the action menu waits
    const art = healthboxArt(side, !!mon.shiny), L = LAYOUT[side], hb = mon.shiny ? HBS : HB;
    frame.blit(art.width, art.height, art.rgba, tl[0], tl[1]);
    const ts = healthboxText(side, mon);
    text(frame, 'small', ts.lv, tl[0] + ts.lvX, tl[1] + L.lvY, hb.text, hb.shadow);
    text(frame, ts.nameFont, ts.shown, tl[0] + ts.nameX, tl[1] + L.nameY, hb.text, hb.shadow);
    if (ts.gSym) text(frame, ts.nameFont, ts.gSym, tl[0] + ts.gX, tl[1] + L.nameY, mon.gender === 'M' ? hb.male : hb.female, hb.shadow);
    // HP label (or the ROM status label in its place, one row higher: its own rows start one row earlier) + the bar
    const bx = tl[0] + L.barX, by = tl[1] + L.barY;
    // FA1 (read off the real game's frames): the FOE's status label takes the HP label's row, at box (8,16), and the HP label is not drawn; the PLAYER keeps its HP label
    // and shows the status label on the row below the bar, at box (16,24), left of the HP numbers.
    if (side === 'foe' && mon.status && statusLabel(frame, side, mon.status, tl[0] + L.statusX, tl[1] + L.statusY, !!mon.shiny)) {
      // the status label replaces the HP label, but the label's second tile becomes healthbox element 68 (ROM 0x72028c + 68 * 32 = 0x720b0c; found by matching the
      // real VRAM tile of the foe's HP-label sprite): it carries the bar's left end cap
      frame.blit(8, 8, capTileRGBA(), tl[0] + 32, tl[1] + 16);
    }
    else {
      frame.blit(labelHP.width, labelHP.height, labelRGBA, tl[0] + L.labelX, tl[1] + L.labelY);
      if (side === 'player' && mon.status) statusLabel(frame, side, mon.status, tl[0] + L.statusX, tl[1] + L.statusY, !!mon.shiny);
    }
    // mon.barCurr / mon.barTarget: the animated bar value the scene holds while an HP bar moves (the ROM draws the pixels and the colour from it, not from the printed HP)
    if (mon.barCurr !== undefined) drawBar(frame, hpBarColorAt(mon.barCurr, mon.maxHp), barFill(mon.barCurr, mon.maxHp, mon.barTarget), 6, bx, by);
    else drawBar(frame, hpBarColor(mon.hp, mon.maxHp), hpFillPixels(mon.hp, mon.maxHp), 6, bx, by);
    if (side === 'player') {
      // FA1: the real game prints "cur/max" as one string, no padding, right-aligned (verified on 1/20, 3/25, 19/19, 90/99, 714/714 in the oracle)
      const num = String(Math.max(0, mon.hp)) + '/' + String(mon.maxHp);
      const nw = widthOf('small', num);
      text(frame, 'small', num, tl[0] + L.hpNumRight - nw, tl[1] + L.hpNumY, hb.text, hb.shadow);
      const ex = mon.exp || { into: 0, span: 1 };
      drawBar(frame, mon.shiny ? 'expBar:shiny' : 'expBar', expFillPixels(ex.into, ex.span), 8, tl[0] + L.expX, tl[1] + L.expY);
    }
  }

  // textbox region art (opaque, as the engine shows it: index 0 of the frame palette is black, not see-through)
  const regionRGBA = {};
  function region(name) { if (!regionRGBA[name]) { const a = ui.get('textbox.' + name); regionRGBA[name] = toRGBA(a, a.palette, true); } return regionRGBA[name]; }
  const win = ui.windowTemplates();
  const winRect = (idx, regionRow) => { const w = win[idx]; return { x: w.left * 8, y: TEXTBOX_Y + (w.top - regionRow) * 8, w: w.width * 8, h: w.height * 8 }; };
  const R = {
    msg: winRect(0, 14), prompt: winRect(1, 34), menu: winRect(2, 34),
    mv: [winRect(3, 54), winRect(4, 54), winRect(5, 54), winRect(6, 54)], pp: winRect(7, 54), ppRem: winRect(9, 54), type: winRect(10, 54),
  };
  const fillWin = (frame, r) => frame.rect(r.x, r.y, r.w, r.h, TEXT.white);
  // FA1: the action menu's words. gText_BattleMenu sits at ROM 0x43cf54 as Gen-3 text with two control codes: FC 13 nn (CLEAR_TO nn: the next word starts nn px from the
  // window's left edge) and FE (new line). Parsed here from the ROM so the words are the game's own ("Battle", "Bag", "Pokémon", "Run"), not this file's.
  const ACTION_MENU_STR = 0x43cf54;
  let menuRowsCache = null;
  function actionMenuRows() {
    if (menuRowsCache) return menuRowsCache;
    const rows = [[]]; let start = ACTION_MENU_STR, segX = 0, o = ACTION_MENU_STR;
    const flush = () => { const s = decodeGen3String(rom, start, o - start); if (s) rows[rows.length - 1].push({ s, x: segX }); };
    for (let guard = 0; guard < 64; guard++) {
      const b = rom[o];
      if (b === 0xff) { flush(); break; }
      if (b === 0xfe) { flush(); rows.push([]); o++; start = o; segX = 0; continue; }
      if (b === 0xfc) { flush(); const code = rom[o + 1]; const arg = rom[o + 2]; o += 3; start = o; if (code === 0x13) segX = arg; continue; }
      o++;
    }
    menuRowsCache = rows; return rows;
  }
  const ARROW_BOB = [0, 0, 0, 0, 0, -1, -1, -1, -1, 0, 0, 0, 0, 0, 1, 1, 1, 1];
  let arrowCache = null;
  function arrowRGBA() {
    if (arrowCache) return arrowCache;
    const out = new Uint8Array(8 * 8 * 4), fill = [14 << 3 | 14 >> 2, 0, 0];      // fill = BGR555 0x000e as the real frame shows it (115,0,0); outline = the dark text colour
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const b = rom[0xf2c688 + y * 4 + (x >> 1)], v = (x & 1) ? b >> 4 : b & 15, d = (y * 8 + x) * 4;
      if (v === 0) continue;
      const col = v === 2 ? TEXT.dark : fill; out[d] = col[0]; out[d + 1] = col[1]; out[d + 2] = col[2]; out[d + 3] = 255;
    }
    arrowCache = out; return out;
  }
  // the four PP text colour pairs {foreground, shadow}, ROM 0x6cd00c (yellow, orange, red, normal), in the order ppState returns them
  let ppCache = null;
  function ppColors() {
    if (ppCache) return ppCache;
    const pal = new Uint16Array(8); for (let i = 0; i < 8; i++) pal[i] = rom[0x6cd00c + 2 * i] | (rom[0x6cd00c + 2 * i + 1] << 8);
    const c = paletteToRGBA(pal), rgb = (i) => [c[i * 4], c[i * 4 + 1], c[i * 4 + 2]];
    ppCache = [0, 1, 2, 3].map((k) => [rgb(2 * k), rgb(2 * k + 1)]); return ppCache;
  }
  // the arrow beside the action / move words: textbox tileset tiles 1 (top) and 2 (bottom), BG palette bank 0, drawn opaque (its background pixels are the window white)
  let cursorCache = null;
  function cursorTilesRGBA() {
    if (cursorCache) return cursorCache;
    const sheet = ui.get('textbox.tiles'), out = new Uint8Array(8 * 16 * 4);
    const rgbaPal = paletteToRGBA(sheet.palette);
    for (let t = 0; t < 2; t++) for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const v = sheet.pixels[y * sheet.width + (t + 1) * 8 + x] & 15, d = ((t * 8 + y) * 8 + x) * 4;
      out[d] = rgbaPal[v * 4]; out[d + 1] = rgbaPal[v * 4 + 1]; out[d + 2] = rgbaPal[v * 4 + 2]; out[d + 3] = 255;
    }
    cursorCache = out; return out;
  }

  function drawBox(frame, box) {
    if (!box || box.mode === 'none') return;
    if (box.mode === 'message') {
      frame.blit(240, 48, region('message'), 0, TEXTBOX_Y); fillWin(frame, R.msg);
      const lines = box.text || [];
      // FA1: the message text starts at the window's left edge (not 2 px in). The wait-for-A arrow is the ROM's 8x8 arrow sprite tile (ROM 0xf2c688: 2 = outline,
      // 1 = fill; found by matching the real frame's arrow shape): it sits 1 px after the last character of the last line, does NOT blink, and bobs
      // 0,-1,0,+1 px with a period of 18 frames (5,4,5,4), measured over 90 real frames.
      lines.forEach((ln, i) => { if (ln) text(frame, 'normal', ln, R.msg.x, R.msg.y + 1 + i * 16, TEXT.dark, TEXT.shadow); });
      if (box.arrow) {
        let li = -1; lines.forEach((ln, i) => { if (ln) li = i; });
        if (li >= 0) frame.blit(8, 8, arrowRGBA(), R.msg.x + widthOf('normal', lines[li]) + 1, R.msg.y + 1 + li * 16 + 4 + ARROW_BOB[(((box.tick | 0) - 1) % 18 + 18) % 18]);
      }
    } else if (box.mode === 'action') {
      frame.blit(240, 48, region('actionMenu'), 0, TEXTBOX_Y); fillWin(frame, R.prompt); fillWin(frame, R.menu);
      // the tilemap leaves a one-tile lane left of the menu window (the engine draws the arrow there with BG tiles); it is
      // made as white as the window, like the moves menu's lanes below, so both menus read the same
      frame.rect(R.menu.x - 8, R.menu.y, 8, R.menu.h, TEXT.white);
      // FA1: positions fitted to the real game's frames (0 differing pixels): the prompt text starts 1 px into its window, the menu words are the ROM's own string
      // gText_BattleMenu (ROM 0x43cf54: "Battle{CLEAR_TO 56}Bag\nPokémon{CLEAR_TO 56}Run") set from the window's left edge, and the arrow is two ROM BG tiles
      // (textbox tiles 1 and 2, the engine draws them in the 8 px lane left of the word), not a font glyph.
      (box.prompt || []).forEach((ln, i) => { if (ln) text(frame, 'normal', ln, R.prompt.x + 1, R.prompt.y + 1 + i * 16, TEXT.dark, TEXT.shadow); });
      actionMenuRows().forEach((row, ri) => row.forEach((seg) => text(frame, 'normal', seg.s, R.menu.x + seg.x, R.menu.y + 1 + ri * 16, TEXT.dark, TEXT.shadow)));
      const c = Math.max(0, Math.min(3, box.cursor | 0));
      frame.blit(8, 16, cursorTilesRGBA(), R.menu.x - 8 + (c & 1) * 56, R.menu.y + (c >> 1) * 16);
    } else if (box.mode === 'moves') {
      frame.blit(240, 48, region('moves'), 0, TEXTBOX_Y);
      for (const r of [...R.mv, R.pp, R.ppRem, R.type]) fillWin(frame, r);
      const moves = box.moves || [];
      // FA1 (all of this was fitted to the real game's frames, 0 differing pixels in the move menu's windows): every move name is set in the 'narrow' font, and in the
      // narrower font 10 when it is wider than its 64 px window; it is never wrapped or scrolled, the window just clips it. The cursor is the same two ROM BG tiles as the
      // action menu's, in the 8 px lane left of each name. 'PP' and 'TYPE/<type>' are narrow too, at the windows' left edges; the PP numbers are two 6 px cells, a
      // slash and two cells, right-aligned, drawn in the colour of the ROM's PP state (see ppState).
      for (const r of R.mv) frame.rect(r.x - 8, r.y, 8, r.h, TEXT.white);
      for (let i = 0; i < 4; i++) {
        const m = moves[i], r = R.mv[i];
        const ms = moveNameSlot(m ? m.name : '-', r.w);
        frame.blitRoles(ui.drawText(ms.font, ms.shown), r.x, r.y + 1, TEXT.dark, TEXT.shadow, r.x, r.x + r.w);
      }
      const c = Math.max(0, Math.min(3, box.cursor | 0)), cr = R.mv[c];
      frame.blit(8, 16, cursorTilesRGBA(), cr.x - 8, cr.y);
      const sel = moves[c];
      text(frame, 'narrow', 'PP', R.pp.x, R.pp.y + 1, TEXT.dark, TEXT.shadow);
      text(frame, 'narrow', 'TYPE/' + (sel && sel.typeName ? sel.typeName : ''), R.type.x, R.type.y + 1, TEXT.dark, TEXT.shadow);
      if (sel) {
        const pp = sel.pp | 0, mx = sel.maxPp | 0, col = ppColors()[ppState(pp, mx)];
        const s2 = String(pp).padStart(2, ' ') + '/' + String(mx).padStart(2, ' '), x0 = R.ppRem.x + R.ppRem.w - 30;
        for (let k = 0; k < s2.length; k++) if (s2[k] !== ' ') text(frame, 'normal', s2[k], x0 + 6 * k, R.ppRem.y + 1, col[0], col[1]);
      }
    }
  }

  function drawMon(frame, side, mon) {
    if (!mon || mon.visible === false) return;
    const sp = sprite(mon.species, side, { shiny: mon.shiny, female: mon.gender === 'F', frame: mon.frame || 0 });
    const c = side === 'foe' ? LAYOUT.foeCenter : LAYOUT.playerCenter;
    const cy = c[1] + sp.yOffset - (side === 'foe' ? sp.elevation : 0);
    const x = c[0] - 32 + (mon.dx | 0), y = cy - 32 + (mon.dy | 0);
    const drop = mon.drop | 0;
    // send-out / recall: the sprite is mixed toward white (mon.tint 0..16, 16 = solid white silhouette), the way a ball opens
    let px = mon.tint > 0 ? whiten(sp.rgba, Math.min(16, mon.tint | 0) / 16) : sp.rgba;
    // AN1: a running move animation may tint the sprite (fxTint: a number 0..16 mixes toward white, or [r, g, b, k]), scale / rotate it (scaleX, scaleY, rot) and blend it (alpha)
    if (mon.fxTint) px = tintSprite(px, mon.fxTint);
    if (mon.scaleX !== undefined || mon.scaleY !== undefined || mon.rot || mon.alpha !== undefined) {
      frame.blitAffine(64, 64, px, x + 32, y + drop + 32, { scaleX: mon.scaleX === undefined ? 1 : mon.scaleX, scaleY: mon.scaleY === undefined ? 1 : mon.scaleY, rot: mon.rot || 0, alpha: mon.alpha === undefined ? 1 : mon.alpha, clipY1: drop ? y + 64 : SCREEN_H });
      return;
    }
    // fainting: the sprite sinks and is cut off at the line it stood on
    frame.blit(64, 64, px, x, y + drop, 0, drop ? y + 64 : SCREEN_H);
  }
  // AN1: a ball sprite (view.balls: { x, y, frame 0|1|2, ball (index into the ROM's ball table, default 1 = the Poke Ball), rot (radians), scale }), centred on (x, y)
  const ballCache = new Map();
  function ballRGBA(index, fr) {
    const key = index + ':' + fr; let b = ballCache.get(key);
    if (!b) { const g = ballGfx(rom, index); b = g ? { w: 16, h: 16, rgba: toRGBA(g.frames[Math.max(0, Math.min(2, fr))], g.palette) } : { w: 16, h: 16, rgba: new Uint8Array(16 * 16 * 4) }; ballCache.set(key, b); }
    return b;
  }
  function drawBall(frame, bl) {
    const b = ballRGBA(bl.ball === undefined ? 1 : bl.ball, bl.frame | 0);
    if (bl.rot || (bl.scale !== undefined && bl.scale !== 1)) frame.blitAffine(16, 16, b.rgba, Math.round(bl.x), Math.round(bl.y), { scaleX: bl.scale === undefined ? 1 : bl.scale, scaleY: bl.scale === undefined ? 1 : bl.scale, rot: bl.rot || 0 });
    else frame.blit(16, 16, b.rgba, Math.round(bl.x) - 8, Math.round(bl.y) - 8);
  }
  // `src` mixed toward a colour: k is a number 0..16 (toward white) or [r, g, b, k01] (toward that colour)
  function tintSprite(src, k) {
    let r = 255, g = 255, b = 255, m;
    if (typeof k === 'number') m = Math.max(0, Math.min(16, k)) / 16; else if (Array.isArray(k)) { r = k[0] | 0; g = k[1] | 0; b = k[2] | 0; m = Math.max(0, Math.min(1, +k[3])); } else return src;
    if (!(m > 0)) return src;
    const out = new Uint8Array(src.length);
    for (let i = 0; i < src.length; i += 4) { out[i] = src[i] + Math.round((r - src[i]) * m); out[i + 1] = src[i + 1] + Math.round((g - src[i + 1]) * m); out[i + 2] = src[i + 2] + Math.round((b - src[i + 2]) * m); out[i + 3] = src[i + 3]; }
    return out;
  }
  // FA1: the foe's ground shadow (the game's shadow sprite pair: priority behind the Pokemon, healthbox palette index 1). Measured on the real game's OAM over a whole turn
  // (tools/pokemonarena_fidelity_test.mjs B2): the shadow sprites exist only while the foe's sprite exists, so they blink with it when it is hit, and they are hidden for the
  // whole of a move animation (render() skips them while view.fxDraw runs). Not measured: the send-out silhouette and the faint sink (hidden here).
  const shadowAsset = ui.get('battle.shadow'), shadowRGBA = toRGBA(shadowAsset, shadowAsset.palette);
  function drawShadow(frame, mon) {
    if (!mon || mon.visible === false || mon.tint > 0 || mon.drop > 0 || mon.showBox === false) return;
    const sp = sprite(mon.species, 'foe', { shiny: mon.shiny, female: mon.gender === 'F', frame: 0 });
    const c = LAYOUT.foeCenter, top = c[1] + sp.yOffset - sp.elevation - 32, k = sp.shadow.size;
    frame.blit(64, 8, cropRGBA(shadowRGBA, 64, 0, 8 * k, 64, 8), c[0] - 32 + sp.shadow.dx, top + 44 + sp.shadow.dy);
  }
  // `src` RGBA mixed toward white by k (0..1); alpha untouched, so the silhouette stays the sprite's own
  function whiten(src, k) {
    const out = new Uint8Array(src.length);
    for (let i = 0; i < src.length; i += 4) { out[i] = src[i] + Math.round((255 - src[i]) * k); out[i + 1] = src[i + 1] + Math.round((255 - src[i + 1]) * k); out[i + 2] = src[i + 2] + Math.round((255 - src[i + 2]) * k); out[i + 3] = src[i + 3]; }
    return out;
  }

  /* =========================================================================== windows, party / preview / result screens (S1) */
  // WHAT IS FROM THE ROM HERE AND WHAT IS NOT. Every window ring below is cut from the ROM's own battle menu frame (the 8-px band around
  // the menu windows in the textbox regions), every Pokemon picture is the ROM's own 2-frame menu icon (species table), every bar is the
  // ROM's HP-bar strip, every label uses the ROM fonts and the ROM status icons (icon.status). The screens' BACKGROUND, the row panels (normal /
  // selected / fainted), the CANCEL button and the weather-tag plates are cut from the ROM's own party-menu bg and healthbox frame (PARTY_ART,
  // TAG_PLATE; see the party-menu panels block below). STILL FLAT FILLS (the ROM also fills these at run time): the interiors of the battle
  // text windows and of the 6 px ring windows (drawWindow) and the cursor lanes. NOT REPRODUCED: the ROM's own selected-slot panel art (not
  // found in the tilemap; selected = the same panel with its fill shown in the frame's light index 4) and the game's exact 2x3 party layout
  // (the list here keeps the vertical rows the hit tests and the INPUT.md contract use). The layout is this module's composition of ROM pieces. Geometry numbers are chosen by eye. tools/pokemonarena_battle_ui_test.mjs pins them.
  const cropRGBA = (src, sw, x, y, w, h) => {
    const out = new Uint8Array(w * h * 4);
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) { const s = ((y + yy) * sw + x + xx) * 4, d = (yy * w + xx) * 4; out[d] = src[s]; out[d + 1] = src[s + 1]; out[d + 2] = src[s + 2]; out[d + 3] = src[s + 3]; }
    return out;
  };
  // The ROM's battle MENU window: a 6-px ring (black, grey, light, dark) around a black interior. In the 240x48 'actionMenu' picture the menu
  // window's ring box is (120,0)-(240,48): the interior is (126,6)-(234,42), so the ring bands are 6 px wide (measured, ringprobe).
  const RING = 6;
  let ringCache = null;
  function ringTiles() {
    if (ringCache) return ringCache;
    const a = region('actionMenu');
    const T = (x, y, w, h) => cropRGBA(a, 240, x, y, w, h);
    ringCache = { tl: T(120, 0, 6, 6), t: T(140, 0, 8, 6), tr: T(234, 0, 6, 6), l: T(120, 10, 6, 8), r: T(234, 10, 6, 8), bl: T(120, 42, 6, 6), b: T(140, 42, 8, 6), br: T(234, 42, 6, 6) };
    return ringCache;
  }
  // a window whose INTERIOR is (x, y, w, h); the ROM ring is painted in the 6 px around it
  function drawWindow(frame, x, y, w, h, o = {}) {
    const r = ringTiles();
    for (let xx = 0; xx < w; xx += 8) {
      const cw = Math.min(8, w - xx);
      frame.blit(cw, RING, cw === 8 ? r.t : cropRGBA(r.t, 8, 0, 0, cw, RING), x + xx, y - RING);
      frame.blit(cw, RING, cw === 8 ? r.b : cropRGBA(r.b, 8, 0, 0, cw, RING), x + xx, y + h);
    }
    for (let yy = 0; yy < h; yy += 8) {
      const ch = Math.min(8, h - yy);
      frame.blit(RING, ch, ch === 8 ? r.l : cropRGBA(r.l, RING, 0, 0, RING, ch), x - RING, y + yy);
      frame.blit(RING, ch, ch === 8 ? r.r : cropRGBA(r.r, RING, 0, 0, RING, ch), x + w, y + yy);
    }
    frame.blit(RING, RING, r.tl, x - RING, y - RING); frame.blit(RING, RING, r.tr, x + w, y - RING);
    frame.blit(RING, RING, r.bl, x - RING, y + h); frame.blit(RING, RING, r.br, x + w, y + h);
    frame.rect(x, y, w, h, o.fill || TEXT.white);
  }

  // colours: all read from ROM palettes
  const statusIcons = ui.get('icon.status'), statusIconRGBA = toRGBA(statusIcons, statusIcons.palette);
  const tbPal = paletteToRGBA(ui.get('textbox.message').palette), tbCol = (i) => [tbPal[i * 4], tbPal[i * 4 + 1], tbPal[i * 4 + 2]];
  const stPalRGB = paletteToRGBA(statusIcons.palette);
  const COL = {
    bg: [stPalRGB[0], stPalRGB[1], stPalRGB[2]],            // status-icon palette entry 0: the party-menu teal
    sel: tbCol(14), blue: tbCol(4), dark: tc[12], white: tc[14], grey: tc[15], green: tc[5], line: tc[11], red: tc[1],
  };
  const STATUS_ICON = { PSN: 0, PAR: 1, SLP: 2, FRZ: 3, BRN: 4, PKRS: 5, FNT: 6, FRB: 7 };
  function statusIcon(frame, st, x, y) {
    const k = STATUS_ICON[st]; if (k === undefined) return false;
    frame.blit(32, 8, cropRGBA(statusIconRGBA, 32, 0, k * 8, 32, 8), x, y); return true;
  }
  /* ------------------------------------------------------------------------------ ROM party-menu panels (S1 fix) */
  // Row panels, screen backgrounds and the CANCEL button are cut from the ROM's own party-menu bg (PARTY_ART). A slot panel is found by
  // flood-filling palette index 2 inside the first slot of the left column and adding the index-5 outline pixels next to it; that
  // mask (not a colour test) cuts the panel out of the frame around it. It is then 9-sliced to any size. Variants are palette
  // choices over the SAME ROM pixels: normal = bank 1, grey (fainted) = bank 0, selected = bank 1 with index 2 shown as the frame's
  // own light index 4 (no selected-slot art was found in the tilemap; the ROM's selected look is therefore NOT reproduced).
  let partyCache = null;
  function partyArt() {
    if (partyCache) return partyCache;
    const A = PARTY_ART, tiles = smolDecode(rom, A.tiles).data, ent = smolTilemapDecode(rom, A.tilemap).entries;
    const map = new Uint16Array(30 * 20); for (let y = 0; y < 20; y++) for (let x = 0; x < 30; x++) map[y * 30 + x] = ent[y * 32 + x] & 0xFFF;       // tile + flip bits; the bank bits are dropped (banks are applied per variant)
    const bm = renderTilemap(tiles, map, 30, 20), W = 240, P = bm.pixels;
    const rgbaPal = paletteToRGBA(readPalette(rom, A.palette, 256));
    const px = (bank, ix) => [rgbaPal[(bank * 16 + ix) * 4], rgbaPal[(bank * 16 + ix) * 4 + 1], rgbaPal[(bank * 16 + ix) * 4 + 2]];
    // panel mask
    const S = A.slot, mask = new Uint8Array(W * 160), seen = new Uint8Array(W * 160), st = [[S.seed[0], S.seed[1]]];
    const inside = (x, y) => x >= S.x0 && x <= S.x1 && y >= S.y0 && y <= S.y1;
    seen[S.seed[1] * W + S.seed[0]] = 1;
    while (st.length) {
      const [x, y] = st.pop();
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const nx = x + dx, ny = y + dy; if (!inside(nx, ny) || seen[ny * W + nx] || (P[ny * W + nx] & 15) !== 2) continue; seen[ny * W + nx] = 1; st.push([nx, ny]); }
    }
    for (let y = S.y0; y <= S.y1; y++) for (let x = S.x0; x <= S.x1; x++) if (seen[y * W + x]) {
      mask[y * W + x] = 1;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (inside(x + dx, y + dy) && (P[(y + dy) * W + x + dx] & 15) === 5) mask[(y + dy) * W + x + dx] = 1;
    }
    let bx0 = 1e9, by0 = 1e9, bx1 = -1, by1 = -1;
    for (let y = 0; y < 160; y++) for (let x = 0; x < W; x++) if (mask[y * W + x]) { bx0 = Math.min(bx0, x); by0 = Math.min(by0, y); bx1 = Math.max(bx1, x); by1 = Math.max(by1, y); }
    const mw = bx1 - bx0 + 1, mh = by1 - by0 + 1;
    const master = (bank, remap) => {
      const out = new Uint8Array(mw * mh * 4);
      for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) if (mask[(by0 + y) * W + bx0 + x]) {
        let ix = P[(by0 + y) * W + bx0 + x] & 15; if (remap && remap[ix] !== undefined) ix = remap[ix];
        const c = px(bank, ix), o = (y * mw + x) * 4; out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2]; out[o + 3] = 255;
      }
      return out;
    };
    const masters = { normal: master(A.bankNormal), grey: master(A.bankGrey), sel: master(A.bankNormal, { 2: 4 }) };
    // the cancel button: indices 13..15 of tile rows 17-18, cols 23-29
    const cn = A.cancel, cancelOf = (bank) => {
      const out = new Uint8Array(cn.w * cn.h * 4);
      for (let y = 0; y < cn.h; y++) for (let x = 0; x < cn.w; x++) { const ix = P[(cn.y + y) * W + cn.x + x] & 15; if (ix < 13) continue; const c = px(bank, ix), o = (y * cn.w + x) * 4; out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2]; out[o + 3] = 255; }
      return out;
    };
    partyCache = { masters, mw, mh, cancel: { normal: cancelOf(A.bankNormal), selected: cancelOf(A.bankSelectedCancel) }, bg: px(A.bankNormal, A.bgTile), mask: { x0: bx0, y0: by0, x1: bx1, y1: by1 }, panelCache: new Map() };
    return partyCache;
  }
  const CHAMFER = 12, EDGE = 3;                      // measured on the panel mask: the top-left chamfer spans 11 rows x 11 columns; the other edges are 1-2 px
  // RGBA (w x h) of a slot panel. sq: square the top-left corner (for small panels: option buttons, icon cells, badges)
  function panelRGBA(variant, w, h, sq) {
    const A = partyArt(), key = variant + ':' + w + 'x' + h + ':' + (sq ? 1 : 0);
    let out = A.panelCache.get(key); if (out) return out;
    const M = A.masters[variant], mw = A.mw, mh = A.mh; out = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let sx, sy;
      if (!sq) {
        sx = x < CHAMFER ? x : x >= w - EDGE ? mw - (w - x) : CHAMFER + ((x - CHAMFER) % (mw - CHAMFER - EDGE));
        sy = y < CHAMFER ? y : y >= h - EDGE ? mh - (h - y) : CHAMFER + ((y - CHAMFER) % (mh - CHAMFER - EDGE));
      } else {
        const mx = x < EDGE ? -1 : x >= w - EDGE ? mw - (w - x) : CHAMFER + ((x - EDGE) % (mw - CHAMFER - EDGE));
        const my = y < EDGE ? -1 : y >= h - EDGE ? mh - (h - y) : CHAMFER + ((y - EDGE) % (mh - CHAMFER - EDGE));
        if (mx < 0 && my < 0) { sx = y === 0 ? CHAMFER + x : (x === 0 ? 0 : CHAMFER + 2); sy = y === 0 ? 0 : (x === 0 ? CHAMFER + y : CHAMFER + 2); }
        else if (mx < 0) { sx = x; sy = my; } else if (my < 0) { sx = mx; sy = y; } else { sx = mx; sy = my; }
      }
      const s = (Math.max(0, Math.min(mh - 1, sy)) * mw + Math.max(0, Math.min(mw - 1, sx))) * 4, d = (y * w + x) * 4;
      out[d] = M[s]; out[d + 1] = M[s + 1]; out[d + 2] = M[s + 2]; out[d + 3] = M[s + 3];
    }
    A.panelCache.set(key, out); return out;
  }
  // variant: 'normal' | 'grey' | 'sel'
  function panel(frame, x, y, w, h, variant = 'normal', sq = false) { frame.blit(w, h, panelRGBA(variant, w, h, sq), x, y); }
  // the screen background: the ROM party-bg's flat outside-the-frame tile, bank 1 index 1
  function screenBg(frame) { frame.clear(partyArt().bg); }
  function cancelButton(frame, selected, x, y) { const A = partyArt(), c = PARTY_ART.cancel; frame.blit(c.w, c.h, selected ? A.cancel.selected : A.cancel.normal, x, y); }

  // Pokemon menu icons: the ROM's 32x32 two-frame pictures, with the species' own icon palette
  const iconCache = new Map();
  function iconRGBA(id, fr, shiny) {
    const key = id + ':' + (fr ? 1 : 0) + ':' + (shiny ? 1 : 0);
    let ic = iconCache.get(key);
    if (ic === undefined) {
      const g = speciesGfx(rom, id);
      if (!g || !g.icon) ic = null;
      else ic = toRGBA(g.icon.frames[Math.min(fr ? 1 : 0, g.icon.frames.length - 1)], shiny ? g.palettes.iconShiny : g.palettes.icon);
      iconCache.set(key, ic);
    }
    return ic;
  }
  function shade(src, k) { const o = new Uint8Array(src.length); for (let i = 0; i < src.length; i += 4) { o[i] = (src[i] * k) | 0; o[i + 1] = (src[i + 1] * k) | 0; o[i + 2] = (src[i + 2] * k) | 0; o[i + 3] = src[i + 3]; } return o; }
  // rows of the 32x32 icon that hold ink (alpha > 0), so a tall list row can centre the picture instead of letting it overlap the next row
  function iconInk(ic) {
    let y0 = 32, y1 = -1;
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) if (ic[(y * 32 + x) * 4 + 3]) { if (y < y0) y0 = y; if (y > y1) y1 = y; }
    return y1 < 0 ? { y0: 0, y1: 31 } : { y0, y1 };
  }
  function drawIcon(frame, id, x, y, o = {}) {
    const ic = iconRGBA(id, o.bob, o.shiny);
    if (!ic) return;
    if (o.centerIn) { const b = iconInk(ic); y = o.centerIn[0] + (((o.centerIn[1] - o.centerIn[0]) - (b.y1 - b.y0 + 1)) >> 1) - b.y0; }
    if (o.clip) frame.blit(32, 32, o.dim ? shade(ic, 0.55) : ic, x, y, o.clip[0], o.clip[1]); else frame.blit(32, 32, o.dim ? shade(ic, 0.55) : ic, x, y);
  }
  const hpLabelAt = (frame, x, y) => frame.blit(labelHP.width, labelHP.height, labelRGBA, x, y);
  const textR = (frame, font, s, rightX, y, fg, sh) => text(frame, font, s, rightX - widthOf(font, s), y, fg, sh);
  const textC = (frame, font, s, cx, y, fg, sh) => text(frame, font, s, cx - Math.floor(widthOf(font, s) / 2), y, fg, sh);

  // ---- geometry shared with the scene's hit testing
  const GEOM = Object.freeze({
    party: { x: 100, y: 3, w: 136, h: 23, pitch: 25, cancel: { x: 8, y: 140, w: 84, h: 16 }, detail: { x: 12, y: 10, w: 68, h: 88 } },
    preview: { mine: { x: 4, y: 14, w: 112, h: 22, pitch: 24 }, foe: { x: 124, y: 14, w: 112, h: 22, pitch: 24 } },
    result: { head: { x: 16, y: 10, w: 208, h: 32 }, mine: { x: 8, y: 60, pitch: 38 }, foe: { x: 8, y: 106, pitch: 38 }, opt: { x: 8, y: 143, w: 70, h: 16, pitch: 76 }, opt4: { x: 2, y: 143, w: 58, h: 16, pitch: 59 } },
    // ST1: the MATCH RECAP screen: a title line, one ROM window holding the page (PAGE_W x PAGE_H of recap_model.js), and three buttons under it
    recap: { title: { x: 8, y: -2 }, win: { x: 10, y: 20, w: 220, h: 106 }, chips: [{ id: 'prev', x: 10, y: 140, w: 64, h: 16 }, { id: 'back', x: 88, y: 140, w: 64, h: 16 }, { id: 'next', x: 166, y: 140, w: 64, h: 16 }] },
  });
  const rowRects = (g, n) => Array.from({ length: n }, (_, i) => ({ x: g.x, y: g.y + i * g.pitch, w: g.w, h: g.h }));
  const LIST_PITCH = 16;
  function overlayRects(o) {
    const n = (o.rows || []).length, w = o.w || 64, x = o.x === undefined ? 168 : o.x;
    const h = n * LIST_PITCH, y = o.y === undefined ? 112 - 8 - h - 8 : o.y;
    return { win: { x, y, w, h }, rows: Array.from({ length: n }, (_, i) => ({ x, y: y + i * LIST_PITCH, w, h: LIST_PITCH })) };
  }
  function drawListOverlay(frame, o) {
    const g = overlayRects(o);
    drawWindow(frame, g.win.x, g.win.y, g.win.w, g.win.h);
    o.rows.forEach((r, i) => {
      const rr = g.rows[i];
      const label = typeof r === 'string' ? r : r.label, dis = typeof r === 'object' && r.disabled;
      text(frame, fitFont(label, rr.w - 16), label, rr.x + 12, rr.y + 1, dis ? COL.line : TEXT.dark, TEXT.shadow);
    });
    const c = Math.max(0, Math.min(g.rows.length - 1, o.cursor | 0));
    if (g.rows.length) text(frame, 'normal', '{CURSOR}', g.rows[c].x + 2, g.rows[c].y + 1, TEXT.dark, TEXT.shadow);
  }

  const STATUS_OF = (s) => (s === 'FNT' ? 'FNT' : s || null);
  function drawMonRow(frame, r, m, o = {}) {
    panel(frame, r.x, r.y, r.w, r.h, o.sel ? 'sel' : m.fainted ? 'grey' : 'normal');
    drawIcon(frame, m.species, r.x + 2, r.y - 5, { bob: o.bob, shiny: m.shiny, dim: m.fainted, clip: o.clipIcon ? [r.y, r.y + r.h] : null, centerIn: o.clipIcon ? [r.y, r.y + r.h] : null });
    const nx = r.x + 34;
    const lv = '{LV}' + m.level, lw = widthOf('small', lv);
    // W1 fix D4: with no HP line (team preview) the level sits on its own line below the name, so the name may use the whole row (it was cut to 8 letters: 'Victreeb', 'Raging B')
    const nameMax = o.showHp === false ? r.w - 36 - 12 : r.w - 36 - lw - 18;
    const nm = fitText(widthOf('small', m.name) <= nameMax ? 'small' : 'smallNarrow', m.name, nameMax);
    text(frame, widthOf('small', m.name) <= nameMax ? 'small' : 'smallNarrow', nm, nx, r.y - 2, TEXT.dark, TEXT.shadow);
    let gx = nx + widthOf(widthOf('small', m.name) <= nameMax ? 'small' : 'smallNarrow', nm) + 1;
    if (m.gender === 'M' || m.gender === 'F') text(frame, 'small', m.gender === 'M' ? '{MALE}' : '{FEMALE}', gx, r.y - 2, m.gender === 'M' ? HB.male : HB.female, TEXT.shadow);
    if (o.showHp !== false) textR(frame, 'small', lv, r.x + r.w - 3, r.y - 2, TEXT.dark, TEXT.shadow);
    else text(frame, 'small', lv, nx, r.y + 9, TEXT.dark, TEXT.shadow);
    if (o.showHp !== false) {
      hpLabelAt(frame, nx - 3, r.y + 12);
      drawBar(frame, hpBarColor(m.hp, m.maxHp), hpFillPixels(m.hp, m.maxHp), 6, nx + 13, r.y + 12);
      textR(frame, 'smallNarrow', m.hp + '/' + m.maxHp, r.x + r.w - 3, r.y + 7, TEXT.dark, TEXT.shadow);
    }
    const st = m.fainted ? 'FNT' : m.status;
    if (st && o.showHp !== false) statusIcon(frame, STATUS_OF(st), r.x + 2, r.y + 15);
    else if (m.active && o.showHp !== false) text(frame, 'small', 'ACTIVE', r.x + 2, r.y + 11, TEXT.white, TEXT.dark);
    if (o.badge !== undefined) {
      const bx = r.x + r.w - 20, by = r.y + 3;
      panel(frame, bx, by, 16, 16, 'sel', true);
      textC(frame, 'normal', String(o.badge), bx + 8, by + 1, TEXT.dark, TEXT.shadow);
    }
  }

  function drawPartyScreen(frame, p) {
    screenBg(frame);
    const G = GEOM.party;
    const rows = rowRects(G, p.mons.length);
    const cur = Math.max(0, Math.min(p.mons.length - 1, p.cursor | 0));
    const bob = ((p.tick | 0) >> 3) & 1;
    p.mons.forEach((m, i) => drawMonRow(frame, rows[i], m, { sel: i === cur, bob: i === cur ? bob : 0 }));
    if (rows[cur]) text(frame, 'normal', '{CURSOR}', rows[cur].x - 6, rows[cur].y + 4, TEXT.dark, TEXT.shadow);
    // detail window: the front picture of the highlighted Pokemon and its name
    const d = G.detail, m = p.mons[cur];
    drawWindow(frame, d.x, d.y, d.w, d.h);
    if (m) {
      const sp = sprite(m.species, 'foe', { shiny: m.shiny, female: m.gender === 'F', frame: bob });
      frame.blit(64, 64, m.fainted ? shade(sp.rgba, 0.55) : sp.rgba, d.x + 2, d.y + 2);
      const nm = m.name;
      const f = fitFont(nm, d.w - 4);
      textC(frame, f, nm, d.x + d.w / 2, d.y + 68, TEXT.dark, TEXT.shadow);
    }
    (p.prompt || []).forEach((ln, i) => { if (ln) text(frame, 'normal', ln, 8, 108 + i * 14, TEXT.white, TEXT.dark); });
    if (p.canCancel) {
      const c = G.cancel, bw = PARTY_ART.cancel.w, bx = c.x + ((c.w - bw) >> 1);
      cancelButton(frame, !!p.cancelSel, bx, c.y);                     // the ROM's own CANCEL button (bank 2 = the selected, red-outlined one)
      textC(frame, 'normal', 'CANCEL', bx + bw / 2, c.y, TEXT.white, TEXT.dark);
    }
  }

  function drawPreviewScreen(frame, p) {
    screenBg(frame);
    const G = GEOM.preview, bob = ((p.tick | 0) >> 3) & 1;
    text(frame, 'normal', p.title || '', 8, -2, TEXT.white, TEXT.dark);
    textR(frame, 'normal', p.foeTitle || '', 232, -2, TEXT.white, TEXT.dark);
    const mine = rowRects(G.mine, p.mine.length), foe = rowRects(G.foe, p.foe.length);
    const cur = Math.max(0, Math.min(p.mine.length - 1, p.cursor | 0));
    p.mine.forEach((m, i) => {
      const k = (p.picks || []).indexOf(i);
      drawMonRow(frame, mine[i], { ...m, hp: 1, maxHp: 1 }, { sel: i === cur, bob: i === cur ? bob : 0, showHp: false, badge: k >= 0 ? k + 1 : undefined, clipIcon: true });
    });
    if (mine[cur]) text(frame, 'normal', '{CURSOR}', mine[cur].x - 3, mine[cur].y + 3, TEXT.dark, TEXT.shadow);
    p.foe.forEach((m, i) => drawMonRow(frame, foe[i], { ...m, hp: 1, maxHp: 1 }, { showHp: false, bob: ((p.tick | 0) >> 4 & 1), clipIcon: true }));
    (p.prompt || []).forEach((ln, i) => { if (ln) text(frame, 'normal', ln, 8, 150 - (p.prompt.length - 1 - i) * 0, TEXT.white, TEXT.dark); });
  }

  function drawResultScreen(frame, r) {
    screenBg(frame);
    const G = GEOM.result, bob = ((r.tick | 0) >> 4) & 1;
    drawWindow(frame, G.head.x, G.head.y, G.head.w, G.head.h, { style: 'message' });
    (r.head || []).forEach((ln, i) => { if (ln) text(frame, 'normal', ln, G.head.x + 2, G.head.y + 1 + i * 16, TEXT.dark, TEXT.shadow); });
    const rowOf = (g, list, label) => {
      text(frame, 'small', label, g.x, g.y - 14, TEXT.white, TEXT.dark);
      list.forEach((m, i) => {
        const x = g.x + i * (g.pitch === 38 ? 38 : g.pitch);
        panel(frame, x, g.y, 34, 34, m.fainted ? 'grey' : 'normal', true);
        drawIcon(frame, m.species, x + 1, g.y + 1, { bob, shiny: m.shiny, dim: m.fainted });
      });
    };
    rowOf(G.mine, r.mine || [], r.mineLabel || 'YOU');
    rowOf(G.foe, r.foe || [], r.foeLabel || 'FOE');
    const rr = resultRects(r), cur = r.cursor === undefined ? 0 : r.cursor | 0;
    if (rr.recap) { const c = rr.recap; panel(frame, c.x, c.y, c.w, c.h, cur === -1 ? 'sel' : 'normal', true); textC(frame, fitFont(r.recapLabel || 'RECAP', c.w - 6), r.recapLabel || 'RECAP', c.x + c.w / 2, c.y, TEXT.dark, TEXT.shadow); }
    (r.options || []).forEach((label, i) => {
      const o = rr.options[i];
      panel(frame, o.x, o.y, o.w, o.h, i === cur ? 'sel' : 'normal', true);
      textC(frame, fitFont(label, o.w - 6), label, o.x + o.w / 2, o.y, TEXT.dark, TEXT.shadow);
    });
  }
  // ST1: with r.recap the bottom row holds four chips, the RECAP chip first (rect `recap`, cursor -1) and the caller's options after it; without it the three-option layout is exactly the old one
  const resultRects = (r) => {
    const o = r.recap ? GEOM.result.opt4 : GEOM.result.opt, shift = r.recap ? 1 : 0;
    return { options: (r.options || []).map((_, i) => ({ x: o.x + (i + shift) * o.pitch, y: o.y, w: o.w, h: o.h })), recap: r.recap ? { x: o.x, y: o.y, w: o.w, h: o.h } : null };
  };
  // ST1: the recap screen: the title, the page window, the three chips (PREV / BACK / NEXT; PREV is dead on the first page and NEXT on the last)
  const pageDrawer = createPageDrawer({ TEXT, COL, assets: ui, measure: (f, s) => widthOf(f, s), safeText, drawWindow, drawIcon });
  const recapRects = () => { const G = GEOM.recap; return { win: G.win, chips: G.chips.map((c) => ({ ...c })) }; };
  function drawRecapScreen(frame, rc) {
    screenBg(frame);
    const G = GEOM.recap, bob = ((rc.tick | 0) >> 4) & 1;
    text(frame, 'normal', rc.title || '', G.title.x, G.title.y, TEXT.white, TEXT.dark);
    textR(frame, 'normal', (rc.index + 1) + '/' + rc.count, 232, G.title.y, TEXT.white, TEXT.dark);
    pageDrawer.drawWindowPage(frame, rc.page, G.win, { bob });
    const labels = { prev: '{LEFT} PREV', back: rc.backLabel || 'BACK', next: 'NEXT {RIGHT}' };
    G.chips.forEach((c) => {
      const dead = (c.id === 'prev' && !rc.canPrev) || (c.id === 'next' && !rc.canNext);
      panel(frame, c.x, c.y, c.w, c.h, dead ? 'grey' : rc.hover === c.id ? 'sel' : 'normal', true);
      textC(frame, 'normal', labels[c.id], c.x + c.w / 2, c.y, dead ? COL.line : TEXT.dark, TEXT.shadow);
    });
  }

  // small status tags at the top-right: weather / field effects. The plate is a 9-slice of the ROM's own healthbox frame art (the foe frame's
  // white outline + dark border rows, light body, dark bottom border; the right end is the left end mirrored); the label is ROM-font text.
  const plateCache = new Map();
  function tagPlateRGBA(w, h) {
    const key = w + 'x' + h; let out = plateCache.get(key); if (out) return out;
    const art = healthboxArt('foe'), T = TAG_PLATE; out = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const sx = x < T.side ? x : x >= w - T.side ? T.side - 1 - (x - (w - T.side)) : T.midCol;
      const sy = y < T.top ? y : y >= h - T.bottom ? 31 - T.bottom + (y - (h - T.bottom)) - 0 : T.midRow;
      const s = (sy * art.width + sx) * 4, d = (y * w + x) * 4;
      out[d] = art.rgba[s]; out[d + 1] = art.rgba[s + 1]; out[d + 2] = art.rgba[s + 2]; out[d + 3] = art.rgba[s + 3];
    }
    plateCache.set(key, out); return out;
  }
  const TAG_H = 14;
  function tagRects(tags) {
    const out = []; let x = SCREEN_W - 3;
    for (const t of tags || []) { const w = widthOf('small', t) + 8; x -= w; out.push({ text: t, x, y: 1, w, h: TAG_H }); x -= 2; }
    return out;
  }
  function drawTags(frame, tags) {
    for (const r of tagRects(tags)) {
      frame.blit(r.w, r.h, tagPlateRGBA(r.w, r.h), r.x, r.y);
      text(frame, 'small', r.text, r.x + 4, r.y, HB.text, HB.shadow);
    }
  }

  // ---- hit testing (logical 240x160 pixels): the contract in pokemonarena/INPUT.md. kind: 'action' | 'move' | 'party' | 'cancel' | 'preview' |
  // 'result' | 'overlay' | 'text' | 'back' (A4: beside an open menu, above the move menu); index = which one. Generous cells: the rows / cells are contiguous bands, so a tap near an item still picks it.
  const inR = (r, x, y) => x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;
  function actionCells() {
    const m = R.menu, hw = m.w / 2, hh = m.h / 2;
    return [0, 1, 2, 3].map((i) => ({ x: m.x + (i & 1) * hw - (i & 1 ? 0 : 8), y: m.y + (i >> 1) * hh, w: hw + (i & 1 ? 0 : 8), h: hh }));
  }
  const moveCells = () => R.mv.map((r) => ({ x: r.x - 8, y: r.y, w: r.w + 8, h: r.h }));
  // W1 fix A5: the PP / TYPE boxes beside the move menu are the "tell me about this move" target for a mouse (a keyboard has C, a controller X): one rectangle around the three windows
  function moveInfoRect() {
    const rs = [R.pp, R.ppRem, R.type];
    const x0 = Math.min(...rs.map((r) => r.x)), y0 = Math.min(...rs.map((r) => r.y)), x1 = Math.max(...rs.map((r) => r.x + r.w)), y1 = Math.max(...rs.map((r) => r.y + r.h));
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  function hitTest(view, x, y) {
    if (!view) return null;
    if (view.overlay) { const g = overlayRects(view.overlay); for (let i = 0; i < g.rows.length; i++) if (inR(g.rows[i], x, y)) return { kind: 'overlay', index: i }; return { kind: 'back', index: 0 }; }          // W1 fix A4: a tap beside an open menu / YES-NO box goes back (touch never depends on the on-screen pad)
    if (view.screen === 'party' && view.party) {
      const G = GEOM.party, rows = rowRects(G, view.party.mons.length);
      if (x >= G.x - 8) for (let i = 0; i < rows.length; i++) if (y >= rows[i].y - 1 && y < rows[i].y + G.pitch - 1) return { kind: 'party', index: i };
      if (view.party.canCancel && inR(G.cancel, x, y)) return { kind: 'cancel', index: 0 };
      return null;
    }
    if (view.screen === 'preview' && view.preview) {
      const G = GEOM.preview.mine, rows = rowRects(G, view.preview.mine.length);
      if (x < G.x + G.w + 4) for (let i = 0; i < rows.length; i++) if (y >= rows[i].y - 1 && y < rows[i].y + G.pitch - 1) return { kind: 'preview', index: i };
      return null;
    }
    if (view.screen === 'result' && view.result) {
      const g = resultRects(view.result);
      if (g.recap && inR({ x: g.recap.x - 2, y: g.recap.y - 4, w: g.recap.w + 4, h: g.recap.h + 8 }, x, y)) return { kind: 'recap', index: -1 };
      for (let i = 0; i < g.options.length; i++) if (inR({ x: g.options[i].x - 2, y: g.options[i].y - 4, w: g.options[i].w + 4, h: g.options[i].h + 8 }, x, y)) return { kind: 'result', index: i };
      return null;
    }
    if (view.screen === 'recap' && view.recap) {
      for (const c of GEOM.recap.chips) if (inR({ x: c.x - 2, y: c.y - 4, w: c.w + 4, h: c.h + 8 }, x, y)) return { kind: 'recap-' + c.id, index: 0 };
      return inR({ x: 0, y: 0, w: 240, h: 138 }, x, y) ? { kind: 'recap-page', index: 0 } : null;
    }
    const b = view.box;
    if (b && b.mode === 'action') { const c = actionCells(); for (let i = 0; i < 4; i++) if (inR(c[i], x, y)) return { kind: 'action', index: i }; return null; }
    if (b && b.mode === 'moves') { const c = moveCells(), n = Math.min(4, (b.moves || []).length); for (let i = 0; i < n; i++) if (inR(c[i], x, y)) return { kind: 'move', index: i }; if (inR(moveInfoRect(), x, y)) return { kind: 'info', index: 0 }; return y < R.mv[0].y ? { kind: 'back', index: 0 } : null; }          // W1 fix A4: a tap on the picture above the move menu goes back to the action menu; A5: a click on the PP / TYPE boxes reads the move's description
    if (b && b.mode === 'message') return { kind: 'text', index: 0 };
    return null;
  }

  const frame = new Frame();
  return {
    rom, assets: ui, LAYOUT, TEXT, R, GEOM, COL, overlayRects, rowRects, resultRects, recapRects, drawWindow, drawIcon, panel, hitTest, actionCells, moveCells, moveInfoRect,
    env, sprite, healthboxArt, healthboxText, moveNameSlot, tagRects, partyArt, panelRGBA, ballRGBA, measure: (font, s) => widthOf(font, s), safeText, fitFont, hpBarInit, hpBarStep,
    // view -> { width, height, rgba } (a NEW buffer every call: callers may keep it)
    render(view) {
      const f = new Frame();
      if (view.blank) { for (let i = 3; i < f.rgba.length; i += 4) f.rgba[i] = 255; return { width: SCREEN_W, height: SCREEN_H, rgba: f.rgba }; }       // AN1 round 6: nothing is drawn yet (the opening's first frames are black)
      if (view.screen === 'party') drawPartyScreen(f, view.party);
      else if (view.screen === 'preview') drawPreviewScreen(f, view.preview);
      else if (view.screen === 'result') drawResultScreen(f, view.result);
      else if (view.screen === 'recap') drawRecapScreen(f, view.recap);
      else {
        const e = env(Math.max(0, Math.min(ENV_COUNT - 1, view.env | 0)));
        f.rgba.set(e.rgba);
        // AN1: a running ROM animation composites itself (both Pokemon included) onto the terrain, under the healthboxes and the text box; the scene hides its own
        // Pokemon for that time (view.fxDraw is not enumerable; see scene.js view())
        if (view.fxDraw) view.fxDraw(f);
        if (!view.fxSys) {                       // AN1 round 3: a SYSTEM run (view.fxSys) draws the whole battle screen itself: terrain, Pokemon, trainers, balls, shadows and healthboxes
          if (!view.fxDraw) drawShadow(f, view.foe);
          drawMon(f, 'foe', view.foe);
          drawMon(f, 'player', view.player);
          if (view.balls) for (const bl of view.balls) drawBall(f, bl);
          if (view.foe && view.foe.showBox !== false) drawHealthbox(f, 'foe', view.foe, LAYOUT.foeBoxTL);
          if (view.player && view.player.showBox !== false) drawHealthbox(f, 'player', view.player, LAYOUT.playerBoxTL);
        }
        if (view.tags && view.tags.length) drawTags(f, view.tags);
        drawBox(f, view.box);
      }
      if (view.overlay) drawListOverlay(f, view.overlay);
      return { width: SCREEN_W, height: SCREEN_H, rgba: f.rgba };
    },
    _frame: frame,
  };
}

/* ===================================================================================== scripted battle state machine */
//
// A scripted battle with no real engine behind it: FIGHT -> pick a move -> the foe's HP bar drains with messages ->
// the foe retaliates -> ... -> someone faints -> reset. Everything is a pure function of (pack, options, button
// presses, tick count): no Math.random, no Date, so a test can script a whole battle and hash the frames.
//
// Stat / damage rules are the Gen-3 ones (IV 31, EV 0, neutral nature, no crit, no random roll, no accuracy check)
// because they need nothing but the ROM tables; they are placeholders for the real engine, not a claim about it.

export const BUTTONS = ['up', 'down', 'left', 'right', 'a', 'b'];
const MSG_HOLD = 40;                 // frames a finished message stays up before the next step (auto-advance)
export const MAX_LEVEL = 100;        // a level-100 mon is awarded no EXP and cannot level up (its EXP span is 0)

function statOf(base, level) { return Math.floor(((2 * base + 31) * level) / 100) + 5; }
export function hpStat(base, level) { return Math.floor(((2 * base + 31) * level) / 100) + level + 10; }

// Gen-3 damage: ((2L/5+2) * power * A / D) / 50 + 2, then STAB x1.5, then the type chart (UQ4.12) one defending type at a time.
export function damageOf(pack, atk, def, move) {
  if (!(move.power > 0)) return 0;
  const phys = move.category === 0;
  const A = phys ? atk.stats.atk : atk.stats.spa, D = phys ? def.stats.def : def.stats.spd;
  let d = Math.floor(Math.floor(Math.floor((2 * atk.level) / 5 + 2) * move.power * A / Math.max(1, D)) / 50) + 2;
  if (atk.types.includes(move.type)) d = Math.floor((d * 3) / 2);
  let mult = 4096;
  for (const t of new Set(def.types)) mult = Math.floor((mult * pack.typeChart[move.type][t]) / 4096);
  d = Math.floor((d * mult) / 4096);
  return mult === 0 ? 0 : Math.max(1, d);
}
export function effectivenessOf(pack, move, def) {
  let mult = 4096;
  for (const t of new Set(def.types)) mult = Math.floor((mult * pack.typeChart[move.type][t]) / 4096);
  return mult;
}

export function makeMon(pack, id, level, opts = {}) {
  const sp = pack.species[id];
  if (!sp || !sp.legal) throw new UiAssetError('species ' + id + ' is not a legal roster entry');
  const b = sp.baseStats;
  const stats = { hp: hpStat(b.hp, level), atk: statOf(b.atk, level), def: statOf(b.def, level), spa: statOf(b.spa, level), spd: statOf(b.spd, level), spe: statOf(b.spe, level) };
  // last four distinct damaging moves learned by `level`; padded with the earlier ones if the species has few
  const learned = [];
  for (const [m, lv] of sp.levelUp) if (lv <= level && !learned.includes(m) && pack.moves[m] && pack.moves[m].name && pack.moves[m].name !== '-') learned.push(m);
  const dmg = learned.filter((m) => pack.moves[m].power > 0);
  const chosen = dmg.length >= 4 ? dmg.slice(-4) : [...dmg, ...learned.filter((m) => !dmg.includes(m))].slice(-4);
  const moves = chosen.map((m) => { const mv = pack.moves[m]; return { id: m, name: mv.name, type: mv.type, power: mv.power, category: mv.category, pp: mv.pp, maxPp: mv.pp }; });
  let gender = null;
  if (sp.genderRatio === 0) gender = 'M'; else if (sp.genderRatio === 254) gender = 'F';
  else if (sp.genderRatio !== 255) gender = (((id * 37 + 11) & 0xFF) >= sp.genderRatio) ? 'M' : 'F';
  return {
    species: id, name: sp.name, level, gender, types: sp.types.slice(), stats, hp: stats.hp, maxHp: stats.hp, status: null,
    moves, growth: sp.growthRate, baseExp: sp.expYield, shiny: !!opts.shiny, drop: 0, visible: true, showBox: true,
  };
}

export class ScriptedBattle {
  // opts: { player, foe, level, env, textSpeed }  (species ids; level applies to both unless playerLevel/foeLevel)
  constructor(battleUi, pack, opts = {}) {
    this.ui = battleUi; this.pack = pack; this.opts = Object.assign({ player: 25, foe: 129, level: 50, env: 0, textSpeed: 'mid' }, opts);
    this.measure = (s) => battleUi.measure('normal', s);
    this.held = { a: false, b: false };
    this.reset();
  }

  reset() {
    const o = this.opts, pk = this.pack;
    this.player = makeMon(pk, o.player, o.playerLevel || o.level);
    this.foe = makeMon(pk, o.foe, o.foeLevel || o.level);
    // EXP into the current level: 35% of the way to the next level (a fixed scripted value; the span is the ROM's table)
    const span = this.expSpan(this.player);
    this.player.expInto = Math.floor(span * 0.35);
    this.phase = 'steps'; this.cursor = 0; this.moveCursor = 0; this.queue = []; this.cur = null; this.turn = 0; this.frames = 0; this.foeMoveIdx = 0;
    this.then('wild');
    this.say('Wild ' + this.foe.name + ' appeared!'); this.say('Go! ' + this.player.name + '!');
    this.after(() => { this.phase = 'action'; });
  }

  expSpan(m) { const row = this.pack.exp[m.growth]; return Math.max(1, row[Math.min(MAX_LEVEL, m.level + 1)] - row[Math.min(MAX_LEVEL, m.level)]); }

  /* ---- step queue ---- */
  push(step) { this.queue.push(step); }
  then(_tag) { /* marker for readability */ }
  say(text, wait = false) { this.push({ t: 'text', text, wait }); }
  after(fn) { this.push({ t: 'call', fn }); }
  drain(mon, to) { this.push({ t: 'drain', mon, to }); }
  faint(mon) { this.push({ t: 'faint', mon }); }
  expFill(m, gain) { this.push({ t: 'exp', mon: m, gain }); }

  useMove(user, target, move, isPlayer) {
    this.say(user.name + ' used ' + move.name + '!');
    move.pp = Math.max(0, move.pp - 1);
    const dmg = damageOf(this.pack, user, target, move);
    if (!(move.power > 0)) { this.say('But nothing happened!'); return; }
    const mult = effectivenessOf(this.pack, move, target);
    if (mult === 0) { this.say("It doesn't affect " + target.name + '...'); return; }
    const newHp = Math.max(0, target.hp - dmg);
    this.drain(target, newHp);
    if (mult > 4096) this.say("It's super effective!"); else if (mult < 4096) this.say("It's not very effective...");
    this.push({ t: 'call', fn: () => { target.hp = newHp; } });
    if (newHp === 0) this.finishFaint(target, isPlayer);
  }

  finishFaint(target, isPlayerAttacker) {
    this.faint(target);
    if (isPlayerAttacker) {
      this.say('Wild ' + target.name + ' fainted!');
      if (this.player.level < MAX_LEVEL) {
        const gain = Math.max(1, Math.floor((this.foe.baseExp * this.foe.level) / 7));
        this.say(this.player.name + ' gained ' + gain + ' EXP. Points!');
        this.expFill(this.player, gain);
      }
    } else {
      this.say(this.player.name + ' fainted!');
    }
    this.say(isPlayerAttacker ? 'The battle is over.' : 'You lost the battle.', false);
    this.after(() => { this.reset(); });
  }

  runTurn(move) {
    const p = this.player, f = this.foe;
    this.useMove(p, f, move, true);
    // the foe answers unless it fainted (a faint ends in reset(), which discards whatever is still queued)
    this.push({ t: 'call', fn: () => {
      const moves = this.foe.moves.filter((m) => m.pp > 0);
      const fm = moves.length ? moves[this.foeMoveIdx++ % moves.length] : null;
      if (fm) this.useMove(this.foe, this.player, fm, false);
      else this.say(this.foe.name + ' has no moves left!');
      this.after(() => { this.phase = 'action'; this.cursor = 0; });
    } });
    this.phase = 'steps';
  }

  /* ---- input ---- */
  hold(a, b) { this.held.a = !!a; this.held.b = !!b; }
  press(btn) {
    const cur = this.cur;
    if (this.phase === 'steps') {
      if (cur && cur.t === 'text' && cur.tw && (btn === 'a' || btn === 'b')) cur.tw.next();
      return;
    }
    if (this.phase === 'action') {
      if (btn === 'left' || btn === 'right') this.cursor ^= 1;
      else if (btn === 'up' || btn === 'down') this.cursor ^= 2;
      else if (btn === 'a') {
        if (this.cursor === 0) { this.phase = 'moves'; this.moveCursor = 0; }
        else if (this.cursor === 1) { this.say('Your BAG is empty.'); this.after(() => { this.phase = 'action'; }); this.phase = 'steps'; }
        else if (this.cursor === 2) { this.say(this.player.name + ' is your only POK{E}MON.'); this.after(() => { this.phase = 'action'; }); this.phase = 'steps'; }
        else { this.say('Got away safely!'); this.after(() => { this.reset(); }); this.phase = 'steps'; }
      }
      return;
    }
    if (this.phase === 'moves') {
      const n = Math.max(1, this.player.moves.length);
      if (btn === 'left' || btn === 'right') { const c = this.moveCursor ^ 1; if (c < n) this.moveCursor = c; }
      else if (btn === 'up' || btn === 'down') { const c = this.moveCursor ^ 2; if (c < n) this.moveCursor = c; }
      else if (btn === 'b') this.phase = 'action';
      else if (btn === 'a') {
        const mv = this.player.moves[this.moveCursor];
        if (!mv) return;
        if (mv.pp <= 0) { this.say("There's no PP left for this move!"); this.after(() => { this.phase = 'moves'; }); this.phase = 'steps'; return; }
        this.runTurn(mv);
      }
    }
  }

  /* ---- time ---- */
  // advance exactly one 60 Hz frame
  tick() {
    this.frames++;
    if (this.phase !== 'steps' && !this.cur) return;
    if (!this.cur) {
      if (!this.queue.length) return;
      this.cur = this.queue.shift();
      const c = this.cur;
      if (c.t === 'text') {
        c.tw = createTypewriter({ text: this.ui.safeText(c.text), measure: this.measure, maxWidth: this.ui.R.msg.w - 4, delay: TEXT_SPEED[this.opts.textSpeed] });
        c.hold = 0;
      } else if (c.t === 'drain') { c.frames = drainFrames(c.mon.hp, c.to, c.mon.maxHp); c.i = 0; }
      else if (c.t === 'faint') { c.n = 0; }
      else if (c.t === 'exp') { c.left = c.gain; c.n = 0; }
    }
    const c = this.cur;
    switch (c.t) {
      case 'text': {
        const fast = this.held.a || this.held.b;
        if (!c.tw.done) c.tw.tick(fast);
        else if (!c.wait && ++c.hold >= MSG_HOLD) this.cur = null;
        break;
      }
      case 'call': c.fn(); this.cur = null; break;
      case 'drain': {
        if (c.i < c.frames.length) c.mon.hp = c.frames[c.i++];
        if (c.i >= c.frames.length) this.cur = null;
        break;
      }
      case 'faint': {
        c.mon.drop += 4; c.n++;
        if (c.mon.drop >= 64) { c.mon.visible = false; c.mon.showBox = false; this.cur = null; }
        break;
      }
      case 'exp': {
        const m = c.mon;
        if (m.level >= MAX_LEVEL) { c.left = 0; this.cur = null; break; }   // nothing to gain at the cap (span would be 0)
        const span = this.expSpan(m), perFrame = Math.max(1, Math.ceil(span / EXP_BAR_PX));
        const step = Math.min(perFrame, c.left);
        m.expInto += step; c.left -= step;
        if (m.expInto >= span) {
          // level up: the bar is full for this frame, then the next level starts with the remainder; reaching the cap
          // discards what is left (the engine stops awarding EXP at level 100)
          const rem = m.expInto - span;
          m.level = Math.min(MAX_LEVEL, m.level + 1);
          const nh = hpStat(this.pack.species[m.species].baseStats.hp, m.level);
          m.hp += nh - m.maxHp; m.maxHp = nh; m.expInto = rem;
          this.queue.unshift({ t: 'text', text: m.name + ' grew to LV. ' + m.level + '!', wait: false });
          if (m.level >= MAX_LEVEL) { m.expInto = 0; c.left = 0; }
        }
        if (c.left <= 0) this.cur = null;
        break;
      }
      default: this.cur = null;
    }
  }

  // run until the queue is idle or the scripted battle needs a button (for tests); returns frames consumed
  settle(maxFrames = 20000) {
    let n = 0;
    while (n < maxFrames && (this.cur || (this.phase === 'steps' && this.queue.length))) { this.tick(); n++; }
    return n;
  }

  /* ---- what to draw ---- */
  view() {
    const p = this.player, f = this.foe;
    const mon = (m) => ({
      species: m.species, name: m.name, level: m.level, gender: m.gender, hp: m.hp, maxHp: m.maxHp, status: m.status, shiny: m.shiny,
      drop: m.drop, visible: m.visible, showBox: m.showBox,
      exp: m === p ? { into: m.expInto, span: this.expSpan(m) } : undefined,
    });
    let box;
    if (this.phase === 'action') box = { mode: 'action', prompt: ['What will', p.name + ' do?'], cursor: this.cursor };
    else if (this.phase === 'moves') box = { mode: 'moves', cursor: this.moveCursor, moves: p.moves.map((m) => ({ name: m.name, pp: m.pp, maxPp: m.maxPp, type: m.type, typeName: (this.pack.types[m.type] || {}).name || '' })) };
    else {
      const c = this.cur && this.cur.t === 'text' ? this.cur : null;
      box = c ? { mode: 'message', text: c.tw.lines(), arrow: c.tw.arrowOn() } : (this.lastBox && this.lastBox.mode === 'message' ? this.lastBox : { mode: 'message', text: ['', ''] });
      if (c) this.lastBox = box;
    }
    return { env: this.opts.env, foe: mon(f), player: mon(p), box };
  }

  debug() {
    return {
      phase: this.phase, step: this.cur ? this.cur.t : null, queued: this.queue.length, frames: this.frames,
      playerHp: this.player.hp + '/' + this.player.maxHp, foeHp: this.foe.hp + '/' + this.foe.maxHp,
      playerBarPx: hpFillPixels(this.player.hp, this.player.maxHp), foeBarPx: hpFillPixels(this.foe.hp, this.foe.maxHp),
      playerBar: hpBarColor(this.player.hp, this.player.maxHp), foeBar: hpBarColor(this.foe.hp, this.foe.maxHp),
    };
  }
}

export { createTypewriter, TEXT_SPEED };

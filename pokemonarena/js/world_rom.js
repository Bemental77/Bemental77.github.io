// pokemonarena/js/world_rom.js
//
// THE OVERWORLD of the SoulGold v1.1.1 ROM, decoded at runtime from the ROM bytes the caller supplies: every map
// (blocks, collision, behaviours, events), the map pictures (tilesets -> metatiles -> pixels, split into what is
// drawn BELOW and ABOVE the sprites), the overworld (field) sprites with their own animation tables, and the
// emote icons. Pure ES module for the browser AND Node: Uint8Array in, plain objects / typed arrays out, no DOM,
// no node: imports. NOTHING ROM-DERIVED IS STORED HERE: the file holds hand-written code, ROM offsets, strides,
// counts, tags, graphics ids and layout rules only. Every pinned number below was found by scanning the ROM and
// confirmed by decoding the thing and LOOKING at it (tools/pokemonarena_world_test.mjs --sheets writes the
// contact sheets; pokemonarena/world.golden.json holds hashes only, no pixels).
//
//   import { loadWorld, MB, GFX, DIRS } from './world_rom.js';
//   const world = loadWorld(romBytes);                 // throws WorldRomError on a wrong / damaged ROM
//   const room = world.center;                         // the Pokemon Center 1F (map 2.0), see CENTER below
//   const pic = world.renderMap(room);                 // { width: 256, height: 160, under, over }  RGBA, 16 px per cell
//   const view = world.renderView(room, 0, 0, 240, 160);          // the GBA screen: the room is exactly one screen
//   const me = world.ow.walker(world.ow.avatars[0], 'down', 0);   // { width, height, rgba, flipX, frame }
//   for (const s of world.mapSprites(room)) blit(s.sprite.rgba, s.px, s.py);   // the nurse and the other NPCs, as placed
//   // one frame: view.under, then every sprite sorted by y (feet on the cell's bottom edge), then view.over
//
// ------------------------------------------------------------------------------------------------------------
// THE DATA MODEL AS FOUND IN THIS ROM (an Emerald engine with pokeemerald-expansion structs; the hack changed
// five engine constants, and each was measured, not assumed)
//
// MAPS
//   gMapGroups      0x1572e10   27 pointers, one per group, each to an array of MapHeader pointers. The arrays lie
//                               back to back just before the table (0x157246c .. 0x1572e10), so group g's map count
//                               is (next array - this array) / 4; the last array ends at gMapGroups. 617 maps.
//                               Found: the one long run of pointers to structs whose first field is a MapLayout.
//                               Confirmed: for all 617 headers gMapLayouts[mapLayoutId - 1] == header.mapLayout
//                               (loadWorld re-checks this for every header it reads).
//   gMapLayouts     0x156d0dc   1029 pointers (376 null), indexed by mapLayoutId - 1. The table begins with null
//                               slots: its base was fixed from one header's mapLayoutId, then confirmed on all 617.
//   MapHeader (28 B) +0 MapLayout*  +4 MapEvents*  +8 scripts*  +12 connections*  +16 u16 music  +18 u16 mapLayoutId
//                   +20 u16 regionMapSectionId  +22 u8 cave  +23 u8 weather  +24 u8 mapType  +26 u8 flags  +27 u8 battleType
//   MapLayout (28 B) +0 s32 width  +4 s32 height  +8 u16* border  +12 u16* map  +16 Tileset* primary
//                   +20 Tileset* secondary  +24 u32 (zero in all 653 layouts). The border is 2x2 blocks (the 8 bytes
//                   before the map data; in the ROM a layout struct directly follows its own map data).
//   MAP BLOCK (u16)  bits 0-10 metatile id (11 bits, NOT Emerald's 10) | bit 11 collision (1 bit, NOT 2) |
//                   bits 12-15 elevation. Measured: read the Emerald way, a house's walls come out walkable at
//                   elevation 0 and its floor impassable; read this way the walls are collision 1 / elevation 0, the
//                   floors collision 0 / elevation 3, and the largest id any map uses is 1459.
//   METATILE IDS     < 1024 index the PRIMARY tileset, >= 1024 the SECONDARY (id - 1024). Measured: for 146 of the 149
//                   tilesets any layout names, the largest index used is below the tileset's metatile count (its
//                   attribute table's bytes / 2); the three exceptions include the unconverted Emerald leftovers.
//   Tileset (24 B)   +0 u8 isCompressed  +1 u8 isSecondary  +4 tiles*  +8 palettes*  +12 metatiles*  +16 attributes*
//                   +20 callback (tile animation; 0 = none). Tiles are 4bpp, LZ77 (the oldest few) or smol compressed.
//   TILES            640 primary + 384 secondary (FireRed's split, not Emerald's 512 + 512): a tile id < 640 is the
//                   primary's, >= 640 is the secondary's (id - 640). Measured over the metatiles live maps use: 64 of
//                   505,440 tile references fall outside their tileset with this split (60 name tiles 512-639 of a
//                   512-tile primary, 4 a secondary tile past its end); such a tile draws nothing.
//   PALETTES         16 colours x 13 (some tilesets store 16), raw BGR555. Slots 0-6 come from the PRIMARY, 7-12 from
//                   the SECONDARY (FireRed's 7 + 6, not Emerald's 6 + 7). Measured: the secondary tilesets inspected
//                   have blank slots 0-6, and over all live maps secondary tiles are drawn in slots 7-12 in 99,457 of
//                   109,860 references. The under layer's backdrop is black (Emerald's engine
//                   blacks colour 0 of slot 0; taken from the engine's source, NOT confirmed in this ROM's code).
//   METATILES        TRIPLE LAYER: 12 u16 tile entries (24 bytes), three 2x2 layers: bottom, middle, top. A tile entry
//                   is the GBA's: bits 0-9 tile, 10 h-flip, 11 v-flip, 12-15 palette. Measured: the metatile table is
//                   exactly 24 bytes per attribute entry in over a hundred tilesets. The bottom and middle layers are
//                   drawn BELOW the sprites, the top layer ABOVE them (a triple-layer engine puts them on BG3 / BG2 /
//                   BG1 and no longer reads the attribute's layer type). Confirmed by looking: the Center's plant tops,
//                   the flowers and the machine on the counter and the wall corners are in the top layer; the floor,
//                   the counter, the PC, the table and the mat are below. NOT confirmed against the running game.
//   ATTRIBUTES       u16 per metatile; the low byte is the behaviour (Emerald's MB_* numbering: the Center's counter is
//                   0x80, its PC 0x83, its wall map 0x85, its door mat 0x65, and the mat is where the warp event is).
//   MapEvents (20 B) +0 u8 objectCount  +1 warpCount  +2 coordCount  +3 bgCount  +4 objects*  +8 warps*  +12 coords*  +16 bgs*
//   ObjectEventTemplate (24 B, the expansion's packed one)  +0 u8 localId  +1 u16 graphicsId  +3 u8 kind  +4 s16 x
//                   +6 s16 y  +8 u8 elevation  +9 u8 movementType  +10 u8 range (x low nibble, y high)  +12 u16 trainerType
//                   +14 u16 trainerRange / berryTreeId  +16 script*  +20 u16 flagId. Confirmed: in every map that has
//                   both, the warp array starts exactly objectCount * 24 bytes after the object array.
//   WarpEvent (8 B)  +0 s16 x  +2 s16 y  +4 u8 elevation  +5 u8 warpId  +6 u8 mapNum  +7 u8 mapGroup
//   CoordEvent (16 B) +0 u16 x  +2 u16 y  +4 u8 elevation  +6 u16 trigger var  +8 u16 index  +12 script*  (Emerald's; not looked at)
//   BgEvent (12 B)   +0 u16 x  +2 u16 y  +4 u8 elevation  +5 u8 kind  +8 script* / hidden item word
//   gInitialMovementTypeFacingDirections  0x4e6604, 82 bytes (1 south, 2 north, 3 west, 4 east), found by its Emerald
//                   prefix; gives an object's first facing from its movementType.
//
// OVERWORLD SPRITES
//   gObjectEventGraphicsInfoPointers  0x4f1078   330 pointers (graphics ids 0..329). The 45 pointers before it are the
//                   field-effect sprite templates. Found: the pointer run whose targets are 36-byte graphics infos;
//                   id 58 is the nurse every Pokemon Center places behind its counter.
//   ObjectEventGraphicsInfo (36 B)  +0 u16 tileTag  +2 u16 paletteTag  +4 u16 reflectionPaletteTag  +6 u16 size
//                   +8 s16 width  +10 s16 height  +12 u8 paletteSlot:4 shadowSize:2 inanimate:1 compressed:1  +13 u8 tracks
//                   +16 oam*  +20 subspriteTables*  +24 anims*  +28 images*  +32 affineAnims*
//   SpriteFrameImage (8 B)  +0 data*  +4 u16 size  +6 u16 relativeFrames:1. With relativeFrames the table has ONE entry
//                   and frame f is at data + f * size (a whole sheet); without it the table has one entry per frame.
//                   Frames are raw 4bpp tiles in row order. No sprite of this ROM sets the compressed bit (the code
//                   path for it is written but has never run on real data).
//   anims            an array of pointers to AnimCmd lists; a list is u32 commands: low 16 bits signed frame (-1 end,
//                   -2 jump, -3 loop), bits 16-21 duration, bit 22 h-flip, bit 23 v-flip. The engine's standard order
//                   is [0] face south [1] face north [2] face west [3] face east [4..7] walk south / north / west / east.
//                   walker() READS these lists: a walker's standing frame is the first frame of its face anim, its two
//                   walk frames are the first two frames of its walk anim that are not the standing frame. For the 218
//                   sprites on the standard table that is stand 0 / 1 / 2 and walk 3,4 / 5,6 / 7,8, east = west h-flipped;
//                   follower Pokemon have one walk frame per direction (stand 0 / 2 / 4, walk 1 / 3 / 5).
//   FRAME COUNTS     the info does not say how many frames a sprite has. It is the smaller of (the highest frame its
//                   anim lists name + 1) and (what its pictures hold: all pictures lie back to back, so a sheet ends
//                   where the next picture starts and an image table where the next table starts).
//   sObjectEventSpritePalettes  0x4e9c84   { u16* data; u16 tag; u16 pad } records, ended by a null pointer; a sprite's
//                   colours are the record whose tag equals its paletteTag (raw 16 x BGR555). Found by tag 0x1100.
//                   0x1100 is the boy's palette, 0x1110 the girl's, 0x1103..0x1106 the four shared NPC palettes (their
//                   colours 0-4, skin and outline, are identical; hair and clothes differ).
//   FOLLOWER POKEMON  graphics id 0x4000 | species (| 0x8000 shiny, | 0x2000 female): the species struct (table
//                   0x7c7310, stride 0x118, see speciesgfx.js) embeds a graphics info at +0xc0 (female form +0xe4) and
//                   palette pointers at +0x108 (shiny +0x10c). 956 species have one (897 are 32x32, 59 are 64x64).
//   AVATARS          ow.avatars: the 16x32 sprites with the full walk (four directions, three different pictures each,
//                   all drawn, every frame its own), each picture once: the two player characters (ids 0 and 89), then
//                   135 people in table order. Kept out, each seen in the contact sheets: Pokemon drawn as walkers,
//                   swimmers, the link / rival copies of the players (the same pictures again), four people whose image
//                   table has three frames and runs on into the next sprite, four with empty walk frames, and eighteen
//                   "standers" whose walk frames are copies of the standing ones (ow.standers: the nurse is one).
//
// EMOTES            three sprite templates share one callback (0x0826ba39): 0x13bcbf8 (palette tag 0x1110): the "!" "?"
//                   "!!" "x" icons; 0x13bcc28 (tag 0x1103): the heart; 0x13bcc10 (tag 0x8003): the expansion's eleven
//                   follower emotes, two frames each. SpriteTemplate (24 B): +0 u16 tileTag +2 u16 paletteTag +4 oam*
//                   +8 anims* +12 images* +16 affineAnims* +20 callback. All images are 16x16. Found through the
//                   emote palette's tag (0x8003) in a template, then the two templates with the same callback.
//
// THE POKEMON CENTER (CENTER below, world.center): 23 maps are the standard Center (the nurse, a Chansey beside her,
//   one PC cell, the counter, the wall map, one door-mat warp; tilesets 0x1138dc8 + 0x1138e28): thirteen are 16x10
//   with a last column of solid black filler (twelve of them block for block identical) and ten are 15x10 with a
//   second table. Map 2.0 is the first of the thirteen; its door leads to map 0.1. The room proper is 15 x 10 cells =
//   240 x 160 px, exactly the GBA screen. There is no upstairs: the only warp is the door mat. Neither tileset has a
//   tile-animation callback, so nothing in the room animates. Seats and cushions have no behaviour of their own: they
//   are plain walkable floor; the table is four solid cells. world.centers also lists the five other maps that have a
//   nurse, a PC and a counter (a big hall, the 35x18 one, a white 16x10 one, a 29x30 one and the 19x11 one with escalators).
//
// NOT HERE (looked for or considered, not done): the field message box frame (uiassets.js has the battle one and the
//   standard window frame), the overworld shadow sprite (field-effect templates 0-3 at 0x4f0fc4; its palette tag
//   0x1200 is a run-time weather palette, not a table entry), map connections, map scripts, tile animations.

import { GfxError, decompressAny } from './gfxcodec.js';

export class WorldRomError extends Error {
  constructor(msg) { super(msg); this.name = 'WorldRomError'; }
}

export const ROM_LENGTH = 33554432;
export const ROM_TITLE = 'POKEMON EMER';   // header 0xA0..0xAB
export const ROM_GAME_CODE = 'BPEE';       // header 0xAC..0xAF
const ROM_BASE = 0x08000000;

/** Every pinned ROM offset / count / stride of this module in one place (see the header for how each was found). */
export const WORLD_OFFSETS = Object.freeze({
  mapGroups: 0x1572e10, mapGroupCount: 27, mapCount: 617,
  mapLayouts: 0x156d0dc, mapLayoutCount: 1029,
  mapHeaderSize: 28, mapLayoutSize: 28, tilesetSize: 24,
  objectTemplateSize: 24, warpSize: 8, coordEventSize: 16, bgEventSize: 12,
  facingTable: 0x4e6604, facingCount: 82,
  owInfoPointers: 0x4f1078, owInfoCount: 330, owInfoSize: 36,
  owPalettes: 0x4e9c84, owPaletteMax: 256,
  speciesTable: 0x7c7310, speciesStride: 0x118, speciesMax: 1577,
  speciesOw: 0xc0, speciesOwFemale: 0xe4, speciesOwPalette: 0x108, speciesOwShinyPalette: 0x10c,
  emoteIconTemplate: 0x13bcbf8, emoteHeartTemplate: 0x13bcc28, emoteFollowerTemplate: 0x13bcc10,
});

/** The engine constants this hack changed (see MAP BLOCK / TILES / PALETTES / METATILES in the header). */
export const BLOCK_METATILE_MASK = 0x07ff;
export const BLOCK_COLLISION_SHIFT = 11;
export const BLOCK_COLLISION_MASK = 0x0800;
export const BLOCK_ELEVATION_SHIFT = 12;
export const METATILES_IN_PRIMARY = 1024;
export const TILES_IN_PRIMARY = 640;
export const TILES_TOTAL = 1024;
export const PALS_IN_PRIMARY = 7;
export const PALS_TOTAL = 13;
export const TILES_PER_METATILE = 12;       // three 2x2 layers
export const METATILE_LAYERS = 3;
export const TOP_LAYER = 2;                 // the layer drawn above the sprites
export const CELL = 16;                     // pixels per map cell
const RENDER_CACHE_BYTES = 32 * 1024 * 1024;   // map pictures kept (see renderMap)

/** Metatile behaviours (attribute low byte). COUNTER, PC, REGION_MAP and SOUTH_ARROW_WARP were confirmed by where
 *  they are in the Pokemon Center; the second group is Emerald's numbering for the same family (values that do occur
 *  in this ROM's maps, NOT confirmed one by one by looking). */
export const MB = Object.freeze({
  NORMAL: 0x00,
  COUNTER: 0x80,            // you talk ACROSS it: the cell beyond it is the one you address
  PC: 0x83,                 // the PC: face it from the cell below
  REGION_MAP: 0x85,         // the map on the wall
  SOUTH_ARROW_WARP: 0x65,   // the door mat: stepping DOWN on it leaves through the warp event on the same cell
  NON_ANIMATED_DOOR: 0x60, LADDER: 0x61, EAST_ARROW_WARP: 0x62, WEST_ARROW_WARP: 0x63, NORTH_ARROW_WARP: 0x64,
  ANIMATED_DOOR: 0x69, UP_ESCALATOR: 0x6a, DOWN_ESCALATOR: 0x6b, TELEVISION: 0x86,
});

/** Graphics ids with a fixed meaning in this ROM (ids are table indices, not ROM data). */
export const GFX = Object.freeze({
  NURSE: 58,
  MON: 0x4000, MON_SHINY: 0x8000, MON_FEMALE: 0x2000, MON_SPECIES_MASK: 0x1fff,
});

/** The canonical Pokemon Center 1F. */
export const CENTER = Object.freeze({ group: 2, num: 0 });

export const DIRS = Object.freeze(['down', 'up', 'left', 'right']);
const FACING_BY_CODE = ['down', 'down', 'up', 'left', 'right'];   // 0 (none) and 1 = south
const SOUTH = 0, NORTH = 1, WEST = 2, EAST = 3;                    // ANIM_STD_FACE_*; the walk anims are 4 + these

// Sprite palette tags: the player's, and the four shared NPC palettes.
export const PAL_TAG_PLAYER = 0x1100;
export const NPC_PAL_TAGS = Object.freeze([0x1103, 0x1104, 0x1105, 0x1106]);
const PAL_TAG_DYNAMIC = 0x1124;   // follower Pokemon: the colours come from the species struct

// The emote names are this site's labels for the pictures (looked at one by one), in the ROM's own table order.
const ICON_NAMES = ['exclaim', 'question', 'doubleExclaim', 'cross'];
const FOLLOWER_EMOTE_NAMES = ['happy', 'smile', 'sad', 'upset', 'angry', 'pensive', 'love', 'surprise', 'curious', 'music', 'poisoned'];

// Graphics ids that pass the structural "16x32 walker with a drawn walk" test but are not a trainer / person a player
// can be (looked at one by one in the contact sheets). Kept out of ow.avatars and ow.standers.
//   225 Kecleon, 226 Dusclops, 228 Sudowoodo, 229 Mew, 310 a bird Pokemon: Pokemon drawn as 16x32 walkers
//   300, 303: swimmers, drawn waist-deep in water with splash pixels
const NOT_A_PERSON = new Set([225, 226, 228, 229, 300, 303, 310]);

/* ------------------------------------------------------------------------------------------------ reader */

function ascii(rom, o, n) { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(rom[o + i]); return s; }

/** Cheap identity check (length + cartridge header). The offsets below are specific to SoulGold v1.1.1; the
 *  caller verifies the SHA-256 (rom.js) before it trusts anything online. */
export function validateRom(rom) {
  if (!(rom instanceof Uint8Array)) throw new WorldRomError('ROM must be a Uint8Array');
  if (rom.length !== ROM_LENGTH) throw new WorldRomError('ROM length ' + rom.length + ' != ' + ROM_LENGTH + ' (expected the 32 MiB SoulGold v1.1.1 image)');
  const title = ascii(rom, 0xa0, 12), code = ascii(rom, 0xac, 4);
  if (title !== ROM_TITLE || code !== ROM_GAME_CODE) {
    throw new WorldRomError('ROM header is "' + title + '"/"' + code + '", expected "' + ROM_TITLE + '"/"' + ROM_GAME_CODE + '"');
  }
  return true;
}

function makeReader(rom) {
  const dv = new DataView(rom.buffer, rom.byteOffset, rom.byteLength);
  const len = rom.length;
  const chk = (o, n) => { if (!(o >= 0 && o + n <= len)) throw new WorldRomError('read of ' + n + ' bytes at 0x' + (o >>> 0).toString(16) + ' is outside the ROM'); };
  const R = {
    u8(o) { chk(o, 1); return rom[o]; },
    u16(o) { chk(o, 2); return dv.getUint16(o, true); },
    s16(o) { chk(o, 2); return dv.getInt16(o, true); },
    u32(o) { chk(o, 4); return dv.getUint32(o, true); },
    s32(o) { chk(o, 4); return dv.getInt32(o, true); },
    isPtr(v) { return v >= ROM_BASE && v < ROM_BASE + len; },
    /** pointer field -> file offset; 0 for a null pointer; anything else outside the ROM is a format error */
    ptr(o) {
      const v = R.u32(o);
      if (v === 0) return 0;
      if (!R.isPtr(v)) throw new WorldRomError('bad ROM pointer 0x' + v.toString(16) + ' read at 0x' + o.toString(16));
      return v - ROM_BASE;
    },
    /** as ptr(), but null is an error too */
    need(o, what) {
      const p = R.ptr(o);
      if (!p) throw new WorldRomError('null ' + what + ' pointer at 0x' + o.toString(16));
      return p;
    },
  };
  return R;
}

/* ------------------------------------------------------------------------------------------------ pixels */

// BGR555 -> RGBA bytes for one colour into `out` at `o`.
function putColour(out, o, c) {
  const r = c & 31, g = (c >> 5) & 31, b = (c >> 10) & 31;
  out[o] = (r << 3) | (r >> 2); out[o + 1] = (g << 3) | (g >> 2); out[o + 2] = (b << 3) | (b >> 2); out[o + 3] = 255;
}

// 4bpp tile data (row-major tiles, the 1D OBJ order) + 16 BGR555 colours -> RGBA, colour 0 transparent.
function spriteRGBA(rom, off, width, height, pal, flipX) {
  const tw = width >> 3, th = height >> 3;
  const out = new Uint8Array(width * height * 4);
  if (off < 0 || off + tw * th * 32 > rom.length) throw new WorldRomError('sprite frame at 0x' + off.toString(16) + ' runs outside the ROM');
  for (let ty = 0; ty < th; ty++) {
    for (let tx = 0; tx < tw; tx++) {
      const base = off + (ty * tw + tx) * 32;
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          const b = rom[base + y * 4 + (x >> 1)];
          const idx = (x & 1) ? b >> 4 : b & 15;
          if (!idx) continue;
          const px = tx * 8 + x, py = ty * 8 + y;
          putColour(out, (py * width + (flipX ? width - 1 - px : px)) * 4, pal[idx]);
        }
      }
    }
  }
  return out;
}

function mirrorRGBA(src, width, height) {
  const out = new Uint8Array(src.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4, d = (y * width + (width - 1 - x)) * 4;
      out[d] = src[s]; out[d + 1] = src[s + 1]; out[d + 2] = src[s + 2]; out[d + 3] = src[s + 3];
    }
  }
  return out;
}

const mod2 = (v) => ((v % 2) + 2) % 2;

/* ------------------------------------------------------------------------------------------------ world */

/**
 * loadWorld(romBytes) -> world. Lazy and cached: nothing is decoded until asked for; every map, tileset and sprite
 * frame is decoded once, and the most recent map pictures are kept (32 MB of them). Returned objects and typed arrays
 * are SHARED: treat them as read-only.
 * Throws WorldRomError when the bytes are not this ROM (length, header, or a table that does not hold together).
 */
export function loadWorld(romBytes) {
  validateRom(romBytes);
  const rom = romBytes;
  const R = makeReader(rom);
  const O = WORLD_OFFSETS;

  /* ---- map groups ------------------------------------------------------------------------------------- */
  const groupArrays = [];
  for (let g = 0; g < O.mapGroupCount; g++) groupArrays.push(R.need(O.mapGroups + 4 * g, 'map group'));
  const groupSizes = [];
  {
    const sorted = groupArrays.slice().sort((a, b) => a - b);
    for (let g = 0; g < O.mapGroupCount; g++) {
      const i = sorted.indexOf(groupArrays[g]);
      const end = i + 1 < sorted.length ? sorted[i + 1] : O.mapGroups;
      const n = (end - groupArrays[g]) / 4;
      if (!(Number.isInteger(n) && n >= 1 && n <= 255)) throw new WorldRomError('map group ' + g + ' has an implausible size ' + n);
      groupSizes.push(n);
    }
    const total = groupSizes.reduce((a, b) => a + b, 0);
    if (total !== O.mapCount) throw new WorldRomError('map groups hold ' + total + ' maps, expected ' + O.mapCount);
  }

  function header(group, num) {
    if (!(Number.isInteger(group) && group >= 0 && group < O.mapGroupCount)) throw new WorldRomError('no map group ' + group);
    if (!(Number.isInteger(num) && num >= 0 && num < groupSizes[group])) throw new WorldRomError('no map ' + group + '.' + num);
    const h = R.need(groupArrays[group] + 4 * num, 'map header');
    const layout = R.need(h, 'map layout');
    const layoutId = R.u16(h + 18);
    if (!(layoutId >= 1 && layoutId <= O.mapLayoutCount) || R.ptr(O.mapLayouts + 4 * (layoutId - 1)) !== layout) {
      throw new WorldRomError('map ' + group + '.' + num + ': layout id ' + layoutId + ' does not name its own layout');
    }
    return {
      offset: h, layout, events: R.ptr(h + 4), scripts: R.ptr(h + 8), connections: R.ptr(h + 12),
      music: R.u16(h + 16), layoutId, regionSection: R.u16(h + 20), cave: R.u8(h + 22), weather: R.u8(h + 23),
      mapType: R.u8(h + 24), flags: R.u8(h + 26), battleType: R.u8(h + 27),
    };
  }

  function layoutOf(off) {
    const width = R.s32(off), height = R.s32(off + 4);
    if (!(width >= 1 && width <= 1024 && height >= 1 && height <= 1024)) throw new WorldRomError('layout at 0x' + off.toString(16) + ' has size ' + width + 'x' + height);
    return {
      offset: off, width, height, border: R.need(off + 8, 'border'), map: R.need(off + 12, 'map data'),
      primary: R.need(off + 16, 'primary tileset'), secondary: R.ptr(off + 20),
    };
  }

  /* ---- tilesets ---------------------------------------------------------------------------------------- */
  const tilesetCache = new Map();
  function tileset(off) {
    if (!off) return null;
    let t = tilesetCache.get(off);
    if (t) return t;
    const isCompressed = R.u8(off), tilesOff = R.need(off + 4, 'tileset tiles');
    let tiles;
    if (isCompressed) {
      let r;
      try { r = decompressAny(rom, tilesOff); } catch (e) { if (!(e instanceof GfxError)) throw e; r = null; }
      if (!r) throw new WorldRomError('tileset at 0x' + off.toString(16) + ': tiles at 0x' + tilesOff.toString(16) + ' are neither LZ77 nor smol');
      tiles = r.data;
    } else {
      tiles = rom.subarray(tilesOff, Math.min(rom.length, tilesOff + TILES_TOTAL * 32));
    }
    t = {
      offset: off, isCompressed: !!isCompressed, isSecondary: !!R.u8(off + 1), tiles, tileCount: tiles.length >> 5,
      palettes: R.need(off + 8, 'tileset palettes'), metatiles: R.need(off + 12, 'tileset metatiles'),
      attributes: R.need(off + 16, 'tileset attributes'), callback: R.u32(off + 20),
    };
    tilesetCache.set(off, t);
    return t;
  }

  // metatile id -> { set, index } (null when the map has no secondary tileset for a secondary id)
  function metatileRef(primary, secondary, id) {
    if (id < METATILES_IN_PRIMARY) return { set: primary, index: id };
    return secondary ? { set: secondary, index: id - METATILES_IN_PRIMARY } : null;
  }
  function attributeOf(primary, secondary, id) {
    const ref = metatileRef(primary, secondary, id);
    return ref ? R.u16(ref.set.attributes + 2 * ref.index) : 0;
  }

  /* ---- events ------------------------------------------------------------------------------------------ */
  function facingOf(movementType) {
    if (movementType >= O.facingCount) return 'down';
    return FACING_BY_CODE[R.u8(O.facingTable + movementType)] || 'down';
  }

  function eventsOf(off) {
    const out = { objects: [], warps: [], coords: [], bgs: [] };
    if (!off) return out;
    const nObj = R.u8(off), nWarp = R.u8(off + 1), nCoord = R.u8(off + 2), nBg = R.u8(off + 3);
    const pObj = R.ptr(off + 4), pWarp = R.ptr(off + 8), pCoord = R.ptr(off + 12), pBg = R.ptr(off + 16);
    if ((nObj && !pObj) || (nWarp && !pWarp) || (nCoord && !pCoord) || (nBg && !pBg)) throw new WorldRomError('map events at 0x' + off.toString(16) + ' count entries behind a null pointer');
    for (let i = 0; i < nObj; i++) {
      const o = pObj + i * O.objectTemplateSize;
      const movementType = R.u8(o + 9), range = R.u8(o + 10);
      out.objects.push({
        localId: R.u8(o), gfx: R.u16(o + 1), kind: R.u8(o + 3), x: R.s16(o + 4), y: R.s16(o + 6), elevation: R.u8(o + 8),
        movementType, facing: facingOf(movementType), rangeX: range & 15, rangeY: range >> 4,
        trainerType: R.u16(o + 12), trainerRange: R.u16(o + 14), script: R.u32(o + 16), flag: R.u16(o + 20),
      });
    }
    for (let i = 0; i < nWarp; i++) {
      const o = pWarp + i * O.warpSize;
      out.warps.push({ x: R.s16(o), y: R.s16(o + 2), elevation: R.u8(o + 4), warpId: R.u8(o + 5), destNum: R.u8(o + 6), destGroup: R.u8(o + 7) });
    }
    for (let i = 0; i < nCoord; i++) {
      const o = pCoord + i * O.coordEventSize;
      out.coords.push({ x: R.u16(o), y: R.u16(o + 2), elevation: R.u8(o + 4), trigger: R.u16(o + 6), index: R.u16(o + 8), script: R.u32(o + 12) });
    }
    for (let i = 0; i < nBg; i++) {
      const o = pBg + i * O.bgEventSize;
      out.bgs.push({ x: R.u16(o), y: R.u16(o + 2), elevation: R.u8(o + 4), kind: R.u8(o + 5), data: R.u32(o + 8) });
    }
    return out;
  }

  /* ---- maps -------------------------------------------------------------------------------------------- */
  let mapList = null;
  function maps() {
    if (mapList) return mapList;
    const out = [];
    for (let g = 0; g < O.mapGroupCount; g++) {
      for (let n = 0; n < groupSizes[g]; n++) {
        const h = header(g, n), L = layoutOf(h.layout);
        out.push({
          group: g, num: n, layoutId: h.layoutId, width: L.width, height: L.height, music: h.music,
          objectCount: h.events ? R.u8(h.events) : 0, warpCount: h.events ? R.u8(h.events + 1) : 0,
          mapType: h.mapType, regionSection: h.regionSection,
        });
      }
    }
    mapList = out;
    return out;
  }

  const mapCache = new Map();
  function map(group, num) {
    const key = group + '.' + num;
    let m = mapCache.get(key);
    if (m) return m;
    const h = header(group, num), L = layoutOf(h.layout);
    const primary = tileset(L.primary), secondary = tileset(L.secondary);
    const n = L.width * L.height;
    if (L.map + n * 2 > rom.length) throw new WorldRomError('map ' + key + ': block data runs outside the ROM');
    const blocks = new Uint16Array(n), metatiles = new Uint16Array(n), attributes = new Uint16Array(n);
    const collision = new Uint8Array(n), elevation = new Uint8Array(n), behavior = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const b = R.u16(L.map + 2 * i);
      blocks[i] = b;
      metatiles[i] = b & BLOCK_METATILE_MASK;
      collision[i] = (b & BLOCK_COLLISION_MASK) >> BLOCK_COLLISION_SHIFT;
      elevation[i] = b >> BLOCK_ELEVATION_SHIFT;
      attributes[i] = attributeOf(primary, secondary, metatiles[i]);
      behavior[i] = attributes[i] & 0xff;
    }
    const border = new Uint16Array(4);
    for (let i = 0; i < 4; i++) border[i] = R.u16(L.border + 2 * i);
    const inside = (x, y) => Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < L.width && y < L.height;
    m = {
      group, num, layoutId: h.layoutId, width: L.width, height: L.height, music: h.music,
      regionSection: h.regionSection, mapType: h.mapType, weather: h.weather, cave: h.cave,
      blocks, metatiles, collision, elevation, behavior, attributes, border,
      tilesets: { primary: L.primary, secondary: L.secondary, animated: !!(primary.callback || (secondary && secondary.callback)) },
      events: eventsOf(h.events),
      inside,
      /** true when a trainer can stand on the cell: inside the map and collision 0 */
      walkable(x, y) { return inside(x, y) && collision[y * L.width + x] === 0; },
      behaviorAt(x, y) { return inside(x, y) ? behavior[y * L.width + x] : MB.NORMAL; },
    };
    mapCache.set(key, m);
    return m;
  }

  /* ---- rendering --------------------------------------------------------------------------------------- */
  const paletteCache = new Map();
  /** The 13 x 16 colours a map is drawn with (Uint16Array(256) BGR555, slots 13-15 zero): 0-6 primary, 7-12 secondary. */
  function mapPalette(m) {
    const key = m.tilesets.primary + ':' + m.tilesets.secondary;
    let p = paletteCache.get(key);
    if (p) return p;
    const primary = tileset(m.tilesets.primary), secondary = tileset(m.tilesets.secondary);
    p = new Uint16Array(256);
    for (let slot = 0; slot < PALS_TOTAL; slot++) {
      const src = slot < PALS_IN_PRIMARY ? primary : secondary;
      if (!src) continue;
      for (let i = 0; i < 16; i++) p[slot * 16 + i] = R.u16(src.palettes + slot * 32 + 2 * i);
    }
    paletteCache.set(key, p);
    return p;
  }

  // Draw one metatile (by id) of a map's tilesets at pixel (px, py) of `under` / `over` (both `stride` px wide).
  function drawMetatile(primary, secondary, pal, id, under, over, stride, px, py) {
    const ref = metatileRef(primary, secondary, id);
    if (!ref) return;
    const mo = ref.set.metatiles + ref.index * TILES_PER_METATILE * 2;
    for (let layer = 0; layer < METATILE_LAYERS; layer++) {
      const dst = layer === TOP_LAYER ? over : under;
      for (let k = 0; k < 4; k++) {
        const e = R.u16(mo + (layer * 4 + k) * 2);
        const tile = e & 0x3ff, hf = e & 0x400, vf = e & 0x800, bank = e >> 12;
        let data, t;
        if (tile < TILES_IN_PRIMARY) { data = primary.tiles; t = tile; } else { if (!secondary) continue; data = secondary.tiles; t = tile - TILES_IN_PRIMARY; }
        const base = t * 32;
        if (base + 32 > data.length) continue;            // a tile the tileset does not have draws nothing
        const ox = px + (k & 1) * 8, oy = py + (k >> 1) * 8;
        for (let y = 0; y < 8; y++) {
          const sy = vf ? 7 - y : y;
          for (let x = 0; x < 8; x++) {
            const sx = hf ? 7 - x : x;
            const b = data[base + sy * 4 + (sx >> 1)];
            const idx = (sx & 1) ? b >> 4 : b & 15;
            if (!idx) continue;
            putColour(dst, ((oy + y) * stride + ox + x) * 4, pal[bank * 16 + idx]);
          }
        }
      }
    }
  }

  function blackOpaque(n) { const a = new Uint8Array(n * 4); for (let i = 0; i < n; i++) a[4 * i + 3] = 255; return a; }

  // Pictures are big (a 60x60 map is 7 MB), so the cache is bounded: the most recently used pictures up to
  // RENDER_CACHE_BYTES; a picture larger than the whole budget is drawn every time it is asked for.
  const renderCache = new Map();
  let renderCacheBytes = 0;
  /**
   * renderMap(map) -> { width, height, under, over }: RGBA, 16 px per cell.
   *   under  everything drawn BELOW the sprites (bottom + middle metatile layers) on the engine's black backdrop: opaque
   *   over   the top metatile layer, drawn ABOVE the sprites: transparent where it has nothing
   * Draw order for a frame: under, the sprites (sorted by y), over.
   */
  function renderMap(m) {
    const key = m.group + '.' + m.num;
    let r = renderCache.get(key);
    if (r) { renderCache.delete(key); renderCache.set(key, r); return r; }   // most recently used last
    const primary = tileset(m.tilesets.primary), secondary = tileset(m.tilesets.secondary), pal = mapPalette(m);
    const W = m.width * CELL, H = m.height * CELL;
    const under = blackOpaque(W * H), over = new Uint8Array(W * H * 4);
    for (let cy = 0; cy < m.height; cy++) {
      for (let cx = 0; cx < m.width; cx++) drawMetatile(primary, secondary, pal, m.metatiles[cy * m.width + cx], under, over, W, cx * CELL, cy * CELL);
    }
    r = { width: W, height: H, under, over };
    const bytes = under.length + over.length;
    if (bytes <= RENDER_CACHE_BYTES) {
      renderCache.set(key, r);
      renderCacheBytes += bytes;
      for (const [k, v] of renderCache) {
        if (renderCacheBytes <= RENDER_CACHE_BYTES) break;
        renderCache.delete(k);
        renderCacheBytes -= v.under.length + v.over.length;
      }
    }
    return r;
  }

  const borderCache = new Map();
  /**
   * renderBorder(map) -> { width: 32, height: 32, under, over }: the layout's 2x2 border block. The game fills
   * everything outside the map with it: the cell at map coordinates (x, y) (negative, or past the edge) shows the
   * quadrant (x & 1, y & 1), i.e. tile this picture with its top-left corner on an EVEN cell.
   */
  function renderBorder(m) {
    const key = m.group + '.' + m.num;
    let r = borderCache.get(key);
    if (r) return r;
    const primary = tileset(m.tilesets.primary), secondary = tileset(m.tilesets.secondary), pal = mapPalette(m);
    const W = 2 * CELL;
    const under = blackOpaque(W * W), over = new Uint8Array(W * W * 4);
    for (let i = 0; i < 4; i++) drawMetatile(primary, secondary, pal, m.border[i] & BLOCK_METATILE_MASK, under, over, W, (i & 1) * CELL, (i >> 1) * CELL);
    r = { width: W, height: W, under, over };
    borderCache.set(key, r);
    return r;
  }

  /**
   * renderView(map, x0, y0, width, height) -> { width, height, under, over }: any pixel rectangle of the map's
   * plane (x0 / y0 may be negative or reach past the map), with the border block wherever the map is not. This is
   * what the game shows on its 240x160 screen. Not cached.
   */
  function renderView(m, x0, y0, width, height) {
    if (![x0, y0, width, height].every(Number.isInteger) || width < 1 || height < 1 || width > 4096 || height > 4096) throw new WorldRomError('renderView: bad rectangle');
    const full = renderMap(m), bord = renderBorder(m);
    const under = new Uint8Array(width * height * 4), over = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
      const my = y0 + y;
      for (let x = 0; x < width; x++) {
        const mx = x0 + x;
        const d = (y * width + x) * 4;
        let src, s;
        if (mx >= 0 && my >= 0 && mx < full.width && my < full.height) { src = full; s = (my * full.width + mx) * 4; }
        else {
          const cx = Math.floor(mx / CELL), cy = Math.floor(my / CELL);
          const bx = mod2(cx) * CELL + (mx - cx * CELL), by = mod2(cy) * CELL + (my - cy * CELL);
          src = bord; s = (by * bord.width + bx) * 4;
        }
        under[d] = src.under[s]; under[d + 1] = src.under[s + 1]; under[d + 2] = src.under[s + 2]; under[d + 3] = src.under[s + 3];
        over[d] = src.over[s]; over[d + 1] = src.over[s + 1]; over[d + 2] = src.over[s + 2]; over[d + 3] = src.over[s + 3];
      }
    }
    return { width, height, under, over };
  }

  /* ---- overworld sprites ------------------------------------------------------------------------------- */
  const spritePalettes = new Map();   // tag -> ROM offset of 16 colours
  {
    for (let i = 0; i < O.owPaletteMax; i++) {
      const o = O.owPalettes + i * 8;
      const p = R.ptr(o);
      if (!p) break;
      const tag = R.u16(o + 4);
      if (!spritePalettes.has(tag)) spritePalettes.set(tag, p);
    }
    if (!spritePalettes.has(PAL_TAG_PLAYER) || NPC_PAL_TAGS.some((t) => !spritePalettes.has(t))) throw new WorldRomError('the overworld sprite palette table does not hold the player / NPC palettes');
  }
  function readPal(off) {
    const p = new Uint16Array(16);
    for (let i = 0; i < 16; i++) p[i] = R.u16(off + 2 * i);
    return p;
  }
  const palByTag = new Map();
  function paletteByTag(tag) {
    let p = palByTag.get(tag);
    if (p) return p;
    const off = spritePalettes.get(tag);
    if (off === undefined) return null;
    p = readPal(off);
    palByTag.set(tag, p);
    return p;
  }

  // graphics id -> ROM offset of its 36-byte info + where its colours come from
  function infoSource(id) {
    if (!Number.isInteger(id) || id < 0) throw new WorldRomError('no overworld graphics id ' + id);
    if (id & GFX.MON) {
      const species = id & GFX.MON_SPECIES_MASK;
      if (species < 1 || species > O.speciesMax) throw new WorldRomError('no follower sprite for species ' + species);
      const slot = O.speciesTable + species * O.speciesStride;
      let off = slot + O.speciesOw;
      if ((id & GFX.MON_FEMALE) && R.ptr(slot + O.speciesOwFemale + 28)) off = slot + O.speciesOwFemale;
      if (!R.ptr(off + 28)) throw new WorldRomError('species ' + species + ' has no follower sprite');
      const palOff = R.ptr(slot + ((id & GFX.MON_SHINY) ? O.speciesOwShinyPalette : O.speciesOwPalette)) || R.ptr(slot + O.speciesOwPalette);
      return { off, palOff, mon: true };
    }
    if (id >= O.owInfoCount) throw new WorldRomError('no overworld graphics id ' + id);
    return { off: R.need(O.owInfoPointers + 4 * id, 'graphics info'), palOff: 0, mon: false };
  }

  // Every anim table any sprite uses, so one table can be told from the next (they lie back to back in the ROM).
  let animStarts = null;
  function animTableStarts() {
    if (animStarts) return animStarts;
    animStarts = new Set();
    for (let id = 0; id < O.owInfoCount; id++) { const a = R.ptr(R.need(O.owInfoPointers + 4 * id, 'graphics info') + 24); if (a) animStarts.add(a); }
    for (let sp = 1; sp <= O.speciesMax; sp++) {
      const slot = O.speciesTable + sp * O.speciesStride;
      for (const d of [O.speciesOw, O.speciesOwFemale]) { const v = R.u32(slot + d + 24); if (R.isPtr(v)) animStarts.add(v - ROM_BASE); }
    }
    return animStarts;
  }

  // One AnimCmd list -> [{ frame, duration, hFlip, vFlip }] (the frame commands, in order, up to the end / jump).
  function animFrames(off) {
    const out = [];
    for (let k = 0; k < 64; k++) {
      const c = R.u32(off + 4 * k);
      const v = (c << 16) >> 16;
      if (v === -1 || v === -2) break;      // end, jump
      if (v === -3) continue;               // loop marker
      if (v < 0) break;
      out.push({ frame: v, duration: (c >>> 16) & 0x3f, hFlip: !!(c & 0x400000), vFlip: !!(c & 0x800000) });
    }
    return out;
  }
  const animCache = new Map();
  function animTable(off) {
    let t = animCache.get(off);
    if (t) return t;
    t = [];
    const starts = animTableStarts();
    for (let i = 0; i < 64; i++) {
      const at = off + 4 * i;
      if (i > 0 && starts.has(at)) break;
      const v = R.u32(at);
      if (!R.isPtr(v)) break;
      t.push(animFrames(v - ROM_BASE));
    }
    animCache.set(off, t);
    return t;
  }

  // How many frames a sprite's pictures really hold. The graphics info does not say; the anim lists can name more
  // frames than the pictures have (then the engine would show the NEXT sprite's art). The pictures of all sprites lie
  // back to back in the ROM, so a sheet ends where the next picture starts and an image table ends where the next
  // image table starts.
  let picStarts = null, imageTableStarts = null;
  function buildPicIndex() {
    imageTableStarts = [];
    const tables = new Set(), pics = new Set();
    const infos = [];
    for (let id = 0; id < O.owInfoCount; id++) infos.push(R.need(O.owInfoPointers + 4 * id, 'graphics info'));
    for (let sp = 1; sp <= O.speciesMax; sp++) {
      const slot = O.speciesTable + sp * O.speciesStride;
      for (const d of [O.speciesOw, O.speciesOwFemale]) if (R.isPtr(R.u32(slot + d + 28))) infos.push(slot + d);
    }
    for (const o of infos) { const t = R.ptr(o + 28); if (t) tables.add(t); }
    imageTableStarts = [...tables].sort((a, b) => a - b);
    for (const t of imageTableStarts) {
      if (R.u16(t + 6) & 1) { const d = R.ptr(t); if (d) pics.add(d); continue; }
      const n = imageTableLength(t);
      for (let i = 0; i < n; i++) pics.add(R.ptr(t + 8 * i));
    }
    picStarts = [...pics].sort((a, b) => a - b);
  }
  function nextAfter(sorted, v) {
    let lo = 0, hi = sorted.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] <= v) lo = mid + 1; else hi = mid; }
    return lo < sorted.length ? sorted[lo] : -1;
  }
  // entries of a one-entry-per-frame image table: up to the next table, and only while they point into the ROM
  function imageTableLength(t) {
    const next = nextAfter(imageTableStarts, t);
    const cap = next > 0 ? Math.min(64, (next - t) >> 3) : 64;
    let n = 0;
    while (n < cap && R.isPtr(R.u32(t + 8 * n))) n++;
    return n;
  }
  function availableFrames(imagesOff, relative, frameBytes) {
    if (!imagesOff) return 0;
    if (!picStarts) buildPicIndex();
    if (!relative) return imageTableLength(imagesOff);
    const data = R.ptr(imagesOff), size = R.u16(imagesOff + 4) || frameBytes;
    if (!data) return 0;
    const next = nextAfter(picStarts, data);
    return next > 0 ? Math.max(1, Math.floor((next - data) / size)) : 64;
  }

  const infoCache = new Map();
  function rawInfo(id) {
    let inf = infoCache.get(id);
    if (inf) return inf;
    const src = infoSource(id);
    const o = src.off;
    const width = R.s16(o + 8), height = R.s16(o + 10), bits = R.u8(o + 12);
    if (!(width >= 8 && width <= 128 && height >= 8 && height <= 128) || (width & 7) || (height & 7)) throw new WorldRomError('overworld graphics ' + id + ' has size ' + width + 'x' + height);
    const animsOff = R.ptr(o + 24), imagesOff = R.ptr(o + 28);
    const anims = animsOff ? animTable(animsOff) : [];
    let maxFrame = 0;
    for (const a of anims) for (const f of a) if (f.frame > maxFrame) maxFrame = f.frame;
    const relative = imagesOff ? (R.u16(imagesOff + 6) & 1) === 1 : false;
    inf = {
      id, offset: o, width, height, paletteTag: R.u16(o + 2), reflectionPaletteTag: R.u16(o + 4), size: R.u16(o + 6),
      paletteSlot: bits & 15, shadowSize: (bits >> 4) & 3, inanimate: !!((bits >> 6) & 1), compressed: !!(bits >> 7),
      tracks: R.u8(o + 13), animsOff, imagesOff, anims, relative,
      frameCount: Math.min(maxFrame + 1, availableFrames(imagesOff, relative, (width * height) >> 1)),
      palOff: src.palOff, mon: src.mon, sheet: null,
    };
    inf.walk = walkPlan(inf);
    inf.kind = kindOf(inf);
    infoCache.set(id, inf);
    return inf;
  }

  // From the sprite's own anim lists: for each direction the standing frame and the two walk frames.
  function walkPlan(inf) {
    const a = inf.anims;
    if (a.length < 8) return null;
    const plan = [];
    for (let d = 0; d < 4; d++) {
      const face = a[d], go = a[4 + d];
      if (!face.length || !go.length) return null;
      const stand = { frame: face[0].frame, flipX: face[0].hFlip };
      const steps = [];
      for (const f of go) {
        if (f.frame === stand.frame) continue;
        if (steps.some((s) => s.frame === f.frame)) continue;
        steps.push({ frame: f.frame, flipX: f.hFlip });
        if (steps.length === 2) break;
      }
      plan.push([stand, steps[0] || stand, steps[1] || stand]);
    }
    // an anim that names a frame the pictures do not have is not a walk this sprite can do
    if (plan.some((p) => p.some((s) => s.frame >= inf.frameCount))) return null;
    return plan;
  }

  function kindOf(inf) {
    if (inf.mon) return 'pokemon';
    if (inf.inanimate || !inf.walk) return 'object';
    const w = inf.walk;
    const full = w.every((p) => p[1].frame !== p[0].frame && p[2].frame !== p[0].frame && p[1].frame !== p[2].frame);
    const facesDiffer = w[SOUTH][0].frame !== w[NORTH][0].frame && w[SOUTH][0].frame !== w[WEST][0].frame && w[NORTH][0].frame !== w[WEST][0].frame;
    if (!full || !facesDiffer) return w.every((p) => p[1].frame !== p[0].frame) && facesDiffer ? 'pokemon' : 'object';
    // the player characters carry the running anims after the 20 standard ones
    if (inf.width === 16 && inf.height === 32 && inf.anims.length >= 24) return 'player';
    return 'walker';
  }

  function paletteOf(inf, paletteTag) {
    if (paletteTag !== undefined) {
      const p = paletteByTag(paletteTag);
      if (!p) throw new WorldRomError('no overworld sprite palette with tag 0x' + Number(paletteTag).toString(16));
      return p;
    }
    if (inf.palOff) return readPal(inf.palOff);
    const p = paletteByTag(inf.paletteTag);
    if (!p) throw new WorldRomError('overworld graphics ' + inf.id + ': no palette with tag 0x' + inf.paletteTag.toString(16));
    return p;
  }

  // ROM (or decompressed-sheet) location of one frame's tile data.
  function frameData(inf, f) {
    if (!inf.imagesOff) throw new WorldRomError('overworld graphics ' + inf.id + ' has no pictures');
    if (!(Number.isInteger(f) && f >= 0 && f < inf.frameCount)) throw new WorldRomError('overworld graphics ' + inf.id + ' has no frame ' + f);
    const bytes = (inf.width * inf.height) >> 1;
    if (inf.compressed) {
      if (!inf.sheet) {
        let r;
        try { r = decompressAny(rom, R.need(inf.imagesOff, 'sprite sheet')); } catch (e) { if (!(e instanceof GfxError)) throw e; r = null; }
        if (!r) throw new WorldRomError('overworld graphics ' + inf.id + ': the compressed sheet does not decode');
        inf.sheet = r.data;
      }
      if ((f + 1) * bytes > inf.sheet.length) throw new WorldRomError('overworld graphics ' + inf.id + ': frame ' + f + ' is past its sheet');
      return { buf: inf.sheet, off: f * bytes };
    }
    if (inf.relative) return { buf: rom, off: R.need(inf.imagesOff, 'sprite sheet') + f * R.u16(inf.imagesOff + 4) };
    return { buf: rom, off: R.need(inf.imagesOff + 8 * f, 'sprite frame') };
  }

  const frameCache = new Map();
  function frameRGBA(id, f, flipX, paletteTag) {
    const key = id + ':' + f + ':' + (flipX ? 1 : 0) + ':' + (paletteTag === undefined ? '' : paletteTag);
    let v = frameCache.get(key);
    if (v) return v;
    const inf = rawInfo(id);
    const d = frameData(inf, f);
    v = { width: inf.width, height: inf.height, rgba: spriteRGBA(d.buf, d.off, inf.width, inf.height, paletteOf(inf, paletteTag), !!flipX) };
    frameCache.set(key, v);
    return v;
  }

  // every one of the twelve walker pictures shows a figure (a sheet with empty walk frames is not a walker to offer)
  function walkerIsDrawn(inf) {
    for (const p of inf.walk) {
      for (const s of p) {
        const d = frameData(inf, s.frame);
        let ink = 0;
        for (let i = 0, n = (inf.width * inf.height) >> 1; i < n; i++) { const b = d.buf[d.off + i]; if (b & 15) ink++; if (b >> 4) ink++; }
        if (ink < 48) return false;
      }
    }
    return true;
  }

  function publicInfo(id) {
    const inf = rawInfo(id);
    return {
      id, width: inf.width, height: inf.height, frameCount: inf.frameCount, paletteTag: inf.paletteTag,
      paletteSlot: inf.paletteSlot, shadowSize: inf.shadowSize, inanimate: inf.inanimate, compressed: inf.compressed,
      tracks: inf.tracks, animCount: inf.anims.length, kind: inf.kind, walker: !!inf.walk,
    };
  }

  // the walk is drawn: in every direction both walk pictures differ from the standing one (eighteen people of this
  // ROM, the nurse among them, carry nine frames whose "walk" frames are copies of the standing ones)
  function walkIsAnimated(inf) {
    const same = (a, b) => {
      if (a.frame === b.frame) return true;
      const x = frameData(inf, a.frame), y = frameData(inf, b.frame), n = (inf.width * inf.height) >> 1;
      for (let i = 0; i < n; i++) if (x.buf[x.off + i] !== y.buf[y.off + i]) return false;
      return true;
    };
    return inf.walk.every((p) => !same(p[0], p[1]) && !same(p[0], p[2]));
  }

  let avatarList = null, standerList = null;
  function avatars() {
    if (avatarList) return avatarList;
    const cands = [];
    for (let id = 0; id < O.owInfoCount; id++) {
      let inf;
      try { inf = rawInfo(id); } catch (e) { if (e instanceof WorldRomError) continue; throw e; }
      if (inf.width !== 16 || inf.height !== 32 || (inf.kind !== 'player' && inf.kind !== 'walker')) continue;
      cands.push(inf);
    }
    // where each candidate's own first picture is: a walk frame that IS another sprite's first picture is borrowed
    const firstPic = new Map();
    for (const inf of cands) { const o = frameData(inf, 0).off; if (!firstPic.has(o)) firstPic.set(o, inf.id); }
    const borrows = (inf) => {
      const own = frameData(inf, 0).off;
      for (const p of inf.walk) for (const st of p) { const o = frameData(inf, st.frame).off; if (o !== own && firstPic.has(o)) return true; }
      return false;
    };
    const players = [], people = [], standers = [], seen = new Set();
    for (const inf of cands) {
      if (NOT_A_PERSON.has(inf.id)) continue;
      if (!walkerIsDrawn(inf)) continue;          // a sheet with empty walk frames
      if (borrows(inf)) continue;                 // a three-frame stander whose image table runs on into the next sprite
      // the same pictures listed again (the rival / link copies of the player characters, in the other one's colours) count once
      const key = frameData(inf, inf.walk[SOUTH][0].frame).off;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!walkIsAnimated(inf)) { standers.push(inf.id); continue; }   // four directions, but it would glide
      (inf.kind === 'player' ? players : people).push(inf.id);
    }
    avatarList = Object.freeze(players.concat(people));
    standerList = Object.freeze(standers);
    return avatarList;
  }

  const ow = {
    /** number of graphics ids in the ROM's table (follower Pokemon are reached as GFX.MON | species) */
    count: O.owInfoCount,
    /** info(id) -> { id, width, height, frameCount, paletteTag, paletteSlot, shadowSize, inanimate, compressed, tracks,
     *  animCount, kind: 'player' | 'walker' | 'pokemon' | 'object', walker } */
    info: publicInfo,
    /** frame(id, frameIndex, { paletteTag }?) -> { width, height, rgba } exactly as stored (not flipped) */
    frame(id, f, opts) { return frameRGBA(id, f, false, opts && opts.paletteTag); },
    /**
     * walker(id, dir, step, { paletteTag }?) -> { width, height, rgba, flipX, frame }
     *   dir   'down' | 'up' | 'left' | 'right'      step  0 standing, 1 and 2 the two walk frames
     * rgba is READY TO DRAW (already mirrored when the ROM's anim says so); flipX and frame say where it came from.
     * A walk cycle is step 1, 0, 2, 0 (8 game frames each in the ROM's walk anim).
     */
    walker(id, dir, step, opts) {
      const d = DIRS.indexOf(dir);
      if (d < 0) throw new WorldRomError('walker: no direction ' + dir);
      if (!(step === 0 || step === 1 || step === 2)) throw new WorldRomError('walker: no step ' + step);
      const inf = rawInfo(id);
      if (!inf.walk) throw new WorldRomError('overworld graphics ' + id + ' is not a walker');
      const p = inf.walk[d][step];
      const v = frameRGBA(id, p.frame, p.flipX, opts && opts.paletteTag);
      return { width: v.width, height: v.height, rgba: v.rgba, flipX: p.flipX, frame: p.frame };
    },
    /** the trainers / people a player can look like: the player characters first, then every NPC person, each once.
     *  16x32, four directions, three DIFFERENT pictures per direction (standing and two walk frames), all drawn. */
    get avatars() { return avatars(); },
    /** people with four directions whose walk frames are copies of the standing ones (the nurse, the cook, ...): fine
     *  for someone who stands still, not for a look that walks. walker() works on them. */
    get standers() { avatars(); return standerList; },
    /**
     * paletteTags(id) -> the sprite palette tags this sprite can be drawn in, its own first. A sprite drawn in one of
     * the four shared NPC palettes can be drawn in the other three (their first five colours, skin and outline, are
     * identical; only hair and clothes change); every other sprite has one palette. Pass a tag as { paletteTag } to
     * frame() / walker(). The GAME always draws a sprite in its own palette: a recolour is this site's use of ROM data.
     */
    paletteTags(id) {
      const own = rawInfo(id).paletteTag;
      return NPC_PAL_TAGS.includes(own) ? [own].concat(NPC_PAL_TAGS.filter((t) => t !== own)) : [own];
    },
    /** 16 BGR555 colours of a sprite palette tag, or null */
    palette(tag) { const p = paletteByTag(tag); return p ? p.slice() : null; },
    /** true when `id` names a sprite this ROM has (a table id, or a follower Pokemon that exists) */
    has(id) { try { rawInfo(id); return true; } catch (e) { if (e instanceof WorldRomError) return false; throw e; } },
  };

  /**
   * mapSprites(map) -> the map's object events resolved to pictures, in the order the game draws them (top to
   * bottom): [{ ...object, sprite: { width, height, rgba, flipX, frame } | null, px, py }]. (px, py) is the top-left
   * pixel of the sprite on the map picture: centred on its cell, feet on the cell's bottom edge. sprite is null for a
   * graphics id the ROM resolves at run time (a variable sprite).
   */
  function mapSprites(m) {
    const out = [];
    for (const o of m.events.objects) {
      let sprite = null;
      if (ow.has(o.gfx)) {
        const inf = rawInfo(o.gfx);
        if (inf.walk) sprite = ow.walker(o.gfx, o.facing, 0);
        else if (inf.frameCount) { const f = frameRGBA(o.gfx, 0, false); sprite = { width: f.width, height: f.height, rgba: f.rgba, flipX: false, frame: 0 }; }
      }
      const w = sprite ? sprite.width : CELL, h = sprite ? sprite.height : CELL;
      out.push({ ...o, sprite, px: o.x * CELL + ((CELL - w) >> 1), py: (o.y + 1) * CELL - h });
    }
    out.sort((a, b) => a.y - b.y || a.x - b.x || a.localId - b.localId);
    return out;
  }

  /* ---- emotes ------------------------------------------------------------------------------------------ */
  let emoteList = null;
  function emotes() {
    if (emoteList) return emoteList;
    const out = [];
    const template = (off) => ({ pal: paletteOrThrow(R.u16(off + 2)), anims: R.need(off + 8, 'emote anims'), images: R.need(off + 12, 'emote images') });
    const image = (t, i) => {
      const data = R.need(t.images + 8 * i, 'emote image');
      if (R.u16(t.images + 8 * i + 4) !== 0x80) throw new WorldRomError('emote image ' + i + ' is not 16x16');
      return spriteRGBA(rom, data, 16, 16, t.pal, false);
    };
    const add = (name, frames) => out.push({ id: out.length, name, width: 16, height: 16, rgba: frames[0], frames });
    const icons = template(O.emoteIconTemplate);
    ICON_NAMES.forEach((name, i) => add(name, [image(icons, i)]));
    const heart = template(O.emoteHeartTemplate);
    add('heart', [image(heart, 0)]);
    const fol = template(O.emoteFollowerTemplate);
    FOLLOWER_EMOTE_NAMES.forEach((name, i) => {
      const frames = [];
      for (const f of animFrames(R.need(fol.anims + 4 * i, 'emote anim'))) if (!frames.some((x) => x.index === f.frame)) frames.push({ index: f.frame, rgba: image(fol, f.frame) });
      if (!frames.length) throw new WorldRomError('follower emote ' + i + ' has no frames');
      add(name, frames.map((x) => x.rgba));
    });
    emoteList = Object.freeze(out);
    return emoteList;
  }
  function paletteOrThrow(tag) {
    const p = paletteByTag(tag);
    if (!p) throw new WorldRomError('no sprite palette with tag 0x' + tag.toString(16));
    return p;
  }

  /* ---- the Pokemon Center ------------------------------------------------------------------------------ */
  /**
   * centerInfo(map) -> the cells a room needs, read from the map itself:
   *   doors     [{ x, y, warpId, destGroup, destNum, behavior }]   the warp cells (the mat)
   *   counter   [{ x, y }]                                         MB.COUNTER cells
   *   nurse     the object event with GFX.NURSE, or null
   *   nurseTalk { x, y, facing: 'up' } | null    the walkable cell from which the nurse is addressed across the counter
   *   pc        [{ x, y }]    MB.PC cells          pcUse  [{ x, y, facing: 'up' }]  the walkable cells below them
   *   regionMap [{ x, y }]    MB.REGION_MAP cells
   *   solid     [{ x, y }]    impassable cells with walkable floor on both sides or above and below (tables, seats, pots)
   */
  function centerInfo(m) {
    const cells = (b) => { const out = []; for (let y = 0; y < m.height; y++) for (let x = 0; x < m.width; x++) if (m.behavior[y * m.width + x] === b) out.push({ x, y }); return out; };
    const doors = m.events.warps.map((w) => ({ x: w.x, y: w.y, warpId: w.warpId, destGroup: w.destGroup, destNum: w.destNum, behavior: m.behaviorAt(w.x, w.y) }));
    const counter = cells(MB.COUNTER), pc = cells(MB.PC);
    const nurse = m.events.objects.find((o) => o.gfx === GFX.NURSE) || null;
    let nurseTalk = null;
    if (nurse) {
      // walk down from the nurse: the counter cell(s), then the first walkable cell
      let y = nurse.y + 1, crossed = false;
      while (m.inside(nurse.x, y) && m.behaviorAt(nurse.x, y) === MB.COUNTER) { crossed = true; y++; }
      if (crossed && m.walkable(nurse.x, y)) nurseTalk = { x: nurse.x, y, facing: 'up' };
    }
    const solid = [];
    for (let y = 1; y < m.height - 1; y++) {
      for (let x = 1; x < m.width - 1; x++) {
        if (m.walkable(x, y) || m.behaviorAt(x, y) !== MB.NORMAL) continue;
        if ((m.walkable(x - 1, y) || m.walkable(x + 1, y)) && m.walkable(x, y + 1) + m.walkable(x, y - 1) + m.walkable(x - 1, y) + m.walkable(x + 1, y) >= 2 && !isWallRun(m, x, y)) solid.push({ x, y });
      }
    }
    return {
      doors, counter, nurse, nurseTalk, pc,
      pcUse: pc.filter((c) => m.walkable(c.x, c.y + 1)).map((c) => ({ x: c.x, y: c.y + 1, facing: 'up' })),
      regionMap: cells(MB.REGION_MAP), solid,
    };
  }
  // an impassable cell that belongs to the outer wall: it reaches the map's edge through impassable cells only
  function isWallRun(m, x, y) {
    const seen = new Set([y * m.width + x]), stack = [[x, y]];
    while (stack.length) {
      const [cx, cy] = stack.pop();
      if (cx === 0 || cy === 0 || cx === m.width - 1 || cy === m.height - 1) return true;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cx + dx, ny = cy + dy, k = ny * m.width + nx;
        if (!m.inside(nx, ny) || seen.has(k) || m.walkable(nx, ny)) continue;
        seen.add(k); stack.push([nx, ny]);
      }
    }
    return false;
  }

  let centerList = null;
  /**
   * centers -> every map that is a Pokemon Center (a nurse object, a PC cell and a counter), in map order:
   * [{ group, num, width, height, music, standard, sameAsCenter }]. standard: it uses the canonical Center's two
   * tilesets and is 15 or 16 cells by 10; sameAsCenter: its blocks are identical to the canonical Center's.
   */
  function centers() {
    if (centerList) return centerList;
    const c0 = map(CENTER.group, CENTER.num);
    const same = (m) => m.width === c0.width && m.height === c0.height && m.blocks.every((b, i) => b === c0.blocks[i]);
    const out = [];
    for (const e of maps()) {
      const h = header(e.group, e.num);
      if (!h.events) continue;
      // cheap pre-filter on the object list before decoding the whole map
      const nObj = R.u8(h.events), pObj = R.ptr(h.events + 4);
      let nurse = false;
      for (let i = 0; i < nObj && !nurse; i++) nurse = R.u16(pObj + i * O.objectTemplateSize + 1) === GFX.NURSE;
      if (!nurse) continue;
      const m = map(e.group, e.num);
      if (!m.behavior.includes(MB.PC) || !m.behavior.includes(MB.COUNTER)) continue;
      const standard = m.tilesets.primary === c0.tilesets.primary && m.tilesets.secondary === c0.tilesets.secondary && m.height === c0.height && (m.width === c0.width || m.width === c0.width - 1);
      out.push({ group: e.group, num: e.num, width: m.width, height: m.height, music: m.music, standard, sameAsCenter: same(m) });
    }
    centerList = Object.freeze(out);
    return centerList;
  }

  const world = {
    /** every map: [{ group, num, layoutId, width, height, music, objectCount, warpCount, mapType, regionSection }] */
    maps,
    /** map(group, num) -> the decoded map (see the header: blocks, metatiles, collision, elevation, behavior, attributes, border, events) */
    map,
    groupSizes: Object.freeze(groupSizes.slice()),
    renderMap, renderBorder, renderView, mapPalette, mapSprites,
    /** which quadrant (0..3 = x + 2y) of the border block the game shows at map cell (x, y) outside the map */
    borderQuadrant(x, y) { return mod2(x) + 2 * mod2(y); },
    /** facing ('down' | 'up' | 'left' | 'right') the ROM gives an object with this movementType */
    facing: facingOf,
    centerInfo,
    get center() { return map(CENTER.group, CENTER.num); },
    get centers() { return centers(); },
    ow,
    /** [{ id, name, width: 16, height: 16, rgba, frames: [rgba, ...] }]: "!" "?" "!!" "x", the heart, then the
     *  eleven follower emotes (two frames each; rgba is frames[0]) */
    get emotes() { return emotes(); },
    /** decoded tileset of a map: { tileCount, isSecondary, callback, ... } (for tools and tests) */
    tilesetOf(m, which) { return tileset(which === 'secondary' ? m.tilesets.secondary : m.tilesets.primary); },
  };

  // The tables must hold together before anything is handed out: a damaged or different build fails here.
  try {
    const c = map(CENTER.group, CENTER.num);
    if (!c.events.objects.some((o) => o.gfx === GFX.NURSE)) throw new WorldRomError('map ' + CENTER.group + '.' + CENTER.num + ' has no nurse: this is not the pinned ROM');
    if (!c.behavior.includes(MB.PC) || !c.behavior.includes(MB.COUNTER)) throw new WorldRomError('map ' + CENTER.group + '.' + CENTER.num + ' has no PC / counter: this is not the pinned ROM');
    const nurse = rawInfo(GFX.NURSE);
    if (nurse.width !== 16 || nurse.height !== 32 || !nurse.walk) throw new WorldRomError('graphics id ' + GFX.NURSE + ' is not a 16x32 walker: this is not the pinned ROM');
  } catch (e) {
    if (e instanceof WorldRomError) throw e;
    throw new WorldRomError('the world tables do not hold together: ' + (e && e.message));
  }
  return world;
}

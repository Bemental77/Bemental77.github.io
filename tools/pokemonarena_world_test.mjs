// tools/pokemonarena_world_test.mjs - Node test for pokemonarena/js/world_rom.js (the ROM's overworld: maps, map
// pictures, the Pokemon Center, overworld sprites, emote icons).
//
//   node tools/pokemonarena_world_test.mjs              # every check + the source mutants; exit 1 on any failure
//   node tools/pokemonarena_world_test.mjs --fast       # skip the source mutants and the all-maps render
//   node tools/pokemonarena_world_test.mjs --update     # rewrite pokemonarena/world.golden.json (HASHES ONLY)
//   node tools/pokemonarena_world_test.mjs --sheets     # also write the contact sheets (PNG) to WORLD_OUT
//   ARENA_ROM=/path/to.gba  WORLD_OUT=/path/to/pngdir   (overrides; WORLD_OUT is never inside the repository)
//
// What it proves (and what would make it fail):
//   W0  the ROM is the pinned image; loadWorld refuses a wrong length, a wrong header, a zero-filled ROM, and a ROM of
//       the right identity whose map tables are damaged (WorldRomError, never a crash or a half-built world);
//   W1  structure: 617 maps in 27 groups, every map decodes, every warp leads somewhere, every object event sits inside
//       its map and resolves to a sprite, the facing table reads up / down / left / right;
//   W2  the block split the hack uses (11-bit metatile id, 1 collision bit): trainers and warps stand on walkable cells;
//   W3  THE POKEMON CENTER: map 2.0, its size, its one PC cell, its counter, its wall map, its door mat warp, the nurse
//       and where she is addressed from, the 23 standard Centers;
//   W4  pictures: sizes, an opaque under layer, a sparse over layer, no tile drawn from a blank palette slot, the border
//       block and renderView agree with renderMap, two worlds built from the same bytes agree (determinism);
//   W5  sprites: 330 ids, the avatars (count, order, 4 directions x 3 steps, drawn, right = left mirrored, built from
//       the sprite's own anim lists), follower Pokemon, the Center's NPCs resolved and placed;
//   W6  the golden hashes (pokemonarena/world.golden.json: SHA-1 of width, height and RGBA; no pixels are stored);
//   W7  emotes: sixteen 16x16 pictures, all different, in the documented order;
//   W8  world_rom.js is browser-portable and holds no ROM-derived data;
//   MUTANTS: a copy of pokemonarena/js with ONE defect at a time (the Emerald block split, the Emerald tile / palette
//       split, a two-layer metatile, the wrong layer above the sprites, a swapped flip bit, an 8-bit graphics id, ...);
//       each must fail the check it names.
// A decoder that passes its own hashes on wrong pictures is a failure: the contact sheets are the real proof, and
// they were looked at before the golden was written (see pokemonarena/README.md).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writePNG, scaleRGBA, newCanvas, blit, fillRect } from './arena_png.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const args = process.argv.slice(2);
const UPDATE = args.includes('--update') || process.env.ARENA_UPDATE_GOLDEN === '1';
const SHEETS = args.includes('--sheets');
const FAST = args.includes('--fast');
const ROM_PATH = process.env.ARENA_ROM || path.join(root, 'gba', 'gbaWasm', 'roms', 'Pokemon SoulGold (v1.1.1).gba');
const OUT = process.env.WORLD_OUT || 'C:/Users/Admin/AppData/Local/Temp/claude/00bb488e02117e04/2fbb0172-3991-4171-8c09-77559e11ae9e/scratchpad/inapp/world';
const GOLDEN = path.join(root, 'pokemonarena', 'world.golden.json');
const JS_DIR = path.join(root, 'pokemonarena', 'js');

const romBuf = fs.readFileSync(ROM_PATH);
const rom = new Uint8Array(romBuf.buffer, romBuf.byteOffset, romBuf.length);
const sha1 = (...parts) => { const h = crypto.createHash('sha1'); for (const p of parts) h.update(p); return h.digest('hex'); };
const i32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const picHash = (p) => sha1(i32(p.width), i32(p.height), p.rgba);
const layersHash = (r) => sha1(i32(r.width), i32(r.height), r.under, r.over);
const J = JSON.stringify;

// The maps whose pictures are pinned one by one (the Center, the other Center shape, a town, a route, a cave-like
// map, houses, the biggest Center); every other map is in the all-maps aggregate.
const SAMPLE_MAPS = ['2.0', '12.0', '21.0', '23.28', '0.1', '0.0', '1.1', '22.0', '24.0', '24.25', '22.54', '5.3'];
// Follower Pokemon pinned one by one (species ids): the Chansey every Center has, and a few others.
const SAMPLE_MONS = [113, 25, 1, 6, 150, 249];

let goldenCache = null;
function readGolden() { if (!goldenCache) goldenCache = JSON.parse(fs.readFileSync(GOLDEN, 'utf8')); return goldenCache; }

/* ================================================================================================ the checks */
// Runs every named check against the world_rom.js found in `dir`. Returns { failed: [names], made: golden-shaped
// object, world, W }. `full` adds the all-maps render aggregate (slow); mutants run without it.
async function runChecks(dir, { full, quiet }) {
  const failed = [];
  let pass = 0;
  const ok = (cond, name, detail) => { if (cond) pass++; else { failed.push(name); if (!quiet) console.log('FAIL', name, detail === undefined ? '' : detail); } };
  const W = await import(pathToFileURL(path.join(dir, 'world_rom.js')).href + '?t=' + Math.random());
  const R = await import(pathToFileURL(path.join(dir, 'rom.js')).href);
  const made = { maps: {}, avatars: {}, emotes: {}, followers: {} };
  const refuses = (bytes, name) => { try { W.loadWorld(bytes); ok(false, name, 'did not throw'); } catch (e) { ok(e instanceof W.WorldRomError, name, e.name + ': ' + e.message); } };

  /* ---- W0 identity ------------------------------------------------------------------------------------ */
  ok(crypto.createHash('sha256').update(rom).digest('hex') === R.PINNED.sha256, 'W0a the ROM on disk is the pinned SoulGold v1.1.1 (sha256)');
  let world;
  try { world = W.loadWorld(rom); } catch (e) { ok(false, 'W0b loadWorld accepts the pinned ROM', e.name + ': ' + e.message); return { failed, pass, made, world: null, W }; }
  ok(!!world, 'W0b loadWorld accepts the pinned ROM');
  refuses(rom.subarray(0, rom.length - 1), 'W0c a ROM of the wrong length is refused');
  { const bad = rom.slice(); bad[0xa0] = 0x58; refuses(bad, 'W0d a ROM with a different title is refused'); }
  { const bad = rom.slice(); bad[0xac] = 0x41; refuses(bad, 'W0d a ROM with a different game code is refused'); }
  refuses(new Uint8Array(rom.length), 'W0e a zero-filled ROM of the right length is refused');
  try { W.loadWorld([1, 2, 3]); ok(false, 'W0f a non-Uint8Array is refused'); } catch (e) { ok(e instanceof W.WorldRomError, 'W0f a non-Uint8Array is refused', e.message); }
  { // right identity, damaged tables: each must be a WorldRomError, never a TypeError / RangeError / a half-built world
    const O = W.WORLD_OFFSETS;
    const a = rom.slice(); a.fill(0, O.mapGroups, O.mapGroups + 8); refuses(a, 'W0g a ROM whose map group table is damaged is refused');
    const b = rom.slice(); b.fill(0xff, O.mapLayouts + 4 * 300, O.mapLayouts + 4 * 700); refuses(b, 'W0g a ROM whose layout table is damaged is refused');
    const c = rom.slice(); c.fill(0, O.owInfoPointers, O.owInfoPointers + 4 * 80); refuses(c, 'W0g a ROM whose sprite table is damaged is refused');
    const d = rom.slice(); d.fill(0, O.owPalettes, O.owPalettes + 64); refuses(d, 'W0g a ROM whose sprite palette table is damaged is refused');
  }

  /* ---- W1 structure ------------------------------------------------------------------------------------ */
  const list = world.maps();
  ok(list.length === 617 && world.groupSizes.length === 27 && world.groupSizes.reduce((x, y) => x + y, 0) === 617, 'W1a 617 maps in 27 groups', list.length + ' maps');
  let decodeBad = 0, cells = 0, warps = 0, warpsOk = 0, objs = 0, objsInside = 0, objsOnFloor = 0, objsResolved = 0, warpsOnFloor = 0, dimBad = 0, maxId = 0;
  const exists = new Set(list.map((m) => m.group + '.' + m.num));
  const allMaps = [];
  for (const e of list) {
    let m;
    try { m = world.map(e.group, e.num); } catch (err) { decodeBad++; if (!quiet) console.log('decode fail', e.group + '.' + e.num, err.message); continue; }
    allMaps.push(m);
    const n = m.width * m.height; cells += n;
    if (m.width !== e.width || m.height !== e.height || m.blocks.length !== n || m.metatiles.length !== n || m.collision.length !== n || m.elevation.length !== n || m.behavior.length !== n || m.border.length !== 4) dimBad++;
    if (m.events.objects.length !== e.objectCount || m.events.warps.length !== e.warpCount) dimBad++;
    for (let i = 0; i < n; i++) if (m.metatiles[i] > maxId) maxId = m.metatiles[i];
    for (const w of m.events.warps) { warps++; if (exists.has(w.destGroup + '.' + w.destNum)) warpsOk++; if (m.walkable(w.x, w.y)) warpsOnFloor++; }
    for (const o of m.events.objects) { objs++; if (m.inside(o.x, o.y)) objsInside++; if (m.walkable(o.x, o.y)) objsOnFloor++; if (world.ow.has(o.gfx)) objsResolved++; }
  }
  ok(decodeBad === 0, 'W1b every map decodes', decodeBad + ' failed');
  ok(dimBad === 0, 'W1c every map has width x height blocks, a 2x2 border and the event counts its header names', dimBad + ' wrong');
  ok(maxId === 1459, 'W1c the largest metatile id any map uses is 1459 (an 11-bit id)', String(maxId));
  ok(warps === 1626 && warpsOk / warps > 0.97, 'W1d 1626 warps, and more than 97% lead to a map that exists (the rest are the engine\'s dynamic warps)', warpsOk + '/' + warps);
  ok(objs === 4153 && objsInside / objs > 0.98, 'W1e 4153 object events, more than 98% inside their own map (a few are parked off the edge)', objsInside + '/' + objs);
  ok(objsResolved / objs > 0.95, 'W1f more than 95% of the object events resolve to a sprite (the rest are run-time variable ids)', objsResolved + '/' + objs);
  ok([7, 8, 9, 10].map((t) => world.facing(t)).join() === 'up,down,left,right' && world.facing(0) === 'down' && world.facing(200) === 'down', 'W1h the facing table: movement types 7 / 8 / 9 / 10 face up / down / left / right', [7, 8, 9, 10].map((t) => world.facing(t)).join());
  made.counts = { maps: list.length, cells, warps, objects: objs };

  /* ---- W2 the block split ------------------------------------------------------------------------------ */
  ok(objsOnFloor / objs > 0.75 && objsOnFloor / objs < 0.95, 'W2a between 75% and 95% of the object events stand on a walkable cell (the rest are behind counters, signs, item balls in walls): the collision bit is bit 11', objsOnFloor + '/' + objs);
  ok(warpsOnFloor / warps > 0.35, 'W2b warps sit on cells a trainer can enter or are doors in a wall (more than 35% on walkable cells)', warpsOnFloor + '/' + warps);

  /* ---- W3 the Pokemon Center --------------------------------------------------------------------------- */
  const c = world.center, ci = world.centerInfo(c);
  ok(c.group === 2 && c.num === 0 && c.width === 16 && c.height === 10, 'W3a the Center is map 2.0, 16 x 10 cells', c.group + '.' + c.num + ' ' + c.width + 'x' + c.height);
  ok(ci.pc.length === 1 && ci.pc[0].x === 11 && ci.pc[0].y === 1 && J(ci.pcUse) === J([{ x: 11, y: 2, facing: 'up' }]), 'W3b one PC cell at (11,1), used from (11,2) facing up', J(ci.pc) + ' ' + J(ci.pcUse));
  ok(J(ci.counter) === J([{ x: 0, y: 2 }, { x: 5, y: 3 }, { x: 6, y: 3 }, { x: 7, y: 3 }, { x: 8, y: 3 }, { x: 9, y: 3 }]), 'W3c the counter cells are (5..9,3) (and the wall piece (0,2))', J(ci.counter));
  ok(J(ci.regionMap) === J([{ x: 12, y: 1 }, { x: 13, y: 1 }]), 'W3c the wall map is (12,1) and (13,1)', J(ci.regionMap));
  ok(ci.doors.length === 1 && ci.doors[0].x === 7 && ci.doors[0].y === 8 && ci.doors[0].behavior === W.MB.SOUTH_ARROW_WARP && ci.doors[0].destGroup === 0 && ci.doors[0].destNum === 1 && c.walkable(7, 8),
    'W3d one warp, on the door mat (7,8) (a south arrow warp, walkable), leading to map 0.1', J(ci.doors));
  ok(!!ci.nurse && ci.nurse.x === 7 && ci.nurse.y === 2 && ci.nurse.facing === 'down' && J(ci.nurseTalk) === J({ x: 7, y: 4, facing: 'up' }), 'W3e the nurse stands at (7,2) facing down and is addressed from (7,4) across the counter', J(ci.nurseTalk));
  ok(J(ci.solid) === J([{ x: 11, y: 6 }, { x: 12, y: 6 }, { x: 11, y: 7 }, { x: 12, y: 7 }]), 'W3f the table is the four solid cells (11..12, 6..7)', J(ci.solid));
  { let walk = 0, col15 = 0; for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) { if (c.walkable(x, y)) walk++; if (x === 15 && !c.walkable(x, y)) col15++; }
    ok(walk === 87 && col15 === 10, 'W3g 87 walkable cells; column 15 is solid filler (the room is 15 x 10 = 240 x 160 px)', walk + ' / ' + col15);
    ok(c.walkable(7, 4) && c.elevation[4 * 16 + 7] === 3 && !c.walkable(7, 3) && !c.walkable(0, 0), 'W3g the floor is elevation 3, the counter and the wall are solid'); }
  const cs = world.centers, std = cs.filter((x) => x.standard);
  ok(std.length === 23 && std.filter((x) => x.width === 16).length === 13 && std.filter((x) => x.width === 15).length === 10, 'W3h 23 standard Centers: thirteen 16 x 10 and ten 15 x 10', std.length + ' / ' + cs.length);
  ok(cs.length >= 23 && cs.every((x) => x.group !== undefined) && cs.some((x) => x.group === 2 && x.num === 0 && x.sameAsCenter), 'W3h the Center is in world.centers', String(cs.length));
  ok(c.tilesets.animated === false, 'W3i neither tileset of the Center has a tile-animation callback');
  made.center = { centers: cs.map((x) => x.group + '.' + x.num + (x.standard ? '' : '*')).join(' '), sameAsCenter: cs.filter((x) => x.sameAsCenter).length };

  /* ---- W4 pictures ------------------------------------------------------------------------------------- */
  const pic = world.renderMap(c);
  { let opaque = 0, overOn = 0; const n = pic.width * pic.height; for (let i = 0; i < n; i++) { if (pic.under[4 * i + 3] === 255) opaque++; if (pic.over[4 * i + 3]) overOn++; }
    ok(pic.width === 256 && pic.height === 160 && pic.under.length === n * 4 && pic.over.length === n * 4, 'W4a the Center picture is 256 x 160');
    ok(opaque === n, 'W4a the under layer is opaque everywhere', opaque + '/' + n);
    ok(overOn > n * 0.02 && overOn < n * 0.25, 'W4a the over layer is sparse (between 2% and 25% of the picture)', (100 * overOn / n).toFixed(1) + '%');
    // the plain floor: walkable cells with nothing above them must be the large majority (the layer above the sprites is the TOP one)
    let clear = 0, walk = 0;
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) { if (!c.walkable(x, y)) continue; walk++; let any = false; for (let py = 0; py < 16 && !any; py++) for (let px = 0; px < 16; px++) if (pic.over[((y * 16 + py) * pic.width + x * 16 + px) * 4 + 3]) { any = true; break; } if (!any) clear++; }
    ok(clear / walk > 0.85, 'W4b more than 85% of the walkable cells have nothing drawn above the sprites', clear + '/' + walk); }
  { // no tile of the pinned maps (the Center, a town, a route, houses, ...) is drawn from a blank palette slot (the
    // 7 + 6 palette split), and every tile they draw exists in its tileset (the 640 + 384 tile split)
    const dv = new DataView(rom.buffer, rom.byteOffset, rom.length);
    let bad = 0, refs = 0, missing = 0; const where = [];
    for (const key of SAMPLE_MAPS) {
      const [g, n] = key.split('.').map(Number); const m = world.map(g, n);
      const pal = world.mapPalette(m); const blank = new Set();
      for (let s = 0; s < 13; s++) { let nz = 0; for (let i = 1; i < 16; i++) if (pal[s * 16 + i]) nz++; if (nz < 2) blank.add(s); }
      const P = world.tilesetOf(m, 'primary'), S = world.tilesetOf(m, 'secondary');
      let b0 = bad, m0 = missing;
      for (const id of new Set(m.metatiles)) {
        const set = id < W.METATILES_IN_PRIMARY ? P : S, idx = id < W.METATILES_IN_PRIMARY ? id : id - W.METATILES_IN_PRIMARY;
        if (!set) continue;
        for (let k = 0; k < W.TILES_PER_METATILE; k++) {
          const e = dv.getUint16(set.metatiles + idx * W.TILES_PER_METATILE * 2 + 2 * k, true); const tile = e & 0x3ff;
          if (!tile) continue; refs++;
          if (blank.has(e >> 12) || (e >> 12) >= 13) bad++;
          if (tile < W.TILES_IN_PRIMARY ? tile >= P.tileCount : (!S || tile - W.TILES_IN_PRIMARY >= S.tileCount)) missing++;
        }
      }
      if (bad !== b0 || missing !== m0) where.push(key + ':' + (bad - b0) + '/' + (missing - m0));
    }
    ok(bad === 0 && refs > 5000, 'W4c no tile of the pinned maps is drawn from a blank palette slot (slots 0-6 primary, 7-12 secondary)', bad + ' of ' + refs + ' ' + where.join(' '));
    ok(missing === 0, 'W4d every tile the pinned maps draw exists in its tileset (640 primary tiles, then the secondary)', missing + ' missing ' + where.join(' '));
    const P = world.tilesetOf(c, 'primary'), S = world.tilesetOf(c, 'secondary');
    ok(P.tileCount === 640 && S.tileCount <= 384 && !P.isSecondary && S.isSecondary, 'W4d the Center primary has 640 tiles, its secondary no more than 384', P.tileCount + ' / ' + S.tileCount); }
  { const b = world.renderBorder(c);
    ok(b.width === 32 && b.height === 32 && b.under.length === 32 * 32 * 4, 'W4e the border block picture is 32 x 32');
    const v = world.renderView(c, -24, -40, 320, 240);
    let inBad = 0, outBad = 0;
    for (let y = 0; y < 240; y++) for (let x = 0; x < 320; x++) {
      const mx = x - 24, my = y - 40, d = (y * 320 + x) * 4;
      if (mx >= 0 && my >= 0 && mx < pic.width && my < pic.height) { const s = (my * pic.width + mx) * 4; for (let k = 0; k < 4; k++) if (v.under[d + k] !== pic.under[s + k] || v.over[d + k] !== pic.over[s + k]) { inBad++; break; } }
      else { const bx = ((mx % 32) + 32) % 32, by = ((my % 32) + 32) % 32, s = (by * 32 + bx) * 4; for (let k = 0; k < 4; k++) if (v.under[d + k] !== b.under[s + k] || v.over[d + k] !== b.over[s + k]) { outBad++; break; } }
    }
    ok(inBad === 0, 'W4f renderView shows the map itself where the map is', inBad + ' px differ');
    ok(outBad === 0, 'W4f renderView fills everything outside the Center with its border block', outBad + ' px differ');
    // a map whose border has four different blocks: the quadrant the game shows at cell (x, y) is (x & 1, y & 1)
    const t = world.map(0, 0), tb = world.renderBorder(t), tp = world.renderMap(t), tv = world.renderView(t, -48, -32, 96, 80);
    let q = 0;
    for (let y = 0; y < 80; y++) for (let x = 0; x < 96; x++) {
      const mx = x - 48, my = y - 32, d = (y * 96 + x) * 4;
      let src, s2;
      if (mx >= 0 && my >= 0) { src = tp; s2 = (my * tp.width + mx) * 4; } else { src = tb; s2 = ((((my % 32) + 32) % 32) * 32 + ((mx % 32) + 32) % 32) * 4; }
      for (let k = 0; k < 4; k++) if (tv.under[d + k] !== src.under[s2 + k] || tv.over[d + k] !== src.over[s2 + k]) { q++; break; }
    }
    const quad = [0, 1, 2, 3].map((i) => { const h = crypto.createHash('sha1'); for (let py = 0; py < 16; py++) { const o = (((i >> 1) * 16 + py) * 32 + (i & 1) * 16) * 4; h.update(tb.under.subarray(o, o + 64)); h.update(tb.over.subarray(o, o + 64)); } return h.digest('hex'); });
    ok(new Set(t.border).size === 4 && new Set(quad).size === 4, 'W4g map 0.0 has a border of four different blocks (four different pictures)', Array.from(t.border).join(','));
    ok(q === 0, 'W4g outside a map the game shows the border block tiled by cell parity: quadrant (x & 1, y & 1)', q + ' px differ');
    ok(world.borderQuadrant(-1, -1) === 3 && world.borderQuadrant(16, 0) === 0 && world.borderQuadrant(17, 3) === 3, 'W4g borderQuadrant');
    made.border = layersHash(b); made.view = layersHash(v); }
  for (const k of SAMPLE_MAPS) { const [g, n] = k.split('.').map(Number); made.maps[k] = layersHash(world.renderMap(world.map(g, n))); }
  { const w2 = W.loadWorld(rom.slice()); const p2 = w2.renderMap(w2.center);
    ok(layersHash(p2) === made.maps['2.0'] && picHash(w2.ow.walker(0, 'left', 1)) === picHash(world.ow.walker(0, 'left', 1)) && picHash(w2.emotes[4]) === picHash(world.emotes[4]), 'W4h determinism: a second world built from a copy of the bytes draws the same pictures');
    const again = world.renderMap(c);
    ok(world.renderMap(c) === again && world.map(2, 0) === c && layersHash(again) === made.maps['2.0'], 'W4h maps and pictures are cached (the same object comes back, and a picture drawn again is the same picture)'); }
  if (full) {
    const h = crypto.createHash('sha1'); let n = 0, bad = 0;
    for (const m of allMaps) { try { const r = world.renderMap(m); h.update(i32(r.width)); h.update(i32(r.height)); h.update(r.under); h.update(r.over); n++; } catch (err) { bad++; if (!quiet) console.log('render fail', m.group + '.' + m.num, err.message); } }
    ok(bad === 0 && n === 617, 'W4i every one of the 617 maps renders', bad + ' failed');
    made.allMaps = h.digest('hex');
  }

  /* ---- W5 sprites -------------------------------------------------------------------------------------- */
  const ow = world.ow;
  { const kinds = {}; let bad = 0;
    for (let id = 0; id < ow.count; id++) { try { const inf = ow.info(id); kinds[inf.kind] = (kinds[inf.kind] || 0) + 1; if (inf.frameCount) ow.frame(id, 0); } catch (err) { if (!(err instanceof W.WorldRomError)) bad++; kinds.none = (kinds.none || 0) + 1; } }
    ok(ow.count === 330 && bad === 0, 'W5a 330 graphics ids; every one decodes or is refused with a WorldRomError', J(kinds));
    made.kinds = kinds; }
  const av = ow.avatars;
  ok(av.length === 137 && new Set(av).size === av.length, 'W5b 137 avatars, each once', String(av.length));
  ok(ow.standers.length === 18 && ow.standers.includes(W.GFX.NURSE) && ow.standers.every((id) => !av.includes(id) && ow.info(id).walker), 'W5b 18 standers (four directions, walk frames that are copies of the standing ones); the nurse is one', ow.standers.join(','));
  ok(av[0] === 0 && av[1] === 89 && ow.info(av[0]).kind === 'player' && ow.info(av[1]).kind === 'player' && av.slice(2).every((id) => ow.info(id).kind === 'walker') && av.slice(2).every((id, i, a) => i === 0 || id > a[i - 1]),
    'W5c the two player characters come first (ids 0 and 89), then the people in table order', av.slice(0, 6).join(','));
  { let sizeBad = 0, blank = 0, mirrorBad = 0, sameDir = 0, sameStep = 0, borrowed = 0;
    const firstPic = new Map(); for (const id of av) firstPic.set(picHash(ow.frame(id, 0)), id);
    for (const id of av) {
      const f = {}; for (const d of W.DIRS) f[d] = [0, 1, 2].map((s) => ow.walker(id, d, s));
      for (const d of W.DIRS) for (const s of f[d]) { if (s.width !== 16 || s.height !== 32 || s.rgba.length !== 16 * 32 * 4) sizeBad++; let ink = 0; for (let i = 3; i < s.rgba.length; i += 4) if (s.rgba[i]) ink++; if (ink < 48) blank++; }
      for (let s = 0; s < 3; s++) { const l = f.left[s].rgba, r = f.right[s].rgba; let same = true; for (let y = 0; y < 32 && same; y++) for (let x = 0; x < 16; x++) { const a = (y * 16 + x) * 4, b = (y * 16 + 15 - x) * 4; if (l[a] !== r[b] || l[a + 1] !== r[b + 1] || l[a + 2] !== r[b + 2] || l[a + 3] !== r[b + 3]) { same = false; break; } } if (!same) mirrorBad++; }
      const h = (p) => picHash(p);
      if (h(f.down[0]) === h(f.up[0]) || h(f.down[0]) === h(f.left[0]) || h(f.up[0]) === h(f.left[0]) || h(f.left[0]) === h(f.right[0])) sameDir++;
      for (const d of W.DIRS) if (h(f[d][1]) === h(f[d][0]) || h(f[d][2]) === h(f[d][0]) || h(f[d][1]) === h(f[d][2])) sameStep++;
      for (const d of W.DIRS) for (const s of f[d]) { const o = firstPic.get(h(s)); if (o !== undefined && o !== id) borrowed++; }
      made.avatars[id] = sha1(...W.DIRS.flatMap((d) => f[d].map((s) => s.rgba)));
    }
    ok(sizeBad === 0, 'W5d every avatar has 4 directions x 3 steps of 16 x 32', sizeBad + ' wrong');
    ok(blank === 0, 'W5d no avatar picture is blank', blank + ' blank');
    ok(mirrorBad === 0, 'W5e facing right is facing left mirrored, pixel for pixel', mirrorBad + ' differ');
    ok(sameDir === 0, 'W5f down, up, left and right are four different pictures', sameDir + ' avatars');
    ok(sameStep === 0, 'W5g standing and the two walk frames are three different pictures in every direction', sameStep + ' cases');
    ok(borrowed === 0, 'W5h no avatar walks in another avatar\'s pictures', borrowed + ' frames');
    made.avatarsAll = sha1(...av.map((id) => Buffer.from(made.avatars[id], 'hex'))); }
  { // the walk comes from the sprite's own anim lists: on the standard table that is 0 / 1 / 2 standing, 3,4 / 5,6 / 7,8 walking
    const fr = (id, d) => [0, 1, 2].map((s) => { const w = ow.walker(id, d, s); return w.frame + (w.flipX ? 'h' : ''); }).join();
    ok(fr(58, 'down') === '0,3,4' && fr(58, 'up') === '1,5,6' && fr(58, 'left') === '2,7,8' && fr(58, 'right') === '2h,7h,8h', 'W5i the nurse walks on frames 0,3,4 / 1,5,6 / 2,7,8 / the same mirrored (read from her anim lists)', [fr(58, 'down'), fr(58, 'up'), fr(58, 'left'), fr(58, 'right')].join(' | '));
    ok(ow.info(0).frameCount === 18 && ow.info(0).animCount === 24 && ow.info(58).frameCount === 10, 'W5i the player has 18 frames and 24 anims (running), the nurse 10 frames', ow.info(0).frameCount + ' ' + ow.info(0).animCount + ' ' + ow.info(58).frameCount);
    let threw = 0; for (const fn of [() => ow.walker(0, 'north', 0), () => ow.walker(0, 'down', 3), () => ow.frame(0, 99), () => ow.info(-1), () => ow.info(330), () => ow.info(W.GFX.MON)]) { try { fn(); } catch (e) { if (e instanceof W.WorldRomError) threw++; } }
    ok(threw === 6, 'W5i a wrong direction, step, frame or id is refused with a WorldRomError', threw + '/6'); }
  { // follower Pokemon
    let good = 0;
    for (const sp of SAMPLE_MONS) {
      const id = W.GFX.MON | sp;
      try { const inf = ow.info(id); const f = W.DIRS.flatMap((d) => [0, 1, 2].map((s) => ow.walker(id, d, s)));
        if (inf.kind === 'pokemon' && (inf.width === 32 || inf.width === 64) && f.every((x) => x.rgba.some((v, i) => (i & 3) === 3 && v))) good++;
        made.followers[sp] = sha1(...f.map((x) => x.rgba)); } catch (e) { if (!quiet) console.log('follower', sp, e.message); }
    }
    ok(good === SAMPLE_MONS.length, 'W5j follower Pokemon (graphics id 0x4000 | species) resolve, are drawn in their own colours and walk', good + '/' + SAMPLE_MONS.length);
    let shiny = false; try { shiny = picHash(ow.frame(W.GFX.MON | W.GFX.MON_SHINY | 25, 0)) !== picHash(ow.frame(W.GFX.MON | 25, 0)); } catch (e) { /* counted below */ }
    ok(shiny, 'W5j the shiny bit changes a follower\'s colours'); }
  try { const sp = world.mapSprites(c);
    const nurse = sp.find((s) => s.gfx === W.GFX.NURSE), ch = sp.find((s) => s.gfx === (W.GFX.MON | 113));
    ok(sp.length === 5 && sp.every((s) => s.sprite) && !!nurse && nurse.px === 112 && nurse.py === 16 && nurse.sprite.width === 16 && nurse.sprite.height === 32, 'W5k the Center has five NPCs, all resolved; the nurse is drawn at (112,16)', sp.map((s) => s.gfx + '@' + s.px + ',' + s.py).join(' '));
    ok(!!ch && ch.sprite.width === 32 && ch.sprite.height === 32 && ch.px === 120 && ch.py === 16 && ch.x === 8 && ch.y === 2, 'W5l the Chansey beside the nurse is a 32 x 32 follower sprite at cell (8,2), drawn at (120,16)', ch ? ch.px + ',' + ch.py + ' ' + ch.sprite.width : 'missing');
    ok(sp.every((s, i) => i === 0 || s.y >= sp[i - 1].y), 'W5k mapSprites come top to bottom (the draw order)');
    made.centerSprites = sha1(...sp.map((s) => s.sprite.rgba)); } catch (e) { ok(false, 'W5k the Center\'s NPCs resolve', e.name + ': ' + e.message); ok(false, 'W5l the Chansey beside the nurse resolves', e.message); }
  { const tags = ow.paletteTags(58), own = ow.info(58).paletteTag;
    const a = ow.walker(58, 'down', 0), b = ow.walker(58, 'down', 0, { paletteTag: tags[1] });
    let shape = true; for (let i = 3; i < a.rgba.length; i += 4) if (a.rgba[i] !== b.rgba[i]) shape = false;
    ok(tags.length === 4 && tags[0] === own && shape && picHash(a) !== picHash(b) && ow.paletteTags(0).length === 1, 'W5m a sprite in a shared NPC palette can be drawn in the other three (same shape, other colours); the player has one palette', J(tags)); }

  /* ---- W7 emotes --------------------------------------------------------------------------------------- */
  const em = world.emotes;
  ok(em.map((e) => e.name).join() === 'exclaim,question,doubleExclaim,cross,heart,happy,smile,sad,upset,angry,pensive,love,surprise,curious,music,poisoned' && em.every((e, i) => e.id === i),
    'W7a sixteen emotes in the documented order', em.map((e) => e.name).join());
  { let bad = 0; const seen = new Set();
    for (const e of em) { if (e.width !== 16 || e.height !== 16 || e.rgba !== e.frames[0]) bad++; for (const f of e.frames) { let ink = 0; for (let i = 3; i < f.length; i += 4) if (f[i]) ink++; if (f.length !== 1024 || ink < 40) bad++; seen.add(sha1(f)); } made.emotes[e.name] = sha1(...e.frames); }
    ok(bad === 0, 'W7b every emote is a drawn 16 x 16 picture', bad + ' wrong');
    ok(em.slice(0, 5).every((e) => e.frames.length === 1) && em.slice(5).every((e) => e.frames.length === 2), 'W7c the five icons have one frame, the eleven follower emotes two');
    ok(seen.size === 5 + 22, 'W7d all 27 emote pictures are different', String(seen.size)); }

  /* ---- W6 the golden ----------------------------------------------------------------------------------- */
  if (!UPDATE || !full) {
    const g = readGolden();
    const diff = (a, b) => Object.keys({ ...a, ...b }).filter((k) => a[k] !== b[k]);
    ok(diff(made.maps, g.maps).length === 0, 'W6a the pinned map pictures equal the golden (the Center, the other Center shape, a town, a route, houses, ...)', diff(made.maps, g.maps).join(' '));
    ok(made.border === g.border && made.view === g.view, 'W6b the border block and the 320 x 240 view equal the golden');
    ok(diff(made.avatars, g.avatars).length === 0 && made.avatarsAll === g.avatarsAll, 'W6c every avatar\'s twelve pictures equal the golden', diff(made.avatars, g.avatars).slice(0, 8).join(' '));
    ok(diff(made.emotes, g.emotes).length === 0, 'W6d every emote equals the golden', diff(made.emotes, g.emotes).join(' '));
    ok(diff(made.followers, g.followers).length === 0 && made.centerSprites === g.centerSprites, 'W6e the follower samples and the Center\'s NPCs equal the golden');
    ok(J(made.kinds) === J(g.kinds) && J(made.counts) === J(g.counts) && J(made.center) === J(g.center), 'W6f the counts equal the golden (sprite kinds, maps, cells, warps, objects, the list of Centers)', J(made.kinds) + ' ' + J(made.center));
    if (full) ok(made.allMaps === g.allMaps, 'W6g the pictures of all 617 maps equal the golden aggregate');
  }
  return { failed, pass, made, world, W };
}

/* ================================================================================================ the real tree */
const t0 = Date.now();
console.log('pokemonarena world test; ROM', ROM_PATH, romBuf.length, 'B');
const real = await runChecks(JS_DIR, { full: !FAST, quiet: false });
let { pass } = real;
const failures = real.failed.slice();
const ok = (cond, name, detail) => { if (cond) pass++; else { failures.push(name); console.log('FAIL', name, detail === undefined ? '' : detail); } };

if (UPDATE && real.world) {
  if (FAST) { console.log('--update needs the full run (no --fast)'); process.exit(1); }
  const g = {
    rom: { sha256: crypto.createHash('sha256').update(rom).digest('hex'), length: rom.length },
    note: 'HASHES ONLY. sha1 of width, height (u32le) and RGBA bytes (maps: under then over). No ROM-derived pixels, palettes or tables are stored here.',
    ...real.made,
  };
  fs.writeFileSync(GOLDEN, JSON.stringify(g, null, 1) + '\n');
  goldenCache = null;
  console.log('wrote golden', GOLDEN);
}

/* ---- W6h / W8: the golden itself, portability ---------------------------------------------------------- */
{
  const g = readGolden();
  ok(g.rom && g.rom.sha256 === crypto.createHash('sha256').update(rom).digest('hex'), 'W6h the golden was made from this ROM');
  const text = fs.readFileSync(GOLDEN, 'utf8');
  const leaves = []; (function walk(v) { if (v && typeof v === 'object') for (const k of Object.keys(v)) walk(v[k]); else leaves.push(v); })(g);
  ok(leaves.every((v) => typeof v === 'number' || (typeof v === 'string' && (/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(v) || v.length < 400))) && text.length < 40000, 'W6h the golden holds hashes, counts and one note only (' + text.length + ' bytes)');
  // negative control: the comparison can fail
  const t = JSON.parse(text); t.maps['2.0'] = '0'.repeat(40);
  ok(Object.keys(t.maps).filter((k) => t.maps[k] !== real.made.maps[k]).length === 1, 'W6i negative control: a tampered golden entry is detected');
}
{
  const src = fs.readFileSync(path.join(JS_DIR, 'world_rom.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  ok(!/node:|require\(|\bBuffer\b|\bprocess\.|\bdocument\b|\bwindow\b/.test(code), 'W8a world_rom.js has no node: / require / Buffer / process / DOM (browser-portable)');
  ok(!/\r/.test(src), 'W8b world_rom.js has LF line endings');
  // nothing ROM-derived: no long run of numeric literals (a table of pixels / colours / blocks) and no long quoted blob
  const longArray = /\[(?:\s*(?:0x[0-9a-fA-F]+|\d+)\s*,){16,}/.test(code), longString = /['"`][0-9A-Za-z+/=]{120,}['"`]/.test(code);
  ok(!longArray && !longString, 'W8c world_rom.js holds no table of ROM data (no array of 17+ numbers, no long encoded string)');
  const imports = [...code.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
  ok(J(imports) === J(['./gfxcodec.js']), 'W8d world_rom.js imports only ./gfxcodec.js', J(imports));
}

/* ================================================================================================ source mutants */
// each: { id, from, to, fails }: ONE defect in a copy of pokemonarena/js; `fails` is the prefix of a check that must fail.
const MUTANTS = [
  { id: 'M1 the Emerald 10-bit metatile id', from: 'export const BLOCK_METATILE_MASK = 0x07ff;', to: 'export const BLOCK_METATILE_MASK = 0x03ff;', fails: 'W3b' },
  { id: 'M2 the Emerald collision bits (10-11)', from: 'export const BLOCK_COLLISION_MASK = 0x0800;', to: 'export const BLOCK_COLLISION_MASK = 0x0400;', fails: 'W3g' },
  { id: 'M3 the Emerald metatile split (512 primary)', from: 'export const METATILES_IN_PRIMARY = 1024;', to: 'export const METATILES_IN_PRIMARY = 512;', fails: 'W0b' },
  { id: 'M4 the Emerald tile split (512 primary tiles)', from: 'export const TILES_IN_PRIMARY = 640;', to: 'export const TILES_IN_PRIMARY = 512;', fails: 'W6a' },
  { id: 'M5 the Emerald palette split (6 primary palettes)', from: 'export const PALS_IN_PRIMARY = 7;', to: 'export const PALS_IN_PRIMARY = 6;', fails: 'W4c' },
  { id: 'M6 a two-layer metatile (8 entries)', from: 'export const TILES_PER_METATILE = 12;', to: 'export const TILES_PER_METATILE = 8;', fails: 'W6a' },
  { id: 'M7 the middle layer drawn above the sprites', from: 'export const TOP_LAYER = 2;', to: 'export const TOP_LAYER = 1;', fails: 'W4b' },
  { id: 'M8 tile h-flip and v-flip swapped', from: 'hf = e & 0x400, vf = e & 0x800,', to: 'hf = e & 0x800, vf = e & 0x400,', fails: 'W6a' },
  { id: 'M9 a sprite is never mirrored', from: 'putColour(out, (py * width + (flipX ? width - 1 - px : px)) * 4, pal[idx]);', to: 'putColour(out, (py * width + px) * 4, pal[idx]);', fails: 'W5e' },
  { id: 'M10 the Emerald 8-bit graphics id', from: 'localId: R.u8(o), gfx: R.u16(o + 1),', to: 'localId: R.u8(o), gfx: R.u8(o + 1),', fails: 'W5l' },
  { id: 'M11 warp destination group and number swapped', from: 'destNum: R.u8(o + 6), destGroup: R.u8(o + 7) });', to: 'destNum: R.u8(o + 7), destGroup: R.u8(o + 6) });', fails: 'W3d' },
  { id: 'M12 the walk frames assumed, not read (the standing frame counts as a step)', from: '        if (f.frame === stand.frame) continue;\n', to: '', fails: 'W5i' },
  { id: 'M13 a follower drawn in the palette its tag names', from: '    if (inf.palOff) return readPal(inf.palOff);\n', to: '', fails: 'W5j' },
  { id: 'M14 the heart read from the icon table', from: "add('heart', [image(heart, 0)]);", to: "add('heart', [image(icons, 0)]);", fails: 'W7d' },
  { id: 'M15 three-frame standers offered as walkers', from: '      if (borrows(inf)) continue;', to: '', fails: 'W5b' },
  { id: 'M16 a sheet read as one frame', from: 'R.need(inf.imagesOff, \'sprite sheet\') + f * R.u16(inf.imagesOff + 4) };', to: 'R.need(inf.imagesOff, \'sprite sheet\') };', fails: 'W5b' },
  { id: 'M17 the border block not tiled by cell parity', from: 'const bx = mod2(cx) * CELL + (mx - cx * CELL), by = mod2(cy) * CELL + (my - cy * CELL);', to: 'const bx = (mx - cx * CELL), by = (my - cy * CELL);', fails: 'W4g' },
  { id: 'M18 left and right swapped in the facing codes', from: "const FACING_BY_CODE = ['down', 'down', 'up', 'left', 'right'];", to: "const FACING_BY_CODE = ['down', 'down', 'up', 'right', 'left'];", fails: 'W1h' },
  { id: 'M19 the object template read at the Emerald stride', from: 'objectTemplateSize: 24, warpSize: 8,', to: 'objectTemplateSize: 20, warpSize: 8,', fails: 'W1e' },
  { id: 'M20 the palette slot taken from the low tile bits', from: 'const tile = e & 0x3ff, hf = e & 0x400, vf = e & 0x800, bank = e >> 12;', to: 'const tile = e & 0x3ff, hf = e & 0x400, vf = e & 0x800, bank = (e >> 12) & 7;', fails: 'W6a' },
  { id: 'M21 the nurse addressed from the counter cell itself', from: "      if (crossed && m.walkable(nurse.x, y)) nurseTalk = { x: nurse.x, y, facing: 'up' };", to: "      if (crossed) nurseTalk = { x: nurse.x, y: y - 1, facing: 'up' };", fails: 'W3e' },
  { id: 'M22 gliding standers offered as walkers', from: "      if (!walkIsAnimated(inf)) { standers.push(inf.id); continue; }   // four directions, but it would glide\n", to: '', fails: 'W5g' },
];
async function runMutants() {
  let killed = 0;
  for (const m of MUTANTS) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'world-mut-'));
    try {
      for (const f of ['world_rom.js', 'gfxcodec.js', 'rom.js']) fs.copyFileSync(path.join(JS_DIR, f), path.join(dir, f));
      const fp = path.join(dir, 'world_rom.js');
      const body = fs.readFileSync(fp, 'utf8').replace(/\r\n/g, '\n');
      const n = body.split(m.from).length - 1;
      if (n !== 1) { console.log('MUTANT', m.id, ': snippet occurs', n, 'times'); continue; }
      fs.writeFileSync(fp, body.replace(m.from, () => m.to));
      let failed;
      try { failed = (await runChecks(dir, { full: false, quiet: true })).failed; } catch (e) { failed = ['threw ' + e.name + ': ' + e.message]; }
      if (failed.some((f) => f.startsWith(m.fails))) killed++;
      else console.log('MUTANT SURVIVED', m.id, '(expected', m.fails, 'to fail; failed:', J(failed.map((f) => f.split(' ')[0])) + ')');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  console.log('source mutants killed', killed + '/' + MUTANTS.length);
  return killed === MUTANTS.length;
}
if (!FAST) ok(await runMutants(), 'MUTANTS every source mutant fails the check it names (' + MUTANTS.length + ')');

/* ================================================================================================ contact sheets */
if (SHEETS && real.world) {
  const { world, W } = real;
  const U = await import(pathToFileURL(path.join(JS_DIR, 'uiassets.js')).href);
  const ui = U.loadUiAssets(rom);
  // labels are set in the ROM's own small font; a character the Gen-3 charset has no glyph for becomes a space
  const glyphOk = new Map();
  const clean = (s) => Array.from(String(s), (ch) => { if (!glyphOk.has(ch)) { try { U.encodeText(ch); glyphOk.set(ch, true); } catch (e) { glyphOk.set(ch, false); } } return glyphOk.get(ch) ? ch : ' '; }).join('');
  const text = (c, x, y, s, fg = [255, 255, 255]) => { const t = ui.renderText('small', clean(s), { fg, shadow: [0, 0, 0] }); blit(c, x, y, t.width, t.height, t.rgba); };
  const put = (c, x, y, p, k = 1) => { const s = k === 1 ? p : scaleRGBA(p.width, p.height, p.rgba, k); blit(c, x, y, s.width, s.height, s.rgba); };
  const checker = (c, x0, y0, w, h) => { for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = ((x >> 3) + (y >> 3)) & 1 ? 196 : 164; const o = ((y0 + y) * c.width + x0 + x) * 4; c.rgba[o] = v; c.rgba[o + 1] = v; c.rgba[o + 2] = v; c.rgba[o + 3] = 255; } };
  const tint = (c, x, y, w, h, col, a) => { for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) { if (xx < 0 || yy < 0 || xx >= c.width || yy >= c.height) continue; const o = (yy * c.width + xx) * 4; for (let k = 0; k < 3; k++) c.rgba[o + k] = Math.round(c.rgba[o + k] * (1 - a) + col[k] * a); } };
  // the map as the game shows it: under, the sprites top to bottom, over
  const scene = (m) => { const r = world.renderMap(m); const c = { width: r.width, height: r.height, rgba: r.under.slice() }; for (const s of world.mapSprites(m)) if (s.sprite) blit(c, s.px, s.py, s.sprite.width, s.sprite.height, s.sprite.rgba); blit(c, 0, 0, r.width, r.height, r.over); return c; };
  const save = (name, c, k = 1) => { const s = k === 1 ? c : scaleRGBA(c.width, c.height, c.rgba, k); writePNG(path.join(OUT, name), s.width, s.height, s.rgba); console.log('sheet', path.join(OUT, name).replace(/\\/g, '/'), s.width + 'x' + s.height); };

  { // 1. the Center: under | over | as the game shows it | collision + special cells (3x)
    const m = world.center, r = world.renderMap(m), ci = world.centerInfo(m), k = 3, W1 = r.width * k, H1 = r.height * k, gap = 12;
    const c = newCanvas(2 * W1 + 3 * gap, 2 * H1 + 3 * gap + 60, [40, 40, 56, 255]);
    put(c, gap, gap, { width: r.width, height: r.height, rgba: r.under }, k);
    checker(c, 2 * gap + W1, gap, W1, H1); put(c, 2 * gap + W1, gap, { width: r.width, height: r.height, rgba: r.over }, k);
    const sc = scene(m); put(c, gap, 2 * gap + H1, sc, k);
    const x0 = 2 * gap + W1, y0 = 2 * gap + H1; put(c, x0, y0, sc, k);
    for (let y = 0; y < m.height; y++) for (let x = 0; x < m.width; x++) { if (!m.walkable(x, y)) tint(c, x0 + x * 16 * k, y0 + y * 16 * k, 16 * k, 16 * k, [200, 0, 0], 0.45); }
    const mark = (cell, col, label) => { tint(c, x0 + cell.x * 16 * k, y0 + cell.y * 16 * k, 16 * k, 16 * k, col, 0.6); text(c, x0 + cell.x * 16 * k + 2, y0 + cell.y * 16 * k + 14, label); };
    for (const d of ci.doors) mark(d, [0, 200, 0], 'DOOR');
    for (const d of ci.counter) mark(d, [240, 160, 0], 'CTR');
    for (const d of ci.pc) mark(d, [0, 120, 255], 'PC');
    for (const d of ci.pcUse) mark(d, [0, 200, 255], 'use');
    for (const d of ci.regionMap) mark(d, [160, 0, 200], 'MAP');
    for (const d of ci.solid) mark(d, [120, 60, 0], 'tbl');
    if (ci.nurseTalk) mark(ci.nurseTalk, [255, 255, 0], 'talk');
    for (let x = 0; x < m.width; x++) text(c, x0 + x * 16 * k + 18, y0 - 12, x);
    for (let y = 0; y < m.height; y++) text(c, x0 - 11, y0 + y * 16 * k + 16, y);
    text(c, gap, 2 * H1 + 3 * gap + 2, 'MAP ' + m.group + '.' + m.num + '  ' + m.width + 'x' + m.height + '  MUSIC ' + m.music + '   top: under / over   bottom: as the game shows it / red = solid');
    text(c, gap, 2 * H1 + 3 * gap + 20, 'NPCs: ' + m.events.objects.map((o) => 'gfx ' + o.gfx + ' (' + o.x + ',' + o.y + ') ' + o.facing).join('   '));
    text(c, gap, 2 * H1 + 3 * gap + 38, 'BG events: ' + m.events.bgs.map((b) => '(' + b.x + ',' + b.y + ')').join(' ') + '   door -> map ' + ci.doors.map((d) => d.destGroup + '.' + d.destNum).join(' '));
    save('center.png', c);
  }
  { // 2. the 240x160 view of the Center (the room is exactly one screen) and a view that shows the border block
    const m = world.center, c = newCanvas(240 * 2 + 320 + 36, 480 + 24, [40, 40, 56, 255]);
    const v = world.renderView(m, 0, 0, 240, 160); const s1 = { width: 240, height: 160, rgba: v.under.slice() };
    for (const s of world.mapSprites(m)) if (s.sprite) blit(s1, s.px, s.py, s.sprite.width, s.sprite.height, s.sprite.rgba);
    blit(s1, 0, 0, 240, 160, v.over); put(c, 12, 12, s1, 2);
    const v2 = world.renderView(m, -32, -40, 320, 240); const s2 = { width: 320, height: 240, rgba: v2.under.slice() }; blit(s2, 0, 0, 320, 240, v2.over); put(c, 240 * 2 + 24, 12, s2, 1);
    text(c, 12, 340, 'left: renderView(center, 0, 0, 240, 160) at 2x = the GBA screen.   right: renderView(center, -32, -40, 320, 240): border block outside');
    save('center_view.png', c);
  }
  { // 3. every Pokemon Center (as the game shows it), labelled; the standard ones first
    const cs = world.centers.filter((e) => e.standard).concat(world.centers.filter((e) => !e.standard)); let y = 8; const rows = [];
    let x = 8, rowH = 0; const k = 1, maxW = 1600;
    for (const e of cs) { const m = world.map(e.group, e.num), w = m.width * 16 * k, h = m.height * 16 * k + 16; if (x + w > maxW) { x = 8; y += rowH + 8; rowH = 0; } rows.push({ e, m, x, y }); x += w + 8; rowH = Math.max(rowH, h); }
    const c = newCanvas(maxW, y + rowH + 8, [40, 40, 56, 255]);
    for (const r of rows) { text(c, r.x, r.y, r.e.group + '.' + r.e.num + ' ' + r.m.width + 'x' + r.m.height + (r.e.standard ? ' STANDARD' : '') + (r.e.sameAsCenter ? ' =2.0' : '') + ' mus ' + r.m.music); put(c, r.x, r.y + 16, scene(r.m), k); }
    save('centers_all.png', c);
  }
  { // 4. every avatar: 4 directions x 3 steps at 2x, labelled with its graphics id (64 per sheet)
    const av = world.ow.avatars, per = 64, cols = 4, k = 2, cw = 36 + 12 * 16 * k + 8, ch = 32 * k + 4;
    for (let s = 0; s * per < av.length; s++) {
      const part = av.slice(s * per, (s + 1) * per);
      const c = newCanvas(cols * cw, Math.ceil(part.length / cols) * ch + 18, [72, 104, 72, 255]);
      text(c, 4, 0, 'AVATARS ' + (s * per) + '..' + (s * per + part.length - 1) + ' of ' + av.length + '   id | down x3 | up x3 | left x3 | right x3   (stand, step 1, step 2)   P = player character');
      part.forEach((id, i) => {
        const x0 = (i % cols) * cw, y0 = 18 + Math.floor(i / cols) * ch;
        text(c, x0 + 2, y0 + 20, id); if (world.ow.info(id).kind === 'player') text(c, x0 + 2, y0 + 36, 'P', [255, 255, 0]);
        let n = 0; for (const d of W.DIRS) for (let st = 0; st < 3; st++) put(c, x0 + 36 + (n++) * 16 * k, y0 + 2, world.ow.walker(id, d, st), k);
      });
      save('avatars_' + s + '.png', c);
    }
  }
  { // 5. the NPC palette axis: a sample of people in their own palette (top) and the four shared NPC palettes
    const ids = [6, 7, 8, 13, 16, 21, 28, 35, 45, 58, 64, 83, 116, 129, 230, 265], k = 3;
    const c = newCanvas(60 + ids.length * (16 * k + 6), 18 + 5 * (32 * k + 6), [72, 104, 72, 255]);
    text(c, 4, 0, 'row 0: own palette. rows 1-4: tags 0x1103 0x1104 0x1105 0x1106 (boxed = own). The last two do not use an NPC palette: a recolour breaks them.');
    ids.forEach((id, i) => { const own = world.ow.info(id).paletteTag; [undefined, ...W.NPC_PAL_TAGS].forEach((tag, r) => { const x = 60 + i * (16 * k + 6), y = 18 + r * (32 * k + 6); if (tag === own) fillRect(c, x, y, 16 * k + 4, 32 * k + 4, [40, 60, 120, 255]); put(c, x + 2, y + 2, world.ow.walker(id, 'down', 0, tag === undefined ? undefined : { paletteTag: tag }), k); }); });
    [undefined, ...W.NPC_PAL_TAGS].forEach((tag, r) => text(c, 2, 18 + r * (32 * k + 6) + 40, tag === undefined ? 'own' : '0x' + tag.toString(16)));
    save('avatar_palettes.png', c);
  }
  { // 6. emotes at 4x, named
    const em = world.emotes, k = 4, cw = 2 * 16 * k + 24;
    const c = newCanvas(8 * cw + 8, 2 * (16 * k + 28) + 8, [96, 128, 96, 255]);
    em.forEach((e, i) => { const x = 8 + (i % 8) * cw, y = 8 + Math.floor(i / 8) * (16 * k + 28); e.frames.forEach((f, j) => put(c, x + j * (16 * k + 4), y, { width: 16, height: 16, rgba: f }, k)); text(c, x, y + 16 * k + 2, e.id + ' ' + e.name); });
    save('emotes.png', c);
  }
  { // 7. follower Pokemon samples + the big / object sprites of the table (frame 0), labelled
    const k = 2, mons = [113, 25, 1, 4, 7, 152, 155, 158, 6, 150, 249, 250];
    const c = newCanvas(40 + 12 * 64 * k / 2 + 200, mons.length * (32 * k + 6) + 20, [72, 104, 72, 255]);
    text(c, 4, 0, 'FOLLOWER POKEMON (graphics id 0x4000 | species): species | down x3 | up x3 | left x3 | right x3');
    mons.forEach((sp, r) => { if (!world.ow.has(W.GFX.MON | sp)) return; text(c, 2, 20 + r * (32 * k + 6) + 24, sp); let n = 0; for (const d of W.DIRS) for (let st = 0; st < 3; st++) { const f = world.ow.walker(W.GFX.MON | sp, d, st); if (f.width === 32) put(c, 40 + (n++) * 32 * k, 20 + r * (32 * k + 6), f, k); } });
    save('followers.png', c);
    const others = []; for (let id = 0; id < world.ow.count; id++) { if (!world.ow.has(id) || world.ow.avatars.includes(id)) continue; const inf = world.ow.info(id); if (inf.frameCount && inf.width <= 64) others.push(id); }
    const cols = 16, cell = 76, c2 = newCanvas(cols * cell, Math.ceil(others.length / cols) * (cell + 14) + 18, [72, 104, 72, 255]);
    text(c2, 4, 0, 'EVERY OTHER GRAPHICS ID (not an avatar), frame 0, with its id and kind (w = walker, p = pokemon, o = object, P = player copy)');
    others.forEach((id, i) => { const x = (i % cols) * cell, y = 18 + Math.floor(i / cols) * (cell + 14); const inf = world.ow.info(id); put(c2, x + ((cell - inf.width) >> 1), y + cell - inf.height - 2, world.ow.frame(id, 0)); text(c2, x + 2, y + cell - 2, id + ' ' + ({ walker: 'w', pokemon: 'p', object: 'o', player: 'P' })[inf.kind]); });
    save('ow_others.png', c2);
  }
  { // 8. other maps, to show the decoder is general: a town, a route, houses, a big interior (1x, as the game shows them)
    const picks = ['0.1', '0.0', '24.25', '1.1', '22.0', '22.54', '5.3', '21.0', '23.28', '24.0'];
    let x = 8, y = 8, rowH = 0; const maxW = 2000, rows = [];
    for (const kx of picks) { const [g, n] = kx.split('.').map(Number); const m = world.map(g, n), w = m.width * 16, h = m.height * 16 + 16; if (x + w > maxW && x > 8) { x = 8; y += rowH + 8; rowH = 0; } rows.push({ kx, m, x, y }); x += w + 8; rowH = Math.max(rowH, h); }
    const c = newCanvas(maxW, y + rowH + 8, [40, 40, 56, 255]);
    for (const r of rows) { text(c, r.x, r.y, 'MAP ' + r.kx + ' ' + r.m.width + 'x' + r.m.height + ' music ' + r.m.music); const sc = scene(r.m); blit(c, r.x, r.y + 16, Math.min(sc.width, maxW - r.x), sc.height, sc.width <= maxW - r.x ? sc.rgba : (() => { const w = maxW - r.x, o = new Uint8Array(w * sc.height * 4); for (let yy = 0; yy < sc.height; yy++) o.set(sc.rgba.subarray(yy * sc.width * 4, yy * sc.width * 4 + w * 4), yy * w * 4); return o; })()); }
    save('maps_sample.png', c);
  }
}

console.log('\n' + pass + ' passed, ' + failures.length + ' failed (' + (Date.now() - t0) + ' ms)');
if (failures.length) { console.log('FAILURES:\n  ' + failures.join('\n  ')); process.exit(1); }

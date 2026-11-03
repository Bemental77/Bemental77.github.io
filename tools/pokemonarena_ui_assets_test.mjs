// tools/pokemonarena_ui_assets_test.mjs - Node test for pokemonarena/js/{gfxcodec,uiassets,speciesgfx}.js
//
//   node tools/pokemonarena_ui_assets_test.mjs                 # run; exit 1 on any failure
//   ARENA_UPDATE_GOLDEN=1 node tools/pokemonarena_ui_assets_test.mjs   # rewrite pokemonarena/ui_assets.golden.json
//   ARENA_ROM=/path/to.gba  ARENA_OUT=/path/to/pngdir  (overrides)
//
// What it proves (and what would make it fail):
//   * the ROM is the pinned image (sha256) - the offsets in the modules are specific to it;
//   * LZ77 + smol codecs: every compressed blob the modules touch decodes with its header's counts satisfied
//     (2,076+ species pics, trainer pics, UI sheets); a corrupted blob either throws or changes the output;
//   * every UI asset decodes to the manifest's declared width/height and its hash (SHA-1 of indices + palette
//     + meta) equals ui_assets.golden.json (hashes only - no pixels are committed);
//   * mutants: flipping one ROM byte inside an asset changes that asset's hash, and an unmutated twin stays equal;
//     a wrong ROM length / header throws; the golden comparison itself is shown to fail on a tampered golden;
//   * the modules contain no node: imports / Buffer / require (browser-portable);
//   * text: the ROM font + width table render "What will PIKACHU do?" (PNG written for visual inspection).
// PNG contact sheets go to ARENA_OUT (default: the stage scratch dir) for opening with an image viewer.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writePNG, scaleRGBA, newCanvas, blit, fillRect, gridSheet } from './arena_png.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const ROM_PATH = process.env.ARENA_ROM || path.join(root, 'gba', 'gbaWasm', 'roms', 'Pokemon SoulGold (v1.1.1).gba');
const OUT = process.env.ARENA_OUT || 'C:/Users/Admin/AppData/Local/Temp/claude/C--Users-Admin-Dev-Bemental77-github-io/c96e71fd-a869-4d47-86d5-aa19395edeed/scratchpad/U1';
const GOLDEN = path.join(root, 'pokemonarena', 'ui_assets.golden.json');
const UPDATE = process.env.ARENA_UPDATE_GOLDEN === '1';
const mod = (n) => import(pathToFileURL(path.join(root, 'pokemonarena', 'js', n)).href);
const G = await mod('gfxcodec.js');
const U = await mod('uiassets.js');
const S = await mod('speciesgfx.js');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, detail) {
  if (cond) pass++; else { fail++; failures.push(name + (detail ? ' :: ' + detail : '')); console.log('FAIL', name, detail || ''); }
}
function throws(fn, name, ctor) {
  try { fn(); ok(false, name, 'did not throw'); } catch (e) { ok(!ctor || e instanceof ctor || e.name === ctor.name, name, e.name + ': ' + e.message); }
}
const sha1 = (...parts) => { const h = crypto.createHash('sha1'); for (const p of parts) h.update(p); return h.digest('hex'); };
const i32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
function palBytes(p) { return p ? Buffer.from(p.buffer, p.byteOffset, p.byteLength) : Buffer.alloc(0); }
function assetHash(a) { return sha1(i32(a.width), i32(a.height), a.pixels, palBytes(a.palette), a.meta ? Buffer.from(a.meta) : Buffer.alloc(0)); }

const romBuf = fs.readFileSync(ROM_PATH);
const rom = new Uint8Array(romBuf.buffer, romBuf.byteOffset, romBuf.length);
const load = (r) => U.loadUiAssets(r);
const t0 = Date.now();
console.log('pokemonarena ui-assets test; ROM', ROM_PATH, romBuf.length, 'B');

/* ---- 0. ROM identity ------------------------------------------------------------------------- */
ok(crypto.createHash('sha256').update(rom).digest('hex') === U.ROM_SHA256, 'rom sha256 matches ROM_SHA256');
ok(crypto.createHash('md5').update(rom).digest('hex') === U.ROM_MD5, 'rom md5 matches ROM_MD5');
ok(U.validateRom(rom) === true, 'validateRom accepts the pinned ROM');
throws(() => U.validateRom(rom.subarray(0, rom.length - 1)), 'wrong ROM length throws', U.UiAssetError);
throws(() => load(new Uint8Array(rom.length)), 'zero-filled ROM of right length throws (header)', U.UiAssetError);
{ const bad = rom.slice(); bad[0xAC] = 0x41; throws(() => load(bad), 'ROM with a different game code throws', U.UiAssetError); }
{ const bad = rom.slice(); bad[0xA0] = 0x58; throws(() => load(bad), 'ROM with a different title throws', U.UiAssetError); }
throws(() => U.validateRom([1, 2, 3]), 'non-Uint8Array throws', U.UiAssetError);

/* ---- 1. codecs ------------------------------------------------------------------------------- */
{ // LZ77: hand-built stream: header, 8 flags -> literal 'A','B' then a back-reference len 6 disp 2 -> ABABABAB (size 8)
  const s = new Uint8Array([0x10, 8, 0, 0, 0x20, 0x41, 0x42, 0x30, 0x01]);   // flags 0b0010_0000: 3rd item is a ref (b1=0x30: len 3+3=6, disp ((0<<8)|1)+1=2)
  const r = G.lz77Decode(s, 0);
  ok(Array.from(r.data).join() === [65, 66, 65, 66, 65, 66, 65, 66].join(), 'lz77 hand-built stream decodes', Array.from(r.data).join());
  const bad = new Uint8Array([0x10, 8, 0, 0, 0x80, 0x00, 0x05]);               // first item is a back-reference before the start
  ok(G.lz77Probe(bad, 0) === null, 'lz77 back-reference before start is rejected (negative control)');
  ok(G.lz77Probe(new Uint8Array([0x11, 8, 0, 0]), 0) === null, 'lz77 wrong type byte rejected');
}
{ // every pointer-referenced LZ77 block in the ROM must decode with its header size and consume a plausible byte count
  const seen = new Set(); let n = 0, bad = 0;
  const dv = new DataView(rom.buffer, rom.byteOffset, rom.length);
  for (let o = 0; o + 4 <= rom.length; o += 4) {
    const v = dv.getUint32(o, true);
    if (v < 0x08000000 || v >= 0x08000000 + rom.length) continue;
    const t = v - 0x08000000;
    if (seen.has(t) || rom[t] !== 0x10) continue;
    seen.add(t);
    const r = G.lz77Probe(rom, t);
    if (r && (r.size % 32 === 0 || (r.size % 2 === 0 && r.size >= 64))) { n++; if (r.consumed < 4 || r.consumed > r.size + (r.size >> 3) + 16) bad++; }
  }
  console.log('real LZ77 blocks (pointer-referenced, plausible tile size):', n);
  ok(n >= 1 && bad === 0, 'ROM contains real LZ77 blocks and they decode with sane consumed sizes (' + n + ')', bad + ' implausible');
}
const speciesIds = [];
{ // smol: every species pic (front+back, normal+female) decodes with the header counts satisfied
  let slots = 0, blobs = 0, two = 0, one = 0, noIcon = 0;
  const seen = new Map();
  let failedDecode = 0;
  for (let id = 1; id <= S.MAX_SPECIES_ID; id++) {
    const r = S.speciesRecord(rom, id);
    if (!r) continue;
    slots++; speciesIds.push(id);
    if (!r.icon) noIcon++;
    for (const off of [r.front, r.back, r.female.front, r.female.back]) {
      if (!off) continue;
      let len = seen.get(off);
      if (len === undefined) { try { const d = G.smolDecode(rom, off); blobs++; len = d.data.length; if (len !== 2048 && len !== 4096) failedDecode++; } catch (e) { failedDecode++; len = -1; console.log('smol fail', id, off.toString(16), e.message); } seen.set(off, len); }
      if (off === r.front) { if (len === 4096) two++; else if (len === 2048) one++; }
    }
  }
  console.log('species slots', slots, 'unique pic blobs', blobs, 'two-frame fronts', two, 'one-frame', one, 'no icon', noIcon);
  ok(failedDecode === 0, 'all species pics smol-decode with exact counts (0 failures)', failedDecode + ' failures');
  ok(slots === 1038, 'populated species slots == 1038 (ids 1..1577)', 'got ' + slots);
  ok(two === 689 && one === 349, 'front frame counts 689 two-frame / 349 one-frame', two + '/' + one);
  ok(noIcon === 1, 'exactly one populated slot has no icon (1557)', 'got ' + noIcon);
  ok(S.speciesRecord(rom, 1557) && S.speciesRecord(rom, 1557).icon === 0 && S.speciesGfx(rom, 1557).icon === null, 'species 1557 icon is null, not a crash');
  ok(S.speciesRecord(rom, 21) === null && S.speciesGfx(rom, 21) === null, 'removed slot 21 returns null');
  throws(() => S.speciesRecord(rom, 0), 'species id 0 throws', G.GfxError);
  throws(() => S.speciesRecord(rom, 1578), 'species id 1578 throws', G.GfxError);
}
{ // smol negative control: flipping a bitstream byte of a real pic must throw or change the output
  const r = S.speciesRecord(rom, 25);
  const good = G.smolDecode(rom, r.front);
  const h = G.smolHeader(rom, r.front);
  let changed = 0, tried = 0;
  for (const delta of [20, 40, 60, 80]) {
    const m = rom.slice(); m[r.front + 8 + 24 + delta] ^= 0xA5; tried++;
    try { const d = G.smolDecode(m, r.front); if (sha1(d.data) !== sha1(good.data)) changed++; } catch (e) { changed++; }
  }
  ok(changed === tried, 'smol: flipping bitstream bytes throws or changes the picture (' + changed + '/' + tried + ')', 'mode ' + h.mode);
  const twin = G.smolDecode(rom.slice(), r.front);
  ok(sha1(twin.data) === sha1(good.data), 'smol: unmutated twin decodes identically');
}

/* ---- 2. UI assets: dimensions + golden hashes ---------------------------------------------------- */
const ui = load(rom);
const mani = ui.manifest();
const hashes = {};
let dimBad = 0, decodeBad = 0;
for (const m of mani) {
  let a;
  try { a = ui.get(m.key); } catch (e) { decodeBad++; console.log('decode fail', m.key, e.message); continue; }
  if (a.width !== m.width || a.height !== m.height) { dimBad++; console.log('dim mismatch', m.key, a.width + 'x' + a.height, 'manifest', m.width + 'x' + m.height); }
  hashes[m.key] = { width: a.width, height: a.height, sha1: assetHash(a) };
}
ok(decodeBad === 0, 'every UI asset decodes (' + mani.length + ' assets)', decodeBad + ' failed');
ok(dimBad === 0, 'every UI asset has the manifest width/height', dimBad + ' mismatches');
ok(mani.every((m) => m.offsets && m.compression !== undefined && m.bpp && m.palette && m.width && m.height), 'every manifest entry carries offsets, compression, bpp, palette source, width, height');
ok(new Set(mani.map((m) => m.key)).size === mani.length, 'asset keys are unique');

// species / trainer aggregate hashes
const agg = {};
{
  const hs = crypto.createHash('sha1');
  for (const id of speciesIds) {
    const g = S.speciesGfx(rom, id);
    for (const f of g.front.frames) hs.update(f.pixels);
    for (const f of g.back.frames) hs.update(f.pixels);
    if (g.icon) for (const f of g.icon.frames) hs.update(f.pixels);
    hs.update(palBytes(g.palettes.normal)); hs.update(palBytes(g.palettes.shiny));
    if (g.palettes.icon) { hs.update(palBytes(g.palettes.icon)); hs.update(palBytes(g.palettes.iconShiny)); }
  }
  agg['species.all'] = { count: speciesIds.length, sha1: hs.digest('hex') };
  for (const id of [1, 25, 150, 249, 250]) {
    const g = S.speciesGfx(rom, id);
    const h = crypto.createHash('sha1');
    for (const f of [...g.front.frames, ...g.back.frames, ...g.icon.frames]) h.update(f.pixels);
    for (const p of [g.palettes.normal, g.palettes.shiny, g.palettes.icon, g.palettes.iconShiny]) h.update(palBytes(p));
    agg['species.' + id] = { name: g.name, frontFrames: g.front.frames.length, sha1: h.digest('hex') };
  }
  const ht = crypto.createHash('sha1');
  for (let i = 0; i < S.TRAINER_FRONT_COUNT; i++) { const t = S.trainerFront(rom, i); ht.update(t.bitmap.pixels); ht.update(palBytes(t.palette)); }
  agg['trainer.fronts'] = { count: S.TRAINER_FRONT_COUNT, sha1: ht.digest('hex') };
  const hb = crypto.createHash('sha1'); let backFrames = 0;
  for (let i = 0; i < S.TRAINER_BACK_COUNT; i++) { const t = S.trainerBack(rom, i); backFrames += t.frames.length; for (const f of t.frames) hb.update(f.pixels); hb.update(palBytes(t.palette)); }
  agg['trainer.backs'] = { count: S.TRAINER_BACK_COUNT, frames: backFrames, sha1: hb.digest('hex') };
  const hh = crypto.createHash('sha1');
  for (let i = 0; i < S.TRAINER_HEAD_COUNT; i++) { const t = S.trainerHead(rom, i); hh.update(t.bitmap.pixels); hh.update(palBytes(t.palette)); }
  agg['trainer.heads'] = { count: S.TRAINER_HEAD_COUNT, sha1: hh.digest('hex') };
  // trainer back frame counts agree with the data-pointer spacing (independent check of the y_offset field)
  const ptrs = []; for (let i = 0; i < 8; i++) ptrs.push({ i, p: (rom[S.TRAINER_BACK_TABLE + i * 24 + 4] | rom[S.TRAINER_BACK_TABLE + i * 24 + 5] << 8 | rom[S.TRAINER_BACK_TABLE + i * 24 + 6] << 16) });
  ptrs.sort((a, b) => a.p - b.p);
  let spacingOk = true;
  for (let k = 0; k + 1 < ptrs.length; k++) if ((ptrs[k + 1].p - ptrs[k].p) / 0x800 !== S.trainerBack(rom, ptrs[k].i).frames.length) spacingOk = false;
  ok(spacingOk, 'trainer back frame counts equal data-pointer spacing / 0x800 (7 of 8 entries checkable)');
}
const goldenNew = { rom: { sha256: U.ROM_SHA256, md5: U.ROM_MD5, length: U.ROM_LENGTH }, note: 'HASHES ONLY. sha1 of width,height (u32le) + indexed pixels + palette (u16le) + meta; no ROM-derived pixels are stored here.', assets: hashes, aggregates: agg };
function compareToGolden(g) {
  let bad = 0;
  for (const k of Object.keys(g.assets)) if (!hashes[k] || hashes[k].sha1 !== g.assets[k].sha1 || hashes[k].width !== g.assets[k].width || hashes[k].height !== g.assets[k].height) bad++;
  for (const k of Object.keys(hashes)) if (!g.assets[k]) bad++;
  for (const k of Object.keys(g.aggregates)) if (!agg[k] || agg[k].sha1 !== g.aggregates[k].sha1) bad++;
  return bad;
}
if (UPDATE || !fs.existsSync(GOLDEN)) { fs.writeFileSync(GOLDEN, JSON.stringify(goldenNew, null, 1) + '\n'); console.log('wrote golden', GOLDEN); }
const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
ok(compareToGolden(golden) === 0, 'all asset + species + trainer hashes equal ui_assets.golden.json', compareToGolden(golden) + ' differ');
ok(Object.keys(golden.assets).length === mani.length, 'golden has one entry per manifest asset');
{ // the comparison itself must be able to fail
  const t = JSON.parse(JSON.stringify(golden)); const k0 = Object.keys(t.assets)[3]; t.assets[k0].sha1 = '0'.repeat(40);
  ok(compareToGolden(t) === 1, 'negative control: a tampered golden entry is detected');
  const t2 = JSON.parse(JSON.stringify(golden)); t2.aggregates['species.all'].sha1 = '1'.repeat(40);
  ok(compareToGolden(t2) === 1, 'negative control: a tampered aggregate is detected');
}

/* ---- 3. mutants: flip a byte inside an asset -> that asset's hash changes -------------------------- */
function mutOffset(m) {
  const o = m.offsets;
  if (o.glyphs !== undefined) return o.glyphs + 0xBB * 64 + 1;                 // a pixel-row byte of glyph 'A'
  if (o.palette !== undefined) return o.palette + 2;
  if (o.record !== undefined) { const p = (rom[o.record + 16] | rom[o.record + 17] << 8 | rom[o.record + 18] << 16); return p + 2; }
  throw new Error('no mutation offset for ' + m.key);
}
let mutOk = 0, mutTotal = 0, twinOk = 0;
for (const m of mani) {
  const off = mutOffset(m);
  const mut = rom.slice(); mut[off] ^= 0x55;
  const a = load(mut).get(m.key);
  mutTotal++;
  if (assetHash(a) !== hashes[m.key].sha1) mutOk++; else console.log('MUTANT SURVIVED', m.key, off.toString(16));
  const twin = load(rom.slice()).get(m.key);
  if (assetHash(twin) === hashes[m.key].sha1) twinOk++;
}
ok(mutOk === mutTotal, 'mutants: one flipped ROM byte changes the hash of every asset (' + mutOk + '/' + mutTotal + ')');
ok(twinOk === mutTotal, 'unmutated twins keep their hash (' + twinOk + '/' + mutTotal + ')');
{ // raw tile mutants (not palette): hp bar strip tile byte, and a smol sheet bitstream byte
  const m1 = mani.find((m) => m.key === 'healthbox.hpGreen');
  const mut = rom.slice(); mut[m1.offsets.tiles + 5 * 32 + 28] ^= 0x0F;
  ok(assetHash(load(mut).get('healthbox.hpGreen')) !== hashes['healthbox.hpGreen'].sha1, 'mutant: a hp-bar tile byte changes healthbox.hpGreen');
  const m2 = mani.find((m) => m.key === 'icon.types');
  const mut2 = rom.slice(); mut2[m2.offsets.sheet + 8 + 24 + 100] ^= 0xFF;
  let r2; try { r2 = assetHash(load(mut2).get('icon.types')) !== hashes['icon.types'].sha1; } catch (e) { r2 = true; }
  ok(r2, 'mutant: a smol bitstream byte makes icon.types throw or change');
}

/* ---- 3b. healthbox elements are assembled ACROSS tile boundaries (the verifier's HP-label defect) ---- */
// The ROM stores the HP label, the HP/EXP fill steps and the status labels as a vertical column of 8-px-wide art in
// which every element starts part-way down a tile and spills into the next. Drawn tile-by-tile they are fragments
// (floating dashes, a bar with no bottom border, a label that is not "HP"). These checks state what a coherent element
// looks like in terms of structure only (which rows are border, shadow, clear; where the fill is) - no pixel art is
// stored here - and a flat tile-by-tile decode, an off-by-one phase and a tail read from the following file must all
// violate them, while the real decode and an unmutated twin must not.
const ELEMENT_SPEC = {   // key -> [count, phase, fillIdxRow(A), fillIdxRow(B)]
  'healthbox.hpGreen': [9, 4], 'healthbox.hpYellow': [9, 4], 'healthbox.hpRed': [9, 4], 'healthbox.expBar': [9, 3], 'healthbox.hpLabel': [2, 4],
  'healthbox.status1': [18, 3], 'healthbox.status2': [18, 3], 'healthbox.status3': [18, 3], 'healthbox.status4': [18, 3],
};
function elementFindings(get) {
  const f = [];
  const t = (n, c) => { if (!c) f.push(n); };
  const row = (a, e, r) => Array.from(a.pixels.subarray(r * a.width + e * 8, r * a.width + e * 8 + 8));
  const all = (arr, v) => arr.every((x) => x === v);
  for (const [key, fa, fb] of [['hpGreen', 10, 11], ['hpYellow', 13, 12], ['hpRed', 15, 14]]) {
    const a = get('healthbox.' + key);
    for (let e = 0; e < 9; e++) {
      const tag = key + '[' + e + ']';
      t(tag + ' rows 0,1,4,5 are the dark border', [0, 1, 4, 5].every((r) => all(row(a, e, r), 1)));
      t(tag + ' row 6 is the shadow row', all(row(a, e, 6), 3));
      t(tag + ' row 7 is the clear separator row', all(row(a, e, 7), 0));
      t(tag + ' row 2 has exactly ' + e + ' fill px then track', row(a, e, 2).every((v, x) => v === (x < e ? fa : 7)));
      t(tag + ' row 3 has exactly ' + e + ' fill px then track', row(a, e, 3).every((v, x) => v === (x < e ? fb : 2)));
    }
  }
  { const a = get('healthbox.expBar');
    for (let e = 0; e < 9; e++) {
      const tag = 'expBar[' + e + ']';
      t(tag + ' rows 2 and 5 are the dark border', all(row(a, e, 2), 1) && all(row(a, e, 5), 1));
      t(tag + ' row 7 is the clear separator row', all(row(a, e, 7), 0));
      t(tag + ' rows 3/4 have exactly ' + e + ' fill px then track', row(a, e, 3).every((v, x) => v === (x < e ? 9 : 3)) && row(a, e, 4).every((v, x) => v === (x < e ? 11 : 6)));
    } }
  { const a = get('healthbox.hpLabel');
    for (let e = 0; e < 2; e++) {
      const ink = (r) => row(a, e, r).filter((v) => v === 12).length;
      t('hpLabel[' + e + '] rows 5,6,7 carry no letter ink (border / shadow / clear)', ink(5) + ink(6) + ink(7) === 0 && ink(0) === 0);
      t('hpLabel[' + e + '] row 7 is clear', all(row(a, e, 7), 0));
      t('hpLabel[' + e + '] has letter ink in rows 1..4', ink(1) + ink(2) + ink(3) + ink(4) > 10);
    } }
  for (let k = 1; k <= 4; k++) {
    const a = get('healthbox.status' + k);
    let bg = 0;
    for (let e = 0; e < 18; e++) {
      t('status' + k + '[' + e + '] rows 0 and 7 are the dark border', all(row(a, e, 0), 1) && all(row(a, e, 7), 1));
      for (let r = 1; r <= 6; r++) for (const v of row(a, e, r)) if (v === 11 + k) bg++;
    }
    t('status' + k + ' uses background colour index ' + (11 + k) + ' heavily', bg > 300);
  }
  return f;
}
{
  const f1 = elementFindings((k) => ui.get(k)), f2 = elementFindings((k) => load(rom.slice()).get(k));
  ok(f1.length === 0, 'healthbox elements: the real decode satisfies every structural invariant', f1.slice(0, 4).join('; '));
  ok(f2.length === 0, 'healthbox elements: an unmutated twin stays quiet');
  const mani2 = U.manifest();
  const build = (phaseDelta, tailOf, only) => (key) => {
    const real = ui.get(key);
    if (only && !only.includes(key)) return real;
    const m = mani2.find((x) => x.key === key), spec = ELEMENT_SPEC[key];
    if (!spec) return real;
    const b = U.stackedElements(rom, m.offsets.tiles, spec[0], Math.max(0, spec[1] + phaseDelta), tailOf ? tailOf(m, spec) : m.offsets.tail);
    return { width: b.width, height: b.height, pixels: b.pixels, palette: real.palette };
  };
  const flatGet = (key) => { const m = mani2.find((x) => x.key === key), b = U.stackedElements(rom, m.offsets.tiles, ELEMENT_SPEC[key] ? ELEMENT_SPEC[key][0] : 1, 0, m.offsets.tiles); return ELEMENT_SPEC[key] ? { width: b.width, height: b.height, pixels: b.pixels } : ui.get(key); };
  const mutants = {
    'flat tile-by-tile decode (the shipped defect)': flatGet,
    'phase one row too late': build(+1),
    'phase one row too early': build(-1),
    'the green strip reads its bottom rows from the FOLLOWING file': build(0, (m) => m.offsets.tiles + 9 * 32, ['healthbox.hpGreen']),
  };
  for (const [name, g] of Object.entries(mutants)) { const r = elementFindings(g); if (process.env.ARENA_VERBOSE) console.log('  mutant', name, '->', r.length, 'findings, first:', r[0]); ok(r.length > 0, 'healthbox elements: mutant "' + name + '" is caught', r.length ? r[0] : 'NOT CAUGHT'); }
  // the label's two halves really are continuous across the tile boundary: stroke pixels of H's lower rows sit directly
  // under stroke pixels of its upper rows (the property that makes it one letter, not two fragments)
  { const a = ui.get('healthbox.hpLabel'); const col = (e, x) => [1, 2, 3, 4].map((r) => a.pixels[r * a.width + e * 8 + x] === 12);
    const stem = [3, 4, 6, 7].filter((x) => col(0, x).filter(Boolean).length >= 4);
    ok(stem.length >= 2, 'healthbox.hpLabel: the H has full-height stems (>= 2 columns inked in all of rows 1..4)', 'stem columns ' + stem.join(',')); }
}

/* ---- 4. fonts / text --------------------------------------------------------------------------- */
{
  const f = ui.font('normal');
  ok(f.info.maxLetterHeight === 16 && f.info.maxLetterWidth === 6, 'normal font FontInfo read from ROM (6x16)', JSON.stringify(f.info));
  ok(ui.measureText('normal', 'What will PIKACHU do?') === 111, 'measureText("What will PIKACHU do?") == 111 px', String(ui.measureText('normal', 'What will PIKACHU do?')));
  ok(ui.measureText('normal', 'A') > 0 && ui.measureText('normal', 'W') > 0, 'glyph widths come from the ROM table');
  const t = ui.drawText('normal', 'What will PIKACHU do?');
  let ink = 0; for (const v of t.pixels) if (v === 1) ink++;
  ok(ink > 100, 'drawText produces foreground pixels (' + ink + ')');
  ok(new Set(Array.from(t.pixels)).size === 3, 'drawText uses exactly the roles 0, 1, 2');
  throws(() => U.encodeText('\u00e7'), 'encodeText rejects a character with no Gen-3 code', U.UiAssetError);
  throws(() => U.encodeText('{NOPE}'), 'encodeText rejects an unknown token', U.UiAssetError);
  const wm = ui.get('font.normal').meta;
  ok(wm.length === 512 && wm[0xBB] === f.width(0xBB), 'font asset meta carries the 512 width bytes');
  ok(U.decodeGen3String(rom, S.speciesSlot(rom, 25) + 0x33, 13) === 'Pikachu', 'species names decode through the charset map (Pikachu)');
  ok(U.decodeGen3String(rom, S.speciesSlot(rom, 150) + 0x33, 13) === 'Mewtwo', 'species names decode (Mewtwo)');
  // bar renderer: filled pixels are exact
  const bar = ui.renderBar('hpGreen', 30, 6);
  const strip = ui.get('healthbox.hpGreen');
  const full = ui.renderBar('hpGreen', 48, 6), empty = ui.renderBar('hpGreen', 0, 6);
  ok(Buffer.compare(Buffer.from(full.pixels.subarray(0, 8)), Buffer.from(strip.pixels.subarray(8 * 8, 8 * 8 + 8))) === 0, 'renderBar: tile 0 of a full bar is the fill-8 tile');
  ok(Buffer.compare(Buffer.from(empty.pixels.subarray(0, 8)), Buffer.from(strip.pixels.subarray(0, 8))) === 0, 'renderBar: an empty bar is the fill-0 tile');
  ok(Buffer.compare(Buffer.from(bar.pixels), Buffer.from(full.pixels)) !== 0 && Buffer.compare(Buffer.from(bar.pixels), Buffer.from(empty.pixels)) !== 0, 'renderBar: a partial bar differs from full and empty');
}

/* ---- 5. window templates read from the ROM ---------------------------------------------------- */
{
  const w = ui.windowTemplates();
  ok(w.length >= 12 && w[0].left === 2 && w[0].top === 15 && w[0].width === 26 && w[0].height === 4, 'window template 0 (message) = x2 y15 26x4');
  ok(w[2].left === 17 && w[2].top === 35 && w[2].width === 12 && w[2].height === 4, 'window template 2 (action menu) = x17 y35 12x4');
}

/* ---- 6. portability: no node:/Buffer/require in the library modules ------------------------------ */
for (const n of ['gfxcodec.js', 'uiassets.js', 'speciesgfx.js']) {
  const src = fs.readFileSync(path.join(root, 'pokemonarena', 'js', n), 'utf8').replace(/\/\/.*$/gm, '');
  ok(!/node:|require\(|\bBuffer\b|\bprocess\./.test(src), n + ' has no node:/require/Buffer/process (browser-portable)');
}

/* ---- 7. PNG proofs ------------------------------------------------------------------------------ */
{
  const C = G;
  const rgbaOf = (bm, pal, o) => C.bitmapToRGBA(bm, pal, o);
  const png = (name, c, k) => { const s = scaleRGBA(c.width, c.height, c.rgba, k || 1); writePNG(path.join(OUT, name), s.width, s.height, s.rgba); };
  const tc = ui.textColors();
  // fonts: all glyphs of the normal font
  { const a = ui.get('font.normal'); const cols = [[255, 255, 255, 255], [24, 24, 24, 255], [168, 168, 184, 255]]; const rgba = new Uint8Array(a.width * a.height * 4); for (let i = 0; i < a.pixels.length; i++) { const c = cols[a.pixels[i]]; rgba[4 * i] = c[0]; rgba[4 * i + 1] = c[1]; rgba[4 * i + 2] = c[2]; rgba[4 * i + 3] = 255; } png('font_normal_all.png', { width: a.width, height: a.height, rgba }, 2); }
  // required proof string on the ROM's message box
  { const c = newCanvas(240, 48, [0, 0, 0, 255]); blit(c, 0, 0, 240, 48, ui.rgba(ui.get('textbox.message'), { transparent0: false })); const t = ui.renderText('normal', 'What will PIKACHU do?', { fg: tc[0xC], shadow: tc[0xF] }); blit(c, 16, 17, t.width, t.height, t.rgba); png('proof_text.png', c, 4); }
  // font comparison rows
  { const rows = ['small', 'normal', 'short', 'narrow', 'smallNarrow']; const c = newCanvas(260, rows.length * 20, [255, 255, 255, 255]); rows.forEach((n, i) => { const t = ui.renderText(n, 'What will PIKACHU do? 0123 {LV}50 {PP}', { fg: [24, 24, 24], shadow: [208, 208, 200] }); blit(c, 2, i * 20 + 2, t.width, t.height, t.rgba); }); png('proof_fonts.png', c, 4); }
  // battle screen: env 9 + the ROM windows + ROM font
  { const env = ui.get('env.9'); const c = newCanvas(240, 160, [112, 184, 248, 255]); blit(c, 0, 0, 240, 160, ui.rgba(env));
    const act = ui.get('textbox.actionMenu'); blit(c, 0, 112, 240, 48, ui.rgba(act, { transparent0: false }));
    const w = ui.windowTemplates(); const w1 = w[1], w2 = w[2];
    fillRect(c, w2.left * 8, 112 + (w2.top - 34) * 8, w2.width * 8, w2.height * 8, [...tc[0xE], 255]);
    fillRect(c, w1.left * 8, 112 + (w1.top - 34) * 8, w1.width * 8, w1.height * 8, [...tc[0xE], 255]);
    const put = (win, dx, dy, s) => { const t = ui.renderText('normal', s, { fg: tc[0xC], shadow: tc[0xF] }); blit(c, win.left * 8 + dx, 112 + (win.top - 34) * 8 + dy, t.width, t.height, t.rgba); };
    put(w1, 2, 1, 'What will'); put(w1, 2, 17, 'PIKACHU do?'); put(w2, 10, 1, 'FIGHT'); put(w2, 58, 1, 'BAG'); put(w2, 10, 17, 'POK{E}MON'); put(w2, 58, 17, 'RUN'); put(w2, 2, 1, '{CURSOR}');
    png('proof_battle.png', c, 4); }
  // bars + status strips
  { const items = []; const add = (k, o) => { const a = ui.get(k); items.push({ width: a.width, height: a.height, rgba: ui.rgba(a, o) }); };
    for (const k of ['healthbox.hpGreen', 'healthbox.hpYellow', 'healthbox.hpRed', 'healthbox.expBar', 'healthbox.hpLabel']) add(k, { transparent0: false });
    for (const [kind, px, tw] of [['hpGreen', 48, 6], ['hpGreen', 30, 6], ['hpYellow', 17, 6], ['hpRed', 6, 6], ['exp', 40, 8]]) { const b = ui.renderBar(kind, px, tw); items.push({ width: b.width, height: b.height, rgba: C.bitmapToRGBA(b, b.palette, { transparent0: false }) }); }
    const s = gridSheet(items, 1, 4, 6, [200, 200, 200, 255]); writePNG(path.join(OUT, 'hp_bar_tiles.png'), s.width, s.height, s.rgba); }
  { const items = []; for (const k of ['healthbox.singlesPlayer', 'healthbox.singlesOpponent', 'healthbox.doublesPlayer', 'healthbox.doublesOpponent', 'healthbox.safari']) { const a = ui.get(k); items.push({ width: a.width, height: a.height, rgba: ui.rgba(a) }); }
    const s = gridSheet(items, 2, 3, 6, [110, 150, 110, 255]); writePNG(path.join(OUT, 'healthbox_sheets.png'), s.width, s.height, s.rgba); }
  { const items = []; for (const k of ['icon.types', 'icon.category', 'icon.status', 'battle.ballStatusBar']) { const a = ui.get(k); items.push({ width: a.width, height: a.height, rgba: ui.rgba(a) }); }
    const s = gridSheet(items, 4, 3, 6, [110, 150, 110, 255]); writePNG(path.join(OUT, 'icons_types_category_status.png'), s.width, s.height, s.rgba); }
  { const items = []; for (const k of ['healthbox.status1', 'healthbox.status2', 'healthbox.status3', 'healthbox.status4']) { const a = ui.get(k); items.push({ width: a.width, height: a.height, rgba: ui.rgba(a, { transparent0: false }) }); }
    const s = gridSheet(items, 1, 6, 6, [110, 150, 110, 255]); writePNG(path.join(OUT, 'healthbox_status_strips.png'), s.width, s.height, s.rgba); }
  { const items = []; for (const k of ['textbox.message', 'textbox.actionMenu', 'textbox.moves']) { const a = ui.get(k); items.push({ width: a.width, height: a.height, rgba: ui.rgba(a, { transparent0: false }) }); }
    const s = gridSheet(items, 1, 3, 6, [110, 150, 110, 255]); writePNG(path.join(OUT, 'textbox_regions.png'), s.width, s.height, s.rgba); }
  { const items = []; for (const i of U.ENV_INDICES) { const a = ui.get('env.' + i); items.push({ width: a.width, height: a.height, rgba: ui.rgba(a) }); }
    const s = gridSheet(items, 5, 1, 4, [60, 60, 90, 255]); writePNG(path.join(OUT, 'battle_envs.png'), s.width, s.height, s.rgba); }
  // species sheet: for each id: front f0, shiny front, back, shiny back, icon f0/f1 normal, icon shiny
  for (const id of [1, 25, 150, 249, 250]) {
    const g = S.speciesGfx(rom, id); const items = [];
    const bm = (b, pal) => ({ width: b.width, height: b.height, rgba: rgbaOf(b, pal) });
    for (const f of g.front.frames) items.push(bm(f, g.palettes.normal));
    items.push(bm(g.front.frames[0], g.palettes.shiny)); items.push(bm(g.back.frames[0], g.palettes.normal)); items.push(bm(g.back.frames[0], g.palettes.shiny));
    items.push(bm(g.icon.frames[0], g.palettes.icon)); items.push(bm(g.icon.frames[1], g.palettes.icon)); items.push(bm(g.icon.frames[0], g.palettes.iconShiny));
    const s = gridSheet(items, items.length, 3, 6, [110, 150, 110, 255]); writePNG(path.join(OUT, 'species_' + String(id).padStart(4, '0') + '_' + g.name + '.png'), s.width, s.height, s.rgba);
  }
  { const items = []; for (let i = 0; i < 24; i++) { const t = S.trainerFront(rom, i); items.push({ width: 64, height: 64, rgba: rgbaOf(t.bitmap, t.palette) }); }
    for (let i = 0; i < 8; i++) { const t = S.trainerBack(rom, i); items.push({ width: 64, height: 64, rgba: rgbaOf(t.frames[0], t.palette) }); }
    for (let i = 0; i < 8; i++) { const t = S.trainerHead(rom, i); items.push({ width: 64, height: 64, rgba: rgbaOf(t.bitmap, t.palette) }); }
    const s = gridSheet(items, 8, 2, 4, [110, 150, 110, 255]); writePNG(path.join(OUT, 'trainers_fronts_backs_heads.png'), s.width, s.height, s.rgba); }
  ok(fs.existsSync(path.join(OUT, 'proof_text.png')) && fs.statSync(path.join(OUT, 'proof_text.png')).size > 500, 'proof PNGs written to ' + OUT);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed (' + (Date.now() - t0) + ' ms)');
if (fail) { console.log('FAILURES:\n  ' + failures.join('\n  ')); process.exit(1); }

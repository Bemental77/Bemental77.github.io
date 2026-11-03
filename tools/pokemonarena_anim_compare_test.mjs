// tools/pokemonarena_anim_compare_test.mjs -- tests of the real-game comparison machinery (tools/pokemonarena_anim_oracle_compare.mjs, _scenarios.mjs, _batch.mjs).
//   node tools/pokemonarena_anim_compare_test.mjs
// No emulator is needed: a "real" capture is MADE from the engine itself, in the real game's capture convention (frame 0 = the launching iteration, frame k = the state after
// iteration k = the engine's step k-1), and then damaged in known ways. The comparison must see no difference in the undamaged copy and must see every injected one --
// that is the negative control of the whole real-game verification (a comparison that cannot fail proves nothing).
// Exits non-zero on any failure. Skips loudly (exit 0) when the ROM is absent.
import fs from 'node:fs';
import zlib from 'node:zlib';
import { createMoveAnimator, AD, Engine } from '../pokemonarena/js/move_anim.js';
import { compareMove } from './pokemonarena_anim_oracle_compare.mjs';
import { envCtx, packCapture, unpackCapture, LADDER, SCENARIOS, FOE_SPECIES } from './pokemonarena_anim_oracle_scenarios.mjs';

const ROM_PATH = process.env.ARENA_ROM || 'gba/gbaWasm/roms/Pokemon SoulGold (v1.1.1).gba';
if (!fs.existsSync(ROM_PATH)) { console.log('SKIPPED: ROM not found at ' + ROM_PATH); process.exit(0); }
const rom = new Uint8Array(fs.readFileSync(ROM_PATH));
let pass = 0, fail = 0;
const ok = (c, name, detail = '') => { if (c) pass++; else { fail++; console.log('  FAIL: ' + name + (detail ? ' -- ' + detail : '')); } return !!c; };
const an = await createMoveAnimator({ rom });
const mem = () => an.eng.mem;

/** A capture in the real game's convention made from the engine: arrays of Buffers, one per frame. */
function fakeReal(id, ctx = {}, species = [1289, 183], sides = [0, 1]) {
  const run = an.start('move', id, { attacker: { side: sides[0], species: species[sides[0]] }, target: { side: sides[1], species: species[sides[1]] }, bystander: { species: species[sides[0] ^ 1] }, seed: 1, ...ctx });
  const f = { spr: [], io: [], tasks: [], rng: [], bsi: [], blk: [] };
  const grab = () => {
    const m = mem();
    f.spr.push(Buffer.from(m.ewram.slice(AD.sprites & 0x3ffff, (AD.sprites & 0x3ffff) + 64 * 0x44)));
    f.io.push(Buffer.from(m.io.slice(0, 0x58))); f.tasks.push(Buffer.from(m.iwram.slice(0x5b34, 0x5b34 + 640)));
    const r = Buffer.alloc(0x28); for (let i = 0; i < 4; i++) { r.writeUInt32LE(m.read32(AD.rng2 + 4 * i), 8 + 4 * i); r.writeUInt32LE(m.read32(AD.rng1 + 4 * i), 0x18 + 4 * i); }
    f.rng.push(r); f.bsi.push(Buffer.from(m.ewram.slice(AD.battlerSpriteIds & 0x3ffff, (AD.battlerSpriteIds & 0x3ffff) + 4))); f.blk.push(Buffer.from(m.ewram.slice(0x18b4, 0x18b4 + 0x60)));
  };
  grab(); let n = 0; while (!run.done && n < 600) { run.step(); grab(); n++; }
  return f;
}
const clone = (f) => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.map((b) => Buffer.from(b))]));
const cmp = (f, id, extra = {}) => compareMove({ an, realSpr: f.spr, realBsi: f.bsi, realIo: f.io, realTasks: f.tasks, realBlk: f.blk, realRng: f.rng, moveId: id, ...extra });

console.log('== an undamaged capture compares identical');
const real = fakeReal(33);
{
  const r = await cmp(clone(real), 33);
  ok(r.exact === r.total && r.total > 20, `sprites: ${r.exact}/${r.total} frames equal`);
  ok(r.io.exact === r.io.total && r.io.shapeBad.length === 0, `I/O registers: ${r.io.exact}/${r.io.total} frames equal (strict buffered phase ${r.io.strict}: this capture is in the direct phase), shape differences [${r.io.shapeBad}]`);
  ok(r.tasks.exact === r.tasks.total, `tasks: ${r.tasks.exact}/${r.tasks.total}`);
  ok(r.blk.first === null && r.blk.same === r.blk.total, 'the script pointer and wait counter are equal on every frame');
  ok(r.lag.length === 0 && r.offset === -1 && r.end.delta === 0, `no lag frames, the canonical offset -1, the end on the same frame (delta ${r.end.delta})`);
}

console.log('== negative controls: every injected difference is seen');
{
  // a changed sprite word
  const f = clone(real); const k = 15; const ENV = new Set([0, 1, 2, 3, 4, 5, 9, 11, 60, 61, 62, 63]); const o = (() => { for (let i = 0; i < 64; i++) if (!ENV.has(i) && (f.spr[k][i * 0x44 + 0x3e] & 1)) return i; return -1; })();
  if (o > 0) f.spr[k].writeInt16LE(f.spr[k].readInt16LE(o * 0x44 + 0x2e) + 1, o * 0x44 + 0x2e);
  const r = await cmp(f, 33); ok(o > 0 && r.exact === r.total - 1 && r.mismatches.length === 1 && r.mismatches[0].k === k, 'one data word changed on one frame -> exactly that frame is a sprite mismatch', `${r.exact}/${r.total} ${JSON.stringify(r.mismatches.map((m) => m.k))}`);
  // a changed task
  const g = clone(real); const ti = (() => { for (let i = 0; i < 16; i++) if (g.tasks[10][i * 40 + 4] === 1) return i; return -1; })(); if (ti >= 0) g.tasks[10][ti * 40 + 8] ^= 1; const t = await cmp(g, 33); ok(t.tasks.exact === t.tasks.total - 1, 'a changed task word on one frame is seen', `${t.tasks.exact}/${t.tasks.total}`);
  // a different script position
  const h = clone(real); h.blk[12].writeUInt32LE(h.blk[12].readUInt32LE(0) + 1, 0); const b = await cmp(h, 33); ok(b.blk.first && b.blk.first.k === 12 && b.blk.same === b.blk.total - 1, 'a changed script pointer is seen at that frame', JSON.stringify(b.blk.first && b.blk.first.k));
  // the animation lasting longer in the real game: three more active frames at the end
  const e = clone(real); const n0 = e.blk.length; for (let i = 0; i < 3; i++) for (const key of Object.keys(e)) e[key].push(Buffer.from(e[key][e[key].length - 1])); for (let i = 0; i < 3; i++) { e.blk[n0 + i][5] = 1; e.rng[n0 + i].writeUInt32LE((e.rng[n0 + i].readUInt32LE(0x24) + 2 * (i + 1)) >>> 0, 0x24); } e.blk[n0 - 1][5] = 1;
  // the real script is now active on 4 frames the engine does not run (the post-end frame and the 3 appended)
  const en = await cmp(e, 33); ok(en.end.delta === -4, 'the end comparison reports the engine 4 frames short (the real script stayed active 4 frames longer)', JSON.stringify(en.end));
}

console.log('== lag frames: an iteration longer than a frame leaves half-done captures, dropped by the Random() counter');
{
  // duplicate frame 10 twice with an UNCHANGED sfc32 counter word: the real game was mid-iteration, nothing advanced
  const dup = (f, at, times, advance) => { const g = clone(f); for (let t = 0; t < times; t++) for (const key of Object.keys(g)) g[key].splice(at + 1, 0, Buffer.from(g[key][at])); if (advance) for (let i = at + 1; i < g.rng.length; i++) { const d = g.rng[i].readUInt32LE(0x24); g.rng[i].writeUInt32LE((d + 2 * times) >>> 0, 0x24); } return g; };
  const g = dup(real, 10, 2, false);
  const r = await cmp(g, 33); ok(JSON.stringify(r.lag) === '[11,12]' && r.exact === r.total, `two duplicated frames with a stalled counter are dropped as lag [${r.lag}] and the rest still matches ${r.exact}/${r.total}`);
  // negative control: the same duplicates WITHOUT lag detection (no realRng) are a mismatch
  const n = await compareMove({ an, realSpr: g.spr, realBsi: g.bsi, realIo: g.io, realTasks: g.tasks, realBlk: g.blk, moveId: 33 });
  ok(n.lag.length === 0 && (n.exact < n.total || n.offset !== -1), 'negative control: without the counter the duplicates are not recognised as lag (the comparison is thrown off)', `${n.exact}/${n.total} offset ${n.offset}`);
  // negative control 2: a frame in which the counter DID advance is a real frame, not lag: kept (the comparison then sees its content as extra)
  const a = dup(real, 10, 1, true); const ra = await cmp(a, 33); ok(ra.lag.length === 0 && ra.exact < ra.total, 'negative control: a duplicate whose counter advanced is kept (not lag) and is a mismatch', `${ra.exact}/${ra.total} lag [${ra.lag}]`);
}

console.log('== I/O registers: per-frame phase, one-frame transients and real differences');
{
  // BLDCNT (0x50) shows a different value for ONE frame (an iteration that straddled a VBlank): the per-frame count sees it, the shape comparison does not
  let at = -1; for (let k = 5; k < real.io.length - 2; k++) if (real.io[k].readUInt16LE(0x50) !== real.io[k + 1].readUInt16LE(0x50)) { at = k; break; }
  const f = clone(real); const k = at > 0 ? at : 12; f.io[k].writeUInt16LE(0x3f40, 0x50);
  const r = await cmp(f, 33); ok(r.io.exact < r.io.total && r.io.shapeBad.length === 0, 'a one-frame transient in BLDCNT fails the per-frame count but not the shape comparison (values held < 3 frames are below its resolution)', `${r.io.exact}/${r.io.total} shapeBad [${r.io.shapeBad}]`);
  // a register that holds a different value for 4 frames is a real difference
  const g = clone(real); for (let i = 8; i < 12; i++) g.io[i].writeUInt16LE(0x1234, 0x52);
  const s = await cmp(g, 33); ok(s.io.shapeBad.includes(0x52), 'negative control: BLDALPHA holding another value for 4 frames is a shape difference', `[${s.io.shapeBad}]`);
  // the BG scroll registers are 9 bits wide on the real chip: the high bits of the engine's raw value must not count as a difference
  const h = clone(real); for (let i = 0; i < h.io.length; i++) h.io[i].writeUInt16LE((h.io[i].readUInt16LE(0x10) | 0xfe00) & 0xffff, 0x10);
  const w = await cmp(h, 33); ok(w.io.exact === w.io.total, 'BG0HOFS is compared modulo 9 bits (real core masks the write)', `${w.io.exact}/${w.io.total}`);
}

console.log('== who attacks whom: the real game\'s own animation block decides');
{
  // Mist targets its user: attacker and target on the SAME side. Its mist sprite sits 8 px lower than for a foe target (measured), so the comparison fails if the sides are not honoured.
  const self = fakeReal(54, {}, [1289, 183], [0, 0]);
  const r = await cmp(clone(self), 54); ok(r.exact === r.total && r.total > 100, `self-targeting Mist: ${r.exact}/${r.total} (sides taken from the block: attacker ${self.blk[0][0x22]}, target ${self.blk[0][0x21]})`);
  const flipped = clone(self); for (const b of flipped.blk) b[0x21] = 1;
  const s = await cmp(flipped, 54); ok(s.exact < s.total, 'negative control: telling the comparison the target was the foe makes it differ (the engine now places the mist 8 px higher)', `${s.exact}/${s.total}`);
}

console.log('== environment: what the real battle looked like before the animation, as engine options');
{
  const cap = {
    started: 1, anim: [{ bsi: Buffer.from([7, 9, 0, 0]), spr: (() => { const b = Buffer.alloc(64 * 0x44); for (const i of [0, 1, 7, 9, 30, 63]) b[i * 0x44 + 0x3e] = 1; return b; })(), rng: (() => { const b = Buffer.alloc(0x28); b.writeUInt32LE(5, 0x18); return b; })() }],
    rngPrev: (() => { const b = Buffer.alloc(0x28); b.writeUInt32LE(0xaabbccdd, 8); return b; })(), ioPrev: (() => { const b = Buffer.alloc(0x58); b.writeUInt16LE(0x3f40, 0); b.writeUInt16LE(0x5e02, 0x0c); return b; })(), varsPrev: Buffer.alloc(0x18, 1),
    env0: { tags: (() => { const b = Buffer.alloc(32, 0xff); b.writeUInt16LE(0xd6ff, 8); return b; })(), reserved: 4, terrain: 9, btf: 4, mons: (() => { const b = Buffer.alloc(2 * 0x98); b.writeUInt16LE(1289, 0); b.writeUInt16LE(11, 0x2a); b.writeUInt16LE(30, 0x2e); b[0x2c] = 5; b.writeUInt16LE(19, 0x98); return b; })(), animSpecies: Buffer.alloc(8), tileBitmap: Buffer.alloc(128, 0xff) },
  };
  const c = envCtx(cap, 9);
  ok(JSON.stringify(c.battlerSlots) === '[7,9]' && JSON.stringify(c.occupiedSlots) === '[0,1,30,63]', 'envCtx: battler slots from the real battlerSpriteIds, the other occupied gSprites slots from the sprite array', JSON.stringify([c.battlerSlots, c.occupiedSlots]));
  ok(c.paletteTags[4] === 0xd6ff && c.paletteTags[0] === 0xffff && c.reservedPalettes === 4 && c.battleTypeFlags === 4 && c.terrain === 9 && c.hour === 22, 'envCtx: palette tags, reserved palettes, battle type flags, terrain and the oracle\'s clock (hour 22)');
  ok(c.rng2[0] === 0xaabbccdd && c.rng1[0] === 5 && c.io[0x00] === 0x3f40 && c.io[0x0c] === 0x5e02 && c.battleMons[0].species === 1289 && c.battleMons[0].hp === 11 && c.battleMons[0].maxHP === 30 && c.battleMons[1].species === 19 && c.battleVars.length === 12, 'envCtx: Random2 state from the frame before the launch, Random() state, registers, battle mons, BG / window variables');
  // the engine really applies them
  const run = an.start('move', 33, { attacker: { side: 0, species: 1289 }, target: { side: 1, species: 183 }, ...c });
  const m = mem(), used = []; for (let i = 0; i < 64; i++) if (m.ewU8(AD.sprites + i * 0x44 + 0x3e) & 1) used.push(i);
  ok(used.join(',') === '0,1,7,9,30,63' && m.ewU8(AD.battlerSpriteIds) === 7 && m.ewU8(AD.battlerSpriteIds + 1) === 9, 'the engine puts the battlers at the real slots (7, 9) and holds exactly the real occupied slots', used.join(',') + ' ' + m.ewU8(AD.battlerSpriteIds));
  ok(m.ewU32(AD.battleTypeFlags) === 4 && m.ewU16(AD.battleMons + 0x2a) === 11, 'the engine applies the battle type flags and the battle mons');
  ok(run.ioBeforeLaunch[0] === 0x40 && run.ioBeforeLaunch[1] === 0x3f, 'run.ioBeforeLaunch holds the registers as the battle left them (DISPCNT 0x3f40)');
}

console.log('== scenarios and capture packing');
{
  ok(LADDER.every((n) => typeof SCENARIOS[n] === 'function' && FOE_SPECIES[n] > 0), `every scenario in the ladder (${LADDER.join(', ')}) has a setup function and a foe species`);
  ok(LADDER[0] === 'trainer' && LADDER.includes('wild') && LADDER.includes('wild2') && LADDER.includes('priorScratch'), 'the ladder starts with the scripted trainer battle and holds the wild / two-Pokemon / prior-turn scenarios the nine refused moves needed (18, 46, 50, 68, 82, 100, 102, 105, 119)');
  const cap = { started: 3, rngPrev: Buffer.from('abcdefghijklmnopqrstuvwxyz0123456789ABCD'), ioPrev: Buffer.alloc(0x58, 3), varsPrev: Buffer.alloc(0x18, 5), env0: { tags: Buffer.alloc(32, 1), reserved: 4, terrain: 2, btf: 12, mons: Buffer.alloc(0x130, 2), animSpecies: Buffer.alloc(8, 3), tileBitmap: Buffer.alloc(128, 4) }, anim: [{ f: 5, active: 1, io: Buffer.alloc(0x58, 6), tasks: Buffer.alloc(640, 7), rng: Buffer.alloc(0x28, 8), bsi: Buffer.from([9, 11, 0, 0]), spr: Buffer.alloc(64 * 0x44, 9), blk: Buffer.alloc(0x60, 10), pf: Buffer.alloc(0x20, 11) }] };
  const u = unpackCapture(zlib.gunzipSync(zlib.gzipSync(packCapture(cap, { scenario: 'wild', idle: 7, tries: 2, terrain: 0 }))).toString('utf8'));
  ok(u.meta.scenario === 'wild' && u.cap.started === 3 && Buffer.compare(u.cap.anim[0].spr, cap.anim[0].spr) === 0 && Buffer.compare(u.cap.env0.tileBitmap, cap.env0.tileBitmap) === 0 && Buffer.compare(u.cap.varsPrev, cap.varsPrev) === 0 && Buffer.compare(u.cap.anim[0].pf, cap.anim[0].pf) === 0, 'packCapture / unpackCapture round-trip every field (a cached real capture can be re-compared against a changed engine)');
}

console.log('== round 6: the FIELD comparison (tools/pokemonarena_anim_field_compare.mjs): the machinery sees a missing terrain fade, ignores the boxes, and is exact on an undamaged copy');
{
  const FC = await import('./pokemonarena_anim_field_compare.mjs');
  const { createBattleUi } = await import('../pokemonarena/js/battle_ui.js');
  const ui = createBattleUi(rom);
  // a "real" recording made from the engine itself (the terrain fades), then damaged: the fade switched off. Round 5's comparison compared sprites and registers only and could not see this.
  const rec = FC.engineFrames(an, ui, 85).frames, twin = FC.engineFrames(an, ui, 85).frames;
  ok(rec.length > 100 && rec.every((f, k) => FC.fieldDiff(f, twin[k]) === 0), 'an undamaged copy compares identical on every frame of the field (' + rec.length + ' frames of Thunderbolt)');
  const lumRec = rec.map(FC.patchLuminance), min = Math.min(...lumRec);
  ok(lumRec[0] === 196 && min >= 115 && min <= 123, 'the luminance series of the terrain patch dips from 196 to about 119 (the ROM blends the terrain toward black by 6 / 16)', 'start ' + lumRec[0] + ' min ' + min);
  const orig = Engine.prototype.baseFadeLut; Engine.prototype.baseFadeLut = () => null;
  let bad; try { bad = FC.engineFrames(an, ui, 85).frames; } finally { Engine.prototype.baseFadeLut = orig; }
  const worst = Math.max(...rec.map((f, k) => FC.fieldDiff(f, bad[k]))), lumBad = bad.map(FC.patchLuminance), lumGap = Math.max(...lumRec.map((v, k) => Math.abs(v - lumBad[k])));
  ok(worst > 13000 && worst <= FC.FIELD_PX, 'damaged copy (no terrain fade): the field difference is seen (up to ' + worst + ' of ' + FC.FIELD_PX + ' pixels in one frame)', String(worst));
  ok(lumGap >= 60 && Math.max(...lumBad) === 196 && Math.min(...lumBad) === 196, 'damaged copy: the terrain luminance stays at 196 where the recording dips (largest gap ' + lumGap + ')', lumBad.slice(0, 3).join(','));
  ok(rec.filter((f, k) => FC.fieldDiff(f, bad[k]) > 0).length > 200, 'the damage is seen on most frames, not one (a bound on the MEAN difference catches it)');
  // the boxes are not the animation: changing a pixel in a healthbox / the text window is invisible to the field comparison, one in the field is not
  const a = Uint8Array.from(rec[10]), b = Uint8Array.from(rec[10]); b[(150 * 240 + 100) * 4] ^= 255; b[(20 * 240 + 50) * 4 + 1] ^= 255; b[(90 * 240 + 200) * 4 + 2] ^= 255;
  ok(FC.fieldDiff(a, b) === 0, 'a difference inside the text window / the foe healthbox / the player healthbox is not counted');
  b[(60 * 240 + 100) * 4] ^= 255; ok(FC.fieldDiff(a, b) === 1, 'a difference in the field is counted (exactly one pixel)');
  ok(FC.FIELD_PX === 18496, 'the field is 18,496 pixels (240 x 112 less the two healthboxes)', String(FC.FIELD_PX));
}

console.log(`\npokemonarena_anim_compare_test: passed ${pass}, failed ${fail}`);
process.exit(fail === 0 ? 0 : 1);

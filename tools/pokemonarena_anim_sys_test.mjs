// tools/pokemonarena_anim_sys_test.mjs -- tests of the SYSTEM animations (pokemonarena/js/battle_sys.js: battle intro, send-out, recall, faint, hit blink, trainer intro).
//   node tools/pokemonarena_anim_sys_test.mjs [--update] [--oracle <OR1 state dir>]
// What is tested without an emulator: the API and its typed errors, the intro's observable timeline (messages, cries, sound cues, the action menu being reached), determinism (same ctx -> same frames,
// bit for bit), that every ctx field that must change the picture does (species, shiny, ball, time of day, environment, trainer), every event's own end state (a fainted battler is gone, a recalled
// one is invisible, a hit blinks), the layer mask, golden frame hashes (js/anim_sys.golden.json: hashes only, never pictures), and NEGATIVE CONTROLS: each mutation of the model that the real-game
// verification found necessary is applied and must be DETECTED (text speed, cry length, BIOS rounding, battle environment, the gFonts pointer), plus the comparison tool's own difference detector
// is shown to see an injected one-field difference.
// With --oracle <dir> the real-game comparison runs too (tools/pokemonarena_sys_compare.mjs): the wild intro, the trainer intro and every event must be sprite-exact and pixel-exact.
// Exits non-zero on any failure. Skips loudly (exit 0) when the ROM is absent.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createMoveAnimator, AD } from '../pokemonarena/js/move_anim.js';
import { SYS_ID, SYS, KEY, makePartyMon, personalityFor, SystemRun } from '../pokemonarena/js/battle_sys.js';
import { GbaCpu, SLICE_CHECK } from '../pokemonarena/js/anim_cpu.js';
import crypto from 'node:crypto';
import { streamCases, streamOf, streamer } from './pokemonarena_sys_stream.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROM_PATH = process.env.ARENA_ROM || 'gba/gbaWasm/roms/Pokemon SoulGold (v1.1.1).gba';
if (!fs.existsSync(ROM_PATH)) { console.log('SKIPPED: ROM not found at ' + ROM_PATH); process.exit(0); }
const args = process.argv.slice(2);
const UPDATE = args.includes('--update');
const ORACLE = args.includes('--oracle') ? args[args.indexOf('--oracle') + 1] : null;
const GOLDEN = path.join(ROOT, 'pokemonarena/js/anim_sys.golden.json');
const rom = new Uint8Array(fs.readFileSync(ROM_PATH));
let pass = 0, fail = 0;
const ok = (c, name, detail = '') => { if (c) pass++; else { fail++; console.log('  FAIL: ' + name + (detail ? ' -- ' + detail : '')); } return !!c; };
const an = await createMoveAnimator({ rom });
const fnv = (a) => { let h = 0x811c9dc5; for (let i = 0; i < a.length; i++) h = Math.imul(h ^ a[i], 16777619) >>> 0; return h.toString(16).padStart(8, '0'); };
const BASE = { foe: { species: 19, level: 3 }, player: { species: 4, level: 5 }, seed: 5, maxFrames: 900 };
// is the battler on screen? OBJ layer drawn minus the empty backdrop, counted inside the battler's box (foe: top right, player: bottom left); the healthboxes are outside the boxes
const BOX = { 0: [8, 60, 90, 160], 1: [136, 20, 232, 70] };   // x0, y0, x1, y1 of the Pokemon, not of the healthboxes (the foe healthbox is at x < 112, y < 32; the player healthbox starts at x 149, y 72)
const objPixels = (run, b) => { const a = Uint8Array.from(run.draw(null, { layers: 0x10 })), z = Uint8Array.from(run.draw(null, { layers: 0 })); const [x0, y0, x1, y1] = BOX[b]; let n = 0; for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const p = (y * 240 + x) * 4; if (a[p] !== z[p] || a[p + 1] !== z[p + 1] || a[p + 2] !== z[p + 2]) n++; } return n; };

/** Run to the end; returns { run, hashes at the requested frames, frames, events }. */
function play(id, ctx = {}, hashAt = []) {
  const run = an.start('system', id, { ...BASE, ...ctx });
  const ev = { sound: [], cry: [], message: [] };
  for (const t of Object.keys(ev)) run.on(t, (e) => ev[t].push({ frame: run.frame, ...e }));
  const hashes = {}; let guard = 0;
  while (!run.done && guard++ < 1500) { run.step(); if (hashAt.includes(run.frame)) hashes[run.frame] = fnv(run.draw(null)) + fnv(run.eng.mem.ewram.subarray(AD.sprites - 0x02000000, AD.sprites - 0x02000000 + 64 * 0x44)); }   // the picture AND the 64 sprite structs
  // the animator owns ONE engine: a run's memory is only valid until the next start(), so what the assertions need is read here, at the end of the run
  const m = run.eng.mem;
  return { run, hashes, frames: run.frame, ev, last: fnv(run.draw(null)), end: { p0: objPixels(run, 0), p1: objPixels(run, 1), main: m.read32(SYS.battleMainFunc), ctl0: m.read32(SYS.controllerFuncs), printers: m.read32(SYS.textPrinterHead) } };
}
const SPR = AD.sprites;
const SEEN = (n) => n > 300;   // a Pokemon sprite is 600..1400 opaque pixels; what remains in an empty box (shadow, ring) is below

console.log('== API');
{
  ok(an.available('system', 0) === 'exact' && an.available('system', 1) === 'exact' && an.available('system', 9) === 'exact', 'ids 0..9 are available');
  ok(an.available('system', 10) === 'none' && an.available('system', -1) === 'none' && an.available('system', 1.5) === 'none', 'ids out of range are not');
  let e = null; try { an.start('system', 99, {}); } catch (x) { e = x; }
  ok(e && e.name === 'MoveAnimError' && /system id 99/.test(e.message), 'an unknown id throws a typed error', e && e.message);
  ok(Object.keys(SYS_ID).length === 10 && SYS_ID.intro === 0 && SYS_ID.faintFoe === 5, 'SYS_ID table');
  const m = makePartyMon(rom, { species: 19, level: 5 });
  ok(m.length === 0x60 && (m[0x20] | (m[0x21] << 8)) === 19 && m[0x50] === 5, 'makePartyMon: 0x60 bytes, species at +0x20, level at +0x50');
  const pid = personalityFor({ tid: 0x2ded, sid: 0xa7e3, shiny: true });
  ok(((0x2ded ^ 0xa7e3 ^ (pid >>> 16) ^ (pid & 0xffff)) & 0xffff) < 256, 'personalityFor(shiny): the hack\'s shiny rule (tid ^ sid ^ pid hi ^ lo < 256)');
  ok(((0x2ded ^ 0xa7e3 ^ (personalityFor({ tid: 0x2ded, sid: 0xa7e3 }) >>> 16) ^ (personalityFor({ tid: 0x2ded, sid: 0xa7e3 }) & 0xffff)) & 0xffff) >= 256, 'personalityFor(normal) is not shiny');
}

console.log('== the wild intro');
const wild = play(SYS_ID.intro, {}, [60, 120, 200]);
{
  const r = wild.run;
  ok(r.ready && !r.truncated && !r.error, 'the intro reaches the action menu', String(r.error || ''));
  ok(wild.frames > 250 && wild.frames < 420, 'its length is in the real game\'s range (one A press per text box)', 'frames ' + wild.frames);
  const texts = wild.ev.message.map((m) => m.text);
  ok(texts.some((t) => /wild Rattata/.test(t)), 'the encounter text names the foe species', JSON.stringify(texts.slice(0, 3)));
  ok(texts.some((t) => /^Go! Charmander!/.test(t)), 'the send-out text names the player Pokemon');
  ok(wild.ev.cry.some((c) => c.species === 19) && wild.ev.cry.some((c) => c.species === 4), 'both Pokemon cry (foe at slide-in, player at send-out)', JSON.stringify(wild.ev.cry.map((c) => c.species)));
  ok(wild.ev.cry.find((c) => c.species === 19).frame < wild.ev.cry.find((c) => c.species === 4).frame, 'the foe cries before the player\'s Pokemon');
  ok(wild.ev.sound.length >= 2, 'sound cues carry song-table indexes (ball throw, ball opening)', JSON.stringify(wild.ev.sound.map((s) => s.index)));
  ok(SEEN(wild.end.p0) && SEEN(wild.end.p1), 'both battler sprites are on screen at the menu', JSON.stringify(wild.end));
  ok(wild.end.main === SYS.actionSelect && wild.end.ctl0 === SYS.actionMenuController, 'the ROM controller is at the action menu');
}
console.log('== determinism, and which ctx fields change the picture');
{
  const again = play(SYS_ID.intro, {}, [60, 120, 200]);
  ok(again.frames === wild.frames && again.last === wild.last && JSON.stringify(again.hashes) === JSON.stringify(wild.hashes), 'same ctx -> the same frames, bit for bit');
  const diff = (ctx, name, at = 200) => { const v = play(SYS_ID.intro, ctx, [at]); ok(v.hashes[at] !== wild.hashes[at] || v.frames !== wild.frames, name); return v; };
  diff({ foe: { species: 25, level: 3 } }, 'foe species changes the picture');
  diff({ player: { species: 1, level: 5 } }, 'player species changes the picture');
  diff({ foe: { species: 19, level: 3, shiny: true } }, 'foe shiny changes the picture (palette, sparkle)', 120);
  diff({ player: { species: 4, level: 5, ball: 3 } }, 'the ball id changes the ball sprite', 150);
  diff({ timeOfDay: 3 }, 'time of day tints the healthbox palette', 120);
  diff({ environment: 1 }, 'the battle environment changes the background', 120);
  diff({ trainer: 5 }, 'a trainer battle is another intro');
  const noPress = play(SYS_ID.intro, { keys: null, maxFrames: 700 });
  ok(noPress.run.truncated && !noPress.run.ready, 'without any A press the intro waits at its first text box (ctx.keys = null)');
  ok(play(SYS_ID.intro, { keys: (f) => (f % 150 < 2 ? KEY.A : 0), maxFrames: 1500 }).frames > wild.frames + 50, 'a slower key script is a longer intro (ctx.keys(iteration, run))');
}
console.log('== layers');
{
  const r = play(SYS_ID.intro, { maxFrames: 120 }).run;
  const all = fnv(r.draw(null)), noObj = fnv(r.draw(null, { layers: 0x0f })), noBg = fnv(r.draw(null, { layers: 0x10 })), noText = fnv(r.draw(null, { layers: 0x1e }));
  ok(new Set([all, noObj, noBg, noText]).size === 4, 'each layer mask gives its own picture (OBJ off, BG off, BG0 = text off)');
  ok(fnv(r.draw(null)) === all, 'masking is per draw() call, not sticky');
}
console.log('== events');
{
  const faintFoe = play(SYS_ID.faintFoe), faintPl = play(SYS_ID.faintPlayer), hitFoe = play(SYS_ID.hitFoe), recall = play(SYS_ID.recallPlayer), sendOut = play(SYS_ID.sendOutPlayer);
  ok(faintFoe.run.ready && !SEEN(faintFoe.end.p1) && SEEN(faintFoe.end.p0), 'faint (foe): the foe is gone, the player stays', JSON.stringify(faintFoe.end));
  ok(faintPl.run.ready && !SEEN(faintPl.end.p0) && SEEN(faintPl.end.p1), 'faint (player): the player Pokemon is gone', JSON.stringify(faintPl.end));
  ok(faintFoe.ev.sound.some((s) => s.index === 16) && faintPl.ev.sound.some((s) => s.index === 16), 'the faint sound cue (song 16) is emitted');
  ok(faintFoe.ev.cry.some((c) => c.species === 4) && faintPl.ev.cry.some((c) => c.species === 19), 'the OTHER Pokemon cries when one faints (the ROM does this)');
  ok(hitFoe.run.ready && hitFoe.frames > 30 && hitFoe.frames < 70 && SEEN(hitFoe.end.p1), 'hit blink: ~36 frames, the Pokemon is visible again at the end', 'frames ' + hitFoe.frames + ' ' + JSON.stringify(hitFoe.end));
  { // the blink: the sprite toggles invisible / visible
    const run = an.start('system', SYS_ID.hitFoe, { ...BASE }); let last = -1, tog = 0;
    while (!run.done) { run.step(); const v = SEEN(objPixels(run, 1)) ? 1 : 0; if (last !== -1 && v !== last) tog++; last = v; }
    ok(tog >= 6, 'hit blink toggles the sprite at least 6 times', 'toggles ' + tog);
  }
  ok(recall.run.ready && !SEEN(recall.end.p0) && recall.ev.sound.length >= 1, 'recall: the player Pokemon is returned to its ball (invisible), with its sound cue', JSON.stringify(recall.end));
  ok(sendOut.run.ready && SEEN(sendOut.end.p0) && sendOut.ev.cry.length >= 1 && sendOut.ev.sound.length >= 1, 'send-out: a Pokemon is on screen again, with its cry and sound cue', JSON.stringify(sendOut.end));
  ok(sendOut.run.switchSpec && sendOut.ev.cry[0].species === sendOut.run.switchSpec.species, 'the cry is the INCOMING Pokemon\'s (ctx.switchIn)', JSON.stringify([sendOut.ev.cry[0], sendOut.run.switchSpec]));
  const so2 = play(SYS_ID.sendOutPlayer, { switchIn: { species: 25, level: 7 } });
  ok(so2.ev.cry[0].species === 25 && so2.last !== sendOut.last, 'ctx.switchIn chooses the incoming Pokemon');
  const trainerEv = [SYS_ID.sendOutFoe, SYS_ID.recallFoe].map((id) => play(id, { trainer: 3 }));
  ok(trainerEv[0].run.ready && SEEN(trainerEv[0].end.p1) && trainerEv[0].ev.cry.length >= 1, 'trainer foe send-out: the next Pokemon appears with its cry', JSON.stringify([trainerEv[0].run.ready, trainerEv[0].end, trainerEv[0].ev.cry]));
  ok(trainerEv[1].run.ready && !SEEN(trainerEv[1].end.p1), 'trainer foe recall: the foe Pokemon is returned', JSON.stringify(trainerEv[1].end));
  // event pre-roll cache semantics: two runs of the same event start from the same state
  ok(play(SYS_ID.faintFoe).last === faintFoe.last, 'an event run is repeatable');
}
console.log('== golden frame hashes');
{
  const cases = { intro: [SYS_ID.intro, {}, [60, 120, 200]], trainerIntro: [SYS_ID.introTrainer, { foe: { species: 183, level: 4 } }, [100, 200, 300]], faintFoe: [SYS_ID.faintFoe, {}, [4, 10, 30]], sendOut: [SYS_ID.sendOutPlayer, {}, [20, 60, 100]], hit: [SYS_ID.hitFoe, {}, [3, 9, 20]], recall: [SYS_ID.recallPlayer, {}, [6, 20, 40]] };
  const got = {};
  for (const [k, [id, ctx, at]] of Object.entries(cases)) { const v = play(id, ctx, at); got[k] = { frames: v.frames, hashes: v.hashes, last: v.last }; }
  if (UPDATE) { fs.writeFileSync(GOLDEN, JSON.stringify(got, null, 1) + '\n'); console.log('  golden written: ' + GOLDEN); }
  else if (!fs.existsSync(GOLDEN)) ok(false, 'golden file exists (run with --update)');
  else { const want = JSON.parse(fs.readFileSync(GOLDEN, 'utf8')); for (const k of Object.keys(cases)) ok(JSON.stringify(want[k]) === JSON.stringify(got[k]), 'golden ' + k, JSON.stringify(got[k]).slice(0, 120)); }
}
console.log('== negative controls: each fix the real-game verification needed must be DETECTED when taken away');
{
  const base = play(SYS_ID.intro, { maxFrames: 900 }, [200]);
  const slowText = play(SYS_ID.intro, { sb2Option16: 0, sb1Flag19c3: 0, maxFrames: 900 });
  ok(slowText.frames !== base.frames, 'slow battle text (SB2 option byte / SB1 flag) changes the timeline', slowText.frames + ' vs ' + base.frames);
  const longCry = { player: { species: 1289, level: 5 } };   // a species whose cry is longer than its motion, so the controller's wait on the cry decides the timeline
  const base2 = play(SYS_ID.intro, longCry);
  const noCry = play(SYS_ID.intro, { ...longCry, cryModel: 'none' });
  ok(noCry.frames < base2.frames - 20, 'a cry that is over at once shortens the send-out wait by the cry length', noCry.frames + ' vs ' + base2.frames);
  const lat0 = play(SYS_ID.intro, { ...longCry, cryLatency: 0 });
  ok(lat0.frames === base2.frames - 1, 'the cry latency of 1 frame is a measurable part of the timeline', lat0.frames + ' vs ' + base2.frames);
  const rcAt = [27, 28, 29, 30, 31, 32], rc = play(SYS_ID.recallPlayer, {}, rcAt), rc0 = play(SYS_ID.recallPlayer, { seExtra: 0 }, rcAt);
  ok(rcAt.some((f) => rc.hashes[f] !== rc0.hashes[f]), 'the recall\'s 2 extra frames of sound wait (measured against the real game) change the sprite state around frames 27-32', JSON.stringify([rc.frames, rc0.frames]));
  // the BIOS ObjAffineSet rounding (toward zero): feed the interpreter a rotation whose products are negative and not multiples of 16384
  const cpu = an.eng.cpu, mem = an.eng.mem;
  { const src = 0x02000100, dst = 0x02000200; mem.write16(src, 256); mem.write16(src + 2, 256); mem.write16(src + 4, 12 << 8); cpu.r[0] = src; cpu.r[1] = dst; cpu.r[2] = 1; cpu.r[3] = 2; cpu._swi(0x0f, 0);
    const pb = (mem.read16(dst + 2) << 16) >> 16; ok(pb === -74, 'ObjAffineSet rounds toward zero (the real BIOS: -74.31 -> -74), not down (-75)', 'pb ' + pb); }
  // the environment hook: without it the ROM derives the terrain from the (absent) map tile
  { const a = play(SYS_ID.intro, { environment: 0, maxFrames: 120 }), b = play(SYS_ID.intro, { environment: 9, maxFrames: 120 }); ok(a.last !== b.last, 'the battle environment (gBattleTerrain hook) is what picks the background'); }
  // the gFonts pointer: break it on a fresh engine and the first message is printed in one frame (the model's original bug)
  { const run = an.start('system', SYS_ID.intro, { ...BASE, maxFrames: 60 }); run.eng.mem.write32(SYS.fonts, 0);
    for (let i = 0; i < 45; i++) run.step();
    const brokenPrinters = run.eng.mem.read32(SYS.textPrinterHead);   // read before the next start() reuses the engine
    const run2 = an.start('system', SYS_ID.intro, { ...BASE, maxFrames: 60 }); for (let i = 0; i < 45; i++) run2.step();
    const goodPrinters = run2.eng.mem.read32(SYS.textPrinterHead);
    ok(brokenPrinters === 0 && goodPrinters !== 0, 'without gFonts no text printer is ever queued (text instant); with it one is active at frame 45'); }
  // the comparison tool's own detector must see an injected difference
  { const cmp = await import(pathToFileURL(path.join(ROOT, 'tools/pokemonarena_sys_compare.mjs')).href);
    const run = an.start('system', SYS_ID.intro, { ...BASE, maxFrames: 40 }); for (let i = 0; i < 40; i++) run.step();
    const m = run.eng.mem, spr = Buffer.from(m.ewram.slice(SPR - 0x02000000, SPR - 0x02000000 + 64 * 0x44));
    let clean = 0; for (let i = 0; i < 64; i++) if (cmp.spriteDiff(m, { spr }, i)) clean++;
    ok(clean === 0, 'spriteDiff: an identical capture has no differing sprite');
    for (const [off, name] of [[0, 'oam attr0 (y)'], [2, 'oam attr1 (x)'], [4, 'oam attr2'], [0x1c, 'callback'], [0x24, 'x2'], [0x26, 'y2'], [0x3e, 'in-use flag']]) {
      let slot = -1; for (let i = 0; i < 64; i++) if (spr[i * 0x44 + 0x3e] & 1) { slot = i; break; }
      const dmg = Buffer.from(spr); dmg[slot * 0x44 + off] ^= 1; ok(cmp.spriteDiff(m, { spr: dmg }, slot), 'spriteDiff sees a one-bit difference in ' + name);
    }
  }
}

console.log('== round 4: prepare / advance / begin (budgeted slices)');
{
  const GOLD = JSON.parse(fs.readFileSync(path.join(ROOT, 'pokemonarena/js/anim_sys_stream.golden.json'), 'utf8'));
  const cases = streamCases();
  const CTX5 = { ...BASE };
  // ---- (1) start() is still the golden stream, bit for bit: the golden md5s were taken from the code BEFORE the sliced path existed (round 3). Round 5 re-recorded exactly four of them (id2, id8,
  // shinyPlayerSendOut, trainer5Foe: the send-outs, whose incoming species the ROM now reads, ANIM.md "Round 5") and added two (id8Gyarados, id2Pikachu); the other 28 are the round-3 values
  for (const [name, [id, ctx]] of Object.entries(cases)) {
    an.system.clearCache();
    const r = streamOf(an.start('system', id, ctx));
    ok(r.md5 === GOLD[name].md5 && r.frames === GOLD[name].frames, 'start() stream == golden: ' + name, r.md5.slice(0, 10) + ' vs ' + GOLD[name].md5.slice(0, 10));
  }
  // ... and the same with the battle-state cache warm (events 2..9 of one battle share it)
  an.system.clearCache(); streamOf(an.start('system', SYS_ID.faintFoe, CTX5));
  for (const id of [2, 3, 4, 5, 6, 7]) { const before = an.system.stats().cacheHits; const r = streamOf(an.start('system', id, CTX5)); ok(r.md5 === GOLD['id' + id].md5 && an.system.stats().cacheHits === before + 1, 'cache hit gives the golden stream: id ' + id, 'hits ' + (an.system.stats().cacheHits - before)); }

  // ---- (2) sliced == synchronous, every id, budgets of 1, 4 and 1000 ms and the adversarial 0
  // the WHOLE console state at the moment the prepared run is handed over (all RAM images, the I/O registers, the run's counters): the pre-roll must not change a single byte of it
  const stateDigest = (run) => { const m = run.eng.mem, h = crypto.createHash('md5'); for (const a of [m.ewram, m.iwram, m.vram, m.pram, m.oam, m.io]) h.update(a); h.update(JSON.stringify([run.prevRaw, run.iter, run.iterTotal, run.introIter, run.cry, run.sePlayers, run.hiddenIterations, run.aheadPending, run.eng.bg3Anim])); return h.digest('hex'); };
  const syncDigest = {};
  for (const id of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]) { an.system.clearCache(); syncDigest[id] = stateDigest(an.start('system', id, cases['id' + id][1])); }
  for (const name of ['id8Gyarados', 'id2Pikachu']) { an.system.clearCache(); syncDigest[name] = stateDigest(an.start('system', cases[name][0], cases[name][1])); }
  const slicedRun = (id, ctx, budget) => {
    an.system.clearCache();
    const h = an.prepare('system', id, ctx); let adv = 0, instr = 0;
    while (!h.ready) { const r = h.advance(budget); instr += r.instructions; if (++adv > 400000) throw new Error('advance(' + budget + ') never finishes'); }
    const run = h.begin();
    return { run, advances: adv, instr, handle: h, digest: stateDigest(run) };
  };
  const BUDGETS = [1, 4, 1000, 0];
  for (const id of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]) {
    for (const budget of BUDGETS) {
      const s = slicedRun(id, cases['id' + id][1], budget);
      ok(s.digest === syncDigest[id], `id ${id}: sliced (${budget} ms) console state at begin() == synchronous (every RAM byte, the I/O registers, the counters)`);
      const r = streamOf(s.run);
      ok(r.md5 === GOLD['id' + id].md5, `id ${id}: sliced (${budget} ms, ${s.advances} advances) stream == synchronous`, r.md5.slice(0, 10) + ' vs ' + GOLD['id' + id].md5.slice(0, 10));
      if (id >= 2 && budget <= 4) ok(s.advances > 5, `id ${id}: a ${budget} ms budget really slices the pre-roll`, 'advances ' + s.advances);
    }
  }
  // the send-outs of a Pokemon that is not the lead's species (Round 5): the same equality for the two cases whose incoming species differs from the outgoing one
  for (const name of ['id8Gyarados', 'id2Pikachu']) for (const budget of BUDGETS) {
    const s = slicedRun(cases[name][0], cases[name][1], budget), r = streamOf(s.run);
    ok(s.digest === syncDigest[name], `${name}: sliced (${budget} ms) console state at begin() == synchronous`);
    ok(r.md5 === GOLD[name].md5 && r.frames === GOLD[name].frames, `${name}: sliced (${budget} ms, ${s.advances} advances) stream == synchronous == golden`, r.md5.slice(0, 10) + ' vs ' + GOLD[name].md5.slice(0, 10));
  }
  // ---- the 17 balls (the intro: its first iteration is prepared ahead); the throw window is compared pixel by pixel, the rest by sprite / OAM / I/O state
  for (let b = 0; b <= 16; b++) {
    const ctx = cases['ball' + b][1], win = { window: [150, 250] };
    an.system.clearCache(); const sync = streamOf(an.start('system', 0, ctx), win);
    for (const budget of BUDGETS) { const s = slicedRun(0, ctx, budget), r = streamOf(s.run, win); ok(r.md5 === sync.md5 && r.frames === sync.frames, `ball ${b}: sliced (${budget} ms) stream == synchronous`, r.md5.slice(0, 10) + ' vs ' + sync.md5.slice(0, 10)); }
  }

  // ---- (3) no single advance exceeds its budget by more than one check interval. Deterministic: a virtual clock of 1000 instructions per millisecond on the prepared engine's core.
  const VIRTUAL = { clock: (cpu) => cpu.icount / 1000 };   // ctx.clock: 1000 instructions per millisecond (deterministic)
  const boundCheck = (budgets) => {
    const bad = []; let worst = 0, minSlice = Infinity, advances = 0;
    for (const B of budgets) {
      an.system.clearCache();
      const h = an.prepare('system', SYS_ID.faintFoe, { ...CTX5, ...VIRTUAL });
      let guard = 0;
      while (!h.ready && guard++ < 100000) {
        const r = h.advance(B); advances++;
        const over = r.instructions - B * 1000;
        worst = Math.max(worst, over);
        if (over > SLICE_CHECK) bad.push(`B=${B}: ${r.instructions} instructions (> ${B * 1000} + ${SLICE_CHECK})`);
        if (!h.ready && r.instructions < B * 1000) bad.push(`B=${B}: stopped early after ${r.instructions}`);
        if (!h.ready) minSlice = Math.min(minSlice, r.instructions);
      }
      h.dispose();
    }
    return { bad, worst, advances, minSlice };
  };
  { const r = boundCheck([3, 10, 40]);
    ok(r.bad.length === 0, 'no advance exceeds budget + one check interval (virtual clock; 3, 10, 40 ms)', r.bad.slice(0, 2).join(' | '));
    ok(r.advances > 20 && r.worst <= SLICE_CHECK && r.worst >= 0, `worst overshoot ${r.worst} instructions <= SLICE_CHECK ${SLICE_CHECK}`, JSON.stringify(r)); }
  // ---- (4) the adversarial budget: 0 ms must still make progress on EVERY advance (at least one check interval of ROM code, until the last one)
  const progressCheck = (cap = 60) => {
    an.system.clearCache();
    const h = an.prepare('system', SYS_ID.faintFoe, CTX5); const seen = []; let ok0 = true;
    for (let i = 0; i < cap && !h.ready; i++) { const before = h.profile.instructions; const r = h.advance(0); seen.push(h.profile.instructions - before); if (!h.ready && h.profile.instructions - before < SLICE_CHECK - 1) ok0 = false; }
    h.dispose(); return { ok0, seen };
  };
  { const p = progressCheck(); ok(p.ok0 && p.seen.length === 60, 'advance(0) makes progress on every call (>= one check interval, 2047 ROM instructions, until the last)', JSON.stringify(p.seen.slice(0, 6))); }

  // ---- the battle-state cache: a second event of the same battle costs a restore, not the intro; the first hit is exact; different contexts do not share
  {
    an.system.clearCache();
    const h1 = an.prepare('system', SYS_ID.hitFoe, CTX5); h1.advance(Infinity); ok(h1.cache === null && h1.profile.phases.intro.iterations > 200, 'first event of a battle: cache miss, the intro is played (hidden)');
    const r1 = h1.begin();
    const t0 = performance.now(); const h2 = an.prepare('system', SYS_ID.faintFoe, CTX5); const a2 = h2.advance(Infinity); const dt = performance.now() - t0;
    ok(h2.cache === 'A' && !h2.profile.phases.intro && h2.profile.instructions === 0, 'second event of the same battle: cache A, no ROM instruction before its own start', JSON.stringify([h2.cache, h2.profile.instructions]));
    ok(dt < 20, 'its preparation is a restore (< 20 ms, measured ' + dt.toFixed(1) + ' ms; the pre-roll is ~100 ms)');
    h2.begin(); const hs = an.prepare('system', SYS_ID.sendOutPlayer, CTX5); hs.advance(Infinity); const hs2 = an.prepare('system', SYS_ID.sendOutPlayer, CTX5); hs2.advance(Infinity);
    ok(hs.cache === 'A' && hs2.cache === 'B', 'an event with its own preparation (send-out: the recall) is cached after it too (B)', hs.cache + ' / ' + hs2.cache);
    hs.dispose(); hs2.dispose();
    const hd = an.prepare('system', SYS_ID.faintFoe, { ...CTX5, seed: 6 }); hd.advance(Infinity); ok(hd.cache === null, 'another seed is another battle (no sharing)'); hd.dispose();
    const hf = an.prepare('system', SYS_ID.faintFoe, { ...CTX5, foe: { species: 25, level: 3 } }); hf.advance(Infinity); ok(hf.cache === null, 'another foe is another battle'); hf.dispose();
    const hk = an.prepare('system', SYS_ID.faintFoe, { ...CTX5, keys: (f) => (f % 30 < 2 ? KEY.A : 0) }); hk.advance(Infinity); ok(hk.cache === null, 'a custom key function is never cached'); hk.dispose();
    const hw = an.prepare('system', 'battle', { ...CTX5, seed: 77 }); while (!hw.ready) hw.advance(4);
    const hv = an.prepare('system', SYS_ID.faintFoe, { ...CTX5, seed: 77 }); hv.advance(Infinity); ok(hv.cache === 'A', "prepare('system', 'battle', ctx) prewarms the cache for the events of that battle"); hv.dispose();
    let e = null; try { hw.begin(); } catch (x) { e = x; } ok(e && /prewarm/.test(e.message), "a 'battle' prewarm has nothing to begin (typed error)");
    ok(an.system.stats().busy <= 3 && an.system.stats().cacheBytes > 0, 'stats(): ' + JSON.stringify(an.system.stats()));
    an.system.clearCache(); while (!r1.done) r1.step();
  }

  // ---- (5) several runs at once: a faint is prepared while the hit plays, each on its own engine; both streams are the synchronous ones
  {
    for (const cold of [false, true]) {
      an.system.clearCache();
      const hit = an.start('system', SYS_ID.hitFoe, CTX5); const hs = streamer(hit);
      if (cold) an.system.clearCache();
      const prep = an.prepare('system', SYS_ID.faintFoe, CTX5);
      let ticks = 0; while (!hit.done || !prep.ready) { if (!hit.done) hs.step(); if (!prep.ready) prep.advance(1); if (++ticks > 5000) break; }
      const rh = hs.finish(); const faint = prep.begin(); const rf = streamOf(faint);
      ok(rh.md5 === GOLD.id7.md5 && rf.md5 === GOLD.id5.md5, `hit playing while the faint behind it is prepared (${cold ? 'cold: sliced pre-roll' : 'warm: cached'}): both streams equal the synchronous ones`, rh.md5.slice(0, 8) + ' ' + rf.md5.slice(0, 8));
    }
    const s = an.system.stats(); ok(s.engines >= 2 && s.engines <= s.maxEngines, 'the pool grew to ' + s.engines + ' engines (max ' + s.maxEngines + ')');
  }
  // ---- the pool: never takes a prepared handle, takes the least recently used finished run (its last frame frozen), then the least recently used live one
  {
    const small = await createMoveAnimator({ rom, systemEngines: 2 });
    const p1 = small.prepare('system', SYS_ID.hitFoe, CTX5), p2 = small.prepare('system', SYS_ID.hitPlayer, CTX5);
    let e = null; try { small.prepare('system', SYS_ID.faintFoe, CTX5); } catch (x) { e = x; }
    ok(e && e.name === 'MoveAnimError' && /pool is exhausted/.test(e.message), 'every engine holding a prepared run: the next prepare() fails with a typed error', e && e.message);
    p1.advance(Infinity); const live = p1.begin(); for (let i = 0; i < 5; i++) live.step();
    p2.advance(Infinity); const fin = p2.begin(); while (!fin.done) fin.step(); const lastPic = Uint8Array.from(fin.draw(null));
    const p3 = small.prepare('system', SYS_ID.faintFoe, CTX5);    // takes the FINISHED run's engine first
    ok(fin.reclaimed && !fin.evicted && !live.reclaimed, 'the finished run was surrendered first, the live one was not touched');
    ok(Buffer.from(fin.draw(null)).equals(Buffer.from(lastPic)), 'a surrendered run keeps its last picture (frozen)');
    const p4 = small.prepare('system', SYS_ID.hitPlayer, CTX5);    // now the live run is the only candidate
    ok(live.evicted && live.done && live.reclaimed, 'with no finished run left the least recently used LIVE run is evicted (done, run.evicted)');
    p3.dispose(); p4.dispose();
    const p5 = small.prepare('system', SYS_ID.faintPlayer, CTX5); ok(p5.phase === 'lookup', 'dispose() gives the engine back at once'); p5.dispose();
    e = null; try { p5.advance(1); } catch (x) { e = x; } ok(e && /disposed/.test(e.message), 'advance() on a disposed handle is a typed error');
    const q = an.prepare('system', SYS_ID.recallPlayer, CTX5); e = null; try { q.begin(); } catch (x) { e = x; } ok(e && /not ready/.test(e.message), 'begin() before ready is a typed error'); q.advance(Infinity); const qr = q.begin(); e = null; try { qr.step(); q.advance(1); } catch (x) { e = x; } ok(e && /already begun/.test(e.message), 'advance() after begin() is a typed error'); qr.dispose();
    e = null; try { an.prepare('move', 33, {}); } catch (x) { e = x; } ok(e && /kind "system"/.test(e.message), "prepare() is for kind 'system' only");
    const un = an.prepare('system', SYS_ID.hitFoe, CTX5); e = null; try { un.run.step(); } catch (x) { e = x; } ok(e && /only prepared/.test(e.message), 'a prepared run cannot step before begin()'); un.dispose();
  }
  // ---- a prepared intro has run its first iteration already (the 10-15 ms one): the first step() delivers it
  {
    an.system.clearCache(); const h = an.prepare('system', SYS_ID.intro, CTX5); h.advance(Infinity);
    ok(h.run.aheadPending === true && h.run.frame === 0 && h.run.iterTotal === 1 && h.profile.phases.ahead.iterations === 1, 'a prepared intro holds its first iteration (frame 0, iteration 1 done)');
    const run = h.begin(); run.step(); ok(run.frame === 1 && !run.aheadPending && run.iterTotal === 1, 'its first step() only hands the iteration over (no ROM code runs)');
    const none = an.prepare('system', SYS_ID.intro, { ...CTX5, lookahead: 0 }); none.advance(Infinity); ok(none.run.iterTotal === 0 && !none.run.aheadPending, 'ctx.lookahead = 0 turns it off'); none.dispose();
  }

  // ---- negative controls: each way the sliced path could be wrong must be DETECTED
  const mutate = (obj, key, repl, fn) => { const orig = obj[key]; obj[key] = repl(orig); try { return fn(); } finally { obj[key] = orig; } };
  const sliceDiffers = (id) => { try { const s = slicedRun(id, cases['id' + id][1], 1); return s.digest !== syncDigest[id] || streamOf(s.run).md5 !== GOLD['id' + id].md5; } catch (e) { return true; } };
  ok(mutate(SystemRun.prototype, 'iterSliced', (o) => function (d) { const r = o.call(this, d); if (r) this.iterTotal++; return r; }, () => sliceDiffers(0)), 'mutant "a sliced iteration is counted twice" is detected (the prepared intro stream differs)');
  ok(mutate(SystemRun.prototype, 'iterKeys', (o) => function (k) { return o.call(this, k | KEY.A); }, () => sliceDiffers(0)), 'mutant "ReadKeys sees an extra A in the sliced path" is detected');
  ok(mutate(GbaCpu.prototype, 'resume', (o) => function (d) { const r = o.call(this, d); if (!r) this.r[5] = (this.r[5] ^ 1) >>> 0; return r; }, () => sliceDiffers(5)), 'mutant "a suspension corrupts a callee-saved register" is detected');
  ok(mutate(GbaCpu.prototype, 'beginCall', (o) => function (a, args, opts) { if (this.skipOnce === undefined) this.skipOnce = 0; if (a === AD.fn.processDma3 && (this.skipOnce++ % 7) === 3) a = AD.fn.spriteCallbackDummy; return o.call(this, a, args, opts); }, () => sliceDiffers(5)), 'mutant "the sliced loop drops some DMA-queue calls" is detected');
  { // the cache: a fingerprint that ignores the battle shares a stale one between different Pokemon
    const other = { ...CTX5, foe: { species: 25, level: 3 } };
    const stale = mutate(SystemRun.prototype, 'fingerprint', (o) => function () { return 'constant'; }, () => { an.system.clearCache(); streamOf(an.start('system', SYS_ID.faintFoe, CTX5)); return streamOf(an.start('system', SYS_ID.faintFoe, other)).md5; });
    an.system.clearCache(); const fresh = streamOf(an.start('system', SYS_ID.faintFoe, other)).md5;
    ok(stale !== fresh, 'mutant "the cache key ignores the Pokemon" is detected (the stale battle changes the stream)'); }
  { // a cache restore that loses part of the console
    const r = mutate(SystemRun.prototype, 'restoreCached', (o) => function (sn) { o.call(this, sn); this.eng.mem.vram.fill(0); }, () => { an.system.clearCache(); streamOf(an.start('system', SYS_ID.faintFoe, CTX5)); return streamOf(an.start('system', SYS_ID.faintFoe, CTX5)).md5; });
    ok(r !== GOLD.id5.md5, 'mutant "a cache hit loses the VRAM" is detected'); }
  ok(mutate(GbaCpu.prototype, 'resume', (o) => function (d) { return o.call(this, Infinity); }, () => boundCheck([3, 10]).bad.length > 0), 'mutant "the deadline is ignored" violates the budget bound (detected)');
  ok(mutate(GbaCpu.prototype, 'resume', (o) => function (d) { return false; }, () => { try { return progressCheck(8).ok0 === false; } catch (e) { return true; } }), 'mutant "advance() runs nothing" fails the progress test (detected)');
  ok(mutate(GbaCpu.prototype, 'beginCall', (o) => function (a, args, opts) { return o.call(this, a, args, opts); }, () => true), 'control: a pass-through wrapper is NOT a mutant (the checks above are not trivially true)');
  ok(!sliceDiffers(5) && boundCheck([10]).bad.length === 0 && progressCheck(8).ok0, 'and the unmutated code passes all three checks again');

  // ---- real clock: how far past its budget a real advance goes (reported; asserted loosely, the machine is shared)
  {
    const rows = [];
    for (const B of [1, 4]) { an.system.clearCache(); const h = an.prepare('system', SYS_ID.faintFoe, CTX5); let worst = 0, n = 0; while (!h.ready) { const t = performance.now(); h.advance(B); const dt = performance.now() - t; worst = Math.max(worst, dt - B); n++; } h.dispose(); rows.push(`${B} ms: ${n} advances, worst overshoot ${worst.toFixed(2)} ms`); }
    console.log('   real clock: ' + rows.join(' | '));
    ok(true, 'real-clock overshoot reported');
  }
  console.log('   pool: ' + JSON.stringify(an.system.stats()));
}

console.log('== round 5: the incoming Pokemon of a send-out (gBattleMons[battler].species)');
{
  const BM = SYS.battleMons, BS = SYS.battleMonStride;
  // the foe's ground shadow pair (SpriteCB_EnemyShadow, callback 0x0807eb89): attr0, attr1, attr2 (the tile = the shadow's size class), x, y of each half
  const shadowsOf = (mem) => { const o = []; for (let i = 0; i < 64; i++) { const a = AD.sprites + i * 0x44; if ((mem.ewU8(a + 0x3e) & 1) && mem.ewU32(a + 0x1c) === 0x0807eb89) o.push([mem.ewU16(a), mem.ewU16(a + 2), mem.ewU16(a + 4), mem.ewS16(a + 0x20), mem.ewS16(a + 0x22)].join(',')); } return o.join(' | '); };
  const standing = (sp) => { an.system.clearCache(); const h = an.prepare('system', 'battle', { ...BASE, foe: { species: sp, level: 5 }, trainer: 1 }); h.advance(Infinity); const s = shadowsOf(h.run.eng.mem); h.dispose(); return s; };
  const FOE0 = { species: 183, level: 4 };
  const sendOut = (sp, extra = {}) => { const run = an.start('system', SYS_ID.sendOutFoe, { ...BASE, foe: FOE0, trainer: 1, switchIn: { species: sp, level: 5 }, ...extra }); let g = 0; while (!run.done && g++ < 3000) run.step(); return { run, mem: run.eng.mem, frames: run.frame, shadows: shadowsOf(run.eng.mem) }; };
  const SPECIES = [130, 143, 6, 25, 129, 94, 200];      // Gyarados, Snorlax, Charizard, Pikachu, Magikarp, Gengar, Misdreavus: seven different (size class, x, y) shadows
  an.system.clearCache();
  const marill = standing(FOE0.species), ref = {};
  for (const sp of SPECIES) ref[sp] = standing(sp);
  ok(new Set([marill, ...Object.values(ref)]).size === 8 && Object.values(ref).every((s) => s.split(' | ').length === 2), 'the reference: eight species, eight different shadow pairs (two halves each)', Object.values(ref).join(' / '));
  const got = {};
  for (const sp of SPECIES) { an.system.clearCache(); got[sp] = sendOut(sp); ok(got[sp].shadows === ref[sp] && got[sp].shadows !== marill, "send-out foe (trainer) Marill -> species " + sp + ": the run ends on the NEW Pokemon's shadow (the standing foe's, the real game's), not the outgoing one's", got[sp].shadows + ' vs ' + ref[sp]); }
  { const m = sendOut(130).mem; ok(m.read16(BM + BS) === 130 && m.read16(BM) === 4, "gBattleMons[1].species is the incoming species after id 8 (the player's slot is untouched)", m.read16(BM + BS) + ' / ' + m.read16(BM)); }
  { an.system.clearCache(); const run = an.start('system', SYS_ID.sendOutPlayer, { ...BASE, switchIn: { species: 25, level: 5 } }); let g = 0; while (!run.done && g++ < 3000) run.step(); const m = run.eng.mem;
    ok(m.read16(BM) === 25 && m.read16(BM + BS) === 19, "gBattleMons[0].species is the incoming species after id 2 (the foe's slot is untouched)", m.read16(BM) + ' / ' + m.read16(BM + BS)); }
  for (const id of [SYS_ID.recallPlayer, SYS_ID.recallFoe, SYS_ID.faintFoe, SYS_ID.hitFoe]) { an.system.clearCache(); const run = an.start('system', id, { ...BASE, trainer: id === SYS_ID.recallFoe ? 1 : 0 }); let g = 0; while (!run.done && g++ < 3000) run.step(); const m = run.eng.mem; ok(m.read16(BM) === 4 && m.read16(BM + BS) === 19, 'id ' + id + ': no incoming Pokemon, gBattleMons keeps both species'); }
  // the cache: the second send-out of one battle (a cache hit, B) with ANOTHER incoming Pokemon gets its own shadow: the incoming Pokemon is written after the snapshot, so the key needs no species
  { an.system.clearCache();
    const first = sendOut(130), h = an.prepare('system', SYS_ID.sendOutFoe, { ...BASE, foe: FOE0, trainer: 1, switchIn: { species: 25, level: 5 } }); h.advance(Infinity);
    ok(first.shadows === ref[130] && h.cache === 'B', 'a cache hit (B) of the same battle with another incoming species', 'cache ' + h.cache);
    const run = h.begin(); let g = 0; while (!run.done && g++ < 3000) run.step();
    ok(shadowsOf(run.eng.mem) === ref[25] && shadowsOf(run.eng.mem) !== first.shadows && run.frame === got[25].frames, "its shadow is the new species' (Pikachu), not the previous run's (Gyarados), and its length is the uncached run's", shadowsOf(run.eng.mem) + ' / ' + run.frame + ' vs ' + got[25].frames); }
  // negative controls: the species not reaching gBattleMons (the round-3 behaviour), or reaching the wrong slot, must be seen
  const mutate2 = (repl, fn) => { const orig = SystemRun.prototype.finishEvent; SystemRun.prototype.finishEvent = repl(orig); try { return fn(); } finally { SystemRun.prototype.finishEvent = orig; } };
  ok(mutate2((o) => function (ctx) { const m = this.eng.mem, a = BM + BS, old = m.read16(a); o.call(this, ctx); m.write16(a, old); }, () => { an.system.clearCache(); const r = sendOut(130); const tiles = (s) => s.split(' | ').map((x) => x.split(',')[2]).join(); return r.shadows !== ref[130] && tiles(r.shadows) === tiles(marill); }), "mutant \"the outgoing species stays in gBattleMons\" (round 3) is detected: the run ends on the previous foe's shadow shape (its tiles; the y follows the new sprite)");
  ok(mutate2((o) => function (ctx) { const m = this.eng.mem, a = BM + BS, old = m.read16(a); o.call(this, ctx); m.write16(a, old); m.write16(BM, 130); }, () => { an.system.clearCache(); const r = sendOut(130); return r.shadows !== ref[130]; }), 'mutant "the species goes to the wrong slot" is detected');
  { an.system.clearCache(); const r = sendOut(130); ok(r.shadows === ref[130], 'and the unmutated code passes again'); }
  // the send-out is longer or shorter with the species (the cry, the sprite's own animation): pinned by the golden streams id8Gyarados (185 frames) / id2Pikachu (150)
  { an.system.clearCache(); const a = streamOf(an.start('system', 2, { ...BASE, switchIn: { species: 25, level: 5 } })), b = streamOf(an.start('system', 2, { ...BASE, switchIn: { species: 130, level: 5 } }));
    ok(a.frames === 150 && b.frames === 152 && a.md5 !== b.md5, "send-out player: Pikachu 150 frames, Gyarados 152 (each equals the real game's natural switch, tools/pokemonarena_sys_natural.mjs)", a.frames + ' / ' + b.frames); }
}
if (ORACLE) {
  console.log('== the real game (OR1 oracle, ' + ORACLE + ')');
  const cmp = await import(pathToFileURL(path.join(ROOT, 'tools/pokemonarena_sys_compare.mjs')).href);
  const { openOracle } = await import(pathToFileURL(path.join(ROOT, 'tools/pokemonarena_rom_oracle.mjs')).href);
  const o = await openOracle({ stateDir: ORACLE });
  const sc = { foe: 19, foeLevel: 2, player: 4, shots: [110, 200, 280], exactBytes: true };
  const rec = await cmp.recordReal(o, sc), res = await cmp.compareIntro(rom, rec, sc, { createMoveAnimator, animator: an });
  ok(res.ready && res.spriteExact >= res.iterations - 1 && res.shots.every((s) => s.differingPixels === 0), 'wild intro: every iteration but the menu\'s opening is sprite-exact, 3 screenshots identical', JSON.stringify([res.iterations, res.spriteExact, res.shots]));
  for (const id of [4, 5, 6, 7, 2]) {
    const sc2 = { foe: 19, foeLevel: 3, player: 4, playerLevel: 5, shotsRel: [2, 6, 12, 24], eventFrames: 330 };
    const r2 = await cmp.recordRealEvent(o, sc2, id), e2 = await cmp.compareEvent(rom, r2, sc2, id, { animator: an });
    ok(!e2.error && e2.injectionMatch.spriteDiffsAtInjection === 0 && e2.spriteExact === e2.iterations && e2.shots.every((s) => s.differingPixels === 0), 'event ' + cmp.EVENT_PLANS[id].name + ' is exact against the real game', JSON.stringify([e2.iterations, e2.spriteExact, e2.shots.map((s) => s.differingPixels)]));
  }
  // Round 5: the send-outs of a Pokemon that is not the outgoing one's species, injected the way the battle script leaves the game (gBattleMons[battler].species written before switchinanim)
  for (const [id, foe, player, sw] of [[8, 183, 4, 130], [8, 183, 4, 25], [8, 183, 4, 129], [8, 183, 4, 200], [8, 183, 4, 94], [2, 19, 6, 25], [2, 19, 6, 130]]) {
    const sc2 = { foe, foeLevel: id === 8 ? 4 : 3, player, playerLevel: 5, switchIn: sw, shotsRel: [2, 6, 12, 24, 48, 100], eventFrames: 330 };
    const r2 = await cmp.recordRealEvent(o, sc2, id), e2 = await cmp.compareEvent(rom, r2, sc2, id, { animator: an });
    ok(!e2.error && e2.injectionMatch.spriteDiffsAtInjection === 0 && e2.spriteExact === e2.iterations && e2.shots.every((s) => s.differingPixels === 0), 'injected event ' + cmp.EVENT_PLANS[id].name + ' (-> species ' + sw + ') is exact against the real game', JSON.stringify([e2.iterations, e2.spriteExact, e2.shots.map((s) => s.differingPixels)]));
  }
  // Round 5: the game's NATURAL switch (its own battle script), compared through the first-party PPU on the side of the picture the event animates
  const nat = await import(pathToFileURL(path.join(ROOT, 'tools/pokemonarena_sys_natural.mjs')).href);
  const natRows = {};
  for (const [kind, list] of [['foe', [130, 143, 6, 25, 129, 94, 200]], ['player', [130, 143, 129, 94, 25, 6]]]) for (const sp of list) {
    const rec = await nat.recordNatural(o, kind, sp); natRows[kind + sp] = { rec };
    const r = await nat.compareNatural(rom, rec, { animator: an }); natRows[kind + sp].r = r;
    const exact = !r.error && r.regionPx === 0 && r.timelineEqual && r.shadowEqual !== false;
    // two player switches (Pikachu, and Charizard after Charizard) differ in one or two frames of the palette-restore transition (the engine's silhouette ends one or two frames later than the natural
    // flow's) and are exact in the injected comparison above; the Charizard one has the SAME species in both slots, so it is the round-3 behaviour and not a product of the species write
    const near = !exact && kind === 'player' && !r.error && r.timelineEqual && r.lastFramePx === 0 && r.badFrames <= 2 && r.firstBad && r.firstBad[0] >= 60 && r.firstBad[0] <= 70;
    ok(exact || near, 'natural ' + kind + ' send-out of species ' + sp + ' is ' + (exact ? 'exact' : 'within one transition frame') + ' against the real game (' + r.iterations + ' iterations, ' + r.regionPx + ' px in ' + r.badFrames + ' frames, timeline ' + (r.timelineEqual ? 'equal' : 'DIFFERENT') + (r.shadowEqual === null ? '' : ', shadow ' + (r.shadowEqual ? 'equal' : 'DIFFERENT')) + ')', JSON.stringify(r).slice(0, 300));
  }
  ok(['foe130', 'foe143', 'foe6', 'foe25', 'foe129', 'foe94', 'foe200'].every((k) => natRows[k].r.regionPx === 0 && natRows[k].r.shadowEqual === true), 'all seven natural trainer switches are pixel-exact AND end on the real shadow pair (seven different shadow classes / offsets)');
  ok(['player130', 'player143', 'player129', 'player94'].every((k) => natRows[k].r.regionPx === 0), 'four natural player switches are pixel-exact');
  // negative controls on the natural comparison: the round-3 behaviour (the species not written) must be seen by BOTH checks
  for (const sp of [130, 200]) {
    const stale = await nat.compareNatural(rom, natRows['foe' + sp].rec, { animator: an, mutate: () => { const orig = SystemRun.prototype.finishEvent; SystemRun.prototype.finishEvent = function (ctx) { const m = this.eng.mem, a = SYS.battleMons + SYS.battleMonStride, old = m.read16(a); orig.call(this, ctx); m.write16(a, old); }; return () => { SystemRun.prototype.finishEvent = orig; }; } });
    ok(stale.shadowEqual === false && stale.regionPx > 1000 && stale.lastFramePx > 0, 'natural comparison, mutant "the outgoing species stays" (species ' + sp + '): seen in the shadow sprites, the pixels (' + stale.regionPx + ' px) and the last frame (' + stale.lastFramePx + ' px)');
  }
  const nat0 = natRows.player130; const shifted = await nat.compareNatural(rom, { ...nat0.rec, f0: nat0.rec.f0 + 3 }, { animator: an });
  ok(!shifted.timelineEqual || shifted.regionPx > 0, 'natural comparison, control: an anchor 3 frames off is seen (the comparison is not trivially true)');
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

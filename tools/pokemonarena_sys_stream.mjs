// tools/pokemonarena_sys_stream.mjs -- the frame stream of a system run as ONE md5: every frame's RGBA (all 240x160 pixels) + every event (type, frame, index / species / text). It is the
// regression gate of the prepare / advance / begin path (pokemonarena/ANIM.md "Round 4"): the stream of a prepared run must equal the stream of animator.start() bit for bit.
//   node tools/pokemonarena_sys_stream.mjs --out <file.json>     writes the md5 of the standard set (ids 0-9, 17 balls, shiny, trainer ids, a long-cry species)
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** The standard set: name -> [id, ctx]. */
export function streamCases() {
  const base = { foe: { species: 19, level: 3 }, player: { species: 4, level: 5 }, seed: 5, maxFrames: 900 };
  const cases = {};
  for (let id = 0; id <= 9; id++) cases['id' + id] = [id, { ...base, ...(id === 1 ? { foe: { species: 183, level: 4 } } : {}) }];
  for (let b = 0; b <= 16; b++) cases['ball' + b] = [0, { ...base, player: { species: 4, level: 5, ball: b } }];
  cases.shinyFoe = [0, { ...base, foe: { species: 19, level: 3, shiny: true } }];
  cases.shinyPlayerSendOut = [2, { ...base, player: { species: 4, level: 5, shiny: true }, switchIn: { species: 25, level: 7, shiny: true } }];
  cases.longCry = [0, { ...base, player: { species: 1289, level: 5 } }];
  cases.trainer5Foe = [8, { ...base, trainer: 5 }];
  cases.night = [3, { ...base, timeOfDay: 3, environment: 1 }];
  // Round 5: send-outs of Pokemon whose species the lead does not share (the incoming species is what the ROM reads, ANIM.md "Round 5"): a Gyarados after a Marill, a Pikachu after a Charmander
  cases.id8Gyarados = [8, { ...base, foe: { species: 183, level: 4 }, trainer: 1, switchIn: { species: 130, level: 5 } }];
  cases.id2Pikachu = [2, { ...base, switchIn: { species: 25, level: 5 } }];
  return cases;
}

/** An incremental stream hash of a run: step() advances the run one frame and hashes its picture; finish() returns { md5, frames }. opts.window = [from, to): frames outside it hash the
 *  64 sprite structs + OAM + I/O registers instead of the 38400 pixels (a 10x cheaper stand-in that still sees any change of what is drawn). */
export function streamer(run, opts = {}) {
  const h = crypto.createHash('md5'); let n = 0;
  const ev = (type) => (e) => h.update(JSON.stringify([type, run.frame, e.index, e.species, e.text, e.pan]));
  for (const t of ['sound', 'cry', 'message']) run.on(t, ev(t));
  const [from, to] = opts.window || [0, Infinity];
  return {
    step() {
      run.step();
      if (n >= from && n < to) h.update(Buffer.from(run.draw(null)));
      else { const m = run.eng.mem; h.update(m.ewram.subarray(0x0203beb4 - 0x02000000, 0x0203beb4 - 0x02000000 + 64 * 0x44)); h.update(m.oam); h.update(m.io.subarray(0, 0x58)); }
      n++;
    },
    finish() { h.update(JSON.stringify([run.ready, run.truncated, run.frame, run.settledAt === undefined ? null : run.settledAt])); return { md5: h.digest('hex'), frames: n }; },
  };
}
/** Plays a run to its end and returns { md5, frames }. */
export function streamOf(run, opts) {
  const s = streamer(run, opts); let guard = 0;
  while (!run.done && guard++ < 3000) s.step();
  return s.finish();
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const R = new URL('..', import.meta.url).href;
  const { createMoveAnimator } = await import(R + 'pokemonarena/js/move_anim.js');
  const rom = new Uint8Array(fs.readFileSync(process.env.ARENA_ROM || 'gba/gbaWasm/roms/Pokemon SoulGold (v1.1.1).gba'));
  const an = await createMoveAnimator({ rom });
  const out = {};
  for (const [name, [id, ctx]] of Object.entries(streamCases())) out[name] = streamOf(an.start('system', id, ctx));
  const outPath = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : null;
  if (outPath) fs.writeFileSync(outPath, JSON.stringify(out, null, 1) + '\n');
  console.log(Object.entries(out).map(([k, v]) => k + ' ' + v.frames + ' ' + v.md5.slice(0, 8)).join('\n'));
}

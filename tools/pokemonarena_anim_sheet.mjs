// tools/pokemonarena_anim_sheet.mjs -- renders labelled contact sheets of ROM animations (scratch PNGs; never committed).
//   node tools/pokemonarena_anim_sheet.mjs --out <dir> [--kind move] [--frames 12] [--cols 6] [--scale 1] [--species A,B] [--side 0] <id> [<id>...]
// One PNG per animation: N frames sampled evenly across the run (frame 0 and the last frame included), each labelled with its frame number.
// The terrain stand-in is a flat gradient (the real scene supplies its own terrain); the mons are the species given with --species.
import fs from 'node:fs';
import path from 'node:path';
import { createMoveAnimator } from '../pokemonarena/js/move_anim.js';
import { writePng, contactSheet } from './pokemonarena_anim_png.mjs';

const args = process.argv.slice(2);
const opt = { out: '.', kind: 'move', frames: 12, cols: 6, scale: 1, species: '4,1', side: 0, rom: 'gba/gbaWasm/roms/Pokemon SoulGold (v1.1.1).gba', max: 900, seed: 1, hour: 12 };
const ids = [];
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) { const k = args[i].slice(2); opt[k] = isNaN(Number(args[i + 1])) ? args[i + 1] : Number(args[i + 1]); i++; } else ids.push(Number(args[i]));
}
const rom = new Uint8Array(fs.readFileSync(opt.rom));
const [spA, spB] = String(opt.species).split(',').map(Number);
const an = await createMoveAnimator({ rom });
fs.mkdirSync(opt.out, { recursive: true });
const base = new Uint8ClampedArray(240 * 160 * 4);
function terrain() {
  for (let y = 0; y < 160; y++) for (let x = 0; x < 240; x++) { const o = (y * 240 + x) * 4; base[o] = 120 + (y >> 2); base[o + 1] = 170 + (y >> 3); base[o + 2] = 120; base[o + 3] = 255; }
}
for (const id of ids) {
  const side = opt.side;
  const run = an.start(opt.kind, id, { attacker: { side, species: side ? spB : spA }, target: { side: side ^ 1, species: side ? spA : spB }, seed: opt.seed, hour: opt.hour });
  const all = [];
  let f = 0;
  while (!run.done && f < opt.max) { run.step(); terrain(); run.draw(base); all.push(new Uint8ClampedArray(base)); f++; }
  const n = Math.min(opt.frames, all.length), picks = [];
  for (let k = 0; k < n; k++) picks.push(n === 1 ? 0 : Math.round((k * (all.length - 1)) / (n - 1)));
  const sheet = contactSheet(picks.map((p) => ({ rgba: all[p], label: `${opt.kind} ${id} f${p}` })), { cols: opt.cols, scale: opt.scale });
  const file = path.join(opt.out, `sheet_${opt.kind}_${id}.png`);
  writePng(file, sheet.width, sheet.height, sheet.rgba);
  console.log(`${opt.kind} ${id}: ${all.length} frames${run.error ? ' ERROR ' + run.error.message : ''} -> ${file}`);
}

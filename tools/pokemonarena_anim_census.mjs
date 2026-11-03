// tools/pokemonarena_anim_census.mjs - what the shared move animator says it can play: counts of exact / approx / fallback / none for every move, and for the
// general / status / special ids the scene asks for (anim_mon.js GENERAL / STATUS / SPECIAL). Read-only; prints a table, writes nothing.
//   node tools/pokemonarena_anim_census.mjs [--list-none]
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const u = (f) => pathToFileURL(path.join(root, 'pokemonarena', 'js', f)).href;
const [T, MA, AM] = await Promise.all(['tables.js', 'move_anim.js', 'anim_mon.js'].map((f) => import(u(f))));
const b = fs.readFileSync(path.join(root, 'gba', 'gbaWasm', 'roms', 'Pokemon SoulGold (v1.1.1).gba'));
const rom = new Uint8Array(b.buffer, b.byteOffset, b.length);
const pack = T.loadPack(rom, { verify: 'header', dexText: false });
let coverage = null; try { coverage = JSON.parse(fs.readFileSync(path.join(root, 'pokemonarena', 'js', 'anim_coverage.json'), 'utf8')); } catch (_e) { /* none: every id answers approx */ }
const animator = await MA.createMoveAnimator({ rom, coverage });
const tally = () => ({ exact: 0, approx: 0, fallback: 0, none: 0 });
const mv = tally(), none = [];
for (let id = 1; id < pack.moves.length; id++) { const m = pack.moves[id]; if (!m || !m.name || m.name === '-') continue; const a = animator.available('move', id); mv[a]++; if (a === 'none') none.push(id + ':' + m.name); }
console.log('moves     ', JSON.stringify(mv), 'of', Object.values(mv).reduce((x, y) => x + y, 0));
for (const [kind, ids] of [['general', AM.GENERAL], ['status', AM.STATUS], ['special', AM.SPECIAL]]) {
  const t = tally(), per = [];
  for (const [name, id] of Object.entries(ids)) { const a = animator.available(kind, id); t[a]++; per.push(name + '=' + a); }
  console.log(kind.padEnd(10), JSON.stringify(t), process.argv.includes('--list-none') ? per.join(' ') : '');
}
if (process.argv.includes('--list-none')) console.log('moves with none:', none.join(', '));

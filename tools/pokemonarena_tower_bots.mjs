// tools/pokemonarena_tower_bots.mjs -- how far does a BOT climb the Tower? A calibration aid, not a test and not human play.
//
//   node tools/pokemonarena_tower_bots.mjs                  80 runs per strategy and format, the CPU AI ('hard') playing the player's side
//   N=200 LEVEL=normal node tools/pokemonarena_tower_bots.mjs
//
// The bot fights every floor with the real AI against the real trainer (real `battleSetup`, real battles) and takes balls by a fixed rule. It is deliberately simple: it does not plan a build, it cannot read a synergy, and the CPU
// AI plays a battle worse than a person does. So the numbers say whether the curve is climbable at all and roughly how much the buffs move it - they do not say how hard the Tower is for a human. Output is one line per cell:
// floors cleared (mean / median / p10 / p90 / max) and runs won. Same inputs, same numbers (every seed is fixed).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const SRC = path.join(root, 'pokemonarena', 'js');
const ROM_PATH = process.env.ARENA_ROM || path.join(root, 'gba', 'gbaWasm', 'roms', 'Pokemon SoulGold (v1.1.1).gba');
const imp = (f) => import(pathToFileURL(path.join(SRC, f)).href);
const [tables, matchctl, T, B, ai] = await Promise.all(['tables.js', 'matchctl.js', 'tower.js', 'tower_buffs.js', 'ai.js'].map(imp));
const pack = tables.loadPack(fs.readFileSync(ROM_PATH), { verify: 'header', dexText: false });
const N = Number(process.env.N || 80), LEVEL = process.env.LEVEL || 'hard';

const score = (tags, bonus) => (o) => { const f = B.FAMILY_BY_ID[o.id]; return (f.curse ? -9 : 0) + (tags.some((t) => f.tags.includes(t)) ? 3 : 0) + (f.tags.includes('foe') ? 1 : 0) + o.tier * 0.5 + bonus; };
const focus = (tags) => (run) => { const sc = score(tags, 0), b = run.offer.slice().sort((a, c) => sc(c) - sc(a))[0]; return sc(b) > 0 ? b.id : null; };
const STRATEGIES = {
  'skip-all': () => null,
  random: (run, rng) => run.offer[rng(run.offer.length)].id,
  'best-colour': (run) => run.offer.slice().sort((a, b) => b.tier - a.tier)[0].id,
  'no-curse': (run, rng) => { const ok = run.offer.filter((o) => !B.FAMILY_BY_ID[o.id].curse); return ok.length ? ok[rng(ok.length)].id : null; },
  'no-curse-best': (run) => { const ok = run.offer.filter((o) => !B.FAMILY_BY_ID[o.id].curse).sort((a, b) => b.tier - a.tier); return ok.length ? ok[0].id : null; },
  'focus-offence': focus(['offense', 'speed']),
  'focus-tank': focus(['bulk', 'recovery']),
};
const quant = (xs, q) => xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))];

for (const fmt of ['3v3', '6v6']) for (const [name, pick] of Object.entries(STRATEGIES)) {
  const reached = [], t0 = Date.now(); let won = 0;
  for (let i = 0; i < N; i++) {
    const team = matchctl.randomTeam(pack, 9000 + i * 31, 6, 'arena-gen3-standard'), rng = ai.createRng(777 + i);
    let run = T.newRun({ pack, seed: 123457 + i * 101, format: fmt, team: { name: 'Bot', recs: team.recs, meta: team.meta } });
    for (let g = 0; g < 200 && run.phase !== 'over' && run.phase !== 'won'; g++) {
      if (run.phase === 'battle') {
        const s = T.battleSetup(pack, run);
        const ctl = matchctl.createMatchController({ pack, ruleset: s.ruleset, teams: [s.player.recs, s.foe.recs], seed: s.seed, pick: s.pick, names: s.names, validate: false, sides: [{ kind: 'cpu', level: LEVEL, seed: 5 + i }, { kind: 'cpu', level: s.cpu.level, seed: s.cpu.seed }] });
        ctl.start();
        run = T.recordFloorResult(run, { floor: run.floor, result: ctl.winner === 0 ? 'w' : 'l', turns: ctl.turn, faints: 0 }, { pack }).run;
      } else run = T.takeBuff(run, pick(run, rng)).run;
    }
    reached.push(run.history.filter((h) => h.result === 'w').length);
    if (run.phase === 'won') won++;
  }
  const mean = (reached.reduce((a, b) => a + b, 0) / reached.length).toFixed(1);
  console.log(`${fmt} ${name.padEnd(14)} bot=${LEVEL} runs=${N}: floors cleared mean ${mean}, median ${quant(reached, 0.5)}, p10 ${quant(reached, 0.1)}, p90 ${quant(reached, 0.9)}, max ${Math.max(...reached)}; won ${won}/${N}  (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
}

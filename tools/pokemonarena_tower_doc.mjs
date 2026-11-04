// tools/pokemonarena_tower_doc.mjs -- keeps the TABLES in pokemonarena/TOWER.md equal to the code that defines them.
//
//   node tools/pokemonarena_tower_doc.mjs           rewrite the generated blocks in pokemonarena/TOWER.md
//   node tools/pokemonarena_tower_doc.mjs --check   exit 1 if TOWER.md is out of date (the Tower test calls blocks() the same way)
//
// TOWER.md is prose written by hand plus blocks between `<!-- BEGIN gen:NAME -->` and `<!-- END gen:NAME -->`. Everything between a pair of markers is generated from tower_config.js,
// tower_buffs.js, tower.js and achievements.js; edit the code, run this, and the document follows. Nothing here reads the ROM.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const DOC = path.join(root, 'pokemonarena', 'TOWER.md');
const POINTS = [1, 2, 4, 8];
const cell = (s) => String(s).replace(/\|/g, '/').replace(/\n/g, ' ');
const table = (head, rows) => ['| ' + head.join(' | ') + ' |', '| ' + head.map(() => '---').join(' | ') + ' |', ...rows.map((r) => '| ' + r.map(cell).join(' | ') + ' |')].join('\n');

/** The generated blocks, from the four Tower modules (passed in so a test can render a mutated copy). */
export function blocks({ B, C, A, T }) {
  const CFG = C.CONFIG, out = {};
  const perTier = [0, 1, 2, 3].map((t) => B.FAMILIES.filter((f) => f.tiers[0] <= t && t <= f.tiers[1]).length);
  const only = [0, 1, 2, 3].map((t) => B.FAMILIES.filter((f) => f.tiers[0] === t && f.tiers[1] === t).length);
  const levels = B.SYNERGIES.reduce((n, s) => n + (s.levels ? s.levels.length : 1), 0);
  const kinds = (k) => B.SYNERGIES.filter((s) => s.kind === k).length;
  const typeFams = B.FAMILIES.filter((f) => f.cat === 'type').length;
  out.counts = table(['What', 'How many'], [
    ['Buff families', `${B.FAMILIES.length} (${B.FAMILIES.length - typeFams} general + ${typeFams} type-themed)`],
    ['Families that can be offered as a green / blue / purple / gold ball', perTier.join(' / ')],
    ['Families offered at one tier only (green / blue / purple / gold)', only.join(' / ')],
    ['Curses (a real cost for a bigger reward)', B.FAMILIES.filter((f) => f.curse).length],
    ['Synergies', `${B.SYNERGIES.length}, in ${levels} levels: ${kinds('tag')} tag sets (${kinds('tag') - 18} general + 18 per-type), ${kinds('combo')} named combos, ${kinds('mult')} multipliers`],
    ['Achievements', `${A.ACHIEVEMENTS.length} (${[1, 2, 3, 4].map((g) => A.ACHIEVEMENTS.filter((a) => a.grade === g).length).join(' / ')} by green / blue / purple / gold grade)`],
    ['Floors', `${CFG.floors}, a boss every ${CFG.bossEvery}th`],
  ]);

  const rows = [];
  for (let f = 1; f <= CFG.floors; f++) {
    const a = T.floorSpec(f, '3v3', CFG), b = T.floorSpec(f, '6v6', CFG);
    rows.push([a.boss ? `**${f}**` : f, a.boss ? '**boss**' : 'trainer', a.cpu, a.size, b.size, (a.evPm / 10) + '%', a.evBonus ? '+' + a.evBonus : '-', a.ivCap, a.itemMode]);
  }
  out.floors = table(['Floor', 'Who', 'CPU', 'Team (3v3)', 'Team (6v6)', 'EVs', 'Extra EVs / stat', 'IV cap', 'Items'], rows);

  const w = (e) => e.w.map((x) => x + '%').join(' / ');
  out.odds = [
    'Ordinary floors (the row whose "from" is the highest one not above the floor just cleared):', '',
    table(['From floor cleared', 'green / blue / purple / gold'], CFG.offer.tierWeights.map((e) => [e.from, w(e)])), '',
    'After a boss (floors 10 and 20; 30 is the top and ends the run):', '',
    table(['From floor cleared', 'green / blue / purple / gold'], CFG.offer.bossWeights.map((e) => [e.from, w(e)])),
  ].join('\n');

  const eff = (f, tier) => B.describeOps(f.ops, POINTS[tier], { cfg: CFG });
  const fr = [];
  for (const f of B.FAMILIES) {
    if (f.cat === 'type') continue;
    const lo = f.tiers[0], hi = f.tiers[1], cap = B.capOf(f, CFG);
    const offered = lo === hi ? C.TIERS[lo].id + ' only' : C.TIERS[lo].id + ' - ' + C.TIERS[hi].id;
    const text = lo === hi ? eff(f, lo) : eff(f, lo) + '  ->  ' + eff(f, hi);
    fr.push([f.name + (f.curse ? ' (curse)' : ''), f.cat, offered, cap < CFG.powerCap ? cap : '16', f.tags.join(', '), text]);
  }
  out.families = table(['Family', 'Kind', 'Offered as', 'Power cap', 'Tags', 'Effect (first tier offered -> top tier offered)'], fr);

  const fire = B.FAMILIES.filter((f) => f.cat === 'type' && f.tags.includes('fire'));
  out.typefamilies = table(['Family (Fire shown; 18 types)', 'Offered as', 'Effect (green -> gold)'], fire.map((f) => [f.name, C.TIERS[f.tiers[0]].id + ' - ' + C.TIERS[f.tiers[1]].id, eff(f, f.tiers[0]) + '  ->  ' + eff(f, f.tiers[1])]));

  const tagRows = B.SYNERGIES.filter((s) => s.kind === 'tag' && !s.id.startsWith('affinity-')).map((s) => [s.levels.map((l) => l.name).join(' / '), 'any ' + s.levels.map((l) => l.need).join(' / ') + ' "' + s.tag + '" families', s.levels.map((l) => l.text).join('  ||  ')]);
  const aff = B.SYNERGIES.find((s) => s.id === 'affinity-fire');
  tagRows.push(['<Type> Affinity / <Type> Mastery (18 types)', '2 / 3 families of that type (e.g. fire: ' + aff.levels.map((l) => l.need).join(' / ') + ')', aff.levels.map((l) => l.text.replace(/Fire/g, '<Type>')).join('  ||  ')]);
  out.tagsets = table(['Synergy (level 1 / level 2)', 'Needs', 'Effect'], tagRows);
  out.combos = table(['Combo', 'Families needed (all of them)', 'Effect'], B.SYNERGIES.filter((s) => s.kind === 'combo').map((s) => [s.name, s.needs.map((n) => B.FAMILY_BY_ID[n].name).join(' + '), s.text]));
  out.mults = table(['Multiplier', 'Switches on with', 'Effect'], B.SYNERGIES.filter((s) => s.kind === 'mult').map((s) => [s.name, s.when.min + ' "' + s.when.tag + '" families', s.text]));

  const GR = ['green', 'blue', 'purple', 'gold'];
  out.achievements = table(['Grade', 'Achievement', 'How'], A.ACHIEVEMENTS.map((a) => [GR[a.grade - 1], a.name, a.desc]));

  out.balls = table(['Rarity', 'Also called', 'Power points', 'Colour', 'ROM ball sprite', 'Dominant hue (measured on the ROM by the test)'], C.TIERS.map((t, i) => [t.id, t.alias, t.points, t.color, 'ballGfx index ' + t.ball, C.BALL_STYLE[i].hue]));

  const ex = (id, p) => { const f = B.FAMILY_BY_ID[id]; return B.describeOps(f.ops, p, { cfg: CFG }); };
  out.worked = table(['Power Training at power', 'Effect on the better attacking stat'], [1, 2, 3, 4, 6, 8, 12, 16].map((p) => [p + ' (' + GR[B.tierOfPower(p)] + ')', ex('power-training', p)]));
  return out;
}

const PAIR = /<!-- BEGIN gen:([a-z-]+) -->\n[\s\S]*?\n<!-- END gen:\1 -->/g;
/** TOWER.md with every generated block replaced by the current one. Throws when a block the document asks for is not generated. */
export function render(doc, gen) {
  return doc.replace(PAIR, (_m, name) => {
    if (!(name in gen)) throw new Error('TOWER.md asks for a generated block "' + name + '" that tools/pokemonarena_tower_doc.mjs does not make');
    return `<!-- BEGIN gen:${name} -->\n${gen[name]}\n<!-- END gen:${name} -->`;
  });
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const imp = (f) => import(pathToFileURL(path.join(root, 'pokemonarena', 'js', f)).href);
  const [T, B, C, A] = await Promise.all(['tower.js', 'tower_buffs.js', 'tower_config.js', 'achievements.js'].map(imp));
  const doc = fs.readFileSync(DOC, 'utf8'), next = render(doc, blocks({ B, C, A, T }));
  if (process.argv.includes('--check')) { if (next !== doc) { console.log('pokemonarena/TOWER.md is out of date: run node tools/pokemonarena_tower_doc.mjs'); process.exit(1); } console.log('TOWER.md tables are current'); }
  else { fs.writeFileSync(DOC, next); console.log(next === doc ? 'TOWER.md already current' : 'TOWER.md updated'); }
}

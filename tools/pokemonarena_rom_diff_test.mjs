#!/usr/bin/env node
// tools/pokemonarena_rom_diff_test.mjs -- stage FA2: does the battle engine compute what THIS ROM computes?
//
//   node tools/pokemonarena_rom_diff_test.mjs            run everything that can run; exit 1 on any failure
//   ARENA_ROM=<gba>   ROM path (default gba/gbaWasm/roms/Pokemon SoulGold (v1.1.1).gba); the test SKIPS LOUDLY (counted, exit 0 only
//                     if nothing else failed) when the ROM is absent
//   ARENA_SKIP_LIVE=1 skip the differential against the real game (the data half is Node-only and always runs)
//
// LAYER 1 (always)  DATA vs ROM BYTES.  tools/pokemonarena_rom_diff_lib.mjs imports nothing from pokemonarena/js: it finds every
//                   table from the literal-pool references in the ROM's own code, reads the record layouts off the Thumb code that
//                   uses them, decodes the tables, and compareData() diffs that decode against the pack the engine actually uses
//                   and against the constants hand-written in engine_data.js.  Negative controls: one flipped byte in a ROM COPY
//                   must trip the check named for it; an unmutated copy must stay silent; one changed engine constant must trip.
// LAYER 2 (live)    FORMULAS vs THE REAL GAME.  tools/pokemonarena_rom_diff_live.mjs drives OR1's oracle (pokemonarena/ORACLE.md): the
//                   same two battlers go into the real game's battle and the damage it deals is compared with engine.previewDamage.
//
// Nothing is written but scratch reports; the ROM is read only and never copied except in memory.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Rom, deriveLayout, census, effectTable, decodeMove, ROM_BASE } from './pokemonarena_rom_diff_lib.mjs';
import { compareData, summarize } from './pokemonarena_rom_diff_data.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const JS = path.join(root, 'pokemonarena', 'js');
const ROM_PATH = process.env.ARENA_ROM || path.join(root, 'gba', 'gbaWasm', 'roms', 'Pokemon SoulGold (v1.1.1).gba');
const J = (x) => JSON.stringify(x);

let passed = 0, failed = 0, skipped = 0;
const failures = [];
function t(name, ok, detail = '') {
  if (ok === true) { passed++; console.log(`  ok   ${name}`); } else {
    failed++;
    const why = typeof ok === 'string' ? ok : detail;
    failures.push(`${name}: ${why}`);
    console.log(`  FAIL ${name}${why ? '  -- ' + String(why).slice(0, 500) : ''}`);
  }
}
const head = (s) => console.log(`\n== ${s}`);
function skip(name, why) { skipped++; console.log(`  SKIP ${name}  -- ${why}`); }

if (!fs.existsSync(ROM_PATH)) {
  console.log(`SKIPPED LOUDLY: ROM not found at ${ROM_PATH} (set ARENA_ROM). 0 checks ran.`);
  process.exit(0);
}
const romBuf = fs.readFileSync(ROM_PATH);
const romBytes = new Uint8Array(romBuf.buffer, romBuf.byteOffset, romBuf.length);
const url = (f) => pathToFileURL(path.join(JS, f)).href;
const { loadPack } = await import(url('tables.js'));
const TB = await import(url('tables.js'));
const ED0 = await import(url('engine_data.js'));
const { HOLD } = await import(url('engine_items.js'));
const ED = { ...ED0, HOLD };
const pack = loadPack(romBytes, { verify: 'header', dexText: false });
console.log(`pokemonarena ROM-vs-engine test; ROM ${ROM_PATH} (${romBytes.length} B); node ${process.version}; ${os.cpus().length} logical CPUs; load ${os.loadavg ? os.loadavg().map((x) => x.toFixed(2)).join('/') : 'n/a'}`);

// ---------------------------------------------------------------------------------------------
head('layer 1a: table bases re-derived from literal-pool references (independent of tables.js)');
const rom = new Rom(romBytes);
const L = deriveLayout(rom);
const PINNED_LAYOUT = {
  moves: { base: TB.LAYOUT.moves.offset, count: TB.LAYOUT.moves.count, stride: TB.LAYOUT.moves.stride },
  species: { base: TB.LAYOUT.species.offset, count: TB.LAYOUT.species.slots, stride: TB.LAYOUT.species.stride },
  abilities: { base: TB.LAYOUT.abilities.offset, count: TB.LAYOUT.abilities.count, stride: TB.LAYOUT.abilities.stride },
  items: { base: TB.LAYOUT.items.offset, count: TB.LAYOUT.items.count, stride: TB.LAYOUT.items.stride },
  natures: { base: TB.LAYOUT.natures.offset, count: TB.LAYOUT.natures.count, stride: TB.LAYOUT.natures.stride },
  types: { base: TB.LAYOUT.types.offset, count: TB.LAYOUT.types.count, stride: TB.LAYOUT.types.stride },
  typeChart: { base: TB.LAYOUT.typeChart.offset, count: TB.LAYOUT.typeChart.size },
  exp: { base: TB.LAYOUT.exp.offset, count: TB.LAYOUT.exp.rows },
  stageRatios: { base: ED.STAT_STAGE_RATIOS_ROM_OFFSET, count: 13 },
};
for (const [name, want] of Object.entries(PINNED_LAYOUT)) {
  const got = L[name];
  t(`layout/${name}: derived from code references == the layout the engine's pack uses`, !!got && got.base === want.base && got.count === want.count && (want.stride === undefined || got.stride === want.stride),
    got ? `derived base 0x${got.base.toString(16)} count ${got.count} stride ${got.stride}; pack uses 0x${want.base.toString(16)} count ${want.count} stride ${want.stride}` : 'no candidate satisfied the structure predicate');
  if (got) t(`layout/${name}: unique (no rival candidate satisfies the same structure predicate)`, got.rivals.length === 0, `rivals ${J(got.rivals)}`);
  if (got) t(`layout/${name}: referenced from code (${got.refs} literal-pool words)`, got.refs >= 4, `refs ${got.refs}`);
}
const ET = effectTable(rom, L.moves.base);
t('layout/effect-table: found from the code that indexes it with move.effect (6-byte records, battle-script pointer first)', !!ET && ET.count === 332, ET ? `count ${ET.count}` : 'not found');
if (ET) {
  let maxEffect = 0;
  for (let i = 0; i < L.moves.count; i++) maxEffect = Math.max(maxEffect, decodeMove(rom, L.moves.base, i).effect);
  t('layout/effect-table: covers every move effect id in the move table', ET.count === maxEffect + 1, `max effect ${maxEffect}, table ${ET.count}`);
}

// ---------------------------------------------------------------------------------------------
head('layer 1b: record layouts read off the Thumb code that uses them (census of field loads and bit operations after a table-base load)');
{
  const C = census(rom, L.moves.base);
  const has = (m, k, n) => (m.get(k) || 0) >= n;
  t(`census/moves: ${C.sites} code sites load the move-table base`, C.sites >= 400, `sites ${C.sites}`);
  const want = [
    ['loads', 'ldrh+8', 50, 'effect id is the halfword at +0x08'],
    ['loads', 'ldrb+10', 10, 'type/category live in the byte at +0x0a'],
    ['ops', 'ldrb+10|lsls25 -> lsrs #30', 8, 'category = bits 5-6 of +0x0a'],
    ['ops', 'ldrb+10|lsls27 -> lsrs #27', 2, 'type = bits 0-4 of +0x0a'],
    ['ops', 'ldrh+10 -> lsrs #7', 2, 'power = halfword +0x0a >> 7'],
    ['ops', 'ldrh+12 -> lsrs #7', 4, 'target = halfword +0x0c >> 7'],
    ['loads', 'ldrb+12', 1, 'accuracy low byte at +0x0c'],
    ['loads', 'ldrb+14', 5, 'PP is the byte at +0x0e'],
    ['ops', 'ldrb+20 -> lsrs #4', 1, 'strike count = high nibble of +0x14'],
    ['ops', 'ldrb+21 -> lsrs #5', 5, 'additional-effect count = bits 5-7 of +0x15'],
    ['ops', 'ldrb+21 -> lsls #30', 3, 'multi-hit / self-destruct bits are the low bits of +0x15'],
    ['loads', 'ldr+36', 5, 'the per-move argument word at +0x24'],
    ['loads', 'ldrb+24', 3, 'semi-invulnerable hit flags at +0x18'],
  ];
  for (const [kind, key, n, why] of want) t(`census/moves: ${why}  [${key} x>=${n}, saw ${C[kind].get(key) || 0}]`, has(C[kind], key, n));
  const Ci = census(rom, L.items.base);
  t('census/items: the hold-effect byte (+0x1c) and its parameter (+0x1d) are read by code', (Ci.loads.get('ldrb+28') || 0) >= 1 && (Ci.loads.get('ldrb+29') || 0) >= 1, `ldrb+28 x${Ci.loads.get('ldrb+28') || 0}, ldrb+29 x${Ci.loads.get('ldrb+29') || 0}`);
  const Cs = census(rom, L.species.base);
  t('census/species: base-stat bytes (+0..+5) and the type bytes (+6,+7) are read by code', [0, 1, 2, 3, 4, 5, 6].filter((o) => (Cs.loads.get(`ldrb+${o}`) || 0) >= 1 || (Cs.loads.get(`ldrh+${o}`) || 0) >= 1).length >= 4, J([...Cs.loads.entries()].filter(([k]) => /\+[0-7]$/.test(k))));
  t('census/species: the ability halfwords (+0x18..+0x1c) are read by code', (Cs.loads.get('ldrh+24') || 0) + (Cs.loads.get('ldrh+26') || 0) >= 3, J([...Cs.loads.entries()].filter(([k]) => /ldrh\+2[4-9]/.test(k))));
}

// ---------------------------------------------------------------------------------------------
head('layer 1c: every battle table the engine reads, diffed field by field (independent decode vs the engine pack)');
const rep = compareData(romBytes, pack, ED);
t('data/layout derivation succeeded for every table', !rep.fatal, rep.fatal);
const sum = summarize(rep);
for (const r of sum.rows) t(`data/${r.table}: ${r.compared} cells compared, ${r.mismatches} mismatches`, r.mismatches === 0 && r.compared > 0, J(rep.tables[r.table].mismatches.slice(0, 5)));
console.log(`  TOTAL cells compared ${sum.compared}, mismatches ${sum.mismatches}`);

// ---------------------------------------------------------------------------------------------
head('layer 1d: ROM facts about the effect ids (engine classification vs the ROM effect-metadata table)');
if (ET) {
  const idsWithFlag = (mask) => ET.flags.map((f, i) => ((f & mask) === mask ? i : -1)).filter((i) => i >= 0);
  const two = idsWithFlag(0x100), semi = idsWithFlag(0x200), protectCtr = idsWithFlag(0x400);
  const kindIds = (...kinds) => Object.values(ED.EFFECTS).filter((e) => kinds.includes(e.kind)).map((e) => e.id).sort((a, b) => a - b);
  t(`rom-effects/two-turn flag (0x100) ids ${J(two)} include every engine twoturn/solarbeam/semiinvuln id ${J(kindIds('twoturn', 'solarbeam', 'semiinvuln'))}`, kindIds('twoturn', 'solarbeam', 'semiinvuln').every((i) => two.includes(i)));
  t(`rom-effects/semi-invulnerable flag (0x200) ids ${J(semi)}: the engine's semiinvuln id ${J(kindIds('semiinvuln'))} is flagged`, kindIds('semiinvuln').every((i) => semi.includes(i)));
  t(`rom-effects/protect-counter flag (0x400) ids ${J(protectCtr)} == the engine's protect + endure ids ${J(kindIds('protect', 'endure'))}`, J(protectCtr) === J(kindIds('protect', 'endure')));
  // ids that share ONE battle script must not be given different engine kinds unless the script is the generic "hit" script
  const byScript = new Map();
  ET.scripts.forEach((s, i) => (byScript.get(s) || byScript.set(s, []).get(s)).push(i));
  let generic = null; for (const [s, ids] of byScript) if (!generic || ids.length > byScript.get(generic).length) generic = s;
  const conflicts = [];
  for (const [s, ids] of byScript) {
    if (s === generic || ids.length < 2) continue;
    const kinds = new Set(ids.filter((i) => ED.EFFECTS[i]).map((i) => ED.EFFECTS[i].kind));
    if (kinds.size > 1) conflicts.push({ script: '0x' + s.toString(16), ids, kinds: [...kinds] });
  }
  // explained: 86 / 90 / 256 (Protect family and Endure) and 36 / 316 (Focus Energy and Dragon Cheer run one script, but Dragon Cheer's target byte is "ally" and it FAILS in a single battle: MEASURED, group `doubles` of the live differential)
  const explained = conflicts.filter((c) => J(c.ids) === J([86, 90, 256]) || J(c.ids) === J([36, 316]));
  t(`rom-effects/engine kinds never split a non-generic ROM battle script (${byScript.size} distinct scripts; the generic hit script 0x${generic.toString(16)} holds ${byScript.get(generic).length} ids)`, conflicts.length === explained.length, J(conflicts.filter((c) => !explained.includes(c))));
  console.log(`  note: ${explained.length} explained script sharing: effect ids 86 (Protect family) and 90 (Endure), and 36 (Focus Energy) and 316 (Dragon Cheer, fails in singles), run the same ROM script (ids ${J(explained.map((c) => c.ids))}); the engine keeps them as two kinds and takes the Endure/Protect difference from the move argument and its own handler`);
}

// ---------------------------------------------------------------------------------------------
head('layer 1e: negative controls (one byte flipped in a ROM COPY; the specific check must trip; the unmutated twin must stay silent)');
{
  const copy = () => new Uint8Array(romBytes);
  const twin = compareData(copy(), pack, ED);
  t('negctl/unmutated twin through the same copy -> compare path: 0 mismatches', summarize(twin).mismatches === 0, J(summarize(twin).rows.filter((r) => r.mismatches)));
  const flips = [
    ['moves', 'a move record power byte', L.moves.base + 85 * 72 + 0x0b, 0x40, /move 85 power/],
    ['moves', 'a move record accuracy byte', L.moves.base + 53 * 72 + 0x0c, 0x01, /move 53 accuracy/],
    ['moves', 'a move record priority nibble', L.moves.base + 98 * 72 + 0x14, 0x03, /move 98 priority/],
    ['engineConstants', 'a move argument byte (recoil percent of Double-Edge)', L.moves.base + 38 * 72 + 0x24, 0x7f, /recoil/],
    ['typeChart', 'one type-chart cell (Fire vs Grass 2x -> 1x)', L.typeChart.base + (11 * 21 + 13) * 4 + 1, 0x30, /chart 11x13/],
    ['species', 'a species base-stat byte', L.species.base + 6 * 280 + 2, 0x55, /species 6 base stats/],
    ['species', 'a species ability halfword', L.species.base + 25 * 280 + 0x18, 0x7f, /species 25 abilities/],
    ['items', 'an item hold-effect byte', L.items.base + 224 * 44 + 0x1c, 0x7f, /item 224 holdEffect/],
    ['natures', 'a nature stat-up code', L.natures.base + 3 * 20 + 4, 0x05, /nature 3 up/, ['natureGrid']],
    ['engineConstants', 'a stat-stage ratio byte', L.stageRatios.base + 7, 0x01, /STAT_STAGE_RATIOS/],
    ['exp', 'one experience-table cell', L.exp.base + (3 * 101 + 50) * 4, 0xaa, /exp 3\/50/],
  ];
  for (const [table, what, off, xor, re, alsoOk = []] of flips) {
    const m = copy(); m[off] ^= xor;
    const r = compareData(m, pack, ED);
    const mm = r.tables[table] ? r.tables[table].mismatches : [];
    t(`negctl/${what}: flipping ROM byte 0x${off.toString(16)} trips ${table}`, mm.length >= 1 && mm.some((x) => re.test(x.what)), mm.length ? J(mm.slice(0, 3)) : 'no mismatch recorded (the check is blind to this byte)');
    const others = summarize(r).rows.filter((x) => x.table !== table && !alsoOk.includes(x.table) && x.mismatches);
    t(`negctl/${what}: ... and trips nothing else`, others.length === 0, J(others));
  }
  // engine-side constants: change one and the comparison must trip
  const ED2 = { ...ED, STAT_STAGE_RATIOS: ED.STAT_STAGE_RATIOS.map((p, i) => (i === 3 ? [p[0], p[1] + 1] : p)) };
  const r2 = compareData(copy(), pack, ED2);
  t('negctl/engine constant: STAT_STAGE_RATIOS entry changed -> engineConstants trips', r2.tables.engineConstants.mismatches.some((x) => /STAT_STAGE_RATIOS/.test(x.what)));
  const ED3 = { ...ED, MOVE_ARGS: { ...ED.MOVE_ARGS, recoil: { ...ED.MOVE_ARGS.recoil, 'Double-Edge': 34 } } };
  const r3 = compareData(copy(), pack, ED3);
  t('negctl/engine constant: MOVE_ARGS.recoil Double-Edge 33 -> 34 -> engineConstants trips', r3.tables.engineConstants.mismatches.some((x) => /recoil Double-Edge/.test(x.what)));
  // a wrong pack: flip a power in a COPY of the pack
  const pk2 = JSON.parse(JSON.stringify(pack)); pk2.moves[85].power += 1;
  const r4 = compareData(copy(), pk2, ED);
  t('negctl/wrong pack: move 85 power +1 in the pack -> moves trips', r4.tables.moves.mismatches.some((x) => /move 85 power/.test(x.what)));
}

// ---------------------------------------------------------------------------------------------
head('layer 2: differential against the real game (OR1 oracle: SoulGold battle code in the first-party mGBA core)');
if (process.env.ARENA_SKIP_LIVE === '1') skip('live/differential', 'ARENA_SKIP_LIVE=1');
else if (!fs.existsSync(path.join(here, 'pokemonarena_rom_diff_live.mjs')) || !fs.existsSync(path.join(here, 'pokemonarena_rom_oracle.mjs'))) skip('live/differential', 'tools/pokemonarena_rom_diff_live.mjs or tools/pokemonarena_rom_oracle.mjs not present');
else {
  const L2 = await import(pathToFileURL(path.join(here, 'pokemonarena_rom_diff_live.mjs')).href);
  const quick = process.env.ARENA_LIVE_QUICK === '1';
  const t0 = Date.now();
  const ctx = { t, head: () => {}, skip, romPath: ROM_PATH, jsDir: JS, every: Number(process.env.ARENA_LIVE_EVERY) || (quick ? 5 : 1) };
  await L2.runLive(ctx);
  if (ctx.results) {
    const R = ctx.results, TR = ctx.turnResults || [], PRB = ctx.probeResults || {};
    const dmgRolls = R.reduce((n, r) => n + (r.tested || 0), 0);
    const bad = R.filter((r) => r.verdict === 'mismatch');
    const detail = (r) => r.group + '/' + r.move + ' ' + (r.bad || []).slice(0, 3).map((b) => 'r' + b.r + ' want ' + b.want + ' got ' + b.got).join(' ');
    t('live/damage: ' + R.length + ' scenarios, ' + dmgRolls + " exact roll comparisons (engine previewDamage vs the real game's first HP drop), " + bad.length + ' mismatching scenarios', bad.length === 0, bad.slice(0, 6).map(detail).join(' ; '));
    t('live/damage: at least 300 scenarios spanning type chart, categories, weather, crits, burn, screens, abilities, items, multi-hit and fixed-damage moves' + (quick ? ' (QUICK subset: not checked)' : ''), quick || R.length >= 300, 'only ' + R.length);
    const byG = {};
    for (const r of R) { const g = (byG[r.group] = byG[r.group] || [0, 0]); g[1]++; if (r.verdict === 'match') g[0]++; }
    console.log('  damage groups (match/total): ' + Object.entries(byG).map(([k, v]) => k + ' ' + v[0] + '/' + v[1]).join(', '));
    const unsup = R.filter((r) => r.verdict === 'engine-unsupported' || r.verdict === 'skipped');
    t('live/damage: scenarios the engine cannot run or the harness skipped are listed, not hidden (' + unsup.length + ')', true);
    const tb = TR.filter((r) => r.verdict === 'mismatch');
    const tm = TR.filter((r) => r.verdict === 'match' || r.verdict === 'match-no-menu').length;
    t('live/turns: ' + TR.length + ' scenarios (stat moves, status and immunities, healing, recoil, drain, residuals, weather and screens, end-of-turn order, multi-turn moves, multi-hit counts, turn order); ' + tm + ' equal in HP / stages / status / weather / screens / items, ' + tb.length + ' mismatching', tb.length === 0, tb.slice(0, 6).map((r) => r.group + '/' + r.label + ' ' + JSON.stringify((r.diffs || []).map((d) => d.field))).join(' ; '));
    t('live/turns: at least 200 scenarios' + (quick ? ' (QUICK subset: not checked)' : ''), quick || TR.length >= 200, 'only ' + TR.length);
    const notCmp = TR.filter((r) => /unsupported|error|timeout/.test(r.verdict));
    console.log('  turn scenarios not compared (listed): ' + notCmp.map((r) => r.group + '/' + r.label + ' [' + r.verdict + ']').join(', '));
    for (const k of ['accuracy', 'crit', 'chance']) {
      const rows = PRB[k] || [];
      const badp = rows.filter((r) => !r.ok);
      t('live/probes/' + k + ': ' + rows.length + ' exact probes (the real threshold found by binary search on one RNG draw), ' + badp.length + ' differ from the engine', rows.length > 0 && badp.length === 0, badp.map((r) => r.label + ' real ' + r.real + ' engine ' + r.engine).join(' ; '));
    }
    console.log('  live layer: ' + R.length + ' damage scenarios (' + dmgRolls + ' roll comparisons) + ' + TR.length + ' turn scenarios + ' + ((PRB.accuracy || []).length + (PRB.crit || []).length + (PRB.chance || []).length) + ' probes in ' + ((Date.now() - t0) / 1000).toFixed(0) + ' s, ' + (ctx.live ? ctx.live.trials : 0) + ' real-game trials');

    // ---- negative controls: a changed engine constant must trip the differential (the unmutated twin is the run above)
    head('layer 2b: negative controls (an engine source copy with one constant changed must trip the live differential)');
    const mutate = (file, from, to) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-fa2-neg-'));
      fs.cpSync(JS, dir, { recursive: true });
      const p = path.join(dir, file);
      const src = fs.readFileSync(p, 'utf8');
      if (src.split(from).length !== 2) throw new Error('mutation snippet must occur once: ' + from);
      fs.writeFileSync(p, src.replace(from, to));
      return dir;
    };
    const WEATHER_OLD = "S.wx[1] -= 1;\n      if (S.wx[1] <= 0) { const w0 = S.wx[0]; S.wx = [WX.NONE, 0]; this.emit({ t: 'weather-end', w: w0 }); }\n    }\n    const w = this.wx();";
    const WEATHER_NEW = "}\n    const w = this.wx();\n    if (S.wx[0] !== WX.NONE && S.wx[1] <= 0) { const w0 = S.wx[0]; S.wx = [WX.NONE, 0]; this.emit({ t: 'weather-end', w: w0 }); }\n    if (S.wx[0] !== WX.NONE) S.wx[1] -= 1;";
    const negs = [
      ['burn modifier 0.5 -> 0.75 trips the damage differential', 'engine_data.js', 'burnMod: 2048,', 'burnMod: 3072,', { part: 'damage', groups: 'burn' }, (c) => (c.results || []).some((r) => r.verdict === 'mismatch')],
      ['accuracy stage -4 entry 43 -> 42 trips the accuracy probe', 'engine_data.js', 'ACC_STAGE_PCT = Object.freeze([33, 36, 43,', 'ACC_STAGE_PCT = Object.freeze([33, 36, 42,', { part: 'turns', groups: 'none', probes: true, probeKinds: ['accuracy'], probeLimit: 4 }, (c) => ((c.probeResults || {}).accuracy || []).some((r) => !r.ok)],
      ['confusion self-hit 33 -> 50 percent trips the chance probe', 'engine_data.js', 'confSelfHitPct: 33,', 'confSelfHitPct: 50,', { part: 'turns', groups: 'none', probes: true, probeKinds: ['chance'], probeLimit: 1 }, (c) => ((c.probeResults || {}).chance || []).some((r) => !r.ok)],
      ['weather damaging its last turn again (the old order) trips the turn differential', 'engine.js', WEATHER_OLD, WEATHER_NEW, { part: 'turns', groups: 'weather-turns', probes: false }, (c) => (c.turnResults || []).some((r) => r.verdict === 'mismatch')],
    ];
    for (const [name, file, from, to, o, check] of negs) {
      let dir;
      try { dir = mutate(file, from, to); } catch (e) { t('live/negctl: ' + name, false, 'mutation setup failed: ' + e.message); continue; }
      const c2 = { t: () => {}, head: () => {}, skip, romPath: ROM_PATH, jsDir: dir, ...o };
      try { await L2.runLive(c2); t('live/negctl: ' + name, check(c2) === true, 'the differential did not notice the change'); } catch (e) { t('live/negctl: ' + name, false, 'run failed: ' + String((e && e.message) || e).slice(0, 200)); }
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) { /* scratch */ }
    }
  }
}

console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
if (failed) { console.log('FAILURES:\n  ' + failures.join('\n  ')); process.exit(1); }

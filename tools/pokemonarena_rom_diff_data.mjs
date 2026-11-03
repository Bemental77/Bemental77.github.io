// tools/pokemonarena_rom_diff_data.mjs -- the DATA-vs-ROM-BYTES comparison of stage FA2.
//
// compareData(romBytes, pack, engineData) decodes every table the battle engine reads straight from `romBytes` with the
// INDEPENDENT reader in pokemonarena_rom_diff_lib.mjs (own table discovery from literal-pool references, own record layouts,
// own text decode) and diffs it field by field against `pack` (the object the engine actually uses, built by pokemonarena/js/tables.js)
// and against the constants hand-written in engine_data.js.  It returns plain data: how many cells were compared per table and
// the list of mismatches.  Run it on a ROM copy with one byte flipped and the mismatch list must become non-empty (negative control).
// Pure ASCII.  Nothing here is ROM content.

import {
  Rom, deriveLayout, decodeMove, decodeSpecies, decodeItem, decodeAbility, decodeNature, decodeTypeChart, text, refsTo, ROM_BASE,
} from './pokemonarena_rom_diff_lib.mjs';

const STAT_OF_NATURE_CODE = { 1: 'atk', 2: 'def', 3: 'spe', 4: 'spa', 5: 'spd' };
const STAT_KEYS = ['hp', 'atk', 'def', 'spe', 'spa', 'spd']; // ROM struct order

/** the engine's pack renders names with its own codec; reduce both sides to a comparable ASCII skeleton */
const skel = (s) => (s === null || s === undefined ? '' : String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\{[^}]*\}/g, '#').replace(/[^\x20-\x7e]/g, '#'));

export function compareData(romBytes, pack, E) {
  const rom = new Rom(romBytes);
  const L = deriveLayout(rom);
  const out = { layout: L, tables: {}, notes: [] };
  const tab = (name) => (out.tables[name] = { compared: 0, mismatches: [] });
  const cmp = (T, what, got, want) => { T.compared++; if (JSON.stringify(got) !== JSON.stringify(want)) T.mismatches.push({ what, rom: got, pack: want }); };

  if (!L.moves || !L.species || !L.abilities || !L.items || !L.natures || !L.typeChart || !L.types || !L.stageRatios) { out.fatal = 'layout derivation failed: ' + Object.entries(L).filter(([, v]) => !v).map(([k]) => k).join(','); return out; }

  // ---- moves -------------------------------------------------------------------------------------------------------
  {
    const T = tab('moves');
    const n = L.moves.count;
    cmp(T, 'count', n, pack.moves.length);
    for (let i = 0; i < Math.min(n, pack.moves.length); i++) {
      const r = decodeMove(rom, L.moves.base, i), p = pack.moves[i];
      const w = (k) => `move ${i} ${k}`;
      cmp(T, w('name'), skel(r.name), skel(p.name));
      cmp(T, w('effect'), r.effect, p.effect);
      cmp(T, w('type'), r.type, p.type);
      cmp(T, w('category'), r.category, p.category);
      cmp(T, w('power'), r.power, p.power);
      cmp(T, w('accuracy'), r.accuracy, p.accuracy);
      cmp(T, w('target'), r.target, p.target);
      cmp(T, w('pp'), r.pp, p.pp);
      cmp(T, w('priority'), r.priority, p.priority);
      cmp(T, w('strikeCount'), r.strikeCount, p.strikeCount);
      cmp(T, w('critStage'), r.critStage, p.critStage);
      cmp(T, w('alwaysCrit'), !!r.alwaysCrit, p.alwaysCrit);
      cmp(T, w('multiHit(bytes[5]&1)'), r.multiHit, p.bytes[5] & 1);
      cmp(T, w('selfDestruct(bytes[5]&2)'), r.selfDestruct, (p.bytes[5] >> 1) & 1);
      cmp(T, w('hitFlags(bytes[8])'), r.hitFlags, p.bytes[8]);
      cmp(T, w('flagsA'), r.flagsA, p.bytes[6]);
      cmp(T, w('flagsB'), r.flagsB, p.bytes[7]);
      const f = p.flags;
      const fa = r.flagsA, fb = r.flagsB;
      cmp(T, w('flag contact'), !!(fa & 1), f.contact); cmp(T, w('flag punch'), !!(fa & 0x20), f.punch); cmp(T, w('flag kick'), !!(fa & 0x40), f.kick);
      cmp(T, w('flag bite'), !!(fa & 0x80), f.bite); cmp(T, w('flag pulse'), !!(fb & 1), f.pulse); cmp(T, w('flag sound'), !!(fb & 2), f.sound);
      cmp(T, w('flag ball'), !!(fb & 4), f.ball); cmp(T, w('flag powder'), !!(fb & 8), f.powder); cmp(T, w('flag dance'), !!(fb & 16), f.dance);
      cmp(T, w('flag wind'), !!(fb & 32), f.wind); cmp(T, w('flag slicing'), !!(fb & 64), f.slicing); cmp(T, w('flag heal'), !!(fb & 128), f.heal);
      cmp(T, w('additional'), r.additional, p.additional.map((a) => [a.effect, a.flags, a.chance]));
    }
  }

  // ---- type chart ----------------------------------------------------------------------------------------------------
  {
    const T = tab('typeChart');
    const chart = decodeTypeChart(rom, L.typeChart.base, L.typeChart.count);
    cmp(T, 'size', chart.length, pack.typeChart.length);
    for (let a = 0; a < chart.length; a++) for (let d = 0; d < chart.length; d++) cmp(T, `chart ${a}x${d}`, chart[a][d], pack.typeChart[a][d]);
    const Tn = tab('typeNames');
    for (let i = 0; i < L.types.count; i++) cmp(Tn, `type ${i}`, skel(text(rom, L.types.base + i * 40, 10)), skel(pack.types[i].name));
  }

  // ---- species -------------------------------------------------------------------------------------------------------
  {
    const T = tab('species');
    cmp(T, 'slots', L.species.count, pack.species.length);
    for (let i = 0; i < Math.min(L.species.count, pack.species.length); i++) {
      const r = decodeSpecies(rom, L.species.base, i), p = pack.species[i];
      cmp(T, `species ${i} present`, r !== null, p !== null);
      if (!r || !p) continue;
      const w = (k) => `species ${i} ${k}`;
      cmp(T, w('name'), skel(r.name), skel(p.name));
      cmp(T, w('base stats'), r.base, STAT_KEYS.map((k) => p.baseStats[k]));
      cmp(T, w('types'), r.types, p.types);
      cmp(T, w('abilities'), r.abilities, p.abilities);
      cmp(T, w('innates'), r.innates, p.innates);
      cmp(T, w('weight'), r.weight, p.weight);
      cmp(T, w('height'), r.height, p.height);
      cmp(T, w('gender ratio'), r.genderRatio, p.genderRatio);
      cmp(T, w('growth'), r.growth, p.growthRate);
      cmp(T, w('catch rate'), r.catchRate, p.catchRate);
      cmp(T, w('exp yield'), r.expYield, p.expYield);
      cmp(T, w('ev yield'), r.evYield, STAT_KEYS.map((k) => p.evYield[k]));
      cmp(T, w('friendship'), r.friendship, p.friendship);
    }
  }

  // ---- items / abilities / natures ------------------------------------------------------------------------------------
  {
    const T = tab('items');
    cmp(T, 'count', L.items.count, pack.items.length);
    for (let i = 0; i < Math.min(L.items.count, pack.items.length); i++) {
      const r = decodeItem(rom, L.items.base, i), p = pack.items[i];
      cmp(T, `item ${i} name`, skel(r.name), skel(p.name));
      cmp(T, `item ${i} holdEffect`, r.holdEffect, p.holdEffect);
      cmp(T, `item ${i} param`, r.param, p.holdEffectParam);
      cmp(T, `item ${i} price`, r.price, p.price);
    }
    const A = tab('abilities');
    cmp(A, 'count', L.abilities.count, pack.abilities.length);
    for (let i = 0; i < Math.min(L.abilities.count, pack.abilities.length); i++) {
      const r = decodeAbility(rom, L.abilities.base, i), p = pack.abilities[i];
      cmp(A, `ability ${i} name`, skel(r.name), skel(p.name));
      cmp(A, `ability ${i} flags`, r.flags, p.flags);
      cmp(A, `ability ${i} rating`, r.rating, p.aiRating);
    }
    const N = tab('natures');
    cmp(N, 'count', L.natures.count, pack.natures.length);
    for (let i = 0; i < Math.min(L.natures.count, pack.natures.length); i++) {
      const r = decodeNature(rom, L.natures.base, i), p = pack.natures[i];
      cmp(N, `nature ${i} name`, skel(r.name), skel(p.name));
      cmp(N, `nature ${i} up`, STAT_OF_NATURE_CODE[r.up], p.up);
      cmp(N, `nature ${i} down`, STAT_OF_NATURE_CODE[r.down], p.down);
    }
    // the nature table must be the canonical 5x5 grid (up = floor(n/5), down = n%5) -- the ROM's own table is the authority; report any deviation
    const G = tab('natureGrid');
    for (let i = 0; i < 25; i++) { const r = decodeNature(rom, L.natures.base, i); cmp(G, `nature ${i} grid`, [r.up, r.down], [1 + Math.floor(i / 5), 1 + (i % 5)]); }
  }

  // ---- experience tables ------------------------------------------------------------------------------------------------
  {
    const T = tab('exp');
    for (let r = 0; r < 8; r++) for (let l = 0; l < 101; l++) cmp(T, `exp ${r}/${l}`, rom.u32(L.exp.base + (r * 101 + l) * 4), pack.exp[r][l]);
  }

  // ---- engine constants vs ROM -----------------------------------------------------------------------------------------
  if (E) {
    const T = tab('engineConstants');
    // stat-stage ratios (u8 pairs, stage -6 first)
    const sr = []; for (let s = 0; s < 13; s++) sr.push([rom.u8(L.stageRatios.base + 2 * s), rom.u8(L.stageRatios.base + 2 * s + 1)]);
    cmp(T, 'STAT_STAGE_RATIOS', E.STAT_STAGE_RATIOS.map((x) => [x[0], x[1]]), sr);
    cmp(T, 'STAT_STAGE_RATIOS_ROM_OFFSET', E.STAT_STAGE_RATIOS_ROM_OFFSET, L.stageRatios.base);
    out.stageRatios = sr;
    // per-move arguments (record +0x24 low byte)
    const idOf = (nm) => { for (let i = 0; i < pack.moves.length; i++) if (pack.moves[i].name === nm) return i; return -1; };
    const argOf = (nm) => { const id = idOf(nm); return id < 0 ? null : decodeMove(rom, L.moves.base, id).arg; };
    const group = (label, table) => { for (const [nm, v] of Object.entries(table)) cmp(T, `${label} ${nm}`, argOf(nm), v); };
    group('statusType', E.MOVE_ARGS.statusType);
    group('drain', E.MOVE_ARGS.drain);
    group('recoil', E.MOVE_ARGS.recoil);
    group('fixed', E.MOVE_ARGS.fixed);
    group('fraction', E.MOVE_ARGS.fraction);
    group('protect', E.MOVE_ARGS.protect);
    group('counter', E.MOVE_ARGS.counter);
    for (const [nm, v] of Object.entries(E.ROM_WEATHER_ARG)) cmp(T, `weather arg ${nm}`, argOf(nm), v);
    // setType arg is a type id
    for (const [nm, v] of Object.entries(E.MOVE_ARGS.setType)) cmp(T, `setType ${nm}`, argOf(nm), v);
    // type ids the engine names vs the ROM's type name table
    const tn = {}; for (let i = 0; i < L.types.count; i++) tn[text(rom, L.types.base + i * 40, 10).toUpperCase()] = i;
    for (const [k, v] of Object.entries(E.T)) { const nm = k === 'MYSTERY' ? '???' : k; cmp(T, `type id ${k}`, tn[nm], v); }
  }
  // held-item hold-effect ids the engine keys its behaviour on (engine_items.js HOLD) vs the ROM item records decoded independently:
  // each anchor item NAME must carry exactly that hold-effect byte, and every HOLD id must occur in the ROM item table
  if (E && E.HOLD) {
    const H = tab('holdEffects');
    const byName = new Map();
    const seen = new Set();
    for (let i = 0; i < L.items.count; i++) { const it = decodeItem(rom, L.items.base, i); seen.add(it.holdEffect); if (it.name !== null && !byName.has(it.name)) byName.set(it.name, it); }
    const ANCHORS = { 'Leftovers': 'LEFTOVERS', 'Black Sludge': 'BLACK_SLUDGE', 'Shell Bell': 'SHELL_BELL', 'Sitrus Berry': 'SITRUS', 'Oran Berry': 'ORAN', 'Life Orb': 'LIFE_ORB', 'Choice Band': 'CHOICE_BAND', 'Choice Specs': 'CHOICE_SPECS', 'Choice Scarf': 'CHOICE_SCARF',
      'Flame Orb': 'FLAME_ORB', 'Toxic Orb': 'TOXIC_ORB', 'Expert Belt': 'EXPERT_BELT', 'Muscle Band': 'MUSCLE_BAND', 'Wise Glasses': 'WISE_GLASSES', 'Eviolite': 'EVIOLITE', 'Assault Vest': 'ASSAULT_VEST', 'Rocky Helmet': 'ROCKY_HELMET', 'Big Root': 'BIG_ROOT',
      'Light Clay': 'LIGHT_CLAY', 'Scope Lens': 'SCOPE_LENS', 'Quick Claw': 'QUICK_CLAW', 'Focus Sash': 'FOCUS_SASH', 'Lagging Tail': 'LAGGING_TAIL', "King's Rock": 'KINGS_ROCK', 'Bright Powder': 'BRIGHT_POWDER', 'Wide Lens': 'WIDE_LENS', 'Zoom Lens': 'ZOOM_LENS',
      'White Herb': 'WHITE_HERB', 'Power Herb': 'POWER_HERB', 'Damp Rock': 'DAMP_ROCK', 'Heat Rock': 'HEAT_ROCK', 'Icy Rock': 'ICY_ROCK', 'Smooth Rock': 'SMOOTH_ROCK', 'Light Ball': 'LIGHT_BALL', 'Thick Club': 'THICK_CLUB', 'Shed Shell': 'SHED_SHELL',
      'Air Balloon': 'AIR_BALLOON', 'Weakness Policy': 'WEAKNESS_POLICY', 'Heavy-Duty Boots': 'HEAVY_BOOTS', 'Clear Amulet': 'CLEAR_AMULET', 'Covert Cloak': 'COVERT_CLOAK', 'Cheri Berry': 'CHERI', 'Chesto Berry': 'CHESTO', 'Pecha Berry': 'PECHA', 'Rawst Berry': 'RAWST',
      'Aspear Berry': 'ASPEAR', 'Persim Berry': 'PERSIM', 'Lum Berry': 'LUM', 'Figy Berry': 'FIGY', 'Wiki Berry': 'WIKI', 'Mago Berry': 'MAGO', 'Aguav Berry': 'AGUAV', 'Iapapa Berry': 'IAPAPA', 'Liechi Berry': 'LIECHI', 'Ganlon Berry': 'GANLON', 'Salac Berry': 'SALAC',
      'Petaya Berry': 'PETAYA', 'Apicot Berry': 'APICOT', 'Occa Berry': 'RESIST_BERRY', 'Charcoal': 'TYPE_POWER', 'Flame Plate': 'PLATE' };
    for (const [nm, key] of Object.entries(ANCHORS)) { const it = byName.get(nm); cmp(H, 'hold effect of ' + nm, it ? it.holdEffect : null, E.HOLD[key]); }
    for (const [key, id] of Object.entries(E.HOLD)) cmp(H, 'HOLD.' + key + ' occurs in the ROM item table', seen.has(id), true);
  }
  return out;
}

/** summary line helper */
export function summarize(rep) {
  const rows = Object.entries(rep.tables).map(([k, v]) => ({ table: k, compared: v.compared, mismatches: v.mismatches.length }));
  return { rows, compared: rows.reduce((s, r) => s + r.compared, 0), mismatches: rows.reduce((s, r) => s + r.mismatches, 0) };
}

// pokemonarena/js/engine_support.js -- which moves, abilities and held items the battle engine can run.
// Leaf module shared by rules.js (legality layer) and engine.js (Metronome pool).  Everything is derived from the
// implemented handler tables plus the decoded pack, memoised per pack object (a pure function of the pack).

import { compileData, moveUnsupportedReason } from './engine_data.js';
import { IMPLEMENTED_KINDS } from './engine_moves.js';
import { ABILITIES } from './engine_abilities.js';
import { SUPPORTED_HOLD_EFFECTS, HOLD } from './engine_items.js';

const cache = new WeakMap();

/**
 * @returns {{ moves:Set<number>, abilities:Set<number>, items:Set<number>, moveReasons:Object, abilityList:number[], itemList:number[],
 *            counts:{moves:number, abilities:number, items:number} }}
 */
export function engineSupport(pack) {
  const hit = cache.get(pack);
  if (hit) return hit;
  const D = compileData(pack);
  const moves = new Set(), abilities = new Set(), items = new Set();
  const moveReasons = Object.create(null);
  for (const mv of pack.moves) {
    if (!mv || mv.id === 0) continue;
    const why = moveUnsupportedReason(pack, mv, IMPLEMENTED_KINDS);
    if (why === null) moves.add(mv.id); else moveReasons[mv.id] = why;
  }
  for (const a of pack.abilities) {
    if (a.id === 0) continue;
    // a name that appears twice in the table (e.g. "As One", "Embody Aspect") is only supported at its first id, unless its handler says `multi`
    if (ABILITIES[a.name] && (D.abilityByName[a.name] === a.id || ABILITIES[a.name].multi)) abilities.add(a.id);
  }
  const hold = new Set(SUPPORTED_HOLD_EFFECTS);
  for (const it of pack.items) {
    if (it.id === 0) continue;
    if (it.holdEffect === 0) { items.add(it.id); continue; }
    if (!hold.has(it.holdEffect)) continue;
    if ((it.holdEffect === HOLD.TYPE_POWER || it.holdEffect === HOLD.PLATE) && D.named.typeItems[it.id] === undefined) continue;
    if (D.itemByName[it.name] !== it.id) continue;
    items.add(it.id);
  }
  const out = {
    moves, abilities, items, moveReasons,
    abilityList: [...abilities].sort((x, y) => x - y), itemList: [...items].sort((x, y) => x - y),
    moveList: [...moves].sort((x, y) => x - y),
    counts: { moves: moves.size, abilities: abilities.size, items: items.size },
  };
  cache.set(pack, out);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// Why something is NOT supported, in plain words (round 3).  rules.js and the editor show `why` next to the item / ability / move.
// A code is the class of the gap; the same code can be shown for many names.  Terrain, Gravity, gender, primal weather, Ruin abilities, Neutralizing Gas, frostbite and the doubles-only moves are
// all run now, so their codes are gone.  A code left here is a rule the arena does not model, or one nobody can use.
// ---------------------------------------------------------------------------------------------------------------------------------------
export const REASON_TEXT = Object.freeze({
  'form-change': 'it changes the Pokemon into another form partway through the battle (new stats, type or look), and the arena keeps one form for the whole battle',
  'tera': 'it belongs to Terastallization, which the arena does not have',
  'dynamax': 'it is a Dynamax / Gigantamax move, and the arena has no Dynamax',
  'mega': 'it is a Mega Evolution stone, and the arena has no Mega Evolution',
  'zmove': 'it is a Z-Crystal, and the arena has no Z-Moves',
  'species-form': 'it only works with a Pokemon form (Silvally, Genesect, Ogerpon, Primal reversion) that the arena does not model',
  'party-rule': 'it counts the horse Pokemon in the party, and which Pokemon count as horses is a list inside the game program that could not be read back',
  'wild-only': 'it only matters outside a battle',
  'not-yet': 'no Pokemon in this game can use it, so the arena never needed to learn it',
});
const L = (s) => new Set(s.split('|'));
const AB_REASON = [
  ['form-change', L("Zen Mode|Stance Change|Power Construct|Battle Bond|Zero to Hero|Illusion|Commander|Hunger Switch|Shields Down|Schooling|Multitype|RKS System|Forecast|Flower Gift|Disguise|Ice Face|Gulp Missile")],
  ['tera', L("Tera Shift|Tera Shell|Teraform Zero|Embody Aspect")],
  ['party-rule', L("Horse Council")],
];
const IT_REASON = (it) => {
  const h = it.holdEffect;
  if (h === 103) return 'mega'; if (h === 114) return 'zmove';
  if (h === 113 || h === 93 || h === 128 || h === 108) return 'species-form';
  if (h === 25 || h === 27 || h === 31 || h === 32 || h === 37 || h === 39 || h === 36) return 'wild-only';
  return 'not-yet';
};
/** { code, why } for an unsupported ability id (null when it is supported). */
export function abilityReason(pack, id) {
  const sup = engineSupport(pack);
  if (sup.abilities.has(id)) return null;
  const a = pack.abilities[id];
  if (!a) return { code: 'not-yet', why: REASON_TEXT['not-yet'] };
  for (const [code, set] of AB_REASON) if (set.has(a.name)) return { code, why: REASON_TEXT[code] };
  return { code: 'not-yet', why: REASON_TEXT['not-yet'] };
}
/** { code, why } for an unsupported held item id (null when it is supported). */
export function itemReason(pack, id) {
  const sup = engineSupport(pack);
  if (sup.items.has(id)) return null;
  const it = pack.items[id];
  const code = it ? IT_REASON(it) : 'not-yet';
  return { code, why: REASON_TEXT[code] };
}
/** { code, why } for an unsupported move id (null when it is supported). */
export function moveReason(pack, id) {
  const sup = engineSupport(pack);
  const raw = sup.moveReasons[id];
  if (raw === undefined) return null;
  const mv = pack.moves[id];
  const eff = mv ? mv.effect : 0;
  let code = 'not-yet';
  if (eff === 307) code = 'dynamax';
  return { code, why: REASON_TEXT[code], raw };
}
/** Innate abilities of species `sp` the engine cannot run (they matter from battle level 75 / 85 / 95; see engine_data.js E.innateLevels). */
export function unsupportedInnates(pack, sp) {
  const sup = engineSupport(pack);
  const s = pack.species[sp];
  const out = [];
  if (s && s.innates) s.innates.forEach((id, k) => { if (id && !sup.abilities.has(id)) out.push({ slot: k, id, name: pack.abilities[id] ? pack.abilities[id].name : '?', ...abilityReason(pack, id) }); });
  return out;
}

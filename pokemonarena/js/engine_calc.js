// pokemonarena/js/engine_calc.js -- the integer arithmetic of the battle engine, as small pure functions.
//
// No state, no RNG, no globals besides constants from engine_data.js. Every function takes and returns integers
// (UQ4.12 fixed-point modifiers are integers where 4096 = 1.0). Nothing here uses floating-point rounding: division is
// idiv() (exact for the integer ranges involved) so two machines always agree.
//
// The chained-modifier scheme is the one Gen 5+ games use: individual modifiers are multiplied together in UQ4.12
// (round half up on the product), then applied to the value once with round-half-DOWN (pokeMod). That order matters:
// applying two x1.5 modifiers one after another to a value rounds differently from chaining them first.

import { E, STAT_STAGE_RATIOS, ACC_STAGE_PCT } from './engine_data.js';

/** Integer division of non-negative integers (exact: the subtraction leaves a multiple of b). */
export function idiv(a, b) {
  return (a - (a % b)) / b;
}

/** value * mod / 4096 with the game's rounding: values at exactly .5 round DOWN. */
export function pokeMod(value, mod) {
  return idiv(value * mod + 2047, 4096);
}

/** Combine two UQ4.12 modifiers into one (round half up). */
export function chainMod(a, b) {
  return idiv(a * b + 2048, 4096);
}

/** Fold a list of modifiers (each 4096 = x1) into one UQ4.12 number. */
export function chain(mods) {
  let m = 4096;
  for (let i = 0; i < mods.length; i++) m = chainMod(m, mods[i]);
  return m;
}

/** stat * stage multiplier. Stage -6..+6, ratios from the ROM's own table (STAT_STAGE_RATIOS). */
export function applyStage(stat, stage) {
  const s = stage < -6 ? -6 : stage > 6 ? 6 : stage;
  const r = STAT_STAGE_RATIOS[s + 6];
  return idiv(stat * r[0], r[1]);
}

/** Accuracy / evasion stage: the ROM's multipliers (percent, ACC_STAGE_PCT) for the net stage, floored. */
export function applyAccStage(acc, net) {
  const s = net < -6 ? -6 : net > 6 ? 6 : net;
  return idiv(acc * ACC_STAGE_PCT[s + 6], 100);
}

/** The base damage before any multiplier:  floor(floor(floor(2L/5+2) * BP * A / D) / 50) + 2 */
export function baseDamage(level, bp, atk, def) {
  const lv = idiv(2 * level, 5) + 2;
  return idiv(idiv(lv * bp * atk, def), E.baseDamageDiv) + 2;
}

/** Percentage factor from the 16-value damage roll: roll index 0 -> 100%, 15 -> 85%. */
export function rollFactor(rollIdx) {
  return 100 - rollIdx;
}

/**
 * Apply one defender type's effectiveness (UQ4.12 from the type chart: 0, 2048, 4096, 8192) to a damage value.
 * Effectiveness is applied per defender type, flooring after each, as the games do.
 */
export function applyTypeMult(dmg, mult) {
  return idiv(dmg * mult, 4096);
}

/** Product of per-type chart multipliers as one UQ4.12 number (for events / immunity tests). 0 means immune. */
export function typeProduct(mults) {
  let p = 4096;
  for (let i = 0; i < mults.length; i++) p = idiv(p * mults[i], 4096);
  return p;
}

/** Fraction of max HP (n / d), at least 1. */
export function fractionOf(max, d, n = 1) {
  const v = idiv(max * n, d);
  return v < 1 ? 1 : v;
}

// pokemonarena/js/tower_config.js -- every number the Pokemon Tower can be tuned by, as DATA. Pure ES module: no imports, no DOM, no clock.
//
// The Tower (TOWER.md) is a solo roguelike climb against CPU trainers. Nothing here is hard-coded into the logic: tower.js / tower_buffs.js take `cfg` (default CONFIG), so the owner can
// change the floor count, the offer sizes, the rarity odds or the foe scaling by editing this file, and a test can run the whole machine under a different table.
//
// RARITY (the owner's words: "green, blue, purple and gold upgrades"). Four tiers; a buff FAMILY is offered at a tier and its magnitude scales with the family's POWER:
//   power points per pick:  green 1, blue 2, purple 4, gold 8          (taking a family you already hold ADDS the points of the tier you were offered)
//   a family's tier:        the highest threshold its power has reached (>=1 green, >=2 blue, >=4 purple, >=8 gold); two greens are a blue, two blues a purple, two purples a gold
//   magnitude:              each numeric amount is written as four anchors [green, blue, purple, gold] at power 1 / 2 / 4 / 8 and interpolated linearly between them (integer arithmetic, rounded half
//                           up), with one more anchor at the power cap (16 = two golds) of gold * capBonusPm / 1000: so a gold family can still grow, with diminishing returns
// SYNERGIES are in tower_buffs.js (also data); this file only holds the numbers of the climb.

export const TIERS = Object.freeze([
  Object.freeze({ id: 'green', alias: 'common', points: 1, color: '#4caf50', ball: 7 }),
  Object.freeze({ id: 'blue', alias: 'rare', points: 2, color: '#42a5f5', ball: 9 }),
  Object.freeze({ id: 'purple', alias: 'epic', points: 4, color: '#ab47bc', ball: 4 }),
  Object.freeze({ id: 'gold', alias: 'legendary', points: 8, color: '#ffca28', ball: 13 }),
]);
export const TIER_IDS = Object.freeze(TIERS.map((t) => t.id));
/** Power at which each tier begins, and the interpolation anchors (the last one is the power cap). */
export const POWER_ANCHORS = Object.freeze([1, 2, 4, 8, 16]);

/**
 * THE BALL ON THE OFFER SCREEN. The ROM's own ball sprites (anim_mon.js ballGfx, 17 of them, 16x16 with their own palettes) are what the Arena can already draw; the table below picks the
 * four whose palettes are, MEASURED on the real ROM, dominantly green / blue / purple / yellow (tools/pokemonarena_tower_test.mjs re-measures it): index 7 a green ball, 9 a blue one,
 * 4 the purple (Master-style) one, 13 the yellow-orange one. No art is invented and none is recoloured.
 */
export const BALL_STYLE = Object.freeze(TIERS.map((t) => Object.freeze({ tier: t.id, ball: t.ball, color: t.color, hue: ['green', 'blue', 'purple/pink', 'yellow'][TIERS.indexOf(t)] })));

const deepFreeze = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const k of Object.keys(o)) deepFreeze(o[k]); } return o; };

export const CONFIG = deepFreeze({
  version: 1,
  ruleset: 'arena-gen3-standard',            // the ruleset every tower battle runs under; buffs are written for a ruleset with raw EVs (not the points ruleset)
  formats: ['3v3', '6v6'],
  floors: 30,                                // the run is won by clearing this floor
  bossEvery: 10,                             // floors 10, 20, 30 are bosses
  powerCap: 16,
  capBonusPm: 1250,                          // the anchor at the power cap = gold * 1.25
  lives: 0,                                  // lives a run starts with (the Extra Life family adds more); 0 = a loss ends the run
  offer: {
    size: 3, bossSize: 5, minSize: 2, maxSize: 7,
    allowSkip: true,                         // the player may take nothing (a skipped offer is a choice, and some achievements are about it)
    // weights per tier [green, blue, purple, gold], by the first floor they apply from (the last entry whose `from` <= floor wins)
    tierWeights: [
      { from: 1, w: [100, 0, 0, 0] },
      { from: 2, w: [80, 20, 0, 0] },
      { from: 5, w: [62, 30, 8, 0] },
      { from: 10, w: [45, 35, 17, 3] },
      { from: 18, w: [30, 36, 26, 8] },
      { from: 25, w: [20, 34, 31, 15] },
    ],
    bossWeights: [
      { from: 1, w: [0, 55, 35, 10] },
      { from: 20, w: [0, 35, 43, 22] },
    ],
    guaranteeEvery: 4, guaranteeTier: 1,     // every 4th floor's offer has at least one blue-or-better ball
    bossGuaranteeTier: 2,                    // a boss offer has at least one purple-or-better ball
    rareShiftPm: 120,                        // per unit of Fortune (a Fortune family is worth 1 / 2 / 3 / 5 units by tier): this many permille of the lowest offered tier's weight moves up to the tiers above it (4:3:1)
  },
  // the CPU: [fromFloor, level]; bosses are always `bossCpu`
  cpu: [[1, 'easy'], [7, 'normal'], [17, 'hard']], bossCpu: 'hard',
  // the trainer's team size by format: [fromFloor, size]; bosses bring `bossSize`
  foeSize: { '3v3': [[1, 3], [4, 4], [10, 5], [20, 6]], '6v6': [[1, 3], [4, 4], [7, 5], [13, 6]] }, bossSize: 6,
  // the trainer's EVs as permille of the 510-point spread the random team builder gives, then a flat bonus per stat from `bonusFrom`
  foeEv: { startPm: 250, perFloorPm: 50, maxPm: 1000, bonusFrom: 17, bonusPerFloor: 6, bossBonus: 30, cap: 255 },
  foeIvCap: [[1, 10], [4, 20], [7, 26], [10, 31]],                 // IVs the trainer's Pokemon are capped at, by floor
  foeItems: [[1, 'none'], [5, 'half'], [10, 'all']],               // whether the trainer's Pokemon hold items
  // the best minimum team the engine will play: 3v3 needs 3 to pick from, 6v6 may be played down to 2
  minFoe: { '3v3': 3, '6v6': 2 },
});

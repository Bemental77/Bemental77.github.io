# ROMDIFF - the battle engine versus this ROM (stage FA2)

Question: does `pokemonarena/js/engine*.js` compute what THIS ROM's own battle code computes? Two layers, both repeatable from a clean checkout
with the ROM present (`node tools/pokemonarena_rom_diff_test.mjs`; it SKIPS LOUDLY when the ROM is absent; the live layer also needs OR1's oracle,
`tools/pokemonarena_rom_oracle.mjs`, and is skipped loudly without it). Nothing here is ROM content: offsets, strides, bit positions, algorithms.

**What kind of evidence each statement is.**
* *real game* = the ROM's battle code was RUN (OR1 oracle: SoulGold in the repo's first-party mGBA core) and its output compared with the engine's.
  Everything in section 2 is of this kind.
* *ROM bytes* = a table decoded from the ROM by code in this stage that imports nothing from the engine's decoder (section 1).
* *ROM code* = Thumb code read by a throwaway disassembler (scratch only), used to find addresses and to understand a result, never as the sole proof.
* *by eye / assumed* = anything not listed below; ENGINE.md keeps the `assumed` rows.

## 1. Layer 1 - data versus ROM bytes (Node only)

`tools/pokemonarena_rom_diff_lib.mjs` + `tools/pokemonarena_rom_diff_data.mjs` (no import from `pokemonarena/js`):

1. **Table bases re-derived from the ROM's own code.** For each table the candidates are the addresses with many literal-pool references in the ROM
   (moves 414, species 152, abilities 35, items 30, natures 16, types 20, type chart 6, experience 20, stat-stage ratios 9 references); the candidate that satisfies
   the structure predicate (record stride, name pointer into text, count) is the table. All 9 equal the layout the engine's pack uses, each is the unique
   satisfying candidate, and the move-effect metadata table (332 six-byte records at ROM 0x446c28: battle-script pointer + flags, 207 distinct scripts)
   was found from the code that indexes it with `move.effect`.
2. **Record layouts read off the Thumb code that uses them** (a "census": for every literal-pool load of a table base follow the registers derived from it and
   histogram the field loads and the shift/mask applied next). 483 code sites load the move table: effect id = halfword +0x08 (121 loads), type = bits 0-4 of +0x0a,
   category = bits 5-6 (18), power = halfword +0x0a >> 7, target = halfword +0x0c >> 7, accuracy = low 7 bits of +0x0c, PP = +0x0e, strike count = high nibble of +0x14,
   additional-effect count = bits 5-7 of +0x15, multi-hit / self-destruct = low bits of +0x15, the argument word at +0x24, the hit flags at +0x18. 15 of these are asserted by the test.
3. **Every battle table the engine reads, diffed field by field** (own decode vs the pack): **50,059 cells compared, 0 mismatches**:

| table | cells | mismatches |
|---|---|---|
| moves (936 records: effect, type, category, power, accuracy, target, PP, priority, strike count, crit stage, always-crit, multi-hit and self-destruct bits, hit flags, 12 flag bits, additional effects id/flags/chance, name) | 28,081 | 0 |
| species (1579 slots: name, 6 base stats, types, 3 abilities, 3 innates, weight, height, gender ratio, growth, catch rate, exp yield, EV yield, friendship) | 15,100 | 0 |
| items (930: name, price, hold effect, hold-effect parameter) | 3,721 | 0 |
| abilities (523: name, flags, AI rating) | 1,570 | 0 |
| type chart 21 x 21 + 21 type names | 463 | 0 |
| natures (25: name, up, down) + the canonical 5 x 5 grid | 101 | 0 |
| experience tables (8 x 101) | 808 | 0 |
| engine constants: STAT_STAGE_RATIOS (13 pairs) and its ROM offset, MOVE_ARGS (status, drain, recoil, fixed, fraction, protect, counter, setType) and ROM_WEATHER_ARG against the move argument byte, the 21 type ids | 93 | 0 |
| engine hold-effect ids (`engine_items.js HOLD`): 60 anchor items by name carry exactly that hold-effect byte, and every one of the 62 HOLD ids occurs in the ROM | 122 | 0 |

   Zero unexplained mismatches, so there is no "ROM-hack fact the engine must follow" and no data decode bug at this level. (The interpretation of ids - which
   effect id does what - cannot be settled by bytes; section 2 does it by behaviour.)
4. **Effect-id classification vs the ROM's effect metadata**: the two-turn flag (0x100) is set exactly on effect ids {54, 113, 116, 266, 290} and the engine's
   twoturn / solarbeam / semiinvuln ids {54, 113, 116} are among them (266 and 290 are the unsupported Skull Bash / Meteor Beam / Electro Shot family);
   the semi-invulnerable flag (0x200) is on {116, 290}; the protect-counter flag (0x400) is on exactly {86, 90} = the engine's protect and endure ids. No two ids
   that share one battle script (other than the generic hit script, 113 ids) are given different engine kinds, except 86/90/256 (Protect/Endure share the script, as expected).
5. **Negative controls** (flip one byte in a ROM COPY, re-derive and re-diff; unmutated twin silent): move power, accuracy, priority, argument byte; one type-chart
   cell; one species base stat; one species ability halfword; one item hold-effect byte; one nature code; one stat-stage ratio byte; one experience cell; plus an
   engine constant changed (stage ratio, recoil percent) and a wrong pack (move power +1): each trips exactly the named table.

## 2. Layer 2 - formulas versus the real game

**Method.** OR1's oracle boots the ROM and reaches a real battle (the scripted rival battle, `CK_ACTION_MENU`). For each scenario the harness overwrites both
`gBattleMons` records (stats, level, HP, types, ability, item, stat stages, status), the weather word and the target's side-status word, presses FIGHT -> move 1,
and reads the foe's first HP drop. **The game's RNG is controlled exactly**: it is sfc32 (four u32 at IWRAM 0x03005a68), rewritten before EVERY frame, so
the draws of the frame in which the move executes are chosen by the harness. The game reduces a 16-bit draw `v` by MULTIPLICATION, not modulo:
damage roll index `(16*v)>>16`, accuracy hit iff `(100*v)>>16 >= 100 - accuracy`, crit iff `v >= ceil((odds-1)*65536/odds)`; which draw position a move
uses varies per move, so the harness forces the first four draws into one value bucket (all accuracy-hit, no-crit, roll r). The engine side is
`engine.previewDamage(side, move, {roll, crit})` (plus the engine's own immunity and crit-immunity checks) and, for effects, a full engine turn with every
rand(n) answered by `floor(n * 34000 / 65536)`. Species 0 is used for both battlers because every legal species carries innate abilities the engine does not model.

**Damage differential: 468 scenarios, 6,837 exact roll comparisons, 468 equal (0 mismatches)** (first run with the unfixed engine: 412 of 470 equal; 21 of
the 58 differences were engine defects, 37 were harness limitations that were then fixed or excluded, listed in section 4):

| group | scenarios | roll comparisons |
|---|---|---|
| type chart x category, 10 defender type combinations (physical / special) | 90 + 90 | 1,358 + 1,350 |
| levels 5-100, stat stages (+-1..6 on both sides, physical and special), crit with stages | 8 + 12 + 12 + 8 | 128 + 192 + 192 + 124 |
| weather (rain, sun, sand, hail, snow) x Water / Fire / Rock / Ice / Solar Beam moves | 28 | 438 |
| burn, status-dependent power (Hex, Venoshock, Facade, Smelling Salts), screens (Reflect, Light Screen, Aurora Veil, with and without crit) | 7 + 8 + 12 | 98 + 96 + 189 |
| attacker abilities (Huge Power, Technician, Iron Fist, Reckless, Sheer Force, Adaptability, Hustle, Guts, Tinted Lens, Sniper, Strong Jaw, Mega Launcher, Sharpness, Tough Claws, -ate abilities, Normalize, Steelworker, Water Bubble, Analytic, Punk Rock, Toxic/Flare Boost, Solar Power, Neuroforce, pinch abilities) | 33 + 7 | 522 + 112 |
| defender abilities (Thick Fat, Heatproof, Multiscale, Solid Rock/Filter/Prism Armor, Fluffy, Ice Scales, Fur Coat, Marvel Scale, Punk Rock, Levitate, Wonder Guard, absorb / immune abilities, Dry Skin, Soundproof, Bulletproof, Unaware, Purifying Salt, Battle Armor) | 37 | 365 |
| held items (attacker: Choice Band/Specs, Life Orb, Expert Belt, type items and plates, Muscle Band, Wise Glasses; defender: Assault Vest, six resist berries) | 29 + 9 | 449 + 144 |
| power-by-state moves (Low Kick, Grass Knot, Heavy Slam, Gyro Ball, Electro Ball, Return, Hidden Power, Eruption, Water Spout, Flail, Reversal, Brine, Acrobatics, Assurance, Payback, Revenge, Stored Power, Punishment, Foul Play, Body Press, Psyshock, Wring Out, Crush Grip, Fell Stinger, Freeze-Dry, Weather Ball) at several HP fractions | 49 | 756 |
| fixed-damage moves, multi-hit per-hit damage, always-crit moves | 9 + 10 + 10 | 16 + 154 + 154 |

**Turn-state differential: 367 scenarios, 364 equal in HP / stat stages / status / weather / screens / side conditions / confusion / items, 0 mismatches**, 3 excluded
because the engine's rules layer does not support them (Comatose, Iron Ball, Stall): stat moves 54/54, status moves 13/13 and immunities 17/18, healing 16/16, self-HP moves 9/9,
recoil 16/16, drain 13/13 (Big Root included), end-of-turn residuals 32/32 and end-of-turn ORDER 16/16, weather 5/5, screens 4/4 and weather-duration traces 4/4, rounding on a max HP of 411
26/26, 44 further effect classes (Mist, Safeguard, Tailwind, Swagger, Flatter, Heal Bell, Dream Eater, False Swipe, Mind Blown, Jump Kicks, Smack Down, Growth, Strength Sap, Toxic Thread,
Soak, Trick-or-Treat, Fury Cutter, Echoed Voice, Bolt Beak, Stomping Tantrum, Sleep Talk, Snore, Revenge/Avalanche/Payback/Assurance, Hex, Smelling Salts, ...) 44/44, multi-turn
mechanics 49/49 (Protect chains, Endure, Substitute, Counter / Mirror Coat / Metal Burst, Fake Out, Fly / Dig / Solar Beam charge, Hyper Beam recharge, trapping, Future Sight, Doom Desire, Thrash /
Outrage, Trick Room, Taunt / Encore / Disable, Yawn, Ingrain, Aqua Ring, Rest, Knock Off / Thief / Trick, Sucker Punch, ...), multi-hit counts 16/16, turn order 30/30 (speed, stages, paralysis, Choice
Scarf, priority, Prankster, Gale Wings, weather speed abilities). The engine effect classes touched live (damage + turn scenarios + probes): 95 of 121 (141 of 175 effect ids, 283 distinct moves).

**Exact probability probes (binary search on a single RNG draw): 37 of 37 equal.** Accuracy: 30 probes (accuracy stages -6..-1 and +1, evasion stages +4 and +5 on accuracy-100 and on
75 / 85 / 90 / 95 moves, a net stage, Compound Eyes, Wide Lens, Hustle, Sand Veil, Snow Cloak, Bright Powder, Thunder / Blizzard / Hurricane by weather, No Guard); crit thresholds: 62806 (1/24) for
stage 0 and 57344 (1/8) for Super Luck, Scope Lens and Razor Claw; chances: full paralysis 25 percent, confusion self-hit 33 percent, thaw 20 percent.

### Defects found and fixed (every one is also a named hand-computed engine check and a named source mutant)

| # | engine said | real game / ROM | fix | before -> after |
|---|---|---|---|---|
| 1 | accuracy / evasion stage multiplier `3/(3+s)` | the ROM table {33,36,43,50,60,75,100,133,166,200,233,266,300} percent, floored | `engine_data.js ACC_STAGE_PCT`, `engine_calc.js applyAccStage` | stage -4: 42 -> 43, -5: 37 -> 36, 75 at +1: 100 -> 99; 8 of 60 probe points differed, 0 now (30 of 30 probes) |
| 2 | dual types: floor after each type | multipliers combined into one UQ4.12 number, applied once (half-down) | `engine_exec.js calcDamage` | 62 of 2,708 type-chart roll comparisons off by one (all dual-type; 13 of 180 scenarios) -> 0 |
| 3 | Life Orb x5324/4096 | x5325/4096 (the rounded 1.3) | `E.lifeOrbMod`, the item hook now reads it | Earthquake with Life Orb 32 -> 33 at 3 of 16 rolls -> 0 |
| 4 | Wring Out / Crush Grip power `1 + floor(120 hp/max)` (121 at full) | `max(1, floor(120 hp/max))` (120): the power that reproduces the real damage at 192/192, 96/192, 32/192, 8/192 is 120, 60, 20, 5 | `engine_moves.js wringout` | damage 21 -> 19 and 7 -> 6 at 32/192 and 8/192 -> 0 differences. **Open item RESOLVED** |
| 5 | toxic damage `floor(max*n/16)` | `floor(max/16) * n` (divide first) | `engine.js residual` | max 411, turn 2: 51 -> 50, turn 5: 128 -> 125 -> 0 differences |
| 6 | weather damaged on its last turn (5 ticks; 8 with a rock: 8 ticks) | 5 turns including the turn it is set: ticks on turns 1-4 and it ends WITHOUT damage on turn 5 (rock: 7 ticks) | `engine.js residual` (counter drops first) | sand/hail/snow trace 5 -> 4 ticks, rock 8 -> 7 -> 0 differences |
| 7 | Flame Orb / Toxic Orb act before the status damage | the orb acts after it (nothing on the activation turn, then 1/16, then n/16) | `engine_items.js lateResidual`, `engine.js residual` | turn 1: 25 -> 0, three-turn toxic orb 25/50/75 -> 0/25/50 -> 0 differences |
| 8 | Sitrus / Oran / pinch berries only fire after damage | also at the end of the turn when the holder is at or below the threshold with no damage | `engine.js residual` | berry at exactly 50 percent: kept -> eaten (+1/4, +10 HP) |
| 9 | confusion self-hit `rand(3) == 0` (33.33 percent) | exactly 33 of 100 picks | `E.confSelfHitPct`, `rand(100) < 33` | 33.33 -> 33.00 percent |
| 10 | Trick-or-Treat / Forest's Curse REPLACE the target's type | they ADD a type (a Normal target stays Normal and immune to Ghost moves) | `engine_moves.js settype` (effect 250 `add`), `engine_validate.js` (3 types) | Shadow Ball after Trick-or-Treat: 68 damage -> 0 |

Golden digest after the fixes: `23714f45a25abb82` -> `cb45262fcf748400` (23 of 40 golden battles changed, all through the defects above); `engine_coverage.json` is unchanged.

### Open items from ENGINE.md - resolved
* **Crit config id 0.** ROM function 0x1731a0 returns the byte at 0x864b40c + id; the crit routine passes id 0 (value 8, selects the Gen 7 table {24,8,2,1,1}); confirmed LIVE: a plain hit
  is critical for draws >= 62806 of 65536 (exactly 1/24) at stage 0 and >= 57344 (exactly 1/8) at stage 1 (Super Luck, Scope Lens, Razor Claw). Id 1 is the crit multiplier
  (value 8; `cmp r0,#4; bhi` selects 6144 = 1.5x); 1.5x is exact on every forced crit in the differential.
* **Wring Out / Crush Grip: 120, not 121** (defect 4).
* **Accuracy-stage table**: not stored as data (that is why the byte search found nothing); measured (defect 1).

## 3. Addresses found while reading the damage / RNG code (also sent to OR1)

All are EWRAM/IWRAM/ROM addresses of the pinned ROM. "Proven" = a write there changed the game's behaviour in the stated way.

| what | address | how it was proven |
|---|---|---|
| RNG state: sfc32 {a, b, c, counter}, four u32 | IWRAM 0x03005a68, +4, +8, +12 | ROM function at file offset 0x21c684 (535 callers; `Random()` = its return value >> 16): `t = a + b + counter; counter++; a = b ^ (b >> 9); b = c + (c << 3); c = ror(c, 11) + t; return t`. The idle battle loop consumes 2 draws per frame. Rewriting the four words before EVERY frame makes the draws of the move's frame a known sequence. |
| draw reductions | multiplicative: roll `(16*v)>>16`; accuracy hit iff `(100*v)>>16 >= 100 - acc`; crit iff `v >= ceil((odds-1)*65536/odds)`; chance events (confusion, paralysis, thaw) are thresholds of one draw (43910 / 16384 / 52429) | 37 of 37 random-state trials reproduce the engine damage table at `(16*v)>>16` (a modulo-16 reduction agrees in 5-13); binary searches on one draw |
| which draw a move uses | NOT constant: Body Slam crit 2 / roll 3; Focus Blast accuracy 0 / roll 3; Rock Slide roll 1 / accuracy 2 | per-move agreement scans |
| weather word | u32 0x02001e3c: rain 0x1, sun 0x8, sandstorm 0x20, hail 0x40, snow 0x80 | EWRAM diff across the five weather moves, then 1.5x / 0.5x damage on writes |
| side statuses | u32 per side at 0x02001dd0 (player) / 0x02001dd4 (foe): Reflect 0x1, Light Screen 0x2, Safeguard 0x4, Mist 0x8, Tailwind 0x10, Aurora Veil 0x20 | Reflect / Light Screen diff; writes halve damage; Safeguard, Mist, Tailwind confirmed by the turn differential |
| gBattleMons record extras (stride 0x98) | status1 u32 +0x54 (burn 0x10, poison 0x08, paralysis 0x40, freeze 0x20, toxic 0x80, sleep low 3 bits); status2 u32 +0x58 (confusion low 3 bits); statStages +0x18 (1 atk, 2 def, 3 spe, 4 spa, 5 spd, 6 acc, 7 eva; 6 neutral); ability u16 +0x20; types +0x22..0x24; friendship +0x2d; item u16 +0x30 | Will-O-Wisp / Toxic / Confuse Ray / Swords Dance diffs; writes change damage as expected |
| GetConfig(id) | ROM 0x1731a0: byte at 0x864b40c + id (id <= 206; almost every value is 8) | crit code at 0xe7a72..0xe7ae4 and 0xec678 |
| move-effect metadata | 332 x 6-byte records at ROM 0x446c28 (script pointer + flags) | `effectTable()` in the lib |
| battle script command table | 318 Thumb pointers at ROM 0x2cfab4 | pointer-run scan |

## 4. What remains unverified (read before trusting a number)

* **Innate abilities** (SoulGold gives every legal species at least one extra ability slot) are NOT modelled by the engine and were avoided in the differential by using species 0.
  Whether the real game's innates change a fight cannot be answered by this stage; the engine ignores them.
* Eviolite (needs an evolving species, so an innate-bearing one), Iron Ball, Stall, Comatose and the other abilities / items the rules layer excludes.
* Not driven live: entry hazards (side-condition words other than the six above are not located), Wish (the real game heals half of the PARTY mon's max HP, which the harness does not set),
  U-turn / Volt Switch / Roar / Dragon Tail / Parting Shot (forced switches; the trainer has one Pokemon), Perish Song and other unsupported moves, switch-in abilities (Intimidate, weather setters, Trace, Download),
  Magnitude / Present / Psywave / Metronome (random power, only their distributions), gender-dependent moves, the held-item speed items other than Choice Scarf and Quick Claw, per-hit accuracy of later hits, Protect's
  success chance beyond the 1-in-3 behaviour of one draw (a two-use chain matches), secondary-effect chances other than the ones listed (their thresholds equal the move record's chance, a table that was compared in layer 1).
* The 26 engine classes (of 121) no scenario touches: roar, ohko, focusenergy, transform, twoturn (Razor Wind / Sky Attack / Skull Bash; Fly, Dig and Solar Beam ARE covered), metronome, psywave, destinybond, hazard, foresight, present,
  magnitude, pursuit, wish, uturn, flyingpress, dragontail, finalgambit, defog, revelation, partingshot, burnup, lashout, struggle, ragefist, lastrespects.
* The stat formula for arbitrary IV / EV / nature is the one decoded statically by stage C2 and the rules tests; the live game gave one extra data point (a level-5 Sprigatito: HP and all five stats equal the formula with one nature).
* The oracle shows one trainer battle (Marill vs Sprigatito); the damage code does not depend on it, but nothing here was run in a wild battle or a double battle.
* Harness limitations found and fixed on the way (not engine defects): `previewDamage` ignores ability immunities and crit immunity (the harness asks the engine's own turn), charge moves deal damage a turn late
  (the real game's second turn is automatic), the foe needs all four move slots filled to act, some animations last more than 600 frames, paralysis / Hustle make low draws miss, and damage is capped by the target's HP.

## 5. Files and commands

* `tools/pokemonarena_rom_diff_test.mjs` - the test (layer 1 always; layer 2 needs the oracle; `ARENA_SKIP_LIVE=1` skips it, `ARENA_LIVE_QUICK=1` runs every fifth scenario).
* `tools/pokemonarena_rom_diff_lib.mjs`, `_data.mjs` (layer 1), `_combos.mjs`, `_turns.mjs`, `_probes.mjs`, `_live.mjs` (layer 2; `node tools/pokemonarena_rom_diff_live.mjs` is also a CLI:
  `ARENA_LIVE_PART=damage|turns|both`, `ARENA_LIVE_GROUP=a,b`, `ARENA_FA2_OUT=<dir>` writes the JSON results).
* Engine: `engine_calc.js`, `engine_data.js`, `engine.js`, `engine_exec.js`, `engine_items.js`, `engine_moves.js`, `engine_validate.js`; `ENGINE.md`; `engine.golden.json` (hash update, deliberate).
* Engine suite: `node tools/pokemonarena_engine_test.mjs` (new named checks in suite 4 `fa2/*`, 12 new named mutants `H01..H12`).

## 6. Test counts (this run, 2026-11-02)

* `node tools/pokemonarena_rom_diff_test.mjs` (full): **100 passed, 0 failed, 0 skipped** - layer 1: 88 checks (layout re-derivation 9 tables + effect table, 15 census checks, 11 table diffs + total, 4 effect-metadata checks,
  25 negative-control checks); layer 2: 8 checks (468 damage scenarios / 6,837 roll comparisons, 367 turn scenarios, 37 probes) + 4 live negative controls; 2,422 s, 7,201 real-game trials.
  `ARENA_LIVE_QUICK=1` runs every fifth scenario (about 10 minutes); `ARENA_SKIP_LIVE=1` runs layer 1 only (88 checks, 1 s).
* `node tools/pokemonarena_engine_test.mjs`: **456 passed, 0 failed** with `ARENA_SKIP_BROWSER=1` (was 444 passed, 0 failed with the Chrome parity step before FA2; the parity step timed out on the machine-wide Chrome lock in
  three attempts, so it is NOT re-verified for the new digest). `cat pokemonarena/js/engine*.js | md5sum` before FA2: `d5e61a697b68b246739b34cd8dcc0edd`, after: `054c0b26971f02a9cba303e1ed6dd8df`.
* Other pokemonarena tests run after the engine change: `pokemonarena_rules_test.mjs` 259 passed, 0 failed; `pokemonarena_battle_ui_test.mjs` 178 passed, 0 failed; `pokemonarena_scene_test.mjs` has 2 failing groups in the
  team-PREVIEW frame goldens (scene.js and scene.golden.json were being edited by another stage at the same moment; the battle frames, which depend on the engine, matched).

## 7. Round 2 - innate abilities, and the abilities / items / moves added after them (stage FA2, 2026-11-02)

Everything below was MEASURED in the real game with OR1's oracle (the same harness as section 2), and the new engine classes were then compared with it
(`tools/pokemonarena_rom_diff_live.mjs`, `_combos.mjs`, `_turns.mjs`).  Counts at the end of the round: moves 688 -> **747**, abilities 173 -> **385**, held items 662 -> **750**,
engine-legal species 925 -> **1000** of 1038 (`engine_coverage.json`).

### 7.1 Innate abilities - where they live and what the real code does

* **Storage.** Each species record holds three u16 ability ids at +0x20 / +0x22 / +0x24 (`pack.species[x].innates`; 0 = empty slot, zeros always trail).  The battle init copies them into the battle record
  (`gBattleMons[b] +0x8e / +0x90 / +0x92`), but that copy is only a MIRROR: a few checks read it (Thick Fat, Unaware, Adaptability, Overcoat, Magic Guard, Poison Heal, Sand Veil, Stall, Own Tempo,
  Pressure, Prankster, Sturdy, Rock Head, Sticky Hold, Liquid Ooze ...) and the rest read the SPECIES table through `gBattleMons[b].species`.  A real holder gets both, so every ability works as an innate.
  **Trap, found the hard way:** writing the mirror on a species without innates made Technician / Huge Power / Levitate / absorbers / status immunities look "dead" (77 damage scenarios said so); a real holder
  disagrees (60 of 60 damage scenarios match with the ability held as an innate by a real species, 28 attacker-side, 32 defender-side, the other innates of the holder included).
* **Level gate.** Slot 0 / 1 / 2 is active from battle level **75 / 85 / 95** (Thick Fat innate in each slot on Rattata, Machamp and Mewtwo: damage 55 -> 28 exactly between 74 and 75, 84 and 85, 94 and 95; the live record
  level is compared; a real Crabrawler, innate 0 = Thick Fat, is 55 at level 74 and 28 at 75).  Under the default ruleset (battle level 50) no innate is active; under `+lv100` all three are.  The ROM text also
  mentions an "Artifact" that unlocks every innate regardless of level and a facility option that switches innates off; neither is modelled (`E.innateLevels` is the only gate).
* **Stacking.** The same ability from the main slot and an innate counts ONCE (Slowbro foe, main + innate Thick Fat: 35 = one halving).  Different abilities multiply (engine check: Thick Fat + Heatproof = 11 where each alone = 21).
* **Switch-in order is one global order**, not "main first" and not slot order (21 pairs observed on real species at level 100): Cloud Nine / Air Lock before the weather setters; Glacial before Snow Warning;
  weather before terrain; Dark Aura, Mold Breaker, Unnerve before Pressure and Forewarn; Forewarn before Intimidate / Uncanny / Trace; Pressure before Download.  Examples: Zapdos (Pressure main, Drizzle innate): Drizzle first;
  Axew (Mold Breaker main, Intimidate innate): Mold Breaker first; Wyrdeer (Intimidate main, Psychic Surge innate): the terrain first; Meowstic (Trace main, Psychic Surge + Uncanny innates): terrain, Uncanny, Trace.
  The engine's list is `SWITCH_IN_ORDER` (engine_exec.js); pairs that were not observed are in list order only (unverified).
* **Engine model.** `mon.inn` = the active innate ids (omitted when none, so every level-50 state, and the golden battles at level 50, are unchanged); `abFn` merges the hooks of the main ability and each distinct innate
  (modifiers multiply, priorities add, immunities fire on the first source that says yes, event hooks run for all); a pop-up from an innate carries `inn: 1` and names the innate; the opponent's view reveals only
  the innate that showed (`revealed.inn`).

### 7.2 What the probes taught (the numbers the engine uses)

* **Type-boost abilities** (Transistor / Windcaller x1.3, Dragon's Maw / Fire Mane / Warrior Spirit / Rocky Payload / Mind Force / Seabound / Wind Force / Hive Force / Verdant Soul / Earthbound / Toxic Core x1.5):
  the live damage only fits when the factor multiplies the ATTACK stat; as a base-power factor Transistor, Mind Force and Seabound were 1 HP off (3 of 250 scenarios on the first run).  **Windcaller is the exception**: a real Flygon holding it as an
  innate fits only a base-power factor (the main-ability scenario fits both), so it is the one boost that stays in the base-power step.  The other nine fit either step on every scenario run (both readings give the same HP there), so the engine's choice (attack stat) is the one that is not contradicted.
* **Phalanx / Spectral** halve the attacker's stat of that category (a damage halving or a defence doubling was 1 HP off); **Omega** acts on the PRODUCT of a dual type (attacker: at least x2, even into a Ghost; defender: always x0.5);
  **Metronome** is a FINAL-step factor of +20 percent per consecutive use (30 and 35 on uses 2 and 3 cannot be reached by a base-power or attack factor); **Steam Engine** raises Speed by SIX stages (the ROM text says 3);
  **Spicy Spray** burns on every damaging hit; **Ritualist** absorbs a Ghost move into a Normal-type before the type chart (ability immunities act first: the engine now does the same).
* Chance abilities (Soothing 10, Poison Touch 30, Toxic Chain 30, Echoing 30, Stench 10, Dust Devil 15, Mirage 25, Plantation 30, Cute Charm 30) were observed firing at their text rate (Soothing 3/30, Poison Touch 9/30,
  Echoing 8/30, Plantation 9/30 on random RNG states) and Toxic Chain / Mirage flip exactly at 30 / 25 on a `Random() % 100` draw.
* Entry abilities, end-of-turn abilities, status-move blockers and the held-item reactions listed in the engine suite (`fa2/ab-*`, `fa2/it-*`) were each read off the real game's stat stages / HP / status / weather / item flag.

### 7.3 Results of the new differential groups

| group | scenarios | match | note |
|---|---|---|---|
| damage, abilities as MAIN ability (`ability-atk`, `ability-def`) | 138 | 138 after the fixes | first run 241 of 250 together with the innate groups |
| damage, abilities held as INNATE by a real species (`innate-atk`, `innate-def`) | 113 | 113 after the fixes | 60 of 60 on the first run of the innate groups; the full run found two more (Windcaller needs the base-power step; an Arceus holder whose Aura Shield the harness cannot arm), both fixed |
| turn state, new abilities (`ability-new`) | 58 | 58 | |
| turn state, new held items (`item-new`) | 35 | 35 | after Metronome moved to the final step |
| turn state, new moves (`move-new`) | 44 | 43 | Tera Blast was excluded by the rules layer on that run (supported since) |

Switch-in order: 21 species/ability pairs observed (not part of the automatic differential, they need a battle start per pair).

### 7.4 Still unverified or unobservable (marked `assumed`)

* Abilities whose effect needs a draw the harness cannot force: Quick Draw (30 percent), Harvest, Mending, Jade Bloom and Moody (which stat), Brand of Torment (not added), the order of the draw inside a move.
* Abilities the probes could not see: Stygian, Voidtouch, Rockstorm, Monsoon, Color Change, Wandering Spirit, Lingering Aroma, Toxic Debris (hazards are not in the observation), Disguise (needs Mimikyu; the first-hit cost is the ROM text's 1/8),
  Aura Shield (blocks the first attack: per switch-in or per battle is unknown, the engine does per switch-in).
* Items the probes could not drive: Red Card, Eject Button, Eject Pack (the wild foe in the oracle has no bench), Loaded Dice (4 or 5 hits assumed), Grip Claw (7 turns assumed), Float Stone (weight), Lansat / Micle / Custap (the oracle showed only
  the message), Leppa, the speed order of the Power items, Quick Powder, Berserk Gene, Blunder Policy (the miss cannot be forced in the harness).
* Moves whose effect is invisible in HP / stages / status / weather / side bits: Power Trick, Power Shift, Power Split, Guard Split, Camouflage, Conversion, Gastro Acid, Embargo, Heal Block, Magnet Rise ... (these are NOT added).
  Moves added but only partly observable: Tar Shot (the Fire weakness did not show), Rollout / Ice Ball (the foe fainted before the second hit in the probe).
* Not supported, with the reason a player should see (`engine_support.js` `abilityReason / itemReason / moveReason`, `REASON_TEXT`): terrain abilities and moves, forms (Zen Mode, Stance Change, Mega stones, Z-crystals, Memories, Drives, Masks),
  gender (Cute Charm, Rivalry, Attract), primal weather, Gravity, Ruin abilities, Neutralizing Gas, Dynamax / Max moves, doubles-only moves (Follow Me, Helping Hand ...), moves that need a choice the battle screen cannot ask (Revival Blessing).

### 7.5 Files

`tools/pokemonarena_rom_diff_live.mjs` (innate species in the battle record, `seedState`, turn observation `pp`), `_combos.mjs` (`buildInnateCombos`, 59 new ability scenarios), `_turns.mjs` (groups `ability-new`, `item-new`, `move-new`),
`tools/pokemonarena_engine_suite2.mjs` (one `kt` per new move class), `_suite4.mjs` (`fa2/ab-*`, `fa2/it-*`, `fa2/innate-*`), `_engine_lib.mjs` (lab `inn`).

### 7.6 Test counts (round 2, 2026-11-02)

* `node tools/pokemonarena_engine_test.mjs` (full: golden, fuzz, 151 mutants all killed incl. 12 new named `I01..I12`, Node-vs-Chrome parity): **567 passed, 0 failed**; the same with `ARENA_SKIP_BROWSER=1 ARENA_SKIP_MUTANTS=1`: 561 passed.
  A 2500-battle fuzz at `arena-gen3-standard+lv100` (all three innates active) also terminates and keeps every invariant.  Golden digest `cb45262fcf748400` -> `55da932d3ad7ecde`.
  `cat pokemonarena/js/engine*.js | md5sum` before round 2: `054c0b26971f02a9cba303e1ed6dd8df`, after: `919a8e722e18f02bc4ef5306af38f861`.
* `node tools/pokemonarena_rom_diff_test.mjs`: layer 1 **88 passed, 0 failed**; the full live layer ran on the tree just before the last two fixes: 655 damage scenarios (9,433 roll comparisons) with 2 mismatches
  (the Windcaller step and an Arceus holder whose Aura Shield the harness cannot arm; both fixed, see 7.2), 507 turn scenarios (506 equal, 1 unsupported: Comatose), 37 of 37 probes, 4 of 4 negative controls; 3,019 s, 9,939 real-game trials.
  After the fixes the affected groups were re-run live: the 113 innate scenarios 113 of 113, 48 of 48 for the abilities touched.  A fresh full run of the whole live layer was NOT repeated after those two fixes.
* Other pokemonarena tests after round 2: rules 259/0, editor 231/0, battle_ui 178/0, scene 39/0 (36 frame hashes and two seed-dependent checks re-based, see below), profile 288/0, pack 175/0, fidelity 145/0.
  Not green and NOT caused by the engine: `pokemonarena_editor_page_test.mjs` (408 passed, 4 failed: the W1 header-focus and nickname-field checks of the editor page), `pokemonarena_hub_test.mjs` (1 failed: "kbd+mouse: no touch pad on a desktop").
* Collateral edits outside the engine files (all because the legal pool grew and seeded random teams moved): `tools/pokemonarena_rules_test.mjs` (the unsupported-ability fixture is Milotic slot 2 = Cute Charm instead of Tyranitar's Unnerve),
  `tools/pokemonarena_scene_test.mjs` (the remote-choice check accepts a faint request, the AI-consistency bound is `ae < an + 0.02`, the resume seed 41 -> 47), `pokemonarena/scene.golden.json` (36 hashes, `ARENA_UPDATE_GOLDEN=1`).

## 8. Round 3 - terrain, Gravity, gender, frostbite, primal weather, Neutralizing Gas, Ruin, and every move / ability / item a legal team can hold (stage FA2, 2026-11-02)

The owner's rule for this round: a legal team is never refused for a reason that is only "not built yet".  Method, every time: the real game first (OR1's oracle, `tools/pokemonarena_rom_oracle.mjs`),
then the engine, then the differential.  Counts after this round (`engine_coverage.json`): moves 878 (was 747), abilities 440 (was 385), held items 757 (was 750), species the
engine can run 1018 of 1038 (was 1000).  Every move a roster species learns is run (0 unsupported and reachable, was 24), and every ability a roster species has, as slot or as innate, is run except the
ones in 8.7 (11, each with a plain-words reason; was 37).

### 8.1 Harness additions (all in tools/, all Node)

* `pokemonarena_engine_lib.mjs`: lab specs for terrain (`tn`), Gravity (`gv`), primal weather (`pw`), gender (`g`), species (`species`), a lab Pokemon now starts with clean stat stages (entry abilities of its species ran in `createBattle`, the real game's post-write state has none).
* `pokemonarena_rom_diff_live.mjs` / `_turns.mjs`: field words (terrain, Gravity, Trick Room, Scorched Field in `gFieldStatuses`, their timers), the infatuation word (battle mon +0x5c), gender through the personality value, texts capture, stuck-text advance,
  entry scenarios with a follow-up turn, `seedRange` draws (the first six draws forced into a range) for chance probes, species-id scenarios.
* new `pokemonarena_rom_diff_chance.mjs`: share-of-the-draw probes (the real game's chance versus the engine's), 9 of 12 agree to 0.01 percent, 3 are multi-draw loops it cannot bisect (returned null).
* groups added: terrain, gravity, gender, primal, ruin, doubles, vol, newhit, batchd, abilityf, innate3, entry-terrain / entry-base / entry-primal / entry-ruin; combos groups terrain, gravity, gender, primal, scorched, newhit.

### 8.2 Constants measured in the real game (the engine uses exactly these)

* **Terrain**: ids Grassy 1, Electric 2, Misty 3, Psychic 4 and the hack's own Scorched Field 5 (`gFieldStatuses` 0x40 / 0x100 / 0x80 / 0x200 / 0x1000, one shared timer byte at `0x02001dc8+2`); five turns counting the turn it was set (eight with a Terrain Extender);
  a grounded Pokemon is healed 1/16 per turn in Grassy; the matching type is x1.3 (5325/4096) at the base-power step for a grounded user; Misty halves Dragon moves, Grassy halves Earthquake / Bulldoze / Magnitude; Electric and Misty stop Rest; Psychic stops priority moves
  against a grounded target; the seeds (hold effect 111) raise a stat on entering their terrain; any other terrain replaces the Scorched Field, Defog / Steel Roller / Ice Spinner clear it.  Scorched Field factors are applied in the WEATHER step: Fire 4506, Scald 4915, Water and Ice 3686; Ash Assets x1.15 at the base-power step.
  Moves and abilities run: Grassy / Electric / Misty / Psychic Terrain, Terrain Pulse, Rising Voltage, Expanding Force, Psyblade, Misty Explosion, Steel Roller, Ice Spinner, Grassy Glide, Floral Healing, Nature Power, Camouflage, Quark Drive / Booster Energy, Hadron Engine, Seed Sower,
  Grass Pelt, Mystic Force, Surge Surfer, Plasma Surge, Channel Earth, Electromagnetism, the four Surge abilities, Magnify Field, Heatstorm, Ash Assets, Mimicry.
* **Gravity**: five turns; a banned move becomes Struggle when chosen under Gravity and is cancelled if it was chosen earlier; accuracy x6840/4096; grounds Fly / Magnet Rise users; Gravity Well and Allseeing Idol set it.
* **Primal weather** (Desolate Land, Primordial Sea, Delta Stream): never times out; Fire fails in heavy rain, Water in harsh sunlight; strong winds make everything that is super effective against Flying neutral.
* **Gender** (read from the personality value and the species ratio byte): Attract / Captivate, Cute Charm, Rivalry (x1.25 same gender, x0.75 opposite), Oblivious / Aroma Veil, Destiny Knot; an infatuated Pokemon is immobilised when `rand(2) == 1`; Cute Charm fires when `rand(100) >= 70`.
* **Frostbite** (status 7; the hack's Ice moves give it where the games give freeze, status1 0x1000): 1/16 per turn, halves the special damage the Pokemon deals, an Ice type and harsh sunlight stop it; Permafrost gives it with 20 percent (`rand(100) >= 80`) and makes the holder immune to burn and to Attack drops.
* **Neutralizing Gas / Ruin**: Neutralizing Gas and the Ruin abilities act from the SWITCH-IN (a state written afterwards does not trigger them in the real game, so the harness drives them through real entries); Ruin x0.75 (3072/4096) on the stat of every other Pokemon on the field; Ability Shield protects the item holder.
* **Chance effects fire on the HIGH end of the 16-bit draw** in the real game (the engine tests the low end; the share is the same, which is all a player can see).
* New volatiles / field effects, each read from the real game: Torment, Imprison, Embargo, Heal Block, Gastro Acid, Miracle Eye, Laser Focus, Power Trick / Shift, Guard / Power Split, Speed Swap, Mud / Water Sport, Wonder / Magic Room, Perish Song and Perish Body,
  Grudge, Powder, Ion Deluge, Fairy Lock, Entrainment, Reflect Type, Conversion, Telekinesis, Magnet Rise, Rototiller, Magnetic Flux / Gear Up, Court Change, Last Resort, Copycat, Me First, Assist, Instruct, Bestow, Stuff Cheeks, Teatime, Baton Pass / Shed Tail, Bide, Belch,
  Fling (all 572 item powers were swept item by item), Pluck / Bug Bite, Uproar, Grav Apple, Chloroblast, Fickle Beam, Stone Axe / Ceaseless Edge, Dynamax Cannon, Snipe Shot, Tera Starstorm, Hyperspace Fury, Fusion Flare / Bolt, Geomancy, Purify, Electro Shot, Rollout lock.
* **Natural Gift**: every berry x 18 defending types was swept (67 berries); the type and power table is the standard one (Cheri Fire 80 ... Chilan Normal 80, Roseli Fairy 80, Liechi Grass 100, Kee Fairy 100, Maranga Dark 100).  The move fails without a usable berry (Klutz, Embargo, Magic Room), the berry is used up whatever
  becomes of the hit (also when the foe protects), the berry's own trigger still works AFTER the damage (a Liechi boost or a cured burn does not change that hit), and the berry is not counted for Belch but is for Cud Chew.
* **Shell Side Arm** is always special in this hack (9 Atk / Sp. Atk / Def / Sp. Def combinations, never physical); its 20 percent poison is an ordinary additional effect.
* **Conversion 2**: the user becomes a type that resists or is immune to the type of the foe's last move, never one it already is, uniformly among the candidates (20 draw ranges for Normal, Fire, Water and Electric, plus users that already are Rock and Ghost / Steel); it fails when the foe has not moved.
* **Population Bomb**: ten hits; Skill Link and Loaded Dice give ten and 4..10 (`4 + rand(7)`) hits.  **Raging Bull** takes the second type of the Paldea Tauros forms (species 1402 / 1403 / 1404), every other user is Normal, and it breaks screens.  **Ivy Cudgel** takes the second type of an Ogerpon form
  (1417 Water, 1418 Fire, 1419 Rock), the mask item does not matter, everyone else is Grass.  The three **Ogerpon masks** give x1.2 on every attack of any Ogerpon form and nothing to other species.
* **Sky Drop**: the first turn lifts (the foe loses that turn, and the next one when it is faster), the second drops it for damage; a Flying target is lifted but the drop does not affect it; a Substitute and a 460 kg target make it fail.
* **Innates**: Reborn (the first lethal move hit leaves the holder at full HP, once per battle), Parrying (Focus Punch is not interrupted), Time Spiral (every move's priority is negated, the foe's too, forced-switch moves keep theirs), Tidal Deity (at full HP the holder's moves go through Protect and Reflect / Light Screen / Aurora Veil).
* **Orichalcum Pulse** (harsh sunlight on entry, x4/3 Attack in it) was classed as a Terastal ability by name only; it is a plain mechanic and runs (damage 3 of 3, entry sunlight matches).  **Generalist** is an attack-step factor (x1.25), not a base-power one (two real rows fit only `atk:5120`); the same holds for **Overgrow / Blaze / Torrent / Swarm** (x1.5 at HP of one third or less): all 8 real rows fit the attack step, the base-power step is one point high on a level-100 Swarm / Bug Buzz row.  **Tar Shot** makes Fire damage to the target double (it was "unverified" in 7.4 because the weakness did not show in the first probe).

### 8.3 Bugs found by the differential in this round (each is now a named check)

Spectral Thief stole before the immunity check; Glaive Rush doubled at the wrong step; Genesis Supernova is 150 BP and sets Psychic Terrain before the hit; the Scorched factors belong to the weather step; Fling base powers are net of held-item boosts (Choice Band 10, Life Orb 30, Black Glasses 30, Dread Plate 90);
Pluck takes the berry before the target's own berry check; Miracle Eye ignores evasion; Telekinesis makes Ground moves miss; Rest fails under Electric / Misty Terrain; Stuff Cheeks and Belch are unusable without a berry; Poison Puppeteer only confuses on the poison a damaging move gives; Rollout locks its user
and Rolling Stones raises Speed; Like a Dragon is a STAB source; Cud Chew eats the berry the turn after; Natural Gift's berry effect comes after the damage; Raging Bull / Ivy Cudgel read the species form (`mon.sp`); a perish count or Salt Cure that takes the last Pokemon after the residual check now ends the battle
(the fuzz found it: "every Pokemon has fainted but the battle has not ended"); the `um` (moves used) list can hold five ids when Mimic replaced a slot.

### 8.4 Harness artifacts that looked like engine bugs (so nobody chases them again)

**Scenario content is not stable across edits of the scenario list.** The damage combos draw their random stats from ONE generator while the list is built, so adding or removing a scenario re-rolls every scenario after it (and `ARENA_LIVE_QUICK` / `ARENA_LIVE_EVERY` take every 5th entry of the list as it is now). Removing Genesis Supernova from the damage groups after the full run turned id 5030 (Swarm / Bug Buzz, level 100) into a different scenario;
the new stats exposed a real one-point fault in the pinch abilities' phase that the old stats had not hit.  Quick and full mode agree on the same tree (the quick set is a subset of the full list, same content); they disagree only across list edits.  Compare results by (group, move, ability), not by id, and re-run the whole differential after any edit of the combo list.

The foe's chosen move precedes a field-word Gravity (use Harden); the lab's default species Pikachu makes Light Ball double damage; an Assault Vest foe is forced into Struggle; the third Uproar turn hangs when the draws are frozen (read from an unforced run: three turns, "calmed down");
a species passed to the lab runs its entry abilities in `createBattle` (Intimidate on the foe), which the post-write real game never does; Thunder in harsh sun needs a draw the harness fixes (removed); exact-draw chance scenarios were replaced by share probes; the damage groups re-write the field words while they wait for the hit, which wipes a terrain the move sets itself (Genesis Supernova, left to the turn-state scenario); the engine's entry goes through a switch turn, so an end-of-turn innate (Koraidon's Speed Boost) has already fired in it and not yet in the real first menu (the Orichalcum Pulse entry compares everything but the stat stages); the battle struct has a third type slot that only Trick-or-Treat and Forest's Curse write (an ability that adds a type works it out at use time); the chance probes need a single deciding draw and returned null for 11 of 12 scenarios until they were made tolerant of a few samples decided by another draw.

### 8.5 Results of the differential groups (final tree)

The full live run (`ARENA_LIVE_PROBES=1 node tools/pokemonarena_rom_diff_live.mjs`, log `scratchpad/FA2/live_final2.log`, 15,824 real-game damage trials, 5,254 s for the damage part, machine load 1 to 20 percent when sampled) ran on the FINAL tree, with no edit after it.  An earlier full run (`live_final.log`) on the tree before the fixes below found 1 damage mismatch, 3 turn mismatches
and the null chance probes; a quick-mode run by the coordinator then found the Swarm row (fix 5).  Every fix was made, the affected groups re-run (`live_fix1.log`, `live_fix2.log`, `quick_rom_diff2.log`: 100 passed, 0 failed) and then the whole differential repeated.  `cat pokemonarena/js/engine*.js | md5sum`: round 2 `919a8e722e18f02bc4ef5306af38f861`, now `997e19be9837635c0495d85bc36d06c8`.

| part | scenarios | equal to the real game | note |
|---|---|---|---|
| damage, 16 rolls each (`combos`) | 902 | **902** | 28 groups; the 903rd, Genesis Supernova, was removed from the damage groups (harness artifact, below) |
| entry (a real species leads a real battle) | 57 | **57** | entry-terrain 33, entry-base 10, entry-ruin 8, entry-primal 6 |
| turn state (1 to 9 turns each) | 1132 | **1131** (1121 + 10 on HP only) | the one left is Comatose (`engine-unsupported`: no species has it) |
| probes: accuracy, crit, chance | 39 + 4 + 3 | 46 of 46 | |
| probes: chance fractions (`_chance.mjs`) | 12 | 9 | Flamethrower burn and Ice Beam frostbite returned no single deciding draw (null); Psybeam confusion measured 11.12 percent against the engine's 10 (see 8.7) |

Damage groups (equal / scenarios): type-phys 90/90, type-spec 90/90, level 8/8, stages 12/12, stages-spec 12/12, stages-crit 8/8, weather 28/28, burn 7/7, status 8/8, frostbite 10/10, terrain 95/95, gravity 15/15, gender 13/13, primal 51/51, scorched 30/30, newhit 28/28 (28/29 with Genesis Supernova),
screens 12/12, ability-atk 82/82, ability-pinch 7/7, ability-def 59/59, item-atk 29/29, item-def 9/9, power-fn 49/49, fixed 9/9, multi 10/10, crit 10/10, innate-atk 70/70, innate-def 51/51.

Turn-state groups: stats 58/58, status 13/13, status-immune 17/18 (Comatose), heal 16/16, self-hp 9/9, recoil 16/16, drain 13/13, residual 32/32, eot-order 16/16, weather-turns 4/4, weather 5/5, screens 4/4, rounding 26/26, classes 44/44, multi-turn 49/49, multi-hit 16/16, ability-new 58/58, item-new 35/35,
move-new 44/44, frostbite 7/7, terrain 156/156, gravity 31/31, doubles 27/27, vol 50/50, newhit 54/54, batchd 169/169, innate3 10/10, abilityf 26/26, ruin 6/6, primal 47/47, gender 28/28, order 45/45.  Ten of these (the ones where the battle ends or the user is locked, so the real game shows no final menu) are compared on HP only (`match-no-menu`).

The four fixes made after the full run, each a harness or preview fault and not an engine rule: (1) `classes/Trick-or-Treat` and `ability-new/Phantom Soul`: the live observation now reads the third type slot (Trick-or-Treat and Forest's Curse write it, Phantom Soul's extra type is worked out at use time),
the engine observation uses the stored types; (2) `primal/Thunder under hsun` is 50 percent accurate and the harness fixes the draw, so it is removed; (3) Genesis Supernova: the engine's preview now applies base power 150 and Psychic Terrain first like the real hit (87 in the full-turn scenario, which matches); the damage-group harness re-writes the field words
while it waits for the hit and so measures 67 (no boost), so the move is left to the turn-state scenario; (4) the chance probe tolerates a few samples decided by a different draw and bisects each step by majority of three runs; (5) Overgrow / Blaze / Torrent / Swarm are attack-step factors (see 8.2), found because removing Genesis Supernova from the list re-rolled the stats of every later combo (8.4) and one level-100 Swarm / Bug Buzz row then missed by one point (real 145, engine 146).  Re-runs: newhit damage 28/28, classes 44/44, ability-new 58/58, primal 47/47, the 8 pinch rows 8/8.

### 8.6 Items and moves that 7.4 listed as unverified and are now driven

Verified: Loaded Dice (Fury Attack 3 hits plain, 5 with the dice at the fixed draw), Grip Claw (a Wrap hits seven times instead of five), Float Stone (Low Kick on a 235 kg target: 120 BP, 100 BP with the stone), Custap Berry (the message, the order),
Rollout / Ice Ball (the lock and Rolling Stones), Tar Shot (now implemented), the Ogerpon masks (new).  Still unverified, with the exact reason: **Red Card, Eject Button, Eject Pack** (the oracle's foe is a single battle Pokemon with no party, so the forced switch cannot be observed),
**Lansat Berry** (only the message shows: the crit it raises needs a draw the harness fixes), **Micle Berry** (the accuracy boost needs a miss the harness cannot force), **Leppa Berry** (the harness writes full PP and cannot set one PP), the speed order of the Power items, Quick Powder (Ditto only), Berserk Gene, Blunder Policy (a miss cannot be forced).

### 8.7 Unverified, unobservable, or not supported (exact reasons)

* Run from the ROM's own text but NOT seen in the real game: **Frost Nova** (the oracle cannot play past a knock-out, there is no bench), **Wimp Out / Emergency Exit** (one Pokemon per side: no replacement to switch to), **Revival Blessing** (same, and it needs a party member that fainted),
  Conversion 2's exact draw order (its distribution matches; the engine picks `rand(candidates)`), Population Bomb's per-hit accuracy (the harness fixes the draws), Sky Drop's weight limit at exactly 200 kg (a 460 kg and a 100 kg target agree), Reborn against damage that is not a move, Wimp Out versus residual damage.
* Parts of hack abilities that the real game did NOT show and the engine does not model: Tidal Deity's rain "when HP drops below full" (no rain was seen), Time Spiral's "extra turn lost by weather and terrain" (none over four turns of rain), Parrying's "charging hits raise Defense" (no Defense change was seen).
* **Psybeam and Confusion**: the real game's confusion chance for these two (effect 8 at chance 10) is 11.12 percent (a threshold of 7286 on the 16-bit draw); Signal Beam (same effect, same chance byte) is 10.00 and the 20 percent ones (Water Pulse, Dizzy Punch) are 20.00.  The cause is not known (the move records differ only in type); the engine keeps 10 for all of them.
* **Tera Shell**: the ROM text says "at full HP, all damage-dealing moves that hit the Pokemon are not very effective".  It was built and then REMOVED: in the oracle a holder at full HP took ordinary damage (Pound 57 against the engine's 28, the same at 300 of 600 HP, 4 of 4 full-HP rows wrong, 4 of 4 below-full rows right).  The rule may need state the game sets at switch-in (as for Neutralizing Gas and the Ruin abilities) or may be limited to the Terastal form; the harness cannot start a battle with a chosen foe move, so it stays unsupported (Terapagos is excluded).
* **Horse Council**: "x1.1 per living horse ally in the party" needs the list of horse species, which is code in the ROM that could not be read back, and the oracle has no party.  Six species hold it as an innate: the innate is silently lost at level 95.
* **Form-change abilities** (six that a roster species holds as a slot: Illusion, Zen Mode, Stance Change, Battle Bond, Power Construct, Zero to Hero; nine more that nobody holds: Forecast, Flower Gift, Shields Down, Schooling, RKS System, Gulp Missile, Ice Face, Hunger Switch, Commander; and the Terastal Tera Shift, Teraform Zero, Embody Aspect).  They are NOT impossible in a team-battle engine; they are not built.
  Each needs a mid-battle species change (new base stats recomputed from the record's IVs / EVs / nature, new types and sometimes a new ability) that the engine's Pokemon (`sp`, `st`, `ty` fixed at switch-in) cannot do, plus a new sprite and name in the battle screen that the scene director does not draw.  The oracle can see the stat change
  (the damage differs), so each one could be run against the real game after that machinery exists.  Until then a species whose every ability slot is one of these is excluded, a slot is refused with the plain-words reason ("it changes the Pokemon into another form partway through the battle ..."), and the innate ones are silently lost.
* **Mega Evolution, Z-Moves, Dynamax / Gigantamax, Terastallization**: SoulGold has them in its DATA and TEXT, so they cannot be marked "not in this game": 114 Mega Stones (hold effect 103) and the Mega forms as separate roster species (Venusaur-Mega 906, Charizard-Mega X / Y 907 / 908 ...), 35 Z-Crystals (hold effect 114), 51 Max / G-Max moves (effect 307),
  the Tera abilities and moves, and battle messages for all four ("is reacting to ... Mega Ring!" at ROM 0x44037c, Dynamax / Gigantamax around 0x43e0f4-0x43e845, Z-Power at 0x43f2b0, Ultra Burst at 0x43eb37, Terastallization).  The trigger items are in the item table too (checked in this round): Mega Ring (id 705), Z-Power Ring (706), Dynamax Band (707), Tera Orb (774) and one Tera Shard per type (776 and on), all hold effect 0.  Whether a player can START one is not known: in the oracle's early-game checkpoint holding Venusaurite or Charizardite X
  showed no trigger prompt (START and SELECT tried), and the checkpoint may not own the Mega Ring; the next probe is to put the Mega Ring and a Mega Stone in the bag and read the battle's command menu.  The engine has no such mechanic, so Mega Stones, Z-Crystals, Memories / Drives / Orbs and the Max moves are refused with their own plain-words reasons.

### 8.8 Files

`tools/pokemonarena_rom_diff_{live,turns,combos,probes,chance}.mjs`, `tools/pokemonarena_engine_{lib,suite1..4,mutants,test}.mjs`; engine files `engine_data.js`, `engine_exec.js`, `engine.js`, `engine_moves.js`, `engine_abilities.js`, `engine_items.js`, `engine_validate.js`, `engine_support.js`, new generated `engine_fling.js` (572 item powers);
`rules.js` and `editor_views.js` (plain-words reasons, small hunks); `pokemonarena/engine.golden.json`, `engine_coverage.json`, `scene.golden.json`.

### 8.9 Test counts (round 3, 2026-11-02)

* `node tools/pokemonarena_engine_test.mjs` (full: golden digest, fuzz of 2000 battles, 167 mutants all killed incl. 16 new ones T01..T16, Node-vs-Chrome parity): **659 passed, 0 failed**; with `ARENA_SKIP_BROWSER=1 ARENA_SKIP_MUTANTS=1`: 653 passed.  A 10,000-battle fuzz at the default level and a 6,000-battle fuzz at level 100 (all innates on)
  also keep every invariant.  Golden digest `55da932d3ad7ecde` -> `e73e7ccc7a32a424`.  New checks: one `kt` per new move class (naturalgift, popbomb, ragingbull, ivycudgel, skydrop, conversion2, revival ... ) and `r3/...` checks for the abilities, Tar Shot, Gravity accuracy, the plain-words refusals and `r3/no-reachable-gap-is-only-not-yet`.
* `ARENA_SKIP_LIVE=1 node tools/pokemonarena_rom_diff_test.mjs`: layer 1 **88 passed, 0 failed** (Focus Energy / Dragon Cheer added to the explained shared scripts).  The live layer is section 8.5.
* Other pokemonarena tests on the final tree: rules 259/0, editor 233/0, editor page (headless Chrome) 420/0, battle_ui 178/0, scene 39/0 (32 of 32 mutants killed; `scene.golden.json` re-based, 36 hashes), profile 288/0, pack 175/0, fidelity 145/0.
* Collateral edits outside the engine files: `pokemonarena/js/rules.js` (plain-words messages, one import) and `editor_views.js` (the reason beside a refused move / item / ability slot, the innate sentence), `tools/pokemonarena_rules_test.mjs` (the unsupported-move case uses a pack in which one learnable move is turned into a Dynamax-class effect, the unsupported-ability case looks up a species with one runnable and one unrunnable slot),
  `tools/pokemonarena_editor_test.mjs` (the same poisoned-pack path for the move status), `pokemonarena/scene.golden.json` (only the team content moved), `pokemonarena/engine.golden.json` and `engine_coverage.json`.  `anim_scene.golden.json` was not touched.

## 9. Round 5 - entry announcements, Slow Start's end, the Delta Stream tick and flag, Rapid Spin freeing its user (stage FA2, 2026-11-02)

Requested by AN1's event sweep (`scratchpad/AN1/engine_requests.md`); the scene already maps every shape, so each line appears as soon as the engine emits the event. Method as always: the real game first (OR1 oracle, text capture), then the engine, then the differential. No battle rule changed: only events (and what the opponent has learned: the revealed ability / item / move).

### 9.1 What the real game does (MEASURED, oracle text capture, `fw_run.log`, `fw_run2.log`, `w_run.log` in the FA2 scratch folder)

* **Announcements at every entry**, same ROM texts AN1 pinned: Pressure 0x43fcb8, Mold Breaker 0x4409bc, Turboblaze 0x440978, Teravolt 0x440998, Dark Aura 0x43fc98, Fairy Aura 0x43fc78, Aura Break 0x43fc50, Cloud Nine / Air Lock 0x43fcd8 (said whether or not there is any weather).
  The order of two announcements of one Pokemon is the existing SWITCH_IN_ORDER (Dark Aura then Pressure for Yveltal, Air Lock then Pressure for Rayquaza: 2 of 2 equal).
* **Frisk** (0x440890) names the foe's item; when the foe holds none the game says nothing (measured, the case AN1 left open).
* **Forewarn** (0x4408e4) is an INNATE of every species that has it (Girafarig, Stantler, Ralts ...), so it only works from battle level 75 (innate slot 0); AN1's level-50 run could not see it. It names the foe's move with the most power: OHKO moves count 150, Counter / Mirror Coat / Metal Burst 120,
  every other one-power move (Seismic Toss, Gyro Ball ...) 80, otherwise the move's power; status moves count 0 and can be named; **the LAST move of the foe's list wins a tie** (7 of 7 orders, so not random): [Flamethrower, Thunderbolt, Ice Beam] names Ice Beam, the reverse order Flamethrower, [Splash, Growl] names Growl, [Growl, Splash] names Splash.
  Ladder runs: Seismic Toss beats Rock Slide (75) and loses to Flamethrower (90); Counter beats Thunder (110) and loses to Hyper Beam (150); Gyro Ball beats Rock Slide and loses to Flamethrower; Fissure beats Earthquake (100), ties Hyper Beam (150) and loses to Explosion (250).
* **Anticipation** (0x440900, "shuddered!") is said when a foe move is an OHKO move (Guillotine, Fissure) or a damaging move that is super effective against the holder by type (fixed-damage Night Shade counts; Explosion, Counter, a neutral, resisted or immune move, and status moves do not).
  AN1's Anticipation run was not a test: Eevee holds it in its hidden slot and the foe used Tackle, which is not super effective against it.
* **Slow Start** ends with the line of 0x440938 at the end of the fifth turn on the field (AN1: scn2 `slow-start-end`; the engine's counter does the same).
* **Delta Stream** prints "The mysterious strong winds blow on regardless!" (0x43f784) every turn.  "The mysterious strong winds weakened the attack!" (0x43f750) is printed whenever the winds clamp fired on the hit, i.e. the defender is a Flying type that the move was super effective against, and the real
  game THEN still prints the effectiveness of what is left: Rock Slide into Pidgey: weakened, nothing more (neutral); into Butterfree: weakened, then "It's super effective!"; into Skarmory: weakened, then "It's not very effective..."; Thunderbolt into Gyarados: weakened, then super effective; Ice Beam into Pidgey and Butterfree: weakened;
  Pound into Pidgey (not clamped): nothing. So the line does NOT replace "It's super effective!"; it is added before it. AN1's assumption that it replaces the line holds only when the clamp makes the hit neutral.
* **Rapid Spin** (AN1 scn4) frees its user from a binding move ("got free of ...'s Wrap!", 0x4428f4) and from Leech Seed ("shed Leech Seed!", 0x4428e0) after the Speed rise.

### 9.2 What the engine emits now

| event | shape | where |
|---|---|---|
| entry announcements | `{ t: 'ability', s, m, ab, fx }` with fx `pressure`, `mold-breaker`, `turboblaze`, `teravolt`, `dark-aura`, `fairy-aura`, `aura-break`, `weather-lock` (Cloud Nine and Air Lock); innates carry `inn: 1` | the `onStart` hook, in SWITCH_IN_ORDER |
| Frisk | `{ ..., fx: 'frisk', it }` (the foe's item id; the foe's item becomes revealed); nothing when the foe holds none | `onStart` |
| Forewarn | `{ ..., fx: 'forewarn', mv }` (the foe's move id; that move becomes revealed) | `onStart`, only when the holder has it (level 75 or more) |
| Anticipation | `{ ..., fx: 'anticipation' }` | `onStart` |
| Slow Start's end | `{ t: 'ability', ..., fx: 'slow-start-end' }` | the residual, when `m.v.ss` goes 1 to 0 (end of the fifth turn) |
| Delta Stream tick | `{ t: 'weather-tick', w: 8 }` every turn while the primal winds blow | `residual` (`S.wx` stays NONE for the winds, the guard now also tests `S.pw === 8`) |
| the winds flag | `winds: 1` on the `damage` event of the hit | whenever the clamp fired (any Flying defender that the move was super effective against), NOT only when the clamp made the hit neutral |
| Rapid Spin | `{ t: 'volatile-end', s, m, v: 'trap', why: 'rapid-spin', var }` then `{ ..., v: 'leech-seed', why: 'rapid-spin' }`, then the hazard clear, all after the Speed rise | `rapidspin.after` (the previous silent deletes) |

### 9.3 The differential

New live group `entry-ann` (34 scenarios plus 4 Anticipation ones with Fighting moves, `tools/pokemonarena_rom_diff_turns.mjs`): a real species leads a real battle against a Rattata with chosen moves / item; the real game's text is read through the oracle and reduced to keys (`annOf` in `_live.mjs`: pressure, mold-breaker ..., `frisk:<item>`, `forewarn:<move>`),
the engine's events are reduced to the same keys, and the two LISTS (order included) must be equal. Nothing but the announcements is compared in these scenarios. Result: see 9.4.
Unit checks in `pokemonarena_engine_suite4.mjs`: `r5/entry-announcements`, `r5/forewarn-power-rules`, `r5/slow-start-ends-at-the-end-of-turn-five-once`, `r5/delta-stream-ticks-every-turn-and-flags-the-clamped-hit`, `r5/rapid-spin-frees-its-user-after-the-speed-rise`, and 8 new mutants V01..V08.

### 9.4 Results and what moved
Engine `cat pokemonarena/js/engine*.js | md5sum`: 997e19be9837635c0495d85bc36d06c8 (end of round 3 follow-up) -> **158ce1437381df587365d4335cfe54e6**.

* Full live differential on this tree (`ARENA_LIVE_PROBES=1 node tools/pokemonarena_rom_diff_live.mjs`, log `scratchpad/FA2/live_final3.log`, 15,824 real-game damage trials, 6,287 s for the damage part): damage 902 of 902 equal; entry 95 of 95 (terrain 33, base 10, **announcements 38**, ruin 8, primal 6);
  turn state 1131 of 1132 equal (1121 + 10 compared on HP only; the one left is Comatose, no species has it); probes accuracy 39/39, crit 4/4, chance 3/3, chance fractions 9/12 (the same three as before: Flamethrower and Ice Beam have no single deciding draw, Psybeam confusion measures 11.12 percent).
* Engine test, full: **664 passed, 0 failed**, 175 of 175 mutants killed (8 new, V01..V08), Chrome digest parity equal; fuzz unchanged. scene_events 45/0 and event_codes 58/0 (AN1's tests: 12 ability-fx rows, `weather-tick:w=8` and `volatile-end:v=leech-seed` rows and 4 scenario checks added as small hunks, plus two FX_SCN entries),
  scene 39/0, rules 259/0, editor 233/0, battle_ui 178/0, fidelity 145/0, pack 175/0. `pokemonarena_profile_test.mjs` shows 2 failures (S21 and its total) that are NOT from the engine: its mutation anchor in `store.js` now occurs twice (another change to store.js).
* What moved: `engine.golden.json` digest `e73e7ccc7a32a424` -> `9db8376a764f382e`. 8 of 40 golden battles gained events (i = 1, 3, 18, 19, 20, 24, 29, 30; event counts +1 to +9: Pressure and the other announcements, the Delta Stream ticks in battle 24); the state hash moved in 7 of them (i = 1, 3, 18, 19, 20, 29, 30: the opponent has now learned an ability, item or move);
  `turns` and `winner` are identical in all 40 rows, so no battle outcome changed. `engine_coverage.json` did not move. `scene.golden.json` did not move (its fixed battle contains none of the new events: the events hash and the state hash of the golden are unchanged). `anim_scene.golden.json` is AN1's.

## 10. Round 6 - the order of the two lead announcements at battle start (stage FA2, 2026-11-02)

AN1 reported that the real game announces the player's lead first whatever the speeds (scn12 / scn14) while the engine orders the entries by speed. **The engine is right; the oracle runs were not a test.**

* The oracle runner writes the Pokemon's STAT block itself (player Speed 100, foe Speed 10 unless `spe` is passed), so "level 10 Pinsir against level 100 Aerodactyl" in scn12 / scn14 was a battle in which the player was always the faster one. The level changes nothing there.
* Re-measured with explicit Speeds (10 oracle scenarios, `ord_run.log` in the FA2 scratch folder): player Speed 50 against foe Speed 300: "The wild Aerodactyl is exerting its pressure!" and then "Pinsir breaks the mold!"; player 300 against foe 50: Pinsir first; with the roles swapped (Aerodactyl the player) the same: the FASTER one is announced first.
  The weather agrees: Drizzle (Politoed) against Drought (Vulpix): the slower one acts last and its weather stays (slow Politoed: rain, fast Politoed: sun, and both again with the roles swapped).
* Equal Speeds: 5 of 6 oracle runs went to the player, 1 went to the foe (Xerneas against Yveltal, both 119: "The wild Yveltal is radiating a dark aura!" first). So an exact tie is decided by the game's RNG (as the engine already does for tied MOVES), not by "player first". The engine's start-of-battle rule keeps side 0 first on an exact tie (`runEntries`: no RNG);
  a tie needs the same Speed on both leads, which is rare, and a random tie would put one draw into the start of every such battle; left as it is and listed here. In singles the player is always battler 0 (also against a trainer), so "player first" and "battler 0 first" cannot be told apart; neither is what the game does.
* No engine change (cat-md5 stays `158ce1437381df587365d4335cfe54e6`), no golden moved. Added: live group `start-order` (6 scenarios: the two leads of a battle, the order of the announcements and the weather that stays, speeds strictly different; `startLive` / `engineStart` in `_live.mjs` / `_turns.mjs`, the engine's own Speeds are written into the oracle's stats),
  unit check `r6/start-of-battle-entries-follow-speed-and-ties-go-to-side-0`, mutant V09. Result: start-order 6 of 6 equal, entry-ann 38 of 38.

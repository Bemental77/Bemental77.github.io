# The Pokemon Tower

A solo roguelike climb for Pokemon Arena: thirty floors of CPU trainers, and after every floor you win you choose one of three Poke Balls, each holding a buff that stacks, upgrades and combines with the ones you already have.

**Status: Phase 2, playable.** The Tower is wired end to end: the profile keeps it (schema 5), the hub has a TOWER row with its own screens, a floor is fought on the battle page, and the way back (offer, status, last run, achievements) is in the hub. Section 17 says how it is wired and where the one seam is; sections 1-16 are the design and still describe the rules. The regular game (Quick Battle, team battles, online) never sees a buff and the Tower never writes the career record.

The tables in this file between `<!-- BEGIN gen:... -->` markers are **generated from the code** by `node tools/pokemonarena_tower_doc.mjs` and checked by the test (case `A16`), so they cannot drift from what the modules do.

```
pokemonarena/js/tower_config.js   every tunable number (floors, odds, foe scaling, ball art), as data
pokemonarena/js/tower_buffs.js    the buff catalogue, the synergies, the interpreter that applies them, the words that describe them
pokemonarena/js/tower.js          the run: floors, trainers, offers, picks, results, the strict stored form, the Tower's own record
pokemonarena/js/achievements.js   the achievements, computed from a run's history and the Tower record
pokemonarena/js/tower_record.js   the stored shape of the Tower record (light: profile.js imports it)
pokemonarena/js/tower_session.js  the run as reducers over the stored record + the floor's spec; callbacks, no page, no address
pokemonarena/js/tower_fight.js    one floor's fight: the lifecycle (begun / left / won / lost) over a session; nav callbacks
pokemonarena/js/tower_launch.js   THE SEAM: the only Tower file that names an address (launchFloorBattle, returnToTower)
pokemonarena/js/tower_hub.js      the hub's Tower screens as a pure state machine (effects out, no DOM)
pokemonarena/js/tower_screen.js   drawing those screens with the ROM's own pieces
tools/pokemonarena_tower_test.mjs         242 cases + 162 mutants  node tools/pokemonarena_tower_test.mjs [--mutants]
tools/pokemonarena_tower_profile_test.mjs  55 cases + 41 mutants   schema 5, migration, import / merge, hostile records, the store transaction
tools/pokemonarena_tower_hub_test.mjs      the hub screens: 21 checks + 65 mutants, every view drawn, every text paged   [--mutants]
tools/pokemonarena_tower_page_test.mjs     real Chrome: phone (touch), desktop (keyboard + controller), integrity, and two tabs (the `residual` session)
tools/pokemonarena_tower_doc.mjs  regenerates / checks the tables in this file
```

## 1. What it is, and the one rule

The owner's words: *"a pokemon tower to try and beat trainers - as you beat trainers you get buffs, we can add rougelike benefits to the profile"* and *"roguelike will be for the tower, not for regular matches. you can get achievments from doing the tower tho"*, then: *"yknow like a roguelike? with tons of options for buffs that procedurally add up and can synergize, and sometimes get green, blue, purple and gold upgrades"* and *"the three buffs can be displayed in the 3 pokeballs like the starter pokemon in the rom"*.

**The one rule: a buff exists only inside a Tower run.** Regular and online battles never see one, and a Tower battle is never written into the regular career. This is enforced three ways and each is tested:

1. *Nothing to call.* The Tower modules import only `rules.js`, the AI's random generator, `matchctl.js`'s team builder and each other (case `H8`); nothing else in `pokemonarena/js` or in a page imports the Tower (`H9`). They touch no storage, DOM, clock or `Math.random`. A mutant that makes a Tower module import `career_stats.js`, or `matchctl.js` import the Tower, is killed.
2. *Nowhere to write.* The Tower keeps its own record (section 11). It has no `byCpu`, `totals`, `recent` or online fields, so a Tower result has no slot in the career (`H10`), and no Tower module exports anything named like a career write (`H11`).
3. *Nothing changes.* After the Tower has built a battle with every one of the 124 families, a regular match on the same teams plays out with the identical log hash, the ROM tables and the saved teams are byte-for-byte unchanged, and with no buffs the player's team is exactly the saved one (`H6`).

## 2. Decisions and the reasons for them

| Decision | Why |
| --- | --- |
| A buff is a change to the team's **records** (EVs, IVs, nature, ability slot, held item, PP Ups, a move) or to the **opponent** (its team size, EVs, IVs, items) - never an engine change. | The engine takes plain records (`engine.js:108-123`: species, level, nature, abilitySlot, item, moves, nickname, evs, ivs). No engine rewrite, so the regular game cannot be affected, and everything a buff does is visible in the same stats the player already knows. What this cannot express is in section 14. |
| Buffs are **data**: a family is `{ id, name, category, tags, ops, tiers, cap }`, a synergy is `{ tag set \| combo \| multiplier }`, and a small interpreter applies the ops. | Tuning is a data edit. The same table feeds the interpreter, the effect text, the offer screen and the tests, so the words on a ball are computed from the numbers that are applied (`C21`, `D7`). |
| Everything is a **function of the run seed**: trainers, offers, rarity rolls and the Gambler's coin. | The same seed gives the same Tower, so a reload cannot re-roll an offer or a trainer, a run can be stored as seed + picks, and the stored form is re-derived and checked on load (`F16`, `F20`). No `Math.random`, no clock. |
| **Four rarities - green, blue, purple, gold - are one stacking rule**, not four separate item classes. | One sentence the player can learn: *taking a family you already hold adds the points of the ball you took (green 1, blue 2, purple 4, gold 8), up to 16; a family's colour is the highest threshold its power has reached.* So two greens make a blue, two blues a purple, two purples a gold, and a gold stacks past gold. |
| The player **chooses** after each floor (3 balls, 5 after a boss, skipping allowed). | The owner asked for choice. A skip is a real option (some achievements are about restraint) and is configurable (`cfg.offer.allowSkip`). |
| **Never offer a dead ball.** With the ROM pack known, a buff that would change nothing for this team is not offered (a Bug-type lesson for a team with no Bug, 31 IVs for a team that already has them). | A ball that does nothing is a wasted choice. Tested both ways (`E11`: with the filter no dead ball appears; without it they do). |
| **Every floor starts at full health.** HP, PP and status do not carry between floors. | The engine's records carry no HP (`engine.js:108-123`), so attrition would need an engine hook (section 14). The pressure comes from build strength against a trainer that scales, and from a loss ending the run. |
| A loss ends the run unless **Extra Life** (a purple/gold buff) was taken. `cfg.lives` is 0. | Roguelike stakes; lives are a buff you can choose, not a given. Configurable. |
| The run uses a **snapshot** of one saved, legal team. Formats: 3v3 (needs 3+ Pokemon) and 6v6. | A run cannot be broken by editing or deleting the team midway. `newRun` refuses an illegal or too-small team (`F1`). |
| Tower battles run at the regular ruleset (`arena-gen3-standard`), built with **`validate: false`**. | Buffed teams exceed the ruleset's 510 EV total and may share an item. `validate:false` is `engine.js:1100`'s documented switch (`if (opts.validate !== false)`). The test runs the engine's own `validateTeam` on every buffed team and trainer and proves that the **only** rules bent are `ev.total` and `team.item-clause` (`H1`, `H3`). Every record still passes the engine's per-record check (`validateRec`, `engine.js:1099`, always on). |
| Opponent strength is **EV/IV/size/items scaled by floor**, built from the same `randomTeam` the regular game uses. | Reuses a tested legal-team generator; no new species logic. |
| Achievements are **computed from the run's history and the Tower record**, never counted live. | They cannot drift or double-count, re-evaluating is idempotent (`G7`), and the caller stamps the time (the module has no clock). |

## 3. What is NOT in v1 (honestly)

- **No HP/PP/status carry-over, no mid-run healing economy.** Each floor is a fresh fight. (Needs an engine hook.)
- **No numeric battle modifiers** (+10% damage, +1 crit stage, accuracy, flat damage reduction), **no opening effects** (weather, terrain, hazards, screens, stat stages on entry), **no per-floor field gimmicks**, **no gimmick bosses.** All need engine hooks. The v1 buffs get their strength from EVs, IVs, natures, abilities, items, PP Ups and moves, all of which the engine already honours.
- **No shop, currency or inventory.** The ball you pick is the whole economy.
- **No mid-battle save.** A run stores the floor you are on and what you hold. Whether a reload may resume the *same* fight is a Phase 2 decision (section 16, question 2); I have not read `battle_resume.js` in this phase.
- **No exact copy of the ROM's starter-choice scene** (section 10 says exactly what is and is not available).
- **No sound or music** for the Tower. **No balance claim**: the numbers are a first pass; section 15 shows what a bot measured, and that is not human play.
- **Not the other ideas from the same conversation:** Stadium-style rulesets, 4-player games, unlockable CPU difficulty. Those are separate.
- **No leaderboard, no daily seed, no online Tower.** (Cheap later: the run is already `seed + picks`.)
- **No UI.** Everything above is Phase 1 logic; the screens are listed in section 12.

## 4. The climb: the floors

<!-- BEGIN gen:counts -->
| What | How many |
| --- | --- |
| Buff families | 124 (70 general + 54 type-themed) |
| Families that can be offered as a green / blue / purple / gold ball | 106 / 117 / 118 / 123 |
| Families offered at one tier only (green / blue / purple / gold) | 1 / 0 / 0 / 5 |
| Curses (a real cost for a bigger reward) | 8 |
| Synergies | 50, in 80 levels: 30 tag sets (12 general + 18 per-type), 14 named combos, 6 multipliers |
| Achievements | 51 (9 / 18 / 15 / 9 by green / blue / purple / gold grade) |
| Floors | 30, a boss every 10th |
<!-- END gen:counts -->

Thirty floors; **floors 10, 20 and 30 are bosses** (`Gatekeeper Thorne`, `Warden Isolde`, `Tower Master Aldous`; the names are made up for the Tower, nothing is from the ROM). Clearing floor 30 wins the run (no offer after it). Every number below is in `tower_config.js`.

<!-- BEGIN gen:floors -->
| Floor | Who | CPU | Team (3v3) | Team (6v6) | EVs | Extra EVs / stat | IV cap | Items |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | trainer | easy | 3 | 3 | 25% | - | 10 | none |
| 2 | trainer | easy | 3 | 3 | 30% | - | 10 | none |
| 3 | trainer | easy | 3 | 3 | 35% | - | 10 | none |
| 4 | trainer | easy | 4 | 4 | 40% | - | 20 | none |
| 5 | trainer | easy | 4 | 4 | 45% | - | 20 | half |
| 6 | trainer | easy | 4 | 4 | 50% | - | 20 | half |
| 7 | trainer | normal | 4 | 5 | 55% | - | 26 | half |
| 8 | trainer | normal | 4 | 5 | 60% | - | 26 | half |
| 9 | trainer | normal | 4 | 5 | 65% | - | 26 | half |
| **10** | **boss** | hard | 6 | 6 | 70% | +30 | 31 | all |
| 11 | trainer | normal | 5 | 5 | 75% | - | 31 | all |
| 12 | trainer | normal | 5 | 5 | 80% | - | 31 | all |
| 13 | trainer | normal | 5 | 6 | 85% | - | 31 | all |
| 14 | trainer | normal | 5 | 6 | 90% | - | 31 | all |
| 15 | trainer | normal | 5 | 6 | 95% | - | 31 | all |
| 16 | trainer | normal | 5 | 6 | 100% | - | 31 | all |
| 17 | trainer | hard | 5 | 6 | 100% | +6 | 31 | all |
| 18 | trainer | hard | 5 | 6 | 100% | +12 | 31 | all |
| 19 | trainer | hard | 5 | 6 | 100% | +18 | 31 | all |
| **20** | **boss** | hard | 6 | 6 | 100% | +54 | 31 | all |
| 21 | trainer | hard | 6 | 6 | 100% | +30 | 31 | all |
| 22 | trainer | hard | 6 | 6 | 100% | +36 | 31 | all |
| 23 | trainer | hard | 6 | 6 | 100% | +42 | 31 | all |
| 24 | trainer | hard | 6 | 6 | 100% | +48 | 31 | all |
| 25 | trainer | hard | 6 | 6 | 100% | +54 | 31 | all |
| 26 | trainer | hard | 6 | 6 | 100% | +60 | 31 | all |
| 27 | trainer | hard | 6 | 6 | 100% | +66 | 31 | all |
| 28 | trainer | hard | 6 | 6 | 100% | +72 | 31 | all |
| 29 | trainer | hard | 6 | 6 | 100% | +78 | 31 | all |
| **30** | **boss** | hard | 6 | 6 | 100% | +114 | 31 | all |
<!-- END gen:floors -->

*EVs* is the share of the 510-point spread the regular random-team builder gives (`matchctl.js` `randomTeam`) that the trainer keeps; *Extra EVs* is a flat amount added to each stat that had EVs, capped at 255 per stat. *Team* is how many Pokemon the trainer brings. Bosses always bring six, always play at the `hard` CPU level, and carry an extra +30 EVs.

### The trainer generator

`floorTrainer(pack, { seed, format, floor }, cfg, mods)` in `tower.js`:

1. **Name:** a title from the CPU band (Youngster ... for `easy`, Hiker ... for `normal`, Ace Trainer ... for `hard`) plus a first name, drawn from `mix(seed, floor, 0x7a41)`; bosses have fixed names.
2. **Team:** `randomTeam(pack, mix(seed, floor, 0x7ea3), 6, ruleset)` - always six legal Pokemon, then the first *size* of them. A buff that changes the size changes only how many are used, so the six are the same with or without it.
3. **EVs:** each stat that had EVs becomes `mulPm(base, evPm') + bonus`, clamped to 0..255, where `evPm'` is the floor's share reduced by the player's foe-EV cuts (never below 10% of it: the cut is capped at 90%).
4. **IVs** are capped at the floor's IV cap (or the player's Stunted Growth cap, whichever is lower). **Items** follow the floor's item mode (none / alternate / all) unless Disarm strips them.
5. **CPU:** the AI level of the floor's band and a seed from `mix(seed, floor, 0xc0de)`.

Nothing here is random in the language sense: the same `(seed, format, floor, buffs)` always gives the same trainer (`F4`, `F5`, `F6`, `H5`).

## 5. Rarity, power, and the exact arithmetic

**Power points.** `green = 1, blue = 2, purple = 4, gold = 8`. Taking a ball adds its points to that family's power, up to the family's cap (16 = two golds; the five gold-only build-definers cap at 8; Scouting Report caps at 1). A family's **colour** is the highest threshold its power has reached: `>= 1` green, `>= 2` blue, `>= 4` purple, `>= 8` gold. Tested against the real `takeBuff`: `1 + green = 2`, `2 + blue = 4`, `4 + purple = 8`, `8 + gold = 16`, `16 + gold = 16` (`E12`).

**Magnitude.** Every amount that scales is written as four anchors `[green, blue, purple, gold]`, reached exactly at power 1, 2, 4 and 8, with a fifth anchor at the cap of `gold x 1.25` (`capBonusPm = 1250`). Between anchors the amount is interpolated linearly:

```
amount(p) = v[i] + roundDiv((v[i+1] - v[i]) * (p - a[i]), a[i+1] - a[i])        a = [1, 2, 4, 8, 16]
roundDiv(n, d) = floor((2n + d) / (2d))                                           (round half up, any integer n, d > 0)
mulPm(v, pm)   = roundDiv(v * pm, 1000)                                           (a synergy multiplier, permille)
```

Integers only, no floating point, and every EV change is clamped to 0..255 per stat. Worked example (generated from the code):

<!-- BEGIN gen:worked -->
| Power Training at power | Effect on the better attacking stat |
| --- | --- |
| 1 (green) | team EVs: best attacking stat +24 |
| 2 (blue) | team EVs: best attacking stat +40 |
| 3 (blue) | team EVs: best attacking stat +52 |
| 4 (purple) | team EVs: best attacking stat +64 |
| 6 (purple) | team EVs: best attacking stat +82 |
| 8 (gold) | team EVs: best attacking stat +100 |
| 12 (gold) | team EVs: best attacking stat +113 |
| 16 (gold) | team EVs: best attacking stat +125 |
<!-- END gen:worked -->

**What reaches the battle.** The engine computes a stat as `floor((2B + IV + floor(EV/4)) * L / 100) + 5` (HP: `+ L + 10` instead of `+ 5`), then the nature's 110/90, at the ruleset's battle level `L = 50` (`rules.js:123`, `battle: 50`; formula documented at `engine_data.js:109`). Case `H4` checks that a Power Training amount of 40 / 52 / 100 / 125 at power 2 / 3 / 8 / 16 is what lands in the record and that every battle stat and HP the engine reports equals this formula. Consequence worth knowing: EVs can add at most about 31 points to a stat at level 50, IVs 15, a nature +-10%. **A buff cannot make a stat go past what the stat range allows**; the Tower's escalation comes from covering more stats, more Pokemon, better items and moves, and from weakening the opponent.

### Offers

After a won floor `f` (not the last) the player is shown an offer:

- **Size:** 3 balls; 5 after a boss; plus Wider Choice / Boss Bounty / the Windfall synergy; clamped to 2..7 (`E3`).
- **Rarity of each ball** is drawn from a table that rises with the floor you just cleared, and is higher after a boss:

<!-- BEGIN gen:odds -->
Ordinary floors (the row whose "from" is the highest one not above the floor just cleared):

| From floor cleared | green / blue / purple / gold |
| --- | --- |
| 1 | 100% / 0% / 0% / 0% |
| 2 | 80% / 20% / 0% / 0% |
| 5 | 62% / 30% / 8% / 0% |
| 10 | 45% / 35% / 17% / 3% |
| 18 | 30% / 36% / 26% / 8% |
| 25 | 20% / 34% / 31% / 15% |

After a boss (floors 10 and 20; 30 is the top and ends the run):

| From floor cleared | green / blue / purple / gold |
| --- | --- |
| 1 | 0% / 55% / 35% / 10% |
| 20 | 0% / 35% / 43% / 22% |
<!-- END gen:odds -->

- **Guarantees:** the first ball of every 4th floor (4, 8, 12, ...) is at least blue; the first ball of a boss offer is at least purple, and a boss offer has no green ball at all (`E6`, `E7`). The very first offer (after floor 1) is all green (`E5`); the table brings purple in from floor 5 cleared and gold from floor 10 (`E8` checks nothing above blue appears before floor 5).
- **Fortune** (a meta family worth 1 / 2 / 3 / 5 units by colour) moves 12% per unit of the lowest offered tier's weight up to the tiers above it, 4:3:1 (`E10`).
- **Which family** fills a ball: drawn by weight (10; the build-definers 5) from the families that can appear at that rarity, are not already in this offer, are not at their power cap (`E4`, `E19`) and, when the pack is known, would change something.
- **Deterministic:** the offer is a function of `(run seed, floor cleared, what you hold)` (`E1`, `E2`), and a stored offer is re-derived and compared on load (`F16`).
- **Taking a ball you hold** upgrades it by the rule above; the pick event says so (`E13`) and names any synergy it completes (`E16`).
- **Skipping** takes nothing, is counted (`skips`) and can be switched off in the config (`E14`).

## 6. The buff catalogue

The 70 general families, in the order they appear in the code. *Offered as* is the colour range a ball of that family can have; *Power cap* is 16 unless shown; the effect column reads *first colour offered -> gold* (amounts are the exact ones the interpreter applies).

<!-- BEGIN gen:families -->
| Family | Kind | Offered as | Power cap | Tags | Effect (first tier offered -> top tier offered) |
| --- | --- | --- | --- | --- | --- |
| Power Training | training | green - gold | 16 | offense, evs | team EVs: best attacking stat +24  ->  team EVs: best attacking stat +100 |
| Speed Training | training | green - gold | 16 | speed, evs | team EVs: Speed +30  ->  team EVs: Speed +120 |
| Bulk Training | training | green - gold | 16 | bulk, evs | team EVs: HP +20, Defense +15, Sp. Def +15  ->  team EVs: HP +84, Defense +64, Sp. Def +64 |
| Iron Wall | training | green - gold | 16 | bulk, evs | team EVs: Defense +40  ->  team EVs: Defense +150; team EVs: HP +40 |
| Mind Shield | training | green - gold | 16 | bulk, evs | team EVs: Sp. Def +40  ->  team EVs: Sp. Def +150; team EVs: HP +40 |
| Twin Focus | training | green - gold | 16 | offense, evs | team EVs: Attack +25, Sp. Atk +25  ->  team EVs: Attack +100, Sp. Atk +100 |
| Max Effort | training | blue - gold | 16 | offense, speed, evs | team EVs: best attacking stat +120, Speed +60  ->  team EVs: best attacking stat +255, Speed +200 |
| Vitality Surge | training | green - gold | 16 | bulk, recovery, evs | team EVs: HP +30  ->  team EVs: HP +160 |
| Underdog Training | training | green - gold | 16 | offense, bulk, evs | weakest member EVs: best attacking stat +60, HP +40  ->  weakest member EVs: best attacking stat +220, HP +160 |
| Lead Training | training | green - gold | 16 | offense, speed, evs | lead EVs: best attacking stat +50, Speed +50  ->  lead EVs: best attacking stat +180, Speed +180 |
| Ace Training | training | blue - gold | 16 | offense, speed, evs | strongest member EVs: best attacking stat +70, Speed +40  ->  strongest member EVs: best attacking stat +170, Speed +100 |
| Rear Guard | training | green - gold | 16 | bulk, evs | last member EVs: HP +60, Defense +30, Sp. Def +30  ->  last member EVs: HP +220, Defense +120, Sp. Def +120 |
| Perfect Genes | genes | green - gold | 16 | genes | team: IVs at least 10  ->  team: IVs at least 31 |
| Nature Coach | genes | green - gold | 16 | genes, nature, offense | team: an attacking nature  ->  team: an attacking nature; team EVs: best attacking stat +20 |
| Swift Natures | genes | green - gold | 16 | genes, nature, speed | team: a Speed-boosting nature  ->  team: a Speed-boosting nature; team EVs: Speed +20 |
| Sturdy Natures | genes | green - gold | 16 | genes, nature, bulk | team: a bulk-boosting nature  ->  team: a bulk-boosting nature; team EVs: HP +20 |
| Hidden Talent | genes | green - gold | 16 | genes, ability | team: hidden ability  ->  team: hidden ability; team EVs: HP +70 |
| Leftovers for All | item | green - gold | 16 | items, recovery | team: hold Leftovers  ->  team: hold Leftovers; team EVs: HP +60 |
| Life Orb Squad | item | blue - gold | 16 | items, offense | team: hold Life Orb; team EVs: best attacking stat +30  ->  team: hold Life Orb; team EVs: best attacking stat +100 |
| Sash Brigade | item | blue - gold | 16 | items, bulk | team: hold Focus Sash; team EVs: Speed +20  ->  team: hold Focus Sash; team EVs: Speed +70 |
| Choice Training | item | green - gold | 16 | items, offense | team: hold a matching Choice item  ->  team: hold a matching Choice item; team EVs: best attacking stat +70 |
| Berry Bag | item | green - gold | 16 | items, recovery | team: hold a Sitrus Berry (if empty-handed)  ->  team: hold a Sitrus Berry (if empty-handed); team EVs: HP +60 |
| Lum Guard | item | green - gold | 16 | items, recovery | team: hold a Lum Berry  ->  team: hold a Lum Berry; team EVs: Sp. Def +60 |
| Sharp Eyes | item | green - gold | 16 | items, crit | team: hold Scope Lens  ->  team: hold Scope Lens; team EVs: best attacking stat +56 |
| Power Band | item | green - gold | 16 | items, offense | team: hold a matching Muscle Band / Wise Glasses  ->  team: hold a matching Muscle Band / Wise Glasses; team EVs: best attacking stat +56 |
| Rocky Thorns | item | green - gold | 16 | items, bulk | team: hold Rocky Helmet  ->  team: hold Rocky Helmet; team EVs: Defense +60 |
| Razor Claws | item | green - gold | 16 | items, crit | team: hold Razor Claw  ->  team: hold Razor Claw; team EVs: Speed +60 |
| Shell Bell Drain | item | green - gold | 16 | items, recovery | team: hold Shell Bell  ->  team: hold Shell Bell; team EVs: HP +60 |
| Quick Claws | item | green - gold | 16 | items, speed | team: hold Quick Claw  ->  team: hold Quick Claw; team EVs: Speed +60 |
| Heavy Boots | item | green - gold | 16 | items, bulk | team: hold Heavy-Duty Boots  ->  team: hold Heavy-Duty Boots; team EVs: HP +60 |
| Pinch Berries | item | green - gold | 16 | items, offense | team: hold a matching pinch berry  ->  team: hold a matching pinch berry; team EVs: best attacking stat +56 |
| Assault Vests | item | blue - gold | 16 | items, bulk | attackers: hold Assault Vest; attackers EVs: Sp. Def +30  ->  attackers: hold Assault Vest; attackers EVs: Sp. Def +100 |
| Air Balloons | item | green - gold | 16 | items, bulk | team: hold an Air Balloon  ->  team: hold an Air Balloon; team EVs: HP +60 |
| PP Boost | move | green - gold | 16 | pp, tutor | PP Ups 1 on every move  ->  PP Ups 3 on every move; team EVs: HP +40 |
| Coverage Tutor | move | blue - gold | 16 | tutor, offense | team: learn a coverage attack if they can; team EVs: best attacking stat +20  ->  team: learn a coverage attack if they can; team EVs: best attacking stat +70 |
| STAB Tutor | move | green - gold | 16 | tutor, offense | team: learn a strong same-type attack if they can  ->  team: learn a strong same-type attack if they can; team EVs: best attacking stat +56 |
| First Aid Lessons | move | green - gold | 16 | tutor, recovery | team: learn a healing move if they can  ->  team: learn a healing move if they can; team EVs: HP +60 |
| Protect Lessons | move | green - gold | 16 | tutor, bulk | team: learn Protect if they can  ->  team: learn Protect if they can; team EVs: Defense +60 |
| Priority Lessons | move | green - gold | 16 | tutor, priority, speed | team: learn a priority attack if they can  ->  team: learn a priority attack if they can; team EVs: Speed +60 |
| Status Lessons | move | green - gold | 16 | tutor, status | team: learn a status move if they can  ->  team: learn a status move if they can; team EVs: Speed +60 |
| Setup Lessons | move | blue - gold | 16 | tutor, setup, offense | team: learn a setup move if they can; team EVs: HP +20  ->  team: learn a setup move if they can; team EVs: HP +70 |
| Hazard Lessons | move | green - gold | 16 | tutor, hazard | lead: learn an entry hazard if they can  ->  lead: learn an entry hazard if they can; lead EVs: HP +100 |
| Power Lessons | move | green - gold | 16 | tutor, offense | team: learn a powerful attack if they can  ->  team: learn a powerful attack if they can; team EVs: best attacking stat +56 |
| Keen Moves | move | green - gold | 16 | tutor, crit | team: learn a high-critical-hit attack if they can  ->  team: learn a high-critical-hit attack if they can; team EVs: best attacking stat +56 |
| Intimidating Presence | foe | green - gold | 16 | foe | Trainers bring 1 fewer Pokemon  ->  Trainers bring 3 fewer Pokemon |
| Disarm | foe | green - gold | 16 | foe, items | Trainers hold no items  ->  Trainers hold no items; Trainer EVs cut by 15% |
| Frail Foes | foe | green - gold | 16 | foe, evs | Trainer EVs cut by 8%  ->  Trainer EVs cut by 28% |
| Stunted Growth | foe | green - gold | 16 | foe, genes | Trainer IVs capped at 20  ->  Trainer IVs capped at 5 |
| Defang | foe | green - gold | 16 | foe, tutor | Each trainer Pokemon loses its strongest attack  ->  Each trainer Pokemon loses its 3 strongest attacks |
| Mundane Foes | foe | green - gold | 16 | foe, ability | Trainers use their ordinary ability  ->  Trainers use their ordinary ability; Trainers have neutral natures |
| Dull Natures | foe | green - gold | 16 | foe, nature | Trainers have neutral natures  ->  Trainers have neutral natures; Trainer EVs cut by 10% |
| Frail Boss | foe | blue - gold | 16 | foe, economy | Boss bonuses cut by 70%  ->  Boss bonuses cut by 100% |
| Wider Choice | meta | green - gold | 16 | economy | offers show +1 ball(s)  ->  offers show +2 ball(s) |
| Fortune | meta | green - gold | 16 | economy | rarer balls (Fortune 1)  ->  rarer balls (Fortune 5) |
| Boss Bounty | meta | blue - gold | 16 | economy | boss offers show +1 ball(s)  ->  boss offers show +2 ball(s) |
| Extra Life | meta | purple - gold | 16 | economy, recovery | 1 extra life  ->  2 extra lives |
| Scouting Report | meta | green only | 1 | economy | the next trainer is revealed |
| Glass Cannon (curse) | risk | green - gold | 16 | risk, offense | team EVs: best attacking stat +60; team: HP EVs set to 0; team: Defense EVs set to 0; team: Sp. Def EVs set to 0  ->  team EVs: best attacking stat +220; team: HP EVs set to 0; team: Defense EVs set to 0; team: Sp. Def EVs set to 0 |
| Tank Mode (curse) | risk | green - gold | 16 | risk, bulk | team EVs: HP +60, Defense +60, Sp. Def +60; team: Attack EVs set to 0; team: Sp. Atk EVs set to 0  ->  team EVs: HP +255, Defense +255, Sp. Def +255; team: Attack EVs set to 0; team: Sp. Atk EVs set to 0 |
| Devil's Bargain (curse) | risk | blue - gold | 16 | risk, offense | team EVs: best attacking stat +100; Opponent EVs: every stat +36  ->  team EVs: best attacking stat +240; Opponent EVs: every stat +56 |
| High Stakes (curse) | risk | green - gold | 16 | risk, speed | team: held items removed; team EVs: best attacking stat +60, Speed +40  ->  team: held items removed; team EVs: best attacking stat +220, Speed +160 |
| Gambler (curse) | risk | green - gold | 16 | risk | A coin each floor: heads, team EVs: best attacking stat +80; tails, Opponent EVs: best attacking stat +60  ->  A coin each floor: heads, team EVs: best attacking stat +255; tails, Opponent EVs: best attacking stat +130 |
| Double or Nothing (curse) | risk | blue - gold | 16 | risk, evs | team: every EV x1.50; Trainers bring 1 more Pokemon  ->  team: every EV x2.00; Trainers bring 1 more Pokemon |
| Berserker (curse) | risk | green - gold | 16 | risk, offense, speed | team EVs: best attacking stat +50, Speed +50; team: Defense EVs set to 0; team: Sp. Def EVs set to 0  ->  team EVs: best attacking stat +200, Speed +200; team: Defense EVs set to 0; team: Sp. Def EVs set to 0 |
| Policy Gamble (curse) | risk | blue - gold | 16 | risk, items | team: hold Weakness Policy; team EVs: best attacking stat +40  ->  team: hold Weakness Policy; team EVs: best attacking stat +140 |
| Apex Predator | training | gold only | 8 | offense, items, genes, nature | team: best attacking stat EVs set to 255; team: IVs set to 31; team: hold Life Orb; team: an attacking nature |
| Fortress | training | gold only | 8 | bulk, items, recovery | team: HP EVs set to 255; team: Defense EVs set to 255; team: Sp. Def EVs set to 255; team: hold Leftovers |
| Titan Training | training | gold only | 8 | offense, bulk, speed, evs | team: HP EVs set to 255; team: Attack EVs set to 255; team: Defense EVs set to 255; team: Sp. Atk EVs set to 255; team: Sp. Def EVs set to 255; team: Speed EVs set to 255 |
| Overwhelming Force | foe | gold only | 8 | foe, economy | Trainers bring 2 fewer Pokemon; Trainer EVs cut by 40% |
| Grandmaster Tutor | move | gold only | 8 | tutor, offense, priority | team: learn a coverage attack if they can; team: learn a strong same-type attack if they can; team: learn a priority attack if they can |
<!-- END gen:families -->

**Type-themed families (54 = 3 mechanics x 18 types).** For every type there is a *Training* family (EVs for members of that type), a *Gear* family (the matching type-boosting item) and a *Lessons* family (a move of that type). They only ever affect Pokemon that have the type, and they are what the per-type synergies are built on. Fire is shown; the other seventeen types are the same with another type:

<!-- BEGIN gen:typefamilies -->
| Family (Fire shown; 18 types) | Offered as | Effect (green -> gold) |
| --- | --- | --- |
| Fire Training | green - gold | Fire members EVs: best attacking stat +24  ->  Fire members EVs: best attacking stat +100, HP +40 |
| Fire Gear | green - gold | Fire members: hold a matching type item  ->  Fire members: hold a matching type item; Fire members EVs: Speed +56 |
| Fire Lessons | green - gold | Fire members: learn a move of its type if they can  ->  Fire members: learn a move of its type if they can; PP Ups 3 on every move |
<!-- END gen:typefamilies -->

**Curses (8)** buy a bigger effect with a real cost (Glass Cannon zeroes your bulk, Devil's Bargain strengthens the trainer, Double or Nothing adds a trainer Pokemon, High Stakes strips your items, Gambler flips a coin each floor that helps either you or the trainer - never both, never neither: `C19`). Three curses in one run is an achievement.

**Build-defining legendaries (5)**, gold only, cap 8, weight 5 (rarer than the rest): *Apex Predator*, *Fortress*, *Titan Training* (every EV 255), *Overwhelming Force* (two fewer trainer Pokemon and 40% fewer trainer EVs), *Grandmaster Tutor*. Taking one is a build decision, not a number.

## 7. Synergies

A synergy has a visible name and a one-line description wherever it is shown. A family counts **once** toward a tag however strong it is (`D3`); of a tag set only the highest reached level is active (`D2`); a combo needs **all** its families at any power (`D4`, `D5`); a multiplier makes the families with a tag stronger by an exact permille (`D6`, `D7`: 24 EVs become 30).

**Tag sets** - hold N families that carry the tag:

<!-- BEGIN gen:tagsets -->
| Synergy (level 1 / level 2) | Needs | Effect |
| --- | --- | --- |
| Tempo / Blitz | any 3 / 5 "speed" families | Speed EVs +40 on every Pokemon  //  Speed EVs +80 and Attack EVs +30 |
| Bastion / Citadel | any 3 / 5 "bulk" families | HP EVs +40 on every Pokemon  //  HP, Defense and Special Defense EVs +60 |
| Onslaught / Annihilation | any 3 / 5 "offense" families | Best attacking stat EVs +40  //  Best attacking stat EVs +90 |
| Full Kit / Walking Armoury | any 3 / 5 "items" families | HP EVs +30  //  HP EVs +50 and PP Ups on every move |
| Scholar / Professor | any 3 / 5 "tutor" families | PP Ups +2 on every move  //  PP Ups +3 and best attacking stat EVs +50 |
| Second Wind / Lifeline | any 3 / 5 "recovery" families | HP EVs +40  //  HP EVs +80 and Special Defense EVs +40 |
| Keen Edge / Executioner | any 2 / 3 "crit" families | Best attacking stat EVs +30  //  Best attacking stat EVs +70 and Speed +30 |
| Intimidator / Dominator | any 3 / 5 "foe" families | Every trainer: EVs cut by 10%  //  Every trainer brings one Pokemon fewer |
| Windfall / Jackpot | any 3 / 5 "economy" families | Every offer shows one more ball  //  Boss offers show one more ball and Fortune is stronger |
| Daredevil / Death Wish | any 2 / 3 "risk" families | Best attacking stat EVs +40  //  Best attacking stat EVs +100 and Speed +60 |
| Study Hall / Honours Class | any 2 / 3 "genes" families | IVs raised to at least 20  //  IVs raised to 31 |
| Overtrained / Peak Condition | any 4 / 6 "evs" families | EVs +15 in every stat  //  EVs +30 in every stat |
| <Type> Affinity / <Type> Mastery (18 types) | 2 / 3 families of that type (e.g. fire: 2 / 3) | <Type> Pokemon: best attacking stat EVs +30 and Speed +20  //  <Type> Pokemon: best attacking stat EVs +70, HP +40 and a favourable nature |
<!-- END gen:tagsets -->

**Named combos** - hold exactly these families:

<!-- BEGIN gen:combos -->
| Combo | Families needed (all of them) | Effect |
| --- | --- | --- |
| Hit and Run | Speed Training + Priority Lessons | Speed EVs +40 and Attack EVs +30 |
| Iron Fortress | Iron Wall + Mind Shield | HP EVs +60 |
| Glass and Steel | Glass Cannon + Life Orb Squad | Best attacking stat EVs +60 |
| Cornered Rat | Sash Brigade + Protect Lessons | Speed EVs +50 and HP +30 |
| Sustain | Leftovers for All + First Aid Lessons | HP EVs +50 and Defense +30 |
| Critical Mass | Sharp Eyes + Keen Moves | Best attacking stat EVs +60 |
| Setup Sweeper | Setup Lessons + Swift Natures | Speed EVs +50 and best attacking stat EVs +40 |
| Boss Hunter | Boss Bounty + Frail Boss | Every offer shows one more ball and bosses are weaker |
| Trainer Trouble | Intimidating Presence + Frail Foes + Disarm | Every trainer: EVs cut by a further 20% |
| Perfect Student | Perfect Genes + Nature Coach + Hidden Talent | EVs +20 in every stat |
| Lucky Streak | Fortune + Wider Choice + Scouting Report | Fortune is stronger and every offer shows one more ball |
| All In | Devil's Bargain + Double or Nothing + Berserker | Best attacking stat and Speed EVs +80 |
| Coverage King | Coverage Tutor + STAB Tutor + Power Lessons | Best attacking stat EVs +60 and PP Ups on every move |
| Cold Open | Hazard Lessons + Status Lessons | Lead Pokemon: HP and Speed EVs +60 |
<!-- END gen:combos -->

**Multipliers** - conditional multipliers on what you already hold:

<!-- BEGIN gen:mults -->
| Multiplier | Switches on with | Effect |
| --- | --- | --- |
| Adrenaline | 2 "speed" families | Offense families are 25% stronger |
| Bulwark | 2 "bulk" families | Recovery families are 30% stronger |
| Precision | 2 "crit" families | Setup families are 25% stronger |
| Quartermaster | 3 "items" families | Tutor families are 20% stronger |
| Overconfidence | 2 "risk" families | Offense families are 30% stronger |
| Methodical | 3 "evs" families | Genetic families are 25% stronger |
<!-- END gen:mults -->

Reachability is proved, not assumed: for **every one of the 80 synergy levels** a bot using only the real `offerFor` / `takeBuff` reaches it in a legal run (`I1`; the hardest needed 24 seeds and no more than 6 picks), and every family shows up in real offers for real teams (`I2`).

## 8. Achievements

Earned only by playing the Tower; each is computed from the run's history (`runFacts`) and the Tower record, with a positive and a negative fixture in the test (`G5`, `G6`). Cosmetic: nothing an achievement unlocks touches regular play.

<!-- BEGIN gen:achievements -->
| Grade | Achievement | How |
| --- | --- | --- |
| green | First Step | Clear floor 1. |
| green | Getting Warm | Clear floor 5. |
| blue | Halfway Up | Clear floor 15. |
| purple | Nearly There | Clear floor 25. |
| blue | Gatekeeper Down | Beat the floor 10 boss. |
| purple | Warden Down | Beat the floor 20 boss. |
| gold | Tower Master | Clear the top floor and win the run. |
| green | Not a Scratch | Win a floor without losing a Pokemon. |
| blue | Hat Trick | Win three floors in a row without losing a Pokemon. |
| purple | Spotless | Win ten floors in one run without losing a Pokemon. |
| purple | Untouchable | Beat a boss without losing a Pokemon. |
| gold | Perfect Climb | Win the run without losing a single Pokemon on any floor. |
| blue | Bare Hands | Clear floor 5 without taking any buff. |
| purple | Purist | Beat the floor 10 boss without taking any buff. |
| gold | Naked Ascent | Win the run without ever taking a buff. |
| green | Picky | Skip five offers in one run. |
| green | Quick Win | Win a floor in 4 turns or fewer. |
| blue | Lightning Round | Win a floor in 2 turns or fewer. |
| purple | One and Done | Win a floor in a single turn. |
| blue | Marathon | Win a floor that lasts 40 turns or more. |
| purple | Triple Threat | Win a run in the 3v3 format. |
| purple | Full Squad | Win a run in the 6v6 format. |
| gold | Both Ways | Win a run in each format. |
| blue | One Note | Clear floor 10 with a team whose Pokemon all share a type. |
| gold | Monotype Master | Win a run with a team whose Pokemon all share a type. |
| blue | Rainbow Team | Clear floor 10 with six Pokemon of six different first types. |
| green | Collector | Take ten different buffs over all your runs. |
| blue | Hoarder | Take thirty different buffs over all your runs. |
| purple | Curator | Take sixty different buffs over all your runs. |
| gold | Completionist | Take every buff family at least once. |
| blue | Walking Arsenal | Hold fifteen different buffs at once. |
| blue | Fusion | Take a buff family twice and merge it up to purple or better. |
| gold | Ascension | Push one buff family to the power cap. |
| purple | Well Rounded | Take a buff from every category in one run. |
| purple | Full Spectrum | Hold a green, a blue, a purple and a gold buff at once. |
| blue | Risky Business | Take three cursed buffs in one run. |
| blue | Synergist | Have three synergies active at once. |
| gold | Synergy Master | Have eight synergies active at once. |
| blue | Combo Lover | Complete a named combo. |
| blue | Comeback | Win a floor after being two Pokemon down. |
| blue | Clean Sweep | Win a floor with one Pokemon scoring every knock-out. |
| blue | Photo Finish | Win a floor with a Pokemon left at 5% HP or less. |
| green | Second Chance | Spend an extra life. |
| gold | Phoenix | Spend an extra life and still win the run. |
| green | Rock Bottom | Lose on floor 1. |
| green | Regular | Finish three runs. |
| blue | Devoted | Finish ten runs. |
| purple | Obsessed | Finish twenty-five runs. |
| purple | Habitual Winner | Win three runs. |
| purple | Tower Veteran | Clear a hundred floors across all your runs. |
| purple | Giant Slayer | Beat ten bosses across all your runs. |
<!-- END gen:achievements -->

## 9. The run, as a state machine

```
newRun(team, format, seed) -> phase 'battle', floor 1
  battleSetup(pack, run)           -> { player.recs, foe.recs, cpu, pick, validate:false, seed, names, ... }   feed to createMatchController
  recordFloorResult(run, result)   win  -> 'offer' on floor+1 (or 'won' after floor 30)
                                   loss -> a life if Extra Life, else 'over'
  takeBuff(run, id | null)         -> 'battle' (a skip is null)
  abandonRun(run)                  -> 'over'
  foldRunInto(tower, run)          -> the Tower record, once
```

`recordFloorResult` is idempotent: a result for another floor, in another phase or twice changes nothing (`F10`), so a double fire or a replayed result screen cannot skip a floor. It accepts `match_stats.summarizeMatch`'s summary directly (`F14`). A run's stored form is a plain JSON object with a **strict** parser: unknown fields, forged powers, free buffs, history that lies about being flawless and 31 more hostile edits (34 in all) are refused (`F16`), and the held list and the pending offer are *re-derived* from the history and the seed rather than trusted (`F16`, `F20`).

## 10. The offer screen

The owner's reference: *"the three buffs can be displayed in the 3 pokeballs like the starter pokemon in the rom"* - three Poke Balls to choose between, a cursor, the highlighted ball opening to show what is in it.

**What can and cannot be built from the ROM, stated plainly.** I did **not** find or decode the retail starter-choice scene's own graphics (its table, background, cursor, info panel): the repo has no decoder for it - a search for "starter" in `pokemonarena/js`, `pokemonarena/*.md` and `docs` matches only a comment about a starter *record* (`rules.js:599`) - and I did not go hunting for it in the ROM in this phase. So **the exact scene cannot be reproduced and nothing here pretends to**. What the repo can already draw from the ROM is the 17-entry Poke Ball table: 16x16 sprites in three frames (closed, open, a dark open frame some balls have), with their own palettes (`anim_mon.js:111-126`, `ballGfx`). The nearest honest equivalent is built only from that plus plain drawing:

- the balls are the ROM's own sprites, at 2x, in a row; the **closed** frame when idle and the **open** frame (lifted a few pixels) on the highlighted ball;
- the surface they sit on is a flat table drawn with filled rectangles (no ROM art is claimed for it);
- the info box uses the text box and font the battle page already draws (`scene.js`, `textfx.js`, `charset.js`);
- the rarity is shown by the choice of ball sprite **and** a coloured ring in the rarity colour, so it reads even for a player who cannot tell the sprites apart.

The four sprites were chosen by **measuring the real ROM's palettes** (the test, `H12`, repeats the measurement every run): the ball index and the dominant hue are

<!-- BEGIN gen:balls -->
| Rarity | Also called | Power points | Colour | ROM ball sprite | Dominant hue (measured on the ROM by the test) |
| --- | --- | --- | --- | --- | --- |
| green | common | 1 | #4caf50 | ballGfx index 7 | green |
| blue | rare | 2 | #42a5f5 | ballGfx index 9 | blue |
| purple | epic | 4 | #ab47bc | ballGfx index 4 | purple/pink |
| gold | legendary | 8 | #ffca28 | ballGfx index 13 | yellow |
<!-- END gen:balls -->

**Controls:** Left/Right moves the cursor across the balls; the highlighted ball opens and its info box appears; **A takes it**; **B steps back to the Tower menu** (the offer is not lost: it is in the profile, and the menu's first row, CHOOSE A BUFF, opens it again; the row under it, MY BUFFS, is how a player looks at what they hold before choosing); **Down, START or the SKIP chip** move the cursor to a *Skip* slot after the last ball, and A there asks to confirm taking nothing. A boss offer is four to five balls in the same row (five at 2x fit in 240 px).

**What the info box shows** - exactly what `offerView(run, { pack })` returns, which is tested (`H13`, `H14`) and which Phase 2 only has to draw:

```
{ cursorStart: 0, canSkip: true,
  balls: [{ id, name, tier, rarity: 'green'|'blue'|'purple'|'gold', alias, color, ball /* ROM index */,
            category, curse,
            effectText,                         // one line, the exact numbers the ball will apply (synergy multipliers included)
            synergyProgress: [{ id, name, have, need, gained }],   // "Fire Affinity 1/2"; gained = taking it completes it
            stacksInto: null | { from:{tier,power}, to:{tier,power}, text: 'green -> blue' } }] }
```

```
 +--------------------------------------+
 |      (o)      (O)^      (o)           |   balls on a flat table; the highlighted one is open and lifted
 |     green     BLUE     purple         |
 | +----------------------------------+ |
 | | Power Training            BLUE   | |   name, rarity word in the rarity colour
 | | best attacking stat EVs +40      | |   effectText
 | | Offense 2/3 -> Onslaught         | |   the nearest synergyProgress
 | | You hold it: green -> purple     | |   stacksInto
 | +----------------------------------+ |
 +--------------------------------------+
```

## 11. The Tower's record (`profile.tower`, schema v5 - built in Phase 2)

The profile is at schema 4 (`profile.js:60`, `SCHEMA_VERSION = 4`) with a fixed key list (`profile.js:431`, `PROFILE_KEYS`). The Tower adds one key:

```json
"tower": {
  "v": 1,
  "best":        { "3v3": 0, "6v6": 0 },     // most floors cleared in one run, per format
  "winsByFormat": { "3v3": 0, "6v6": 0 },    // runs won (wins = their sum)
  "runs": 0, "wins": 0, "floors": 0, "bosses": 0,
  "buffsSeen":   { "<family id>": 3 },         // times each family was taken, over all runs
  "achievements": { "<achievement id>": 1767225600000 },   // when earned (the caller's clock)
  "current": null                              // the unfinished run (the strict stored form), or null
}
```

- **It is not the career.** `stats` (`career_stats.js:19-24`: `byFormat`, `byCpu`, `totals`, `recent`) is untouched; there is no field a Tower result could fold into (`H10`).
- **Strict:** `checkTower` refuses unknown fields, wins above runs, a best above the floor count, unknown buffs, bad stamps and a finished run in `current` (`F19`: 8 hostile edits). `current` is itself checked by `parseRun`, which re-derives its held list and offer.
- **Size is bounded:** `current` is at most six records, one offer and a history the parser caps at 400 rows; `achievements` <= 51 today (the check allows 500); `buffsSeen` <= 124.
- **Built (Phase 2):** `tower` is in `PROFILE_KEYS`; `SCHEMA_VERSION = 5`; `migrate4to5` is pure and idempotent (it keeps a valid `tower`, sets `emptyTower()` otherwise, and parks junk in `_unknown.v4Tower`); `normalizeTower` repairs field by field and keeps the damaged value in `tower._unknown.towerRejected`; the export checksum covers `tower`; import `new` copies it, `replace` replaces it, `merge` keeps the local one; "Keep my edits" and restoring a revision keep the CURRENT tower and the CURRENT `stats`. A profile of a newer schema stays read-only. The record also holds `last` (a summary of the last finished run). `tools/pokemonarena_tower_profile_test.mjs` proves each of these, and that a whole climb through the real store leaves `stats.totals`, `byCpu` and the online record byte-identical.
- **Merge (proposal; I have not read the profile merge code in this phase and Phase 2 must follow whatever it does for `stats`):** `best` = max per format; `achievements` = union keeping the earlier stamp; `buffsSeen` = union keeping the larger count; counters (`runs`, `wins`, `floors`, `bosses`) cannot be summed across two copies of the same profile without double counting, so follow `stats`' rule; `current` = the run that has cleared more floors.
- **Folding a finished run** (`foldRunInto`) is idempotent: a run carries a `folded` flag, so a replay or a second tab cannot count it twice (`F15`, `F18`). A run in progress folds into nothing. **A run counts only if it can be read and cleared at least one floor**: DROP THIS RUN and NEW RUN drop one that cannot (a stored run whose rows do not parse would throw inside the fold and lock the Tower) and one that cleared nothing is not a run (starting a run and giving it up from the hub earns no run-count or Rock Bottom achievement); a run that is *played* and lost on floor 1 still counts (`Q9`, `Q11`). **LEAVE TOWER on the battle page follows the same rule**: a quit on a floor whose fight was never marked (no choice made) on a run that has cleared no floor is DROPPED, counted as nothing, exactly as the hub's give-up drops it (`reduceFinishFloor`; `Q44`, `Q47`: 25 cycles of start, open the floor, LEAVE TOWER earn no run, no Rock Bottom, no run-count achievement). Once the first choice is made, leaving is a played loss and counts (`Q45`; 25 such cycles are 25 runs). A quit before the first choice of a LATER floor, on a run that has cleared a floor, is still the counted loss it always was (`Q46`): only a run that cleared nothing is dropped.
- **A hostile or hand-edited record can never lock the Tower** (`Q1`-`Q7`, `D1`-`D3b`). The strict CHECK accepts up to 400 buff ids, 500 achievements and counters up to 10^9; the REPAIR keeps fewer (`TOWER_LIMITS.buffsKeep` 250, `achievementsKeep` 400, `counterKeep` 10^9 - 10^6, the two formats' wins adding up to no more than that), so a record the repair left full still has room for the next real id or count (124 families and 51 achievements exist). What does not fit is handed back in `tower._unknown.towerRejected`, never thrown away silently. That bag (`tower._unknown`, with `towerRejected` in it) is itself held to 64 KB (`capBag`: the oldest keys go first, a key bigger than the allowance goes too); a real Tower record is under 10 KB. What the repair hands back (`rejected`) is cut down on its own FIRST (`fitRejected`) to the room that bag has left, because `capBag` drops the oldest keys: merged in whole, a huge reject (20,000 junk buff ids) would push the record's own older unknown values (a `futureThing`) out of the bag and then itself. The fields of a reject that do not fit are left out and named in `towerRejected._dropped` (`D2c`, `D2d` of the profile test). The shallow shape check also requires every row of a stored run's `history`, `held` and `team.recs` to be an object. `migrate4to5` files a junk v4 `tower` under the first FREE name (`v4Tower`, `v4Tower_2`, ...: a name the player's own unknown value or a stray top-level key already holds is never overwritten). A stamp from a clock that gives -5, 1.5 or NaN is stored as 0 (`sanitiseStamp`).
- **A fight has an identity.** The page that makes the first choice marks the run `fighting` with its own `attempt` (a whole number from 1; an optional key of the stored run, 0 when no fight is marked, absent in a run written before it existed). Only that page can finish the fight (`reduceFinishFloor`), a second tab on the floor is refused as taken (it is told it is a duplicate), and a result also names the try of the floor it is for (`lives`, the lives spent when the fight began), so a late or replayed loss of an earlier try is refused after an Extra Life was spent (`Q13`-`Q16`, `Q27`-`Q31`). The tab-local resume record (`battle_resume.js`, session storage) carries the attempt of the page that wrote it, and a Tower page takes a saved battle over only if the record's attempt is exactly the one it asks for (on a reload that is the run's own): a duplicate tab saves its own choices under ITS number, so when it is reloaded the record does not match the first tab's fight, the saved battle is refused ("another page of this fight") and thrown away, and the fight counts as LEFT (`Q38`-`Q40b`; in real Chrome the `residual` session of the page test, two tabs). Scouting a floor in a second tab opened by address therefore cannot dodge the abandon penalty of the first. **Known and left:** a tab made with the browser's "Duplicate" command copies the first tab's session storage, saved battle and attempt included, so such a copy is not told apart from the tab it came from; a deliberate player could play ahead in one copy and carry on in the other. Telling them apart needs a per-tab identity (a BroadcastChannel owner), which this release does not add. A saved battle with no attempt in it (written by the build before the field existed) is refused the same way, so a Tower tab left open across the deploy that added it counts its fight as left when reloaded. Attempt numbers are whole numbers up to 2^32-1 and are compared as such: about half of all random 32-bit numbers are 2^31 or more, and a page holding one is still the owner of its own mark (`Q43`). A ball is taken by the OFFER it was shown in: the pick carries the floor and the offer's key, and an old screen cannot answer a later offer (`Q17`). On the hub the "Take this buff?" / "Take nothing?" question PINS the run, the floor, the offer's key and the ball when it OPENS and answers those on YES, not what the data says by then; if the offer in the data changes while the question is open (another tab answered it, a newer one is up) the question closes (`pin:` checks of the hub test).

## 12. Hub screens (Phase 2: built, except the codex and the grade filter)

1. **Tower home:** the current run (Continue / Give up), Start a run (pick a saved legal team and a format), the record (best floor per format, runs, wins).
2. **Floor screen:** the floor and the trainer (name, team size, CPU level; the team itself only with Scouting Report), what you hold, a *Fight* button.
3. **Offer screen** (section 10).
4. **Held buffs / synergies list:** every family you hold with its colour and effect, the active synergies, and the ones within reach.
5. **Run result:** floors cleared, what you built, the achievements this run earned, *New run*.
6. **Achievements:** the 51, locked / earned with the stamp, filter by grade.
7. **Buff codex:** the 124 families, seen or not (from `buffsSeen`), with the effect at each colour.

Built: 1 (Tower home, with FIGHT / CHOOSE A BUFF / NEW RUN / DROP THIS RUN / TRAINER), 2 (folded into the home screen: the message says who is next), 3 (the offer, section 10), 4 (MY BUFFS with a SYNERGIES tab), 5 (LAST RUN), 6 (ACHIEVEMENTS, all 51, earned ones marked; no grade filter yet). The message box of MY BUFFS and ACHIEVEMENTS word-wraps the selected text to the ROM window by the real font, two lines a page: A (or a tap on the box) turns the page, a down arrow shows that the text goes on, and no word is ever cut or lost (every buff text at every power, every synergy and achievement text is proved to read back exactly: 1,900+ texts, `R.` checks in the hub test). **Deferred:** 7 (the codex of all 124 families) and the achievement filter.

The battle page needs a *tower mode* (built: `battle.html?tower=1&floor=N&run=<seed>[&life=K][&p=<profile id>]`): build the match from `battleSetup(pack, run)` (not from two saved teams), pass `validate: false`, run the CPU with `setup.cpu`, and on the end hand `summarizeMatch`'s summary to `recordFloorResult`, **persist the run before showing the result screen**, and never call the career's `foldMatch`.

## 13. How the Tower reaches the engine

**Integrator's note (preview and question).** `battleSetup` returns `pick` AND `lead` (`lead` is true for a 6v6 run, so a 6v6 floor opens on the LEAD preview, a 3v3 floor on the team preview: `F8b`, mutant `setup-drops-lead`; `towerFloorSpec` carries it to the page) and, for the question "Will you switch your Pokemon?" that a Pokemon trainer battle asks, pass `freeSwitch: true` and give the scene the page's BATTLE STYLE setting (`createScene({ style })`, `style_settings.js`), exactly as `battle_boot.js` does; a Tower floor is a human seat against a CPU, so the question applies. Both are answered through `ctl.submit` and are ordinary recorded choices (they do not change what a floor's turn count means: a free switch is not a turn). (`battle_boot.js` passes `freeSwitch: true` for every spec, a Tower floor included, so the question is asked there too; `battleSetup` does not return it.)

`battleSetup` returns `{ player: { recs, meta }, foe: { recs, meta }, ruleset, pick, lead, validate: false, seed, names, cpu, trainer, effects }`. For a 3v3 run `pick` is 3, for 6v6 0. `player.recs` is `applyTeam(pack, run.team.recs, run.held)` - a **new** array (the saved team is never touched: `C1`, `H7` run it on a deep-frozen team through every family) - and `foe.recs` is the floor's trainer after the opponent-side ops. `effects` carries what the buffs do to the run itself (offer size, Fortune, lives, Scouting).

## 14. Engine hooks needed (not built)

Each of these is something a roguelike would want and the engine cannot do today. I built none of them; a buff that needs one is not in the catalogue.

1. **Starting HP / PP / status per Pokemon** (carry damage between floors, a healing economy). `engine.js:108-123`: a record has no HP.
2. **Opening field effects** (weather, terrain, entry hazards, screens) - "starts rain", "your side starts with Spikes".
3. **Opening stat stages** (+1 Attack on entry).
4. **Numeric modifiers** as first-class values: damage multiplier, critical-hit stage, accuracy, speed-tie priority, flat damage reduction.
5. **A level override** (the ruleset normalises battles to 50: `rules.js:123`) for level-up style buffs.
6. **Per-floor modifiers / gimmick bosses** (a floor with a weather, a boss with a rule).
7. **Mid-battle consumables or revives** (an inventory).
8. **Trainer AI traits** beyond the three CPU levels.

What is **not** a hook: the moves and held items the catalogue's lookup tables name (`FIXED_ITEMS`, `TYPE_ITEMS`, `NAMES` in `tower_buffs.js`) exist in this ROM and are runnable by the engine. I checked them one by one against `engineSupports` on 2026-11-03: every one resolves and runs except the alternate spelling "BlackGlasses", which is only a fallback for "Black Glasses". An item the engine could not run would simply give nothing (`itemFor` returns 0), and the dead-ball filter would stop offering it.

## 15. The tests

`node tools/pokemonarena_tower_test.mjs` (about 20 s) runs 242 cases in groups: **A** the catalogue (counts, tier ranges, anchors, descriptions, caps, and that the tables in this file are the generated ones); **B** the arithmetic; **C** each op on real legal teams; **D** synergies; **E** offers, rarity statistics and stacking; **F** the run machine, the floors and trainers, 34 hostile edits of a stored run and 8 of the Tower record; **G** the achievements (51 positive and 51 negative fixtures); **H** the engine (random pick sequences through the real machine and straight from the stacking rule, up to 30 picks, on real legal teams: the engine's own validation, real battles, exact stats), the regular game's isolation and the import graph, the ROM ball hues, `offerView`; **I** reachability of every synergy and every family; **J** the stored record, **K** the session, **L** the fight controller, **M** the address and the one navigation seam, **N** what reaches a battle; **Q** the release hardening (the record that cannot lock the Tower, the unreadable and the empty run, the identity of a fight and of an offer, every kill point of a fight, the battle page's wiring, the stray address parameters, the saved battle's attempt and the two-tab reload, attempt numbers of 2^31 and more, a quit before the first choice, and the hub page's start guard and history seeding). `--mutants` then breaks the modules 160 ways, one at a time, in a private copy, and every break must fail a case of the group it names (all 160 are killed; `--mutant=id,id` runs just those). `ARENA_VERBOSE=1` prints every case.

Not measured: balance against humans. A bot (the CPU AI playing the player's side, random or best-colour picks) was run only to learn whether the curve is climbable at all:

`node tools/pokemonarena_tower_bots.mjs` (80 runs per row, fixed seeds, the CPU AI at `hard` playing the player's side, real battles, real offers; about a minute). Floors cleared, mean / median / 90th percentile, and runs that won all 30 floors:

| Bot's ball rule | 3v3 mean / median / 90th pct | 3v3 won | 6v6 mean / median / 90th pct | 6v6 won |
| --- | --- | --- | --- | --- |
| skip every offer | 7.8 / 7 / 12 | 0/80 | 9.2 / 9 / 13 | 0/80 |
| random ball | 8.4 / 7 / 15 | 1/80 | 11.7 / 9 / 24 | 6/80 |
| random, never a curse | 8.3 / 8 / 16 | 1/80 | 11.8 / 10 / 24 | 4/80 |
| highest colour, never a curse | 9.3 / 8 / 19 | 3/80 | 12.2 / 9 / 30 | 8/80 |
| favour offence + speed families | 8.8 / 8 / 15 | 0/80 | 12.9 / 10 / 30 | 10/80 |
| favour bulk + recovery families | 8.9 / 8 / 16 | 3/80 | 13.2 / 9 / 30 | 13/80 |

What this does and does not say. A team with no buffs dies around floor 7-9, and some buffed runs reach the top, so the curve is climbable and the buffs matter. But the buffs move a **random-picking bot only about 1 to 4 floors on average**, and the median hardly moves. That is a hint, not a verdict: the bot never builds towards a synergy, and the CPU AI plays worse than a person. It is the number to watch when tuning (all of it is in `tower_config.js` and the buff anchors in `tower_buffs.js`): if humans are found to stall near floor 10, make the buffs stronger or the early trainers' EV share lower; if they sweep, do the reverse.

## 16. Questions for the owner (with a recommended default)

1. **A loss ends the run (no lives by default)?** Recommended: yes; Extra Life is a purple/gold buff. `cfg.lives` changes it.
2. **Leaving a Tower battle mid-fight** (closing the tab): **built as recommended.** The fight BEGINS at the player's first choice (`ctl.onLocalChoice`); from then on leaving it counts as a loss (an Extra Life is spent if held). A reload resumes the same fight (`battle_resume.js` carries a `tag` = `tower:<seed>:<floor>:<livesUsed>:<hash of what is held>` that must match, so a record from another run or another set of buffs is refused); a reload that finds the fight marked and NOTHING to resume it from (the saved choices are gone, or no longer replay) counts it as left, a loss, never a free restart at the preview. Arriving at a begun fight any other way (a typed address, a link) is a loss. Looking at a floor and closing the page before the first choice costs nothing. The pause menu's LEAVE TOWER before the first choice drops a run that has cleared no floor (counted as nothing) and, on a run that has cleared floors, counts as a lost floor (an Extra Life is spent if held); section 11. **The Tower hears the match the moment the engine ends it** (`watchEngine`, on `ctl.onEnd`), not when the result screen comes up, so closing or reloading the page during the end-of-battle text can neither dodge a loss nor turn a won fight into one; a reload or a typed address after that shows "the result is already counted" and writes nothing. What remains: the few milliseconds of the write itself (an IndexedDB transaction already started when the page is killed); a fight that was won at engine level and lost to a kill inside that window counts as left.
3. **30 floors, bosses at 10 / 20 / 30, formats 3v3 and 6v6?** Recommended: keep; every one is a config value.
4. **Achievements are cosmetic only** (a badge and a stamp on the profile), nothing that touches regular play. Recommended: yes.
5. **Scouting Report** needs a trainer-preview line on the floor screen. Recommended: show the trainer's species only, not moves or EVs.
6. **A daily shared seed** (everyone climbs the same Tower) - free to add later because a run is `seed + picks`. Recommended: after the first version is played.

## 17. Phase 2: how it is wired

**The rule that shaped it.** The owner wants one continuous game, so every Tower rule lives in modules that take plain arguments and callbacks and never read `location`, an address or the DOM. A test (`M7`, `pokemonarena_tower_test.mjs`) fails if any Tower module except `tower_launch.js` names an address, `location`, `window` or a page.

**The seam: `js/tower_launch.js`.** `launchFloorBattle(run, { navigate, profileId })` is the ONLY place the hub starts a floor's battle: today it navigates to `battle.html?tower=1&floor=N&run=<seed>...` (`towerBattleHref`); when the hub hosts battles in its own page, replace that one function (mount the fight, call `startTowerFloor` / `createTowerFight` directly). `returnToTower({ navigate, step })` is the way back (`#tower-offer`, `#tower-last` or `#tower`), `returnToHub` leaves for the main menu, `parseTowerParams` reads an address back (strict: `tower` must be `1`, floor 1-30, decimal run and life, a profile-id alphabet; nothing is echoed). The hub calls it from `boot.js` (`towerEffect`); the battle page calls the same functions through `battle_boot.js`'s thin Tower mode.

**The logic, with no page in it.**
- `tower_session.js`: `createTowerSession({ pack, persist })` -> `startRun / beginFloor / markFight / finishFloor / pick / giveUp / read`, each a pure reducer over the stored record run in one store transaction (`store.towerUpdate`, compare-and-set, no history entry). Results are idempotent (a replay is "already applied"), achievements are evaluated after each step and stamped with the caller's clock. `startTowerFloor({ pack, persist, floor, runId, navType })` -> `{ ok, spec, tag, markFight(), finish(result) }`. `towerFloorSpec(pack, run)` is the ONE place buffs reach a battle: it builds a normal spec (`validate: false`) plus a `tower` record; `resolveBattle` and every regular spec are untouched and carry no `tower` field.
- `tower_fight.js`: `createTowerFight({ pack, persist, floor, runId, navType, nav, now })` with `nav = { toTower(step), toHub(), retry(run) }` -> `{ ok, status, spec, tag, attempt, bar(), resultOptions(winner), committed(), onMatchEnd(info), recap(), whenSettled(go), onResult(choice), onQuit() }`. A refusal carries a status (`stale`, `abandoned`) and words.
- `tower_hub.js` / `tower_screen.js`: the hub screens. `hub_model.js` hands every path beginning `tower` to `tower_hub.js`; its effects are `tower-new / tower-fight / tower-pick / tower-giveup` plus screen changes (`back: true` when a screen steps back to another Tower screen). Nothing in the hub navigates to show a Tower screen; only FIGHT uses the battle page.
- Resumable anywhere: the run, its phase (`battle` / `offer` / `over` / `won`), the offer and the fight flag are in `profile.tower`. Reloading on the offer shows the offer; reloading mid-fight resumes the fight; an offer is applied once (a second pick of the same offer is refused as already applied).

**The offer screen's art.** The three (five for a boss) Poke Balls are the ROM's own ball sprites (`anim_mon.js ballGfx`, ROM balls 7, 9, 4 and 13 for green, blue, purple and gold), drawn at 2x, closed when idle and open and lifted when highlighted, with a rarity-coloured outline; the text box, fonts and colours are the ROM's. **Honest note:** the starter-selection scene's own art (the three balls on the table) is not decoded by this project, so the balls are the battle-intro sprites, not a copy of that scene.

**Main menu.** It now has nine rows and shows eight at a time (`MAIN_VISIBLE` in `hub_model.js`), scrolling to keep the cursor visible, with arrows for what is hidden; another row (OPEN BATTLES) can be added with one entry in the row table and needs nothing from the Tower code.

**Page test.** `tools/pokemonarena_tower_page_test.mjs` plays floors 1-3 in real Chrome at 390x844 (touch only) and 1280x800 (keyboard and a synthetic controller): the offer by touch and by pad, a mid-fight reload that resumes, a floor left by a typed address (a loss), a loss that ends the run, hostile addresses (refused, nothing written), NEW RUN from the hub, the career byte-identical after a climb, and a plain Quick Battle in the same browser playing exactly the battle it played before. A third session (integrity; 134 checks in all across the four sessions) proves in the browser: a double START with no profile makes one profile and one run; no challenge dialog is mounted in a Tower fight; the Tower has the result when the engine ends the match (read from the profile while the scene is still playing it out), and a reload there shows "already counted" and writes nothing; B, B from #tower-offer and from #tower-last stay inside the hub (and the browser's Back steps through the same screens); the note after a ball is taken shows; a regular battle still mounts OPEN TO BATTLES. A fourth session (`residual`, two tabs in one browser) proves: START, START, B, NEW RUN, START in one tick makes one profile and one run (and a hub page restored from the back / forward cache frees its start guard, so START works again after START, browser Back, give up: Q50 and the guard's `reset()`; the Chrome session cannot show it because the dev server sends no-store headers that stop the cache, which is why the unit test and the wiring check carry it); LEAVE TOWER with no choice made drops the run (nothing counted, no last run); a second tab that opened the floor before the first choice is told it is a duplicate, and RELOADED it does not take over the first tab's fight (its saved battle is refused, the fight counts as left, the run is over); three reloads at `#tower-last` add nothing to the history, B, B ends on the main menu, and a Back arrival keeps the Forward entry. The start, quit, two-tab and reload-history checks were each shown to fail with their fix taken out (the fixes reverted in the tree for a run); the Back-arrival check did NOT fail in the run with the history fix taken out (a page restored from the back-forward cache is not booted again; I did not check that this is what happened), so what pins that case is the `historySeedPlan` check of the hub test.

**Release hardening (what two independent reviews of the release candidate found, and what was done; each has a test that fails without it, and a named mutant).**

- *The history trap.* The way back from a fight lands the hub on `#tower-offer` or `#tower-last`, where the page's history held ONE entry, so B on the Tower menu stepped `history.back()` onto the battle page. The hub now gives an address-opened screen the history it would have had if it had been walked to (`arrivalTrail` in `tower_hub.js`, applied by `seedHistory` in `boot.js`: the menu's entry, then each screen on the way), so B, B from any Tower screen ends on the main menu inside the hub, and the browser's Back steps through the same screens. A player who has been on any other Tower screen is not thrown back into a pending offer by a data refresh (the home opens it by itself once, for a link). The entries are written ONCE, on a fresh arrival (`historySeedPlan`): a page whose current history entry already carries the hub's marker (`history.state.arenaHub`: a reload, or a back / forward step onto an entry the hub wrote) already stands on the trail, so it adds nothing and keeps the Forward entry; three reloads at `#tower-last` leave `history.length` as it was, and B, B still ends on the main menu (page test, `residual`).
- *The loss dodge, and the unfair loss.* See section 16, question 2: the Tower is told at the engine's end, and an unrestorable marked fight is a loss.
- *Two tabs, replayed results, double taps.* The identity of a fight and of an offer (section 11). START carries a token naming the visit to NEW RUN, and `boot.js` runs each token once (`createOnceGate`), so a double tap makes one run and, with no profile yet, one profile; the start no longer replaces a run another tab made (`replace: false`; the menu already asked to give the old one up). `createStartGuard` adds the page-wide half: ONE start under way on the whole page, so START, B, NEW RUN, START inside one tick (two visits, two tokens) makes one profile and one run, not two of each; a start that did not happen releases the page and its token, one that did keeps the page locked while it leaves for the floor (page test, `residual`).
- *The note.* `You took X!` / `That could not be applied` is set around the step that changes the data, and the data change closes the offer; the note now survives that screen change (`onData` in `tower_hub.js`).
- *OPEN TO BATTLES is not mounted in a Tower fight.* Accepting a challenge leaves the page, which the Tower counts as a loss (and the dialog said nothing of it). The button stays hidden and no board connection is made on the battle page of a Tower floor; a challenge reaches the player in the hub, between floors (ONLINE.md says so).
- *Texts and speech.* Long texts page by words (section 12). The screen reader is told the last run's result, the selected buff or achievement by name, rarity and power, the Tower home as `Tower.` (it used to say `Tower, .`) and the values of the NEW RUN rows (`speakTower`).
- *Addresses.* An address with `p`, `run`, `floor` or `life` and no `tower=1` is a regular address and they are ignored, as the build before the Tower ignored every parameter it did not know; with `tower=1` every hostile value is still refused. `battle_boot.js` and `boot.js` spell out no hub or Tower address: they use `HUB_PAGE_URL`, `TOWER_HUB_URL`, `launchFloorBattle` and `returnToTower` from `tower_launch.js` (test `M7` scans both pages).
- *The second review's residual items* (eight; each has a test that fails without it and a named mutant). A reloaded duplicate tab no longer takes over the first tab's fight (the tab-local resume record carries the attempt). Attempt numbers compare as unsigned 32-bit numbers. LEAVE TOWER before any choice drops a run that cleared nothing. A refused pick's note clears on the next cursor move or when the question opens, and never hides an open question. The buff question pins the offer it was opened on. A reload or a back / forward arrival adds nothing to the history. One START at a time on the whole page. A huge reject no longer pushes the record's own unknown values out of the bag.
- *Not changed, deliberately.* The first load after the deploy writes the pre-migration document into the five-revision undo ring (as the v3 -> v4 migration did) and sets `updatedAt` to the migration time. A 2,000-Pokemon box made a Tower step cost about 350 ms in the review (the result screen waits at most 1.5 s for the write; a slower phone could cross it, as `recordMatch` already can). A browser holding an old `store.js` next to the new `profile.js` for one cache lifetime restores a revision without the Tower record (the opposite mix is safe). The names this round added across modules (`createStartGuard` and `historySeedPlan` in `tower_hub.js`, `fitRejected` in `tower_record.js`) are imported by `boot.js` and `profile.js` like the ones before them: a page that gets the new importer next to a cached older copy of the module it imports fails to link until the cache revalidates (I did not make that mix safe, and did not measure how long a visitor can be in it).

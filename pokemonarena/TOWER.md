# The Pokemon Tower

A solo roguelike climb for Pokemon Arena: thirty floors of CPU trainers, and after every floor you win you choose one of three Poke Balls, each holding a buff that stacks, upgrades and combines with the ones you already have.

**Status: Phase 2, playable.** The Tower is wired end to end: the profile keeps it (schema 5), the hub has a TOWER row with its own screens, a floor is fought on the battle page, and the way back (offer, status, last run, achievements) is in the hub. Section 17 says how it is wired and where the one seam is; sections 1-16 are the design and still describe the rules. The regular game (Quick Battle, team battles, online) never sees a buff and the Tower never writes the career record.

**Since 2026-11-17 a loss no longer ends the climb at once.** The owner: *"need to be able to save progress in the tower too, and retry and have counted # of retries"*; asked whether retries should be capped ("say three per floor, or a fixed number per climb"), the owner answered: *"three"*. It is read as **three retries per floor**: a lost floor is tried again, up to three times (four tries of a floor in all); every retry is counted; the climb is in the profile after every floor, pick and lost try, and the screens say so. Sections 2 (the decision), 9 (the state machine and how a try is identified), 11 (what is stored), 12 (the screens) and 16 (the two questions it supersedes).

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
tools/pokemonarena_tower_test.mjs         304 cases + 261 mutants  node tools/pokemonarena_tower_test.mjs [--mutants] [--only=R,S,O]   (R, S, O: the retries)
tools/pokemonarena_tower_profile_test.mjs  66 cases + 60 mutants   schema 5, migration, import / merge, hostile records, the store transaction, the retries (group R)
tools/pokemonarena_tower_hub_test.mjs      the hub screens: 21 checks + 89 mutants, every view drawn, every text paged   [--mutants]
tools/pokemonarena_tower_page_test.mjs     real Chrome: phone (touch), desktop (keyboard + controller), the browser's Back / Forward in the middle of a retry (`history`), integrity, and two tabs (`residual`)
tools/pokemonarena_tower_doc.mjs  regenerates / checks the tables in this file
tools/pokemonarena_tower_bots.mjs  how far a bot climbs (section 15); RETRIES=0 plays the rule before retries
tools/fixtures/pokemonarena/tower-build-before-retries/   the five Tower modules as they stood before retries: group O of the test loads them as "the old build" (section 11)
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
| **Every floor starts at full health.** HP, PP and status do not carry between floors. | The engine's records carry no HP (`engine.js:108-123`), so attrition would need an engine hook (section 14). The pressure comes from build strength against a trainer that scales, and from a floor's retries running out. |
| **A LOSS NO LONGER ENDS THE CLIMB AT ONCE: EVERY FLOOR HAS THREE RETRIES** (decided 2026-11-17). After a lost floor the run stays on that floor, with everything it holds, and the player may retry it up to `cfg.retriesPerFloor` (3) times on that floor: four tries of a floor in all. The count of retries used on a floor starts again at 0 on every new floor. | The owner's words: *"need to be able to save progress in the tower too, and retry and have counted # of retries"*; asked whether retries should be capped ("say three per floor, or a fixed number per climb"), the answer was *"three"*. It is read as three per floor. **Both caps are config values** (`tower_config.js`): `retriesPerFloor: 3, retriesPerRun: null` (no cap on the whole climb) is the rule in force; the other reading, three for the whole climb, is `retriesPerFloor: null, retriesPerRun: 3`, and every rule, screen text and test follows it (`R11`, `R12`, `S13`-`S16`); `retriesPerFloor: 0` is exactly the rule before, a loss ends the run, and every check that was written for that rule still runs under it with its expectations unchanged (groups F, K, L, Q; `R10`). A cap that is not a whole number from 0 or `null` reads as 0, never as "no limit" (`R14`), and with no cap at all one run still counts at most 300 retries (`R13`). |
| **A run ends** when it is WON (floor 30 cleared), GIVEN UP (NEW RUN over it, DROP THIS RUN), or LOST with no retry left on the floor and no Extra Life to spend. Nothing else ends it. | A lost try, a fight that was left, a closed tab: each leaves the run on its floor (`R1`, `R3`, `S4`-`S10`). The loss that does end it ends it exactly as a loss always did (phase `over`, folded into the record once). |
| **EVERY RETRY IS COUNTED**, once. A run has a count for the whole climb and one for the floor it is on; both go up by one each time a floor is lost with a retry left and no Extra Life to spend. The Tower record keeps the total and, per format, the fewest retries a WON climb needed. | The owner asked for the count. It is exact because every lost try has an identity (section 9): the same lost try can never count twice, and a stale page can never answer a newer try (`R18`, `S1`-`S7`). |
| **Extra Life** (a purple/gold buff) is spent INSTEAD of a retry. `cfg.lives` is 0. | A life is the stronger thing to hold: a loss that spends one costs none of the floor's three retries (`R5`). Its ball says so (*"1 extra life: a lost floor spends it instead of a retry"*), and Second Chance and Phoenix are still about lives, not retries (section 8). |
| **A retry is a real new try** of the same floor: the same trainer and the same two teams, **with the dice re-rolled**. | The battle seed is mixed from the try number, as it already was from the lives spent (`R15`-`R17`: four tries, four seeds, the same trainer; the same two sides playing the same way give a different battle on every try). So a retry is not a replay of the lost battle, and a loss cannot be studied and then replayed move for move. |
| **Leaving a fight before the first choice costs nothing; after it, it is a lost try.** | A lost try costs what a loss costs: an Extra Life, else a retry, else the run. Before the first choice nothing was played, so nothing is written, on any floor (it used to drop a run that had cleared nothing and to count as a lost floor on a later one). LEAVE TOWER and FORFEIT ask their question with that cost in it (section 12). |
| **The browser's Back out of a fight counts nothing by itself.** What counts a fight as left is OPENING THE FLOOR AFRESH while it is marked (the hub's row, a typed address), and the hub says what that costs before it is done. Back lands on the hub, or on the battle page of an earlier try, which says it is not the fight's page and writes nothing; Forward is the fight again, where it was. | Found by the review of 2026-11-17: the page behind a retry in the tab's history was the LOST try's battle page, and it counted the fight under way as left, so one Back cost a retry, or the climb on the last try, with no question asked, while the same Back out of a first try cost nothing. Four things now hold (section 9, "The page behind a retry"): RETRY FLOOR on the result screen takes the lost try's place in the history; a battle page's address always names the try it hosts; a history step onto the page of another try than the one being fought is neither a resume nor a leave; and the tab's saved battle is kept under the fight, not under an address (`S22`-`S25`; in real Chrome, the `history` session of the page test). |
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
| Extra Life | meta | purple - gold | 16 | economy, recovery | 1 extra life: a lost floor spends it instead of a retry  ->  2 extra lives: a lost floor spends one instead of a retry |
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

**Retries and the achievements (2026-11-17).** All 51 were read again against the new rule; six changed, and there are still 51.

- *Not a Scratch, Hat Trick, Spotless, Untouchable, Perfect Climb* (the five "without losing a Pokemon" ones). With three retries a floor they could be fished for: leave a fight that is going badly, try again. They now count a floor only when it was won with no faint **on its first try**: a floor that took a retry, or cost an Extra Life, was lost once with every Pokemon down, so it is not clean however the winning try went, and a lost try breaks a streak. Their words say "on the first try" / "without a retry" (`R26`: each is earned by its clean fixture, not with a retry or a life on the floor it depends on, and still earned when the retry was on another floor).
- *Rock Bottom* said "Lose on floor 1". One loss on floor 1 no longer ends anything, so the words were untrue; the condition (a run that is over with nothing cleared) is the same, and now means the floor's tries ran out there: "Run out of tries on floor 1." (`R27`: not earned by the first lost try, earned by the one that ends the run).
- *Second Chance* and *Phoenix* are unchanged and still need an Extra Life: a retry earns neither (`R5`, `R27`). Every other achievement says what it always said (a retry does not make "clear floor 5" or "win a floor in 4 turns" untrue), so it was left alone; the restraint ones (Bare Hands, Purist, Naked Ascent) are about buffs, not about losing.

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
| green | Not a Scratch | Win a floor on the first try without losing a Pokemon. |
| blue | Hat Trick | Win three floors in a row on the first try without losing a Pokemon. |
| purple | Spotless | Win ten floors in one run on the first try without losing a Pokemon. |
| purple | Untouchable | Beat a boss on the first try without losing a Pokemon. |
| gold | Perfect Climb | Win the run without a retry and without losing a single Pokemon on any floor. |
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
| green | Rock Bottom | Run out of tries on floor 1. |
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
  battleSetup(pack, run)           -> { player.recs, foe.recs, cpu, pick, validate:false, seed, names, ... }   feed to createMatchController (`seed` is the TRY's: see below)
  recordFloorResult(run, result, { tries })
                                   win  -> 'offer' on floor+1 (or 'won' after floor 30)
                                   loss -> THE SAME FLOOR AGAIN (phase stays 'battle'; the team, the buffs and the floor are untouched):
                                             an Extra Life is spent if one is held        the history row is marked  life: true
                                             else a RETRY is counted while one is left    the history row is marked  retry: true
                                           -> 'over' when neither is left                 the history row has no mark
  retryInfo(run)                   -> { used, onFloor, left, cap, scope }   retries of the climb / of this floor / still to use; the cap that counts and what it covers ('floor' | 'run' | 'none')
  takeBuff(run, id | null)         -> 'battle' (a skip is null)
  abandonRun(run)                  -> 'over'
  foldRunInto(tower, run)          -> the Tower record, once (with the run's retries: the total, and the fewest of a WON climb)
```

**How a lost try is recorded.** The history has one row for every try: a won floor is one row, a lost try is one row *on the floor it was fought on*, and that row says what the loss cost: `life: true` (an Extra Life was spent), `retry: true` (a retry was counted), or neither, which is the loss that ended the run and is therefore the last row of a run that is over. **A run stores no retry number.** The climb's count (`retriesOf`) and the floor's (`floorRetriesOf`, 0 again on a new floor because a new floor's rows are new rows) are read from the rows every time, as the lives always were checked against them; so there is no second number beside the rows that could disagree with them (section 11 says what else that buys; "The known limit" below says what it does NOT buy). The caps are the config's to say and the reducer's to enforce: a stored run is never refused for having been made under another cap, so changing `retriesPerFloor` cannot make a climb under way unreadable (`R21`).

**How a try is identified.** `tryNumber(run)` is how many lost tries the climb has behind it that did not end it: the Extra Lives spent plus the retries counted. With the run's seed and floor it names ONE try of ONE floor, and it is in four places:

- the **battle seed**: `mix(seed, floor, 0xb477, try)` (the first try keeps `mix(seed, floor, 0xb477)`, the seed a floor always had), so every try rolls its own dice against the same trainer (`R15`-`R17`);
- the **tag** of the tab's saved battle: `tower:<seed>:<floor>:<try>:<hash of what is held>`, so a reload can only resume the try it was (`K23`, `N5`); the saved battle is kept UNDER that tag (below);
- the **address**: `battle.html?tower=1&floor=N&run=<seed>&try=K`, so every try of a floor has its own address and RETRY FLOOR is a navigation to another page (`S21`; the older `life=K` is still read). The address does not decide which try is FOUGHT (that is always the run's own); it says which page this is (below);
- the **mark and the result**: the page that opens a floor takes the try number from the run, and its first-choice mark and its result both name it (`tries`).

**The page behind a retry (the review of 2026-11-17).** A retry is another page than the try it follows, so the entry BEHIND a retry in the tab's history could be the lost try's battle page. A reload or a history step onto a floor whose fight is marked used to be taken for "the fight's own page comes back": that page took the fight for its own, found nothing saved under its own address (the tab's saved battle was kept under the address of the page that fought) and counted the fight as LEFT. So the browser's Back in the middle of a retry cost a retry at once, and ended the climb on the last try, with no question asked, although Forward would have resumed the fight untouched. Four things now hold, each with a check and a mutant, and together in real Chrome (the `history` session of the page test):

1. *A page says which try it was opened as* (`openedTry`: the battle page hands in the try of its address). A reload or a history step onto a marked fight is that fight's own page, and resumes it, only if the two agree; onto the page of ANOTHER try it is `elsewhere`: nothing is written, the page says it is not the fight under way and that nothing was counted, and Forward is the fight again where it was (`S22`: also on the last try, where it used to end the climb). A FRESH arrival at any address of the floor still means the fight was left, as before: the address is not a way round the cost of leaving.
2. *The address always names the try the page hosts.* A page that opens another try than its address names (a reload at a lost result opens the NEXT try) puts that try into its address at once (`searchForTry` in `tower_launch.js`, the page's `history.replaceState`), so its own reload is known for a page of the fight's try (`S24`).
3. *RETRY FLOOR on the result screen takes the lost try's place in the history* (the page navigates by replacing), so the page before a retry is the hub, as before a first try, and Back from a retry lands there: the hub says what leaving the fight would cost, and counts nothing (`S24`). A result screen can still outlive its moment (the hub's own RETRY FLOOR row leaves the lost try's page in the history, behind the hub, and a browser may bring a page back whole from its back / forward cache, which this was not tested in: the dev server's headers keep that cache out of the test rig): its RETRY FLOOR button opens the next try only while the run still waits for it with no fight begun, and otherwise goes to the Tower (`S23`).
4. *The tab's saved battle belongs to the fight, not to an address.* A Tower floor's saved battle is kept under the fight's tag (`resumeKeyOfTag` in `battle_resume.js`; a regular battle keeps its address, which IS the battle), so every entry of the tab's history that is a page of the fight's try finds it, however its address is spelled: the page that opened the try from the hub and the page that was reloaded into it do not write the same address, and kept under the address the saved battle was found by one of them only (`S25`). One saved under the address by the build before is carried over once (`adoptRecord`), so that a fight under way across the deploy can still be resumed by a reload (the carrying-over is checked in Node, `S25`; a real deploy with a fight under way was not played). What is found is still not believed: its seed, its tag and the attempt of the page that fought it are checked as before.

`recordFloorResult(run, result, { tries })` refuses a result that names another try than the one the run is waiting for, and the session refuses it before that ("that try of the floor is over"). **That is what makes the count exact:** the first loss of a try moves the run on to the next try, so the same result fired twice, a reloaded result screen, a second tab and a late loss (or a late win) of an earlier try all name a try that is over, and change nothing (`R18`, `S1`-`S7`; through the real store, `R9` of the profile test: the replayed loss does not even move the profile's revision). A page that opened a floor and is still open after that try was lost elsewhere can neither mark a fight nor finish one (`S2`).

`recordFloorResult` is idempotent: a result for another floor, in another phase or twice changes nothing (`F10`), so a double fire or a replayed result screen cannot skip a floor. It accepts `match_stats.summarizeMatch`'s summary directly (`F14`). A run's stored form is a plain JSON object with a **strict** parser: unknown fields, forged powers, free buffs, history that lies about being flawless and 31 more hostile edits (34 in all) are refused (`F16`), the held list and the pending offer are *re-derived* from the history and the seed rather than trusted (`F16`, `F20`), and so are the retries: 22 MALFORMED edits of the marks are refused (`R19`: a mark on a won floor, a mark that is not `true`, a loss that cost both or nothing, a retry row re-labelled in place as another floor, which leaves it out of order, a stored count).

**THE KNOWN LIMIT: a self-consistent edit of the rows is not detectable** (found by the review of 2026-11-17, which showed that an earlier version of this paragraph claimed more than the parser does; pinned by `R19b` so that it cannot drift again). The retries are counted from the rows, and a browser holds no secret, so an edit that leaves the rows well formed is, to the parser, a genuine run. On a run with no retry left on its floor: delete that floor's three retry rows and it reads back as a run with three left; delete one, or re-file one IN ORDER under a floor already cleared (before that floor's win), and it has one left; delete every lost row and it never lost. A fourth retry of a floor can therefore be had by editing the stored run by hand. This is the same limit the wins have always had (a hand-written run of won floors parses too, and did before retries), a stored count beside the rows would not close it (it would be edited with them), and the tempting parser rule that would (refuse a retry row of any floor but the current one) refuses every genuine climb that lost a try on an earlier floor (mutant `parse-refuses-retries-of-floors-below`). What the strict form does give: every edit that leaves the rows malformed is refused (`R19`), and a profile file edited after it was exported fails its export checksum (`R3` of the profile test). The checksum is a plain hash, not a secret: the same edit made in the profile and exported again by the game's own code imports like any file (`R3b` of the profile test). There is no leaderboard and no online Tower (section 3), so the record is only ever shown to the player who holds it.

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
  "current": null,                             // the unfinished run (the strict stored form), or null
  "last": null,                                // a summary of the run that ended last; it may carry "retries" (absent = 0)
  "retries": 12,                               // OPTIONAL (absent = 0): retries counted over all finished runs
  "fewestRetries": { "3v3": 2, "6v6": null }   // OPTIONAL: the fewest retries a WON climb needed, per format (null until one is won)
}
```

- **It is not the career.** `stats` (`career_stats.js:19-24`: `byFormat`, `byCpu`, `totals`, `recent`) is untouched; there is no field a Tower result could fold into (`H10`).
- **Strict:** `checkTower` refuses unknown fields, wins above runs, a best above the floor count, unknown buffs, bad stamps and a finished run in `current` (`F19`: 8 hostile edits). `current` is itself checked by `parseRun`, which re-derives its held list and offer.
- **Size is bounded:** `current` is at most six records, one offer and a history the parser caps at 400 rows; `achievements` <= 51 today (the check allows 500); `buffsSeen` <= 124.
- **Built (Phase 2):** `tower` is in `PROFILE_KEYS`; `SCHEMA_VERSION = 5`; `migrate4to5` is pure and idempotent (it keeps a valid `tower`, sets `emptyTower()` otherwise, and parks junk in `_unknown.v4Tower`); `normalizeTower` repairs field by field and keeps the damaged value in `tower._unknown.towerRejected`; the export checksum covers `tower`; import `new` copies it, `replace` replaces it, `merge` keeps the local one; "Keep my edits" and restoring a revision keep the CURRENT tower and the CURRENT `stats`. A profile of a newer schema stays read-only. The record also holds `last` (a summary of the last finished run). `tools/pokemonarena_tower_profile_test.mjs` proves each of these, and that a whole climb through the real store leaves `stats.totals`, `byCpu` and the online record byte-identical.
- **Merge (proposal; I have not read the profile merge code in this phase and Phase 2 must follow whatever it does for `stats`):** `best` = max per format; `achievements` = union keeping the earlier stamp; `buffsSeen` = union keeping the larger count; counters (`runs`, `wins`, `floors`, `bosses`) cannot be summed across two copies of the same profile without double counting, so follow `stats`' rule; `current` = the run that has cleared more floors.
- **THE RETRIES ARE OPTIONAL KEYS: no schema bump, no new record version (decided 2026-11-17).** The precedent is `attempt` (an optional key of the stored run). The reasons:
  1. *A profile schema bump (5 to 6)* would make every page that still holds the old code open the profile READ-ONLY (that is what a newer schema means to an older build: `P9`). The Tower **and the Team Builder** would be locked for as long as that cache lives, which is the very thing the old code must not do, and every stored profile would be rewritten by a migration (its pre-migration copy pushed into the five-revision undo ring) for three numbers.
  2. *A new record version (`tower.v` 1 to 2)* is worse: the old build's repair keeps a record of another version whole in the bag and starts an EMPTY one (`J8`).
  3. *Optional keys, absent = 0, written only once they have something to say*: every stored record is already a valid one (nothing is migrated, and opening old data writes no key: `R2` of the profile test), and a record that never saw a retry is, byte for byte, what the build before wrote (`R10`, `O1`).
- **What is stored, and where.** *In the run:* nothing but the rows of its history (section 9): a lost try that cost a retry is a row marked `retry: true`. *In `last`:* `retries`, the retries the finished run counted (left out when 0). *In the record:* `retries`, the total over every finished run (a run that is dropped, because it cleared nothing, counts for nothing here either: `R9`), and `fewestRetries`, per format the fewest retries a WON climb needed (`null` until one is won; a better win lowers it, a worse one never raises it: `R6`, `R7`). It counts RETRIES only: an Extra Life spent on the way is not a retry (it is spent instead of one), so a climb won on a life with no retry records 0; the lives a run spent are in `last.livesUsed`. **Old data:** a record written before retries existed has none of these and reads as 0 retries; a format it has already won reads as won with 0, because a loss used to end the run, so every such win used none (`fewestRetriesOf`; `R8`).
- **The strict check and the repair treat each retry key as its own field** (`R22`, `R23`; `R7` of the profile test): a total that is negative, fractional, text or past the counter limit, a fewest that is not per format, is above what one run can count, or names a format that was never won, and a `last` with a bad count are refused by `checkTowerShape`; `normalizeTower` empties that one field (a fewest for a format never won loses only that entry), hands the bad value back for the bag, and keeps the rest of the record. **Export, import and restore follow the record's existing rules** because the keys are part of the record: the export checksum covers them (`R3`), import NEW carries the file's, REPLACE takes the file's, MERGE keeps the profile's own (the file's are not added and not taken: `R4`), "Keep my edits" and restoring a revision keep the CURRENT ones (`R5`, `R6`).
- **A BUILD WITHOUT THE KEYS, NEXT TO A RECORD THAT HAS THEM** (a page that still holds the old code for one cache lifetime, or a tab left open across the deploy). This is exactly what it does; group `O` of the test runs the real old modules (`tools/fixtures/pokemonarena/tower-build-before-retries`) against records this build wrote:
  1. *A climb that has not used a retry* is exactly what the old build wrote. It reads it and plays it by its own rule: there, a loss ends the run (`O1`).
  2. *The record's keys.* The old strict check does not know `retries` and `fewestRetries`; its repair, which runs on every load and is written back by `store.loadProfile`, moves both, whole, into the record's bag of unknown values (`tower._unknown`), and sets a `last` that has `retries` aside in `tower._unknown.towerRejected.last` (LAST RUN is not shown there). Every counter, every achievement, the buffs seen and **the climb under way are kept** (`O2`).
  3. *A climb that has a retry in it.* Because a run stores no retry key, the old shallow check still accepts it and it stays in `current`. The old deep parser cannot read the `retry` mark, so the old hub shows "This run cannot be read" with DROP THIS RUN (offered, never forced) and the old battle page refuses to open the floor and writes nothing. **Nothing is locked:** a NEW RUN over it, a win, a ball and a loss are all recorded by the old build (`O3`). If the player does drop the run there, it is dropped (not counted).
  4. *Back in this build nothing is lost.* `normalizeTower` takes a key it knows out of the bag when the record does not have it (`retries`, `fewestRetries`), and a parked `last` back while nothing has taken its place: after a visit of the old build the record is, value for value, the one this build wrote (`O4`, through the real store; `R24`; `R8` of the profile test). Junk in the bag stays there; a key the record has is never overwritten by the bag.
  5. *Why the count is not a key of the run* (`O5`, the control): the old build, shown a run with one unknown top-level key, takes THE WHOLE CLIMB out of `current` and parks it, on every load, written back. A stale tab would have thrown away the climb the player was in the middle of. Marks on rows do not do that. (What the rows do not give is tamper-proofing: section 9, "The known limit". A stored number would not give it either.)
  6. *Known and left.* A climb won on the old build while the keys sat in the bag is not in `fewestRetries` (the old build cannot continue a climb that has retries, and a climb it starts and wins itself has none, so the figure can only be too high, never too low). An old battle page that was already open on a floor's team preview when a retry of that floor was counted elsewhere identifies a try by the lives alone, so it can still play that floor once, by its own rule. Neither is defended against.
- **Folding a finished run** (`foldRunInto`) is idempotent: a run carries a `folded` flag, so a replay or a second tab cannot count it twice (`F15`, `F18`). A run in progress folds into nothing. **A run counts only if it can be read and cleared at least one floor**: DROP THIS RUN and NEW RUN drop one that cannot (a stored run whose rows do not parse would throw inside the fold and lock the Tower) and one that cleared nothing is not a run (starting a run and giving it up from the hub earns no run-count or Rock Bottom achievement); a run that is *played* and lost on floor 1 still counts (`Q9`, `Q11`). **LEAVE TOWER on the battle page, before the first choice, changes NOTHING** (the rule changed 2026-11-17: it used to drop a run that had cleared nothing and to count as a lost floor on a later one). No choice was made, so no fight was played: the page writes nothing and the run waits for the same fight (`L11b`: the record is byte for byte what it was), and a quit result for a fight that was never marked is refused by the reducer too ("no fight was begun": `Q44`, `Q46`; `Q47`: opening the floor and leaving 25 times earns no run, no Rock Bottom, no run-count achievement, and loses nothing). Once the first choice is made, leaving is a lost try: it spends an Extra Life, else costs a retry, else ends the run (`S9`, `S10`; with no retries in the config, `Q45`: it ends the run, and 25 such climbs are 25 runs).
- **A hostile or hand-edited record can never lock the Tower** (`Q1`-`Q7`, `D1`-`D3b`). The strict CHECK accepts up to 400 buff ids, 500 achievements and counters up to 10^9; the REPAIR keeps fewer (`TOWER_LIMITS.buffsKeep` 250, `achievementsKeep` 400, `counterKeep` 10^9 - 10^6, the two formats' wins adding up to no more than that), so a record the repair left full still has room for the next real id or count (124 families and 51 achievements exist). What does not fit is handed back in `tower._unknown.towerRejected`, never thrown away silently. That bag (`tower._unknown`, with `towerRejected` in it) is itself held to 64 KB (`capBag`: the oldest keys go first, a key bigger than the allowance goes too); a real Tower record is under 10 KB. What the repair hands back (`rejected`) is cut down on its own FIRST (`fitRejected`) to the room that bag has left, because `capBag` drops the oldest keys: merged in whole, a huge reject (20,000 junk buff ids) would push the record's own older unknown values (a `futureThing`) out of the bag and then itself. The fields of a reject that do not fit are left out and named in `towerRejected._dropped` (`D2c`, `D2d` of the profile test). The shallow shape check also requires every row of a stored run's `history`, `held` and `team.recs` to be an object. `migrate4to5` files a junk v4 `tower` under the first FREE name (`v4Tower`, `v4Tower_2`, ...: a name the player's own unknown value or a stray top-level key already holds is never overwritten). A stamp from a clock that gives -5, 1.5 or NaN is stored as 0 (`sanitiseStamp`).
- **A fight has an identity.** The page that makes the first choice marks the run `fighting` with its own `attempt` (a whole number from 1; an optional key of the stored run, 0 when no fight is marked, absent in a run written before it existed). Only that page can finish the fight (`reduceFinishFloor`), a second tab on the floor is refused as taken (it is told it is a duplicate), and a result also names the try of the floor it is for (`tries`, the try number when the fight began: the lives spent plus the retries counted, section 9), so a late or replayed loss of an earlier try is refused after an Extra Life was spent or a retry counted (`Q13`-`Q16`, `Q27`-`Q31`, `S1`-`S3`). **Known and left (review of 2026-11-17):** every page gets the try through `startTowerFloor`, whose `markFight()` and `finish()` carry it, but the reducers under it (`reduceMarkFight`, `reduceFinishFloor`, `recordFloorResult`) still take `tries` as OPTIONAL, and a result sent without it is applied to whatever try is current (the same loss could then be applied twice). No caller in the game leaves it out; a host that fights a floor (the hub, when it hosts the fight itself) must go through `startTowerFloor`, not call `finishFloor` on its own. It was not made required because the test scaffolding drives the reducers directly, without it, in dozens of places, one of them in the hub's test library (`tools/pokemonarena_hub_lib.mjs`). And a page also says which try it was OPENED AS (`openedTry`, section 9, "The page behind a retry"): a history step onto the page of another try than the one being fought is neither that fight's page nor a new arrival. The tab-local resume record (`battle_resume.js`, session storage) carries the attempt of the page that wrote it, and a Tower page takes a saved battle over only if the record's attempt is exactly the one it asks for (on a reload that is the run's own): a duplicate tab saves its own choices under ITS number, so when it is reloaded the record does not match the first tab's fight, the saved battle is refused ("another page of this fight") and thrown away, and the fight counts as LEFT (`Q38`-`Q40b`; in real Chrome the `residual` session of the page test, two tabs). Scouting a floor in a second tab opened by address therefore cannot dodge the abandon penalty of the first. **Known and left:** a tab made with the browser's "Duplicate" command copies the first tab's session storage, saved battle and attempt included, so such a copy is not told apart from the tab it came from; a deliberate player could play ahead in one copy and carry on in the other. Telling them apart needs a per-tab identity (a BroadcastChannel owner), which this release does not add. A saved battle with no attempt in it (written by the build before the field existed) is refused the same way, so a Tower tab left open across the deploy that added it counts its fight as left when reloaded. Attempt numbers are whole numbers up to 2^32-1 and are compared as such: about half of all random 32-bit numbers are 2^31 or more, and a page holding one is still the owner of its own mark (`Q43`). A ball is taken by the OFFER it was shown in: the pick carries the floor and the offer's key, and an old screen cannot answer a later offer (`Q17`). On the hub the "Take this buff?" / "Take nothing?" question PINS the run, the floor, the offer's key and the ball when it OPENS and answers those on YES, not what the data says by then; if the offer in the data changes while the question is open (another tab answered it, a newer one is up) the question closes (`pin:` checks of the hub test).

## 12. Hub screens (Phase 2: built, except the codex and the grade filter)

1. **Tower home:** the current run (Continue / Give up), Start a run (pick a saved legal team and a format), the record (best floor per format, runs, wins).
2. **Floor screen:** the floor and the trainer (name, team size, CPU level; the team itself only with Scouting Report), what you hold, a *Fight* button.
3. **Offer screen** (section 10).
4. **Held buffs / synergies list:** every family you hold with its colour and effect, the active synergies, and the ones within reach.
5. **Run result:** floors cleared, what you built, the achievements this run earned, *New run*.
6. **Achievements:** the 51, locked / earned with the stamp, filter by grade.
7. **Buff codex:** the 124 families, seen or not (from `buffsSeen`), with the effect at each colour.

Built: 1 (Tower home, with FIGHT or RETRY FLOOR n / CHOOSE A BUFF / NEW RUN / DROP THIS RUN / TRAINER), 2 (folded into the home screen: the message says who is next), 3 (the offer, section 10), 4 (MY BUFFS with a SYNERGIES tab), 5 (LAST RUN), 6 (ACHIEVEMENTS, all 51, earned ones marked; no grade filter yet). The message box of MY BUFFS and ACHIEVEMENTS word-wraps the selected text to the ROM window by the real font, two lines a page: A (or a tap on the box) turns the page, a down arrow shows that the text goes on, and no word is ever cut or lost (every buff text at every power, every synergy and achievement text is proved to read back exactly: 1,900+ texts, `R.` checks in the hub test). **Deferred:** 7 (the codex of all 124 families) and the achievement filter.

**The climb is saved, and the game says so (2026-11-17).** The run was always written to the profile after every floor and pick; a lost try is written the same way, and the screens now show where the climb stands:

- *The Tower home.* The status window names the floor, the format and the best floor, the buffs (and the lives, when there are or were any), then **`RETRIES LEFT 2/3`** (left on this floor, of the cap) and **`RETRIES USED 5`** (on the climb). When the last try of the current floor was lost, the first row reads **`RETRY FLOOR n`** instead of `FIGHT: FLOOR n` (the same row, the same effect) and its message says the climb is saved, how many retries this floor has left and how many the climb has used: *"The climb is saved on floor 7." / "2 of 3 retries left here, 4 used."* (on the last try: *"Last try: no retry left, 3 used."*). Coming back another day shows the same, because it is drawn from the profile. A fight that was begun and left says what opening it again costs (*"That costs 1 of the 2 retries left."* / *"No retry is left: the climb ends."*). With no run, the window shows the record and, once there are some, `RETRIES n` (every finished climb); the NEW RUN row of a Tower that has been won names the fewest retries of a won climb in each format (*"Fewest retries to win:" / "3v3 2, 6v6 not won yet."*). LAST RUN shows the retries of the finished run. The screen reader is told the floor, the retries left and used, and the last run's retries (`speakTower`), each once (on the RETRY FLOOR row the message already carries the retry sentence, so the status does not say it a second time: it used to). The words are made in one place (`retryLines`, `retryWords` in `tower_hub.js`) and follow the config: a cap for the whole climb, no cap, no retries at all. Every line is measured against its window with the ROM's fonts, extremes included (hub test, `R.` checks); `RETRIES USED 999` is exactly the window's width, so a count past three digits, which no stored run can hold, is shown as `RETRIES 999+`.
- *The battle page.* The Tower bar shows the retries left: `TOWER  FLOOR 7/30  Hiker Marco  BUFFS 4  RETRIES 2/3`. After a loss with a retry (or an Extra Life) in hand the result screen offers **RETRY FLOOR** first, then **BACK TO TOWER**, then BACK TO HUB, and the record page says *THE CLIMB IS SAVED. TRY THE FLOOR AGAIN.* and what is left; after the loss that ends the run it shows what a lost run always showed (TO THE TOWER, BACK TO HUB; *THE CLIMB ENDS ON FLOOR n.*) under the heading *TOWER FLOOR n: NO RETRY LEFT* (`S8`, `S13`-`S15`). RETRY FLOOR opens the next try IN PLACE of the lost one (the browser's Back from a retry is the hub, never the battle that was lost), and only while the run still waits for that try (`S23`, `S24`).
- *The browser's Back and Forward in a fight.* Back counts nothing: it lands on the hub's Tower screen, whose first row says *"You left a fight unfinished."* and what opening the floor again would cost (*"That costs 1 of the 2 retries left."* / *"No retry is left: the climb ends."*), and Forward from there is the fight again, resumed where it was. If the page it lands on is the battle page of ANOTHER try of the floor (the lost try's page is still in the tab's history when the retry was opened from the hub), that page shows *"Another try of this floor"*: it says the fight under way is open on another page, that going forward carries on with it, and that nothing was counted (`S22`; the `history` session of the page test). If it is another page of the SAME try (the history can hold two), the fight is resumed there, at the state it was left in (`S25`).
- *LEAVE TOWER and FORFEIT ask what leaving costs NOW* (`tower_fight.js leaveAsk`; the scene asks the page for its question through one optional `leaveAsk` option, and a battle that passes none asks exactly what it always asked: `S18`, `S19`). Before the first choice LEAVE TOWER costs nothing (*"Leave? Costs nothing."*); FORFEIT is itself a choice, so it costs a retry. After the first choice both say *"...? It costs 1 of the 2 retries left on this floor."*, or that it spends the Extra Life while one is held, or, when no retry is left, *"No retry is left on this floor: the climb ends here."* (`S16`; each fits the message box's two lines and the team preview's title row: `S17`).
- *When the browser is not keeping profiles* (storage blocked or private mode) the Tower still says the climb cannot be saved, as before: the hub refuses to start or fight a run with *"This browser is not keeping profiles, so a Tower run cannot be saved."* and the battle page refuses the floor. The summary the hub draws from now also carries `saved: false` there (`hub_data.js` passes `store.status.notSaved`), so the RETRY FLOOR message can never say "saved" in such a browser: it says *"This climb is NOT being saved: this browser keeps no profiles."* (`R10` of the profile test).

The battle page needs a *tower mode* (built: `battle.html?tower=1&floor=N&run=<seed>[&try=K][&p=<profile id>]`): build the match from `battleSetup(pack, run)` (not from two saved teams), pass `validate: false`, run the CPU with `setup.cpu`, and on the end hand `summarizeMatch`'s summary to `recordFloorResult`, **persist the run before showing the result screen**, and never call the career's `foldMatch`.

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

`node tools/pokemonarena_tower_test.mjs` (about 20 s) runs 304 cases in groups: **A** the catalogue (counts, tier ranges, anchors, descriptions, caps, and that the tables in this file are the generated ones); **B** the arithmetic; **C** each op on real legal teams; **D** synergies; **E** offers, rarity statistics and stacking; **F** the run machine, the floors and trainers, 34 hostile edits of a stored run and 8 of the Tower record; **G** the achievements (51 positive and 51 negative fixtures); **H** the engine (random pick sequences through the real machine and straight from the stacking rule, up to 30 picks, on real legal teams: the engine's own validation, real battles, exact stats), the regular game's isolation and the import graph, the ROM ball hues, `offerView`; **I** reachability of every synergy and every family; **J** the stored record, **K** the session, **L** the fight controller, **M** the address and the one navigation seam, **N** what reaches a battle; **Q** the release hardening (the record that cannot lock the Tower, the unreadable and the empty run, the identity of a fight and of an offer, every kill point of a fight, the battle page's wiring, the stray address parameters, the saved battle's attempt and the two-tab reload, attempt numbers of 2^31 and more, a quit before the first choice, and the hub page's start guard and history seeding); **R** the retries: the reducer (a loss keeps the run on its floor, the fourth lost try ends it, the floor's count starts again, an Extra Life is spent instead), the two caps and their other settings, the identity of a try, the strict parser and its known limit (`R19b`), the record (total, fewest, old data, repair, what comes back out of the bag), the summary, the achievements a retry must not cheapen, and a bot that retries (the same seeds under both rules: every climb reaches at least as far, and further in all); **S** the session, the fight and the page under the rule in force (a lost try counted once through the page's own functions, a stale page, two tabs, every kill point, leaving mid-fight, what the bar, the buttons, the record page and the LEAVE / FORFEIT questions say, the questions in a real scene, the address, and the page behind a retry: a history step onto the page of another try, a result screen that outlived its moment, the address a page gives itself, the saved battle kept under the fight and not the address: `S22`-`S25`); **O** the build before retries next to a record that has them (section 11). The checks written for "a loss ends the run" (in F, K, L and Q) run under `retriesPerFloor: 0` with their expectations unchanged. `--mutants` then breaks the modules 261 ways, one at a time, in a private copy, and every break must fail a case of the group it names (all 261 are killed; `--mutant=id,id` runs just those). `ARENA_VERBOSE=1` prints every case; `ARENA_FAST=1` runs the lighter loops every mutant gets, on the real tree (they must pass there too, or a kill would mean nothing).

Not measured: balance against humans. A bot (the CPU AI playing the player's side, random or best-colour picks) was run only to learn whether the curve is climbable at all:

`node tools/pokemonarena_tower_bots.mjs` (80 runs per row, fixed seeds, the CPU AI at `hard` playing the player's side, real battles, real offers; about three minutes). A bot that loses a floor retries it while a retry is left, as a player would. Floors cleared, mean / median / 90th percentile, runs that won all 30 floors, and the retries a run used on average, measured 2026-11-17 with three retries a floor:

| Bot's ball rule | 3v3 mean / median / 90th pct | 3v3 won | 3v3 retries | 6v6 mean / median / 90th pct | 6v6 won | 6v6 retries |
| --- | --- | --- | --- | --- | --- | --- |
| skip every offer | 9.9 / 9 / 17 | 0/80 | 4.2 | 12.5 / 11 / 19 | 2/80 | 4.5 |
| random ball | 12.0 / 9 / 26 | 5/80 | 3.9 | 15.4 / 13 / 30 | 16/80 | 3.9 |
| random, never a curse | 12.7 / 11 / 25 | 5/80 | 4.2 | 16.1 / 13 / 30 | 13/80 | 4.0 |
| highest colour, never a curse | 12.4 / 10 / 26 | 7/80 | 4.1 | 16.8 / 14 / 30 | 18/80 | 3.9 |
| favour offence + speed families | 12.2 / 10 / 25 | 4/80 | 4.2 | 17.9 / 15 / 30 | 24/80 | 3.8 |
| favour bulk + recovery families | 12.5 / 10 / 30 | 11/80 | 3.6 | 17.3 / 14 / 30 | 22/80 | 3.3 |

The same bots under the rule before retries (`RETRIES=0`; the same numbers the tool gave at the commit before this change, row for row):

| Bot's ball rule | 3v3 mean / median / 90th pct | 3v3 won | 6v6 mean / median / 90th pct | 6v6 won |
| --- | --- | --- | --- | --- |
| skip every offer | 7.8 / 7 / 12 | 0/80 | 9.2 / 9 / 13 | 0/80 |
| random ball | 8.5 / 7 / 17 | 1/80 | 11.7 / 9 / 24 | 6/80 |
| random, never a curse | 8.4 / 8 / 16 | 1/80 | 12.1 / 10 / 24 | 5/80 |
| highest colour, never a curse | 9.3 / 8 / 19 | 3/80 | 12.4 / 9 / 30 | 8/80 |
| favour offence + speed families | 8.8 / 8 / 15 | 0/80 | 12.9 / 10 / 30 | 10/80 |
| favour bulk + recovery families | 8.9 / 8 / 16 | 3/80 | 13.3 / 9 / 30 | 13/80 |

What this does and does not say. Under the old rule a team with no buffs died around floor 7-9; with three retries a floor the same bot gets about 2 to 5 floors further on average and wins 127 of the 960 climbs in the table instead of 50, using about 4 retries a climb. Some buffed runs reach the top, so the curve is climbable and the buffs matter. But the buffs move a **random-picking bot only about 2 to 3 floors on average** (the best rule about 5), and the median moves less. That is a hint, not a verdict: the bot never builds towards a synergy, and the CPU AI plays worse than a person. It is the number to watch when tuning (all of it is in `tower_config.js` and the buff anchors in `tower_buffs.js`): if humans are found to stall near floor 10, make the buffs stronger or the early trainers' EV share lower; if they sweep, do the reverse.

## 16. Questions for the owner (with a recommended default)

1. ~~**A loss ends the run (no lives by default)?** Recommended: yes; Extra Life is a purple/gold buff. `cfg.lives` changes it.~~ **SUPERSEDED 2026-11-17.** The owner: *"need to be able to save progress in the tower too, and retry and have counted # of retries"*, and, asked for a cap, *"three"*. A loss costs a retry while the floor has one left (three a floor), and ends the run only when none is left; every retry is counted. Extra Life is still a purple/gold buff and is spent before a retry. `cfg.retriesPerFloor`, `cfg.retriesPerRun` and `cfg.lives` change it (section 2).
2. **Leaving a Tower battle mid-fight** (closing the tab): **built as recommended; WHAT A LEFT FIGHT COSTS WAS SUPERSEDED 2026-11-17** by the same words of the owner. Wherever the text below says "counts as a loss", read "is a lost try": it spends an Extra Life if one is held, else costs one retry of the floor, and ends the run only when none is left. And the pause menu's LEAVE TOWER before the first choice now costs nothing on any floor (below it is described as dropping a run that had cleared no floor and as a lost floor on a later one: that is how it was). And where it says that a reload or a typed address after the engine's end shows "the result is already counted": that is what a WON floor or an ended run shows; after a lost try that did not end the run it opens the next try of the floor (and writes nothing either way). What a left fight is, and that it can be neither dodged nor suffered unfairly, is unchanged. (The review of 2026-11-17 found one way it WAS suffered unfairly once retries existed: the browser's Back in the middle of a retry landed on the lost try's battle page, which counted the fight as left. Section 9, "The page behind a retry", says what was done: Back now counts nothing, there as everywhere.) The fight BEGINS at the player's first choice (`ctl.onLocalChoice`); from then on leaving it counts as a loss (an Extra Life is spent if held). A reload resumes the same fight (`battle_resume.js` carries a `tag` = `tower:<seed>:<floor>:<livesUsed>:<hash of what is held>` that must match, so a record from another run or another set of buffs is refused); a reload that finds the fight marked and NOTHING to resume it from (the saved choices are gone, or no longer replay) counts it as left, a loss, never a free restart at the preview. Arriving at a begun fight any other way (a typed address, a link) is a loss. Looking at a floor and closing the page before the first choice costs nothing. The pause menu's LEAVE TOWER before the first choice drops a run that has cleared no floor (counted as nothing) and, on a run that has cleared floors, counts as a lost floor (an Extra Life is spent if held); section 11. **The Tower hears the match the moment the engine ends it** (`watchEngine`, on `ctl.onEnd`), not when the result screen comes up, so closing or reloading the page during the end-of-battle text can neither dodge a loss nor turn a won fight into one; a reload or a typed address after that shows "the result is already counted" and writes nothing. What remains: the few milliseconds of the write itself (an IndexedDB transaction already started when the page is killed); a fight that was won at engine level and lost to a kill inside that window counts as left.
3. **30 floors, bosses at 10 / 20 / 30, formats 3v3 and 6v6?** Recommended: keep; every one is a config value.
4. **Achievements are cosmetic only** (a badge and a stamp on the profile), nothing that touches regular play. Recommended: yes.
5. **Scouting Report** needs a trainer-preview line on the floor screen. Recommended: show the trainer's species only, not moves or EVs.
6. **A daily shared seed** (everyone climbs the same Tower) - free to add later because a run is `seed + picks`. Recommended: after the first version is played.

## 17. Phase 2: how it is wired

**The rule that shaped it.** The owner wants one continuous game, so every Tower rule lives in modules that take plain arguments and callbacks and never read `location`, an address or the DOM. A test (`M7`, `pokemonarena_tower_test.mjs`) fails if any Tower module except `tower_launch.js` names an address, `location`, `window` or a page.

**The seam: `js/tower_launch.js`.** `launchFloorBattle(run, { navigate, profileId })` is the ONLY place the hub starts a floor's battle: today it navigates to `battle.html?tower=1&floor=N&run=<seed>...` (`towerBattleHref`); when the hub hosts battles in its own page, replace that one function (mount the fight, call `startTowerFloor` / `createTowerFight` directly). `returnToTower({ navigate, step })` is the way back (`#tower-offer`, `#tower-last` or `#tower`), `returnToHub` leaves for the main menu, `parseTowerParams` reads an address back (strict: `tower` must be `1`, floor 1-30, decimal run, try and life, a profile-id alphabet; nothing is echoed; `try` is the try number of section 9, and the older `life` is still read when there is no `try`). The hub calls it from `boot.js` (`towerEffect`); the battle page calls the same functions through `battle_boot.js`'s thin Tower mode.

**The logic, with no page in it.**
- `tower_session.js`: `createTowerSession({ pack, persist })` -> `startRun / beginFloor / markFight / finishFloor / pick / giveUp / read`, each a pure reducer over the stored record run in one store transaction (`store.towerUpdate`, compare-and-set, no history entry). Results are idempotent (a replay is "already applied"), achievements are evaluated after each step and stamped with the caller's clock. `startTowerFloor({ pack, persist, floor, runId, navType })` -> `{ ok, spec, tag, markFight(), finish(result) }`. `towerFloorSpec(pack, run)` is the ONE place buffs reach a battle: it builds a normal spec (`validate: false`) plus a `tower` record; `resolveBattle` and every regular spec are untouched and carry no `tower` field.
- `tower_fight.js`: `createTowerFight({ pack, persist, floor, runId, navType, nav, now })` with `nav = { toTower(step), toHub(), retry(run) }` -> `{ ok, status, spec, tag, attempt, bar(), resultOptions(winner), leaveCost(kind), leaveAsk(kind, where), committed(), onMatchEnd(info), recap(), whenSettled(go), onResult(choice), onQuit() }`. A refusal carries a status (`stale`, `abandoned`) and words (a fight that was left says what it cost and what is left).
- `tower_hub.js` / `tower_screen.js`: the hub screens. `hub_model.js` hands every path beginning `tower` to `tower_hub.js`; its effects are `tower-new / tower-fight / tower-pick / tower-giveup` plus screen changes (`back: true` when a screen steps back to another Tower screen). Nothing in the hub navigates to show a Tower screen; only FIGHT uses the battle page.
- Resumable anywhere: the run, its phase (`battle` / `offer` / `over` / `won`), the offer and the fight flag are in `profile.tower`. Reloading on the offer shows the offer; reloading mid-fight resumes the fight; an offer is applied once (a second pick of the same offer is refused as already applied).

**The offer screen's art.** The three (five for a boss) Poke Balls are the ROM's own ball sprites (`anim_mon.js ballGfx`, ROM balls 7, 9, 4 and 13 for green, blue, purple and gold), drawn at 2x, closed when idle and open and lifted when highlighted, with a rarity-coloured outline; the text box, fonts and colours are the ROM's. **Honest note:** the starter-selection scene's own art (the three balls on the table) is not decoded by this project, so the balls are the battle-intro sprites, not a copy of that scene.

**Main menu.** It now has nine rows and shows eight at a time (`MAIN_VISIBLE` in `hub_model.js`), scrolling to keep the cursor visible, with arrows for what is hidden; another row (OPEN BATTLES) can be added with one entry in the row table and needs nothing from the Tower code.

**Page test.** `tools/pokemonarena_tower_page_test.mjs` plays floors 1-3 in real Chrome at 390x844 (touch only) and 1280x800 (keyboard and a synthetic controller): the offer by touch and by pad, a mid-fight reload that resumes, a floor left by a typed address (a lost try: one retry, and the run goes on), **the retries on floor 3** (a loss; RETRY FLOOR first on the result screen; the retry counted once; a reload at the result that does not count it again and opens the next try; LEAVE TOWER before a choice that costs nothing; the hub showing RETRY FLOOR 3, RETRIES LEFT 2/3 and "The climb is saved"; a fight left mid-way that costs one retry while the run goes on; the loss after the third retry that ends the run; what LEAVE TOWER and FORFEIT ask at each point; LAST RUN with its 3 retries), **the browser's Back and Forward in the middle of a retry** (the `history` session: a retry opened from the hub, where Back past the hub lands on the lost try's battle page, which says "Another try of this floor" and counts nothing; a retry opened by RETRY FLOOR on the result screen, which takes the lost try's place in the history so that Back is the hub; and the last try with two pages of it in the history, each of which put the try into its own address, spelled differently: Back onto the other one resumes the fight there. At each one nothing is counted, the climb does not end, and Forward resumes the fight at the same battle state. The session was run against the build before the fix, where its first Back counted a retry, and against the fix with the saved battle still kept under the address, where Back onto the other page of the last try ended the climb), hostile addresses (refused, nothing written), NEW RUN from the hub (which gives the run under way up, counted with its retry), the career byte-identical after a climb, and a plain Quick Battle in the same browser playing exactly the battle it played before. A session of its own (`history`, 24 checks) is the browser's Back and Forward in the middle of a retry, described above. Another session (integrity; 186 checks in all across the five sessions) proves in the browser: a double START with no profile makes one profile and one run; no challenge dialog is mounted in a Tower fight; the Tower has the result when the engine ends the match (read from the profile while the scene is still playing it out), and a reload there writes nothing (a won floor shows "already counted", a lost one opens its next try); four fights of a floor begun and left in a row end the run and land on the last-run screen; B, B from #tower-offer and from #tower-last stay inside the hub (and the browser's Back steps through the same screens); the note after a ball is taken shows; a regular battle still mounts OPEN TO BATTLES. The last session (`residual`, two tabs in one browser) proves: START, START, B, NEW RUN, START in one tick makes one profile and one run (and a hub page restored from the back / forward cache frees its start guard, so START works again after START, browser Back, give up: Q50 and the guard's `reset()`; the Chrome session cannot show it because the dev server sends no-store headers that stop the cache, which is why the unit test and the wiring check carry it); LEAVE TOWER with no choice made costs nothing (the record is exactly what it was, and the hub still offers FIGHT: FLOOR 1); a second tab that opened the floor before the first choice is told it is a duplicate, and RELOADED it does not take over the first tab's fight (its saved battle is refused, the fight counts as left: one retry, and the run goes on); three reloads at `#tower-last` add nothing to the history, B, B ends on the main menu, and a Back arrival keeps the Forward entry. The start, quit, two-tab and reload-history checks were each shown to fail with their fix taken out (the fixes reverted in the tree for a run); the Back-arrival check did NOT fail in the run with the history fix taken out (a page restored from the back-forward cache is not booted again; I did not check that this is what happened), so what pins that case is the `historySeedPlan` check of the hub test.

**Release hardening (what two independent reviews of the release candidate found, and what was done; each has a test that fails without it, and a named mutant).**

- *The history trap.* The way back from a fight lands the hub on `#tower-offer` or `#tower-last`, where the page's history held ONE entry, so B on the Tower menu stepped `history.back()` onto the battle page. The hub now gives an address-opened screen the history it would have had if it had been walked to (`arrivalTrail` in `tower_hub.js`, applied by `seedHistory` in `boot.js`: the menu's entry, then each screen on the way), so B, B from any Tower screen ends on the main menu inside the hub, and the browser's Back steps through the same screens. A player who has been on any other Tower screen is not thrown back into a pending offer by a data refresh (the home opens it by itself once, for a link). The entries are written ONCE, on a fresh arrival (`historySeedPlan`): a page whose current history entry already carries the hub's marker (`history.state.arenaHub`: a reload, or a back / forward step onto an entry the hub wrote) already stands on the trail, so it adds nothing and keeps the Forward entry; three reloads at `#tower-last` leave `history.length` as it was, and B, B still ends on the main menu (page test, `residual`).
- *The loss dodge, and the unfair loss.* See section 16, question 2: the Tower is told at the engine's end, and an unrestorable marked fight is a lost try.
- *The retries (2026-11-17).* Everything the hardening above defends is defended for a lost try that does NOT end the run, which is the new case: the run stays in `battle` on the same floor, so the floor and the phase no longer tell two tries apart, and the try number does (section 9). The count is exact under a result fired twice, a reload at the result screen, a second tab and a late result of an earlier try (`R18`, `S1`-`S7`); a left fight and an unrestorable marked fight cost one retry, once (`S3`, `S4`, `S9`-`S11`); leaving before the first choice writes nothing (`L11b`, `Q44`-`Q47`).
- *The review of the retries (2026-11-17): two findings.* (1) **The browser's Back in the middle of a retry cost a retry at once, and ended the climb on the last try**, because the page behind a retry in the tab's history was the lost try's battle page and it counted the fight as left. Fixed at the root (section 9, "The page behind a retry"): a page says which try it was opened as and a history step onto another try's page writes nothing (`S22`; mutants `begin-resumes-on-any-page`, `begin-typed-old-address-is-free`, `begin-own-page-is-elsewhere`); the address always names the try the page hosts, and RETRY FLOOR takes the lost try's place in the history (`S24`; mutants `page-keeps-a-stale-address`, `page-retry-adds-a-history-entry`); a result screen that outlived its moment cannot open a try that is being fought elsewhere (`S23`; mutant `fight-stale-retry-button-leaves-the-fight`); the tab's saved battle is kept under the fight's tag, so that two pages of one try whose addresses are spelled differently both find it (`S25`; mutant `page-keeps-the-saved-battle-under-its-address`); in real Chrome, the `history` session of the page test, which fails on the build before the fix. (2) **This document and the test `R19` claimed that a hand edit which frees a retry is refused; a self-consistent one is accepted.** No code can close that in a browser; the claim was corrected and the limit is stated and pinned (section 9, "The known limit"; `R19b`, `R3b` of the profile test; mutant `parse-refuses-retries-of-floors-below`). Smaller things from the same review: the screen reader said the retry sentence twice on the RETRY FLOOR row (once now); a count of retries past three digits, which no stored run can hold, would have been drawn past the status window (shown as `RETRIES 999+`); the fewest-retries figure does not count Extra Lives (said in section 11); `tries` is still optional under `startTowerFloor` (known and left: section 11).
- *Two tabs, replayed results, double taps.* The identity of a fight and of an offer (section 11). START carries a token naming the visit to NEW RUN, and `boot.js` runs each token once (`createOnceGate`), so a double tap makes one run and, with no profile yet, one profile; the start no longer replaces a run another tab made (`replace: false`; the menu already asked to give the old one up). `createStartGuard` adds the page-wide half: ONE start under way on the whole page, so START, B, NEW RUN, START inside one tick (two visits, two tokens) makes one profile and one run, not two of each; a start that did not happen releases the page and its token, one that did keeps the page locked while it leaves for the floor (page test, `residual`).
- *The note.* `You took X!` / `That could not be applied` is set around the step that changes the data, and the data change closes the offer; the note now survives that screen change (`onData` in `tower_hub.js`).
- *OPEN TO BATTLES is not mounted in a Tower fight.* Accepting a challenge leaves the page, which the Tower counts as a loss (and the dialog said nothing of it). The button stays hidden and no board connection is made on the battle page of a Tower floor; a challenge reaches the player in the hub, between floors (ONLINE.md says so).
- *Texts and speech.* Long texts page by words (section 12). The screen reader is told the last run's result, the selected buff or achievement by name, rarity and power, the Tower home as `Tower.` (it used to say `Tower, .`) and the values of the NEW RUN rows (`speakTower`).
- *Addresses.* An address with `p`, `run`, `floor`, `try` or `life` and no `tower=1` is a regular address and they are ignored, as the build before the Tower ignored every parameter it did not know; with `tower=1` every hostile value is still refused. `battle_boot.js` and `boot.js` spell out no hub or Tower address: they use `HUB_PAGE_URL`, `TOWER_HUB_URL`, `launchFloorBattle` and `returnToTower` from `tower_launch.js` (test `M7` scans both pages).
- *The second review's residual items* (eight; each has a test that fails without it and a named mutant). A reloaded duplicate tab no longer takes over the first tab's fight (the tab-local resume record carries the attempt). Attempt numbers compare as unsigned 32-bit numbers. LEAVE TOWER before any choice dropped a run that cleared nothing (since 2026-11-17 it changes nothing at all: section 11). A refused pick's note clears on the next cursor move or when the question opens, and never hides an open question. The buff question pins the offer it was opened on. A reload or a back / forward arrival adds nothing to the history. One START at a time on the whole page. A huge reject no longer pushes the record's own unknown values out of the bag.
- *Not changed, deliberately.* The first load after the deploy writes the pre-migration document into the five-revision undo ring (as the v3 -> v4 migration did) and sets `updatedAt` to the migration time. A 2,000-Pokemon box made a Tower step cost about 350 ms in the review (the result screen waits at most 1.5 s for the write; a slower phone could cross it, as `recordMatch` already can). A browser holding an old `store.js` next to the new `profile.js` for one cache lifetime restores a revision without the Tower record (the opposite mix is safe). The names this round added across modules (`createStartGuard` and `historySeedPlan` in `tower_hub.js`, `fitRejected` in `tower_record.js`) are imported by `boot.js` and `profile.js` like the ones before them: a page that gets the new importer next to a cached older copy of the module it imports fails to link until the cache revalidates (I did not make that mix safe, and did not measure how long a visitor can be in it).

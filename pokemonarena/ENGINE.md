# Pokemon Arena battle engine (stage E1)

A first-party, deterministic, pure ES-module **singles** battle engine that runs on the SoulGold data pack
(`pokemonarena/js/tables.js` `loadPack`). A battle scene, a CPU opponent and a later netplay lockstep all drive the same
API. Nothing here is ROM content: the engine reads the pack it is given; the source holds hand-written code, small numeric
constants and lookup keys only. Doubles are **out of scope**.

Files (all in `pokemonarena/js/`): `engine.js` (battle object, turn flow, API), `engine_exec.js` (move execution, damage, status),
`engine_moves.js` (one handler per move-effect class), `engine_abilities.js`, `engine_items.js`, `engine_data.js` (constants,
MECHANICS table, effect classification, `EngineError`), `engine_calc.js` (integer arithmetic), `engine_support.js` (what the engine can run),
`engine_validate.js` (pack / team record / snapshot validation, pack fingerprint), `engine_digest.js` (seeded battle set used by the
golden / parity tests). `rules.js` gained the **engine layer** (below).
Tests: `node tools/pokemonarena_engine_test.mjs`. Data files: `engine_coverage.json` (ids and counts only), `engine.golden.json` (hashes only).

**Errors.** Bad input never surfaces as a `TypeError`: every refusal is an `EngineError` with a stable `error.code` and a structured `error.detail`.
Codes: `bad-argument` (missing/garbled options, bad side or move id for a preview), `pack-invalid`, `team-invalid` (a record the engine cannot build;
`team-illegal` is a record `rules.js` rejects, `detail` = its reasons), `snapshot-invalid` / `snapshot-version` / `snapshot-rom`,
`replay-rejected`, `step-rejected`. (`pick` outside 1..4 and an unknown ruleset id stay `RangeError`.)

## 1. API

```js
import { createBattle, restoreBattle, replay, stepBattle, encodeChoice, decodeChoice, hash64, EVENT_CODES, MECHANICS } from './engine.js';
const battle = createBattle({ pack, ruleset: 'arena-gen3-standard', teams: [teamA, teamB], seed: 12345, pick: 3, names: ['Red', 'Blue'] });
```

* **team** = array of 1-6 records the rules layer already uses (`{species, level, nature, abilitySlot, item, moves:[ids], ivs, evs | points}`), or
  a profile.js mon (`heldItem`, `moves:[{id, ppUps}]`, `ev`, `iv`, `nickname`). Battle stats come from `rules.battleStats` (the ROM stat routine, level 50 normalised under the
  default ruleset). `validate` (default true) runs `rules.validateTeam` and throws `EngineError` (with `detail` = the reasons) for an illegal team.
* **pick** (optional, 1..4): Stadium-style team preview. Both sides choose `{kind:'preview', order:[teamIndexes]}` of exactly `pick` distinct members; the first is the lead.
* **lead** (optional, `true`): the 6v6 LEAD preview. Each side chooses ONE member, `{kind:'preview', order:[teamIndex]}`; that member is sent out first and **the whole team fights**, the rest following in team order (the `preview` event carries the full order, so `slot` is the position afterwards and `orig` still names the team index). The request is `{phase:'preview', pick:1, lead:true, team, canForfeit}`; state carries `lead:1` and `pick:1` (and only a lead battle carries the key, so every other battle's state, event and hash are what they were). A side whose team has **one** member has nothing to choose: its request is `wait` (`need` false, an automatic choice, like a side locked into a charge) and the other side's choice starts the battle; two teams of one skip the preview altogether. `pick` and `lead` together, or a `lead` that is not a boolean, are `bad-argument`. One 16-bit wire word (`encodeChoice` of a one-slot preview), so the protocol needs no new message; `replay` takes `lead` too, and a snapshot that says `lead` with anything but `pick:1` is `snapshot-invalid`. `matchctl.js` `FORMATS['6v6']` is `{pick:0, lead:true}` and `formatOpts(fmt)` is the pair to spread into `createMatchController`: `online_match.js` calls it for the online match; the battle page reads `FORMATS[format].lead` itself (`battle_boot.js resolveBattle`, `spec.lead`); the Tower page is to spread `formatOpts(setup.format)` too (TOWER.md section 13).
* **freeSwitch** (optional, `true` | `false` | `[boolean, boolean]`): **"Will you switch your Pokemon?"**, the Gen 3 trainer-battle prompt (Battle Style SHIFT), for the sides it names (`true` = both). While the faint-replacement phase is open, if **exactly one** side needs a replacement (its active Pokemon fainted and it has another) and the **other** side's active Pokemon is alive, can leave the field (not trapped) and has a living Pokemon on its bench, that other side is **offered a free switch** (`Battle.offerFree`, called from `endOfTurn`). Its request is `{phase:'switch', reason:'free', switches, next, canForfeit}` where `switches` are its living bench members and `next` is `{slot, sp, name, level}` of the Pokemon the foe has **already chosen** to send out (the CPU answers first, as in the real game, where the foe's next Pokemon is named before the question is asked; `null` until it has). It answers with `{kind:'switch', slot}` (that Pokemon comes in **now**: `switch-out`, `switch-in`, then its entry hazards, abilities and items exactly as for a switch at the start of a turn, **using no move and no turn**; only then is the foe's chosen replacement sent out) or with the new `{kind:'stay'}` (NO: nothing happens). Both are ordinary choices: they are in `choiceLog`, replay, snapshots and the wire. State: `s.fs = [0|1, 0|1]` (present only when some side is offered; a battle without the option has no such key, so its state, events and hash are what they always were) and `s.fo = side` while an offer is open (the phase is still `switch`, reason `faint`, `need` true for both sides). Not offered (the phase is then exactly as before): the option off for that side, both Pokemon fainted (each side replaces its own), the player's Pokemon trapped (Mean Look, a binding move, Ingrain, Fairy Lock; the foe's Shadow Tag / Arena Trap / Magnet Pull do not hold it, the foe having fainted), nobody on its bench, the foe with no replacement (the battle simply ends). If the Pokemon that comes in faints on entry (a hazard) and the side has another, the foe's replacement does **not** come in yet: the side must choose an ordinary replacement (`reason:'faint'`, the foe's choice is kept) and the two come in together as after a double faint. `stay` is refused (`wrong-phase`) from any side that is not being offered, and a switch to the active, a fainted or a missing slot is refused by name (`active`, `fainted`, `bad-slot`). Wire: `stay` is the 16-bit word 7 (a forfeit stays 3; every pattern is still canonical or refused); `replay` takes `freeSwitch` too and a log with answers needs the option it was played with (`replay-rejected` otherwise); a snapshot that names `fo` for a side that is not offered, or outside the faint phase, is `snapshot-invalid`. **An Intimidate (or any entry effect aimed at the foe) of the Pokemon that comes in finds nobody**: the foe's Pokemon has fainted and its replacement is not in yet, as in the real game. `matchctl.js` passes it for a human seat that fights a CPU and for nobody else (below), so an online battle is untouched.
* **seed** u32 initialises the RNG stored in the state.
* `battle.requests()` -> `[reqA, reqB]`:
  * `{phase:'preview', pick, team:[{slot, sp, name, level}], canForfeit}`
  * `{phase:'move', moves:[{slot, id, pp, max, disabled, reason}], struggle, switches:[{slot, sp, name, hp, max, st, level}], trapped, canForfeit}` (when no move has PP the only entry is slot 4 = Struggle)
  * `{phase:'switch', reason:'faint'|'pivot'|'revive'|'free', switches, canForfeit}` (`free` also carries `next`, see `freeSwitch` above); `{phase:'wait', locked, lockedMove, canForfeit}` (nothing to choose: other side's turn, or locked into a charge / recharge / rampage); `{phase:'end', winner}`.
  * `canForfeit` is the truth about what `choose(side, {kind:'forfeit'})` will do: true until the side has made a real choice (a side that is merely locked into a charge / recharge / rampage may forfeit), and also true when every choice is in and the phase is about to resolve; false once it forfeited or the battle ended.
* `battle.choose(side, choice)` -> `{ok, code}`; it never throws for a malformed choice (a hostile object is read once into a private copy). Choices are small plain objects: `{kind:'move', slot}`, `{kind:'switch', slot}`, `{kind:'preview', order}`, `{kind:'forfeit'}`, and `{kind:'stay'}` (only as the answer NO to a `reason:'free'` request).
  Rejection codes: `bad-side ended bad-choice already-chosen not-needed wrong-phase bad-order bad-slot active fainted trapped` and a disabled move's reason (`no-pp disabled taunt encore choice assault-vest`).
  A choice cannot be changed once accepted (the UI keeps it local until confirmed), which keeps the choice log unambiguous.
  **Forfeit ordering.** The choice log has no "advance" markers, so a forfeit is made unambiguous: `choose(side, forfeit)` first resolves any phase in which every needed choice is already in (exactly what a driver that calls `advance()` as soon as `ready()` does), and then records the forfeit; the events of that resolution are delivered by the next `advance()` / `drain()`. The forfeit itself takes effect at the next `advance()` (both sides forfeiting is a draw).
* `battle.ready()` is true when every side that has to choose has chosen (or a side forfeited). `battle.advance()` resolves the turn / phase and **returns the new events** (everything since the last `advance()` / `drain()`); it runs until the next point where a choice is needed, **including turns in which neither side has a choice** (both locked into a charge / recharge / rampage), so `ready()` is false whenever a driver has to act. `battle.drain()` returns undelivered events without advancing.
* `battle.events` (full log), `battle.winner` (`null | 0 | 1 | -1` = draw), `battle.turn`, `battle.choiceLog` (`[{s, c}]`).
* **State**: `battle.s` is one plain JSON object (no classes, no `undefined`). `battle.snapshot()` -> JSON copy of state + events + choice log + `packId` (ROM sha256 when the pack was fully verified, else null) + `packFp` (16-hex fingerprint of the battle-relevant pack content) + `hash` (the state hash).
  `restoreBattle(snap, {pack})` **validates the snapshot completely** and builds nothing unless it passes: the engine version (`snapshot-version`), the ROM / pack it was made with (`snapshot-rom`; the `packFp` is always compared, the sha256 when both sides have one), the shape of every field, every range (hp within 0..max, stages -6..6, pp within max, slot indexes, ...), every species / move / item / ability id against the pack, the volatile-condition names, event codes, the choice log, cross-field consistency (fnt is 1 exactly when hp is 0, no status on a fainted Pokemon, a winner exactly when the phase is `end`, ...), and the stored state hash; then it proves the state is usable (`requests()` and both `viewFor()` run). Anything wrong throws `EngineError` code `snapshot-invalid`. The input is never aliased or modified.
  `battle.hash()` = 64-bit digest (16 hex chars: two independent FNV-1a passes) of the canonical JSON of the full state; `battle.logHash()` the same over the event log.
* **Pure step**: `stepBattle(snapshot, [choiceA, choiceB], {pack})` -> `{snapshot, events, hash}`. A turn is a pure function of (state, choices): the RNG lives inside the state.
* **Replay**: `replay({pack, ruleset, teams, seed, pick, names, choiceLog})` reproduces the identical event log and final hash for **every** phase mix, forfeits included (a forfeit in a faint-replacement phase, a forfeit followed by the opponent's choice, both sides forfeiting, a forfeit by a locked side). It advances whenever the engine is ready before feeding the next logged choice, except that it does not advance while a forfeit is pending (the next logged entry is then the other side's choice for the same phase). The result is exactly the live battle, which tests/fuzz check on random drivers.
* **Wire**: `encodeChoice(choice)` -> u16 (<= 2 bytes; move/switch/forfeit use 5 bits, a preview of up to 4 members uses 16), `decodeChoice(u16)` -> choice or `null`; canonical (decode(encode(c)) equals c, and every 16-bit pattern is either canonical or refused: tested exhaustively).
* **Information hiding**: `battle.viewFor(side)` returns the field as that side may see it: its own team in full; the foe's active mon with HP as a percentage, species/types/status/stages, and only the **revealed** moves, ability and item (a revealed field is set when the move is used / the ability or item triggers). Bench members the foe has never seen are `{hidden:1}`. Private volatiles (a Choice lock, a Flash Fire boost, ...) are filtered out. **During team preview the foe's whole team (species, level, types) is visible**, as in Stadium; after the picks the unseen bench is hidden again.
  **What is NOT hidden (the view model, read before building a CPU or a netplay client).** `viewFor` is the only filtered surface. `battle.events`, `advance()`'s return value, `snapshot()`, `battle.s` and `previewDamage()` are **full-information**: damage / heal events carry the exact HP of both sides, `switch-in` carries exact HP and max, and `previewDamage` uses both sides' real stats. A UI must show the foe's HP as a bar only and must not print foe numbers; a CPU opponent must decide from `viewFor` (and its own estimates) and never call `previewDamage` for the foe's side or read `events` for hidden data; a lockstep netplay client runs the whole engine (both teams are known to both machines by construction), so nothing here is a secret from a modified client - that is inherent to deterministic lockstep and is not defended.
* **Damage preview**: `battle.previewDamage(side, moveId, {roll: 0..15, crit})` is a **pure function of the battle**: it runs on a private deep copy whose RNG throws, so it changes no state, writes no event and draws no random number (two identical battles, one previewed, stay hash-identical; checked for every supported move). It returns one hit's damage from `side`'s active Pokemon to the foe's active Pokemon. Random-power moves use their expected power (Present 65 given that it damages, Magnitude 71, Psywave = the user's level, Echoed Voice reads the current streak); fixed-damage moves their fixed value (Seismic Toss = level, Sonic Boom 20, Super Fang half the target's HP, OHKO moves the target's HP); status moves and team preview return 0; multi-hit moves return one hit. A bad side or a move id the engine cannot run throws `EngineError` `bad-argument`. `battle.callablePool()` = the moves Metronome may call (every supported move except the ban list, which now also holds every Z-move and Max Guard).
* Formats: teams 1-6 (a 6v6 battle chooses its lead first, above), forced switch after a faint, forfeit, Struggle when out of PP, a turn cap of 300 turns (draw) so every battle terminates; a simultaneous KO of both last Pokemon is a draw.

### Events (`battle.events`, plain objects, **message codes only - never English text**; the scene builds text from ROM strings)

`t` = code, `s` = side, `m` = team slot. 58 codes (`EVENT_CODES`; the test fails if a fuzzed battle emits one that is not listed):

| group | codes (fields beyond `t s m`) |
|---|---|
| flow | `start` (names, sizes, pick, rules, and `lead:1` in a lead battle), `preview` (order), `turn` (n), `switch-in` (sp, name, lv, hp, max, st), `switch-out`, `pivot`, `forced-out`, `faint`, `win`, `draw`, `forfeit`, `turn-cap` |
| moves | `move-use` (mv, called), `miss`, `avoid` (semi-invulnerable target), `fail` (why), `immune` (why: type / ability / powder / airborne / **prankster** (a Prankster-boosted status move against a Dark type) / ...), `protected` (pk), `protect-break`, `cant-move` (why: slp frz par flinch recharge truant disabled taunt lost-focus), `charge`, `multi-hit` (n), `crit`, `struggle`, `confusion-hit`, `copy` (how: metronome / sleep-talk / transform / trace; **transform also carries `sg` = the user's new stat stages, `ty`, `ab`**), `noop` |
| hp | `damage` (from, to, max, src, eff, crit, mv), `heal` (from, to, max, src), `drain`, `recoil`, `endure`, `sub-set`, `sub-damage`, `sub-break`, `destiny-bond`, `wish`, `future-sight` |
| status | `status-set` (st 1 slp 2 psn 3 brn 4 frz 5 par 6 tox, fx), `status-clear` (st, why), `volatile` (v: confusion, protect, leech-seed, taunt, ...), `volatile-end`, `type-change` |
| stats | `stat-change` (stat, delta, now), `stat-fail` (stat, why: max / min / ability / item / mist), `stats-reset` |
| field | `weather` (w 1 rain 2 sun 3 sand 4 hail 5 snow), `weather-tick`, `weather-end`, `hazard` (hz, n), `hazard-damage`, `hazard-clear`, `screen` (k), `screen-end`, `field` (k: trick-room) |
| triggers | `ability` (ab, fx), `item` (it, fx, used), `trick` |

`damage.eff` is the effectiveness as a UQ4.12 number (4096 = neutral, 8192 super effective, 2048 resisted, 0 immune).

## 2. Determinism

* Integer-only battle math: `Math.imul`, `>>>0`, and `idiv(a,b) = (a - a % b) / b`. Modifiers are UQ4.12 numbers (4096 = x1) **chained per stage** and applied with **round-half-down** (`pokeMod`): the base-power modifiers (Technician, the pinch abilities Overgrow / Blaze / Torrent / Swarm, Muscle Band / Wise Glasses / plates, ...) are chained and applied to the **move power** before the damage formula; attacking-stat modifiers (Huge Power, Choice Band, ...) and defending-stat modifiers to the stat; the final modifiers (screens, Life Orb, Expert Belt, Multiscale, ...) are chained and applied once to the damage at the end. **Type effectiveness**: the defender's two multipliers are multiplied into ONE UQ4.12 number (`typeProduct`) and applied once with the same half-down rounding (`pokeMod`); the earlier "floor after each type" was off by one on dual types (measured against the real game, 1438 of 1438 dual-type rolls, ROMDIFF.md). No `Math.random`, `Date`, `Intl`, no unordered iteration; state keys are sorted by `canonicalJSON` for hashing.
* **One RNG** inside the state: a 32-bit LCG `s = s*0x41C64E6D + 0x6073 (mod 2^32)`, output `s >>> 16`, `rand(n) = output % n`. It is the GBA-family LCG, **not the hack's own RNG** (engine-internal; MECHANICS row `rng`).
* **Order of RNG calls** (pinned by the scripted-RNG tests, which fail if a call is added, removed or reordered):
  1. turn start: Quick Claw `rand(5)` per holder; a full tie in order (priority, item order, speed) takes one `rand(2)`;
  2. before a move: freeze thaw `rand(5)`; confusion self-hit `rand(3)` then (if it hits) the damage roll `rand(16)`; full paralysis `rand(4)`;
  3. accuracy: one `rand(100)` only when the effective accuracy is below 100 (none for moves that cannot miss, none in Lock-On, none when No Guard applies, none for Toxic used by a Poison-type, none for a Stomp-family move against a Minimized target);
  4. kind-specific rolls (Present, Magnitude, Psywave `rand(101)`, multi-hit count `rand(100)` -> 2/3/4/5 hits at 35/35/15/15) happen after the accuracy roll and the immunity checks;
  5. per hit: crit `rand(odds)` (skipped for fixed-damage moves, always-crit moves and crit-immune targets), then the damage roll `rand(16)` (damage factor 100-i percent);
  6. secondary effects in table order: `rand(100)` for each with a chance below 100 (Serene Grace doubles it); sleep length `rand(3)`, confusion length `rand(4)`;
  7. end of turn: Future Sight damage roll `rand(16)`, Shed Skin `rand(3)`; Toxic, Leech Seed, weather and Leftovers need none.
* Turn resolution: switches first, then moves by priority bracket (move priority, plus Prankster / Gale Wings / Triage), Quick Claw / Lagging Tail, speed (descending; ascending under Trick Room). **Order is fixed at the start of the turn** (a mid-turn speed change does not reorder).
* End of turn, in this order: weather tick + damage, Wish, Future Sight, ability residuals, item residuals, Leech Seed, burn / poison / toxic, trap damage / Curse / Ingrain / Aqua Ring / Yawn and the Taunt-Encore-Disable-Magnet Rise timers, field timers (screens, Safeguard, Tailwind, Mist, Trick Room, weather turns), then replacement requests for fainted actives. Effects of one kind run for the faster side first.

## 3. MECHANICS table (`MECHANICS` export: name, value, source)

`rom` = decoded from the ROM data at runtime; `rom-live` = a value MEASURED in the real game (FA2: the ROM's own battle code driven with a forced RNG; `tools/pokemonarena_rom_diff_test.mjs` repeats it); `rom-static` = a ROM value located by a static decode (nothing executed) and pinned against the ROM bytes by the test; `assumed` = not verified against this ROM, the pokeemerald-expansion default for the modern behaviour the hack uses. **Every `assumed` row below is an unverified assumption.**

| mechanic | value | source | note |
|---|---|---|---|
| typeChart | 21x21 UQ4.12 (pack.typeChart) | rom | decoded at 0x43b8b4; engine reads it through pack.typeChart, never a copy |
| moveData | type, category, power, accuracy, pp, priority, effect id, additional effects (id, chance), flags, target, strikeCount, critStage | rom | decoded move table (tables.js) |
| multiHitFlag | move.bytes[5] & 1 = 2-5 hits; & 2 = self-destruct | rom | raw move byte +0x15, correlated with the known multi-hit / explosion move sets by the test |
| semiInvulnHitFlags | move.bytes[8] bits 3 (underground), 4 (underwater), 5/6 (airborne) | rom | raw move byte +0x18, correlated with Earthquake/Surf/Thunder/Gust families by the test |
| baseStats / natures / species types | pack.species, pack.natures | rom | decoded |
| statFormula | floor((2B+IV+floor(EV/4))*L/100)+5 (HP +L+10), nature 110/90 | rom-static | ROM routine at 0x1ed920 decoded statically by stage C2; computed by rules.battleStats |
| statStageRatios | [[10,40],[10,35],[10,30],[10,25],[10,20],[10,15],[10,10],[15,10],[20,10],[25,10],[30,10],[35,10],[40,10]] | rom-static | u8 pairs at file offset 0x7c72f4, pinned against the ROM by the engine test |
| accuracyStageRatio | accuracy = min(100, floor(base * P / 100)) with P = {33, 36, 43, 50, 60, 75, 100, 133, 166, 200, 233, 266, 300} for the net stage s = the user's accuracy stage minus the target's evasion stage clamped to -6..+6 (index s + 6; `engine_data.js ACC_STAGE_PCT`) | rom-live | MEASURED in the real game (FA2): the ROM has no data table (the ratio is built inside the accuracy routine, which is why the byte search found nothing); the effective accuracy of an accuracy-100 move was read at every stage and 60 of 60 (move, stage) probes equal the formula. The earlier 3/(3+s) formula differed at -5 (37 vs 36), -4 (42 vs 43) and in the floor at +1 (75 base: 100 vs 99) |
| critOdds | [24,8,2,1] (stage 0..3; the ROM table is {24,8,2,1,1}, stage 4 = stage 3) | rom-static | the table the compiled code reads was decoded (see "Crit odds" below): Thumb routines at 0xe7a7c and 0xed530 index four ROM tables by crit stage and choose one from a config byte; the ROM's config byte is 8, which selects the Gen 7+ table {24,8,2,1,1} at 0x476b7c; pinned against the ROM bytes by the engine test |
| critMultiplier | 1.5x (UQ4.12 6144) | rom-live | modern default; MEASURED (FA2): every always-crit move and every forced-crit combo in the damage differential equals the engine with 1.5x, roll for roll |
| damageFormula | floor(floor(floor(2L/5+2)*BP*A/D)/50)+2, then weather, crit, roll, STAB (each a pokeMod: UQ4.12, round half down), then the type chart (the defender types multiplied into ONE UQ4.12 number and applied once, half-down), then burn, then the chained final modifiers applied once | rom-live | expansion Gen 5+ order; base-power modifiers (Technician, the pinch abilities Overgrow / Blaze / Torrent / Swarm, Muscle Band, ...) are chained and applied to the move POWER before the formula, attacking-stat modifiers (Huge Power, Choice Band, ...) to the stat; MEASURED (FA2): 470 scenarios x 16 rolls equal the real game exactly (type chart combined for dual types, STAB, weather, crit, burn, screens, abilities, items); see pokemonarena/ROMDIFF.md |
| randomRoll | 85..100 percent, 16 values (100 - rand(16)) | rom-live | MEASURED (FA2): the game draws RandomUniform(0,15), roll index r gives (100 - r) percent; all 16 rolls compared |
| stab | 1.5x; Adaptability 2x | rom-live | MEASURED (FA2): 1.5x and Adaptability 2x equal the real game on the damage differential |
| burn | halves physical damage (not with Guts/Facade); residual 1/16 max HP | rom-live | Gen 7+ residual; MEASURED (FA2): physical damage halved (Guts and Facade excepted) and the 1/16 residual equal the real game |
| paralysis | speed x0.5; 25% chance to be fully paralysed | rom-live | Gen 7+ speed drop; MEASURED (FA2): the speed halving decides the same turn orders as the real game (paralysis order cases), and the full-paralysis chance is exactly 25 percent (draw below 16384 of 65536) |
| sleep | 1-3 turns; counter decrements on each move attempt | assumed | Gen 5+ |
| freeze | 20% thaw chance per move attempt; a frozen USER is thawed by its own Flame Wheel-type move; a frozen TARGET is thawed by any damaging Fire-type hit (and Scald, Steam Eruption, Scorching Sands) that a Substitute does not absorb; Ice types and harsh sunlight cannot be frozen; no frostbite | assumed | frostbite is an expansion option, assumed off |
| poison / toxic | 1/8 max HP; toxic n/16 max HP with n counting up | rom-live | MEASURED (FA2): poison 1/8; toxic = floor(max/16) * counter (divide FIRST, then multiply), counter 1 on the first tick; equal over 5 turns at max HP 411 |
| confusion | 2-5 turns; 33% self-hit; 40 power typeless physical | rom-live | Gen 7+; MEASURED (FA2): duration 2-5 in equal quarters of the draw; self-hit exactly 33 of 100 picks; the 40-power typeless hit equals the real game |
| flinch | only if the target has not moved yet this turn; cleared at end of turn | assumed |  |
| weather | Rain/Sun x1.5/x0.5 for Water/Fire; 5 turns (8 with the matching rock); Sand and Hail 1/16 residual; Snow raises Ice Defense x1.5 | rom-live | Snowscape is present in the ROM move table; engine models Snow as Gen 9; MEASURED (FA2): 1.5x / 0.5x, five turns INCLUDING the turn it is set: damage on turns 1-4 and it ends WITHOUT damage on turn 5 (eight turns with the rock: 7 ticks); sand / hail chip 1/16; Rain Dish, Dry Skin, Ice Body, Solar Power order |
| screens | Reflect/Light Screen/Aurora Veil x0.5 in singles, 5 turns (8 with Light Clay), ignored by crits | rom-live | MEASURED (FA2): 0.5x in singles, ignored by crits, five turns (expires on the fifth end of turn) |
| hazards | Spikes 1/8,1/6,1/4; Toxic Spikes 1 psn/2 tox; Stealth Rock 1/8 x type effectiveness; Sticky Web speed -1 | assumed |  |
| protect | success chance 1/3 per consecutive use, 1/81 cap, resets after any other move | assumed |  |
| trapping | 4-5 turns, 1/8 max HP per turn | assumed | Gen 6+ value |
| leechSeed | 1/8 max HP drained each turn | assumed |  |
| recoilDrain | recoil/drain percentages are the move record argument byte (+0x24) | rom | read by the test from the ROM and compared with MOVE_ARGS; the engine uses the hand-written MOVE_ARGS copy |
| itemHoldEffects | item -> behaviour is keyed by the item record hold-effect id and param byte (pack.items[].holdEffect / holdEffectParam) | rom | decoded; the test anchors the ids to named items (e.g. 41 Leftovers, 60 Life Orb, 29 Choice Band) |
| itemModifiers | Life Orb 5325/4096 (FA2: the ROM uses the rounded 1.3, 5324 was one low) with 10% recoil; Expert Belt 4915; Choice 6144; type items and plates 4915; Muscle Band and Wise Glasses 4505; Eviolite and Assault Vest 6144; Sitrus heals 1/4, Oran 10 HP, pinch berries 1/3; resist berries halve once; Rocky Helmet 1/6; Leftovers 1/16; Black Sludge 1/16 or 1/8 | assumed | the numeric effect of each hold effect is the expansion default, not read from the ROM |
| abilityModifiers | Technician 1.5x up to 60 BP; Iron Fist and Reckless 1.2x; Sheer Force 1.3x and removes secondaries; Huge Power 2x; Guts and Hustle 1.5x; -ate abilities 1.2x; Multiscale 0.5x; Solid Rock 0.75x; Thick Fat 0.5x; absorb abilities heal 1/4; contact abilities 30%; Rough Skin 1/8; weather speed 2x | assumed | ability behaviour is not in the ROM tables (names and text only); the numbers are the expansion defaults |
| speedTie | one rand(2) call | assumed | engine rule |
| rng | 32-bit LCG s = s*0x41C64E6D + 0x6073, output s>>>16, rand(n) = output % n | assumed | engine-internal (the GBA family LCG); not the hack's own RNG |
| turnCap | 300 | assumed | engine rule: a battle is drawn after this many turns so every battle terminates |
| selfDestruct | Explosion and Self-Destruct (raw move byte +0x15 bit 1) faint the user once the move is USED, whether it hits, misses, hits a Ghost, is Protected or finds a semi-invulnerable target; only Damp (a fail before the move starts) stops it | assumed | Gen 3+ behaviour |
| invulnerableDoubling | Earthquake / Magnitude vs Dig, Surf / Whirlpool vs Dive, Gust / Twister vs Fly / Bounce deal x2; Stomp-family moves vs a Minimized target deal x2 and never miss | assumed | Gen 6+ behaviour; the hit flags that let a move connect are the ROM's (semiInvulnHitFlags), the doubling is keyed by move name |
| toxicAccuracy | Toxic used by a Poison-type never misses; Sheer Cold used by a non-Ice-type has base accuracy 20 + level difference instead of 30 + level difference | assumed | Gen 6+ / Gen 7+ behaviour |
| trapImmunity | Ghost types cannot be trapped by Mean Look-style moves, trapping moves or the abilities Shadow Tag / Arena Trap / Magnet Pull; a Shed Shell frees any holder | assumed | Gen 6+ behaviour |
| pranksterVsDark | a status move whose priority was raised by Prankster fails against a Dark-type target | assumed | Gen 7+ behaviour |
| faintClearsStatus | a fainted Pokemon has no major status (silent: no status-clear event, the faint event is the message) | assumed | |
| previewPower | previewDamage() uses the expected power of the random-power moves (Present 65 given that it damages, Magnitude 71) and the user level for Psywave; it never draws from the RNG, writes an event or changes the battle | assumed | engine rule |

**What `rom-static` rests on.** (1) The stat-stage ratio table: 13 `(numerator, denominator)` u8 pairs at file offset 0x7c72f4, referenced by 9 literal-pool words; the test compares the engine's copy with the ROM bytes and a mutant of one entry is killed. (2) The stat formula: the ROM routine at 0x1ed920, decoded by stage C2 (not re-decoded here). (3) The crit-odds table and its selection (see "Crit odds" below): table bytes, the config byte and the dispatch halfwords are pinned against the ROM by the engine test.
**Searched and not found:** an accuracy-stage ratio table (u8 / u16 / u32 pairs, both 33/100-style and 3/(3+s)). It is not stored as data; FA2 measured it by driving the ROM (row `accuracyStageRatio`).

**Crit odds (decoded; no longer assumed).** The ROM holds four adjacent u32[5] tables: 0x476b7c `{24,8,2,1,1}`, 0x476b90 `{16,8,2,1,1}`, 0x476ba4 `{17,32,64,85,128}`, 0x476bb8 `{16,8,4,3,2}` (the expansion's Gen 7+, Gen 6, Gen 2 and Gen 3-5 crit tables). No literal-pool word points at any of them directly, which is why the first pass found nothing. The code reaches them through a base pointer: 19 literal-pool words hold 0x08476b3c (the start of the rodata block) and the routines at 0xe7a7c-0xe7ae4 and 0xed530-0xed61e compute `base + stage*4` and load with `ldr [.., #64]` / `#84` / `#104` / `#124` - the four tables (halfwords 0x6c1b, 0x6d5b, 0x6e9b, 0x6fdb). The dispatch is: call 0x1731a0 with argument 0 (a bounds-checked read of the byte at `[0x864b40c + id]`, file offset 0x64b40c); a value above 5 selects +64 (0x476b7c, Gen 7+), 5 selects +84 (0x476b90), 1 selects +104 (0x476ba4), anything else +124 (0x476bb8). **The ROM's config byte 0 is 8**, so the code reads the Gen 7+ table `{24,8,2,1,1}`; the chance is `1 / table[stage]` through the ROM's weighted-chance helper (0x21cafc, called with weights `{odds-1, 1}`). That argument 0 is the crit-chance config was INFERRED by the first pass and is now CONFIRMED by FA2 in the real game: the draw at which a plain hit becomes critical is exactly 62806 of 65536 (= 1/24, stage 0) and 57344 (= 1/8) for Super Luck, Scope Lens and Razor Claw (stage +1). The earlier note "3 references at 0x476bbc" is unrelated: those words load `0x8476bbc`, add 40 and scan u16 thresholds ending in 0xFFFF - the Flail / Reversal power table that follows the crit tables. Pinned by the engine test (table bytes, config byte, the four dispatch halfwords). The crit multiplier (1.5x) is **not** decoded and stays `assumed` (config byte 1 is also 8, consistent with the Gen 6+ multiplier).
Damage, status residuals, weather multipliers, STAB, burn/paralysis/confusion/sleep constants live inside large inlined Thumb routines that were **not** decoded (labelled `assumed`).

## 4. Move effects

The ROM stores one numeric `effect` per move (321 distinct values) plus up to three "additional" secondary effects. **No name table exists in the ROM**; the mapping below was built the way the brief asks: anchor ids to well-known moves, then cluster by field patterns. The engine test re-checks **every anchor against the decoded pack** (a shifted or wrong mapping fails) and checks every per-move argument (recoil %, drain %, status id, protect kind, weather, fixed damage, counter multiplier) against the ROM move record's argument byte at `+0x24`.

Additional ROM facts used: raw move byte `+0x15` bit 0 = multi-hit (2-5 hits), bit 1 = self-destruct (Explosion family) - both tested against the known move sets; byte `+0x18` bits 3 / 4 / 5-6 = "also hits an underground / underwater / airborne target" (Earthquake, Surf, Thunder, Gust families); the `strikeCount` nibble gives fixed multi-hit counts; `additional.chance === 0` means "always".

**Support rule.** A move is SUPPORTED only if its effect class has a handler, every per-move argument exists, and every secondary effect id is implemented. `rules.js` makes everything else illegal (section 6). Currently **878 of 935 moves** are supported (57 unsupported: 51 Max / G-Max moves and 6 that no species learns), through **228 classes covering 314 of the 321 effect ids in the ROM** (round 2 added 59 moves and 42 classes, round 3 added 131 moves and 66 classes; the reasons for the rest are in section 7 and ROMDIFF.md 8.7). Each class has at least one hand-computed unit test (the run fails if a class has none).

**Supported is not the same as reachable.** 878 is what the engine can *run*; **796** is what a legal team can actually *contain* (the union of `rules.legalMoves` over the 1018 engine-legal species at level 100 with every learn source enabled). The other **82** supported moves can never be on a legal team: the Z-moves and Max Guard, event-only or legendary-signature moves (Celebrate, Happy Hour, King's Shield, Blast Burn, V-create, Steel Beam, Bolt Beak, Collision Course, ...) and Struggle. `engine_coverage.json` counts both (`movesSupported`, `movesReachable`) and lists the 82 (`moves.supportedButUnreachable`). Quote **796**, not 878, as "moves a player can use" (and every move a species learns is among them). Metronome's pool is the 878 minus its ban list (which excludes every Z-move and Max Guard), so it can still call a supported move that no legal species learns, as in the real games.

Moves with the effect (and fully supported), by class:

| class | effect id(s) | anchor moves (evidence) | moves with this effect | of which fully supported |
|---|---|---|---|---|
| hit | 1, 111, 239, 331 | Pound, Flamethrower, Earthquake, Bulldoze | 406 | 378 |
| stats | 7, 8, 13, 14, 15, 16, 18, 20, 38, 39, 40, 41, 42, 46, 47, 48, 49, 50, 52, 82, 117, 158, 159, 160, 162, 163, 216, 217, 220, 221, 227, 228, 229, 230, 236 | Meditate, Sharpen, Harden, Withdraw | 54 | 54 |
| status | 2, 296 | Toxic, Thunder Wave, Will-O-Wisp, Spore | 14 | 14 |
| drain | 3 | Absorb, Giga Drain, Draining Kiss | 12 | 12 |
| protect | 86 | Protect, Detect, King's Shield, Quick Guard | 12 | 12 |
| recoil | 324 | Double-Edge, Flare Blitz, Head Smash | 12 | 12 |
| heal | 26, 103, 104, 105, 118, 184, 265, 326 | Recover, Slack Off, Morning Sun, Synthesis | 11 | 11 |
| semiinvuln | 116 | Fly, Dig, Dive, Bounce | 6 | 6 |
| condpower | 130 | Hex, Venoshock, Smelling Salts | 6 | 6 |
| weather | 107 | Rain Dance, Sunny Day, Sandstorm, Hail | 5 | 5 |
| ohko | 29 | Fissure, Sheer Cold | 4 | 4 |
| fractiondamage | 31 | Super Fang | 4 | 4 |
| crash | 34 | Jump Kick, High Jump Kick | 4 | 4 |
| confuse | 37 | Supersonic, Confuse Ray | 4 | 4 |
| twoturn | 54 | Razor Wind, Sky Attack, Skull Bash | 7 | 4 |
| counter | 66 | Counter, Mirror Coat, Metal Burst | 4 | 4 |
| hazard | 87, 194, 196, 203 | Spikes, Toxic Spikes, Stealth Rock, Sticky Web | 4 | 4 |
| settype | 224, 250 | Soak, Magic Powder, Trick-or-Treat, Forest's Curse | 4 | 4 |
| screen | 27, 53, 249 | Light Screen, Reflect, Aurora Veil | 3 | 3 |
| nothing | 59, 61, 62 | Splash, Celebrate, Happy Hour | 3 | 3 |
| meanlook | 80 | Mean Look, Spider Web, Block | 3 | 3 |
| return | 95 | Return | 3 | 3 |
| eruption | 148 | Eruption, Water Spout | 3 | 3 |
| uturn | 155 | U-turn, Volt Switch, Flip Turn | 3 | 3 |
| wringout | 168 | Wring Out, Crush Grip | 3 | 3 |
| psyshock | 183 | Psyshock, Psystrike, Secret Sword | 3 | 3 |
| roar | 24 | Roar, Whirlwind | 2 | 2 |
| fixeddamage | 32 | Sonic Boom, Dragon Rage | 2 | 2 |
| leveldamage | 64 | Seismic Toss, Night Shade | 2 | 2 |
| lockon | 71 | Mind Reader, Lock-On | 2 | 2 |
| flail | 75 | Flail, Reversal | 2 | 2 |
| falseswipe | 77 | False Swipe | 2 | 2 |
| healbell | 78 | Heal Bell, Aromatherapy | 2 | 2 |
| triplekick | 79 | Triple Kick, Triple Axel | 2 | 2 |
| healingwish | 84, 85 | Healing Wish, Lunar Dance | 2 | 2 |
| foresight | 88 | Foresight, Odor Sleuth | 2 | 2 |
| futuresight | 112 | Future Sight, Doom Desire | 2 | 2 |
| solarbeam | 113 | Solar Beam, Solar Blade | 2 | 2 |
| firstturn | 119 | Fake Out, First Impression | 2 | 2 |
| trick | 136 | Trick, Switcheroo | 2 | 2 |
| revenge | 143 | Revenge, Avalanche | 2 | 2 |
| thief | 146 | Thief, Covet | 2 | 2 |
| lowkick | 154 | Low Kick, Grass Knot | 2 | 2 |
| heavyslam | 172 | Heavy Slam, Heat Crash | 2 | 2 |
| storedpower | 174 | Stored Power, Power Trip | 2 | 2 |
| suckerpunch | 205 | Sucker Punch | 2 | 2 |
| dragontail | 233 | Dragon Tail, Circle Throw | 2 | 2 |
| stomptantrum | 257 | Stomping Tantrum | 2 | 2 |
| burnup | 264 | Burn Up, Double Shock | 2 | 2 |
| boltbeak | 289 | Bolt Beak, Fishious Rend | 2 | 2 |
| mindblown | 293 | Mind Blown, Steel Beam | 2 | 2 |
| collision | 303 | Collision Course, Electro Drift | 2 | 2 |
| rapidspin | 323 | Rapid Spin | 2 | 2 |
| smackdown | 325 | Smack Down, Thousand Arrows | 2 | 2 |
| dreameater | 5 | Dream Eater | 1 | 1 |
| haze | 22 | Haze | 1 | 1 |
| rest | 28 | Rest | 1 | 1 |
| mist | 35 | Mist | 1 | 1 |
| focusenergy | 36 | Focus Energy | 1 | 1 |
| transform | 45 | Transform | 1 | 1 |
| substitute | 55 | Substitute | 1 | 1 |
| metronome | 57 | Metronome | 1 | 1 |
| leechseed | 58 | Leech Seed | 1 | 1 |
| disable | 63 | Disable | 1 | 1 |
| psywave | 65 | Psywave | 1 | 1 |
| encore | 67 | Encore | 1 | 1 |
| painsplit | 68 | Pain Split | 1 | 1 |
| snore | 69 | Snore | 1 | 1 |
| sleeptalk | 73 | Sleep Talk | 1 | 1 |
| destinybond | 74 | Destiny Bond | 1 | 1 |
| spite | 76 | Spite | 1 | 1 |
| curse | 83 | Curse | 1 | 1 |
| endure | 90 | Endure | 1 | 1 |
| swagger | 92 | Swagger | 1 | 1 |
| furycutter | 93 | Fury Cutter | 1 | 1 |
| present | 96 | Present | 1 | 1 |
| safeguard | 98 | Safeguard | 1 | 1 |
| magnitude | 99 | Magnitude | 1 | 1 |
| hiddenpower | 106 | Hidden Power | 1 | 1 |
| fellstinger | 108 | Fell Stinger | 1 | 1 |
| bellydrum | 109 | Belly Drum | 1 | 1 |
| teleport | 114 | Teleport | 1 | 1 |
| flatter | 126 | Flatter | 1 | 1 |
| memento | 127 | Memento | 1 | 1 |
| facade | 128 | Facade | 1 | 1 |
| focuspunch | 129 | Focus Punch | 1 | 1 |
| taunt | 134 | Taunt | 1 | 1 |
| wish | 138 | Wish | 1 | 1 |
| ingrain | 140 | Ingrain | 1 | 1 |
| yawn | 144 | Yawn | 1 | 1 |
| knockoff | 145 | Knock Off | 1 | 1 |
| endeavor | 147 | Endeavor | 1 | 1 |
| refresh | 151 | Refresh | 1 | 1 |
| weatherball | 157 | Weather Ball | 1 | 1 |
| assurance | 169 | Assurance | 1 | 1 |
| acrobatics | 171 | Acrobatics | 1 | 1 |
| punishment | 173 | Punishment | 1 | 1 |
| electroball | 175 | Electro Ball | 1 | 1 |
| gyroball | 176 | Gyro Ball | 1 | 1 |
| echoedvoice | 177 | Echoed Voice | 1 | 1 |
| payback | 178 | Payback | 1 | 1 |
| brine | 180 | Brine | 1 | 1 |
| foulplay | 182 | Foul Play | 1 | 1 |
| tailwind | 187 | Tailwind | 1 | 1 |
| aquaring | 189 | Aqua Ring | 1 | 1 |
| trickroom | 190 | Trick Room | 1 | 1 |
| freezedry | 210 | Freeze-Dry | 1 | 1 |
| flyingpress | 218 | Flying Press | 1 | 1 |
| growth | 225 | Growth | 1 | 1 |
| toxicthread | 232 | Toxic Thread | 1 | 1 |
| finalgambit | 234 | Final Gambit | 1 | 1 |
| defog | 238 | Defog | 1 | 1 |
| revelation | 248 | Revelation Dance | 1 | 1 |
| partingshot | 255 | Parting Shot | 1 | 1 |
| strengthsap | 262 | Strength Sap | 1 | 1 |
| bodypress | 269 | Body Press | 1 | 1 |
| lashout | 272 | Lash Out | 1 | 1 |
| struggle | 277 | Struggle | 1 | 1 |
| ragefist | 309 | Rage Fist | 1 | 1 |
| lastrespects | 317 | Last Respects | 1 | 1 |

Secondary ("additional") effect ids:

| secondary id | meaning | anchor moves |
|---|---|---|
| 1 | status SLP | Relic Song |
| 2 | status PSN | Poison Sting, Sludge Bomb |
| 3 | status BRN | Fire Punch, Flamethrower |
| 5 | status PAR | Thunder Punch, Thunderbolt, Body Slam |
| 6 | status TOX | Poison Fang |
| 7 | status FRZ | Ice Punch, Ice Beam |
| 8 | confuse | Psybeam, Confusion |
| 9 | flinch | Bite, Headbutt, Stomp |
| 10 | tri | Tri Attack |
| 12 | noop | Pay Day |
| 13 | trap | Bind, Wrap, Fire Spin, Whirlpool |
| 21 | foe {"atk":-1} | Aurora Beam, Play Rough |
| 22 | foe {"def":-1} | Iron Tail, Crunch, Rock Smash |
| 23 | foe {"spe":-1} | Bubble Beam, Icy Wind, Mud Shot |
| 24 | foe {"spa":-1} | Mist Ball, Snarl, Moonblast |
| 25 | foe {"spd":-1} | Psychic, Shadow Ball, Energy Ball, Focus Blast |
| 26 | foe {"acc":-1} | Mud-Slap, Octazooka, Mirror Shot |
| 31 | noescape | Spirit Shackle, Anchor Shot, Thousand Waves |
| 35 | noop | Smelling Salts, Wake-Up Slap |
| 48 | foe {"spd":-2} | Seed Flare, Acid Spray |
| 54 | clearsmog | Clear Smog |
| 56 | breakprotect | Feint |
| 66 | direclaw | Dire Claw |
| 270 | self {"atk":1} | Metal Claw, Power-Up Punch |
| 271 | self {"def":1} | Steel Wing, Psyshield Bash |
| 272 | self {"spe":1} | Flame Charge, Esper Wing |
| 273 | self {"spa":1} | Charge Beam, Torch Song |
| 278 | self {"def":-1} | Clanging Scales |
| 279 | self {"spe":-1} | Hammer Arm, Ice Hammer |
| 280 | self {"spa":-1} | Make It Rain |
| 284 | noop | Burn Up, Double Shock |
| 285 | recharge | Hyper Beam, Giga Impact, Frenzy Plant |
| 290 | self {"atk":1,"def":1,"spa":1,"spd":1,"spe":1} | Ancient Power, Silver Wind |
| 292 | self {"atk":-1,"def":-1} | Superpower |
| 294 | self {"def":2} | Diamond Storm |
| 302 | self {"spe":-2} | Spin Out |
| 303 | self {"spa":-2} | Overheat, Draco Meteor, Leaf Storm |
| 308 | rampage | Outrage, Thrash, Petal Dance |
| 309 | self {"def":-1,"spd":-1} | Close Combat, Dragon Ascent |
| 313 | self {"def":-1,"spd":-1,"spe":-1} | V-create |
| 319 | struggle | Struggle |
| 4223 | screenbreak | Brick Break, Psychic Fangs |

**Unsupported move groups** (round 3): every move a roster species learns is supported.  What is left unsupported by name is the 51 Max / G-Max moves (effect 307, reason `dynamax`: the arena has no Dynamax) and six moves that no roster species learns (Sketch, Shell Trap, Octolock, Aura Wheel, Corrosive Gas, Extreme Evoboost; reason `not-yet` = "no Pokemon in this game can use it"; the check `r3/no-reachable-gap-is-only-not-yet` fails if that ever stops being true).  Full per-reason list in `engine_coverage.json`.

## 5. Abilities and items

* **Abilities**: 440 of 522 ROM ability ids are supported (round 2: +212, round 3: +55; the 82 left are the form-change, Terastal and party-rule abilities of ROMDIFF.md 8.7 and the ones no species has) (a name that appears twice in the table is supported at its first id only). Behaviour is keyed by the ability NAME (the ROM stores names and text only); weather setters, Intimidate / Download / Trace, type absorbers, contact punishers, speed / stat / damage modifiers, status immunities, Sturdy, Magic Guard, Poison Heal, Protean / Libero, Moxie / Beast Boost, Contrary / Simple / Defiant / Competitive, Mold Breaker, Unaware, Prankster / Gale Wings / Triage, trapping abilities, and doubles-only abilities that are inert in singles (Symbiosis, Telepathy, Stalwart, Healer; Quark Drive can never trigger because terrain and Booster Energy are unsupported). **Round 2 added** the innate-ability model (below), the custom SoulGold abilities (Soothing, Enigma, Omega, Aura Shield, Siegebreaker, the type-boost, priority-at-full-HP and Soul families, Uncanny / Breaking / Disquiet / Tangling ...), Magic Bounce, Mirror Armor, Parental Bond, Dancer, Disguise-style first-hit blockers, Multitype and ally-only abilities that are inert in singles. Every new number is labelled in `engine_abilities.js` (MEASURED = read from the real game, otherwise the ROM description text).
* **Innate abilities** (round 2): a species record has three innate slots; slot k is ACTIVE once the battle level reaches `E.innateLevels[k]` = 75 / 85 / 95 (MEASURED: the live record level is compared; see ROMDIFF.md section 7.1). `makeMon` stores the active ids in `mon.inn` (the field is OMITTED when none is active, so level-50 states are unchanged). `abFn(mon, hook)` merges the hooks of the main ability and every distinct innate: numeric modifiers multiply, priorities add, immunities and blockers fire on the first source that says yes, event hooks run for all sources; the same ability twice counts once. Switch-in abilities of one Pokemon run in the global order `SWITCH_IN_ORDER` (engine_exec.js; MEASURED, not main-before-innate). While an innate's hook runs, `mon.ab` is that innate's id, so its pop-up (`ability` event) names it and carries `inn: 1`. The opponent's view reveals only the innate that showed (`revealed.inn`), never the main ability.
* **Items**: 757 of 929 are supported (round 2: +88, round 3: +7, the four terrain seeds and the three Ogerpon masks): 541 items with hold effect 0 are inert (trivially supported), another 14 are inert in singles (Soothe Bell, Incense, Everstone, Lucky Egg, Ability Shield, Booster Energy, Terrain Extender, Destiny Knot ...) and 195 have an implemented effect (round 2 added the Gems (x1.3 once), Power items / Macho Brace / Iron Ball (speed x0.5), Absorb Bulb / Cell Battery / Luminous Moss / Snowball, Kee / Maranga / Jaboca / Rowap / Enigma berries, Lansat / Starf / Micle / Custap / Leppa, Sticky Barb, Metronome (+20 percent per use, final step), Punching Glove, Protective Pads, Safety Goggles, Utility Umbrella, Ring Target, Binding Band, Grip Claw, Float Stone, Red Card / Eject Button / Eject Pack, Blunder Policy, Room Service, Mirror Herb, Mental Herb, Throat Spray, Loaded Dice, Berserk Gene, Focus Band and the species items Soul Dew, the Orbs, Leek, Lucky Punch, Metal / Quick Powder, Deep Sea Scale / Tooth) (Leftovers, Black Sludge, Choice items, Life Orb, Focus Sash, Expert Belt, type items and plates, Muscle Band / Wise Glasses, Light Ball, Thick Club, Scope Lens, Wide / Zoom Lens, Bright Powder, Quick Claw, King's Rock, Shell Bell, Assault Vest, Eviolite, Rocky Helmet, Air Balloon, Weakness Policy, Heavy-Duty Boots, status / pinch / stat berries, resist berries, White Herb, Flame / Toxic Orb, weather rocks, Light Clay, Power Herb, Big Root, Covert Cloak, Clear Amulet, Shed Shell). Items are keyed by the ROM's **hold-effect id** and param byte; the type items and plates by name.
* `engine_coverage.json` lists the supported ids.

## 6. Rules integration (`rules.js`)

A ruleset gained a plain field `engine: { enforce }`, **true** in `arena-gen3-standard` (and so in every layered id). It is a field rather than a named layer so ruleset ids and team-code layer bits (`teamcode.js LAYER_BITS`) are unchanged; a ruleset OBJECT with `enforce:false` switches it off (tests only). Machine-readable reasons (messages in `RULE_CODES`):

`move.engine-unsupported` (detail `{move, why}`), `ability.engine-unsupported`, `item.engine-unsupported`, `species.engine-no-ability` (no ability slot the engine can run), `species.engine-no-move` (no runnable move at the level). Engine reasons are appended after every other reason, and a move that is already illegal / banned gets no engine reason (one fault, one reason). `legalMoves` lists only supported moves; `blankRec` picks a supported ability and throws `RangeError` for an excluded species.
New exports: `engineSupports(pack)`, `engineExcludedSpecies(pack, ruleset)` (the report: `[{id, why}]`), `engineCoverage(pack, ruleset)`.

**Final legal counts under `arena-gen3-standard`** (after FA2 round 3): species **1018** of 1038 (20 excluded, all for having no runnable ability: Zorua, Zoroark, Aegislash, Greninja, Zygarde, Palafin, Ogerpon Embody Aspect forms, Terapagos; was 1000 / 38 after round 2 and 925 / 113 before), moves **878** (reachable 796, and no species learns a move the engine cannot run), abilities **440**, held items **757**. The three presets (strict-champions, lv5, lv100) give the same counts.
The blockers among the excluded species: Illusion, Embody Aspect (4 each), Power Construct (3), Stance Change, Emergency Exit, Battle Bond, Zero to Hero (2 each), Allseeing Idol, Wimp Out, Delta Stream. The list of excluded species is in `engine_coverage.json` `speciesExcluded`.

Existing rules tests stay green with documented, narrow edits (`tools/pokemonarena_rules_test.mjs`): the six ruleset fingerprint pins changed because the ruleset gained the engine field (old values are in the comment), the standard-ruleset pin lists it, five new MATRIX cases cover the new codes, the independent differential oracle runs on rulesets with the engine layer off (it models the pre-engine rules), the brute-force legalMoves comparison filters by engine support, `blankRec`-for-every-species expects `RangeError` for excluded species, the determinism digest uses species 150 instead of 1553 (Raichu-Alola is excluded), and the purity test now expects the one extra import (`./engine_support.js`).

## 7. Deviations and things not modelled (read before trusting a number)

* Innate abilities ARE modelled since round 2 (section 5); a species whose innate is an ability the engine cannot run (Horse Council, and the form-change abilities) is still legal, and `engine_support.unsupportedInnates(pack, species)` lists what a level-75/85/95 battle would silently lose; the editor says so.  Friendship is assumed maxed (Return = 102 BP; Frustration = 1 BP).  Gender is modelled since round 3 (the personality value and the species ratio byte).  Weight comes from the pack (hectograms); Low Kick / Heavy Slam / Sky Drop use it.
* Doubles, Dynamax / Gigantamax, Mega evolution, Terastallization and the mid-battle form changes (Zen Mode, Stance Change, Illusion, Battle Bond, Power Construct, Zero to Hero ...) are not implemented (their items, moves and abilities are refused with a plain-words reason, see ROMDIFF.md 8.7 for why each is "not built" and not "impossible").  Terrain, Gravity, primal weather, Neutralizing Gas, the Ruin abilities, frostbite, gender, Baton Pass, Perish Song and every move a roster species learns ARE implemented since round 3 (Pursuit runs as a plain 40 BP hit without catching a switching foe; Magic Bounce / Magic Coat and Mirror Armor are implemented since round 2).  **Z-moves** are not a mechanic here: their records exist in the move table and run as plain damaging moves, so the engine counts them as supported, but no legal species learns them and Metronome never calls them (nor Max Guard).
* Metronome's ban list is the classic one (Counter, Mirror Coat, Protect family, Focus Punch, Trick, Transform, ...) plus every Z-move and Max Guard; it is **not** the full modern list, so Metronome can call a few moves the newest games forbid (Celebrate, Happy Hour, Hold Back, Snap Trap, Thunder Cage, Steel Beam, ...).
* **Wring Out / Crush Grip** use `max(1, floor(120 * targetHP / targetMaxHP))`: the maximum is **120**, not 121. RESOLVED by FA2 against the real game (the power that reproduces the real damage at HP 192/192, 96/192, 32/192 and 8/192 is 120, 60, 20 and 5; the old `1 + floor(...)` gave 21 and 6 at the last two).
* Hidden Power: the **type** comes from the IVs by the Gen 3 bit rule (`stats.hiddenPower`, unverified for the hack); the power is the ROM's fixed 60.
* Speed order is fixed at the start of the turn. Protect does not fail for the last mover. Disable / Encore / Taunt lengths (5 / 4 / 4 including the turn used) and Wish / Future Sight timings are assumed. Future Sight uses the user's stats at use time and ignores abilities / items.
* Sleep: the counter is the number of move attempts lost (1-3, Rest 2); a mon that wakes acts that turn. Confusion damage is plain (no burn, STAB, ability or item modifiers).
* Sheer Force removes all secondary effects including self-stat drops. Life Orb recoil is skipped under Sheer Force / Magic Guard. Transform copies stats, types, ability and moves (5 PP each) and reverts on switch-out or faint; it does not change the displayed species.
* Crit odds are decoded from the ROM (`rom-static`, section 3) and, with the crit multiplier, the accuracy-stage table and the multipliers listed in section 10, measured in the real game (`rom-live`); every row still labelled `assumed` is an unverified expansion default. Burn Up / Double Shock remove the matching type after the hit.
* A fainted Pokemon has no status (cleared silently when it faints). Transform copies the target's stat stages and reports them on its `copy` event.
* **Ability traps** (Shadow Tag, Arena Trap, Magnet Pull) do not hold Ghost types or a Shed Shell holder. The trap check is made when a switch is chosen and again by `requests()`.
* **Information model**: only `viewFor()` is filtered; events, snapshots and `previewDamage()` are full-information (section 1).
* Rock-Head style recoil immunities, weather-immune abilities and Mold Breaker are flag-based: Mold Breaker is active only for the duration of its own move.
* Browser: parity was verified on HeadlessChrome 156 (V8) only.

## 8. Tests

`node tools/pokemonarena_engine_test.mjs` (exit 0 = pass; `ARENA_UPDATE_GOLDEN=1` rewrites the two JSON files; `ARENA_FUZZ`, `ARENA_SKIP_MUTANTS=1`, `ARENA_SKIP_BROWSER=1`; the browser parity step starts its own devserver on 8096 and headless Chrome on CDP 9285, muted, throwaway profile). Last full run before FA2: **444 passed, 0 failed**; after FA2 round 1: **456 passed, 0 failed**; after round 2: see the report below (557 checks with `ARENA_SKIP_BROWSER=1 ARENA_SKIP_MUTANTS=1`) (139 mutants, all killed, 12 of them new named FA2 mutants `H01..H12`; 14 new named hand-computed checks `fa2/*`); the Node-vs-Chrome parity step could not take the machine-wide browser lock in three attempts (other agents held it for more than 15 minutes each) so the parity of the NEW golden digest `cb45262fcf748400` in Chrome is not re-verified.

* **419 hand-computed checks** (suites 1-4: arithmetic, the ROM-static tables, the classification evidence, damage, order, accuracy, crits, status, weather, hazards, one scenario per move class, ~60 ability / item, the API, the rules layer; suite 4 = one named check per defect the two adversarial verifiers proved, plus the checks for mechanics that were pinned by the golden digest alone). Scripted-RNG tests fail when the call order changes.
* 40 golden battles (hashes only) and a Node-vs-Chrome parity check of the same digest.
* a 2000-battle fuzz between random LEGAL teams with invariants (0 <= hp <= max, PP and stage bounds, fnt flag, event stream equals state, termination, hash stable across snapshot/restore twins run in lock-step, replay equality), plus 90 battles with random forfeits and random advance timing whose replay must equal the live battle.
* **127 source mutants, all killed** (the implementer's 45, the two verifiers' own, and one per fix); 65 of them are flagged `named` and must be killed by a named suite check - the golden digest changing or a crash does not count. The unmutated twin through the same loader is quiet and reproduces the golden digest. Equivalent mutants (no observable difference) are listed, not hidden, in `tools/pokemonarena_engine_mutants.mjs`.
* a poisoned pack (one type-chart cell flipped) fails a hand-computed check and changes the golden digest; a corrupted pack is refused with `pack-invalid`; 28 tampered snapshots are each refused with `snapshot-invalid`.
* `previewDamage` is checked to change no state hash, event or RNG for every supported move on two mid-battle states, and to work on a deeply frozen battle.

## 9. api_changes (what a consumer of the engine - battle scene, CPU, netplay - may observe differently after the E1 fix pass)

Signatures, return shapes and event shapes are unchanged; every throw is still the named `EngineError`. Observable differences:

1. **`previewDamage` is pure.** It no longer touches the battle (it used to change the RNG / events / state for Present, Magnitude, Echoed Voice and Struggle and could even heal the foe). Random-power moves return their expected power; fixed-damage moves (Seismic Toss, Sonic Boom, Super Fang, OHKO, Psywave, ...) return the fixed value instead of a meaningless formula number; status moves return 0 (was a small number); a bad side or move id throws `EngineError` `bad-argument` (was a `TypeError`).
2. **`restoreBattle` / `stepBattle` validate fully** and throw `EngineError` (`snapshot-invalid`, `snapshot-version`, `snapshot-rom`, `bad-argument`) where a malformed snapshot used to restore silently or throw a `TypeError`. `snapshot()` gains `packFp` and `hash` fields (additive).
3. **`createBattle` validates the pack and every record**: a corrupted pack throws `pack-invalid`; a null / malformed record, a move id that is not in the pack or that the engine cannot run (now also with `validate:false`) throws `team-invalid` (was `TypeError` or a crash mid-battle).
4. **Forfeit.** `choose(side, forfeit)` first resolves any phase in which every needed choice is already in, then records the forfeit (events of that resolution arrive with the next `advance()`); a side locked into a charge / recharge / rampage may forfeit; `replay()` now equals the live battle for every forfeit placement. `requests()[i].canForfeit` is now accurate (false after a real choice or a forfeit). A driver that does `choose(forfeit); advance()` behaves as before.
5. **`advance()` runs turns in which nobody has a choice** (both sides locked): it no longer stops there with `ready()` true and two `wait` requests, so `pending()`-style drivers never stall; the events of those turns come back in the same call.
6. **`choose` never throws** for a hostile choice object (getter, Proxy): it returns `{ok:false, code:'bad-choice'}`; the choice is read once.
7. **Event content.** New `immune` reason `why:'prankster'`; `copy` events for Transform carry `sg`, `ty`, `ab`; fainted Pokemon keep no status (state only, no new event); Explosion / Self-Destruct now faint the user on a miss / Ghost / Protect / semi-invulnerable target (same `faint` event, same `damage` event with `src:'explosion'`); a frozen target hit by Fire now gets a `status-clear` with `why:'thaw'`.
8. **`viewFor(side)` during team preview** lists the whole foe team (species, level, types) instead of only slot 0; `foe.hidden` entries return once the picks are made.
9. **Metronome** no longer calls Z-moves or Max Guard (`callablePool()` shrinks accordingly).
10. **Rules of the game that now differ**: Shadow Tag / Arena Trap / Magnet Pull do not trap Ghost types or a Shed Shell holder (`requests().trapped`, `choose` code `trapped`); Toxic from a Poison-type and Stomp-family moves vs a Minimized target skip the accuracy roll; Sheer Cold's base accuracy is 20 for non-Ice users; Earthquake / Surf / Gust / Stomp-family damage doubles in the cases listed in section 3.
11. Coverage numbers: `engine_coverage.json` gained `movesReachable` (609) and `movesSupportedButUnreachable` (79); every previous count and list is unchanged (688 / 173 / 662 / 925).

## 10. Verified against the real game (stage FA2)

`pokemonarena/ROMDIFF.md` is the full account; this is what a consumer of the engine needs to know.

* **How**: the ROM's own battle code is run in the first-party mGBA core (OR1's oracle, `tools/pokemonarena_rom_oracle.mjs`) with a forced RNG (the game's sfc32 state is rewritten before every frame)
  and compared with the engine: 468 damage scenarios x 16 rolls (6,837 exact roll comparisons) all equal; 367 one-to-eight-turn state scenarios (364 compared, 3 excluded as unsupported by the rules layer) all equal;
  37 exact probability probes (accuracy thresholds, crit thresholds, paralysis / confusion / thaw chances) all equal. `node tools/pokemonarena_rom_diff_test.mjs` repeats it (and trips when an engine constant is changed).
* **Data**: 50,059 cells of the move / species / item / ability / nature / type-chart / experience tables, the stat-stage and hold-effect constants, decoded independently from table bases re-derived from the
  ROM's literal-pool references: 0 mismatches.
* **Fixed because of it** (before -> after in ROMDIFF.md): the accuracy / evasion stage table (`rom-live`, `ACC_STAGE_PCT`), dual-type effectiveness (one combined multiplier, not a floor per type), Life Orb 5325,
  Wring Out / Crush Grip maximum 120, toxic = floor(max/16) * counter, the weather expiring without damage on its last turn, Flame / Toxic Orb acting after the status damage, HP berries also firing at the
  end of the turn, confusion self-hit exactly 33 percent, Trick-or-Treat / Forest's Curse adding a type. These changed the 40-battle golden digest (`engine.golden.json`, updated deliberately).
* **Event shape changes a consumer can see**: `type-change` from Trick-or-Treat / Forest's Curse carries `ty: [the added type]` and `add: 1` (the full list is in the state: `m.v.ty` may now hold three types);
  `weather-end` is emitted at the start of the end-of-turn weather step (the counter drops first), before the weather damage and the weather-dependent ability / item residuals, instead of after them; a Flame / Toxic Orb status is announced after the residual damage events of the turn.
* **Not verified** (so still `assumed`): see ROMDIFF.md sections 4 and 7.4 - entry hazards, forced switches, random-power moves, the chance and draw-order abilities, the rest of the `assumed` rows. (Innate abilities and the switch-in order WERE verified in round 2: section 5 and ROMDIFF.md 7.1.)

## 11. Round 2 api_changes (stage FA2 round 2: innates and the added abilities / items / moves)

Signatures are unchanged; additive observable differences:

1. **State**: a Pokemon record may carry `inn` (array of 1..3 active innate ability ids; absent when none is active - always absent at the default battle level 50), `sw` (Supersweet Syrup used), `dg` (a Disguise-style cloak is gone); `rev.n` (innate ids that showed); new volatile keys `chgd` (Charged), `ss` (Slow Start turns), `swt`, `lans`/`micle`/`custap`, `metro` {mv,n}, `stk`/`stkd`/`stks` (Stockpile), `nm` (Nightmare), `elec` (Electrify), `mcoat` / `snatch` (this turn only), `roll` {mv,n} (Rollout), `ash` (Aura Shield used), `mhq` (Mirror Herb queue). `validateSnapshot` knows all of them.
2. **`ability` events** gained `inn: 1` when the ability that showed is an innate (the `ab` field then names the innate). New `fx` codes (free text for the scene director, one per ability): the ability's name in kebab case, e.g. `uncanny`, `breaking`, `last-stand`, `magic-bounce`, `mirror-armor`, `dancer`, `aura-shield`, `disguise`, `windburst`, `showtime`, `restoring`, `rooted`, `wishmaker`, `screen-cleaner`, `slow-start`, `glacial`, `electromorphosis`, `wind-power`, `shockwiring`, `wind-rider`, `cheek-pouch`, `sand-spit`, `toxic-debris`, `pickpocket`, `multitype` ...
3. **`copy` events** gained `how` values `ability-set` (Worry Seed / Simple Beam), `role-play`, `skill-swap`, `power-swap`, `guard-swap`, `heart-swap`, `psych-up`, `mimic`, `mirror-move`, `nature-power`, `mummy`, `wandering-spirit`, `lingering-aroma`; `stats-reset` gained `inverted: 1` (Topsy-Turvy). `volatile` events gained `v` values `charged`, `nightmare`, `electrify`, `magic-coat`, `snatch`, `leech-seed` (Plantation); `screen` gained `k: 'luckyChant'`; `trick` events gained `how` values `magician`, `pickpocket`, `sticky-barb`; `item` events gained `fx` values `recycle`, `harvest`, `focus-band`. `noop` events gained `why: 'bounced'` and `'snatched'`. `hazard` events can come from Toxic Debris.
4. **Order of the checks** (observable): an ability that absorbs a move (Ritualist, Volt Absorb, ...) now acts BEFORE the type chart's immunity (MEASURED), so a Ghost move into a Normal-type Ritualist heals instead of printing "no effect"; the type-chart product can be rewritten by an ability (Omega, Inversion, Acidic: new hooks `typeProd`, `typeProdDef`, `typeMult`, `typeMultDef`).
5. **New hook names** for `engine_abilities.js` / `engine_items.js` authors: `afterHit`, `atkSource`, `aura`, `auraBreak`, `sunMoves`, `firstHit`, `statusMoveBlock`, `magicBounce`, `priorityBlock`, `reactive`, `stall`, `stygian`, `quickDraw`, `sureHit`, `fireBreaker`, `waterBreaker`, `extraType`, `copyBoost`, `reflectDrop`, `dancer`, `afterPriority`, `noContact`, `sleepTurns`, `noFatigue`, `tireless`, `ppDrain`, `parental`; items: `mirror`, `mental`, `onMiss`, `onTrickRoom`, `band`, `goggles`, `umbrella`, `ringTarget`, `bindBand`, `gripClaw`, `weightHalf`, `loadedDice`. Sturdy-style hooks may return the HP the holder is left with (Stone Face = a quarter).
6. **`engine_support.js`** gained `REASON_TEXT`, `abilityReason(pack,id)`, `itemReason(pack,id)`, `moveReason(pack,id)` (each `{code, why}` with the player-facing sentence) and `unsupportedInnates(pack, species)`. `engineSupport(pack).moveReasons` keeps its raw codes.
7. **Coverage numbers** (`engine_coverage.json`): moves 747 (was 688), reachable 674 (was 609), abilities 385 (was 173), items 750 (was 662), engine-legal species 1000 (was 925).
8. **Goldens**: `engine.golden.json` digest `cb45262fcf748400` -> `55da932d3ad7ecde` (the random legal teams of the 40 golden battles draw from a bigger pool; deliberate). `scene.golden.json` (36 hashes of team-preview / intro frames) was re-baselined for the same reason.

## 12. Round 3 api_changes (stage FA2 round 3: terrain, Gravity, gender, frostbite, primal weather, Neutralizing Gas, Ruin, and the rest of what a legal team can hold)

Signatures are unchanged; additive observable differences.  Everything below was read from the real game first (ROMDIFF.md section 8).

1. **State** (`snapshot()` / `restoreBattle`): `s.tn = [id, turns]` (terrain: 1 Grassy, 2 Electric, 3 Misty, 4 Psychic, 5 Scorched Field; absent when none), `s.gv` (Gravity turns), `s.pw` (primal weather 6 heavy rain, 7 harsh sun, 8 strong winds), `s.ms / ws / wr / mr / fl / ion`
   (Mud Sport, Water Sport, Wonder Room, Magic Room, Fairy Lock, Ion Deluge turns), `s.lm` (last move used, Copycat), `s.bp` (a Baton Pass / Shed Tail hand-over), `s.fu` (Fusion Flare / Bolt this turn), `s.pk` (`'revive'` while a Revival Blessing choice is open).  A Pokemon record may carry `g`
   (gender, 1 female, 2 none; omitted for a male, so older states are unchanged) and `rb` (Reborn used).  The record of a team member (`rec.gender`) is read by `makeMon`.  New volatile keys (all validated in `engine_validate.js`): `torment imp gastro mir pt grudge powder rage glaive salt ate mim be inf hb emb tc tele lf syrup perish so um bide cud pend raised held tar fn`
   and `ramp.up / ramp.nc`.  At the default battle level 50 and without these features the state of an old battle is byte-identical.
2. **Status**: code **7 = frostbite** (`status-set` / `status-clear` events, `st` in the view).
3. **Events**: new `t` codes `perish` (a perish count), `pp-drain`, `revive`; `field` events with `k` in `grassy-terrain electric-terrain misty-terrain psychic-terrain scorched-terrain` (and `on: 0/1`), `gravity`, `mud-sport`, `water-sport`, `wonder-room`, `magic-room`, `fairy-lock`, `ion-deluge`, `court-change`;
   `cant-move` reasons `gravity`, `love` (infatuation), `torment`, `imprison`, `heal-block`, `throat-chop`, `sky-drop`, `lost-focus`; `volatile` names `torment imprison embargo heal-block gastro-acid miracle-eye laser-focus perish-song power-trick tar-shot sky-drop ...`; many new `ability` `fx` codes
   (free text for the scene director, one per ability); `weather` ids 6 / 7 / 8 for the primal weathers; `item` events with `fx: 'fling' | 'natural-gift' | 'knocked-off' ...`.
4. **View** (`viewFor`): `terrain: { id, turns }` and `gravity` appear only while they are on; `weather.id` can be 6 / 7 / 8; the opponent's view of a Pokemon shows the infatuation key `inf` (it is public).
5. **Requests**: a `switch` request with `reason: 'revive'` (Revival Blessing) lists the FAINTED party members as `switches`; a legal choice is `{ kind: 'switch', slot }` of one of them (a living slot is refused with `not-fainted`).  Any consumer that already handles the faint-replacement switch request handles this one.
6. **Rules / support**: `rules.js` messages for `move / ability / item .engine-unsupported` now say WHY in plain words (`<name> cannot be used in the arena, because <reason>.`) and carry `reason` in the detail next to the raw `why`; `RULE_CODES` for the five engine codes no longer say "yet".
   `engine_support.js` `REASON_TEXT` lost the codes that no longer exist (terrain, gender, gravity, primal-weather, ruin, neutralizing, frostbite, doubles-only, ui, switch-out) and gained `party-rule`; `abilityReason / itemReason / moveReason / unsupportedInnates` keep their shape.  `E.innateLevels` is still 75 / 85 / 95.
   The editor shows the reason beside the item, the move and the ability slot, and its innate sentence now says the innates work from level 75 / 85 / 95 "as in the game" and names the ones the arena cannot use.
7. **Coverage numbers** (`engine_coverage.json`): moves 878 (was 747), abilities 440 (was 385), items 757 (was 750), engine-legal species 1018 (was 1000).  No roster species learns an unsupported move; the abilities and items that stay unsupported are listed in ROMDIFF.md 8.7.
8. **Goldens**: `engine.golden.json` digest `55da932d3ad7ecde` -> `e73e7ccc7a32a424` (the random legal teams of the 40 golden battles draw from a bigger pool and the new mechanics change some of them; deliberate); `scene.golden.json` re-based by FA2: only team content moved (see ROMDIFF.md 8.5, the old preview frame was
   re-rendered from the round-2 support sets and reproduces the old hash `2911261c...`; the NEW tree with the OLD teams reproduces it too).  `anim_scene.golden.json` was not touched.
9. **What a form-change ability needs** (not built, see ROMDIFF.md 8.7): a mid-battle `formChange(mon, species)` that recomputes `st` / `ty` / `ab` from the record, a `form-change` event, and a sprite swap in the scene director.  Mega Evolution, Z-Moves, Dynamax and Terastallization are in the ROM's data and text but not in the engine.

## 13. Round 5 api_changes (stage FA2 round 5: the events AN1's sweep asked for)

No battle rule changed; the engine now EMITS what the real game prints (ROMDIFF.md section 9, every line MEASURED).

1. **Entry announcements**: `{ t: 'ability', s, m, ab, fx }` with fx `pressure`, `mold-breaker`, `turboblaze`, `teravolt`, `dark-aura`, `fairy-aura`, `aura-break`, `weather-lock` (Cloud Nine, Air Lock), at every entry, in SWITCH_IN_ORDER (innates carry `inn: 1`).
   `frisk` carries `it` (the foe's item id; nothing when the foe holds none), `forewarn` carries `mv` (the foe's move id; Forewarn is an innate of every holder, so level 75 or more), `anticipation` has no extra field. Frisk / Forewarn make the foe's item / move revealed to the holder's player (`rev`).
2. **`fx: 'slow-start-end'`** at the end of the fifth turn on the field (the residual, `m.v.ss` 1 to 0).
3. **`{ t: 'weather-tick', w: 8 }`** every turn while the Delta Stream winds blow.
4. **`winds: 1` on the `damage` event** whenever the winds clamp fired on that hit (a Flying defender the move was super effective against). It is NOT "instead of super effective": the real game prints "weakened the attack" and then still the effectiveness line of what is left (still super effective for Rock into Bug/Flying, not very effective for Rock into Steel/Flying).
5. **Rapid Spin**: `volatile-end` with `why: 'rapid-spin'` for `v: 'trap'` (carries `var`) and `v: 'leech-seed'`, after the Speed `stat-change` and before the hazard clear.
6. **What moved in the goldens**: `engine.golden.json` digest `e73e7ccc7a32a424` -> `9db8376a764f382e`; 8 of the 40 battles (i = 1, 3, 18, 19, 20, 24, 29, 30) have extra events, 7 of them (all but 24) a new state hash because the opponent now has learned an ability / item / move; `turns` and `winner` are identical in all 40 rows.
   `engine_coverage.json` and `scene.golden.json` did NOT move (the scene golden battle contains none of these events). `anim_scene.golden.json` is AN1's: any battle that holds one of these abilities, Delta Stream or Rapid Spin plays more events now.
7. **Tests**: engine 664 passed / 0 failed (175 of 175 mutants, 8 new V01..V08; Chrome parity); scene_events 45/0 and event_codes 58/0 (rows added for the 12 ability fx, `weather-tick:w=8`, `volatile-end:v=leech-seed`); scene 39/0; rules 259/0; editor 233/0; battle_ui 178/0; fidelity 145/0.

## 14. Round 9 api_changes (the free switch: "Will you switch your Pokemon?")

Everything below is additive and only observable when `createBattle` / `createMatchController` is given `freeSwitch`; a battle without it has the state, events, requests, choice log, hash and digest it always had (`engine.golden.json`, `scene.golden.json`, `anim_scene.golden.json` and the scene-event / event-code goldens were NOT touched and still pass; the new test compares a battle with `freeSwitch: false` / `[false,false]` to one that never heard of the option, hash for hash).

1. **Option.** `createBattle({ freeSwitch: true | false | [boolean, boolean] })` (anything else `bad-argument`); `replay({ freeSwitch })` takes it too; `createMatchController({ freeSwitch: true })` turns it on for a human seat whose opponent is a CPU and for no other seat (`matchctl.js`).
2. **Request.** `{ phase: 'switch', reason: 'free', switches, next, canForfeit }`, `next = { slot, sp, name, level } | null` (the foe's chosen replacement). `REQUEST_PHASES` is unchanged (it is a `switch` phase); a consumer that treats every `switch` request as a forced replacement must look at `reason` (`ai.js` answers a `free` request with `stay`; the scene asks the question).
3. **Choice.** `{ kind: 'stay' }` (in `CHOICE_KINDS`), wire word `7`; `decodeChoice(7)` was `null` before. Logged like any choice; accepted only from the side being offered.
4. **State.** `s.fs` (`[0|1, 0|1]`, only when some side is offered), `s.fo` (the side being offered while the offer is open; never present in a finished battle). Both are validated by `restoreBattle` (`fs` shape, `fo` only with `fs[fo] = 1` in the faint phase with both sides asked). `ENGINE_VERSION` is unchanged (no existing state changed shape).
5. **Events.** No new event code. A free switch is a `switch-out` and a `switch-in` of the offered side (then its entry events), and then the foe's `switch-in`, before the `turn` event of the next turn.
6. **Turns and statistics (what was done, and why).** A free switch is **not a turn**: `s.turn`, the `turn` events, `battle.turn`, `Mon.v.turns` (the turns since a Pokemon came in) and the turn cap are exactly as if the player had said NO; the new Pokemon is credited a turn on the field when the next `turn` event begins, like a Pokemon that came in as a replacement. The match summary (`match_stats.js`) is unchanged and counts the switch as a **switch** (`side.switches`, the career's `totals.switches`: it is one: a recall and a send-out), never as a turn, so `summary.turns`, the career's `turns`, `bests.fastestWin` / `longestBattle` and the walkover rule read the same numbers they would have without the free switch. `pokemonarena_switch_test.mjs` section C checks `summary.turns === battle.turn`, `sides[0].switches` = the `switch-out` events and the turns on the field against the turn events over 12 real battles with free switches.
7. **Not modelled / deliberate.** The answer is not timed (an online battle has no question at all). The offer is made only after the foe has chosen its replacement, so the CPU never adapts to the Pokemon you bring in (as in the game, where "is about to send out X" is said before you choose). A trapped Pokemon (Mean Look, binding, Ingrain, Fairy Lock) is not offered the switch. The question is not asked when your own Pokemon fainted as well. Tests: `node tools/pokemonarena_switch_test.mjs [--mutants]`, `node tools/pokemonarena_switch_page_test.mjs [--mutants]`.

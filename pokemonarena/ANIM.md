# ANIM.md -- the ROM move-animation engine (AN2)

Plays the animations that live in the Pokemon SoulGold v1.1.1 ROM (moves, general, status, special, backgrounds) with the ROM's own sprite
sheets, palettes, backgrounds, timings and sound-effect cues. Nothing is drawn by hand; nothing from the ROM is committed (offsets, hashes
and code only; every picture is decoded at runtime from the ROM the page already holds).

Files: `js/battle_sys.js` (round 3: the battle's system animations, see Round 3), `js/move_anim.js` (animator + battle-state seeding), `js/anim_cpu.js` (ARMv4T interpreter + BIOS HLE), `js/anim_ram.js` (GBA memory
map / DMA / open bus), `js/anim_ppu.js` (OBJ / BG / blend / window renderer), `js/anim_script.js` (static script decoder), `js/anim_sound.js` (song-length and cry-length
estimates from the ROM's own song / cry tables), `js/anim_coverage.json` + `js/anim.golden.json` (statuses / hashes only), tools `tools/pokemonarena_anim_*.mjs`
(`_oracle_batch / _compare / _scenarios / _probe / _stat / _diag`, `_readset`, `_coverage`, `_sheet`, `_test / _cpu_test / _ppu_test / _compare_test`, round 6: `_field_compare`).

## Round 9 -- the free switch ("Will you switch your Pokemon?") adds no event and no prepared effect

The question is a REQUEST of the engine (`{ phase 'switch', reason 'free', next }`), asked by the scene from `idle()`, after everything the events queued has played: no event code is new (`EVENT_CODES` is unchanged), the director queues nothing for it, and `prepareSys` has nothing to prepare, so the stale-picture rules of Round 7 / 7b have nothing to say about the question itself. What follows an answer is ordinary: a YES gives `switch-out` / `switch-in` of the player's Pokemon and then the foe's `switch-in` (a recall, a send-out and a send-out), which are prepared and projected like any other switch. **Checked** by `tools/pokemonarena_anim_scene_test.mjs` (group `system/free-switch`): battles in which the player answers YES or NO at every offer, with the stub animator, and the same with the UI-driven answers, each recall / send-out / hit / faint run begins with the Pokemon the screen shows (0 prepared again), the log of animation problems is empty. Under BATTLE STYLE: SET the scene answers `stay` the moment the choice that opened the offer has gone in (`autoStay`, called from `submit` and `idle` before the events are read), so the replacement's send-out arrives in the same batch as ever: the frames of a battle on SET are the frames of the battle before the feature (`pokemonarena_switch_test.mjs`, 6 battles compared frame by frame, events too). Had the answer been left to `idle()` the replacement's events would have arrived a batch later (2 to 4 frames, and the foe's send-out effect would not be prepared during the faint).

## Round 8 -- "the system engine pool is exhausted" (the prewarm kept an engine), and a benign re-prepare is a note, not a problem

**Seen by a review of Round 7:** with the real ROM animator, battles on seeds 2 and 3 logged `system 6 prepare() threw: the system engine pool is exhausted: all 3 engines hold prepared runs`. A `prepare()` that throws means that effect is not prepared ahead
and starts late (the previous picture is held, `animInfo().waited`).

**Reproduced, and old.** `ARENA_ANIMATOR=real`'s setup (the real `createMoveAnimator`, the scene's `sysClock: cpu.icount / 1000`, i.e. 1 ms per 1000 ROM instructions, a 3v3 AI battle in which the player switches on purpose up to 3 times, as the Round 7 live group does): seeds 2, 3,
4 and 5 each log it once (ticks 506, 1567, 513 and 715; seed 5 also for the faint, id 4, in the same call), and the committed HEAD tree (a copy without any Round 7 change) logs it at the same ticks, so it is not a Round 7 regression. Over seeds 2-10 and 12 on the HEAD tree
every battle logs 1 or 2 of them at that clock, none at a clock 10 and 50 times faster (`cpu.icount / 10000`, `/ 50000`; 10 seeds each). In headless Chrome the browser suite's own battle (`ARENA_BROWSER=1`: 25 system runs over 7,374 frames) has an empty log and its prewarm finished during the opening (210 ms in 60 slices), so the pool never filled there; how often a slow phone sees it is NOT measured.

**Cause (read off the pool at the moment of the throw, `animator.system.slots`).** The three engines were held by: the slide-in prepared ahead (id 2, not begun), the **opening's prewarm** (`'battle'`, `prepDone` false) and the recall that was the current step and still waiting for its own handle (id 3, not begun). The hit
(id 6) wanted a fourth. The prewarm is created with the opening (`startSysIntro`) and keeps its engine until its pre-roll finishes (`battle_sys.js` releases it in the `finish` phase), but `pumpSys` serves the event handles before it, so while events keep being prepared it gets no slice and holds
the engine for ever; and `prepareSys`'s limit of two prepared events ahead counts the queue only, not the waiting current step and not the prewarm. On a machine fast enough to finish the prewarm during the opening (the clocks above) the pool never fills.

**The fix (scene.js `prepareHandle`).** A `prepare()` that throws while a prewarm is still pending disposes the prewarm (it only fills the battle-state cache, which the first event's own pre-roll fills as well: `battle_sys.js` `cachePut('a', ...)` in the `hidden` phase of every plan) and prepares again once; a second throw is
logged as before. Nothing else changes. Seeds 2-5 then log nothing, carry one note each (`system 6 prepare() threw (the system engine pool is exhausted: all 3 engines hold prep): the prewarm was given up and it was prepared again`), and wait fewer ticks (seed 2: 12335 -> 11682, 3: 15442 -> 15100,
4: 10647 -> 10191, 5: 7051 -> 6420: the effect is prepared in time instead of at its start). Not proved: that the frames of an effect prepared after a given-up prewarm equal those of one prepared after a finished prewarm (the cache is meant to be bit-exact, `anim_sys_test`), they were not diffed here.

**The log is for problems.** The Round 7 re-prepare (`restale`) used to be written to `animInfo().log`, which the stub-animator test and the browser suite require empty; it is benign (a brief hold, never a wrong picture). It is counted (`restale`) and noted in the new `animInfo().notes`, as is a given-up prewarm (`shed`).
The tamper groups assert that the notes carry one `system N stale: ...` line per re-prepare and the log stays empty; the browser suite asserts `log` empty and `notes.length === restale + shed` with only those two kinds of line.

**Proof (`tools/pokemonarena_anim_scene_test.mjs`).** The stub animator has a pool model (`poolEngines`: a free engine, else a finished run's, else a live run's, which counts as an eviction, else it throws as the real one does; the prewarm holds one until its handle is ready) and a handle that needs 500 advances
(the prewarm starves, as on the slow clock). Group `system/pool` (4 battles, the player switching): the log is empty, the prewarm handle was disposed and `shed` equals the pool's refusals, no live run was evicted, same battle (hash, hit and faint hooks once per event), and a pool of four engines gives nothing to give up. With the fix in, the stub pool refuses
a prepare (and the prewarm is given up) on all of seeds 1-8 at 500 advances per handle, on seeds 2 and 4-7 at 300, and never at 200 or fewer; without the fix each refusal is a `prepare() threw` log line. Four new mutants (a re-prepare written to the problems log; no prewarm given up; given up but not prepared again; forgotten instead of disposed) each fail a named check.
A 400-battle re-run of the Round 7 live group on the current scene (seeds 1-400, up to 3 voluntary switches): 4,884 hit / faint runs and 3,611 send-out / recall runs, 1,162 switches, every run begins with what the screen shows, 0 prepared again.

## Round 7 -- the stale picture: a hit or a faint played for the Pokemon that was switched OUT, and a health bar that jumped back up

**The report (the player, playing the real page):** "when pokemon get hit, faint, or after they switch out and the new pokemon gets hit, it will show the old pokemon briefly ... that's the same time when the health bars get fucky."

**Reproduced, not guessed.** A headless Chrome records every frame the battle page draws (`putImageData`) while the engine's own AI plays a 3v3 with a voluntary switch on turn 1 (seed 777, default speed), and a contact sheet of the frames
shows it: during the Discharge animation the switched-in Jirachi is on the field; on the FIRST frame of the hit blink on Jirachi the picture changes to **Quilava** (the Pokemon that was recalled), with "Quilava 133/133" and a full bar, and
stays Quilava for all 41 frames of the blink. The second cause shows in the scene's own diagnostics (a hit / faint prepared for the other Pokemon's HP *before* a drain that was already playing): `foe.hp 72->61`, `foe.hp 55->47`.

**The mechanism.** The scene PREPARES the next hit / faint ahead of time (`prepareSys`, round 4: the ROM's hidden pre-roll costs 100-250 ms, so it runs in slices while earlier steps play) and seeds it from "what the scene displays now"
(`eventCtx`). But `S.disp` (the displayed Pokemon) only changes when a send-out / recall / faint effect FINISHES (`finishSysEvent`), a recall leaves the slot empty with the recalled Pokemon in `A.lastMon`, and a drain writes the Pokemon's own
`hp` on EVERY frame of the bar (`runStep` 'drain': `d.hp = v`, `v` from `hpBarStep`; the end value only on arrival). So an effect prepared behind a switch was seeded from the OLD Pokemon (its species, its bar) and was then played, as
prepared, for the new one (`sysEventStart` never looked at the picture again); and an effect prepared while a bar was draining was seeded with a MID-DRAIN value of the OTHER Pokemon's bar, neither the old bar nor the new one (the logged
`foe.hp 72->61` is such a partial value). The queue-only guard of round 4 ("a bar drain before it changes the HP the picture must show") never saw the drain that was *currently* playing, and exempted faints.

**The fix (scene.js), two layers:**

1. **Projection.** `prepareSys` walks the queue with a projection of the display (`projectStep`): the step playing now and every step ahead of the event apply their effect (a send-out puts the new Pokemon in the slot, a recall empties it, a drain
   sets the bar's end value) and `eventCtx` seeds an effect from the projected Pokemon, so the picture is right the first time. Round 7 did this for a HIT and a FAINT only; **Round 7b (below) extends it to every Pokemon a
   send-out and a recall draw.**
2. **A re-check at start.** `sysEventStart` compares the prepared effect's seed (`ctxSig`) with what is on screen when it begins and prepares it again if they differ (a brief hold of the previous picture, `A.waited`, never a wrong
   picture). Counted in `scene.animInfo().restale` and noted in `scene.animInfo().notes` as `system 6 stale: foe.hp 72->61` (Round 8: it used to be written to `animInfo().log`, the list of animation PROBLEMS that the
   tests and the browser suite require empty; a re-prepare is benign, so it is a note now). (Round 7: hit / faint; Round 7b: all four kinds.)

**Proof.** `tools/pokemonarena_anim_scene_test.mjs` (stub animator): over the 12 battles of its live group, in which the player switches on purpose (35 voluntary switches), every one of the 145 hit / faint runs BEGINS with the Pokemon (species, level, HP) the scene shows at that moment, and none had to
be prepared again (`restale` 0); a deliberately unforeseen change of the displayed HP between preparing and playing (4 battles tampered with) is caught at start and the run is prepared again (4 re-prepared, 4 notes, nothing in the problems log); four mutants (no projection, no drain projection, no re-check, the playing step not
projected) each fail a named check. (Counts re-read for Round 8 from the test's own check titles: the live group is 12 battles, one found at run time plus the fixed seeds 2-10, 12 and 15. An earlier version of this paragraph said 9.) Two contract-stream goldens changed (`sysstarts.3`, `sysstarts.8`): they had recorded the stale HP values, and with the `hp` fields removed the streams of the old and the new scene are identical (checked by
hashing both without them), so the change is exactly the stale HP and nothing else. The real-browser frames (before / after) are the reproduction above; after the fix frames 1110-1137 show Jirachi 175/175 blinking.

**Not covered / unchanged:** the `moveanim` effects (a move's own animation) take their battler state from `battlerInfo` at start and were not part of this report. (Round 7 as first written also left the send-out and recall
effects seeded from the display and called the remaining risk "not observed"; that was wrong, see Round 7b.)

### Round 7b -- the same defect in the SEND-OUT and the RECALL (found by the review of round 7)

**What was left.** Round 7 projected (and re-checked) a hit and a faint only, on the grounds that the send-out and recall effects "were measured against the real game with the old rule". Counted on the stub animator in Node over 400
battles (seeds 1-400, the player switching on purpose up to 3 times; 3,611 send-out / recall runs), with the Round 7 scene **164 of those runs began with a stale picture of a Pokemon they draw**: foe send-outs (id 8) 156 of 518
(34 the wrong Pokemon, 122 a stale bar), player send-outs (id 2) 2 of 1,899 (wrong Pokemon), player recalls (id 3) 3 of 1,174, foe recalls (id 9) 3 of 20. Two examples. Seed 2: the foe's replacement send-out was prepared with the player's
FAINTED Pokemon (species 848, 0 HP) and began while the player's replacement (species 1207, 117/204) stood on screen, so the foe's send-out was drawn beside the old, dead Pokemon (both sides had fainted). Seed 8: the foe's send-out was
prepared with the player's bar at 113 HP and began when the screen showed 101, so that bar jumped back up for the length of the effect (a drain writes the hp on every frame, so a read while it plays is a mid-drain value). Not rendered in a
browser: what each effect draws is compared with the ROM engine below.

**Which Pokemon each effect draws (measured with the ROM engine, `4. draws` in the test).** Every frame of the whole effect is hashed, then the same effect is run with one Pokemon changed. A **send-out** (ids 2 and 8; 150 and 185 frames)
is identical in every frame for any HP (37) or species of the side that sends out, i.e. the Pokemon it replaces, and different for the other side's HP. A **recall** (ids 3 and 9; 53 frames) is different for either side's HP: the recalled
Pokemon is drawn with its bar, and so is the other side. So the old lead rule (the Pokemon the display holds when the effect is prepared) costs nothing for the side that SENDS OUT, which no frame shows (in the 400 battles 290 of the 518
foe send-outs have a lead whose HP differs from the screen when they begin, and that is invisible), but it is wrong for a recall's own Pokemon: a bar that moves just before the recall is drawn at its mid-drain value (an Eject Button
recalls the Pokemon it was hit on: `engine_items.js:188`). Two recalls in the 400 battles had a stale own bar (seeds 311, id 3, and 379, id 9; the cause was not traced). The review suggested keeping the lead rule for both effects; the
measurement says it holds for the send-out only, so the recall's own Pokemon is projected too. Where no drain or switch is ahead of the recall that is the same value as before, and the Round 3 handoff rows build their own ctx and do not go
through scene.js, so they are unchanged.

**The fix (scene.js).** `drawsLead(kind)` is false for a send-out only. `eventCtx` takes the projection for every Pokemon the effect draws (`side !== st.side || drawsLead(kind)`): both sides of a hit, a faint and a recall, the OTHER
side of a send-out; the side that sends out keeps the plain read of the display. `ctxSig(ctx, kind, st)` covers the same Pokemon (the sending side's slot of a send-out is `null`, so a change there costs no re-preparation), and
`sysEventStart` re-checks all four kinds. The comments in scene.js now say what the code does (a drain writes `d.hp` on every frame, not only when it ends). With the new scene the same 400 battles have 0 stale runs of 3,611 and none
prepared again (`restale` 0); the step tokens, the frame count, the engine hash, the ticks waited for a handle, the number of runs of each id, the rendered-frame digest, the sounds and the cries are identical to the Round 7 scene in all 400.

**Proof (`tools/pokemonarena_anim_scene_test.mjs`, stub animator).** On the Round 7 scene the live check finds 6 stale runs, the hand-built groups 4 of 4 and 6 of 6 cases wrong, and the tamper group fails.
- Live battles (12 of them, the player switching on purpose): every run of ids 2-9 begins with the Pokemon it draws (species, level, HP) as the scene shows them at that moment, and none had to be prepared again.
- 10 hand-built cases on a real scene (steps queued the way the director queues them, so each exists whatever the engine does): a foe / player send-out and a foe / player recall behind a drain of the other side's bar and behind the other
  side's replacement, plus a recall behind a drain of its own bar. Each begins with what the screen holds (the bar at the drain's END value, the replacement's species) and none is prepared again.
- 5 tamper cases (the displayed HP is moved while the effect waits prepared, by something the projection cannot know): a send-out (other side's bar) and a recall (either bar) are caught at start and prepared again; a change to the
  Pokemon a send-out replaces is not (restale 0); a control with nothing moved leaves the count at 0.
- `4. draws`: the four ROM-engine rows above (a send-out ignores the sending side and is sensitive to the other, a recall is sensitive to both).
- 6 new mutants (no projection of the other side for a send-out; no projection of a recall's own Pokemon; no projection of a queued replacement; no re-check of a send-out; no re-check of a recall; the Pokemon a send-out replaces
  compared too) and the 2 Round 7 ones whose code moved (no projection at all, no re-check), each fails a named check. (Counted in Round 8: the test has 10 `SYSTEM/stale` mutants from these two rounds, Round 7's four plus the six above, and Round 8 adds 1 more `SYSTEM/stale` and 3 `SYSTEM/pool`; the whole mutant list is 66 and all 66 are killed.)
- Goldens: `sysstarts.8` changed and nothing else (`sysstarts.3` and the 12 other hashes are identical). Run by run, 2 of the 17 system runs of seed 8 differ, both foe send-outs (id 8) and both in the player's picture: run 6 species
  644 -> 922, HP 0 -> 182, max HP 207 -> 182, experience 156250 -> 125000 (the dead Pokemon replaced by its replacement), run 10 HP 157 -> 146 (mid-drain -> end). Round 7's method (hash the stream without the `hp` fields) does NOT show
  equality here, because run 6's stale value is a species as well. Hashing both streams without the OTHER side's species, level, HP, max HP and experience in every send-out and recall run gives the same hash on the Round 7 and the new
  scene (`d043c2635d64` for seed 8, `e99462c5c437` for seed 3), and the tokens, frame count, engine hash and ticks waited are identical, so only stale values changed. (Applied to Round 7's own change the without-`hp` method does confirm its
  claim: the HEAD scene and the Round 7 scene give identical streams without the `hp` fields, `08fb65270a33` for seed 3 and `43ddca946fc2` for seed 8.)

**Not covered / unchanged:** the side that sends out is still read from the display when the effect is prepared (no frame shows it, measured above). By reading `projectStep`: a replacement queued before a later recall of the SAME side in one
batch projects the slot as empty and falls back to the display, which the re-check catches at start (a brief hold) instead of getting it right the first time; not observed in the 400 battles. The `moveanim` effects are as in Round 7. Not
rendered in a real browser: the scene's behaviour is measured with the stub animator, what each effect draws with the ROM engine.

## Round 6 -- the FIELD against the real game: the terrain's palette fades, the pinned mGBA's colour arithmetic, per-line alpha, BG3's shake (read this first)

**The defect (FV1, 37 moves, pixel by pixel against the oracle).** The battle terrain did not dim, go black or tint in the moves where the real game does: the terrain-only patch (x 110..139, y 4..29)
stayed at luminance 196 while the real game read 119 (Thunderbolt, Thunder Wave, Hail), 96 (Fire Blast), 144 (Rain Dance), 0 (Hyper Beam), 215 (Sunny Day). Air Slash, Psychic and Hypnosis darkened because their
dimming is an animation BACKGROUND (`fadetobg`), which the engine renders itself.

**Why the earlier comparison never saw it.** `pokemonarena_anim_oracle_compare.mjs` compares the engine's SPRITE state (gSprites structs, tasks, script pointer) and its I/O registers with the real game's,
frame by frame; it never compared what the PPU draws. The terrain is not in the engine at all (the scene supplies it as a picture, and the PPU treats that picture as BG3), so the ROM's palette work on the terrain's palettes
happened, was correct, and reached nothing. The PPU's own unit tests took their expected values from GBATEK, not from the real game. The system animations were compared pixel by pixel only at three or four chosen
frames (round 3). Nothing had ever checked a fade frame.

**Four causes, each measured on the real game, each with a negative control** (tests: `anim_test` round 6, `anim_ppu_test`, `anim_compare_test`):

| # | what the real game does | what the engine did | fix |
|---|---|---|---|
| 1 | `AnimTask_BlendBattleAnimPal` (ROM 0x0805522d, and the other ROM tasks that touch the same palettes: the colour map is not the identity on 10 of the 37 moves -- Thunderbolt, Thunder Wave, Hail, Sunny Day, Fire Blast, Rain Dance, Hyper Beam, Giga Drain, Ice Beam and Earthquake's flash) blends gPlttBufferFaded of BG palettes 1..3 = the terrain's (LoadBattleBg loads three at slot 1): Thunderbolt `args 1,0,0,6,0` = BG, 6/16 toward black; Fire Blast 8/16; Rain Dance 4/16; Hail, Thunder Wave 6/16; Sunny Day 6/16 toward white; Hyper Beam to black. 10 of the 37 moves do it | the blend ran (gPlttBufferFaded slots 1..3 changed, verified), but the terrain is a picture, not those palettes | palette slots 1 and 2 hold a 32-level gray RAMP (both buffers + PRAM, seeded at run start and again after every terrain reload: `restorebg` loads the real terrain palette over it); `baseFadeLut()` reads the faded ramp back as a per-channel colour map and the PPU applies it to the base picture (`setBaseRGBA(rgba, fade)`). A blend is a function of one entry's colour, so the map is exact. The map is null when nothing happened or when the ROM replaced the ramp (an animation background owns BG3 then) |
| 2 | the pinned mGBA draws the colour effects on the EXPANDED 8-bit channels: lighten `v + ((255 - v) * y >> 4)`; darken R `v - (v * y >> 4)`, G and B `(v * (16 - y)) >> 4`; alpha `min(255, (a * eva + b * evb) >> 4)`. Measured (`--calibrate`): 2,532,522 channel values at EVY 1..16 and 276,480 at 8 EVA / EVB pairs, 0 mismatches; the hardware's 5-bit rule mismatches 256,307 of the alpha values | the 5-bit rule: every pixel of every fade frame (fadetobg: Hypnosis, Confuse Ray, Aurora Beam, Psychic ...) and of every alpha-blended sprite or layer was off by up to 7 in 8-bit units | `anim_ppu.js` `colorMath = 'mgba'` (default); `'gba'` keeps the hardware rule (what rounds 1-5 were taken with, and what the proof below switches back on) |
| 3 | Surf arms an HBlank DMA to BLDALPHA (0x04000052) that streams EVA / EVB per scanline: the wave is the lines whose EVA is not 0 | the PPU read BLDALPHA once per frame and replayed the stream only for scroll and window registers, and applied item i to line i | BLDCNT / BLDALPHA / BLDY are looked up per line (`_regForLine`), and a streamed register is applied with a ONE-LINE DELAY (an HBlank DMA moves item i at the end of line i, so line y shows item y - 1): Surf 3293 -> 125.6 -> 0.1 px / frame (the delay alone removed all of line 111) |
| 4 | Earthquake shakes BG3 (27 different X values) | the base picture ignored BG3's scroll | the base follows BG3HOFS / VOFS (per line if streamed); what scrolls in from beyond the 240 x 160 picture repeats its edge (the real map's extra columns are not known here) |

**What changed for the pictures.** Move animations with a terrain fade, an alpha blend or a BLDY fade now draw different pixels (see "Goldens" below); the run's STATE (sprites, tasks, registers, sound, length) is untouched.
System animations: only the trainer intro (id 1) differs, in the frames with a fade or blend: against the real game's whole 404-frame trainer intro 61 frames differed beyond the known 16-pixel glyph with the 5-bit rule and 8
now (24,632 -> 5,945 differing pixels in all).

**The comparison.** `node tools/pokemonarena_anim_field_compare.mjs [--moves "A,B"] [--foe N] [--png dir] [--json f]` plays the move in the real game (OR1, L held, the clock pinned to noon) and in the engine over the scene's own
terrain (`battle_ui.js`, the picture the scene composites on), seeds the engine's two PRNG states from the real game's (Random2 scatters sprites: round 5 could not match those), and compares the FIELD (everything
but the two healthboxes and the text window: 18,496 pixels) frame by frame, plus the luminance of the terrain patch in 15 samples. `--calibrate` runs the colour-effect measurement.
Alignment: the engine's frame 0 is searched among real frames 60..130 by the smallest total difference; "within +-14" matches each engine frame to its best real frame (a LAG frame of the real game -- one main-loop
iteration that needs more than a video frame, which the engine cannot model -- shifts everything after it by one frame).
Moves that target their user (Mist, Protect, Reflect, Light Screen, Swords Dance) are launched the way the scene launches them (attacker = target = the user's side, the other Pokemon a bystander): launched
against the foe, Mist read 733 px / frame, launched properly it is 0 on all 324 frames. A real recording where the game does not play the animation ("It doesn't affect", "But it failed!", the charge turn of a two-turn move)
is not comparable (see below).

**All 37 moves (FV1's set), final tree, node tools/pokemonarena_anim_field_compare.mjs:** 25 pixel-exact (0 differing pixels on every frame), 6 near (< 400 px / frame), 5 moderate (400-2000), 1 large (> 2000); FV1 measured 5 / 8 / 9 / 15 before. Sorted best first; the 8 moves FV1 named are in the table with their round-5 numbers.

| move | frames | mean differing field px / frame (of 18,496) | exact frames | within +-14 real frames | terrain luminance (real = engine) | remaining |
|---|---|---|---|---|---|---|
| Aurora Beam | 213 | **0** | 213/213 | 0 px, 213 exact | equal |  |
| Bite | 37 | **0** | 37/37 | 0 px, 37 exact | equal |  |
| Body Slam | 103 | **0** | 103/103 | 0 px, 103 exact | equal |  |
| Bubble Beam | 235 | **0** | 235/235 | 0 px, 235 exact | equal |  |
| Double Slap | 31 | **0** | 31/31 | 0 px, 31 exact | equal |  |
| Dragon Claw | 142 | **0** | 142/142 | 0 px, 142 exact | equal |  |
| Ember | 67 | **0** | 67/67 | 0 px, 67 exact | equal |  |
| Fire Blast | 195 | **0** (FV1: 5755) | 195/195 | 0 px, 195 exact | equal |  |
| Flamethrower | 207 | **0** | 207/207 | 0 px, 207 exact | equal |  |
| Giga Drain | 226 | **0** | 226/226 | 0 px, 226 exact | equal |  |
| Growl | 51 | **0** | 51/51 | 0 px, 51 exact | equal |  |
| Hail | 156 | **0** (FV1: 4180) | 156/156 | 0 px, 156 exact | equal |  |
| Hydro Pump | 138 | **0** | 138/138 | 0 px, 138 exact | equal |  |
| Hyper Beam | 278 | **0** (FV1: 10047) | 278/278 | 0 px, 278 exact | equal |  |
| Ice Beam | 199 | **0** (FV1: 8051) | 199/199 | 0 px, 199 exact | equal |  |
| Mist | 324 | **0** | 324/324 | 0 px, 324 exact | equal |  |
| Quick Attack | 30 | **0** | 30/30 | 0 px, 30 exact | equal |  |
| Rain Dance | 185 | **0** (FV1: 8989) | 185/185 | 0 px, 185 exact | equal |  |
| Slash | 44 | **0** | 44/44 | 0 px, 44 exact | equal |  |
| Sunny Day | 155 | **0** (FV1: 4797) | 155/155 | 0 px, 155 exact | equal |  |
| Swords Dance | 67 | **0** | 67/67 | 0 px, 67 exact | equal |  |
| Tackle | 39 | **0** | 39/39 | 0 px, 39 exact | equal |  |
| Thunder Wave | 118 | **0** (FV1: 2126) | 118/118 | 0 px, 118 exact | equal |  |
| Thunderbolt | 234 | **0** (FV1: 8351) | 234/234 | 0 px, 234 exact | equal |  |
| Water Gun | 123 | **0** | 123/123 | 0 px, 123 exact | equal |  |
| Surf | 135 | **0.1** | 134/135 | 0.1 px, 134 exact | equal | one frame, <= 15 px |
| Earthquake | 197 | **47.4** | 5/197 | 47.4 px, 5 exact | equal | BG3 columns beyond 240 px |
| Protect | 119 | **231** | 100/119 | 17.7 px, 114 exact | equal | BLDALPHA step timing |
| Light Screen | 82 | **351** | 43/82 | 24.6 px, 74 exact | equal | one lag frame |
| Sleep Powder | 192 | **353.4** | 1/192 | 346 px, 1 exact | equal | real game: "But it failed!" |
| Reflect | 76 | **368.9** | 51/76 | 3.7 px, 73 exact | equal | one lag frame |
| Toxic | 228 | **1028.8** | 0/228 | 729.8 px, 4 exact | equal | real game skips it vs Snorlax (Immunity); exact vs Gyarados |
| Solar Beam | 104 | **1174.8** | 0/104 | 1147.1 px, 0 exact | equal | real = the charge turn |
| Hypnosis | 166 | **1320.4** | 150/166 | 0 px, 166 exact | max gap 13 (within +-14: 0) | one lag frame (within +-14: 0) |
| Sandstorm | 162 | **1484.1** | 149/162 | 904 px, 150 exact | equal | BLDALPHA steps one frame late (13 frames) |
| Confuse Ray | 264 | **1880** | 95/264 | 0 px, 262 exact | max gap 24 (within +-14: 0) | one lag frame (within +-14: 0) |
| Psychic | 140 | **3210** | 105/140 | 4.7 px, 139 exact | max gap 24 (within +-14: 0) | one lag frame (within +-14: 4.7) |


**What remains, with the reason.**
* **One lag frame of the real game (Psychic 3210 px / frame at the aligned offset but 4.7 within +-14 frames; Confuse Ray 1880 / 0; Hypnosis 1320 / 0; Reflect 369 / 3.7; Light Screen 351 / 24.6).** At one point the real game
  takes an extra video frame (a main-loop iteration that needs more than one frame of CPU: Hypnosis' `restorebg` iteration runs 22,304 ROM instructions, 4x the others, plus a terrain decode the engine does natively) and
  everything after is shifted by one frame: for Hypnosis frames 148..163 of the engine equal real frames 149..164 with 0 differing pixels. Not modelled: it needs the real cycle cost of an iteration (instructions x wait states
  + the decoders the engine runs natively), and instruction counts alone do not predict it (Aurora Beam's identical `restorebg` does not lag).
* **BLDALPHA steps one frame late (Sandstorm 1484 px / frame: 13 frames of 162, every 4th, the whole field differs; Protect 231).** On those frames the real game already shows the NEW EVA / EVB the ROM's task just wrote.
  Experiment (scratch, not shipped): drawing each frame with the BLD registers of the NEXT iteration's first half takes Sandstorm from 13 differing frames to 1 and Protect from 19 to 1, but Reflect from 25 to 48 and Light
  Screen from 39 to 56, so "one iteration earlier" is not the rule: it depends on where in the video frame the write lands (the real game draws scanline by scanline), which needs cycle-accurate timing.
* **Earthquake (47 px / frame, at most 83).** BG3 is shaken by up to 13 px, which exposes columns beyond the 240-px terrain picture the scene supplies; the engine repeats the picture's edge, the real map has the next terrain columns.
* **Surf: 0.1 px / frame (one frame of 135, at most 15 px).** (Before the streamed registers got their one-line delay it was 125 px / frame: all of line 111.)
* **Not comparable, not engine defects.** Solar Beam: the real recording is the CHARGE turn ("absorbed light!"), the engine plays the strike. Sleep Powder: "But it failed!" in the real game (no animation). Toxic against the
  default Snorlax: "It doesn't affect" (Immunity), no animation; against a Gyarados (`--foe 130`) it is 228 of 228 frames pixel-exact.
* **System animations:** the trainer intro still has 8 frames (of 404) that differ from the real game beyond the known 16-pixel healthbox glyph (frame 32: 240 px; 246..270: about 370-396 px); cause not determined.
* The frame on which a run reports `done` is the scene's first frame of rest and is not compared.

**Tests.** `anim_test` 122 passed, 0 failed (171 with `--oracle`; round 5: 95) (round 6: the terrain colour map against the ROM's own blend arguments read from the scripts, five negative controls; `--oracle`: the calibration, 17 moves pixel by pixel with luminance bounds,
four negative controls that switch off the fade / the streamed alpha / BG3's scroll / the 8-bit arithmetic and must push the same comparison past its bound); `anim_ppu_test` 21 passed, 7 of 7 mutants detected (round 5: 15, 3 of 3); `anim_compare_test` 34 passed (round 5: 26) (the machinery
sees a missing fade on an engine-made recording, ignores the boxes, counts exactly one pixel in the field).

**Goldens.** `js/anim.golden.json` (the 19 move / general / status / special / bg frame-stream hashes): 13 entries changed, in two stages, each proven. Stage 1, the terrain colour map: with the map switched off all 95
round-5 hashes were reproduced (6 entries changed: Thunderbolt, Hyper Beam, Earthquake, general 9, general 10, special 2). Stage 2, the 8-bit colour arithmetic and the streamed BLD registers: with `colorMath = 'gba'` and the streamed
BLD registers ignored all 95 stage-1 hashes were reproduced (8 more entries changed: Tackle, Water Gun, Psychic, Swords Dance, Surf, stat change, general 10 again, background 7) -- both runs were `node --import <preload>
tools/pokemonarena_anim_test.mjs`. Stage 3, the one-line DMA delay: Surf only. So the animation STATE is untouched; only pixels with a fade, a blend or a streamed register moved. The real-game comparison above is the proof they moved
the right way: Tackle, Water Gun, Swords Dance, Bubble Beam, Hydro Pump, Quick Attack, Bite, Double Slap, Body Slam (alpha) went from 53-1618 differing pixels per frame to 0. `js/anim_sys.golden.json`: `trainerIntro` frame 200 only;
`js/anim_sys_stream.golden.json`: `id1` only (the other 33 entries are bit-identical; with `colorMath = 'gba'` all 350 `anim_sys` checks reproduce the round-5 goldens). The DMA delay changed no system frame.
**AN1:** the scene's frames over a ROM animation change for every move that blends or fades (and the terrain now dims), so `anim_scene.golden.json` needs a re-baseline after this; nothing else about the API changed.

## Round 5 -- the incoming Pokemon of a send-out: the run kept the PREVIOUS Pokemon's species (read this first)

**The defect (AN1).** After a trainer's mid-battle send-out (id 8, 'sendOutFoe', Marill -> Gyarados) the run ended on the PREVIOUS foe's ground shadow (shape and position); the real game draws the new
Pokemon's (the scene test's last-frame diff against it: 63 px). It was never only the shadow.

**Cause (ROM code, traced).**
* The foe's shadow is two sprites with callback 0x0807eb89 = `SpriteCB_EnemyShadow` (ROM 0x0807eb88). It recomputes its OAM tile (attr2: the shadow's size class), x and y EVERY FRAME from a species
  record: table 0x087c7310, stride 280, +0xa2 x (s8), +0xa3 y, +0xa4 size; the species comes from the function at 0x080ce94c, which returns `gBattleMons[battler].species` (0x02001ecc + 152 * battler, +0).
* The real battle script runs `switchindataupdate` (the incoming Pokemon is copied into gBattleMons[battler]) BEFORE `switchinanim`. A system event injects only the controller commands (6 recall, then 5
  switch-in), so gBattleMons kept the OUTGOING Pokemon. The oracle's injection in `pokemonarena_sys_compare.mjs` had the same omission, which is why round 3 compared exact: both sides ran the ROM on the
  wrong species. Reading every access to gBattleMons[battler] during ids 2 and 8 (a tap on the memory map, with the PC) finds only +0 and +0x5c: the species (through 0x080ce94c, at 0x080ce962: the shadow every frame, 227
  reads in id 8, and the controller's own read at 0x08068926 that the next point is about; and the flag function 0x080ce62c at 0x080ce640) and a flag byte at +0x5c (equal in both): writing the species
  covers every read the pictures make.
* The controller's own read (0x08068926 -> 0x080ce94c, then a call to 0x081eb1cc with the species, before the mon's sprite is created) goes through the same field; I did not trace what that function does with it,
  but the picture says it matters: with the outgoing species Marill -> Gyarados differed from the real game's natural switch in 127 of 177 frames of the foe side (224,068 px in x 96..239, y 0..63) and ended
  80 px off (AN1's rows 63..70: 63 px), and the default pairs' send-outs lasted 139 (player) / 141 (foe) frames where the corrected run lasts 166 / 163.

**The fix.** `SystemRun.finishEvent` writes the incoming species (the u16 at +0x20 of the party record it just wrote, 11 bits) into gBattleMons[battler] before it issues the event's command; ids 2 and 8
(`SYS.battleMons`, `SYS.battleMonStride`). It runs after the battle-state cache's snapshots (A and B are taken before `finishEvent`), so the cache key needs no species: a second send-out of the same
battle with ANOTHER incoming Pokemon is a B hit and gets its own shadow (tested). The recalls (3, 9), the faint, the hit and the intros have no incoming Pokemon and are unchanged (28 of 32 golden streams
are bit-identical).

**Checked against the real game two ways.**
1. The game's NATURAL switch (`node tools/pokemonarena_sys_natural.mjs`, new): a real trainer battle in which the player's Tackle faints the lead and the game's own script sends out the trainer's next
   Pokemon, and a real wild battle in which the player picks POKeMON in the menu, the second member and SHIFT. From the frame the controller starts the switch-in, every video frame's real VRAM / OAM /
   palette / I/O is dumped and rendered through the first-party PPU (text layer left out; with every layer the render equals the real screenshot, 0 px), and compared with the engine's frames of the
   same event on the side of the picture the event animates. Two alignments by the Random() counter: the controller function (logic) at the frame the real controller flips, the picture one video frame
   later (OAM and palette reach the screen at the NEXT VBlank; the engine draws after its own VBlank work: measured, 0 px at +1, thousands at +0).

| natural switch | species | iterations | foe-side / player-side px | controller timeline | shadow sprites |
|---|---|---|---|---|---|
| trainer, Marill -> | Gyarados 130, Snorlax 143, Charizard 6, Pikachu 25, Magikarp 129, Gengar 94, Misdreavus 200 | 185, 207, 137, 193, 185, 212, 199 | **0 in all seven** | equal in all | equal in all (seven different tile / x / y) |
| player, Charizard -> | Gyarados 130, Snorlax 143, Magikarp 129, Gengar 94 | 152, 166, 139, 156 | **0 in all four** | equal | - |
| player, Charizard -> | Pikachu 25, Charizard 6 | 150, 203 | 1631 px in ONE frame (iteration 67) / 4801 px in two (63, 6x), last frame 0 | equal | - |

   The two exceptions are one or two frames of the silhouette -> colour palette transition at the end of the ball burst (the engine's ends 1-2 frames after the natural flow's). They are exact in the injected
   comparison below, and the Charizard -> Charizard one has the SAME species in both slots (the species write changes nothing there, so the engine's output is the round-3 code's). The cause is NOT determined;
   I have not tested my guess that it is something the natural flow has around the switch (the party screen, the turn's other tasks). The test accepts exactly this and nothing wider: timeline equal, last
   frame 0 px, at most 2 frames, all in iterations 60..70.
2. The oracle's injection, now doing what the script does (`GBATTLEMONS` write in `recordRealEvent`): `--event 8 --switch N` / `--event 2 --switch N`: sprite-exact in EVERY iteration and 0 px in every shot for
   the trainer send-out of Gyarados, Pikachu, Magikarp, Misdreavus, Gengar and the player send-out of Pikachu, Charizard, Gyarados, Snorlax.
Negative controls (each must be DETECTED): the round-3 behaviour (the outgoing species stays) is seen by the shadow sprite pair, by 1000+ pixels and by the last frame in the natural comparison
(Gyarados, Misdreavus), and by the end shadow of the run in the unit tests; the species written to the wrong slot; an alignment 3 frames off.

**Goldens.** `js/anim_sys_stream.golden.json`: exactly 4 of the 32 round-3 entries changed and were re-recorded: `id2` (139 -> 166 frames), `id8` and `trainer5Foe` (141 -> 163), `shinyPlayerSendOut`; the
other 28 are unchanged. Two new entries: `id8Gyarados` (185 frames), `id2Pikachu` (150). `js/anim_sys.golden.json`: only `sendOut` (139 -> 166 frames and its frame hashes). The numbers in Round 3's
timings (send-out 139, trainer send-out 237) are the stale ones; a send-out's length depends on the incoming species (cry, sprite animation): player 150 (Pikachu) .. 203 (Charizard), foe 137 .. 212.

**For the scene (AN1).** Send-out runs are now 20-30 frames longer for the default pairs and differ per species; any test or timing that pinned the old frame counts, and the "keeps the PREVIOUS foe shadow"
allowance of the scene test's send-out row (limit 70 px at the last frame) can go: the last frame of a send-out is exact against the scene's standing foe (0 px in the foe region against the real game).
The foe side of a send-out now needs the incoming species in `ctx.switchIn` (already so) and nothing else.

## Round 4 -- no stalls: prepare / advance / begin for the system animations (read this first)

**The problem (AN1, headless Chrome, a 3 v 3 battle of 4936 frames).** `animator.start('system', id, ctx)` was synchronous: for the ten ids 2..9 it first plays the battle intro hidden up to the
first iteration of the action selection (the real game is in that state when a turn begins) and only then starts the event: 22 of 23 system runs cost 94 / 127 / 151 ms (min / median / max) in ONE
tick, 2.6 s in all = 6-9 dropped frames at every intro, send-out, recall, faint and hit, with a static message on screen. A second `start()` also overwrote a live system run (one engine).

**What changed (the frame stream did not).** The whole pre-roll is now a state machine that can be advanced a few milliseconds at a time, and it is shared:

```js
const prep = animator.prepare('system', SYS_ID.faintFoe, ctx);        // takes an engine of the pool and seeds it (0.04 ms warm, 2-5 ms for the first call of a session)
while (!prep.ready) prep.advance(3);                                    // once per tick: runs the ROM model for at most ~3 ms (returns { ready, phase, ms, instructions })
const run = prep.begin();                                               // the SystemRun: step() / draw() as before, from its frame 0
// animator.start('system', id, ctx) is exactly prepare + advance(Infinity) + begin(): same frames, bit for bit
animator.prepare('system', 'battle', ctx)                               // PREWARM: pre-rolls a battle state into the cache and gives its engine back; nothing to begin
```

* **The slice is the CPU's.** `GbaCpu.beginCall()` / `resume(deadline)` (anim_cpu.js) run one ROM call that can be suspended at a check point: every `SLICE_CHECK` = 2048 instructions
  (and between two calls of an iteration) the host clock is read; past the deadline the call stops with registers and memory consistent and the next `advance()` continues it. Only the
  OUTERMOST loop suspends: a nested call made from inside a hook (CreateMon wrapper) always runs to its end. A budget of 0 still runs one check interval (2047 instructions) per `advance()`.
  The iteration order, the addresses read between the calls and the instruction budgets are those of the synchronous `iterate()`; the per-instruction cost of the check is one comparison.
* **Overshoot.** An `advance(B)` runs B ms of ROM code plus at most one check interval (< 2048 instructions = ~0.07 ms at 34 ns / instruction) plus whatever single piece it cannot interrupt:
  a nested hook call or the JS graphics decoder. Measured with a virtual clock (1000 instructions per ms, deterministic): worst overshoot 2031 instructions < 2048 over 724 advances at 3 ms; with
  the real clock in Chrome see the table below.
* **A prepared intro (ids 0 / 1)** has run its first iteration (the one battle-setup iteration that costs 10-19 ms): `begin()` hands it over and the first `step()` only delivers it (frame 1,
  its events). `ctx.lookahead = 0` turns this off. `run.setKeys()` applies from the second iteration on.
* **The battle-state cache** (`ctx.keys` not a function, no `ctx.isSEPlaying`; `createMoveAnimator({ systemCache: 4 })` battles, 0.38 MiB per snapshot): every event of a battle starts from the
  same hidden state, so the pre-roll is played ONCE per battle state. The key is a hash of the SEEDED console (parties, save blocks, flags, RNG, time of day ...) plus the settings kept outside
  RAM (hour, environment, cry model, SE extra, key policy); the value is the console at the first iteration of the action selection (A) and, for the send-outs (ids 2, 8), after their
  preparation (B). A hit restores the snapshot (restore 0.01 ms, fingerprint 0.14 ms; prepare + the one advance that finishes a hit took 2-4 ms in Node on a cold JIT) instead of playing 2.9 M instructions: `handle.cache` says `null` / 'A' / 'B'. The second event of a battle (the faint behind the hit)
  therefore costs a restore. Different seed, parties (level and HP too: the healthbox shows them), environment, time of day or trainer = a different battle = one pre-roll each. Pass the
  ctx you will use for the events to `prepare('system', 'battle', ctx)` while the intro plays, and the first event is also instant. (For ids 8 / 9 pass `trainer` explicitly: their default is 1.)
* **Several runs at once.** The animator owns a POOL of engines (`createMoveAnimator({ systemEngines: 3 })`, default 3): a run (prepared or playing) owns one. A faint can be prepared while the
  hit plays: two engines. The pool never takes a prepared handle; when it is full it takes the least recently used FINISHED run's engine (that run keeps its last picture: `draw()` returns it,
  `run.reclaimed`), then the least recently used LIVE run's (`run.evicted`, `done`); if every engine holds a prepared handle `prepare()` throws a `MoveAnimError`. `handle.dispose()` gives an
  engine back at once. A finished run holds its engine until another run needs it: do not read `run.eng` after starting a new run.
* **Memory.** Per pool engine 1.16 MiB (EWRAM 256 KiB + IWRAM 32 + VRAM 96 + palette / OAM / I/O 3 KiB, the same again as its boot snapshot, and the PPU's buffers); the 16 MiB hook-flag array is
  SHARED with the move engine (measured: the first engine added 17.16 MiB before sharing, 1.16 MiB after). Each cached battle snapshot is 0.38 MiB (a send-out battle holds two). Defaults:
  3 engines + 4 battles ~ 3.5 + 3 MiB. `animator.system.stats()` reports `{ engines, busy, prepared, live, cacheBattles, cacheSnapshots, cacheBytes, cacheHits, cacheMisses }`.

The handle: `advance(budgetMs = 4)` returns `{ ready, phase, ms, instructions }` (a fault or an instruction-budget overrun rethrows and disposes the handle); `ready`; `phase` (`'lookup'` -> `'hidden'`
-> `'pre'` -> `'finish'` -> `'ready'`, or `'ahead'` for an intro); `cache` (`null` / `'A'` / `'B'`); `profile` (`{ phases: { init, intro, pre, ahead, lookup: { iterations, instructions, ms, calls: { cb1, cb2, vblank,
dma3, random } } }, instructions, ms, advances }`); `error`; `run` (the SystemRun, only valid after `begin()`: stepping it earlier throws); `begin()` (once, only when ready); `dispose()`.
New ctx fields: `lookahead` (default 1; 0 = off), `clock(cpu) -> ms` (the clock `advance` reads; tests drive it from `cpu.icount`); animator options: `createMoveAnimator({ rom, systemEngines: 3, systemCache: 4 })`.

### Where the pre-roll goes (instructions per phase; `handle.profile`)

Measured on a prepared `faintFoe` (Rattata L3 vs Charmander L5, seed 5): 2,925,719 ROM instructions in 277 iterations.

| phase | iterations | instructions | share | what it is |
|---|---|---|---|---|
| init | 35 | 599,727 | 20.5 % | `CB2_InitBattle` and the intro's set-up until the ROM's main function is the intro's (cb2 82 %: iteration 0 alone is 202,940 instructions = 6.9 % of the whole) |
| intro | 242 | 2,325,992 | 79.5 % | the intro itself, waited out one iteration at a time (cb2 87.8 %: text printing, sprite animation, palette fades; vblank 4.9 %, cb1 6.4 %, DMA queue 0.5 %, Random 0.4 %) |
| pre | 9 | 62,595 | 2.1 % of a send-out | the recall without animation that precedes a player send-out |

A trainer battle (`sendOutFoe`): init 678,512 (14.9 %), intro 336 iterations 3,826,369 (84.0 %), pre 52,891; 4.56 M instructions. A prepared intro's first iteration: 202,940 instructions.
**Is any of it ctx-independent?** The memory writes of iteration 0 were compared between two contexts that differ in one thing: they are identical up to instruction 50,758 of ~203,000 when only the
seed differs, 157,113 for the environment, 173,786 for the time of day, 199,679 / 201,029 for the player's / the foe's species. So the only pre-roll work that does not depend on the context is the
first iteration (at most 7 % of the whole, and only for a fixed seed), in the middle of one ROM call: a snapshot there would need the interpreter's call state too and would save less than the
10 ms the slices already hide. The crt0 + heap initialisation (the other ctx-independent part) is the engine's boot snapshot, restored per run. The 93 % that depends on the battle is what the
cache shares between the events of the same battle.

### Chrome tick numbers (headless Chrome 156, throwaway profile, muted, behind the shared browser lock; `node tools/pokemonarena_sys_tick.mjs`)

Headless Chrome 156 (16 hardware threads), a requestAnimationFrame loop that does `step()` + `draw()` + `putImageData` per tick, 23 system runs of a scripted 3 v 3 battle (intro, then hits, faints,
send-outs and recalls on three battle states): 1815-2699 ticks per pass, one pass of each mode, the JIT warmed by a discarded pass. The machine was not quiet (the same `start()` that
costs ~97 ms in Node early in this session cost 220-260 ms later in it; Windows has no load average, `os.loadavg()` is 0): compare the rows with each other, not with other sessions.

| mode | ticks | tick ms min / median / max | ticks > 16.7 ms | ticks > 33 ms | worst rAF gap | `start()` / `advance()` ms min / median / max | begin ms | ticks the next run was not ready |
|---|---|---|---|---|---|---|---|---|
| **sync, cache off** (round 3) | 1812 | 1.2 / 2.9 / **309.6** | **23** | **22** | 303.7 ms | start 22.5 / 234.4 / 305.8 (22 events) | - | - |
| sync, cache on | 1812 | 0.8 / 2.7 / 288.6 | 4 | 3 | 288.8 ms | start 1.1 / 2.7 / 285.6 (3 cold battles) | - | - |
| sliced 2 ms, cache off | 2699 | 0.3 / 4.1 / 10.0 | 0 | 0 | 15.2 ms | advance 0.3 / 2.0 / 2.7 | 0.0 | 887 |
| sliced 2 ms | 1926 | 0.6 / 2.5 / 13.0 | 0 | 0 | 15.0 ms | advance 0.1 / 2.0 / 2.4 | 0.1 | 114 |
| sliced 2 ms + prewarm | 1820 | 1.9 / 2.4 / 8.7 | 0 | 0 | 15.1 ms | advance 0.0 / 2.0 / 2.2 | 0.1 | 8 |
| sliced 4 ms, cache off | 1930 | 0.0 / 6.1 / 9.9 | 0 | 0 | 15.1 ms | advance 0.0 / 4.0 / 4.3 | 0.0 | 118 |
| **sliced 4 ms** | 1816 | 1.5 / 2.3 / **9.4** | **0** | **0** | 15.5 ms | advance 0.1 / 4.0 / 4.2 | 0.0 | 4 |
| sliced 4 ms + prewarm | 1815 | 1.9 / 2.4 / 12.6 | 0 | 0 | 15.0 ms | advance 0.0 / 4.0 / 4.3 | 0.0 | 3 |

What it says. (1) The stall is gone: with `advance(4)` the worst tick of the whole battle is 9.4-12.6 ms (the step + draw + the slice) against 309.6 ms, no tick exceeds 16.7 ms and no rAF gap
exceeds 15.5 ms; an `advance()` costs its budget plus at most 0.3 ms in the real clock (4.0-4.3 ms for 4, 2.0-2.7 for 2). (2) The cache alone does not remove the stall (3 cold battles still
stall ~285 ms); slicing does. (3) "Ticks the next run was not ready" is how long the scene had to HOLD the previous picture because a cold pre-roll was not finished when the previous run ended:
887 ticks without the cache at 2 ms (a pre-roll costs ~120-250 ms of slices), 118 at 4 ms, 4 with the cache, 3 with a prewarm that gets the battle state ready during the intro. The prewarm
is what makes the first event of a battle instant; with it the scene never waits.

### Tests (`node tools/pokemonarena_anim_sys_test.mjs`: 350 passed, 0 failed, 2-4 minutes after Round 5 (312 in round 4); `--oracle` adds 31 = 381, Round 5 included)

* `start()` is the round-3 stream bit for bit: `js/anim_sys_stream.golden.json` holds the md5 of every frame (all 38400 pixels) and every event of 34 runs (ids 0-9, the 17 balls, shiny, a long
  cry, a trainer send-out, night, and the two Round 5 send-outs) taken from the code BEFORE the sliced path existed (`tools/pokemonarena_sys_stream.mjs`); 28 are the round-3 values, 4 were re-recorded in Round 5 (the send-outs), all match, with the cache cold and warm.
* Sliced == synchronous: ids 0-9 x budgets 1, 4, 1000 and 0 ms: the stream md5 AND the whole console state at `begin()` (every RAM image, the registers, the counters) equal the synchronous ones
  (80 checks); the 17 balls x the same four budgets (68 stream checks; the throw window pixel by pixel, the rest by sprite / OAM / I/O state). A 1 or 4 ms budget really slices an event's pre-roll
  (more than 5 advances; 1,257 at 1 ms, 651 at 4 ms for a faint).
* No `advance` exceeds budget + one check interval (virtual clock: 3, 10 and 40 ms, 724+ advances), none stops early; `advance(0)` makes at least 2047 instructions of progress on every call.
* Cache: first event of a battle misses and plays the intro, the second hits (A) with 0 ROM instructions and < 20 ms, a send-out hits A then B, another seed / foe / key function does not share,
  a `'battle'` prewarm fills it. Pool: a hit plays while a faint is prepared (cold: sliced pre-roll; warm: cached): both streams equal the synchronous ones; exhaustion, finished-run
  surrender with a frozen last picture, live eviction, dispose, typed errors.
* Negative controls (each must be DETECTED): a sliced iteration counted twice, an extra key in ReadKeys, a suspension that corrupts a register, a sliced loop that drops DMA-queue calls, a cache key
  that ignores the Pokemon, a cache hit that loses the VRAM, a resume that ignores the deadline (breaks the bound), a resume that runs nothing (breaks progress); a pass-through wrapper is NOT
  detected (the checks are not trivially true), and the unmutated code passes all three again.

### For AN1 (what to change; AN1 owns these hunks)

1. Scene: replace `animator.start('system', id, ctx)` in the tick that needs the run by `prepare()` as soon as the run is foreseeable and `prep.advance(3)` once per tick (the pool allows the
   next run to be prepared while the current one plays); `begin()` when the current run is `done` and `prep.ready`. Prewarm the battle with `prepare('system', 'battle', ctx)` (same ctx as the events)
   during the intro, and dispose a handle you will not begin.
2. README, the paragraph "Animations are the ROM's, but not all are verified or present": the sentence "They start with a 100-250 ms pre-roll in the engine, which the scene spends while a message is up
   (measured in Chrome: 22 stalls of 94-151 ms ...)" is obsolete once the scene uses `prepare()`; suggested replacement: "The pre-roll (100-250 ms of ROM code) is run in 3-4 ms slices by `animator.prepare()` while the previous picture plays, and shared between the events of a battle by a
   snapshot cache; measured in Chrome with `node tools/pokemonarena_sys_tick.mjs`: no tick of a 3v3 battle exceeds 12.6 ms (round 3: 22 stalls of 94-151 ms, worst tick 309.6 ms), see `ANIM.md` Round 4."
   The scene must also stop describing the stall as "spent while a message is up" once it uses `prepare()`.


## Round 3 -- the battle's SYSTEM animations: intro, send-out, recall, faint, hit, shiny (read this first)

`animator.start('system', id, ctx)` plays what the ROM does AROUND a move: the battle intro (background scroll-in, the foe sliding in, the player trainer's back sprite sliding out and the
ball throw, the ball opening, the white silhouette growing into the Pokemon, the Pokemon's own front / back motion, cries, healthbox slides, the battle text), a Pokemon sent out or
recalled mid-battle, fainting, the hit blink, and the shiny sparkle. Same technique as the moves (the ROM's own THUMB code on the interpreter), with one difference: **nothing is looked
up by a table of mine**. The whole battle flow is ROM code driven by `CB2_InitBattle` (0x0808d581), `gBattleMainFunc` (0x03002e64), the per-battler controller functions (0x03002e44) and
their command tables (0x08431340 opponent / 0x084314a8 player, 53 entries each; the command id is `bufferA[battler][0]` at `*(0x02001c6c) + 16 + battler * 0x200`). `js/battle_sys.js`
boots a second model of the console (`SystemEngine`: the same `anim_cpu.js` / `anim_ram.js` / `anim_ppu.js`), seeds the few things the battle reads, points `gMain.callback2` at
`CB2_InitBattle` and runs the game's main loop one iteration per `run.step()`: ReadKeys, callback1 (the controllers), callback2 (the battle main function), the battle VBlank callback,
the DMA queue, two `Random()` draws. A mid-battle event is "play the same controller command the battle script would issue" (see Events).

| id | `SYS_ID.` | what it plays | ends when |
|---|---|---|---|
| 0 | `intro` | wild-battle opening, in the real order: terrain scroll-in, the foe slides in (cry + its front motion), "You encountered a wild X!", the player's trainer slides out, the ball arc, the ball opens, silhouette, the Pokemon (cry + back motion), "Go! X!", healthboxes slide in | the ROM reaches the action menu (`run.ready`) |
| 1 | `introTrainer` | trainer-battle opening: the foe trainer's front sprite slides in, the trainer's party balls, "X would like to battle!", the trainer throws, the foe Pokemon, then as id 0 | action menu |
| 2 | `sendOutPlayer` | a Pokemon sent out mid-battle (hidden pre-roll: the intro, then the lead recalled without animation): ball throw, release, silhouette, cry + motion, healthbox slide | the picture stops changing |
| 3 | `recallPlayer` | the player's Pokemon is recalled: it shrinks into its ball (SE 15) | same |
| 4 / 5 | `faintPlayer` / `faintFoe` | faint: the sprite sinks and goes, the healthbox leaves, SE 16, and the OTHER Pokemon cries and plays its front / back motion (the ROM does this) | same |
| 6 / 7 | `hitPlayer` / `hitFoe` | the hit blink (the sprite toggles visible / invisible, 8 times in 36 frames) | same |
| 8 / 9 | `sendOutFoe` / `recallFoe` | a TRAINER's next Pokemon (trainer battle) is sent out / recalled | same |

Ids 2..9 start from a hidden pre-roll (the intro run up to the first iteration of the action selection, about 280 hidden iterations = 100-150 ms of host time in one call; Round 4 slices it and caches it per battle); `run.frame` counts only
the visible part. `done` is raised once the picture has not changed for 8 iterations (`run.settledAt` = the last frame with a change).

### Per-species motion (the first task item), where it is and what was verified

* The routines are a table of **154 THUMB function pointers at ROM 0x08f07430** (`sMonAnimFunctions`; found by scanning the ROM for runs of function pointers: it is the only run of 154).
  Species +0x56 (`frontAnimId` 0..153) indexes it: Rattata's `frontAnimId` 49 -> 0x08f074f4 = 0x081f61b5, and 0x081f61b5 is exactly the callback the REAL game's recording shows on the
  foe's sprite (first seen at frame 36). The back animation ids (+0x57, 0..25) reach the same functions through a second mapping the ROM applies (Charmander's back motion is the
  callback 0x081f4771 = table index 96; the mapping itself is not decoded and is not needed: the ROM does it).
* Because the whole send-out runs natively, the motion is not "driven" by anything of mine. Verified against the real game on 84 species pairs that cover **every front animation id
  any species uses (84) and every back animation id (26)**: see "Verified" below.

### What the model had to be given (every item was found by diffing against the real game)

| missing piece | symptom | where / how found | fix (`battle_sys.js`) |
|---|---|---|---|
| `gFonts` (0x0203dbf8 -> 0x0911ab64) | `AddTextPrinter` (0x0825ac70) returns at once when it is null: every message printed in one frame, the `{FB}` wait never happened | `AddTextPrinter` reads `[0x0203dbf8]` and returns 0 on null; set at the game's boot, not by the battle | written in `SystemEngine.boot` |
| fast battle text: **SB2 +0x16 bit 4** and **SB1 +0x19c3 bit 6** (a flag byte) | the first message took ~150 frames instead of 28 | bisected: the pinned save's SaveBlock bytes were zeroed range by range until two single bytes were left that change the timeline; the meaning is NOT decoded (text speed is the observable effect) | `ctx.sb2Option16` (default 0x30), `ctx.sb1Flag19c3` (0x40) |
| the cry wait | the send-out waits for `IsCryPlaying` (the m4a player); the engine answered "done" | the real game's controller sits in 0x0805e6f1 for 148 frames, the engine's for 107 | `anim_sound.js` `cryFrames` (the wave's length) **+ 1 frame** (`ctx.cryModel`, `ctx.cryLatency`) |
| battle environment | the terrain the ROM derives from the map tile under the player does not exist here | `GetBattleEnvironment` (0x0805ac74) returns `gBattleTerrain` (0x02001d43) | hook: `ctx.environment` (0..40, an index of the table at 0x08430470) is written before it runs |
| time of day (`0x03001d4c`, 0..3) | the healthbox palette (colours 5 and 6 of OBJ palette 4) is blended toward 0x294a by a coefficient from the table at 0x0878d508 indexed by it (function 0x081c0cb8) | the real save is at 22:13 -> 3 | `ctx.timeOfDay` (default 1 = day, no tint). The BACKGROUND tint is applied only on an outdoor map type (`gMapHeader.mapType` 0x02003840 in 1..3, 6) and is not modelled |
| follower Pokemon | in the pinned save the lead follows the player in the overworld; the ROM then skips the ball throw (task data 253 instead of 255; 0x080666f4 -> 0x0813ba78 scans the object events for id 0xfe) | the first divergence at frame 166 of the first comparison | none: the arena has no overworld, so the ball is thrown. The real recordings clear the object events (`tools/pokemonarena_sys_compare.mjs`) |
| BIOS `ObjAffineSet` rounds toward zero | 1-LSB differences in the front-animation matrices (e.g. -74.31 -> -74, mine gave -75), one pixel at the foe's edge | the OAM matrix of the real game vs the engine's | `anim_cpu.js`. This also fixed 2 MORE of the 935 moves (469, 639): identical moves 602 -> 604, none lost (re-compared from the cached real captures) |
| trainer-battle foe party | the ROM zeroes `gEnemyParty` and builds it from the trainer's ROM data (its species and levels) | the foe was species 343 whatever was written | hook on `CreateMonWithEVSpread` (0x081ece55, return address 0x0808cca3): the host's foe is written over its result. `ctx.trainer` = a ROM trainer id (name, class, picture); `ctx.trainerParty = true` keeps the ROM's party |
| command numbering | this ROM's controller table is not the vanilla order: the hit blink is **36**, not 41 (41 / 46 are other commands that return at once) | scanning all 53 commands on the foe and counting sprite visibility toggles: only 36 toggles it (8 times) | `CMD` in `battle_sys.js` |
| the "pause" function | the ROM's dummy command handler 0x08068a5d is NOT a bare return: used as the paused main function it completed the player's command before it ran | exec flag cleared at 0x0805f018 | `SYS.pauseMainFunc` = 0x08068a75 (a real `bx lr`) |
| `IsSEPlaying` polled by a battle controller | the recall (SE 15) ended 2 iterations before the real game's; the healthbox sprites' OAM priority (set when it ends) differed for 3 iterations | `ctx.isSEPlaying` sweep on the recall: +0, +1, +3, +4 frames over the move engine's estimate leave it inexact, **+2 is identical in all 53 iterations**; the same +2 on the intro breaks 7 of the 84 species scenarios (long cries), so it is applied to events only | `ctx.seExtra` (default 2 for ids 2..9, 0 for the intros) |
| the main loop's `WIN0V` | rewritten every frame (161 / 160) by the battle's VBlank | the "event never ends" run of the hit blink | ignored by the settle test |

### API  (additions only; the move API is unchanged)

```js
import { SYS_ID, makePartyMon, KEY } from './battle_sys.js';
animator.available('system', id)       // 'exact' for the ten ids 0..9, 'none' for anything else
const run = animator.start('system', SYS_ID.intro, ctx);   // throws MoveAnimError for an unknown id; ids 2..9: start() = prepare() + advance(Infinity) + begin(), 100-150 ms in one go (Round 4: prepare() + advance(budgetMs) spreads it over ticks)
```

`ctx` (every field optional):

| field | default | meaning |
|---|---|---|
| `foe`, `player` | Rattata L3, Charmander L5 | `{ species, level, nickname?, hp?, maxHp?, shiny?, gender?: 'M'\|'F', pid?, ball? (0..16), moves?, item?, status?, ... }` (`makePartyMon`: the 96-byte party record the game keeps; `shiny: true` picks a personality the hack's rule renders shiny). The foe's and the player's LEAD. |
| `switchIn` | species 1 / 4, level of the lead | the Pokemon sent out by ids 2 and 8 (player party slot 1 / trainer party slot 1) |
| `trainer` | id 1 -> 1, id 8 / 9 -> 1 | a ROM trainer id (its name, class and picture); truthy on id 0 makes the intro a trainer battle |
| `environment` | 0 | the terrain: index 0..40 of the ROM's terrain table (0 grass ... see ROM 0x08430470) |
| `timeOfDay` | 1 | 0..3: tints the healthbox palette (night = 3) |
| `keys` | A held 2 of every 24 iterations from iteration 24 | `null` = no key (the intro waits at its first text box); `(iteration, run) => KEY mask` = your own script. The ROM waits for A at each text box, exactly as in the real game; `run.setKeys(mask)` holds a mask |
| `seed` | 1 | the Random() seed (the stars of the shiny sparkle, ...) |
| `playerName`, `gender`, `tid`, `sid` | 'Nova', 'M', 0x2ded, 0xa7e3 | the save-block fields the battle prints / compares (shininess uses tid / sid) |
| `maxFrames` | 1500 | a run still going then is cut off (`run.truncated`) |
| `cryModel`, `cryLatency`, `seExtra` | 'sample', 1, 2 for events / 0 for intros | the cry's wait length (`'none'`: a cry is over at once); extra frames a controller waits for a sound effect to end, on top of the move engine's estimate |
| `isSEPlaying(index, elapsed)`, `hour` | as for moves | |
| tests only | | `partyBytes {foe, player, switchIn}`, `saveBlocks {sb1, sb2}`, `trainerStruct`, `battleTypeFlags`, `sb2Option16`, `sb1Flag19c3` |

`run`: `step()` (one GBA frame, 59.7275 Hz), `done`, `ready` (the event / intro reached its end state), `truncated`, `error`, `frame` (visible frames), `settledAt` (events), `messages`
(`[{ frame, text, window }]`, text decoded with `charset.js`: `{FB}` is the wait-for-A token), `on(type, fn)`, `draw(target, { layers, base })`, `setKeys(mask)`, `battlerState(side)`
(`{ x, y, dx, dy, visible }` of a battler's sprite), `dispose()`. Events (`run.on`): `message` `{ text, window }`; `cry` `{ species, pan }` (the species number the ROM passed to its cry
routine; play it with `cries.js` / `cryForSpecies`); `sound` `{ index, pan }` (song-table index of a sound effect: 61 ball thrown, 15 ball opens / returns, 16 faint, 5 and 102 the intro's
foe sparkle, 114-116 the trainer slide; use `songInfo` for its player and length); `pan`.

`draw(target, { layers, base })`: `layers` is a bit mask (bit 0..3 = BG0..BG3, bit 4 = OBJ; default 0x1f). BG0 is the battle text boxes and the action menu's windows, BG3 the terrain, OBJ
everything else (battlers, trainers, balls, healthboxes, shadows, sparkles). `base` (RGBA 240x160) replaces nothing by itself: pass `layers` without bit 3 and it is the backdrop.

### AN1 integration guide

1. **What it draws.** The WHOLE battle screen, 240x160: terrain (BG3), the text boxes (BG0), both battlers, the trainers, balls and effects, **and the healthboxes** (they are OBJ sprites
   the ROM creates, slides in and hides itself). While a system run plays, the scene should draw NOTHING of the battlefield or battle UI and show `run.draw(...)` instead; when `run.done`,
   hand over to the scene's own UI (for ids 0 / 1 that is the action menu: the ROM's text box and menu are in the last frame, `ready` is the moment the real game starts waiting for input).
   To keep the scene's own text instead: `draw(img, { layers: 0x1e })` (BG0 off) and use the `message` events for the strings and their frames.
2. **What to hide.** Everything the scene draws for the battlefield (its own terrain, battler sprites, trainers, healthboxes, ball icons). The scene's own sprites for the Pokemon must
   not be drawn during ids 0..9 (the run draws them from the ROM's art, shiny palette and all).
3. **Timings it implies (measured, 59.7275 fps; default key script).** Wild intro 279 frames (4.7 s) to the action menu with the default key script (Rattata vs Charmander); with the oracle's script (A held 5 frames every 60) the 84 species pairs take 215 to 624 iterations (median 321; the engine iteration count from the intro start to the menu), the length being decided by the cries. Trainer intro 373. Send-out 139 (settles at 131; the round-5 value for this pair is 166, and the length depends on the incoming species), recall 53 (45), faint 55-107 (47-99; foe 76 / 53 / 140 depending on the cries), hit blink 42 (34),
   trainer send-out 237 (229; stale as the send-out above, Round 5). `run.settledAt` is the last frame that changed; the 8 frames after it are only the "nothing changes any more" test.
4. **Sound.** Play the `sound` events with the song table (`songInfo(rom, index)` gives player / length) and the `cry` events with `cries.js`; the frames are the real game's.
5. **Shiny.** `shiny: true` on `foe` / `player`: the palette, the yellow healthbox and the star sparkle (SE 102) are the ROM's. Shininess is `tid ^ sid ^ pid.hi ^ pid.lo < 256` (this hack's
   rule, measured; `personalityFor`).
6. **Cost.** 0.55 ms per `step()` and 2.6 ms per `draw()` on average (the frame budget is 16.7 ms); the FIRST frames of an intro are heavy (battle setup: the worst single step measured
   is 38 ms), so start the run behind a fade / loading frame (Round 4 removes that too: a prepared intro has already run its first iteration). Ids 2..9 spend 100-150 ms in a synchronous `start()`: use `prepare()` / `advance()` (Round 4).
7. **The timings the fidelity audit listed as "by eye" are now the ROM's** (measured in the default-key wild intro, Rattata vs Charmander, gSprites x positions per frame): the foe
   Pokemon appears at frame 27 (no slide: x 176 -> 144 in one frame) and its front motion swings it +-16 px for ~47 frames (frames 28..75: period ~44, the "about 44" of the audit);
   the foe's healthbox slides in from the left at +10 px per frame for 12 frames (x -118 -> 2, frames ~40..52); the player's healthbox slides in from the right at -30 px per frame for
   7 frames (x 336 -> 136, frames ~190..197); the player trainer's back sprite slides off to the left in about 16 frames. Play the run, or read these off `battlerState`.
8. **Determinism.** Same ctx -> the same frames bit for bit (tested). The Random() seed only changes sparkle positions and similar.

### Verified against the real game  (`tools/pokemonarena_sys_compare.mjs`; OR1's mGBA, native 1x with L held; the machine had no other load of its own, os.loadavg is 0 on Windows)

Method. The real game plays the battle with a fixed key script (A for 5 frames every 60); every video frame the oracle records gSprites (64 x 0x44 bytes), the battle main /
controller functions, the key mask and the `Random()` counter, and takes screenshots. The engine runs the SAME battle through `animator.start('system', ...)` and is fed the real key mask
for each of ITS iterations. An engine iteration is matched to a real frame by the Random() counter (+2 per main-loop iteration in both; the real game's lag frames have counter delta 0 and are
never chosen; the real init phase, whose length depends on CPU time the engine does not model, is aligned at the first intro iteration). Compared: every field the picture depends on of all
64 sprites (OAM attr 0/1/2, callback, x, y, x2, y2, in-use flag) per iteration, the main/controller timeline, and the screen at 3-6 frames (pixel by pixel).
Mid-battle events: the oracle INJECTS into the real game the same command the engine issues (writes the command id into `bufferA[battler]`, the battler's bit into
`gBattleControllerExecFlags`, parks `gBattleMainFunc` on an empty function) at the first iteration of the action selection; both then run on their own.

| what | scenarios | result |
|---|---|---|
| wild intro, every front animation id (84 used) x every back id (26), exact party bytes | 84 | timeline identical in 84/84; sprites identical in every iteration except the LAST one (the action menu's two sprites exist one iteration earlier in the real game) in 84/84; screenshots identical (0 of 38400 px) in all 250 shots |
| all 17 ball ids (the ball sprite / throw / release) | 17 | same, 4 shots each, 0 px |
| shiny foe / shiny player / both (the sparkle + SE 102 + yellow healthbox) | 3 | same, 6 shots each, 0 px |
| trainer intro (trainer 0x363 "Crystal", Marill) | 1 | 411 of 412 iterations identical (the last one as above), timeline identical, shots 0 / 0 / 16 px (the foe healthbox's level digits at x 87-89, y 22-25) |
| events: faint x2, hit x2, send-out player, recall player (x 4 species pairs each), trainer send-out (x 4) | 28 | every iteration identical, every shot (4-5 each) 0 px (the two send-outs ran the ROM on the OUTGOING species in both the engine and the oracle's injection; Round 5 corrects both, the faint / hit / recall rows are unaffected) |
| events: trainer recall (x 4) | 4 | every iteration identical (53 of 53); shots 16 / 16 / 16 / 16 / 0 px (the foe healthbox's gender glyph, see below) |

### What stays unresolved (honest list)

* **Lag frames at battle init.** In the scenarios measured the real game's init took 20 or 21 frames (a lag frame, presumably from the size of what it decompresses: not verified); the engine always takes 20. The engine has no cycle clock:
  it does not reproduce the real stutter (the step costs above are host time, not GBA time). The comparison aligns on the first intro iteration to be independent of this.
* **The action menu's opening iteration** (two menu sprites exist one iteration earlier in the real game): cosmetic, not explained.
* **Trainer battles**: 16-24 px of the foe healthbox (its gender glyph) differ from the real game. The real game rebuilds the foe party from the trainer's ROM data with its own `Random()`
  state (the personality is random), so a party injected into the real game cannot be reproduced by one the arena writes; `ctx.trainerParty = true` runs the ROM's builder with the
  engine's seed (still 24 px: another personality). Not proven to be the cause, but the sprite structs are identical in every iteration, so it is not the animation.
* **Background time-of-day tint** (outdoor map types only), the `{FB}`-less auto text speed, doubles, safari, link battles, the HP bar / EXP bar animations, status animations in the
  healthbox (the ROM's HP-bar tasks run when a battle script drives them; this module does not run battle scripts), and the level-up (special 0, verified as a move-engine animation).
* The meaning of SB2 +0x16 bit 4 / SB1 +0x19c3 bit 6 (above).


## Round 2 -- what was found and fixed (read this first)

Round 1 compared the engine with the real game on 112 moves, sprites only, and found 16 differences it could not explain. Round 2 built the comparison properly (OR1's mGBA oracle, every move
1-935, sprites + tasks + the animation script's own position + the I/O registers + the END frame, with the real battle's own environment fed into the engine) and then chased every
difference to a cause. The causes were NOT in the ROM code the engine runs; they were in the battle STATE around it. Each is fixed, pinned by a test with a negative control, and
listed here with the move it was found on:

| cause (measured on the real game) | moves that differed because of it | fix |
|---|---|---|
| **gSprites slot numbering.** CreateSprite hands out the lowest free slot and callbacks keep the id in a data word. The real singles battle holds slots 0-5, 9 (player), 11 (foe), 60-63 and leaves 6-8, 10, 12-59 free; the model held 0-11 densely, so Double Kick's child sprite stored 13 where the real game stores 7. | 24, 28, 37, 63, 61, 108 (and the sprite ids inside every data word) | `ctx.occupiedSlots` (default = the real layout), `ctx.battlerSlots` |
| **OBJ palette slots 4-10 are taken** by the healthbox / status bar / ball sprites, so the first animation palette is slot 11-12 and Light Screen stores `(index + 16) * 16` = 448, not 320. | 112, 113, 115 | `ctx.paletteTags` / `ctx.reservedPalettes` (default = the real tags) |
| **The partner battlers were present** (positions 2 / 3 were 2 / 3 instead of 0xff): `monbg` created a spurious BG2 task, which shifted the id of every task created after it. Round 1's "task id differs" was this. No exemption is needed or added. | 97, 98, 112, 113, 115 | positions 0xff, `gBattlersCount` 2 |
| **Random2 state.** The real animation draws from the real Random2 state; given the real state (read the frame before the launch) the engine reproduces Double Kick (24: 33/33 frames), Sand Attack (28: 56/56), Thrash (37: 97/97) and Hyper Beam (63: 279/279) on every frame. Different seeds give different jitter: that is not a divergence. | 24, 28, 37, 63 | `ctx.rng2` / `ctx.rng1` (4 u32 each); the real main loop draws Random() twice per frame, so `Run.step` does too (`ctx.mainLoopRandom`) |
| **The target of self-targeting moves is the user** (Mist, Swords Dance, weather...). The comparison had put the foe there, so Mist's sprite sat 8 px higher. | 54 | `ctx.bystander`; the harness reads attacker / target from the real animation block |
| **Lag frames.** An iteration longer than one frame (a heavy load) leaves a hardware frame with the iteration half done; the real main loop draws Random() twice at the END of an iteration, so a capture whose sfc32 counter word did not advance is half done and is dropped before comparing. This explained the "frame 70+ tail" of 5 / 25, 27, 81, 61, 108. | 5, 25, 27, 61, 81, 108 | `compareMove` `realRng` (tool) |
| **DecompressDataWithHeaderVram's smol decoder allocates a temporary buffer as big as the output.** The model's heap holds ~2 KB less than the real battle's, so a 12 KB terrain-tile stream (terrain 9: the scripted trainer battle's) failed `Alloc` -> the ROM's assertion screen -> a spin loop -> the 3M-instruction budget. This one cause produced the "instruction budget" fallbacks of 831, general 41 / 44, bg 83 / 84 AND the early end of every `restorebg` on terrain 9. | 5 and 25 (their `restorebg` on terrain 9 killed the run 19 frames early), 831, general 41 / 44, bg 83 / 84 | the smol routine (0x0811c080) is replaced by `gfxcodec.js` writing the same bytes (327 of 330 ROM streams checked byte-equal against the native routine; the other 3 cannot run natively in this heap) |
| **Open bus.** Moves 232 / 337 (Metal Claw, Dragon Claw) read through a pointer the ROM builds with a sign extension (0xffffba30) and keep the halfword they get. The real game gets the value left on the bus: the prefetched instruction (0x2206 = the `mov r2,#6` two instructions ahead), not 0. The real game DOES do the same thing; the engine now returns the prefetch for an unmapped read and reproduces both moves on 100% of frames (232: 152/152, 337: 143/143). | 232, 337 | `mem.openBus` |
| **Battle state the code reads** (found by `tools/pokemonarena_anim_readset.mjs`, which lists every byte of RAM the ROM code reads before writing and that differs from the real image): `gAnimBattlerSpecies` (the launcher fills it from the party), `gBattleMons[b]` species / hp / level / maxHP (a function skips a battler whose hp is 0), `gBattleTypeFlags`, the OBJ tile-allocation bitmap, `gBattle_BGx_X/Y` and `gBattle_WINxH/V`, the registers the battle left behind. | 233, 264, 279, 419, 433 (persistent BG1 scroll / DISPCNT left by the real battle), 232 / 337 (a saved scroll value), 46 (the cry species) | `ctx.battleMons`, `ctx.battleTypeFlags`, `ctx.tileBitmap`, `ctx.battleVars`, `ctx.io` (defaults are plain values; the oracle harness feeds the real ones) |
| **Sound-effect waits.** `end` waits for IsSEPlaying; the engine answered "done". Now the song header's WAIT lengths and tempo give the length (`anim_sound.js`), plus one frame of player latency (measured). | every move whose last sound outlasts its visuals (Tackle: 28 -> 40 steps; the real game: 40) | `ctx.isSEPlaying(songIndex, framesSinceStart)`, default = the estimate |
| **Script command 0x34** is `34 b argc <argc x u16>` (3 + 2*argc bytes), not a fixed 3; command 0x33 is a 6-byte conditional jump. This was move 697's static-walk desync. | 697 | `anim_script.js` |

What the comparison harness now needs to be trusted (all tested in `tools/pokemonarena_anim_compare_test.mjs`, 26 checks, with an injected difference for every kind it must see):
the real capture is cached per move; the engine is fed the real battle's environment (`envCtx`); half-done lag captures are dropped by the Random() counter; I/O registers are compared per
frame in either of two phases (the GPU registers reach the chip straight through during VBlank and buffered otherwise, which depends on the real cycle) and by *shape* (the sequence of
values held 3+ frames), so a one-frame transient of the real chip does not read as a difference but a register that holds a different value for 4 frames does; the end frame is compared.

## API  (stable; AN1 integrates against exactly this)

```js
import { createMoveAnimator } from './move_anim.js';
const animator = await createMoveAnimator({ rom /* Uint8Array, the pinned 32 MiB image */, coverage /* optional: the parsed js/anim_coverage.json */ });

animator.available(kind, id)  // 'exact' | 'approx' | 'fallback' | 'none'.  kind: 'move' | 'general' | 'status' | 'special' | 'bg'
                              // id ranges: move 1..935, general 0..55, status 0..9, special 0..7, bg 0..84 (KIND_RANGE is exported).
                              // Without the coverage file every in-range id answers 'approx' (playable, unclassified), anything else 'none'.
animator.prepare('system', id | 'battle', ctx)  // Round 4 (kind 'system' only): a handle { advance(budgetMs), ready, phase, cache, profile, begin(), dispose() }; see "Round 4" at the top
const run = animator.start(kind, id, {
  attacker: { side: 0|1, species, ... },   // side 0 = the player's (near, back-sprite) side, 1 = the foe (far, front-sprite) side; 'player' / 'foe' accepted
  target:   { side: 0|1, species, ... },
  isDouble: false,                         // singles only
  args: [ ...u16 ],                        // gBattleAnimArgs[0..7] the script reads (general / status / special animations take parameters)
  animArg: 0,                              // gBattleSpritesDataPtr->animationData->animArg: general 0 (stat change) reads WHICH stat change here, see "Stat-change argument"
  terrain: 0,                              // gBattleTerrain (Secret Power / Nature Power / the restored background read it)
  hour: 12,                                // the real-time clock hour the few time-of-day animations read
  disable: { 4: n, 5: n, 6: n },           // the three DisableStruct bytes Rollout / Fury Cutter / Ice Ball / Spit Up read (hit counters)
  seed: 1,                                 // 32-bit; same seed -> same frames, bit for bit
  maxFrames: 1800,                         // a run still going then is cut off (run.truncated = true)
});
run.step();               // advance exactly ONE GBA frame (the caller steps at 59.7275 Hz; ANIM_FPS is exported)
run.done;                 // true once the ROM's script has ended (all sprites / tasks it created have finished), a fault stopped it, or maxFrames cut it off
run.error;                // null, or the CpuFault that stopped the run          run.truncated: cut off by maxFrames          run.frame: frames stepped
run.draw(target, opts);   // composite onto target (an ImageData / { data: Uint8ClampedArray(240*160*4) }): see below
run.battlerState(side);   // { dx, dy, scaleX, scaleY, rot, visible, alpha, tint } the engine's current displacement of that side's mon (informational: draw() applies it)
run.on('sound', ({ index, pan }) => ...);   // song-table index straight from the ROM's script (playse / panse / sound tasks); pan -127..127 (0 centre)
run.on('pan',   ({ pan }) => ...);          // a pan update that follows a sound already announced
run.dispose();            // optional; a run needs no cleanup (the animator reuses one engine; start() restores it to the booted state)
```

**draw(target, opts)**. `target` (240x160 RGBA) must hold the *battlefield without the two mons and without any UI*: the terrain picture, which the
engine treats as the real game's BG3: alpha blends, brightness fades and window effects read it exactly as the real blend unit reads BG3. The ROM's
animation then draws, in the real game's own priority order, the two mons (as OBJ sprites, or copied onto BG1 / BG2 by `monbg`, which is how
the ROM distorts them), the animation backgrounds and every effect sprite, and the result is written back into `target`.
**Order for the scene: terrain -> run.draw -> UI (healthboxes, text box).** While a run is active the scene must NOT draw its own mon sprites
(the run draws them, displaced / scaled / rotated / blended / tinted as the script says). A background animation (`fadetobg`) takes BG3 over
for its duration (the engine then renders its own BG3 from VRAM and ignores `target`), and gives it back at `restorebg`.
`opts.base === false` renders onto the engine's backdrop instead (tests).

Pass the attacker and the target on DIFFERENT sides (`side` 0 and 1) for a move that hits the foe. A SELF-targeting move (Mist, Swords Dance, weather ...) is launched by the game with attacker and target on the SAME side; pass it that way
and name the other Pokemon with `bystander: { species }` (round 2: the engine used to substitute the user's species for the other side and AN1 had to wipe it).

**Environment options (round 2; every one has a default that is a plain, valid battle, and every one is what the real-game comparison feeds from the real battle)**

| option | meaning | default |
|---|---|---|
| `bystander: { species }` | the other Pokemon on the field when attacker and target are the SAME side (self-targeting moves: Mist, Swords Dance, weather, ...) | the attacker's species |
| `occupiedSlots`, `battlerSlots` | gSprites slots the battle already holds (`null` = the old dense 0-11), the two battlers' slots | `[0..5, 60..63]`, `[9, 11]` (the real trainer battle) |
| `paletteTags`, `reservedPalettes` | the 16 `sSpritePaletteTags` words and the reserved count | tags 4-10 taken (real), 4 reserved |
| `rng2`, `rng1` | 4 u32 each: the Random2() / Random() state at launch | seeded from `seed` |
| `mainLoopRandom` | the real main loop draws Random() twice per frame; `step()` does too | `true` |
| `isSEPlaying(songIndex, framesSinceStart)` | answers the `end` command's sound wait; return false for the old "never waits" | the song-header estimate |
| `cryModel` / `cryCap` | `'none'` (a cry is over at once) or `'sample'` (it plays for its wave length; measured WORSE on the 8 cached moves with a cry task); a frame cap | `'none'` |
| `battleTypeFlags`, `battleMons: [{species, hp, level, maxHP}, ...]`, `tileBitmap` (128 bytes), `battleVars` (12 u16: gBattle_BG0_X .. WIN1V), `io: { offset: value }` | battle state the code reads | trainer flags (0x0c), hp 100, all tiles free, zeros, the boot's registers |
| `frameBudget` | instructions one frame step may use (the whole frame: script, sprites, tasks, VBlank) | 64,000,000 (`FRAME_BUDGET`); setup calls keep 3,000,000 (`CALL_BUDGET`) |

Run fields: `run.stepInstr` (instructions of the last `step()`), `run.peakStepInstr`, `run.heavySteps` (steps above `CALL_BUDGET`), `run.ioBeforeLaunch`. Events: `run.on('cry', ({ species, pan }))`
fires when the ROM starts a Pokemon cry (the host plays the cry; the engine does not wait for it); `sound` events still carry the real song-table index.

**Positions**: mon centres come from the ROM's own battler coordinate table (singles: player (72, 80), foe (176, 40); the table is at ROM 0x427fb8, 4 bytes per entry
`x, y, 0, 0` -- battle_ui.js's header says those bytes "are not in the ROM"; they are, interleaved with two zero bytes), vertical offsets from the species
table (`frontYOffset` / `backYOffset` / `elevation`). `attacker.x / y` are accepted and ignored.

**Speed**: `step()` costs about 0.2-1.3 ms of emulated ROM code + ~2 ms of drawing per frame (see Performance); the caller may call it several times per
display frame for a "fast" presentation speed.

**What the real game does around an animation (for the scene)**: it hides BOTH healthboxes for the length of the move animation and slides them back in
afterwards (frames 1-23 and 24-26 of the real Scratch capture show none, then both); the foe's ground shadow (two sprites with callback 0x0807eb89) stays;
and this hack's `BattleMainCB2` (ROM 0x0808b099) runs the whole battle callback chain several times per displayed frame ("battle speed"; the function at
0x0806a250 returns 1 -- the native rate -- while L is held). The engine reproduces the NATIVE 1x rate; 2x / 4x is `step()` called 2 / 4 times per frame.

## How it works  (strategy B of the stage plan: run the ROM's own code)

The animation machinery of the game is native THUMB code: the script interpreter (`RunAnimScriptCommand`, ROM 0x080297b1, dispatching through the
53-entry command table at ROM 0x00421154), ~hundreds of sprite callbacks and "visual tasks", the sprite engine (`CreateSprite`, `AnimateSprites`,
`BuildOamBuffer`), the task engine (`RunTasks`), palette fading, DMA requests, BG management. `anim_cpu.js` is a first-party ARMv4T interpreter (THUMB
formats 1-19, the ARM instructions the ROM contains, BIOS HLE: Div, DivArm, Sqrt, ArcTan, ArcTan2, CpuSet, CpuFastSet, LZ77 WRAM/VRAM, RL WRAM/VRAM, BitUnPack,
ObjAffineSet, BgAffineSet, Huffman). `anim_ram.js` is the memory map (EWRAM, IWRAM, I/O with DMA, palette, VRAM, OAM, ROM). `move_anim.js` boots a
minimal battle (the game's own init functions: heap, sprite / task / palette-fade reset, DMA queue, battle resource allocators, the BG set-up code), seeds
the few battle variables the animation code reads, calls the ROM's own `LaunchBattleAnimation(animType, id)`, then each frame does what the game's main loop
does -- script callback, `AnimateSprites`, `BuildOamBuffer`, `UpdatePaletteFade`, `RunTasks`, then the VBlank work (the battle VBlank callback: BG scroll
registers, OAM load, sprite-copy requests, palette transfer; and the DMA3 request queue) -- and `anim_ppu.js` renders VRAM / OAM / palette / registers.
No move is hand-ported. Unknown territory is COUNTED (unmapped accesses, unhandled SWIs, instruction budget), which is what the coverage table reports.

Why this strategy (feasibility numbers measured in this repository, this machine, load average from `os.loadavg()` is 0 on Windows so the run was on an otherwise idle 16-core box):
* boot of the whole engine: ~20 ms; one animation start (state restore + battler set-up): ~1-2 ms
* all 935 move scripts: 933 completed without a CPU fault on the first try (round 2: 1090 of the 1094 animations finish; the 4 that do not are listed under Fallbacks), with no hand-written per-move code; median 164 frames, median 7.4 thousand THUMB
  instructions per frame (p90 9.9 k, max 17.3 k) -> the interpreter spends 0.2-0.6 ms per frame
* 197,035 frames (all animations) in 164 s wall = 1.2 k frames/s without drawing

## Frame order and what the harness replaces

Per `step()`: `gAnimScriptCallback()` (if the script is active) -> `AnimateSprites` -> `BuildOamBuffer` -> `UpdatePaletteFade` -> `RunTasks` -> battle VBlank callback
(ROM 0x0808a07d, the real battle's own: it sets the BG scroll and window registers from `gBattle_BG*` / `gBattle_WIN*` at 0x02001c52.. and does LoadOam, ProcessSpriteCopyRequests, TransferPlttBuffer and the
scanline-effect handler; round 1 ran its sibling 0x08102d81, identical on 75 moves, see "Approximations"), then Random() twice (the real main loop's draws) -> `ProcessDma3Requests`.
Replaced by JS (hooks): the sound layer (`PlaySE`, `PlaySE12WithPanning`, `m4aSongNumStart`, panpot control -> events; `IsSEPlaying` answers from the song header, see "Sound-effect waits"; `PlayCryInternal` -> a `cry` event),
`RtcCalcLocalTime` (hour from `ctx.hour`), the m4a status poll of the cry player, the hack's smol graphics decoder 0x0811c080 (`gfxcodec.js` writes the same bytes), the library thunk `_call_via_r3` (a recording tap when tracing), and an
open-bus value for a read of unmapped memory. Nothing else is intercepted: not one animation routine.

## Where everything is (addresses found by literal-pool xrefs and structure; THUMB functions are listed with bit 0 set)

| What | Where | How found |
|---|---|---|
| script command table (53 handlers) | ROM 0x00421154 | scan for runs of THUMB pointers; `RunAnimScriptCommand` 0x080297b1 holds the literal |
| move -> script pointer | `gMovesInfo[move].battleAnimScript`, move record base 0x769860, stride 0x48, field +0x44 | the dispatcher `LaunchBattleAnimation` (0x0802adbd) reads `[0x08769860 + id*0x48 + 0x44]` |
| general / status / special scripts | table at 0x00421050 (type 0), 0x00420ff8+16 (type 2 status ids 0..9, type 3 special ids 0..7) | probing `LaunchBattleAnimation(type, id)` |
| sprite sheet / palette table | ROM 0x00421624, 16 bytes per tag: `{sheetPtr, size u16, tag u16, palPtr, palTag u16, pad}`; tag = 10000 + index | `loadspritegfx` handler 0x0802a3f5 |
| battler centres | ROM 0x00427fb8, 4 bytes per position (x, y, 0, 0) | `GetBattlerSpriteCoord` 0x080477c5 |
| engine variables | EWRAM 0x020018b4 (script ptr +0, frames to wait +4, active +5, callback +8, args +0x10 (u16[8]), target +0x21, attacker +0x22, move +0x40) | handler disassembly |
| sprites / tasks | gSprites 0x0203beb4 (64 x 0x44), gTasks 0x03005b34 (16 x 0x28) | `AnimateSprites` 0x082454cd, `RunTasks` 0x0825a565 |
| heap | 0x0201b25c, 0x1d000 bytes (`InitHeap` 0x081a55cd) | callers of InitHeap in the game's own init |
| mon picture buffers | the ROM's frame-image tables hard-code EWRAM 0x0202325c + 0x2000 * position (+0x800 frame 2): inside `gMonSpritesGfx->firstDecompressed` | `SetMultiuseSpriteTemplateToPokemon` 0x081eb1d3 |
| BG layout in battle | BG0 0x9800, BG1 0x9c00 (char block 0, map 28), BG2 0x5e00 (char block 0, map 30), BG3 0x5a0b (char block 2, map 26); mon-on-BG tiles at VRAM 0x4000 / 0x6000; animation backgrounds are loaded INTO BG3 (tiles 0x6008000, map 0x600d000, palette 2) | the BG set-up code at 0x08087738 + the real game's registers read through OR1's oracle |
| time of day | `gLocalTime` IWRAM 0x03005a78 (+2 = hour), filled by `RtcCalcLocalTime` 0x0822c67d | a Z-move task polls the cartridge RTC |
| the ROM's two PRNGs | IWRAM 0x03005a68 (Random, 0x0821c685) and 0x03005a58 (Random2, 0x0821c6ad: the one the animations call) | xref of the generator |

## Stat-change argument  (VERIFIED against the real game in round 2)

`general 0` reads `animArg` (`ctx.animArg`; the case number is `animArg - 14`). Measured on the REAL game with 14 moves (`tools/pokemonarena_anim_oracle_stat.mjs`: the game plays the move,
launches the general animation, and the u16 at `gBattleSpritesDataPtr->animationData->animArg` is read on its first frame), the encoding is, with k = 0..6 for the stats in this order
**ATK, DEF, SPE, SPA, SPD, ACC, EVA**:

| change | animArg | observed on the real game |
|---|---|---|
| +1 | 14 + k (14..20) | Howl / Growth ATK 14, Harden DEF 15, Double Team EVA 20 |
| -1 | 21 + k (21..27) | Growl ATK 21, Tail Whip DEF 22, Sand Attack ACC 26 |
| +2 | 37 + k (37..43) | Swords Dance ATK 37, Agility SPE 39, Nasty Plot SPA 40, Amnesia SPD 41 |
| -2 | 44 + k (44..50) | String Shot SPE 46, Fake Tears SPD 48, Sweet Scent EVA 50 |

All seven stats occur among the 14 observations and every one equals base + k, so "which of the seven slots is which stat" is now read off the game itself: the order is **ATK, DEF,
SPE, SPA, SPD, ACC, EVA**. (Round 1's `args[1]` slot numbers 0,1,3,5,6,2,4 are the engine's own on-screen column order for k = 0..6, i.e. ATK, DEF, ACC, SPE, EVA, SPA, SPD from the left;
that is a property of the ROM's sprite placement, which the engine reproduces: all 14 animations below match the real frames.) The remaining cases measured in round 1 -- animArg 28..36
and 51..54 draw nothing, 55..58 are the "all stats up 1 / up 2 / down 1 / down 2" cases -- were not reachable with a single-stat move and are verified on the engine only.

Engine against the real game with the real animArg (sprite state on every frame; the dummy-callback clone of the foe's mon sprite is left out of both sides, see Approximations):

| move | change | real animArg | frames identical |
|---|---|---|---|
| Swords Dance | atk +2 on the user | 37 (0x25) | 86/86 |
| Harden | def +1 on the user | 15 (0xf) | 72/72 |
| Agility | spe +2 on the user | 39 (0x27) | 86/86 |
| Nasty Plot | spa +2 on the user | 40 (0x28) | 86/86 |
| Amnesia | spd +2 on the user | 41 (0x29) | 86/86 |
| Double Team | eva +1 on the user | 20 (0x14) | 72/72 |
| Growl | atk -1 on the foe | 21 (0x15) | 72/72 |
| Tail Whip | def -1 on the foe | 22 (0x16) | 72/72 |
| String Shot | spe -2 on the foe | 46 (0x2e) | 86/86 |
| Fake Tears | spd -2 on the foe | 48 (0x30) | 86/86 |
| Sand Attack | acc -1 on the foe | 26 (0x1a) | 72/72 |
| Sweet Scent | eva -2 on the foe | 50 (0x32) | 86/86 |
| Growth | spa +1 on the user | 14 (0xe) | 72/72 |
| Howl | atk +1 on the user | 14 (0xe) | 72/72 |

## Coverage  (tools/pokemonarena_anim_coverage.mjs -> js/anim_coverage.json)

Definitions (the same words `available()` returns; "exact" keeps exactly its round-1 meaning):
* **exact**: it plays to the end through the ROM's own code with no unmapped memory access (unless the real game confirmed the open-bus value it got: verified moves), no Pokemon cry, no real-time-clock read, no approximated PPU feature and no measured
  difference from the real game. Because the code that runs IS the ROM's, "exact" means *no known source of divergence*, not "compared pixel for pixel".
* **verified** (a flag on top of exact): additionally a run of the REAL game (OR1's mGBA oracle, L held = native rate) matched the engine on every frame in `gSprites`
  (callback, position, OAM attributes, data[0..7]), in the tasks (function, priority, data), in the animation script's own position and wait counter, in the history of every I/O
  register (BG control / scroll, windows, blend), AND the animation ended on the same frame.
* **approx**: plays to the end but something it used is approximated, or the real game was measured to differ (the reasons are in the JSON, `oracle-diff:<what>` names the class).
* **fallback**: the engine cannot play it (CPU fault, frame-budget overrun, a script that never ends); the scene should use its lunge + blink.
* **none**: the ROM has no animation for it.

The sound-effect wait is NOT a reason by itself any more (round 1 listed it as a universal approximation): it is modelled from the song header (see "Sound-effect waits"), and the
accuracy of that model is exactly what the end-frame comparison measures per move. A move whose end frame differs from the real game's is approx for that measured reason
(`oracle-diff:end-frame-1` = the engine ended one frame early).

<!-- COVERAGE:BEGIN -->
| kind | ids | exact | approx | fallback | none | verified against the real game |
|---|---|---|---|---|---|---|
| move | 935 | 635 | 298 | 2 | 0 | 602 of 890 compared |
| general | 56 | 49 | 6 | 1 | 0 | general 0 (stat change): the arrow sprites of all 14 real stat animations |
| status | 10 | 10 | 0 | 0 | 0 | - |
| special | 8 | 7 | 0 | 1 | 0 | - |
| bg | 85 | 85 | 0 | 0 | 0 | - |
| **all** | 1094 | **786** | **304** | **4** | **0** | |

**Round 1 -> round 2** (the same tool, the same definitions): move exact 876 -> 635, approx 56 -> 298, fallback 3 -> 2; general 53/0/3 -> 49/6/1; status 10/0/0 -> 10/0/0; special 7/0/1 -> 7/0/1; bg 83/0/2 -> 85/0/0; verified moves 96 of 112 compared -> 602 of 890 compared. The exact count FELL because round 1's "exact" ignored the sound wait and compared only sprites on 112 moves; round 2 compares sprites, tasks, the script position, the I/O registers and the END frame on every move the real game would animate, and a measured difference makes a move approx (the definition below).

**Why the non-exact ones are not exact** (ids; a move can appear under several reasons):

* general: cry-length -- 6: 22, 30, 37, 39, 51, 53
* general: known -- 1: 3
* general: never-ends -- 1: 3
* move: cry-length -- 18: 45-46, 304, 336, 448, 459, 496, 547, 568, 574-575, 586, 621, 720, 799, 807, 841-842
* move: fault -- 1: 502
* move: known -- 2: 502, 852
* move: never-ends -- 1: 852
* move: not-reachable-in-oracle -- 4: 363, 502, 621, 841
* move: oracle-diff end-frame-1 -- 90: 18-19, 29-31, 37, 52, 64, 67, 73-74, 82, 92, 105, 120-121, 124, 139, 154, 164, 179, 190, 192, 199-200, 206, 220, 232, 235, 265, 282, 284, 289, 291-292, 303, 311, 331, 340, 342-344, 346, 350, 358, 364, 368, 379, 383, 388-389, 398, 402, 407, 426, 430, 436, 442-444, 447, 456, 468, 490, 504, 507, 521, 532, 559, 577, 580, 617, 694, 696-697, 703, 713, 746, 765, 795, 806, 809, 821, 829, 835, 847, 897, 907, 913, 927
* move: oracle-diff end-frame-2 -- 1: 320
* move: oracle-diff end-frame-63 -- 1: 539
* move: oracle-diff end-frame-75 -- 13: 28, 43, 96, 104, 106, 108, 110, 134, 159, 579, 590, 608, 695
* move: oracle-diff end-frame-76 -- 3: 39, 148, 589
* move: oracle-diff end-frame-88 -- 19: 14, 81, 97, 103, 107, 112, 133, 178, 204, 230, 294, 313, 319, 334, 397, 417, 538, 598, 770
* move: oracle-diff end-frame-89 -- 1: 184
* move: oracle-diff end-frame-9 -- 2: 89, 523
* move: oracle-diff end-frame-90 -- 1: 47
* move: oracle-diff io -- 62: 57, 93-94, 101, 123, 137-138, 144, 151, 169, 182, 185, 212, 234, 236, 242, 248, 262, 272, 293, 297, 312, 330, 354, 361, 413, 425, 461, 467, 469, 482, 527, 564, 566-567, 585, 588, 596, 622, 624, 642, 666, 668, 677, 721, 744, 760, 777-778, 780, 803, 836, 855, 859, 871, 879, 884, 898, 902, 921, 929, 931
* move: oracle-diff io+script -- 4: 194, 288, 318, 650
* move: oracle-diff script -- 34: 13, 69, 158, 188, 244, 296, 366, 424, 439, 466, 479, 536, 542, 544, 583, 687, 724, 727, 735, 743, 759, 763, 774-776, 786, 802, 853, 860, 862, 874, 890, 922-923
* move: oracle-diff sprites -- 2: 316, 878
* move: oracle-diff sprites+io -- 5: 171, 180, 464, 662, 754
* move: oracle-diff sprites+script -- 2: 217, 505
* move: oracle-diff sprites+tasks -- 1: 431
* move: oracle-diff sprites+tasks+io+script -- 4: 174, 218, 475, 656
* move: oracle-diff sprites+tasks+script -- 2: 223, 807
* move: oracle-diff tasks -- 31: 45-46, 205, 228-229, 283, 290, 301, 304, 323, 326, 336, 362, 448, 459, 496, 522, 547, 568, 574-575, 586, 725, 732, 787, 789, 794, 799, 815, 842-843
* move: oracle-diff tasks+io -- 3: 222, 720, 782
* move: oracle-diff tasks+io+script -- 2: 593, 734
* move: oracle-diff tasks+script -- 4: 595, 618, 712, 831
* move: ppu -- 21: 91, 151, 166, 180, 229, 262, 326, 349, 363, 461, 483, 666, 754, 760, 787, 789, 794-795, 800, 803, 853
* move: rtc -- 3: 854, 867, 869
* move: unmapped -- 6: 232, 304, 547, 586, 799, 842
* special: known -- 1: 4
* special: never-ends -- 1: 4

**Verified frame-for-frame against the real game (602 moves)**: 1-12, 15-17, 20-27, 32-36, 38, 40-42, 44, 48-51, 53-56, 58-63, 65-66, 68, 70-72, 75-80, 83-88, 90-91, 95, 98-100, 102, 109, 111, 113-119, 122, 125-132, 135-136, 140-143, 145-147, 149-150, 152-153, 155-157, 160-163, 165-168, 170, 172, 175-177, 181, 183, 186-187, 189, 191, 193, 195-198, 201-203, 207-211, 215-216, 219, 221, 224-227, 231, 233, 237-241, 245-247, 249-254, 257-261, 263-264, 268-269, 273-277, 279-281, 285-286, 295, 298-300, 302, 305-310, 314-315, 317, 321-322, 324-325, 327-329, 332-333, 335, 337-339, 341, 345, 347-349, 351-353, 355-357, 359-360, 365, 369-373, 376-378, 380-382, 384-386, 390-396, 399-401, 403-406, 408-412, 414, 416, 418-423, 427-429, 432-435, 437-438, 440-441, 446, 449-455, 457-458, 460, 462-463, 465, 470-474, 477-478, 480-481, 483-484, 486-489, 491-495, 497-501, 503, 506, 508-515, 517-520, 524-526, 528-531, 533-535, 537, 540-541, 543, 545-546, 548-558, 560-561, 563, 565, 569-573, 578, 581-582, 584, 587, 591-592, 594, 600-601, 603-606, 609-616, 619-620, 623, 625-633, 635-636, 638-641, 643-644, 646-649, 651-655, 658-661, 663-665, 667, 669-676, 678-686, 688-692, 699-702, 704-710, 714-719, 722-723, 728-731, 733, 736, 740-742, 745, 747-753, 755-758, 761-762, 764, 766-769, 771-773, 779, 781, 783-785, 788, 790, 792-793, 796-798, 800-801, 804-805, 808, 810-814, 816-817, 819-820, 822-828, 830, 832-834, 837-840, 844-845, 848-851, 854, 856-858, 861, 863-870, 872-873, 875-877, 880-883, 885-889, 891-896, 899-901, 903-906, 908-912, 914-920, 924-926, 928, 930, 932-935

status table hash (pinned by tools/pokemonarena_anim_test.mjs): `e0e3131401153074136e0e24861d61c91129a6249ba10fe92c4d94f226799688`; machine-readable table: `js/anim_coverage.json` (per-id status + reason codes, `verified`, `oracleDiff`, `neverAnimated`, `endFrameOff`). A move that is exact but not verified is exact *by construction* (the same ROM code on the same inputs). 45 moves could not be compared at all because the real game never animated them in any of the 11 scenarios within the time cap (173, 213-214, 243, 255-256, 266-267, 270-271, 278, 287, 363, 367, 374-375, 387, 415, 445, 476, 485, 502, 516, 562, 576, 597, 599, 602, 607, 621, 634, 637, 645, 657, 693, 698, 711, 726, 737-739, 791, 818, 841, 846); those that run through are exact-by-construction, 502 is a fallback.
<!-- COVERAGE:END -->

## Verified against the real game

`tools/pokemonarena_anim_oracle_batch.mjs` boots the real game in OR1's mGBA oracle and, for every move 1-935, records the animation frame by frame while the real game plays it
(L held = native 1x), then compares the engine's run of the same move:

1. **Scenario ladder** (`tools/pokemonarena_anim_oracle_scenarios.mjs`). A move whose conditions are not met shows NO animation, so the one scripted trainer battle (Bob's Sprigatito
   Lv5 vs Crystal's Marill Lv4) cannot record everything. The nine moves that "failed in the real battle" in round 1 (18, 46, 50, 68, 82, 100, 102, 105, 119) animate in these scenarios: **Whirlwind 18, Roar 46, Disable 50, Counter 68, Dragon Rage 82, Recover 105, Mirror Move 119** in a plain WILD battle against a Rattata (a trainer battle refuses Whirlwind / Roar / Teleport; why it gave no animation for the others in four RNG rolls was not established -- a wild battle simply works; Bob is at 11 HP there, which is why Recover plays, and a Rattata is not Fairy, which Dragon Rage's Dragon type needs); **Teleport 100** needs a wild battle with a SECOND party Pokemon (`wild2`: Gen 8 Teleport switches the user out); **Mimic 102** needs a prior turn in which the foe used a move the user does not know (`priorScratch`). All nine are compared (the table below). The ladder
   (`trainer, wild, prior, wounded, fastfoe, priorScratch, wild2, ghost, rock, flying, asleep`) is walked, with up to four RNG rolls each (a move that MISSES shows no animation), until the real game
   animates the move; the scenario that worked is recorded with the result. 45 moves never animated in any scenario within the time cap (listed in the coverage JSON): they are unreachable
   for the oracle, not shown to differ.
2. **Environment.** What the real battle looked like before the launch is fed to the engine (`envCtx`: sprite slots, palette tags, Random2 / Random() state, registers, battle mons, BG /
   window variables, terrain, the oracle's clock). That is environment, not behaviour: none of it is part of what is compared.
3. **What is compared**, per logical frame: the sprite multiset (callback, position, OAM attribute 0 / size, animation cell, data[0..7]; the battlers' own sprites and the real battle's
   healthbox / shadow sprites are environment and dropped; sprite ids inside data words are compared symbolically); the task list (function, priority, data); the animation block's script pointer
   and wait counter; every BG / window / blend / DISPCNT register (scroll registers modulo 9 bits); and the end frame.
4. **Lag frames.** The real main loop draws Random() twice at the END of every iteration (measured: the sfc32 counter word advances by exactly 2 per iteration). A hardware frame whose counter
   did not advance is an iteration still in progress (a heavy load, e.g. `LoadBattleAnimBg`): it is dropped before comparing. Without this the real run of move 5 looked like a 19-frame tail difference.
5. **I/O phase.** `SetGpuReg` writes the chip straight through while the CPU is inside VBlank and buffers the write for the next VBlank copy otherwise, so a register's value appears in the real capture
   one frame earlier or later than in the engine depending on the real cycle. A frame matches when each register equals the engine's value at either phase; the SHAPE of each register's history
   (values held 3+ frames, in order) is compared separately, so a one-frame transient of the real chip does not count as a difference and a register holding another value for 4 frames does.

<!-- ORACLE:BEGIN -->
Result of the full batch (every move 1-935; the real game was recorded once per move and cached, so the engine could be re-compared after each fix): **890 moves compared, 45 never animated by the real game**.

| outcome | moves |
|---|---|
| **sprites, tasks, script position, I/O register shape AND the end frame all equal** (verified) | **602** (562 of them also equal on the I/O registers frame by frame) |
| everything equal except the END frame, off by 1-2 frames (the sound-length estimate) | 91 (end-frame deltas: 1: 16, 2: 9, -1: 107, -2: 2) |
| everything equal until the engine ends, but the real script goes on for 9-90 frames | 40: 14:-88 28:-75 39:-76 43:-75 47:-90 81:-88 89:-9 96:-75 97:-88 103:-88 104:-75 106:-75 107:-88 108:-75 110:-75 112:-88 133:-88 134:-75 148:-76 159:-75 178:-88 184:-89 204:-88 230:-88 294:-88 313:-88 319:-88 334:-88 397:-88 417:-88 523:-9 538:-88 539:-63 579:-75 589:-76 590:-75 598:-88 608:-75 695:-75 770:-88 |
| differences in the I/O register history only | 62 |
| differences in the script position | 38 (scripts that diverge before the end, with or without register differences) |
| differences in tasks (the cry task above all) | 40 |
| differences in sprites | 17 (sprites+io: 171, 180, 464, 662, 754; sprites+tasks+io+script: 174, 218, 475, 656, 852; sprites+script: 217, 505; sprites+tasks+script: 223, 807; sprites: 316, 878; sprites+tasks: 431) |

Real-game timing seen by the recordings: 650 of 890 animations contain at least one lag frame (an iteration longer than one frame); 1276 of 177859 hardware frames were lag frames and are dropped by the Random() counter before comparing (176583 logical frames compared). Scenarios the animations needed: trainer 808, prior 7, wild 62, fastfoe 1, wild2 7, priorScratch 2, asleep 3.

The nine moves round 1 could not compare, and the one scenario each animated in:

| move | scenario | sprites | tasks | I/O frames | script | end-frame delta |
|---|---|---|---|---|---|---|
| 18 | wild | 81/81 | 81/81 | 83/83 | equal to the last frame | -1 |
| 46 | wild | 97/97 | 27/97 | 98/98 | equal | 0 |
| 50 | wild | 110/110 | 110/110 | 111/111 | equal | 0 |
| 68 | wild | 85/85 | 85/85 | 86/86 | equal | 0 |
| 82 | wild | 176/176 | 176/176 | 178/178 | equal to the last frame | -1 |
| 100 | wild2 | 94/94 | 94/94 | 95/95 | equal | 0 |
| 102 | priorScratch | 113/113 | 113/113 | 114/114 | equal | 0 |
| 105 | wild | 180/180 | 180/180 | 181/181 | equal to the last frame | -1 |
| 119 | wild | 32/32 | 32/32 | 33/33 | equal | 0 |

Classes of the remaining differences (ids):

* script: 34 (13, 69, 158, 188, 244, 296, 366, 424, 439, 466, 479, 536, 542, 544, 583, 687, 724, 727, 735, 743, 759, 763, 774-776, 786, 802, 853, 860, 862, 874, 890, 922-923)
* tasks: 31 (45-46, 205, 228-229, 283, 290, 301, 304, 323, 326, 336, 362, 448, 459, 496, 522, 547, 568, 574-575, 586, 725, 732, 787, 789, 794, 799, 815, 842-843)
* io: 62 (57, 93-94, 101, 123, 137-138, 144, 151, 169, 182, 185, 212, 234, 236, 242, 248, 262, 272, 293, 297, 312, 330, 354, 361, 413, 425, 461, 467, 469, 482, 527, 564, 566-567, 585, 588, 596, 622, 624, 642, 666, 668, 677, 721, 744, 760, 777-778, 780, 803, 836, 855, 859, 871, 879, 884, 898, 902, 921, 929, 931)
* sprites+io: 5 (171, 180, 464, 662, 754)
* sprites+tasks+io+script: 5 (174, 218, 475, 656, 852)
* io+script: 4 (194, 288, 318, 650)
* sprites+script: 2 (217, 505)
* tasks+io: 3 (222, 720, 782)
* sprites+tasks+script: 2 (223, 807)
* sprites: 2 (316, 878)
* sprites+tasks: 1 (431)
* tasks+io+script: 2 (593, 734)
* tasks+script: 4 (595, 618, 712, 831)
<!-- ORACLE:END -->

## Sound-effect waits and cries

The ROM's `end` command (and `waitsound`) polls `IsSEPlaying()`, so an animation lasts as long as its last sound effect. The engine has no sound hardware; `pokemonarena/js/anim_sound.js` answers
the question from the song's own header in the ROM (`gSongTable` at ROM 0x095e8ed8: u32 header pointer, u16 player): a small parse of the m4a format that follows only what decides when a track
ends -- the WAIT commands (0x80-0xB0, the gClockTable lengths), TEMPO (value x 2 BPM), GOTO / PATT / PEND / REPT -- and ignores notes, voices and the mixer. At the default tempo 150 one tick is one frame;
tempo T advances T/150 ticks per frame; IsSEPlaying looks at the players SE1 and SE2 only (song-table player 1 and 2); a looping song is capped at 600 frames; the player adds one frame of
latency (`SE_LATENCY = 1`, chosen on 297 cached real animations: end frame exact for 185/203/178 per shard with 0, 221/242/228 with 1, 225/218/204 with 2, 172/193/167 with 3). `ctx.isSEPlaying(songIndex, framesSinceStart)` replaces the estimate;
sound events keep the real song-table index. Measured accuracy of the estimate on the sampled moves whose end is within 3 frames: 242 of 274 end on exactly the real frame, 24 one frame early, 5 one late,
3 more than one off (tempo 220 songs are the most often one frame early). Not modelled: note release tails, a higher-priority song cutting a lower one.

**Cries.** The ROM starts a cry with `PlayCryInternal` (0x082440b8) and polls the cry player's status (0x081a14b4). The engine raises a `cry` event ({species, pan}) and answers "finished"
(`cryModel 'none'`); the alternative `'sample'` (the wave's sampleCount / rate, `cryFrames`) was measured WORSE (of the 8 cached moves whose script has a cry task: 5 end on the real frame with
'none', 1 with 'sample'). The real cry task of Growl ends 16 frames after the first cry and the second cry lasts ~61: lengths set by the cry MODE (Growl 1 / 2, Roar 1 / 2, ...), which depend
on the m4a cry-song bytes the engine does not run. Moves whose script waits on a cry (45 Growl, 46 Roar and the ~25 others listed under "tasks" above) are approx: the engine ends the cry
task at once and the script goes on.

## Fallbacks (round 2: what each waits for)

* **831 Syrup Bomb, general 41 / 44, bg 83 / 84** ran into the 3M-instruction budget in round 1 and were called "heavy software pixel loops". They were not: they were the smol decoder's failed
  `Alloc` -> the ROM's assertion screen -> the spin loop `VBlankIntrWait` (found by tracing the hot PCs back to the allocation and reading the allocator's own failure path). With the decoder
  replaced they run to the end (168, 100, 231, 127 / 127 frames). The measured cost of any animation is now at most **224,383 instructions in one frame step** (p99 222,333, median 113,701; none above
  the 3M call budget): ~0.2-1.3 ms per step in this interpreter. At ~2.4 cycles per instruction a GBA frame holds ~117,000 instructions, so 49 of the 1090 animations have a frame the real
  hardware could not finish in 1/60 s -- the real game lags there (lag frames above) and the engine does not (it has no cycle clock). `FRAME_BUDGET` (64M) bounds a runaway frame; `CALL_BUDGET` (3M) the setup calls.
* **502 Ally Switch** is a doubles move: its tasks wait for the partner battler, which a singles battle does not have. The real game never animated it in singles (OR1: 22 tries over 11 scenarios,
  no animation), and the engine spins until the 64M frame budget (~1.9 s) and stops with a typed `CpuBudgetError`. fallback; the scene should not call it.
* **852 Acid Downpour** is animated by the real game (400 hardware frames, 9 of them lag). Its script waits at 0x082bcef0 (`waitforvisualfinish`) for the BG-scroll task 0x08055121 (data[3] = 0xffff),
  which ends only when `gBattleAnimArgs[7] == 0xffff`; the script sets that argument AFTER the wait (0x082bcf00). In the real game the wait is passed (the real run continues at frame ~358); in the
  model it is not. The writer of that argument that the real game has and the model lacks was not found (args[7] pre-set to 0, 1 and 0xffff did not release it). fallback, cause unexplained.
* **general 3 and special 4** wait for the PLAYER's mon sprite to reach animation command 1 (`gSprites[id] + 0x2b == 1`; callback 0x080514ad / task 0x08052b09). The model's mon sprite
  has `animNum` 1 from step ~15 but its command index stays 0 (flags 0x30). They are the send-out style animations and cannot be launched by one real move, so no real recording exists.
  fallback, cause not determined.
* **232 Metal Claw and 337 Dragon Claw** (round 1: "the ROM builds a corrupted pointer"): the real game does the same -- it reads through 0xffffba30 and keeps what the bus gives (0x2206, the
  prefetched instruction). With the open-bus model both match the real game on every frame (see above).

## Approximations and what is NOT verified (honest list)

* Sound: the length of a sound effect is an estimate from the song header (above); a cry has no length.
* **The engine has no cycle clock.** The real game's lag frames (an iteration longer than a frame) are not reproduced: 49 of 1090 animations have a frame step above ~117k instructions. The comparison
  removes the real lag frames; a host that wants the real stutter would have to pace such frames itself (`run.stepInstr`).
* I/O register timing: a register written during VBlank shows one frame earlier than one written outside it; the engine copies at the end of its step. The register HISTORIES are compared by shape.
* The real-time clock is pinned (`ctx.hour`, default noon) for the animations that read it (3 Z-moves: 854, 867, 869); the oracle runs use the oracle's own clock (hour 22).
* 21 moves use a scanline effect (HBlank DMA streaming a register per line); the replay per line is verified only where the oracle compared the move.
* Mosaic on OBJ sprites is approximated; affine BGs have no unit test beyond the generic ones (`bg.affine.untested`).
* **The VBlank callback** (round-1 open item): the real battle's callback is 0x0808a07d, round 1 ran its sibling 0x08102d81. Disassembly (round 2): 0x0808a07c reads the 12 u16 at 0x02001c52-0x02001c68
  (BG0..3 X/Y, WIN0H/WIN0V/WIN1H/WIN1V) and writes them to REG 0x10-0x1e, 0x40, 0x44, 0x42, 0x46, then calls LoadOam (0x08245634), ProcessSpriteCopyRequests (0x08245944), TransferPlttBuffer (0x081bf888)
  and the scanline-effect handler (0x0822f978); 0x08102d80 does the same with absolute addresses and the transfer in another order. Playing 75 moves (every 12th cached one) with either gave identical
  I/O registers, OAM and sprite arrays on every frame, and the engine now runs the real 0x0808a07d (the golden streams did not change). `ctx.vblank` selects either.
* Party data: `GetMonData` on the party sees an empty party; the species the launcher would read is injected (`gAnimBattlerSpecies`, `gBattleMons`). Animations that read the party mon's own data
  (personality-dependent palettes, Transform of a real mon) are not modelled. No double battles.
* **The foe's cloned mon sprite**: for a FOE-targeted general / status animation the ROM creates a dummy-callback copy of the foe's mon sprite; the real copy runs front-sprite animation 1
  (command index 2, data[3] = 120, data[4] = 136) and the model's stays on animation 0. The arrow sprites match on every frame (`tools/pokemonarena_anim_oracle_stat.mjs` ignores that one sprite),
  but a scene that draws the clone sees the foe's mon not shaking.
* The healthboxes and the foe's shadows do not exist in the engine (the scene owns them).
* The 40 moves whose real script keeps waiting 9-90 frames after the engine's ends (ids under "end frame off by more"): in the real game the script reaches the shared tail
  `waitforvisualfinish; end` (ROM 0x082bb00e) and the battle's own tasks 0x0807ed1d / 0x08054bb9 -> 0x08054f51 appear at that moment and hold the visual-finish count; the model ends instead.
  Cause not determined (the task functions are the battle's, not the animation's).

## Tests

| Command | What | Result (this run) |
|---|---|---|
| `node tools/pokemonarena_anim_cpu_test.mjs` | ARMv4T interpreter + memory map + BIOS HLE unit tests + (round 4) sliced calls, 8 negative-control mutants | 63 passed, 0 failed; 8 of 8 mutants detected |
| `node tools/pokemonarena_anim_ppu_test.mjs` | PPU unit tests on synthetic VRAM / OAM, the colour effects as the pinned mGBA draws them (and the 5-bit hardware switch), the streamed BLDALPHA with its one-line delay, the base picture's BG3 scroll and colour map (round 6), 7 negative-control mutants | 21 passed, 0 failed; 7 of 7 mutants detected |
| `node tools/pokemonarena_anim_test.mjs [--full] [--oracle]` | static parse of all 935 scripts, command lengths vs executed scripts, golden frame-stream hashes (19 animations), determinism, negative controls, API / typed errors, coverage integrity, smoke run, **round-2 environment pins (slots, palettes, partner battlers, self target, Random2, smol decoder vs native, sound waits, cries, frame budget, commands 0x33 / 0x34), each with a negative control**, performance | default **122 passed, 0 failed** (95 before round 6: + the terrain colour map against the ROM's own blend arguments, the ramp surviving `restorebg`, 5 negative controls); `--oracle` **171 passed, 0 failed** (round 6: + the field comparison of 19 moves and four negative controls); `--full --oracle` (all 1094 animations + 11 moves against the real game, end frame included, + a negative control, + round 6) **175 passed, 0 failed** (122 in round 5; `--full` alone was not re-run in round 6) |
| `node tools/pokemonarena_anim_compare_test.mjs` | the real-game comparison machinery without an emulator: a capture is made from the engine itself in the real convention, then damaged -- every kind of injected difference (a data word, a task, the script pointer, the end frame, lag frames, a one-frame register transient, a 4-frame register difference, the target side) must be seen, and an undamaged copy must compare identical; `envCtx`, the scenario ladder and the capture cache round-trip | **34 passed, 0 failed** (26 before round 6: + the FIELD comparison machinery: a missing terrain fade, the box mask, the luminance series) |
| `node tools/pokemonarena_anim_field_compare.mjs [--moves "A,B"] [--foe N] [--png dir] [--json f] [--calibrate]` | round 6, the whole FIELD against the real game pixel by pixel: 37 moves, mean differing px per frame, exact frames, within +-14 frames, the terrain-patch luminance; `--calibrate` measures the oracle's colour-effect arithmetic | 25 of 37 moves pixel-exact on every frame; calibration 0 mismatches in 2.5 M brightness and 276 K alpha values (`anim_test --oracle`: 171 passed) |
| `node tools/pokemonarena_anim_sys_test.mjs [--update] [--oracle <dir>]` | round 3, the system animations: API / typed errors, the intro's timeline (messages, cries, sound cues, the action menu), determinism, every ctx field that must change the picture, each event's end state, layer masks, golden frame hashes (`js/anim_sys.golden.json`), 12 negative controls (text speed, cry length and latency, BIOS rounding, environment, gFonts, the comparison tool's difference detector on 7 fields); round 4: the prepared / sliced path against the round-3 stream goldens, with 8 more mutants; `--oracle` adds the real-game comparison of the wild intro and 5 events | 312 passed, 0 failed (318 with `--oracle`) |
| `node tools/pokemonarena_sys_stream.mjs --out <file>` | round 4: the md5 of every frame (38400 pixels) + event of 34 system runs (ids 0-9, 17 balls, shiny, long cry, trainer, night, 2 send-outs); `js/anim_sys_stream.golden.json` holds the values the sliced path must reproduce (28 round-3, 4 re-recorded and 2 added in Round 5) | 34 of 34 equal |
| `node tools/pokemonarena_sys_natural.mjs [--dir D] [--foe 130,143,...] [--player 130,...] [--json f]` | round 5: the game's NATURAL trainer / player switch (its own battle script) rendered through the first-party PPU vs the engine's send-out, aligned by the Random() counter; needs the oracle (native 1x, text layer left out) | foe 7 of 7 pixel-exact (0 px, timeline and shadow sprites equal); player 4 of 6 exact, 2 within 1-2 transition frames |
| `node tools/pokemonarena_sys_tick.mjs [--budgets 2,4] [--out f.json]` | round 4: the per-tick cost of 23 system runs in headless Chrome (muted, throwaway profile, behind the browser lock), synchronous vs sliced | see Round 4 |
| `node tools/pokemonarena_sys_compare.mjs --dir <oracle state> [--foe N --player N --trainer 1 --exact 1 --shots a,b,c] [--event ID [--switch SPECIES]] [--batch coverage|events]` | round 3, the real-game comparison of the system animations (sprites per iteration + timeline + screenshots), `--batch coverage` = 84 species pairs covering every animation id, `--batch events` = every event x 4 pairs; `--event none` records an intro with the event recorder's key script | see Round 3 |
| `node tools/pokemonarena_anim_coverage.mjs --oracle <final.json> --stat <stat.json>` | writes `js/anim_coverage.json` | see Coverage |
| `node tools/pokemonarena_anim_oracle_batch.mjs --dir <oracle state> --out <dir> --cache <dir> --ids 1-935 [--shard i/n] [--from-cache 1]` | the real-game comparison of every move (needs the OR1 oracle; `--from-cache` re-compares the cached real recordings against the current engine without it) | see Verified |
| `node tools/pokemonarena_anim_oracle_stat.mjs --dir <oracle state>` | the 14 stat-change animations against the real game | see Stat-change argument |
| `node tools/pokemonarena_anim_readset.mjs --dir <oracle state> [--scenario ..] <move ids>` | every byte of RAM the ROM code reads before writing that differs from the real battle's image (how the missing battle state was found) | n/a |
| `node tools/pokemonarena_anim_oracle_diag.mjs --dir <oracle state> [--scenario ..] <move ids>` | per-move sprite / I/O / task / script differences with and without the real Random2 state injected | n/a |
| `node tools/pokemonarena_anim_sheet.mjs --out <dir> --kind move <ids>` | scratch contact sheets (PNG) | n/a |

## Performance (per GBA frame, warm engine; the frame budget at 59.7275 Hz is 16.74 ms)

Measured with `tools/pokemonarena_anim_test.mjs` (Node 24, V8, 16 logical cores). Windows `os.loadavg()` is always 0, so the machine load is stated from `Win32_Processor.LoadPercentage`: **38-40%** while these numbers were taken (other agents were running; 6% when idle):
`step()` 0.25-0.33 ms mean, `draw()` 1.85-2.3 ms mean, worst single frames 3.5-8.5 ms (ratios, not absolutes, are the durable part at that load). Instructions per frame step over all 1090 animations that finish: median 113,701, p90 113,965, p99 222,333, **max 224,383**
(no step above the 3,000,000-instruction call budget). One frame of the GBA holds ~117,000 instructions at ~2.4 cycles per instruction, so 49 animations have a step the real hardware would lag on.
The runaway case, move 502, burns the 64,000,000-instruction frame budget in ~1.9 s before its typed error.

## Findings about the ROM worth knowing

* The expansion's `battleAnimScript` lives in the move record (`+0x44`), and the sprite sheets are `smol`-compressed (modes 1-6), not LZ77.
* This hack runs the battle callbacks several times per displayed frame ("battle speed") and returns 1x while L is held.
* The real battle hides both healthboxes during a move animation.
* The scene's header claims the battler-coordinate bytes `48 50 B0 28` are not in the ROM: the table is at 0x427fb8 with two padding bytes between entries.
* Round 2: a read of unmapped memory returns the prefetched instruction (open bus), not 0 -- the ROM's own code (232 / 337) relies on it.
* The real main loop draws Random() twice per iteration, and an iteration longer than a frame (lag) leaves a half-done hardware frame whose Random() counter has not advanced.
* The hack's smol graphics decoder allocates a temporary buffer as large as the output; on a 12 KB terrain stream a heap that is 2 KB too tight fails into the ROM's assertion loop.
* The real battle's gSprites layout: healthboxes / shadows in 0-5 and 60-63, the player's mon in 9, the foe's in 11 (7 in a wild battle).

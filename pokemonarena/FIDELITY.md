# Battle screen fidelity (stage FA1)

User, verbatim: "we need to ensure that the healthbars and everything during the battle is accurate to the rom".

Until this stage the arena's battle screen was composed from ROM art with many numbers taken from memory of the Gen-3 decompilation. This ROM is **not** vanilla
(pokeemerald-expansion-like, with its own healthbox, window frame, battle-speed switch and menu words), so the recollection was wrong in many places. Every number below
was re-derived from one of three sources, and each row says which:

* **REAL** = the real game's frames, palette RAM, OAM and VRAM from OR1's oracle (`tools/pokemonarena_rom_oracle.mjs`, the site's own mGBA core running the ROM; a real
  trainer battle and wild battles; clock pinned to **noon** 2023-11-14 12:00 UTC so the game's night tint is off). Compared pixel by pixel with the arena's render.
* **CODE** = the ROM's own THUMB/ARM code **run** in `tools/pokemonarena_fidelity_cpu.mjs` (a small interpreter written for this stage) and compared with the arena's port over sweeps.
* **TABLE** = a ROM table/string read at the cited offset (checked against REAL).
* **EYE** = still chosen by eye (said plainly in the status column).

Every offset is a file offset (add `0x08000000` for the bus address). No ROM bytes, frames or states are committed: the tests read the ROM from where the other
pokemonarena tests find it (`ARENA_ROM` or `gba/gbaWasm/roms/Pokemon SoulGold (v1.1.1).gba`), build frames at run time, and **skip loudly (counted)** without it.

## Verification, in one place

`node tools/pokemonarena_fidelity_test.mjs` -> **145 passed, 0 failed, 0 skipped** (30 s; machine CPU about 50 %, 5 GB free). Sections:

* A1-A6 (CODE): the interpreter reproduces the ROM's `__divsi3`; `MoveBattleBar @0x08085ecc` is run for **11,964 bars at rest** (140 max-HP values, every HP) and
  **1,100 drains/fills = 23,928 frames** (printed HP, filled pixels, colour per frame): 0 mismatches. `GetScaledHPFraction @0x08086c84`, `GetHPBarLevel @0x08086cac`,
  `GetCurrentPpToMaxPpState @0x08094dc8` and the battle-speed switch `@0x0806a250` are run too. Negative controls: the pre-FA1 colour rule, no-minimum-pixel, round-not-floor,
  `max/48` drain, 1 HP/frame drain, no fixed-point branch, a ROM copy with `toAdd = max/48`, a ROM copy with a changed compare, a corrupted division routine.
* B1 (REAL): 10 healthbox scenarios x 5 regions = **0 differing pixels**; negative controls (ROM bytes flipped, text one pixel off).
* B2 (REAL): action menu x4 cursors, move menu x4, **29 PP states**, 2 long-name menus, message window, the wait arrow on 36 consecutive frames = **0 differing pixels**.
* B3 (REAL): shiny boxes (4 scenarios), the 12 battle backgrounds, a second species' sprites = **0 differing pixels**.
* B4 (REAL OAM): over a 140-frame turn the foe's shadow sprites were never present without the foe's own sprite, and were hidden for the whole of both moves' animations; the arena follows the same rule.

## Element by element

`before` = the arena as it was; `after` = now. "exact" means 0 differing pixels (or 0 mismatches) on the stated reference scenarios; it does not mean "every possible input was tried".

| Element | Real-game value and how obtained | Arena before | Arena after | Status |
|---|---|---|---|---|
| **Foe healthbox position** | sprites at (2,14) and (66,14), 64x32 each (REAL: OAM at the action menu, a message, 10 scenarios) | (12,14) | (2,14) | exact |
| **Player healthbox position** | (136,72) at rest (REAL: OAM at a battle message) | (126,72) | (136,72) | exact |
| Player box idle bob | +-1 px while the action / move menu waits: y 72 <-> 73, half period 18.3 displayed frames at the oracle save's 2x battle speed = 36.6 frames at 1x (REAL: OAM over 140 frames); the Pokemon bobs 55 <-> 56, half period 18 (36 at 1x). Same at 50/50, 12/50, 3/50 HP (OR1): no HP-dependent bounce | none | `scene.js view()` | **approx**: amplitude and period measured, the phase when the menu opens is not reproduced |
| Name text | font **small** while the name is <= 50 px wide, else the narrower **font 11** (never truncated); origin box (8,3) foe / (16,3) player (REAL: 18 names of 49..60 px, 51 px already switches) | small, origin (8,1)/(17,1), truncated by an invented rule | rule above | exact |
| Gender symbol | the next glyph after the name (no gap), in the **name's font**; male colour = palette index 11 (64,200,248), female = 10 (248,152,144) of ROM palette 0x72140c = OBJ palette 4 (REAL: palette RAM) | 1 px gap, 'small' glyph, both colours from the wrong palette (0x716bdc: orange) | exact | exact |
| Text colours in the box | 1 dark, 3 shadow of 0x72140c (REAL); the HP-bar palette was used before (shadow too dark) | wrong palette | 0x72140c | exact |
| Level | `Lv` + digits right-aligned to box x 88 (foe) / 96 (player), y 3 (REAL: 1, 2 and 3 digits) | x 93/101, y 1 | fitted | exact |
| HP label, HP bar frame, HP bar fill tiles | the art matched already (REAL: 0 differing after the box moved) | exact | exact | exact |
| **HP bar fill (pixels)** | `floor(48*hp/max)`, never 0 while the **target** HP > 0; for max < 48 the animated value is Q8 (CODE: `CalcBarFilledPixels @0x0808434c`, run via `MoveBattleBar`) | same formula | `barFill()` (adds the target / Q8 rule) | exact (11,964 bars) |
| **HP bar colour** | by the HP **value**: green when hp = max or hp > max/2 (integer), yellow when hp > max/5, else red; a max of 1 stays green; decided on the animated value mid-drain (CODE: `MoveBattleBar`, `GetHPBarLevel @0x08086cac`; REAL agrees on 5 fills + 39/42 % yellow, 6.5/13 % red) | pixel thresholds > 24 px green, > 9 px yellow (recollection) | `hpBarColorAt()` | exact (**82 of the 3,202 bars of the first sweep were the wrong colour before**, e.g. 51/100 yellow, 20/99 red) |
| **HP drain rate** | per frame: `max/24` HP for max > 23 (else 1); under max 48 a Q8 fixed point that takes 48 frames full-to-empty; the first call already moves; the bar ends on a call that returns -1 (CODE: `CalcNewBarValue @0x080839e4`; REAL: 2 px/frame at 1x, shown as 4 px at the oracle save's 2x: foe 200->160: 48,44,40,38; 19->15: 46,44,42,40,38,37) | `max/48` HP per frame (half the real speed), no fixed point | `hpBarInit/hpBarStep` | exact (1,100 drains / 23,928 frames) |
| Drain of a heal | the same routine with the sign flipped (CODE) | one HP/frame | same stepper | exact |
| **Battle speed** | `GetBattleSpeed @0x0806a250` returns 1/2/3/4 logic iterations per frame for VAR 0x40dc = 0/1/2/3, and 1 while L is held (CODE). The oracle's save is at **2x**: all REAL timings were halved to the 1x the arena runs | not modelled | arena = 1x | exact (stated) |
| **HP numbers (player)** | `cur/max` as one string, no padding, right-aligned to x 231 (REAL: 1/20, 3/25, 19/19, 90/99, 714/714) | `padStart(3)` each, wrong | plain string | exact |
| Foe HP numbers | none shown (REAL) | none | none | exact |
| EXP bar | 64 px at box (32,32); fill = `floor(64*into/span)` (REAL: 0 %, 20 %, 50 %, 97 %); the box shares the sprite's palette (gold when shiny) | geometry exact | same + shiny palette | exact; **arena-only**: the arena has no EXP, the bar stays empty |
| **Status labels** | the box's palette slot `12 + battler` is overwritten with the status colour (PSN 0x6198, PAR 0x0ef7, SLP 0x4694, FRZ 0x72d1, BRN 0x29dc; `UpdateStatusIconInHealthbox @0x08084d4c`'s literal pool) and the label tiles are copied with nibbles 5->4 and 6->2; foe: label at box (8,16) **replaces** the HP label (tile 2 of the label row becomes element 68 = the bar's end cap, ROM 0x720b0c); player: label at box (16,24) **beside** the kept HP label; TOX shows PSN (REAL: all five on both sides, 3 re-checks) | blue/green strip colour for every status, label glued to the bar | exact on both sides | exact |
| **Shiny healthbox** | the box sprites switch to OBJ palette 6 = ROM 0x716bbc (SpritePalette record 0x437740, tag 0xd70d): the same art in gold; status labels are NOT nibble-remapped then (REAL via `startBattle(shinyPid)`) | normal palette | gold | exact (4 scenarios) |
| **Foe ground shadow** | a 64x8 shape from the 32 tiles at ROM 0x6c6f48 (SpriteSheet record 0x4377b8, tag 0xd759), class `+0xa4` of the species record (0..3 = tile base 8*class), at (144 + s8 `+0xa2`, spriteTop + 44 + s8 `+0xa3`), palette index 1, behind the Pokemon, not drawn for the player (REAL: OAM of 13 species). Visibility (REAL OAM, 140 frames): present only while the foe's sprite is, so it blinks with a hit foe; hidden for the whole of a move animation (the scene owns the shadow; AN2's animation engine does not create it) | **missing** | drawn, with that visibility | exact (4 species compared pixel-wise; the 13-species offsets by OAM; visibility by OAM trace) |
| **Foe elevation** | byte at species `+0x9c` (235 species have one, 1..19 px); the arena read `+0x93`, which is 0 in all 1,038 species, so no floating Pokemon was ever lifted (Magnemite was 17 px too low) | read the wrong byte | `+0x9c` | exact (Magnemite scenario: 0 differing) |
| Sprite placement | foe top = 8 + frontYOffset - elevation, x 144; player top = 48 + backYOffset, x 40 (REAL: OAM). The centres (72,80) player and (176,40) foe are in the ROM at **0x427fb8** as u16 pairs `48 50 00 00 b0 28 00 00 ...` (AN2's finding; the earlier "not in the ROM" came from searching the bytes without the two padding bytes) | exact | exact (the stale "recollection" comment was corrected) | exact |
| **Battle background** | the game's terrain id *i* (0..11) **is** the arena's environment record *i* (REAL: all 12, 0 differing pixels outside the boxes). The page picks `seed % 9`, so terrains 9-11 are never used | n/a | n/a | exact mapping; the pick is arena-only |
| Message window art + text | window art exact (same ROM tilemap); text starts at the window's left edge, y + 1 (REAL: "Bob used Scratch!") | 2 px in | fixed | exact |
| **Wait-for-A arrow** | ROM 8x8 tile at 0xf2c688 (2 = dark outline, 1 = dark-red fill 0x000e), 1 px after the last character of the last line, does **not blink**, bobs 0,-1,0,+1 with a period of 18 frames (5,4,5,4) (REAL: 36 consecutive frames) | font glyph at the window's right edge, blinking | tile, bobbing | exact |
| Action prompt / menu windows | prompt text at window x + 1, y + 1; the menu words are the ROM's own string `gText_BattleMenu` at 0x43cf54 (`Battle{CLEAR_TO 56}Bag\nPokémon{CLEAR_TO 56}Run`); the words are **Battle / Bag / Pokémon / Run**, not FIGHT / BAG / POKéMON / RUN | invented upper-case words | ROM string | exact |
| **Window ring (menus)** | BG tiles 0x12..0x1a are the player's window frame: raw 4bpp at ROM 0x111d218 with colour 0 turned into 15, BG palette bank 1 = ROM 0x111b8d8 (blue-white ring); the old ring was the black battle-menu frame (REAL: palette RAM and VRAM matched against the ROM) | black ring | blue-white | exact |
| Menu cursor | two ROM BG tiles (textbox tiles 1, 2) at x 128/184, y 120/136 (action) and x 8/80, y 120/136 (moves) | font glyph 1 px off | tiles | exact |
| **Move names** | font **narrow** (id 7) at the window's left edge, y + 1; the narrower **font 10** when wider than the 64 px window; never wrapped or scrolled, clipped by the window (REAL: 4 short, 4 long, 4 Z-move names) | normal font, two-line layout and a scrolling marquee of this UI's own | real rule | exact |
| **PP numbers** | two 6 px cells + slash + two 6 px cells, right-aligned to the window edge: `" 5/ 5"`, `"35/35"` (REAL) | variable-width string | cells | exact |
| **PP colours** | `GetCurrentPpToMaxPpState @0x08094dc8` (CODE; ported as `ppState`, 13 hand cases + 64x64 sweep against the ROM): cur = max normal; max <= 2 and max <= 7 special cases; else 0 red, <= max/4 orange, <= max/2 yellow; the four colour pairs are at ROM 0x6cd00c (yellow, orange, red, normal) (REAL: 29 frames) | red at 0, orange at <= 1/4, **no yellow** | ROM states | exact |
| "TYPE/" row | `TYPE/` followed by the type's **name** (narrow font), not a badge icon (REAL) | 32x16 badge | text | exact |
| PP / TYPE label fonts | narrow, window x, y + 1 (REAL) | normal, x + 2 | narrow | exact |
| Glyph drawing | the game blits only a glyph's advance width of its 16 px cell; the cell's right half can hold stray ink (the `S` of the narrow font) | whole cell | clipped to the width table | exact |
| **Text speed** | one character per logic frame whatever Slow/Mid/Fast is (identical frames for 0,1,2); only the Instant option (3) prints at once (REAL). The oracle runs at 2x: 2 characters per displayed frame | 8/4/1 frame waits (recollection) | mid = fast = 0; slow = 3 (arena-only) | exact for the real pace; **slow is arena-only** |
| Text page wait | the real game waits for A at a page break; the arena auto-advances after 50 frames | n/a | 50 | **approx / EYE** |
| Message hold after a message | not resolved: one measured turn held the last message 99 displayed frames (198 logic frames) including the end-of-turn engine work; `waitmessage`'s arguments were not decoded | 36 frames | 36 | **EYE** |
| Healthbox slide-in | foe box x -108 -> 2, 5 px per displayed frame at 2x = 2.5 px/frame at 1x = 44 frames; the Pokemon appears after a ball animation (REAL: OAM x per frame) | 22-frame ease with the sprite | unchanged | **approx / EYE** (AN1 owns the ball / slide queue) |
| Faint | the real sprite flashes red then vanishes and the box leaves (REAL sheet `faint_foe_sheet.png`, opened); the arena sinks the sprite 4 px/frame | sink | unchanged | **approx / EYE** (AN1) |
| Party menu in battle | a different layout from the arena's: row panel list at the left, a species / held-item summary panel at the right (REAL: `CK_PARTY_MENU.png`, opened) | arena composition from other ROM pieces | unchanged | **not matched** |
| "L MOVE INFO" button and the foe's "?" tag in the move menu | real sprites, not drawn by the arena | absent | absent | **not matched** |
| Night tint | the real game tints the whole battle at night by its clock (OR1's pinned 22:13 clock showed it); the arena always shows day | day | day | arena-only |

## Elements with no ROM equivalent ("arena-only")

Team preview, the result screen, the pause menu, the forfeit / leave confirmations, the hub, the start-menu rows, the weather / Trick Room tag plates, the "Choose n (a/b)" counter and the
text of lines the ROM has no string for (listed by `scene.fallbacks()`; `scene.js` header) are built by this site from ROM windows, tiles and fonts; none is claimed to match the game.
Since FA1 they use the real game's window frame (blue-white ring) instead of the old black one, because they share the ring art.

## Numbers: differing pixels against the real game

Before = the arena as it stood when FA1 began (the saved originals rendered at the same scenes), after = now. Frames are 240x160; regions are in screen pixels.

| Region | Before (10 scenarios summed) | After |
|---|---|---|
| Foe healthbox (2,14, 128x34) | 13,862 | 0 |
| Player healthbox (136,72, 104x40) | 15,838 | 0 |
| Foe sprite + shadow region | 1,431 | 0 |
| Player sprite region | 630 | 0 |
| Background (outside boxes, sprites, text box) | 720 | 0 |
| Text box, action-menu scenes (10 x 240x48) | 38,317 | 0 |
| Action menu, cursors 0-3 | 15,193 | 0 |
| Move menu, cursors 0-3 | 27,065 | 0 |
| Message window "Bob used Scratch!" | 555 | 0 |
| 29 PP states + 2 long-name menus | n/a (the old arena drew a badge and a two-line layout) | 0 |
| Shiny boxes (4) / 12 backgrounds | n/a | 0 / 0 |

## Remaining differences (and why)

1. **Party menu**: the game's own party screen (hack-specific layout) was not rebuilt; the arena keeps its composition. Needs a new screen layout and the game's panel art.
2. **Timings not matched**: the post-message hold, the page-break wait, the send-out / recall slide, the faint animation. They need the battle scripts' `waitmessage` arguments decoded
   (or per-situation oracle runs at 1x) and belong with AN1's animation queue. Facts measured and not yet applied are in the table above (healthbox slide 2.5 px/frame).
3. **Move menu extras**: the "L MOVE INFO" button sprite and the foe "?" tag are not drawn.
4. **Night tint** is not applied.
5. **EXP** is not modelled (arena battles have no EXP): the player's bar is empty.
6. The page picks a background with `seed % 9`; the real game picks by the tile under the player (terrains 9-11 are never used).
7. Not verified: doubles layouts, trainer sprites, the Bag screen, weather tag plates, the party-menu gender colours, species whose healthbox name is wider than the font-11 window.
8. All REAL comparisons are against one save, one noon clock, 1x derived from a 2x save, and one scripted trainer battle plus wild battles; a different save option (Instant text, another
   window-frame type, another battle speed) would look different in the real game too. The window frame used is frame type 1 (the save's default).
9. `README.md`'s "What is approximate" still lists the pre-FA1 statements (HP drains one pixel per frame, colour thresholds and text speeds from memory). It is outside this stage's files and was not edited.

## How the ROM facts were found (so they can be re-found)

* `GetScaledHPFraction` and friends: a semantic search that **runs** every function of the first 4 MB in the interpreter with test vectors and keeps the ones whose answers match a rule
  (`GetScaledHPFraction` was the only hit of 12 vectors; `CalcNewBarValue` by watching a drain sequence; `GetCurrentPpToMaxPpState` by partition-matching the PP states read off the real menu).
* The healthbox element table: ROM 0x72028c + 32 * index (the arena's strips are the same tiles starting 12 bytes later, hence its "stacked element" decode).
* Palette / tile sources (window frame, shadow, arrow, shiny palette): match the oracle's palette RAM and VRAM against the ROM, raw or up to a one-to-one nibble remap, or through `smolDecode`.
* Species record fields (`+0x9c`, `+0xa2..0xa4`): correlate the oracle's OAM positions over 13 species with every byte of the 0x118-byte record.

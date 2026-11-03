# pokemonarena music map (stage MU2)

Which ROM song plays where, for both soundtracks, with the evidence. Machine-readable twin of this file: `pokemonarena/js/music_map.js`. Re-checked against the ROMs by `tools/pokemonarena_music_map_test.mjs`.

Nothing here is audio or ROM bytes: only song-table indexes, hashes, file offsets, labels. Nobody listened to anything; every identification below is code, a name the ROM itself carries, or a byte comparison.

## ROM profiles

| | SoulGold (v1.1.1) | Ultra Violet |
|---|---|---|
| file | Pokemon SoulGold (v1.1.1).gba | pokemonUltraViolet.gba |
| size | 33554432 | 16777216 |
| sha256 | `8071e2c348d54c3ec7b78b53837c5cbd757d5cfc461a50fa5ffbc9f5ab35060a` | `467fe116ff6d7d5723b9f8fc60dd81c698c5d4e27b1b444168f3be292848d015` |
| header | "POKEMON EMER" / BPEE | "ULTRA VIOLET" / PUVV |
| base game | Pokemon Emerald hack (pokeemerald-style sound.c; Hoenn + Kanto (RG) + added Johto songs) | FireRed-engine hack (its sFanfares table and song numbering are pokefirered's: 14 fanfares, songs 256-346 = the FRLG block; trainer-class text also carries the Emerald list) |
| song table | file 0x15E8ED8 (GBA 0x95E8ED8), 990 slots | file 0x4A32CC (GBA 0x84A32CC), 347 slots |
| gMPlayTable | file 0x15E8EA8 | file 0x4A329C |
| m4aSongNumStart | 0x81A0994 | 0x81DD0F4 |
| PlayBGM / PlaySE | 0x8244544 / 0x824456C | 0x80722A0 / 0x80722CC |
| GetBattleBGM | 0x81EFBEC | 0x8043FD4 |
| sFanfares | file 0xF3C594, 18 x 8 B | file 0x3AC990, 14 x 4 B |

Slot counting: SoulGold slots 0..989; slot 0 is a dummy, 1..269 are sound effects, 270..349 are dummy slots (the Emerald gap), 350..989 are music/hack songs with further dummy slots between them (698 slots hold a real song; slot 988 points at a non-header, 989 is valid). MU1's `findSongTable` independently found the same table offset (0x15E8ED8 / 0x4A32CC) but stops at 988 slots for SoulGold, so song 989 is outside its count (no key uses it).

## Method (what "evidence" means here)

1. **Code.** A throwaway THUMB decoder (scratch, not committed) found `m4aSongNumStart` as the function whose literal pool holds the song-table address, then `PlayBGM` (checks gDisableMusic, maps 0xFFFF to 0), `PlaySE`, `PlayNewMapMusic`, `PlayFanfare`, the battle-music selector `GetBattleBGM` and the battle-end victory handler by their shapes, and resolved the constants passed at call sites by a forward constant-propagation over the preceding instructions.
2. **Names the ROM carries.** SoulGold has its own song-name table: two pointer arrays (file 0x4CC990, 269 sound-effect names for songs 1..269; file 0x4CCDC4, music names, entry n = song 349+n) pointing at Gen3-charset strings like "SE-SELECT" and "MUS-VS-WILD". Its indexing is proven by the stock column of the sFanfares table: all 18 songs there carry the expected names (test: `names/soulgold/sFanfares-stock-songs-carry-MUS-names`).
3. **Byte twins.** 339 of Ultra Violet's 346 songs have a byte-identical (pointer-normalised) track-command stream in SoulGold, which names Ultra Violet's songs without any numbering assumption: UV 5 = SE-SELECT, UV 298 = MUS-RG-VS-WILD, ... Twin pairs by index offset (SoulGold index - UV index): +7 for 205 pairs (sound effects), +212 for 76 pairs (the FireRed music block), 0 for 24 pairs (UV 1..24), +6 for 23 pairs. The 7 UV songs with no twin are 83, 243, 257, 258, 259, 268, 269.
4. **Structure.** Loop/jingle flags come from the song headers (a track whose command stream reaches GOTO loops; all tracks ending in FINE = jingle). My walker and MU1's `Mp2kRom.song()` agree on track count and voicegroup for all 988 readable SoulGold slots and all 347 Ultra Violet slots (scratch cross-check, this run).
5. **Class tables.** The selectors switch on trainer class. Class numbers were pinned to real trainers by reading each ROM's trainers table (test: `trainers/*`).

## Findings that drive the map

### SoulGold (Emerald engine, hack soundtrack)

The hack **replaced the songs the stock game would play** at several points, so the stock song numbers (MUS-VS-WILD 474, MUS-VS-TRAINER 476 ...) are *not* what plays:

- `GetBattleBGM` @0x081EFBEC (reached through `PlayMapChosenOrBattleBGM` @0x081EFE9C): not a trainer -> **887**; trainer, default -> **888**; classes 31 (Elite Four) / 32 (Leader) -> **889**; class 38 (Champion) -> **895**; class 50 (rival) -> **890**; classes 68/80 (Team Rocket) -> **891**; classes 58..64 (frontier brains) -> **917**; Aqua/Magma classes keep the stock **475** / **483**. Link battles take the trainer default.
- Victory handler @0x0808B810 (calls `PlayBGM` @0x08244544): default **899**; class 32 -> **354**; classes 31, 38 -> **355**; Aqua/Magma classes -> **424**.
- `sFanfares` @0x08F3C594 (18 entries of {stock song, **played song**, duration}); `PlayFanfareByFanfareNum` and `PlayFanfare` play the **second** field, so level-up plays **947**, heal **946**, item **948**, evolved **950**, TM **952**, badge **951**, key item **949**, berry **955**, move-deleted **954**.
- Trainer-encounter themes: u16 table @0x08447620 (ids 0..13 stock songs, then hack songs 895 879 885 878 884 880 886 881 860 883 882 and 691..705).

### Ultra Violet (FireRed engine)

- Song numbering is pokefirered's: 256..271 fanfare/evolution block, 272..346 = the Emerald "RG" block byte-for-byte (UV = SoulGold - 212).
- `GetBattleBGM` @0x08043FD4: link -> 266; wild or legendary flag -> **298**; trainer default -> **297**; classes 84 (gym leaders) and 87 (Elite Four) -> **296**; class 90 (champion stage) -> **299**. Class numbers pinned via the trainers table @0x08241408 (stride 40): class 84 = BROCK..SABRINA, 87 = LORELEI/BRUNO/AGATHA/LANCE, 85 = GRUNT.
- Victory handler @0x08015690: classes 84, 90 -> **312**; everything else -> **310**.
- `sFanfares` @0x083AC990: 14 entries {song, duration}: 257 level-up, 258 item, 259 evolved, 261 TM, 256 heal, 260 badge, 270 move-deleted, 262 berry, 268/269 slots, 271 too-bad, 338 poke flute, 318 key item, 317 dex rating.

## The map

Confidence: high = the ROM's own code plays this index in that situation; medium = identity certain, role from prior knowledge or a design choice with a code anchor; low = **UNVERIFIED-GUESS** (a mood recommendation; the identity of the song is still certain). Flags are header-derived. `loop` = the song loops forever (the director must stop it); `jingle` = it ends by itself.

### Music

| key | what | SoulGold | | UV | |
|---|---|---|---|---|---|
| `battle_easy` | CPU level easy: wild-battle style theme | **887** loop (high) | SoulGold hack wild-battle theme (replaces stock MUS_VS_WILD 474) | **298** loop (high) | FRLG VS-WILD (byte-identical to SoulGold song 510 MUS-RG-VS-WILD) |
| `battle_normal` | CPU level normal: ordinary trainer theme | **888** loop (high) | SoulGold hack trainer-battle theme (replaces stock MUS_VS_TRAINER 476) | **297** loop (high) | FRLG VS-TRAINER (twin of SoulGold 509 MUS-RG-VS-TRAINER) |
| `battle_hard` | CPU level hard: gym leader / elite four theme | **889** loop (high) | SoulGold hack gym-leader + elite-four theme (stock 477/482 are not used by the selector) | **296** loop (high) | FRLG VS-GYM-LEADER (twin of SoulGold 508 MUS-RG-VS-GYM-LEADER) |
| `battle_final` | last / final-boss feel: champion theme | **895** loop (high) | SoulGold hack champion theme | **299** loop (high) | FRLG VS-CHAMPION (twin of SoulGold 511 MUS-RG-VS-CHAMPION) |
| `battle_rival` | rival-style special trainer | **890** loop (high) | SoulGold hack rival theme (class 50, trainers named with the rival-name placeholder FD 06) | null | *FRLG has no separate rival battle theme: UV class 89 (rival) falls to the default trainer theme 297 (@0x08044062)* |
| `battle_villain` | villain-team trainers (Team Rocket / Aqua / Magma) | **891** loop (high) | SoulGold hack Team Rocket theme (classes 68 "Team Rocket", 80 "Rocket Admin") | null | *UV routes Team Rocket (class 85, GRUNT) to the generic trainer theme 297; there is no villain-specific battle song in its selector* |
| `battle_frontier` | frontier-brain style boss | **917** loop (high) | SoulGold hack frontier-brain theme (classes 58-64: Salon Maiden .. Pyramid King) | null | *UV has no battle-frontier classes* |
| `battle_legendary` | legendary Pokemon encounter | **553** loop (high) | MUS-RG-VS-LEGEND (stock Emerald RG block) | **341** loop (medium) | FRLG VS-LEGEND (twin of SoulGold 553) |
| `victory` | trainer-battle victory music (loops in the ROM; it is a BGM, not a fanfare) | **899** loop (high) | SoulGold hack trainer-victory music | **310** loop (high) | FRLG VICTORY-TRAINER (twin of SoulGold 522 MUS-RG-VICTORY-TRAINER) |
| `victory_gym` | gym leader victory music | **354** loop (high) | MUS-VICTORY-GYM-LEADER | **312** loop (high) | FRLG VICTORY-GYM-LEADER (twin of SoulGold 524) |
| `victory_league` | elite four / champion victory music | **355** loop (high) | MUS-VICTORY-LEAGUE | **312** loop (medium) | FRLG VICTORY-GYM-LEADER (UV reuses it for the champion class 90 only) |
| `result_win` | result screen after a win | **436** loop (medium) | MUS-HALL-OF-FAME (loops) | **286** loop (medium) | FRLG HALL-OF-FAME (twin of SoulGold 498 MUS-RG-HALL-OF-FAME) |
| `result_lose` | result screen after a loss | **492** loop (low) | MUS-RG-LAVENDER (loops) | **280** loop (low) | FRLG LAVENDER (twin of SoulGold 492) |
| `hub` | hub / main menu | **400** loop (low) | MUS-POKE-CENTER (loops, calm, 9 tracks) | **303** loop (low) | FRLG POKE-CENTER (twin of SoulGold 515 MUS-RG-POKE-CENTER) |
| `editor` | team editor | **383** loop (low) | MUS-BIRCH-LAB (loops, tempo 100) | **301** loop (low) | FRLG OAK-LAB (twin of SoulGold 513 MUS-RG-OAK-LAB) |
| `preview` | team preview before a battle | **416** loop (medium) | MUS-ENCOUNTER-INTENSE (loops, 8 tracks) | **315** loop (low) | FRLG ENCOUNTER-RIVAL (twin of SoulGold 527 MUS-RG-ENCOUNTER-RIVAL) |
| `title` | title screen theme | **413** jingle (low) | MUS-TITLE (does NOT loop: header ends in FINE) | **278** loop (high) | FRLG TITLE (twin of SoulGold 490 MUS-RG-TITLE) |
| `pokecenter` | pokemon center | **400** loop (low) | MUS-POKE-CENTER | **303** loop (low) | FRLG POKE-CENTER |
| `lab` | laboratory | **383** loop (low) | MUS-BIRCH-LAB | **301** loop (low) | FRLG OAK-LAB |
| `town` | calm town theme | **405** loop (low) | MUS-LITTLEROOT (loops, 9 tracks, tempo 108) | **300** loop (low) | FRLG PALLET (twin of SoulGold 512) |
| `evolution` | evolution scene | **377** loop (high) | MUS-EVOLUTION (loops) | **264** loop (high) | FRLG EVOLUTION (twin of SoulGold 377) |
| `hof` | hall of fame | **436** loop (high) | MUS-HALL-OF-FAME | **286** loop (high) | FRLG HALL-OF-FAME |
| `credits` | credits roll | **455** jingle (high) | MUS-CREDITS (does NOT loop) | **290** jingle (medium) | FRLG CREDITS (twin of SoulGold 502 MUS-RG-CREDITS; 11376 ticks) |

### Jingles / fanfares

| key | what | SoulGold | | UV | |
|---|---|---|---|---|---|
| `victory_sting` | short non-looping victory fanfare (for the "you won" moment before the result music) | **951** jingle (medium) | SoulGold hack obtain-badge fanfare (sFanfares[5] plays field +2 = 951) | **260** jingle (medium) | FRLG OBTAIN-BADGE fanfare |
| `defeat` | defeat sting | **391** jingle (low) | MUS-TOO-BAD (slot-machine "too bad" fanfare) | **271** jingle (low) | FRLG TOO-BAD fanfare |
| `heal` | party healed | **946** jingle (high) | SoulGold hack heal fanfare (sFanfares[4] = {368,946,160}) | **256** jingle (high) | FRLG HEAL fanfare |
| `levelup` | level up | **947** jingle (high) | SoulGold hack level-up fanfare (sFanfares[0] = {367,947,80}) | **257** jingle (high) | FRLG LEVEL-UP fanfare |
| `item` | item obtained | **948** jingle (high) | SoulGold hack obtain-item fanfare (entry 1 = {370,948,160}) | **258** jingle (high) | FRLG OBTAIN-ITEM fanfare |
| `evolved` | evolution finished | **950** jingle (high) | SoulGold hack evolved fanfare (entry 2 = {371,950,240}) | **259** jingle (high) | FRLG EVOLVED fanfare |
| `tm` | TM/HM obtained | **952** jingle (high) | SoulGold hack obtain-TM fanfare (entry 3 = {372,952,220}) | **261** jingle (high) | FRLG OBTAIN-TMHM fanfare |
| `badge` | badge obtained | **951** jingle (high) | SoulGold hack obtain-badge fanfare (entry 5 = {369,951,340}) | **260** jingle (high) | FRLG OBTAIN-BADGE fanfare |
| `key_item` | key item obtained | **949** jingle (high) | SoulGold hack key-item fanfare (entry 13 = {530,949,170}) | **318** jingle (high) | FRLG OBTAIN-KEY-ITEM fanfare |
| `berry` | berry obtained | **955** jingle (high) | SoulGold hack obtain-berry fanfare (entry 7 = {387,955,120}) | **262** jingle (high) | FRLG OBTAIN-BERRY fanfare |
| `move_deleted` | move forgotten / deleted | **954** jingle (high) | SoulGold hack move-deleted fanfare (entry 6 = {378,954,180}) | **270** jingle (high) | FRLG MOVE-DELETED fanfare |

### Sound effects

| key | what | SoulGold | | UV | |
|---|---|---|---|---|---|
| `se_cursor` | menu cursor move | **5** jingle (high) | SE-SELECT | **5** jingle (high) | SE-SELECT (twin of SoulGold 5) |
| `se_select` | menu confirm | **5** jingle (high) | SE-SELECT | **5** jingle (high) | SE-SELECT |
| `se_back` | menu cancel / B | **5** jingle (medium) | SE-SELECT (the engine has no separate cancel sound) | **5** jingle (medium) | SE-SELECT |
| `se_error` | invalid action buzz | **32** jingle (high) | SE-FAILURE | **26** jingle (high) | SE-FAILURE (twin of SoulGold 32) |
| `se_success` | success chime | **31** jingle (medium) | SE-SUCCESS | **25** jingle (medium) | SE-SUCCESS (twin of SoulGold 31) |
| `se_hit_normal` | damaging hit, neutral | **13** jingle (medium) | SE-EFFECTIVE | **13** jingle (medium) | SE-EFFECTIVE (twin of SoulGold 13) |
| `se_hit_super` | super effective hit | **14** jingle (medium) | SE-SUPER-EFFECTIVE | **14** jingle (medium) | SE-SUPER-EFFECTIVE (twin of SoulGold 14) |
| `se_hit_weak` | not very effective hit | **12** jingle (medium) | SE-NOT-EFFECTIVE | **12** jingle (medium) | SE-NOT-EFFECTIVE (twin of SoulGold 12) |
| `se_faint` | Pokemon faints | **16** jingle (medium) | SE-FAINT | **16** jingle (medium) | SE-FAINT (twin of SoulGold 16) |
| `se_ball_throw` | ball thrown | **61** jingle (medium) | SE-BALL-THROW | **54** jingle (medium) | SE-BALL-THROW (twin of SoulGold 61) |
| `se_ball_open` | ball opens / Pokemon sent out | **15** jingle (medium) | SE-BALL-OPEN | **15** jingle (medium) | SE-BALL-OPEN (twin of SoulGold 15) |
| `se_ball_bounce` | ball bounce (catch) | **56** jingle (medium) | SE-BALL-BOUNCE-1 | **49** jingle (medium) | SE-BALL-BOUNCE-1 (twin of SoulGold 56) |
| `se_exp` | exp bar filling | **33** jingle (medium) | SE-EXP | **27** jingle (medium) | SE-EXP (twin of SoulGold 33) |
| `se_exp_max` | exp bar full / level reached | **91** jingle (medium) | SE-EXP-MAX | **84** jingle (medium) | SE-EXP-MAX (twin of SoulGold 91) |
| `se_lowhp` | low HP warning beep | **90** jingle (medium) | SE-LOW-HEALTH | **83** loop (medium) | FRLG LOW-HEALTH (looping, player 3) |
| `se_flee` | run away | **17** jingle (medium) | SE-FLEE | **17** jingle (medium) | SE-FLEE (twin of SoulGold 17) |
| `se_use_item` | use item | **1** jingle (high) | SE-USE-ITEM | **1** jingle (high) | SE-USE-ITEM (twin of SoulGold 1) |
| `se_switch` | switch / toggle | **35** jingle (low) | SE-SWITCH | **29** jingle (low) | SE-SWITCH (twin of SoulGold 35) |
| `se_menu_open` | window / menu opens | **6** jingle (medium) | SE-WIN-OPEN | **6** jingle (medium) | SE-WIN-OPEN (twin of SoulGold 6) |
| `se_save` | game saved | **55** jingle (medium) | SE-SAVE | **48** jingle (medium) | SE-SAVE (twin of SoulGold 55) |
| `se_levelup` | level-up sting played as an effect (alias of the levelup fanfare) | **947** jingle (high) | SoulGold hack level-up fanfare | **257** jingle (high) | FRLG LEVEL-UP fanfare |

### Evidence per key

**`battle_easy`**
- soulgold: 887 (high) - GetBattleBGM @0x081EFBEC (called through PlayMapChosenOrBattleBGM @0x081EFE9C): non-trainer branch returns 0x377=887 (ldr r0,=0x377 @0x081EFD44, reached from the trainer-bit test at 0x081EFC26)
- ultraviolet: 298 (high) - GetBattleBGM @0x08043FD4 (called through PlayMapChosenOrBattleBGM @0x08044090): non-trainer branch returns 0x12A=298 (movs r0,#149; lsls r0,#1 @0x0804406C); song 298 has a byte-identical stream twin = SoulGold 510 "MUS-RG-VS-WILD"

**`battle_normal`**
- soulgold: 888 (high) - GetBattleBGM @0x081EFBEC (called through PlayMapChosenOrBattleBGM @0x081EFE9C): default of the trainer-class jump table @0x087C6E3C (idx=class-3) is 888 (movs r0,#222; lsls r0,#2 @0x081EFD0A); also used for link battles
- ultraviolet: 297 (high) - GetBattleBGM @0x08043FD4 (called through PlayMapChosenOrBattleBGM @0x08044090): default trainer branch returns 0x129=297 (@0x08044062); every class except 84/87/90 lands there; twin = SoulGold 509

**`battle_hard`**
- soulgold: 889 (high) - GetBattleBGM @0x081EFBEC (called through PlayMapChosenOrBattleBGM @0x081EFE9C): trainer classes 31 ("Elite Four") and 32 ("Leader") -> 0x379=889 (@0x081EFD74); class names from the table @0x0843B03C (stride 16); trainers table @0x08497FBC (stride 52, class byte +28, name +31): class 31 = Koga/Will/Bruno/Karen, class 32 = Falkner/Blaine/Jasmine/Pryce/Blue/Lt. Surge/Erika/Sabrina
- ultraviolet: 296 (high) - GetBattleBGM @0x08043FD4 (called through PlayMapChosenOrBattleBGM @0x08044090): classes 84 and 87 -> 0x128=296 (@0x0804405C); gTrainers @0x08241408 (stride 40): class 84 = BROCK/MISTY/LT. SURGE/ERIKA/KOGA/BLAINE/SABRINA/GIOVANNI, class 87 = LORELEI/BRUNO/AGATHA/LANCE; twin = SoulGold 508

**`battle_final`**
- soulgold: 895 (high) - GetBattleBGM @0x081EFBEC (called through PlayMapChosenOrBattleBGM @0x081EFE9C): class 38 ("Champion": trainers Lance, Steven in the trainers table) -> 0x37F=895 (@0x081EFD86). The ROM has no low-HP / last-Pokemon music variant, so "final" = the champion theme (design choice)
- ultraviolet: 299 (high) - GetBattleBGM @0x08043FD4 (called through PlayMapChosenOrBattleBGM @0x08044090): class 90 (TERRY x3, the champion-stage rival) -> 0x12B=299 (@0x08044054); twin = SoulGold 511

**`battle_rival`**
- soulgold: 890 (high) - GetBattleBGM @0x081EFBEC (called through PlayMapChosenOrBattleBGM @0x081EFE9C): class 50 -> 0x37A=890 (@0x081EFD82). Class 50 trainers (ids 226,228,229,252,253,326,351,503 ...) have the name placeholder FD 06 (RIVAL) in the trainers table @0x08497FBC; the class-name text only says "PKMN Trainer"
- ultraviolet: null - FRLG has no separate rival battle theme: UV class 89 (rival) falls to the default trainer theme 297 (@0x08044062)

**`battle_villain`**
- soulgold: 891 (high) - GetBattleBGM @0x081EFBEC (called through PlayMapChosenOrBattleBGM @0x081EFE9C): classes 68 (trainers named Grunt) and 80 (Giovanni, Ariana, Archer, Petrel, Proton) -> 0x37B=891 (@0x081EFD78). Stock Aqua/Magma classes (3,9,11,49) return 475 MUS-VS-AQUA-MAGMA, (13,53) return 483 MUS-VS-AQUA-MAGMA-LEADER
- ultraviolet: null - UV routes Team Rocket (class 85, GRUNT) to the generic trainer theme 297; there is no villain-specific battle song in its selector

**`battle_frontier`**
- soulgold: 917 (high) - GetBattleBGM @0x081EFBEC (called through PlayMapChosenOrBattleBGM @0x081EFE9C): classes 58..64 -> 0x395=917 (@0x081EFD64)
- ultraviolet: null - UV has no battle-frontier classes

**`battle_legendary`**
- soulgold: 553 (high) - GetBattleBGM @0x081EFBEC (called through PlayMapChosenOrBattleBGM @0x081EFE9C): legendary-flag (bit 0x2000) branch picks by species (384->470 VS-RAYQUAZA, 382/383->480 VS-KYOGRE-GROUDON, others 479 VS-REGI or the generic fallback 0x229=553 @0x081EFD60); the 0x400 branch returns 1137-species = 894/893/892 for species 243/244/245
- ultraviolet: 341 (medium) - identity: byte-identical stream twin = SoulGold 553 "MUS-RG-VS-LEGEND". ROLE: UV's GetBattleBGM has no legendary branch (flag 0x1000 returns the wild theme 298 @0x0804406C), so FRLG's own scripts start it; not traced -> role from prior knowledge

**`victory`**
- soulgold: 899 (high) - victory handler @0x0808B810 calls PlayBGM @0x08244544: default branch PlayBGM(0x383=899) @0x0808B900 for every class not in the class jump table @0x0843ABB8 (idx=class-31)
- ultraviolet: 310 (high) - victory handler @0x08015690 calls PlayBGM @0x080722A0: default branch PlayBGM(0x136=310) @0x08015762; twin = SoulGold 522

**`victory_gym`**
- soulgold: 354 (high) - victory handler @0x0808B810 calls PlayBGM @0x08244544: class 32 ("Leader") -> PlayBGM(177<<1=354) @0x0808B932; name from the ROM's own song-name table (@0x004CCDC4, entry 354-349)
- ultraviolet: 312 (high) - victory handler @0x08015690 calls PlayBGM @0x080722A0: classes 84 (Leader) and 90 (Champion) -> PlayBGM(156<<1=312) @0x08015758; twin = SoulGold 524

**`victory_league`**
- soulgold: 355 (high) - victory handler @0x0808B810 calls PlayBGM @0x08244544: classes 31 ("Elite Four") and 38 ("Champion") -> PlayBGM(100+255=355) @0x0808B928; name table entry 355
- ultraviolet: 312 (medium) - victory handler @0x08015690 calls PlayBGM @0x080722A0: only classes 84 and 90 use 312; elite four (87) takes the default 310. Shared with victory_gym

**`victory_sting`**
- soulgold: 951 (medium) - sFanfares @0x08F3C594 entry 5 = {369,951,340}; PlayFanfareByFanfareNum @0x08243E38 plays the halfword at +2 (ldrh r0,[r3,#2] @0x08243E4A). Choosing a badge fanfare as a win sting is a design choice (UNVERIFIED-GUESS for mood)
- ultraviolet: 260 (medium) - sFanfares @0x083AC990 entry 5 = {260,340}; PlayFanfareByFanfareNum @0x08071BC4 plays [+0]. Mood choice (UNVERIFIED-GUESS)

**`defeat`**
- soulgold: 391 (low) - UNVERIFIED-GUESS: the ROM has no battle-loss jingle (the battle-end handlers only start victory music). 391 is the only sad fanfare: sFanfares @0x08F3C594 entry 11 = {391,391,160}
- ultraviolet: 271 (low) - UNVERIFIED-GUESS: no battle-loss jingle in the ROM; sFanfares @0x083AC990 entry 10 = {271,160}

**`result_win`**
- soulgold: 436 (medium) - PlayBGM(436) @0x08174EC0 (Hall of Fame screen). Using it as the result theme is a design choice
- ultraviolet: 286 (medium) - PlayBGM(286) @0x080F1EDE (Hall of Fame screen). Design choice for the result theme

**`result_lose`**
- soulgold: 492 (low) - UNVERIFIED-GUESS (mood): somber FRLG town theme; identity from the ROM name table @0x004CCDC4 (entry 492-349)
- ultraviolet: 280 (low) - UNVERIFIED-GUESS (mood); identity by byte-identical twin = SoulGold 492 "MUS-RG-LAVENDER"

**`hub`**
- soulgold: 400 (low) - UNVERIFIED-GUESS (mood): friendly, calm looping town theme. Identity: ROM name table @0x004CCDC4 (entry 400-349) whose indexing is cross-checked against the sFanfares table
- ultraviolet: 303 (low) - UNVERIFIED-GUESS (mood). Identity: byte-identical twin

**`editor`**
- soulgold: 383 (low) - UNVERIFIED-GUESS (mood): slow lab theme for a long editing session. Identity: ROM name table (entry 383-349)
- ultraviolet: 301 (low) - UNVERIFIED-GUESS (mood). Identity: byte-identical twin

**`preview`**
- soulgold: 416 (medium) - The ROM plays trainer-encounter themes through the u16 table at 0x08447620 (song ids 380 407 379 423 416 417 419 441 385 449 450 451 453 397 then hack ids), read by the code @0x080BF210-0x080BF226 (ldrh r4,[table+48+2*id]; PlayNewMapMusic @0x08243B80). 416 is entry 4; using an encounter theme as the preview theme is a design choice
- ultraviolet: 315 (low) - UNVERIFIED-GUESS (mood); identity by twin; UV encounter-music selector not traced

**`title`**
- soulgold: 413 (low) - identity: ROM name table (entry 413-349). I did NOT find code that starts 413 (the three sites that pass 413 call a UI helper @0x080D32E4, not a song function); a direct m4aSongNumStart(802) exists @0x0825FB44 (802 = 16 tracks, no loop, purpose unknown) -> UNVERIFIED-GUESS that 413 is the title theme of this hack
- ultraviolet: 278 (high) - m4aSongNumStart(278) called directly @0x08078AF8 (movs r0,#139; lsls r0,#1; bl 0x081DD0F4)

**`pokecenter`**
- soulgold: 400 (low) - identity from the ROM name table (entry 400-349); UNVERIFIED-GUESS that this is a good pokemon-center theme here (role from prior knowledge)
- ultraviolet: 303 (low) - identity by byte-identical twin (SoulGold 515); UNVERIFIED-GUESS on role (prior knowledge)

**`lab`**
- soulgold: 383 (low) - identity from the ROM name table (entry 383-349); UNVERIFIED-GUESS on role (prior knowledge)
- ultraviolet: 301 (low) - identity by byte-identical twin (SoulGold 513); UNVERIFIED-GUESS on role (prior knowledge)

**`town`**
- soulgold: 405 (low) - identity from the ROM name table (entry 405-349); UNVERIFIED-GUESS on role (prior knowledge)
- ultraviolet: 300 (low) - identity by byte-identical twin (SoulGold 512); UNVERIFIED-GUESS on role (prior knowledge)

**`evolution`**
- soulgold: 377 (high) - PlayBGM(377) @0x08147BC8 and @0x08147E30 (evolution scene); intro 376 via PlayBGM @0x081308AC; PlayBGM(371) @0x081470CC
- ultraviolet: 264 (high) - PlayBGM(264) @0x0804731A (and @0x080CF6B0/@0x080CF9B0); intro 263 @0x0804730A

**`hof`**
- soulgold: 436 (high) - PlayBGM(436) @0x08174EC0
- ultraviolet: 286 (high) - PlayBGM(286) @0x080F1EDE

**`credits`**
- soulgold: 455 (high) - m4aSongNumStart(455) called directly @0x08112F86 (movs r0,#200; adds r0,#255)
- ultraviolet: 290 (medium) - identity by twin; the code that starts it was not located

**`heal`**
- soulgold: 946 (high) - sFanfares @0x08F3C594 entry 4; PlayFanfareByFanfareNum @0x08243E38 plays field +2; PlayFanfare(songNum) @0x08243EB8 matches +0 or +2 and also plays +2
- ultraviolet: 256 (high) - sFanfares @0x083AC990 entry 4 = {256,160}; PlayFanfare(256) called @0x08083F50

**`levelup`**
- soulgold: 947 (high) - sFanfares @0x08F3C594 entry 0, field +2 is what is played
- ultraviolet: 257 (high) - sFanfares @0x083AC990 entry 0 = {257,80}

**`item`**
- soulgold: 948 (high) - sFanfares @0x08F3C594 entry 1
- ultraviolet: 258 (high) - sFanfares @0x083AC990 entry 1 = {258,160}

**`evolved`**
- soulgold: 950 (high) - sFanfares @0x08F3C594 entry 2
- ultraviolet: 259 (high) - sFanfares @0x083AC990 entry 2 = {259,220}

**`tm`**
- soulgold: 952 (high) - sFanfares @0x08F3C594 entry 3
- ultraviolet: 261 (high) - sFanfares @0x083AC990 entry 3 = {261,220}

**`badge`**
- soulgold: 951 (high) - sFanfares @0x08F3C594 entry 5
- ultraviolet: 260 (high) - sFanfares @0x083AC990 entry 5 = {260,340}

**`key_item`**
- soulgold: 949 (high) - sFanfares @0x08F3C594 entry 13
- ultraviolet: 318 (high) - sFanfares @0x083AC990 entry 12 = {318,170}

**`berry`**
- soulgold: 955 (high) - sFanfares @0x08F3C594 entry 7
- ultraviolet: 262 (high) - sFanfares @0x083AC990 entry 7 = {262,120}

**`move_deleted`**
- soulgold: 954 (high) - sFanfares @0x08F3C594 entry 6
- ultraviolet: 270 (high) - sFanfares @0x083AC990 entry 6 = {270,180}

**`se_cursor`**
- soulgold: 5 (high) - PlaySE @0x0824456C is called with 5 from 822 resolvable sites (the most-used SE in the ROM); name from the ROM song-name table @0x004CC990 (entry 5-1)
- ultraviolet: 5 (high) - PlaySE @0x080722CC called with 5 from 362 resolvable sites (most-used); byte-identical stream twin = SoulGold 5

**`se_select`**
- soulgold: 5 (high) - same as se_cursor: Emerald/FRLG menus use SE_SELECT for both move and confirm (822 PlaySE sites)
- ultraviolet: 5 (high) - same as se_cursor (362 PlaySE sites)

**`se_back`**
- soulgold: 5 (medium) - cancel uses PlaySE(SE_SELECT) in the stock menu code (prior); no distinct cancel SE exists in the table. SE-PC-OFF (3) was not chosen because its role is unverified
- ultraviolet: 5 (medium) - same reasoning (prior); 362 PlaySE(5) sites

**`se_error`**
- soulgold: 32 (high) - PlaySE(32) from 82 resolvable sites (second most used); name table entry 32-1
- ultraviolet: 26 (high) - PlaySE(26) from 19 resolvable sites; twin = SoulGold 32

**`se_success`**
- soulgold: 31 (medium) - PlaySE(31) from 7 sites; name table entry 31-1
- ultraviolet: 25 (medium) - PlaySE(25) from 2 sites

**`se_hit_normal`**
- soulgold: 13 (medium) - identity: ROM name table entry 13-1. Role (battle script command effectivenesssound) is prior knowledge: I did not locate that handler (PlaySE(13) appears at 4 other sites, @0x081D28CA,@0x081D28E0,@0x081D5098,@0x081D515E)
- ultraviolet: 13 (medium) - identity by twin; role prior

**`se_hit_super`**
- soulgold: 14 (medium) - identity: name table entry 14-1; role prior (handler not located)
- ultraviolet: 14 (medium) - identity by twin; role prior

**`se_hit_weak`**
- soulgold: 12 (medium) - identity: name table entry 12-1; role prior (handler not located)
- ultraviolet: 12 (medium) - identity by twin; role prior

**`se_faint`**
- soulgold: 16 (medium) - PlaySE(16) from 4 sites (@0x08165F88,@0x081BF0CA,@0x081D3A28,@0x081D48A6); name table entry 16-1
- ultraviolet: 16 (medium) - identity by twin; role prior

**`se_ball_throw`**
- soulgold: 61 (medium) - PlaySE(61) from 3 sites (@0x080F5ACE,@0x081D8820,@0x081D888E); name table entry 61-1
- ultraviolet: 54 (medium) - PlaySE(54) from 2 sites; twin

**`se_ball_open`**
- soulgold: 15 (medium) - PlaySE(15) @0x08053D66; name table entry 15-1
- ultraviolet: 15 (medium) - PlaySE(15) from 1 site; twin

**`se_ball_bounce`**
- soulgold: 56 (medium) - PlaySE(56) from 6 sites (57..59 are the next bounces); name table entry 56-1
- ultraviolet: 49 (medium) - PlaySE(49) from 6 sites; twin

**`se_exp`**
- soulgold: 33 (medium) - PlaySE(33) @0x0805F6D2,@0x08147CB4; name table entry 33-1. Note header is a 156-tick single track (long)
- ultraviolet: 27 (medium) - PlaySE(27) from 5 sites; twin

**`se_exp_max`**
- soulgold: 91 (medium) - PlaySE(91) @0x08122724,@0x08190728; name table entry 91-1
- ultraviolet: 84 (medium) - PlaySE(84) from 1 site; twin

**`se_lowhp`**
- soulgold: 90 (medium) - PlaySE(90) @0x080801B6 (single site); name table entry 90-1
- ultraviolet: 83 (medium) - NO byte-identical twin in SoulGold; chosen by position: SoulGold song 90 = UV song 83 under the constant +7 offset that holds for 205 twin pairs, and song 83 is a 1-track LOOPING song on music player 3 (ms/me = 3/3), which is how FRLG runs its low-HP beep. It LOOPS: the director must stop it

**`se_flee`**
- soulgold: 17 (medium) - name table entry 17-1
- ultraviolet: 17 (medium) - PlaySE(17) from 1 site; twin

**`se_use_item`**
- soulgold: 1 (high) - PlaySE(1) from 51 sites; name table entry 1-1
- ultraviolet: 1 (high) - PlaySE(1) from 8 sites; twin

**`se_switch`**
- soulgold: 35 (low) - identity from the ROM name table (entry 35-1); UNVERIFIED-GUESS on role (prior knowledge)
- ultraviolet: 29 (low) - identity by byte-identical twin (SoulGold 35); UNVERIFIED-GUESS on role (prior knowledge)

**`se_menu_open`**
- soulgold: 6 (medium) - PlaySE(6) from 8 sites; name table entry 6-1
- ultraviolet: 6 (medium) - PlaySE(6) from 10 sites; twin

**`se_save`**
- soulgold: 55 (medium) - name table entry 55-1
- ultraviolet: 48 (medium) - PlaySE(48) from 3 sites; twin

**`se_levelup`**
- soulgold: 947 (high) - sFanfares @0x08F3C594 entry 0 field +2
- ultraviolet: 257 (high) - sFanfares @0x083AC990 entry 0

## Recommended menu-mood tracks (extras)

The ROMs contain no hub/editor/preview screen, so these are recommendations with certain identities and **low** confidence for the role:

| mood | SoulGold | Ultra Violet |
|---|---|---|
| hub (calm, friendly) | 400 MUS-POKE-CENTER | 303 RG-POKE-CENTER |
| editor (long sessions) | 383 MUS-BIRCH-LAB (tempo 100) | 301 RG-OAK-LAB |
| quiet town alternative | 405 MUS-LITTLEROOT | 300 RG-PALLET |
| somber (loss result) | 492 MUS-RG-LAVENDER | 280 RG-LAVENDER |
| tense pre-battle | 416 MUS-ENCOUNTER-INTENSE | 315 RG-ENCOUNTER-RIVAL |

## What I could not establish

- **A battle-loss jingle.** The battle-end code only starts victory music. `defeat` = the slot-machine "too bad" fanfare (SoulGold 391 / UV 271) is a guess.
- **SoulGold title music.** MUS-TITLE (413) exists but nothing I traced starts it; the three sites that pass 413 call a UI helper. The hack's intro uses a direct `m4aSongNumStart(802)` @0x0825FB44 (purpose not traced). 413 does not loop.
- **Names for SoulGold's hack-added songs** (every valid slot above 558, plus the unnamed ones in 350..558: none are unnamed there). Only their *roles* in the selector, the victory handler, the fanfare table and the encounter table are known; what tune they are is unknown and nobody listened. Songs flagged `unmapped` below have no role found.
- **The battle script command that plays the hit sounds** (SE-EFFECTIVE / SUPER / NOT-EFFECTIVE, SE-FAINT, SE-BALL-*). Identities are certain (name table / byte twin); their *use* at those moments is prior knowledge (confidence medium). The animation stage's move scripts carry the per-move sounds themselves.
- **Ultra Violet's trainer-encounter selector** (the preview pick there is a guess) and **where FRLG starts its legendary battles** (its GetBattleBGM has no legendary branch).
- **UV song 83 is not a byte twin** of SoulGold 90 (SE-LOW-HEALTH). It is identified by position (+7 offset) and by being a 1-track looping song on music player 3.
- Real lengths/tempos: the tick and tempo columns below come from my main-stream-only walker (patterns not followed, no tempo changes) and are for orientation; MU1's `listSongs` supersedes them (MU1's MUSIC.md did not exist when this was written).

## All songs

Columns: tracks, loop/jingle (header), approx. main-stream ticks, first tempo, keys that use it, notes. Rows with no key and no note are **unmapped**.

### SoulGold (698 songs)

| idx | ROM name / twin | tr | kind | ticks | tempo | keys | notes |
|---|---|---|---|---|---|---|---|
| 1 | SE-USE-ITEM | 1 | jingle | 24 | 132 | se_use_item |  |
| 2 | SE-PC-LOGIN | 1 | jingle | 24 | 144 |  | unmapped |
| 3 | SE-PC-OFF | 1 | jingle | 18 | 120 |  | unmapped |
| 4 | SE-PC-ON | 1 | jingle | 57 | 144 |  | unmapped |
| 5 | SE-SELECT | 1 | jingle | 18 | 300 | se_cursor, se_select, se_back |  |
| 6 | SE-WIN-OPEN | 1 | jingle | 24 | 220 | se_menu_open |  |
| 7 | SE-WALL-HIT | 1 | jingle | 24 | 220 |  | unmapped |
| 8 | SE-DOOR | 1 | jingle | 24 | 110 |  | unmapped |
| 9 | SE-EXIT | 1 | jingle | 30 | 120 |  | unmapped |
| 10 | SE-LEDGE | 1 | jingle | 9 | 120 |  | unmapped |
| 11 | SE-BIKE-BELL | 1 | jingle | 96 | 120 |  | unmapped |
| 12 | SE-NOT-EFFECTIVE | 2 | jingle | 9 | 90 | se_hit_weak |  |
| 13 | SE-EFFECTIVE | 2 | jingle | 42 | 90 | se_hit_normal |  |
| 14 | SE-SUPER-EFFECTIVE | 2 | jingle | 51 | 90 | se_hit_super |  |
| 15 | SE-BALL-OPEN | 3 | jingle | 15 | 90 | se_ball_open |  |
| 16 | SE-FAINT | 3 | jingle | 30 | 90 | se_faint |  |
| 17 | SE-FLEE | 1 | jingle | 39 | 150 | se_flee |  |
| 18 | SE-SLIDING-DOOR | 1 | jingle | 12 | 120 |  | unmapped |
| 19 | SE-SHIP | 1 | jingle | 168 | 220 |  | unmapped |
| 20 | SE-BANG | 1 | jingle | 72 | 240 |  | unmapped |
| 21 | SE-PIN | 1 | jingle | 15 | 100 |  | unmapped |
| 22 | SE-BOO | 1 | jingle | 12 | 100 |  | unmapped |
| 23 | SE-BALL | 1 | jingle | 6 | 128 |  | unmapped |
| 24 | SE-CONTEST-PLACE | 4 | jingle | 36 | 144 |  | unmapped |
| 25 | SE-A | 1 | jingle | 96 | 240 |  | unmapped |
| 26 | SE-I | 1 | jingle | 96 | 240 |  | unmapped |
| 27 | SE-U | 1 | jingle | 96 | 240 |  | unmapped |
| 28 | SE-E | 1 | jingle | 96 | 240 |  | unmapped |
| 29 | SE-O | 1 | jingle | 96 | 240 |  | unmapped |
| 30 | SE-N | 1 | jingle | 96 | 240 |  | unmapped |
| 31 | SE-SUCCESS | 1 | jingle | 24 | 240 | se_success |  |
| 32 | SE-FAILURE | 1 | jingle | 33 | 240 | se_error |  |
| 33 | SE-EXP | 1 | jingle | 156 | 240 | se_exp |  |
| 34 | SE-BIKE-HOP | 1 | jingle | 6 | 180 |  | unmapped |
| 35 | SE-SWITCH | 1 | jingle | 9 | 150 | se_switch |  |
| 36 | SE-CLICK | 1 | jingle | 9 | 150 |  | unmapped |
| 37 | SE-FU-ZAKU | 1 | jingle | 24 | 150 |  | unmapped |
| 38 | SE-CONTEST-CONDITION-LOSE | 1 | jingle | 9 | 150 |  | unmapped |
| 39 | SE-LAVARIDGE-FALL-WARP | 1 | jingle | 54 | 120 |  | unmapped |
| 40 | SE-ICE-STAIRS | 2 | jingle | 18 | 150 |  | unmapped |
| 41 | SE-ICE-BREAK | 2 | jingle | 15 | 120 |  | unmapped |
| 42 | SE-ICE-CRACK | 2 | jingle | 9 | 150 |  | unmapped |
| 43 | SE-FALL | 1 | jingle | 48 | 170 |  | unmapped |
| 44 | SE-UNLOCK | 2 | jingle | 24 | 150 |  | unmapped |
| 45 | SE-WARP-IN | 1 | jingle | 33 | 110 |  | unmapped |
| 46 | SE-WARP-OUT | 1 | jingle | 36 | 110 |  | unmapped |
| 47 | SE-REPEL | 1 | jingle | 36 | 220 |  | unmapped |
| 48 | SE-ROTATING-GATE | 1 | jingle | 30 | 220 |  | unmapped |
| 49 | SE-TRUCK-MOVE | 2 | loop | 384 | 150 |  | unmapped |
| 50 | SE-TRUCK-STOP | 3 | jingle | 144 | 150 |  | unmapped |
| 51 | SE-TRUCK-UNLOAD | 1 | jingle | 27 | 150 |  | unmapped |
| 52 | SE-TRUCK-DOOR | 2 | jingle | 12 | 150 |  | unmapped |
| 53 | SE-BERRY-BLENDER | 1 | loop | 240 | 150 |  | unmapped |
| 54 | SE-CARD | 1 | jingle | 36 | 180 |  | unmapped |
| 55 | SE-SAVE | 2 | jingle | 42 | 150 | se_save |  |
| 56 | SE-BALL-BOUNCE-1 | 2 | jingle | 12 | 150 | se_ball_bounce |  |
| 57 | SE-BALL-BOUNCE-2 | 2 | jingle | 12 | 150 |  | unmapped |
| 58 | SE-BALL-BOUNCE-3 | 2 | jingle | 12 | 150 |  | unmapped |
| 59 | SE-BALL-BOUNCE-4 | 2 | jingle | 12 | 150 |  | unmapped |
| 60 | SE-BALL-TRADE | 2 | jingle | 12 |  |  | unmapped |
| 61 | SE-BALL-THROW | 1 | jingle | 24 | 150 | se_ball_throw |  |
| 62 | SE-NOTE-C | 2 | jingle | 18 | 150 |  | unmapped |
| 63 | SE-NOTE-D | 2 | jingle | 18 | 150 |  | unmapped |
| 64 | SE-NOTE-E | 2 | jingle | 18 | 150 |  | unmapped |
| 65 | SE-NOTE-F | 2 | jingle | 18 | 150 |  | unmapped |
| 66 | SE-NOTE-G | 2 | jingle | 18 | 150 |  | unmapped |
| 67 | SE-NOTE-A | 2 | jingle | 18 | 150 |  | unmapped |
| 68 | SE-NOTE-B | 2 | jingle | 18 | 150 |  | unmapped |
| 69 | SE-NOTE-C-HIGH | 2 | jingle | 18 | 150 |  | unmapped |
| 70 | SE-PUDDLE | 1 | jingle | 12 | 150 |  | unmapped |
| 71 | SE-BRIDGE-WALK | 1 | jingle | 9 | 150 |  | unmapped |
| 72 | SE-ITEMFINDER | 2 | jingle | 30 | 128 |  | unmapped |
| 73 | SE-DING-DONG | 2 | jingle | 63 | 150 |  | unmapped |
| 74 | SE-BALLOON-RED | 1 | jingle | 24 | 240 |  | unmapped |
| 75 | SE-BALLOON-BLUE | 1 | jingle | 18 | 240 |  | unmapped |
| 76 | SE-BALLOON-YELLOW | 1 | jingle | 18 | 240 |  | unmapped |
| 77 | SE-BREAKABLE-DOOR | 1 | jingle | 30 | 240 |  | unmapped |
| 78 | SE-MUD-BALL | 1 | jingle | 9 | 150 |  | unmapped |
| 79 | SE-FIELD-POISON | 1 | jingle | 24 | 150 |  | unmapped |
| 80 | SE-ESCALATOR | 1 | jingle | 120 | 150 |  | unmapped |
| 81 | SE-THUNDERSTORM | 1 | loop | 84 | 220 |  | unmapped |
| 82 | SE-THUNDERSTORM-STOP | 1 | jingle | 48 | 220 |  | unmapped |
| 83 | SE-DOWNPOUR | 1 | loop | 60 | 220 |  | unmapped |
| 84 | SE-DOWNPOUR-STOP | 1 | jingle | 48 | 220 |  | unmapped |
| 85 | SE-RAIN | 1 | loop | 84 | 220 |  | unmapped |
| 86 | SE-RAIN-STOP | 1 | jingle | 48 | 220 |  | unmapped |
| 87 | SE-THUNDER | 1 | jingle | 144 | 220 |  | unmapped |
| 88 | SE-THUNDER2 | 1 | jingle | 120 | 220 |  | unmapped |
| 89 | SE-ELEVATOR | 2 | jingle | 216 | 150 |  | unmapped |
| 90 | SE-LOW-HEALTH | 1 | jingle | 144 | 150 | se_lowhp |  |
| 91 | SE-EXP-MAX | 2 | jingle | 18 | 150 | se_exp_max |  |
| 92 | SE-ROULETTE-BALL | 1 | jingle | 480 | 150 |  | unmapped |
| 93 | SE-ROULETTE-BALL2 | 1 | jingle | 72 | 150 |  | unmapped |
| 94 | SE-TAILLOW-WING-FLAP | 2 | loop | 48 | 220 |  | unmapped |
| 95 | SE-SHOP | 2 | jingle | 24 | 128 |  | unmapped |
| 96 | SE-CONTEST-HEART | 1 | jingle | 12 | 150 |  | unmapped |
| 97 | SE-CONTEST-CURTAIN-RISE | 2 | jingle | 12 | 150 |  | unmapped |
| 98 | SE-CONTEST-CURTAIN-FALL | 2 | jingle | 12 | 150 |  | unmapped |
| 99 | SE-CONTEST-ICON-CHANGE | 1 | jingle | 6 | 150 |  | unmapped |
| 100 | SE-CONTEST-ICON-CLEAR | 1 | jingle | 6 | 150 |  | unmapped |
| 101 | SE-CONTEST-MONS-TURN | 1 | jingle | 24 | 150 |  | unmapped |
| 102 | SE-SHINY | 1 | jingle | 48 | 220 |  | unmapped |
| 103 | SE-INTRO-BLAST | 1 | jingle | 132 | 110 |  | unmapped |
| 104 | SE-MUGSHOT | 2 | jingle | 108 | 110 |  | unmapped |
| 105 | SE-APPLAUSE | 1 | jingle | 72 | 150 |  | unmapped |
| 106 | SE-VEND | 1 | jingle | 12 | 150 |  | unmapped |
| 107 | SE-ORB | 2 | jingle | 162 | 110 |  | unmapped |
| 108 | SE-DEX-SCROLL | 1 | jingle | 3 | 100 |  | unmapped |
| 109 | SE-DEX-PAGE | 1 | jingle | 9 | 100 |  | unmapped |
| 110 | SE-POKENAV-ON | 2 | jingle | 18 | 144 |  | unmapped |
| 111 | SE-POKENAV-OFF | 2 | jingle | 18 | 144 |  | unmapped |
| 112 | SE-DEX-SEARCH | 2 | jingle | 72 | 144 |  | unmapped |
| 113 | SE-EGG-HATCH | 2 | jingle | 24 | 150 |  | unmapped |
| 114 | SE-BALL-TRAY-ENTER | 2 | jingle | 12 | 150 |  | unmapped |
| 115 | SE-BALL-TRAY-BALL | 1 | jingle | 6 | 150 |  | unmapped |
| 116 | SE-BALL-TRAY-EXIT | 1 | jingle | 3 | 150 |  | unmapped |
| 117 | SE-GLASS-FLUTE | 1 | jingle | 18 | 120 |  | unmapped |
| 118 | SE-M-THUNDERBOLT | 2 | jingle | 48 | 220 |  | unmapped |
| 119 | SE-M-THUNDERBOLT2 | 2 | jingle | 48 | 220 |  | unmapped |
| 120 | SE-M-HARDEN | 2 | jingle | 24 | 150 |  | unmapped |
| 121 | SE-M-NIGHTMARE | 2 | jingle | 96 | 220 |  | unmapped |
| 122 | SE-M-VITAL-THROW | 2 | jingle | 24 | 220 |  | unmapped |
| 123 | SE-M-VITAL-THROW2 | 2 | jingle | 24 | 220 |  | unmapped |
| 124 | SE-M-BUBBLE | 1 | jingle | 24 | 220 |  | unmapped |
| 125 | SE-M-BUBBLE2 | 2 | jingle | 24 | 220 |  | unmapped |
| 126 | SE-M-BUBBLE3 | 1 | jingle | 24 | 220 |  | unmapped |
| 127 | SE-M-RAIN-DANCE | 1 | jingle | 168 | 220 |  | unmapped |
| 128 | SE-M-CUT | 2 | jingle | 48 | 220 |  | unmapped |
| 129 | SE-M-STRING-SHOT | 1 | jingle | 48 | 250 |  | unmapped |
| 130 | SE-M-STRING-SHOT2 | 2 | jingle | 96 | 250 |  | unmapped |
| 131 | SE-M-ROCK-THROW | 1 | jingle | 48 | 150 |  | unmapped |
| 132 | SE-M-GUST | 1 | loop | 72 | 150 |  | unmapped |
| 133 | SE-M-GUST2 | 1 | jingle | 48 | 150 |  | unmapped |
| 134 | SE-M-DOUBLE-SLAP | 1 | jingle | 24 | 150 |  | unmapped |
| 135 | SE-M-DOUBLE-TEAM | 1 | jingle | 24 | 150 |  | unmapped |
| 136 | SE-M-RAZOR-WIND | 2 | jingle | 48 | 220 |  | unmapped |
| 137 | SE-M-ICY-WIND | 2 | jingle | 12 | 150 |  | unmapped |
| 138 | SE-M-THUNDER-WAVE | 2 | jingle | 48 | 150 |  | unmapped |
| 139 | SE-M-COMET-PUNCH | 2 | jingle | 24 | 150 |  | unmapped |
| 140 | SE-M-MEGA-KICK | 1 | jingle | 72 | 150 |  | unmapped |
| 141 | SE-M-MEGA-KICK2 | 2 | jingle | 48 | 220 |  | unmapped |
| 142 | SE-M-CRABHAMMER | 1 | jingle | 24 | 150 |  | unmapped |
| 143 | SE-M-JUMP-KICK | 1 | jingle | 24 | 180 |  | unmapped |
| 144 | SE-M-FLAME-WHEEL | 2 | jingle | 33 | 150 |  | unmapped |
| 145 | SE-M-FLAME-WHEEL2 | 2 | jingle | 48 | 150 |  | unmapped |
| 146 | SE-M-FLAMETHROWER | 2 | jingle | 192 | 150 |  | unmapped |
| 147 | SE-M-FIRE-PUNCH | 2 | jingle | 72 | 220 |  | unmapped |
| 148 | SE-M-TOXIC | 1 | jingle | 24 | 150 |  | unmapped |
| 149 | SE-M-SACRED-FIRE | 2 | jingle | 24 | 150 |  | unmapped |
| 150 | SE-M-SACRED-FIRE2 | 2 | jingle | 96 | 150 |  | unmapped |
| 151 | SE-M-EMBER | 1 | jingle | 24 | 150 |  | unmapped |
| 152 | SE-M-TAKE-DOWN | 1 | jingle | 48 | 150 |  | unmapped |
| 153 | SE-M-BLIZZARD | 1 | loop | 72 | 150 |  | unmapped |
| 154 | SE-M-BLIZZARD2 | 1 | jingle | 48 | 150 |  | unmapped |
| 155 | SE-M-SCRATCH | 1 | jingle | 24 | 220 |  | unmapped |
| 156 | SE-M-VICEGRIP | 2 | jingle | 24 | 220 |  | unmapped |
| 157 | SE-M-WING-ATTACK | 2 | jingle | 24 | 220 |  | unmapped |
| 158 | SE-M-FLY | 2 | jingle | 48 | 220 |  | unmapped |
| 159 | SE-M-SAND-ATTACK | 2 | jingle | 24 | 150 |  | unmapped |
| 160 | SE-M-RAZOR-WIND2 | 1 | jingle | 24 | 250 |  | unmapped |
| 161 | SE-M-BITE | 2 | jingle | 24 | 220 |  | unmapped |
| 162 | SE-M-HEADBUTT | 1 | jingle | 24 | 150 |  | unmapped |
| 163 | SE-M-SURF | 1 | jingle | 96 | 150 |  | unmapped |
| 164 | SE-M-HYDRO-PUMP | 2 | jingle | 120 | 150 |  | unmapped |
| 165 | SE-M-WHIRLPOOL | 1 | jingle | 120 | 150 |  | unmapped |
| 166 | SE-M-HORN-ATTACK | 1 | jingle | 24 | 150 |  | unmapped |
| 167 | SE-M-TAIL-WHIP | 1 | jingle | 24 | 150 |  | unmapped |
| 168 | SE-M-MIST | 1 | jingle | 24 | 150 |  | unmapped |
| 169 | SE-M-POISON-POWDER | 1 | jingle | 24 | 150 |  | unmapped |
| 170 | SE-M-BIND | 1 | jingle | 24 | 150 |  | unmapped |
| 171 | SE-M-DRAGON-RAGE | 1 | jingle | 96 | 150 |  | unmapped |
| 172 | SE-M-SING | 2 | jingle | 162 | 100 |  | unmapped |
| 173 | SE-M-PERISH-SONG | 2 | jingle | 120 | 100 |  | unmapped |
| 174 | SE-M-PAY-DAY | 1 | jingle | 36 | 150 |  | unmapped |
| 175 | SE-M-DIG | 1 | jingle | 15 | 150 |  | unmapped |
| 176 | SE-M-DIZZY-PUNCH | 1 | jingle | 24 | 150 |  | unmapped |
| 177 | SE-M-SELF-DESTRUCT | 1 | jingle | 48 | 150 |  | unmapped |
| 178 | SE-M-EXPLOSION | 2 | jingle | 72 | 150 |  | unmapped |
| 179 | SE-M-ABSORB-2 | 2 | jingle | 51 | 150 |  | unmapped |
| 180 | SE-M-ABSORB | 1 | jingle | 12 | 150 |  | unmapped |
| 181 | SE-M-SCREECH | 2 | jingle | 24 | 150 |  | unmapped |
| 182 | SE-M-BUBBLE-BEAM | 1 | jingle | 66 | 150 |  | unmapped |
| 183 | SE-M-BUBBLE-BEAM2 | 1 | jingle | 36 | 150 |  | unmapped |
| 184 | SE-M-SUPERSONIC | 1 | jingle | 42 | 150 |  | unmapped |
| 185 | SE-M-BELLY-DRUM | 1 | jingle | 24 | 150 |  | unmapped |
| 186 | SE-M-METRONOME | 1 | jingle | 24 | 150 |  | unmapped |
| 187 | SE-M-BONEMERANG | 1 | jingle | 12 | 150 |  | unmapped |
| 188 | SE-M-LICK | 1 | jingle | 36 | 150 |  | unmapped |
| 189 | SE-M-PSYBEAM | 2 | jingle | 42 | 190 |  | unmapped |
| 190 | SE-M-FAINT-ATTACK | 1 | jingle | 30 | 150 |  | unmapped |
| 191 | SE-M-SWORDS-DANCE | 2 | jingle | 60 | 150 |  | unmapped |
| 192 | SE-M-LEER | 2 | jingle | 60 | 150 |  | unmapped |
| 193 | SE-M-SWAGGER | 1 | jingle | 18 | 190 |  | unmapped |
| 194 | SE-M-SWAGGER2 | 1 | jingle | 12 | 150 |  | unmapped |
| 195 | SE-M-HEAL-BELL | 1 | jingle | 24 | 150 |  | unmapped |
| 196 | SE-M-CONFUSE-RAY | 1 | jingle | 48 | 220 |  | unmapped |
| 197 | SE-M-SNORE | 2 | jingle | 30 | 220 |  | unmapped |
| 198 | SE-M-BRICK-BREAK | 2 | jingle | 36 | 150 |  | unmapped |
| 199 | SE-M-GIGA-DRAIN | 1 | jingle | 24 | 150 |  | unmapped |
| 200 | SE-M-PSYBEAM2 | 1 | jingle | 60 | 190 |  | unmapped |
| 201 | SE-M-SOLAR-BEAM | 1 | jingle | 192 | 150 |  | unmapped |
| 202 | SE-M-PETAL-DANCE | 2 | jingle | 135 | 150 |  | unmapped |
| 203 | SE-M-TELEPORT | 1 | jingle | 54 | 150 |  | unmapped |
| 204 | SE-M-MINIMIZE | 1 | jingle | 54 | 150 |  | unmapped |
| 205 | SE-M-SKETCH | 1 | jingle | 12 | 180 |  | unmapped |
| 206 | SE-M-SWIFT | 2 | jingle | 18 | 180 |  | unmapped |
| 207 | SE-M-REFLECT | 2 | jingle | 54 | 150 |  | unmapped |
| 208 | SE-M-BARRIER | 2 | jingle | 54 | 150 |  | unmapped |
| 209 | SE-M-DETECT | 1 | jingle | 42 | 220 |  | unmapped |
| 210 | SE-M-LOCK-ON | 1 | jingle | 18 | 150 |  | unmapped |
| 211 | SE-M-MOONLIGHT | 2 | jingle | 216 | 150 |  | unmapped |
| 212 | SE-M-CHARM | 1 | jingle | 18 | 150 |  | unmapped |
| 213 | SE-M-CHARGE | 1 | jingle | 72 | 150 |  | unmapped |
| 214 | SE-M-STRENGTH | 2 | jingle | 24 | 150 |  | unmapped |
| 215 | SE-M-HYPER-BEAM | 2 | jingle | 24 | 150 |  | unmapped |
| 216 | SE-M-WATERFALL | 2 | jingle | 60 | 150 |  | unmapped |
| 217 | SE-M-REVERSAL | 2 | jingle | 66 | 150 |  | unmapped |
| 218 | SE-M-ACID-ARMOR | 1 | jingle | 72 | 150 |  | unmapped |
| 219 | SE-M-SANDSTORM | 2 | jingle | 192 | 200 |  | unmapped |
| 220 | SE-M-TRI-ATTACK | 2 | jingle | 24 | 220 |  | unmapped |
| 221 | SE-M-TRI-ATTACK2 | 2 | jingle | 96 | 220 |  | unmapped |
| 222 | SE-M-ENCORE | 1 | jingle | 12 | 150 |  | unmapped |
| 223 | SE-M-ENCORE2 | 1 | jingle | 72 | 150 |  | unmapped |
| 224 | SE-M-BATON-PASS | 2 | jingle | 45 |  |  | unmapped |
| 225 | SE-M-MILK-DRINK | 2 | jingle | 30 | 180 |  | unmapped |
| 226 | SE-M-ATTRACT | 2 | jingle | 69 | 210 |  | unmapped |
| 227 | SE-M-ATTRACT2 | 2 | jingle | 216 | 150 |  | unmapped |
| 228 | SE-M-MORNING-SUN | 2 | jingle | 75 | 150 |  | unmapped |
| 229 | SE-M-FLATTER | 1 | jingle | 12 | 150 |  | unmapped |
| 230 | SE-M-SAND-TOMB | 2 | jingle | 96 | 150 |  | unmapped |
| 231 | SE-M-GRASSWHISTLE | 2 | jingle | 132 | 100 |  | unmapped |
| 232 | SE-M-SPIT-UP | 2 | jingle | 15 | 150 |  | unmapped |
| 233 | SE-M-DIVE | 2 | jingle | 48 | 150 |  | unmapped |
| 234 | SE-M-EARTHQUAKE | 2 | jingle | 162 | 150 |  | unmapped |
| 235 | SE-M-TWISTER | 2 | jingle | 168 | 150 |  | unmapped |
| 236 | SE-M-SWEET-SCENT | 2 | jingle | 168 | 150 |  | unmapped |
| 237 | SE-M-YAWN | 2 | jingle | 48 | 150 |  | unmapped |
| 238 | SE-M-SKY-UPPERCUT | 2 | jingle | 36 | 220 |  | unmapped |
| 239 | SE-M-STAT-INCREASE | 2 | jingle | 78 | 170 |  | unmapped |
| 240 | SE-M-HEAT-WAVE | 2 | jingle | 132 | 150 |  | unmapped |
| 241 | SE-M-UPROAR | 1 | jingle | 24 | 150 |  | unmapped |
| 242 | SE-M-HAIL | 2 | jingle | 30 | 150 |  | unmapped |
| 243 | SE-M-COSMIC-POWER | 2 | jingle | 198 | 150 |  | unmapped |
| 244 | SE-M-TEETER-DANCE | 2 | jingle | 60 | 170 |  | unmapped |
| 245 | SE-M-STAT-DECREASE | 2 | jingle | 78 | 170 |  | unmapped |
| 246 | SE-M-HAZE | 2 | jingle | 210 | 190 |  | unmapped |
| 247 | SE-M-HYPER-BEAM2 | 2 | jingle | 24 | 150 |  | unmapped |
| 248 | SE-RG-DOOR | 2 | jingle | 24 | 110 |  | unmapped |
| 249 | SE-RG-CARD-FLIP | 1 | jingle | 48 | 182 |  | unmapped |
| 250 | SE-RG-CARD-FLIPPING | 1 | jingle | 120 | 182 |  | unmapped |
| 251 | SE-RG-CARD-OPEN | 2 | jingle | 120 | 174 |  | unmapped |
| 252 | SE-RG-BAG-CURSOR | 2 | jingle | 9 | 310 |  | unmapped |
| 253 | SE-RG-BAG-POCKET | 2 | jingle | 6 | 422 |  | unmapped |
| 254 | SE-RG-BALL-CLICK | 2 | jingle | 21 | 310 |  | unmapped |
| 255 | SE-RG-SHOP | 1 | jingle | 30 | 124 |  | unmapped |
| 256 | SE-RG-SS-ANNE-HORN | 2 | jingle | 240 | 164 |  | unmapped |
| 257 | SE-RG-HELP-OPEN | 1 | jingle | 96 | 420 |  | unmapped |
| 258 | SE-RG-HELP-CLOSE | 1 | jingle | 96 | 420 |  | unmapped |
| 259 | SE-RG-HELP-ERROR | 1 | jingle | 48 | 420 |  | unmapped |
| 260 | SE-RG-DEOXYS-MOVE | 3 | jingle | 192 | 262 |  | unmapped |
| 261 | SE-RG-POKE-JUMP-SUCCESS | 2 | jingle | 51 | 150 |  | unmapped |
| 262 | SE-RG-POKE-JUMP-FAILURE | 1 | jingle | 33 | 240 |  | unmapped |
| 263 | SE-POKENAV-CALL | 2 | jingle | 24 | 136 |  | unmapped |
| 264 | SE-POKENAV-HANG-UP | 2 | jingle | 30 | 120 |  | unmapped |
| 265 | SE-ARENA-TIMEUP1 | 2 | jingle | 36 | 92 |  | unmapped |
| 266 | SE-ARENA-TIMEUP2 | 2 | jingle | 48 | 92 |  | unmapped |
| 267 | SE-PIKE-CURTAIN-CLOSE | 3 | jingle | 79 | 98 |  | unmapped |
| 268 | SE-PIKE-CURTAIN-OPEN | 3 | jingle | 72 | 112 |  | unmapped |
| 269 | SE-SUDOWOODO-SHAKE | 1 | jingle | 36 | 100 |  | unmapped |
| 350 | MUS-LITTLEROOT-TEST | 9 | loop | 1584 | 108 |  | unmapped |
| 351 | MUS-GSC-ROUTE38 | 4 | loop | 1728 | 130 |  | unmapped |
| 352 | MUS-CAUGHT | 7 | loop | 780 | 140 |  | unmapped |
| 353 | MUS-VICTORY-WILD | 7 | loop | 873 | 140 |  | unmapped |
| 354 | MUS-VICTORY-GYM-LEADER | 8 | loop | 2649 | 138 | victory_gym |  |
| 355 | MUS-VICTORY-LEAGUE | 8 | loop | 1956 | 140 | victory_league |  |
| 356 | MUS-C-COMM-CENTER | 3 | loop | 1440 | 120 |  | unmapped |
| 357 | MUS-GSC-PEWTER | 4 | loop | 2784 | 128 |  | unmapped |
| 358 | MUS-C-VS-LEGEND-BEAST | 3 | loop | 5904 | 186 |  | unmapped |
| 359 | MUS-ROUTE101 | 8 | loop | 1356 | 114 |  | unmapped |
| 360 | MUS-ROUTE110 | 9 | loop | 1932 | 132 |  | unmapped |
| 361 | MUS-ROUTE120 | 8 | loop | 3072 | 134 |  | unmapped |
| 362 | MUS-PETALBURG | 8 | loop | 1632 | 126 |  | unmapped |
| 363 | MUS-OLDALE | 7 | loop | 1536 | 100 |  | unmapped |
| 364 | MUS-GYM | 7 | loop | 1728 | 128 |  | unmapped |
| 365 | MUS-SURF | 6 | loop | 2340 | 82 |  | unmapped |
| 366 | MUS-PETALBURG-WOODS | 9 | loop | 2196 | 130 |  | unmapped |
| 367 | MUS-LEVEL-UP | 5 | jingle | 96 | 174 |  | unmapped |
| 368 | MUS-HEAL | 4 | jingle | 120 | 132 |  | unmapped |
| 369 | MUS-OBTAIN-BADGE | 7 | jingle | 300 | 144 |  | unmapped |
| 370 | MUS-OBTAIN-ITEM | 6 | jingle | 204 | 190 |  | unmapped |
| 371 | MUS-EVOLVED | 7 | jingle | 300 | 150 |  | unmapped |
| 372 | MUS-OBTAIN-TMHM | 7 | jingle | 180 | 140 |  | unmapped |
| 373 | MUS-LILYCOVE-MUSEUM | 6 | loop | 2424 | 68 |  | unmapped |
| 374 | MUS-ROUTE122 | 8 | loop | 2400 | 124 |  | unmapped |
| 375 | MUS-OCEANIC-MUSEUM | 7 | loop | 2976 | 120 |  | unmapped |
| 376 | MUS-EVOLUTION-INTRO | 4 | jingle | 48 | 120 |  | unmapped |
| 377 | MUS-EVOLUTION | 7 | loop | 864 | 120 | evolution |  |
| 378 | MUS-MOVE-DELETED | 6 | jingle | 156 | 150 |  | unmapped |
| 379 | MUS-ENCOUNTER-GIRL | 8 | loop | 888 | 144 |  | trainer-encounter table id 2 |
| 380 | MUS-ENCOUNTER-MALE | 7 | loop | 864 | 138 |  | trainer-encounter table id 0 |
| 381 | MUS-ABANDONED-SHIP | 8 | loop | 1572 | 100 |  | unmapped |
| 382 | MUS-FORTREE | 8 | loop | 1728 | 128 |  | unmapped |
| 383 | MUS-BIRCH-LAB | 7 | loop | 1152 | 100 | editor, lab |  |
| 384 | MUS-B-TOWER-RS | 9 | loop | 2040 | 128 |  | unmapped |
| 385 | MUS-ENCOUNTER-SWIMMER | 8 | loop | 720 | 142 |  | trainer-encounter table id 8 |
| 386 | MUS-CAVE-OF-ORIGIN | 9 | loop | 1752 | 100 |  | unmapped |
| 387 | MUS-OBTAIN-BERRY | 5 | jingle | 108 | 140 |  | unmapped |
| 388 | MUS-AWAKEN-LEGEND | 7 | jingle | 636 | 140 |  | unmapped |
| 389 | MUS-SLOTS-JACKPOT | 7 | jingle | 252 | 144 |  | unmapped |
| 390 | MUS-SLOTS-WIN | 7 | jingle | 144 | 144 |  | unmapped |
| 391 | MUS-TOO-BAD | 5 | jingle | 168 | 180 | defeat |  |
| 392 | MUS-ROULETTE | 7 | loop | 912 | 180 |  | unmapped |
| 393 | MUS-LINK-CONTEST-P1 | 7 | loop | 2112 | 128 |  | unmapped |
| 394 | MUS-LINK-CONTEST-P2 | 7 | loop | 2112 | 128 |  | unmapped |
| 395 | MUS-LINK-CONTEST-P3 | 7 | loop | 2112 | 128 |  | unmapped |
| 396 | MUS-LINK-CONTEST-P4 | 5 | loop | 2112 | 128 |  | unmapped |
| 397 | MUS-ENCOUNTER-RICH | 5 | loop | 936 | 128 |  | trainer-encounter table id 13 |
| 398 | MUS-VERDANTURF | 10 | loop | 1554 | 84 |  | unmapped |
| 399 | MUS-RUSTBORO | 8 | loop | 3156 | 128 |  | unmapped |
| 400 | MUS-POKE-CENTER | 9 | loop | 1632 | 104 | hub, pokecenter |  |
| 401 | MUS-ROUTE104 | 10 | loop | 2112 | 128 |  | unmapped |
| 402 | MUS-ROUTE119 | 9 | loop | 3984 | 136 |  | unmapped |
| 403 | MUS-CYCLING | 9 | loop | 2784 | 138 |  | PlayBGM @0x080F2A8E,@0x080F30A0 |
| 404 | MUS-POKE-MART | 8 | loop | 3072 | 172 |  | unmapped |
| 405 | MUS-LITTLEROOT | 9 | loop | 2340 | 108 | town |  |
| 406 | MUS-MT-CHIMNEY | 9 | loop | 4656 | 124 |  | unmapped |
| 407 | MUS-ENCOUNTER-FEMALE | 9 | loop | 480 | 90 |  | trainer-encounter table id 1 |
| 408 | MUS-LILYCOVE | 6 | loop | 2016 | 80 |  | unmapped |
| 409 | MUS-DESERT | 8 | loop | 1920 | 120 |  | unmapped |
| 410 | MUS-HELP | 7 | loop | 390 | 136 |  | unmapped |
| 411 | MUS-UNDERWATER | 10 | loop | 2976 | 86 |  | unmapped |
| 412 | MUS-VICTORY-TRAINER | 9 | loop | 880 | 136 |  | unmapped |
| 413 | MUS-TITLE | 10 | jingle | 5496 | 144 | title |  |
| 414 | MUS-INTRO | 10 | jingle | 1824 | 118 |  | unmapped |
| 415 | MUS-ENCOUNTER-MAY | 10 | loop | 1728 | 128 |  | unmapped |
| 416 | MUS-ENCOUNTER-INTENSE | 8 | loop | 792 | 140 | preview | trainer-encounter table id 4 |
| 417 | MUS-ENCOUNTER-COOL | 9 | loop | 1740 | 140 |  | trainer-encounter table id 5 |
| 418 | MUS-ROUTE113 | 9 | loop | 3324 | 128 |  | unmapped |
| 419 | MUS-ENCOUNTER-AQUA | 10 | loop | 1740 | 140 |  | trainer-encounter table id 6 |
| 420 | MUS-FOLLOW-ME | 8 | loop | 1344 | 128 |  | unmapped |
| 421 | MUS-ENCOUNTER-BRENDAN | 10 | loop | 1728 | 128 |  | unmapped |
| 422 | MUS-EVER-GRANDE | 8 | loop | 3480 | 128 |  | unmapped |
| 423 | MUS-ENCOUNTER-SUSPICIOUS | 9 | loop | 1032 | 122 |  | trainer-encounter table id 3 |
| 424 | MUS-VICTORY-AQUA-MAGMA | 9 | loop | 592 | 142 |  | victory: Aqua/Magma classes (mask 0x2A08 + 49,53) |
| 425 | MUS-CABLE-CAR | 9 | jingle | 3168 | 120 |  | unmapped |
| 426 | MUS-GAME-CORNER | 10 | loop | 5094 | 182 |  | unmapped |
| 427 | MUS-DEWFORD | 10 | loop | 2496 | 94 |  | unmapped |
| 428 | MUS-SAFARI-ZONE | 9 | loop | 1164 | 142 |  | unmapped |
| 429 | MUS-VICTORY-ROAD | 10 | loop | 2880 | 134 |  | unmapped |
| 430 | MUS-AQUA-MAGMA-HIDEOUT | 9 | loop | 1920 | 118 |  | unmapped |
| 431 | MUS-SAILING | 9 | loop | 1932 | 156 |  | unmapped |
| 432 | MUS-MT-PYRE | 10 | loop | 1920 | 90 |  | unmapped |
| 433 | MUS-SLATEPORT | 10 | loop | 4080 | 124 |  | unmapped |
| 434 | MUS-MT-PYRE-EXTERIOR | 10 | loop | 3360 | 102 |  | unmapped |
| 435 | MUS-SCHOOL | 4 | loop | 1728 | 116 |  | unmapped |
| 436 | MUS-HALL-OF-FAME | 10 | loop | 1740 | 122 | result_win, hof | PlayBGM @0x08174EC0 |
| 437 | MUS-FALLARBOR | 9 | loop | 3168 | 148 |  | unmapped |
| 438 | MUS-SEALED-CHAMBER | 8 | loop | 2016 | 140 |  | unmapped |
| 439 | MUS-CONTEST-WINNER | 8 | loop | 780 | 148 |  | unmapped |
| 440 | MUS-CONTEST | 8 | loop | 2112 | 128 |  | unmapped |
| 441 | MUS-ENCOUNTER-MAGMA | 10 | loop | 1260 | 148 |  | trainer-encounter table id 7 |
| 442 | MUS-INTRO-BATTLE | 9 | jingle | 1068 | 184 |  | direct m4aSongNumStart(442) @0x081876DC |
| 443 | MUS-ABNORMAL-WEATHER | 6 | loop | 1368 | 108 |  | unmapped |
| 444 | MUS-WEATHER-GROUDON | 3 | loop | 864 | 78 |  | unmapped |
| 445 | MUS-SOOTOPOLIS | 8 | loop | 2964 | 136 |  | unmapped |
| 446 | MUS-CONTEST-RESULTS | 8 | loop | 792 | 128 |  | PlayBGM @0x0810FDCC,@0x081107A2 (contest results) |
| 447 | MUS-HALL-OF-FAME-ROOM | 7 | loop | 1560 | 114 |  | unmapped |
| 448 | MUS-TRICK-HOUSE | 8 | loop | 2400 | 136 |  | unmapped |
| 449 | MUS-ENCOUNTER-TWINS | 10 | loop | 576 | 134 |  | trainer-encounter table id 9 |
| 450 | MUS-ENCOUNTER-ELITE-FOUR | 9 | loop | 1176 | 134 |  | trainer-encounter table id 10 |
| 451 | MUS-ENCOUNTER-HIKER | 8 | loop | 864 | 128 |  | trainer-encounter table id 11 |
| 452 | MUS-CONTEST-LOBBY | 8 | loop | 1728 | 128 |  | unmapped |
| 453 | MUS-ENCOUNTER-INTERVIEWER | 9 | loop | 582 | 142 |  | trainer-encounter table id 12 |
| 454 | MUS-ENCOUNTER-CHAMPION | 10 | loop | 1728 | 142 |  | unmapped |
| 455 | MUS-CREDITS | 10 | jingle | 6432 | 94 | credits |  |
| 456 | MUS-END | 2 | loop | 4944 | 138 |  | direct m4aSongNumStart(456) @0x08112BF6 |
| 457 | MUS-B-FRONTIER | 9 | loop | 2124 | 122 |  | unmapped |
| 458 | MUS-B-ARENA | 9 | loop | 2598 | 128 |  | unmapped |
| 459 | MUS-OBTAIN-B-POINTS | 9 | jingle | 192 | 122 |  | unmapped |
| 460 | MUS-REGISTER-MATCH-CALL | 5 | jingle | 72 | 96 |  | unmapped |
| 461 | MUS-B-PYRAMID | 10 | loop | 3288 | 106 |  | PlayBGM @0x0816B4E4 |
| 462 | MUS-B-PYRAMID-TOP | 7 | loop | 384 | 90 |  | PlayBGM @0x0816B4CA |
| 463 | MUS-B-PALACE | 9 | loop | 3414 | 96 |  | unmapped |
| 464 | MUS-RAYQUAZA-APPEARS | 7 | jingle | 1248 | 120 |  | unmapped |
| 465 | MUS-B-TOWER | 7 | loop | 2496 | 122 |  | unmapped |
| 466 | MUS-OBTAIN-SYMBOL | 9 | jingle | 240 | 122 |  | unmapped |
| 467 | MUS-B-DOME | 10 | loop | 2688 | 144 |  | unmapped |
| 468 | MUS-B-PIKE | 10 | loop | 2592 | 120 |  | unmapped |
| 469 | MUS-B-FACTORY | 9 | loop | 3720 | 144 |  | unmapped |
| 470 | MUS-VS-RAYQUAZA | 6 | loop | 3456 | 196 |  | battle: legendary branch, species 384 (Rayquaza) |
| 471 | MUS-VS-FRONTIER-BRAIN | 10 | loop | 7116 | 190 |  | unmapped |
| 472 | MUS-VS-MEW | 8 | loop | 3264 | 182 |  | unmapped |
| 473 | MUS-B-DOME-LOBBY | 3 | loop | 1152 | 144 |  | unmapped |
| 474 | MUS-VS-WILD | 8 | loop | 4128 | 196 |  | unmapped |
| 475 | MUS-VS-AQUA-MAGMA | 8 | loop | 7392 | 200 |  | battle: Aqua/Magma classes 3,9,11,49 |
| 476 | MUS-VS-TRAINER | 8 | loop | 7104 | 198 |  | unmapped |
| 477 | MUS-VS-GYM-LEADER | 8 | loop | 5952 | 196 |  | unmapped |
| 478 | MUS-VS-CHAMPION | 8 | loop | 5568 | 212 |  | unmapped |
| 479 | MUS-VS-REGI | 8 | loop | 3840 | 160 |  | battle: legendary branch (Regi range) |
| 480 | MUS-VS-KYOGRE-GROUDON | 6 | loop | 3456 | 196 |  | battle: legendary branch, species 382/383 |
| 481 | MUS-VS-RIVAL | 8 | loop | 4992 | 196 |  | unmapped |
| 482 | MUS-VS-ELITE-FOUR | 8 | loop | 5280 | 214 |  | unmapped |
| 483 | MUS-VS-AQUA-MAGMA-LEADER | 8 | loop | 6096 | 202 |  | battle: Aqua/Magma leader classes 13,53 |
| 484 | MUS-RG-FOLLOW-ME | 8 | loop | 960 | 146 |  | unmapped |
| 485 | MUS-RG-GAME-CORNER | 8 | loop | 2520 | 146 |  | unmapped |
| 486 | MUS-RG-ROCKET-HIDEOUT | 10 | loop | 3840 | 130 |  | unmapped |
| 487 | MUS-RG-GYM | 7 | loop | 1728 | 128 |  | unmapped |
| 488 | MUS-RG-JIGGLYPUFF | 4 | jingle | 384 | 146 |  | unmapped |
| 489 | MUS-RG-INTRO-FIGHT | 8 | jingle | 912 | 188 |  | unmapped |
| 490 | MUS-RG-TITLE | 10 | loop | 2520 | 140 |  | unmapped |
| 491 | MUS-RG-CINNABAR | 9 | loop | 1728 | 120 |  | unmapped |
| 492 | MUS-RG-LAVENDER | 8 | loop | 4224 | 128 | result_lose |  |
| 493 | MUS-RG-HEAL | 2 | jingle | 120 | 146 |  | unmapped |
| 494 | MUS-RG-CYCLING | 8 | loop | 1836 | 134 |  | unmapped |
| 495 | MUS-RG-ENCOUNTER-ROCKET | 7 | loop | 504 | 146 |  | unmapped |
| 496 | MUS-RG-ENCOUNTER-GIRL | 9 | loop | 468 | 174 |  | unmapped |
| 497 | MUS-RG-ENCOUNTER-BOY | 8 | loop | 576 | 154 |  | unmapped |
| 498 | MUS-RG-HALL-OF-FAME | 9 | loop | 1728 | 152 |  | unmapped |
| 499 | MUS-RG-VIRIDIAN-FOREST | 10 | loop | 5388 | 128 |  | unmapped |
| 500 | MUS-RG-MT-MOON | 7 | loop | 3900 | 110 |  | unmapped |
| 501 | MUS-RG-POKE-MANSION | 10 | loop | 3456 | 132 |  | unmapped |
| 502 | MUS-RG-CREDITS | 9 | jingle | 11376 | 94 |  | unmapped |
| 503 | MUS-RG-ROUTE1 | 8 | loop | 1164 | 116 |  | unmapped |
| 504 | MUS-RG-ROUTE24 | 6 | loop | 984 | 118 |  | unmapped |
| 505 | MUS-RG-ROUTE3 | 9 | loop | 1788 | 124 |  | unmapped |
| 506 | MUS-RG-ROUTE11 | 10 | loop | 1728 | 124 |  | unmapped |
| 507 | MUS-RG-VICTORY-ROAD | 8 | loop | 1752 | 136 |  | unmapped |
| 508 | MUS-RG-VS-GYM-LEADER | 10 | loop | 4224 | 186 |  | unmapped |
| 509 | MUS-RG-VS-TRAINER | 10 | loop | 7008 | 172 |  | unmapped |
| 510 | MUS-RG-VS-WILD | 8 | loop | 3168 | 182 |  | unmapped |
| 511 | MUS-RG-VS-CHAMPION | 10 | loop | 5088 | 172 |  | unmapped |
| 512 | MUS-RG-PALLET | 6 | loop | 1536 | 88 |  | unmapped |
| 513 | MUS-RG-OAK-LAB | 6 | loop | 816 | 120 |  | unmapped |
| 514 | MUS-RG-OAK | 9 | loop | 1632 | 160 |  | unmapped |
| 515 | MUS-RG-POKE-CENTER | 10 | loop | 1536 | 116 |  | unmapped |
| 516 | MUS-RG-SS-ANNE | 10 | loop | 3264 | 114 |  | unmapped |
| 517 | MUS-RG-SURF | 7 | loop | 1296 | 100 |  | unmapped |
| 518 | MUS-RG-POKE-TOWER | 6 | loop | 3168 | 134 |  | unmapped |
| 519 | MUS-RG-SILPH | 9 | loop | 3336 | 114 |  | unmapped |
| 520 | MUS-RG-FUCHSIA | 9 | loop | 1632 | 120 |  | unmapped |
| 521 | MUS-RG-CELADON | 7 | loop | 1728 | 110 |  | unmapped |
| 522 | MUS-RG-VICTORY-TRAINER | 9 | loop | 880 | 136 |  | unmapped |
| 523 | MUS-RG-VICTORY-WILD | 7 | loop | 873 | 140 |  | unmapped |
| 524 | MUS-RG-VICTORY-GYM-LEADER | 8 | loop | 2649 | 138 |  | unmapped |
| 525 | MUS-RG-VERMILLION | 9 | loop | 1728 | 116 |  | unmapped |
| 526 | MUS-RG-PEWTER | 9 | loop | 3096 | 126 |  | unmapped |
| 527 | MUS-RG-ENCOUNTER-RIVAL | 9 | loop | 1344 | 168 |  | unmapped |
| 528 | MUS-RG-RIVAL-EXIT | 9 | loop | 1248 | 168 |  | unmapped |
| 529 | MUS-RG-DEX-RATING | 7 | jingle | 96 | 64 |  | unmapped |
| 530 | MUS-RG-OBTAIN-KEY-ITEM | 6 | jingle | 72 | 44 |  | unmapped |
| 531 | MUS-RG-CAUGHT-INTRO | 8 | jingle | 180 | 64 |  | unmapped |
| 532 | MUS-RG-PHOTO | 5 | jingle | 96 | 192 |  | unmapped |
| 533 | MUS-RG-GAME-FREAK | 5 | jingle | 522 | 150 |  | unmapped |
| 534 | MUS-RG-CAUGHT | 7 | loop | 780 | 140 |  | unmapped |
| 535 | MUS-RG-NEW-GAME-INSTRUCT | 1 | loop | 204 | 120 |  | unmapped |
| 536 | MUS-RG-NEW-GAME-INTRO | 6 | loop | 576 | 120 |  | unmapped |
| 537 | MUS-RG-NEW-GAME-EXIT | 7 | jingle | 96 | 120 |  | unmapped |
| 538 | MUS-RG-POKE-JUMP | 8 | loop | 2520 | 138 |  | unmapped |
| 539 | MUS-RG-UNION-ROOM | 8 | loop | 2520 | 134 |  | unmapped |
| 540 | MUS-RG-NET-CENTER | 10 | loop | 1536 | 114 |  | unmapped |
| 541 | MUS-RG-MYSTERY-GIFT | 7 | loop | 864 | 124 |  | unmapped |
| 542 | MUS-RG-BERRY-PICK | 8 | loop | 2520 | 148 |  | unmapped |
| 543 | MUS-RG-SEVII-CAVE | 7 | loop | 3900 | 110 |  | unmapped |
| 544 | MUS-RG-TEACHY-TV-SHOW | 8 | loop | 960 | 146 |  | unmapped |
| 545 | MUS-RG-SEVII-ROUTE | 10 | loop | 1848 | 124 |  | unmapped |
| 546 | MUS-RG-SEVII-DUNGEON | 10 | loop | 5388 | 128 |  | unmapped |
| 547 | MUS-RG-SEVII-123 | 9 | loop | 3096 | 126 |  | unmapped |
| 548 | MUS-RG-SEVII-45 | 9 | loop | 2508 | 120 |  | unmapped |
| 549 | MUS-RG-SEVII-67 | 9 | loop | 2016 | 116 |  | unmapped |
| 550 | MUS-RG-POKE-FLUTE | 2 | jingle | 1632 | 80 |  | unmapped |
| 551 | MUS-RG-VS-DEOXYS | 10 | loop | 5184 | 128 |  | unmapped |
| 552 | MUS-RG-VS-MEWTWO | 8 | loop | 3168 | 182 |  | unmapped |
| 553 | MUS-RG-VS-LEGEND | 8 | loop | 3168 | 182 | battle_legendary |  |
| 554 | MUS-RG-ENCOUNTER-GYM-LEADER | 7 | loop | 576 | 164 |  | unmapped |
| 555 | MUS-RG-ENCOUNTER-DEOXYS | 7 | loop | 768 | 128 |  | unmapped |
| 556 | MUS-RG-TRAINER-TOWER | 7 | loop | 1728 | 128 |  | unmapped |
| 557 | MUS-RG-SLOW-PALLET | 6 | loop | 1536 | 72 |  | unmapped |
| 558 | MUS-RG-TEACHY-TV-MENU | 4 | loop | 216 | 144 |  | unmapped |
| 559 |  | 1 | jingle | 47 | 120 |  | unmapped |
| 560 |  | 1 | loop | 192 | 120 |  | unmapped |
| 561 |  | 1 | jingle | 54 | 120 |  | unmapped |
| 562 |  | 1 | jingle | 54 | 120 |  | unmapped |
| 563 |  | 1 | loop | 192 | 120 |  | unmapped |
| 564 |  | 1 | jingle | 54 | 120 |  | unmapped |
| 565 |  | 1 | jingle | 54 | 120 |  | unmapped |
| 566 |  | 1 | loop | 192 | 120 |  | unmapped |
| 567 |  | 1 | jingle | 54 | 120 |  | unmapped |
| 568 |  | 1 | jingle | 54 | 120 |  | unmapped |
| 569 |  | 1 | loop | 192 | 120 |  | unmapped |
| 570 |  | 1 | jingle | 54 | 120 |  | unmapped |
| 571 |  | 1 | jingle | 54 | 120 |  | unmapped |
| 572 |  | 1 | loop | 192 | 120 |  | unmapped |
| 573 |  | 1 | jingle | 54 | 120 |  | unmapped |
| 574 |  | 1 | jingle | 54 | 120 |  | unmapped |
| 575 |  | 1 | loop | 192 | 120 |  | unmapped |
| 576 |  | 1 | jingle | 54 | 120 |  | unmapped |
| 577 |  | 1 | jingle | 54 | 120 |  | unmapped |
| 578 |  | 1 | loop | 192 | 120 |  | unmapped |
| 579 |  | 1 | jingle | 54 | 120 |  | unmapped |
| 580 |  | 1 | jingle | 54 | 120 |  | unmapped |
| 581 |  | 1 | loop | 192 | 120 |  | unmapped |
| 582 |  | 1 | jingle | 54 | 120 |  | unmapped |
| 583 |  | 1 | jingle | 54 | 120 |  | unmapped |
| 584 |  | 1 | loop | 192 | 120 |  | unmapped |
| 585 |  | 1 | jingle | 54 | 120 |  | unmapped |
| 586 |  | 1 | jingle | 54 | 120 |  | unmapped |
| 587 |  | 1 | loop | 192 | 120 |  | unmapped |
| 588 |  | 1 | jingle | 54 | 120 |  | unmapped |
| 589 |  | 1 | jingle | 54 | 120 |  | unmapped |
| 590 |  | 1 | loop | 192 | 120 |  | unmapped |
| 591 |  | 1 | jingle | 54 | 120 |  | unmapped |
| 592 |  | 1 | jingle | 54 | 120 |  | unmapped |
| 593 |  | 1 | loop | 192 | 120 |  | unmapped |
| 594 |  | 1 | jingle | 54 | 120 |  | unmapped |
| 595 |  | 1 | jingle | 54 | 120 |  | unmapped |
| 596 |  | 1 | loop | 192 | 120 |  | unmapped |
| 597 |  | 1 | jingle | 54 | 120 |  | unmapped |
| 598 |  | 1 | jingle | 54 | 120 |  | unmapped |
| 599 |  | 1 | loop | 192 | 120 |  | unmapped |
| 600 |  | 1 | jingle | 54 | 120 |  | unmapped |
| 601 |  | 1 | jingle | 54 | 120 |  | unmapped |
| 602 |  | 1 | loop | 192 | 120 |  | unmapped |
| 603 |  | 1 | jingle | 54 | 120 |  | unmapped |
| 604 |  | 1 | jingle | 54 | 120 |  | unmapped |
| 605 |  | 1 | loop | 192 | 120 |  | unmapped |
| 606 |  | 1 | jingle | 54 | 120 |  | unmapped |
| 607 |  | 1 | jingle | 54 | 120 |  | unmapped |
| 608 |  | 1 | loop | 192 | 120 |  | unmapped |
| 609 |  | 1 | jingle | 54 | 120 |  | unmapped |
| 612 |  | 9 | loop | 1440 | 50 |  | unmapped |
| 614 |  | 9 | loop | 4224 | 140 |  | unmapped |
| 621 |  | 9 | loop | 4152 | 118 |  | unmapped |
| 622 |  | 9 | loop | 4524 | 134 |  | unmapped |
| 630 |  | 9 | loop | 2592 | 86 |  | unmapped |
| 631 |  | 9 | loop | 3468 | 122 |  | unmapped |
| 632 |  | 10 | loop | 3840 | 94 |  | unmapped |
| 638 |  | 9 | loop | 1440 | 50 |  | unmapped |
| 646 |  | 8 | loop | 3648 | 134 |  | unmapped |
| 649 |  | 7 | loop | 4320 | 104 |  | unmapped |
| 652 |  | 6 | loop | 1440 | 120 |  | unmapped |
| 653 |  | 8 | loop | 4656 | 128 |  | unmapped |
| 654 |  | 7 | loop | 1920 | 100 |  | unmapped |
| 658 |  | 10 | loop | 3936 | 92 |  | unmapped |
| 659 |  | 8 | loop | 1848 | 96 |  | unmapped |
| 663 |  | 8 | loop | 4320 | 152 |  | unmapped |
| 665 |  | 8 | loop | 1536 | 60 |  | unmapped |
| 669 |  | 8 | loop | 2400 | 110 |  | unmapped |
| 670 |  | 9 | loop | 2568 | 96 |  | unmapped |
| 671 |  | 10 | loop | 4944 | 156 |  | unmapped |
| 672 |  | 9 | loop | 2016 | 116 |  | unmapped |
| 673 |  | 8 | loop | 3168 | 114 |  | unmapped |
| 675 |  | 11 | loop | 2304 | 64 |  | unmapped |
| 685 |  | 8 | loop | 3072 | 130 |  | unmapped |
| 691 |  | 8 | loop | 1728 | 308 |  | trainer-encounter table id 25 |
| 692 |  | 9 | loop | 576 | 130 |  | trainer-encounter table id 26 |
| 693 |  | 7 | loop | 1152 | 286 |  | trainer-encounter table id 27 |
| 694 |  | 9 | loop | 864 | 110 |  | trainer-encounter table id 28 |
| 695 |  | 8 | loop | 1824 | 280 |  | trainer-encounter table id 29 |
| 696 |  | 7 | loop | 1248 | 250 |  | trainer-encounter table id 30 |
| 697 |  | 8 | loop | 1464 | 160 |  | trainer-encounter table id 31 |
| 698 |  | 9 | loop | 1920 | 140 |  | trainer-encounter table id 32 |
| 699 |  | 8 | loop | 1728 | 208 |  | trainer-encounter table id 33 |
| 700 |  | 8 | loop | 1248 | 150 |  | trainer-encounter table id 34 |
| 701 |  | 9 | loop | 1020 | 228 |  | trainer-encounter table id 35 |
| 702 |  | 9 | loop | 1728 | 170 |  | trainer-encounter table id 36 |
| 703 |  | 6 | loop | 1548 | 120 |  | trainer-encounter table id 37 |
| 704 |  | 8 | loop | 960 | 134 |  | trainer-encounter table id 38 |
| 705 |  | 8 | loop | 3264 | 202 |  | trainer-encounter table id 39 |
| 707 |  | 9 | loop | 6336 | 180 |  | unmapped |
| 708 |  | 10 | loop | 8160 | 186 |  | unmapped |
| 709 |  | 9 | loop | 6720 | 184 |  | unmapped |
| 711 |  | 9 | loop | 10608 | 180 |  | unmapped |
| 712 |  | 9 | loop | 5760 | 164 |  | unmapped |
| 716 |  | 8 | loop | 3840 | 150 |  | unmapped |
| 802 |  | 16 | jingle | 4353 | 148 |  | direct m4aSongNumStart(802) @0x0825FB44 (16 tracks, no loop; purpose not traced) |
| 803 |  | 8 | loop | 1200 | 118 |  | unmapped |
| 805 |  | 7 | loop | 1344 | 126 |  | PlayBGM(805) @0x081308C0 (purpose not traced) |
| 807 |  | 12 | loop | 4056 | 140 |  | unmapped |
| 811 |  | 14 | loop | 3072 | 128 |  | unmapped |
| 812 |  | 9 | loop | 2409 | 118 |  | unmapped |
| 813 |  | 14 | loop | 2784 | 108 |  | unmapped |
| 814 |  | 12 | loop | 3180 | 120 |  | unmapped |
| 815 |  | 11 | loop | 2304 | 136 |  | unmapped |
| 816 |  | 9 | loop | 2688 | 84 |  | unmapped |
| 817 |  | 7 | loop | 2592 | 88 |  | unmapped |
| 818 |  | 9 | loop | 2268 | 100 |  | unmapped |
| 819 |  | 14 | loop | 1932 | 128 |  | PlayBGM(819) @0x081A4AC8 (purpose not traced) |
| 820 |  | 9 | loop | 2880 | 132 |  | unmapped |
| 821 |  | 9 | loop | 2784 | 130 |  | unmapped |
| 822 |  | 12 | loop | 2304 | 132 |  | unmapped |
| 823 |  | 13 | loop | 1920 | 96 |  | unmapped |
| 824 |  | 11 | loop | 3552 | 122 |  | unmapped |
| 825 |  | 13 | loop | 1728 | 126 |  | unmapped |
| 826 |  | 13 | loop | 1440 | 60 |  | unmapped |
| 827 |  | 13 | loop | 1728 | 130 |  | unmapped |
| 828 |  | 12 | loop | 1692 | 84 |  | unmapped |
| 829 |  | 4 | loop | 1152 | 70 |  | unmapped |
| 830 |  | 11 | loop | 1548 | 104 |  | unmapped |
| 831 |  | 11 | loop | 1884 | 116 |  | unmapped |
| 832 |  | 13 | loop | 1824 | 114 |  | unmapped |
| 833 |  | 12 | loop | 1440 | 106 |  | unmapped |
| 834 |  | 12 | loop | 1776 | 128 |  | unmapped |
| 835 |  | 8 | loop | 1536 | 114 |  | unmapped |
| 836 |  | 11 | loop | 2880 | 136 |  | unmapped |
| 837 |  | 14 | loop | 2028 | 120 |  | unmapped |
| 838 |  | 10 | loop | 2166 | 138 |  | unmapped |
| 839 |  | 13 | loop | 3096 | 162 |  | unmapped |
| 840 |  | 9 | loop | 969 | 92 |  | unmapped |
| 841 |  | 12 | loop | 4272 | 130 |  | unmapped |
| 844 |  | 10 | loop | 2304 | 108 |  | unmapped |
| 845 |  | 7 | loop | 2712 | 108 |  | unmapped |
| 846 |  | 13 | loop | 1344 | 84 |  | unmapped |
| 847 |  | 12 | loop | 4035 | 140 |  | unmapped |
| 848 |  | 11 | loop | 2016 | 90 |  | unmapped |
| 849 |  | 14 | loop | 1920 | 86 |  | unmapped |
| 850 |  | 8 | loop | 1920 | 132 |  | unmapped |
| 851 |  | 11 | loop | 2496 | 130 |  | unmapped |
| 852 |  | 9 | loop | 5184 | 160 |  | unmapped |
| 853 |  | 14 | loop | 3744 | 130 |  | unmapped |
| 854 |  | 12 | loop | 3912 | 92 |  | unmapped |
| 855 |  | 13 | loop | 3120 | 120 |  | unmapped |
| 856 |  | 9 | loop | 2304 | 130 |  | unmapped |
| 857 |  | 8 | loop | 2688 | 140 |  | unmapped |
| 858 |  | 7 | loop | 804 | 128 |  | unmapped |
| 860 |  | 10 | loop | 1968 | 182 |  | trainer-encounter table id 22 |
| 861 |  | 11 | loop | 1632 | 182 |  | unmapped |
| 864 |  | 3 | loop | 384 | 240 |  | unmapped |
| 865 |  | 9 | loop | 2412 | 160 |  | unmapped |
| 867 |  | 13 | loop | 3468 | 150 |  | unmapped |
| 868 |  | 5 | loop | 396 | 84 |  | unmapped |
| 870 |  | 5 | loop | 960 | 74 |  | unmapped |
| 871 |  | 8 | loop | 1251 | 132 |  | unmapped |
| 872 |  | 3 | loop | 1440 | 200 |  | unmapped |
| 873 |  | 4 | loop | 984 | 78 |  | unmapped |
| 874 |  | 11 | loop | 1920 | 116 |  | unmapped |
| 875 |  | 7 | loop | 2496 | 142 |  | unmapped |
| 876 |  | 13 | loop | 1542 | 140 |  | unmapped |
| 878 |  | 8 | loop | 960 | 148 |  | trainer-encounter table id 17 |
| 879 |  | 11 | loop | 984 | 160 |  | trainer-encounter table id 15 |
| 880 |  | 9 | loop | 1272 | 132 |  | trainer-encounter table id 19 |
| 881 |  | 8 | loop | 1260 | 132 |  | trainer-encounter table id 21 |
| 882 |  | 10 | loop | 528 | 118 |  | trainer-encounter table id 24 |
| 883 |  | 9 | loop | 876 | 160 |  | trainer-encounter table id 23 |
| 884 |  | 10 | loop | 864 | 144 |  | trainer-encounter table id 18 |
| 885 |  | 11 | loop | 960 | 164 |  | trainer-encounter table id 16 |
| 886 |  | 6 | loop | 1272 | 144 |  | trainer-encounter table id 20 |
| 887 |  | 11 | loop | 3839 | 182 | battle_easy |  |
| 888 |  | 11 | loop | 9276 | 186 | battle_normal |  |
| 889 |  | 14 | loop | 5760 | 188 | battle_hard |  |
| 890 |  | 11 | loop | 5004 | 180 | battle_rival |  |
| 891 |  | 13 | loop | 5184 | 188 | battle_villain |  |
| 892 |  | 14 | loop | 7968 | 190 |  | battle: flag-0x400 branch returns 1137-species for species 245 (Suicune) |
| 893 |  | 14 | loop | 6072 | 190 |  | battle: same branch, species 244 (Entei) |
| 894 |  | 14 | loop | 7968 | 190 |  | battle: same branch, species 243 (Raikou) |
| 895 |  | 13 | loop | 4992 | 184 | battle_final | trainer-encounter table id 14 |
| 897 |  | 10 | loop | 6384 | 172 |  | unmapped |
| 898 |  | 14 | loop | 5088 | 184 |  | unmapped |
| 899 |  | 8 | loop | 1248 | 160 | victory |  |
| 900 |  | 9 | loop | 864 | 152 |  | PlayBGM(900) @0x080B6AF2 (purpose not traced) |
| 901 |  | 8 | loop | 768 | 152 |  | unmapped |
| 902 |  | 9 | loop | 2496 | 164 |  | victory handler special case: opponent id 0x3FE -> PlayBGM(902) @0x0808B93A (flow not fully traced) |
| 903 |  | 14 | loop | 6150 | 154 |  | unmapped |
| 904 |  | 12 | loop | 5352 | 188 |  | unmapped |
| 913 |  | 5 | loop | 3168 | 96 |  | unmapped |
| 915 |  | 7 | loop | 6144 | 46 |  | unmapped |
| 917 |  | 10 | loop | 6624 | 190 | battle_frontier |  |
| 927 |  | 9 | loop | 2832 | 100 |  | unmapped |
| 928 |  | 7 | loop | 2688 | 120 |  | unmapped |
| 929 |  | 9 | loop | 3072 | 120 |  | unmapped |
| 931 |  | 10 | loop | 1248 | 106 |  | unmapped |
| 933 |  | 8 | loop | 804 | 82 |  | unmapped |
| 934 |  | 9 | loop | 969 | 92 |  | unmapped |
| 938 |  | 15 | loop | 4464 | 128 |  | unmapped |
| 939 |  | 12 | loop | 1548 | 114 |  | unmapped |
| 943 |  | 12 | loop | 3840 | 196 |  | unmapped |
| 946 |  | 10 | jingle | 111 | 132 | heal | plays instead of stock 368 (sFanfares played-song field) |
| 947 |  | 6 | jingle | 52 | 174 | levelup, se_levelup | plays instead of stock 367 (sFanfares played-song field) |
| 948 |  | 8 | jingle | 146 | 120 | item | plays instead of stock 370 (sFanfares played-song field) |
| 949 |  | 7 | jingle | 143 | 170 | key_item | plays instead of stock 530 (sFanfares played-song field) |
| 950 |  | 9 | jingle | 243 | 162 | evolved | plays instead of stock 371 (sFanfares played-song field) |
| 951 |  | 8 | jingle | 260 | 120 | victory_sting, badge | plays instead of stock 369 (sFanfares played-song field) |
| 952 |  | 9 | jingle | 156 | 134 | tm | plays instead of stock 372 (sFanfares played-song field) |
| 954 |  | 6 | jingle | 112 | 150 | move_deleted | plays instead of stock 378 (sFanfares played-song field) |
| 955 |  | 8 | jingle | 70 | 120 | berry | plays instead of stock 387 (sFanfares played-song field) |
| 968 |  | 6 | jingle | 154 | 152 |  | plays instead of stock 460 (sFanfares played-song field) |
| 975 |  | 11 | jingle | 173 | 122 |  | plays instead of stock 459 (sFanfares played-song field) |
| 977 |  | 9 | loop | 3168 | 130 |  | unmapped |
| 978 |  | 9 | loop | 1728 | 130 |  | unmapped |
| 979 |  | 4 | loop | 2197 | 120 |  | unmapped |
| 980 |  | 6 | loop | 2592 | 182 |  | unmapped |
| 981 |  | 4 | loop | 1536 | 140 |  | unmapped |
| 982 |  | 4 | loop | 1536 | 140 |  | unmapped |
| 983 |  | 9 | loop | 2016 | 132 |  | unmapped |
| 984 |  | 5 | loop | 3012 | 84 |  | unmapped |
| 985 |  | 5 | loop | 1866 | 120 |  | unmapped |
| 986 |  | 4 | loop | 3412 | 120 |  | unmapped |
| 987 |  | 5 | loop | 863 | 154 |  | unmapped |
| 989 |  | 5 | loop | 3648 | 112 |  | unmapped |

### Ultra Violet (346 songs; name = SoulGold twin)

| idx | SoulGold twin(s) | tr | kind | ticks | tempo | keys | notes |
|---|---|---|---|---|---|---|---|
| 1 | 1 SE-USE-ITEM | 1 | jingle | 24 | 132 | se_use_item |  |
| 2 | 2 SE-PC-LOGIN | 1 | jingle | 24 | 144 |  | unmapped |
| 3 | 3 SE-PC-OFF | 1 | jingle | 18 | 120 |  | unmapped |
| 4 | 4 SE-PC-ON | 1 | jingle | 57 | 144 |  | unmapped |
| 5 | 5 SE-SELECT | 1 | jingle | 18 | 300 | se_cursor, se_select, se_back |  |
| 6 | 6 SE-WIN-OPEN | 1 | jingle | 24 | 220 | se_menu_open |  |
| 7 | 7 SE-WALL-HIT | 1 | jingle | 24 | 220 |  | unmapped |
| 8 | 8 SE-DOOR | 1 | jingle | 24 | 110 |  | unmapped |
| 9 | 9 SE-EXIT | 1 | jingle | 30 | 120 |  | unmapped |
| 10 | 10 SE-LEDGE | 1 | jingle | 9 | 120 |  | unmapped |
| 11 | 11 SE-BIKE-BELL | 1 | jingle | 96 | 120 |  | unmapped |
| 12 | 12 SE-NOT-EFFECTIVE | 2 | jingle | 9 | 90 | se_hit_weak |  |
| 13 | 13 SE-EFFECTIVE | 2 | jingle | 42 | 90 | se_hit_normal |  |
| 14 | 14 SE-SUPER-EFFECTIVE | 2 | jingle | 51 | 90 | se_hit_super |  |
| 15 | 15 SE-BALL-OPEN | 3 | jingle | 15 | 90 | se_ball_open |  |
| 16 | 16 SE-FAINT | 3 | jingle | 30 | 90 | se_faint |  |
| 17 | 17 SE-FLEE | 1 | jingle | 39 | 150 | se_flee |  |
| 18 | 18 SE-SLIDING-DOOR | 1 | jingle | 12 | 120 |  | unmapped |
| 19 | 19 SE-SHIP | 1 | jingle | 168 | 220 |  | unmapped |
| 20 | 20 SE-BANG | 1 | jingle | 72 | 240 |  | unmapped |
| 21 | 21 SE-PIN | 1 | jingle | 15 | 100 |  | unmapped |
| 22 | 22 SE-BOO | 1 | jingle | 12 | 100 |  | unmapped |
| 23 | 23 SE-BALL | 1 | jingle | 6 | 128 |  | unmapped |
| 24 | 24 SE-CONTEST-PLACE | 4 | jingle | 36 | 144 |  | unmapped |
| 25 | 31 SE-SUCCESS | 1 | jingle | 24 | 240 | se_success |  |
| 26 | 32 SE-FAILURE | 1 | jingle | 33 | 240 | se_error |  |
| 27 | 33 SE-EXP | 1 | jingle | 156 | 240 | se_exp |  |
| 28 | 34 SE-BIKE-HOP | 1 | jingle | 6 | 180 |  | unmapped |
| 29 | 35 SE-SWITCH | 1 | jingle | 9 | 150 | se_switch |  |
| 30 | 36 SE-CLICK | 1 | jingle | 9 | 150 |  | unmapped |
| 31 | 37 SE-FU-ZAKU | 1 | jingle | 24 | 150 |  | unmapped |
| 32 | 38 SE-CONTEST-CONDITION-LOSE | 1 | jingle | 9 | 150 |  | unmapped |
| 33 | 39 SE-LAVARIDGE-FALL-WARP | 1 | jingle | 54 | 120 |  | unmapped |
| 34 | 40 SE-ICE-STAIRS | 2 | jingle | 18 | 150 |  | unmapped |
| 35 | 41 SE-ICE-BREAK | 2 | jingle | 15 | 120 |  | unmapped |
| 36 | 42 SE-ICE-CRACK | 2 | jingle | 9 | 150 |  | unmapped |
| 37 | 43 SE-FALL | 1 | jingle | 48 | 170 |  | unmapped |
| 38 | 44 SE-UNLOCK | 2 | jingle | 24 | 150 |  | unmapped |
| 39 | 45 SE-WARP-IN | 1 | jingle | 33 | 110 |  | unmapped |
| 40 | 46 SE-WARP-OUT | 1 | jingle | 36 | 110 |  | unmapped |
| 41 | 47 SE-REPEL | 1 | jingle | 36 | 220 |  | unmapped |
| 42 | 48 SE-ROTATING-GATE | 1 | jingle | 30 | 220 |  | unmapped |
| 43 | 49 SE-TRUCK-MOVE | 2 | loop | 384 | 150 |  | unmapped |
| 44 | 50 SE-TRUCK-STOP | 3 | jingle | 144 | 150 |  | unmapped |
| 45 | 51 SE-TRUCK-UNLOAD | 1 | jingle | 27 | 150 |  | unmapped |
| 46 | 52 SE-TRUCK-DOOR | 2 | jingle | 12 | 150 |  | unmapped |
| 47 | 53 SE-BERRY-BLENDER | 1 | loop | 240 | 150 |  | unmapped |
| 48 | 55 SE-SAVE | 2 | jingle | 42 | 150 | se_save |  |
| 49 | 56 SE-BALL-BOUNCE-1 | 2 | jingle | 12 | 150 | se_ball_bounce |  |
| 50 | 57 SE-BALL-BOUNCE-2 | 2 | jingle | 12 | 150 |  | unmapped |
| 51 | 58 SE-BALL-BOUNCE-3 | 2 | jingle | 12 | 150 |  | unmapped |
| 52 | 59 SE-BALL-BOUNCE-4 | 2 | jingle | 12 | 150 |  | unmapped |
| 53 | 60 SE-BALL-TRADE | 2 | jingle | 12 |  |  | unmapped |
| 54 | 61 SE-BALL-THROW | 1 | jingle | 24 | 150 | se_ball_throw |  |
| 55 | 62 SE-NOTE-C | 2 | jingle | 18 | 150 |  | unmapped |
| 56 | 63 SE-NOTE-D | 2 | jingle | 18 | 150 |  | unmapped |
| 57 | 64 SE-NOTE-E | 2 | jingle | 18 | 150 |  | unmapped |
| 58 | 65 SE-NOTE-F | 2 | jingle | 18 | 150 |  | unmapped |
| 59 | 66 SE-NOTE-G | 2 | jingle | 18 | 150 |  | unmapped |
| 60 | 67 SE-NOTE-A | 2 | jingle | 18 | 150 |  | unmapped |
| 61 | 68 SE-NOTE-B | 2 | jingle | 18 | 150 |  | unmapped |
| 62 | 69 SE-NOTE-C-HIGH | 2 | jingle | 18 | 150 |  | unmapped |
| 63 | 70 SE-PUDDLE | 1 | jingle | 12 | 150 |  | unmapped |
| 64 | 71 SE-BRIDGE-WALK | 1 | jingle | 9 | 150 |  | unmapped |
| 65 | 72 SE-ITEMFINDER | 2 | jingle | 30 | 128 |  | unmapped |
| 66 | 73 SE-DING-DONG | 2 | jingle | 63 | 150 |  | unmapped |
| 67 | 74 SE-BALLOON-RED | 1 | jingle | 24 | 240 |  | unmapped |
| 68 | 75 SE-BALLOON-BLUE | 1 | jingle | 18 | 240 |  | unmapped |
| 69 | 76 SE-BALLOON-YELLOW | 1 | jingle | 18 | 240 |  | unmapped |
| 70 | 77 SE-BREAKABLE-DOOR | 1 | jingle | 30 | 240 |  | unmapped |
| 71 | 78 SE-MUD-BALL | 1 | jingle | 9 | 150 |  | unmapped |
| 72 | 79 SE-FIELD-POISON | 1 | jingle | 24 | 150 |  | unmapped |
| 73 | 80 SE-ESCALATOR | 1 | jingle | 120 | 150 |  | unmapped |
| 74 | 81 SE-THUNDERSTORM | 1 | loop | 84 | 220 |  | unmapped |
| 75 | 82 SE-THUNDERSTORM-STOP | 1 | jingle | 48 | 220 |  | unmapped |
| 76 | 83 SE-DOWNPOUR | 1 | loop | 60 | 220 |  | unmapped |
| 77 | 84 SE-DOWNPOUR-STOP | 1 | jingle | 48 | 220 |  | unmapped |
| 78 | 85 SE-RAIN | 1 | loop | 84 | 220 |  | unmapped |
| 79 | 86 SE-RAIN-STOP | 1 | jingle | 48 | 220 |  | unmapped |
| 80 | 87 SE-THUNDER | 1 | jingle | 144 | 220 |  | unmapped |
| 81 | 88 SE-THUNDER2 | 1 | jingle | 120 | 220 |  | unmapped |
| 82 | 89 SE-ELEVATOR | 2 | jingle | 216 | 150 |  | unmapped |
| 83 |  | 1 | loop | 36 | 150 | se_lowhp | looping, music player 3 (FRLG low-HP beep slot; no SoulGold twin) |
| 84 | 91 SE-EXP-MAX | 2 | jingle | 18 | 150 | se_exp_max |  |
| 85 | 92 SE-ROULETTE-BALL | 1 | jingle | 480 | 150 |  | unmapped |
| 86 | 93 SE-ROULETTE-BALL2 | 1 | jingle | 72 | 150 |  | unmapped |
| 87 | 94 SE-TAILLOW-WING-FLAP | 2 | loop | 48 | 220 |  | unmapped |
| 88 | 95 SE-SHOP | 2 | jingle | 24 | 128 |  | unmapped |
| 89 | 96 SE-CONTEST-HEART | 1 | jingle | 12 | 150 |  | unmapped |
| 90 | 97 SE-CONTEST-CURTAIN-RISE | 2 | jingle | 12 | 150 |  | unmapped |
| 91 | 98 SE-CONTEST-CURTAIN-FALL | 2 | jingle | 12 | 150 |  | unmapped |
| 92 | 99 SE-CONTEST-ICON-CHANGE | 1 | jingle | 6 | 150 |  | unmapped |
| 93 | 100 SE-CONTEST-ICON-CLEAR | 1 | jingle | 6 | 150 |  | unmapped |
| 94 | 101 SE-CONTEST-MONS-TURN | 1 | jingle | 24 | 150 |  | unmapped |
| 95 | 102 SE-SHINY | 1 | jingle | 48 | 220 |  | unmapped |
| 96 | 103 SE-INTRO-BLAST | 1 | jingle | 132 | 110 |  | unmapped |
| 97 | 104 SE-MUGSHOT | 2 | jingle | 108 | 110 |  | unmapped |
| 98 | 105 SE-APPLAUSE | 1 | jingle | 72 | 150 |  | unmapped |
| 99 | 106 SE-VEND | 1 | jingle | 12 | 150 |  | unmapped |
| 100 | 107 SE-ORB | 2 | jingle | 162 | 110 |  | unmapped |
| 101 | 108 SE-DEX-SCROLL | 1 | jingle | 3 | 100 |  | unmapped |
| 102 | 109 SE-DEX-PAGE | 1 | jingle | 9 | 100 |  | unmapped |
| 103 | 110 SE-POKENAV-ON | 2 | jingle | 18 | 144 |  | unmapped |
| 104 | 111 SE-POKENAV-OFF | 2 | jingle | 18 | 144 |  | unmapped |
| 105 | 112 SE-DEX-SEARCH | 2 | jingle | 72 | 144 |  | unmapped |
| 106 | 113 SE-EGG-HATCH | 2 | jingle | 24 | 150 |  | unmapped |
| 107 | 114 SE-BALL-TRAY-ENTER | 2 | jingle | 12 | 150 |  | unmapped |
| 108 | 115 SE-BALL-TRAY-BALL | 1 | jingle | 6 | 150 |  | unmapped |
| 109 | 116 SE-BALL-TRAY-EXIT | 1 | jingle | 3 | 150 |  | unmapped |
| 110 | 117 SE-GLASS-FLUTE | 1 | jingle | 18 | 120 |  | unmapped |
| 111 | 118 SE-M-THUNDERBOLT | 2 | jingle | 48 | 220 |  | unmapped |
| 112 | 119 SE-M-THUNDERBOLT2 | 2 | jingle | 48 | 220 |  | unmapped |
| 113 | 120 SE-M-HARDEN | 2 | jingle | 24 | 150 |  | unmapped |
| 114 | 121 SE-M-NIGHTMARE | 2 | jingle | 96 | 220 |  | unmapped |
| 115 | 122 SE-M-VITAL-THROW | 2 | jingle | 24 | 220 |  | unmapped |
| 116 | 123 SE-M-VITAL-THROW2 | 2 | jingle | 24 | 220 |  | unmapped |
| 117 | 124 SE-M-BUBBLE | 1 | jingle | 24 | 220 |  | unmapped |
| 118 | 125 SE-M-BUBBLE2 | 2 | jingle | 24 | 220 |  | unmapped |
| 119 | 126 SE-M-BUBBLE3 | 1 | jingle | 24 | 220 |  | unmapped |
| 120 | 127 SE-M-RAIN-DANCE | 1 | jingle | 168 | 220 |  | unmapped |
| 121 | 128 SE-M-CUT | 2 | jingle | 48 | 220 |  | unmapped |
| 122 | 129 SE-M-STRING-SHOT | 1 | jingle | 48 | 250 |  | unmapped |
| 123 | 130 SE-M-STRING-SHOT2 | 2 | jingle | 96 | 250 |  | unmapped |
| 124 | 131 SE-M-ROCK-THROW | 1 | jingle | 48 | 150 |  | unmapped |
| 125 | 132 SE-M-GUST | 1 | loop | 72 | 150 |  | unmapped |
| 126 | 133 SE-M-GUST2 | 1 | jingle | 48 | 150 |  | unmapped |
| 127 | 134 SE-M-DOUBLE-SLAP | 1 | jingle | 24 | 150 |  | unmapped |
| 128 | 135 SE-M-DOUBLE-TEAM | 1 | jingle | 24 | 150 |  | unmapped |
| 129 | 136 SE-M-RAZOR-WIND | 2 | jingle | 48 | 220 |  | unmapped |
| 130 | 137 SE-M-ICY-WIND | 2 | jingle | 12 | 150 |  | unmapped |
| 131 | 138 SE-M-THUNDER-WAVE | 2 | jingle | 48 | 150 |  | unmapped |
| 132 | 139 SE-M-COMET-PUNCH | 2 | jingle | 24 | 150 |  | unmapped |
| 133 | 140 SE-M-MEGA-KICK | 1 | jingle | 72 | 150 |  | unmapped |
| 134 | 141 SE-M-MEGA-KICK2 | 2 | jingle | 48 | 220 |  | unmapped |
| 135 | 142 SE-M-CRABHAMMER | 1 | jingle | 24 | 150 |  | unmapped |
| 136 | 143 SE-M-JUMP-KICK | 1 | jingle | 24 | 180 |  | unmapped |
| 137 | 144 SE-M-FLAME-WHEEL | 2 | jingle | 33 | 150 |  | unmapped |
| 138 | 145 SE-M-FLAME-WHEEL2 | 2 | jingle | 48 | 150 |  | unmapped |
| 139 | 146 SE-M-FLAMETHROWER | 2 | jingle | 192 | 150 |  | unmapped |
| 140 | 147 SE-M-FIRE-PUNCH | 2 | jingle | 72 | 220 |  | unmapped |
| 141 | 148 SE-M-TOXIC | 1 | jingle | 24 | 150 |  | unmapped |
| 142 | 149 SE-M-SACRED-FIRE | 2 | jingle | 24 | 150 |  | unmapped |
| 143 | 150 SE-M-SACRED-FIRE2 | 2 | jingle | 96 | 150 |  | unmapped |
| 144 | 151 SE-M-EMBER | 1 | jingle | 24 | 150 |  | unmapped |
| 145 | 152 SE-M-TAKE-DOWN | 1 | jingle | 48 | 150 |  | unmapped |
| 146 | 153 SE-M-BLIZZARD | 1 | loop | 72 | 150 |  | unmapped |
| 147 | 154 SE-M-BLIZZARD2 | 1 | jingle | 48 | 150 |  | unmapped |
| 148 | 155 SE-M-SCRATCH | 1 | jingle | 24 | 220 |  | unmapped |
| 149 | 156 SE-M-VICEGRIP | 2 | jingle | 24 | 220 |  | unmapped |
| 150 | 157 SE-M-WING-ATTACK | 2 | jingle | 24 | 220 |  | unmapped |
| 151 | 158 SE-M-FLY | 2 | jingle | 48 | 220 |  | unmapped |
| 152 | 159 SE-M-SAND-ATTACK | 2 | jingle | 24 | 150 |  | unmapped |
| 153 | 160 SE-M-RAZOR-WIND2 | 1 | jingle | 24 | 250 |  | unmapped |
| 154 | 161 SE-M-BITE | 2 | jingle | 24 | 220 |  | unmapped |
| 155 | 162 SE-M-HEADBUTT | 1 | jingle | 24 | 150 |  | unmapped |
| 156 | 163 SE-M-SURF | 1 | jingle | 96 | 150 |  | unmapped |
| 157 | 164 SE-M-HYDRO-PUMP | 2 | jingle | 120 | 150 |  | unmapped |
| 158 | 165 SE-M-WHIRLPOOL | 1 | jingle | 120 | 150 |  | unmapped |
| 159 | 166 SE-M-HORN-ATTACK | 1 | jingle | 24 | 150 |  | unmapped |
| 160 | 167 SE-M-TAIL-WHIP | 1 | jingle | 24 | 150 |  | unmapped |
| 161 | 168 SE-M-MIST | 1 | jingle | 24 | 150 |  | unmapped |
| 162 | 169 SE-M-POISON-POWDER | 1 | jingle | 24 | 150 |  | unmapped |
| 163 | 170 SE-M-BIND | 1 | jingle | 24 | 150 |  | unmapped |
| 164 | 171 SE-M-DRAGON-RAGE | 1 | jingle | 96 | 150 |  | unmapped |
| 165 | 172 SE-M-SING | 2 | jingle | 162 | 100 |  | unmapped |
| 166 | 173 SE-M-PERISH-SONG | 2 | jingle | 120 | 100 |  | unmapped |
| 167 | 174 SE-M-PAY-DAY | 1 | jingle | 36 | 150 |  | unmapped |
| 168 | 175 SE-M-DIG | 1 | jingle | 15 | 150 |  | unmapped |
| 169 | 176 SE-M-DIZZY-PUNCH | 1 | jingle | 24 | 150 |  | unmapped |
| 170 | 177 SE-M-SELF-DESTRUCT | 1 | jingle | 48 | 150 |  | unmapped |
| 171 | 178 SE-M-EXPLOSION | 2 | jingle | 72 | 150 |  | unmapped |
| 172 | 179 SE-M-ABSORB-2 / 261 SE-RG-POKE-JUMP-SUCCESS | 2 | jingle | 51 | 150 |  | unmapped |
| 173 | 180 SE-M-ABSORB | 1 | jingle | 12 | 150 |  | unmapped |
| 174 | 181 SE-M-SCREECH | 2 | jingle | 24 | 150 |  | unmapped |
| 175 | 182 SE-M-BUBBLE-BEAM | 1 | jingle | 66 | 150 |  | unmapped |
| 176 | 183 SE-M-BUBBLE-BEAM2 | 1 | jingle | 36 | 150 |  | unmapped |
| 177 | 184 SE-M-SUPERSONIC | 1 | jingle | 42 | 150 |  | unmapped |
| 178 | 185 SE-M-BELLY-DRUM | 1 | jingle | 24 | 150 |  | unmapped |
| 179 | 186 SE-M-METRONOME | 1 | jingle | 24 | 150 |  | unmapped |
| 180 | 187 SE-M-BONEMERANG | 1 | jingle | 12 | 150 |  | unmapped |
| 181 | 188 SE-M-LICK | 1 | jingle | 36 | 150 |  | unmapped |
| 182 | 189 SE-M-PSYBEAM | 2 | jingle | 42 | 190 |  | unmapped |
| 183 | 190 SE-M-FAINT-ATTACK | 1 | jingle | 30 | 150 |  | unmapped |
| 184 | 191 SE-M-SWORDS-DANCE | 2 | jingle | 60 | 150 |  | unmapped |
| 185 | 192 SE-M-LEER | 2 | jingle | 60 | 150 |  | unmapped |
| 186 | 193 SE-M-SWAGGER | 1 | jingle | 18 | 190 |  | unmapped |
| 187 | 194 SE-M-SWAGGER2 | 1 | jingle | 12 | 150 |  | unmapped |
| 188 | 195 SE-M-HEAL-BELL | 1 | jingle | 24 | 150 |  | unmapped |
| 189 | 196 SE-M-CONFUSE-RAY | 1 | jingle | 48 | 220 |  | unmapped |
| 190 | 197 SE-M-SNORE | 2 | jingle | 30 | 220 |  | unmapped |
| 191 | 198 SE-M-BRICK-BREAK | 2 | jingle | 36 | 150 |  | unmapped |
| 192 | 199 SE-M-GIGA-DRAIN | 1 | jingle | 24 | 150 |  | unmapped |
| 193 | 200 SE-M-PSYBEAM2 | 1 | jingle | 60 | 190 |  | unmapped |
| 194 | 201 SE-M-SOLAR-BEAM | 1 | jingle | 192 | 150 |  | unmapped |
| 195 | 202 SE-M-PETAL-DANCE | 2 | jingle | 135 | 150 |  | unmapped |
| 196 | 203 SE-M-TELEPORT | 1 | jingle | 54 | 150 |  | unmapped |
| 197 | 204 SE-M-MINIMIZE | 1 | jingle | 54 | 150 |  | unmapped |
| 198 | 205 SE-M-SKETCH | 1 | jingle | 12 | 180 |  | unmapped |
| 199 | 206 SE-M-SWIFT | 2 | jingle | 18 | 180 |  | unmapped |
| 200 | 207 SE-M-REFLECT | 2 | jingle | 54 | 150 |  | unmapped |
| 201 | 208 SE-M-BARRIER | 2 | jingle | 54 | 150 |  | unmapped |
| 202 | 209 SE-M-DETECT | 1 | jingle | 42 | 220 |  | unmapped |
| 203 | 210 SE-M-LOCK-ON | 1 | jingle | 18 | 150 |  | unmapped |
| 204 | 211 SE-M-MOONLIGHT | 2 | jingle | 216 | 150 |  | unmapped |
| 205 | 212 SE-M-CHARM | 1 | jingle | 18 | 150 |  | unmapped |
| 206 | 213 SE-M-CHARGE | 1 | jingle | 72 | 150 |  | unmapped |
| 207 | 214 SE-M-STRENGTH | 2 | jingle | 24 | 150 |  | unmapped |
| 208 | 215 SE-M-HYPER-BEAM | 2 | jingle | 24 | 150 |  | unmapped |
| 209 | 216 SE-M-WATERFALL | 2 | jingle | 60 | 150 |  | unmapped |
| 210 | 217 SE-M-REVERSAL | 2 | jingle | 66 | 150 |  | unmapped |
| 211 | 218 SE-M-ACID-ARMOR | 1 | jingle | 72 | 150 |  | unmapped |
| 212 | 219 SE-M-SANDSTORM | 2 | jingle | 192 | 200 |  | unmapped |
| 213 | 220 SE-M-TRI-ATTACK | 2 | jingle | 24 | 220 |  | unmapped |
| 214 | 221 SE-M-TRI-ATTACK2 | 2 | jingle | 96 | 220 |  | unmapped |
| 215 | 222 SE-M-ENCORE | 1 | jingle | 12 | 150 |  | unmapped |
| 216 | 223 SE-M-ENCORE2 | 1 | jingle | 72 | 150 |  | unmapped |
| 217 | 224 SE-M-BATON-PASS | 2 | jingle | 45 |  |  | unmapped |
| 218 | 225 SE-M-MILK-DRINK | 2 | jingle | 30 | 180 |  | unmapped |
| 219 | 226 SE-M-ATTRACT | 2 | jingle | 69 | 210 |  | unmapped |
| 220 | 227 SE-M-ATTRACT2 | 2 | jingle | 216 | 150 |  | unmapped |
| 221 | 228 SE-M-MORNING-SUN | 2 | jingle | 75 | 150 |  | unmapped |
| 222 | 229 SE-M-FLATTER | 1 | jingle | 12 | 150 |  | unmapped |
| 223 | 230 SE-M-SAND-TOMB | 2 | jingle | 96 | 150 |  | unmapped |
| 224 | 231 SE-M-GRASSWHISTLE | 2 | jingle | 132 | 100 |  | unmapped |
| 225 | 232 SE-M-SPIT-UP | 2 | jingle | 15 | 150 |  | unmapped |
| 226 | 233 SE-M-DIVE | 2 | jingle | 48 | 150 |  | unmapped |
| 227 | 234 SE-M-EARTHQUAKE | 2 | jingle | 162 | 150 |  | unmapped |
| 228 | 235 SE-M-TWISTER | 2 | jingle | 168 | 150 |  | unmapped |
| 229 | 236 SE-M-SWEET-SCENT | 2 | jingle | 168 | 150 |  | unmapped |
| 230 | 237 SE-M-YAWN | 2 | jingle | 48 | 150 |  | unmapped |
| 231 | 238 SE-M-SKY-UPPERCUT | 2 | jingle | 36 | 220 |  | unmapped |
| 232 | 239 SE-M-STAT-INCREASE | 2 | jingle | 78 | 170 |  | unmapped |
| 233 | 240 SE-M-HEAT-WAVE | 2 | jingle | 132 | 150 |  | unmapped |
| 234 | 241 SE-M-UPROAR | 1 | jingle | 24 | 150 |  | unmapped |
| 235 | 242 SE-M-HAIL | 2 | jingle | 30 | 150 |  | unmapped |
| 236 | 243 SE-M-COSMIC-POWER | 2 | jingle | 198 | 150 |  | unmapped |
| 237 | 244 SE-M-TEETER-DANCE | 2 | jingle | 60 | 170 |  | unmapped |
| 238 | 245 SE-M-STAT-DECREASE | 2 | jingle | 78 | 170 |  | unmapped |
| 239 | 246 SE-M-HAZE | 2 | jingle | 210 | 190 |  | unmapped |
| 240 | 247 SE-M-HYPER-BEAM2 | 2 | jingle | 24 | 150 |  | unmapped |
| 241 | 248 SE-RG-DOOR | 2 | jingle | 24 | 110 |  | unmapped |
| 242 | 249 SE-RG-CARD-FLIP | 1 | jingle | 48 | 182 |  | unmapped |
| 243 |  | 1 | jingle | 120 | 182 |  | no twin |
| 244 | 251 SE-RG-CARD-OPEN | 2 | jingle | 120 | 174 |  | unmapped |
| 245 | 252 SE-RG-BAG-CURSOR | 2 | jingle | 9 | 310 |  | unmapped |
| 246 | 253 SE-RG-BAG-POCKET | 2 | jingle | 6 | 422 |  | unmapped |
| 247 | 254 SE-RG-BALL-CLICK | 2 | jingle | 21 | 310 |  | unmapped |
| 248 | 255 SE-RG-SHOP | 1 | jingle | 30 | 124 |  | unmapped |
| 249 | 256 SE-RG-SS-ANNE-HORN | 2 | jingle | 240 | 164 |  | unmapped |
| 250 | 257 SE-RG-HELP-OPEN | 1 | jingle | 96 | 420 |  | unmapped |
| 251 | 258 SE-RG-HELP-CLOSE | 1 | jingle | 96 | 420 |  | unmapped |
| 252 | 259 SE-RG-HELP-ERROR | 1 | jingle | 48 | 420 |  | unmapped |
| 253 | 260 SE-RG-DEOXYS-MOVE | 3 | jingle | 192 | 262 |  | unmapped |
| 254 | 179 SE-M-ABSORB-2 / 261 SE-RG-POKE-JUMP-SUCCESS | 2 | jingle | 51 | 150 |  | unmapped |
| 255 | 32 SE-FAILURE | 1 | jingle | 33 | 240 |  | unmapped |
| 256 | 368 MUS-HEAL | 4 | jingle | 120 | 132 | heal |  |
| 257 |  | 5 | jingle | 72 | 174 | levelup, se_levelup | FRLG level-up fanfare (differs from the Emerald one: no twin) |
| 258 |  | 6 | jingle | 180 | 190 | item | FRLG obtain-item fanfare (no twin) |
| 259 |  | 7 | jingle | 228 | 150 | evolved | FRLG evolved fanfare (no twin) |
| 260 | 369 MUS-OBTAIN-BADGE | 7 | jingle | 300 | 144 | victory_sting, badge |  |
| 261 | 372 MUS-OBTAIN-TMHM | 7 | jingle | 180 | 140 | tm |  |
| 262 | 387 MUS-OBTAIN-BERRY | 5 | jingle | 108 | 140 | berry |  |
| 263 | 376 MUS-EVOLUTION-INTRO | 4 | jingle | 48 | 120 |  | PlayBGM @0x0804730A |
| 264 | 377 MUS-EVOLUTION | 7 | loop | 864 | 120 | evolution | PlayBGM @0x0804731A,@0x080CF6B0,@0x080CF9B0 |
| 265 | 477 MUS-VS-GYM-LEADER | 8 | loop | 5952 | 196 |  | link battle theme (RS gym leader) via PlayMapChosenOrBattleBGM @0x080813C6 |
| 266 | 476 MUS-VS-TRAINER | 8 | loop | 7104 | 198 |  | link battle theme (RS trainer): GetBattleBGM returns it when flags&2 or 0x4000 @0x08043FF6 |
| 267 | 435 MUS-SCHOOL | 4 | loop | 1728 | 116 |  | unmapped |
| 268 |  | 7 | jingle | 252 | 144 |  | FRLG slots jackpot (no twin) |
| 269 |  | 7 | jingle | 144 | 144 |  | FRLG slots win (no twin) |
| 270 | 378 MUS-MOVE-DELETED | 6 | jingle | 156 | 150 | move_deleted |  |
| 271 | 391 MUS-TOO-BAD | 5 | jingle | 168 | 180 | defeat |  |
| 272 | 484 MUS-RG-FOLLOW-ME / 544 MUS-RG-TEACHY-TV-SHOW | 8 | loop | 960 | 146 |  | unmapped |
| 273 | 485 MUS-RG-GAME-CORNER | 8 | loop | 2520 | 146 |  | PlayBGM @0x0804CE0C |
| 274 | 486 MUS-RG-ROCKET-HIDEOUT | 10 | loop | 3840 | 130 |  | unmapped |
| 275 | 487 MUS-RG-GYM / 556 MUS-RG-TRAINER-TOWER | 7 | loop | 1728 | 128 |  | unmapped |
| 276 | 488 MUS-RG-JIGGLYPUFF | 4 | jingle | 384 | 146 |  | unmapped |
| 277 | 489 MUS-RG-INTRO-FIGHT | 8 | jingle | 912 | 188 |  | unmapped |
| 278 | 490 MUS-RG-TITLE | 10 | loop | 2520 | 140 | title |  |
| 279 | 491 MUS-RG-CINNABAR | 9 | loop | 1728 | 120 |  | unmapped |
| 280 | 492 MUS-RG-LAVENDER | 8 | loop | 4224 | 128 | result_lose |  |
| 281 | 493 MUS-RG-HEAL | 2 | jingle | 120 | 146 |  | unmapped |
| 282 | 494 MUS-RG-CYCLING | 8 | loop | 1836 | 134 |  | unmapped |
| 283 | 495 MUS-RG-ENCOUNTER-ROCKET | 7 | loop | 504 | 146 |  | unmapped |
| 284 | 496 MUS-RG-ENCOUNTER-GIRL | 9 | loop | 468 | 174 |  | unmapped |
| 285 | 497 MUS-RG-ENCOUNTER-BOY | 8 | loop | 576 | 154 |  | unmapped |
| 286 | 498 MUS-RG-HALL-OF-FAME | 9 | loop | 1728 | 152 | result_win, hof |  |
| 287 | 499 MUS-RG-VIRIDIAN-FOREST / 546 MUS-RG-SEVII-DUNGEON | 10 | loop | 5388 | 128 |  | unmapped |
| 288 | 500 MUS-RG-MT-MOON | 7 | loop | 3900 | 110 |  | unmapped |
| 289 | 501 MUS-RG-POKE-MANSION | 10 | loop | 3456 | 132 |  | unmapped |
| 290 | 502 MUS-RG-CREDITS | 9 | jingle | 11376 | 94 | credits |  |
| 291 | 503 MUS-RG-ROUTE1 | 8 | loop | 1164 | 116 |  | unmapped |
| 292 | 504 MUS-RG-ROUTE24 | 6 | loop | 984 | 118 |  | unmapped |
| 293 | 505 MUS-RG-ROUTE3 | 9 | loop | 1788 | 124 |  | unmapped |
| 294 | 506 MUS-RG-ROUTE11 | 10 | loop | 1728 | 124 |  | unmapped |
| 295 | 507 MUS-RG-VICTORY-ROAD | 8 | loop | 1752 | 136 |  | unmapped |
| 296 | 508 MUS-RG-VS-GYM-LEADER | 10 | loop | 4224 | 186 | battle_hard |  |
| 297 | 509 MUS-RG-VS-TRAINER | 10 | loop | 7008 | 172 | battle_normal |  |
| 298 | 510 MUS-RG-VS-WILD | 8 | loop | 3168 | 182 | battle_easy |  |
| 299 | 511 MUS-RG-VS-CHAMPION | 10 | loop | 5088 | 172 | battle_final |  |
| 300 | 512 MUS-RG-PALLET | 6 | loop | 1536 | 88 | town |  |
| 301 | 513 MUS-RG-OAK-LAB | 6 | loop | 816 | 120 | editor, lab |  |
| 302 | 514 MUS-RG-OAK | 9 | loop | 1632 | 160 |  | unmapped |
| 303 | 515 MUS-RG-POKE-CENTER | 10 | loop | 1536 | 116 | hub, pokecenter |  |
| 304 | 516 MUS-RG-SS-ANNE | 10 | loop | 3264 | 114 |  | unmapped |
| 305 | 517 MUS-RG-SURF | 7 | loop | 1296 | 100 |  | unmapped |
| 306 | 518 MUS-RG-POKE-TOWER | 6 | loop | 3168 | 134 |  | unmapped |
| 307 | 519 MUS-RG-SILPH | 9 | loop | 3336 | 114 |  | unmapped |
| 308 | 520 MUS-RG-FUCHSIA | 9 | loop | 1632 | 120 |  | unmapped |
| 309 | 521 MUS-RG-CELADON | 7 | loop | 1728 | 110 |  | unmapped |
| 310 | 522 MUS-RG-VICTORY-TRAINER | 9 | loop | 880 | 136 | victory |  |
| 311 | 523 MUS-RG-VICTORY-WILD | 7 | loop | 873 | 140 |  | unmapped |
| 312 | 524 MUS-RG-VICTORY-GYM-LEADER | 8 | loop | 2649 | 138 | victory_gym, victory_league |  |
| 313 | 525 MUS-RG-VERMILLION | 9 | loop | 1728 | 116 |  | unmapped |
| 314 | 526 MUS-RG-PEWTER / 547 MUS-RG-SEVII-123 | 9 | loop | 3096 | 126 |  | unmapped |
| 315 | 527 MUS-RG-ENCOUNTER-RIVAL | 9 | loop | 1344 | 168 | preview |  |
| 316 | 528 MUS-RG-RIVAL-EXIT | 9 | loop | 1248 | 168 |  | unmapped |
| 317 | 529 MUS-RG-DEX-RATING | 7 | jingle | 96 | 64 |  | unmapped |
| 318 | 530 MUS-RG-OBTAIN-KEY-ITEM | 6 | jingle | 72 | 44 | key_item |  |
| 319 | 531 MUS-RG-CAUGHT-INTRO | 8 | jingle | 180 | 64 |  | unmapped |
| 320 | 532 MUS-RG-PHOTO | 5 | jingle | 96 | 192 |  | unmapped |
| 321 | 533 MUS-RG-GAME-FREAK | 5 | jingle | 522 | 150 |  | unmapped |
| 322 | 534 MUS-RG-CAUGHT | 7 | loop | 780 | 140 |  | unmapped |
| 323 | 535 MUS-RG-NEW-GAME-INSTRUCT | 1 | loop | 204 | 120 |  | unmapped |
| 324 | 536 MUS-RG-NEW-GAME-INTRO | 6 | loop | 576 | 120 |  | unmapped |
| 325 | 537 MUS-RG-NEW-GAME-EXIT | 7 | jingle | 96 | 120 |  | unmapped |
| 326 | 538 MUS-RG-POKE-JUMP | 8 | loop | 2520 | 138 |  | unmapped |
| 327 | 539 MUS-RG-UNION-ROOM | 8 | loop | 2520 | 134 |  | unmapped |
| 328 | 540 MUS-RG-NET-CENTER | 10 | loop | 1536 | 114 |  | unmapped |
| 329 | 541 MUS-RG-MYSTERY-GIFT | 7 | loop | 864 | 124 |  | unmapped |
| 330 | 542 MUS-RG-BERRY-PICK | 8 | loop | 2520 | 148 |  | unmapped |
| 331 | 543 MUS-RG-SEVII-CAVE | 7 | loop | 3900 | 110 |  | unmapped |
| 332 | 484 MUS-RG-FOLLOW-ME / 544 MUS-RG-TEACHY-TV-SHOW | 8 | loop | 960 | 146 |  | unmapped |
| 333 | 545 MUS-RG-SEVII-ROUTE | 10 | loop | 1848 | 124 |  | unmapped |
| 334 | 499 MUS-RG-VIRIDIAN-FOREST / 546 MUS-RG-SEVII-DUNGEON | 10 | loop | 5388 | 128 |  | unmapped |
| 335 | 526 MUS-RG-PEWTER / 547 MUS-RG-SEVII-123 | 9 | loop | 3096 | 126 |  | unmapped |
| 336 | 548 MUS-RG-SEVII-45 | 9 | loop | 2508 | 120 |  | unmapped |
| 337 | 549 MUS-RG-SEVII-67 | 9 | loop | 2016 | 116 |  | unmapped |
| 338 | 550 MUS-RG-POKE-FLUTE | 2 | jingle | 1632 | 80 |  | unmapped |
| 339 | 551 MUS-RG-VS-DEOXYS | 10 | loop | 5184 | 128 |  | unmapped |
| 340 | 552 MUS-RG-VS-MEWTWO | 8 | loop | 3168 | 182 |  | unmapped |
| 341 | 553 MUS-RG-VS-LEGEND | 8 | loop | 3168 | 182 | battle_legendary |  |
| 342 | 554 MUS-RG-ENCOUNTER-GYM-LEADER | 7 | loop | 576 | 164 |  | unmapped |
| 343 | 555 MUS-RG-ENCOUNTER-DEOXYS | 7 | loop | 768 | 128 |  | unmapped |
| 344 | 487 MUS-RG-GYM / 556 MUS-RG-TRAINER-TOWER | 7 | loop | 1728 | 128 |  | unmapped |
| 345 | 557 MUS-RG-SLOW-PALLET | 6 | loop | 1536 | 72 |  | unmapped |
| 346 | 558 MUS-RG-TEACHY-TV-MENU | 4 | loop | 216 | 144 |  | unmapped |

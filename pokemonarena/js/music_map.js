// pokemonarena/js/music_map.js - which ROM song plays where (stage MU2).
//
// ES module, no side effects, importable in Node and in the browser. It holds ONLY song-table indexes, labels,
// loop/jingle flags, hashes and file offsets - never ROM bytes or audio.
//
// A "song" is an index into the m4a/MP2K song table of the ROM (entries of {song header ptr, music-player ms, me}).
// SoulGold's table has 990 entries, Ultra Violet's has 347.  Both ROMs are decomp-style builds of the stock
// pokeemerald / pokefirered sound code (sound.c: PlayBGM, PlaySE, PlayFanfare, PlayNewMapMusic).
//
// HOW THE INDEXES WERE ESTABLISHED (details and every address: pokemonarena/MUSIC_MAP.md)
//  1. code:  a throwaway THUMB decoder located m4aSongNumStart through its literal pool (the song-table address),
//            then PlayBGM/PlaySE/PlayFanfare/PlayNewMapMusic, then the battle-music selector, the victory handler and
//            the sFanfares tables, and resolved the song constants passed at the call sites.
//  2. names: SoulGold carries its own song-name table (pointer arrays at file 0x004CC990 / 0x004CCDC4); its indexing
//            was verified against the sFanfares table (18/18 fanfare songs carry the expected MUS-* names).
//  3. twins: 339 of Ultra Violet's 346 songs have a byte-identical (pointer-normalised) track-command stream in
//            SoulGold, which names them without trusting any numbering assumption.
//  4. structure: loops/jingle come from the song headers (a track that ends in GOTO loops; all tracks ending in
//            FINE = jingle).  This file's flags are re-derived from the ROM by tools/pokemonarena_music_map_test.mjs.
//
// confidence: 'high' = index is what the ROM's own code plays for that situation (or identity proven by name table +
// byte twin AND role proven by code); 'medium' = identity certain, role from prior knowledge or a design choice with a
// code-backed anchor; 'low' = UNVERIFIED-GUESS (a mood recommendation; identity is still certain).

export const SOUNDTRACKS = ['soulgold', 'ultraviolet'];

export const MUSIC_KEYS = ["battle_easy","battle_normal","battle_hard","battle_final","battle_rival","battle_villain","battle_frontier","battle_legendary","victory","victory_gym","victory_league","victory_sting","defeat","result_win","result_lose","hub","editor","preview","title","pokecenter","lab","town","evolution","hof","credits","heal","levelup","item","evolved","tm","badge","key_item","berry","move_deleted"];

export const SFX_KEYS = ["se_cursor","se_select","se_back","se_error","se_success","se_hit_normal","se_hit_super","se_hit_weak","se_faint","se_ball_throw","se_ball_open","se_ball_bounce","se_exp","se_exp_max","se_lowhp","se_flee","se_use_item","se_switch","se_menu_open","se_save","se_levelup"];

export const ALL_KEYS = [...MUSIC_KEYS, ...SFX_KEYS];

// Hashes and offsets only.
export const ROM_PROFILES = {
  soulgold: {
    file: 'Pokemon SoulGold (v1.1.1).gba',
    size: 33554432,
    sha256: '8071e2c348d54c3ec7b78b53837c5cbd757d5cfc461a50fa5ffbc9f5ab35060a',
    headerTitle: 'POKEMON EMER',
    gameCode: 'BPEE',
    base: 'Pokemon Emerald hack (pokeemerald-style sound.c; Hoenn + Kanto (RG) + added Johto songs)',
    songTableOffset: 0x15E8ED8,
    songTableAddress: 0x095E8ED8,
    songCount: 990,
    mplayTableOffset: 0x15E8EA8,
    // song-name tables the ROM itself carries (u32 pointers to Gen3-charset strings)
    seNamePointerTable: { offset: 0x4CC990, count: 269, firstSong: 1 },
    musNamePointerTable: { offset: 0x4CCDC4, count: 210, firstSong: 349 },
    fanfareTable: { offset: 0xF3C594, count: 18, stride: 8, layout: 'u16 stockSong, u16 playedSong, u16 durationFrames, u16 0' },
    codeAnchors: { m4aSongNumStart: 0x081A0994, PlayBGM: 0x08244544, PlaySE: 0x0824456C, PlayNewMapMusic: 0x08243B80, PlayFanfare: 0x08243EB8, GetBattleBGM: 0x081EFBEC, PlayMapChosenOrBattleBGM: 0x081EFE9C, victoryHandler: 0x0808B810 },
    trainerClassNameTable: { offset: 0x43B03C, stride: 16 },
    // table 0 (0x0848934C) is all zero in the ROM; the 1164-entry table the game reads is the second one (stride 52)
    trainerTable: { offset: 0x497FBC, stride: 52, count: 1164, classByteOffset: 28, nameOffset: 31 },
  },
  ultraviolet: {
    file: 'pokemonUltraViolet.gba',
    size: 16777216,
    sha256: '467fe116ff6d7d5723b9f8fc60dd81c698c5d4e27b1b444168f3be292848d015',
    headerTitle: 'ULTRA VIOLET',
    gameCode: 'PUVV',
    base: 'FireRed-engine hack (its sFanfares table and song numbering are pokefirered\'s: 14 fanfares, songs 256-346 = the FRLG block; trainer-class text also carries the Emerald list)',
    songTableOffset: 0x4A32CC,
    songTableAddress: 0x084A32CC,
    songCount: 347,
    mplayTableOffset: 0x4A329C,
    seNamePointerTable: null,
    musNamePointerTable: null,
    fanfareTable: { offset: 0x3AC990, count: 14, stride: 4, layout: 'u16 song, u16 durationFrames' },
    codeAnchors: { m4aSongNumStart: 0x081DD0F4, PlayBGM: 0x080722A0, PlaySE: 0x080722CC, PlayNewMapMusic: 0x08071A74, PlayFanfare: 0x08071C60, GetBattleBGM: 0x08043FD4, PlayMapChosenOrBattleBGM: 0x08044090, victoryHandler: 0x08015690 },
    trainerTable: { offset: 0x241408, stride: 40, count: 190, classByteOffset: 1, nameOffset: 4 },
  },
};

// key -> { group, doc, soulgold, ultraviolet }; an entry is { index, loops, jingle, label, confidence, evidence }
// or { none: reason } when that soundtrack has no counterpart.
export const MAP = {
  battle_easy: {
    group: "bgm",
    doc: "CPU level easy: wild-battle style theme",
    soulgold: { index: 887, loops: true, jingle: false, label: "SoulGold hack wild-battle theme (replaces stock MUS_VS_WILD 474)", confidence: "high", evidence: "GetBattleBGM @0x081EFBEC (called through PlayMapChosenOrBattleBGM @0x081EFE9C): non-trainer branch returns 0x377=887 (ldr r0,=0x377 @0x081EFD44, reached from the trainer-bit test at 0x081EFC26)" },
    ultraviolet: { index: 298, loops: true, jingle: false, label: "FRLG VS-WILD (byte-identical to SoulGold song 510 MUS-RG-VS-WILD)", confidence: "high", evidence: "GetBattleBGM @0x08043FD4 (called through PlayMapChosenOrBattleBGM @0x08044090): non-trainer branch returns 0x12A=298 (movs r0,#149; lsls r0,#1 @0x0804406C); song 298 has a byte-identical stream twin = SoulGold 510 \"MUS-RG-VS-WILD\"" },
  },
  battle_normal: {
    group: "bgm",
    doc: "CPU level normal: ordinary trainer theme",
    soulgold: { index: 888, loops: true, jingle: false, label: "SoulGold hack trainer-battle theme (replaces stock MUS_VS_TRAINER 476)", confidence: "high", evidence: "GetBattleBGM @0x081EFBEC (called through PlayMapChosenOrBattleBGM @0x081EFE9C): default of the trainer-class jump table @0x087C6E3C (idx=class-3) is 888 (movs r0,#222; lsls r0,#2 @0x081EFD0A); also used for link battles" },
    ultraviolet: { index: 297, loops: true, jingle: false, label: "FRLG VS-TRAINER (twin of SoulGold 509 MUS-RG-VS-TRAINER)", confidence: "high", evidence: "GetBattleBGM @0x08043FD4 (called through PlayMapChosenOrBattleBGM @0x08044090): default trainer branch returns 0x129=297 (@0x08044062); every class except 84/87/90 lands there; twin = SoulGold 509" },
  },
  battle_hard: {
    group: "bgm",
    doc: "CPU level hard: gym leader / elite four theme",
    soulgold: { index: 889, loops: true, jingle: false, label: "SoulGold hack gym-leader + elite-four theme (stock 477/482 are not used by the selector)", confidence: "high", evidence: "GetBattleBGM @0x081EFBEC (called through PlayMapChosenOrBattleBGM @0x081EFE9C): trainer classes 31 (\"Elite Four\") and 32 (\"Leader\") -> 0x379=889 (@0x081EFD74); class names from the table @0x0843B03C (stride 16); trainers table @0x08497FBC (stride 52, class byte +28, name +31): class 31 = Koga/Will/Bruno/Karen, class 32 = Falkner/Blaine/Jasmine/Pryce/Blue/Lt. Surge/Erika/Sabrina" },
    ultraviolet: { index: 296, loops: true, jingle: false, label: "FRLG VS-GYM-LEADER (twin of SoulGold 508 MUS-RG-VS-GYM-LEADER)", confidence: "high", evidence: "GetBattleBGM @0x08043FD4 (called through PlayMapChosenOrBattleBGM @0x08044090): classes 84 and 87 -> 0x128=296 (@0x0804405C); gTrainers @0x08241408 (stride 40): class 84 = BROCK/MISTY/LT. SURGE/ERIKA/KOGA/BLAINE/SABRINA/GIOVANNI, class 87 = LORELEI/BRUNO/AGATHA/LANCE; twin = SoulGold 508" },
  },
  battle_final: {
    group: "bgm",
    doc: "last / final-boss feel: champion theme",
    soulgold: { index: 895, loops: true, jingle: false, label: "SoulGold hack champion theme", confidence: "high", evidence: "GetBattleBGM @0x081EFBEC (called through PlayMapChosenOrBattleBGM @0x081EFE9C): class 38 (\"Champion\": trainers Lance, Steven in the trainers table) -> 0x37F=895 (@0x081EFD86). The ROM has no low-HP / last-Pokemon music variant, so \"final\" = the champion theme (design choice)" },
    ultraviolet: { index: 299, loops: true, jingle: false, label: "FRLG VS-CHAMPION (twin of SoulGold 511 MUS-RG-VS-CHAMPION)", confidence: "high", evidence: "GetBattleBGM @0x08043FD4 (called through PlayMapChosenOrBattleBGM @0x08044090): class 90 (TERRY x3, the champion-stage rival) -> 0x12B=299 (@0x08044054); twin = SoulGold 511" },
  },
  battle_rival: {
    group: "bgm",
    doc: "rival-style special trainer",
    soulgold: { index: 890, loops: true, jingle: false, label: "SoulGold hack rival theme (class 50, trainers named with the rival-name placeholder FD 06)", confidence: "high", evidence: "GetBattleBGM @0x081EFBEC (called through PlayMapChosenOrBattleBGM @0x081EFE9C): class 50 -> 0x37A=890 (@0x081EFD82). Class 50 trainers (ids 226,228,229,252,253,326,351,503 ...) have the name placeholder FD 06 (RIVAL) in the trainers table @0x08497FBC; the class-name text only says \"PKMN Trainer\"" },
    ultraviolet: { none: "FRLG has no separate rival battle theme: UV class 89 (rival) falls to the default trainer theme 297 (@0x08044062)" },
  },
  battle_villain: {
    group: "bgm",
    doc: "villain-team trainers (Team Rocket / Aqua / Magma)",
    soulgold: { index: 891, loops: true, jingle: false, label: "SoulGold hack Team Rocket theme (classes 68 \"Team Rocket\", 80 \"Rocket Admin\")", confidence: "high", evidence: "GetBattleBGM @0x081EFBEC (called through PlayMapChosenOrBattleBGM @0x081EFE9C): classes 68 (trainers named Grunt) and 80 (Giovanni, Ariana, Archer, Petrel, Proton) -> 0x37B=891 (@0x081EFD78). Stock Aqua/Magma classes (3,9,11,49) return 475 MUS-VS-AQUA-MAGMA, (13,53) return 483 MUS-VS-AQUA-MAGMA-LEADER" },
    ultraviolet: { none: "UV routes Team Rocket (class 85, GRUNT) to the generic trainer theme 297; there is no villain-specific battle song in its selector" },
  },
  battle_frontier: {
    group: "bgm",
    doc: "frontier-brain style boss",
    soulgold: { index: 917, loops: true, jingle: false, label: "SoulGold hack frontier-brain theme (classes 58-64: Salon Maiden .. Pyramid King)", confidence: "high", evidence: "GetBattleBGM @0x081EFBEC (called through PlayMapChosenOrBattleBGM @0x081EFE9C): classes 58..64 -> 0x395=917 (@0x081EFD64)" },
    ultraviolet: { none: "UV has no battle-frontier classes" },
  },
  battle_legendary: {
    group: "bgm",
    doc: "legendary Pokemon encounter",
    soulgold: { index: 553, loops: true, jingle: false, label: "MUS-RG-VS-LEGEND (stock Emerald RG block)", confidence: "high", evidence: "GetBattleBGM @0x081EFBEC (called through PlayMapChosenOrBattleBGM @0x081EFE9C): legendary-flag (bit 0x2000) branch picks by species (384->470 VS-RAYQUAZA, 382/383->480 VS-KYOGRE-GROUDON, others 479 VS-REGI or the generic fallback 0x229=553 @0x081EFD60); the 0x400 branch returns 1137-species = 894/893/892 for species 243/244/245" },
    ultraviolet: { index: 341, loops: true, jingle: false, label: "FRLG VS-LEGEND (twin of SoulGold 553)", confidence: "medium", evidence: "identity: byte-identical stream twin = SoulGold 553 \"MUS-RG-VS-LEGEND\". ROLE: UV's GetBattleBGM has no legendary branch (flag 0x1000 returns the wild theme 298 @0x0804406C), so FRLG's own scripts start it; not traced -> role from prior knowledge" },
  },
  victory: {
    group: "bgm",
    doc: "trainer-battle victory music (loops in the ROM; it is a BGM, not a fanfare)",
    soulgold: { index: 899, loops: true, jingle: false, label: "SoulGold hack trainer-victory music", confidence: "high", evidence: "victory handler @0x0808B810 calls PlayBGM @0x08244544: default branch PlayBGM(0x383=899) @0x0808B900 for every class not in the class jump table @0x0843ABB8 (idx=class-31)" },
    ultraviolet: { index: 310, loops: true, jingle: false, label: "FRLG VICTORY-TRAINER (twin of SoulGold 522 MUS-RG-VICTORY-TRAINER)", confidence: "high", evidence: "victory handler @0x08015690 calls PlayBGM @0x080722A0: default branch PlayBGM(0x136=310) @0x08015762; twin = SoulGold 522" },
  },
  victory_gym: {
    group: "bgm",
    doc: "gym leader victory music",
    soulgold: { index: 354, loops: true, jingle: false, label: "MUS-VICTORY-GYM-LEADER", confidence: "high", evidence: "victory handler @0x0808B810 calls PlayBGM @0x08244544: class 32 (\"Leader\") -> PlayBGM(177<<1=354) @0x0808B932; name from the ROM's own song-name table (@0x004CCDC4, entry 354-349)" },
    ultraviolet: { index: 312, loops: true, jingle: false, label: "FRLG VICTORY-GYM-LEADER (twin of SoulGold 524)", confidence: "high", evidence: "victory handler @0x08015690 calls PlayBGM @0x080722A0: classes 84 (Leader) and 90 (Champion) -> PlayBGM(156<<1=312) @0x08015758; twin = SoulGold 524" },
  },
  victory_league: {
    group: "bgm",
    doc: "elite four / champion victory music",
    soulgold: { index: 355, loops: true, jingle: false, label: "MUS-VICTORY-LEAGUE", confidence: "high", evidence: "victory handler @0x0808B810 calls PlayBGM @0x08244544: classes 31 (\"Elite Four\") and 38 (\"Champion\") -> PlayBGM(100+255=355) @0x0808B928; name table entry 355" },
    ultraviolet: { index: 312, loops: true, jingle: false, label: "FRLG VICTORY-GYM-LEADER (UV reuses it for the champion class 90 only)", confidence: "medium", evidence: "victory handler @0x08015690 calls PlayBGM @0x080722A0: only classes 84 and 90 use 312; elite four (87) takes the default 310. Shared with victory_gym" },
  },
  victory_sting: {
    group: "jingle",
    doc: "short non-looping victory fanfare (for the \"you won\" moment before the result music)",
    soulgold: { index: 951, loops: false, jingle: true, label: "SoulGold hack obtain-badge fanfare (sFanfares[5] plays field +2 = 951)", confidence: "medium", evidence: "sFanfares @0x08F3C594 entry 5 = {369,951,340}; PlayFanfareByFanfareNum @0x08243E38 plays the halfword at +2 (ldrh r0,[r3,#2] @0x08243E4A). Choosing a badge fanfare as a win sting is a design choice (UNVERIFIED-GUESS for mood)" },
    ultraviolet: { index: 260, loops: false, jingle: true, label: "FRLG OBTAIN-BADGE fanfare", confidence: "medium", evidence: "sFanfares @0x083AC990 entry 5 = {260,340}; PlayFanfareByFanfareNum @0x08071BC4 plays [+0]. Mood choice (UNVERIFIED-GUESS)" },
  },
  defeat: {
    group: "jingle",
    doc: "defeat sting",
    soulgold: { index: 391, loops: false, jingle: true, label: "MUS-TOO-BAD (slot-machine \"too bad\" fanfare)", confidence: "low", evidence: "UNVERIFIED-GUESS: the ROM has no battle-loss jingle (the battle-end handlers only start victory music). 391 is the only sad fanfare: sFanfares @0x08F3C594 entry 11 = {391,391,160}" },
    ultraviolet: { index: 271, loops: false, jingle: true, label: "FRLG TOO-BAD fanfare", confidence: "low", evidence: "UNVERIFIED-GUESS: no battle-loss jingle in the ROM; sFanfares @0x083AC990 entry 10 = {271,160}" },
  },
  result_win: {
    group: "bgm",
    doc: "result screen after a win",
    soulgold: { index: 436, loops: true, jingle: false, label: "MUS-HALL-OF-FAME (loops)", confidence: "medium", evidence: "PlayBGM(436) @0x08174EC0 (Hall of Fame screen). Using it as the result theme is a design choice" },
    ultraviolet: { index: 286, loops: true, jingle: false, label: "FRLG HALL-OF-FAME (twin of SoulGold 498 MUS-RG-HALL-OF-FAME)", confidence: "medium", evidence: "PlayBGM(286) @0x080F1EDE (Hall of Fame screen). Design choice for the result theme" },
  },
  result_lose: {
    group: "bgm",
    doc: "result screen after a loss",
    soulgold: { index: 492, loops: true, jingle: false, label: "MUS-RG-LAVENDER (loops)", confidence: "low", evidence: "UNVERIFIED-GUESS (mood): somber FRLG town theme; identity from the ROM name table @0x004CCDC4 (entry 492-349)" },
    ultraviolet: { index: 280, loops: true, jingle: false, label: "FRLG LAVENDER (twin of SoulGold 492)", confidence: "low", evidence: "UNVERIFIED-GUESS (mood); identity by byte-identical twin = SoulGold 492 \"MUS-RG-LAVENDER\"" },
  },
  hub: {
    group: "bgm",
    doc: "hub / main menu",
    soulgold: { index: 400, loops: true, jingle: false, label: "MUS-POKE-CENTER (loops, calm, 9 tracks)", confidence: "low", evidence: "UNVERIFIED-GUESS (mood): friendly, calm looping town theme. Identity: ROM name table @0x004CCDC4 (entry 400-349) whose indexing is cross-checked against the sFanfares table" },
    ultraviolet: { index: 303, loops: true, jingle: false, label: "FRLG POKE-CENTER (twin of SoulGold 515 MUS-RG-POKE-CENTER)", confidence: "low", evidence: "UNVERIFIED-GUESS (mood). Identity: byte-identical twin" },
  },
  editor: {
    group: "bgm",
    doc: "team editor",
    soulgold: { index: 383, loops: true, jingle: false, label: "MUS-BIRCH-LAB (loops, tempo 100)", confidence: "low", evidence: "UNVERIFIED-GUESS (mood): slow lab theme for a long editing session. Identity: ROM name table (entry 383-349)" },
    ultraviolet: { index: 301, loops: true, jingle: false, label: "FRLG OAK-LAB (twin of SoulGold 513 MUS-RG-OAK-LAB)", confidence: "low", evidence: "UNVERIFIED-GUESS (mood). Identity: byte-identical twin" },
  },
  preview: {
    group: "bgm",
    doc: "team preview before a battle",
    soulgold: { index: 416, loops: true, jingle: false, label: "MUS-ENCOUNTER-INTENSE (loops, 8 tracks)", confidence: "medium", evidence: "The ROM plays trainer-encounter themes through the u16 table at 0x08447620 (song ids 380 407 379 423 416 417 419 441 385 449 450 451 453 397 then hack ids), read by the code @0x080BF210-0x080BF226 (ldrh r4,[table+48+2*id]; PlayNewMapMusic @0x08243B80). 416 is entry 4; using an encounter theme as the preview theme is a design choice" },
    ultraviolet: { index: 315, loops: true, jingle: false, label: "FRLG ENCOUNTER-RIVAL (twin of SoulGold 527 MUS-RG-ENCOUNTER-RIVAL)", confidence: "low", evidence: "UNVERIFIED-GUESS (mood); identity by twin; UV encounter-music selector not traced" },
  },
  title: {
    group: "bgm",
    doc: "title screen theme",
    soulgold: { index: 413, loops: false, jingle: true, label: "MUS-TITLE (does NOT loop: header ends in FINE)", confidence: "low", evidence: "identity: ROM name table (entry 413-349). I did NOT find code that starts 413 (the three sites that pass 413 call a UI helper @0x080D32E4, not a song function); a direct m4aSongNumStart(802) exists @0x0825FB44 (802 = 16 tracks, no loop, purpose unknown) -> UNVERIFIED-GUESS that 413 is the title theme of this hack" },
    ultraviolet: { index: 278, loops: true, jingle: false, label: "FRLG TITLE (twin of SoulGold 490 MUS-RG-TITLE)", confidence: "high", evidence: "m4aSongNumStart(278) called directly @0x08078AF8 (movs r0,#139; lsls r0,#1; bl 0x081DD0F4)" },
  },
  pokecenter: {
    group: "bgm",
    doc: "pokemon center",
    soulgold: { index: 400, loops: true, jingle: false, label: "MUS-POKE-CENTER", confidence: "low", evidence: "identity from the ROM name table (entry 400-349); UNVERIFIED-GUESS that this is a good pokemon-center theme here (role from prior knowledge)" },
    ultraviolet: { index: 303, loops: true, jingle: false, label: "FRLG POKE-CENTER", confidence: "low", evidence: "identity by byte-identical twin (SoulGold 515); UNVERIFIED-GUESS on role (prior knowledge)" },
  },
  lab: {
    group: "bgm",
    doc: "laboratory",
    soulgold: { index: 383, loops: true, jingle: false, label: "MUS-BIRCH-LAB", confidence: "low", evidence: "identity from the ROM name table (entry 383-349); UNVERIFIED-GUESS on role (prior knowledge)" },
    ultraviolet: { index: 301, loops: true, jingle: false, label: "FRLG OAK-LAB", confidence: "low", evidence: "identity by byte-identical twin (SoulGold 513); UNVERIFIED-GUESS on role (prior knowledge)" },
  },
  town: {
    group: "bgm",
    doc: "calm town theme",
    soulgold: { index: 405, loops: true, jingle: false, label: "MUS-LITTLEROOT (loops, 9 tracks, tempo 108)", confidence: "low", evidence: "identity from the ROM name table (entry 405-349); UNVERIFIED-GUESS on role (prior knowledge)" },
    ultraviolet: { index: 300, loops: true, jingle: false, label: "FRLG PALLET (twin of SoulGold 512)", confidence: "low", evidence: "identity by byte-identical twin (SoulGold 512); UNVERIFIED-GUESS on role (prior knowledge)" },
  },
  evolution: {
    group: "bgm",
    doc: "evolution scene",
    soulgold: { index: 377, loops: true, jingle: false, label: "MUS-EVOLUTION (loops)", confidence: "high", evidence: "PlayBGM(377) @0x08147BC8 and @0x08147E30 (evolution scene); intro 376 via PlayBGM @0x081308AC; PlayBGM(371) @0x081470CC" },
    ultraviolet: { index: 264, loops: true, jingle: false, label: "FRLG EVOLUTION (twin of SoulGold 377)", confidence: "high", evidence: "PlayBGM(264) @0x0804731A (and @0x080CF6B0/@0x080CF9B0); intro 263 @0x0804730A" },
  },
  hof: {
    group: "bgm",
    doc: "hall of fame",
    soulgold: { index: 436, loops: true, jingle: false, label: "MUS-HALL-OF-FAME", confidence: "high", evidence: "PlayBGM(436) @0x08174EC0" },
    ultraviolet: { index: 286, loops: true, jingle: false, label: "FRLG HALL-OF-FAME", confidence: "high", evidence: "PlayBGM(286) @0x080F1EDE" },
  },
  credits: {
    group: "bgm",
    doc: "credits roll",
    soulgold: { index: 455, loops: false, jingle: true, label: "MUS-CREDITS (does NOT loop)", confidence: "high", evidence: "m4aSongNumStart(455) called directly @0x08112F86 (movs r0,#200; adds r0,#255)" },
    ultraviolet: { index: 290, loops: false, jingle: true, label: "FRLG CREDITS (twin of SoulGold 502 MUS-RG-CREDITS; 11376 ticks)", confidence: "medium", evidence: "identity by twin; the code that starts it was not located" },
  },
  heal: {
    group: "jingle",
    doc: "party healed",
    soulgold: { index: 946, loops: false, jingle: true, label: "SoulGold hack heal fanfare (sFanfares[4] = {368,946,160})", confidence: "high", evidence: "sFanfares @0x08F3C594 entry 4; PlayFanfareByFanfareNum @0x08243E38 plays field +2; PlayFanfare(songNum) @0x08243EB8 matches +0 or +2 and also plays +2" },
    ultraviolet: { index: 256, loops: false, jingle: true, label: "FRLG HEAL fanfare", confidence: "high", evidence: "sFanfares @0x083AC990 entry 4 = {256,160}; PlayFanfare(256) called @0x08083F50" },
  },
  levelup: {
    group: "jingle",
    doc: "level up",
    soulgold: { index: 947, loops: false, jingle: true, label: "SoulGold hack level-up fanfare (sFanfares[0] = {367,947,80})", confidence: "high", evidence: "sFanfares @0x08F3C594 entry 0, field +2 is what is played" },
    ultraviolet: { index: 257, loops: false, jingle: true, label: "FRLG LEVEL-UP fanfare", confidence: "high", evidence: "sFanfares @0x083AC990 entry 0 = {257,80}" },
  },
  item: {
    group: "jingle",
    doc: "item obtained",
    soulgold: { index: 948, loops: false, jingle: true, label: "SoulGold hack obtain-item fanfare (entry 1 = {370,948,160})", confidence: "high", evidence: "sFanfares @0x08F3C594 entry 1" },
    ultraviolet: { index: 258, loops: false, jingle: true, label: "FRLG OBTAIN-ITEM fanfare", confidence: "high", evidence: "sFanfares @0x083AC990 entry 1 = {258,160}" },
  },
  evolved: {
    group: "jingle",
    doc: "evolution finished",
    soulgold: { index: 950, loops: false, jingle: true, label: "SoulGold hack evolved fanfare (entry 2 = {371,950,240})", confidence: "high", evidence: "sFanfares @0x08F3C594 entry 2" },
    ultraviolet: { index: 259, loops: false, jingle: true, label: "FRLG EVOLVED fanfare", confidence: "high", evidence: "sFanfares @0x083AC990 entry 2 = {259,220}" },
  },
  tm: {
    group: "jingle",
    doc: "TM/HM obtained",
    soulgold: { index: 952, loops: false, jingle: true, label: "SoulGold hack obtain-TM fanfare (entry 3 = {372,952,220})", confidence: "high", evidence: "sFanfares @0x08F3C594 entry 3" },
    ultraviolet: { index: 261, loops: false, jingle: true, label: "FRLG OBTAIN-TMHM fanfare", confidence: "high", evidence: "sFanfares @0x083AC990 entry 3 = {261,220}" },
  },
  badge: {
    group: "jingle",
    doc: "badge obtained",
    soulgold: { index: 951, loops: false, jingle: true, label: "SoulGold hack obtain-badge fanfare (entry 5 = {369,951,340})", confidence: "high", evidence: "sFanfares @0x08F3C594 entry 5" },
    ultraviolet: { index: 260, loops: false, jingle: true, label: "FRLG OBTAIN-BADGE fanfare", confidence: "high", evidence: "sFanfares @0x083AC990 entry 5 = {260,340}" },
  },
  key_item: {
    group: "jingle",
    doc: "key item obtained",
    soulgold: { index: 949, loops: false, jingle: true, label: "SoulGold hack key-item fanfare (entry 13 = {530,949,170})", confidence: "high", evidence: "sFanfares @0x08F3C594 entry 13" },
    ultraviolet: { index: 318, loops: false, jingle: true, label: "FRLG OBTAIN-KEY-ITEM fanfare", confidence: "high", evidence: "sFanfares @0x083AC990 entry 12 = {318,170}" },
  },
  berry: {
    group: "jingle",
    doc: "berry obtained",
    soulgold: { index: 955, loops: false, jingle: true, label: "SoulGold hack obtain-berry fanfare (entry 7 = {387,955,120})", confidence: "high", evidence: "sFanfares @0x08F3C594 entry 7" },
    ultraviolet: { index: 262, loops: false, jingle: true, label: "FRLG OBTAIN-BERRY fanfare", confidence: "high", evidence: "sFanfares @0x083AC990 entry 7 = {262,120}" },
  },
  move_deleted: {
    group: "jingle",
    doc: "move forgotten / deleted",
    soulgold: { index: 954, loops: false, jingle: true, label: "SoulGold hack move-deleted fanfare (entry 6 = {378,954,180})", confidence: "high", evidence: "sFanfares @0x08F3C594 entry 6" },
    ultraviolet: { index: 270, loops: false, jingle: true, label: "FRLG MOVE-DELETED fanfare", confidence: "high", evidence: "sFanfares @0x083AC990 entry 6 = {270,180}" },
  },
  se_cursor: {
    group: "se",
    doc: "menu cursor move",
    soulgold: { index: 5, loops: false, jingle: true, label: "SE-SELECT", confidence: "high", evidence: "PlaySE @0x0824456C is called with 5 from 822 resolvable sites (the most-used SE in the ROM); name from the ROM song-name table @0x004CC990 (entry 5-1)" },
    ultraviolet: { index: 5, loops: false, jingle: true, label: "SE-SELECT (twin of SoulGold 5)", confidence: "high", evidence: "PlaySE @0x080722CC called with 5 from 362 resolvable sites (most-used); byte-identical stream twin = SoulGold 5" },
  },
  se_select: {
    group: "se",
    doc: "menu confirm",
    soulgold: { index: 5, loops: false, jingle: true, label: "SE-SELECT", confidence: "high", evidence: "same as se_cursor: Emerald/FRLG menus use SE_SELECT for both move and confirm (822 PlaySE sites)" },
    ultraviolet: { index: 5, loops: false, jingle: true, label: "SE-SELECT", confidence: "high", evidence: "same as se_cursor (362 PlaySE sites)" },
  },
  se_back: {
    group: "se",
    doc: "menu cancel / B",
    soulgold: { index: 5, loops: false, jingle: true, label: "SE-SELECT (the engine has no separate cancel sound)", confidence: "medium", evidence: "cancel uses PlaySE(SE_SELECT) in the stock menu code (prior); no distinct cancel SE exists in the table. SE-PC-OFF (3) was not chosen because its role is unverified" },
    ultraviolet: { index: 5, loops: false, jingle: true, label: "SE-SELECT", confidence: "medium", evidence: "same reasoning (prior); 362 PlaySE(5) sites" },
  },
  se_error: {
    group: "se",
    doc: "invalid action buzz",
    soulgold: { index: 32, loops: false, jingle: true, label: "SE-FAILURE", confidence: "high", evidence: "PlaySE(32) from 82 resolvable sites (second most used); name table entry 32-1" },
    ultraviolet: { index: 26, loops: false, jingle: true, label: "SE-FAILURE (twin of SoulGold 32)", confidence: "high", evidence: "PlaySE(26) from 19 resolvable sites; twin = SoulGold 32" },
  },
  se_success: {
    group: "se",
    doc: "success chime",
    soulgold: { index: 31, loops: false, jingle: true, label: "SE-SUCCESS", confidence: "medium", evidence: "PlaySE(31) from 7 sites; name table entry 31-1" },
    ultraviolet: { index: 25, loops: false, jingle: true, label: "SE-SUCCESS (twin of SoulGold 31)", confidence: "medium", evidence: "PlaySE(25) from 2 sites" },
  },
  se_hit_normal: {
    group: "se",
    doc: "damaging hit, neutral",
    soulgold: { index: 13, loops: false, jingle: true, label: "SE-EFFECTIVE", confidence: "medium", evidence: "identity: ROM name table entry 13-1. Role (battle script command effectivenesssound) is prior knowledge: I did not locate that handler (PlaySE(13) appears at 4 other sites, @0x081D28CA,@0x081D28E0,@0x081D5098,@0x081D515E)" },
    ultraviolet: { index: 13, loops: false, jingle: true, label: "SE-EFFECTIVE (twin of SoulGold 13)", confidence: "medium", evidence: "identity by twin; role prior" },
  },
  se_hit_super: {
    group: "se",
    doc: "super effective hit",
    soulgold: { index: 14, loops: false, jingle: true, label: "SE-SUPER-EFFECTIVE", confidence: "medium", evidence: "identity: name table entry 14-1; role prior (handler not located)" },
    ultraviolet: { index: 14, loops: false, jingle: true, label: "SE-SUPER-EFFECTIVE (twin of SoulGold 14)", confidence: "medium", evidence: "identity by twin; role prior" },
  },
  se_hit_weak: {
    group: "se",
    doc: "not very effective hit",
    soulgold: { index: 12, loops: false, jingle: true, label: "SE-NOT-EFFECTIVE", confidence: "medium", evidence: "identity: name table entry 12-1; role prior (handler not located)" },
    ultraviolet: { index: 12, loops: false, jingle: true, label: "SE-NOT-EFFECTIVE (twin of SoulGold 12)", confidence: "medium", evidence: "identity by twin; role prior" },
  },
  se_faint: {
    group: "se",
    doc: "Pokemon faints",
    soulgold: { index: 16, loops: false, jingle: true, label: "SE-FAINT", confidence: "medium", evidence: "PlaySE(16) from 4 sites (@0x08165F88,@0x081BF0CA,@0x081D3A28,@0x081D48A6); name table entry 16-1" },
    ultraviolet: { index: 16, loops: false, jingle: true, label: "SE-FAINT (twin of SoulGold 16)", confidence: "medium", evidence: "identity by twin; role prior" },
  },
  se_ball_throw: {
    group: "se",
    doc: "ball thrown",
    soulgold: { index: 61, loops: false, jingle: true, label: "SE-BALL-THROW", confidence: "medium", evidence: "PlaySE(61) from 3 sites (@0x080F5ACE,@0x081D8820,@0x081D888E); name table entry 61-1" },
    ultraviolet: { index: 54, loops: false, jingle: true, label: "SE-BALL-THROW (twin of SoulGold 61)", confidence: "medium", evidence: "PlaySE(54) from 2 sites; twin" },
  },
  se_ball_open: {
    group: "se",
    doc: "ball opens / Pokemon sent out",
    soulgold: { index: 15, loops: false, jingle: true, label: "SE-BALL-OPEN", confidence: "medium", evidence: "PlaySE(15) @0x08053D66; name table entry 15-1" },
    ultraviolet: { index: 15, loops: false, jingle: true, label: "SE-BALL-OPEN (twin of SoulGold 15)", confidence: "medium", evidence: "PlaySE(15) from 1 site; twin" },
  },
  se_ball_bounce: {
    group: "se",
    doc: "ball bounce (catch)",
    soulgold: { index: 56, loops: false, jingle: true, label: "SE-BALL-BOUNCE-1", confidence: "medium", evidence: "PlaySE(56) from 6 sites (57..59 are the next bounces); name table entry 56-1" },
    ultraviolet: { index: 49, loops: false, jingle: true, label: "SE-BALL-BOUNCE-1 (twin of SoulGold 56)", confidence: "medium", evidence: "PlaySE(49) from 6 sites; twin" },
  },
  se_exp: {
    group: "se",
    doc: "exp bar filling",
    soulgold: { index: 33, loops: false, jingle: true, label: "SE-EXP", confidence: "medium", evidence: "PlaySE(33) @0x0805F6D2,@0x08147CB4; name table entry 33-1. Note header is a 156-tick single track (long)" },
    ultraviolet: { index: 27, loops: false, jingle: true, label: "SE-EXP (twin of SoulGold 33)", confidence: "medium", evidence: "PlaySE(27) from 5 sites; twin" },
  },
  se_exp_max: {
    group: "se",
    doc: "exp bar full / level reached",
    soulgold: { index: 91, loops: false, jingle: true, label: "SE-EXP-MAX", confidence: "medium", evidence: "PlaySE(91) @0x08122724,@0x08190728; name table entry 91-1" },
    ultraviolet: { index: 84, loops: false, jingle: true, label: "SE-EXP-MAX (twin of SoulGold 91)", confidence: "medium", evidence: "PlaySE(84) from 1 site; twin" },
  },
  se_lowhp: {
    group: "se",
    doc: "low HP warning beep",
    soulgold: { index: 90, loops: false, jingle: true, label: "SE-LOW-HEALTH", confidence: "medium", evidence: "PlaySE(90) @0x080801B6 (single site); name table entry 90-1" },
    ultraviolet: { index: 83, loops: true, jingle: false, label: "FRLG LOW-HEALTH (looping, player 3)", confidence: "medium", evidence: "NO byte-identical twin in SoulGold; chosen by position: SoulGold song 90 = UV song 83 under the constant +7 offset that holds for 205 twin pairs, and song 83 is a 1-track LOOPING song on music player 3 (ms/me = 3/3), which is how FRLG runs its low-HP beep. It LOOPS: the director must stop it" },
  },
  se_flee: {
    group: "se",
    doc: "run away",
    soulgold: { index: 17, loops: false, jingle: true, label: "SE-FLEE", confidence: "medium", evidence: "name table entry 17-1" },
    ultraviolet: { index: 17, loops: false, jingle: true, label: "SE-FLEE (twin of SoulGold 17)", confidence: "medium", evidence: "PlaySE(17) from 1 site; twin" },
  },
  se_use_item: {
    group: "se",
    doc: "use item",
    soulgold: { index: 1, loops: false, jingle: true, label: "SE-USE-ITEM", confidence: "high", evidence: "PlaySE(1) from 51 sites; name table entry 1-1" },
    ultraviolet: { index: 1, loops: false, jingle: true, label: "SE-USE-ITEM (twin of SoulGold 1)", confidence: "high", evidence: "PlaySE(1) from 8 sites; twin" },
  },
  se_switch: {
    group: "se",
    doc: "switch / toggle",
    soulgold: { index: 35, loops: false, jingle: true, label: "SE-SWITCH", confidence: "low", evidence: "identity from the ROM name table (entry 35-1); UNVERIFIED-GUESS on role (prior knowledge)" },
    ultraviolet: { index: 29, loops: false, jingle: true, label: "SE-SWITCH (twin of SoulGold 35)", confidence: "low", evidence: "identity by byte-identical twin (SoulGold 35); UNVERIFIED-GUESS on role (prior knowledge)" },
  },
  se_menu_open: {
    group: "se",
    doc: "window / menu opens",
    soulgold: { index: 6, loops: false, jingle: true, label: "SE-WIN-OPEN", confidence: "medium", evidence: "PlaySE(6) from 8 sites; name table entry 6-1" },
    ultraviolet: { index: 6, loops: false, jingle: true, label: "SE-WIN-OPEN (twin of SoulGold 6)", confidence: "medium", evidence: "PlaySE(6) from 10 sites; twin" },
  },
  se_save: {
    group: "se",
    doc: "game saved",
    soulgold: { index: 55, loops: false, jingle: true, label: "SE-SAVE", confidence: "medium", evidence: "name table entry 55-1" },
    ultraviolet: { index: 48, loops: false, jingle: true, label: "SE-SAVE (twin of SoulGold 55)", confidence: "medium", evidence: "PlaySE(48) from 3 sites; twin" },
  },
  se_levelup: {
    group: "se",
    doc: "level-up sting played as an effect (alias of the levelup fanfare)",
    soulgold: { index: 947, loops: false, jingle: true, label: "SoulGold hack level-up fanfare", confidence: "high", evidence: "sFanfares @0x08F3C594 entry 0 field +2" },
    ultraviolet: { index: 257, loops: false, jingle: true, label: "FRLG LEVEL-UP fanfare", confidence: "high", evidence: "sFanfares @0x083AC990 entry 0" },
  },
};

// When a soundtrack has no song for a key (entry null) the director walks this chain, then falls back to silence.
export const FALLBACKS = {
  battle_final: ['battle_hard', 'battle_normal'],
  battle_hard: ['battle_normal'],
  battle_easy: ['battle_normal'],
  battle_rival: ['battle_normal'],
  battle_villain: ['battle_normal'],
  battle_frontier: ['battle_hard', 'battle_normal'],
  battle_legendary: ['battle_hard', 'battle_normal'],
  victory_gym: ['victory'],
  victory_league: ['victory_gym', 'victory'],
  victory_sting: ['victory'],
  defeat: [],
  result_win: ['victory', 'hof'],
  result_lose: ['defeat', 'hub'],
  preview: ['battle_normal', 'hub'],
  editor: ['hub', 'lab'],
  hub: ['pokecenter', 'town', 'title'],
  title: ['hub'],
  pokecenter: ['hub'],
  lab: ['hub'],
  town: ['hub'],
  evolution: ['hub'],
  hof: ['result_win'],
  credits: ['hub'],
};

// ---------------------------------------------------------------------------------------------------------------
export function songFor(soundtrack, key) {
  const row = MAP[key];
  if (!row) return null;
  const e = row[soundtrack];
  if (!e || e.none !== undefined) return null;
  return { index: e.index, loops: e.loops, jingle: e.jingle, label: e.label, confidence: e.confidence, evidence: e.evidence };
}

// Why songFor() returned null (unknown soundtrack/key -> a reason string too).
export function whyNull(soundtrack, key) {
  if (!SOUNDTRACKS.includes(soundtrack)) return 'unknown soundtrack: ' + soundtrack;
  const row = MAP[key];
  if (!row) return 'unknown key: ' + key;
  const e = row[soundtrack];
  if (e && e.none !== undefined) return e.none;
  return null;
}

// songFor with the documented fallback chain applied; returns { key, ...song } of the first hit or null.
export function resolveSong(soundtrack, key) {
  const seen = new Set();
  const queue = [key];
  while (queue.length) {
    const k = queue.shift();
    if (seen.has(k)) continue;
    seen.add(k);
    const s = songFor(soundtrack, k);
    if (s) return { key: k, requested: key, ...s };
    for (const f of FALLBACKS[k] || []) queue.push(f);
  }
  return null;
}

export function keysFor(soundtrack) {
  return ALL_KEYS.filter((k) => songFor(soundtrack, k) !== null);
}

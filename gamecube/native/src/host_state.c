// gamecube/native/src/host_state.c — library state the GAME READS BACK, placed in game memory so a rollback
// restores it. Everything here is between the mp4web_game_bss markers (build.sh lists this file with the
// game objects): the store barrier logs each write like any game store, and rewinds put it back.
// Rule: if the game can observe a value through an API call, the value must live here or in game memory.
//
// 1. THE MEMORY CARD of a room / determinism run (?nosave=1).
//
// A save, and the boxes the menus probe, are game state: the game reads them back. The card used to be a
// raw image FILE (MEMFS) plus aurora's card object on the C++ heap, neither inside the range rollback
// covers, so a rewind across a card operation re-ran it against the card as the abandoned future had left
// it (mode select's probe/create of MARIPA4BOX0-2: saveBuf read 08 04 on the first pass, FF FF on the
// re-run, and the room desynced). Here every byte of the card — aurora's CardRawFile object (directory/BAT
// caches, open state), the image length and the 251-block image — is restored with everything else. aurora's lib/dolphin/card.cpp places the slot-A card here when Module.mp4MemCard is set.
// (A card that persists — solo, IndexedDB — stays a file: nothing rolls back there.)
#define MP4WEB_CARD_OBJ_BYTES (128u * 1024u)                 // CardRawFile + the image length (last 64 bytes)
#define MP4WEB_CARD_IMAGE_BYTES (256u * 8192u)               // a 251-block card: 256 blocks of 8 KB
_Alignas(4096) unsigned char mp4web_card_arena[MP4WEB_CARD_OBJ_BYTES + MP4WEB_CARD_IMAGE_BYTES];
const unsigned int mp4web_card_arena_size = sizeof mp4web_card_arena;

// 2. THE GX SHADOW REGISTERS (aurora's __gx, ~600 B, no pointers). GXGetProjectionv/GXGetViewportv return
// them, and minigames read them back (m427 map.c, m428 player.c project points with them). On the C++ heap
// they held whatever the abandoned future set last, so a frame re-run after a rewind could read a projection
// from frames that no longer happened. aurora's lib/dolphin/gx/GXManage.cpp points __gx here on the web.
_Alignas(16) unsigned char mp4web_gx_shadow[4096];

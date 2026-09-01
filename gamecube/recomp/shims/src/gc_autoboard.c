// [wasm-recomp 2026-08-25] AUTOBOARD: jump straight into the Party-Mode board with the exact
// configuration the default 18-press setup flow commits (mentDll main.c:1893-1932 -> :1975).
// The char-select screen has an unresolved input gate (the pick registers but the wait loop
// never advances — under investigation); this replays the game's OWN commit writes so the
// board (OVL_W01, Toad's Midway Madness) is reachable for live play NOW. Armed at runtime by
// the host via __recomp_autoboard_arm(1); fires from the char-select wait loop after ~2s.
// Values = the flow's defaults: teams off, bonus off, minigame pack 0, 20 turns, no handicap;
// P1 Mario (human, pad 0), COMs Luigi/Peach/Yoshi at Easy.
#include "game/gamework_data.h"
#include "game/board/main.h"
#include "game/object.h"

int __recomp_autoboard_armed = 0;
void __recomp_autoboard_arm(int v) { __recomp_autoboard_armed = v; }

void __recomp_autoboard(void)
{
    int i;
    BoardPartyConfigSet(0 /*team*/, 0 /*bonus_star*/, 0 /*mg_list*/, 20 /*max_turn*/,
                        0, 0, 0, 0 /*handicaps*/);
    for (i = 0; i < 4; i++) {
        GWPlayerCfg[i].character = i;      /* Mario, Luigi, Peach, Yoshi */
        GWPlayerCfg[i].pad_idx = i;
        GWPlayerCfg[i].diff = 0;
        GWPlayerCfg[i].group = 0;
        GWPlayerCfg[i].iscom = (i != 0);
    }
    BoardSaveInit(0);                       /* GWSystem.board = 0 (board/main.c:289) */
    omOvlCallEx(OVL_W01, 1, 0, 0);
}

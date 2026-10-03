// [wasm-recomp 2026-08-25] AUTOBOARD: jump straight into the Party-Mode board with the exact
// configuration the default 18-press setup flow commits (mentDll main.c:1893-1932 -> :1975).
// The char-select screen has an unresolved input gate (the pick registers but the wait loop
// never advances — under investigation); this replays the game's OWN commit writes so the
// board (OVL_W01, Toad's Midway Madness) is reachable for live play NOW. Armed at runtime by
// the host via __recomp_autoboard_arm(1); fires from the char-select wait loop after ~2s.
// Values = the flow's defaults: teams off, bonus off, minigame pack 0, 20 turns, no handicap;
// P1 Mario (human, pad 0), COMs Luigi/Peach/Yoshi at Easy.
//
// [2026-10-01] AUTOTEST — the same firing point, two more destinations, so EVERY overlay can be
// driven to without a person: __recomp_autotest_set(board, mg) before main().
//   board 0..5  BoardSaveInit(board) + the board overlay w01..w06 (consecutive in the game's
//               DLL enum, ovl_table.h).
//   mg >= 0     a MINIGAME, entered the way Mini-Game mode enters one (mgmodedll minigame.c:
//               CharMotionInit per player, history[0] = mgmodedll, omOvlCallEx(instdll)) with
//               GWSystem.mg_next = mg (instDll main.c reads it). All four players are COMs, so
//               the minigame plays itself, and the "show instructions" flag (0,11) is cleared,
//               which instDll treats as "go straight to the minigame" (instDll main.c:107-111).
//               Teams follow Mini-Game mode's free play (free_play.c:460-463, 1277-1287).
#include "game/gamework_data.h"
#include "game/board/main.h"
#include "game/object.h"
#include "game/objsub.h"
#include "game/flag.h"
#include "game/chrman.h"
#include "game/audio.h"
#include "game/minigame_seq.h"
// DECOMP GENERATIONS (build_wasm.sh): the 2026 decomp's overlay enum is DLL_<name>, not OVL_<NAME>.
#if defined(RECOMP_DECOMP_GEN) && RECOMP_DECOMP_GEN >= 2
#define OVL_W01 DLL_w01dll
#define OVL_INST DLL_instdll
#define OVL_MGMODE DLL_mgmodedll
#endif
/* gen 1 spells them OVL_INST / OVL_MGMODE already (its enum drops the "dll": OVL_BOOT, OVL_MENT, ...) */

int __recomp_autoboard_armed = 0;
void __recomp_autoboard_arm(int v) { __recomp_autoboard_armed = v; }
static int autotest_board = 0;
static int autotest_mg = -1;
static int autotest_allcom = 0;
/* board: 0..5, plus 0x100 = ALL FOUR PLAYERS COM (the board then plays itself, including the
 * minigame instruction screen, which waits for a human START unless every player is a COM —
 * instDll main.c:294 `comNum == 4 && i > 60`). */
void __recomp_autotest_set(int board, int mg)
{
    autotest_allcom = (board & 0x100) != 0;
    board &= 0xFF;
    autotest_board = (board >= 0 && board <= 5) ? board : 0;
    autotest_mg = mg;
    __recomp_autoboard_armed = 1;
}

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
    if (autotest_mg >= 0) {
        int type = mgInfoTbl[autotest_mg].type;
        for (i = 0; i < 4; i++) {
            GWPlayerCfg[i].iscom = 1;
            GWPlayerCfg[i].group = (type == 1) ? (i != 0) : (type == 2) ? (i >= 2) : i;
        }
        GWSystem.mg_next = autotest_mg;
        _ClearFlag(FLAG_ID_MAKE(0, 11));
        CharDataClose(-1);
        for (i = 0; i < 4; i++) CharMotionInit(GWPlayerCfg[i].character);
        HuAudSndCharGrpSet(-1);
        omOvlHisChg(0, OVL_MGMODE, 0, 0);
        omOvlCallEx(OVL_INST, 1, 0, 0);
        return;
    }
    if (autotest_allcom) for (i = 0; i < 4; i++) GWPlayerCfg[i].iscom = 1;
    BoardSaveInit(autotest_board);          /* GWSystem.board = board (board/main.c:289) */
    /* What mentDll's own launch (fn_1_C174, case 1/3) does between the commit and the call:
     * kill the select-screen character models and minigame sequences, then CharMotionInit each
     * seated character. The original AUTOBOARD skipped this and w01 happened not to need it;
     * MEASURED without it: w03/w04/w05 trapped in Hu3DJointMotion <- CharMotionCreate <-
     * ExecPlayerStart at their first player start (gamecube/recomp/ovl_test.mjs board:2-4). */
    CharModelKill(-1);
    MGSeqKillAll();
    for (i = 0; i < 4; i++) CharMotionInit(GWPlayerCfg[i].character);
    omOvlCallEx(OVL_W01 + autotest_board, 1, 0, 0);
}

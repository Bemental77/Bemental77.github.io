// [wasm-recomp 2026-08-23] Host input injection. The recomp has no VI-retrace interrupt firing
// PadReadVSync (game/pad.c:148), so PADRead runs once and _PadBtnDown/HuPadBtnDown stay 0 -> no
// input ever reaches the game. These globals let the host (recomp_worker.js, fed by the page's
// pace SAB) drive controller state: build_wasm.sh bakes a four-port loop at the end of HuPadRead
// that ORs __recomp_inject_btn[p] into HuPadBtnDown[p] (and the other three channels into their
// arrays), so whatever the host sets here is delivered as "pressed this frame" (e.g.
// PAD_BUTTON_START=0x1000 to advance the title -> OVL_MODESEL). The host pulses the edge
// channels (set then clear) to avoid held-button rapid-fire in menus.
//
// [four ports 2026-09-10] THESE WERE FOUR SCALARS AND MARIO PARTY IS A FOUR-PLAYER GAME.
// Every channel was a single int and every setter took no port, so build_wasm.sh could only
// ever write index [0] — the recomp engine physically could not express player 2. The game
// itself was never the limit: game/pad.c declares HuPadBtn/HuPadBtnDown/HuPadStkX/HuPadStkY/
// HuPadDStkRep/HuPadErr as [4] and HuPadRead loops i=0..3 over all of them, and mentDll's
// character select reads HuPadBtnDown[player->pad_idx] per player
// (~/gc_refs/marioparty4/src/REL/mentDll/main.c:3987-4025), so four cursors move independently
// the moment four ports carry different bytes. PadReadVSync never runs here, so _PadErr[0..3]
// stay PAD_ERR_NONE (0) and HuPadStatGet() reports all four controllers PRESENT — which is
// what lets modeseldll/main.c:140-149 mark all four slots human.
//
// The per-channel arrays stay `int` (not the guest's u16/u8/s8) because the host writes them
// through a wasm export and the widening is free; the bake in build_wasm.sh casts down at the
// point of use, exactly as it did when they were scalars.
#define RECOMP_PAD_PORTS 4

int __recomp_inject_btn[RECOMP_PAD_PORTS];
int __recomp_inject_dstk[RECOMP_PAD_PORTS];
int __recomp_inject_stkx[RECOMP_PAD_PORTS];
int __recomp_inject_stky[RECOMP_PAD_PORTS];

// The one setter the host uses now: all four channels of one port in a single call, so a port's
// state can never be half-updated across a frame boundary (HuPadRead can run more than once per
// retrace — see the FRAME-SCOPED note in build_wasm.sh). Out-of-range ports are dropped rather
// than clamped to 0: silently folding a bad port onto player 1 is the exact bug this commit
// exists to remove.
void __recomp_set_pad(int port, int btn, int dstk, int stkx, int stky)
{
    if ((unsigned int)port >= (unsigned int)RECOMP_PAD_PORTS) return;
    __recomp_inject_btn[port]  = btn;
    __recomp_inject_dstk[port] = dstk;
    __recomp_inject_stkx[port] = stkx;
    __recomp_inject_stky[port] = stky;
}

// Legacy single-port entry points, kept because gamecube/recomp/recomp_probe.mjs:348-353 and
// any older shipped recomp_worker.js call them by name. They are port 0 and nothing else.
void __recomp_set_inject_btn(int v) { __recomp_inject_btn[0] = v; }
int __recomp_get_inject_btn(void) { return __recomp_inject_btn[0]; }
void __recomp_set_inject_dstk(int v) { __recomp_inject_dstk[0] = v; }
void __recomp_set_inject_stkx(int v) { __recomp_inject_stkx[0] = v; }
void __recomp_set_inject_stky(int v) { __recomp_inject_stky[0] = v; }

// ── THE WITNESS: WHAT THE GAME ITSELF THINKS ITS FOUR PADS ARE ──────────────────────────────
// "Four ports are wired" is only worth something if it can be checked against the GAME'S OWN
// arrays instead of against the flag we just set. This reads the decomp's globals BY C SYMBOL,
// which matters more than it sounds: THIS IS A NATIVE PORT, NOT AN EMULATOR. There is no Gekko
// address map here — HuPadBtnDown is a wasm data symbol wherever wasm-ld put it, NOT at the
// GameCube address 0x801D3AD0 the symbol map lists. A harness that peeked MEM1 offsets read
// four zeros and looked exactly like broken input; it was reading empty arena.
//
// winKey is the load-bearing entry. Our bake WRITES HuPadBtnDown, so reading that back proves
// only that we can write memory. winKey is computed by MP4's OWN HuWinComKeyGet, which loops
// i = 0..3 and does `winKey[i] = HuPadDStkRep[i] | HuPadBtnDown[i]` (src/game/window.c:1564-1580)
// every frame a message window is in stat 2 or 3 (:558-568), for all four pads
// (player_disable defaults to 0, :279). Four distinct injected pads coming back out of winKey as
// four distinct values is the GAME reading four ports.
extern unsigned short HuPadBtn[4];
extern unsigned short HuPadBtnDown[4];
extern unsigned char  HuPadDStkRep[4];
extern signed char    HuPadStkX[4];
extern signed char    HuPadStkY[4];
extern signed char    HuPadErr[4];
extern unsigned int   winKey[4];
// PlayerConfig is five s16 (character, pad_idx, diff, group, iscom) — include/game/gamework_data.h:11.
// Declared as a flat s16 array so this shim needs none of the game's headers.
extern short GWPlayerCfg[];
// Where the game IS. omcurovl is the running overlay id (include/game/object.h:115) and
// winData[i].stat == 2 or 3 is what makes HuWinComKeyGet — and therefore winKey — run at all
// (src/game/window.c:558-568). Without these two a harness cannot tell "four ports are dead"
// from "no message window was open when I looked", and those are opposite conclusions.
// winData is WindowData[32], stride 0x180, `stat` at offset 0 (include/game/window.h:24-25);
// declared flat here so this shim needs none of the game's headers.
extern int omcurovl;
extern int omovlevtno;
extern unsigned char winData[];
// MP4's OWN per-frame counter, bumped by the game's main loop at the bottom of every rendered
// frame (~/gc_refs/marioparty4/src/game/main.c:115, `GlobalCounter++`). This is a GUEST-EXECUTED
// clock: it advances only because the game itself ran, which makes it independent of the host's
// own retrace bookkeeping and of the renderer's frame counters. It is the recomp path's W4.
extern unsigned int GlobalCounter;
#define RECOMP_WINDATA_STRIDE 0x180
#define RECOMP_WINDATA_COUNT  32

#define RECOMP_WIT_INTS 48
static int __recomp_wit[RECOMP_WIT_INTS];

// Fills the static block and returns its address, so the host reads it out of HEAP32 with one
// call (the ___recomp_card_base pattern). Layout, four ints per row, port-major:
//   0 HuPadBtnDown   4 HuPadBtn      8 HuPadDStkRep  12 HuPadStkX   16 HuPadStkY
//  20 HuPadErr      24 winKey       28 cfg.character 32 cfg.pad_idx 36 cfg.iscom
//  40 __recomp_inject_btn  — what the HOST set, so "not injected" and "injected but not
//                            delivered to the game" are two distinguishable failures.
//  44 omcurovl  45 omovlevtno  46 open message windows (stat 2 or 3)  47 GlobalCounter
int __recomp_pad_witness(void)
{
    int i, open = 0;
    for (i = 0; i < RECOMP_WINDATA_COUNT; i++) {
        unsigned char st = winData[i * RECOMP_WINDATA_STRIDE];
        if (st == 2 || st == 3) open++;
    }
    __recomp_wit[44] = omcurovl;
    __recomp_wit[45] = omovlevtno;
    __recomp_wit[46] = open;
    __recomp_wit[47] = (int)GlobalCounter;
    for (i = 0; i < RECOMP_PAD_PORTS; i++) {
        __recomp_wit[0  + i] = (int)HuPadBtnDown[i];
        __recomp_wit[4  + i] = (int)HuPadBtn[i];
        __recomp_wit[8  + i] = (int)HuPadDStkRep[i];
        __recomp_wit[12 + i] = (int)HuPadStkX[i];
        __recomp_wit[16 + i] = (int)HuPadStkY[i];
        __recomp_wit[20 + i] = (int)HuPadErr[i];
        __recomp_wit[24 + i] = (int)winKey[i];
        __recomp_wit[28 + i] = (int)GWPlayerCfg[i * 5 + 0];
        __recomp_wit[32 + i] = (int)GWPlayerCfg[i * 5 + 1];
        __recomp_wit[36 + i] = (int)GWPlayerCfg[i * 5 + 4];
        __recomp_wit[40 + i] = __recomp_inject_btn[i];
    }
    return (int)(long)&__recomp_wit[0];
}

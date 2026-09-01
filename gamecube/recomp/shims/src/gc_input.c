// [wasm-recomp 2026-08-23] Host input injection. The recomp has no VI-retrace interrupt firing
// PadReadVSync (game/pad.c:148), so PADRead runs once and _PadBtnDown/HuPadBtnDown stay 0 -> no
// input ever reaches the game. This global lets the host (fiber_probe.mjs) drive controller-0
// buttons: build_wasm.sh bakes `HuPadBtnDown[0] |= __recomp_inject_btn` at the end of HuPadRead,
// so whatever the host sets here is delivered as "pressed this frame" (e.g. PAD_BUTTON_START=0x1000
// to advance the title -> OVL_MODESEL). The host pulses it (set then clear) to avoid held-button
// rapid-fire in menus.
int __recomp_inject_btn = 0;
void __recomp_set_inject_btn(int v) { __recomp_inject_btn = v; }
int __recomp_get_inject_btn(void) { return __recomp_inject_btn; }

// Directional input: menus/choice dialogs (HuWinChoice, the modesel carousel) navigate on the
// ANALOG-STICK digital repeat HuPadDStkRep, not HuPadBtnDown — baked as a second OR at
// HuPadRead's end. Same pulse discipline as the buttons.
int __recomp_inject_dstk = 0;
void __recomp_set_inject_dstk(int v) { __recomp_inject_dstk = v; }

// Raw analog stick: mentDll's own UIs (player-count, character grid) navigate on
// HuPadStkX/HuPadStkY thresholds (>=50 / <=-50, and >=5 rows), NOT the D-stick repeat —
// HuPadBtn's d-pad bits are masked out at HuPadRead (pad.c:134) so the stick is the only
// live navigation surface there. One-shot like the other channels.
int __recomp_inject_stkx = 0, __recomp_inject_stky = 0;
void __recomp_set_inject_stkx(int v) { __recomp_inject_stkx = v; }
void __recomp_set_inject_stky(int v) { __recomp_inject_stky = v; }

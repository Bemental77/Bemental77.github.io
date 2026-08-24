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

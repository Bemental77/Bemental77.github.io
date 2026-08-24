// [wasm-recomp 2026-08-23] AOT overlay dispatch — generalize bootDll's static-prolog trick to the
// mode-select overlay (the path toward gameplay). Each REL shares executor.c's _prolog/ObjectSetup
// symbols, so overlays AOT-compiled into one module must have their entry symbols namespaced
// (build_wasm.sh compiles modeseldll with -DObjectSetup=modesel_ObjectSetup). This provides the
// per-overlay prolog the dispatch (objdll.c omDLLLink bake) calls for OVL_MODESEL, mirroring
// executor.c's _prolog (skip the ctor loop — the decomp is C, its _ctors list is empty, and the
// shared runtime's ctors already ran under bootDll).
//
// Defined weakly-ish: if RECOMP_MODESEL is off, modesel_ObjectSetup is an undefined import and this
// is never dispatched, so it stays a harmless no-op stub target.
extern void modesel_ObjectSetup(void);
int modesel_prolog(void) { modesel_ObjectSetup(); return 0; }

// OVL_MENT (Party-Mode entry/setup). mentDll ships its OWN _prolog (common.c) whose only real
// work after the (empty) ctor loop is fn_1_144() — namespaced fn_mt1_144 by build_wasm.sh's
// RECOMP_MENT block; the staged _prolog/_epilog are neutralized (their _ctors/_dtors link
// symbols do not exist under emcc).
extern void fn_mt1_144(void);
int ment_prolog(void) { fn_mt1_144(); return 0; }

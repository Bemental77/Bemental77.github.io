// [wasm-recomp, 2026-10-01] AOT OVERLAY DISPATCH — the table side of objdll.c's hooks.
//
// Every REL overlay compiled into this module is listed in __recomp_ovl_tab, which ovl_build.py
// GENERATES (BUILD/ovl/ovl_table.c) from the overlays it actually compiled: number (the game's
// own DLL enum, read from the decomp's ovl_table.h), the overlay's namespaced _prolog/_epilog,
// and the address range of its .data and of its .bss (marker objects bracket the overlay's
// objects in the link order; build_wasm.sh links them in that order).
//
// It replaces the hand-written modesel_prolog / ment_prolog / w01_prolog entry points this file
// used to carry. Those called ObjectSetup-equivalents directly; the table calls each overlay's
// REAL _prolog (executor.c's, board_executor.c's or the overlay's own), compiled per overlay,
// so the entry sequence is the REL's own: ctors (none in C), then ObjectSetup.
//
// THE STATICS. On hardware OSLink gives a REL fresh statics on EVERY link: the module (with its
// .data) is re-read from disc, and its .bss is a fresh allocation that OSLink zeroes. omDLLStart's
// "Already Loaded" restart re-zeroes .bss (objdll.c memset). The AOT overlays live at fixed
// addresses for the whole run, so both are reproduced here:
//   __recomp_ovl_fresh: first link -> snapshot .data (pristine: nothing but the overlay's own
//                       code writes it); later links -> restore it. Then zero .bss.
//   __recomp_ovl_bss:   zero .bss only (the Already Loaded path).
// The snapshot is taken from the game's own C heap (malloc), so it is part of the guest state
// that savestates and the determinism hash cover — two consoles take it at the same frame.
#include <string.h>
// declared here, not via <stdlib.h>: the decomp's own include/stdlib.h shadows the sysroot's.
extern void *malloc(unsigned long);

typedef int (*RecompProlog)(void);
typedef void (*RecompEpilog)(void);
typedef struct { short num; RecompProlog prolog; RecompEpilog epilog; char *db, *de, *bb, *be;
                 const char *name; } RecompOvl;
extern const RecompOvl __recomp_ovl_tab[];
extern const int __recomp_ovl_count;

// executor.c / board_executor.c / mentDll walk these before ObjectSetup; a C overlay has no
// static constructors, so both lists are just the terminator (shared by every overlay).
typedef void (*VoidFunc)(void);
const VoidFunc _ctors[] = { 0 };
const VoidFunc _dtors[] = { 0 };

#define RECOMP_OVL_MAX 128
static unsigned char *ovl_snap[RECOMP_OVL_MAX];

long __recomp_ovl_find(short overlay)
{
    int i;
    for (i = 0; i < __recomp_ovl_count; i++)
        if (__recomp_ovl_tab[i].num == overlay) return i;
    return -1;
}

const char *__recomp_ovl_name(long i)
{
    return (i >= 0 && i < __recomp_ovl_count) ? __recomp_ovl_tab[i].name : "?";
}

void __recomp_ovl_bss(long i)
{
    const RecompOvl *o;
    if (i < 0 || i >= __recomp_ovl_count) return;
    o = &__recomp_ovl_tab[i];
    memset(o->bb, 0, (size_t)(o->be - o->bb));
}

void __recomp_ovl_fresh(long i)
{
    const RecompOvl *o;
    size_t n;
    if (i < 0 || i >= __recomp_ovl_count || i >= RECOMP_OVL_MAX) return;
    o = &__recomp_ovl_tab[i];
    n = (size_t)(o->de - o->db);
    if (!ovl_snap[i]) {
        ovl_snap[i] = (unsigned char *)malloc(n ? n : 1);
        if (ovl_snap[i]) memcpy(ovl_snap[i], o->db, n);
    } else {
        memcpy(o->db, ovl_snap[i], n);
    }
    __recomp_ovl_bss(i);
}

long __recomp_ovl_prolog(long i)
{
    if (i < 0 || i >= __recomp_ovl_count || !__recomp_ovl_tab[i].prolog) return 0;
    return __recomp_ovl_tab[i].prolog();
}

void __recomp_ovl_epilog(long i)
{
    if (i < 0 || i >= __recomp_ovl_count || !__recomp_ovl_tab[i].epilog) return;
    __recomp_ovl_tab[i].epilog();
}

// omDllData* -> table index, for the AOT dlls currently linked (module == 0, so the record
// itself carries nothing that names the overlay). OM_DLL_MAX is 20 in the decomp.
#define RECOMP_DLL_SLOTS 32
static void *dll_key[RECOMP_DLL_SLOTS];
static long dll_idx[RECOMP_DLL_SLOTS];

void __recomp_ovl_bind(void *dll, long i)
{
    int k, free_k = -1;
    for (k = 0; k < RECOMP_DLL_SLOTS; k++) {
        if (dll_key[k] == dll) { dll_idx[k] = i; return; }
        if (!dll_key[k] && free_k < 0) free_k = k;
    }
    if (free_k >= 0) { dll_key[free_k] = dll; dll_idx[free_k] = i; }
}

long __recomp_ovl_of(void *dll)
{
    int k;
    for (k = 0; k < RECOMP_DLL_SLOTS; k++)
        if (dll_key[k] == dll) return dll_idx[k];
    return -1;
}

void __recomp_ovl_unbind(void *dll)
{
    int k;
    for (k = 0; k < RECOMP_DLL_SLOTS; k++)
        if (dll_key[k] == dll) { dll_key[k] = 0; dll_idx[k] = -1; }
}

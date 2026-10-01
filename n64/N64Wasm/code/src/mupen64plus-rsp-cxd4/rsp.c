/******************************************************************************\
* Project:  Module Subsystem Interface to SP Interpreter Core                  *
* Authors:  Iconoclast                                                         *
* Release:  2016.03.23                                                         *
* License:  CC0 Public Domain Dedication                                       *
*                                                                              *
* To the extent possible under law, the author(s) have dedicated all copyright *
* and related and neighboring rights to this software to the public domain     *
* worldwide. This software is distributed without any warranty.                *
*                                                                              *
* You should have received a copy of the CC0 Public Domain Dedication along    *
* with this software.                                                          *
* If not, see <http://creativecommons.org/publicdomain/zero/1.0/>.             *
\******************************************************************************/

#define LIBRETRO

#if defined(USE_SSE2NEON) && defined(__ARM_NEON__)
#include "sse2neon/SSE2NEON.h"
#define ARCH_MIN_SSE2
#endif

#include "vu/add.c"
#include "vu/divide.c"
#include "vu/logical.c"
#include "vu/multiply.c"
#include "vu/select.c"
#include "vu/vu.c"
#include "su.c"
#include "module.c"

unsigned char rsp_conf[32];

/* NEIL RAW STATE — the cxd4 LLE RSP's architectural state.
 *
 * With forceAngry this core runs EVERY RSP task (graphics AND audio: libretronew.c
 * forces send_allist_to_hle_rsp = false) on cxd4, and the m64p savestate keeps
 * only SP DMEM/IMEM + the SP registers. The scalar and vector register files,
 * the accumulators, the VCO/VCC/VCE flags, the divide unit's buffered operands
 * and the adaptive MFC0 SP_STATUS timeout all survive from one task to the next
 * on real hardware and here, so a rollback that restores RDRAM and DMEM but not
 * these would hand the next task the register file of a FUTURE frame.
 * Everything here is plain data (no pointers), so the blob is valid in any
 * instance of the same binary. Returns the blob size; save != 0 copies out. */
static void cxd4_blob_io(unsigned char* p, int save, void* v, size_t n)
{
    if (save) memcpy(p, v, n); else memcpy(v, p, n);
}

int neil_cxd4_state_io(unsigned char* buf, int save)
{
    size_t o = 0;
#define CXD4_IO(v) do { if (buf) cxd4_blob_io(buf + o, save, (void*)&(v), sizeof(v)); o += sizeof(v); } while (0)
    CXD4_IO(SR);
    CXD4_IO(VR);
    CXD4_IO(VACC);
    CXD4_IO(cf_ne);
    CXD4_IO(cf_co);
    CXD4_IO(cf_clip);
    CXD4_IO(cf_comp);
    CXD4_IO(cf_vce);
    CXD4_IO(DivIn);
    CXD4_IO(DivOut);
    CXD4_IO(DPH);
    CXD4_IO(temp_PC);
    CXD4_IO(MF_SP_STATUS_TIMEOUT);
#ifdef WAIT_FOR_CPU_HOST
    CXD4_IO(MFC0_count);
#endif
#undef CXD4_IO
    return (int)o;
}

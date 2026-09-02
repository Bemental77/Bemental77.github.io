// op_census.cpp — the EXECUTED-op instrument. Host-native driver that runs the
// LIVE emitter (build_block_next) over real guest blocks and records, for each
// block, the byte range of every emit phase and of every guest instruction.
//
// WHY THIS EXISTS
// ---------------
// Every op-level number in this tree is a STATIC emitted-op count:
// `BEM_EMIT_AUDIT` (tests/test_simd_bswap.cpp:336) and `dump_block_wasm`
// (tests/test_gekko_next.cpp:2506) both dump a module and count instruction
// lines. Static size is not executed cost. Commit dd6759fb names the trap
// verbatim: psq_st's ~500-op quantized tree sits behind an `op_if` on st_type
// (jit_load_store.cpp:2116/:2173) and the FLOAT path never enters it, so a
// "536 vs 5 = 107x" reading is 10x wrong about executed work.
//
// This driver emits the byte ranges; op_census_report.py intersects them with
// `wasm-objdump -d` and the block/if/loop nesting structure, so each phase is
// reported as (unconditional ops | ops behind an if) rather than one number.
//
// FIDELITY TO THE LIVE EMIT — what matches and what does not:
//   MATCHES: the emitter itself (build_block_next, one call, same as
//     JitWasm.cpp:1134), the block-decode rule (JitWasm.cpp:983-1007), the
//     false-returning g_hle_hook_query the live build installs
//     (JitWasm.cpp:415) — without it the emitter emits frc.Flush before every
//     op and DEMOTES Single repr (the trap commit dd6759fb hit), and
//     g_bem_chain_enabled=1 so the real terminal is emitted.
//   MATCHES, CONDITIONALLY: g_bem_lc_base. It is NOT cosmetic — the in-wasm
//     write-gather-pipe arm is gated on `BEM_GP_INWASM_ARM && params.lc_base`
//     (jit_load_store.cpp:661), so emitting with lc_base=0 silently produces the
//     ALL-IMPORT shape and would misreport every WPAR store. So this driver
//     mmaps the SAB scratch window and sets lc_base for real. If the mapping
//     fails it falls back to lc_base=0 and SAYS SO on stderr — a census that
//     quietly measured the wrong shape is worse than none.
//   IRRELEVANT: the exact ctx_ptr / mem1_base values change only the LEB length
//     of baked i32.consts, never the op count. That is precisely why this
//     instrument counts OPS and not BYTES (CLAUDE.md gate #10).
//
// INPUT   argv[1] = manifest: one block per line, "PC WORD WORD ..." in hex.
// OUTPUT  argv[2] = output directory: <pc>.wasm + <pc>.marks per block.
//
// Build: see tools/build_op_census.sh.

#include "guests/powerpc-next/ppc_emit.h"
#include "guests/powerpc-next/ppc_analyst.h"

#include <cstdio>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>
#include <sys/mman.h>
#include <cerrno>

using namespace bemental;
using namespace bemental::powerpc;

extern "C" {
extern uint32_t g_bem_lc_base;
extern uint32_t g_bem_fprf_enabled;
extern uint32_t g_bem_accurate_nans;
extern unsigned char g_bem_chain_enabled;
}

// Live values. ctx_ptr is pinned at 0x02400000 (gamecube/docs/aot/A3_plan.md);
// mem1_base/mask/size are the 24 MB MEM1 window JitWasm.cpp:506-508 passes.
// Only their LEB widths depend on the exact numbers, so op counts are stable.
static constexpr uint32_t kCtxPtr   = 0x02400000u;
static constexpr uint32_t kMem1Base = 0x10000000u;
// [census-fidelity 2026-09-02] ram_size is the ALLOCATED size, not the real
// 24 MB: Memmap.cpp:100-102 sets m_ram_size = NextPowerOf2(24MB) = 32 MB and
// m_ram_mask = m_ram_size - 1, so `mem1_mask == ram_size - 1` is an INVARIANT
// of every live config. This matters because jit_load_store.cpp:239-246 elides
// the fastmem bound check on exactly that equality. The old pair here
// (mask 0x01FFFFFF, ram_size 0x01800000) broke it, so the census emitted a
// 6-op bound check on EVERY load and store that the live build never emits —
// inflating every load/store op count and the whole "guest work" total with it.
static constexpr uint32_t kMem1Mask = 0x01FFFFFFu;
static constexpr uint32_t kRamSize  = 0x02000000u;
static_assert(kMem1Mask == kRamSize - 1u,
              "census must satisfy Memmap.cpp:102's m_ram_mask = ram_size - 1, "
              "or jit_load_store.cpp:239 emits a bound check the live build elides");

// JitWasm.cpp:102
static constexpr uint32_t kMaxBlockInsts = 64u;

struct Mark { uint32_t tag, pc, off; };
static std::vector<Mark> g_marks;

static void mark_cb(u32 tag, u32 pc, u32 off) {
    g_marks.push_back(Mark{tag, pc, off});
}

int main(int argc, char** argv) {
    if (argc < 3) {
        std::fprintf(stderr, "usage: op_census <manifest> <outdir>\n");
        return 2;
    }
    std::FILE* mf = std::fopen(argv[1], "r");
    if (!mf) { std::perror("manifest"); return 2; }
    const std::string outdir = argv[2];

    // Reproduce the live emit context (JitWasm.cpp:415, block_cache.cpp).
    // The emitter reads SAB scratch cells absolutely (e.g. ppc_emit.cpp:1177's
    // 0x026B3408) whenever lc_base is set, so the window has to be real memory
    // here or the emit segfaults. Zeroed = every SAB-gated feature default-OFF,
    // which is what a cold-booted browser presents too.
#ifdef __EMSCRIPTEN__
    // WASM BUILD — the high-fidelity one, and the reason it exists. Under a
    // native macOS binary the SAB window is unmappable: with a small PAGEZERO
    // dyld lands the image at ~0x2696000 and libsystem_malloc's metadata covers
    // 0x26af000-0x26d0000, i.e. exactly 0x026B3408, so MAP_FIXED there returns
    // ENOMEM and reading it returns malloc metadata rather than a zeroed cell.
    // Linked with -sGLOBAL_BASE=0x02700000 every emcc datum sits ABOVE the
    // window, so 0x026B3xxx is untouched zero-filled linear memory — the same
    // relationship the live build has, and the same wasm target too.
    g_bem_lc_base = 0x02600000u;
    std::fprintf(stderr, "[op_census] wasm build; lc_base=0x02600000 (live shape)\n");
#else
    void* sab = mmap((void*)(uintptr_t)0x02600000u, 0x00200000u,
                     PROT_READ | PROT_WRITE,
                     MAP_PRIVATE | MAP_ANON | MAP_FIXED, -1, 0);
    if (sab == MAP_FAILED || sab != (void*)(uintptr_t)0x02600000u) {
        std::fprintf(stderr, "[op_census] mmap -> %p (errno %d: %s)\n",
                     sab, errno, std::strerror(errno));
        std::fprintf(stderr,
            "[op_census] WARNING: SAB window mmap failed -> lc_base=0. The in-wasm\n"
            "            gather-pipe arm (jit_load_store.cpp:661) will NOT be emitted,\n"
            "            so WPAR store counts in this run are the ALL-IMPORT shape and\n"
            "            do NOT match the live build. Do not report them as live.\n");
        g_bem_lc_base = 0u;
    } else {
        std::memset(sab, 0, 0x00200000u);
        g_bem_lc_base = 0x02600000u;   // any nonzero in-window value; live = GetL1Cache()
        std::fprintf(stderr, "[op_census] SAB window mapped; lc_base=0x02600000 (live shape)\n");
    }
#endif
    // [mips-gate A/B 2026-09-02] The executed-cycle meter is emit-time gated on
    // SAB cell BEM_MIPS_FLAG_CELL (ppc_emit.h) and ships OFF. Setting
    // OPCENSUS_MIPS=1 arms it here so BOTH arms of that gate can be censused —
    // and, more usefully, so the ARMED arm can be byte-compared against a
    // census taken before the gate existed. The cell lives in the SAB window
    // zeroed just above, so this is the same write gamecube.html's
    // `?bjit_mips=1` performs.
    if (const char* mv = std::getenv("OPCENSUS_MIPS")) {
        if (*mv && *mv != '0') {
            *reinterpret_cast<volatile uint32_t*>(
                static_cast<uintptr_t>(bemental::powerpc::BEM_MIPS_FLAG_CELL)) = 1u;
            std::fprintf(stderr, "[op_census] MIPS meter ARMED (cell 0x%08X = 1)\n",
                         bemental::powerpc::BEM_MIPS_FLAG_CELL);
        }
    }
    g_bem_fprf_enabled  = 0u;
    g_bem_accurate_nans = 0u;
    g_bem_chain_enabled = 1u;   // emit the real per-edge terminal
    g_hle_hook_query    = [](uint32_t) -> bool { return false; };
    g_bem_emit_mark_cb  = &mark_cb;

    char line[8192];
    unsigned n_ok = 0, n_skip = 0;
    while (std::fgets(line, sizeof line, mf)) {
        if (line[0] == '#' || line[0] == '\n') continue;
        std::vector<uint32_t> words;
        uint32_t pc = 0;
        char* save = nullptr;
        char* tok = strtok_r(line, " \t\r\n", &save);
        if (!tok) continue;
        pc = (uint32_t)strtoul(tok, nullptr, 16);
        while ((tok = strtok_r(nullptr, " \t\r\n", &save)))
            words.push_back((uint32_t)strtoul(tok, nullptr, 16));
        if (words.empty()) continue;

        // Block decode — byte-for-byte the JitWasm.cpp:983-1007 rule.
        std::vector<uint32_t> insts;
        std::vector<uint32_t> pcs;
        uint32_t cur = pc;
        for (uint32_t i = 0; i < kMaxBlockInsts && i < words.size(); ++i) {
            insts.push_back(words[i]);
            pcs.push_back(cur);
            if (IsBlockTerminator(words[i]) &&
                !IsForwardConditionalBranch(words[i], cur))
                break;
            cur += 4u;
        }
        if (insts.empty()) { ++n_skip; continue; }

        g_marks.clear();
        uint32_t cycles = 0;
        bool idle = false;
        std::vector<u8> bytes = build_block_next(
            pc, insts.data(), (u32)insts.size(), kCtxPtr,
            kMem1Base, kMem1Mask, kRamSize, &cycles, &idle, pcs.data());
        if (bytes.empty()) { ++n_skip; continue; }

        char path[1024];
        std::snprintf(path, sizeof path, "%s/%08x.wasm", outdir.c_str(), pc);
        std::FILE* wf = std::fopen(path, "wb");
        if (!wf) { std::perror(path); return 2; }
        std::fwrite(bytes.data(), 1, bytes.size(), wf);
        std::fclose(wf);

        std::snprintf(path, sizeof path, "%s/%08x.marks", outdir.c_str(), pc);
        std::FILE* kf = std::fopen(path, "w");
        if (!kf) { std::perror(path); return 2; }
        std::fprintf(kf, "# block pc=%08x n_insts=%zu cycles=%u idle=%d module_bytes=%zu\n",
                     pc, insts.size(), cycles, (int)idle, bytes.size());
        for (size_t i = 0; i < insts.size(); ++i)
            std::fprintf(kf, "inst %08x %08x\n", pcs[i], insts[i]);
        for (const Mark& m : g_marks)
            std::fprintf(kf, "mark %u %08x %u\n", m.tag, m.pc, m.off);
        std::fclose(kf);
        ++n_ok;
    }
    std::fclose(mf);
    std::fprintf(stderr, "[op_census] emitted %u blocks, skipped %u\n", n_ok, n_skip);
    return 0;
}

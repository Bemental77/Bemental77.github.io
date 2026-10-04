// block_replay.cpp — OFFLINE replay of the LIVE powerpc-next emitter on real
// guest state. No browser, no Dolphin, no probe.
//
// WHY THIS EXISTS
// ---------------
// Two questions in this tree could only be answered by the browser probe, and
// that probe is not always available to a session:
//   (1) How many wasm ops does emitted code EXECUTE per guest instruction?
//       op_census answers "how many are emitted", weighted by a PC histogram,
//       with every op behind an `if` reported as an upper bound only.
//   (2) Does an emitter change preserve guest semantics on REAL game code, not
//       just on per-instruction conformance vectors?
// This driver loads MEM1 + the PowerPC register file from a port savestate
// (gamecube/tools/gcs_extract_cpu.py), then runs guest code exactly the way
// JitWasm::Run does: decode with the JitWasm.cpp TryCompileBlock rule, emit with
// build_block_next, register through the real BlockCache, and dispatch through
// the real chain_dispatch -> bem_chain_loop_c -> in-wasm return_call_indirect
// chaining. What is NOT real: there is no CoreTiming, no interrupts, no MMIO
// device (MMIO reads return 0, writes are dropped and counted), and no
// interpreter — a block that falls back to ppc_interp STOPS the replay at that
// point (reported). Within those limits the trajectory is deterministic, which is
// what makes mode (2) work: two emitter arms that are semantically identical must
// produce bit-identical register files after every slice and a bit-identical MEM1.
//
// MODES
//   count  — instrument each module (block_replay_pre.js) and report executed
//            ops by phase/class per guest instruction.
//   trace  — no instrumentation; write one state hash per slice + final MEM1
//            hash. Diff two arms' trace files: any difference is a semantic
//            change.
//
// ARMS. Emit-time switches are SAB cells, the same cells the page writes, so an
// arm here is the same arm the live build gets: --cell ADDR=VAL (repeatable).
//
// Usage: node block_replay.js <state_dir> <mode> <max_slices> [--slice N]
//        [--cell 0xADDR=0xVAL]... [--trace-out FILE] [--stop-park]
//        [--json FILE]

#include "guests/powerpc-next/ppc_emit.h"
#include "guests/powerpc-next/ppc_analyst.h"
#include "guests/powerpc-next/ppc_offsets.h"
#include "bementalJIT/block_cache.h"

#include <cstdio>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <map>
#include <string>
#include <vector>
#include <emscripten.h>

using namespace bemental;
using namespace bemental::powerpc;

extern "C" {
extern uint32_t g_bem_lc_base;
extern uint32_t g_bem_fprf_enabled;
extern uint32_t g_bem_accurate_nans;
extern uint32_t g_bem_ni_flush;
extern unsigned char g_bem_chain_enabled;
extern int g_bem_gp_dirty;
}

static constexpr u32 kMaxBlockInsts = 64u;      // JitWasm.cpp kMaxBlockInsts
static constexpr u32 kRamSize = 0x02000000u;    // Memmap: NextPowerOf2(24MB)
static constexpr u32 kRamMask = kRamSize - 1u;
static constexpr u32 kCtxBytes = 0x1400u;

static u8* g_mem1 = nullptr;
static u8* g_ctx = nullptr;
alignas(64) static u8 g_gp_buf[1024];
alignas(8) static uint64_t g_cnt[16 + 512];
static int g_counting = 0;

// marks from the emitter (g_bem_emit_mark_cb), flat [tag, off, ...]
static std::vector<int32_t> g_marks;
static void mark_cb(u32 tag, u32 pc, u32 off) {
    g_marks.push_back((int32_t)tag);
    g_marks.push_back((int32_t)off);
    g_marks.push_back((int32_t)pc);
}

static inline u32 rd32le(const u8* p) { u32 v; std::memcpy(&v, p, 4); return v; }
static inline void wr32le(u8* p, u32 v) { std::memcpy(p, &v, 4); }
static inline u32 ctx32(u32 off) { return rd32le(g_ctx + off); }
static inline void set_ctx32(u32 off, u32 v) { wr32le(g_ctx + off, v); }

static u32 guest_read32(u32 ea) {
    if ((ea & 0x3E000000u) != 0u) return 0u;
    const u8* p = g_mem1 + (ea & kRamMask);
    return ((u32)p[0] << 24) | ((u32)p[1] << 16) | ((u32)p[2] << 8) | p[3];
}

// Instrumenter bridge: rewrite bytes in place into out (cap bytes); returns
// the new length, or -1.
EM_JS(int, replay_instrument, (const u8* src_ptr, int len, const int32_t* marks, int nmarks,
                               u8* out, int cap, uint64_t* cells, const u8* mem1), {
    const src = HEAPU8.slice(src_ptr, src_ptr + len);
    const mk = Array.from(HEAP32.subarray(marks >> 2, (marks >> 2) + nmarks));
    let r;
    try { r = Module.bemReplayInstrument(src, mk, cells, mem1); }
    catch (e) { console.error('[replay] instrument failed: ' + e.message); return -1; }
    if (r.length > cap) return -1;
    HEAPU8.set(r, out);
    return r.length;
});

// Host imports (defined in block_replay_pre.js: Module.bemReplayInstallImports).
// Big-endian guest RAM at mem1; MMIO/unknown -> 0 / dropped; no interpreter.
static void install_imports() {
    EM_ASM({ Module.bemReplayInstallImports($0 >>> 0, $1 >>> 0, $2 >>> 0, $3 >>> 0); },
           g_mem1, g_ctx, g_gp_buf, &g_bem_gp_dirty);
}

static int js_stat(const char* key) {
    return EM_ASM_INT({ return (Module.__replay[UTF8ToString($0)] | 0); }, key);
}

static BlockCache* g_cache = nullptr;
static u32 g_compiles = 0, g_compile_fail = 0;
static std::vector<u8> g_ibuf(4u << 20);

static bool compile_at(u32 start_pc) {
    std::vector<u32> insts;
    u32 pc = start_pc;
    for (u32 i = 0; i < kMaxBlockInsts; ++i) {
        const u32 inst = guest_read32(pc);
        insts.push_back(inst);
        // JitWasm.cpp TryCompileBlock decode rule, verbatim.
        if (IsBlockTerminator(inst) && !IsForwardConditionalBranch(inst, pc)) break;
        pc += 4u;
    }
    g_marks.clear();
    u32 cycles = 0;
    const u32 ctx_ptr = (u32)(uintptr_t)g_ctx;
    const u32 mem1_base = (u32)(uintptr_t)g_mem1;
    std::vector<u8> bytes = build_block_next(start_pc, insts.data(), (u32)insts.size(), ctx_ptr,
                                             mem1_base, kRamMask, kRamSize, &cycles);
    if (bytes.empty()) { ++g_compile_fail; return false; }
    const u8* use = bytes.data();
    std::size_t n = bytes.size();
    if (g_counting) {
        const int r = replay_instrument(bytes.data(), (int)bytes.size(), g_marks.data(),
                                        (int)g_marks.size(), g_ibuf.data(), (int)g_ibuf.size(),
                                        g_cnt, g_mem1);
        if (r < 0) { ++g_compile_fail; return false; }
        use = g_ibuf.data(); n = (std::size_t)r;
    }
    const int h = g_cache->compile((u64)start_pc, use, n);
    if (h < 0) { ++g_compile_fail; return false; }
    ++g_compiles;
    return true;
}

static uint64_t fnv64(const u8* p, std::size_t n, uint64_t h = 1469598103934665603ull) {
    for (std::size_t i = 0; i < n; ++i) { h ^= p[i]; h *= 1099511628211ull; }
    return h;
}

static std::vector<u8> read_file(const char* path) {
    std::vector<u8> v;
    std::FILE* f = std::fopen(path, "rb");
    if (!f) return v;
    std::fseek(f, 0, SEEK_END); long n = std::ftell(f); std::fseek(f, 0, SEEK_SET);
    v.resize((std::size_t)n);
    if (std::fread(v.data(), 1, v.size(), f) != v.size()) v.clear();
    std::fclose(f);
    return v;
}

int main(int argc, char** argv) {
    if (argc < 4) {
        std::fprintf(stderr, "usage: block_replay <state_dir> count|trace <max_slices> [opts]\n");
        return 2;
    }
    const std::string dir = argv[1];
    const std::string mode = argv[2];
    const long max_slices = std::atol(argv[3]);
    long slice = 20000;
    const char* trace_out = nullptr;
    const char* json_out = nullptr;
    bool stop_park = false;
    std::vector<std::pair<u32, u32>> cells;
    for (int i = 4; i < argc; ++i) {
        if (!std::strcmp(argv[i], "--slice") && i + 1 < argc) slice = std::atol(argv[++i]);
        else if (!std::strcmp(argv[i], "--trace-out") && i + 1 < argc) trace_out = argv[++i];
        else if (!std::strcmp(argv[i], "--json") && i + 1 < argc) json_out = argv[++i];
        else if (!std::strcmp(argv[i], "--stop-park")) stop_park = true;
        else if (!std::strcmp(argv[i], "--cell") && i + 1 < argc) {
            const char* s = argv[++i];
            const char* eq = std::strchr(s, '=');
            if (!eq) { std::fprintf(stderr, "bad --cell %s\n", s); return 2; }
            cells.push_back({(u32)std::strtoul(s, nullptr, 0), (u32)std::strtoul(eq + 1, nullptr, 0)});
        }
    }
    g_counting = (mode == "count");

    std::vector<u8> mem = read_file((dir + "/mem1.bin").c_str());
    std::vector<u8> ctx = read_file((dir + "/ctx.bin").c_str());
    if (mem.size() != kRamSize || ctx.size() != kCtxBytes) {
        std::fprintf(stderr, "[replay] bad state dir %s (mem1 %zu ctx %zu)\n", dir.c_str(),
                     mem.size(), ctx.size());
        return 2;
    }
    g_mem1 = (u8*)aligned_alloc(65536, kRamSize);
    g_ctx = (u8*)aligned_alloc(64, kCtxBytes + 0x1000);
    std::memcpy(g_mem1, mem.data(), kRamSize);
    std::memset(g_ctx, 0, kCtxBytes + 0x1000);
    std::memcpy(g_ctx, ctx.data(), kCtxBytes);
    mem.clear(); mem.shrink_to_fit();

    // Live emit context (JitWasm.cpp): lc window published, FPRF/accurate-NaN/
    // NI-flush at their shipping defaults (0), chaining on, no HLE hooks.
    // lc_base = 0x02600000 is below -sGLOBAL_BASE, i.e. zero-filled memory that
    // nothing else owns — the same choice op_census makes, for the same reason.
    g_bem_lc_base = 0x02600000u;
    g_bem_fprf_enabled = 0u;
    g_bem_accurate_nans = 0u;
    g_bem_ni_flush = 0u;
    g_bem_chain_enabled = 1u;
    g_hle_hook_query = [](uint32_t) -> bool { return false; };
    g_bem_emit_mark_cb = &mark_cb;
    for (auto& c : cells) {
        *reinterpret_cast<volatile u32*>((uintptr_t)c.first) = c.second;
        std::fprintf(stderr, "[replay] cell 0x%08X = 0x%08X\n", c.first, c.second);
    }

    // Gather pipe (PowerPCState gather_pipe_ptr / base at 0x0C / 0x10).
    set_ctx32(0x0C, (u32)(uintptr_t)g_gp_buf);
    set_ctx32(0x10, (u32)(uintptr_t)g_gp_buf);
    set_ctx32(ppc_off::EXCEPTIONS, 0u);
    install_imports();

    BlockCache cache;
    g_cache = &cache;

    std::FILE* tf = trace_out ? std::fopen(trace_out, "w") : nullptr;
    uint64_t guest_cycles = 0;
    u32 host_chains = 0, blocks_via_host = 0;
    long s = 0;
    const char* stop = "max_slices";
    u32 stop_pc = 0;
    u32 park_ring[32] = {0};
    std::map<u32, u32> end_pcs;
    for (; s < max_slices; ++s) {
        set_ctx32(ppc_off::DOWNCOUNT, (u32)slice);
        bool halted = false;
        for (;;) {
            const u32 pc = ctx32(ppc_off::PC);
            u32 final_pc = pc, trap_pc = 0;
            *reinterpret_cast<volatile u32*>((uintptr_t)0x026B38C0u) = 0u;   // JitWasm.cpp:893
            const s32 chained = cache.chain_dispatch(
                pc, 4096u, &final_pc, &trap_pc,
                reinterpret_cast<const u32*>(g_ctx + ppc_off::EXCEPTIONS),
                reinterpret_cast<const s32*>(g_ctx + ppc_off::DOWNCOUNT));
            ++host_chains;
            if (trap_pc != 0u) { stop = "trap"; stop_pc = trap_pc; halted = true; break; }
            if (chained > 0) {
                blocks_via_host += (u32)chained;
                set_ctx32(ppc_off::PC, final_pc);
                set_ctx32(ppc_off::NPC, final_pc);
                if (js_stat("interp")) { stop = "interp"; stop_pc = (u32)js_stat("interpPc"); halted = true; break; }
                if ((s32)ctx32(ppc_off::DOWNCOUNT) <= 0) break;
                continue;
            }
            if (!compile_at(pc)) { stop = "compile_fail"; stop_pc = pc; halted = true; break; }
        }
        const s32 dc = (s32)ctx32(ppc_off::DOWNCOUNT);
        guest_cycles += (uint64_t)((int64_t)slice - (int64_t)dc);
        const u32 epc = ctx32(ppc_off::PC);
        end_pcs[epc]++;
        if (tf) {
            // Everything architectural in the register file; the host-pointer
            // fields (gather pipe ptrs) and downcount are excluded.
            uint64_t h = fnv64(g_ctx + 0x000, 0x0C);
            h = fnv64(g_ctx + 0x014, ppc_off::DOWNCOUNT - 0x014, h);
            h = fnv64(g_ctx + 0x2F4, 0x1340 - 0x2F4, h);
            std::fprintf(tf, "%ld %08x %016llx %d\n", s, epc, (unsigned long long)h, dc);
        }
        if (halted) break;
        park_ring[s & 31] = epc;
        if (stop_park && s >= 64) {
            u32 distinct = 0; u32 seen[32];
            for (u32 i = 0; i < 32; ++i) {
                bool dup = false;
                for (u32 j = 0; j < distinct; ++j) if (seen[j] == park_ring[i]) { dup = true; break; }
                if (!dup) seen[distinct++] = park_ring[i];
            }
            if (distinct <= 3) { stop = "parked"; stop_pc = epc; ++s; break; }
        }
    }
    const uint64_t mem_hash = fnv64(g_mem1, kRamSize);
    const uint64_t ctx_hash = fnv64(g_ctx + 0x014, ppc_off::DOWNCOUNT - 0x014,
                                    fnv64(g_ctx + 0x000, 0x0C));
    if (tf) {
        std::fprintf(tf, "END mem1=%016llx ctx=%016llx cycles=%llu\n",
                     (unsigned long long)mem_hash, (unsigned long long)ctx_hash,
                     (unsigned long long)guest_cycles);
        std::fclose(tf);
    }

    const double gi = (double)g_cnt[12];
    const double ops = (double)(g_cnt[0] + g_cnt[1] + g_cnt[2] + g_cnt[3] + g_cnt[4] + g_cnt[15]);
    char buf[4096];
    std::snprintf(buf, sizeof buf,
        "{\"mode\":\"%s\",\"slices\":%ld,\"stop\":\"%s\",\"stop_pc\":\"0x%08x\","
        "\"guest_cycles\":%llu,\"compiles\":%u,\"compile_fail\":%u,\"host_chains\":%u,"
        "\"blocks_via_host\":%u,\"mem1_hash\":\"%016llx\",\"ctx_hash\":\"%016llx\","
        "\"guest_instrs\":%llu,\"block_entries\":%llu,\"ops_total\":%.0f,"
        "\"ops_prologue\":%llu,\"ops_bodyhead\":%llu,\"ops_guest\":%llu,\"ops_terminal\":%llu,"
        "\"ops_other\":%llu,\"ops_epilogue\":%llu,\"loads\":%llu,\"stores\":%llu,\"import_calls\":%llu,"
        "\"indirect_calls\":%llu,\"consts\":%llu,\"locals\":%llu,\"control\":%llu,"
        "\"terminal_loads\":%llu,\"ops_per_guest_instr\":%.3f,\"instrs_per_entry\":%.3f,"
        "\"mmioR\":%d,\"mmioW\":%d,\"wpar_import\":%d,\"drains\":%d,\"interp\":%d}",
        mode.c_str(), s, stop, stop_pc, (unsigned long long)guest_cycles, g_compiles,
        g_compile_fail, host_chains, blocks_via_host, (unsigned long long)mem_hash,
        (unsigned long long)ctx_hash, (unsigned long long)g_cnt[12],
        (unsigned long long)g_cnt[13], ops,
        (unsigned long long)g_cnt[0], (unsigned long long)g_cnt[1], (unsigned long long)g_cnt[2],
        (unsigned long long)g_cnt[3], (unsigned long long)g_cnt[4], (unsigned long long)g_cnt[15],
        (unsigned long long)g_cnt[5],
        (unsigned long long)g_cnt[6], (unsigned long long)g_cnt[7], (unsigned long long)g_cnt[8],
        (unsigned long long)g_cnt[9], (unsigned long long)g_cnt[10], (unsigned long long)g_cnt[11],
        (unsigned long long)g_cnt[14], gi > 0 ? ops / gi : 0.0,
        g_cnt[13] ? gi / (double)g_cnt[13] : 0.0,
        js_stat("mmioR"), js_stat("mmioW"), js_stat("wpar"), js_stat("drains"), js_stat("interp"));
    std::printf("%s\n", buf);
    if (json_out) { std::FILE* jf = std::fopen(json_out, "w"); if (jf) { std::fprintf(jf, "%s\n", buf); std::fclose(jf); } }
    std::fprintf(stderr, "[replay] slice-end PCs (top):");
    {
        std::vector<std::pair<u32, u32>> v(end_pcs.begin(), end_pcs.end());
        std::sort(v.begin(), v.end(), [](auto& a, auto& b) { return a.second > b.second; });
        for (std::size_t i = 0; i < v.size() && i < 8; ++i)
            std::fprintf(stderr, " %08x:%u", v[i].first, v[i].second);
        std::fprintf(stderr, "\n");
    }
    if (g_counting) EM_ASM({ Module.bemReplayPrintClasses($0, $1); }, g_cnt, 48);
    EM_ASM({
        const st = Module.__replay;
        console.error('[replay] host-interp fallbacks served: ' + JSON.stringify(st.fallbackOps));
        const m = Object.entries(st.mmioAddrs).sort((a, b) => b[1] - a[1]).slice(0, 12);
        console.error('[replay] MMIO (top): ' + JSON.stringify(m));
    });
    if (js_stat("interp"))
        std::fprintf(stderr, "[replay] first interp fallback pc=0x%08x inst=0x%08x\n",
                     (u32)js_stat("interpPc"), (u32)js_stat("interpInst"));
    return 0;
}

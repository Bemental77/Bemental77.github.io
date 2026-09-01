// aot_emit — offline AoT PPC->WASM driver (Task 2: "AoT-compile MP4 PPC→WASM from decomp").
//
// Feeds DOL functions (boundaries from the decomp's symbols.txt) through the SAME gekko
// emitter the runtime uses (build_region_function), producing shippable .wasm region
// modules + a pc->slot index. Removes per-region browser compile; the worker loads these
// at boot and pre-populates its dispatch map.
//
// Build (native, no emscripten):
//   clang++ -std=c++17 -O2 -o /tmp/aot_emit \
//     gamecube/tools/aot/aot_emit.cpp \
//     gamecube/bementalJIT/guests/powerpc/gekko_emit.cpp \
//     gamecube/tools/aot/aot_stubs.cpp \
//     -I gamecube/bementalJIT/include -I gamecube/bementalJIT/guests/powerpc
//
// Usage:
//   aot_emit <main.dol> <symbols.txt> <out_dir> [func_addr_hex]
//     func_addr_hex given  -> emit just that function (milestone/debug mode)
//     omitted              -> emit every .text function (bundling TBD)
//
// Emit-time constants baked into the output (loader MUST verify at init, and fall back to
// runtime compile on mismatch):
//   ctx (PowerPCState)  = 0x02400000   (SAB layout, sab_layout.h)
//   mem1_base           = 0x1A4B7498   (observed stable across all probe runs)
//   mem1_mask           = 0x01FFFFFF
//   ram_size            = 0x02000000

#include "gekko_emit.h"

#include <cstdio>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>
#include <map>
#include <set>
#include <fstream>
#include <sstream>

using bemental::powerpc::BlockInputs;
using bemental::powerpc::build_region_function;

namespace bemental::powerpc { extern bool g_aot_suppress_ras; extern bool g_aot_chain; }
extern "C" bool g_emit_retired;

static constexpr uint32_t CTX_PTR   = 0x02400000u;
// Default MEM1 base — dolphin's malloc'd arena, STABLE per dolphin build but shifts when
// dolphin-src changes sizes. Override with argv[5] (hex); the worker verifies at enable
// and falls back to runtime compile on mismatch, printing the live value to rebake with.
static uint32_t MEM1_BASE = 0x1A4B7498u;
static constexpr uint32_t MEM1_MASK = 0x01FFFFFFu;
static constexpr uint32_t RAM_SIZE  = 0x02000000u;

struct Seg { uint32_t addr; std::vector<uint8_t> bytes; };

static uint32_t be32(const uint8_t* p) {
    return (uint32_t(p[0]) << 24) | (uint32_t(p[1]) << 16) | (uint32_t(p[2]) << 8) | uint32_t(p[3]);
}

static bool load_dol(const char* path, std::vector<Seg>& segs) {
    std::ifstream f(path, std::ios::binary);
    if (!f) return false;
    std::vector<uint8_t> b((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
    if (b.size() < 0x100) return false;
    for (int i = 0; i < 7; i++) {  // text sections only
        uint32_t off  = be32(&b[0x00 + i * 4]);
        uint32_t addr = be32(&b[0x48 + i * 4]);
        uint32_t size = be32(&b[0x90 + i * 4]);
        if (!size) continue;
        if (off + size > b.size()) return false;
        segs.push_back({addr, std::vector<uint8_t>(b.begin() + off, b.begin() + off + size)});
    }
    return !segs.empty();
}

static const uint8_t* seg_read(const std::vector<Seg>& segs, uint32_t addr, uint32_t size) {
    for (const auto& s : segs)
        if (addr >= s.addr && addr + size <= s.addr + s.bytes.size())
            return s.bytes.data() + (addr - s.addr);
    return nullptr;
}

struct Func { uint32_t addr, size; std::string name; };

static void parse_symbols(const char* path, std::vector<Func>& out) {
    std::ifstream f(path);
    std::string line;
    while (std::getline(f, line)) {
        // NAME = .text:0xADDR; // type:function size:0xSIZE ...
        if (line.find("type:function") == std::string::npos) continue;
        auto eq = line.find(" = .text:0x");
        auto sz = line.find("size:0x");
        if (eq == std::string::npos || sz == std::string::npos) continue;
        Func fn;
        fn.name = line.substr(0, eq);
        fn.addr = (uint32_t)strtoul(line.c_str() + eq + 11, nullptr, 16);
        fn.size = (uint32_t)strtoul(line.c_str() + sz + 7, nullptr, 16);
        if (fn.size >= 4) out.push_back(fn);
    }
}

// Basic-block leader scan over one function. Leaders: entry, every branch
// target inside the function, every instruction after a branch.
static void split_blocks(uint32_t addr, uint32_t size, const uint8_t* code,
                         std::vector<std::pair<uint32_t, uint32_t>>& blocks /* (pc, n_insts) */) {
    const uint32_t n = size / 4;
    std::set<uint32_t> leaders;
    leaders.insert(addr);
    for (uint32_t i = 0; i < n; i++) {
        const uint32_t inst = be32(code + i * 4);
        const uint32_t pc = addr + i * 4;
        const uint32_t op = inst >> 26;
        bool is_branch = false;
        uint32_t target = 0;
        bool has_target = false;
        if (op == 18) {  // b/bl
            int32_t li = (int32_t)(inst & 0x03FFFFFC);
            if (li & 0x02000000) li -= 0x04000000;
            target = (inst & 2) ? (uint32_t)li : pc + (uint32_t)li;
            has_target = true;
            is_branch = true;
        } else if (op == 16) {  // bc
            int32_t bd = (int32_t)(inst & 0xFFFC);
            if (bd & 0x8000) bd -= 0x10000;
            target = (inst & 2) ? (uint32_t)bd : pc + (uint32_t)bd;
            has_target = true;
            is_branch = true;
        } else if (op == 19) {
            const uint32_t xo = (inst >> 1) & 0x3FF;
            if (xo == 16 || xo == 528 || xo == 50) is_branch = true;  // bclr/bcctr/rfi
        } else if (op == 17) {
            is_branch = true;  // sc
        } else if (op == 31) {
            const uint32_t xo = (inst >> 1) & 0x3FF;
            if (xo == 146) is_branch = true;  // mtmsr ends blocks (runtime convention)
        }
        if (has_target && target >= addr && target < addr + size)
            leaders.insert(target);
        if (is_branch && i + 1 < n)
            leaders.insert(pc + 4);
    }
    std::vector<uint32_t> ls(leaders.begin(), leaders.end());
    for (size_t i = 0; i < ls.size(); i++) {
        const uint32_t start = ls[i];
        const uint32_t end = (i + 1 < ls.size()) ? ls[i + 1] : addr + size;
        blocks.push_back({start, (end - start) / 4});
    }
}

int main(int argc, char** argv) {
    if (argc < 4) {
        fprintf(stderr, "usage: aot_emit <main.dol> <symbols.txt> <out_dir> [func_addr_hex]\n");
        return 2;
    }
    bemental::powerpc::g_aot_suppress_ras = true;  // host-address RAS invalid in AoT output
    bemental::powerpc::g_aot_chain = true;         // in-wasm dispatch: tail-call via env.aot_table
    g_emit_retired = true;                         // MIPS counter (SAB present at runtime)
    std::vector<Seg> segs;
    if (!load_dol(argv[1], segs)) { fprintf(stderr, "bad dol\n"); return 2; }
    std::vector<Func> funcs;
    parse_symbols(argv[2], funcs);
    fprintf(stderr, "[aot] %zu functions in symbols\n", funcs.size());
    const std::string out_dir = argv[3];
    uint32_t only = argc > 4 ? (uint32_t)strtoul(argv[4], nullptr, 16) : 0;
    if (argc > 5) MEM1_BASE = (uint32_t)strtoul(argv[5], nullptr, 16);
    fprintf(stderr, "[aot] mem1_base=0x%08x\n", MEM1_BASE);

    size_t emitted = 0, skipped = 0;
    std::vector<uint8_t> pack, func_recs, block_pcs;
    std::ofstream index(out_dir + "/aot_index.txt");
    for (const auto& fn : funcs) {
        if (only && fn.addr != only) continue;
        const uint8_t* code = seg_read(segs, fn.addr, fn.size);
        if (!code) { skipped++; continue; }

        std::vector<std::pair<uint32_t, uint32_t>> blocks;
        split_blocks(fn.addr, fn.size, code, blocks);

        // Byteswap instruction words per block.
        std::vector<std::vector<uint32_t>> insts(blocks.size());
        std::vector<std::vector<uint32_t>> pcs(blocks.size());
        std::vector<BlockInputs> bi(blocks.size());
        std::map<uint32_t, uint32_t> pc2idx;
        for (size_t i = 0; i < blocks.size(); i++) pc2idx[blocks[i].first] = (uint32_t)i;
        for (size_t i = 0; i < blocks.size(); i++) {
            const auto [pc, cnt] = blocks[i];
            insts[i].resize(cnt);
            pcs[i].resize(cnt);
            const uint8_t* p = seg_read(segs, pc, cnt * 4);
            for (uint32_t k = 0; k < cnt; k++) { insts[i][k] = be32(p + k * 4); pcs[i][k] = pc + k * 4; }
            bi[i] = {};
            bi[i].start_pc = pc;
            bi[i].insts = insts[i].data();
            bi[i].count = cnt;
            bi[i].ctx_ptr_const = CTX_PTR;
            bi[i].mem1_base = MEM1_BASE;
            bi[i].mem1_mask = MEM1_MASK;
            bi[i].ram_size = RAM_SIZE;
            bi[i].instr_pcs = pcs[i].data();
            bi[i].emit_hle_check = false;
            bi[i].block_cycles = cnt;  // 1 cycle/inst approximation (Task-3 refinement later)
        }
        auto lookup = [](const void* user, uint32_t pc, uint32_t* out) -> bool {
            const auto* m = static_cast<const std::map<uint32_t, uint32_t>*>(user);
            auto it = m->find(pc);
            if (it == m->end()) return false;
            *out = it->second;
            return true;
        };
        std::vector<uint8_t> mod = build_region_function(bi.data(), (uint32_t)bi.size(),
                                                         lookup, &pc2idx);
        if (mod.empty()) { skipped++; continue; }
        // pack: append module bytes; index: function record + flat block-pc list.
        const uint32_t offset = (uint32_t)pack.size();
        pack.insert(pack.end(), mod.begin(), mod.end());
        auto put32 = [](std::vector<uint8_t>& v, uint32_t x) {
            v.push_back(x & 0xFF); v.push_back((x >> 8) & 0xFF);
            v.push_back((x >> 16) & 0xFF); v.push_back((x >> 24) & 0xFF);
        };
        put32(func_recs, fn.addr);
        put32(func_recs, offset);
        put32(func_recs, (uint32_t)mod.size());
        put32(func_recs, (uint32_t)(block_pcs.size() / 4));  // first block index
        put32(func_recs, (uint32_t)blocks.size());
        for (const auto& [bpc, cnt] : blocks) put32(block_pcs, bpc);
        index << std::hex << fn.addr << " " << std::dec << blocks.size() << " " << fn.name << "\n";
        emitted++;
        if (only)
            fprintf(stderr, "[aot] %s @0x%08x: %zu blocks -> %zu bytes\n",
                    fn.name.c_str(), fn.addr, blocks.size(), mod.size());
    }
    // aot_pack.bin = concatenated wasm modules.
    // aot_funcs.bin = 5x u32 LE per function: [addr, pack_offset, size, first_block_idx, n_blocks]
    // aot_blocks.bin = flat u32 LE block-start pcs; entry_sel for a pc = its position within
    //                  the owning function's slice.
    { std::ofstream o(out_dir + "/aot_pack.bin", std::ios::binary);
      o.write((const char*)pack.data(), (std::streamsize)pack.size()); }
    { std::ofstream o(out_dir + "/aot_funcs.bin", std::ios::binary);
      o.write((const char*)func_recs.data(), (std::streamsize)func_recs.size()); }
    { std::ofstream o(out_dir + "/aot_blocks.bin", std::ios::binary);
      o.write((const char*)block_pcs.data(), (std::streamsize)block_pcs.size()); }
    fprintf(stderr, "[aot] emitted=%zu skipped=%zu pack=%zuB funcs=%zuB blocks=%zuB\n",
            emitted, skipped, pack.size(), func_recs.size(), block_pcs.size());
    return emitted ? 0 : 1;
}

// test_perf_t1.cpp — T1 microkernel performance harness for bementalJIT.
//
// Loads each T1 kernel into a fake guest memory image, runs it through the
// bementalJIT block-cache + dispatch loop standalone (no Dolphin HW), and
// reports a [wild-perf t1<x>] line per kernel: native_ratio against the
// reference 486 MHz Gekko CPU.
//
// Acceptance gate per feedback_native_speed_acceptance.md:
//   each T1 kernel sustains native_ratio >= 1.0
//
// Measurement protocol:
//   - WARMUP_CALLS invocations to populate block cache + let V8 see the code
//   - measurement loop runs until WALL_BUDGET_MS elapsed
//   - native_ratio = (calls * inner_count * ref_cycles) / (wall_s * 486M)
//
// Standalone harness — does NOT depend on Dolphin HW emulation. Measures
// ppc-emit + block-cache + (when wired) compile-pool in isolation.

#include "bementalJIT/bemental.h"
#include "bementalJIT/perf_counters.h"
#include "bementalJIT/perf_runtime.h"
#include "guests/powerpc/gekko_emit.h"
#include "perf_t1_kernels.h"

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <unordered_set>
#include <vector>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#endif

using namespace bemental;
using namespace bemental::powerpc;
using namespace bemental::perf;

// ---------- Configuration --------------------------------------------------
static constexpr u32 GUEST_MEM_BASE = 0x80000000;
static constexpr u32 GUEST_MEM_SIZE = 0x00400000;   // 4 MiB
static constexpr u32 STACK_TOP      = 0x80300000;
static constexpr u32 SENTINEL_LR    = 0xDEADBEEF;   // kernel-done marker
static constexpr u32 WARMUP_CALLS   = 50;
static constexpr u32 WALL_BUDGET_MS = 5000;          // per-kernel measurement window

// ---------- Reporting ------------------------------------------------------
static void emit_perf_line(const char* test_id, u32 calls, u64 inner_total,
                           u32 ref_cycles_per_iter, double wall_seconds,
                           u64 dBlockEmit) {
    const double guest_cycles = static_cast<double>(inner_total) * ref_cycles_per_iter;
    const double native_hz    = 486'000'000.0;
    const double ratio        = guest_cycles / (wall_seconds * native_hz);
    char buf[320];
    std::snprintf(buf, sizeof(buf),
                  "[wild-perf %s] calls=%u inner=%llu cycles=%.0f wall=%.3fs "
                  "ratio=%.4f block_emit=%llu",
                  test_id, calls,
                  static_cast<unsigned long long>(inner_total),
                  guest_cycles, wall_seconds, ratio,
                  static_cast<unsigned long long>(dBlockEmit));
    std::printf("%s\n", buf);
#ifdef __EMSCRIPTEN__
    EM_ASM({ console.log(UTF8ToString($0)); }, buf);
#endif
}

// ---------- Block walker ---------------------------------------------------
// Decode forward from pc through guest memory, stopping at the first block
// terminator. Returns instruction count; *out_inst is filled with up to 64
// instructions. Mirrors the JitWasm IsBlockTerminator predicate: opcodes
// 16 (bc), 17 (sc), 18 (b), 19 (bclr/bcctr).
static u32 decode_block(const u32* guest_mem, u32 pc, u32* out_inst, u32 max_inst) {
    const u32 base_word_idx = (pc - GUEST_MEM_BASE) / 4u;
    u32 i = 0;
    for (; i < max_inst; ++i) {
        const u32 inst = guest_mem[base_word_idx + i];
        out_inst[i] = inst;
        const u32 op = (inst >> 26) & 0x3Fu;
        if (op == 16 || op == 17 || op == 18 || op == 19) {
            ++i;
            break;
        }
    }
    return i;
}

// ---------- Per-kernel harness state --------------------------------------
struct Harness {
    void*       ctx_raw   = nullptr;
    u32         ctx_ptr   = 0;
    u32*        guest_mem = nullptr;
    BlockCache  cache;

    bool init() {
        constexpr u32 CTX_BYTES = 0x400;
        ctx_raw = std::calloc(1, CTX_BYTES);
        if (!ctx_raw) return false;
        ctx_ptr   = static_cast<u32>(reinterpret_cast<uintptr_t>(ctx_raw));
        guest_mem = static_cast<u32*>(std::calloc(GUEST_MEM_SIZE / 4u, 4u));
        if (!guest_mem) return false;
#ifdef __EMSCRIPTEN__
        // Publish guest_mem host address to the JS import stubs so memory
        // ops on guest addresses route to the right host-side buffer.
        const u32 mem1_host = static_cast<u32>(reinterpret_cast<uintptr_t>(guest_mem));
        EM_ASM({ Module._t1_mem1_host = $0; }, mem1_host);
#endif
        return true;
    }
    ~Harness() {
        if (ctx_raw)   std::free(ctx_raw);
        if (guest_mem) std::free(guest_mem);
    }

    u32& gpr(u32 i) { return *reinterpret_cast<u32*>(static_cast<u8*>(ctx_raw) + ppc_off::gpr(i)); }
    u32& spr(u32 i) { return *reinterpret_cast<u32*>(static_cast<u8*>(ctx_raw) + ppc_off::spr(i)); }

    void load_kernel(const T1Kernel& k) {
        const u32 word_idx = (k.load_pc - GUEST_MEM_BASE) / 4u;
        std::memcpy(&guest_mem[word_idx], k.insts, k.inst_count * 4u);
    }

    // Compile (lazily) and dispatch starting at start_pc. Continues following
    // next_pc until the kernel returns to SENTINEL_LR. Returns true on
    // successful kernel completion.
    bool run_until_sentinel(u32 start_pc) {
        u32 pc = start_pc;
        // Cap at >2M because T1e has inner_count=1,048,576 and each bdnz
        // iteration is one block dispatch.
        for (int safety = 0; safety < 4'000'000; ++safety) {
            if (pc == SENTINEL_LR) return true;
            if (cache.lookup(pc) < 0) {
                u32 insts[64];
                u32 count = decode_block(guest_mem, pc, insts, 64);
                if (count == 0) {
                    std::fprintf(stderr, "[t1-fail] decode_block count=0 at pc=0x%08x\n", pc);
                    return false;
                }
                std::vector<u32> instr_pcs(count);
                for (u32 i = 0; i < count; ++i) instr_pcs[i] = pc + i * 4u;
                const u32 host_mem1_base =
                    static_cast<u32>(reinterpret_cast<std::uintptr_t>(guest_mem));
                std::vector<u8> bytes = build_block(
                    pc, insts, count, ctx_ptr,
                    /*mem_pages=*/0,
                    /*mem1_base=*/host_mem1_base,
                    /*mem1_mask=*/GUEST_MEM_SIZE - 1u,
                    /*ram_size=*/GUEST_MEM_SIZE,
                    instr_pcs.data());
                if (cache.compile(pc, bytes.data(), bytes.size()) < 0) {
                    std::fprintf(stderr, "[t1-fail] cache.compile failed at pc=0x%08x count=%u\n", pc, count);
                    return false;
                }
            }
            s32 next_pc = 0;
            if (!cache.dispatch(pc, &next_pc)) {
                std::fprintf(stderr, "[t1-fail] dispatch returned false at pc=0x%08x\n", pc);
                return false;
            }
            // next_pc is a u32 guest address packed into an s32 return slot;
            // PCs >= 0x80000000 appear "negative" — that's normal, not a fault.
            // BlockCache::dispatch has already filtered the INT32_MIN trap.
            pc = static_cast<u32>(next_pc);
        }
        std::fprintf(stderr, "[t1-fail] safety cap hit, last pc=0x%08x\n", pc);
        return false;
    }
};

// ---------- Run one kernel through the WARMUP+MEASURE protocol ------------
static bool run_one_kernel(const T1Kernel& k) {
    Harness h;
    if (!h.init()) {
        std::fprintf(stderr, "[wild-perf %s] init failed\n", k.id);
        return false;
    }
    h.load_kernel(k);

    // Warmup — populate block cache. Reset state each invocation.
    for (u32 i = 0; i < WARMUP_CALLS; ++i) {
        h.gpr(1) = STACK_TOP - 256u;       // stack pointer (room for callees)
        h.gpr(3) = k.inner_count;
        h.spr(8) = SENTINEL_LR;            // lr = kernel-done marker
        if (!h.run_until_sentinel(k.load_pc)) {
            std::fprintf(stderr, "[wild-perf %s] warmup invocation %u failed\n", k.id, i);
            return false;
        }
    }

    // Measure
    using clock = std::chrono::steady_clock;
    const auto snap_before = perf_runtime::snapshot();
    const auto t0 = clock::now();
    u32 calls = 0;
    u64 inner_total = 0;
    while (true) {
        h.gpr(1) = STACK_TOP - 256u;
        h.gpr(3) = k.inner_count;
        h.spr(8) = SENTINEL_LR;
        if (!h.run_until_sentinel(k.load_pc)) {
            std::fprintf(stderr, "[wild-perf %s] measure invocation %u failed\n", k.id, calls);
            return false;
        }
        ++calls;
        inner_total += k.inner_count;
        const auto elapsed_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
            clock::now() - t0).count();
        if (elapsed_ms >= WALL_BUDGET_MS) break;
    }
    const auto t1 = clock::now();
    const double wall_s = std::chrono::duration<double>(t1 - t0).count();
    const auto snap_after = perf_runtime::snapshot();
    const u64 dBlockEmit = snap_after[PERF_SLOT_BLOCK_EMIT] - snap_before[PERF_SLOT_BLOCK_EMIT];

    emit_perf_line(k.id, calls, inner_total, k.ref_cycles_per_iter, wall_s, dBlockEmit);
    return true;
}

// ---------- main ----------------------------------------------------------
int main() {
#ifdef __EMSCRIPTEN__
    // The JIT-emitted block module imports 9 host functions; even kernels
    // that don't touch memory need stubs bound or WebAssembly.Instance
    // throws on construction. Mirrors test_gekko's standalone setup.
    EM_ASM({
        if (!Module.bemental_imports) Module.bemental_imports = { env: {} };
        const env = Module.bemental_imports.env;
        env.ppc_read8       = function(addr) {
            return (Module.HEAPU8[addr - 0x80000000 + Module._t1_mem1_host] | 0);
        };
        env.ppc_read16      = function(addr) {
            const off = (addr - 0x80000000 + Module._t1_mem1_host) | 0;
            return (Module.HEAPU16[off >> 1] | 0);
        };
        env.ppc_read32      = function(addr) {
            const off = (addr - 0x80000000 + Module._t1_mem1_host) | 0;
            return (Module.HEAPU32[off >> 2] | 0);
        };
        env.ppc_write8      = function(addr, val) {
            Module.HEAPU8[addr - 0x80000000 + Module._t1_mem1_host] = val & 0xFF;
        };
        env.ppc_write16     = function(addr, val) {
            const off = (addr - 0x80000000 + Module._t1_mem1_host) | 0;
            Module.HEAPU16[off >> 1] = val & 0xFFFF;
        };
        env.ppc_write32     = function(addr, val) {
            const off = (addr - 0x80000000 + Module._t1_mem1_host) | 0;
            Module.HEAPU32[off >> 2] = val | 0;
        };
        env.ppc_interp      = function(inst, pc) {};
        env.ppc_check_exc   = function(pc) { return 0; };
        env.ppc_break_block = function(pc, _) {};
        env.ppc_hle_check   = function(pc) { return 0; };
    });
#endif
    int failed = 0;
    for (u32 i = 0; i < kAllCount; ++i) {
        if (!run_one_kernel(*kAll[i])) ++failed;
    }
    std::printf("[wild-perf summary] %u/%u kernels ran; %d failed\n",
                kAllCount, kAllCount, failed);
    return failed == 0 ? 0 : 1;
}

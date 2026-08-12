// aot_merge.cpp — [AOT A3.1] the whole-function merged compiler.
//
// Emits a leaf guest function as ONE wasm $region module via
// build_region_function_next_merged (ppc_emit.cpp): the intra-region edges are
// V8 jumps + warm GPR residency — the fps mechanism per-block A1 could not reach.
// This is the crux de-risk: prove the runtime merged emitter is DRIVABLE OFFLINE
// (emit-time needs only block descriptors + gen_idx + blr_chain_addr) and yields
// a structurally VALID module.
//
// Pipeline: decode the function into blocks by a CFG walk (JitWasm terminator
// logic, address-keyed) -> RegionBlockDesc[] -> build_region_function_next_merged
// -> write the module. Node validates it (WebAssembly.validate) in build_aot.sh.
//
// A3.1 opens on HandleReverb (scalar-FP, no paired-single arms) so the merged
// singles-arm-loss precondition doesn't apply yet.

#include "bementalJIT/region_desc.h"
#include "guests/powerpc-next/ppc_emit.h"
#include "guests/powerpc-next/ppc_analyst.h"

#include <cstdio>
#include <cstdint>
#include <cstdlib>
#include <vector>
#include <map>
#include <set>

#include "handlereverb_words.h"   // kHandleReverb[], kHandleReverbEntry

using namespace bemental;
using namespace bemental::powerpc;

extern "C" { extern uint32_t g_bem_lc_base; extern uint32_t g_bem_aot_count_fnk; }
// g_hle_hook_query is bemental::powerpc::g_hle_hook_query (via using namespace) — not extern "C".

// --- PPC branch-target decode (for the CFG walk) ---
static bool is_bl(uint32_t w)   { return (w >> 26) == 18u && (w & 1u); }       // branch-and-link
static bool is_b(uint32_t w)    { return (w >> 26) == 18u && !(w & 1u); }      // unconditional branch
static bool is_bc(uint32_t w)   { return (w >> 26) == 16u; }                   // conditional branch (bc/bdnz/…)
static bool is_blr(uint32_t w)  { return w == 0x4e800020u; }                   // blr
static bool is_bctr_like(uint32_t w) { return (w >> 26) == 19u && ((w >> 1) & 0x3FFu) == 528u; } // bcctr

static int32_t sext(uint32_t v, int bits) {
  const uint32_t m = 1u << (bits - 1);
  return (int32_t)((v ^ m) - m);
}
// target of a b/bc at pc, or 0 if absolute/computed/none
static uint32_t branch_target(uint32_t w, uint32_t pc) {
  if ((w & 2u) != 0u) return 0u;  // AA (absolute) — not used intra-function here
  if (is_b(w) || is_bl(w))  return pc + (uint32_t)(sext(w & 0x03FFFFFCu, 26));
  if (is_bc(w))             return pc + (uint32_t)(sext(w & 0x0000FFFCu, 16));
  return 0u;
}

int main(int argc, char** argv) {
  const uint32_t ctx_ptr = (argc > 1) ? (uint32_t)strtoul(argv[1], nullptr, 0) : 0x02400000u;
  const char* out_path   = (argc > 2) ? argv[2] : "handlereverb.wasm";

  const uint32_t entry = kHandleReverbEntry;
  const uint32_t n_words = (uint32_t)(sizeof(kHandleReverb) / sizeof(kHandleReverb[0]));
  const uint32_t end = entry + n_words * 4u;
  auto at = [&](uint32_t pc) -> uint32_t {
    const uint32_t i = (pc - entry) >> 2; return (i < n_words) ? kHandleReverb[i] : 0u;
  };
  const bool in_fn = [&](uint32_t pc){ return pc >= entry && pc < end; }(entry);
  (void)in_fn;

  // Match the golden/live emit context (see aot_compile.cpp): un-hooked PCs skip
  // the HLE prologue; HandleReverb is scalar-FP so lc_base=0 (no singles spec).
  g_hle_hook_query = [](uint32_t) -> bool { return false; };
  g_bem_lc_base = 0u;
  g_bem_aot_count_fnk = 1u;   // emit the fn_k proof-of-run counter into the AOT asset

  // --- block starts: entry + EVERY internal branch target (forward conditionals
  // coalesce mid-block, but their TAKEN target is still a block start the merged
  // edge must reach) + the fall-through past every unconditional terminator. ---
  std::set<uint32_t> starts_set;
  starts_set.insert(entry);
  for (uint32_t pc = entry; pc < end; pc += 4u) {
    const uint32_t w = at(pc);
    if (is_bctr_like(w)) {
      std::fprintf(stderr, "[aot-merge] computed bctr at 0x%08x — jump table unsupported (HandleReverb has none)\n", pc);
      return 3;
    }
    if (is_b(w) || is_bc(w) || is_bl(w)) {
      const uint32_t t = branch_target(w, pc);
      if (t >= entry && t < end) starts_set.insert(t);
    }
    // instruction after an UNCONDITIONAL terminator begins a new block (if reached
    // at all it's via a branch, but seed it so straight-line-after-b is covered).
    if ((is_b(w) || is_blr(w)) && pc + 4u < end) starts_set.insert(pc + 4u);
  }
  // decode each start until its terminator (coalescing forward conditionals).
  std::map<uint32_t, uint32_t> block_count;
  for (uint32_t s : starts_set) {
    uint32_t pc = s, count = 0;
    for (; pc < end; pc += 4u) {
      const uint32_t w = at(pc);
      ++count;
      if (IsBlockTerminator(w) && !IsForwardConditionalBranch(w, pc)) break;
    }
    block_count[s] = count;
  }

  // --- order blocks: entry first, rest by PC (block k <-> fn_k) ---
  std::vector<uint32_t> starts;
  starts.push_back(entry);
  for (auto& kv : block_count) if (kv.first != entry) starts.push_back(kv.first);

  std::vector<RegionBlockDesc> descs(starts.size());
  for (size_t k = 0; k < starts.size(); ++k) {
    const uint32_t s = starts[k];
    descs[k].start_pc  = s;
    descs[k].insts     = &kHandleReverb[(s - entry) >> 2];
    descs[k].count     = block_count[s];
    descs[k].ctx_ptr   = ctx_ptr;
    descs[k].mem1_base = 0u;      // slowmem (address-independent)
    descs[k].mem1_mask = 0u;
    descs[k].ram_size  = 0u;
  }
  std::printf("[aot-merge] HandleReverb @0x%08x: %zu blocks discovered\n", entry, starts.size());

  // --- emit the merged $region module ---
  const uint32_t gen_idx = 0xA07u;                 // reserved AOT gen
  const uint32_t blr_chain_addr = 0x026B3500u;     // placeholder (module validity is addr-independent)
  std::vector<uint8_t> mod = build_region_function_next_merged(
      descs.data(), (uint32_t)descs.size(), gen_idx, blr_chain_addr, /*mem_pages=*/1u);

  const bool ok = mod.size() >= 8 && mod[0] == 0x00 && mod[1] == 0x61 && mod[2] == 0x73 && mod[3] == 0x6D;
  std::printf("[aot-merge] merged module: %zu bytes, wasm-magic=%s\n", mod.size(), ok ? "OK" : "BAD");
  if (!ok) return 2;

  // --- write the v3 MERGED asset the AOT loader seals as a pre-built gen ---
  // Format: "BJAOTM\0" | ver=3 u32 | baked_ctx u32 | gen_idx u32 | n_blocks u32
  //   | n_blocks*(pc u32, gspan u32, ghash u32)   [fn_k order; ghash authenticates guest code]
  //   | module_len u32 | module bytes
  auto put32 = [](std::vector<uint8_t>& v, uint32_t x) {
    v.push_back(x & 0xFF); v.push_back((x >> 8) & 0xFF); v.push_back((x >> 16) & 0xFF); v.push_back((x >> 24) & 0xFF);
  };
  std::vector<uint8_t> asset;
  const char magic[7] = {'B','J','A','O','T','M','\0'};
  asset.insert(asset.end(), magic, magic + 7);
  put32(asset, 3u);
  put32(asset, ctx_ptr);
  put32(asset, gen_idx);
  put32(asset, (uint32_t)descs.size());
  for (const RegionBlockDesc& d : descs) {
    uint32_t h = 0x811c9dc5u;   // FNV-1a over the block's guest words (== loader's AotGuestHash)
    for (uint32_t j = 0; j < d.count; ++j) { const uint32_t gw = d.insts[j]; for (int k = 0; k < 4; ++k) { h ^= (gw >> (8 * k)) & 0xFFu; h *= 0x01000193u; } }
    put32(asset, d.start_pc); put32(asset, d.count); put32(asset, h);
  }
  put32(asset, (uint32_t)mod.size());
  asset.insert(asset.end(), mod.begin(), mod.end());

  FILE* f = std::fopen(out_path, "wb");
  if (!f) { std::perror("fopen"); return 1; }
  std::fwrite(asset.data(), 1, asset.size(), f);
  std::fclose(f);
  std::printf("[aot-merge] wrote %s: %zu-byte asset (%zu blocks + %zu-byte module, gen=0x%x, ctx=0x%08x)\n",
              out_path, asset.size(), descs.size(), mod.size(), gen_idx, ctx_ptr);
  return 0;
}

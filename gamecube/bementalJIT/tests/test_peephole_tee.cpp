// test_peephole_tee.cpp — WasmModuleBuilder's set/get -> tee peephole
// (powerpc-next lever bit21, BEM_LEVER_SET_GET_TEE).
//
// `local.set X; local.get X` with no instruction between is `local.tee X`: the
// same local write, the same value left on the stack. The rewrite must fire
// ONLY for that exact adjacency and index, fire once per set (a second get is a
// real get), keep multi-byte LEB indices intact, never move a byte, and do
// nothing with the peephole off. Byte-exact expectations, written by hand.
//
// Run: node test_peephole_tee.js  (exit 0 = PASS)

#include "bementalJIT/wasm_module_builder.h"

#include <cstdio>
#include <vector>

static int g_fail = 0, g_n = 0;
static void expect_bytes(const char* what, const WasmModuleBuilder& b, std::vector<u8> want) {
    ++g_n;
    const bool ok = b.getBytes() == want;
    if (!ok) ++g_fail;
    std::printf("[%s] %s:", ok ? "PASS" : "FAIL", what);
    for (u8 x : b.getBytes()) std::printf(" %02x", x);
    std::printf("\n");
}

int main() {
    { WasmModuleBuilder b; b.setPeepholeTee(true);
      b.op_local_set(3); b.op_local_get(3);
      expect_bytes("set 3; get 3 -> tee 3", b, {0x22, 0x03}); }
    { WasmModuleBuilder b; b.setPeepholeTee(true);
      b.op_local_set(3); b.op_local_get(4);
      expect_bytes("set 3; get 4 unchanged", b, {0x21, 0x03, 0x20, 0x04}); }
    { WasmModuleBuilder b; b.setPeepholeTee(true);
      b.op_local_set(3); b.op_i32_const(1); b.op_drop(); b.op_local_get(3);
      expect_bytes("set 3; const; drop; get 3 unchanged", b,
                   {0x21, 0x03, 0x41, 0x01, 0x1A, 0x20, 0x03}); }
    { WasmModuleBuilder b; b.setPeepholeTee(true);
      b.op_local_set(3); b.op_local_get(3); b.op_local_get(3);
      expect_bytes("set 3; get 3; get 3 -> tee 3; get 3", b, {0x22, 0x03, 0x20, 0x03}); }
    { WasmModuleBuilder b; b.setPeepholeTee(true);
      b.op_local_set(152); b.op_local_get(152);
      expect_bytes("set 152; get 152 -> tee 152 (2-byte LEB)", b, {0x22, 0x98, 0x01}); }
    { WasmModuleBuilder b;
      b.op_local_set(3); b.op_local_get(3);
      expect_bytes("peephole off: unchanged", b, {0x21, 0x03, 0x20, 0x03}); }
    { WasmModuleBuilder b; b.setPeepholeTee(true);
      b.op_local_tee(3); b.op_local_get(3);
      expect_bytes("tee 3; get 3 unchanged", b, {0x22, 0x03, 0x20, 0x03}); }
    { WasmModuleBuilder b; b.setPeepholeTee(true);
      b.op_local_set(3); b.op_end(); b.op_local_get(3);
      expect_bytes("set 3; end; get 3 unchanged", b, {0x21, 0x03, 0x0B, 0x20, 0x03}); }
    { WasmModuleBuilder b; b.setPeepholeTee(true);
      b.op_local_set(3); b.op_local_set(4); b.op_local_get(3);
      expect_bytes("set 3; set 4; get 3 unchanged", b, {0x21, 0x03, 0x21, 0x04, 0x20, 0x03}); }
    std::printf("[%s] TOTAL %d/%d checks\n", g_fail ? "FAIL" : "PASS", g_n - g_fail, g_n);
    return g_fail ? 1 : 0;
}

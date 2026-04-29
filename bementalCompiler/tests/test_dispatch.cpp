// test_dispatch.cpp — end-to-end dispatch test for bementalCompiler.
//
// Builds a hand-rolled WASM module:
//   (module (func (export "run") (result i32) (i32.const 5)))
// using WasmModuleBuilder, compiles + instantiates it via BlockCache, then
// dispatches and asserts the return value is 5. No guest emitter involved —
// proves the entire builder + dispatch pipeline before any guest work.

#include "bementalCompiler/bemental.h"

#include <cstdio>
#include <vector>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#endif

static std::vector<u8> build_return_five() {
    WasmModuleBuilder b;

    b.emitHeader();

    // Type section: 1 type, () -> i32
    b.emitTypeSection(1);
    {
        const u8 results[] = { WASM_TYPE_I32 };
        b.emitFuncType(nullptr, 0, results, 1);
    }
    b.endSection();

    // Function section: 1 function of type 0
    {
        const u32 typeIdx[] = { 0 };
        b.emitFunctionSection(1, typeIdx);
    }

    // Export section: export func 0 as "run"
    b.emitExportSection("run", 0);

    // Code section: 1 function body — no locals, return i32 const 5.
    b.beginCodeSection(1);
    b.beginFuncBody();
    b.emitLEB128(0);            // 0 local groups
    b.op_i32_const(5);
    b.endFuncBody();
    b.endSection();

    return b.getBytes();
}

static void report(const char* line, bool pass) {
    std::printf("%s %s\n", pass ? "[PASS]" : "[FAIL]", line);
#ifdef __EMSCRIPTEN__
    EM_ASM({
        const msg  = UTF8ToString($0);
        const pass = $1;
        if (typeof document === 'undefined') return;
        let pre = document.getElementById('bemental-out');
        if (!pre) {
            pre = document.createElement('pre');
            pre.id = 'bemental-out';
            pre.style.cssText = 'font: 14px ui-monospace, Menlo, monospace; padding: 16px;';
            document.body.appendChild(pre);
        }
        const tag = pass ? '[PASS] ' : '[FAIL] ';
        pre.textContent += tag + msg + '\n';
    }, line, pass ? 1 : 0);
#endif
}

int main() {
    std::vector<u8> bytes = build_return_five();
    std::printf("[info] built WASM module: %zu bytes\n", bytes.size());

    bemental::BlockCache cache;

    int handle = cache.compile(/*key=*/0xDEADBEEF, bytes.data(), bytes.size());
    if (handle < 0) {
        report("compile failed (handle < 0)", false);
        return 1;
    }
    char buf[64];
    std::snprintf(buf, sizeof(buf), "compile ok (handle=%d, cache size=%zu)",
                  handle, cache.size());
    report(buf, true);

    if (cache.lookup(0xDEADBEEF) != handle) {
        report("lookup mismatch", false);
        return 1;
    }
    report("lookup ok", true);

    s32 out = -1;
    if (!cache.dispatch(0xDEADBEEF, &out)) {
        report("dispatch returned false (key not cached?)", false);
        return 1;
    }
    std::snprintf(buf, sizeof(buf), "dispatch ok, run() returned %d (expected 5)", out);
    report(buf, out == 5);

    cache.evict(0xDEADBEEF);
    if (cache.lookup(0xDEADBEEF) != -1) {
        report("evict failed (key still present)", false);
        return 1;
    }
    report("evict ok", true);

    return out == 5 ? 0 : 1;
}

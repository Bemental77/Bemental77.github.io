// test_sh4_dispatch.cpp — minimal seam smoke test for the SH4 emitter.
//
// RuntimeBlockInfo carries enough Flycast dependencies that constructing one
// host-side would drag in blockmanager.cpp and friends. The current seam
// supports a null-block path that produces a valid empty WASM module — that
// is what this test exercises. Once a stand-alone test fixture for
// RuntimeBlockInfo lands (or the Flycast deps get sliced), expand this to
// cover BET_CLS_Static / Dynamic / COND emitBlockExit branches.

#include "wasm_emit.h"

#include <cstdio>
#include <cstdlib>
#include <vector>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#endif

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
    std::vector<u8> bytes = bemental::sh4::build_block(nullptr);
    std::printf("[info] built SH4 WASM module: %zu bytes\n", bytes.size());

    bool magic_ok = bytes.size() >= 8
        && bytes[0] == 0x00 && bytes[1] == 0x61 && bytes[2] == 0x73 && bytes[3] == 0x6D
        && bytes[4] == 0x01 && bytes[5] == 0x00 && bytes[6] == 0x00 && bytes[7] == 0x00;
    report("module header is \\0asm\\1\\0\\0\\0", magic_ok);

    return magic_ok ? 0 : 1;
}

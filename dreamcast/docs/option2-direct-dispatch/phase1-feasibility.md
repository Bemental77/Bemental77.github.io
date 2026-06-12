# Phase 1 — Feasibility: Emscripten dynamic linking for direct SH4 block dispatch

## Context

Dreamcast SH4 emulator currently dispatches compiled blocks via
`C++ → EM_JS → JS dispatcher → wasm fn`. Measured per-block overhead ≈100 μs.
Each compiled block is wrapped in its own `WebAssembly.Module`/`Instance`
(see `dreamcast/flycast-bridge/flycast_worker_funcs.js:104-188` —
`flycast_register_block`, `flycast_install_epoch`, `flycast_run_block`),
and the per-dispatch call site is the EM_JS shim
`wasm_dispatcher_run_block` in `dreamcast/flycast-bridge/rec_wasm.cpp:96-103`.

Target of Option 2: kill the JS hop with a C-side function pointer obtained
via `dlsym()` against a side module, so the SH4 fetch loop just does
`pc = ((blk_fn)tbl[idx])(ctx, ram_base)`.

Current link flags relevant to this question
(`dreamcast/flycast-bridge/flycast_worker_link.sh:160-226`):
- `-pthread`
- `-sIMPORTED_MEMORY=1` (implied by `-pthread`)
- `-sALLOW_MEMORY_GROWTH=1`
- `-sASYNCIFY=1`
- `-sMODULARIZE=1`, `-sEXPORT_NAME=flycastWorkerModule`
- `-sENVIRONMENT=worker`
- `-sPTHREAD_POOL_SIZE=8`
- `-O3`, `-fexceptions`
- emscripten 3.1.67 (per the `transferredCanvasNames` workaround comment)

---

## 1. Verdict

**Unknown — needs spike build.** Compatibility is documented as
"experimental but supported" for every individual flag combination we use,
but Emscripten's tracker has multiple unresolved correctness bugs in
`MAIN_MODULE + pthread + dlopen + ASYNCIFY`, and — crucially — even if
dlopen works, the dispatch cost is bounded below by V8's documented
cross-instance `call_indirect` deopt (no speculative inlining across
`WebAssembly.Instance` boundaries). That deopt is the same wall the
existing per-block-module path already hits. So even a working dlopen
build may not approach the ~50 ns "direct call" target.

Two questions only a spike build can answer:
- does our exact flag stack link + load without abort? (Section 8)
- with a hot loop calling a `dlsym`'d block, what is `time/iteration`
  on V8? (Section 6 go/no-go)

If the spike answers both favorably we proceed. If either fails, kill
criteria below apply.

---

## 2. Compatibility matrix

Each row is a flag/feature we use × dlopen support level × citation.

| Feature | Works with dlopen? | Notes |
|---|---|---|
| `-pthread` (PTHREADS) | Experimental, supported with caveats | Official docs label dynamic-linking-plus-pthreads experimental; emcc prints a warning when both are set. See `library_dylink.js` lines 736-858 (`#if PTHREADS` branches in `postInstantiation` + `sharedModules` cache). [emscripten.org/docs/porting/pthreads.html](https://emscripten.org/docs/porting/pthreads.html) |
| `-sSHARED_MEMORY=1` / `-sIMPORTED_MEMORY=1` | Yes, implicitly | `-pthread` implies both. `IMPORTED_MEMORY` is required for `-pthread`, `RELOCATABLE` (auto-set by MAIN/SIDE_MODULE), and `ASYNCIFY_LAZY_LOAD_CODE` (settings.js:2095-2105). Side modules import the main module's `WebAssembly.Memory` — no separate memory is created. |
| `-sASYNCIFY=1` | Partially — open bug #13049 | `_dlopen_js__async: true` is wired in `library_dylink.js:1140-1153` (uses `Asyncify.handleSleep`). Exports are wrapped via `Asyncify.instrumentWasmExports` (line 749-751). **But** when a side module loaded via `dlopen` itself calls an async JS import, the asyncify call stack becomes invalid and traps with "RuntimeError: unreachable" / function-signature-mismatch errors. Issue open since 2020-12-15, no fix in tracker. [github.com/emscripten-core/emscripten/issues/13049](https://github.com/emscripten-core/emscripten/issues/13049) |
| `-sALLOW_MEMORY_GROWTH=1` | Yes | No documented interaction. Side module memory comes from main via `getMemory()`. |
| `-fexceptions` + `-O3` + `SIDE_MODULE` | Known regression #14896 | `pthread_create` shows as undefined symbol when all three combine. [github.com/emscripten-core/emscripten/issues/14896](https://github.com/emscripten-core/emscripten/issues/14896) Status: open. Our build has all three. |
| Multiple side libs + pthread workers | Broken — issue #13303 | Function-pointer table indices diverge between main thread (async load, non-deterministic order) and pthread workers (sync load). With >1 side library a fn pointer obtained on main may resolve to a different fn on a worker. Mitigation: keep to **one** side module. [github.com/emscripten-core/emscripten/issues/13303](https://github.com/emscripten-core/emscripten/issues/13303) |
| Side module on pthread + `-sSTACK_OVERFLOW_CHECK` | Broken — issue #13327 | Side modules initialize with main-thread stack limits. We don't currently set `STACK_OVERFLOW_CHECK`, so OK as long as we don't add it. [github.com/emscripten-core/emscripten/issues/13327](https://github.com/emscripten-core/emscripten/issues/13327) |
| `PTHREAD_POOL_SIZE=N` | Memory cost per side module ×N | Per discussion #17034: each side module is loaded once per thread (no module sharing across workers without the `sharedModules` postMessage path in `library_dylink.js:736-744`). With N=8 pool that's 8× the side-module bytes in memory + 8× compile cost. [github.com/emscripten-core/emscripten/discussions/17034](https://github.com/emscripten-core/emscripten/discussions/17034) |
| `-sMODULARIZE=1` + `MAIN_MODULE` | OK in principle but interactions exist | Issue #20636 documents `INCOMING_MODULE_JS_API + Pthread + Modularize` interaction bugs (orthogonal but adjacent). [github.com/emscripten-core/emscripten/issues/20636](https://github.com/emscripten-core/emscripten/issues/20636) |
| `-sASYNCIFY=1` + `_dlopen_js` returning `0` on failure | Quiet failure | The catch arm at `library_dylink.js:1148` calls `wakeUp(0)` on any error, returning `NULL` to `dlopen()`. The actual error is only in `dlerror()`. Easy to miss in instrumentation. |

**Net:** every individual flag in our stack has *some* support for dlopen,
but at the intersection of (pthread + asyncify + side-module + -O3 +
-fexceptions) we are deep into experimental territory with at least
issues #13049, #14896, #13303 unresolved. None of these is a hard block
for our use case (single side module, async-import-free block functions),
but each must be specifically checked in the spike.

---

## 3. V8 cross-side-module dispatch cost

### Hard data found
V8 ships speculative `call_indirect` inlining + deopt support in
Chrome M137 (May 2025). [v8.dev/blog/wasm-speculative-optimizations](https://v8.dev/blog/wasm-speculative-optimizations).
Quote from the V8 blog (verbatim, also archived in our
`single_module_jit_plan.md` memory):

> "Correctly inlining functions that belong to a different instance ...
> would require additional compiler machinery as well as solving a few
> obstacles in our general handling of generated code. Luckily, most
> calls are within a single instance anyway, so for the time being we
> check that the call target's instance matches the current instance,
> which lets the compiler make the simplifying assumption that both
> instances are the same. **If not, we deoptimize.**"

### How this applies to dlopen

Each `dlopen`'d side module is a separate `WebAssembly.Instance` that
imports the main module's `wasmTable` and `wasmMemory`. `dlsym` returns
a `wasmTable` index (`library_dylink.js:1196-1262`). A C-side direct
call `((fn_t)ptr)(args)` lowers to `call_indirect tbl, idx` from inside
the main module's wasm. The target function lives in the side module's
instance.

So the very dispatch we are trying to fast-path **is the cross-instance
case the V8 blog calls out as a deopt**. Expected behavior:
- Liftoff (tier 1): plain `call_indirect`, no inlining, ~10-30 ns
  amortized per dispatch (rough — varies with target arch).
- TurboFan (tier 2): per the blog, instance-check at the call site,
  miss → deopt to a slower path. Best case ≈ same as Liftoff, worst
  case worse than Liftoff due to deopt churn if dispatch fans out across
  many side modules.

This is the **same wall the existing per-block-module epoch path
already hits** — flycast_install_epoch makes one `WebAssembly.Instance`
per epoch, and `flycast_run_block` calls `fn(ctxPtr, ramBase)` where
`fn` is an export of that epoch instance, called from main worker
instance JS. The JS round-trip is on top of the cross-instance call.

### Hypothesis

Direct-dispatch via dlopen will measure **noticeably faster than the
current EM_JS hop** (kills ~one JS→wasm boundary and the `Map.get`),
but **bounded above by Liftoff cross-instance `call_indirect`**, which
is roughly 10-100× slower than intra-instance direct call. So the
"native ~50 ns dispatch" target requires single-module emission
(memory `single_module_jit_plan.md`), not dlopen.

**Caveat:** the V8 cross-instance deopt only matters at TurboFan tier.
If our hot loop stays in Liftoff (which it will for the foreseeable
future since we keep emitting new blocks), the deopt path is
irrelevant — we just pay normal `call_indirect` cost. That can be quite
fast. The spike measurement is decisive here.

---

## 4. Precedent projects

Searched: dosbox-x, beetle-psx-libretro, mupen64plus-wasm,
dolphin-wasm-forks, libretro cores, retroarch.

Negative findings:
- RetroArch's libretro architecture is dynamic-linking-shaped at the
  Linux/Win level (cores = `.so`/`.dll`), but the **WASM** ports
  (`retroarch_web`) statically link the cores via `add_executable`
  per-core or use load-time linked subprojects — no runtime dlopen.
  [retroarch.com/?page=cores](https://retroarch.com/?page=cores)
- dosbox-pure WASM build statically links — no dlopen in build script.
  [github.com/schellingb/dosbox-pure](https://github.com/schellingb/dosbox-pure)
- Dolphin libretro: same — when WASM-built (our GameCube branch), it's
  a single `.a` link with no MAIN/SIDE module split.

Positive finding (closest precedent):
- **Pyodide** uses `MAIN_MODULE` + side modules for Python C extensions
  at runtime in a pthread environment. See their debugging-tips page
  [pyodide.org/en/stable/development/debugging.html](https://pyodide.org/en/stable/development/debugging.html) —
  they document several of the same wasm/dlopen interaction bugs we'd
  hit. Not a 1:1 fit (Python extensions are leaf-call shaped, not
  hot-inner-loop shaped), but the closest live large-scale user.

**Net:** no emulator-shaped precedent for MAIN_MODULE + SIDE_MODULE +
pthread + hot-path dispatch found in open source. The Pyodide
precedent confirms the stack *can* be made to work for large apps but
does not validate the dispatch cost target.

---

## 5. PIC overhead on main module

Issue #5256 reports a user's app jumping from 7.5 MB → >13 MB when adding
`-sMAIN_MODULE=2 -O3`. [github.com/emscripten-core/emscripten/issues/5256](https://github.com/emscripten-core/emscripten/issues/5256)
Issue #12682 confirms RELOCATABLE (-fPIC) is currently forced on
MAIN_MODULE builds even though there is "no need for the main module
itself to be relocatable". [github.com/emscripten-core/emscripten/issues/12682](https://github.com/emscripten-core/emscripten/issues/12682)

Current `flycast_worker_emcc.wasm` is roughly **50 MB** (file is tracked
in repo; tracked status confirms via `git status` showing it as
modified). Scaling factor from #5256 is ~1.7× for an already-O3 build.

Estimated worst case:
- Main module wasm: 50 MB → **~75-85 MB**.
- Cold compile time on Chrome: roughly proportional to bytes → +50-70%
  initial-load wait. No data point exact.

MAIN_MODULE=2 is the variant we'd want (DCE preserved, manual exports
list). Per the dynamic-linking docs, MAIN_MODULE=1 (no DCE) would push
the wasm size much higher; MAIN_MODULE=2 keeps DCE but requires us to
explicitly keep symbols alive that side modules need. For Option 2 the
side module needs nothing from main beyond the imports we declare
(memory, table, plus any helpers the JIT'd blocks call — `sh4_mem_*`,
register-access wrappers, etc.), which we already track in
`EXPORTED_FUNCS` in the link script.

Mitigation: if Lever 3 (multi-block-per-instance epoch in
`flycast_install_epoch`) gives the same V8 benefit as MAIN_MODULE
without the PIC tax, prefer it.

---

## 6. Go/no-go criteria the Phase 1 spike would test

The reference side module already exists at
`dreamcast/docs/option2-direct-dispatch/refs/side_ref.c`
(currently just `int run(int a, int b){ return a; }`). Phase 1 spike =
build it as SIDE_MODULE, build a minimal main that `dlopen`s it inside
the worker, and measure dispatch time in a tight loop.

### Spike build script (do not execute — for the human to run)

```bash
#!/bin/bash
set -euo pipefail
ROOT=/Users/caseybement/Bemental77.github.io
SPIKE=$ROOT/dreamcast/docs/option2-direct-dispatch/spike
mkdir -p "$SPIKE"

source $ROOT/emsdk/emsdk_env.sh

# --- side module ---
emcc $ROOT/dreamcast/docs/option2-direct-dispatch/refs/side_ref.c \
  -O3 -sSIDE_MODULE=1 -fPIC -pthread -matomics -mbulk-memory \
  -o "$SPIKE/side_ref.wasm"

# --- main module: minimal C with dlopen + bench loop ---
cat > "$SPIKE/main_spike.c" <<'EOF'
#include <stdio.h>
#include <stdint.h>
#include <dlfcn.h>
#include <emscripten.h>
#include <time.h>

typedef int (*run_fn)(int, int);

int main(void) {
    void* h = dlopen("side_ref.wasm", RTLD_NOW);
    if (!h) { printf("[spike] dlopen FAILED: %s\n", dlerror()); return 1; }
    run_fn fn = (run_fn)dlsym(h, "run");
    if (!fn) { printf("[spike] dlsym FAILED: %s\n", dlerror()); return 1; }

    // warmup
    volatile int sink = 0;
    for (int i = 0; i < 100000; i++) sink += fn(i, i);

    // measurement: 50M iterations
    double t0 = emscripten_get_now();
    for (int i = 0; i < 50000000; i++) sink += fn(i, i);
    double t1 = emscripten_get_now();

    double ns_per_call = (t1 - t0) * 1e6 / 50000000.0;
    printf("[spike] sink=%d  ns/call=%.2f\n", sink, ns_per_call);
    return 0;
}
EOF

# Build with the EXACT flag stack from flycast_worker_link.sh that matters
# for dlopen behavior (-pthread, ASYNCIFY, -O3, -fexceptions, ENVIRONMENT=worker)
emcc "$SPIKE/main_spike.c" \
  -O3 -fexceptions \
  -sMAIN_MODULE=2 \
  -pthread -matomics -mbulk-memory \
  -sALLOW_MEMORY_GROWTH=1 \
  -sASYNCIFY=1 \
  -sPTHREAD_POOL_SIZE=8 \
  -sENVIRONMENT=worker,node \
  -sEXPORTED_RUNTIME_METHODS=ccall,cwrap \
  -sEXPORTED_FUNCTIONS=_main,_malloc,_free \
  -sINITIAL_MEMORY=67108864 \
  -sMAXIMUM_MEMORY=536870912 \
  "$SPIKE/side_ref.wasm" \
  -o "$SPIKE/main_spike.js"

# Run under node (the easiest harness for headless wasm+pthreads)
cd "$SPIKE" && node --experimental-wasm-threads main_spike.js
```

### What to grep for

```
grep "ns/call" <node-output>
```

### Success thresholds (one is sufficient for go; both fail = no-go)

| Threshold | Verdict |
|---|---|
| `ns/call < 200` | Strong go — dispatch is 500× better than current ~100 μs |
| `200 ≤ ns/call < 2000` | Weak go — 50-500× better, useful intermediate while pursuing single-module emission in parallel |
| `ns/call ≥ 2000` | No-go — barely beats EM_JS hop; not worth the PIC tax |
| Build link fails | Hard no-go on current flag stack — see kill criteria |
| Build links but `dlopen` returns NULL at runtime with our exact flags | Kill criterion #1 below |
| Build links, loads, but throws RuntimeError / signature-mismatch in hot loop | Likely issue #13049 — kill criterion #2 |

### What the spike does NOT test (Phase 2 if go)

- Behavior when side module imports `wasmMemory` shared with pthread
  workers (spike only runs main thread).
- Hot-recompile churn: registering N=10000 side modules over time
  (testing for the `wasmTable` growth + thread-resync cost noted in
  issue #13303 and library_dylink lines 646-651).
- Interaction with our actual flycast bridge wasm imports
  (`sh4_mem_read*`, `sh4_mem_write*` etc.) being satisfied via
  `RTLD_GLOBAL` symbol export.

---

## 7. Kill criteria

Any of these = abandon Option 2, fall back to the single-module-emission
plan in `single_module_jit_plan.md` (already partially scaffolded in
`flycast_install_epoch`):

1. **Linker rejects MAIN_MODULE=2 with our flag stack.** Specifically
   the combination `-pthread + -sASYNCIFY=1 + -fexceptions + -O3 +
   -sMAIN_MODULE=2 + -sMODULARIZE=1 + -sENVIRONMENT=worker`. If link
   succeeds for main alone but fails when we add the side module via
   `-sAUTOLOAD_DYLIBS=1` or runtime `dlopen`, that's issue #14896
   territory (open as of 2025, no fix).

2. **`dlopen` returns NULL at runtime** with a meaningful `dlerror`
   pointing to asyncify stack corruption / instance-check fail. That
   maps to issue #13049 and there is no known workaround other than
   "build as a regular module and use ccall" — which is *back to where
   we started* (JS hop).

3. **Spike `ns/call ≥ 2000`** (see Section 6 thresholds). At that cost
   the EM_JS hop saving doesn't justify the 1.7× wasm size, PIC slowdown
   on the entire main-module hot path (not just dispatch), and the
   thread-sync cost on every dlopen.

4. **`wasmTable.grow(N)` cost per dlopen** measured >1 ms on Chrome
   when the table reaches ~10K entries. `library_dylink.js:646-652`
   shows the grow is unconditional. SH4 workloads generate thousands of
   blocks; if every one needs a table grow + thread broadcast we'd
   negate the per-call savings.

5. **Multi-thread function-pointer divergence** observed when the SH4
   worker and the page main thread both touch the dispatch table — i.e.
   if we manage to repro issue #13303 with even one side module.
   (Unlikely with single side module, but worth a probe.)

---

## 8. Open questions only a spike build can answer

Listed in priority order — what to learn before committing to Option 2.

1. **Does our exact 3.1.67 emcc + flag stack link MAIN_MODULE=2 at all?**
   The `transferredCanvasNames` patch comment in
   `flycast_worker_link.sh:238-240` tells us we're already on a brittle
   Emscripten version. MAIN_MODULE might pull in newer dylink JS that
   hasn't been validated against 3.1.67.

2. **What is the actual `ns/call` for cross-side-module dispatch on V8
   (Chrome/Node) at our target site?** Section 3 hypothesizes but
   cannot bound this without a measurement. The single number from the
   spike's `printf` decides go/no-go.

3. **Does `dlopen` of a side module that touches `wasmMemory` (i.e.
   reads/writes guest RAM) work correctly when called from a pthread
   worker?** Spike script as written runs on main thread of node. Real
   use is from the SH4 worker thread.

4. **Cost of side-module compile per dlopen.** Production target is
   one side module per SH4 block batch — could be hundreds of dlopens
   per second. Cold-compile of a tiny module is ~5-50 ms on V8 (per
   our existing per-block-module timing). If dlopen is bounded below
   by that, we get nothing.

5. **Can we use one long-lived side module + `dlsym` to re-fetch
   symbols when blocks update?** The current epoch path
   (`flycast_install_epoch`) installs a fresh `WebAssembly.Instance`
   per epoch — equivalent to one dlopen per epoch. The win from
   Option 2 is then dispatch shape, not load shape.

6. **What is the wasm-size delta** of converting our 50 MB main to
   MAIN_MODULE=2? Issue #5256's 1.7× is a single data point; ours may
   differ.

7. **Does `-sAUTOLOAD_DYLIBS=1` (default per settings.js:2119) interact
   badly with our `-sMODULARIZE=1` + `flycastWorkerModule` factory
   pattern?** Side modules listed at link time would have to load
   before the factory promise resolves.

---

## Sources

- [Pthreads support — Emscripten docs](https://emscripten.org/docs/porting/pthreads.html)
- [Dynamic Linking — Emscripten docs](https://emscripten.org/docs/compiling/Dynamic-Linking.html)
- [Emscripten settings reference](https://emscripten.org/docs/tools_reference/settings_reference.html)
- [Speculative Optimizations for WebAssembly using Deopts and Inlining — V8 blog](https://v8.dev/blog/wasm-speculative-optimizations)
- [Issue #13049 — Invalid Asyncify stack when using dlopen() with SIDE_MODULE and asyncify imports](https://github.com/emscripten-core/emscripten/issues/13049)
- [Issue #14896 — pthread_create undefined symbol with side module + -fexception + -O3](https://github.com/emscripten-core/emscripten/issues/14896)
- [Issue #13303 — Side libraries linked in non-deterministic order between main thread and workers](https://github.com/emscripten-core/emscripten/issues/13303)
- [Issue #13327 — Side module on pthread aborts with STACK_OVERFLOW_CHECK](https://github.com/emscripten-core/emscripten/issues/13327)
- [Discussion #17034 — SIDE_MODULE and USE_PTHREADS provoke memory growth](https://github.com/emscripten-core/emscripten/discussions/17034)
- [Issue #5256 — Javascript with MAIN_MODULE=2 becomes very big](https://github.com/emscripten-core/emscripten/issues/5256)
- [Issue #12682 — Stop building MAIN_MODULE with RELOCATABLE (-fPIC)](https://github.com/emscripten-core/emscripten/issues/12682)
- [Issue #20636 — INCOMING_MODULE_JS_API+Pthread+Modularize don't work](https://github.com/emscripten-core/emscripten/issues/20636)
- [Issue #8302 — Calls via loadDynamicLibrary much slower than dlopen](https://github.com/emscripten-core/emscripten/issues/8302)
- Local: `emsdk/upstream/emscripten/src/library_dylink.js` (lines 60-66, 736-858, 990-1068, 1140-1262)
- Local: `emsdk/upstream/emscripten/src/settings.js` (lines 819-931 ASYNCIFY, 1126-1195 MAIN/SIDE_MODULE, 1636 SHARED_MEMORY, 2095-2119 IMPORTED_MEMORY/AUTOLOAD_DYLIBS)
- Local: `dreamcast/flycast-bridge/flycast_worker_link.sh` (current link flags)
- Local: `dreamcast/flycast-bridge/rec_wasm.cpp:62-119` (current EM_JS dispatch shims)
- Local: `dreamcast/flycast-bridge/flycast_worker_funcs.js:104-188` (current JS-side dispatcher)
- Local memory: `single_module_jit_plan.md` (V8 cross-instance deopt verbatim quote, alternative plan)

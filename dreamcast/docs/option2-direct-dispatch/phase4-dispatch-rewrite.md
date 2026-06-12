# Phase 4 — SH4 Dispatch Rewrite to Direct C Function Pointers

Status: research-only design doc. No source changes in this phase.

This document defines how to replace the JS-mediated SH4 block dispatch
(`flycast_run_block` via EM_JS) with C function pointers obtained from
`dlopen`/`dlsym` on per-block (or per-epoch) Emscripten side modules.

Source layer references (all line numbers as of 2026-05-17):
- `dreamcast/flycast-bridge/rec_wasm.cpp` — current EM_JS dispatch (lines 62-119, 312-344, 363-435)
- `dreamcast/flycast-bridge/flycast_worker_funcs.js` — JS dispatcher (45-188)
- `emsdk/upstream/emscripten/system/include/dlfcn.h` — public dlopen/dlsym API (22-26)
- `emsdk/upstream/emscripten/system/include/emscripten/emscripten.h` — async dlopen variants (177-185)
- `emsdk/upstream/emscripten/system/lib/libc/dynlink.c` — dlopen/dlsym C-side (170-208, 540-585)
- `emsdk/upstream/emscripten/system/lib/libc/musl/src/ldso/dlclose.c` — dlclose stub (1-8)
- `emsdk/upstream/emscripten/src/library_dylink.js` — JS-side dlopen + dlsym + loadWebAssemblyModule (391-510, 600-1062, 1100-1258)
- `emsdk/upstream/emscripten/src/settings.js` — MAIN_MODULE/SIDE_MODULE/RELOCATABLE (1124-1196)

---

## 1. Dispatch chain: today vs. Option 2

### 1.1 Today (8 boundary crossings per SH4 block call)

Inside `WasmDynarec::mainloop()` (rec_wasm.cpp:715-744) every dispatch:

1. C++ `bm_GetCodeByVAddr(ctx->pc)` returns the per-block fake pointer
   (`block->code` set at compile-time, rec_wasm.cpp:432).
2. C++ `wasm_block_trampoline()` runs.
3. C++ `wasm_dispatcher_run_block(pc, ctx, ram)` — EM_JS body
   (rec_wasm.cpp:96-103). This is a wasm→JS call into the importing
   function emitted by Emscripten.
4. JS `flycast_run_block(vaddr, ctxPtr, ramBase)`
   (flycast_worker_funcs.js:174-188).
5. JS `flycast_vaddr_to_fn.get(vaddr)` — `Map<u32, Function>` lookup.
6. JS `fn(ctxPtr, ramBase)` — JS→wasm call into the side instance.
7. Block body runs; on imported `sh4_read*/sh4_write*/sh4_ifb` calls it
   pays *another* wasm→JS→wasm hop (those imports are funneled through
   `flycast_wasm_imports` in flycast_worker_funcs.js:84-95).
8. Block returns `next_pc` → unwinds through #6 → #3 → C++ trampoline →
   C++ writes `ctx->pc = next_pc & ~1`.

V8 must JIT every one of those JS shims. The cross-instance
`call_indirect` deopt at ~1395 active blocks (per
`session_2026_05_12_throughput_levers.md`,
`flycast_worker_funcs.js:55-60`) is what motivated the epoch path; even
with a single live `Instance`, the call from JS into a function whose
`SharedFunctionInfo` lives in a separate WebAssembly.Module pays
the cross-module call cost on the V8 IC.

### 1.2 Option 2 (1 boundary crossing)

In the new code, after compile() returns, every dispatch:

1. C++ `bm_GetCodeByVAddr(ctx->pc)` → the *real* function pointer (a
   wasm table index, see §4.1) cast to `u32(*)(u32, u32)`.
2. C++ trampoline: `next_pc = fn(ctx, ram_base);` — this is a
   `call_indirect` against the main module's `__indirect_function_table`.

That's it: no JS, no EM_JS, no `MAIN_THREAD_EM_ASM`, no `Map.get`. The
imports the block calls (`sh4_read*`, `sh4_ifb`, `sh4_shil_fb`) are
resolved at *dlopen* time to the **main module's existing wasm
functions** (Emscripten's `loadWebAssemblyModule` proxy at
library_dylink.js:690-722 maps `env.<name>` through `wasmImports`),
so block→helper calls become wasm→wasm direct table calls — no more
wasm→JS→wasm round-trip on per-instruction memory access either.

The only remaining "crossing" is the `call_indirect` through the
shared `__indirect_function_table`, which is a single bounds-check +
type-check + branch in V8 Liftoff (≈ few-ns cost; see §5).

---

## 2. rec_wasm.cpp diff

### 2.1 Remove

| Lines | What |
|---|---|
| 43 | `#include <emscripten.h>` stays (still need `MAIN_THREAD_EM_ASM` for diag); add `#include <dlfcn.h>` |
| 51-60 | EM_JS bridge banner comment — keep but rewrite |
| 62-71 | `wasm_dispatcher_register_block` (no longer called) |
| 85-94 | `wasm_dispatcher_install_epoch` (no longer called) |
| 96-103 | `wasm_dispatcher_run_block` (no longer called) |
| 108-119 | `wasm_dispatcher_get_last_error` (replace with `dlerror()`) |
| 127 | `g_compiled_blocks` (raw-bytes stash) — keep only if diag needs it |
| 156-171 | `g_active_blocks`, `g_active_vaddrs`, `g_pending_blocks`, `g_pending_vaddrs`, `EPOCH_BATCH`, `EPOCH_MAX_ACTIVE` |
| 179-280 | `flush_epoch()` entire body |
| 376-380 | `flush_epoch("batch")` call in compile() |
| 449-452 | `g_active/pending_*.clear()` in reset() |
| 501 | `flush_epoch("entry")` call in mainloop() |
| 732 | `flush_epoch("miss")` call in cache-miss path |
| 987 | `(int)g_active_blocks.size()` in stats |

### 2.2 Add

```cpp
#include <dlfcn.h>
#include <cstdio>      // snprintf for FS path
#include <sys/stat.h>  // mkdir
#include <unistd.h>    // write, close
#include <fcntl.h>     // open, O_WRONLY|O_CREAT

// Function-pointer type matching the block export signature
//   (i32 ctx_ptr, i32 ram_base) -> i32 next_pc
// See bementalJIT/guests/sh4/wasm_emit.cpp:1347-1362 build_block().
using BlockFnPtr = uint32_t (*)(uint32_t /*ctx*/, uint32_t /*ram_base*/);

// vaddr -> dlsym'd "run" function pointer. Direct call from the
// trampoline. Replaces flycast_vaddr_to_fn (JS Map) +
// flycast_block_instances + g_active_blocks.
static std::unordered_map<u32, BlockFnPtr> g_vaddr_to_fnptr;

// Kept for diagnostics / dlclose-on-reset (if we ever wire it).
static std::unordered_map<u32, void*> g_vaddr_to_handle;

// Monotonic id used as the FS filename. Multiple recompiles of the
// same vaddr (post-reset() or SMC) get distinct files so dlopen sees
// a fresh path and instantiates a new module rather than hitting
// LDSO.loadedLibsByName (library_dylink.js:956-981 returns the
// already-loaded handle if the path matches).
static std::atomic<uint64_t> g_block_serial{0};

// Ensure /tmp/blocks exists. Called once on first compile().
// Emscripten ships MEMFS mounted at / by default; mkdir() lands in
// MEMFS, which dlopen's read()/stat() (dynlink.c:188-204) can serve
// synchronously.
static void ensure_block_dir() {
    static bool done = false;
    if (done) return;
    done = true;
    mkdir("/tmp",        0755);
    mkdir("/tmp/blocks", 0755);
}
```

### 2.3 New compile() body

Replaces lines 363-435. Diag block (382-422) preserved verbatim; only
the dispatch wiring changes.

```cpp
void compile(RuntimeBlockInfo* block, bool, bool) override
{
    const u32 vaddr = block->vaddr;

    // Build the block's wasm bytes (single-block module, "run" export).
    // build_block() returns a complete module header + import + function
    // + code section. For Option 2 we MUST also prepend a `dylink.0`
    // custom section — see §3 below for the spec and §6 for impl notes.
    std::vector<u8> bytes = bemental::sh4::build_block(block);

    ensure_block_dir();

    // /tmp/blocks/<serial>.wasm — fresh path per compile so dlopen
    // doesn't dedupe to a cached handle.
    char path[64];
    const uint64_t serial = ++g_block_serial;
    std::snprintf(path, sizeof(path), "/tmp/blocks/%llu.wasm",
                  (unsigned long long)serial);

    int fd = ::open(path, O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (fd < 0) { /* hard error — see §5 */ return; }
    ::write(fd, bytes.data(), bytes.size());
    ::close(fd);

    // RTLD_NOW: resolve all imports up-front; RTLD_LOCAL (default by
    // omitting RTLD_GLOBAL) since the block exports nothing other
    // modules care about. See dlfcn.h:10-15.
    void* handle = dlopen(path, RTLD_NOW);
    if (!handle) {
        const char* err = dlerror();
        WARN_LOG(DYNAREC,
                 "[rec_wasm] dlopen failed for vaddr=0x%08x: %s",
                 vaddr, err ? err : "(no message)");
        // Mirror the existing register_block error-stash pattern:
        // leave g_vaddr_to_fnptr without an entry, dispatcher will
        // re-cache-miss on next pass and try again next compile.
        return;
    }

    void* sym = dlsym(handle, "run");
    if (!sym) {
        const char* err = dlerror();
        WARN_LOG(DYNAREC,
                 "[rec_wasm] dlsym(\"run\") failed for vaddr=0x%08x: %s",
                 vaddr, err ? err : "(no message)");
        // dlclose is a no-op in Emscripten (see §6); leak is fine.
        return;
    }

    // dlsym returns the wasm table index for the function, which is
    // ABI-compatible with a C function pointer in Emscripten — wasm
    // function pointers ARE table indices. See library_dylink.js:1196-1258.
    g_vaddr_to_fnptr[vaddr]  = reinterpret_cast<BlockFnPtr>(sym);
    g_vaddr_to_handle[vaddr] = handle;

    // [preserve the RAM-block one-shot dump at lines 382-422]

    // block->code uniqueness fake-pointer trick (lines 432-435) stays
    // unchanged — the dispatcher still uses bm_GetCodeByVAddr +
    // wasm_block_trampoline; the trampoline does the fnptr lookup.
    block->code            = (DynarecCodeEntryPtr)(uintptr_t)block;
    block->host_code_size  = 0;
    block->host_opcodes    = 0;
}
```

### 2.4 New wasm_block_trampoline()

Replaces lines 312-344.

```cpp
static void wasm_block_trampoline()
{
    Sh4Context* ctx = &Sh4cntx;
    const u32 pc = ctx->pc;

    static uintptr_t s_ram_base = 0;
    if (!s_ram_base) s_ram_base = (uintptr_t)GetMemPtr(0x0c000000, 1);

    auto it = g_vaddr_to_fnptr.find(pc);
    if (it == g_vaddr_to_fnptr.end()) {
        // Cache miss: advance PC by 2 so the outer dispatcher's
        // bm_GetCodeByVAddr -> rdv_FailedToFindBlock_pc -> compile()
        // cycle runs. Mirrors the JS fallback at
        // flycast_worker_funcs.js:187.
        ctx->pc = (pc + 2) & ~1u;
        return;
    }

    // ONE call_indirect through __indirect_function_table. No JS hop.
    const u32 next_pc_raw = it->second((uint32_t)(uintptr_t)ctx,
                                       (uint32_t)s_ram_base);
    ctx->pc = next_pc_raw & ~1u;  // bit-0 mask preserved (rec_wasm.cpp:329-339)
}
```

### 2.5 reset()

```cpp
void reset() override
{
    INFO_LOG(DYNAREC, "[rec_wasm] reset — clearing %zu blocks",
             g_vaddr_to_fnptr.size());
    // dlclose() is a no-op on Emscripten (musl stub, dlclose.c:4-7),
    // so handles are immortal once opened. Dropping the map entries
    // makes them unreachable but the wasm instance + table slots
    // remain — see §6 for memory implications.
    g_vaddr_to_fnptr.clear();
    g_vaddr_to_handle.clear();
}
```

### 2.6 mainloop()

The only changes inside `mainloop()` are: remove the `flush_epoch`
calls at lines 501 and 732, and remove the `(int)g_active_blocks.size()`
in the stats line 987 (replace with `g_vaddr_to_fnptr.size()`).
All diag dumps, exception handlers, SPG raises, ring buffers stay
verbatim — they don't touch dispatch.

---

## 3. dlopen requires a `dylink.0` section

This is the load-bearing constraint and the reason this isn't a 30-line
patch.

`library_dylink.js:430-432`:
```js
failIf(dylinkSection.length === 0, 'need dylink section');
```

`build_block()` today emits a plain wasm module — no `dylink.0` custom
section — so `dlopen` would throw `"need dylink section"` and return
NULL. Two options:

### 3.1 (Recommended) Teach `WasmModuleBuilder` to emit a minimal `dylink.0`

The format is documented in
[WebAssembly/tool-conventions DynamicLinking.md](https://github.com/WebAssembly/tool-conventions/blob/main/DynamicLinking.md#the-dylink0-custom-section)
and parsed at library_dylink.js:464-512.

Minimum subsections we need:

- `WASM_DYLINK_MEM_INFO` (0x1): `memorySize=0, memoryAlign=0,
  tableSize=0, tableAlign=0`. Blocks have no static data, no globals,
  so all four are zero.
- `WASM_DYLINK_NEEDED` (0x2): empty (0 lib names).

That's it — `EXPORT_INFO` and `IMPORT_INFO` are optional. The section
must be the FIRST section after magic+version (library_dylink.js:443
asserts `binary[8] !== 0`, where byte 8 is the section-id of the first
section and `0` is the custom-section id).

Wire bytes:
```
00 61 73 6d 01 00 00 00            ; magic + version
00                                  ; custom section id
<LEB size>                          ; section payload size
08 64 79 6c 69 6e 6b 2e 30          ; "dylink.0" (len=8 + bytes)
01                                  ; subsection MEM_INFO
04                                  ; subsection size
00 00 00 00                         ; memorySize, memoryAlign, tableSize, tableAlign
02                                  ; subsection NEEDED
01                                  ; subsection size
00                                  ; 0 needed libs
```

= 23 bytes prepended before what `emitHeader()` already produces. Add a
`WasmModuleBuilder::emitDylinkSection()` helper or do it inline at the
start of `build_block`.

### 3.2 (Alternative) Skip dlopen JS path entirely

Write a custom `_dlopen_js`-style function (e.g. in
`flycast_worker_funcs.js`) that takes raw bytes + an import object,
calls `new WebAssembly.Module(bytes)` + `new WebAssembly.Instance(mod,
imports)`, and shoves the `run` export into `wasmTable` via
`addFunction` (the same Emscripten internal that `_dlsym_js` uses at
library_dylink.js:1247). Returns the table index to C++.

This bypasses dylink-section requirements but reintroduces an EM_JS
boundary at instantiate-time (still removed from the dispatch hot
path — instantiate is per-compile, not per-call). Net win vs §3.1: no
SIDE_MODULE format work. Net loss: gives up `MAIN_MODULE`'s automatic
import resolution (we hand-build the imports object exactly as
`flycast_build_imports()` does today, line 65-97). For Phase 4 the
§3.1 path is cleaner because it removes the entire JS file from the
dispatch story.

---

## 4. Open Emscripten-API questions, answered

### 4.1 Does `dlopen(path, RTLD_NOW)` return a valid handle for a wasm SIDE_MODULE on FS?

Yes. `dlopen` (dynlink.c:583-585) calls `_dlopen` (542-581), which
calls `load_library_start` (172-208). That function `stat`s and
`open`+`read`s the file from the FS into a malloc'd buffer
(`p->file_data`, `p->file_data_size`), then `_dlopen_js`
(library_dylink.js:1143-1153) hands the buffer to `dlopenInternal` →
`loadDynamicLibrary` (948-1068) → `loadWebAssemblyModule` (607+).

The FS path can be MEMFS — `stat`/`open`/`read` are unconditional on
the FS backend. `mkdir("/tmp/blocks")` + `open(O_CREAT)` + `write` are
fine on MEMFS (FILESYSTEM=1 is already on; see `EXPORTED_RUNTIME` in
flycast_worker_link.sh:75-80 includes `FS`).

### 4.2 Does `dlsym(handle, "run")` return a callable function pointer?

Yes — and "callable" here means **callable directly from C as a
function pointer**, not "callable as a JS function". Per
library_dylink.js:1196-1258, `_dlsym_js` resolves the export, calls
`addFunction(result, result.sig)` (or finds an existing table index via
`getFunctionAddress`), and returns the **table index**. In Emscripten,
wasm function pointers ARE table indices into
`__indirect_function_table`; `call_indirect` against that table is
exactly what `(*fnptr)(args...)` compiles to.

The return type of `dlsym` is `void*`; the C side casts to the
appropriate `T(*)(...)` and calls. The compiler emits a wasm
`call_indirect` with the type signature derived from the cast — that
matches the side module's exported function type (verified by V8 at
call time; a type mismatch traps).

### 4.3 Failure-mode signature on dlopen of invalid wasm

- File-not-found: `load_library_start` (188) `stat` returns nonzero,
  `file_data` stays NULL, `_dlopen_js` calls back into JS which tries
  `locateFile(libName)` (library_dylink.js:1010) → fetch fails →
  `dlSetError` (1134) → returns 0 to C side → `_dlopen` returns NULL,
  `dlerror()` returns `"Could not load dynamic lib: <path>\n<error>"`.
- Bad wasm bytes: `getDylinkMetadata` (391-512) throws (e.g.
  `"need wasm magic number"`, `"need dylink section"`, `"need the
  dylink section to be first"`) → caught in `dlopenInternal`
  (1128-1136) → `dlSetError` → `dlopen` returns NULL.
- Instantiate failure: same catch — `new WebAssembly.Instance` throw
  bubbles up, dlSetError, NULL handle.

So error path is: `dlopen` → 0, `dlerror()` → human-readable string.
Mirrors the existing `flycast_last_register_error` pattern but uses
the standard POSIX call.

### 4.4 In-memory wasm dlopen (no FS write)?

There is no public Emscripten API for `dlopen_from_memory(bytes,
len)`. The closest thing:

- `_dlopen_js` (library_dylink.js:1143) reads `file_data` from the
  `dso` struct if non-NULL (`loadDynamicLibrary` lines 1001-1008),
  falling back to `locateFile`+fetch otherwise. The `file_data` is set
  ONLY by `load_library_start` (dynlink.c:194-201) reading from FS, so
  there's no C-visible "pass me bytes" path.
- `emscripten_dlopen` (emscripten.h:180) is just the async variant —
  same path, just non-blocking.
- A custom approach: skip `dlopen` and call `new WebAssembly.Module`
  + `new WebAssembly.Instance` + `addFunction` from JS, as in §3.2.

**Conclusion**: stick with the FS write. MEMFS write is ~µs (memcpy
into an FS node); cost is negligible vs. wasm instantiate (~ms).

### 4.5 Function-pointer call cost

A wasm-to-wasm `call_indirect` in V8 Liftoff does:
1. Table bounds check (1 cmp/branch).
2. Signature check against the static call-site type (1 load+cmp).
3. Indirect branch through the slot's `function_index`.

In TurboFan (after tier-up) the type check can be elided when the
target has been observed-monomorphic for a single signature
([V8 blog on indirect calls in wasm](https://v8.dev/blog/wasm-speed)).

Order of magnitude: low single-digit ns, comparable to a virtual
function dispatch. **Cite**: V8's Wasm interpreter docs and the
[Liftoff design doc](https://v8.dev/blog/liftoff), plus the empirical
note in `bementalJIT_module_decomposition_2026_05_05.md` about
cross-instance `call_indirect` being the SAME `call_indirect` op but
with a deopt because the IC stays megamorphic across modules. In our
single-module-graph (each side module imports from the SAME main
module's `__indirect_function_table`), all calls into helpers
(`sh4_read32` etc.) are intra-table → fully monomorphic.

The current 8-crossing path has at least 2 wasm→JS transitions per
dispatch (steps 3 and the imports inside step 7), each measurable in
~hundreds of ns on V8 ≥ 11. Saving ~600ns per dispatch at ~24K disp/s
recovers ~14 ms/sec; at the design-target ~400K disp/s it's
~240 ms/sec — directly visible in the throughput probe.

### 4.6 Handle lifecycle / dlclose

`dlclose` is a **no-op** (musl stub, dlclose.c:1-7). The Emscripten
implementation has no symbol for `__dl_invalid_handle`, so the
function unconditionally returns the invalid-handle error. Even if it
worked, `loadDynamicLibrary` sets `dso.refcount = Infinity` when
`flags.nodelete` is true (library_dylink.js:973-975, and `nodelete`
defaults to true at line 948).

**Implication**: handles + their instances + their table slots leak
for the life of the worker. This is fine for our case:
- Live function pointers stay valid forever.
- Reset clears the C++ map but the underlying instance + table entries
  stick around (~unreachable memory; not unbounded because Flycast's
  block manager + cycle of `bm_DiscardBlock` triggers fresh
  recompiles, but each fresh recompile = fresh leak).
- For a long-running game, see §6 memory budget.

### 4.7 Memory growth per dlopen

Per the dylink loader (library_dylink.js:629-640):
- `metadata.memorySize` of new linear memory is allocated via
  `getMemory()`. For our blocks, `memorySize=0` (no static data, no
  globals). No additional linear-memory growth per block.
- `metadata.tableSize` slots are grown into
  `__indirect_function_table` (line 646-651): 1 slot per exported
  function — we export only `run`, so +1 table slot per block.
- `new WebAssembly.Module(bytes)` and `new WebAssembly.Instance(mod,
  imports)` — V8 holds onto the JIT'd machine code (Liftoff baseline
  ~10× wasm-bytes size, TurboFan ~5×). Our blocks average ~200 bytes
  → ~2 KB Liftoff code per block. At 5000 blocks: ~10 MB. Acceptable.

So per-block overhead is roughly:
- 1 wasm table slot (8 B in V8 ≥ 10).
- The DSO struct (`sizeof(struct dso) + path-strlen` ≈ 120 B + 30 B path).
- The `file_data` malloc (~module size, ~200 B); the comment at
  dynlink.c:166 says it's never freed because dlsync can't tell when
  all threads have it.
- JIT code (~2 KB).

→ **~2.5 KB / block**, dominated by code. 5000 blocks → ~13 MB. Compare
to the current epoch-module path which keeps ALL active blocks in one
big module that gets re-compiled at each flush (O(N²) cumulative
Liftoff). Direct-dispatch is more memory but linear.

### 4.8 Thread safety

`dlopen` takes a process-wide `pthread_mutex_t write_lock`
(dynlink.c:83, 88-98) on `_REENTRANT` builds. So concurrent
`dlopen` calls from multiple threads are serialized.

However — and this is a real concern — `dlopen` under `_REENTRANT`
calls `dlsync()` (dynlink.c:164) which **broadcasts** the new DSO to
all other pthreads via `_emscripten_proxy_dlsync` (dynlink.c:422-433),
which requires the **main thread** to coordinate (`assert(emscripten_is_main_runtime_thread())`
on line 386). If `dlopen` is called from a pthread (which is exactly
our case — `mainloop()` runs on the proxied pthread, see
`PROXY_TO_PTHREAD=0` is *not* set but `-sPTHREAD_POOL_SIZE=8` is;
the dispatch loop runs on whichever pthread emcc dispatched it), the
dlsync uses `emscripten_proxy_sync_with_ctx` (dynlink.c:457-460) which
**blocks** the calling pthread until the main thread runs the proxy
queue.

**Implication**: every `dlopen` call from the SH4 pthread does a
round-trip to the main thread. If main-thread is busy painting (we
have a render probe + GL paint), this can stall the SH4 pthread for
~ms per compile. Mitigations:
- Use **`emscripten_dlopen_promise`** (emscripten.h:185) which is the
  async-only variant — but it returns a promise, which on the worker
  pthread means we'd need to install async resolution via Asyncify.
  ASYNCIFY is already on in our build (link.sh:202: `-sASYNCIFY=1`),
  so this is plausible.
- Or batch compiles: collect N blocks worth of bytes, do one dlopen
  per epoch (just like current epoch flush) so the main-thread
  round-trip cost amortizes over N blocks instead of per-block.

For a first cut, **synchronous `dlopen` from the SH4 pthread is fine**
— the existing `flycast_register_block` path is also synchronous and
JS-blocking, so we're not regressing.

---

## 5. Failure handling

Mirror the existing `flycast_last_register_error` stash (rec_wasm.cpp:108-119,
flycast_worker_funcs.js:103, 121-124, 167-171) but using POSIX `dlerror()`.

`compile()` failure cases:

| Failure | Detection | Action |
|---|---|---|
| `mkdir`/`open`/`write` for FS path | Check `fd < 0` or `write` return | `WARN_LOG`, return without populating map. Outer dispatcher cache-misses again → re-compile → retry. |
| `dlopen` returns 0 | Standard POSIX | `dlerror()` for message, `WARN_LOG`, no map entry. |
| `dlsym` returns 0 | Standard POSIX | `dlerror()` for message, `WARN_LOG`, no map entry. Note: handle leaks (dlclose is a no-op anyway). |
| `dlopen` throws in JS (bad bytes) | Caught inside dylink_js, surfaces as `dlopen` returning 0 | Same as above. `dlerror()` returns the JS exception's `e.message`. |

The "no map entry" outcome leaves `g_vaddr_to_fnptr.find(pc)` returning
end on next dispatch; the trampoline advances PC by 2 (matching the JS
fallback). The block manager will mark the slot as miss next time
through and re-enter `rdv_FailedToFindBlock_pc`, recompiling. So
failure is self-healing (modulo a hot loop calling a broken block).

For the trampoline itself, **no exception handling needed**: if the
block traps (e.g. unreachable instruction), V8 raises a JS exception
which propagates through `dispatch_raw` exactly the way `mainloop()`'s
existing try/catch around `SH4ThrownException` catches it. The
`dispatch_raw_trap_fix_2026_05_04.md` note about wrapping in
try/catch was for the dolphin path — for flycast the `SH4ThrownException`
catch at rec_wasm.cpp:920 is the equivalent.

---

## 6. Memory & cleanup

The Emscripten dynamic linker is fundamentally **append-only**: there
is no dlclose, no table-slot recycling, no JIT-code freeing. For
Phase 4 we accept this and design accordingly:

- **reset()** should clear `g_vaddr_to_fnptr` and `g_vaddr_to_handle`
  to drop stale entries. The next compile()-for-same-vaddr generates a
  fresh serial → fresh `/tmp/blocks/<N>.wasm` → fresh DSO → fresh
  table slot. Previous entries are unreachable.
- **Leaked code memory**: each reset cycle leaks ~2 KB × (blocks
  compiled before reset). Across boot (~5000 blocks) per reset,
  ~10 MB leaks. PSO + SAB reset rarely in normal operation; SBI/BIOS
  swap may force ~1-2 resets per session. Tolerable.
- **MEMFS bloat from `/tmp/blocks/`**: each block leaves an
  ~200-300 byte MEMFS node. At 5000 blocks, ~1-1.5 MB MEMFS. Optional
  cleanup: `unlink(path)` after `dlopen` succeeds (Emscripten's
  loader reads the file once into `file_data` then closes the fd
  per dynlink.c:203 — the FS path is unused after that point unless
  someone calls `dlopen` again with the same name, which we avoid by
  using a monotonic serial). Add an `unlink(path)` in compile() after
  successful dlopen if MEMFS pressure becomes visible.

If real per-block reclaim becomes a requirement (e.g. emulation runs
for hours and hits a code-cache pressure cliff), the right answer is
NOT to fix dlclose but to **batch blocks per-DSO** (e.g. 256 blocks
per epoch, identical to the current `EPOCH_BATCH=64`), so 1 DSO leak
covers 256 blocks of code memory. The dlopen API doesn't change; only
the `build_block` → `build_epoch_module` swap inside compile() does.
This is a future optimization, not Phase 4.

---

## 7. flycast_worker_funcs.js diff

All rec_wasm-related JS goes away. **Delete**:

| Lines | What |
|---|---|
| 25-43 | Banner block about the JS dispatcher |
| 45-47 | `flycast_block_modules`, `flycast_block_instances`, `flycast_wasm_imports` |
| 49-63 | Banner + `flycast_active_instance`, `flycast_vaddr_to_fn`, `flycast_epoch_serial` |
| 65-97 | `flycast_build_imports` |
| 99-125 | `flycast_register_block` + `flycast_last_register_error` |
| 127-172 | `flycast_install_epoch` |
| 174-188 | `flycast_run_block` |

**What stays:**

- Lines 1-23 — file banner (rewrite to drop the rec_wasm dispatcher
  paragraph).
- Lines 190-241 — `ENVIRONMENT_IS_PTHREAD` guard + `onRuntimeInitialized`
  hook + `mbx-cmd`/`shutdown` `onmessage` dispatcher. These are NOT
  dispatch-path; they're the worker's runtime-init signaling and
  page-mediated mailbox routing for the (future) sh4-worker split.
- Line 243 — `[flycast-funcs] post-js installed` log.

The file shrinks from ~250 lines to ~70.

**Imports the side modules now need:** the names `env.sh4_read8`, …,
`env.sh4_write32`, `env.sh4_ifb`, `env.sh4_shil_fb`, `env.memory`
must all resolve at dlopen time. With `MAIN_MODULE=1` in the link, the
loader proxy (library_dylink.js:707-710) looks them up in
`wasmImports`. Since our exports list (flycast_worker_link.sh:54-64)
already exports `_sh4_mem_read*`, `_sh4_mem_write*`, `_sh4_interp_ifb`,
`_sh4_interp_shil_fb`, Emscripten registers them in `wasmImports`
under the underscore-prefixed name. **BUT** side modules import them
as `sh4_read8` (no underscore prefix — see `wasm_emit.h:31-41`
`WIMPORT_*`). Two reconciliations:
- (a) rename the side-module imports to match the underscored
  Emscripten export names (`_sh4_mem_read8`, …) — change
  `emitTypeImportSection` in wasm_emit.cpp.
- (b) add aliases in the link via `-sEXPORTED_FUNCTIONS` /
  `--export=...` so both names resolve. Cleaner.
- (c) leave the underscored exports but inject explicit non-underscored
  aliases via a `--js-library` shim that defines
  `wasmImports.sh4_read8 = wasmImports._sh4_mem_read8` (and so on)
  before any dlopen runs.

(c) is the minimum-change path. (a) is the cleanest. See open
questions below.

Memory import: side modules with `dylink.0` rely on
`__memory_base`/`__table_base` rather than importing `env.memory`
explicitly. **OR**, since our blocks need ZERO static memory (only
SH4 RAM via `ram_base` function argument), we can keep the existing
`env.memory` import — the dylink proxy at lines 707-710 will find
`wasmImports.memory` (the main module's linear memory) and hand it
to the side instance. That's exactly what we want; SH4 reads/writes
that index off the main `WebAssembly.Memory`.

---

## 8. Link-flag changes (flycast_worker_link.sh)

Required additions:
- `-sMAIN_MODULE=2` — turns on the dynamic-linking runtime (dlopen,
  dlsym, dlerror, __indirect_function_table growth, dylink proxy
  loader). Mode 2 = DCE-on; we list everything the side modules need
  via `EXPORTED_FUNCTIONS` so it's kept alive. Mode 1 disables DCE
  entirely → +10s of MB binary bloat.
- The existing `-sALLOW_TABLE_GROWTH=1` and `-sASYNCIFY=1` are already
  on; both are required.
- `-sEXPORT_ES6=0` (default) and `-sMODULARIZE=1` (already on) — fine
  with MAIN_MODULE.
- Side-module compile (the bytes that `build_block` emits) does NOT
  go through emcc — we build them at runtime via `WasmModuleBuilder`.
  So no compile-side `-sSIDE_MODULE` flag is needed; we just need the
  `dylink.0` custom section per §3.1.

Pre-existing flag interactions to verify in an actual build:
- `-sPTHREAD_POOL_SIZE=8` + `MAIN_MODULE` — dlopen is documented to
  work with pthreads (dynlink.c § dlsync), with the main-thread
  round-trip cost noted in §4.8.
- `-Wl,--allow-multiple-definition` — already on; fine.
- `--embed-file` BIOS embeds — unaffected.

---

## 9. Open questions requiring an actual build

1. **Does MAIN_MODULE=2 on a wasm32+pthreads+asyncify build link
   cleanly with the current ARCHIVES set?** Some of Flycast's
   archives may have unresolved weak symbols that MAIN_MODULE's
   no-DCE mode (or mode 2's "DCE but keep what's listed") would let
   slip through with mismatching signatures. Concrete check: run
   flycast_worker_link.sh with `-sMAIN_MODULE=2` and verify the
   `-Wl,--allow-multiple-definition` flag doesn't paper over a real
   import-mismatch error.

2. **The `dylink.0` section bytes**: §3.1 has a 23-byte template, but
   `tableSize=0` may need to be revisited if the side module imports a
   func and the loader expects a non-zero base. Verify in an isolated
   minimal `build_block` that produces one block, that `dlopen` →
   `dlsym("run")` → cast → call works and returns the expected PC.

3. **Import-name reconciliation** (§7 a/b/c): pick one and confirm by
   building a single block that does `env.sh4_read32(...)` and
   verifying the call lands in the main module's `_sh4_mem_read32`.

4. **Main-thread dlsync cost under our pthread proxy queue**:
   measure wall-time of `dlopen` from the SH4 pthread under realistic
   main-thread load (paint loop active). If > 2-3 ms per dlopen
   sustained, batch via §6 per-DSO grouping.

5. **MEMFS pressure**: after 10K compiles, is `/tmp/blocks/` taking
   meaningful memory? If so, add `unlink(path)` after successful
   dlopen (the loader has already copied bytes into `file_data`).

6. **Per-dispatch wall-time delta**: the goal of Phase 4 is throughput.
   Probe via `build_and_probe.sh` and compare `[stats] disp=N/s` with
   the current epoch path baseline (currently ~21-24K disp/s at
   plateau). A 4-8× improvement is what eliminating JS hops should
   yield; less than 2× would suggest the dispatch hop wasn't the
   actual bottleneck and we should re-measure where the cycles go
   (Liftoff dispatch loop itself, RAM-base lookup, etc.).

---

## Summary of files touched

| File | Change |
|---|---|
| `dreamcast/flycast-bridge/rec_wasm.cpp` | Delete §2.1 lines; add §2.2-2.6 |
| `dreamcast/flycast-bridge/flycast_worker_funcs.js` | Delete §7 lines (~180 lines removed) |
| `dreamcast/flycast-bridge/flycast_worker_link.sh` | Add `-sMAIN_MODULE=2` (§8) |
| `bementalJIT/include/bementalJIT/wasm_module_builder.h` + `wasm_module_builder.cpp` | Add `emitDylinkSection()` helper (§3.1) |
| `bementalJIT/guests/sh4/wasm_emit.cpp` | Call `emitDylinkSection()` at top of `build_block` (and `build_epoch_module` if we keep the epoch helper alive for §6 batching) |
| (optional) `bementalJIT/guests/sh4/wasm_emit.h` | If §7-(a) chosen, rename `WIMPORT_*` import names |

No changes to: `EmscriptenWorker.cpp`, `flycast_stubs.cpp`, build
patches under `patches/`, `dreamcast.html`, `flycast_worker.js`
(shim — it's not in the dispatch path).

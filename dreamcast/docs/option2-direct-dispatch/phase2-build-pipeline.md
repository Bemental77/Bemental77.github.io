# Option 2 — Direct C-to-WASM Dispatch
## Phase 2: Build Pipeline Changes for `MAIN_MODULE` / `SIDE_MODULE`

**Status:** Research only — does not modify any source.
**Toolchain version:** Emscripten **3.1.67** (from `emsdk/upstream/emscripten/emscripten-version.txt`).
**Target file to modify (Phase 3):** `dreamcast/flycast-bridge/flycast_worker_link.sh`.

This document answers the five Phase-2 questions and ends with verification steps,
risk register, and open questions that can only be resolved by an actual build.

All claims are cited from the local Emscripten 3.1.67 source tree
(`emsdk/upstream/emscripten/...`).

---

## 0. Why MAIN_MODULE at all (recap)

Per `dreamcast_inwasm_dispatcher_plan.md`, the per-flush `new
WebAssembly.Module(epoch_bytes)` cost is the dominant gap once the active
block set passes ~512 entries — full Liftoff codegen runs O(module-byte-size)
on every flush.

Option 2's premise: stop emitting one growing super-module, instead emit one
tiny `SIDE_MODULE` wasm **per block** and `dlopen()` it. Each side-module is
~hundreds of bytes; per-block Liftoff cost is O(1). The main module
(`flycast_worker_emcc.wasm`) becomes a `MAIN_MODULE`, exporting the
glue/runtime/HLE/memory symbols the side modules need to call back into
(`sh4_mem_read*`, `sh4_mem_write*`, etc.).

Direct C-to-wasm dispatch follows naturally: once the side module's exported
fn is in the main module's `wasmTable` (via the dylink relocation step), the
C side can call it through a fn-pointer — no `EM_JS` round-trip, no
JS-side `Map.get`.

---

## 1. Exact link-flag set for `MAIN_MODULE`

### 1a. `MAIN_MODULE=1` vs `MAIN_MODULE=2`

`emsdk/upstream/emscripten/src/settings.js:1130-1139`:

```
// A main module is a file compiled in a way that allows us to link it to
// a side module at runtime.
//
// - 1: Normal main module.
// - 2: DCE'd main module. We eliminate dead code normally. If a side
//   module needs something from main, it is up to you to make sure
//   it is kept alive.
```

`emsdk/upstream/emscripten/tools/link.py:1004-1011`:

```
if settings.MAIN_MODULE:
  assert not settings.SIDE_MODULE
  if settings.MAIN_MODULE == 1:
    settings.INCLUDE_FULL_LIBRARY = 1
  ...
if settings.MAIN_MODULE == 1 or settings.SIDE_MODULE == 1:
  settings.LINKABLE = 1
```

`MAIN_MODULE=1` forces `INCLUDE_FULL_LIBRARY=1` and `LINKABLE=1`. That cascades
into:

1. `INCLUDE_FULL_LIBRARY=1` (`settings.js:1113-1122`) pulls in every JS-library
   function emscripten ships, "needed when dynamically loading (i.e. dlopen)
   modules that make use of runtime library functions that are not used in the
   main module." Cost: large generated-JS bloat — the 3.1.58 ChangeLog entry
   (`ChangeLog.md:115-121`) notes the simple-program JS shrink from 3.3 MB to
   0.5 MB when this stopped re-exporting onto `Module`.
2. `LINKABLE=1` (`settings.js:1184-1195`) passes `--whole-archive` +
   `--export-dynamic` to wasm-ld. The double link pass in `link.py:1857-1872`
   confirms: in `LINKABLE` mode, ~7000+ symbols are exported and metadata is
   re-extracted.

`MAIN_MODULE=2` is the **DCE'd** form. It does **not** auto-set
`INCLUDE_FULL_LIBRARY` and does **not** set `LINKABLE`. You explicitly list
what the side modules will need via `EXPORTED_FUNCTIONS`. The 2.0.18 ChangeLog
(`ChangeLog.md:1400-1405`) says directly:

```
- When building with `MAIN_MODULE=2` the linker will now automatically
  include any symbols required by side modules found on the command line.
  This means that for many users of `MAIN_MODULE=2` it should no longer
  be necessary to list explicit `EXPORTED_FUNCTIONS`. Also, users of
  `MAIN_MODULE=1` ... should be able to switch to `MAIN_MODULE=2` and
  get a reduction in code size.
```

**Choice for us: `-sMAIN_MODULE=2`.**

Rationale:
- Our SIDE_MODULEs are **generated at runtime** (not present on the link
  command-line), so we cannot rely on link-time auto-inclusion. We must use
  the existing `EXPORTED_FUNCTIONS` list in `flycast_worker_link.sh:40-64`
  and add to it the symbols runtime-generated side modules import:
  `sh4_mem_read{8,16,32}`, `sh4_mem_write{8,16,32}`, plus any helpers the
  emitter generates calls to.
- The size penalty of `MAIN_MODULE=1`'s `INCLUDE_FULL_LIBRARY=1` is
  unacceptable for a worker module that already weighs in around the WASM
  size cliff (`flycast_worker_emcc.wasm` is committed and large). The
  3.1.58 ChangeLog (`ChangeLog.md:115-121`) is explicit about the JS-side
  bloat.

### 1b. `EXPORT_ALL=1` — needed?

`emsdk/upstream/emscripten/src/settings.js:1075-1086`:

```
// If true, we export all the symbols of the wasm module. This is useful
// (with MAIN_MODULE=2) to allow runtime-loaded side modules to call any
// symbol in the main module without having to enumerate them...
// This does not affect which symbols will be present - it does not
// prevent DCE or cause anything to be included in linking. It only does
// ``Module['X'] = X;`` for all X that end up in the JS file.
var EXPORT_ALL = false;
```

The v1.38.16 ChangeLog (`ChangeLog.md:2529-2535`) explicitly broke the
old auto-`EXPORT_ALL`-on-MAIN_MODULE behaviour; the user must opt in now.

**Choice: do NOT set `EXPORT_ALL=1`.** Use explicit `EXPORTED_FUNCTIONS`.
`EXPORT_ALL=1` doesn't help symbol resolution between MAIN and SIDE
modules at the wasm level — that runs through the GOT and dynamic linker
(`library_dylink.js:665-721`), which resolves against `wasmImports` and
loaded-module exports regardless of whether they appear on `Module`.

What `EXPORT_ALL` would change: it adds `Module['X'] = X` lines in the
generated JS, useful only if JS-side code on the page wants to call into
those symbols. We don't need that here — JS-side dispatch is going away.

### 1c. `ALLOW_TABLE_GROWTH=1`

Already set in `flycast_worker_link.sh:200`. `link.py:1028-1048` makes
this **automatic** under `RELOCATABLE`:

```
if settings.RELOCATABLE:
  settings.DEFAULT_LIBRARY_FUNCS_TO_INCLUDE += [...]
  ...
  # shared modules need memory utilities to allocate their memory
  settings.ALLOW_TABLE_GROWTH = 1
```

And `library_dylink.js:646-652` is the code that grows it on each side-module
load:

```
var tableGrowthNeeded = tableBase + metadata.tableSize - wasmTable.length;
if (tableGrowthNeeded > 0) {
  wasmTable.grow(tableGrowthNeeded);
}
```

**No change needed** — it's redundant under MAIN_MODULE but harmless and
explicit (good for readability).

### 1d. `USE_PTHREADS` (we use `-pthread`) interaction

`link.py:485-492`:

```
if settings.RELOCATABLE:
  # pthreads + dynamic linking has certain limitations
  if settings.SIDE_MODULE:
    diagnostics.warning('experimental', '-sSIDE_MODULE + pthreads is experimental')
  elif settings.MAIN_MODULE:
    diagnostics.warning('experimental', '-sMAIN_MODULE + pthreads is experimental')
```

**Status: officially "experimental" but supported.** The combo emits a
warning, not an error. Same file at `link.py:515-522`:

```
if settings.MAIN_MODULE:
  settings.REQUIRED_EXPORTS += [
    '_emscripten_dlsync_self',
    '_emscripten_dlsync_self_async',
    '_emscripten_proxy_dlsync',
    '_emscripten_proxy_dlsync_async',
    '__dl_seterr',
  ]
```

These extra exports are auto-added; they handle the "side module loaded on
thread A must be visible to thread B" cross-thread sync. Our `flycast_worker`
runs as a single pthread (`PROXY_TO_PTHREAD`/`PTHREAD_POOL_SIZE=8` in the
link script — only one of those pool threads runs the SH4 dispatch loop),
so the dlsync cost is small but non-zero.

`library_dylink.js:736-745`: when MAIN_MODULE is on with PTHREADS, side
modules are cached in `sharedModules` and posted to new workers; the dylink
runtime handles this transparently.

### 1e. Flags that **become required** when `MAIN_MODULE` is on

#### `-fPIC` on object compilation

`emcc.py:378-379`:

```
if settings.RELOCATABLE and '-fPIC' not in user_args:
  flags.append('-fPIC')
```

And `emcc.py:835-836`:

```
if settings.MAIN_MODULE or settings.SIDE_MODULE:
  settings.RELOCATABLE = 1
```

So `MAIN_MODULE` → `RELOCATABLE` → `-fPIC` is auto-appended **at every emcc
invocation that sees `-sMAIN_MODULE=2`**. The catch: this only fires for
TUs compiled by *this* emcc invocation. Object files inside the pre-built
`.a` archives (`libflycast_libretro.a`, `libbementalJIT.a`, etc.) were
compiled by a *different* emcc invocation that did NOT have `-sMAIN_MODULE`
set, so they were NOT built with `-fPIC`. See §3 for what that implies.

#### `-fvisibility=default`

`emcc.py:381-387`:

```
if settings.RELOCATABLE or settings.LINKABLE or '-fPIC' in user_args:
  if not any(a.startswith('-fvisibility') for a in user_args):
    flags.append('-fvisibility=default')
```

Auto-applied. Side modules need `default` visibility to find imports;
LLVM's wasm backend defaults to `hidden`.

#### `IMPORTED_MEMORY=1`

`link.py:1412-1413`:

```
if settings.SHARED_MEMORY or settings.RELOCATABLE or settings.ASYNCIFY_LAZY_LOAD_CODE:
  settings.IMPORTED_MEMORY = 1
```

Auto-set by `RELOCATABLE` (i.e. by MAIN_MODULE). We already pass
`-sIMPORTED_MEMORY=1` explicitly (`flycast_worker_link.sh:196`) — keep it,
it's a no-op redundancy.

#### `--export-dynamic` (handled internally)

`link.py:1857-1872` runs wasm-ld twice in `LINKABLE` mode. Since we're using
`MAIN_MODULE=2` (no auto-LINKABLE), this path doesn't fire — the link is
a single pass + we rely on `EXPORTED_FUNCTIONS` for what to expose.

### 1f. Summary — proposed `emcc` flag delta

Drop these flags? **None.**

Add these flags?

| Flag | Source justification |
|---|---|
| `-sMAIN_MODULE=2` | `settings.js:1130-1139`, `ChangeLog.md:1400-1405` |
| (no `-sEXPORT_ALL=1`) | `settings.js:1075-1086`, `ChangeLog.md:2529-2535` |
| (no `-sLINKABLE=1`) | implied not-set by `MAIN_MODULE=2`; saves the double-link pass |
| Extra entries in `EXPORTED_FUNCTIONS` | side modules dlopen-resolve against `wasmImports` (`library_dylink.js:707-720`) |

The extra `EXPORTED_FUNCTIONS` entries are the ones generated SH4
side-modules emit calls to. From `bementalJIT/guests/sh4/wasm_emit.cpp`
(imports declared in `emitTypeImportSection` / `emitImportSection` —
inspect the actual emitter to enumerate). The existing list already
contains `_sh4_mem_read{8,16,32}` and `_sh4_mem_write{8,16,32}` plus
`_sh4_interp_ifb`, `_sh4_interp_shil_fb` — these are the SH4
fast-path callbacks the per-block emit already imports. **No new entries
should be needed** if the side-module's import list is a subset of what
the epoch-module already imports.

`-sERROR_ON_UNDEFINED_SYMBOLS=1` should be acceptable per
`ChangeLog.md:1406-1409`: *"When building with MAIN_MODULE it is now
possible to warn or error on undefined symbols assuming all the side
modules are passed at link time."* For us, the inverse holds — side
modules are runtime-only — so we may need `-sERROR_ON_UNDEFINED_SYMBOLS=0`
on the side-module compile step, but the main module link can keep its
default (assuming the main module itself is self-contained, which it is
today).

---

## 2. Per-block SIDE_MODULE compile

### 2a. Can a SIDE_MODULE be produced from raw wasm bytes (no C source)?

**Answer: no, not via emcc.** A SIDE_MODULE wasm requires a `dylink.0`
custom section with the exact layout the runtime parses in
`library_dylink.js:464-513`:

```
} else {
  failIf(name !== 'dylink.0');
  var WASM_DYLINK_MEM_INFO = 0x1;
  var WASM_DYLINK_NEEDED = 0x2;
  var WASM_DYLINK_EXPORT_INFO = 0x3;
  var WASM_DYLINK_IMPORT_INFO = 0x4;
  ...
  if (subsectionType === WASM_DYLINK_MEM_INFO) {
    customSection.memorySize = getLEB();
    customSection.memoryAlign = getLEB();
    customSection.tableSize = getLEB();
    customSection.tableAlign = getLEB();
  } else if (subsectionType === WASM_DYLINK_NEEDED) { ... }
  else if (subsectionType === WASM_DYLINK_EXPORT_INFO) { ... }
  else if (subsectionType === WASM_DYLINK_IMPORT_INFO) { ... }
}
```

The section also needs to be **first after the wasm header** (`library_dylink.js:443`:
*"need the dylink section to be first"*). Plus the wasm itself must use the
relocatable ABI — function-imports prefixed `env.`, globals through GOT.func/
GOT.mem, all addresses offset by `__memory_base` / `__table_base`.

Two paths forward:

**Path A: emit `dylink.0` and the relocatable ABI from `wasm_emit.cpp`.**
The emitter already builds wasm modules from scratch (`build_block`,
`build_epoch_module` in `bementalJIT/guests/sh4/wasm_emit.cpp:1390+`). Adding
a `dylink.0` writer is mechanical: emit `MEM_INFO` (memorySize=0,
memoryAlign=0, tableSize=1, tableAlign=0 — the block needs 1 tableslot for
its exported fn) and a 0-length `NEEDED`. The current emitter's imports
are already namespaced `env.<symbol>`, which is the dylink ABI. This
avoids emcc on the per-block hot path entirely.

**Path B: write a tiny C shim, emcc it as SIDE_MODULE.** Per block emit a
~50-byte C file that calls `__attribute__((import_name("run_<id>"))) extern
uint32_t run_impl(uint32_t, uint32_t);` and re-exports it. Then `emcc
-sSIDE_MODULE=1 shim.c -o block.wasm`. This works but adds a process-fork
per block (emcc + wasm-ld + binaryen), which destroys the throughput goal.
Hard reject.

**Recommendation: Path A.** Cite `library_dylink.js:464-513` for the
section layout. Adds ~30 LoC to `wasm_emit.cpp::build_block`, no per-block
process forks, no toolchain dependency at runtime.

### 2b. If we did emcc per-block (rejected, for reference)

```bash
emcc shim.c \
  -o block_<vaddr>.wasm \
  -sSIDE_MODULE=1 \
  -O2 \
  -pthread \
  -matomics -mbulk-memory -mtail-call \
  -fPIC \
  -fvisibility=default \
  -Wl,--allow-undefined
```

Notes:
- `-pthread`/`-matomics` MUST match the main module's flags (`link.py:485-492`
  cascades shared-memory settings).
- `-Wl,--allow-undefined` because the side module imports symbols
  (`sh4_mem_read*`) it will only resolve at dlopen time.
- Output `block_*.wasm` goes wherever `dlopen()` will look — see §2d.

### 2c. Output `.wasm` paths and `dlopen` conventions

From `library_dylink.js:1010-1019`:

```
var libFile = locateFile(libName);
if (flags.loadAsync) {
  return new Promise((resolve, reject) => asyncLoad(libFile, resolve, reject));
}
if (!readBinary) {
  throw new Error(`${libFile}: file not found, and synchronous loading
                   of external files is not available`);
}
return readBinary(libFile);
```

Two delivery options:

1. **In-memory via the DSO file_data fields.** `library_dylink.js:1001-1008`:
   ```
   if (handle) {
     var data = makeGetValue('handle', C_STRUCTS.dso.file_data, '*');
     var dataSize = makeGetValue('handle', C_STRUCTS.dso.file_data_size, '*');
     if (data && dataSize) {
       var libData = HEAP8.slice(data, data + dataSize);
       return libData;
     }
   }
   ```
   The C side can set `dso->file_data = ptr; dso->file_data_size = N;` on the
   handle before triggering loadDynamicLibrary, bypassing the FS entirely.
   This is the path Option 2 wants — block bytes never leave wasm linear
   memory.

2. **Via FS.** The C side writes block bytes to an MEMFS path
   (`/tmp/block_<vaddr>.wasm`), then `dlopen("/tmp/block_<vaddr>.wasm",
   RTLD_NOW)`. Round trip through FS + asyncLoad → strictly worse than
   path 1 for performance.

**Choice: in-memory via `file_data`.** Inspect `system/lib/libc/musl/src/internal/dynlink.h`
(or the locally-shipped equivalent) for the exact `struct dso` layout
before wiring. The `C_STRUCTS.dso.file_data` offset is generated from the
struct definition at build time.

### 2d. Metadata overhead per side module

Per-block fixed cost of relocatable wasm:

- **Wasm header**: 8 bytes.
- **`dylink.0` custom section**: ~12-20 bytes for the MEM_INFO subsection
  (memorySize=0, memoryAlign=0, tableSize=1, tableAlign=0) + 0-length
  NEEDED/EXPORT_INFO. With LEB128 encoding and the section framing, expect
  ~15 bytes.
- **Imports section**: 1 entry per symbol (e.g. `env.sh4_mem_read32`) ≈
  20-30 bytes per import. A typical SH4 block emits calls into ~5-10
  helpers; call it ~150 bytes of imports.
- **GOT relocations**: `library_dylink.js:725-727` injects a `GOT.mem` and
  `GOT.func` import-namespace via `Proxy`; the side module imports
  `GOT.mem.<sym>` for any external data + `__memory_base` / `__table_base`
  globals. Add ~30 bytes for the base globals.
- **Function/Code/Export**: identical to the current non-relocatable
  per-block emit.

Net overhead vs the current (non-relocatable) per-block emit: **~200
bytes/block of dylink+GOT framing**. For 1395 blocks that's ~280 KB of
overhead — but compared to the *current* approach (one growing 500+ KB
super-module re-compiled every flush), it's a fixed amortized cost, not
quadratic.

---

## 3. Object-file rebuild requirements

### 3a. Do the `.a` archives need rebuilding with `-fPIC`?

**Yes, for objects in archives the MAIN_MODULE references.** Per
`emcc.py:378-387`, `-fPIC` + `-fvisibility=default` are appended only on
TU compilation that itself sees `-sMAIN_MODULE=2`. Pre-built archives
were compiled by separate emcc invocations (the `emmake make
flycast_libretro -j4` step in `dreamcast/flycast-src/build-wasm/`) that
did NOT have `-sMAIN_MODULE=2`, so:

- `.o` files in those archives have `visibility=hidden` defaults.
- Static-data addresses are absolute, not relative to `__memory_base`.
- Static-fn references are direct call indices, not GOT-mediated.

In practice, wasm-ld at the final link step **can** mix non-relocatable
static archives into a relocatable main-module link by treating them as
"statically linked into the main module" (which is what they are — the
main module statically links libflycast_libretro.a, libbementalJIT.a, etc.,
and *those symbols* then need to be re-exported so side modules can find
them). The wasm-ld behaviour: it'll succeed unless an object explicitly
forbids relocation (none of ours do — they all use the default LLVM wasm
backend).

**Empirical risk:** undefined behaviour around C++ vtables, static
initializers, and TLS in mixed-PIC linking is documented as fragile.
The `MAIN_MODULE + pthreads is experimental` warning at `link.py:489-490`
applies precisely here. Worst case: vtable lookups silently mis-resolve;
TLS slots collide.

**Recommendation:** rebuild the archives `MAIN_MODULE`-aware by adding
`-fPIC` to CMake. This is a one-time cost, mechanical. See §3b.

### 3b. CMake change

`dreamcast/flycast-src/build-wasm/CMakeCache.txt` currently has:

```
CMAKE_C_FLAGS:STRING=-pthread -matomics -mbulk-memory
CMAKE_CXX_FLAGS:STRING=-pthread -matomics -mbulk-memory
```

Required change at the `emcmake cmake ...` configure step:

```bash
emcmake cmake \
  -DCMAKE_POSITION_INDEPENDENT_CODE=ON \
  -DCMAKE_C_FLAGS='-pthread -matomics -mbulk-memory -fPIC' \
  -DCMAKE_CXX_FLAGS='-pthread -matomics -mbulk-memory -fPIC' \
  ...
```

`CMAKE_POSITION_INDEPENDENT_CODE=ON` is the canonical way; the explicit
`-fPIC` in `CMAKE_C_FLAGS`/`CMAKE_CXX_FLAGS` is a belt-and-braces backup
for sub-projects that don't honour the property (libchdr, libzip, etc.
often override flags). Both can coexist.

Add `-fvisibility=default` only if `-fPIC` doesn't propagate it everywhere
— per `emcc.py:381-387` it should propagate automatically when `-fPIC` is
on user_args.

**Repeat for the `bementalJIT/build-emcc/` subbuild** (the per-CMake
`add_subdirectory(${repo}/bementalJIT ...)` configured by patches/0003 —
it inherits parent CMAKE_* flags, so the parent change should cover it).
Verify by checking `bementalJIT/build-emcc/CMakeCache.txt` (or wherever
the subbuild lives) for the propagated flags after re-configure.

### 3c. Order of operations

1. `rm -rf dreamcast/flycast-src/build-wasm` (full nuke — partial rebuilds
   with changed CMAKE_C_FLAGS are unreliable).
2. Re-`emcmake cmake ...` with the additions in §3b.
3. `emmake make flycast_libretro -j4` (or whatever the canonical build cmd is).
4. Then run the modified `flycast_worker_link.sh` (with `-sMAIN_MODULE=2`).

---

## 4. Symbol resolution main↔side

### 4a. How side modules find main-module symbols

`library_dylink.js:665-721` is the resolution chain:

```
function resolveSymbol(sym) {
  var resolved = resolveGlobalSymbol(sym).sym;
  if (!resolved && localScope) {
    resolved = localScope[sym];
  }
  if (!resolved) {
    resolved = moduleExports[sym];
  }
  return resolved;
}
```

`resolveGlobalSymbol` ultimately checks `wasmImports` — the same table
the main module exports through `EXPORTED_FUNCTIONS`. So:

- Symbol on `EXPORTED_FUNCTIONS` of main → in `wasmImports` → side module
  resolves it.
- Symbol NOT exported → falls through to localScope (other already-loaded
  side modules) → fails with the assertion message from `library_dylink.js:674`:
  ```
  assert(resolved, `undefined symbol '${sym}'. perhaps a side module was
                    not linked in? if this global was expected to arrive
                    from a system library, try to build the MAIN_MODULE
                    with EMCC_FORCE_STDLIBS=1 in the environment`);
  ```

### 4b. So is `EXPORT_ALL=1` enough?

**No** — `EXPORT_ALL` only affects `Module['X']` (JS-side accessors), not
wasm exports. The wasm export list is controlled by `EXPORTED_FUNCTIONS`.

### 4c. Bare `extern` decls on the side suffice?

Yes — the side-module emitter just declares the symbol as an `env.<name>`
import. The relocatable ABI then routes it through `wasmImports`. No
attribute decorations needed on the side side. On the main side, the
function must:

1. Be present in the linked binary (referenced by something, OR force-kept
   via `-Wl,-u,_<name>`).
2. Be in `EXPORTED_FUNCTIONS` so it lands in `wasmImports`.

Our `EXPORTED_FUNCTIONS` block at `flycast_worker_link.sh:40-64` already
includes `_sh4_mem_read{8,16,32}`, `_sh4_mem_write{8,16,32}`,
`_sh4_interp_ifb`, `_sh4_interp_shil_fb`. **Audit step:** diff against
the actual imports declared by `bementalJIT/guests/sh4/wasm_emit.cpp::build_block`
to confirm coverage. If `build_block` imports something not in
EXPORTED_FUNCTIONS (e.g. a helper added later), the side module will throw
on dlopen.

### 4d. Visibility attributes?

Not strictly needed once the file is built with `-fPIC` + auto
`-fvisibility=default`. Belt-and-braces: tag the main-module exports the
side modules need with `EMSCRIPTEN_KEEPALIVE` (defined in
`emscripten/em_macros.h` to `__attribute__((used,visibility("default")))`).
This survives DCE and any visibility-attribute regressions.

---

## 5. Memory model under `IMPORTED_MEMORY` + `SHARED_MEMORY` + `MAIN_MODULE`

### 5a. Shared heap propagation

Side modules **inherit the main module's `WebAssembly.Memory`** automatically.
`library_dylink.js:724-729`:

```
var info = {
  'GOT.mem': new Proxy({}, GOTHandler),
  'GOT.func': new Proxy({}, GOTHandler),
  'env': proxy,
  '{{{ WASI_MODULE_NAME }}}': proxy,
};
```

The `env` proxy (`library_dylink.js:707-720`) routes `env.memory` (and
every other `env.*` import) to whatever's in `wasmImports`. The
main-module-installed memory is in `wasmImports['memory']` (Emscripten's
runtime convention), so the side module sees the same `SharedArrayBuffer`.

`link.py:540-543`:

```
if settings.IMPORTED_MEMORY:
  if user_specified_initial_heap:
    exit_with_error('INITIAL_HEAP is currently not compatible with
                     IMPORTED_MEMORY (which is enabled indirectly via
                     SHARED_MEMORY, RELOCATABLE, ASYNCIFY_LAZY_LOAD_CODE)')
```

We already have `INITIAL_MEMORY=...`, not `INITIAL_HEAP`, so this check
passes.

### 5b. Per-module static-data allocation

`library_dylink.js:632`:

```
var memoryBase = metadata.memorySize ?
  alignMemory(getMemory(metadata.memorySize + memAlign), memAlign) : 0;
```

Each side module gets a fresh slab in the shared heap via `getMemory`
(`library_dylink.js:367-387`). Pre-`runtimeInitialized` this just bumps
`__heap_base`; post-init it goes through `_malloc`. With memorySize=0 (no
statics in a generated SH4 block) this allocator is a no-op (`metadata.memorySize ? ... : 0`).

### 5c. Table base

Same pattern (`library_dylink.js:633`):

```
var tableBase = metadata.tableSize ? wasmTable.length : 0;
```

Then grows the table if needed (`library_dylink.js:646-652`, already
cited). Each block needs `tableSize=1` (one slot for its exported fn,
which becomes a fn pointer the C side can call_indirect through), so
each dlopen grows wasmTable by 1.

---

## 6. Modified `flycast_worker_link.sh` — proposed diff

Annotated. Line numbers from the current 242-line file.

```diff
@@ Line 40-64 (EXPORTED_FUNCS) — verify coverage but no diff expected if
@@ wasm_emit.cpp imports remain the SH4-mem + SH4-interp set. ADD any newly
@@ required helpers here BEFORE flipping MAIN_MODULE=2 on (else dlopen will
@@ throw 'undefined symbol' per library_dylink.js:674).

@@ Line 188-216 (emcc invocation) — additions:

   -O3 \
   -std=c++23 \
   -fno-strict-aliasing \
   -fomit-frame-pointer \
   -fexceptions \
   -DNDEBUG \
   -D__LIBRETRO__ \
   -pthread \
   -matomics -mbulk-memory -mtail-call \
+  -sMAIN_MODULE=2 \
+  # MAIN_MODULE=2 = DCE'd main; explicit EXPORTED_FUNCTIONS controls
+  # what side modules can dlsym. ChangeLog.md:1400-1405 says auto-include
+  # for cmd-line-listed side modules — ours are runtime-generated so
+  # EXPORTED_FUNCTIONS list IS the contract. settings.js:1130-1139.
   -sIMPORTED_MEMORY=1 \
   -sINITIAL_MEMORY=536870912 \
   -sMAXIMUM_MEMORY=4294967296 \
   -sALLOW_MEMORY_GROWTH=1 \
   -sALLOW_TABLE_GROWTH=1 \
+  # ALLOW_TABLE_GROWTH redundant under MAIN_MODULE (link.py:1028-1048
+  # forces it via RELOCATABLE) but explicit for clarity. Each dlopen
+  # grows wasmTable by side-module.tableSize (=1/block in our case).
   -sPTHREAD_POOL_SIZE=8 \
   -sASYNCIFY=1 \
   -sUSE_WEBGL2=1 \
   -sFULL_ES3=1 \
   -sMIN_WEBGL_VERSION=2 \
   -sMAX_WEBGL_VERSION=2 \
   -sOFFSCREENCANVAS_SUPPORT=1 \
   -sENVIRONMENT=worker \
   -sMODULARIZE=1 \
   -sEXPORT_NAME=flycastWorkerModule \
   -sEXIT_RUNTIME=0 \
   -sSTACK_SIZE=8388608 \
   -Wl,--allow-multiple-definition \
   -Wl,-u,_emscripten_thread_crashed \
   -Wl,-u,_emscripten_thread_free_data \
+  # If any side-module symbol is dropped by DCE before EXPORTED_FUNCTIONS
+  # kicks in, add: -Wl,-u,_<symbol> here. Inspect post-link wasm with
+  # wasm-objdump -x | grep '<symbol>' to confirm presence.
   -sEXPORTED_FUNCTIONS="$EXPORTED_FUNCS" \
   -sEXPORTED_RUNTIME_METHODS="$EXPORTED_RUNTIME" \
   --emit-symbol-map \
   -g2 \
```

**Things explicitly NOT added:**
- `-sEXPORT_ALL=1` (settings.js:1075-1086 says it's `Module[X]=X` only,
  doesn't affect wasm-level resolution).
- `-sLINKABLE=1` (would force the double-link pass at link.py:1857-1872
  and over-export ~7000 symbols).
- `-sMAIN_MODULE=1` (forces `INCLUDE_FULL_LIBRARY=1` per link.py:1006-1007,
  bloats JS output massively per ChangeLog.md:115-121).
- `-sAUTOLOAD_DYLIBS=0` (default true per settings.js:2117-2119; we have
  no cmd-line side modules to auto-load, so the default is a no-op).

---

## 7. CMake-side changes

### 7a. Reconfigure flags

In whatever script wraps `emcmake cmake ...` for `dreamcast/flycast-src/build-wasm/`,
add:

```
-DCMAKE_POSITION_INDEPENDENT_CODE=ON
-DCMAKE_C_FLAGS="-pthread -matomics -mbulk-memory -fPIC"
-DCMAKE_CXX_FLAGS="-pthread -matomics -mbulk-memory -fPIC"
```

(Append `-fPIC` to the existing values, don't replace.)

### 7b. Cache flush

A flag change of this magnitude requires a clean rebuild:

```bash
rm -rf dreamcast/flycast-src/build-wasm
# re-run the cmake configure step from scratch
# then: cd dreamcast/flycast-src/build-wasm && emmake make flycast_libretro -j4
```

Partial rebuild with changed PIC-ness produces silently-broken object
files (some PIC, some not) that wasm-ld may accept but produce runtime
crashes in vtable / virtual-call / TLS-init paths.

### 7c. bementalJIT subbuild

Patch 0003 adds `bementalJIT/` to the build via `add_subdirectory`. Because
CMake propagates `CMAKE_*_FLAGS` and `CMAKE_POSITION_INDEPENDENT_CODE`
into subdirectories by default, no separate change is needed for the
`bementalJIT/` subproject. Verify after re-configure by inspecting the
sub-build's `CMakeCache.txt` (typically `build-wasm/bementalJIT/CMakeCache.txt`).

---

## 8. Verification steps post-build

### 8a. Confirm main module has `dylink.0` metadata

`wasm-objdump` ships with the emsdk's binaryen — under
`emsdk/upstream/bin/`. Run:

```bash
emsdk/upstream/bin/wasm-objdump -h \
  dreamcast/flycast_libretro/flycast_worker_emcc.wasm | grep -i dylink
```

Expected: at least one `dylink.0` (or legacy `dylink`) custom section
listed. Actual main-module `dylink.0` includes the GOT/relocation metadata
that wasm-ld inserts under `LINKABLE`/`RELOCATABLE`.

Inspect contents:

```bash
emsdk/upstream/bin/wasm-objdump -x \
  dreamcast/flycast_libretro/flycast_worker_emcc.wasm | head -200
```

Look for:
- `Custom: name="dylink.0"` (section header).
- Imports namespaced `env.<symbol>` (relocatable ABI).
- A `__memory_base` and `__table_base` global (LLVM-injected for PIC code).
- `__indirect_function_table` exported (so side modules can grow it).

### 8b. Confirm exported-symbol coverage

```bash
emsdk/upstream/bin/wasm-objdump -x \
  dreamcast/flycast_libretro/flycast_worker_emcc.wasm \
  | grep -E 'Export.*func' | grep -E 'sh4_mem_|sh4_interp_'
```

Expected: all 8 symbols (`sh4_mem_read{8,16,32}`,
`sh4_mem_write{8,16,32}`, `sh4_interp_{ifb,shil_fb}`) appear as
exported funcs. If any is missing, add it to EXPORTED_FUNCTIONS in
`flycast_worker_link.sh` and re-link.

### 8c. Confirm a fabricated SIDE_MODULE loads

Build a 1-line test side module:

```bash
cat >/tmp/test_side.c <<'EOF'
__attribute__((visibility("default"))) int side_test_value = 42;
EOF
emcc /tmp/test_side.c -o /tmp/test_side.wasm \
  -sSIDE_MODULE=1 -O2 -pthread -matomics -mbulk-memory
```

Then verify it has the dylink section:

```bash
emsdk/upstream/bin/wasm-objdump -h /tmp/test_side.wasm | grep dylink
```

Expected: `Custom: name="dylink.0"`.

This validates the toolchain side; runtime loading needs a JS harness in
the actual page or a `dlopen()` call from a C entry-point exported on
the main module.

### 8d. Confirm `wasmTable` is the canonical `__indirect_function_table`

Open `dreamcast/flycast_libretro/flycast_worker_emcc.js` in a browser
console at runtime and check:

```js
flycastWorkerModule().then(m => console.log(m.wasmExports['__indirect_function_table']));
```

Expected: a `WebAssembly.Table` instance, length > 0 (depending on
initial table size, usually a few thousand entries).

---

## 9. Risks (interactions with other link flags)

### 9a. `-sASYNCIFY=1`

`link.py:368-371`:

```
if settings.ASYNCIFY == 1:
  passes += ['--asyncify']
  if settings.MAIN_MODULE or settings.SIDE_MODULE:
    passes += ['--pass-arg=asyncify-relocatable']
```

ASYNCIFY + MAIN_MODULE is **supported** (ChangeLog 3.1.x line 852: *"Add
support for dynamic linking with Asyncify."*). The extra
`asyncify-relocatable` pass instruments differently. Side modules
**must also pass `-sASYNCIFY=1`** if they call any asyncify-able function
(via dlsym, etc.) — for raw SH4 blocks that don't call asyncify-able
imports, they don't need it.

`library_dylink.js:749-751`:

```
moduleExports = relocateExports(instance.exports, memoryBase);
#if ASYNCIFY
moduleExports = Asyncify.instrumentWasmExports(moduleExports);
#endif
```

The dylink runtime wraps side-module exports with the Asyncify
instrumentation automatically. **Risk: low** — but the wrap **may** add
per-call overhead that defeats the throughput goal of Option 2. Worth
benchmarking: wrapped side-fn vs raw exported main-fn dispatch time.

### 9b. `-sFULL_ES3=1` + `-sOFFSCREENCANVAS_SUPPORT=1`

These pull in `library_gl.js` and the canvas-transfer machinery, but
neither touches RELOCATABLE/dylink. **Risk: nil.**

### 9c. `-Wl,--allow-multiple-definition`

Suppresses ODR violations from the patches that add bementalJIT
overrides for libretro symbols. Under `MAIN_MODULE=2` + `LINKABLE=0`,
the linker still does DCE-aware single-link (not the double-pass), so
multiple-definition handling is unchanged. **Risk: nil.**

### 9d. Post-build `sed` patch for transferredCanvasNames

`flycast_worker_link.sh:238-241` does a `sed -i ''` on the generated JS
to inject a missing null-check in the Emscripten 3.1.67 pthread runtime.
The relevant JS lives in the pthread-create path, not the dylink path.
**Risk: nil** — but verify the sed pattern still matches the generated
JS post-MAIN_MODULE (which expands `INCLUDE_FULL_LIBRARY` only at
MAIN_MODULE=1 — we're using =2 so the relevant pthread JS should be
identical).

### 9e. `-sPTHREAD_POOL_SIZE=8` + experimental warning

Per `link.py:489-490`:

```
elif settings.MAIN_MODULE:
  diagnostics.warning('experimental', '-sMAIN_MODULE + pthreads is experimental')
```

`emsdk` will print a warning at link time. Suppress with
`-Wno-experimental` if desired (cosmetic only). **Risk: medium** —
"experimental" in Emscripten terms means "tested but may have rough
edges." Known rough edge: `sharedModules` (`library_dylink.js:737-744`)
posting side modules to newly-spawned pthreads. We spawn 8 — every one
must receive a copy of every dlopen'd block. The IPC cost may be
significant if we dlopen thousands of blocks; mitigate by only dlopen'ing
from the SH4 thread and never spawning new threads after JIT starts.

### 9f. `IMPORTED_MEMORY` + initial size

`flycast_worker_link.sh:197-199`:

```
-sINITIAL_MEMORY=536870912
-sMAXIMUM_MEMORY=4294967296
-sALLOW_MEMORY_GROWTH=1
```

Compatible with RELOCATABLE/MAIN_MODULE/SHARED_MEMORY per the
exit-with-error check at `link.py:540-543` (which only fires if
`INITIAL_HEAP` is set; we use `INITIAL_MEMORY`). **Risk: nil.**

### 9g. The `gl_override.js` library + `webgl2-compat.js` pre-js

Both are static JS includes. Under MAIN_MODULE, all generated JS is
still emitted into the same single file — there's no JS-side splitting
implied. **Risk: nil**, but the JS size grows due to extra dylink
runtime (`library_dylink.js` content is ~50 KB unminified).

---

## 10. Open questions requiring an actual build

1. **Does wasm-ld actually error on the mixed-PIC archive case?** §3a
   speculates it does not, but the actual link may fail with a relocation-
   mismatch error from wasm-ld. Only running the link with `-sMAIN_MODULE=2`
   against the un-rebuilt archives will tell. If it fails: §3a's
   recommendation (full PIC rebuild) becomes mandatory; if it succeeds:
   nice-to-have-but-deferrable.

2. **What is the actual JS bundle size delta?** `MAIN_MODULE=2` shouldn't
   pull `INCLUDE_FULL_LIBRARY=1`, but the dylink runtime itself
   (`library_dylink.js`, ~1260 lines) is included. Measure: `wc -c`
   before/after on the generated `.js`.

3. **What is the wasm-binary size delta?** With `--export-dynamic`
   suppressed (by NOT setting `LINKABLE=1`), the wasm export table
   should stay close to the current ~25 entries. Verify with
   `wasm-objdump -x | grep '^.*Export' | wc -l`.

4. **Does `flycast_worker_funcs.js`'s `flycast_install_epoch` /
   `flycast_register_block` path still work?** It must continue working
   during the transition — we don't ship Option 2 alongside revert; we
   build both code paths and env-gate. Per current source, those JS
   functions use `new WebAssembly.Module(bytes)` directly (not dlopen);
   they don't touch the dylink runtime. **Should remain functional.**

5. **Does Asyncify-instrumenting per-block side modules destroy
   throughput?** `library_dylink.js:749-751` wraps every side-module
   export. The wrapper adds a state-machine check on every call. May
   need to gate per-block side modules through a Module-property that
   suppresses the wrapper for blocks we know don't yield. Investigate
   `Asyncify.instrumentWasmExports` source.

6. **What is the actual `tableSize` to declare in `dylink.0`?** §2a
   assumed 1 per block (one exported fn). If the emitter declares
   internal funcrefs (e.g. for `call_indirect`-based tail-call links),
   table-size grows accordingly. Inspect `wasm_emit.cpp::build_block`
   for any `emitElementSection` / table entries.

7. **Cross-pthread `sharedModules` cost.** §9e speculates it could be
   significant at thousands-of-blocks scale. Only a measurement of
   page→pthread `postMessage` overhead at N=2000 dlopen'd modules can
   confirm. Mitigation if it bites: don't spawn additional pthreads
   after first JIT.

8. **Does `--pre-js webgl2-compat.js` survive MAIN_MODULE re-link?**
   The pre-js content is inserted before runtime setup; MAIN_MODULE
   adds dylink scaffolding that may conflict with WebGL2 shims if
   `WebAssembly.Memory` is reconstructed mid-init. Build-and-test only.

---

## 11. Citation index

All file paths are inside `/Users/caseybement/Bemental77.github.io/emsdk/upstream/emscripten/`.

| Claim | File:Line |
|---|---|
| `MAIN_MODULE=1` vs `=2` semantics | `src/settings.js:1130-1143` |
| `MAIN_MODULE=1` forces `INCLUDE_FULL_LIBRARY=1` and `LINKABLE=1` | `tools/link.py:1004-1012` |
| `EXPORT_ALL` is JS-side only, doesn't affect wasm export | `src/settings.js:1075-1086` |
| `LINKABLE` triggers double link pass + over-exports | `tools/link.py:1857-1872` |
| `RELOCATABLE` auto-set under MAIN/SIDE_MODULE at compile time | `emcc.py:835-836` |
| `-fPIC` auto-added under RELOCATABLE | `emcc.py:378-379` |
| `-fvisibility=default` auto-added under RELOCATABLE/LINKABLE/-fPIC | `emcc.py:381-387` |
| `IMPORTED_MEMORY` auto-set under RELOCATABLE | `tools/link.py:1412-1413` |
| `ALLOW_TABLE_GROWTH` auto-set under RELOCATABLE | `tools/link.py:1028-1048` |
| MAIN_MODULE + pthreads warning ("experimental") | `tools/link.py:485-492` |
| MAIN_MODULE extra REQUIRED_EXPORTS for dlsync | `tools/link.py:515-522` |
| dlopen → loadDynamicLibrary → loadWebAssemblyModule entry-point chain | `src/library_dylink.js:948-1068` |
| In-memory side module via `dso.file_data` | `src/library_dylink.js:1001-1008` |
| `dylink.0` custom section format (MEM_INFO/NEEDED/EXPORT/IMPORT subsections) | `src/library_dylink.js:464-513` |
| Side-module memory base via `getMemory` | `src/library_dylink.js:367-387, 632` |
| Side-module table-base + auto-grow | `src/library_dylink.js:633, 646-652` |
| Side-module `env`-import resolution via proxy → `wasmImports` | `src/library_dylink.js:707-720` |
| Side-module exports get Asyncify-instrumented | `src/library_dylink.js:749-751` |
| sharedModules cached + posted to new pthreads | `src/library_dylink.js:736-745` |
| MAIN_MODULE=2 auto-includes side-module symbols (cmd-line case) | `ChangeLog.md:1400-1405` |
| MAIN_MODULE=1 JS-size bloat | `ChangeLog.md:115-121` |
| Auto-EXPORT_ALL on MAIN_MODULE removed in v1.38.16 | `ChangeLog.md:2529-2535` |
| Asyncify+dynlink relocatable pass | `tools/link.py:368-371` |
| `dlopen` API in dlfcn.h | `cache/sysroot/include/dlfcn.h:1-46` |
| `emscripten_dlopen` async API | `system/include/emscripten/emscripten.h:177-185` |
| `test_dlopen_async.c` recipe (sSIDE_MODULE flag) | `test/test_other.py:7386-7395` |
| Emscripten version pin | `emscripten-version.txt:1` (`3.1.67`) |

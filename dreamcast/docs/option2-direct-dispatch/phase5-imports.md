# Phase 5 — Cross-module imports: side modules calling main module's exports

Scope: research only. The per-block SIDE_MODULE wasm files (Phase 3 emits them)
have to resolve six C runtime helpers + shared memory + (optionally) the
indirect-function-table + the stack-pointer global from the main flycast
module at instantiate time. Today these come from a JS-side import bag
built in `flycast_build_imports` (`dreamcast/flycast-bridge/flycast_worker_funcs.js:65-97`).
After Option 2 lands, the imports must come from the *main module's own
exports*, mediated by Emscripten's dynamic-linker runtime
(`emsdk/upstream/emscripten/src/library_dylink.js`).

All citations below are by file:line in this checkout unless prefixed
with a URL.

---

## 1. Export-side changes (main module = `flycast_worker_emcc.wasm`)

### 1a. EMSCRIPTEN_KEEPALIVE is **not enough on its own** under MAIN_MODULE

`EMSCRIPTEN_KEEPALIVE` expands to `__attribute__((used))` —
`emsdk/upstream/emscripten/system/include/emscripten/em_macros.h:10`.

`used` tells the C compiler not to elide the definition and tells the linker
(via the object file) that it is a referenced symbol. It does **not** set ELF
default visibility. By itself this is enough today because the bridge link
script lists every helper individually in `EXPORTED_FUNCTIONS`
(`dreamcast/flycast-bridge/flycast_worker_link.sh:54-63`), which gets
translated by emcc into wasm-ld `--export=` lines
(`emsdk/upstream/emscripten/tools/building.py:185-189`).

Under `-sMAIN_MODULE=1` (mode 1 — not 2), Emscripten:

- Forces `LINKABLE=1` (`emsdk/upstream/emscripten/tools/link.py:1011-1012`).
- Forces `INCLUDE_FULL_LIBRARY=1` (`tools/link.py:1006-1007`).
- Passes `--export-dynamic` to wasm-ld (`building.py:165-166`), which
  re-exports every defined symbol from object files.
- Warns and ignores `EXPORTED_FUNCTIONS` (`building.py` doesn't filter — see
  `tools/link.py:1014-1015`: "EXPORTED_FUNCTIONS is not valid with LINKABLE
  set ... To export only a subset use ... MAIN_MODULE=2").
- Pulls in `$getDylinkMetadata` + `$mergeLibSymbols` so the JS side knows how
  to load + bind side modules (`tools/link.py:1017-1021`).
- Emits a `wasmImports` object whose keys include every imported JS-library
  function (`tools/emscripten.py:849-869`).

**Conclusion (Question 1):** with `-sMAIN_MODULE=1`, `EMSCRIPTEN_KEEPALIVE` on
the six C helpers in `EmscriptenWorker.cpp:788-933` is sufficient — they will
be re-exported by `--export-dynamic`, registered in the main module's
`wasmExports`, and then surfaced into `wasmImports` for side-module
resolution by `mergeLibSymbols` (`library_dylink.js:531-579`) /
`resolveSymbol` (`library_dylink.js:706-721`).

If we move to `MAIN_MODULE=2` later (a "DCE'd main module" — `settings.js:1134-1136`),
the helpers will **not** be exported automatically. In that mode the link
script must list them in either `EXPORTED_FUNCTIONS` *and*
`SIDE_MODULE_IMPORTS` (`settings_internal.js:28-30`: "All symbols imported
by side modules. These are symbols that the main module ... will need to
provide.") so they survive DCE and are added to the live wasm-export set
(`building.py:113-117`, `tools/emscripten.py:864-869`).

### 1b. Link-flag delta on `flycast_worker_link.sh`

Today the link command (`flycast_worker_link.sh:160-226`) is a static-exe
build with imported memory + table-growth + pthreads. To turn it into a
main module the additions are:

```
+ -sMAIN_MODULE=1                         # implies RELOCATABLE=1, LINKABLE=1, INCLUDE_FULL_LIBRARY=1
+ -sASYNCIFY_IMPORTS=...                  # already implied by ASYNCIFY=1 — no change
- -sEXPORTED_FUNCTIONS="$EXPORTED_FUNCS"  # warning-only under LINKABLE; harmless if left in
```

`IMPORTED_MEMORY=1` and `ALLOW_TABLE_GROWTH=1` are already on, which is
exactly what dynamic linking needs (Emscripten will refuse to MAIN_MODULE
without imported memory + a JS-created table — see `library.js:2391-2407`
which creates `wasmTable` in JS under `RELOCATABLE`, and `emscripten.py:787-791`
which routes both into `send_items_map`).

### 1c. Stack pointer

Under `RELOCATABLE`, emcc adds `__stack_pointer` to
`DEFAULT_LIBRARY_FUNCS_TO_INCLUDE` (`link.py:1028-1035`). This causes the
main module to import `env.__stack_pointer` as a mutable i32 (i64 under
MEMORY64) wasm global. Side modules import the same name and the dynamic
linker resolves both to the same `WebAssembly.Global` instance, so the call
stack is genuinely shared.

The hand-emitted side modules in `wasm_emit.cpp` **do not currently use
the C stack** — every block body operates entirely on locals
(`ctx_ptr`, `ram_base`, scratch + RegCache locals declared in
`wasm_emit.h:64-77`). So we do not need to import `__stack_pointer` unless a
future change starts spilling locals to the C stack or calling a function
that does. The six helper imports listed above all eventually call into
flycast C++ — but they pay the stack cost on the *main module's* frames,
not on the block's. So Phase 5 minimal blocks can skip `__stack_pointer`.

---

## 2. Import-side changes — `emitTypeImportSection` diff

Current implementation (`bementalJIT/guests/sh4/wasm_emit.cpp:1319-1342`):

```cpp
b.emitImportSection(1 + WIMPORT_COUNT);
b.emitImportMemory("env", "memory", 1);
b.emitImportFunc("env", "sh4_read8",   1);
b.emitImportFunc("env", "sh4_read16",  1);
b.emitImportFunc("env", "sh4_read32",  1);
b.emitImportFunc("env", "sh4_write8",  2);
b.emitImportFunc("env", "sh4_write16", 2);
b.emitImportFunc("env", "sh4_write32", 2);
b.emitImportFunc("env", "sh4_ifb",     2);
b.emitImportFunc("env", "sh4_shil_fb", 2);
```

The JS-side bag (`flycast_worker_funcs.js:84-95`) renames the C-mangled
exports: `Module._sh4_mem_read8` is passed as `env.sh4_read8`, etc. Under
Option 2 there is no JS rename layer — the side module imports whatever
name the main module exports, and the main module exports the C function's
underscore-mangled name (`_sh4_mem_read8`).

Symbol names emitted by `wasm-ld` for a C function `sh4_mem_read8` defined
with `extern "C"` + `EMSCRIPTEN_KEEPALIVE`: just `sh4_mem_read8` (no
underscore in the wasm-side symbol table; the underscore prefix is only
added by emcc's JS-side `asmjs_mangle`, see `emscripten.py:843-845`).
So side modules import `env.sh4_mem_read8`, not `env._sh4_mem_read8`.

Diff:

```cpp
b.emitImportSection(1 + WIMPORT_COUNT);
b.emitImportMemory("env", "memory", 1);
- b.emitImportFunc("env", "sh4_read8",   1);
- b.emitImportFunc("env", "sh4_read16",  1);
- b.emitImportFunc("env", "sh4_read32",  1);
- b.emitImportFunc("env", "sh4_write8",  2);
- b.emitImportFunc("env", "sh4_write16", 2);
- b.emitImportFunc("env", "sh4_write32", 2);
- b.emitImportFunc("env", "sh4_ifb",     2);
- b.emitImportFunc("env", "sh4_shil_fb", 2);
+ b.emitImportFunc("env", "sh4_mem_read8",     1);
+ b.emitImportFunc("env", "sh4_mem_read16",    1);
+ b.emitImportFunc("env", "sh4_mem_read32",    1);
+ b.emitImportFunc("env", "sh4_mem_write8",    2);
+ b.emitImportFunc("env", "sh4_mem_write16",   2);
+ b.emitImportFunc("env", "sh4_mem_write32",   2);
+ b.emitImportFunc("env", "sh4_interp_ifb",    2);
+ b.emitImportFunc("env", "sh4_interp_shil_fb",2);
```

The `WIMPORT_*` enum values in `wasm_emit.h:30-41` do not change — they are
internal indices into the side module's own import-section ordering, and
the helper calls are emitted as `call WIMPORT_x` which is correct as long
as the import-section ordering matches the enum.

### 2a. dylink.0 custom section (REQUIRED for `loadWebAssemblyModule`)

`library_dylink.js:431` aborts on a side module without a dylink section:
"need dylink section". `library_dylink.js:443` further requires that the
section be the *first* section of the module:
`failIf(binary[8] !== 0, 'need the dylink section to be first')`. Byte 8 is
the section ID of the first section; ID 0 is "custom".

Side modules built by emcc carry the new-format `dylink.0` custom section
emitted by wasm-ld. The format
(per `library_dylink.js:466-513` and
[tool-conventions/DynamicLinking.md](https://github.com/WebAssembly/tool-conventions/blob/main/DynamicLinking.md)):

- Section: custom, name = `"dylink.0"` (LEB-prefixed string).
- Body: a sequence of typed subsections, each `(u8 type, u32 LEB size, bytes payload)`.
- Subsections we must emit:
  - **`WASM_DYLINK_MEM_INFO` (0x01)** — 4 LEB128s: `memorySize`,
    `memoryAlign`, `tableSize`, `tableAlign`
    (`library_dylink.js:476-480`). For a minimal block with no statics:
    all four are `0`. Assertion at `library_dylink.js:517-519` requires
    `tableAlign == 0` (i.e. alignment = 1 << 0 = 1).
  - **`WASM_DYLINK_NEEDED` (0x02)** — `u32 count, name*`. We have no
    transitive deps, emit count = 0.
  - Optional **`WASM_DYLINK_EXPORT_INFO` (0x03)** and
    **`WASM_DYLINK_IMPORT_INFO` (0x04)** carry TLS flags + weak-binding flags.
    Phase 5 blocks export only `run` (a plain function, not TLS, not weak)
    and import non-weak symbols. Both are optional and can be omitted.

`WasmModuleBuilder` does not have a `dylink.0` helper today. The addition is
along the lines of:

```cpp
// Emit a "dylink.0" custom section as the FIRST section (must precede type).
void emitDylink0Empty() {
    beginCustomSection("dylink.0");
    // WASM_DYLINK_MEM_INFO (0x01): memSize=0, memAlign=0, tblSize=0, tblAlign=0
    emitByte(0x01);
    {
        beginLEB128Patch();  // subsection size
        emitLEB128(0);
        emitLEB128(0);
        emitLEB128(0);
        emitLEB128(0);
        endLEB128Patch();
    }
    // WASM_DYLINK_NEEDED (0x02): count=0
    emitByte(0x02);
    {
        beginLEB128Patch();
        emitLEB128(0);
        endLEB128Patch();
    }
    endSection();
}
```

`emitDylink0Empty` must be called between `emitHeader()` and
`emitTypeImportSection()` in both `build_block` and `build_epoch_module`
(`wasm_emit.cpp:1347-1402`).

The builder also needs a `beginCustomSection(const char*)` helper —
mechanically the same as `beginSection` but with `WASM_SEC_CUSTOM = 0` and
an LEB-prefixed name written into the body. None of those primitives exist
yet in `wasm_module_builder.h`; the closest is `emitName` at line 226 which
can be reused for the name encoding.

### 2b. Function-pointer / GOT.func / GOT.mem imports

The minimal block emits no function-pointer references (no `call_indirect`
through a guest-table pointer, no taking the address of an external
function). So no `GOT.func.*` imports are needed.

The minimal block does not reference any imported memory address as a
data pointer either — every memory access goes through one of the
imported helper calls or the imported `env.memory` instance via plain
i32.load/store with an i32 offset computed at runtime. So no `GOT.mem.*`
imports are needed.

If a future emit ever needs the *address of* an imported helper (e.g. to
stash a fnptr into a guest register), it would import a `GOT.func.<name>`
mutable i32 global; the proxy at `library_dylink.js:725-726` synthesizes
those on demand.

---

## 3. Memory sharing verification

### 3a. Mechanism

- Main module link emits `-sIMPORTED_MEMORY=1` (already on,
  `flycast_worker_link.sh:196`). `emscripten.py:787-788` adds
  `send_items_map['memory'] = 'wasmMemory'` so the main module's
  `env.memory` resolves to the JS-side `wasmMemory` global.
- Side module emits `import "env" "memory" (memory $0 shared 1 65536)`
  via our `emitImportMemory` at `wasm_module_builder.h:280-291` (note
  hard-coded `0x03` flags = shared+has-max — matches the main module's
  shared-memory layout under `-sSHARED_MEMORY` / `-pthread`).
- At side-module instantiation, `library_dylink.js:723-729` builds the
  imports object as `{'GOT.mem': proxy, 'GOT.func': proxy, env: proxy, wasi: proxy}`,
  and the env proxy's `get` (line 707-710) returns `wasmImports[prop]`
  when the symbol exists there. `wasmImports['memory']` is set to the
  same `wasmMemory` instance the main module imports. So both end up
  with the **same `WebAssembly.Memory` object** — same SAB-backed
  ArrayBuffer, same `HEAP*` views.

### 3b. Proof check (wasm-objdump)

After the build, the test recipe should be:

```
$EMSDK/upstream/bin/wasm-objdump -j Import -x /tmp/probe_block.wasm | grep memory
# expected: " - memory[0] pages: initial=1 max=65536 shared <- env.memory"
```

And the main module:
```
$EMSDK/upstream/bin/wasm-objdump -j Import -x dreamcast/flycast_libretro/flycast_worker_emcc.wasm | grep memory
# expected: " - memory[0] pages: initial=N max=M shared <- env.memory"
```

Same module name (`env`), same field name (`memory`), and both flagged
`shared` — that is the runtime contract the dynamic linker enforces.
Shared flag mismatch will fail instantiation with
`WebAssembly.LinkError: imported memory shared flag does not match` (V8).

---

## 4. Function-table (`__indirect_function_table`) sharing

For Phase 5 blocks that do not call_indirect, no table import is needed.
The block's only callees are the 8 imported helpers — direct `call $N`
instructions referencing the import-section function indices 0..7.

For completeness: if a future block needs `call_indirect` (e.g. emitted
guest-side jump-table dispatch), the recipe is:

- `emitImportTable("env", "__indirect_function_table", initial, hasMax, max)`
  via the existing helper at `wasm_module_builder.h:304-312`.
- emcc routes `__indirect_function_table` -> the JS `wasmTable` global
  (`emscripten.py:790-791`: `send_items_map['__indirect_function_table'] = 'wasmTable'`).
- `wasmTable` itself is created in JS under RELOCATABLE
  (`library.js:2392-2404`: `new WebAssembly.Table({initial, element:'anyfunc'})`).
- `library_dylink.js:633-651` allocates `tableBase` for each side module by
  growing `wasmTable` and patching the side module's exports up by
  `tableBase`. All modules end up viewing the same `WebAssembly.Table`.

Proof check (same recipe as memory, grepping for table instead of memory):

```
$EMSDK/upstream/bin/wasm-objdump -j Import -x /tmp/probe_block.wasm | grep table
# (Phase 5 minimal block: no output — no table import)
```

---

## 5. JS-side cleanup

Today `flycast_build_imports` (`flycast_worker_funcs.js:65-97`) hand-rolls
the env bag. Under Option 2 the side module is loaded by Emscripten's
`loadWebAssemblyModule` (`library_dylink.js:607-755`), which builds the
imports object itself from `wasmImports` + GOT proxies. Two paths to invoke
that loader:

- **dlopen path**: call the JS `dlopen("blob:...")` from C — requires
  writing the side-module bytes to MEMFS first.
- **`loadDynamicLibrary(name, flags, handle?)`** directly from JS, with
  the bytes pre-stashed in a per-vaddr map (closer to what
  `flycast_install_epoch` currently does at
  `flycast_worker_funcs.js:136-170`).

In either path, the imports object is constructed by Emscripten — the
function `flycast_build_imports` and the cached `flycast_wasm_imports`
variable are no longer needed. What remains JS-side:

1. `flycast_install_epoch` becomes "register N side modules with the
   dynamic linker, build a vaddr -> exported run-function Map" — same
   external contract, different internals.
2. The vaddr -> fn Map (`flycast_vaddr_to_fn`,
   `flycast_worker_funcs.js:62`) still exists and is still hot-path.
3. `flycast_active_instance` is replaced by N per-block DSO handles (the
   epoch concept changes — see Phase 4 doc when it lands).

The `Module.wasmMemory` shim plumbing
(`flycast_worker_funcs.js:67-77`) becomes redundant — Emscripten exposes
`wasmMemory` in module scope under RELOCATABLE+IMPORTED_MEMORY, and
`library_dylink.js` reads from `wasmImports['memory']` (set by emcc-generated
code), not from a Module property. The shim can be deleted.

---

## 6. Test plan: minimal side module that calls `sh4_mem_read32(0)`

The reference `dreamcast/docs/option2-direct-dispatch/refs/side_ref_mem.c`
already encodes the right shape:

```c
extern int sh4_read32(int addr);     // -> rename to sh4_mem_read32 (no JS rename)
extern void sh4_ifb(int opc, int pc);
int run(int ctx, int ram_base) {
    int v = *(int*)(ram_base + 0x100);
    sh4_ifb(0x1234, ctx);
    return v + sh4_read32(ram_base);
}
```

For Option 2 the names need updating to the underlying C symbol names:

```c
extern int  sh4_mem_read32(int addr);
extern void sh4_interp_ifb(int opc, int pc);
int run(int ctx, int ram_base) {
    int v = *(int*)(ram_base + 0x100);
    sh4_interp_ifb(0x1234, ctx);
    return v + sh4_mem_read32(ram_base);
}
```

### 6a. Build the reference side module (emcc-built — oracle)

```bash
$EMSDK/upstream/emscripten/emcc \
  -sSIDE_MODULE=1 \
  -sSHARED_MEMORY=1 \
  -pthread \
  -matomics \
  -O2 -g0 \
  -o /tmp/side_ref_mem.wasm \
  dreamcast/docs/option2-direct-dispatch/refs/side_ref_mem.c
```

Then dump:

```bash
$EMSDK/upstream/bin/wasm-objdump -x /tmp/side_ref_mem.wasm | head -60
```

Expected sections in order:

1. Custom `dylink.0` (must be byte 8 = 0).
2. Type
3. Import (`env.memory`, `env.__indirect_function_table` if any GOT usage,
   `env.__stack_pointer` global, `env.sh4_mem_read32`, `env.sh4_interp_ifb`,
   plus GOT.mem / GOT.func entries for any function pointers taken — for
   this minimal `run`, none).
4. Function / Table / Memory / Global / Export / Element / Code.

This is the byte-for-byte oracle the hand-emitted module must match
(modulo `__stack_pointer` — see §1c — and modulo any C-runtime statics
the hand-emit will omit since it allocates nothing).

### 6b. Load it under the modified main module

Pseudo-shell of the worker-side test once `MAIN_MODULE=1` is in
`flycast_worker_link.sh`:

```js
// in flycast_worker_funcs.js, post-runtime-init
const bytes = await (await fetch('side_ref_mem.wasm')).arrayBuffer();
const handle = Module.loadWebAssemblyModule(new Uint8Array(bytes), {loadAsync:false});
const result = handle['run'](0, Module.HEAP32.byteOffset);  // ctx=0, ram_base=heap
console.log('side run returned', result);
// Expected: heap[0x100/4] + sh4_mem_read32(0); sh4_interp_ifb fires once.
```

(The exact API surface depends on whether we call `loadDynamicLibrary` /
`dlopen` / a direct `loadWebAssemblyModule` — all three are exported by
the dynamic-linker library JS when `MAIN_MODULE` is set; see
`library_dylink.js:599-755` for `loadWebAssemblyModule`'s contract.)

### 6c. Verify the C-side function fires

Add a one-shot `printf` / `MAIN_THREAD_EM_ASM` print at the head of
`sh4_interp_ifb` (`EmscriptenWorker.cpp:874`) gated on a probe flag. Run
the worker, call the side module's `run`, expect the print.

### 6d. Verify the hand-emitted module loads identically

Repeat 6a–6c but with the hand-emitted bytes from a Phase 5 single-block
build of `wasm_emit.cpp`. The hand-emitted module's `WebAssembly.Module`
should compile (LinkError-free) and `run(ctx_ptr, ram_base)` should
return the same value as the emcc oracle for the same inputs.

---

## 7. Open questions (require a build to answer)

1. **`dylink.0` empty payload format** — `library_dylink.js:519` has
   `assert(offset == end)` after walking subsections, which means the
   parser is strict about no trailing bytes. The minimal `(MEM_INFO 0,0,0,0)
   + (NEEDED 0)` payload above is what wasm-ld emits today for trivial
   side modules — confirm with `wasm-objdump -j dylink.0 -d` on the 6a
   oracle, and copy the byte layout exactly.

2. **i64 vs i32 globals on POINTER_WASM_TYPE** — `library_dylink.js:164`
   uses `POINTER_WASM_TYPE` which is `i64` under MEMORY64. We are not
   using MEMORY64. `__stack_pointer` will be i32; if we ever import it
   we must use i32 not i64. The bridge uses 4 GB max memory
   (`flycast_worker_link.sh:198`) so we never need MEMORY64.

3. **`--shlib-sigcheck` / WASM_BIGINT** — `building.py:197-202` disables
   wasm-ld signature checking on shared libs when WASM_BIGINT is off, so
   our (i32,i32)->i32 side-module signatures will not be cross-checked
   against the main-module's `sh4_mem_read*` (uint32_t)->uint32_t
   signatures at link time. They match anyway (uint32_t == i32 in the
   wasm ABI), but a mismatch would only surface at runtime as a
   `WebAssembly.LinkError`. The bridge build does not currently pass
   `-sWASM_BIGINT` — check whether enabling it makes the build stricter
   here. (Probably no-op for our types.)

4. **Side module memory alignment of zero** — `tableAlign == 0` asserted
   (`library_dylink.js:517-519`); is `memoryAlign == 0` also accepted?
   The oracle's `dylink.0` answers this — the hand-emit should mirror.

5. **`mergeLibSymbols` behavior on the `run` export** — by default
   `loadWebAssemblyModule` calls `mergeLibSymbols(exports, libName)` only
   if the `RTLD_GLOBAL` flag is set on the load
   (`library_dylink.js:531-579`). For per-block modules we **do not**
   want `run` symbols leaking into the global symbol table — they would
   collide between blocks. Load with `flags = {global: false}` (i.e.
   `RTLD_LOCAL`) and pull the `run` export out of the returned handle
   directly. Confirm the JS-side API surface (`loadWebAssemblyModule`
   return value structure) is stable enough to rely on.

6. **Per-instance vs per-module instantiation cost** — `library_dylink.js`
   has no concept of "compile once, instantiate many" for the same DSO;
   each `loadWebAssemblyModule` call compiles + instantiates one wasm.
   That matches today's per-block-Module behavior. If Phase 5 splits
   blocks across many side modules, the JIT spin-up cost is N
   compilations whether we hand-emit or use Emscripten's loader. The
   epoch / merged-module trick from
   `dreamcast_inwasm_dispatcher_plan` (per MEMORY.md entry) interacts
   with this and is out of scope for Phase 5.

7. **`--allow-multiple-definition` interaction with MAIN_MODULE=1** —
   the current link script passes `-Wl,--allow-multiple-definition`
   (`flycast_worker_link.sh:213`). Under MAIN_MODULE=1's
   `--export-dynamic` this could cause spurious duplicate-symbol
   re-exports across the static archives. Verify with
   `wasm-objdump -j Export | wc -l` before/after enabling MAIN_MODULE.

---

## Relevant files (absolute paths)

- `/Users/caseybement/Bemental77.github.io/dreamcast/flycast-bridge/EmscriptenWorker.cpp` (sh4_mem_* helpers, lines 788-933)
- `/Users/caseybement/Bemental77.github.io/dreamcast/flycast-bridge/flycast_worker_funcs.js` (current import bag, lines 65-97)
- `/Users/caseybement/Bemental77.github.io/dreamcast/flycast-bridge/flycast_worker_link.sh` (linker invocation)
- `/Users/caseybement/Bemental77.github.io/bementalJIT/guests/sh4/wasm_emit.cpp` (emitTypeImportSection, lines 1319-1342)
- `/Users/caseybement/Bemental77.github.io/bementalJIT/guests/sh4/wasm_emit.h` (WIMPORT_* enum, lines 30-41)
- `/Users/caseybement/Bemental77.github.io/bementalJIT/include/bementalJIT/wasm_module_builder.h` (import emitters, lines 275-313; no dylink.0 helper yet)
- `/Users/caseybement/Bemental77.github.io/emsdk/upstream/emscripten/src/library_dylink.js` (loader, lines 393-755)
- `/Users/caseybement/Bemental77.github.io/emsdk/upstream/emscripten/src/preamble.js` (wasmMemory / wasmTable init, lines 983-998)
- `/Users/caseybement/Bemental77.github.io/emsdk/upstream/emscripten/src/library.js` (wasmTable creation, lines 2391-2407)
- `/Users/caseybement/Bemental77.github.io/emsdk/upstream/emscripten/tools/emscripten.py` (send_items_map wiring, lines 778-869)
- `/Users/caseybement/Bemental77.github.io/emsdk/upstream/emscripten/tools/building.py` (wasm-ld flags, lines 133-249)
- `/Users/caseybement/Bemental77.github.io/emsdk/upstream/emscripten/tools/link.py` (MAIN_MODULE settings cascade, lines 1004-1035)
- `/Users/caseybement/Bemental77.github.io/emsdk/upstream/emscripten/system/include/emscripten/em_macros.h` (EMSCRIPTEN_KEEPALIVE, line 10)
- `/Users/caseybement/Bemental77.github.io/dreamcast/docs/option2-direct-dispatch/refs/side_ref_mem.c` (reference side module)
- External: https://github.com/WebAssembly/tool-conventions/blob/main/DynamicLinking.md

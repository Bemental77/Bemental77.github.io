# Phase 3 — Emit per-block WASM as Emscripten SIDE_MODULE

Research for Option 2 (direct in-wasm dispatch via `dlopen`-able per-block side
modules). Goal: convert the current `WasmModuleBuilder` plain-WASM 1.0 output
from `bementalJIT/guests/sh4/wasm_emit.cpp` into Emscripten's SIDE_MODULE
shape so per-block modules can be loaded by the main `flycast_worker` module
via `dlopen` (and so their exported funcrefs land in the main
`__indirect_function_table` for a stable in-wasm dispatcher).

All binary-format claims are cited inline. No build was attempted from this
sandbox; emcc + wasm-dis + llvm-objdump invocations were blocked by the
harness sandbox (cannot run executables — only source inspection). The
"reference annotated bytes" section below is reconstructed from the
emscripten source (cited) rather than dumped from a built artifact — an open
question marks the bytes that still want a wasm-objdump confirmation pass on
a real toolchain run.

Sources read in full:

- `bementalJIT/include/bementalJIT/wasm_module_builder.h`
- `bementalJIT/guests/sh4/wasm_emit.{h,cpp}`
- `dreamcast/flycast-bridge/{rec_wasm.cpp, flycast_worker_funcs.js}`
- `emsdk/upstream/emscripten/src/library_dylink.js`
- `emsdk/upstream/emscripten/tools/{webassembly.py, building.py}`
- WebAssembly tool-conventions DynamicLinking.md (canonical online —
  https://github.com/WebAssembly/tool-conventions/blob/main/DynamicLinking.md)

---

## 1. `dylink.0` byte format for our minimal case

The full subsection grammar lives in
`emsdk/upstream/emscripten/tools/webassembly.py:158-176, 339-375` (parser)
and `emsdk/upstream/emscripten/src/library_dylink.js:390-527`
(`getDylinkMetadata`). These two are the canonical Emscripten readers; what
they accept defines what we must emit.

### Section frame

A custom section is encoded as the standard WASM custom-section frame
(spec §5.5.3):

```
section_id      = 0x00               // CUSTOM
section_size    = u32_LEB128         // bytes of name+payload
name_len        = u32_LEB128         // length of section name
name            = "dylink.0"         // exactly these 8 bytes — see (*)
payload         = <dylink.0 subsections, concatenated>
```

(*) The runtime accepts the **legacy** name `"dylink"` (5 bytes, single
flat record) and the **current** name `"dylink.0"` (subsection grammar).
`library_dylink.js:424,428,465` falls back from `dylink.0` → `dylink` for
lookup, and `failIf(name !== 'dylink.0')` for new-format parsing. wasm-ld
emits only `dylink.0` since LLVM 11 (the legacy flat format is read-only
for backward compat). **Emit `dylink.0`.**

The section MUST be the first section in the module (immediately after the
8-byte header). `library_dylink.js:443`:
`failIf(binary[8] !== 0, 'need the dylink section to be first')`.

### Subsection grammar

`webassembly.py:158-162` defines the subsection-type byte:

```
MEM_INFO    = 0x01
NEEDED      = 0x02
EXPORT_INFO = 0x03
IMPORT_INFO = 0x04
```

Each subsection is framed as:

```
subsection_type = u8                 // one of the above
subsection_size = u32_LEB128         // bytes of subsection payload
payload         = <type-specific>
```

`MEM_INFO` payload (`library_dylink.js:477-480`):

```
memory_size    = u32_LEB128          // total bytes of static data we need
memory_align   = u32_LEB128          // log2(alignment), e.g. 4 for 16-byte
table_size     = u32_LEB128          // number of funcref slots to reserve
table_align    = u32_LEB128          // MUST decode to 1 (asserted by loader)
```

The `tableAlign` assertion is at `library_dylink.js:518`:
`assert(tableAlign === 1, "invalid tableAlign ${tableAlign}");` where
`tableAlign = Math.pow(2, customSection.tableAlign)`. So encode the LEB128
value `0` (since `2^0 = 1`).

`NEEDED` payload (`library_dylink.js:482-486`):

```
needed_count   = u32_LEB128          // count of needed shared libs
for i in 0..count:
    lib_name_len  = u32_LEB128
    lib_name      = bytes
```

`EXPORT_INFO` and `IMPORT_INFO` are only inspected for TLS / weak flags
(`library_dylink.js:487-512`). They are **optional** — unknown subsections
are skipped (`library_dylink.js:506-512`,
`webassembly.py:373-375`). For our use we omit them.

### Our minimal `dylink.0` byte sequence

For a per-block module that:

- holds **no static data** (block code only — locals, no globals, no data
  segments)
- adds **no funcref table slots** of its own (the dispatcher's funcref table
  lives in the main module; our exported `run` function gets added to it via
  GOT.func / Emscripten `addFunction`)
- has **no needed dynlibs** (main module satisfies everything)

…the smallest legal `dylink.0` section is:

```
HEX  | DESCRIPTION
-----+---------------------------------------------
00   | section_id = CUSTOM
0E   | section_size = 14 bytes follow
08   | name_len = 8
64796C696E6B2E30 | "dylink.0"
01   | subsection_type = MEM_INFO
04   | subsection_size = 4
00   | memory_size   = 0   (LEB128)
00   | memory_align  = 0   (LEB128, => 2^0 = 1 byte)
00   | table_size    = 0   (LEB128)
00   | table_align   = 0   (LEB128, => 2^0 = 1, asserted)
```

Total: 16 bytes. The section name `"dylink.0"` is 8 ASCII bytes
`64 79 6C 69 6E 6B 2E 30`. We could omit MEM_INFO entirely — the parser
loop at `library_dylink.js:473-513` tolerates a `dylink.0` payload of zero
length — but the post-loop assertions
(`library_dylink.js:517-519`) reference `customSection.tableAlign`, which
won't be set without a MEM_INFO. **Always emit MEM_INFO.**

If/when we start emitting blocks that need static rodata (e.g. constant
floats inlined into a data segment), bump `memory_size` to the byte count
and `memory_align` to `log2(alignment)`. Same for any `funcref` slots we
add to our own (internal) table; right now we have neither.

---

## 2. Are relocations required for our minimal case?

Per the tool-conventions DynamicLinking spec (and `library_dylink.js` —
which is what *actually* runs in the browser), per-block side modules
**do not need to emit a `linking` or `reloc.*` custom section**, because:

- `relocateExports` (`library_dylink.js:258-282`) only rebases values that
  the module already returned as integer exports. It adds `memoryBase` to
  every integer-typed export. Our `run` export is a *function* — V8 boxes
  it as a `WasmExportedFunction` object, not an integer — so the
  `if (typeof value == POINTER_JS_TYPE)` branch is skipped for it
  (`library_dylink.js:275-277`).
- The only true relocations Emscripten still applies at runtime are the
  **data relocations** baked into the `__wasm_apply_data_relocs` start
  function (`library_dylink.js:836`). That function is emitted by wasm-ld
  when a side module references symbols in its OWN data segment that point
  to imported globals (typical for C++ vtables, etc.). Our blocks have no
  data segment at all, so wasm-ld would not synthesise this function and
  the loader call simply no-ops (`library_dylink.js:836-846` —
  `if (applyRelocs)` is guarded).

Things our blocks reference:

| Reference                                                | How it's satisfied                                           |
|----------------------------------------------------------|--------------------------------------------------------------|
| `env.memory`                                              | Import — supplied by Emscripten loader's `proxy` (line 727). |
| `env.sh4_read8` / `sh4_write*` / `sh4_ifb` / `sh4_shil_fb` | Import — proxy resolves each via `wasmImports[prop]` (line 707). |
| (later) `env.__indirect_function_table`                  | Import — proxy resolves to the main module's table (NOT yet imported by our emit; see §4). |
| (later) `env.__memory_base` / `env.__table_base`         | Auto-supplied by proxy at lines 694-697.                     |
| (later) `GOT.func.<sym>` / `GOT.mem.<sym>`               | Auto-supplied by Proxy at lines 725-726.                     |

None of those require an explicit `linking` section. **Decision: emit zero
relocation sections.**

The only edge case: if a future block emits a constant function-pointer
into a memory location, that needs a `GOT.func.<sym>` import + an
`__wasm_apply_data_relocs` function. We have no such pattern today and the
SH4 emitter's IFB/SHIL fallback path is the only place that could
introduce one. Mark as a follow-up item.

---

## 3. GOT (Global Offset Table) entries

`library_dylink.js:160-177` exposes `'GOT.mem'` and `'GOT.func'` as Proxy
objects in the import object. Any global the side module imports under
those two module names auto-vivifies a `WebAssembly.Global` and tracks the
post-link value.

For our minimal case:

- **`GOT.mem.<sym>`**: only needed when the side module needs the
  *runtime address* of a symbol defined in another module (e.g. a global
  variable). Our blocks read and write `ctx_ptr + offset` — `ctx_ptr` is
  a function parameter the dispatcher passes in. **No GOT.mem entries
  required.**
- **`GOT.func.<sym>`**: only needed when the side module wants a
  *callable function pointer* (table index) for a symbol defined in
  another module — used by C++ when taking `&foo`. Our blocks call imported
  functions directly via `call <imported_idx>`, never via funcref. **No
  GOT.func entries required.**

`reportUndefinedSymbols` (`library_dylink.js:284-322`) only complains
about GOT entries with `required = true` and `value == 0`. Since we
import nothing under `GOT.*`, the report stays silent.

**Decision: zero GOT entries in the import section.**

---

## 4. Function index space & calling convention

Emscripten's main module exposes the application's funcref table as the
import `env.__indirect_function_table` (see e.g.
`gamecube/dolphin_libretro/dolphin_worker_emcc.js` — every side module
plays here too). Our current emit imports only `env.memory` plus the eight
`sh4_*` functions; it does NOT import the indirect function table.

For Option 2 the dispatcher needs to invoke each block via a SINGLE
monomorphic JS-to-wasm call to a fixed dispatcher fn that does its own
`call_indirect` against the main module's table — that's the only way V8
will speculatively inline (per
`single_module_jit_plan` / `v8_inlining_resolved_2026_05_03` — V8's
inlining only fires on `call_indirect` through an *internally referenced
or module-imported* table, not on per-instance JS-side `fn.call(...)`).

**Steps to make this work:**

1. Each per-block side module exports its `run` function. The Emscripten
   loader, in `updateGOT` (`library_dylink.js:207-252`), calls
   `addFunction(value)` on every exported function — this **assigns it an
   index in the main module's `__indirect_function_table`** and stashes
   that index in `GOT.func.<symname>.value`.
2. The dispatcher (a separate, stable module — likely a tiny wasm fn
   compiled once at boot) imports `env.__indirect_function_table` and does
   `(call_indirect (type 0) (local.get $idx))`, where `$idx` is looked up
   from a vaddr→table-index map held in a wasm memory page also imported
   from main.
3. The per-block module's `run` export must use a stable function type
   that the dispatcher's `call_indirect` `type` operand also references.
   Today our type-0 is `(i32, i32) -> i32` (ctx_ptr, ram_base → next_pc),
   matching `(env.sh4_read8 / read16 / read32)` — fine. **Keep that.**

The export name doesn't matter for the dispatcher path — only the table
index does — but Emscripten's `addFunction` uses the export name as the
key into `GOT.func` (`library_dylink.js:230`). For the dispatcher to find
the slot it needs to call `dlsym(handle, "run")` (or equivalent) to get
the integer table index, then write that index into the SAB-backed
vaddr→idx map we hand to the dispatcher fn.

**Concretely from `wasm_emit.cpp` today vs Option-2 target:**

| Aspect                | Today                                        | Option 2 SIDE_MODULE                                                 |
|-----------------------|----------------------------------------------|----------------------------------------------------------------------|
| Module shape           | Plain WASM 1.0                              | SIDE_MODULE (`dylink.0` first, dlopen-loadable)                      |
| Per-module unit       | N blocks (epoch)                            | 1 block per module (so a per-block compile is tiny)                  |
| Memory                | Imports `env.memory`, shared SAB             | Same (loader's `proxy` resolves `env.memory` from `wasmImports`)     |
| Helper fns            | Imports `env.sh4_*`                          | Same (proxy resolves via `wasmImports[prop]`)                        |
| Funcref table         | Not imported                                 | Optional. NOT needed for export-only use; needed only if WE call_indirect inside our block. |
| Indirect call         | None (block does no funcrefs)                | None — block-bodies stay direct-call.                                |
| Export                | `run_<i>` per block                          | `run` (single — module = single block)                               |
| Memory layout aware?  | No                                          | No — see §5                                                          |

---

## 5. PIC / memory addressing

Position-independent code in Emscripten side modules works two ways
(`emcc.py:378-381` and `building.py:194-208`):

- **Data**: side-module-defined globals + static data live in a memory
  region rooted at the *imported global* `env.__memory_base`. wasm-ld
  generates loads of the form `i32.load (local.get $0) (offset 0)` where
  `$0` is the result of `global.get __memory_base` plus the static
  offset. The loader passes `__memory_base` as a const-init global at
  `library_dylink.js:694-695`.
- **Tables**: side-module-declared funcref tables are offset by
  `env.__table_base` — same pattern (`library_dylink.js:696-697`).

**For our minimal blocks: neither applies.** We import `env.memory`
directly and our SHIL emit computes raw addresses (`ctx_ptr + ctx_off::PC`
etc., or `ram_base + sh4_addr`) by adding a function parameter. We never
reference a side-module-static address. **No PIC adjustments needed.**

If we ever want to inline a constant table (e.g. a 16-entry SHIL operand
LUT) into the block's own data section, we'd then need:

1. An import `(global $__memory_base (mut i32))` in slot 0.
2. Loads via `(i32.load (i32.add (global.get $__memory_base) (i32.const lut_off)))`.
3. A data segment with active offset `(global.get $__memory_base)`
   (wasm 2.0 init expression).
4. A `MEM_INFO` `memory_size` covering the segment + `memory_align` set
   to `log2(alignment)`.

For Phase 3 we punt on all of that — block bodies stay PIC-free.

---

## 6. Existing tools that produce a SIDE_MODULE

### `wasm-ld -shared`

`building.py:194-208` is the canonical incantation: when
`settings.SIDE_MODULE` is set, emcc passes
`--experimental-pic --unresolved-symbols=import-dynamic --no-shlib-sigcheck
 -shared --no-export-dynamic` to wasm-ld. wasm-ld then:

- Compiles the `.o` inputs to a wasm module.
- Emits the `dylink.0` custom section with the computed `memory_size`,
  `memory_align`, `table_size`, `table_align`, `needed`, `export_info`,
  `import_info` (see `lld/wasm/SyntheticSections.cpp` upstream —
  `DylinkSection`).
- Rewrites every reference to an external symbol as an *import* in the
  `env` or `GOT.*` module names.

wasm-ld's input is `.o` files (or `.so`s), which means feeding it a hand-
emitted wasm-1.0 module isn't a path — it expects LLVM's `R_WASM_*`
relocation entries inside object files. We could conceivably emit
relocatable object format ourselves, but that's bigger than just emitting
`dylink.0`. **Not the right tool for our use.**

### `wasm-emscripten-finalize`

Found at `emsdk/upstream/bin/wasm-emscripten-finalize` (Binaryen tool).
Per Emscripten's build pipeline this is run **after** wasm-ld to:

- Demangle the legalization wrappers for non-BigInt builds.
- Apply `--side-module` / `--global-base=...` / `--initial-stack-pointer=...`
  rewrites.
- Insert the `__indirect_function_table` import where missing.

The `--side-module` mode tells the tool "this is a SIDE_MODULE, don't
emit start function calls, add the dylink section if not present, etc."
But finalize **does not add a `dylink.0` to a module that has zero
information about its memory/table needs** — its input is already a
wasm-ld output that has those fields. So this tool also is not a
"convert plain → side" stage. **Not the right tool.**

### `llvm-objcopy` / `wasm-objcopy`

llvm-objcopy (at `emsdk/upstream/bin/llvm-objcopy`) supports adding
custom sections to wasm modules via `--add-section name=file`. This **is**
viable: we could pipe our hand-emitted plain-wasm module through

```
llvm-objcopy --add-section dylink.0=dylink_payload.bin block.wasm block.so
```

… where `dylink_payload.bin` is the 4-byte MEM_INFO we computed in §1
(not including the `0x00 0x0E 0x08 'dylink.0'` framing — `llvm-objcopy`
adds the custom-section header itself). This sidesteps having to teach
`WasmModuleBuilder` about custom sections at all.

**Caveats:**

- `llvm-objcopy --add-section` for wasm currently appends the section at
  the END of the module. We MUST move it to right after the header
  (loader requires offset 8). Either patch in-place after, or use Binaryen
  `wasm-opt --custom-section=dylink.0=…` which has more knobs.
- Spawning a subprocess per per-block compile is heavyweight — we
  currently compile thousands of blocks per second. Subprocess cost would
  kill throughput.

**Decision: hand-emit the `dylink.0` section directly from
`WasmModuleBuilder`. The byte format is 16 bytes — see §1 — and we
already control the section emission order.**

---

## 7. Reference: minimal SIDE_MODULE byte layout

This section reconstructs the *complete* byte layout of a SIDE_MODULE for
a single function `(i32, i32) -> i32` that returns its first parameter,
matching the shape `wasm_emit.cpp::build_block` will produce. Bytes are
derived from the WASM 1.0 binary spec + `library_dylink.js`
parser rules cited in §1. A run of `emcc -O0 -sSIDE_MODULE=1
-sEXPORTED_FUNCTIONS=_run` followed by `llvm-objdump -h` against the
sandbox-blocked `emcc` would confirm exact bytes; this is the open
question carried in §10.

```
# Header
00 61 73 6D     ; magic "\0asm"
01 00 00 00     ; version 1

# Section 0 (CUSTOM): dylink.0  — MUST be first
00              ; section_id = 0
0E              ; section_size = 14
08              ; name_len = 8
64 79 6C 69 6E 6B 2E 30  ; "dylink.0"
01              ; subsection_type = MEM_INFO
04              ; subsection_size = 4
00              ; memory_size  = 0
00              ; memory_align = 0  (=> 1 byte)
00              ; table_size   = 0
00              ; table_align  = 0  (=> 1; loader asserts this)

# Section 1 (TYPE)
01              ; section_id = 1
07              ; section_size
01              ; num types = 1
60              ; func type tag
02 7F 7F        ; 2 params: i32 i32
01 7F           ; 1 result: i32

# Section 2 (IMPORT) — just memory + the 8 SH4 helpers
02              ; section_id = 2
NN              ; section_size (LEB128) — depends on N imports
...             ; one import descriptor each:
                ;   modlen module modlen field kind ...
                ; e.g. for env.memory:
                ;   03 65 6E 76 06 6D 65 6D 6F 72 79 02 03 01 80 80 04
                ;     ^env             ^memory       ^kind(mem) ^shared+max flags=0x03 init=1 max=65536
                ; for env.sh4_read32 (type idx 1 since type 0 is the run type):
                ;   ... (skipped to keep this skeleton readable)

# Section 3 (FUNCTION)
03              ; section_id = 3
02              ; section_size
01              ; num funcs = 1
00              ; func 0 uses type index 0

# Section 7 (EXPORT)
07              ; section_id = 7
07              ; section_size
01              ; num exports = 1
03 72 75 6E     ; name_len=3 "run"
00              ; kind=FUNC
09              ; func index = 9   (8 imports + this func)

# Section 10 (CODE)
0A              ; section_id = 10
07              ; section_size
01              ; num bodies = 1
05              ; body_size
00              ; locals_count = 0
20 00           ; local.get 0
0F              ; return
0B              ; end
```

**Notes on the byte layout above:**

- The function index `9` in the export section assumes our existing
  8-import shape (read8/16/32, write8/16/32, ifb, shil_fb) → 8 imported
  funcs. Plain memory imports do NOT advance the function index space.
  `WasmModuleBuilder` already gets this right at `wasm_emit.cpp:1356`
  (`WIMPORT_COUNT`).
- The CODE section in our real emit will be much larger; this is just the
  smallest validate-able shape.
- We do NOT emit a TABLE section here because the dispatcher's
  call_indirect goes through the main module's table (imported from
  `env.__indirect_function_table` by the dispatcher, not by us).

---

## 8. Diff to `wasm_emit.cpp` and `wasm_module_builder.h`

### `wasm_module_builder.h` — new helpers

```cpp
// New section id (we currently don't have it explicit because
// emitTypeSection / emitImportSection / etc. all assume non-custom).
constexpr u8 WASM_SEC_CUSTOM = 0;

// Begin/end a CUSTOM section with a specific name.
// (Mirrors beginSection() but emits the section name before payload.)
void beginCustomSection(const char* name) {
    beginSection(WASM_SEC_CUSTOM);
    emitName(name);
}

// dylink.0 subsection types (per tool-conventions DynamicLinking.md).
constexpr u8 WASM_DYLINK_MEM_INFO    = 0x01;
constexpr u8 WASM_DYLINK_NEEDED      = 0x02;
constexpr u8 WASM_DYLINK_EXPORT_INFO = 0x03;
constexpr u8 WASM_DYLINK_IMPORT_INFO = 0x04;

// Emit the full dylink.0 section for a SIDE_MODULE that needs only
// MEM_INFO (no static data, no extra table slots, no NEEDED libs).
//
// memorySize/tableSize default to 0; align values are log2 (so 0 => 1B).
void emitDylink0_MinimalMemInfo(u32 memorySize = 0, u32 memoryAlign = 0,
                                u32 tableSize  = 0, u32 tableAlign  = 0) {
    beginCustomSection("dylink.0");
    emitByte(WASM_DYLINK_MEM_INFO);

    // Subsection size: need to back-patch (we don't know LEB byte count
    // up front). Reuse the 5-byte fixed-LEB128 patcher.
    u32 subSizePos = (u32)bytes.size();
    bytes.push_back(0); bytes.push_back(0); bytes.push_back(0);
    bytes.push_back(0); bytes.push_back(0);
    u32 subStart = (u32)bytes.size();
    emitLEB128(memorySize);
    emitLEB128(memoryAlign);
    emitLEB128(tableSize);
    emitLEB128(tableAlign);
    patchLEB128_5(subSizePos, (u32)bytes.size() - subStart);

    endSection();
}
```

`patchLEB128_5` is currently `private` in `WasmModuleBuilder` — keep it
that way and have `emitDylink0_MinimalMemInfo` live as a member function so
it has access. Or expose a `beginSubsection`/`endSubsection` pair that
hides the back-patching.

### `wasm_emit.cpp` — single-line addition

`build_block` (line 1347):

```cpp
std::vector<u8> build_block(RuntimeBlockInfo* block) {
    WasmModuleBuilder b;
    b.emitHeader();
    b.emitDylink0_MinimalMemInfo();   // <— NEW: must be first section
    emitTypeImportSection(b);
    ...
}
```

`build_epoch_module` (line 1390) gets the same one-line insertion. (If
Option-2 ditches the epoch path entirely in favour of one-block-per-module,
delete `build_epoch_module` instead.)

`emitTypeImportSection` does NOT change. Imports stay the same set
(`env.memory` + the eight `env.sh4_*` functions). The Emscripten loader's
`proxy` handler (`library_dylink.js:690-722`) resolves each to whatever
`wasmImports[<name>]` returned at main-module instantiation time, which is
exactly the JS shim's `Module._sh4_*` table in
`flycast_worker_funcs.js:84-96` — already wired.

No other emit-side changes are required for Phase 3 minimum-viable
SIDE_MODULE.

### Host (JS) side

`flycast_worker_funcs.js` switches from the current synchronous
`new WebAssembly.Module(bytes) / new WebAssembly.Instance(mod, imports)`
pair to Emscripten's `loadWebAssemblyModule(bytes, flags, libName, scope)`
(`library_dylink.js:607`). Two ways to invoke:

1. **C side calls `dlopen`** through Emscripten's libc, passing the
   in-memory bytes via the
   `EMSCRIPTEN_KEEPALIVE void* emscripten_dlopen_promise(const void*, size_t)`
   path. Emscripten 3.x exposes
   `EMSCRIPTEN_KEEPALIVE void emscripten_dlopen(const char* libname, int flags, void* user_data, em_dlopen_callback onsuccess, em_arg_callback_func onerror)` — see
   `emsdk/upstream/emscripten/system/lib/libc/dynlink.c`.
2. **JS side calls `Module.loadWebAssemblyModule`** directly. Requires
   `EXPORTED_RUNTIME_METHODS=loadWebAssemblyModule` at main-module link
   time.

Option 2 is simpler from the SH4 worker funcs. Either way the synchronous
fallback `loadWebAssemblyModule(binary, {loadAsync: false, nodelete: true})`
returns immediately with the relocated exports map (`library_dylink.js:872-874`).

The exports map will contain `{run: <wasm fn>, ...}`. We then look up
`GOT.func.run` to get the funcref-table index, and post that index +
the block's vaddr to the dispatcher's vaddr→idx map.

---

## 9. Decision: hand-emit `dylink.0` (not `wasm-ld -shared`)

| Option                            | Pros                                       | Cons                                                                            |
|-----------------------------------|--------------------------------------------|---------------------------------------------------------------------------------|
| `wasm-ld -shared` per block       | Spec-correct, generated by upstream tools  | Requires `.o` input format with R_WASM relocations — we'd have to ALSO emit those; subprocess per block kills throughput. |
| `llvm-objcopy --add-section`      | Re-uses tool                                | Subprocess per block; section ends up at wrong offset (must be first).          |
| Hand-emit `dylink.0` (this doc)   | Zero subprocess; <30 LoC in builder; full control over offsets | We own the spec compliance.                                                     |

**Decision: hand-emit.** The format is trivial (16 bytes for the minimum
case), the spec is small (1 file: `webassembly.py:158-176, 339-375`),
and we already control byte-level layout in `WasmModuleBuilder`.

---

## 10. Open questions (must build to verify)

1. **Does the Emscripten main module need additional flags to accept
   side-module loads of our hand-emitted shape?** Specifically:
   `MAIN_MODULE=1` (or `=2` for trimmed export list), and
   `EXPORTED_RUNTIME_METHODS=loadWebAssemblyModule` if JS calls it
   directly. The current `flycast_worker_emcc.js` was built without
   `MAIN_MODULE` — need to add it to `flycast_worker_link.sh` and confirm
   throughput regression is acceptable. (MAIN_MODULE adds an extra ~10-50KB
   of dlopen runtime and wraps all exports with addFunction calls — see
   `library_dylink.js:255-282`.)

2. **Exact LEB128 widths in a real wasm-ld-emitted `dylink.0`**: confirm
   wasm-ld uses single-byte LEB128 (not the fixed-5-byte pattern) for the
   subsection_size when the payload is small. The
   `library_dylink.js:475`'s `getLEB()` parser accepts variable-width
   LEB; either works. Worth dumping
   `llvm-objdump -hd refs/side_ref.wasm` once `emcc` is unblocked to
   confirm.

3. **Does `__indirect_function_table` get auto-imported by our hand-
   emitted module?** Today we do not import it. For the dispatcher to call
   our exports via `call_indirect`, the LOADER must put our `run` in the
   main table — `library_dylink.js:230` says yes, via `addFunction(value)`,
   but that path only runs if `MAIN_MODULE` is set on the main module
   (`addFunction` is gated by `ALLOW_TABLE_GROWTH=1` —
   `system/lib/libc/dynlink.c`). Confirm at runtime.

4. **First-section-must-be-`dylink.0`** is asserted by
   `library_dylink.js:443`. Our `WasmModuleBuilder` currently has
   `emitHeader()` followed by `emitTypeSection()` — switching the order
   is fine, but verify `build_epoch_module` callers don't depend on
   "first byte after header == 0x01".

5. **Throughput regression budget.** The plain-WASM path today is
   ~21K disp/s sustained (from `dreamcast_inwasm_dispatcher_plan.md`).
   Even a no-op dlopen wraps each `new WebAssembly.Instance` with extra
   work (loader walks imports through Proxy, updateGOT, relocateExports).
   Per-block cost adds ~tens of microseconds. Open Q: does that exceed
   the V8-IC-megamorphic cliff we're trying to fix? Must A/B with
   `?option2=1` env-gate.

6. **Confirm `addFunction` adds to the SAME table imported by a future
   dispatcher module.** Emscripten's `addFunction` writes to
   `wasmTable` which is initialised from
   `Module.wasmExports['__indirect_function_table']` (or grown from it).
   The dispatcher module's `(import "env" "__indirect_function_table"
   (table funcref))` resolves to the same `wasmTable` via the Proxy
   handler — but only if the dispatcher is loaded via the same loader
   path. Verify both blocks and the dispatcher get the SAME funcref
   table identity at runtime (`wasmTable === <dispatcher's imported
   table>` after instantiation).

7. **Stack-pointer global**: side modules built by `wasm-ld -shared`
   import `__stack_pointer` as a mutable i32 global from `env`. Our
   block bodies do no stack ops (everything goes through wasm locals).
   But: does the Emscripten loader still expect that import to exist?
   `library_dylink.js:707-720` Proxy returns
   `wasmImports[prop]` for unknown names, fine if the host has
   `_emscripten_stack_get_base` etc. but our blocks don't use them.
   Worth grep on a real compiled side-module's import list.

---

## 11. Summary

- **dylink.0**: 16 bytes for the minimum case; one MEM_INFO subsection of
  4 LEB zeros. Must be the first section in the module.
  Cite: `library_dylink.js:443, 466-480`; `webassembly.py:339-375`.

- **Relocations**: NOT required. Our blocks have no data segment, no
  funcref taken (no `GOT.func`), no global address-of (no `GOT.mem`).
  Cite: `library_dylink.js:258-282, 836-846`.

- **GOT**: zero entries. Imports stay the existing 9 (memory + 8 funcs).
  Cite: `library_dylink.js:160-177, 284-322`.

- **Function index space**: unchanged. `run` keeps function index
  `WIMPORT_COUNT + 0` (= 9). The Emscripten loader calls
  `addFunction(exports.run)` post-instantiation
  (`library_dylink.js:229-233`), which slots it into the main module's
  `__indirect_function_table` and writes the table index to
  `GOT.func.run.value` — the dispatcher reads that for its lookup.

- **PIC**: not required. Our emit produces no static data and references
  no side-module-local globals. If/when we inline LUTs we'll need
  `__memory_base` + a data segment.

- **Tooling**: hand-emit. wasm-ld needs `.o` inputs (too heavy); finalize
  doesn't add dylink to a stranger module; objcopy puts the section at
  the wrong offset.

- **Code impact**: ~30 LoC in `wasm_module_builder.h`
  (`emitDylink0_MinimalMemInfo` + the `WASM_SEC_CUSTOM` /
  `WASM_DYLINK_*` constants); one new call in `build_block` /
  `build_epoch_module` right after `emitHeader()`. JS-side flips to
  `loadWebAssemblyModule` (or C-side `emscripten_dlopen`) and reads
  `GOT.func.run.value` to populate the dispatcher's vaddr→idx map.

- **Carry over to build-time verification**: the seven open questions in
  §10. The most consequential is #1 (does main module need `MAIN_MODULE=1`
  and what's the size cost?) and #5 (throughput A/B vs current 21K disp/s
  baseline).

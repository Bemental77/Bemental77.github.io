# Item 6 — MMIO Stage 2: SAB mirror canonical for writes (design)

**Status:** design only. No code shipped under this item. Stage 1 (`a1_mmio_mirror_2026_05_10.md`) already laid the cls-table scaffolding and the emit-site helper for *reads*; Stage 2 extends both to writes.

## 1. The core architectural wrinkle

Stage 1 made the SAB mirror canonical for **reads** because dolphin already owns and updates the host-native register words; the mirror is just a sync'd copy. Stage 2 cannot symmetrically make the SAB canonical for **writes** because GameCube MMIO is not pure storage — most writes have side effects that must still execute in dolphin (IRQ updates, DMA kicks, CoreTiming events, etc.).

Concretely (see `ProcessorInterface.cpp`):

- `PI_INTERRUPT_MASK` is registered with `DirectRead<u32>(&m_interrupt_mask)` (pure-storage read) **but** `ComplexWrite` that does `m_interrupt_mask = val; UpdateException();`. Other code (PI ISR delivery, line 200) reads `m_interrupt_mask` *directly from the C++ field*, not from the MMIO mirror. If ppc-worker writes the mirror only, the field stays stale and `UpdateException` computes against a wrong mask.

So "SAB mirror canonical for writes" really means **two coordinated changes**:

1. **Pure-storage writes** (`DirectWrite` on both 16- and 32-bit): emit `i32.store` to the mirror. No dolphin notification needed for that subset *only if* dolphin reads canonical state from the mirror. Today it reads from the C++ field. The cheapest fix: keep the C++ field as source of truth, and have dolphin pull from the mirror back into the field at slice boundaries (mirror→struct sync, the dual of Stage 1's struct→mirror sync). Cheap, bounded staleness, no per-handler edits.

2. **Side-effect writes** (`ComplexWrite`): MUST reach dolphin's handler lambda. Three plausible routes (see §4); a SAB pending-writes ring drained by dolphin in CoreTiming is the right shape.

## 2. Classification by semantic type

Walked the handlers under `gamecube/dolphin-src/Source/Core/Core/HW/`. The `WriteHandlingMethodVisitor` surface (MMIOHandlers.h:107) only has `VisitDirect(T* addr, u32 mask)` and `VisitComplex(...)` — there is no nop-write or constant-write. Classification follows trivially from which visitor fires.

| Range | Window | Read side | Write side | Stage 2 disposition |
|---|---|---|---|---|
| CP | 0xCC000000 | mostly Complex (FIFO ptrs, status flag clears) | mostly Complex (FIFO state, BP/SR clears) | side-effect — mailbox |
| VI | 0xCC002000 | mix: DR for HSW/VSW/HSR/FCT mapped vars; CR for status/position | Direct on storage regs, Complex on control regs (mode change, XFB addr commit) | per-cell: mostly Direct writes → SAB. ~12 ComplexWrites → mailbox |
| PI | 0xCC003000 | DirectRead on mask + cause | ComplexWrite (calls UpdateException) | **all writes mailbox** (handler must fire) |
| Memory Interface | 0xCC004000 | mostly Direct on chunk-of-regs | mostly Direct, some Complex for protected regions | Direct → SAB |
| DSP/AR | 0xCC005000 | mix; some clears-on-read | Complex (DMA start, mailbox bits) | **all writes mailbox** |
| DI | 0xCC006000 | Direct on status copies | Complex (command kickoff, DI IRQ) | **all writes mailbox** |
| SI | 0xCC006400 | mostly Direct | Complex (transfer kickoff) | **all writes mailbox** |
| EXI | 0xCC006800 | mostly Direct | Complex (channel kickoff) | **all writes mailbox** |
| AI | 0xCC006C00 | Direct | Complex (rate/start) | **all writes mailbox** |
| GP FIFO data | 0xCC008000 | n/a | streaming — NOT in MMIO dispatch (separate path) | out of scope, already a ring |

Bottom line: **VI and MemoryInterface are the main wins for direct writes**. PI/DI/SI/EXI/AI/DSP/CP are dominated by Complex writes — direct-write Stage 2 cannot help them; what helps is shortening the mailbox round-trip (a pending-writes ring instead of a synchronous reply).

The cls-table cell value is what carries this per-cell. Slots already reserved:

- `DIRECT_RW` (1) — read AND write to mirror.
- `READ_SE` (2) — read mailbox, write mirror.
- `WRITE_SE` (3) — read mirror, write mailbox.
- `READ_WRITE_SE` (4) — both mailbox.
- `CONSTANT` (5) — read folds to const, write typically NOP/Invalid.

Stage 1 only emits the value `DIRECT_RW` (because writes always mailbox). Stage 2 needs the classifier to actually distinguish on the write side.

## 3. Emit-side changes

Files and line anchors (all line numbers from the current `dev` branch state):

### 3a. New helper in `bementalJIT/guests/powerpc/gekko_emit.cpp`

Add `emit_mmio_mirror_store_else_or_import` next to `emit_mmio_mirror_else_or_import` (line 531). Layout mirrors the read helper but for writes:

```
rel = ea - 0xCC000000
if (rel < 0x40000) AND (cls[rel >> shift] in {DIRECT_RW, READ_SE})
    i32.store[16] offset = MMIO_MIRROR_ADDR    ; host-native, no bswap
else
    call write_import(ea, val)                  ; existing mailbox path
```

Acceptance set is `{DIRECT_RW, READ_SE}` because `READ_SE` means *read* has side effects but *write* is pure-storage. For `{WRITE_SE, READ_WRITE_SE, UNMAPPED, CONSTANT}` the helper falls through to the import.

Caveats from Stage 1 carry over verbatim:
- Use `op_local_set(LOCAL_TMP_B)` for `rel`, NOT `op_local_tee` — keeps the if/else block fall-through balanced to one value (or here, zero values since stores are void).
- Mask `rel & (MMIO_GUEST_RANGE_BYTES-1)` before indexing cls; the unmasked value can be huge for non-MMIO addresses and would index past the cls table → wasm bounds trap.
- Use B11-aware `emit_b11_op_if/else/end` so the cross-arm GPR-cache coherence bug (see `b11_coherence_bug_2026_05_07.md`) does not regress.
- 8-bit writes skip the mirror in Stage 2 too (no cls8 table). Rare in MMIO.

### 3b. Wire `emit_store_d` / `emit_store_x` slow paths

Two call sites today route to `emit_import_or_stub` for the write:

- `emit_store_d` line 779 (path a: no fastmem base) and line 816 (path c: untrusted-block else-arm).
- `emit_store_x` line 3226 (path a) and line 3289 (path c).

Each of these replaces `emit_import_or_stub(c, import_idx)` with `emit_mmio_mirror_store_else_or_import(c, import_idx)`. The caller must first push EA into `LOCAL_TMP_A` and value into `LOCAL_TMP_C` (need a new scratch local; LOCAL_TMP_B is reserved for `rel`). The helper consumes both. Symmetry with the read helper keeps the stack discipline identical.

The path-b case (`g_mem1_safe == true`) already proved the EA is in MEM1, never MMIO — no change needed there.

### 3c. cls-table writer side in `MMIOMirror.cpp`

`ReadClassifier` (line 71) records reads. Add a parallel `WriteClassifier<T> : MMIO::WriteHandlingMethodVisitor<T>` that records `VisitDirect → DIRECT_RW_W`, `VisitComplex → COMPLEX_W` into a temporary per-cell byte.

Then in `walk_size<T>` (line 99) do both reads and writes for each cell and combine into the cls byte:

```
read_cls  + write_cls  →  cls_table entry
DIRECT    + DIRECT     →  DIRECT_RW
DIRECT    + COMPLEX    →  WRITE_SE
COMPLEX   + DIRECT     →  READ_SE
COMPLEX   + COMPLEX    →  READ_WRITE_SE
CONSTANT  + any        →  CONSTANT  (write rarely valid; treat as read-fold)
```

The emit-side read helper already keys on `== DIRECT_RW`; that subset still works. The emit-side write helper keys on `in {DIRECT_RW, READ_SE}`. Both checks can be a single byte compare with no table change since the cls enum values are stable.

## 4. Side-effect routing

`ComplexWrite` cells must still reach dolphin's lambda. Options, in increasing order of complexity:

### Option W1 — mailbox synchronous (status quo, no change)
Already-shipped `env.ppc_write{8,16,32}` import call. Cost: one WASM→JS→postMessage round-trip per side-effect write. This is what Stage 2 leaves in place for `WRITE_SE` / `READ_WRITE_SE` cells.

### Option W2 — pending-writes SPSC ring in SAB
Dedicated ring at e.g. `0x02680000` (the 64 KB stage-2 reserved region in sab_layout.h:211), records: `{cmd_byte, size, ea_u32, val_u32}` per slot. ppc-worker writes the slot atomically (head++ with `Atomics.store` release), no reply wait. Dolphin drains in its CoreTiming event boundary (or on each `Run()` slice entry — already a yield point).

Pros: zero per-write JS round-trip; ppc-worker keeps running without waiting. Pros for VI/AI: the kHz-rate writes the SDK does for audio/video state become batchable.

Cons: handler side effects (DMA start, IRQ raise) execute asynchronously w.r.t. the write that triggered them. For most GameCube MMIO this is fine — the guest spins on a status register that lives in the mirror, and dolphin sets that status when it processes the queued write. But some patterns (DI command-then-immediate-poll-status) need the handler to run BEFORE the next dispatch slice; the slice-boundary drain satisfies that.

Cons: the ring needs to be big enough to absorb a slice's worth of writes. 16K slots × 16 B = 256 KB is plenty.

### Option W3 — per-range atomic flag
Each MMIO range has a u32 flag in SAB. ppc-worker sets the flag after writing the mirror; dolphin polls the flag in its slice. Cheaper than W2 (no ring), but loses ordering across writes and across ranges — wrong for command sequences.

**Recommendation: W2.** It's the smallest change that gets us off the synchronous round-trip, and the slice-boundary drain matches dolphin's existing CoreTiming event cadence. W1 stays in place as the fallback for the very first SAB-layout version that ships W2 (gated by a runtime flag so we can A/B).

## 5. Mirror→struct sync (the dual of Stage 1's struct→mirror)

Required so dolphin's own code (e.g. PI ISR delivery reading `m_interrupt_mask`) sees ppc-worker-side writes. The existing `g_direct16` / `g_direct32` vectors already enumerate the cells with native storage pointers; the sync function just runs in reverse:

```cpp
void mmio_mirror_sync_from_sab() {
    for (auto& r : g_direct16) {
        const uint16_t* mirror = ...;
        std::memcpy(const_cast<uint16_t*>(r.src), mirror, sizeof(uint16_t));
    }
    // same for g_direct32
}
```

`DirectCellRecord::src` is currently `const T*` because Stage 1 only reads from the dolphin side. Drop the `const` (or add a parallel writable record set) so the sync-from-sab pass can write through.

Call site: same as `mmio_mirror_sync_to_sab` — at the `JitWasm::Run()` yield boundary in `JitWasm.cpp`, BEFORE dolphin re-enters its own loop. Pair the two:

```
yield boundary:
  mmio_mirror_sync_from_sab();   // pull ppc-worker writes into struct
  drain_pending_writes_ring();    // execute queued ComplexWrite lambdas
  // ... dolphin's per-slice work ...
  mmio_mirror_sync_to_sab();      // push struct back to mirror
```

## 6. Verification plan

Per-stage validation that does NOT depend on visible-frame progress (which is dominated by orthogonal bottlenecks):

1. **Build green** — `bash gamecube/ppc-worker/build_ppc_worker.sh` and `bash build_and_probe.sh` exit 0.
2. **No write-mailbox regression** — diag counters in `MMIOMirror.cpp` track per-range mailbox-write count. After Stage 2 lands, expected drop for VI and MemoryInterface (DIRECT_RW write cells); zero change for PI/DI/SI/EXI/AI/DSP/CP (all-Complex).
3. **PI mask coherence** — known-fragile case from `b11_coherence_bug_2026_05_07.md`. Probe: read `m_interrupt_mask` from dolphin at slice boundary, compare to mirror byte. Must agree.
4. **Boot-probe parity** — iter count and exit-pc match Stage 1 baseline or improve. Regression = the mirror→struct sync isn't catching some write, or a Complex handler isn't seeing its trigger.
5. **DVDLowInquiry path** — DI is all-Complex on writes, so DI must still issue command + see TCINT. Apploader stall would be the failure mode.

## 7. What this design explicitly defers

- **CONSTANT-write classification**: cls slot value 5 exists but the write side is unhandled. In practice most CONSTANT cells have `InvalidWrite` (log + drop) — emitting a drop is correct. Add a fast-path for that if it shows up hot.
- **8-bit writes**: rare in MMIO. Stage 2 keeps them on the import path.
- **GP FIFO at 0xCC008000**: separate streaming path. Different design (true ring buffer to a dolphin video backend).
- **Cross-size aliasing**: if a 16-bit cell is mirrored at offset O and the JIT does a 32-bit store at O-2, the lower halfword scribbles over a different cell. Dolphin's MMIO dispatch enforces single-size; the emit helper inherits that constraint (cls lookup is per-size).
- **Out-of-order observability across cores**: there is only one PowerPC core. No memory-model concerns from the guest. Host-side WASM→JS atomics on the pending-writes ring head are sufficient.

## 8. Out-of-scope reminders (constraint, not descope)

Per `feedback_no_constraint_descope.md`, the items below are constraints that shape Stage 2 — they are NOT removed from the broader plan, and Stage 2 is one slice of the per-instruction-roundtrip elimination arc (Phase A2..A5 still pending per Stage 1 memory):

- A2 in-worker `ppc_read_tb`, A3 inline-emit mfcr / mtcrf / fixed-table SPRs, A4 residual-op fallback interpreter, A5 drop `ppc_interp`/`ppc_read*`/`ppc_write*` imports entirely. Stage 2 is parallel to and unblocks A5 for the write side.

## File-level summary of where the edits land

- `bementalJIT/guests/powerpc/gekko_emit.cpp` — new `emit_mmio_mirror_store_else_or_import` near line 531; rewire 4 call sites (lines 779, 816, 3226, 3289).
- `gamecube/dolphin-src/Source/Core/Core/HW/MMIOMirror.cpp` — add `WriteClassifier`, combine in `walk_size`, add `mmio_mirror_sync_from_sab`, drop `const` on `DirectCellRecord<T>::src`.
- `gamecube/dolphin-src/Source/Core/Core/HW/MMIOMirror.h` — declare `mmio_mirror_sync_from_sab`.
- `gamecube/dolphin-src/Source/Core/Core/PowerPC/JitWasm/JitWasm.cpp` — add the new sync call at the yield boundary, paired before the existing `mmio_mirror_sync_to_sab`.
- `gamecube/dolphin-bridge/dolphin_worker_link.sh` — export `_dolphin_mmio_mirror_sync_from_sab` and (if W2 lands) `_dolphin_mmio_drain_pending_writes`.
- `gamecube/ppc-worker/sab_layout.h` — claim `0x02680000` (currently reserved) for pending-writes ring; document fields.
- `gamecube/ppc-worker/ppc_worker.js` — (W2 only) install `env.ppc_write{8,16,32}` as ring-enqueue rather than postMessage call when feature flag is on.

// rec_wasm.cpp — Sh4Dynarec implementation for the wasm32 (Emscripten) target.
//
// Lives in flycast-bridge/ per the no-patching-upstream rule. Compiled into
// the libretro target by patches/0003 when ARCHITECTURE contains "wasm32".
//
// Phase 1 single-worker bridge:
//   - compile() builds a per-block WASM module via bemental::sh4::build_block
//     and hands the bytes to JS via wasm_dispatcher_register_block (EM_JS).
//   - block->code points at a single shared trampoline. The dispatcher calls
//     it like any native dynarec entry point; the trampoline reads PC out of
//     Sh4cntx, hands (pc, ctx_ptr, ram_base) to wasm_dispatcher_run_block,
//     and lets the WASM module's emitBlockExit code update Sh4cntx.pc.
//   - mainloop() is now a real loop (not a stub): it dispatches blocks until
//     CpuRunning goes false, mirroring the per-arch mainloops in rec-x64 etc.
//
// The JS side (flycast_worker_funcs.js) owns the WebAssembly.Module / Instance
// caches; the EM_JS bodies call out to that file's module-scope state.

#include "build.h"

#if FEAT_SHREC == DYNAREC_JIT && HOST_CPU == CPU_WASM

#include "types.h"
#include "hw/sh4/sh4_if.h"
#include "hw/sh4/dyna/ngen.h"
#include "hw/sh4/dyna/blockmanager.h"
#include "log/Log.h"
#include "oslib/host_context.h"

// bementalJITSh4 adds guests/sh4/ to its PUBLIC include path; rec_wasm.cpp
// is compiled into a target that links bementalJITSh4, so the bare include
// resolves. Mirrors how Dolphin's JitWasm.cpp includes "gekko_emit.h".
#include "wasm_emit.h"

#include <emscripten.h>

#include <cstdint>
#include <cstdio>
#include <unordered_map>
#include <vector>

// ---------------------------------------------------------------------------
// JS bridge: register / dispatch a per-block WASM module.
//
// EM_JS bodies live inside flycast_worker_funcs.js's module scope (post-js'd
// into the same factory), so they can reach the `flycast_block_modules` /
// `flycast_block_instances` Maps and the shared `flycast_wasm_imports`
// import object defined there. Doing the heavy lifting in funcs.js (rather
// than inlining everything here) keeps the EM_JS bodies short and lets us
// edit the JS side without touching C++.
// ---------------------------------------------------------------------------

EM_JS(int, wasm_dispatcher_register_block,
      (uint32_t vaddr, const uint8_t* bytes, uint32_t len),
{
    // Synchronous compile is fine for these tiny per-block modules; switching
    // to WebAssembly.compile (async) would force ASYNCIFY on the compile path.
    if (typeof flycast_register_block === 'function') {
        return flycast_register_block(vaddr >>> 0, bytes >>> 0, len >>> 0) | 0;
    }
    return 0;
});

EM_JS(uint32_t, wasm_dispatcher_run_block,
      (uint32_t vaddr, uintptr_t ctx_ptr, uintptr_t ram_base),
{
    if (typeof flycast_run_block === 'function') {
        return flycast_run_block(vaddr >>> 0, ctx_ptr >>> 0, ram_base >>> 0) >>> 0;
    }
    return (vaddr + 2) >>> 0;
});

// ---------------------------------------------------------------------------
// Compiled-block byte store. Kept around for diagnostics / future "dump
// compiled blocks" tooling. The JS side already owns the live Module+Instance
// caches, but stashing the raw bytes lets us re-register or hex-dump after
// the fact without re-running build_block.
// ---------------------------------------------------------------------------
static std::unordered_map<u32, std::vector<u8>> g_compiled_blocks;

// ---------------------------------------------------------------------------
// Shared trampoline. Every successfully-compiled block's RuntimeBlockInfo::code
// points here. We read PC out of Sh4cntx (the dispatcher's invariant: it only
// calls block->code when PC matches the block), look up the matching WASM
// module via vaddr, and dispatch through JS.
//
// The compiled block's "run" export updates Sh4cntx.pc itself (via emitBlockExit
// in bementalJIT/guests/sh4/wasm_emit.cpp). The return value (next_pc) is the
// same PC value Sh4cntx.pc was just written to — we mirror it back to Sh4cntx
// defensively so a misbehaving emitBlockExit can't desync the dispatcher.
//
// Sh4cntx is a macro for p_sh4rcb->cntx; p_sh4rcb is a global set up at SH4
// init time, so the trampoline can look it up cheaply on every call.
// ---------------------------------------------------------------------------
static void wasm_block_trampoline()
{
    Sh4Context* ctx = &Sh4cntx;
    const u32 pc = ctx->pc;
    // ram_base = 0: emitted SHIL ops use absolute addresses into wasmMemory
    // (the import is `env.memory`, shared with the worker), so no relocation
    // base is needed. The arg slot is reserved for a future fastmem path
    // that wants to add a region offset to guest addresses before each load.
    const u32 next_pc = wasm_dispatcher_run_block(pc, (uintptr_t)ctx, 0u);
    // Defensive PC mirror — the WASM module already wrote ctx->pc, but if a
    // future code path returns next_pc without storing it (or vice versa),
    // we want the dispatcher to keep moving rather than spin on a stale PC.
    ctx->pc = next_pc;
}

// ---------------------------------------------------------------------------
// Sh4Dynarec subclass.
// ---------------------------------------------------------------------------
class WasmDynarec : public Sh4Dynarec
{
public:
	WasmDynarec() {
		sh4Dynarec = this;
	}

	void init(Sh4Context& sh4ctx, Sh4CodeBuffer& codeBuffer) override
	{
		this->sh4ctx = &sh4ctx;
		this->codeBuffer = &codeBuffer;
		INFO_LOG(DYNAREC, "[rec_wasm] init");
	}

	void compile(RuntimeBlockInfo* block, bool /*smc_checks*/, bool /*optimise*/) override
	{
		// Build a WASM module for this block via bementalJIT.
		std::vector<u8> bytes = bemental::sh4::build_block(block);
		const u32 vaddr = block->vaddr;
		const u32 len   = (u32)bytes.size();

		// Hand the bytes to the JS dispatcher (synchronous WebAssembly.Module
		// compile + cache by vaddr). Failure here means the JS side rejected
		// the bytes — log it but still install the trampoline so a re-entry
		// at the same PC re-attempts dispatch (which will then fall through
		// to "no module for vaddr" and advance PC by 2 to make forward
		// progress rather than spin).
		const int ok = wasm_dispatcher_register_block(vaddr, bytes.data(), len);
		if (!ok) {
			WARN_LOG(DYNAREC, "[rec_wasm] register_block FAILED vaddr=%08x len=%u",
			         vaddr, len);
		}

		g_compiled_blocks[vaddr] = std::move(bytes);

		block->code            = (DynarecCodeEntryPtr)&wasm_block_trampoline;
		block->host_code_size  = 0;
		block->host_opcodes    = 0;
	}

	void reset() override
	{
		INFO_LOG(DYNAREC, "[rec_wasm] reset — clearing %zu compiled blocks",
		         g_compiled_blocks.size());
		g_compiled_blocks.clear();
		// The JS side wipes its caches when it sees the next register_block
		// for an existing vaddr; an explicit "flycast_reset_blocks()" call
		// could be added here later if reset becomes hot.
	}

	void mainloop(void* /*cntx*/) override
	{
		// Dispatch loop. Mirrors the structure of the JIT-emitted mainloops
		// in rec-x64/rec-arm: look up code by current PC, call it, repeat
		// until CpuRunning goes false.
		//
		// The trampoline updates Sh4cntx.pc inline, so the loop body reads
		// the fresh PC on every iteration. bm_GetCodeByVAddr returns either
		// the matching block's code() (always wasm_block_trampoline for us)
		// or ngen_FailedToFindBlock — the latter triggers a compile + retry
		// inside Flycast's driver via rdv_FailedToFindBlock_pc, so we don't
		// re-implement it here.
		Sh4Context* ctx = sh4ctx;
		while (ctx->CpuRunning) {
			DynarecCodeEntryPtr code = bm_GetCodeByVAddr(ctx->pc);
			code();
		}
	}

	void handleException(host_context_t& /*context*/) override
	{
		// WASM has no native fault handler — exceptions propagate as C++
		// throws from the imports (e.g. SH4ThrownException out of the
		// IFB fallback). The dispatcher's normal driver path catches them.
		INFO_LOG(DYNAREC, "[rec_wasm] handleException stub");
	}

	bool rewrite(host_context_t& /*context*/, void* /*faultAddress*/) override
	{
		// No SIGSEGV-driven fastmem rewrites — every guest mem access goes
		// through the bounds-checked sh4_read*/sh4_write* imports.
		return false;
	}

	void canonStart(const shil_opcode* /*op*/) override
	{
		// TODO(canon): canonical-call ABI for SHIL native emit. Phase 1
		// only emits IFB fallbacks (emitShilOp returns true for shop_ifb
		// and false for everything else), so canonStart/Param/Call/Finish
		// are never reached on the IFB path. They'll be wired alongside
		// the first native SHIL emitter.
	}

	void canonParam(const shil_opcode* /*op*/, const shil_param* /*param*/,
	                CanonicalParamType /*paramType*/) override
	{
	}

	void canonCall(const shil_opcode* /*op*/, void* /*function*/) override
	{
	}

	void canonFinish(const shil_opcode* /*op*/) override
	{
	}

private:
	Sh4Context*     sh4ctx     = nullptr;
	Sh4CodeBuffer*  codeBuffer = nullptr;
};

static WasmDynarec instance;

#endif // FEAT_SHREC == DYNAREC_JIT && HOST_CPU == CPU_WASM

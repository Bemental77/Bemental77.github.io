// wasm_module_builder.h — WASM binary format builder for bementalJIT
//
// Builds valid WebAssembly modules byte-by-byte. No external dependencies.
// Used by guest emitters to compile basic blocks into WASM functions.

#pragma once
#include "types.h"
#include <vector>
#include <cstring>

// WASM value types
constexpr u8 WASM_TYPE_I32 = 0x7F;
constexpr u8 WASM_TYPE_I64 = 0x7E;
constexpr u8 WASM_TYPE_F32 = 0x7D;
constexpr u8 WASM_TYPE_F64 = 0x7C;
constexpr u8 WASM_TYPE_V128 = 0x7B;   // fixed-width SIMD (paired-single f32x2 in lanes 0-1)
constexpr u8 WASM_TYPE_FUNC = 0x60;

// WASM section IDs (full set in spec order: type=1, import=2, function=3,
// table=4, memory=5, global=6, export=7, start=8, element=9, code=10,
// data=11). We emit only the subset listed below.
constexpr u8 WASM_SEC_TYPE     = 1;
constexpr u8 WASM_SEC_IMPORT   = 2;
constexpr u8 WASM_SEC_FUNCTION = 3;
constexpr u8 WASM_SEC_TABLE    = 4;
constexpr u8 WASM_SEC_GLOBAL   = 6;
constexpr u8 WASM_SEC_EXPORT   = 7;
constexpr u8 WASM_SEC_ELEMENT  = 9;
constexpr u8 WASM_SEC_CODE     = 10;
constexpr u8 WASM_SEC_DATA_COUNT = 12;

// WASM import/export kinds
constexpr u8 WASM_IMPORT_FUNC   = 0x00;
constexpr u8 WASM_IMPORT_TABLE  = 0x01;
constexpr u8 WASM_IMPORT_MEMORY = 0x02;
constexpr u8 WASM_EXPORT_FUNC   = 0x00;
constexpr u8 WASM_EXPORT_TABLE  = 0x01;
constexpr u8 WASM_EXPORT_MEMORY = 0x02;
constexpr u8 WASM_EXPORT_GLOBAL = 0x03;

// WASM reference types (used by tables)
constexpr u8 WASM_REF_FUNCREF   = 0x70;

// WASM opcodes
namespace wop {
	constexpr u8 unreachable   = 0x00;
	constexpr u8 nop           = 0x01;
	constexpr u8 block         = 0x02;
	constexpr u8 loop_         = 0x03;
	constexpr u8 if_           = 0x04;
	constexpr u8 else_         = 0x05;
	constexpr u8 end           = 0x0B;
	constexpr u8 br            = 0x0C;
	constexpr u8 br_if         = 0x0D;
	constexpr u8 br_table      = 0x0E;
	constexpr u8 return_       = 0x0F;
	constexpr u8 call          = 0x10;
	constexpr u8 drop          = 0x1A;
	constexpr u8 select        = 0x1B;
	constexpr u8 local_get     = 0x20;
	constexpr u8 local_set     = 0x21;
	constexpr u8 local_tee     = 0x22;
	constexpr u8 global_get    = 0x23;
	constexpr u8 global_set    = 0x24;
	constexpr u8 i32_load      = 0x28;
	constexpr u8 i64_load      = 0x29;
	constexpr u8 f32_load      = 0x2A;
	constexpr u8 f64_load      = 0x2B;
	constexpr u8 i32_load8_s   = 0x2C;
	constexpr u8 i32_load8_u   = 0x2D;
	constexpr u8 i32_load16_s  = 0x2E;
	constexpr u8 i32_load16_u  = 0x2F;
	constexpr u8 i32_store     = 0x36;
	constexpr u8 i64_store     = 0x37;
	constexpr u8 f32_store     = 0x38;
	constexpr u8 f64_store     = 0x39;
	constexpr u8 i32_store8    = 0x3A;
	constexpr u8 i32_store16   = 0x3B;
	constexpr u8 i32_const     = 0x41;
	constexpr u8 f32_const     = 0x43;
	constexpr u8 f64_const     = 0x44;
	constexpr u8 i32_eqz       = 0x45;
	constexpr u8 i32_eq        = 0x46;
	constexpr u8 i32_ne        = 0x47;
	constexpr u8 i32_lt_s      = 0x48;
	constexpr u8 i32_lt_u      = 0x49;
	constexpr u8 i32_gt_s      = 0x4A;
	constexpr u8 i32_gt_u      = 0x4B;
	constexpr u8 i32_le_s      = 0x4C;
	constexpr u8 i32_le_u      = 0x4D;
	constexpr u8 i32_ge_s      = 0x4E;
	constexpr u8 i32_ge_u      = 0x4F;
	constexpr u8 f32_eq        = 0x5B;
	constexpr u8 f32_gt        = 0x5E;
	constexpr u8 i32_clz       = 0x67;
	constexpr u8 i32_add       = 0x6A;
	constexpr u8 i32_sub       = 0x6B;
	constexpr u8 i32_mul       = 0x6C;
	constexpr u8 i32_div_s     = 0x6D;
	constexpr u8 i32_div_u     = 0x6E;
	constexpr u8 i32_rem_s     = 0x6F;
	constexpr u8 i32_rem_u     = 0x70;
	constexpr u8 i32_and       = 0x71;
	constexpr u8 i32_or        = 0x72;
	constexpr u8 i32_xor       = 0x73;
	constexpr u8 i32_shl       = 0x74;
	constexpr u8 i32_shr_s     = 0x75;
	constexpr u8 i32_shr_u     = 0x76;
	constexpr u8 i32_rotl      = 0x77;
	constexpr u8 i32_rotr      = 0x78;
	constexpr u8 f32_abs       = 0x8B;
	constexpr u8 f32_neg       = 0x8C;
	constexpr u8 f32_sqrt      = 0x91;
	constexpr u8 f32_add       = 0x92;
	constexpr u8 f32_sub       = 0x93;
	constexpr u8 f32_mul       = 0x94;
	constexpr u8 f32_div       = 0x95;
	// i64 comparisons
	constexpr u8 i64_eqz       = 0x50;
	constexpr u8 i64_lt_u      = 0x54;
	// i64 arithmetic
	constexpr u8 i64_clz       = 0x79;
	constexpr u8 i64_add       = 0x7C;
	constexpr u8 i64_sub       = 0x7D;
	constexpr u8 i64_mul       = 0x7E;
	constexpr u8 i64_and       = 0x83;
	constexpr u8 i64_or        = 0x84;
	constexpr u8 i64_xor       = 0x85;
	constexpr u8 i64_shl       = 0x86;
	constexpr u8 i64_shr_s     = 0x87;
	constexpr u8 i64_shr_u     = 0x88;
	constexpr u8 i64_const     = 0x42;

	// f64 comparison
	constexpr u8 f64_eq        = 0x61;
	constexpr u8 f64_ne        = 0x62;
	constexpr u8 f64_lt        = 0x63;
	constexpr u8 f64_gt        = 0x64;
	constexpr u8 f64_le        = 0x65;
	constexpr u8 f64_ge        = 0x66;

	// f64 ops
	constexpr u8 f64_abs       = 0x99;
	constexpr u8 f64_neg       = 0x9A;
	constexpr u8 f64_ceil      = 0x9B;
	constexpr u8 f64_floor     = 0x9C;
	constexpr u8 f64_trunc     = 0x9D;
	constexpr u8 f64_nearest   = 0x9E;
	constexpr u8 f64_sqrt      = 0x9F;
	constexpr u8 f64_add       = 0xA0;
	constexpr u8 f64_sub       = 0xA1;
	constexpr u8 f64_mul       = 0xA2;
	constexpr u8 f64_div       = 0xA3;
	constexpr u8 f64_min       = 0xA4;
	constexpr u8 f64_max       = 0xA5;

	// Conversions
	constexpr u8 i32_wrap_i64  = 0xA7;
	constexpr u8 i32_trunc_f32_s = 0xA8;
	constexpr u8 i32_trunc_f32_u = 0xA9;
	constexpr u8 i32_trunc_f64_s = 0xAA;
	constexpr u8 i32_trunc_f64_u = 0xAB;
	constexpr u8 i64_extend_i32_s = 0xAC;
	constexpr u8 i64_extend_i32_u = 0xAD;
	constexpr u8 f32_convert_i32_s = 0xB2;
	constexpr u8 f32_convert_i32_u = 0xB3;
	constexpr u8 f64_convert_i32_s = 0xB7;
	constexpr u8 f64_convert_i32_u = 0xB8;
	constexpr u8 f64_promote_f32   = 0xBB;
	constexpr u8 i32_reinterpret_f32 = 0xBC;
	constexpr u8 i64_reinterpret_f64 = 0xBD;
	constexpr u8 f32_demote_f64    = 0xB6;
	constexpr u8 f32_reinterpret_i32 = 0xBE;
	constexpr u8 f64_reinterpret_i64 = 0xBF;

	// Saturating truncation prefix + sub-opcodes (Wasm 2.0 / non-trapping
	// float-to-int proposal, in core spec since 2019). Encoded as
	// 0xFC <leb128 subop>. Saturating semantics: NaN → 0, ±INF →
	// INT_MIN/INT_MAX, oob finite → INT_MIN/INT_MAX.
	constexpr u8 prefix_FC                  = 0xFC;
	constexpr u8 sub_i32_trunc_sat_f32_s    = 0x00;
	constexpr u8 sub_i32_trunc_sat_f32_u    = 0x01;
	constexpr u8 sub_i32_trunc_sat_f64_s    = 0x02;
	constexpr u8 sub_i32_trunc_sat_f64_u    = 0x03;
	constexpr u8 sub_i64_trunc_sat_f32_s    = 0x04;
	constexpr u8 sub_i64_trunc_sat_f32_u    = 0x05;
	constexpr u8 sub_i64_trunc_sat_f64_s    = 0x06;
	constexpr u8 sub_i64_trunc_sat_f64_u    = 0x07;
	// Bulk-memory ops (also 0xFC prefix). memory.fill takes a memory index
	// immediate (LEB128, 0 for the single imported memory).
	constexpr u8 sub_memory_fill            = 0x0B;
}

class WasmModuleBuilder {
public:
	// --- Low-level encoding ---

	void emitByte(u8 b) { bytes.push_back(b); }

	void emitU32LE(u32 v) {
		bytes.push_back(v & 0xFF);
		bytes.push_back((v >> 8) & 0xFF);
		bytes.push_back((v >> 16) & 0xFF);
		bytes.push_back((v >> 24) & 0xFF);
	}

	void emitLEB128(u32 v) {
		do {
			u8 b = v & 0x7F;
			v >>= 7;
			if (v != 0) b |= 0x80;
			bytes.push_back(b);
		} while (v != 0);
	}

	void emitSignedLEB128(s32 v) {
		bool more = true;
		while (more) {
			u8 b = v & 0x7F;
			v >>= 7;
			if ((v == 0 && (b & 0x40) == 0) || (v == -1 && (b & 0x40) != 0))
				more = false;
			else
				b |= 0x80;
			bytes.push_back(b);
		}
	}

	void emitBytes(const void* data, size_t len) {
		const u8* p = (const u8*)data;
		bytes.insert(bytes.end(), p, p + len);
	}

	void emitName(const char* name) {
		u32 len = (u32)strlen(name);
		emitLEB128(len);
		emitBytes(name, len);
	}

	// --- Section management ---

	void beginSection(u8 sectionId) {
		emitByte(sectionId);
		sectionSizePos = (u32)bytes.size();
		// Placeholder for section size (5 bytes max LEB128 for u32)
		bytes.push_back(0); bytes.push_back(0); bytes.push_back(0);
		bytes.push_back(0); bytes.push_back(0);
		sectionContentStart = (u32)bytes.size();
	}

	void endSection() {
		u32 contentSize = (u32)bytes.size() - sectionContentStart;
		// Patch the 5-byte LEB128 size at sectionSizePos
		patchLEB128_5(sectionSizePos, contentSize);
	}

	// --- Module header ---

	void emitHeader() {
		// Magic: \0asm
		emitByte(0x00); emitByte(0x61); emitByte(0x73); emitByte(0x6D);
		// Version: 1
		emitByte(0x01); emitByte(0x00); emitByte(0x00); emitByte(0x00);
	}

	// --- Type section ---

	void emitTypeSection(u32 count) {
		beginSection(WASM_SEC_TYPE);
		emitLEB128(count);
	}

	void emitFuncType(const u8* params, u32 paramCount, const u8* results, u32 resultCount) {
		emitByte(WASM_TYPE_FUNC);
		emitLEB128(paramCount);
		for (u32 i = 0; i < paramCount; i++) emitByte(params[i]);
		emitLEB128(resultCount);
		for (u32 i = 0; i < resultCount; i++) emitByte(results[i]);
	}

	// --- Import section ---

	void emitImportSection(u32 count) {
		beginSection(WASM_SEC_IMPORT);
		emitLEB128(count);
	}

	void emitImportMemory(const char* module, const char* name, u32 initialPages, u32 maxPages = 65536) {
		emitName(module);
		emitName(name);
		emitByte(WASM_IMPORT_MEMORY);
		// limits flags: 0x03 = shared memory + has max. Required when the
		// host module uses -pthread / SharedArrayBuffer (shared flag must
		// match exactly between import and host memory). Shared memory also
		// requires a max to be specified.
		emitByte(0x03);
		emitLEB128(initialPages);
		emitLEB128(maxPages);
	}

	void emitImportFunc(const char* module, const char* name, u32 typeIdx) {
		emitName(module);
		emitName(name);
		emitByte(WASM_IMPORT_FUNC);
		emitLEB128(typeIdx);
	}

	// Import a function table (typically Emscripten's
	// `__indirect_function_table`) so emitted call_indirect ops can target
	// the host's shared table. Must be called between emitImportSection's
	// count and endSection. limits flags 0x00 = no max, 0x01 = has max.
	void emitImportTable(const char* module, const char* name,
	                     u32 initialSize, bool hasMax = false, u32 maxSize = 0) {
		emitName(module);
		emitName(name);
		emitByte(WASM_IMPORT_TABLE);
		emitByte(WASM_REF_FUNCREF);
		emitByte(hasMax ? 0x01 : 0x00);
		emitLEB128(initialSize);
		if (hasMax) emitLEB128(maxSize);
	}

	// --- Function section ---

	void emitFunctionSection(u32 count, const u32* typeIndices) {
		beginSection(WASM_SEC_FUNCTION);
		emitLEB128(count);
		for (u32 i = 0; i < count; i++) emitLEB128(typeIndices[i]);
		endSection();
	}

	// --- Export section (single-export, kept for the original
	// single-function build_block path) ---

	void emitExportSection(const char* name, u32 funcIdx) {
		beginSection(WASM_SEC_EXPORT);
		emitLEB128(1); // 1 export
		emitName(name);
		emitByte(WASM_EXPORT_FUNC);
		emitLEB128(funcIdx);
		endSection();
	}

	// --- Multi-export section (multi-function modules) ---
	//
	// Use:
	//   beginExportSection(N);
	//   emitExport("name1", WASM_EXPORT_FUNC,  funcIdx1);
	//   emitExport("name2", WASM_EXPORT_TABLE, tableIdx);
	//   ...
	//   endSection();   // existing endSection() works
	void beginExportSection(u32 count) {
		beginSection(WASM_SEC_EXPORT);
		emitLEB128(count);
	}

	void emitExport(const char* name, u8 kind, u32 idx) {
		emitName(name);
		emitByte(kind);
		emitLEB128(idx);
	}

	// --- Table section (declares tables defined IN this module — the
	// foundation for V8 speculative inlining, since call_indirect through
	// an internally-declared table doesn't trip the cross-instance check.
	// See kcGCresearch_gaps Gap 1 for the rationale.) ---
	void beginTableSection(u32 count) {
		beginSection(WASM_SEC_TABLE);
		emitLEB128(count);
	}

	// Encodes one table entry: elem_type then limits.
	// limits flags: 0x00 = no max, 0x01 = has max.
	void emitTable(u32 initialSize, bool hasMax = true,
	               u32 maxSize = 0, u8 elemType = WASM_REF_FUNCREF) {
		emitByte(elemType);
		emitByte(hasMax ? 0x01 : 0x00);
		emitLEB128(initialSize);
		if (hasMax) emitLEB128(maxSize);
	}

	// --- Global section ---
	//   beginGlobalSection(N);
	//   emitGlobalI32Mut(initialValue);   // repeat N times
	//   endSection();
	// Section order: type, import, function, table, memory, global, export.
	// emitGlobalI32Mut emits one global descriptor: mut i32 = init_value.
	void beginGlobalSection(u32 count) {
		beginSection(WASM_SEC_GLOBAL);
		emitLEB128(count);
	}
	void emitGlobalI32Mut(s32 init_value) {
		emitByte(WASM_TYPE_I32);
		emitByte(0x01);                         // mutable
		emitByte(wop::i32_const);
		emitSignedLEB128(init_value);
		emitByte(wop::end);
	}

	// --- Element section (populates a table at instantiation time).
	// We use the simplest form: an "active" segment with a constant
	// i32.const offset and a sequence of function indices.
	void beginElementSection(u32 count) {
		beginSection(WASM_SEC_ELEMENT);
		emitLEB128(count);
	}

	// Active segment for table 0 (default), populating slots
	// [offset, offset+funcIndices.size()) with the given functions.
	// Encoding (per WASM 2.0 element-segment forms):
	//   flags = 0x00 (active, table 0, expr-offset, vec(funcidx))
	//   offset_expr = i32.const N end
	//   vec(funcidx) = LEB(N) then N LEB-encoded indices
	void emitActiveElementSegment(u32 offset, const u32* funcIndices, u32 n) {
		emitByte(0x00);                         // flags: active, table 0
		emitByte(wop::i32_const); emitSignedLEB128((s32)offset);
		emitByte(wop::end);
		emitLEB128(n);
		for (u32 i = 0; i < n; ++i) emitLEB128(funcIndices[i]);
	}

	// --- Data count section (id 12) ---
	//
	// Required by the bulk-memory proposal whenever a code section uses
	// memory.fill / memory.copy / data.drop. Declares the number of data
	// segments the module contains; emitted between exports/start and code
	// per the section-ordering rules. Pass 0 when the module has no
	// data segments (the common case for JIT'd guest blocks).
	void emitDataCountSection(u32 dataSegmentCount) {
		beginSection(WASM_SEC_DATA_COUNT);
		emitLEB128(dataSegmentCount);
		endSection();
	}

	// --- Code section ---

	void beginCodeSection(u32 funcCount) {
		beginSection(WASM_SEC_CODE);
		emitLEB128(funcCount);
	}

	void beginFuncBody() {
		funcBodySizePos = (u32)bytes.size();
		// Placeholder for body size (5 bytes)
		bytes.push_back(0); bytes.push_back(0); bytes.push_back(0);
		bytes.push_back(0); bytes.push_back(0);
		funcBodyStart = (u32)bytes.size();
		m_branch_hints.clear();   // [PM59 branch hints] per-body offsets
	}

	void emitLocals(u32 groupCount, const u32* counts, const u8* types) {
		emitLEB128(groupCount);
		for (u32 i = 0; i < groupCount; i++) {
			emitLEB128(counts[i]);
			emitByte(types[i]);
		}
	}

	void endFuncBody() {
		emitByte(wop::end); // function end
		u32 bodySize = (u32)bytes.size() - funcBodyStart;
		patchLEB128_5(funcBodySizePos, bodySize);
	}

	// --- WASM instructions ---

	void op_local_get(u32 idx) { emitByte(wop::local_get); emitLEB128(idx); }
	void op_local_set(u32 idx) { emitByte(wop::local_set); emitLEB128(idx); }
	void op_global_get(u32 idx) { emitByte(wop::global_get); emitLEB128(idx); }
	void op_global_set(u32 idx) { emitByte(wop::global_set); emitLEB128(idx); }
	void op_local_tee(u32 idx) { emitByte(wop::local_tee); emitLEB128(idx); }

	void op_i32_const(s32 val) { emitByte(wop::i32_const); emitSignedLEB128(val); }
	void op_f32_const(float val) {
		emitByte(wop::f32_const);
		u32 bits;
		memcpy(&bits, &val, 4);
		emitU32LE(bits);
	}

	// Memory load/store (align=log2 of natural alignment)
	void op_i32_load(u32 offset, u32 align = 2) {
		emitByte(wop::i32_load); emitLEB128(align); emitLEB128(offset);
	}
	void op_i32_load8_s(u32 offset) {
		emitByte(wop::i32_load8_s); emitLEB128(0); emitLEB128(offset);
	}
	void op_i32_load8_u(u32 offset) {
		emitByte(wop::i32_load8_u); emitLEB128(0); emitLEB128(offset);
	}
	void op_i32_load16_s(u32 offset) {
		emitByte(wop::i32_load16_s); emitLEB128(1); emitLEB128(offset);
	}
	void op_i32_load16_u(u32 offset) {
		emitByte(wop::i32_load16_u); emitLEB128(1); emitLEB128(offset);
	}
	void op_i32_store(u32 offset, u32 align = 2) {
		emitByte(wop::i32_store); emitLEB128(align); emitLEB128(offset);
	}
	void op_i32_store8(u32 offset) {
		emitByte(wop::i32_store8); emitLEB128(0); emitLEB128(offset);
	}
	void op_i32_store16(u32 offset) {
		emitByte(wop::i32_store16); emitLEB128(1); emitLEB128(offset);
	}
	void op_f32_load(u32 offset, u32 align = 2) {
		emitByte(wop::f32_load); emitLEB128(align); emitLEB128(offset);
	}
	void op_f32_store(u32 offset, u32 align = 2) {
		emitByte(wop::f32_store); emitLEB128(align); emitLEB128(offset);
	}
	void op_f64_load(u32 offset, u32 align = 3) {
		emitByte(wop::f64_load); emitLEB128(align); emitLEB128(offset);
	}
	void op_f64_store(u32 offset, u32 align = 3) {
		emitByte(wop::f64_store); emitLEB128(align); emitLEB128(offset);
	}
	void op_i64_load(u32 offset, u32 align = 3) {
		emitByte(wop::i64_load); emitLEB128(align); emitLEB128(offset);
	}
	void op_i64_store(u32 offset, u32 align = 3) {
		emitByte(wop::i64_store); emitLEB128(align); emitLEB128(offset);
	}
	void op_f64_const(double val) {
		emitByte(wop::f64_const);
		u64 bits;
		memcpy(&bits, &val, 8);
		for (int i = 0; i < 8; i++) bytes.push_back((bits >> (i * 8)) & 0xFF);
	}

	// Arithmetic / logic
	void op_i32_add()   { emitByte(wop::i32_add); }
	void op_i32_sub()   { emitByte(wop::i32_sub); }
	void op_i32_mul()   { emitByte(wop::i32_mul); }
	void op_i32_div_s() { emitByte(wop::i32_div_s); }
	void op_i32_div_u() { emitByte(wop::i32_div_u); }
	void op_i32_rem_s() { emitByte(wop::i32_rem_s); }
	void op_i32_rem_u() { emitByte(wop::i32_rem_u); }
	void op_i32_and()   { emitByte(wop::i32_and); }
	void op_i32_or()    { emitByte(wop::i32_or); }
	void op_i32_xor()   { emitByte(wop::i32_xor); }
	void op_i32_shl()   { emitByte(wop::i32_shl); }
	void op_i32_shr_s() { emitByte(wop::i32_shr_s); }
	void op_i32_shr_u() { emitByte(wop::i32_shr_u); }
	void op_i32_rotl()  { emitByte(wop::i32_rotl); }
	void op_i32_rotr()  { emitByte(wop::i32_rotr); }
	void op_i32_clz()   { emitByte(wop::i32_clz); }

	// Comparison
	void op_i32_eqz()   { emitByte(wop::i32_eqz); }
	void op_i32_eq()    { emitByte(wop::i32_eq); }
	void op_i32_ne()    { emitByte(wop::i32_ne); }
	void op_i32_lt_s()  { emitByte(wop::i32_lt_s); }
	void op_i32_lt_u()  { emitByte(wop::i32_lt_u); }
	void op_i32_gt_s()  { emitByte(wop::i32_gt_s); }
	void op_i32_gt_u()  { emitByte(wop::i32_gt_u); }
	void op_i32_le_s()  { emitByte(wop::i32_le_s); }
	void op_i32_le_u()  { emitByte(wop::i32_le_u); }
	void op_i32_ge_s()  { emitByte(wop::i32_ge_s); }
	void op_i32_ge_u()  { emitByte(wop::i32_ge_u); }

	// Float ops
	void op_f32_add()   { emitByte(wop::f32_add); }
	void op_f32_sub()   { emitByte(wop::f32_sub); }
	void op_f32_mul()   { emitByte(wop::f32_mul); }
	void op_f32_div()   { emitByte(wop::f32_div); }
	void op_f32_abs()   { emitByte(wop::f32_abs); }
	void op_f32_neg()   { emitByte(wop::f32_neg); }
	void op_f32_sqrt()  { emitByte(wop::f32_sqrt); }
	void op_f32_eq()    { emitByte(wop::f32_eq); }
	void op_f32_gt()    { emitByte(wop::f32_gt); }

	// i64 arithmetic
	void op_i64_add()   { emitByte(wop::i64_add); }
	void op_i64_sub()   { emitByte(wop::i64_sub); }
	void op_i64_mul()   { emitByte(wop::i64_mul); }
	void op_i64_and()   { emitByte(wop::i64_and); }
	void op_i64_or()    { emitByte(wop::i64_or); }
	void op_i64_xor()   { emitByte(wop::i64_xor); }
	void op_i64_shl()   { emitByte(wop::i64_shl); }
	void op_i64_shr_s() { emitByte(wop::i64_shr_s); }
	void op_i64_shr_u() { emitByte(wop::i64_shr_u); }
	void op_i64_clz()   { emitByte(wop::i64_clz); }
	void op_i64_eqz()   { emitByte(wop::i64_eqz); }
	void op_i64_lt_u()  { emitByte(wop::i64_lt_u); }
	void op_i64_const(s64 val) {
		emitByte(wop::i64_const);
		// signed LEB128 for i64
		bool more = true;
		while (more) {
			u8 b = val & 0x7F;
			val >>= 7;
			if ((val == 0 && (b & 0x40) == 0) || (val == -1 && (b & 0x40) != 0))
				more = false;
			else
				b |= 0x80;
			bytes.push_back(b);
		}
	}

	// i64 conversions
	void op_i32_wrap_i64()       { emitByte(wop::i32_wrap_i64); }
	void op_i64_extend_i32_s()   { emitByte(wop::i64_extend_i32_s); }
	void op_i64_extend_i32_u()   { emitByte(wop::i64_extend_i32_u); }

	// Double (f64) ops
	void op_f64_add()            { emitByte(wop::f64_add); }
	void op_f64_sub()            { emitByte(wop::f64_sub); }
	void op_f64_mul()            { emitByte(wop::f64_mul); }
	void op_f64_div()            { emitByte(wop::f64_div); }
	void op_f64_abs()            { emitByte(wop::f64_abs); }
	void op_f64_min()            { emitByte(wop::f64_min); }
	void op_f64_max()            { emitByte(wop::f64_max); }
	void op_f64_neg()            { emitByte(wop::f64_neg); }
	void op_f64_sqrt()           { emitByte(wop::f64_sqrt); }
	void op_f64_trunc()          { emitByte(wop::f64_trunc); }
	void op_f64_nearest()        { emitByte(wop::f64_nearest); }
	void op_f64_floor()          { emitByte(wop::f64_floor); }
	void op_f64_ceil()           { emitByte(wop::f64_ceil); }
	void op_f64_eq()             { emitByte(wop::f64_eq); }
	void op_f64_ne()             { emitByte(wop::f64_ne); }
	void op_f64_lt()             { emitByte(wop::f64_lt); }
	void op_f64_gt()             { emitByte(wop::f64_gt); }
	void op_f64_le()             { emitByte(wop::f64_le); }
	void op_f64_ge()             { emitByte(wop::f64_ge); }
	void op_f64_promote_f32()    { emitByte(wop::f64_promote_f32); }
	void op_f32_demote_f64()     { emitByte(wop::f32_demote_f64); }

	// ---- v128 fixed-width SIMD (0xFD prefix + LEB128 subopcode) ----
	// Paired-single fast path: a single-typed FPR is held as f32x2 in v128
	// lanes 0-1. Only the subset the paired emitters need. Subopcodes per the
	// WebAssembly SIMD spec (values >127 LEB128-encode to 2 bytes).
	static constexpr u8 V128_PREFIX = 0xFD;
	void op_v128_load(u32 off, u32 align = 4)  { emitByte(V128_PREFIX); emitLEB128(0x00u); emitLEB128(align); emitLEB128(off); }        // v128.load
	void op_v128_load64_zero(u32 off, u32 align = 3) { emitByte(V128_PREFIX); emitLEB128(0x5Du); emitLEB128(align); emitLEB128(off); } // v128.load64_zero
	void op_v128_store(u32 off, u32 align = 4) { emitByte(V128_PREFIX); emitLEB128(0x0Bu); emitLEB128(align); emitLEB128(off); }        // v128.store
	void op_v128_store64_lane(u32 off, u8 lane, u32 align = 3) { emitByte(V128_PREFIX); emitLEB128(0x5Bu); emitLEB128(align); emitLEB128(off); emitByte(lane); } // v128.store64_lane
	void op_f32x4_splat()        { emitByte(V128_PREFIX); emitLEB128(0x13u); }   // f32x4.splat (f32 -> v128)
	void op_f64x2_splat()        { emitByte(V128_PREFIX); emitLEB128(0x14u); }   // f64x2.splat
	void op_f32x4_extract_lane(u8 l) { emitByte(V128_PREFIX); emitLEB128(0x1Fu); emitByte(l); }  // -> f32
	void op_f32x4_replace_lane(u8 l) { emitByte(V128_PREFIX); emitLEB128(0x20u); emitByte(l); }  // (v128,f32) -> v128
	void op_i32x4_extract_lane(u8 l) { emitByte(V128_PREFIX); emitLEB128(0x1Bu); emitByte(l); }  // -> i32
	void op_i32x4_replace_lane(u8 l) { emitByte(V128_PREFIX); emitLEB128(0x1Cu); emitByte(l); }  // (v128,i32) -> v128
	void op_f64x2_extract_lane(u8 l) { emitByte(V128_PREFIX); emitLEB128(0x21u); emitByte(l); }  // -> f64
	void op_f64x2_replace_lane(u8 l) { emitByte(V128_PREFIX); emitLEB128(0x22u); emitByte(l); }  // (v128,f64) -> v128
	void op_v128_and()           { emitByte(V128_PREFIX); emitLEB128(0x4Eu); }
	void op_v128_or()            { emitByte(V128_PREFIX); emitLEB128(0x50u); }
	void op_v128_xor()           { emitByte(V128_PREFIX); emitLEB128(0x51u); }
	// (v1,v2,c) -> (v1 & c) | (v2 & ~c). Opcode bytes verified vs wat2wasm.
	void op_v128_bitselect()     { emitByte(V128_PREFIX); emitLEB128(0x52u); }
	void op_i32x4_lt_u()         { emitByte(V128_PREFIX); emitLEB128(0x3Au); }
	// v128.const with all four i32 lanes equal (the only form the paired
	// emitters need). 16 literal bytes, each lane LE.
	void op_v128_const_i32_splat(u32 v) {
		emitByte(V128_PREFIX); emitLEB128(0x0Cu);
		for (int lane = 0; lane < 4; ++lane)
			for (int b = 0; b < 4; ++b) emitByte((u8)((v >> (8 * b)) & 0xFFu));
	}
	void op_i8x16_shuffle(const u8 lanes[16]) { emitByte(V128_PREFIX); emitLEB128(0x0Du); for (int i = 0; i < 16; ++i) emitByte(lanes[i]); }
	void op_f32x4_abs()          { emitByte(V128_PREFIX); emitLEB128(0xE0u); }
	void op_f32x4_neg()          { emitByte(V128_PREFIX); emitLEB128(0xE1u); }
	void op_f32x4_add()          { emitByte(V128_PREFIX); emitLEB128(0xE4u); }
	void op_f32x4_sub()          { emitByte(V128_PREFIX); emitLEB128(0xE5u); }
	void op_f32x4_mul()          { emitByte(V128_PREFIX); emitLEB128(0xE6u); }
	void op_f32x4_div()          { emitByte(V128_PREFIX); emitLEB128(0xE7u); }
	void op_f64x2_promote_low_f32x4() { emitByte(V128_PREFIX); emitLEB128(0x5Fu); }  // low 2 f32 -> f64x2
	void op_f32x4_demote_f64x2_zero() { emitByte(V128_PREFIX); emitLEB128(0x5Eu); }  // f64x2 -> low 2 f32
	// relaxed-SIMD fused multiply-add: (a,b,c) -> a*b+c, fused on FMA hardware
	// (matches native JitArm64's f32 FMLA on its singles path). Subopcodes 261/262.
	void op_f32x4_relaxed_madd()  { emitByte(V128_PREFIX); emitLEB128(261u); }  // a*b+c
	void op_f32x4_relaxed_nmadd() { emitByte(V128_PREFIX); emitLEB128(262u); }  // -(a*b)+c

	// Conversions
	void op_i32_trunc_f32_s()    { emitByte(wop::i32_trunc_f32_s); }
	void op_i32_trunc_f32_u()    { emitByte(wop::i32_trunc_f32_u); }
	void op_i32_trunc_f64_s()    { emitByte(wop::i32_trunc_f64_s); }
	void op_i32_trunc_f64_u()    { emitByte(wop::i32_trunc_f64_u); }

	// Saturating (non-trapping) variants. NaN → 0, oob → INT_MIN/MAX.
	void op_i32_trunc_sat_f32_s() { emitByte(wop::prefix_FC); emitLEB128(wop::sub_i32_trunc_sat_f32_s); }
	void op_i32_trunc_sat_f32_u() { emitByte(wop::prefix_FC); emitLEB128(wop::sub_i32_trunc_sat_f32_u); }
	void op_i32_trunc_sat_f64_s() { emitByte(wop::prefix_FC); emitLEB128(wop::sub_i32_trunc_sat_f64_s); }
	void op_i32_trunc_sat_f64_u() { emitByte(wop::prefix_FC); emitLEB128(wop::sub_i32_trunc_sat_f64_u); }

	// memory.fill: stack (dest:i32, byte:i32, len:i32) -> (). Fills `len`
	// bytes at `dest` with the low 8 bits of `byte`. Traps if (dest+len)
	// exceeds the memory size. Requires a data-count section (see
	// emitDataCountSection below) per the bulk-memory spec.
	void op_memory_fill() {
		emitByte(wop::prefix_FC);
		emitLEB128(wop::sub_memory_fill);
		emitByte(0x00);              // memory index (single imported memory)
	}
	void op_f32_convert_i32_s()  { emitByte(wop::f32_convert_i32_s); }
	void op_f32_convert_i32_u()  { emitByte(wop::f32_convert_i32_u); }
	void op_f64_convert_i32_s()  { emitByte(wop::f64_convert_i32_s); }
	void op_f64_convert_i32_u()  { emitByte(wop::f64_convert_i32_u); }
	void op_i32_reinterpret_f32() { emitByte(wop::i32_reinterpret_f32); }
	void op_i64_reinterpret_f64() { emitByte(wop::i64_reinterpret_f64); }
	void op_f32_reinterpret_i32() { emitByte(wop::f32_reinterpret_i32); }
	void op_f64_reinterpret_i64() { emitByte(wop::f64_reinterpret_i64); }

	// Control flow
	void op_call(u32 funcIdx) { emitByte(wop::call); emitLEB128(funcIdx); }
	// Indirect call through a table. typeIdx is the function-type index in
	// the type section; tableIdx is the table import index (0 if there's
	// only one imported/declared table). The runtime asserts the called
	// function's signature matches `typeIdx`; mismatch traps.
	void op_call_indirect(u32 typeIdx, u32 tableIdx = 0) {
		emitByte(0x11);            // call_indirect
		emitLEB128(typeIdx);
		emitLEB128(tableIdx);
	}
	// Tail-call counterparts (WASM tail-call proposal — V8 ships this since
	// 11.2). Stack doesn't grow; caller's frame is replaced.
	void op_return_call(u32 funcIdx) {
		emitByte(0x12);            // return_call
		emitLEB128(funcIdx);
	}
	void op_return_call_indirect(u32 typeIdx, u32 tableIdx = 0) {
		emitByte(0x13);            // return_call_indirect
		emitLEB128(typeIdx);
		emitLEB128(tableIdx);
	}
	void op_return()     { emitByte(wop::return_); }
	void op_drop()       { emitByte(wop::drop); }
	void op_select()     { emitByte(wop::select); }
	void op_unreachable() { emitByte(wop::unreachable); }

	// [region-resident 2026-07-15] Control-nesting depth tracker: op_if/op_block/
	// op_loop push, op_end pops (op_else stays — same construct). Lets the merged-
	// region edge emitter compute a correct `br` immediate back to the region loop
	// from ANY nesting inside a spliced body (br imm = ctrlDepth() + the body's
	// splice offset) — the powerpc-next answer to gekko's hand-threaded
	// local_block_depth wrappers. Depth is builder-relative (0 at construction);
	// endFuncBody's function terminator is emitted directly, not via op_end, so
	// the counter stays balanced across bodies.
	void op_if(u8 blockType = 0x40) { emitByte(wop::if_); emitByte(blockType); ++m_ctrl_depth; }
	// [PM59 branch hints] Emit an `if` whose bias is recorded for the WebAssembly
	// branch-hinting custom section (metadata.code.branch_hint). `likely`=1 means
	// the THEN arm (fall-through into the if-body) is the hot path; `likely`=0 =
	// cold. The offset recorded is the position of the `if` opcode relative to the
	// function-body start (proposal semantics). Recording is a pure no-op on the
	// emitted bytes — the hints only matter when a caller emits the custom section
	// from branchHints(); until then this is identical to op_if.
	struct BranchHint { u32 offset; u8 likely; };
	void op_if_hinted(u8 likely, u8 blockType = 0x40) {
		m_branch_hints.push_back({ (u32)bytes.size() - funcBodyStart, likely });
		op_if(blockType);
	}
	const std::vector<BranchHint>& branchHints() const { return m_branch_hints; }
	void op_else()       { emitByte(wop::else_); }
	void op_end()        { emitByte(wop::end); if (m_ctrl_depth) --m_ctrl_depth; }
	void op_block(u8 blockType = 0x40) { emitByte(wop::block); emitByte(blockType); ++m_ctrl_depth; }
	void op_loop(u8 blockType = 0x40) { emitByte(wop::loop_); emitByte(blockType); ++m_ctrl_depth; }
	u32 ctrlDepth() const { return m_ctrl_depth; }
	void op_br(u32 depth) { emitByte(wop::br); emitLEB128(depth); }
	void op_br_if(u32 depth) { emitByte(wop::br_if); emitLEB128(depth); }
	// br_table: branch to one of the labels indexed by the i32 on stack.
	// Encoding: 0x0E + LEB128(N) + N×LEB128(label) + LEB128(default).
	// `labels` is the per-arm label depth list of length n_labels;
	// `default_label` is taken when the i32 index is >= n_labels.
	void op_br_table(const u32* labels, u32 n_labels, u32 default_label) {
		emitByte(wop::br_table);
		emitLEB128(n_labels);
		for (u32 i = 0; i < n_labels; ++i) emitLEB128(labels[i]);
		emitLEB128(default_label);
	}

	// --- Output ---

	const std::vector<u8>& getBytes() const { return bytes; }
	size_t size() const { return bytes.size(); }

private:
	std::vector<u8> bytes;
	u32 sectionSizePos = 0;
	u32 sectionContentStart = 0;
	u32 funcBodySizePos = 0;
	u32 funcBodyStart = 0;
	u32 m_ctrl_depth = 0;   // [region-resident] control-nesting depth (see op_block)
	// [PM59 branch hints] per-func-body (offset-from-body-start, likely) records,
	// populated by op_if_hinted, cleared at beginFuncBody. Consumed by the module
	// assembler to emit the metadata.code.branch_hint custom section.
	std::vector<BranchHint> m_branch_hints;

	// Write a u32 as a 5-byte fixed-length LEB128 at a specific position
	void patchLEB128_5(u32 pos, u32 value) {
		bytes[pos + 0] = (value & 0x7F) | 0x80;
		bytes[pos + 1] = ((value >> 7) & 0x7F) | 0x80;
		bytes[pos + 2] = ((value >> 14) & 0x7F) | 0x80;
		bytes[pos + 3] = ((value >> 21) & 0x7F) | 0x80;
		bytes[pos + 4] = (value >> 28) & 0x0F;
	}
};

#pragma once
//
// RCMode + RCOpArg + RCWasmLocal — Bind-site primitives used by the per-op
// emitters (jit_integer.cpp, jit_load_store.cpp, ...) to talk to RegCache.
// Adapted from Dolphin Jit64's RCMode.h + JitRegCache.h. The big shape
// change: backing storage is fixed WASM locals (one per live PPC GPR over
// the block) instead of a finite x86 host-register pool. Lock/unlock has
// no host-pool implications for WASM but is kept for API symmetry — future
// cross-block local-reuse optimizations can re-engage it.

#include "bementalJIT/types.h"

namespace bemental::powerpc {

class RegCache;

enum class RCMode {
    Read,       // value will be read; bind to current local
    Write,      // value will be written; invalidates immediates and prior reads
    ReadWrite,  // both — common for RA-update / accumulator-style ops
};

// RAII handle returned by RegCache::Bind. Destructor releases the binding
// lock. Move-only. is_valid()==false after move-from or default-construct.
class RCWasmLocal {
public:
    constexpr RCWasmLocal() = default;
    RCWasmLocal(RegCache* rc, u32 local_idx, u32 preg, RCMode mode)
        : m_rc(rc), m_local_idx(local_idx), m_preg(preg), m_mode(mode) {}
    ~RCWasmLocal();

    RCWasmLocal(const RCWasmLocal&) = delete;
    RCWasmLocal& operator=(const RCWasmLocal&) = delete;

    RCWasmLocal(RCWasmLocal&& other) noexcept
        : m_rc(other.m_rc), m_local_idx(other.m_local_idx),
          m_preg(other.m_preg), m_mode(other.m_mode) {
        other.m_rc = nullptr;
    }
    RCWasmLocal& operator=(RCWasmLocal&& other) noexcept {
        if (this != &other) {
            release();
            m_rc        = other.m_rc;
            m_local_idx = other.m_local_idx;
            m_preg      = other.m_preg;
            m_mode      = other.m_mode;
            other.m_rc  = nullptr;
        }
        return *this;
    }

    constexpr u32  local_idx() const { return m_local_idx; }
    constexpr u32  preg()      const { return m_preg; }
    constexpr bool is_valid()  const { return m_rc != nullptr; }

private:
    void release();
    RegCache* m_rc        = nullptr;
    u32       m_local_idx = 0;
    u32       m_preg      = 0;
    RCMode    m_mode      = RCMode::Read;
};

// BindOrImm returns either a known-constant immediate or a WASM local.
// The emit site uses is_imm() to fold immediates inline (skipping local_get).
struct RCOpArg {
    enum class Kind { Imm32, Local };
    Kind kind = Kind::Local;
    u32  value = 0;  // imm value when Kind::Imm32, local index when Kind::Local

    constexpr bool is_imm()   const { return kind == Kind::Imm32; }
    constexpr bool is_local() const { return kind == Kind::Local; }
    constexpr u32  imm()      const { return value; }
    constexpr u32  local()    const { return value; }

    static constexpr RCOpArg Imm(u32 v)   { return {Kind::Imm32, v}; }
    static constexpr RCOpArg Local(u32 i) { return {Kind::Local, i}; }
};

}  // namespace bemental::powerpc

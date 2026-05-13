#pragma once

// bementalJIT — guest-agnostic WASM JIT builder.
// Single-include umbrella. Per-guest emitters live under guests/<arch>/
// and are linked separately as their own static libraries.

#include "bementalJIT/types.h"
#include "bementalJIT/wasm_module_builder.h"
#include "bementalJIT/block_cache.h"

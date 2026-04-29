#pragma once

// bementalCompiler — guest-agnostic WASM JIT builder.
// Single-include umbrella. Per-guest emitters live under guests/<arch>/
// and are linked separately as their own static libraries.

#include "bementalCompiler/types.h"
#include "bementalCompiler/wasm_module_builder.h"
#include "bementalCompiler/block_cache.h"

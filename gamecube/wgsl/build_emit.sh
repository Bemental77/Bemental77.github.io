#!/usr/bin/env bash
# build_emit.sh
#
# Builds gamecube/wgsl/emit_shader, the native harness that drives Dolphin's
# REAL ubershader GLSL generators (UberShader::GenPixelShader /
# GenVertexShader) and dumps the raw generator buffer (no #version/macro
# preamble) to gamecube/wgsl/dolphin_gen.{frag,vert}.glsl. Used as a WebGPU
# go/no-go gate.
#
# IMPORTANT toolchain note:
#   Apple clang 12 (the system /usr/bin/clang++) CANNOT build this -- Dolphin
#   uses C++20/23 (requires-clauses, std::bit_cast, std::to_underlying,
#   std::type_identity_t) that Apple clang 12's libc++ lacks. We use the
#   Homebrew LLVM clang (clang 22) targeting native x86_64-apple-darwin, with
#   -std=c++23 (Dolphin reads std::to_underlying, a C++23 lib feature, even
#   though its CMake nominally asks for c++20; clang 22's libc++ only exposes it
#   under c++23).
#
# Run from the repo root: bash gamecube/wgsl/build_emit.sh

set -euo pipefail

cd "$(dirname "$0")/../.."   # repo root

CXX="/usr/local/opt/llvm/bin/clang++"   # Homebrew LLVM (clang 22), native x86_64
SDKROOT="$(xcrun --show-sdk-path)"

DOLPHIN="gamecube/dolphin-src"

"$CXX" -std=c++23 -DFMT_HEADER_ONLY=1 \
  -isysroot "$SDKROOT" \
  -I "$DOLPHIN/Source/Core" \
  -I "$DOLPHIN/Externals/fmt/fmt/include" \
  -I "$DOLPHIN/build-wasm/Source/Core" \
  gamecube/wgsl/emit_shader.cpp \
  gamecube/wgsl/stubs.cpp \
  "$DOLPHIN/Source/Core/VideoCommon/UberShaderPixel.cpp" \
  "$DOLPHIN/Source/Core/VideoCommon/UberShaderVertex.cpp" \
  "$DOLPHIN/Source/Core/VideoCommon/UberShaderCommon.cpp" \
  "$DOLPHIN/Source/Core/VideoCommon/ShaderGenCommon.cpp" \
  "$DOLPHIN/Source/Core/VideoCommon/PixelShaderGen.cpp" \
  "$DOLPHIN/Source/Core/VideoCommon/LightingShaderGen.cpp" \
  -o gamecube/wgsl/emit_shader

echo "[build_emit] built gamecube/wgsl/emit_shader"
echo "[build_emit] running..."
./gamecube/wgsl/emit_shader >/dev/null
echo "[build_emit] wrote:"
wc -c gamecube/wgsl/dolphin_gen_vk.frag.glsl gamecube/wgsl/dolphin_gen_vk.vert.glsl

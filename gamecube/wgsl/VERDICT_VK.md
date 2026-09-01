# Phase 1 WebGPU go/no-go gate — VULKAN / separate-descriptor path — RESULT

**VERDICT: GO (naga SUFFICIENT — we do NOT need to build Tint/Dawn).**

Both the REAL full Dolphin **fragment** ubershader and the REAL full **vertex**
ubershader, emitted via the **Vulkan** generator path, translate to WGSL through
**naga 29.0.3 alone**, and naga's WGSL validator passes on both — once three
**source-level (post-emit)** fixes are applied. None of the three needs a tool
beyond naga; none modifies `gamecube/dolphin-src`. Two of the three are
generator-side shapes that Dolphin's own GLSL would need to emit differently for
a clean naga path (recorded as to-dos below).

Tools (verified, not assumed): naga v29.0.3 at `/Users/caseybement/.cargo/bin/naga`;
`@webgpu/glslang@0.0.15` (node-devel, synchronous Emscripten factory); node v24.15.0;
Homebrew LLVM clang 22 (`-std=c++23`) to link the real generators.

## Per-stage chain results (final, both PASS)

| Shader   | GLSL chars | [1] glslang GLSL→Vulkan SPIR-V | [2] naga SPIR-V→WGSL | [3] naga WGSL validate |
|----------|-----------:|--------------------------------|----------------------|------------------------|
| FRAGMENT | 27,762 | **PASS** — 14,102 SPIR-V words | **PASS** — 71,422 WGSL chars | **PASS** — "Validation successful" |
| VERTEX   | 17,750 | **PASS** — 7,733 SPIR-V words  | **PASS** — 34,887 WGSL chars | **PASS** — "Validation successful" |

Driver: `node gamecube/wgsl/run_pipeline_vk.cjs` → final line
`VERDICT: GO (both real Dolphin ubershaders -> valid WGSL via Vulkan/separate-descriptor, zero naga errors)`.

## What "the Vulkan path" actually changed (and didn't)

Emitting via `APIType::Vulkan` (vs OpenGL) changes the generator output in exactly
two ways for this config:
1. **Vertex**: a Vulkan clip-space Y-flip — `gl_Position = float4(o.pos.x, -o.pos.y, o.pos.z, o.pos.w);`
   (OGL emits `gl_Position = o.pos;`). Verified by `diff dolphin_gen.vert.glsl dolphin_gen_vk.vert.glsl`.
2. **Preamble macros only** (`SAMPLER_BINDING` → `set=1,binding=x`, `UBO_BINDING` →
   `set=0,binding=(x-1)`, `SSBO_BINDING` → `set=2`, `API_VULKAN`, `gl_VertexID`→`gl_VertexIndex`).

**It did NOT make the fragment emit separate texture+sampler.** The fragment
generator buffer is byte-identical between OGL and Vulkan
(`diff dolphin_gen.frag.glsl dolphin_gen_vk.frag.glsl` = empty). Dolphin's
`WritePixelShaderCommonHeader` (PixelShaderGen.cpp:344) emits
`SAMPLER_BINDING(0) uniform sampler2DArray samp[8];` — a **COMBINED** image-sampler —
**unconditionally**, for the Vulkan path too. Dolphin's Vulkan backend keeps the
combined sampler in GLSL and relies on SPIRV-Cross/MoltenVK to split it
downstream. So the separate-descriptor split is something WE must do as a
source-level transform; it is not free from `APIType::Vulkan`.

## The three required transforms (all in `assemble_vk.cjs`, source-level only)

### (A) VERTEX — `isnan(f)` → `((f) != (f))`   [cosmetic, same as prior run]
Dolphin emits `#define dolphin_isnan(f) isnan(f)` (3 uses, texgen NaN guard).
naga 29's SPIR-V frontend rejects `OpIsNan`. Redefining the macro to `(f != f)`
clears it. This was already proven in the prior (OGL) run; reconfirmed here.

### (B) FRAGMENT — combined sampler → SEPARATE texture + sampler, **threaded by index not by resource**
The naïve split (declare `texture2DArray samp_tex[8]` + `sampler samp_smp[8]`,
reconstruct `sampler2DArray(tex,smp)` at the call) hit TWO sub-blockers, each
isolated with a 2-line control:

- **glslang:** `'call argument' : sampler constructor must appear at point of use`.
  Vulkan GLSL (GL_KHR_vulkan_glsl) forbids passing a constructed `sampler2DArray(tex,smp)`
  as a function argument — the combine must happen AT the `texture()` call.
- **naga:** `invalid global var Access { base: [N], index: [M] }`. Proven by
  `control_fnparam.cjs`: passing a **dynamically-indexed** separate texture/sampler
  array element (`samp_tex[idx]`) as a **function argument** through a helper is
  what naga rejects — NOT dynamic indexing itself (`control_dynidx.cjs` shows a
  dynamic index sampled inline translates+validates fine), and NOT the
  separate-descriptor split itself.

  **Fix (proven by `control_fix.cjs`):** don't pass the texture/sampler as an
  argument at all — pass the **index** (`uint texmap`) and index the global
  `binding_array`s **directly inside** the helper, so the resource `OpAccessChain`
  lives in the same function as `texture()` and traces to a direct global. Applied:
  `sampleTexture(uint texmap, int2 uv, int layer)` indexes `samp_tex[texmap]`/`samp_smp[texmap]`
  internally; the wrapper call drops the resource arg.

### (C) FRAGMENT — alpha-test `switch` (discard-in-else) → if/else-if chain
Dolphin's alpha test (UberShaderPixel.cpp:1031-1037, comment: "written weirdly to
work around intel and Qualcomm bugs") emits
`switch(op){ case 0u: if(a&&b) break; else discard; break; ... }`. glslang
structurizes the `if(...)break; else discard; break;` cases so a case block
falls through into the next case label; **naga rejects this:
`fall-through switch case block`**. Isolated by bisection (`control_fallthrough.cjs`
+ in-place neutralization): neutralizing THIS switch is exactly what flips naga
to PASS; the other fragment switches (TevCompareMode, fog, logic-op) are fine.
Replaced with a semantically-identical `if/else-if` chain that computes
`alpha_pass` then `if (!alpha_pass) discard;`.

## How the fragment WGSL came out (the load-bearing part)

```wgsl
@group(0) @binding(0)  var<uniform> unnamed: PSBlock;
@group(1) @binding(0)  var samp_tex: binding_array<texture_2d_array<f32>, 8>;
@group(1) @binding(8)  var samp_smp: binding_array<sampler, 8>;
...
fn sampleTexture_...(texmap: ptr<function,u32>, uv: ..., layer: ...) -> vec4<i32> {
  ...
  let _e134 = (*texmap);
  let _e136 = (*texmap);
  let _e138 = coords;
  let _e139 = lod_bias;
  let _e145 = textureSampleBias(samp_tex[_e134], samp_smp[_e136],
                                vec2<f32>(_e138.x, _e138.y), i32(_e138.z), _e139);
  ...
}
```
i.e. the combined `sampler2DArray samp[8]` came out as separate
`binding_array<texture_2d_array<f32>,8>` + `binding_array<sampler,8>`, sampled with
a **runtime index** (`samp_tex[texmap]`, `samp_smp[texmap]`) combined at the
`textureSampleBias` call. naga validated this clean.

## Open items for the actual renderer (NOT tool changes — known to-dos)

1. **`binding_array` (sampled-texture descriptor indexing) is a WebGPU feature.**
   naga translates + validates the runtime-indexed `binding_array` fine, but at
   pipeline-creation time WebGPU requires the `texture-binding-array` /
   `sampler-binding-array` feature (Chrome behind a flag / not universally
   available). If the target device lacks it, the renderer must either request
   the feature or specialize the ubershader to a fixed sampler (Dolphin already
   has `backend_dynamic_sampler_indexing`; turning it OFF emits a `switch(texmap)`
   over constant `samp[0u]`..`samp[7u]` — constant indices, no binding_array
   needed — but that re-introduces the combined-sampler split per-index and a
   bigger switch; re-test if used).
2. **Generator-side fixes** (to drop transforms B-helper-shape and C entirely):
   - (C) Dolphin emitting the alpha test as an if/else-if chain (or merged
     case bodies with no empty fall-through) would remove transform (C).
   - (B) A real separate-descriptor mode in Dolphin's GLSL generator (declare
     `texture2DArray`+`sampler`, sample by combining at point-of-use, thread the
     index not the resource) would remove transform (B). Today no APIType does this.
   - (A) `isnan` → `(x!=x)` in the generator removes transform (A).
   These are GLSL-generator changes, not naga/Tint changes.

## Artifacts (all under gamecube/wgsl/)
- `emit_shader.cpp` (now `APIType::Vulkan`), `stubs.cpp`, `build_emit.sh` — link the real generators, emit raw Vulkan GLSL.
- `dolphin_gen_vk.frag.glsl` / `dolphin_gen_vk.vert.glsl` — raw Vulkan-path generator output (no preamble).
- `glsl_preamble_vk.h` — Vulkan #version 450 + macro header (mirrors Vulkan/ShaderCompiler.cpp:22-59).
- `assemble_vk.cjs` — prepends the VK preamble + applies transforms (A),(B),(C); writes the complete GLSL.
- `dolphin_vk.frag.glsl` / `dolphin_vk.vert.glsl` — complete, glslang-compilable Vulkan GLSL.
- `dolphin_vk.frag.spv` (14,102 words) / `dolphin_vk.vert.spv` (7,733 words) — glslang Vulkan SPIR-V.
- `dolphin_vk.frag.wgsl` (71,422 chars) / `dolphin_vk.vert.wgsl` (34,887 chars) — naga WGSL, BOTH validate.
- `run_pipeline_vk.cjs` — the VK driver (glslang→naga→naga validate, per-stage PASS/FAIL).
- Controls (decisive isolations): `control_dynidx.cjs` (dynamic index OK inline),
  `control_fnparam.cjs` (resource-as-fn-arg = the naga blocker), `control_fix.cjs`
  (index-param fix = PASS, `control_FIX.wgsl`), `control_fallthrough.cjs` (fall-through
  switch isolation).

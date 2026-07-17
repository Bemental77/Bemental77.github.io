# Phase 1 WebGPU go/no-go gate — RESULT

**VERDICT: NO-GO** (with two concrete, named blockers and a clear escalation signal)

Question asked: does a *real* Dolphin-generated ubershader survive GLSL → SPIR-V → WGSL and
produce WGSL that naga validates with zero errors, for BOTH a real pixel and a real vertex
ubershader?

Tools (verified, not assumed): naga v29.0.3 at `/Users/caseybement/.cargo/bin/naga`;
`@webgpu/glslang@0.0.15` (node-devel, synchronous Emscripten factory); node v24.15.0.

The shaders are Dolphin's REAL generated ubershaders, emitted by linking the actual
`UberShader::GenPixelShader/GenVertexShader(APIType::OpenGL, ...)` generators (see
`emit_shader.cpp` + `build_emit.sh`). Common case: num_texgens=1, dual-source blend on,
backend_bitfield on, no per-pixel-lighting/msaa/ssaa/stereo/bbox. Fragment = 25,523 GLSL
chars from the generator; contains 50× `bitfieldExtract`, dynamic-index sampler array,
big std140 UBO, dual-source `FRAGMENT_OUTPUT_LOCATION_INDEXED`, switch trees. This is the
hard case, not a toy.

## Per-stage chain results

| Shader   | GLSL chars | [1] glslang GLSL→SPIR-V | [2] naga SPIR-V→WGSL | [3] naga WGSL validate |
|----------|-----------:|------------------------|----------------------|------------------------|
| FRAGMENT | 27,888 (w/ preamble) | PASS — 14,028 SPIR-V words | **FAIL — `invalid id %253`** | (not reached) |
| VERTEX   | 17,925 (w/ preamble) | PASS — 7,661 SPIR-V words  | **FAIL — `Unsupported relational function: IsNan`** | (not reached) |

Both pass glslang. Both fail at naga's **SPIR-V frontend** (stage 2). `--capabilities all`
does not change either result (capabilities gate validation features, not frontend opcode
support).

## Blocker #1 — FRAGMENT: combined image-sampler (`sampler2DArray`)

`invalid id %253` = `%253 = OpLoad %36` where `%36 = OpTypeSampledImage` (a COMBINED
image+sampler), fed into `OpImageSampleImplicitLod`. Dolphin declares
`SAMPLER_BINDING(0) uniform sampler2DArray samp[8]` and samples via `texture(samp[i], ...)`.

This is NOT the sampler array or the helper-function parameter (both were ruled out by
controls): a one-line `void main(){ o = texture(samp0, uv); }` with a single
`uniform sampler2DArray samp0` ALSO fails naga (`invalid id %14`). The blocker is the
**combined image-sampler type itself** — naga's SPIR-V frontend cannot consume a value of
`OpTypeSampledImage` loaded from a `UniformConstant`. WGSL/WebGPU has no combined-sampler
type; it requires separate `texture_2d_array<f32>` + `sampler`.

CONTROL proving the path is otherwise sound: GLSL using SEPARATE
`uniform texture2DArray tex0` + `uniform sampler samp0` →
`texture(sampler2DArray(tex0, samp0), uv)` translates AND validates through naga cleanly
(`naga_separate_sampler_demo.wgsl`). So naga is fine with separate objects; it chokes only
on Dolphin's combined ones — and EVERY texture access in the pixel ubershader is combined.

## Blocker #2 — VERTEX: `OpIsNan`

`Unsupported relational function: IsNan`. The vertex ubershader emits 3× `OpIsNan` (core
opcode 156) from its texgen NaN guard
(`if (dolphin_isnan(coord.x)) coord.x = 1.0;`, lines 438–440 of the generated GLSL —
`#define dolphin_isnan(f) isnan(f)`). naga 29.0.3's SPIR-V frontend rejects `OpIsNan`.

CONTROL: replacing `isnan(f)` with the equivalent `(f != f)` makes the WHOLE real vertex
ubershader translate to 34,761 chars of WGSL AND validate ("Validation successful")
(`dolphin.vert.isnan_patched.wgsl`). So `OpIsNan` is the *sole* vertex blocker and has a
trivial source workaround.

## Escalation judgment (the point of the gate)

- **Blocker #2 (OpIsNan)** is cosmetic — a one-line generator/preprocess substitution
  (`isnan(f)` → `(f != f)`, or strip Dolphin's `dolphin_isnan` to that form) clears it
  entirely. No tool change needed.
- **Blocker #1 (combined image-sampler)** is the real decision. Dolphin's OGL shader path
  is combined-sampler throughout. naga's SPIR-V frontend will not accept that as-is.
  Options:
    1. **SPIRV-Cross / Tint instead of naga's SPIR-V frontend.** Tint (the production
       Dawn/Chrome WGSL compiler) and SPIRV-Cross both have mature combined→separate
       image/sampler splitting. This is the most likely fix and worth a focused retest
       BEFORE building the rest of the WebGPU renderer.
    2. **Don't go through naga's SPIR-V frontend at all.** Drive Dolphin's Vulkan-backend
       shader generators (which already emit separate texture/sampler with explicit
       sets/bindings — the control proved naga eats that) instead of the OGL generators;
       or emit Vulkan-GLSL (`texture2DArray` + `sampler`) and feed naga separate objects.
    3. **naga's own GLSL frontend** (`naga --input-kind glsl`) — untested here; may or may
       not split combined samplers.

Recommended next step: re-run THIS exact harness but (a) substitute `isnan`→`(x!=x)`, and
(b) feed the SPIR-V to **Tint** (and/or generate the shaders with `APIType::Vulkan` so they
come out with separate texture/sampler). If Tint clears blocker #1, the WebGPU path is GO.

## Artifacts (all under gamecube/wgsl/)
- `emit_shader.cpp`, `stubs.cpp`, `build_emit.sh` — links the real Dolphin generators, emits the raw GLSL.
- `dolphin_gen.frag.glsl` / `dolphin_gen.vert.glsl` — raw generator output (no preamble).
- `glsl_preamble.h` — the #version 450 + macro header (mirrors OGL ProgramShaderCache.cpp).
- `dolphin.frag` / `dolphin.vert` — preamble + generator output = complete GLSL fed to glslang.
- `dolphin.frag.spv` (14,028 words) / `dolphin.vert.spv` (7,661 words) — glslang SPIR-V output.
- `dolphin.vert.isnan_patched.wgsl` — proof the real vertex ubershader fully translates+validates once OpIsNan is removed.
- `naga_separate_sampler_demo.wgsl` — proof naga accepts separate texture+sampler.
- `run_pipeline.cjs` — the driver (glslang→naga→naga validate, per-stage PASS/FAIL).
- `spv_inspect.cjs` — minimal SPIR-V disassembler used to pinpoint the blocking ids.

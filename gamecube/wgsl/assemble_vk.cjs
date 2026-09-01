// assemble_vk.cjs
//
// Produces the COMPLETE, glslang-compilable Vulkan GLSL for the two real
// Dolphin ubershaders, by combining:
//   1. the Vulkan preamble (glsl_preamble_vk.h)        -- VK set/binding macros
//   2. the generator output (dolphin_gen_vk.{frag,vert}.glsl, emitted via
//      APIType::Vulkan), with two post-emit text transforms applied:
//
//   (A) VERTEX:  isnan(f) -> (f != f)
//       Dolphin emits `#define dolphin_isnan(f) isnan(f)`. naga 29's SPIR-V
//       frontend rejects OpIsNan. We redefine the macro to the equivalent
//       (f != f), which the prior run PROVED translates+validates.
//
//   (B) FRAGMENT:  combined image-sampler  ->  SEPARATE texture + sampler
//       Dolphin's GLSL (OGL *and* Vulkan path) declares
//           SAMPLER_BINDING(0) uniform sampler2DArray samp[8];
//       i.e. a COMBINED sampler2DArray. naga's SPIR-V frontend cannot consume
//       OpTypeSampledImage (combined). WebGPU/WGSL has no combined type; it
//       needs separate texture_2d_array + sampler. So we split:
//           layout(set=1,binding=0) uniform texture2DArray  samp_tex[8];
//           layout(set=1,binding=8) uniform sampler          samp_smp[8];
//
//       *** dynamic-sampler-indexing OFF variant (2026-06-26) ***
//       With host_config.backend_dynamic_sampler_indexing = false, the generator
//       emits the wrapper as a `switch(sampler_num)` with 8 CONSTANT-index cases
//       (samp[0u]..samp[7u]) instead of one dynamic `samp[texmap]`. Constant
//       indices mean naga lowers each `samp_tex[Nu]`/`samp_smp[Nu]` access to a
//       FIXED binding -- no runtime indexing, so naga does NOT emit a WGSL
//       `binding_array` / require the sized_binding_array language feature (the
//       Dawn-gated feature this whole flip exists to avoid).
//
//       To keep the indices compile-time-constant all the way to the texture()
//       call, we pass the SEPARATE texture+sampler as function ARGUMENTS into
//       sampleTexture (the wrapper supplies the constant-indexed globals), and
//       combine them at point-of-use inside sampleTexture:
//         * sampleTexture's parameter  `in sampler2DArray tex`
//             -> `texture2DArray tex, sampler smp`   (two separate params)
//         * its body's  texture(tex, ...)  ->  texture(sampler2DArray(tex, smp), ...)
//           (Vulkan GLSL / GL_KHR_vulkan_glsl: the sampler2DArray constructor
//            must appear AT the texture() call -- so we construct it there.)
//         * each wrapper case  sampleTexture(Nu, samp[Nu], uv, layer)
//             -> sampleTexture(Nu, samp_tex[Nu], samp_smp[Nu], uv, layer)
//       The naga "resource-as-fn-arg" blocker from the dynamic-indexing run does
//       NOT apply here: that blocker was specifically a DYNAMICALLY-indexed array
//       element passed as an arg; these are CONSTANT-indexed (0u..7u).
//       This is a SOURCE-LEVEL transform only; dolphin-src is untouched.
//
// Outputs:  dolphin_vk.frag.glsl , dolphin_vk.vert.glsl
//
// Run from repo root:  node gamecube/wgsl/assemble_vk.cjs

const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const DIR = __dirname;
const R = (f) => readFileSync(join(DIR, f), 'utf8');
const W = (f, s) => writeFileSync(join(DIR, f), s);

const preamble = R('glsl_preamble_vk.h');

// ---------------------------------------------------------------------------
// VERTEX
// ---------------------------------------------------------------------------
let vert = R('dolphin_gen_vk.vert.glsl');

// (A) isnan substitution: redefine the generator's macro to (f != f).
const ISNAN_DEF = '#define dolphin_isnan(f) isnan(f)';
const ISNAN_FIX = '#define dolphin_isnan(f) ((f) != (f))';
if (!vert.includes(ISNAN_DEF)) {
  throw new Error('VERTEX: expected isnan macro def not found -- generator output changed');
}
vert = vert.replace(ISNAN_DEF, ISNAN_FIX);

W('dolphin_vk.vert.glsl', preamble + '\n' + vert);

// ---------------------------------------------------------------------------
// FRAGMENT
// ---------------------------------------------------------------------------
let frag = R('dolphin_gen_vk.frag.glsl');

// (B1) split the combined sampler ARRAY declaration into 8 SEPARATE SCALAR
//      texture + 8 separate scalar sampler bindings.
//      An array-of-resource declaration (samp_tex[8]) makes naga emit a WGSL
//      `binding_array<...,8>` -- even when every index is a compile-time
//      constant -- which requires Dawn's gated sized_binding_array language
//      feature (the whole reason for the dynamic-indexing-OFF flip). Declaring
//      8 INDIVIDUAL scalar bindings instead makes naga emit 8 plain
//      `@group(1) @binding(N) var samp_texN: texture_2d_array<f32>;` decls with
//      NO binding_array. Textures take bindings 0..7, samplers 8..15.
const COMBINED_DECL = 'SAMPLER_BINDING(0) uniform sampler2DArray samp[8];';
let SEPARATE_DECL = '';
for (let n = 0; n < 8; n++)
  SEPARATE_DECL += `layout(set = 1, binding = ${n}) uniform texture2DArray samp_tex${n};\n`;
for (let n = 0; n < 8; n++)
  SEPARATE_DECL += `layout(set = 1, binding = ${8 + n}) uniform sampler samp_smp${n};\n`;
SEPARATE_DECL = SEPARATE_DECL.trimEnd();
if (!frag.includes(COMBINED_DECL)) {
  throw new Error('FRAGMENT: expected combined sampler decl not found -- generator output changed');
}
frag = frag.replace(COMBINED_DECL, SEPARATE_DECL);

// (B2/B3/B4) SPECIALIZE sampleTexture into 8 CONSTANT-INDEXED variants.
//
// naga's SPIR-V frontend rejects BOTH (a) passing a separate texture/sampler
// array ELEMENT as a function argument ("invalid global var Access" -- proven
// again on 2026-06-26 even with constant indices), AND (b) a runtime/parameter
// index into the resource arrays inside the helper (which emits a runtime-
// indexed WGSL `binding_array`, requiring Dawn's gated sized_binding_array).
//
// The only shape that satisfies naga AND avoids binding_array: the resource
// access must be a DIRECT global indexed by a COMPILE-TIME CONSTANT, in the
// SAME function as texture(). So we clone sampleTexture's body into 8 variants
// sampleTexture_0..sampleTexture_7, each hardcoding samp_tex[Nu]/samp_smp[Nu]
// (and the literal texmap Nu for texdim/texmode). The wrapper's switch then
// calls the matching specialized variant. dolphin-src untouched.
const FN_DEF =
  'int4 sampleTexture(uint texmap, in sampler2DArray tex, int2 uv, int layer) {\n' +
  '  float size_s = float(texdim[texmap].x * 128);\n' +
  '  float size_t = float(texdim[texmap].y * 128);\n' +
  '  float3 coords = float3(float(uv.x) / size_s, float(uv.y) / size_t, layer);\n' +
  '  uint texmode0 = samp_texmode0(texmap);\n' +
  '  float lod_bias = float(bitfieldExtract(int(texmode0), 8, 16)) / 256.0f;\n' +
  '  return iround(255.0 * texture(tex, coords, lod_bias));\n' +
  '}';
if (!frag.includes(FN_DEF)) {
  throw new Error('FRAGMENT: expected sampleTexture definition body not found -- generator output changed');
}
let specialized = '';
for (let n = 0; n < 8; n++) {
  specialized +=
    `int4 sampleTexture_${n}(int2 uv, int layer) {\n` +
    `  float size_s = float(texdim[${n}u].x * 128);\n` +
    `  float size_t = float(texdim[${n}u].y * 128);\n` +
    `  float3 coords = float3(float(uv.x) / size_s, float(uv.y) / size_t, layer);\n` +
    `  uint texmode0 = samp_texmode0(${n}u);\n` +
    `  float lod_bias = float(bitfieldExtract(int(texmode0), 8, 16)) / 256.0f;\n` +
    `  return iround(255.0 * texture(sampler2DArray(samp_tex${n}, samp_smp${n}), coords, lod_bias));\n` +
    `}\n`;
}
frag = frag.replace(FN_DEF, specialized.trimEnd());

// Wrapper switch: each constant case calls its specialized variant.
{
  const before = frag;
  frag = frag.replace(/sampleTexture\((\d+)u,\s*samp\[\d+u\],\s*uv,\s*layer\)/g,
                      'sampleTexture_$1(uv, layer)');
  const rewrote = (before.match(/sampleTexture\(\d+u,\s*samp\[\d+u\]/g) || []).length;
  if (rewrote !== 8) {
    throw new Error('FRAGMENT: expected 8 constant-index sampler wrapper cases, found ' + rewrote +
                    ' -- generator output changed');
  }
}

// (B5) the wrapper's `switch(sampler_num){ case Nu: return ...; }` -> if/else-if
//      chain. glslang structurizes the 8 returning cases such that naga's
//      validator rejects the SPIR-V ("Expression can't be introduced - it's
//      already in scope" in sampleTextureWrapper). Same class as the alpha-test
//      switch (transform C). An if/else-if chain over the constant cases avoids
//      the structurizer pattern naga chokes on.
const WRAP_SWITCH =
  '  switch(sampler_num) {\n' +
  '  case 0u: return sampleTexture_0(uv, layer);\n' +
  '  case 1u: return sampleTexture_1(uv, layer);\n' +
  '  case 2u: return sampleTexture_2(uv, layer);\n' +
  '  case 3u: return sampleTexture_3(uv, layer);\n' +
  '  case 4u: return sampleTexture_4(uv, layer);\n' +
  '  case 5u: return sampleTexture_5(uv, layer);\n' +
  '  case 6u: return sampleTexture_6(uv, layer);\n' +
  '  case 7u: return sampleTexture_7(uv, layer);\n' +
  '  }';
const WRAP_IFCHAIN =
  '  if (sampler_num == 0u) return sampleTexture_0(uv, layer);\n' +
  '  else if (sampler_num == 1u) return sampleTexture_1(uv, layer);\n' +
  '  else if (sampler_num == 2u) return sampleTexture_2(uv, layer);\n' +
  '  else if (sampler_num == 3u) return sampleTexture_3(uv, layer);\n' +
  '  else if (sampler_num == 4u) return sampleTexture_4(uv, layer);\n' +
  '  else if (sampler_num == 5u) return sampleTexture_5(uv, layer);\n' +
  '  else if (sampler_num == 6u) return sampleTexture_6(uv, layer);\n' +
  '  else return sampleTexture_7(uv, layer);';
if (!frag.includes(WRAP_SWITCH)) {
  throw new Error('FRAGMENT: expected sampler wrapper switch block not found -- generator output changed');
}
frag = frag.replace(WRAP_SWITCH, WRAP_IFCHAIN);

// Safety: no remaining COMBINED `samp[...]` use must survive (the new arrays are
// samp_tex[ / samp_smp[, and the macros samp_texmode0/1 reference bpmem_pack2).
// Match `samp[` that is NOT followed by `_tex`/`_smp`/`_texmode`.
const stale = frag.match(/\bsamp\[/g);  // samp_tex[ and samp_smp[ have an underscore, not `[`
if (stale) {
  throw new Error('FRAGMENT: ' + stale.length + ' stale combined `samp[` references remain after transform');
}
// No combined `sampler2DArray` should remain as a declaration/parameter type
// (it is allowed ONLY inside the texture() call as a constructor at point of use).
const combinedDecl = frag.match(/uniform\s+sampler2DArray/g);
if (combinedDecl) {
  throw new Error('FRAGMENT: ' + combinedDecl.length + ' combined `uniform sampler2DArray` decl(s) remain');
}

// (C) FRAGMENT alpha-test switch -> if/else chain.
//     Dolphin's alpha test (UberShaderPixel.cpp:1031-1037, "written weirdly to
//     work around intel and Qualcomm bugs") emits
//         switch (op) { case 0u: if (a&&b) break; else discard; break; ... }
//     glslang structurizes the `if(...)break; else discard; break;` cases so
//     that a case block falls through into the next case label; naga 29 rejects
//     this ("fall-through switch case block"). Proven by control bisection:
//     neutralizing THIS switch is exactly what clears naga. We replace it with
//     a semantically-identical if/else-if chain (compute pass, then discard if
//     not). This is a SOURCE-LEVEL transform; dolphin-src is untouched. The
//     generator-side fix would be to emit this shape (or merged case bodies).
const ALPHA_SWITCH =
  '    switch (bitfieldExtract(uint(bpmem_alphaTest), 22, 2)) {\n' +
  '    case 0u: // AND\n' +
  '      if (comp0 && comp1) break; else discard_fragment; break;\n' +
  '    case 1u: // OR\n' +
  '      if (comp0 || comp1) break; else discard_fragment; break;\n' +
  '    case 2u: // XOR\n' +
  '      if (comp0 != comp1) break; else discard_fragment; break;\n' +
  '    case 3u: // XNOR\n' +
  '      if (comp0 == comp1) break; else discard_fragment; break;\n' +
  '    }';
const ALPHA_IFCHAIN =
  '    uint alpha_op = bitfieldExtract(uint(bpmem_alphaTest), 22, 2);\n' +
  '    bool alpha_pass;\n' +
  '    if (alpha_op == 0u) alpha_pass = (comp0 && comp1);       // AND\n' +
  '    else if (alpha_op == 1u) alpha_pass = (comp0 || comp1);  // OR\n' +
  '    else if (alpha_op == 2u) alpha_pass = (comp0 != comp1);  // XOR\n' +
  '    else alpha_pass = (comp0 == comp1);                      // XNOR (op==3u)\n' +
  '    if (!alpha_pass) discard_fragment;';
if (!frag.includes(ALPHA_SWITCH)) {
  throw new Error('FRAGMENT: expected alpha-test switch block not found -- generator output changed');
}
frag = frag.replace(ALPHA_SWITCH, ALPHA_IFCHAIN);

W('dolphin_vk.frag.glsl', preamble + '\n' + frag);

console.log('[assemble_vk] wrote dolphin_vk.frag.glsl (' + (preamble.length + frag.length) +
            ' chars) and dolphin_vk.vert.glsl (' + (preamble.length + vert.length) + ' chars)');
console.log('[assemble_vk] FRAGMENT: combined sampler2DArray samp[8] -> 8 scalar texture2DArray samp_tex0..7 (binding 0..7) + 8 scalar sampler samp_smp0..7 (binding 8..15); specialized constant-index variants + if/else wrapper => NO binding_array');
console.log('[assemble_vk] VERTEX:   isnan(f) -> ((f) != (f))');

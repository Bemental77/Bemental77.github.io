// GLSL preamble prepended to Dolphin's generated ubershader GLSL before
// feeding it to glslang (GLSL -> SPIR-V).
//
// This reproduces, for the common WebGPU/Vulkan-semantics target, the macro
// and #version header that Dolphin's OGL backend prepends at compile time
// (see gamecube/dolphin-src/Source/Core/VideoBackends/OGL/ProgramShaderCache.cpp
//  GetGLSLVersionString() + the s_glsl_header fmt::format block ~line 785-939).
//
// We deliberately use the EXPLICIT-LAYOUT branch (binding_layout where
// g_ogl_config.bSupportsExplicitLayoutInShader == true) so every UBO/sampler
// gets an explicit `binding=`, and every fragment output an explicit
// `location=`/`index=`. Those become real SPIR-V binding decorations, which is
// exactly what naga/WebGPU expect. We target #version 450 core (desktop GLSL)
// because:
//   * the generated shader uses `bitfieldExtract` (backend_bitfield=true path,
//     i.e. it relies on the native built-in -> needs GL 4.00+ / ES 3.10+), and
//   * #version 450 maps cleanly to SPIR-V via glslang with no ES precision
//     juggling, matching WebGPU's Vulkan-1.0/SPIR-V semantics.
//
// The float2/float3/... and frac/lerp aliases are copied verbatim from the
// "Silly differences" block of the OGL header.
#version 450 core

// ---- explicit binding/location layout (OGL bSupportsExplicitLayoutInShader) ----
#define ATTRIBUTE_LOCATION(x) layout(location = x)
#define FRAGMENT_OUTPUT_LOCATION(x) layout(location = x)
#define FRAGMENT_OUTPUT_LOCATION_INDEXED(x, y) layout(location = x, index = y)
#define UBO_BINDING(packing, x) layout(packing, binding = x)
#define SAMPLER_BINDING(x) layout(binding = x)
#define TEXEL_BUFFER_BINDING(x) layout(binding = x)
#define SSBO_BINDING(x) layout(std430, binding = x)
#define IMAGE_BINDING(format, x) layout(format, binding = x)
// VARYING_LOCATION is declared empty by the OGL backend ("TODO: actually
// define this if using bSupportsExplicitLayoutInShader"). We give it an
// explicit location so the vert->frag varying interface matches by location,
// which is what WebGPU/SPIR-V wants.
#define VARYING_LOCATION(x) layout(location = x)

#define API_OPENGL 1
#define float2 vec2
#define float3 vec3
#define float4 vec4
#define uint2 uvec2
#define uint3 uvec3
#define uint4 uvec4
#define int2 ivec2
#define int3 ivec3
#define int4 ivec4
#define frac fract
#define lerp mix

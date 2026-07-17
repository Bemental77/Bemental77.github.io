// Vulkan GLSL preamble prepended to Dolphin's generated ubershader GLSL before
// feeding it to glslang (GLSL -> Vulkan SPIR-V).
//
// This mirrors VERBATIM (modulo formatting) Dolphin's Vulkan backend header,
// gamecube/dolphin-src/Source/Core/VideoBackends/Vulkan/ShaderCompiler.cpp
// lines 22-59 (the SHADER_HEADER string). Key differences from the OGL preamble:
//   * SAMPLER_BINDING  => layout(set = 1, binding = x)
//   * UBO_BINDING      => layout(packing, set = 0, binding = (x - 1))
//   * TEXEL_BUFFER     => layout(set = 1, binding = (x + 8))
//   * SSBO_BINDING     => layout(std430, set = 2, binding = x)
//   * API_VULKAN 1     (instead of API_OPENGL 1)
//   * gl_VertexID  => gl_VertexIndex  ;  gl_InstanceID => gl_InstanceIndex
//
// Targets #version 450 core (desktop GLSL), which glslang maps to Vulkan
// SPIR-V with separate OpTypeImage/OpTypeSampler descriptor decorations
// (set=/binding=) -- exactly the descriptor model WebGPU/naga expect.
#version 450 core

#define ATTRIBUTE_LOCATION(x) layout(location = x)
#define FRAGMENT_OUTPUT_LOCATION(x) layout(location = x)
#define FRAGMENT_OUTPUT_LOCATION_INDEXED(x, y) layout(location = x, index = y)
#define UBO_BINDING(packing, x) layout(packing, set = 0, binding = (x - 1))
#define SAMPLER_BINDING(x) layout(set = 1, binding = x)
#define TEXEL_BUFFER_BINDING(x) layout(set = 1, binding = (x + 8))
#define SSBO_BINDING(x) layout(std430, set = 2, binding = x)
#define INPUT_ATTACHMENT_BINDING(x, y, z) layout(set = x, binding = y, input_attachment_index = z)
#define VARYING_LOCATION(x) layout(location = x)
#define FORCE_EARLY_Z layout(early_fragment_tests) in

// Metal framebuffer fetch helpers (unused in this config; framebuffer_fetch=false).
#define FB_FETCH_VALUE subpassLoad(in_ocol0)

// hlsl to glsl function translation
#define API_VULKAN 1
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

// These were changed in Vulkan
#define gl_VertexID gl_VertexIndex
#define gl_InstanceID gl_InstanceIndex

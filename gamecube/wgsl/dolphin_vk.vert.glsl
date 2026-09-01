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

// Vertex UberShader for 8 texgens

struct Light {
	int4 color;
	float4 cosatt;
	float4 distatt;
	float4 pos;
	float4 dir;
};
UBO_BINDING(std140, 2) uniform VSBlock {
	uint    components;
	uint    xfmem_dualTexInfo;
	uint    xfmem_numColorChans;
	uint    missing_color_hex;
	float4  missing_color_value;
	float4 cpnmtx[6];
	float4 cproj[4];
	int4 cmtrl[4];
	Light clights[8];
	float4 ctexmtx[24];
	float4 ctrmtx[64];
	float4 cnmtx[32];
	float4 cpostmtx[64];
	float4 cpixelcenter;
	float2 cviewport;
	uint4   xfmem_pack1[8];
	float4 cnormal;
	float4 ctangent;
	float4 cbinormal;
	uint vertex_stride;
	uint vertex_offset_rawnormal;
	uint vertex_offset_rawtangent;
	uint vertex_offset_rawbinormal;
	uint vertex_offset_rawpos;
	uint vertex_offset_posmtx;
	uint vertex_offset_rawcolor0;
	uint vertex_offset_rawcolor1;
	uint4 vertex_offset_rawtex[2];
	#define xfmem_texMtxInfo(i) (xfmem_pack1[(i)].x)
	#define xfmem_postMtxInfo(i) (xfmem_pack1[(i)].y)
	#define xfmem_color(i) (xfmem_pack1[(i)].z)
	#define xfmem_alpha(i) (xfmem_pack1[(i)].w)
};
struct VS_OUTPUT {
	 float4 pos;
	 float4 colors_0;
	 float4 colors_1;
	 float3 tex0;
	 float3 tex1;
	 float3 tex2;
	 float3 tex3;
	 float3 tex4;
	 float3 tex5;
	 float3 tex6;
	 float3 tex7;
	 float4 clipPos;
};

#define dolphin_isnan(f) ((f) != (f))
int4 CalculateLighting(uint index, uint attnfunc, uint diffusefunc, float3 pos, float3 normal) {
  float3 ldir, h, cosAttn, distAttn;
  float dist, dist2, attn;

  switch (attnfunc) {
  case 0x0u /* No attenuation */:
  case 0x2u /* Directional light attenuation */:
    ldir = normalize(clights[index].pos.xyz - pos.xyz);
    attn = 1.0;
    if (length(ldir) == 0.0)
      ldir = normal;
    break;

  case 0x1u /* Point light attenuation */:
    ldir = normalize(clights[index].pos.xyz - pos.xyz);
    attn = (dot(normal, ldir) >= 0.0) ? max(0.0, dot(normal, clights[index].dir.xyz)) : 0.0;
    cosAttn = clights[index].cosatt.xyz;
    if (diffusefunc == 0x0u /* None */)
      distAttn = clights[index].distatt.xyz;
    else
      distAttn = normalize(clights[index].distatt.xyz);
    attn = max(0.0, dot(cosAttn, float3(1.0, attn, attn*attn))) / dot(distAttn, float3(1.0, attn, attn*attn));
    break;

  case 0x3u /* Spot light attenuation */:
    ldir = clights[index].pos.xyz - pos.xyz;
    dist2 = dot(ldir, ldir);
    dist = sqrt(dist2);
    ldir = ldir / dist;
    attn = max(0.0, dot(ldir, clights[index].dir.xyz));
    attn = max(0.0, clights[index].cosatt.x + clights[index].cosatt.y * attn + clights[index].cosatt.z * attn * attn) / dot(clights[index].distatt.xyz, float3(1.0, dist, dist2));
    break;

  default:
    attn = 1.0;
    ldir = normal;
    break;
  }

  switch (diffusefunc) {
  case 0x0u /* None */:
    return int4(round(attn * float4(clights[index].color)));

  case 0x1u /* Sign */:
    return int4(round(attn * dot(ldir, normal) * float4(clights[index].color)));

  case 0x2u /* Clamp */:
    return int4(round(attn * max(0.0, dot(ldir, normal)) * float4(clights[index].color)));

  default:
    return int4(0, 0, 0, 0);
  }
}

ATTRIBUTE_LOCATION(0x0u /* Position */) in float4 rawpos;
ATTRIBUTE_LOCATION(0x1u /* Position Matrix */) in uint4 posmtx;
ATTRIBUTE_LOCATION(0x2u /* Normal */) in float3 rawnormal;
ATTRIBUTE_LOCATION(0x3u /* Tangent */) in float3 rawtangent;
ATTRIBUTE_LOCATION(0x4u /* Binormal */) in float3 rawbinormal;
ATTRIBUTE_LOCATION(0x5u /* Color 0 */) in float4 rawcolor0;
ATTRIBUTE_LOCATION(0x6u /* Color 1 */) in float4 rawcolor1;
ATTRIBUTE_LOCATION(0x8u /* Tex Coord 0 */) in float3 rawtex0;
ATTRIBUTE_LOCATION(0x9u /* Tex Coord 1 */) in float3 rawtex1;
ATTRIBUTE_LOCATION(0xau /* Tex Coord 2 */) in float3 rawtex2;
ATTRIBUTE_LOCATION(0xbu /* Tex Coord 3 */) in float3 rawtex3;
ATTRIBUTE_LOCATION(0xcu /* Tex Coord 4 */) in float3 rawtex4;
ATTRIBUTE_LOCATION(0xdu /* Tex Coord 5 */) in float3 rawtex5;
ATTRIBUTE_LOCATION(0xeu /* Tex Coord 6 */) in float3 rawtex6;
ATTRIBUTE_LOCATION(0xfu /* Tex Coord 7 */) in float3 rawtex7;
VARYING_LOCATION(0)  out float4 colors_0;
VARYING_LOCATION(1)  out float4 colors_1;
VARYING_LOCATION(2)  out float3 tex0;
VARYING_LOCATION(3)  out float3 tex1;
VARYING_LOCATION(4)  out float3 tex2;
VARYING_LOCATION(5)  out float3 tex3;
VARYING_LOCATION(6)  out float3 tex4;
VARYING_LOCATION(7)  out float3 tex5;
VARYING_LOCATION(8)  out float3 tex6;
VARYING_LOCATION(9)  out float3 tex7;
VARYING_LOCATION(10)  out float4 clipPos;
void main()
{
VS_OUTPUT o;

// Position matrix
float4 P0;
float4 P1;
float4 P2;

// Normal matrix
float3 N0;
float3 N1;
float3 N2;

if ((components & 2u) != 0u) { // VB_HAS_POSMTXIDX
  // Vertex format has a per-vertex matrix
  int posidx = int(posmtx.r);
  P0 = ctrmtx[posidx];
  P1 = ctrmtx[posidx+1];
  P2 = ctrmtx[posidx+2];

  int normidx = posidx >= 32 ? (posidx - 32) : posidx;
  N0 = cnmtx[normidx].xyz;
  N1 = cnmtx[normidx+1].xyz;
  N2 = cnmtx[normidx+2].xyz;
} else {
  // One shared matrix
  P0 = cpnmtx[0];
  P1 = cpnmtx[1];
  P2 = cpnmtx[2];
  N0 = cpnmtx[3].xyz;
  N1 = cpnmtx[4].xyz;
  N2 = cpnmtx[5].xyz;
}

// Multiply the position vector by the position matrix
float4 pos = float4(dot(P0, rawpos), dot(P1, rawpos), dot(P2, rawpos), 1.0);
o.pos = float4(dot(cproj[0], pos), dot(cproj[1], pos), dot(cproj[2], pos), dot(cproj[3], pos));

float3 _rawnormal;
float3 _rawtangent;
float3 _rawbinormal;
if ((components & 1024u) != 0u) // VB_HAS_NORMAL
{
  _rawnormal = rawnormal;
}
else
{
  _rawnormal = cnormal.xyz;
}

if ((components & 2048u) != 0u) // VB_HAS_TANGENT
{
  _rawtangent = rawtangent;
}
else
{
  _rawtangent = ctangent.xyz;
}

if ((components & 4096u) != 0u) // VB_HAS_BINORMAL
{
  _rawbinormal = rawbinormal;
}
else
{
  _rawbinormal = cbinormal.xyz;
}

// The scale of the transform matrix is used to control the size of the emboss map
// effect by changing the scale of the transformed binormals (which only get used by
// emboss map texgens). By normalising the first transformed normal (which is used
// by lighting calculations and needs to be unit length), the same transform matrix
// can do double duty, scaling for emboss mapping, and not scaling for lighting.
float3 _normal = normalize(float3(dot(N0, _rawnormal), dot(N1, _rawnormal), dot(N2, _rawnormal)));
float3 _tangent = float3(dot(N0, _rawtangent), dot(N1, _rawtangent), dot(N2, _rawtangent));
float3 _binormal = float3(dot(N0, _rawbinormal), dot(N1, _rawbinormal), dot(N2, _rawbinormal));
// xfmem.numColorChans controls the number of color channels available to TEV,
// but we still need to generate all channels here, as it can be used in texgen.
// Cel-damage is an example of this.
float4 vertex_color_0, vertex_color_1;

// To use color 1, the vertex descriptor must have color 0 and 1.
// If color 1 is present but not color 0, it is used for lighting channel 0.
bool use_color_1 = ((components & 24576u) == 24576u); // VB_HAS_COL0 | VB_HAS_COL1
if ((components & 24576u) == 24576u) // VB_HAS_COL0 | VB_HAS_COL1
{
  vertex_color_0 = rawcolor0;
  vertex_color_1 = rawcolor1;
}
else if ((components & 8192u) != 0u) // VB_HAS_COL0
{
  vertex_color_0 = rawcolor0;
  vertex_color_1 = rawcolor0;
}
else if ((components & 16384u) != 0u) // VB_HAS_COL1
{
  vertex_color_0 = rawcolor1;
  vertex_color_1 = rawcolor1;
}
else
{
  vertex_color_0 = missing_color_value;
  vertex_color_1 = missing_color_value;
}
// Lighting
for (uint chan = 0u; chan < 2u; chan++) {
  uint colorreg = xfmem_color(chan);
  uint alphareg = xfmem_alpha(chan);
  int4 mat = cmtrl[chan + 2u]; 
  int4 lacc = int4(255, 255, 255, 255);

  if (bitfieldExtract(uint(colorreg), 0, 1) != 0u)
    mat.xyz = int3(round(((chan == 0u) ? vertex_color_0.xyz : vertex_color_1.xyz) * 255.0));
  if (bitfieldExtract(uint(alphareg), 0, 1) != 0u)
    mat.w = int(round(((chan == 0u) ? vertex_color_0.w : vertex_color_1.w) * 255.0));
  else
    mat.w = cmtrl [chan + 2u].w;

  if (bitfieldExtract(uint(colorreg), 1, 1) != 0u) {
    if (bitfieldExtract(uint(colorreg), 6, 1) != 0u)
      lacc.xyz = int3(round(((chan == 0u) ? vertex_color_0.xyz : vertex_color_1.xyz) * 255.0));
    else
      lacc.xyz = cmtrl [chan].xyz;

    uint light_mask = bitfieldExtract(uint(colorreg), 2, 4) | (bitfieldExtract(uint(colorreg), 11, 4) << 4u);
    uint attnfunc = bitfieldExtract(uint(colorreg), 9, 2);
    uint diffusefunc = bitfieldExtract(uint(colorreg), 7, 2);
    for (uint light_index = 0u; light_index < 8u; light_index++) {
      if ((light_mask & (1u << light_index)) != 0u)
        lacc.xyz += CalculateLighting(light_index, attnfunc, diffusefunc, pos.xyz, _normal).xyz;
    }
  }

  if (bitfieldExtract(uint(alphareg), 1, 1) != 0u) {
    if (bitfieldExtract(uint(alphareg), 6, 1) != 0u) {
      if ((components & (8192u << chan)) != 0u) // VB_HAS_COL0
        lacc.w = int(round(((chan == 0u) ? vertex_color_0.w : vertex_color_1.w) * 255.0));
      else if ((components & 8192u) != 0u) // VB_HAS_COLO0
        lacc.w = int(round(vertex_color_0.w * 255.0));
      else
        lacc.w = 255;
    } else {
      lacc.w = cmtrl [chan].w;
    }

    uint light_mask = bitfieldExtract(uint(alphareg), 2, 4) | (bitfieldExtract(uint(alphareg), 11, 4) << 4u);
    uint attnfunc = bitfieldExtract(uint(alphareg), 9, 2);
    uint diffusefunc = bitfieldExtract(uint(alphareg), 7, 2);
    for (uint light_index = 0u; light_index < 8u; light_index++) {

      if ((light_mask & (1u << light_index)) != 0u)

        lacc.w += CalculateLighting(light_index, attnfunc, diffusefunc, pos.xyz, _normal).w;
    }
  }

  lacc = clamp(lacc, 0, 255);

  // Hopefully GPUs that can support dynamic indexing will optimize this.
  float4 lit_color = float4((mat * (lacc + (lacc >> 7))) >> 8) / 255.0;
  switch (chan) {
  case 0u: o.colors_0 = lit_color; break;
  case 1u: o.colors_1 = lit_color; break;
  }
}

o.tex0 = float3(0.0, 0.0, 0.0);
o.tex1 = float3(0.0, 0.0, 0.0);
o.tex2 = float3(0.0, 0.0, 0.0);
o.tex3 = float3(0.0, 0.0, 0.0);
o.tex4 = float3(0.0, 0.0, 0.0);
o.tex5 = float3(0.0, 0.0, 0.0);
o.tex6 = float3(0.0, 0.0, 0.0);
o.tex7 = float3(0.0, 0.0, 0.0);
// Texture coordinate generation
for (uint texgen = 0u; texgen < 8u; texgen++) {
  // Texcoord transforms
  float4 coord = float4(0.0, 0.0, 1.0, 1.0);
  uint texMtxInfo = xfmem_texMtxInfo(texgen);
  switch (bitfieldExtract(uint(texMtxInfo), 7, 5)) {
  case 0x0u /* Geometry (input is ABC1) */:
    coord.xyz = rawpos.xyz;
    break;

  case 0x1u /* Normal (input is ABC1) */:
    if ((components & 1024u) != 0u) // VB_HAS_NORMAL
    {
      coord.xyz = rawnormal.xyz;
    }
    break;

  case 0x3u /* Binormal T (input is ABC1) */:
    if ((components & 2048u) != 0u) // VB_HAS_TANGENT
    {
      coord.xyz = rawtangent.xyz;
    }
    break;

  case 0x4u /* Binormal B (input is ABC1) */:
    if ((components & 4096u) != 0u) // VB_HAS_BINORMAL
    {
      coord.xyz = rawbinormal.xyz;
    }
    break;

  case 0x5u /* Tex 0 */:
    if ((components & 32768u) != 0u) // VB_HAS_UV0
    {
      coord = float4(rawtex0.x, rawtex0.y, 1.0f, 1.0f);
    }
    break;

  case 0x6u /* Tex 1 */:
    if ((components & 65536u) != 0u) // VB_HAS_UV1
    {
      coord = float4(rawtex1.x, rawtex1.y, 1.0f, 1.0f);
    }
    break;

  case 0x7u /* Tex 2 */:
    if ((components & 131072u) != 0u) // VB_HAS_UV2
    {
      coord = float4(rawtex2.x, rawtex2.y, 1.0f, 1.0f);
    }
    break;

  case 0x8u /* Tex 3 */:
    if ((components & 262144u) != 0u) // VB_HAS_UV3
    {
      coord = float4(rawtex3.x, rawtex3.y, 1.0f, 1.0f);
    }
    break;

  case 0x9u /* Tex 4 */:
    if ((components & 524288u) != 0u) // VB_HAS_UV4
    {
      coord = float4(rawtex4.x, rawtex4.y, 1.0f, 1.0f);
    }
    break;

  case 0xau /* Tex 5 */:
    if ((components & 1048576u) != 0u) // VB_HAS_UV5
    {
      coord = float4(rawtex5.x, rawtex5.y, 1.0f, 1.0f);
    }
    break;

  case 0xbu /* Tex 6 */:
    if ((components & 2097152u) != 0u) // VB_HAS_UV6
    {
      coord = float4(rawtex6.x, rawtex6.y, 1.0f, 1.0f);
    }
    break;

  case 0xcu /* Tex 7 */:
    if ((components & 4194304u) != 0u) // VB_HAS_UV7
    {
      coord = float4(rawtex7.x, rawtex7.y, 1.0f, 1.0f);
    }
    break;

  }

  // Input form of AB11 sets z element to 1.0
  if (bitfieldExtract(uint(texMtxInfo), 2, 1) == 0x0u /* AB11 */) // inputform == AB11
    coord.z = 1.0f;

  // Convert NaN to 1
  if (dolphin_isnan(coord.x)) coord.x = 1.0;
  if (dolphin_isnan(coord.y)) coord.y = 1.0;
  if (dolphin_isnan(coord.z)) coord.z = 1.0;
  // first transformation
  uint texgentype = bitfieldExtract(uint(texMtxInfo), 4, 3);
  float3 output_tex;
  switch (texgentype)
  {
  case 0x1u /* Emboss map (used when bump mapping) */:
    {
      uint light = bitfieldExtract(uint(texMtxInfo), 15, 3);
      uint source = bitfieldExtract(uint(texMtxInfo), 12, 3);
      switch (source) {
      case 0u: output_tex.xyz = o.tex0; break;
      case 1u: output_tex.xyz = o.tex1; break;
      case 2u: output_tex.xyz = o.tex2; break;
      case 3u: output_tex.xyz = o.tex3; break;
      case 4u: output_tex.xyz = o.tex4; break;
      case 5u: output_tex.xyz = o.tex5; break;
      case 6u: output_tex.xyz = o.tex6; break;
      case 7u: output_tex.xyz = o.tex7; break;
      default: output_tex.xyz = float3(0.0, 0.0, 0.0); break;
      }
      float3 ldir = normalize(clights[light].pos.xyz - pos.xyz);
      output_tex.xyz += float3(dot(ldir, _tangent), dot(ldir, _binormal), 0.0);
    }
    break;

  case 0x2u /* Color channel 0 */:
    output_tex.xyz = float3(o.colors_0.x, o.colors_0.y, 1.0);
    break;

  case 0x3u /* Color channel 1 */:
    output_tex.xyz = float3(o.colors_1.x, o.colors_1.y, 1.0);
    break;

  case 0x0u /* Regular */:
  default:
    {
      if ((components & (4u /* VB_HAS_TEXMTXIDX0 */ << texgen)) != 0u) {
        // This is messy, due to dynamic indexing of the input texture coordinates.
        // Hopefully the compiler will unroll this whole loop anyway and the switch.
        int tmp = 0;
        switch (texgen) {
        case 0u: tmp = int(rawtex0.z); break;
        case 1u: tmp = int(rawtex1.z); break;
        case 2u: tmp = int(rawtex2.z); break;
        case 3u: tmp = int(rawtex3.z); break;
        case 4u: tmp = int(rawtex4.z); break;
        case 5u: tmp = int(rawtex5.z); break;
        case 6u: tmp = int(rawtex6.z); break;
        case 7u: tmp = int(rawtex7.z); break;
        }

        if (bitfieldExtract(uint(texMtxInfo), 1, 1) == 0x1u /* STQ (3x4 matrix) */) {
          output_tex.xyz = float3(dot(coord, ctrmtx[tmp]),
                                  dot(coord, ctrmtx[tmp + 1]),
                                  dot(coord, ctrmtx[tmp + 2]));
        } else {
          output_tex.xyz = float3(dot(coord, ctrmtx[tmp]),
                                  dot(coord, ctrmtx[tmp + 1]),
                                  1.0);
        }
      } else {
        if (bitfieldExtract(uint(texMtxInfo), 1, 1) == 0x1u /* STQ (3x4 matrix) */) {
          output_tex.xyz = float3(dot(coord, ctexmtx[3u * texgen]),
                                  dot(coord, ctexmtx[3u * texgen + 1u]),
                                  dot(coord, ctexmtx[3u * texgen + 2u]));
        } else {
          output_tex.xyz = float3(dot(coord, ctexmtx[3u * texgen]),
                                  dot(coord, ctexmtx[3u * texgen + 1u]),
                                  1.0);
        }
      }
    }
    break;

  }

  if (xfmem_dualTexInfo != 0u) {
    uint postMtxInfo = xfmem_postMtxInfo(texgen);    uint base_index = bitfieldExtract(uint(postMtxInfo), 0, 6);
    float4 P0 = cpostmtx[base_index & 0x3fu];
    float4 P1 = cpostmtx[(base_index + 1u) & 0x3fu];
    float4 P2 = cpostmtx[(base_index + 2u) & 0x3fu];

    if (bitfieldExtract(uint(postMtxInfo), 8, 1) != 0u)
      output_tex.xyz = normalize(output_tex.xyz);

    // multiply by postmatrix
    output_tex.xyz = float3(dot(P0.xyz, output_tex.xyz) + P0.w,
                            dot(P1.xyz, output_tex.xyz) + P1.w,
                            dot(P2.xyz, output_tex.xyz) + P2.w);
  }

  if (texgentype == 0x0u /* Regular */ && output_tex.z == 0.0)
    output_tex.xy = clamp(output_tex.xy / 2.0f, float2(-1.0f,-1.0f), float2(1.0f,1.0f));

  // Hopefully GPUs that can support dynamic indexing will optimize this.
  switch (texgen) {
  case 0u: o.tex0 = output_tex; break;
  case 1u: o.tex1 = output_tex; break;
  case 2u: o.tex2 = output_tex; break;
  case 3u: o.tex3 = output_tex; break;
  case 4u: o.tex4 = output_tex; break;
  case 5u: o.tex5 = output_tex; break;
  case 6u: o.tex6 = output_tex; break;
  case 7u: o.tex7 = output_tex; break;
  }
}
// The number of colors available to TEV is determined by numColorChans.
// We have to provide the fields to match the interface, so set to zero
// if it's not enabled.
if (xfmem_numColorChans == 0u)
  o.colors_0 = float4(0.0, 0.0, 0.0, 0.0);
if (xfmem_numColorChans <= 1u)
  o.colors_1 = float4(0.0, 0.0, 0.0, 0.0);
o.clipPos = o.pos;
o.pos.z = o.pos.w * cpixelcenter.w - o.pos.z * cpixelcenter.z;
o.pos.xy *= sign(cpixelcenter.xy * float2(1.0, -1.0));
o.pos.xy = o.pos.xy - o.pos.w * cpixelcenter.xy;
tex0.xyz = o.tex0;
tex1.xyz = o.tex1;
tex2.xyz = o.tex2;
tex3.xyz = o.tex3;
tex4.xyz = o.tex4;
tex5.xyz = o.tex5;
tex6.xyz = o.tex6;
tex7.xyz = o.tex7;
clipPos = o.clipPos;
colors_0 = o.colors_0;
colors_1 = o.colors_1;
gl_Position = float4(o.pos.x, -o.pos.y, o.pos.z, o.pos.w);
}

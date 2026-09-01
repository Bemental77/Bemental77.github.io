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
// Pixel UberShader for 1 texgens
int idot(int3 x, int3 y)
{
	int3 tmp = x * y;
	return tmp.x + tmp.y + tmp.z;
}
int idot(int4 x, int4 y)
{
	int4 tmp = x * y;
	return tmp.x + tmp.y + tmp.z + tmp.w;
}

int  iround(float  x) { return int (round(x)); }
int2 iround(float2 x) { return int2(round(x)); }
int3 iround(float3 x) { return int3(round(x)); }
int4 iround(float4 x) { return int4(round(x)); }

SAMPLER_BINDING(0) uniform sampler2DArray samp[8];

UBO_BINDING(std140, 1) uniform PSBlock {
	int4 color[4];
	int4 k[4];
	int4 alphaRef;
	int4 texdim[8];
	int4 czbias[2];
	int4 cindscale[2];
	int4 cindmtx[6];
	int4 cfogcolor;
	int4 cfogi;
	float4 cfogf;
	float4 cfogrange[3];
	float4 czslope;
	float2 cefbscale;
	uint  bpmem_genmode;
	uint  bpmem_alphaTest;
	uint  bpmem_fogParam3;
	uint  bpmem_fogRangeBase;
	uint  bpmem_dstalpha;
	uint  bpmem_ztex_op;
	bool  bpmem_late_ztest;
	bool  bpmem_rgba6_format;
	bool  bpmem_dither;
	bool  bpmem_bounding_box;
	uint4 bpmem_pack1[16];
	uint4 bpmem_pack2[8];
	int4  konstLookup[32];
	bool  blend_enable;
	uint  blend_src_factor;
	uint  blend_src_factor_alpha;
	uint  blend_dst_factor;
	uint  blend_dst_factor_alpha;
	bool  blend_subtract;
	bool  blend_subtract_alpha;
	bool  logic_op_enable;
	uint  logic_op_mode;
	uint  time_ms;
};

#define bpmem_combiners(i) (bpmem_pack1[(i)].xy)
#define bpmem_tevind(i) (bpmem_pack1[(i)].z)
#define bpmem_iref(i) (bpmem_pack1[(i)].w)
#define bpmem_tevorder(i) (bpmem_pack2[(i)].x)
#define bpmem_tevksel(i) (bpmem_pack2[(i)].y)
#define samp_texmode0(i) (bpmem_pack2[(i)].z)
#define samp_texmode1(i) (bpmem_pack2[(i)].w)


int4 sampleTexture(uint texmap, in sampler2DArray tex, int2 uv, int layer) {
  float size_s = float(texdim[texmap].x * 128);
  float size_t = float(texdim[texmap].y * 128);
  float3 coords = float3(float(uv.x) / size_s, float(uv.y) / size_t, layer);
  uint texmode0 = samp_texmode0(texmap);
  float lod_bias = float(bitfieldExtract(int(texmode0), 8, 16)) / 256.0f;
  return iround(255.0 * texture(tex, coords, lod_bias));
}
FRAGMENT_OUTPUT_LOCATION_INDEXED(0, 0) out vec4 ocol0;
FRAGMENT_OUTPUT_LOCATION_INDEXED(0, 1) out vec4 ocol1;
VARYING_LOCATION(0)  in float4 colors_0;
VARYING_LOCATION(1)  in float4 colors_1;
VARYING_LOCATION(2)  in float3 tex0;
VARYING_LOCATION(3)  in float4 clipPos;
int2 selectTexCoord(uint index, int2 fixpoint_uv0) {
  if (index >= 1u) {
    return fixpoint_uv0;
  }
      return fixpoint_uv0;
}

uint selectTexCoordIndex(uint texmap){
  if (texmap >= 1u) {
    return 0u;
  }
      return 0u;
}

int4 sampleTextureWrapper(uint texmap, int2 uv, int layer) {
  return sampleTexture(texmap, samp[texmap], uv, layer);
}

int4 Swizzle(uint s, int4 color) {
  // AKA: Color Channel Swapping

  int4 ret;
  ret.r = color[bitfieldExtract(uint(bpmem_tevksel(s * 2u)), 0, 2)];
  ret.g = color[bitfieldExtract(uint(bpmem_tevksel(s * 2u)), 2, 2)];
  ret.b = color[bitfieldExtract(uint(bpmem_tevksel(s * 2u + 1u)), 0, 2)];
  ret.a = color[bitfieldExtract(uint(bpmem_tevksel(s * 2u + 1u)), 2, 2)];
  return ret;
}

int Wrap(int coord, uint mode) {
  if (mode == 0u) // ITW_OFF
    return coord;
  else if (mode < 6u) // ITW_256 to ITW_16
    return coord & (0xfffe >> mode);
  else // ITW_0
    return 0;
}

// TEV's Linear Interpolate, plus bias, add/subtract and scale
int tevLerp(int A, int B, int C, int D, uint bias, bool op, uint scale) {
 // Scale C from 0..255 to 0..256
  C += C >> 7;

 // Add bias to D
  if (bias == 1u) D += 128;
  else if (bias == 2u) D -= 128;

  int lerp = (A << 8) + (B - A)*C;
  if (scale != 3u) {
    lerp = lerp << scale;
    D = D << scale;
  }

  // This rounding bias is not added when the scale is divide by 2
  if (scale != 3u)
    lerp = lerp + (op ? 127 : 128);

  int result = lerp >> 8;

  // Add/Subtract D
  if (op) // Subtract
    result = D - result;
  else // Add
    result = D + result;

  // Most of the Scale was moved inside the lerp for improved precision
  // But we still do the divide by 2 here
  if (scale == 3u)
    result = result >> 1;
  return result;
}

// TEV's Linear Interpolate, plus bias, add/subtract and scale
int3 tevLerp3(int3 A, int3 B, int3 C, int3 D, uint bias, bool op, uint scale) {
 // Scale C from 0..255 to 0..256
  C += C >> 7;

 // Add bias to D
  if (bias == 1u) D += 128;
  else if (bias == 2u) D -= 128;

  int3 lerp = (A << 8) + (B - A)*C;
  if (scale != 3u) {
    lerp = lerp << scale;
    D = D << scale;
  }

  // This rounding bias is not added when the scale is divide by 2
  if (scale != 3u)
    lerp = lerp + (op ? 127 : 128);

  int3 result = lerp >> 8;

  // Add/Subtract D
  if (op) // Subtract
    result = D - result;
  else // Add
    result = D + result;

  // Most of the Scale was moved inside the lerp for improved precision
  // But we still do the divide by 2 here
  if (scale == 3u)
    result = result >> 1;
  return result;
}

// Implements operations 0-5 of TEV's compare mode,
// which are common to both color and alpha channels
bool tevCompare(uint op, int3 color_A, int3 color_B) {
  switch (op) {
  case 0u: // TevCompareMode::R8, TevComparison::GT
    return (color_A.r > color_B.r);
  case 1u: // TevCompareMode::R8, TevComparison::EQ
    return (color_A.r == color_B.r);
  case 2u: // TevCompareMode::GR16, TevComparison::GT
    int A_16 = (color_A.r | (color_A.g << 8));
    int B_16 = (color_B.r | (color_B.g << 8));
    return A_16 > B_16;
  case 3u: // TevCompareMode::GR16, TevComparison::EQ
    return (color_A.r == color_B.r && color_A.g == color_B.g);
  case 4u: // TevCompareMode::BGR24, TevComparison::GT
    int A_24 = (color_A.r | (color_A.g << 8) | (color_A.b << 16));
    int B_24 = (color_B.r | (color_B.g << 8) | (color_B.b << 16));
    return A_24 > B_24;
  case 5u: // TevCompareMode::BGR24, TevComparison::EQ
    return (color_A.r == color_B.r && color_A.g == color_B.g && color_A.b == color_B.b);
  default:
    return false;
  }
}

struct State {
  int4 Reg[4];
  int4 RawTexColor;
  int4 TexColor;
  int AlphaBump;
};
struct StageState {
  uint stage;
  uint order;
  uint cc;
  uint ac;
};

int4 getRasColor(State s, StageState ss, float4 colors_0, float4 colors_1);
int4 getKonstColor(State s, StageState ss);

// Helper function for Alpha Test
bool alphaCompare(int a, int b, uint compare) {
  if (compare < 4u) {
    if (compare < 2u) {
      if (compare < 1u) {
        return false;  // Never (0)
      } else {
        return a <  b;  // Less (1)
      }
    } else {
      if (compare < 3u) {
        return a == b;  // Equal (2)
      } else {
        return a <= b;  // LEqual (3)
      }
    }
  } else {
    if (compare < 6u) {
      if (compare < 5u) {
        return a >  b;  // Greater (4)
      } else {
        return a != b;  // NEqual (5)
      }
    } else {
      if (compare < 7u) {
        return a >= b;  // GEqual (6)
      } else {
        return true;  // Always (7)
      }
    }
  }
}

int3 selectColorInput(State s, StageState ss, float4 colors_0, float4 colors_1, uint index) {
  if (index < 8u) {
    if (index < 4u) {
      if (index < 2u) {
        if (index < 1u) {
          return s.Reg[0].rgb;  // prev.rgb (0)
        } else {
          return s.Reg[0].aaa;  // prev.aaa (1)
        }
      } else {
        if (index < 3u) {
          return s.Reg[1].rgb;  // c0.rgb (2)
        } else {
          return s.Reg[1].aaa;  // c0.aaa (3)
        }
      }
    } else {
      if (index < 6u) {
        if (index < 5u) {
          return s.Reg[2].rgb;  // c1.rgb (4)
        } else {
          return s.Reg[2].aaa;  // c1.aaa (5)
        }
      } else {
        if (index < 7u) {
          return s.Reg[3].rgb;  // c2.rgb (6)
        } else {
          return s.Reg[3].aaa;  // c2.aaa (7)
        }
      }
    }
  } else {
    if (index < 12u) {
      if (index < 10u) {
        if (index < 9u) {
          return s.TexColor.rgb;  // tex.rgb (8)
        } else {
          return s.TexColor.aaa;  // tex.aaa (9)
        }
      } else {
        if (index < 11u) {
          return getRasColor(s, ss, colors_0, colors_1).rgb;  // ras.rgb (10)
        } else {
          return getRasColor(s, ss, colors_0, colors_1).aaa;  // ras.aaa (11)
        }
      }
    } else {
      if (index < 14u) {
        if (index < 13u) {
          return int3(255, 255, 255);  // ONE (12)
        } else {
          return int3(128, 128, 128);  // HALF (13)
        }
      } else {
        if (index < 15u) {
          return getKonstColor(s, ss).rgb;  // konst.rgb (14)
        } else {
          return int3(0, 0, 0);  // ZERO (15)
        }
      }
    }
  }
}

int selectAlphaInput(State s, StageState ss, float4 colors_0, float4 colors_1, uint index) {
  if (index < 4u) {
    if (index < 2u) {
      if (index < 1u) {
        return s.Reg[0].a;  // prev (0)
      } else {
        return s.Reg[1].a;  // c0 (1)
      }
    } else {
      if (index < 3u) {
        return s.Reg[2].a;  // c1 (2)
      } else {
        return s.Reg[3].a;  // c2 (3)
      }
    }
  } else {
    if (index < 6u) {
      if (index < 5u) {
        return s.TexColor.a;  // tex (4)
      } else {
        return getRasColor(s, ss, colors_0, colors_1).a;  // ras (5)
      }
    } else {
      if (index < 7u) {
        return getKonstColor(s, ss).a;  // konst (6)
      } else {
        return 0;  // ZERO (7)
      }
    }
  }
}

int4 getTevReg(in State s, uint index) {
  if (index < 2u) {
    if (index < 1u) {
      return s.Reg[0];  // prev (0)
    } else {
      return s.Reg[1];  // c0 (1)
    }
  } else {
    if (index < 3u) {
      return s.Reg[2];  // c1 (2)
    } else {
      return s.Reg[3];  // c2 (3)
    }
  }
}

#define getTexCoord(index) selectTexCoord((index), fixpoint_uv0)

void main()
{
  float4 rawpos = gl_FragCoord;
  uint num_stages = bitfieldExtract(uint(bpmem_genmode), 10, 4);

	int layer = 0;
  int3 tevcoord = int3(0, 0, 0);
  State s;
  s.TexColor = int4(0, 0, 0, 0);
  s.RawTexColor = int4(0, 0, 0, 0);
  s.AlphaBump = 0;

  s.Reg[0] = color[0];
  s.Reg[1] = color[1];
  s.Reg[2] = color[2];
  s.Reg[3] = color[3];
  // Main tev loop
  for(uint stage = 0u; stage <= num_stages; stage++)
  {
    StageState ss;
    ss.stage = stage;
    ss.cc = bpmem_combiners(stage).x;
    ss.ac = bpmem_combiners(stage).y;
    ss.order = bpmem_tevorder(stage>>1);
    if ((stage & 1u) == 1u)
      ss.order = ss.order >> 12;

    int2 fixpoint_uv0 = int2((tex0.z == 0.0 ? tex0.xy : tex0.xy / tex0.z) * float2(texdim[0].zw * 128));

    uint tex_coord = bitfieldExtract(uint(ss.order), 3, 3);
    int2 fixedPoint_uv = getTexCoord(tex_coord);

    bool texture_enabled = (ss.order & 64u) != 0u;

    // Indirect textures
    uint tevind = bpmem_tevind(stage);
    if (tevind != 0u)
    {
      uint bs = bitfieldExtract(uint(tevind), 7, 2);
      uint fmt = bitfieldExtract(uint(tevind), 2, 2);
      uint bias = bitfieldExtract(uint(tevind), 4, 3);
      uint bt = bitfieldExtract(uint(tevind), 0, 2);
      uint matrix_index = bitfieldExtract(uint(tevind), 9, 2);
      uint matrix_id = bitfieldExtract(uint(tevind), 11, 2);
      int2 indtevtrans = int2(0, 0);

      if (bpmem_iref(bt) != 0u) {
        int3 indcoord;
{
  uint iref = bpmem_iref(bt);
  uint texcoord = bitfieldExtract(iref, 0, 3);
  uint texmap = bitfieldExtract(iref, 8, 3);
  int2 fixedPoint_uv = getTexCoord(texcoord);

  if ((bt & 1u) == 0u)
    fixedPoint_uv = fixedPoint_uv >> cindscale[bt >> 1].xy;
  else
    fixedPoint_uv = fixedPoint_uv >> cindscale[bt >> 1].zw;

  indcoord = sampleTextureWrapper(texmap, fixedPoint_uv, layer).abg;
}
        if (bs != 0u)
          s.AlphaBump = indcoord[bs - 1u];
        switch(fmt)
        {
        case 0x0u /* ITF_8 */:
          indcoord.x = indcoord.x + ((bias & 1u) != 0u ? -128 : 0);
          indcoord.y = indcoord.y + ((bias & 2u) != 0u ? -128 : 0);
          indcoord.z = indcoord.z + ((bias & 4u) != 0u ? -128 : 0);
          s.AlphaBump = s.AlphaBump & 0xf8;
          break;
        case 0x1u /* ITF_5 */:
          indcoord.x = (indcoord.x >> 3) + ((bias & 1u) != 0u ? 1 : 0);
          indcoord.y = (indcoord.y >> 3) + ((bias & 2u) != 0u ? 1 : 0);
          indcoord.z = (indcoord.z >> 3) + ((bias & 4u) != 0u ? 1 : 0);
          s.AlphaBump = s.AlphaBump << 5;
          break;
        case 0x2u /* ITF_4 */:
          indcoord.x = (indcoord.x >> 4) + ((bias & 1u) != 0u ? 1 : 0);
          indcoord.y = (indcoord.y >> 4) + ((bias & 2u) != 0u ? 1 : 0);
          indcoord.z = (indcoord.z >> 4) + ((bias & 4u) != 0u ? 1 : 0);
          s.AlphaBump = s.AlphaBump << 4;
          break;
        case 0x3u /* ITF_3 */:
          indcoord.x = (indcoord.x >> 5) + ((bias & 1u) != 0u ? 1 : 0);
          indcoord.y = (indcoord.y >> 5) + ((bias & 2u) != 0u ? 1 : 0);
          indcoord.z = (indcoord.z >> 5) + ((bias & 4u) != 0u ? 1 : 0);
          s.AlphaBump = s.AlphaBump << 3;
          break;
        }

        // Matrix multiply
        if (matrix_index != 0u)
        {
          uint mtxidx = 2u * (matrix_index - 1u);
          int shift = cindmtx[mtxidx].w;

          switch (matrix_id)
          {
          case 0u: // 3x2 S0.10 matrix
            indtevtrans = int2(idot(cindmtx[mtxidx].xyz, indcoord), idot(cindmtx[mtxidx + 1u].xyz, indcoord)) >> 3;
            break;
          case 1u: // S matrix, S17.7 format
            indtevtrans = (fixedPoint_uv * indcoord.xx) >> 8;
            break;
          case 2u: // T matrix, S17.7 format
            indtevtrans = (fixedPoint_uv * indcoord.yy) >> 8;
            break;
          }

          if (shift >= 0)
            indtevtrans = indtevtrans >> shift;
          else
            indtevtrans = indtevtrans << ((-shift) & 31);
        }
      }

      // Wrapping
      uint sw = bitfieldExtract(uint(tevind), 13, 3);
      uint tw = bitfieldExtract(uint(tevind), 16, 3); 
      int2 wrapped_coord = int2(Wrap(fixedPoint_uv.x, sw), Wrap(fixedPoint_uv.y, tw));

      if ((tevind & 1048576u) != 0u) // add previous tevcoord
        tevcoord.xy += wrapped_coord + indtevtrans;
      else
        tevcoord.xy = wrapped_coord + indtevtrans;

      // Emulate s24 overflows
      tevcoord.xy = (tevcoord.xy << 8) >> 8;
    }
    else
    {
      tevcoord.xy = fixedPoint_uv;
    }

    // Sample texture for stage
    if (texture_enabled) {
      uint sampler_num = bitfieldExtract(uint(ss.order), 0, 3);

      s.RawTexColor = sampleTextureWrapper(sampler_num, tevcoord.xy, layer);
      uint swap = bitfieldExtract(uint(ss.ac), 2, 2);
      s.TexColor = Swizzle(swap, s.RawTexColor);
    } else {
      // Texture is disabled
      s.TexColor = int4(255, 255, 255, 255);
    }

    // This is the Meat of TEV
    {
      // Color Combiner
      uint color_a = bitfieldExtract(uint(ss.cc), 12, 4);
      uint color_b = bitfieldExtract(uint(ss.cc), 8, 4);
      uint color_c = bitfieldExtract(uint(ss.cc), 4, 4);
      uint color_d = bitfieldExtract(uint(ss.cc), 0, 4);
      uint color_bias = bitfieldExtract(uint(ss.cc), 16, 2);
      bool color_op = bool(bitfieldExtract(uint(ss.cc), 18, 1));
      bool color_clamp = bool(bitfieldExtract(uint(ss.cc), 19, 1));
      uint color_scale = bitfieldExtract(uint(ss.cc), 20, 2);
      uint color_dest = bitfieldExtract(uint(ss.cc), 22, 2);
      uint color_compare_op = color_scale << 1 | uint(color_op);

      int3 color_A = selectColorInput(s, ss, colors_0, colors_1, color_a) & int3(255, 255, 255);
      int3 color_B = selectColorInput(s, ss, colors_0, colors_1, color_b) & int3(255, 255, 255);
      int3 color_C = selectColorInput(s, ss, colors_0, colors_1, color_c) & int3(255, 255, 255);
      int3 color_D = selectColorInput(s, ss, colors_0, colors_1, color_d);  // 10 bits + sign

      int3 color;
      if (color_bias != 3u) { // Normal mode
        color = tevLerp3(color_A, color_B, color_C, color_D, color_bias, color_op, color_scale);
      } else { // Compare mode
        // op 6 and 7 do a select per color channel
        if (color_compare_op == 6u) {
          // TevCompareMode::RGB8, TevComparison::GT
          color.r = (color_A.r > color_B.r) ? color_C.r : 0;
          color.g = (color_A.g > color_B.g) ? color_C.g : 0;
          color.b = (color_A.b > color_B.b) ? color_C.b : 0;
        } else if (color_compare_op == 7u) {
          // TevCompareMode::RGB8, TevComparison::EQ
          color.r = (color_A.r == color_B.r) ? color_C.r : 0;
          color.g = (color_A.g == color_B.g) ? color_C.g : 0;
          color.b = (color_A.b == color_B.b) ? color_C.b : 0;
        } else {
          // The remaining ops do one compare which selects all 3 channels
          color = tevCompare(color_compare_op, color_A, color_B) ? color_C : int3(0, 0, 0);
        }
        color = color_D + color;
      }

      // Clamp result
      if (color_clamp)
        color = clamp(color, 0, 255);
      else
        color = clamp(color, -1024, 1023);

      // Write result to the correct input register of the next stage
      if (color_dest < 2u) {
        if (color_dest < 1u) {
          s.Reg[0].rgb = color;  // prev (0)
        } else {
          s.Reg[1].rgb = color;  // c0 (1)
        }
      } else {
        if (color_dest < 3u) {
          s.Reg[2].rgb = color;  // c1 (2)
        } else {
          s.Reg[3].rgb = color;  // c2 (3)
        }
      }

      // Alpha Combiner
      uint alpha_a = bitfieldExtract(uint(ss.ac), 13, 3);
      uint alpha_b = bitfieldExtract(uint(ss.ac), 10, 3);
      uint alpha_c = bitfieldExtract(uint(ss.ac), 7, 3);
      uint alpha_d = bitfieldExtract(uint(ss.ac), 4, 3);
      uint alpha_bias = bitfieldExtract(uint(ss.ac), 16, 2);
      bool alpha_op = bool(bitfieldExtract(uint(ss.ac), 18, 1));
      bool alpha_clamp = bool(bitfieldExtract(uint(ss.ac), 19, 1));
      uint alpha_scale = bitfieldExtract(uint(ss.ac), 20, 2);
      uint alpha_dest = bitfieldExtract(uint(ss.ac), 22, 2);
      uint alpha_compare_op = alpha_scale << 1 | uint(alpha_op);

      int alpha_A = 0;
      int alpha_B = 0;
      if (alpha_bias != 3u || alpha_compare_op > 5u) {
        // Small optimisation here: alpha_A and alpha_B are unused by compare ops 0-5
        alpha_A = selectAlphaInput(s, ss, colors_0, colors_1, alpha_a) & 255;
        alpha_B = selectAlphaInput(s, ss, colors_0, colors_1, alpha_b) & 255;
      };
      int alpha_C = selectAlphaInput(s, ss, colors_0, colors_1, alpha_c) & 255;
      int alpha_D = selectAlphaInput(s, ss, colors_0, colors_1, alpha_d); // 10 bits + sign


      int alpha;
      if (alpha_bias != 3u) { // Normal mode
        alpha = tevLerp(alpha_A, alpha_B, alpha_C, alpha_D, alpha_bias, alpha_op, alpha_scale);
      } else { // Compare mode
        if (alpha_compare_op == 6u) {
          // TevCompareMode::A8, TevComparison::GT
          alpha = (alpha_A > alpha_B) ? alpha_C : 0;
        } else if (alpha_compare_op == 7u) {
          // TevCompareMode::A8, TevComparison::EQ
          alpha = (alpha_A == alpha_B) ? alpha_C : 0;
        } else {
          // All remaining alpha compare ops actually compare the color channels
          alpha = tevCompare(alpha_compare_op, color_A, color_B) ? alpha_C : 0;
        }
        alpha = alpha_D + alpha;
      }

      // Clamp result
      if (alpha_clamp)
        alpha = clamp(alpha, 0, 255);
      else
        alpha = clamp(alpha, -1024, 1023);

      // Write result to the correct input register of the next stage
      if (alpha_dest < 2u) {
        if (alpha_dest < 1u) {
          s.Reg[0].a = alpha;  // prev (0)
        } else {
          s.Reg[1].a = alpha;  // c0 (1)
        }
      } else {
        if (alpha_dest < 3u) {
          s.Reg[2].a = alpha;  // c1 (2)
        } else {
          s.Reg[3].a = alpha;  // c2 (3)
        }
      }
    }
    } // Main TEV loop

  int4 TevResult;
  TevResult.xyz = getTevReg(s, bitfieldExtract(uint(bpmem_combiners(num_stages).x), 22, 2)).xyz;
  TevResult.w = getTevReg(s, bitfieldExtract(uint(bpmem_combiners(num_stages).y), 22, 2)).w;
  TevResult &= 255;

	int zCoord = czbias[1].x + int((clipPos.z / clipPos.w) * float(czbias[1].y));
  // Depth Texture
  int early_zCoord = zCoord;
  if (bpmem_ztex_op != 0u) {
    int ztex = int(czbias[1].w); // fixed bias

    // Whatever texture was in our last stage, it's now our depth texture
    ztex += idot(s.RawTexColor.xyzw, czbias[0].xyzw);
    ztex += (bpmem_ztex_op == 1u) ? zCoord : 0;
    zCoord = ztex & 0xFFFFFF;
  }

  // Alpha Test
  #define discard_fragment discard
  if (bpmem_alphaTest != 0u) {
    bool comp0 = alphaCompare(TevResult.a, alphaRef.r, bitfieldExtract(uint(bpmem_alphaTest), 16, 3));
    bool comp1 = alphaCompare(TevResult.a, alphaRef.g, bitfieldExtract(uint(bpmem_alphaTest), 19, 3));

    // These if statements are written weirdly to work around intel and Qualcomm bugs with handling booleans.
    switch (bitfieldExtract(uint(bpmem_alphaTest), 22, 2)) {
    case 0u: // AND
      if (comp0 && comp1) break; else discard_fragment; break;
    case 1u: // OR
      if (comp0 || comp1) break; else discard_fragment; break;
    case 2u: // XOR
      if (comp0 != comp1) break; else discard_fragment; break;
    case 3u: // XNOR
      if (comp0 == comp1) break; else discard_fragment; break;
    }
  }

  // Hardware testing indicates that an alpha of 1 can pass an alpha test,
  // but doesn't do anything in blending
  if (TevResult.a == 1) TevResult.a = 0;
  if (bpmem_dither) {
    // Flipper uses a standard 2x2 Bayer Matrix for 6 bit dithering
    // Here the matrix is encoded into the two factor constants
    int2 dither = int2(rawpos.xy) & 1;
    TevResult.rgb = (TevResult.rgb - (TevResult.rgb >> 6)) + (dither.x ^ dither.y) * 2 + dither.y;
  }

  // Fog
  uint fog_function = bitfieldExtract(uint(bpmem_fogParam3), 21, 3);
  if (fog_function != 0x0u /* Off (no fog) */) {
    // TODO: This all needs to be converted from float to fixed point
    float ze;
    if (bitfieldExtract(uint(bpmem_fogParam3), 20, 1) == 0u) {
      // perspective
      // ze = A/(B - (Zs >> B_SHF)
      ze = (cfogf.x * 16777216.0) / float(cfogi.y - (zCoord >> cfogi.w));
    } else {
      // orthographic
      // ze = a*Zs    (here, no B_SHF)
      ze = cfogf.x * float(zCoord) / 16777216.0;
    }

    if (bool(bitfieldExtract(uint(bpmem_fogRangeBase), 10, 1))) {
      // x_adjust = sqrt((x-center)^2 + k^2)/k
      // ze *= x_adjust
      float offset = (2.0 * (rawpos.x / cfogf.w)) - 1.0 - cfogf.z;
      float floatindex = clamp(9.0 - abs(offset) * 9.0, 0.0, 9.0);
      uint indexlower = uint(floatindex);
      uint indexupper = indexlower + 1u;
      float klower = cfogrange[indexlower >> 2u][indexlower & 3u];
      float kupper = cfogrange[indexupper >> 2u][indexupper & 3u];
      float k = lerp(klower, kupper, frac(floatindex));
      float x_adjust = sqrt(offset * offset + k * k) / k;
      ze *= x_adjust;
    }

    float fog = clamp(ze - cfogf.y, 0.0, 1.0);

    if (fog_function >= 0x4u /* Exponential fog */) {
      switch (fog_function) {
      case 0x4u /* Exponential fog */:
        fog = 1.0 - exp2(-8.0 * fog);
        break;
      case 0x5u /* Exponential-squared fog */:
        fog = 1.0 - exp2(-8.0 * fog * fog);
        break;
      case 0x6u /* Backwards exponential fog */:
        fog = exp2(-8.0 * (1.0 - fog));
        break;
      case 0x7u /* Backwards exponenential-sequared fog */:
        fog = 1.0 - fog;
        fog = exp2(-8.0 * fog * fog);
        break;
      }
    }

    int ifog = iround(fog * 256.0);
    TevResult.rgb = (TevResult.rgb * (256 - ifog) + cfogcolor.rgb * ifog) >> 8;
  }

  // Helpers for logic op blending approximations
  if (logic_op_enable) {
    switch (logic_op_mode) {
      case 0: // Clear
        TevResult = int4(0, 0, 0, 0);
        break;
      case 12: // Copy Inverted
        TevResult ^= 0xff;
        break;
      case 15: // Set
      case 10: // Invert
        TevResult = int4(255, 255, 255, 255);
        break;
      default:
        break;
    }
  }
  if (bpmem_rgba6_format)
    ocol0.rgb = float3(TevResult.rgb >> 2) / 63.0;
  else
    ocol0.rgb = float3(TevResult.rgb) / 255.0;

  if (bpmem_dstalpha != 0u)
    ocol0.a = float(bitfieldExtract(uint(bpmem_dstalpha), 0, 8) >> 2) / 63.0;
  else
    ocol0.a = float(TevResult.a >> 2) / 63.0;
  
  // Dest alpha override (dual source blending)
  // Colors will be blended against the alpha from ocol1 and
  // the alpha from ocol0 will be written to the framebuffer.
  ocol1 = float4(0.0, 0.0, 0.0, float(TevResult.a) / 255.0);
}

int4 getRasColor(State s, StageState ss, float4 colors_0, float4 colors_1) {
  // Select Ras for stage
  uint ras = bitfieldExtract(uint(ss.order), 7, 3);
  if (ras < 2u) { // Lighting Channel 0 or 1
    int4 color = iround(((ras == 0u) ? colors_0 : colors_1) * 255.0);
    uint swap = bitfieldExtract(uint(ss.ac), 0, 2);
    return Swizzle(swap, color);
  } else if (ras == 5u) { // Alpha Bump
    return int4(s.AlphaBump, s.AlphaBump, s.AlphaBump, s.AlphaBump);
  } else if (ras == 6u) { // Normalzied Alpha Bump
    int normalized = s.AlphaBump | s.AlphaBump >> 5;
    return int4(normalized, normalized, normalized, normalized);
  } else {
    return int4(0, 0, 0, 0);
  }
}

int4 getKonstColor(State s, StageState ss) {
  // Select Konst for stage
  // TODO: a switch case might be better here than an dynamically  // indexed uniform lookup
  uint tevksel = bpmem_tevksel(ss.stage>>1);
  if ((ss.stage & 1u) == 0u)
    return int4(konstLookup[bitfieldExtract(uint(tevksel), 4, 5)].rgb, konstLookup[bitfieldExtract(uint(tevksel), 9, 5)].a);
  else
    return int4(konstLookup[bitfieldExtract(uint(tevksel), 14, 5)].rgb, konstLookup[bitfieldExtract(uint(tevksel), 19, 5)].a);
}

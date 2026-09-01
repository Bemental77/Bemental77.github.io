// emit_shader.cpp
//
// Native harness that drives Dolphin's REAL ubershader GLSL generators and
// dumps the raw generator buffer (NO #version/macro preamble) for both the
// pixel and vertex ubershaders. Used as a WebGPU go/no-go gate.
//
// Build: see gamecube/wgsl/build_emit.sh
//
// We deliberately emit only ShaderCode::GetBuffer() -- the generator output --
// without the GLSL header that the real backend prepends. A separate step adds
// the preamble.

#include <cstdio>
#include <cstring>
#include <fstream>
#include <string>

#include "VideoCommon/VideoCommon.h"        // APIType
#include "VideoCommon/ShaderGenCommon.h"    // ShaderHostConfig, ShaderCode
#include "VideoCommon/UberShaderPixel.h"    // GenPixelShader, pixel_ubershader_uid_data
#include "VideoCommon/UberShaderVertex.h"   // GenVertexShader, vertex_ubershader_uid_data

static void write_file(const char* path, const std::string& contents)
{
  std::ofstream os(path, std::ios::binary | std::ios::trunc);
  os.write(contents.data(), static_cast<std::streamsize>(contents.size()));
  os.close();
}

int main()
{
  // ---- Host config (common case) ---------------------------------------
  ShaderHostConfig host_config;
  host_config.bits = 0;

  host_config.backend_dual_source_blend = true;
  host_config.backend_bitfield = true;
  host_config.backend_dynamic_sampler_indexing = false;
  host_config.backend_geometry_shaders = false;
  host_config.per_pixel_lighting = false;
  host_config.msaa = false;
  host_config.ssaa = false;
  host_config.stereo = false;
  host_config.bounding_box = false;
  host_config.backend_shader_framebuffer_fetch = false;
  host_config.manual_texture_sampling = false;
  // [WGPU C1 2026-07-13] The WGPU backend advertises bSupportsClipControl=true (WGPUMain.cpp),
  // so the C++ fills cpixelcenter for the [0,1] clip volume. Without this the generator emits
  // the GL remap `o.pos.z = z*2 - w`, which under WebGPU's [0,w] clip discards the near half of
  // the depth range (audit wf_a86451c3; previously hand-deleted from the baked header).
  host_config.backend_clip_control = true;

  // ---- Pixel ubershader UID --------------------------------------------
  UberShader::pixel_ubershader_uid_data pix_uid;
  std::memset(&pix_uid, 0, sizeof(pix_uid));
  // [WGPU C1 2026-07-13] 8 texgens (was 1). The backend bakes ONE WGSL pair for every pipeline
  // (CreateShaderFromSource substitutes it), so the pair must carry all 8 texcoord interpolants;
  // with num_texgens=1 every TEV stage sampled texcoord0 at texdims[0] scale — chroma/detail
  // textures sampled at the wrong UV scale (gray base + offset color ghosts, audit wf_a86451c3).
  pix_uid.num_texgens = 8;
  pix_uid.early_depth = 0;
  pix_uid.per_pixel_depth = 0;
  pix_uid.uint_output = 0;
  pix_uid.no_dual_src = 0;

  // ---- Vertex ubershader UID -------------------------------------------
  UberShader::vertex_ubershader_uid_data vert_uid;
  std::memset(&vert_uid, 0, sizeof(vert_uid));
  vert_uid.num_texgens = 8;  // must match pix_uid (interpolant set is shared)

  // ---- Generate (VULKAN path: separate-descriptor sets/bindings) --------
  ShaderCode pix = UberShader::GenPixelShader(APIType::Vulkan, host_config, &pix_uid);
  ShaderCode vert = UberShader::GenVertexShader(APIType::Vulkan, host_config, &vert_uid);

  const std::string& pix_src = pix.GetBuffer();
  const std::string& vert_src = vert.GetBuffer();

  // ---- Write files ------------------------------------------------------
  write_file("gamecube/wgsl/dolphin_gen_vk.frag.glsl", pix_src);
  write_file("gamecube/wgsl/dolphin_gen_vk.vert.glsl", vert_src);

  // ---- Print to stdout, delimited --------------------------------------
  std::printf("===PIXEL_SHADER_BEGIN===\n");
  std::fwrite(pix_src.data(), 1, pix_src.size(), stdout);
  std::printf("\n===PIXEL_SHADER_END===\n");

  std::printf("===VERTEX_SHADER_BEGIN===\n");
  std::fwrite(vert_src.data(), 1, vert_src.size(), stdout);
  std::printf("\n===VERTEX_SHADER_END===\n");

  std::fprintf(stderr, "[emit_shader] pixel buffer = %zu bytes, vertex buffer = %zu bytes\n",
               pix_src.size(), vert_src.size());
  return 0;
}

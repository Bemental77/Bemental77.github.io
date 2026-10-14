#pragma once
#include "hw/pvr/ta_structs.h"
#include "hw/pvr/ta_ctx.h"
#include "hw/pvr/elan_struct.h"
#include "rend/TexCache.h"
#include "wsi/gl_context.h"
#include "glcache.h"
#include "rend/shader_util.h"
#include "rend/transform_matrix.h"
#ifndef LIBRETRO
#include "ui/imgui_driver.h"
#endif

#include <unordered_map>
#include <glm/glm.hpp>

#ifndef GL_TEXTURE_MAX_ANISOTROPY
#define GL_TEXTURE_MAX_ANISOTROPY         0x84FE
#endif
#ifndef GL_MAX_TEXTURE_MAX_ANISOTROPY
#define GL_MAX_TEXTURE_MAX_ANISOTROPY     0x84FF
#endif
#ifndef GL_PRIMITIVE_RESTART_FIXED_INDEX
#define GL_PRIMITIVE_RESTART_FIXED_INDEX  0x8D69
#endif
#ifndef GL_RGBA8
#define GL_RGBA8 0x8058
#endif
#ifndef GL_R8
#define GL_R8 0x8229
#endif

// ---------------------------------------------------------------------------
// glCheck() — GL error check at a renderer call site.
//
// Upstream this is `verify(glGetError()==GL_NO_ERROR)` gated on
// config::OpenGlChecks.  In THIS build that gate is DEAD, so all 44 call sites
// under core/rend/gles/ and core/rend/gl4/ are runtime no-ops:
//   * core/cfg/option.cpp has `Option<bool> OpenGlChecks("OpenGlChecks", false, "validate")`,
//     but the libretro shell overrides that TU with
//     shell/libretro/option.cpp `Option<bool> OpenGlChecks("", false)` —
//     default false AND an EMPTY core-option name, so it is not user-settable.
//   * Nothing in dreamcast/flycast-bridge/ sets it.
// On a phone that means a GL error only the mobile driver raises is discarded
// silently and the session produces no evidence at all.
//
// Under Emscripten we therefore make glCheck() LOG instead of trap:
//
//   * LOG, never verify()/abort.  An abort on a device tells us strictly less
//     than a message: we would get one failure with no context instead of the
//     whole sequence of errors leading to it, and the page would die before
//     the log could be read off the screen.
//
//   * WARN_LOG(RENDERER, ...) is the transport ON PURPOSE — it is the only one
//     that reaches the phone's screen.  Route, each hop read:
//       WARN_LOG (core/log/Log.h) -> GenericLog
//         -> LogManager::LogWithFullPath (shell/libretro/LogManager.cpp)
//         -> retro_printf, i.e. flycast_log_cb
//            (dreamcast/flycast-bridge/EmscriptenWorker.cpp, registered from
//             environment_cb's RETRO_ENVIRONMENT_GET_LOG_INTERFACE case)
//         -> MAIN_THREAD_EM_ASM postMessage({cmd:'print', txt:'[flycast.log] '...})
//         -> dreamcast.html's worker onmessage `case 'print': pageLog(d.txt)`
//         -> the page's #log element.
//     A bare printf/console.log from the worker does NOT reach the page.
//     WARN_LOG also survives the NDEBUG log-level cut: MAX_LOGLEVEL is
//     LWARNING there (core/log/Log.h, the `#if !defined(NDEBUG)` block), so
//     INFO_LOG/DEBUG_LOG would be compiled out of this build entirely.
//
// KNOWN BLIND SPOT: GL_INVALID_ENUM (0x0500) can never appear here.  The
// worker-side JS shim drains it before it reaches C —
// dreamcast/flycast-bridge/webgl2-compat.js drains 0x500 in its ctx.getError
// wrapper, deliberately, because GLGraphicsContext::findGLVersion()
// (core/wsi/gl_context.cpp) reads a 0x500 following glGetIntegerv(GL_MAJOR_VERSION)
// as "this is GLES2" and would downgrade the whole renderer.  That shim now
// COUNTS and WARNs what it swallows ("[glcompat] swallowed GL_INVALID_ENUM"),
// so look there for 0x500, not here.
//
// ***** OFF BY DEFAULT — AND MUST BE OFF FOR ANY PERF MEASUREMENT. *****
// glGetError() under WebGL is a SYNCHRONOUS round-trip: it flushes the pending
// command buffer and blocks until the GL side answers.  Several call sites sit
// directly on per-draw paths — the glDrawElements lines in
// core/rend/gles/gldraw.cpp and core/rend/gl4/gldraw.cpp, and the per-param
// SetCull/glDrawArrays lines in core/rend/gl4/abuffer.cpp all end in
// `; glCheck();` — so enabling this serializes the renderer against every
// draw.  An fps / MHz / frame-count / "it wedged" reading taken from a build
// with FLYCAST_GL_CHECKS on is not a measurement of anything — same rule and
// the same reason as -DFLYCAST_BRIDGE_DIAG (see the DIAG-flavor block in
// dreamcast/flycast-bridge/flycast_worker_link.sh, where the per-access trace
// stalled the guest badly enough to look like a boot wedge).  The one-shot
// banner below exists so a screenshot from a device can never be mistaken for
// a clean run.
//
// Opt in the same way the bridge diag flavors do — a compile define, absent by
// default:   -DFLYCAST_GL_CHECKS
//
// NOTE, and this differs from the bridge diag flags: FLYCAST_BRIDGE_DIAG and
// DEBUG_DISPATCH reach ONLY the bridge TUs on the emcc link line, so those are
// re-link-only.  gles.h is compiled into the flycast_libretro STATIC ARCHIVE,
// so toggling FLYCAST_GL_CHECKS requires rebuilding the archive
// (`emmake make`), not just re-running the link script.
// ---------------------------------------------------------------------------
#if defined(__EMSCRIPTEN__) && defined(FLYCAST_GL_CHECKS)

// Flood budget.  A GL error raised inside a per-draw path repeats on every
// single draw call, and an unbounded per-event log is a proven hazard in this
// project: the per-access [gdrom] trace emitted 51,867 of 53,319 console lines
// in one 60s run and starved the very loop it was watching (the DIAG-flavor
// banner in flycast_worker_link.sh records it).  The first errors identify the failure;
// the rest are the same line.  Budget is intentionally small, and exhaustion
// prints exactly one trailing line so a truncated log is never misread as a
// clean one.
inline int& glCheckLogBudget() { static int budget = 128; return budget; }

inline const char *glCheckErrorName(GLenum err)
{
	switch (err)
	{
	case 0x0500: return "GL_INVALID_ENUM";
	case 0x0501: return "GL_INVALID_VALUE";
	case 0x0502: return "GL_INVALID_OPERATION";
	case 0x0503: return "GL_STACK_OVERFLOW";
	case 0x0504: return "GL_STACK_UNDERFLOW";
	case 0x0505: return "GL_OUT_OF_MEMORY";
	case 0x0506: return "GL_INVALID_FRAMEBUFFER_OPERATION";
	case 0x0507: return "GL_CONTEXT_LOST";
	case 0x9242: return "GL_CONTEXT_LOST_WEBGL";
	default:     return "GL_<unknown>";
	}
}

inline void glCheckImpl(const char *file, int line)
{
	static bool banner = false;
	if (!banner)
	{
		banner = true;
		WARN_LOG(RENDERER, "[glcheck] ENABLED (-DFLYCAST_GL_CHECKS). Every GL call site now does a "
				"synchronous glGetError() round-trip. NO fps / MHz / frame-count / wedge claim "
				"may be made from this build.");
	}
	// glGetError() reports and clears ONE error per call, so drain: otherwise
	// the next site reports this site's error and every attribution is off by
	// one call.  Bounded — a lost context returns GL_CONTEXT_LOST_WEBGL
	// forever and an unbounded drain would spin here.
	GLenum err;
	int drained = 0;
	while ((err = glGetError()) != 0 /* GL_NO_ERROR */ && ++drained <= 8)
	{
		int &budget = glCheckLogBudget();
		if (budget < 0)
			continue;
		if (budget-- == 0)
		{
			WARN_LOG(RENDERER, "[glcheck] log budget exhausted — further GL errors are SILENCED "
					"(checks still run). Earlier [glcheck] lines are the complete evidence.");
			continue;
		}
		WARN_LOG(RENDERER, "[glcheck] %s (0x%04x) at %s:%d", glCheckErrorName(err), (unsigned)err, file, line);
	}
	// One-shot: if the queue will not drain, it will not drain on every
	// subsequent site either, and this line must not become the flood.
	static bool undrainable = false;
	if (drained > 8 && !undrainable)
	{
		undrainable = true;
		WARN_LOG(RENDERER, "[glcheck] error queue did not drain in 8 reads at %s:%d — context likely LOST", file, line);
	}
}

#define glCheck() glCheckImpl(__FILE__, __LINE__)

#else
// Unchanged upstream behavior for native builds, and the zero-cost default for
// the shipping wasm build (config::OpenGlChecks is false and unsettable, so
// this compiles to a predictable never-taken branch).
#define glCheck() do { if (unlikely(config::OpenGlChecks)) { verify(glGetError()==GL_NO_ERROR); } } while(0)
#endif

#define VERTEX_POS_ARRAY 0
#define VERTEX_COL_BASE_ARRAY 1
#define VERTEX_COL_OFFS_ARRAY 2
#define VERTEX_UV_ARRAY 3
// OIT only
#define VERTEX_COL_BASE1_ARRAY 4
#define VERTEX_COL_OFFS1_ARRAY 5
#define VERTEX_UV1_ARRAY 6
// Naomi2
#define VERTEX_NORM_ARRAY 7

void DrawStrips();

struct PipelineShader
{
	GLuint program;

	GLint depth_scale;
	GLint pp_ClipTest;
	GLint cp_AlphaTestValue;
	GLint sp_FOG_COL_RAM;
	GLint sp_FOG_COL_VERT;
	GLint sp_FOG_DENSITY;
	GLint trilinear_alpha;
	GLint fog_clamp_min, fog_clamp_max;
	GLint ndcMat;
	GLint palette_index;
	GLint ditherDivisor;
	GLint texSize;

	// Naomi2
	GLint mvMat;
	GLint normalMat;
	GLint projMat;
	GLint glossCoef[2];
	GLint envMapping[2];
	GLint bumpMapping;
	GLint constantColor[2];

	GLint lightCount;
	GLint ambientBase[2];
	GLint ambientOffset[2];
	GLint ambientMaterialBase[2];
	GLint ambientMaterialOffset[2];
	GLint useBaseOver;
	GLint bumpId0;
	GLint bumpId1;
	struct {
		GLint color;
		GLint direction;
		GLint position;
		GLint parallel;
		GLint diffuse[2];
		GLint specular[2];
		GLint routing;
		GLint dmode;
		GLint smode;
		GLint distAttnMode;
		GLint attnDistA;
		GLint attnDistB;
		GLint attnAngleA;
		GLint attnAngleB;
	} lights[elan::MAX_LIGHTS];

	int lastMvMat;
	int lastNormalMat;
	int lastProjMat;
	int lastLightModel;

	//
	bool cp_AlphaTest;
	bool pp_InsideClipping;
	bool pp_Texture;
	bool pp_UseAlpha;
	bool pp_IgnoreTexA;
	u32 pp_ShadInstr;
	bool pp_Offset;
	u32 pp_FogCtrl;
	bool pp_Gouraud;
	bool pp_BumpMap;
	bool fog_clamping;
	bool trilinear;
	int palette;	// 1 if nearest, 2 if bilinear
	bool naomi2;
	bool divPosZ;
	bool dithering;
};

class GlBuffer
{
public:
	GlBuffer(GLenum type, GLenum usage =  GL_STREAM_DRAW)
		: type(type), usage(usage), size(0) {
		glGenBuffers(1, &name);
	}

	~GlBuffer() {
		glDeleteBuffers(1, &name);
	}

	void bind() const {
		glBindBuffer(type, name);
	}

	GLuint getName() const {
		return name;
	}

	void update(const void *data, GLsizeiptr size)
	{
		bind();
		if (size > this->size)
		{
			glBufferData(type, size, data, usage);
			this->size = size;
		}
		else
		{
			glBufferSubData(type, 0, size, data);
		}
	}

private:
	GLenum type;
	GLenum usage;
	GLsizeiptr size;
	GLuint name;
};

class GlFramebuffer
{
public:
	GlFramebuffer(int width, int height, bool withDepth = false, GLuint texture = 0);
	GlFramebuffer(int width, int height, bool withDepth, bool withTexture);
	~GlFramebuffer();

	void bind(GLenum type = GL_FRAMEBUFFER) const {
		glBindFramebuffer(type, framebuffer);
	}

	int getWidth() const { return width; }
	int getHeight() const { return height; }

	GLuint getTexture() const { return texture; }
	GLuint detachTexture() {
		GLuint t = texture;
		texture = 0;
		return t;
	}
	GLuint getFramebuffer() const { return framebuffer; }

private:
	void makeFramebuffer(bool withDepth);

	int width;
	int height;
	GLuint texture;
	GLuint framebuffer = 0;
	GLuint colorBuffer = 0;
	GLuint depthBuffer = 0;
};

class GlVertexArray
{
public:
	virtual ~GlVertexArray() = default;
	void bind(GlBuffer *buffer, GlBuffer *indexBuffer = nullptr);
	static void unbind();
	void term();

protected:
	virtual void defineVtxAttribs() = 0;

private:
	static void bindVertexArray(GLuint vao);
	GLuint vertexArray = 0;
};

class MainVertexArray final : public GlVertexArray
{
protected:
	void defineVtxAttribs() override;
};

class ModvolVertexArray final : public GlVertexArray
{
protected:
	void defineVtxAttribs() override;
};

class GlQuadDrawer;

struct gl_ctx
{
	struct
	{
		GLuint program;

		GLint depth_scale;
		GLint sp_ShaderColor;
		GLint ndcMat;
	} modvol_shader;

	struct
	{
		GLuint program;

		GLint depth_scale;
		GLint sp_ShaderColor;
		GLint ndcMat;

		GLint mvMat;
		GLint projMat;
	} n2ModVolShader;

	std::unordered_map<u32, PipelineShader> shaders;

	struct
	{
		MainVertexArray mainVAO;
		ModvolVertexArray modvolVAO;
		std::unique_ptr<GlBuffer> geometry;
		std::unique_ptr<GlBuffer> modvols;
		std::unique_ptr<GlBuffer> idxs;
	} vbo;

	struct
	{
		std::unique_ptr<GlFramebuffer> framebuffer;
	} rtt;

	struct
	{
		std::unique_ptr<GlFramebuffer> framebuffer;
		float aspectRatio;
		GLuint origFbo = 0;
		float shiftX, shiftY;
	} ofbo;

	struct
	{
		GLuint tex;
		int width;
		int height;
	} dcfb;

	struct
	{
		std::unique_ptr<GlFramebuffer> framebuffer;
	} fbscaling;

	struct
	{
		std::unique_ptr<GlFramebuffer> framebuffer;
		bool ready = false;
	} ofbo2;

	struct
	{
		std::unique_ptr<GlFramebuffer> framebuffer;
	} videorouting;

	std::unique_ptr<GlQuadDrawer> quad;
	const char *gl_version;
	const char *glsl_version_header;
	int gl_major;
	int gl_minor;
	bool is_gles;
	GLuint single_channel_format;
	GLenum index_type;
	bool GL_OES_packed_depth_stencil_supported;
	bool GL_OES_depth24_supported;
	bool highp_float_supported;
	float max_anisotropy;
	bool mesa_nouveau;
	bool mali;
	bool border_clamp_supported;
	bool prim_restart_supported;
	bool prim_restart_fixed_supported;
	bool bogusBlitFramebuffer;
	rend_context *rendContext = nullptr;
	TransformMatrix matrices;

	size_t get_index_size() { return index_type == GL_UNSIGNED_INT ? sizeof(u32) : sizeof(u16); }
};

extern gl_ctx gl;

inline void GlVertexArray::bindVertexArray(GLuint vao)
{
#ifndef GLES2
	if (gl.gl_major >= 3)
		glBindVertexArray(vao);
#endif
}

inline void GlVertexArray::bind(GlBuffer *buffer, GlBuffer *indexBuffer)
{
	if (vertexArray == 0)
	{
#ifndef GLES2
		if (gl.gl_major >= 3)
		{
			glGenVertexArrays(1, &vertexArray);
			glBindVertexArray(vertexArray);
		}
#endif
		buffer->bind();
		if (indexBuffer != nullptr)
			indexBuffer->bind();
		else
			glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, 0);
		defineVtxAttribs();
	}
	else
	{
		bindVertexArray(vertexArray);
		buffer->bind();
		if (indexBuffer != nullptr)
			indexBuffer->bind();
		else
			glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, 0);
	}
}

inline void GlVertexArray::unbind()
{
	bindVertexArray(0);
}

inline void GlVertexArray::term()
{
#ifndef GLES2
	if (gl.gl_major >= 3)
		glDeleteVertexArrays(1, &vertexArray);
#endif
	vertexArray = 0;
}

enum ModifierVolumeMode { Xor, Or, Inclusion, Exclusion, ModeCount };

void termGLCommon();
void findGLVersion();

void SetCull(u32 CullMode);
void SetMVS_Mode(ModifierVolumeMode mv_mode, ISP_Modvol ispc);

GLuint BindRTT(bool withDepthBuffer = true);
void ReadRTTBuffer();
void glReadFramebuffer(const FramebufferInfo& info);
GLuint init_output_framebuffer(int width, int height);
void writeFramebufferToVRAM();

PipelineShader *GetProgram(bool cp_AlphaTest, bool pp_InsideClipping,
		bool pp_Texture, bool pp_UseAlpha, bool pp_IgnoreTexA, u32 pp_ShadInstr, bool pp_Offset,
		u32 pp_FogCtrl, bool pp_Gouraud, bool pp_BumpMap, bool fog_clamping, bool trilinear,
		int palette, bool naomi2, bool dithering);

GLuint gl_CompileShader(const char* shader, GLuint type);
GLuint gl_CompileAndLink(const char *vertexShader, const char *fragmentShader);
bool CompilePipelineShader(PipelineShader* s);
extern const char* GouraudSource;

extern struct ShaderUniforms_t
{
	float PT_ALPHA;
	float depth_coefs[4];
	float fog_den_float;
	float ps_FOG_COL_RAM[3];
	float ps_FOG_COL_VERT[3];
	float fog_clamp_min[4];
	float fog_clamp_max[4];
	glm::mat4 ndcMat;
	struct {
		bool enabled;
		int x;
		int y;
		int width;
		int height;
	} base_clipping;
	bool dithering;
	float ditherDivisor[4];

	void Set(const PipelineShader* s)
	{
		if (s->cp_AlphaTestValue!=-1)
			glUniform1f(s->cp_AlphaTestValue,PT_ALPHA);

		if (s->depth_scale!=-1)
			glUniform4fv( s->depth_scale, 1, depth_coefs);

		if (s->sp_FOG_DENSITY!=-1)
			glUniform1f( s->sp_FOG_DENSITY,fog_den_float);

		if (s->sp_FOG_COL_RAM!=-1)
			glUniform3fv( s->sp_FOG_COL_RAM, 1, ps_FOG_COL_RAM);

		if (s->sp_FOG_COL_VERT!=-1)
			glUniform3fv( s->sp_FOG_COL_VERT, 1, ps_FOG_COL_VERT);

		if (s->fog_clamp_min != -1)
			glUniform4fv(s->fog_clamp_min, 1, fog_clamp_min);
		if (s->fog_clamp_max != -1)
			glUniform4fv(s->fog_clamp_max, 1, fog_clamp_max);

		if (s->ndcMat != -1)
			glUniformMatrix4fv(s->ndcMat, 1, GL_FALSE, &ndcMat[0][0]);

		if (s->ditherDivisor != -1)
			glUniform4fv(s->ditherDivisor, 1, ditherDivisor);
	}

} ShaderUniforms;

class TextureCacheData final : public BaseTextureCacheData
{
public:
	TextureCacheData(TSP tsp, TCW tcw, int area) : BaseTextureCacheData(tsp, tcw, area) {
	}
	TextureCacheData(TextureCacheData&& other) : BaseTextureCacheData(std::move(other)) {
		std::swap(texID, other.texID);
	}

	GLuint texID = 0;   //gl texture
	std::string GetId() override { return std::to_string(texID); }
	void UploadToGPU(int width, int height, const u8 *temp_tex_buffer, bool mipmapped, bool mipmapsIncluded = false) override;
	bool Delete() override;

	static void setUploadToGPUFlavor();

private:
	void UploadToGPUGl2(int width, int height, const u8 *temp_tex_buffer, bool mipmapped, bool mipmapsIncluded);
	void UploadToGPUGl4(int width, int height, const u8 *temp_tex_buffer, bool mipmapped, bool mipmapsIncluded);

	static void (TextureCacheData::*uploadToGpu)(int, int, const u8 *, bool, bool);
};

class GlTextureCache final : public BaseTextureCache<TextureCacheData>
{
public:
	void Cleanup()
	{
		if (!texturesToDelete.empty())
		{
			glcache.DeleteTextures((GLsizei)texturesToDelete.size(), &texturesToDelete[0]);
			texturesToDelete.clear();
		}
		CollectCleanup();
	}
	void DeleteLater(GLuint texId) { texturesToDelete.push_back(texId); }

private:
	std::vector<GLuint> texturesToDelete;
};
extern GlTextureCache TexCache;

extern const u32 Zfunction[8];
extern const u32 SrcBlendGL[], DstBlendGL[];

struct OpenGLRenderer : Renderer
{
	bool Init() override;
	void Term() override;

	void Process(TA_context* ctx) override;

	bool Render() override;

	void RenderFramebuffer(const FramebufferInfo& info) override;

	bool RenderLastFrame() override
	{
		if (clearLastFrame)
			return false;
		saveCurrentFramebuffer();
		bool ret = renderLastFrame();
		restoreCurrentFramebuffer();

		return ret;
	}
	bool GetLastFrame(std::vector<u8>& data, int& width, int& height) override;

	BaseTextureCacheData *GetTexture(TSP tsp, TCW tcw, int area) override;

	bool Present() override
	{
		if (!frameRendered || clearLastFrame)
			return false;
#ifndef LIBRETRO
		imguiDriver->setFrameRendered();
#endif
		frameRendered = false;
		return true;
	}

protected:
	virtual GLenum getFogTextureSlot() const {
		return GL_TEXTURE1;
	}
	virtual GLenum getPaletteTextureSlot() const {
		return GL_TEXTURE2;
	}

	void saveCurrentFramebuffer() {
#ifdef LIBRETRO
		gl.ofbo.origFbo = glsm_get_current_framebuffer();
#else
		gl.ofbo.origFbo = 0;
		glGetIntegerv(GL_FRAMEBUFFER_BINDING, (GLint *)&gl.ofbo.origFbo);
#endif
	}
	void restoreCurrentFramebuffer() {
		glBindFramebuffer(GL_FRAMEBUFFER, gl.ofbo.origFbo);
	}

	bool renderLastFrame();
	void renderVideoRouting();
	void drawOSD();

private:
	bool renderFrame(int width, int height);

protected:
	bool frameRendered = false;
	int width = 640;
	int height = 480;
	void initVideoRoutingFrameBuffer();
};

extern const char* ShaderCompatSource;
extern const char *VertexCompatShader;
extern const char *PixelCompatShader;

class OpenGlSource : public ShaderSource
{
public:
	OpenGlSource() : ShaderSource(gl.glsl_version_header) {
		addConstant("TARGET_GL", gl.gl_version);
		addSource(ShaderCompatSource);
	}
};

void drawVmusAndCrosshairs(int width, int height);
void termVmuLightgun();

#ifdef LIBRETRO
extern "C" struct retro_hw_render_callback hw_render;
#endif

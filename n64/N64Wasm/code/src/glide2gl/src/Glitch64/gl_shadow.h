/* gl_shadow.h — drop GL calls that cannot change GL state.
 *
 * WHY. Every GL call from this core is a wasm -> JS -> WebGL hop, and in
 * Chrome every WebGL call is validated and serialised into the GPU command
 * buffer whether it changes anything or not. A census of MK64's race
 * (frames 1800-2000, HEAD core) counted ~1950 calls per field, and ~1130 of
 * them re-set state to the value it already had: glTexParameteri 338 of 369
 * (grTexSource re-applies four parameters on every bind), glBindTexture
 * 140 of 179, glUniform* ~300, glActiveTexture 94, glEnable/glDisable 67,
 * glUseProgram 21, glDisableVertexAttribArray 13. With the readback taken
 * out, glTexParameteri alone was 20% of the frame's profile.
 *
 * WHAT. Each shadowed call is compared against the value this file last
 * sent; a call that would set the same value is not sent. A call whose
 * current value is not known is always sent. GL therefore receives a
 * subsequence of the calls it received before, and every call dropped is
 * one GL would have treated as a no-op, so every rendered pixel (and every
 * byte a readback puts in RDRAM) is unchanged.
 *
 * WHEN THE SHADOW MAY BE WRONG, IT IS FORGOTTEN. Only this core's glide
 * (Glitch64) calls go through it. Anything else that touches GL state —
 * glsm's state bind/unbind around every retro_run (it calls GL through
 * rglgen pointers), the frontend's text overlay (mymain.cpp), page/worker JS
 * — runs outside retro_run or touches state this file does not shadow
 * (pack buffer, read framebuffer, pixel store). gls_reset() runs right after
 * glsm's bind at the start of every retro_run (libretronew.c glsm_enter), so
 * nothing learned in one frame is trusted in the next; glsm itself calls GL
 * directly, never through this file.
 *
 * Kill switch: gls_set_enabled(0) (_neil_set_gl_shadow(0) / page ?glshadow=0)
 * sends every call, as before.
 */
#ifndef GLITCH64_GL_SHADOW_H
#define GLITCH64_GL_SHADOW_H

#include <GL/glew.h>

#ifdef __cplusplus
extern "C" {
#endif

void gls_reset(void);
void gls_set_enabled(int on);
int  gls_enabled(void);
void gls_stats(unsigned *sent, unsigned *dropped);

void gls_ActiveTexture(GLenum texture);
void gls_BindTexture(GLenum target, GLuint texture);
void gls_TexParameteri(GLenum target, GLenum pname, GLint param);
void gls_DeleteTextures(GLsizei n, const GLuint *textures);
void gls_UseProgram(GLuint program);
void gls_LinkProgram(GLuint program);
void gls_DeleteProgram(GLuint program);
void gls_Uniform1i(GLint loc, GLint v0);
void gls_Uniform1f(GLint loc, GLfloat v0);
void gls_Uniform3f(GLint loc, GLfloat v0, GLfloat v1, GLfloat v2);
void gls_Uniform4f(GLint loc, GLfloat v0, GLfloat v1, GLfloat v2, GLfloat v3);
void gls_Enable(GLenum cap);
void gls_Disable(GLenum cap);
void gls_EnableVertexAttribArray(GLuint index);
void gls_DisableVertexAttribArray(GLuint index);
void gls_BindVertexArray(GLuint array);
void gls_BlendFuncSeparate(GLenum s0, GLenum d0, GLenum s1, GLenum d1);
void gls_BlendFunc(GLenum sf, GLenum df);
void gls_DepthMask(GLboolean flag);
void gls_DepthFunc(GLenum func);
void gls_PolygonOffset(GLfloat factor, GLfloat units);
void gls_sync_active(void);
void gls_forget_fixed(void);

/* DRAW MERGING (geometry.c): consecutive single-triangle draws that nothing
 * separates are sent as ONE glDrawArrays(GL_TRIANGLES). "Nothing separates"
 * means no GL call reached GL in between, so every call that does reach GL
 * first draws the triangles still held back: GLS_PRE() below, run by every
 * wrapper in this file and by every shadowed call that is actually sent. A
 * call the shadow drops changes nothing, so it does not end a batch. */
extern int  vbuf_merge_pending;
void vbo_merge_flush(void);
#define GLS_PRE() (vbuf_merge_pending ? vbo_merge_flush() : (void)0)

#ifndef GL_SHADOW_IMPL
#define glActiveTexture            gls_ActiveTexture
#define glBindTexture              gls_BindTexture
#define glTexParameteri            gls_TexParameteri
#define glDeleteTextures           gls_DeleteTextures
#define glUseProgram               gls_UseProgram
#define glLinkProgram              gls_LinkProgram
#define glDeleteProgram            gls_DeleteProgram
#define glUniform1i                gls_Uniform1i
#define glUniform1f                gls_Uniform1f
#define glUniform3f                gls_Uniform3f
#define glUniform4f                gls_Uniform4f
#define glEnable                   gls_Enable
#define glDisable                  gls_Disable
#define glEnableVertexAttribArray  gls_EnableVertexAttribArray
#define glDisableVertexAttribArray gls_DisableVertexAttribArray
#define glBindVertexArray          gls_BindVertexArray
#define glBlendFuncSeparate        gls_BlendFuncSeparate
#define glBlendFunc                gls_BlendFunc
#define glDepthMask                gls_DepthMask
#define glDepthFunc                gls_DepthFunc
#define glPolygonOffset            gls_PolygonOffset
/* every other GL entry point this core calls: draw what is held back first */
#define glGetUniformLocation(...) (GLS_PRE(), glGetUniformLocation(__VA_ARGS__))
#define glGetIntegerv(...) (GLS_PRE(), gls_sync_active(), glGetIntegerv(__VA_ARGS__))
#define glBindBuffer(...) (GLS_PRE(), glBindBuffer(__VA_ARGS__))
#define glVertexAttribPointer(...) (GLS_PRE(), glVertexAttribPointer(__VA_ARGS__))
#define glGenTextures(...) (GLS_PRE(), glGenTextures(__VA_ARGS__))
#define glTexImage2D(...) (GLS_PRE(), gls_sync_active(), glTexImage2D(__VA_ARGS__))
#define glBindAttribLocation(...) (GLS_PRE(), glBindAttribLocation(__VA_ARGS__))
#define glPixelStorei(...) (GLS_PRE(), glPixelStorei(__VA_ARGS__))
#define glDrawArrays(...) (GLS_PRE(), glDrawArrays(__VA_ARGS__))
#define glBindSampler(...) (GLS_PRE(), glBindSampler(__VA_ARGS__))
#define glBindFramebuffer(...) (GLS_PRE(), glBindFramebuffer(__VA_ARGS__))
#define glAttachShader(...) (GLS_PRE(), glAttachShader(__VA_ARGS__))
#define glViewport(...) (GLS_PRE(), glViewport(__VA_ARGS__))
#define glShaderSource(...) (GLS_PRE(), glShaderSource(__VA_ARGS__))
#define glReadPixels(...) (GLS_PRE(), glReadPixels(__VA_ARGS__))
#define glCreateShader(...) (GLS_PRE(), glCreateShader(__VA_ARGS__))
#define glCompileShader(...) (GLS_PRE(), glCompileShader(__VA_ARGS__))
#define glColorMask(...) (GLS_PRE(), glColorMask(__VA_ARGS__))
#define glGetShaderiv(...) (GLS_PRE(), glGetShaderiv(__VA_ARGS__))
#define glGetProgramiv(...) (GLS_PRE(), glGetProgramiv(__VA_ARGS__))
#define glGetError(...) (GLS_PRE(), glGetError(__VA_ARGS__))
#define glCullFace(...) (GLS_PRE(), glCullFace(__VA_ARGS__))
#define glCreateProgram(...) (GLS_PRE(), glCreateProgram(__VA_ARGS__))
#define glClear(...) (GLS_PRE(), glClear(__VA_ARGS__))
#define glBufferSubData(...) (GLS_PRE(), glBufferSubData(__VA_ARGS__))
#define glBufferData(...) (GLS_PRE(), glBufferData(__VA_ARGS__))
#define glTexSubImage2D(...) (GLS_PRE(), gls_sync_active(), glTexSubImage2D(__VA_ARGS__))
#define glScissor(...) (GLS_PRE(), glScissor(__VA_ARGS__))
#define glIsProgram(...) (GLS_PRE(), glIsProgram(__VA_ARGS__))
#define glIsEnabled(...) (GLS_PRE(), glIsEnabled(__VA_ARGS__))
#define glGetString(...) (GLS_PRE(), glGetString(__VA_ARGS__))
#define glGetShaderInfoLog(...) (GLS_PRE(), glGetShaderInfoLog(__VA_ARGS__))
#define glGetProgramInfoLog(...) (GLS_PRE(), glGetProgramInfoLog(__VA_ARGS__))
#define glGetBooleanv(...) (GLS_PRE(), gls_sync_active(), glGetBooleanv(__VA_ARGS__))
#define glGenVertexArrays(...) (GLS_PRE(), glGenVertexArrays(__VA_ARGS__))
#define glGenFramebuffers(...) (GLS_PRE(), glGenFramebuffers(__VA_ARGS__))
#define glGenBuffers(...) (GLS_PRE(), glGenBuffers(__VA_ARGS__))
#define glFramebufferTexture2D(...) (GLS_PRE(), glFramebufferTexture2D(__VA_ARGS__))
#define glDrawPixels(...) (GLS_PRE(), glDrawPixels(__VA_ARGS__))
#define glDrawBuffer(...) (GLS_PRE(), glDrawBuffer(__VA_ARGS__))
#define glDeleteBuffers(...) (GLS_PRE(), glDeleteBuffers(__VA_ARGS__))
#define glCopyTexSubImage2D(...) (GLS_PRE(), gls_sync_active(), glCopyTexSubImage2D(__VA_ARGS__))
#define glClearDepth(...) (GLS_PRE(), glClearDepth(__VA_ARGS__))
#define glClearColor(...) (GLS_PRE(), glClearColor(__VA_ARGS__))
#define glDeleteShader(...) (GLS_PRE(), glDeleteShader(__VA_ARGS__))
#define glValidateProgram(...) (GLS_PRE(), glValidateProgram(__VA_ARGS__))
#define glStencilMask(...) (GLS_PRE(), glStencilMask(__VA_ARGS__))
#define glStencilFunc(...) (GLS_PRE(), glStencilFunc(__VA_ARGS__))
#define glStencilOp(...) (GLS_PRE(), glStencilOp(__VA_ARGS__))
#define glFrontFace(...) (GLS_PRE(), glFrontFace(__VA_ARGS__))
#define glDeleteFramebuffers(...) (GLS_PRE(), glDeleteFramebuffers(__VA_ARGS__))
#define glDeleteVertexArrays(...) (GLS_PRE(), glDeleteVertexArrays(__VA_ARGS__))
#define glCheckFramebufferStatus(...) (GLS_PRE(), glCheckFramebufferStatus(__VA_ARGS__))
#define glFinish(...) (GLS_PRE(), glFinish(__VA_ARGS__))
#define glFlush(...) (GLS_PRE(), glFlush(__VA_ARGS__))
#define glCopyTexImage2D(...) (GLS_PRE(), gls_sync_active(), glCopyTexImage2D(__VA_ARGS__))
#define glGenerateMipmap(...) (GLS_PRE(), gls_sync_active(), glGenerateMipmap(__VA_ARGS__))
#define glDepthRangef(...) (GLS_PRE(), glDepthRangef(__VA_ARGS__))
#define glClearStencil(...) (GLS_PRE(), glClearStencil(__VA_ARGS__))
#define glTexParameterf(...) (GLS_PRE(), gls_sync_active(), glTexParameterf(__VA_ARGS__))
#define glTexParameteriv(...) (GLS_PRE(), gls_sync_active(), glTexParameteriv(__VA_ARGS__))
#define glUniform1fv(...) (GLS_PRE(), glUniform1fv(__VA_ARGS__))
#define glUniform2f(...) (GLS_PRE(), glUniform2f(__VA_ARGS__))
#define glUniform4fv(...) (GLS_PRE(), glUniform4fv(__VA_ARGS__))
#define glUniformMatrix4fv(...) (GLS_PRE(), glUniformMatrix4fv(__VA_ARGS__))
#endif

#ifdef __cplusplus
}
#endif

#endif

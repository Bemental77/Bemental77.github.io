/* gl_shadow.c — see gl_shadow.h for why and for the rules.
 *
 * Every piece of shadow state carries the epoch it was learned in; gls_reset()
 * moves to a new epoch, which forgets everything at once. Within an epoch an
 * entry is only ever added or overwritten (a deletion overwrites the value
 * with UNKNOWN and keeps the key), so the open-addressing chains below never
 * lose a link. A lookup that runs off its probe budget treats the value as
 * unknown: the call is sent. Unknown is always safe; only a KNOWN value that
 * equals the requested one drops a call. */
#define GL_SHADOW_IMPL
#include <stdint.h>
#include <string.h>
#include "gl_shadow.h"

static int      gls_on = 1;
static uint32_t gls_ep = 1;
static unsigned gls_sent, gls_dropped, gls_resets;
/* slots claimed in this epoch; past half of a table the epoch is renewed, so
 * chains stay short however many textures/programs come and go in a session */
static unsigned gls_texp_used, gls_uni_used;

#define GLS_UNITS   128
#define GLS_ATTRIBS 16
#define GLS_CAPS    32
#define GLS_TEXP    8192          /* (texture, pname) slots, power of two */
#define GLS_UNI     8192          /* (program, location) slots, power of two */
#define GLS_PROBE   48

/* gls_active: the unit GL has active. gls_want: the unit glide last asked
 * for. glActiveTexture is deferred until a call that depends on the active
 * unit is actually sent (gls_sync_active), so a unit switch followed only by
 * dropped binds/parameters never reaches GL. */
static struct { uint32_t ep; GLenum v; } gls_active, gls_want;
/* fixed-function state glsm also sets (through its own pointers) around every
 * retro_run: forgotten at every glsm bind (gls_forget_fixed) */
static struct { uint32_t ep; GLenum s0, d0, s1, d1; } gls_blend;
static struct { uint32_t ep; GLboolean v; } gls_dmask;
static struct { uint32_t ep; GLenum v; } gls_dfunc;
static struct { uint32_t ep; uint32_t f, u; } gls_poff;
static uint32_t gls_fixed_ep = 1;
static struct { uint32_t ep; GLuint v; } gls_prog, gls_vao;
static struct { uint32_t ep; GLuint tex; } gls_unit[GLS_UNITS];
static struct { uint32_t ep; uint8_t on; } gls_attrib[GLS_ATTRIBS];
static struct { uint32_t ep; GLenum cap; uint8_t on; } gls_cap[GLS_CAPS];

/* texture parameter cache: key = texture name, which pname (0..3) */
static struct { uint32_t ep; GLuint tex; uint8_t p; uint8_t known; GLint v; } gls_texp[GLS_TEXP];
/* uniform cache: key = program, location; value = type tag + 4 raw words */
static struct { uint32_t ep; GLuint prog; GLint loc; uint8_t type; uint8_t known; uint32_t w[4]; } gls_uni[GLS_UNI];

void gls_forget_fixed(void);
void gls_reset(void) { gls_ep++; if (!gls_ep) gls_ep = 1; gls_texp_used = gls_uni_used = 0; gls_resets++; gls_forget_fixed(); }
void gls_sync_active(void);
void gls_set_enabled(int on) { gls_sync_active(); gls_on = on ? 1 : 0; gls_reset(); }
void gls_forget_fixed(void) { gls_fixed_ep++; if (!gls_fixed_ep) gls_fixed_ep = 1; }
int  gls_enabled(void) { return gls_on; }
void gls_stats(unsigned *sent, unsigned *dropped) { if (sent) *sent = gls_sent; if (dropped) *dropped = gls_dropped; }

static inline uint32_t gls_hash(uint32_t a, uint32_t b)
{
   uint32_t h = a * 0x9E3779B1u ^ (b + 0x7F4A7C15u) * 0x85EBCA77u;
   return h ^ (h >> 15);
}

/* ---- textures ---------------------------------------------------------- */

static int gls_pidx(GLenum pname)
{
   switch (pname)
   {
      case GL_TEXTURE_MIN_FILTER: return 0;
      case GL_TEXTURE_MAG_FILTER: return 1;
      case GL_TEXTURE_WRAP_S:     return 2;
      case GL_TEXTURE_WRAP_T:     return 3;
   }
   return -1;
}

/* the slot for (tex, p) in this epoch: an existing one, or a free one to
 * claim (*fresh = 1), or NULL when the probe budget runs out */
static int gls_texp_slot(GLuint tex, int p, int *fresh)
{
   uint32_t i = gls_hash(tex, (uint32_t)p) & (GLS_TEXP - 1);
   int k;
   for (k = 0; k < GLS_PROBE; k++, i = (i + 1) & (GLS_TEXP - 1))
   {
      if (gls_texp[i].ep != gls_ep) { *fresh = 1; return (int)i; }
      if (gls_texp[i].tex == tex && gls_texp[i].p == p) { *fresh = 0; return (int)i; }
   }
   return -1;
}

void gls_sync_active(void)
{
   if (gls_want.ep != gls_ep) return;                       /* nothing deferred */
   if (gls_active.ep == gls_ep && gls_active.v == gls_want.v) return;
   GLS_PRE(); glActiveTexture(gls_want.v); gls_sent++;
   gls_active.ep = gls_ep; gls_active.v = gls_want.v;
}

void gls_ActiveTexture(GLenum texture)
{
   if (!gls_on)
   {
      GLS_PRE(); glActiveTexture(texture); gls_sent++;
      gls_active.ep = gls_ep; gls_active.v = texture;
      gls_want = gls_active;
      return;
   }
   if (gls_want.ep == gls_ep && gls_want.v == texture) { gls_dropped++; return; }
   gls_want.ep = gls_ep; gls_want.v = texture;              /* sent when something needs it */
   gls_dropped++;
}

/* the unit glide addresses (the one it last made active), or -1 if unknown */
static int gls_cur_unit(void)
{
   uint32_t u;
   if (gls_want.ep != gls_ep) return -1;
   u = gls_want.v - GL_TEXTURE0;
   return u < GLS_UNITS ? (int)u : -1;
}

void gls_BindTexture(GLenum target, GLuint texture)
{
   int u = (target == GL_TEXTURE_2D) ? gls_cur_unit() : -1;
   if (gls_on && u >= 0 && gls_unit[u].ep == gls_ep && gls_unit[u].tex == texture) { gls_dropped++; return; }
   gls_sync_active();
   GLS_PRE(); glBindTexture(target, texture); gls_sent++;
   if (target != GL_TEXTURE_2D) return;
   if (u >= 0) { gls_unit[u].ep = gls_ep; gls_unit[u].tex = texture; }
}

void gls_TexParameteri(GLenum target, GLenum pname, GLint param)
{
   int u = (target == GL_TEXTURE_2D) ? gls_cur_unit() : -1;
   int p = gls_pidx(pname), s = -1, fresh = 0;
   GLuint tex = 0;
   if (gls_on && u >= 0 && p >= 0 && gls_unit[u].ep == gls_ep)
   {
      tex = gls_unit[u].tex;
      if (tex) s = gls_texp_slot(tex, p, &fresh);
      if (s >= 0 && !fresh && gls_texp[s].known && gls_texp[s].v == param) { gls_dropped++; return; }
   }
   gls_sync_active();
   GLS_PRE(); glTexParameteri(target, pname, param); gls_sent++;
   if (s >= 0)
   {
      gls_texp[s].ep = gls_ep; gls_texp[s].tex = tex; gls_texp[s].p = (uint8_t)p;
      gls_texp[s].known = 1; gls_texp[s].v = param;
      if (fresh && ++gls_texp_used > GLS_TEXP / 2) gls_reset();
   }
}

void gls_DeleteTextures(GLsizei n, const GLuint *textures)
{
   GLsizei i;
   int u, p, s, fresh;
   GLS_PRE(); glDeleteTextures(n, textures); gls_sent++;
   for (i = 0; i < n; i++)
   {
      GLuint t = textures[i];
      if (!t) continue;
      /* GL unbinds a deleted texture from every unit it is bound to */
      for (u = 0; u < GLS_UNITS; u++)
         if (gls_unit[u].ep == gls_ep && gls_unit[u].tex == t) gls_unit[u].tex = 0;
      for (p = 0; p < 4; p++)
      {
         s = gls_texp_slot(t, p, &fresh);
         if (s >= 0 && !fresh) gls_texp[s].known = 0;
      }
   }
}

/* ---- programs and uniforms ---------------------------------------------- */

void gls_UseProgram(GLuint program)
{
   if (gls_on && gls_prog.ep == gls_ep && gls_prog.v == program) { gls_dropped++; return; }
   GLS_PRE(); glUseProgram(program); gls_sent++;
   gls_prog.ep = gls_ep; gls_prog.v = program;
}

static void gls_forget_program(GLuint program)
{
   int i;
   for (i = 0; i < GLS_UNI; i++)
      if (gls_uni[i].ep == gls_ep && gls_uni[i].prog == program) gls_uni[i].known = 0;
}

void gls_LinkProgram(GLuint program)
{
   GLS_PRE(); glLinkProgram(program); gls_sent++;
   gls_forget_program(program);          /* a (re)link resets every uniform to 0 */
}

void gls_DeleteProgram(GLuint program)
{
   GLS_PRE(); glDeleteProgram(program); gls_sent++;
   gls_forget_program(program);
}

/* 1 = the uniform already holds exactly these words (drop the call);
 * otherwise *slot is where to record them after sending (-1 = do not) */
static int gls_uni_same(GLint loc, uint8_t type, const uint32_t *w, int n, int *slot)
{
   uint32_t i;
   int k;
   GLuint prog;
   *slot = -1;
   if (!gls_on || loc < 0 || gls_prog.ep != gls_ep || !gls_prog.v) return 0;
   prog = gls_prog.v;
   i = gls_hash(prog, (uint32_t)loc) & (GLS_UNI - 1);
   for (k = 0; k < GLS_PROBE; k++, i = (i + 1) & (GLS_UNI - 1))
   {
      if (gls_uni[i].ep != gls_ep) { *slot = (int)i; return 0; }
      if (gls_uni[i].prog == prog && gls_uni[i].loc == loc)
      {
         *slot = (int)i;
         return gls_uni[i].known && gls_uni[i].type == type && !memcmp(gls_uni[i].w, w, (size_t)n * 4);
      }
   }
   return 0;
}

static void gls_uni_put(int s, GLint loc, uint8_t type, const uint32_t *w, int n)
{
   int fresh;
   if (s < 0) return;
   fresh = gls_uni[s].ep != gls_ep;
   gls_uni[s].ep = gls_ep; gls_uni[s].prog = gls_prog.v; gls_uni[s].loc = loc;
   gls_uni[s].type = type; gls_uni[s].known = 1;
   memset(gls_uni[s].w, 0, sizeof(gls_uni[s].w));
   memcpy(gls_uni[s].w, w, (size_t)n * 4);
   if (fresh && ++gls_uni_used > GLS_UNI / 2) gls_reset();
}

void gls_Uniform1i(GLint loc, GLint v0)
{
   uint32_t w[1]; int s;
   memcpy(w, &v0, 4);
   if (gls_uni_same(loc, 1, w, 1, &s)) { gls_dropped++; return; }
   GLS_PRE(); glUniform1i(loc, v0); gls_sent++;
   gls_uni_put(s, loc, 1, w, 1);
}

void gls_Uniform1f(GLint loc, GLfloat v0)
{
   uint32_t w[1]; int s;
   memcpy(w, &v0, 4);
   if (gls_uni_same(loc, 2, w, 1, &s)) { gls_dropped++; return; }
   GLS_PRE(); glUniform1f(loc, v0); gls_sent++;
   gls_uni_put(s, loc, 2, w, 1);
}

void gls_Uniform3f(GLint loc, GLfloat v0, GLfloat v1, GLfloat v2)
{
   uint32_t w[3]; int s;
   memcpy(&w[0], &v0, 4); memcpy(&w[1], &v1, 4); memcpy(&w[2], &v2, 4);
   if (gls_uni_same(loc, 3, w, 3, &s)) { gls_dropped++; return; }
   GLS_PRE(); glUniform3f(loc, v0, v1, v2); gls_sent++;
   gls_uni_put(s, loc, 3, w, 3);
}

void gls_Uniform4f(GLint loc, GLfloat v0, GLfloat v1, GLfloat v2, GLfloat v3)
{
   uint32_t w[4]; int s;
   memcpy(&w[0], &v0, 4); memcpy(&w[1], &v1, 4); memcpy(&w[2], &v2, 4); memcpy(&w[3], &v3, 4);
   if (gls_uni_same(loc, 4, w, 4, &s)) { gls_dropped++; return; }
   GLS_PRE(); glUniform4f(loc, v0, v1, v2, v3); gls_sent++;
   gls_uni_put(s, loc, 4, w, 4);
}

/* ---- capabilities --------------------------------------------------------- */

static void gls_capset(GLenum cap, int on)
{
   int i, free_i = -1;
   for (i = 0; i < GLS_CAPS; i++)
   {
      if (gls_cap[i].ep == gls_ep && gls_cap[i].cap == cap)
      {
         if (gls_on && gls_cap[i].on == on) { gls_dropped++; return; }
         free_i = i; break;
      }
      if (free_i < 0 && gls_cap[i].ep != gls_ep) free_i = i;
   }
   GLS_PRE(); if (on) glEnable(cap); else glDisable(cap);
   gls_sent++;
   if (free_i >= 0) { gls_cap[free_i].ep = gls_ep; gls_cap[free_i].cap = cap; gls_cap[free_i].on = (uint8_t)on; }
}

void gls_Enable(GLenum cap)  { gls_capset(cap, 1); }
void gls_Disable(GLenum cap) { gls_capset(cap, 0); }

/* ---- vertex attribute arrays (VAO state) ---------------------------------- */

static void gls_attrset(GLuint index, int on)
{
   if (gls_on && index < GLS_ATTRIBS && gls_attrib[index].ep == gls_ep && gls_attrib[index].on == on) { gls_dropped++; return; }
   GLS_PRE(); if (on) glEnableVertexAttribArray(index); else glDisableVertexAttribArray(index);
   gls_sent++;
   if (index < GLS_ATTRIBS) { gls_attrib[index].ep = gls_ep; gls_attrib[index].on = (uint8_t)on; }
}

void gls_EnableVertexAttribArray(GLuint index)  { gls_attrset(index, 1); }
void gls_DisableVertexAttribArray(GLuint index) { gls_attrset(index, 0); }

void gls_BindVertexArray(GLuint array)
{
   int i;
   GLS_PRE(); glBindVertexArray(array); gls_sent++;
   if (gls_vao.ep == gls_ep && gls_vao.v == array) return;
   /* the enabled-array flags belong to the VAO: a different one has its own */
   for (i = 0; i < GLS_ATTRIBS; i++) gls_attrib[i].ep = 0;
   gls_vao.ep = gls_ep; gls_vao.v = array;
}

/* ---- blending, depth (also set by glsm: see gls_forget_fixed) ------------- */

void gls_BlendFuncSeparate(GLenum s0, GLenum d0, GLenum s1, GLenum d1)
{
   if (gls_on && gls_blend.ep == gls_fixed_ep && gls_blend.s0 == s0 && gls_blend.d0 == d0
         && gls_blend.s1 == s1 && gls_blend.d1 == d1) { gls_dropped++; return; }
   GLS_PRE(); glBlendFuncSeparate(s0, d0, s1, d1); gls_sent++;
   gls_blend.ep = gls_fixed_ep; gls_blend.s0 = s0; gls_blend.d0 = d0; gls_blend.s1 = s1; gls_blend.d1 = d1;
}

void gls_BlendFunc(GLenum sf, GLenum df)
{
   /* glBlendFunc(s, d) sets exactly what glBlendFuncSeparate(s, d, s, d) sets */
   if (gls_on && gls_blend.ep == gls_fixed_ep && gls_blend.s0 == sf && gls_blend.d0 == df
         && gls_blend.s1 == sf && gls_blend.d1 == df) { gls_dropped++; return; }
   GLS_PRE(); glBlendFunc(sf, df); gls_sent++;
   gls_blend.ep = gls_fixed_ep; gls_blend.s0 = sf; gls_blend.d0 = df; gls_blend.s1 = sf; gls_blend.d1 = df;
}

void gls_DepthMask(GLboolean flag)
{
   if (gls_on && gls_dmask.ep == gls_fixed_ep && gls_dmask.v == flag) { gls_dropped++; return; }
   GLS_PRE(); glDepthMask(flag); gls_sent++;
   gls_dmask.ep = gls_fixed_ep; gls_dmask.v = flag;
}

void gls_DepthFunc(GLenum func)
{
   if (gls_on && gls_dfunc.ep == gls_fixed_ep && gls_dfunc.v == func) { gls_dropped++; return; }
   GLS_PRE(); glDepthFunc(func); gls_sent++;
   gls_dfunc.ep = gls_fixed_ep; gls_dfunc.v = func;
}

void gls_PolygonOffset(GLfloat factor, GLfloat units)
{
   uint32_t f, u;
   memcpy(&f, &factor, 4); memcpy(&u, &units, 4);
   if (gls_on && gls_poff.ep == gls_fixed_ep && gls_poff.f == f && gls_poff.u == u) { gls_dropped++; return; }
   GLS_PRE(); glPolygonOffset(factor, units); gls_sent++;
   gls_poff.ep = gls_fixed_ep; gls_poff.f = f; gls_poff.u = u;
}

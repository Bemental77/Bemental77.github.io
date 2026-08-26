// [wasm-recomp 2026-08-21] Portable-C implementation of the GameCube MTX/VEC/QUAT
// math the game references. The SDK ships PSMTX* (PowerPC paired-single asm) and
// C_MTX* (portable C) variants of the SAME operations; this file provides both
// symbol sets from standard linear-algebra definitions so the decomp's asm-bodied
// math translation units can be excluded from the wasm compile. These are my own
// implementations of well-known matrix/vector math, not the SDK source. Signatures
// match include/dolphin/mtx.h + vec.h (Mtx = f32[3][4], ROMtx = f32[4][3],
// Mtx44 = f32[4][4], Vec = {x,y,z}). Projection matrices follow the documented GC
// convention and may need calibration against the live render.
#include <dolphin/mtx.h>
// dolphin/vec.h does not exist in the decomp — Vec comes from mtx.h -> GeoTypes.h.
#include <math.h>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

/* ---------------- Mtx (3x4 affine) ---------------- */

static void mtx_ident(Mtx m) {
  m[0][0]=1;m[0][1]=0;m[0][2]=0;m[0][3]=0;
  m[1][0]=0;m[1][1]=1;m[1][2]=0;m[1][3]=0;
  m[2][0]=0;m[2][1]=0;m[2][2]=1;m[2][3]=0;
}
void PSMTXIdentity(Mtx m){ mtx_ident(m); }
void C_MTXIdentity(Mtx m){ mtx_ident(m); }

void PSMTXCopy(const Mtx s, Mtx d){ int i,j; for(i=0;i<3;i++)for(j=0;j<4;j++) d[i][j]=s[i][j]; }
void C_MTXCopy(const Mtx s, Mtx d){ PSMTXCopy(s,d); }

static void mtx_concat(const Mtx a, const Mtx b, Mtx ab){
  Mtx t; int i,j;
  for(i=0;i<3;i++)for(j=0;j<4;j++)
    t[i][j]=a[i][0]*b[0][j]+a[i][1]*b[1][j]+a[i][2]*b[2][j]+(j==3?a[i][3]:0.0f);
  for(i=0;i<3;i++)for(j=0;j<4;j++) ab[i][j]=t[i][j];
}
void PSMTXConcat(const Mtx a, const Mtx b, Mtx ab){ mtx_concat(a,b,ab); }
void C_MTXConcat(const Mtx a, const Mtx b, Mtx ab){ mtx_concat(a,b,ab); }
void PSMTXConcatArray(const Mtx a, const Mtx* sb, Mtx* db, u32 n){ u32 i; for(i=0;i<n;i++) mtx_concat(a,sb[i],db[i]); }
void C_MTXConcatArray(const Mtx a, const Mtx* sb, Mtx* db, u32 n){ u32 i; for(i=0;i<n;i++) mtx_concat(a,sb[i],db[i]); }

void PSMTXTrans(Mtx m, f32 x, f32 y, f32 z){ mtx_ident(m); m[0][3]=x; m[1][3]=y; m[2][3]=z; }
void C_MTXTrans(Mtx m, f32 x, f32 y, f32 z){ PSMTXTrans(m,x,y,z); }
void C_MTXTransApply(const Mtx s, Mtx d, f32 x, f32 y, f32 z){ PSMTXCopy(s,d); d[0][3]=s[0][3]+x; d[1][3]=s[1][3]+y; d[2][3]=s[2][3]+z; }

void PSMTXScale(Mtx m, f32 x, f32 y, f32 z){ mtx_ident(m); m[0][0]=x; m[1][1]=y; m[2][2]=z; }
void C_MTXScale(Mtx m, f32 x, f32 y, f32 z){ PSMTXScale(m,x,y,z); }
void C_MTXScaleApply(const Mtx s, Mtx d, f32 x, f32 y, f32 z){
  int j; for(j=0;j<4;j++){ d[0][j]=s[0][j]*x; d[1][j]=s[1][j]*y; d[2][j]=s[2][j]*z; } }

static void mtx_rot_trig(Mtx m, char axis, f32 s, f32 c){
  mtx_ident(m);
  switch(axis){
    case 'x': case 'X': m[1][1]=c; m[1][2]=-s; m[2][1]=s; m[2][2]=c; break;
    case 'y': case 'Y': m[0][0]=c; m[0][2]=s; m[2][0]=-s; m[2][2]=c; break;
    default:            m[0][0]=c; m[0][1]=-s; m[1][0]=s; m[1][1]=c; break; /* z */
  }
}
void PSMTXRotRad(Mtx m, char axis, f32 rad){ mtx_rot_trig(m,axis,sinf(rad),cosf(rad)); }
void C_MTXRotRad(Mtx m, char axis, f32 rad){ mtx_rot_trig(m,axis,sinf(rad),cosf(rad)); }
void PSMTXRotTrig(Mtx m, char axis, f32 s, f32 c){ mtx_rot_trig(m,axis,s,c); }
void C_MTXRotTrig(Mtx m, char axis, f32 s, f32 c){ mtx_rot_trig(m,axis,s,c); }

static void mtx_rot_axis(Mtx m, const Vec* ax, f32 rad){
  f32 l=sqrtf(ax->x*ax->x+ax->y*ax->y+ax->z*ax->z); f32 x,y,z,s,c,t;
  if(l<1e-8f){ mtx_ident(m); return; }
  x=ax->x/l; y=ax->y/l; z=ax->z/l; s=sinf(rad); c=cosf(rad); t=1.0f-c;
  m[0][0]=t*x*x+c;   m[0][1]=t*x*y-s*z; m[0][2]=t*x*z+s*y; m[0][3]=0;
  m[1][0]=t*x*y+s*z; m[1][1]=t*y*y+c;   m[1][2]=t*y*z-s*x; m[1][3]=0;
  m[2][0]=t*x*z-s*y; m[2][1]=t*y*z+s*x; m[2][2]=t*z*z+c;   m[2][3]=0;
}
void PSMTXRotAxisRad(Mtx m, const Vec* ax, f32 rad){ mtx_rot_axis(m,ax,rad); }
void C_MTXRotAxisRad(Mtx m, const Vec* ax, f32 rad){ mtx_rot_axis(m,ax,rad); }

static void mtx_mult_vec(const Mtx m, const Vec* s, Vec* d){
  f32 x=s->x,y=s->y,z=s->z;
  d->x=m[0][0]*x+m[0][1]*y+m[0][2]*z+m[0][3];
  d->y=m[1][0]*x+m[1][1]*y+m[1][2]*z+m[1][3];
  d->z=m[2][0]*x+m[2][1]*y+m[2][2]*z+m[2][3];
}
static void mtx_mult_vec_sr(const Mtx m, const Vec* s, Vec* d){
  f32 x=s->x,y=s->y,z=s->z;
  d->x=m[0][0]*x+m[0][1]*y+m[0][2]*z;
  d->y=m[1][0]*x+m[1][1]*y+m[1][2]*z;
  d->z=m[2][0]*x+m[2][1]*y+m[2][2]*z;
}
void PSMTXMultVec(const Mtx m, const Vec* s, Vec* d){ mtx_mult_vec(m,s,d); }
void C_MTXMultVec(const Mtx m, const Vec* s, Vec* d){ mtx_mult_vec(m,s,d); }
void PSMTXMultVecSR(const Mtx m, const Vec* s, Vec* d){ mtx_mult_vec_sr(m,s,d); }
void C_MTXMultVecSR(const Mtx m, const Vec* s, Vec* d){ mtx_mult_vec_sr(m,s,d); }
void PSMTXMultVecArray(const Mtx m, const Vec* sb, Vec* db, u32 n){ u32 i; for(i=0;i<n;i++) mtx_mult_vec(m,&sb[i],&db[i]); }
void C_MTXMultVecArray(const Mtx m, const Vec* sb, Vec* db, u32 n){ u32 i; for(i=0;i<n;i++) mtx_mult_vec(m,&sb[i],&db[i]); }
void PSMTXMultVecArraySR(const Mtx m, const Vec* sb, Vec* db, u32 n){ u32 i; for(i=0;i<n;i++) mtx_mult_vec_sr(m,&sb[i],&db[i]); }
void C_MTXMultVecArraySR(const Mtx m, const Vec* sb, Vec* db, u32 n){ u32 i; for(i=0;i<n;i++) mtx_mult_vec_sr(m,&sb[i],&db[i]); }

/* ROMtx (4x3): row i (0..2) = column i of the 3x3, row 3 = translation. */
void PSMTXReorder(const Mtx s, ROMtx d){ int i,j; for(i=0;i<3;i++)for(j=0;j<3;j++) d[i][j]=s[j][i]; for(j=0;j<3;j++) d[3][j]=s[j][3]; }
static void ro_mult_vec(const ROMtx m, const Vec* s, Vec* d){
  f32 x=s->x,y=s->y,z=s->z;
  d->x=m[0][0]*x+m[1][0]*y+m[2][0]*z+m[3][0];
  d->y=m[0][1]*x+m[1][1]*y+m[2][1]*z+m[3][1];
  d->z=m[0][2]*x+m[1][2]*y+m[2][2]*z+m[3][2];
}
void PSMTXROMultVecArray(const ROMtx m, const Vec* sb, Vec* db, u32 n){ u32 i; for(i=0;i<n;i++) ro_mult_vec(m,&sb[i],&db[i]); }

static u32 mtx_inverse(const Mtx s, Mtx inv){
  f32 det =
    s[0][0]*(s[1][1]*s[2][2]-s[1][2]*s[2][1])
   -s[0][1]*(s[1][0]*s[2][2]-s[1][2]*s[2][0])
   +s[0][2]*(s[1][0]*s[2][1]-s[1][1]*s[2][0]);
  f32 id; Mtx r;
  if(det>-1e-9f && det<1e-9f) return 0;
  id=1.0f/det;
  r[0][0]=(s[1][1]*s[2][2]-s[1][2]*s[2][1])*id;
  r[0][1]=(s[0][2]*s[2][1]-s[0][1]*s[2][2])*id;
  r[0][2]=(s[0][1]*s[1][2]-s[0][2]*s[1][1])*id;
  r[1][0]=(s[1][2]*s[2][0]-s[1][0]*s[2][2])*id;
  r[1][1]=(s[0][0]*s[2][2]-s[0][2]*s[2][0])*id;
  r[1][2]=(s[0][2]*s[1][0]-s[0][0]*s[1][2])*id;
  r[2][0]=(s[1][0]*s[2][1]-s[1][1]*s[2][0])*id;
  r[2][1]=(s[0][1]*s[2][0]-s[0][0]*s[2][1])*id;
  r[2][2]=(s[0][0]*s[1][1]-s[0][1]*s[1][0])*id;
  r[0][3]=-(r[0][0]*s[0][3]+r[0][1]*s[1][3]+r[0][2]*s[2][3]);
  r[1][3]=-(r[1][0]*s[0][3]+r[1][1]*s[1][3]+r[1][2]*s[2][3]);
  r[2][3]=-(r[2][0]*s[0][3]+r[2][1]*s[1][3]+r[2][2]*s[2][3]);
  PSMTXCopy(r,inv); return 1;
}
u32 PSMTXInverse(const Mtx s, Mtx inv){ return mtx_inverse(s,inv); }
u32 C_MTXInverse(const Mtx s, Mtx inv){ return mtx_inverse(s,inv); }

static u32 mtx_invxpose(const Mtx s, Mtx ix){
  Mtx t; u32 ok=mtx_inverse(s,t); int i,j;
  if(!ok){ mtx_ident(ix); return 0; }
  for(i=0;i<3;i++)for(j=0;j<3;j++) ix[i][j]=t[j][i];
  ix[0][3]=ix[1][3]=ix[2][3]=0; return 1;
}
u32 PSMTXInvXpose(const Mtx s, Mtx ix){ return mtx_invxpose(s,ix); }
u32 C_MTXInvXpose(const Mtx s, Mtx ix){ return mtx_invxpose(s,ix); }
void C_MTXTranspose(const Mtx s, Mtx x){ int i,j; for(i=0;i<3;i++)for(j=0;j<3;j++) x[i][j]=s[j][i]; x[0][3]=x[1][3]=x[2][3]=0; }

/* ---------------- Projection (Mtx44) — documented GC convention ---------------- */
void C_MTXPerspective(Mtx44 m, f32 fovY, f32 aspect, f32 n, f32 f){
  f32 cot=1.0f/tanf((f32)(fovY*0.5*M_PI/180.0));
  m[0][0]=cot/aspect;m[0][1]=0;m[0][2]=0;m[0][3]=0;
  m[1][0]=0;m[1][1]=cot;m[1][2]=0;m[1][3]=0;
  m[2][0]=0;m[2][1]=0;m[2][2]=f/(n-f);m[2][3]=(f*n)/(n-f);
  m[3][0]=0;m[3][1]=0;m[3][2]=-1.0f;m[3][3]=0;
}
void C_MTXFrustum(Mtx44 m, f32 t, f32 b, f32 l, f32 r, f32 n, f32 f){
  f32 dx=r-l,dy=t-b,dz=f-n;
  m[0][0]=(2*n)/dx;m[0][1]=0;m[0][2]=(r+l)/dx;m[0][3]=0;
  m[1][0]=0;m[1][1]=(2*n)/dy;m[1][2]=(t+b)/dy;m[1][3]=0;
  m[2][0]=0;m[2][1]=0;m[2][2]=-n/dz;m[2][3]=-(f*n)/dz;
  m[3][0]=0;m[3][1]=0;m[3][2]=-1.0f;m[3][3]=0;
}
void C_MTXOrtho(Mtx44 m, f32 t, f32 b, f32 l, f32 r, f32 n, f32 f){
  f32 dx=r-l,dy=t-b,dz=f-n;
  m[0][0]=2/dx;m[0][1]=0;m[0][2]=0;m[0][3]=-(r+l)/dx;
  m[1][0]=0;m[1][1]=2/dy;m[1][2]=0;m[1][3]=-(t+b)/dy;
  m[2][0]=0;m[2][1]=0;m[2][2]=-1/dz;m[2][3]=-f/dz;
  m[3][0]=0;m[3][1]=0;m[3][2]=0;m[3][3]=1;
}
void C_MTXLookAt(Mtx m, const Point3d* pos, const Vec* up, const Point3d* tgt){
  Vec fwd,side,u2; f32 fl,sl,ul;
  fwd.x=pos->x-tgt->x; fwd.y=pos->y-tgt->y; fwd.z=pos->z-tgt->z;
  fl=sqrtf(fwd.x*fwd.x+fwd.y*fwd.y+fwd.z*fwd.z); if(fl<1e-8f)fl=1; fwd.x/=fl;fwd.y/=fl;fwd.z/=fl;
  side.x=up->y*fwd.z-up->z*fwd.y; side.y=up->z*fwd.x-up->x*fwd.z; side.z=up->x*fwd.y-up->y*fwd.x;
  sl=sqrtf(side.x*side.x+side.y*side.y+side.z*side.z); if(sl<1e-8f)sl=1; side.x/=sl;side.y/=sl;side.z/=sl;
  u2.x=fwd.y*side.z-fwd.z*side.y; u2.y=fwd.z*side.x-fwd.x*side.z; u2.z=fwd.x*side.y-fwd.y*side.x;
  ul=sqrtf(u2.x*u2.x+u2.y*u2.y+u2.z*u2.z); if(ul<1e-8f)ul=1; u2.x/=ul;u2.y/=ul;u2.z/=ul;
  m[0][0]=side.x;m[0][1]=side.y;m[0][2]=side.z;m[0][3]=-(side.x*pos->x+side.y*pos->y+side.z*pos->z);
  m[1][0]=u2.x;m[1][1]=u2.y;m[1][2]=u2.z;m[1][3]=-(u2.x*pos->x+u2.y*pos->y+u2.z*pos->z);
  m[2][0]=fwd.x;m[2][1]=fwd.y;m[2][2]=fwd.z;m[2][3]=-(fwd.x*pos->x+fwd.y*pos->y+fwd.z*pos->z);
}
void C_MTXLightPerspective(Mtx m, f32 fovY, f32 aspect, f32 scaleS, f32 scaleT, f32 transS, f32 transT){
  f32 cot=1.0f/tanf((f32)(fovY*0.5*M_PI/180.0));
  m[0][0]=(cot/aspect)*scaleS;m[0][1]=0;m[0][2]=-transS;m[0][3]=0;
  m[1][0]=0;m[1][1]=cot*scaleT;m[1][2]=-transT;m[1][3]=0;
  m[2][0]=0;m[2][1]=0;m[2][2]=-1.0f;m[2][3]=0;
}

/* ---------------- Vec ---------------- */
void C_VECAdd(const Vec* a, const Vec* b, Vec* o){ o->x=a->x+b->x; o->y=a->y+b->y; o->z=a->z+b->z; }
void PSVECAdd(const Vec* a, const Vec* b, Vec* o){ o->x=a->x+b->x; o->y=a->y+b->y; o->z=a->z+b->z; }
void C_VECSubtract(const Vec* a, const Vec* b, Vec* o){ o->x=a->x-b->x; o->y=a->y-b->y; o->z=a->z-b->z; }
void PSVECSubtract(const Vec* a, const Vec* b, Vec* o){ o->x=a->x-b->x; o->y=a->y-b->y; o->z=a->z-b->z; }
void C_VECScale(const Vec* s, Vec* o, f32 k){ o->x=s->x*k; o->y=s->y*k; o->z=s->z*k; }
void PSVECScale(const Vec* s, Vec* o, f32 k){ o->x=s->x*k; o->y=s->y*k; o->z=s->z*k; }
static void vec_norm(const Vec* s, Vec* o){ f32 m=sqrtf(s->x*s->x+s->y*s->y+s->z*s->z); if(m<1e-8f)m=1; o->x=s->x/m; o->y=s->y/m; o->z=s->z/m; }
void C_VECNormalize(const Vec* s, Vec* o){ vec_norm(s,o); }
void PSVECNormalize(const Vec* s, Vec* o){ vec_norm(s,o); }
f32 C_VECDotProduct(const Vec* a, const Vec* b){ return a->x*b->x+a->y*b->y+a->z*b->z; }
f32 PSVECDotProduct(const Vec* a, const Vec* b){ return a->x*b->x+a->y*b->y+a->z*b->z; }
void C_VECCrossProduct(const Vec* a, const Vec* b, Vec* o){ f32 x=a->y*b->z-a->z*b->y,y=a->z*b->x-a->x*b->z,z=a->x*b->y-a->y*b->x; o->x=x;o->y=y;o->z=z; }
void PSVECCrossProduct(const Vec* a, const Vec* b, Vec* o){ C_VECCrossProduct(a,b,o); }
f32 C_VECMag(const Vec* v){ return sqrtf(v->x*v->x+v->y*v->y+v->z*v->z); }
f32 PSVECMag(const Vec* v){ return sqrtf(v->x*v->x+v->y*v->y+v->z*v->z); }
f32 C_VECSquareMag(const Vec* v){ return v->x*v->x+v->y*v->y+v->z*v->z; }
f32 PSVECSquareMag(const Vec* v){ return v->x*v->x+v->y*v->y+v->z*v->z; }
static f32 vec_dist(const Vec* a, const Vec* b){ f32 x=a->x-b->x,y=a->y-b->y,z=a->z-b->z; return sqrtf(x*x+y*y+z*z); }
f32 C_VECDistance(const Vec* a, const Vec* b){ return vec_dist(a,b); }
f32 PSVECDistance(const Vec* a, const Vec* b){ return vec_dist(a,b); }
f32 C_VECSquareDistance(const Vec* a, const Vec* b){ f32 x=a->x-b->x,y=a->y-b->y,z=a->z-b->z; return x*x+y*y+z*z; }
f32 PSVECSquareDistance(const Vec* a, const Vec* b){ f32 x=a->x-b->x,y=a->y-b->y,z=a->z-b->z; return x*x+y*y+z*z; }
void C_VECHalfAngle(const Vec* a, const Vec* b, Vec* h){ Vec na,nb,s; na.x=-a->x;na.y=-a->y;na.z=-a->z; nb.x=-b->x;nb.y=-b->y;nb.z=-b->z; vec_norm(&na,&na); vec_norm(&nb,&nb); s.x=na.x+nb.x;s.y=na.y+nb.y;s.z=na.z+nb.z; if(C_VECSquareMag(&s)<=0.0f){h->x=h->y=h->z=0;} else vec_norm(&s,h); }
void C_VECReflect(const Vec* s, const Vec* n, Vec* o){ Vec u; f32 d; vec_norm(n,&u); d=2.0f*(s->x*u.x+s->y*u.y+s->z*u.z); o->x=s->x-d*u.x; o->y=s->y-d*u.y; o->z=s->z-d*u.z; }

/* ---------------- PPC compiler intrinsics (2026-08-25) ----------------
 * Referenced by compiled SDK units (GXLight sqrtf, GXTexture reg-field insert,
 * vi.c/THPDec bit scans). These were silently resolving to return-0 host stubs:
 * __frsqrte=0 made GXLight's file-local sqrtf return 0, and that definition
 * SHADOWED libc sqrtf binary-wide under -Wl,--allow-multiple-definition, which
 * no-op'd every VECNormalize/VECMag (board lookat garbage, world culled).
 * GXLight's sqrtf is also neutered by a build_wasm.sh bake so libc's f32.sqrt
 * serves the binary. */
double __frsqrte(double x){ return 1.0 / sqrt(x); }
u32 __cntlzw(u32 x){ return x ? (u32)__builtin_clz(x) : 32u; }
/* rlwinm: rotate left by sh, AND with the PPC MASK(mb,me) (bit 0 = MSB; wraps
 * when mb > me) — matches the MWerks intrinsic used as __rlwinm(v, sh, mb, me). */
u32 __rlwinm(u32 x, int sh, int mb, int me){
  u32 r = (sh & 31) ? ((x << (sh & 31)) | (x >> (32 - (sh & 31)))) : x;
  u32 m; int i;
  if (mb <= me) { m = 0; for (i = mb; i <= me; i++) m |= 1u << (31 - i); }
  else { m = 0xFFFFFFFFu; for (i = me + 1; i < mb; i++) m &= ~(1u << (31 - i)); }
  return r & m;
}
/* Aliasing-safe 3x4 transpose of the rotation block, translation zeroed —
 * C_MTXTranspose semantics (mtx.c:354). */
void PSMTXTranspose(const Mtx s, Mtx d){
  Mtx t; int i, j;
  for (i = 0; i < 3; i++) for (j = 0; j < 3; j++) t[i][j] = s[j][i];
  t[0][3] = t[1][3] = t[2][3] = 0.0f;
  for (i = 0; i < 3; i++) for (j = 0; j < 4; j++) d[i][j] = t[i][j];
}

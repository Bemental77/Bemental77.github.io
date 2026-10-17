// gamecube/recomp/gx_walk/gx_walk.c — recomp_worker.js walkStream, compiled to WebAssembly.
//
// WHY. Every presented frame, the recomp worker walks the frame's GX FIFO to keep the CP/XF/BP
// register shadow (the prologue every shipped frame carries), to find new display lists, vertex
// array bindings and textures, and to measure how far draws reach into each array. MEASURED (MP4
// 3D title, rate 1, per-frame counters in a scratch copy): 70 KB of FIFO, 874 CP + 1562 XF loads
// (3717 words) + 5891 BP writes + 1296 display-list calls per frame, 0.37-0.42 ms of JS on the
// guest's thread — about 38% of that thread's work per frame once the audio post was gone, and on
// the toaster arm (x6.2) ~2.4 ms of a ~14 ms frame.
//
// WHAT. The same walk, command for command, over a copy of the FIFO in this module's own memory.
// It is a SEPARATE module from mp4_game.wasm on purpose: its state (register shadow, slot reach,
// display-list signature cache) must stay outside guest memory, exactly where the JS walk kept it,
// so the rollback ring and the room's whole-state fingerprint (which cover all of mp4_game's
// memory) see nothing new. Recording the same facts at the SDK call boundary inside the game
// module would have put them in guest memory, and a display list's body still has to be parsed
// once (its CP/BP writes are not SDK calls this frame).
//
// THE CONTRACT (recomp_worker.js cw*): the JS side keeps every decision that touches its own maps.
// This module reports, in stream order: pairSeen insertions, texBound updates, arrUsed reach notes
// (EV_* below), and stops (GW_YIELD_DL) at every display-list call whose binding signature is not
// in its mirror of the JS signature ring — the JS side then runs its exact logic for that call
// (knownDLs, newDLs, the body walk) and writes the entry's ring back. A hit here is therefore always
// a hit there. Reads past the end of the buffer return 0, as a JS typed array read does.
// Sizes are computed in double, so a vertex format the JS walk turns into NaN (an out-of-range
// format index) ends the walk the same way (p becomes NaN: the loop condition fails, returns end).
typedef unsigned char u8;
typedef unsigned int u32;
typedef int i32;

#define TOP_CAP (8u << 20)
#define BODY_CAP (2u << 20)
static u8 top_buf[TOP_CAP];
static u8 body_buf[BODY_CAP];
static u32 top_len, body_len;

// ---- state shared with JS (synchronized around every call) ----
static u32 st_vcdLo, st_vcdHi, st_tlutSrc;
static u32 st_vatA[8], st_arrayBase[16], st_arrayStride[16], st_texImg0[8];
static double st_slotUse[16];
static i32 st_psGen, st_flags;                 // flags: 1 = XF_SHADOW_ALL, 2 = noteReach
static i32 psSlotGen[16]; static u32 psSlotB[16], psSlotS[16];

// ---- register shadows: val / seen / first-insertion order / count / version ----
typedef struct { u32 *val; u8 *seen; u32 *order; i32 n; i32 ver; } Shadow;
static u32 cp_val[0x100], bp_val[0x100], xf_val[0x20000];
static u8 cp_seen[0x100], bp_seen[0x100], xf_seen[0x20000];
static u32 cp_ord[0x100], bp_ord[0x100], xf_ord[0x20000];
static Shadow sh[3] = { { cp_val, cp_seen, cp_ord, 0, 0 }, { xf_val, xf_seen, xf_ord, 0, 0 }, { bp_val, bp_seen, bp_ord, 0, 0 } };
static inline void sh_set(Shadow *s, u32 k, u32 v) { if (!s->seen[k]) { s->seen[k] = 1; s->order[s->n++] = k; s->ver++; } s->val[k] = v; }

// ---- events ----
enum { EV_PAIR = 1, EV_TEX = 2, EV_ARR = 3 };
#define EV_CAP 65536
static u32 ev[EV_CAP * 4]; static i32 ev_n;
#define PD_N 4096
static u32 pdB[PD_N], pdS[PD_N]; static i32 pdG[PD_N];
static int pair_seen(u32 b0, u32 v) {
  u32 h = ((b0 * 2654435761u) ^ (v * 40503u)) >> 20;
  for (u32 i = 0; i < 64; i++) {
    u32 k = (h + i) & (PD_N - 1);
    if (pdG[k] != st_psGen) { pdG[k] = st_psGen; pdB[k] = b0; pdS[k] = v; return 0; }
    if (pdB[k] == b0 && pdS[k] == v) return 1;
  }
  return 0;   // table crowded: emit (a duplicate set is harmless)
}
static inline void ev_push(u32 t, u32 a, u32 b, u32 c) { u32 *e = ev + 4 * ev_n++; e[0] = t; e[1] = a; e[2] = b; e[3] = c; }

// ---- display-list signature cache: a mirror of each knownDLs entry's ring (ent.c / ent.cN) ----
#define DLC_N 16384
typedef struct { u32 addr; i32 used; i32 cN; u32 c[32]; } DlEnt;
static DlEnt dlc[DLC_N]; static i32 dlc_count;
static DlEnt *dlc_find(u32 addr, i32 make) {
  u32 h = (addr * 2654435761u) >> 18;   // 14 bits
  for (u32 i = 0; i < DLC_N; i++) {
    DlEnt *e = &dlc[(h + i) & (DLC_N - 1)];
    if (!e->used) { if (!make || dlc_count >= DLC_N / 2) return 0; e->used = 1; e->addr = addr; e->cN = 0; dlc_count++; return e; }
    if (e->addr == addr) return e;
  }
  return 0;
}

// ---- outputs of a stopped walk ----
static i32 out_p; static u32 out_dl[6]; static i32 out_bad;

static inline u32 rd8(const u8 *b, u32 len, u32 o) { return o < len ? b[o] : 0; }
static inline u32 rd16(const u8 *b, u32 len, u32 o) { return (o + 2 <= len) ? (u32)((b[o] << 8) | b[o + 1]) : ((rd8(b, len, o) << 8) | rd8(b, len, o + 1)); }
static inline u32 rd32(const u8 *b, u32 len, u32 o) {
  if (o + 4 <= len) return ((u32)b[o] << 24) | ((u32)b[o + 1] << 16) | ((u32)b[o + 2] << 8) | b[o + 3];
  return (rd8(b, len, o) << 24) | (rd8(b, len, o + 1) << 16) | (rd8(b, len, o + 2) << 8) | rd8(b, len, o + 3);
}
static const double NaN_ = __builtin_nan("");
static double FMT_SZ(u32 i) { static const double t[5] = { 1, 1, 2, 2, 4 }; return i < 5 ? t[i] : NaN_; }
static double COL_SZ(u32 i) { static const double t[6] = { 2, 3, 4, 2, 3, 4 }; return i < 6 ? t[i] : NaN_; }
static u32 TEX_BPP(u32 f) {   // TEX_BPP[fmt] || 32
  switch (f) { case 0: return 4; case 1: return 8; case 2: return 8; case 3: return 16; case 4: return 16; case 5: return 16;
               case 6: return 32; case 8: return 4; case 9: return 8; case 10: return 16; case 14: return 4; default: return 32; }
}
static inline double pvAdd(u32 t, double d) { return t == 1 ? d : t == 2 ? 1 : t == 3 ? 2 : 0; }
static double perVertSize0(u32 vat) {
  const u32 va = st_vatA[vat], lo = st_vcdLo, hi = st_vcdHi;
  double s = 0;
  if (lo & 1) s++;
  for (int i = 0; i < 8; i++) if (lo & (1u << (1 + i))) s++;
  s += pvAdd((lo >> 9) & 3, ((va & 1) ? 3 : 2) * FMT_SZ((va >> 1) & 7));
  s += pvAdd((lo >> 11) & 3, (((va >> 9) & 1) ? 9 : 3) * FMT_SZ((va >> 10) & 7));
  s += pvAdd((lo >> 13) & 3, COL_SZ((va >> 14) & 7));
  s += pvAdd((lo >> 15) & 3, COL_SZ((va >> 18) & 7));
  for (int i = 0; i < 8; i++) s += pvAdd((hi >> (2 * i)) & 3, i == 0 ? (((va >> 21) & 1) ? 2 : 1) * FMT_SZ((va >> 22) & 7) : 8);
  return s;
}
static u32 pvLo[8], pvHi[8], pvVa[8], pvOk[8]; static double pvSz[8];
static double perVertSize(u32 vat) {
  if (pvOk[vat] && pvLo[vat] == st_vcdLo && pvHi[vat] == st_vcdHi && pvVa[vat] == st_vatA[vat]) return pvSz[vat];
  pvLo[vat] = st_vcdLo; pvHi[vat] = st_vcdHi; pvVa[vat] = st_vatA[vat]; pvOk[vat] = 1;
  return pvSz[vat] = perVertSize0(vat);
}
// indexed attributes of a vertex: [offset, index bytes, slot] triples (idxAttrs)
static double ixA[64]; static int ixN;
static double ixPut(u32 t, double d, int slot, double off) {
  if (t >= 2) { ixA[ixN] = off; ixA[ixN + 1] = t == 2 ? 1 : 2; ixA[ixN + 2] = slot; ixN += 3; }
  return off + pvAdd(t, d);
}
static u32 ixLo = 1, ixHi, ixVa, ixVat = 99;
static void idxAttrs(u32 vat) {
  const u32 va = st_vatA[vat], lo = st_vcdLo, hi = st_vcdHi;
  if (ixVat == vat && ixLo == lo && ixHi == hi && ixVa == va) return;
  ixVat = vat; ixLo = lo; ixHi = hi; ixVa = va;
  ixN = 0; double off = 0;
  if (lo & 1) off++;
  for (int i = 0; i < 8; i++) if (lo & (1u << (1 + i))) off++;
  off = ixPut((lo >> 9) & 3, ((va & 1) ? 3 : 2) * FMT_SZ((va >> 1) & 7), 0, off);
  off = ixPut((lo >> 11) & 3, (((va >> 9) & 1) ? 9 : 3) * FMT_SZ((va >> 10) & 7), 1, off);
  off = ixPut((lo >> 13) & 3, COL_SZ((va >> 14) & 7), 2, off);
  off = ixPut((lo >> 15) & 3, COL_SZ((va >> 18) & 7), 3, off);
  for (int i = 0; i < 8; i++) off = ixPut((hi >> (2 * i)) & 3, i == 0 ? (((va >> 21) & 1) ? 2 : 1) * FMT_SZ((va >> 22) & 7) : 8, 4 + i, off);
}
static void drawNote(const u8 *b, u32 len, u32 p, u32 n, u32 vs) {
  for (int a = 0; a < ixN; a += 3) {
    const u32 off = p + (u32)ixA[a], sz = (u32)ixA[a + 1];
    u32 mx = 0;
    if (sz == 1) { u32 q = off; for (u32 v = 0; v < n; v++, q += vs) { u32 i = rd8(b, len, q); if (i > mx) mx = i; } }
    else { u32 q = off; for (u32 v = 0; v < n; v++, q += vs) { u32 i = (rd8(b, len, q) << 8) | rd8(b, len, q + 1); if (i > mx) mx = i; } }
    const int si = (int)ixA[a + 2];
    const double need = (double)(mx + 1) * (double)(st_arrayStride[si] & 0xFF);
    if (need > st_slotUse[si]) st_slotUse[si] = need;
  }
}
static void arrNote(int si, double bytes) {
  const u32 b = st_arrayBase[si], s = st_arrayStride[si];
  if (!b || !s || s > 0xFF) return;
  ev_push(EV_ARR, b, s, (u32)bytes);
}

enum { GW_DONE = 0, GW_BUDGET = 1, GW_YIELD_DL = 2, GW_EVFULL = 3, GW_BADOP = -1, GW_OVERRUN = -2 };

// Walk [p, end) of buffer `which` (0 = top, 1 = body). budget: commands before GW_BUDGET (0 = none).
// On a stop, out_p is the offset of the next command to run.
__attribute__((export_name("gw_walk")))
i32 gw_walk(i32 which, i32 p0, i32 end0, i32 depth, i32 budget) {
  const u8 *b = which ? body_buf : top_buf; const u32 len = which ? body_len : top_len;
  const u32 end = (u32)end0; u32 p = (u32)p0; int tick = 0;
  while (p < end) {
    if (ev_n > EV_CAP - 64) { out_p = (i32)p; return GW_EVFULL; }
    if (budget && ++tick > budget) { out_p = (i32)p; return GW_BUDGET; }
    const u32 cmd0 = p;
    const u32 op = rd8(b, len, p); p += 1;
    if (op == 0x00) continue;
    else if (op == 0x61) {
      const u32 v = rd32(b, len, p); p += 4;
      const u32 reg = v >> 24, val = v & 0xffffff;
      sh_set(&sh[2], reg, val);
      if (reg < 0x64) continue;
      int slot = -1;
      if (reg >= 0x88 && reg <= 0x8B) st_texImg0[reg - 0x88] = val;
      else if (reg >= 0xA8 && reg <= 0xAB) st_texImg0[4 + (reg - 0xA8)] = val;
      else if (reg >= 0x94 && reg <= 0x97) slot = reg - 0x94;
      else if (reg >= 0xB4 && reg <= 0xB7) slot = 4 + (reg - 0xB4);
      else if (reg == 0x64) st_tlutSrc = val << 5;
      else if (reg == 0x65) {
        const u32 n32 = (val >> 10) & 0x7FF;
        if (st_tlutSrc && n32) ev_push(EV_TEX, st_tlutSrc, n32 * 32, 0);
      }
      if (slot >= 0) {
        const u32 base = val << 5, i0 = st_texImg0[slot];
        const u32 w = (i0 & 0x3FF) + 1, h = ((i0 >> 10) & 0x3FF) + 1, fmt = (i0 >> 20) & 0xF;
        const u32 wp = (w + 7) & ~7u, hp = (h + 7) & ~7u;
        const u32 size = (wp * hp * TEX_BPP(fmt)) >> 3;
        if (base) ev_push(EV_TEX, base, size, 0);
      }
    } else if (op == 0x10) {
      const u32 hdr = rd32(b, len, p); p += 4;
      const u32 count = (hdr >> 16) + 1, xfAddr = hdr & 0xFFFF;
      if ((st_flags & 1) || xfAddr >= 0x1000) {
        Shadow *x = &sh[1];
        if (p + 4 * count <= len) { const u8 *q = b + p; for (u32 k = 0; k < count; k++, q += 4) sh_set(x, xfAddr + k, ((u32)q[0] << 24) | ((u32)q[1] << 16) | ((u32)q[2] << 8) | q[3]); }
        else for (u32 k = 0; k < count; k++) sh_set(x, xfAddr + k, rd32(b, len, p + 4 * k));
      }
      p += 4 * count;
    } else if (op == 0x08) {
      const u32 a = rd8(b, len, p), v = rd32(b, len, p + 1); p += 5;
      sh_set(&sh[0], a, v);
      if (a == 0x50) st_vcdLo = v; else if (a == 0x60) st_vcdHi = v;
      else if (a >= 0x70 && a <= 0x77) st_vatA[a - 0x70] = v;
      else if (a >= 0xA0 && a <= 0xAF) {
        const int si = a - 0xA0;
        if (st_slotUse[si] > 0) { arrNote(si, st_slotUse[si]); st_slotUse[si] = 0; }
        st_arrayBase[si] = v;
      } else if (a >= 0xB0 && a <= 0xBF) {
        const int si = a - 0xB0;
        if (st_slotUse[si] > 0) { arrNote(si, st_slotUse[si]); st_slotUse[si] = 0; }
        st_arrayStride[si] = v;
        const u32 b0 = st_arrayBase[si];
        if (b0 && v && !(psSlotGen[si] == st_psGen && psSlotB[si] == b0 && psSlotS[si] == v)) {
          if (!pair_seen(b0, v)) ev_push(EV_PAIR, b0, v, 0);
          psSlotGen[si] = st_psGen; psSlotB[si] = b0; psSlotS[si] = v;
        }
      }
    } else if (op == 0x40) {
      const u32 addr = rd32(b, len, p), size = rd32(b, len, p + 4); p += 8;
      if (depth > 0 || size == 0) continue;
      const u32 a0 = st_arrayBase[0], a1 = st_arrayBase[1], a2 = st_arrayBase[2], a4 = st_arrayBase[4];
      DlEnt *e = dlc_find(addr, 0);
      if (e) {
        const int cn = e->cN < 8 ? e->cN : 8;
        int hit = 0;
        for (int i = 0, j = 0; i < cn; i++, j += 4)
          if (e->c[j] == a0 && e->c[j + 1] == a1 && e->c[j + 2] == a2 && e->c[j + 3] == a4) { hit = 1; break; }
        if (hit) continue;
      }
      out_p = (i32)p; out_dl[0] = addr; out_dl[1] = size; out_dl[2] = a0; out_dl[3] = a1; out_dl[4] = a2; out_dl[5] = a4;
      return GW_YIELD_DL;
    } else if (op >= 0x20 && op <= 0x38 && (op & 7) == 0) {
      const u32 v = rd32(b, len, p); p += 4;
      const int si = 12 + ((op - 0x20) >> 3);
      const double need = (double)(v >> 16) * (double)(st_arrayStride[si] & 0xFF) + (double)((((v >> 12) & 0xF) + 1) << 2);
      if (need > st_slotUse[si]) st_slotUse[si] = need;
    } else if (op == 0x48) continue;
    else if (op >= 0x80 && op <= 0xBF) {
      const u32 vat = op & 7, n = rd16(b, len, p); p += 2;
      const double vsd = perVertSize(vat);
      if (vsd != vsd) { if (n == 0) { /* 0 * NaN is NaN too */ } out_p = end0; return GW_DONE; }   // the JS walk's p becomes NaN: its loop ends, it returns end
      const u32 vs = (u32)vsd;
      const double span = (double)n * vsd;
      if ((st_flags & 2) && n > 0) { idxAttrs(vat); if (ixN && (double)p + span <= (double)end) drawNote(b, len, p, n, vs); }
      if ((double)p + span > (double)end) { out_p = (i32)cmd0; return GW_OVERRUN; }
      p += n * vs;
    } else { out_p = (i32)cmd0; out_bad = (i32)op; return GW_BADOP; }
  }
  out_p = end0; return GW_DONE;
}

// ---- accessors (the JS side maps typed-array views over these) ----
#define EXP(n) __attribute__((export_name(#n)))
EXP(gw_top_buf) u8 *gw_top_buf(void) { return top_buf; }
EXP(gw_body_buf) u8 *gw_body_buf(void) { return body_buf; }
EXP(gw_set_lens) void gw_set_lens(u32 t, u32 bl) { top_len = t; body_len = bl; }
EXP(gw_vatA) u32 *gw_vatA(void) { return st_vatA; }
EXP(gw_arrayBase) u32 *gw_arrayBase(void) { return st_arrayBase; }
EXP(gw_arrayStride) u32 *gw_arrayStride(void) { return st_arrayStride; }
EXP(gw_texImg0) u32 *gw_texImg0(void) { return st_texImg0; }
EXP(gw_slotUse) double *gw_slotUse(void) { return st_slotUse; }
EXP(gw_set_scalars) void gw_set_scalars(u32 lo, u32 hi, u32 tl, i32 psGen, i32 flags) { st_vcdLo = lo; st_vcdHi = hi; st_tlutSrc = tl; st_psGen = psGen; st_flags = flags; }
EXP(gw_vcdLo) u32 gw_vcdLo(void) { return st_vcdLo; }
EXP(gw_vcdHi) u32 gw_vcdHi(void) { return st_vcdHi; }
EXP(gw_tlutSrc) u32 gw_tlutSrc(void) { return st_tlutSrc; }
EXP(gw_ev) u32 *gw_ev(void) { return ev; }
EXP(gw_ev_n) i32 gw_ev_n(void) { return ev_n; }
EXP(gw_ev_reset) void gw_ev_reset(void) { ev_n = 0; }
EXP(gw_out_p) i32 gw_out_p(void) { return out_p; }
EXP(gw_out_dl) u32 *gw_out_dl(void) { return out_dl; }
EXP(gw_out_bad) i32 gw_out_bad(void) { return out_bad; }
EXP(gw_sh_val) u32 *gw_sh_val(i32 k) { return sh[k].val; }
EXP(gw_sh_seen) u8 *gw_sh_seen(i32 k) { return sh[k].seen; }
EXP(gw_sh_order) u32 *gw_sh_order(i32 k) { return sh[k].order; }
EXP(gw_sh_meta) i32 *gw_sh_meta(i32 k) { return &sh[k].n; }   // [n, ver]
// the signature ring of one display list, written back by the JS side after it handled a call
EXP(gw_dl_put) void gw_dl_put(u32 addr, i32 cN, const u32 *c) {
  DlEnt *e = dlc_find(addr, 1); if (!e) return;
  e->cN = cN; for (int i = 0; i < 32; i++) e->c[i] = c[i];
}
EXP(gw_dl_scratch) u32 *gw_dl_scratch(void) { static u32 s[32]; return s; }
EXP(gw_dl_clear) void gw_dl_clear(void) { for (u32 i = 0; i < DLC_N; i++) dlc[i].used = 0; dlc_count = 0; }

// [wasm-recomp 2026-08-22] Byte-swap a whole HSF 3D-model file in place, BE (GameCube disc
// asset) -> LE (wasm native), ONCE, before LoadHSF() interprets it. The MP4 decomp reads every
// HSF struct field as a native little-endian load (hsfload.c), but the .hsf files stored on the
// disc are big-endian PowerPC data. Reading them natively yields garbage counts/offsets and OOB
// walks (e.g. head.*.count / *->data / *->ofs). We swap the file's scalar fields to LE here so
// hsfload.c's relocation math then sees correct values.
//
// The layout is include/game/hsfformat.h (authoritative). The recomp compiles that same header,
// so casting into the real structs gives byte-identical strides/offsets to what the loader uses.
//
// SWAP RULES (per the task spec):
//   - s32/u32/f32 and any pointer-stored-as-file-offset  -> bsw32 (byte reversal is the same)
//   - s16/u16                                             -> bsw16
//   - u8/s8/char, char[] name fields, magic[8]            -> DO NOT SWAP
//   - the 'string' section (raw string table)            -> DO NOT SWAP any bytes
//   - the 'symbol' section (array of s32 offsets)         -> bsw32 each entry
// Every scalar field of every element is swapped EXACTLY ONCE.
//
// OFFSET-BASE / OFFSET-SCALE discipline (this is where the earlier draft was wrong): a stored
// offset must be resolved with the SAME base and the SAME scaling that hsfload.c uses, or the
// swap targets the wrong bytes (leaving the real records big-endian AND corrupting neighbours):
//   - cenv single/dual/multi element arrays are relative to data_base = &cenv[count], NOT the
//     file base (hsfload.c:726,732-734).
//   - part.vertex (hsfload.c:821,825) and mapAttr.data (hsfload.c:904,906) are u16 ELEMENT
//     indices (`&data[idx]`, data typed u16*) -> scale by sizeof(u16); they are NOT byte offsets.
//   - palette.data (hsfload.c:961,969) IS a byte offset (`(u32)data_base + (u32)ofs`) -> no scale.
//   - vertex/normal/st/face/color/bitmap data are byte offsets (`(u32)data + (u32)ofs`).
//   - the face strip table (hsfload.c:423,430) is indexed as `strip + idx * (sizeof(s16)*4)`.
//
// IMPORTANT ordering note: a field that stores a file-relative byte offset/index must be swapped
// BEFORE it is used to locate nested data. We swap the field in place (which both fixes the stored
// value for the loader AND yields the correct LE value we then use to walk the nested array), so
// each helper reads the offset from the field only AFTER swapping it.

#include "game/hsfformat.h"
#include <stdint.h>
#include <string.h>

// [DIAG] trace which section is being swapped (define HSF_BSWAP_TRACE to enable); the harness
// records the __gc_trace IDs, so the LAST id before an OOB names the culprit section. Disabled now
// that the swapper is validated (all 21 sections complete; the vertex/normal/st stride bug is fixed).
#ifdef HSF_BSWAP_TRACE
extern void __gc_trace(int);
#define HT(n) __gc_trace(9000 + (n))
#define TV(x) __gc_trace((int)(x))
#else
#define HT(n) ((void)0)
#define TV(x) ((void)0)
#endif

static u16 bsw16(u16 v) { return (u16)((v >> 8) | (v << 8)); }
static u32 bsw32(u32 v) {
    return (v >> 24) | ((v >> 8) & 0xFF00u) | ((v << 8) & 0xFF0000u) | (v << 24);
}
// Swap an f32 by reinterpreting its bits (never touch the float value directly).
static void bswf32(f32 *p) { u32 t; memcpy(&t, p, 4); t = bsw32(t); memcpy(p, &t, 4); }

// Swap in place, in the field's own storage, and return the swapped value (for traversal).
static u32 sw32f(void *p) { u32 v; memcpy(&v, p, 4); v = bsw32(v); memcpy(p, &v, 4); return v; }
static u16 sw16f(void *p) { u16 v; memcpy(&v, p, 2); v = bsw16(v); memcpy(p, &v, 2); return v; }

// A Vec is 3 x f32.
static void swVec(Vec *v) { bswf32(&v->x); bswf32(&v->y); bswf32(&v->z); }

// Swap one motion track's appended keyframe curve data (STEP/LINEAR/BEZIER float arrays, or a
// BITMAP HsfBitmapKey[] table). track_data is &track_base[numTracks] (hsfload.c:1345); the track's
// (already-swapped) data-offset word is a byte offset into that region. Strides come straight from
// the anim readers: GetConstant (curveType 0 / STEP) advances +2 floats/key, GetLinear (1) reads
// float[key][2] (2 floats/key), GetBezier (2) reads float[key][4] (4 floats/key). curveType 4
// (CONST) has no appended data (GetCurve returns the inline `value` word). curveType 3 (BITMAP)
// is HsfBitmapKey[numKeyframes] = { f32 time; ptr data } (hsfmotion.c:1181-1199, 1201-1234,
// 1237-1292, 1314-1321).
static void swTrackKeyframes(unsigned char *track_data, u16 curveType, u16 numKeyframes,
                             u32 dataOfs)
{
    s32 nk = (s32)numKeyframes;
    s32 i;
    if (nk <= 0) return;
    switch (curveType) {
        case HSF_CURVE_STEP:   /* 0 -> GetConstant, 2 floats/key */
        case HSF_CURVE_LINEAR: /* 1 -> GetLinear,   2 floats/key */
        {
            f32 *kf = (f32 *)(track_data + dataOfs);
            for (i = 0; i < nk * 2; i++) bswf32(&kf[i]);
        }
        break;
        case HSF_CURVE_BEZIER: /* 2 -> GetBezier, 4 floats/key */
        {
            f32 *kf = (f32 *)(track_data + dataOfs);
            for (i = 0; i < nk * 4; i++) bswf32(&kf[i]);
        }
        break;
        case HSF_CURVE_BITMAP: /* 3 -> HsfBitmapKey[nk] = { f32 time; ptr data } */
        {
            HsfBitmapKey *key = (HsfBitmapKey *)(track_data + dataOfs);
            for (i = 0; i < nk; i++) {
                bswf32(&key[i].time);
                sw32f(&key[i].data);  /* bitmap index/offset consumed by SearchBitmapPtr */
            }
        }
        break;
        case HSF_CURVE_CONST:  /* 4 -> inline value word, no appended data */
        default:
            break;
    }
}

// [Fix A support] swap n_f32 floats at base+ofs, once — dedup against a small seen list so
// two mesh objects sharing one pristine-copy region cannot double-swap it.
#define HSF_COPYSEEN_MAX 128
static u32 hsf_copyseen[HSF_COPYSEEN_MAX];
static s32 hsf_copyseen_n;
static void hsf_swap_copy_region(unsigned char *base, u32 ofs, u32 n_f32)
{
    s32 m;
    f32 *e = (f32 *)(base + ofs);
    for (m = 0; m < hsf_copyseen_n; m++) if (hsf_copyseen[m] == ofs) return;
    if (hsf_copyseen_n < HSF_COPYSEEN_MAX) hsf_copyseen[hsf_copyseen_n++] = ofs;
    { u32 q; for (q = 0; q < n_f32; q++) { u32 v = *(u32 *)&e[q]; v = (v >> 24) | ((v >> 8) & 0xFF00u) | ((v << 8) & 0xFF0000u) | (v << 24); *(u32 *)&e[q] = v; } }
}

void __recomp_bswap_hsf(void *data)
{
    unsigned char *base = (unsigned char *)data;
    HsfHeader *h = (HsfHeader *)data;
    HsfSection *sec;
    s32 i, j, k;
    hsf_copyseen_n = 0;   // per-file dedup list for the pristine-copy regions (Fix A)

    // --- Double-swap plausibility guard -------------------------------------------------------
    // The scene section is the very first section entry in the header (right after magic[8]).
    // In a correctly big-endian file, scene.ofs is a modest positive byte offset into the file
    // (0 < ofs < a few MB) when read big-endian, but reads as an absurdly large value when read
    // as-is on our little-endian target. If the file has ALREADY been swapped to LE, reading it
    // as-is (native) yields the plausible small offset while the byte-swapped form is huge. So:
    // if the native (as-is) scene.ofs is already small-and-plausible AND its byte-swapped form is
    // huge, the file is already LE -> return without swapping (idempotent guard).
    {
        u32 as_is = (u32)h->scene.ofs;              // native (little-endian) read of the raw bytes
        u32 swapped = bsw32(as_is);                 // what it would become if we swapped
        const u32 PLAUSIBLE = 0x400000u;            // 4 MB: an .hsf file is well under this
        // Fix D: hard idempotence — stamped on first swap (below). The plausibility guard can
        // fail OPEN on a header the loader has rewritten with live pointers (SetHsfModel), and
        // is inert when scene.ofs==0; the stamp is absolute. Real files end "...037\0" and
        // hsfload never re-reads magic as a string.
        if (h->magic[7] == 1) return;
        if (as_is != 0 && as_is < PLAUSIBLE && swapped >= PLAUSIBLE) {
#ifdef RECOMP_HSFDIAG
            { extern void OSReport(const char*, ...); OSReport("HSF: SKIP(already-LE) %x\n", (unsigned)data); }
#endif
            return;   // already little-endian; do not double-swap
        }
#ifdef RECOMP_HSFDIAG
        { extern void OSReport(const char*, ...); OSReport("HSF: SWAP %x scene.ofs_asis=%x\n", (unsigned)data, as_is); }
#endif
        // (If as_is is 0 we still proceed: scene.ofs==0 is legitimately possible and harmless.)
    }

    h->magic[7] = 1;   // Fix D stamp — see the guard above

    // --- 1. Header: magic[8] stays; swap all 42 section s32 (21 sections x {ofs,count}) --------
    // NOTE: char magic[8] is ASCII ("Hsfv" style) -> DO NOT SWAP.
    HT(1); sec = &h->scene;              // first HsfSection; the 21 are contiguous in declaration order
    for (i = 0; i < 21; i++) {
        sec[i].ofs   = (s32)bsw32((u32)sec[i].ofs);
        sec[i].count = (s32)bsw32((u32)sec[i].count);
    }
    // From here on, h->*.ofs and h->*.count are native (LE) and safe to use directly.

    // --- 2. scene section : HsfScene[count] ---------------------------------------------------
    //   { GXFogType fogType(enum=s32); f32 start; f32 end; GXColor color(4xu8) }
    if (h->scene.count) { HT(2);
        HsfScene *s = (HsfScene *)(base + h->scene.ofs);
        for (i = 0; i < h->scene.count; i++) {
            sw32f(&s[i].fogType);         // enum -> 32-bit
            bswf32(&s[i].start);
            bswf32(&s[i].end);
            /* color is 4 x u8 -> no swap */
        }
    }

    // --- 3. color section : HsfBuffer[count] { char *name; s32 count; void *data } ------------
    // name/data are file offsets (u32), count is s32. The per-buffer color pixel DATA is NOT
    // swapped: ColorLoad (hsfload.c:287-291) only relocates the pointer, and hsfdraw.c:513 sets
    // GXSetArray(GX_VA_CLR0, ..., 4) with GXColor (4 x u8) reads (hsfdraw.c:2550) -> u8 RGBA.
    if (h->color.count) { HT(3);
        HsfBuffer *b = (HsfBuffer *)(base + h->color.ofs);
        for (i = 0; i < h->color.count; i++) {
            sw32f(&b[i].name);
            b[i].count = (s32)bsw32((u32)b[i].count);
            sw32f(&b[i].data);
        }
    }

    // --- 4. material section : HsfMaterial[count] ---------------------------------------------
    if (h->material.count) { HT(4);
        HsfMaterial *m = (HsfMaterial *)(base + h->material.ofs);
        for (i = 0; i < h->material.count; i++) {
            sw32f(&m[i].name);            // char* offset
            /* unk4[4] : u8[4] -> no swap */
            m[i].pass = bsw16(m[i].pass); // u16
            /* vtxMode u8; litColor[3] u8; color[3] u8; shadowColor[3] u8 -> no swap */
            bswf32(&m[i].hilite_scale);
            bswf32(&m[i].unk18);
            bswf32(&m[i].invAlpha);
            bswf32(&m[i].unk20[0]);
            bswf32(&m[i].unk20[1]);
            bswf32(&m[i].refAlpha);
            bswf32(&m[i].unk2C);
            m[i].flags    = bsw32(m[i].flags);
            m[i].numAttrs = bsw32(m[i].numAttrs);
            sw32f(&m[i].attrs);           // symbol-index (stored as s32*) -> 32-bit
        }
        // The material 'attrs' arrays live in the symbol section (swapped there); no extra data
        // is appended after the HsfMaterial[] array in the material section itself.
    }

    // --- 5. attribute section : HsfAttribute[count] -------------------------------------------
    // Mixed f32/u32 fields with u8[] padding runs (unk8/unk10/unk18/unk24/unk38/unk6C -> no swap).
    if (h->attribute.count) { HT(5);
        HsfAttribute *a = (HsfAttribute *)(base + h->attribute.ofs);
        for (i = 0; i < h->attribute.count; i++) {
            sw32f(&a[i].name);            // char* offset (may be -1 sentinel; swap is symmetric)
            sw32f(&a[i].unk04);           // pointer field
            /* unk8[4] u8 */
            bswf32(&a[i].unk0C);
            /* unk10[4] u8 */
            bswf32(&a[i].unk14);
            /* unk18[8] u8 */
            bswf32(&a[i].unk20);
            /* unk24[4] u8 */
            bswf32(&a[i].unk28);
            bswf32(&a[i].unk2C);
            bswf32(&a[i].unk30);
            bswf32(&a[i].unk34);
            /* unk38[44] u8 */
            a[i].wrap_s = bsw32(a[i].wrap_s);
            a[i].wrap_t = bsw32(a[i].wrap_t);
            /* unk6C[12] u8 */
            a[i].unk78 = bsw32(a[i].unk78);
            a[i].flag  = bsw32(a[i].flag);
            sw32f(&a[i].bitmap);          // bitmap index/offset (SearchBitmapPtr consumes it) -> 32-bit
        }
    }

    // --- 6/7/8. vertex / normal / st sections : HsfBuffer[count] + appended element arrays -----
    // Each buffer: { char *name; s32 count; void *data(byte offset) }. The element data is
    // appended after the HsfBuffer[] array, at data_base = &buf[count], plus the (swapped)
    // per-buffer data BYTE offset (hsfload.c:309,321 add it as a raw u32). vertex is HsfVector3f
    // (3xf32), st is HsfVector2f (2xf32). normal is 3xf32 too: hsfdraw.c:508 sets
    // GXSetArray(GX_VA_NRM, ..., 3*sizeof(float)) -> confirmed f32 triples (NormalLoad itself only
    // relocates the pointer and doesn't prove the stride, so the GX descriptor is the authority).
    // comps = number of f32 to swap PER element. vertex = HsfVector3f (3 f32). st = HsfVector2f
    // (2 f32). normal is 3x s8 PACKED BYTES (empirically the per-buffer data offset advances by
    // count*3 bytes, not count*12) -> single bytes need NO swap, so comps=0: swap only its buffer
    // headers. (The earlier f32 assumption over-ran 4x the data and corrupted the st section.)
    {
        struct { HsfSection *s; int comps; } vbufs[3];
        vbufs[0].s = &h->vertex; vbufs[0].comps = 3; // HsfVector3f
        // normals: per-FILE dichotomy (hsfdraw.c:503-508): cenv-less files pack s8 triples
        // (no swap); SKINNED files (cenv.count != 0) use f32 triples stride 12 — leaving
        // those BE broke every skinned model's normals (Fix B).
        vbufs[1].s = &h->normal; vbufs[1].comps = h->cenv.count ? 3 : 0;
        HT(6); vbufs[2].s = &h->st;     vbufs[2].comps = 2; // HsfVector2f
        for (k = 0; k < 3; k++) {
            HsfSection *S = vbufs[k].s;
            int comps = vbufs[k].comps;
            HT(60 + k); TV(S->ofs); TV(S->count);
            if (!S->count) continue;
            HsfBuffer *b = (HsfBuffer *)(base + S->ofs);
            unsigned char *data_base = (unsigned char *)&b[S->count];
#ifdef RECOMP_HSFDIAG
            { extern void OSReport(const char*, ...);
              OSReport("HSF: sec%d file=%x nbuf=%d data_base=%x\n", (int)k, (unsigned)base, (int)S->count, (unsigned)data_base); }
#endif
            for (i = 0; i < S->count; i++) {
                sw32f(&b[i].name);
                b[i].count = (s32)bsw32((u32)b[i].count);
                u32 dofs = sw32f(&b[i].data);       // byte offset; swap, keep value for traversal
                TV(b[i].count); TV((int)dofs);
                if (!comps) continue;               // normal: packed s8, nothing to byte-swap
                f32 *elem = (f32 *)(data_base + dofs);
#ifdef RECOMP_HSFDIAG
                if (i < 2) { extern void OSReport(const char*, ...);
                  OSReport("HSF:   buf%d elem=%x n=%d\n", (int)i, (unsigned)elem, (int)b[i].count); }
#endif
                for (j = 0; j < b[i].count * comps; j++) {
                    bswf32(&elem[j]);
                }
            }
        }
    }

    // --- 9. face section : HsfBuffer[count] + appended HsfFace[] arrays + shared s16 strip table -
    // Each face buffer's data BYTE offset points into an appended HsfFace[] array
    // (data_base = &buf[cnt]; hsfload.c:412,422). Each HsfFace: { s16 type; s16 mat;
    // union{ strip{ s16 indices[3][4]; u32 count; s16 *data } | s16 indices[4][4] }; Vec nbt }.
    // For strip faces (type==4) the union stores a count(u32) + a strip.data INDEX (scaled by
    // sizeof(s16)*4) into a SHARED s16 strip table that begins past the LAST buffer's HsfFace[]
    // array (hsfload.c:423,430). The renderer (hsfdraw.c:2712-2713) walks strip.count entries,
    // 4 s16 each (pos/normal/color/texcoord) -> the appended run is strip.count*4 s16.
    if (h->face.count) { HT(7);
        HsfBuffer *b = (HsfBuffer *)(base + h->face.ofs);
        unsigned char *data_base = (unsigned char *)&b[h->face.count];
        // First, resolve strip_base = past the LAST buffer's HsfFace[] array, matching how the
        // loader's `strip` pointer ends up after its first loop (hsfload.c:418-424): it is left
        // pointing at &((HsfFace*)last_buf->data)[last_buf->count].
        unsigned char *strip_base = data_base;
        {
            s32 last = h->face.count - 1;
            u32 last_dofs = bsw32((u32)b[last].data);   // peek (not yet swapped in place) for base
            s32 last_cnt  = (s32)bsw32((u32)b[last].count);
            strip_base = data_base + last_dofs + (u32)last_cnt * (u32)sizeof(HsfFace);
        }
        for (i = 0; i < h->face.count; i++) {
            sw32f(&b[i].name);
            b[i].count = (s32)bsw32((u32)b[i].count);
            u32 dofs = sw32f(&b[i].data);
            HsfFace *f = (HsfFace *)(data_base + dofs);
            for (j = 0; j < b[i].count; j++) {
                u16 type = sw16f(&f[j].type);       // read type after swapping it
                f[j].mat = (s16)bsw16((u16)f[j].mat);
                if (type == 4) {
                    // strip variant: 3x4 s16 inline indices, then u32 count, then s16* data index
                    s16 *idx = &f[j].strip.indices[0][0];
                    for (k = 0; k < 3 * 4; k++) idx[k] = (s16)bsw16((u16)idx[k]);
                    u32 scount = bsw32(f[j].strip.count); f[j].strip.count = scount;
                    u32 sidx   = sw32f(&f[j].strip.data);   // index into shared strip table
                    // Swap the shared-table run for this strip: scount * 4 s16 at
                    // strip_base + sidx * (sizeof(s16)*4).
                    s16 *st16 = (s16 *)(strip_base + sidx * (u32)(sizeof(s16) * 4));
                    for (k = 0; k < (s32)scount * 4; k++) st16[k] = (s16)bsw16((u16)st16[k]);
                } else {
                    // non-strip variant: 4x4 s16 indices fill the union
                    s16 *idx = &f[j].indices[0][0];
                    for (k = 0; k < 4 * 4; k++) idx[k] = (s16)bsw16((u16)idx[k]);
                }
                swVec(&f[j].nbt);
            }
        }
    }

    // --- 10. object section : HsfObject[count] ------------------------------------------------
    // { char *name; u32 type; void *constData; u32 flags; union{ HsfObjectData | HsfCamera |
    //   HsfLight } }. DispObject only handles the data-arm object types (NULL1/REPLICA/MESH/ROOT/
    //   JOINT/NULL2/MAP); camera/light arms (types 7/8) are all-32-bit-field layouts (a per-word
    //   32-bit swap is correct for camera; a light's packed u8 type/r/g/b would be mis-swapped,
    //   but MP4 boot/model objects use the data arm). We swap the data arm for every object.
    if (h->object.count) { HT(8);
        HsfObject *o = (HsfObject *)(base + h->object.ofs);
        for (i = 0; i < h->object.count; i++) {
            sw32f(&o[i].name);
            u32 type = sw32f(&o[i].type);   // swap type, then branch on it
            sw32f(&o[i].constData);
            o[i].flags = bsw32(o[i].flags);
            (void)type;
            {
                HsfObjectData *d = &o[i].data;
                sw32f(&d->parent);
                d->childrenCount = bsw32(d->childrenCount);
                sw32f(&d->children);            // offset/symbol-index array base
                // base + curr : two HsfTransform = 2 x (Vec pos, Vec rot, Vec scale)
                swVec(&d->base.pos);  swVec(&d->base.rot);  swVec(&d->base.scale);
                swVec(&d->curr.pos);  swVec(&d->curr.rot);  swVec(&d->curr.scale);
                // union: mesh { Vec3f min; Vec3f max; f32 baseMorph; f32 morphWeight[33] }
                //        overlaps replica pointer (first 4 bytes). Swap the mesh arm (largest);
                // for a replica object the first f32 (min.x) aliases the replica offset -- a
                // 32-bit swap is correct for both interpretations (both are 32-bit words).
                bswf32(&d->mesh.min.x); bswf32(&d->mesh.min.y); bswf32(&d->mesh.min.z);
                bswf32(&d->mesh.max.x); bswf32(&d->mesh.max.y); bswf32(&d->mesh.max.z);
                bswf32(&d->mesh.baseMorph);
                for (j = 0; j < 33; j++) bswf32(&d->mesh.morphWeight[j]);
                // buffer/material/attribute references (stored as indices/offsets)
                sw32f(&d->face);
                sw32f(&d->vertex);
                sw32f(&d->normal);
                sw32f(&d->color);
                sw32f(&d->st);
                sw32f(&d->material);
                sw32f(&d->attribute);
                /* unk120[2] u8 ; shapeType u8 ; unk123 u8 -> no swap */
                d->vertexShapeCnt = bsw32(d->vertexShapeCnt);
                sw32f(&d->vertexShape);
                d->clusterCnt = bsw32(d->clusterCnt);
                sw32f(&d->cluster);
                d->cenvCnt = bsw32(d->cenvCnt);
                sw32f(&d->cenv);
                // file[0]/file[1]: ABSOLUTE byte offsets (from file base — unlike the section-
                // relative pools) to PRISTINE COPIES of this mesh's vertex/normal arrays, used
                // by the skinning/morph paths as per-frame restore sources (ClusterExec.c:125,
                // EnvelopeExec.c:176/179). The section sweeps never reach them, so the per-frame
                // restore was copying BE floats over the swapped draw buffers (the measured
                // "arrays revert to BE" / streak-geometry bug). Swap their elements here — only
                // for the mesh arm with skinning data (type==2 && cenvCnt, matching every deref
                // gate), with the count from the (already-swapped) vertex/normal buffer headers,
                // deduped in case two objects share one copy region.
                {
                    u32 f0 = sw32f(&d->file[0]);
                    u32 f1 = sw32f(&d->file[1]);
                    if (type == 2 && d->cenvCnt != 0) {
                        s32 vidx = (s32)(u32)d->vertex;
                        s32 nidx = (s32)(u32)d->normal;
                        if (f0 && vidx >= 0 && vidx < h->vertex.count) {
                            HsfBuffer *vb = (HsfBuffer *)(base + h->vertex.ofs);
                            hsf_swap_copy_region(base, f0, (u32)vb[vidx].count * 3u);
                        }
                        if (f1 && nidx >= 0 && nidx < h->normal.count) {
                            HsfBuffer *nb = (HsfBuffer *)(base + h->normal.ofs);
                            hsf_swap_copy_region(base, f1, (u32)nb[nidx].count * 3u);
                        }
                    }
                }
            }
        }
    }

    // --- 11. bitmap section : HsfBitmap[count] ------------------------------------------------
    // { char *name; u32 maxLod; u8 dataFmt; u8 pixSize; s16 sizeX; s16 sizeY; s16 palSize;
    //   GXColor tint(4xu8); void *palData; u32 unk; void *data }. Pixel DATA is not swapped here.
    if (h->bitmap.count) { HT(9);
        HsfBitmap *bm = (HsfBitmap *)(base + h->bitmap.ofs);
        for (i = 0; i < h->bitmap.count; i++) {
            sw32f(&bm[i].name);
            bm[i].maxLod = bsw32(bm[i].maxLod);
            /* dataFmt u8 ; pixSize u8 -> no swap */
            bm[i].sizeX   = (s16)bsw16((u16)bm[i].sizeX);
            bm[i].sizeY   = (s16)bsw16((u16)bm[i].sizeY);
            bm[i].palSize = (s16)bsw16((u16)bm[i].palSize);
            /* tint GXColor 4xu8 -> no swap */
            sw32f(&bm[i].palData);
            bm[i].unk = bsw32(bm[i].unk);
            sw32f(&bm[i].data);
        }
    }

    // --- 12. palette section : HsfPalette[count] + appended u16 palette entries ----------------
    // { char *name; s32 unk; u32 palSize; u16 *data(BYTE offset) }. PaletteLoad (hsfload.c:961,969)
    // resolves data as `(u32)data_base + (u32)palette->data` -> a genuine BYTE offset (NOT a u16
    // element index like part/mapAttr), so `data_base + dofs` is correct here. The appended
    // palette entries are 16-bit color words -> swap each as u16.
    if (h->palette.count) { HT(10);
        HsfPalette *p = (HsfPalette *)(base + h->palette.ofs);
        unsigned char *data_base = (unsigned char *)&p[h->palette.count];
        for (i = 0; i < h->palette.count; i++) {
            sw32f(&p[i].name);
            p[i].unk     = (s32)bsw32((u32)p[i].unk);
            p[i].palSize = bsw32(p[i].palSize);
            u32 dofs = sw32f(&p[i].data);              // BYTE offset (hsfload.c:961)
            u16 *pal = (u16 *)(data_base + dofs);
            for (j = 0; j < (s32)p[i].palSize; j++) pal[j] = bsw16(pal[j]);
        }
    }

    // --- 13. motion section : HsfMotion[count] + appended HsfTrack[] + appended keyframe data ---
    // { char *name; s32 numTracks; HsfTrack *track(offset); f32 len }. The HsfTrack[] array is
    // appended after the HsfMotion[] array (track_base = &motion[count]); the keyframe curve data
    // follows the tracks (track_data = &track_base[numTracks]) -- exactly as MotionLoad computes
    // it (hsfload.c:1344-1345). MotionLoad sizes the track array from motion[0].numTracks.
    if (h->motion.count) { HT(11);
        HsfMotion *mo = (HsfMotion *)(base + h->motion.ofs);
        for (i = 0; i < h->motion.count; i++) {
            sw32f(&mo[i].name);
            mo[i].numTracks = (s32)bsw32((u32)mo[i].numTracks);   // store swapped value back
            sw32f(&mo[i].track);                                  // offset (relocated later)
            bswf32(&mo[i].len);
        }
        {
            s32 nTracks = mo[0].numTracks;                        // already swapped above
            HsfTrack *tr = (HsfTrack *)&mo[h->motion.count];      // track_base
            unsigned char *track_data = (unsigned char *)&tr[nTracks];
            for (j = 0; j < nTracks; j++) {
                // HsfTrack: { u8 type; u8 start;
                //   union{u16 target|s16};
                //   union{ s32 unk04 | { union{s16 param|u16}; union{u16 channel|s16} } };
                //   u16 curveType; u16 numKeyframes; union{ f32 value | void *data } }
                /* type u8 ; start u8 -> no swap */
                tr[j].target = bsw16(tr[j].target);          // u16 target (16-bit either way)
                // The unk04 word: type-6 (CLUSTER_WEIGHT) tracks read it as ONE 32-bit index
                // (hsfmotion.c:741 `->unk04`), so those need a 32-bit swap. Every other track
                // type reads param (low u16) and channel (high u16) as INDEPENDENT 16-bit fields
                // (hsfmotion.c:683,691,700,726,747,899,906,954,961,772) -> per-u16 swap, or the
                // two halves get transposed. Dispatch on the (unswapped) track type byte.
                if (tr[j].type == HSF_TRACK_CLUSTER_WEIGHT) {
                    tr[j].unk04 = (s32)bsw32((u32)tr[j].unk04);   // single 32-bit index
                } else {
                    tr[j].param   = (s16)bsw16((u16)tr[j].param);   // low u16
                    tr[j].channel = bsw16(tr[j].channel);           // high u16
                }
                tr[j].curveType    = bsw16(tr[j].curveType);
                tr[j].numKeyframes = bsw16(tr[j].numKeyframes);
                // Final union is a 32-bit word (f32 value OR void* data offset) -> 32-bit swap.
                // Capture the (swapped) value/offset for keyframe traversal below.
                u32 dataOfs = sw32f(&tr[j].value);
                // Swap the appended keyframe curve data this track points into.
                swTrackKeyframes(track_data, tr[j].curveType, tr[j].numKeyframes, dataOfs);
            }
        }
    }

    // --- 14. cenv section : HsfCenv[count] + appended single/dual/multi weight arrays -----------
    // HsfCenv: { char *name; HsfCenvSingle *singleData(ofs); HsfCenvDual *dualData(ofs);
    //   HsfCenvMulti *multiData(ofs); u32 singleCount; u32 dualCount; u32 multiCount; u32 vtxCount;
    //   u32 copyCount }. Appended data holds the single/dual/multi element arrays, then the
    //   dual/multi weight sub-arrays. Per CenvLoad (hsfload.c:726,732-734) the single/dual/multi
    //   element-array offsets are relative to data_base = &cenv[count] (NOT the file base), and
    //   the dual/multi weight offsets are relative to weight_base (past all element arrays,
    //   hsfload.c:740-742,759,768).
    if (h->cenv.count) { HT(12);
        HsfCenv *c = (HsfCenv *)(base + h->cenv.ofs);
        unsigned char *data_base = (unsigned char *)&c[h->cenv.count];
        // First pass: swap the HsfCenv records themselves (offsets + counts) and remember counts.
        for (i = 0; i < h->cenv.count; i++) {
            sw32f(&c[i].name);
            sw32f(&c[i].singleData);
            sw32f(&c[i].dualData);
            sw32f(&c[i].multiData);
            c[i].singleCount = bsw32(c[i].singleCount);
            c[i].dualCount   = bsw32(c[i].dualCount);
            c[i].multiCount  = bsw32(c[i].multiCount);
            c[i].vtxCount    = bsw32(c[i].vtxCount);
            c[i].copyCount   = bsw32(c[i].copyCount);
        }
        // Second pass: swap the element arrays and their weight sub-arrays. weight_base advances
        // past the single+dual+multi element arrays of every cenv, matching hsfload.c:740-742.
        {
            unsigned char *weight_base = data_base;
            for (i = 0; i < h->cenv.count; i++) {
                weight_base += c[i].singleCount * (u32)sizeof(HsfCenvSingle);
                weight_base += c[i].dualCount   * (u32)sizeof(HsfCenvDual);
                weight_base += c[i].multiCount  * (u32)sizeof(HsfCenvMulti);
            }
            for (i = 0; i < h->cenv.count; i++) {
                // Element arrays are relative to data_base (hsfload.c:732-734), NOT the file base.
                // HsfCenvSingle: { u32 target; u16 pos; u16 posCnt; u16 normal; u16 normalCnt }
                HsfCenvSingle *sg = (HsfCenvSingle *)(data_base + (u32)c[i].singleData);
                for (j = 0; j < (s32)c[i].singleCount; j++) {
                    sg[j].target    = bsw32(sg[j].target);
                    sg[j].pos       = bsw16(sg[j].pos);
                    sg[j].posCnt    = bsw16(sg[j].posCnt);
                    sg[j].normal    = bsw16(sg[j].normal);
                    sg[j].normalCnt = bsw16(sg[j].normalCnt);
                }
                // HsfCenvDual: { u32 target1; u32 target2; u32 weightCnt; HsfCenvDualWeight *weight(ofs) }
                HsfCenvDual *du = (HsfCenvDual *)(data_base + (u32)c[i].dualData);
                for (j = 0; j < (s32)c[i].dualCount; j++) {
                    du[j].target1   = bsw32(du[j].target1);
                    du[j].target2   = bsw32(du[j].target2);
                    u32 wcnt        = bsw32(du[j].weightCnt); du[j].weightCnt = wcnt;
                    u32 wofs        = sw32f(&du[j].weight);
                    // HsfCenvDualWeight: { f32 weight; u16 pos; u16 posCnt; u16 normal; u16 normalCnt }
                    HsfCenvDualWeight *w = (HsfCenvDualWeight *)(weight_base + wofs);
                    for (k = 0; k < (s32)wcnt; k++) {
                        bswf32(&w[k].weight);
                        w[k].pos       = bsw16(w[k].pos);
                        w[k].posCnt    = bsw16(w[k].posCnt);
                        w[k].normal    = bsw16(w[k].normal);
                        w[k].normalCnt = bsw16(w[k].normalCnt);
                    }
                }
                // HsfCenvMulti: { u32 weightCnt; u16 pos; u16 posCnt; u16 normal; u16 normalCnt;
                //   HsfCenvMultiWeight *weight(ofs) }
                HsfCenvMulti *mu = (HsfCenvMulti *)(data_base + (u32)c[i].multiData);
                for (j = 0; j < (s32)c[i].multiCount; j++) {
                    u32 wcnt        = bsw32(mu[j].weightCnt); mu[j].weightCnt = wcnt;
                    mu[j].pos       = bsw16(mu[j].pos);
                    mu[j].posCnt    = bsw16(mu[j].posCnt);
                    mu[j].normal    = bsw16(mu[j].normal);
                    mu[j].normalCnt = bsw16(mu[j].normalCnt);
                    u32 wofs        = sw32f(&mu[j].weight);
                    // HsfCenvMultiWeight: { u32 target; f32 value }
                    HsfCenvMultiWeight *w = (HsfCenvMultiWeight *)(weight_base + wofs);
                    for (k = 0; k < (s32)wcnt; k++) {
                        w[k].target = bsw32(w[k].target);
                        bswf32(&w[k].value);
                    }
                }
            }
        }
    }

    // --- 15. skeleton section : HsfSkeleton[count] { char *name; HsfTransform transform } -------
    if (h->skeleton.count) { HT(13);
        HsfSkeleton *sk = (HsfSkeleton *)(base + h->skeleton.ofs);
        for (i = 0; i < h->skeleton.count; i++) {
            sw32f(&sk[i].name);
            swVec(&sk[i].transform.pos);
            swVec(&sk[i].transform.rot);
            swVec(&sk[i].transform.scale);
        }
    }

    // --- 16. part section : HsfPart[count] + appended u16 vertex-index arrays -------------------
    // { char *name; u32 count; u16 *vertex(u16 ELEMENT index) }. PartLoad (hsfload.c:821,825) does
    // `data = (u16*)&part[count]; part->vertex = &data[(u32)part->vertex]` -> the stored field is a
    // u16 element index, scaled by sizeof(u16). Index as u16, NOT as a raw byte offset.
    if (h->part.count) { HT(14);
        HsfPart *pt = (HsfPart *)(base + h->part.ofs);
        unsigned char *data_base = (unsigned char *)&pt[h->part.count];
        for (i = 0; i < h->part.count; i++) {
            sw32f(&pt[i].name);
            u32 cnt = bsw32(pt[i].count); pt[i].count = cnt;
            u32 vofs = sw32f(&pt[i].vertex);
            u16 *vtx = (u16 *)data_base + vofs;        // u16 element index (hsfload.c:825)
            for (j = 0; j < (s32)cnt; j++) vtx[j] = bsw16(vtx[j]);
        }
    }

    // --- 17. cluster section : HsfCluster[count] ----------------------------------------------
    // { char *name[2]; union{char*targetName|s32 target}; HsfPart *part(idx); f32 unk10;
    //   f32 unk14[1]; u8 unk18[124]; u8 adjusted; u8 unk95; u16 type; u32 vertexCnt;
    //   HsfBuffer **vertex(symbol-idx) }.
    if (h->cluster.count) { HT(15);
        HsfCluster *cl = (HsfCluster *)(base + h->cluster.ofs);
        for (i = 0; i < h->cluster.count; i++) {
            sw32f(&cl[i].name[0]);
            sw32f(&cl[i].name[1]);
            sw32f(&cl[i].targetName);       // union with s32 target -> 32-bit either way
            sw32f(&cl[i].part);             // part index/offset (SearchPartPtr consumes it)
            bswf32(&cl[i].unk10);
            bswf32(&cl[i].unk14[0]);
            /* unk18[124] u8 ; adjusted u8 ; unk95 u8 -> no swap */
            cl[i].type      = bsw16(cl[i].type);
            cl[i].vertexCnt = bsw32(cl[i].vertexCnt);
            // Fix C: the weight array REALLY extends past unk14[0] into the unk18[124] bytes
            // (read up to vertexCnt floats per frame, ClusterExec.c:56/67) — swap the rest.
            { s32 wn = (s32)cl[i].vertexCnt; if (wn > 32) wn = 32;
              for (j = 1; j < wn; j++) bswf32(&cl[i].unk14[j]); }
            sw32f(&cl[i].vertex);           // symbol-index array base
        }
    }

    // --- 18. shape section : HsfShape[count] --------------------------------------------------
    // { char *name; union{u16 count16[2] | u32 vertexCnt}; HsfBuffer **vertex(symbol-idx) }.
    // ShapeLoad reads the union as two u16 (count16[0], count16[1]; hsfload.c:879-880) -> swap as
    // two u16 so both halves are individually correct.
    if (h->shape.count) { HT(16);
        HsfShape *sh = (HsfShape *)(base + h->shape.ofs);
        for (i = 0; i < h->shape.count; i++) {
            sw32f(&sh[i].name);
            sh[i].count16[0] = bsw16(sh[i].count16[0]);
            sh[i].count16[1] = bsw16(sh[i].count16[1]);
            sw32f(&sh[i].vertex);           // symbol-index array base
        }
    }

    // --- 19. mapAttr section : HsfMapAttr[count] + appended u16 data ----------------------------
    // { f32 minX; f32 minZ; f32 maxX; f32 maxZ; u16 *data(u16 ELEMENT index); u32 dataLen }.
    // MapAttrLoad (hsfload.c:904,906) does `data = (u16*)&mapattr[count]; mapattr->data =
    // &data[(u32)mapattr->data]` -> the stored field is a u16 element index, scaled by sizeof(u16).
    // Index as u16, NOT as a raw byte offset.
    if (h->mapAttr.count) { HT(17);
        HsfMapAttr *ma = (HsfMapAttr *)(base + h->mapAttr.ofs);
        unsigned char *data_base = (unsigned char *)&ma[h->mapAttr.count];
        for (i = 0; i < h->mapAttr.count; i++) {
            bswf32(&ma[i].minX);
            bswf32(&ma[i].minZ);
            bswf32(&ma[i].maxX);
            bswf32(&ma[i].maxZ);
            u32 dofs = sw32f(&ma[i].data);
            u32 dlen = bsw32(ma[i].dataLen); ma[i].dataLen = dlen;
            u16 *d = (u16 *)data_base + dofs;          // u16 element index (hsfload.c:906)
            for (j = 0; j < (s32)dlen; j++) d[j] = bsw16(d[j]);
        }
    }

    // --- 20. matrix section : HsfMatrix header + appended Mtx[] ---------------------------------
    // { u32 base_idx; u32 count; Mtx *data(offset) } followed immediately by `count` Mtx (each
    // 3x4 f32). MatrixLoad (hsfload.c:1406-1409) reads exactly ONE HsfMatrix header and sets
    // data = ofs + sizeof(HsfMatrix). The Mtx-array length is the HsfMatrix struct's own `count`
    // field (indexed at hsfdraw.c:223 `matrix->data[idx + base_idx]`), NOT head.matrix.count
    // (which the loader stores as Model.matrixCnt, a section count). Swap `mx->count` matrices.
    if (h->matrix.count) { HT(18);
        HsfMatrix *mx = (HsfMatrix *)(base + h->matrix.ofs);
        u32 mcount = bsw32(mx->count); mx->count = mcount;
        mx->base_idx = bsw32(mx->base_idx);
        sw32f(&mx->data);                   // offset field (loader overwrites, but keep consistent)
        // Appended Mtx array: mx->count matrices, each 3x4 = 12 f32.
        f32 *mtx = (f32 *)((unsigned char *)mx + sizeof(HsfMatrix));
        for (j = 0; j < (s32)mcount * 12; j++) bswf32(&mtx[j]);
    }

    // --- 21. symbol section : s32[count] (array of string-table offsets) -----------------------
    // NSymIndex = fileptr + head.symbol.ofs; it is an array of s32 offsets -> bsw32 each.
    if (h->symbol.count) { HT(19);
        s32 *sym = (s32 *)(base + h->symbol.ofs);
        for (i = 0; i < h->symbol.count; i++) {
            sym[i] = (s32)bsw32((u32)sym[i]);
        }
    }

    // --- string section : raw char string table -> DO NOT SWAP any bytes. (handled by omission) -
}

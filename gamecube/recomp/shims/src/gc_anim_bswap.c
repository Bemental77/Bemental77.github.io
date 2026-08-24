// [wasm-recomp 2026-08-22, REL_ENDIANNESS_PLAN.md step 5] Byte-swap a sprite AnimData tree
// in place, BE (GameCube asset) -> LE (wasm native). The decomp reads every AnimData field as a
// native struct access (sprman.c HuSprAnimRead + the sprite render path), which is wrong on the
// little-endian wasm target. We swap the whole tree ONCE at decode time (bootDll
// NintendoDataDecode) so HuSprAnimRead then relocates a correct LE tree — this also fixes the
// sentinel at sprman.c:217 (anim->bank & 0xFFFF0000), which would false-positive on a BE offset.
//
// Layout per include/game/animdata.h (offsets in the asset are relative to the AnimData base):
//   AnimData(0x14): bankNum/patNum/bmpNum/useNum s16 @0/2/4/6 ; bank/pat/bmp u32-offset @8/0xC/0x10
//   AnimBankData(8): timeNum/unk s16 ; frame u32-offset       AnimFrameData(0xC): 6 s16
//   AnimPatData(0x10): layerNum/centerX/centerY/sizeX/sizeY s16 ; layer u32-offset
//   AnimLayerData(0x20): alpha/flip u8 (no swap) ; 7 s16 ; vtx[8] s16
//   AnimBmpData(0x14): pixSize/dataFmt u8 (no swap) ; palNum/sizeX/sizeY s16 ; dataSize u32 ;
//                      palData/data u32-offset  (NOTE: 16-bit pixel/palette DATA is not swapped
//                      here — geometry draws; per-texel color endianness is a follow-on.)
#include "game/animdata.h"

static u16 bsw16(u16 v) { return (u16)((v >> 8) | (v << 8)); }
static u32 bsw32(u32 v) { return (v >> 24) | ((v >> 8) & 0xFF00u) | ((v << 8) & 0xFF0000u) | (v << 24); }

// Expose the most-recently-swapped AnimData so the render harness can pull the texture out of
// guest memory (HuSprAnimRead later relocates bmp->data/palData to full pointers).
void *__recomp_animtree_ptr = 0;
void *__recomp_get_animtree(void) { return __recomp_animtree_ptr; }
// Track the AnimData with the LARGEST first bitmap (the full-screen background sprite) so the
// harness can extract + render it for a visible title frame.
void *__recomp_bg_animtree_ptr = 0;
static unsigned __recomp_bg_area = 0;
void *__recomp_get_bg_animtree(void) { return __recomp_bg_animtree_ptr; }
// Record EVERY swapped sprite AnimData so the harness can extract each and composite a full title.
#define RECOMP_ANIM_MAX 64
void *__recomp_anim_list[RECOMP_ANIM_MAX];
int __recomp_anim_count = 0;
void *__recomp_get_anim_at(int i) { return (i >= 0 && i < __recomp_anim_count) ? __recomp_anim_list[i] : 0; }
int __recomp_get_anim_count(void) { return __recomp_anim_count; }

void __recomp_bswap_animtree(void *datav) {
    __recomp_animtree_ptr = datav;
    if (__recomp_anim_count < RECOMP_ANIM_MAX) __recomp_anim_list[__recomp_anim_count++] = datav;
    unsigned char *base = (unsigned char *)datav;
    AnimData *a = (AnimData *)datav;
    int i, j, k;

    a->bankNum = bsw16(a->bankNum);
    a->patNum  = bsw16(a->patNum);
    a->bmpNum  = bsw16(a->bmpNum);
    a->useNum  = bsw16(a->useNum);
    a->bank = (AnimBankData *)bsw32((u32)a->bank);
    a->pat  = (AnimPatData *)bsw32((u32)a->pat);
    a->bmp  = (AnimBmpData *)bsw32((u32)a->bmp);

    { AnimBankData *bank = (AnimBankData *)(base + (u32)a->bank);
      for (i = 0; i < a->bankNum; i++) {
        bank[i].timeNum = bsw16(bank[i].timeNum);
        bank[i].unk     = bsw16(bank[i].unk);
        bank[i].frame   = (AnimFrameData *)bsw32((u32)bank[i].frame);
        AnimFrameData *fr = (AnimFrameData *)(base + (u32)bank[i].frame);
        for (j = 0; j < bank[i].timeNum; j++) {
          fr[j].pat = bsw16(fr[j].pat); fr[j].time = bsw16(fr[j].time);
          fr[j].shiftX = bsw16(fr[j].shiftX); fr[j].shiftY = bsw16(fr[j].shiftY);
          fr[j].flip = bsw16(fr[j].flip); fr[j].pad = bsw16(fr[j].pad);
        }
      } }

    { AnimPatData *pat = (AnimPatData *)(base + (u32)a->pat);
      for (i = 0; i < a->patNum; i++) {
        pat[i].layerNum = bsw16(pat[i].layerNum);
        pat[i].centerX = bsw16(pat[i].centerX); pat[i].centerY = bsw16(pat[i].centerY);
        pat[i].sizeX = bsw16(pat[i].sizeX); pat[i].sizeY = bsw16(pat[i].sizeY);
        pat[i].layer = (AnimLayerData *)bsw32((u32)pat[i].layer);
        AnimLayerData *ly = (AnimLayerData *)(base + (u32)pat[i].layer);
        for (j = 0; j < pat[i].layerNum; j++) {
          /* alpha, flip are u8 */
          ly[j].bmpNo = bsw16(ly[j].bmpNo);
          ly[j].startX = bsw16(ly[j].startX); ly[j].startY = bsw16(ly[j].startY);
          ly[j].sizeX = bsw16(ly[j].sizeX); ly[j].sizeY = bsw16(ly[j].sizeY);
          ly[j].shiftX = bsw16(ly[j].shiftX); ly[j].shiftY = bsw16(ly[j].shiftY);
          for (k = 0; k < 8; k++) ly[j].vtx[k] = bsw16(ly[j].vtx[k]);
        }
      } }

    { AnimBmpData *bmp = (AnimBmpData *)(base + (u32)a->bmp);
      for (i = 0; i < a->bmpNum; i++) {
        /* pixSize, dataFmt are u8 */
        bmp[i].palNum = bsw16(bmp[i].palNum);
        bmp[i].sizeX = bsw16(bmp[i].sizeX); bmp[i].sizeY = bsw16(bmp[i].sizeY);
        bmp[i].dataSize = bsw32(bmp[i].dataSize);
        bmp[i].palData = (void *)bsw32((u32)bmp[i].palData);
        bmp[i].data = (void *)bsw32((u32)bmp[i].data);
      }
      if (a->bmpNum > 0) {
        unsigned area = (unsigned)bmp[0].sizeX * (unsigned)bmp[0].sizeY;
        if (area > __recomp_bg_area) { __recomp_bg_area = area; __recomp_bg_animtree_ptr = datav; }
      } }
}

// Swap a fresh sprite AnimData blob BE->LE and return it, for the general sprite-load path.
// HuSprAnimReadFile(id) = HuSprAnimRead(HuDataSelHeapReadNum(...)); we wrap the inner read so the
// BE disc AnimData is swapped ONCE before HuSprAnimRead relocates it (whose sentinel
// `anim->bank & 0xFFFF0000` otherwise mis-fires on a BE offset and silently drops the sprite).
// Each HuSprAnimReadFile call gets a fresh malloc'd blob, so this swaps exactly once per load.
// The bootDll logo does NOT use this macro (it calls HuSprAnimRead on NintendoDataDecode()'s
// already-swapped output), so it is unaffected.
void *__recomp_bswap_animtree_ret(void *datav) {
    if (datav) __recomp_bswap_animtree(datav);
    return datav;
}

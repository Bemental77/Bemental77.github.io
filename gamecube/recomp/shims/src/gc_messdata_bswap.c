// [wasm-recomp 2026-08-23] Byte-swap a message-data (.bin) blob BE->LE, once, after HuWinMesRead
// loads+copies it. messdata.c (MessData_MesDataGet + _MessData_MesPtrGet) walks this blob with
// native little-endian loads; the disc .bin is big-endian, so max-bank count / bank-table /
// per-message offsets read as garbage -> MessData_MesPtrGet returns a wild pointer ->
// GetMesMaxSizeSub derefs it -> OOB (the demo/movie subtitle window; a LATENT bug both builds hit).
//
// NOTE: use PLAIN types (not stdint) — the decomp's stub <stdint.h> shadows emscripten's, so
// uint16_t/uint32_t are undefined here. No <string.h> either (its stub redeclares builtins).
//
// Format (messdata.c): d[0]=max_bank(s32); d[1]=byte-offset to the bank table; bank table @base+d[1]
// = max_bank pairs of { u16 bank_id, u16 data_index }; a bank's byte offset is d[1+data_index](s32);
// a bank @base+bank_ofs = [0]=max_index(s32), [1..max_index]=per-message byte offsets(s32).

static unsigned short b16(unsigned short v) { return (unsigned short)((v >> 8) | (v << 8)); }
static unsigned int b32(unsigned int v) { return (v >> 24) | ((v >> 8) & 0xFF00u) | ((v << 8) & 0xFF0000u) | (v << 24); }
static int sw32(void *p) { unsigned int v = *(unsigned int *)p; v = b32(v); *(unsigned int *)p = v; return (int)v; }
static unsigned short sw16(void *p) { unsigned short v = *(unsigned short *)p; v = b16(v); *(unsigned short *)p = v; return v; }

void __recomp_bswap_messdata(void *md, int size) {
    unsigned char *base = (unsigned char *)md;
    int *d = (int *)md;
    int max_bank, tbl_ofs, i, j, k;
    unsigned short *banks;
    static unsigned short di[4096];
    if (!md || size < 8) return;
    max_bank = sw32(&d[0]);
    tbl_ofs  = sw32(&d[1]);
    if (max_bank <= 0 || max_bank > 4096) return;   // sanity — not a message blob / already swapped
    if (tbl_ofs < 0 || tbl_ofs + max_bank * 4 > size) return;
    banks = (unsigned short *)(base + tbl_ofs);
    for (i = 0; i < max_bank; i++) { sw16(&banks[i * 2]); di[i] = sw16(&banks[i * 2 + 1]); }
    for (i = 0; i < max_bank; i++) {
        int dup = 0, bank_ofs, max_index;
        int *bd;
        for (k = 0; k < i; k++) if (di[k] == di[i]) { dup = 1; break; }
        if (dup || di[i] == 0) continue;            // d[1] already swapped; skip duplicate index
        if ((int)di[i] + 1 > size / 4) continue;                       // bank-offset slot in range
        bank_ofs = sw32(&d[1 + di[i]]);
        if (bank_ofs < 0 || bank_ofs + 4 > size) continue;             // bank header in range
        bd = (int *)(base + bank_ofs);
        max_index = sw32(&bd[0]);
        // bound max_index BEFORE multiplying (avoids the (max_index+1)*4 int overflow that let a
        // garbage count through -> OOB read). size/4 is the absolute max s32 slots in the blob.
        if (max_index <= 0 || max_index > (size - bank_ofs) / 4 - 1) continue;
        for (j = 0; j < max_index; j++) sw32(&bd[1 + j]);
    }
}

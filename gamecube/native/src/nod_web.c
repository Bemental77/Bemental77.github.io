// nod's C API for GameCube disc images — see shim/nod.h. A disc and its data partition are the same
// stream (a GameCube disc has no partitions); a file handle is a window [base, base+size) onto it.
#include <stdlib.h>
#include <string.h>
#include "nod.h"

typedef struct Disc { NodDiscStream s; uint64_t size; int refs; NodPartitionMeta meta; uint8_t* fst; uint32_t fstSize; } Disc;
struct NodHandle { int kind; Disc* d; uint64_t base, size, pos; uint8_t* buf; };   // kind 0 disc, 1 partition, 2 file

static uint32_t be32(const uint8_t* p) { return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | p[3]; }
static int rd(Disc* d, uint64_t off, void* out, size_t len) { return d->s.read_at(d->s.user_data, off, out, len) == (int64_t)len ? 0 : -1; }
static NodHandle* mk(int kind, Disc* d, uint64_t base, uint64_t size) { NodHandle* h = calloc(1, sizeof *h); h->kind = kind; h->d = d; h->base = base; h->size = size; d->refs++; return h; }

NodResult nod_disc_open_stream(const NodDiscStream* stream, const NodDiscOptions* options, NodHandle** out) {
  (void)options;
  Disc* d = calloc(1, sizeof *d); d->s = *stream;
  int64_t n = stream->stream_len ? stream->stream_len(stream->user_data) : -1;
  if (n < 0x440) { free(d); return NOD_RESULT_ERR_IO; }
  d->size = (uint64_t)n;
  uint8_t magic[4];
  if (rd(d, 0x1C, magic, 4) || be32(magic) != 0xC2339F3D) { free(d); return NOD_RESULT_ERR_FORMAT; }   // GameCube disc magic
  *out = mk(0, d, 0, d->size);
  return NOD_RESULT_OK;
}
NodResult nod_disc_header(NodHandle* h, NodDiscHeader* o) {
  uint8_t b[0x60];
  if (rd(h->d, 0, b, sizeof b)) return NOD_RESULT_ERR_IO;
  memset(o, 0, sizeof *o);
  memcpy(o->game_id, b, 6); o->disc_num = b[6]; o->disc_version = b[7]; o->audio_streaming = b[8]; o->audio_stream_buf_size = b[9];
  memcpy(o->game_title, b + 0x20, 63);
  return NOD_RESULT_OK;
}
uint64_t nod_disc_size(NodHandle* h) { return h->d->size; }
NodResult nod_disc_open_partition_kind(NodHandle* h, NodPartitionKind kind, const void* opt, NodHandle** out) {
  (void)opt;
  if (kind != NOD_PARTITION_KIND_DATA) return NOD_RESULT_ERR_FORMAT;
  *out = mk(1, h->d, 0, h->d->size);
  return NOD_RESULT_OK;
}
static NodResult load_fst(Disc* d) {
  if (d->fst) return NOD_RESULT_OK;
  uint8_t b[12];
  if (rd(d, 0x424, b, 12)) return NOD_RESULT_ERR_IO;
  uint32_t off = be32(b), size = be32(b + 4);
  if (!size || off + (uint64_t)size > d->size) return NOD_RESULT_ERR_FORMAT;
  d->fst = malloc(size); d->fstSize = size;
  if (rd(d, off, d->fst, size)) { free(d->fst); d->fst = 0; return NOD_RESULT_ERR_IO; }
  return NOD_RESULT_OK;
}
NodResult nod_partition_meta(NodHandle* h, NodPartitionMeta* o) {
  Disc* d = h->d;
  if (!d->meta.raw_dol.data) {
    uint8_t b[4], hdr[0x100];
    if (rd(d, 0x420, b, 4)) return NOD_RESULT_ERR_IO;
    uint32_t dolOff = be32(b);
    if (rd(d, dolOff, hdr, sizeof hdr)) return NOD_RESULT_ERR_IO;
    uint32_t end = 0x100;
    for (int i = 0; i < 18; i++) {   // 7 text + 11 data sections: offsets at 0x00, sizes at 0x90
      uint32_t so = be32(hdr + 4 * i), ss = be32(hdr + 0x90 + 4 * i);
      if (so && ss && so + ss > end) end = so + ss;
    }
    uint8_t* dol = malloc(end);
    if (rd(d, dolOff, dol, end)) { free(dol); return NOD_RESULT_ERR_IO; }
    d->meta.raw_dol.data = dol; d->meta.raw_dol.size = end;
    uint8_t* boot = malloc(0x440);
    if (!rd(d, 0, boot, 0x440)) { d->meta.raw_boot.data = boot; d->meta.raw_boot.size = 0x440; } else free(boot);
    if (load_fst(d) == NOD_RESULT_OK) { d->meta.raw_fst.data = d->fst; d->meta.raw_fst.size = d->fstSize; }
  }
  *o = d->meta;
  return NOD_RESULT_OK;
}
uint32_t nod_partition_iterate_fst(NodHandle* h, NodFstCallback cb, void* ud) {
  Disc* d = h->d;
  if (load_fst(d) != NOD_RESULT_OK) return 0;
  const uint8_t* f = d->fst;
  uint32_t count = be32(f + 8);   // the root entry's length = number of entries
  if ((uint64_t)count * 12 > d->fstSize) return 0;
  const char* names = (const char*)f + count * 12;
  uint32_t i = 1;
  while (i < count) {
    const uint8_t* e = f + 12 * i;
    uint32_t w0 = be32(e), len = be32(e + 8);
    uint32_t nameOff = w0 & 0xFFFFFF;
    const char* name = (count * 12 + nameOff < d->fstSize) ? names + nameOff : "";
    i = cb(i, (w0 >> 24) ? NOD_NODE_KIND_DIRECTORY : NOD_NODE_KIND_FILE, name, len, ud);
  }
  return count;
}
NodResult nod_partition_open_file(NodHandle* h, uint32_t index, NodHandle** out) {
  Disc* d = h->d;
  if (load_fst(d) != NOD_RESULT_OK) return NOD_RESULT_ERR_IO;
  uint32_t count = be32(d->fst + 8);
  if (index == 0 || index >= count) return NOD_RESULT_ERR_FORMAT;
  const uint8_t* e = d->fst + 12 * index;
  if (be32(e) >> 24) return NOD_RESULT_ERR_FORMAT;
  *out = mk(2, d, be32(e + 4), be32(e + 8));
  return NOD_RESULT_OK;
}
int64_t nod_read(NodHandle* h, void* buf, size_t len) {
  if (h->pos >= h->size) return 0;
  if (len > h->size - h->pos) len = (size_t)(h->size - h->pos);
  int64_t n = h->d->s.read_at(h->d->s.user_data, h->base + h->pos, buf, len);
  if (n > 0) h->pos += (uint64_t)n;
  return n;
}
int64_t nod_seek(NodHandle* h, int64_t off, int32_t whence) {
  int64_t p = whence == 0 ? off : whence == 1 ? (int64_t)h->pos + off : (int64_t)h->size + off;
  if (p < 0) return -1;
  h->pos = (uint64_t)p; return p;
}
const uint8_t* nod_buf_read(NodHandle* h, size_t* avail) {
  if (!h->buf) h->buf = malloc(1 << 20);
  if (h->pos >= h->size) { *avail = 0; return h->buf; }
  size_t n = (size_t)((h->size - h->pos) < (1u << 20) ? (h->size - h->pos) : (1u << 20));
  int64_t r = h->d->s.read_at(h->d->s.user_data, h->base + h->pos, h->buf, n);
  *avail = r > 0 ? (size_t)r : 0;
  return h->buf;
}
void nod_buf_consume(NodHandle* h, size_t len) { h->pos += len; }
void nod_free(void* p) {
  NodHandle* h = p; if (!h) return;
  Disc* d = h->d; free(h->buf); free(h);
  if (--d->refs == 0) {
    if (d->s.close) d->s.close(d->s.user_data);
    free((void*)d->meta.raw_dol.data); free((void*)d->meta.raw_boot.data); free(d->fst); free(d);
  }
}

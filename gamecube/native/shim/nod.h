// The subset of nod's C API (encounter/nod) that Aurora's DVD layer and Party Board use, implemented
// for plain GameCube disc images (GCM/ISO) in src/nod_web.c. nod itself is a Rust library; the web
// build has no Rust toolchain, and a GCM image needs none of nod's container formats or Wii crypto.
#ifndef NOD_WEB_H
#define NOD_WEB_H
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
typedef struct NodHandle NodHandle;
typedef enum NodResult { NOD_RESULT_OK = 0, NOD_RESULT_ERR_IO = 1, NOD_RESULT_ERR_FORMAT = 2, NOD_RESULT_ERR_OTHER = 3 } NodResult;
typedef enum NodPartitionKind { NOD_PARTITION_KIND_DATA = 0, NOD_PARTITION_KIND_UPDATE = 1, NOD_PARTITION_KIND_CHANNEL = 2 } NodPartitionKind;
typedef enum NodNodeKind { NOD_NODE_KIND_FILE = 0, NOD_NODE_KIND_DIRECTORY = 1 } NodNodeKind;
typedef struct NodDiscStream {
  void* user_data;
  int64_t (*read_at)(void* user_data, uint64_t offset, void* out, size_t len);
  int64_t (*stream_len)(void* user_data);
  void (*close)(void* user_data);
} NodDiscStream;
typedef struct NodDiscOptions { uint32_t preloader_threads; } NodDiscOptions;
typedef struct NodDiscHeader {
  char game_id[6]; uint8_t disc_num; uint8_t disc_version; uint8_t audio_streaming; uint8_t audio_stream_buf_size;
  char game_title[64];
} NodDiscHeader;
typedef struct NodBuf { const uint8_t* data; size_t size; } NodBuf;
typedef struct NodPartitionMeta { NodBuf raw_boot; NodBuf raw_bi2; NodBuf raw_apploader; NodBuf raw_fst; NodBuf raw_dol; } NodPartitionMeta;
typedef uint32_t (*NodFstCallback)(uint32_t index, NodNodeKind kind, const char* name, uint32_t size, void* user_data);

NodResult nod_disc_open_stream(const NodDiscStream* stream, const NodDiscOptions* options, NodHandle** out);
NodResult nod_disc_header(NodHandle* disc, NodDiscHeader* out);
uint64_t nod_disc_size(NodHandle* disc);
NodResult nod_disc_open_partition_kind(NodHandle* disc, NodPartitionKind kind, const void* options, NodHandle** out);
NodResult nod_partition_meta(NodHandle* partition, NodPartitionMeta* out);
uint32_t nod_partition_iterate_fst(NodHandle* partition, NodFstCallback callback, void* user_data);
NodResult nod_partition_open_file(NodHandle* partition, uint32_t index, NodHandle** out);
int64_t nod_read(NodHandle* handle, void* buf, size_t len);
int64_t nod_seek(NodHandle* handle, int64_t offset, int32_t whence);
const uint8_t* nod_buf_read(NodHandle* handle, size_t* avail);
void nod_buf_consume(NodHandle* handle, size_t len);
void nod_free(void* handle);
#ifdef __cplusplus
}
#endif
#endif

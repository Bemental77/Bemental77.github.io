// Copyright 2008 Dolphin Emulator Project
// SPDX-License-Identifier: GPL-2.0-or-later

#include "Common/Hash.h"

#include <algorithm>
#include <bit>
#include <cstring>

#include <zlib.h>

// XXH_INLINE_ALL compiles xxHash (XXH3 included) straight into this translation unit as
// static functions, so GetHash64_XXH3 stays inlinable at -O3 and no new external symbol is
// emitted - it cannot collide with the separately linked libxxhash.a that VideoCommon uses.
// Externals/xxhash/xxHash/xxh3.h:54-55 does exactly this, and VideoCommon/PipelineUtils.h:6
// already pulls xxHash in that way in this tree.
#define XXH_INLINE_ALL
#include <xxhash.h>

#include "Common/CPUDetect.h"
#include "Common/Intrinsics.h"

#ifdef _M_ARM_64
#ifdef _MSC_VER
#include <intrin.h>
#else
#include <arm_acle.h>
#endif
#endif

namespace Common
{
u32 HashAdler32(const u8* data, size_t len)
{
  // Use fast implementation from zlib-ng
  return adler32_z(1, data, len);
}

// Stupid hash - but can't go back now :)
// Don't use for new things. At least it's reasonably fast.
u32 HashEctor(const u8* data, size_t len)
{
  u32 crc = 0;

  for (size_t i = 0; i < len; i++)
  {
    crc ^= data[i];
    crc = (crc << 3) | (crc >> 29);
  }

  return crc;
}

// [texhash A/B 2026-08-28] Dolphin's original sampling MurmurHash3, kept VERBATIM so the
// runtime toggle below is a true matched pair: this is byte-for-byte the code that was
// measured at 15.6-16.1% of the render worker. Do not "clean up" - its value is that it is
// unchanged. Reached only when the ?bjit_xxh3_texhash=0 SAB cell is set; XXH3 is the default.
#ifdef _ARCH_64

//-----------------------------------------------------------------------------
// Block read - if your platform needs to do endian-swapping or can only
// handle aligned reads, do the conversion here

static u64 getblock(const u64* p, int i)
{
  return p[i];
}

//----------
// Block mix - combine the key bits with the hash bits and scramble everything

static void bmix64(u64& h1, u64& h2, u64& k1, u64& k2, u64& c1, u64& c2)
{
  k1 *= c1;
  k1 = std::rotl(k1, 23);
  k1 *= c2;
  h1 ^= k1;
  h1 += h2;

  h2 = std::rotl(h2, 41);

  k2 *= c2;
  k2 = std::rotl(k2, 23);
  k2 *= c1;
  h2 ^= k2;
  h2 += h1;

  h1 = h1 * 3 + 0x52dce729;
  h2 = h2 * 3 + 0x38495ab5;

  c1 = c1 * 5 + 0x7b7d159c;
  c2 = c2 * 5 + 0x6bce6396;
}

//----------
// Finalization mix - avalanches all bits to within 0.05% bias

static u64 fmix64(u64 k)
{
  k ^= k >> 33;
  k *= 0xff51afd7ed558ccd;
  k ^= k >> 33;
  k *= 0xc4ceb9fe1a85ec53;
  k ^= k >> 33;

  return k;
}

static u64 GetMurmurHash3(const u8* src, u32 len, u32 samples)
{
  const u8* data = (const u8*)src;
  const int nblocks = len / 16;
  u32 Step = (len / 8);
  if (samples == 0)
    samples = std::max(Step, 1u);
  Step = Step / samples;
  if (Step < 1)
    Step = 1;

  u64 h1 = 0x9368e53c2f6af274;
  u64 h2 = 0x586dcd208f7cd3fd;

  u64 c1 = 0x87c37b91114253d5;
  u64 c2 = 0x4cf5ad432745937f;

  //----------
  // body

  const u64* blocks = (const u64*)(data);

  for (int i = 0; i < nblocks; i += Step)
  {
    u64 k1 = getblock(blocks, i * 2 + 0);
    u64 k2 = getblock(blocks, i * 2 + 1);

    bmix64(h1, h2, k1, k2, c1, c2);
  }

  //----------
  // tail

  const u8* tail = (const u8*)(data + nblocks * 16);

  u64 k1 = 0;
  u64 k2 = 0;

  switch (len & 15)
  {
  case 15:
    k2 ^= u64(tail[14]) << 48;
  case 14:
    k2 ^= u64(tail[13]) << 40;
  case 13:
    k2 ^= u64(tail[12]) << 32;
  case 12:
    k2 ^= u64(tail[11]) << 24;
  case 11:
    k2 ^= u64(tail[10]) << 16;
  case 10:
    k2 ^= u64(tail[9]) << 8;
  case 9:
    k2 ^= u64(tail[8]) << 0;

  case 8:
    k1 ^= u64(tail[7]) << 56;
  case 7:
    k1 ^= u64(tail[6]) << 48;
  case 6:
    k1 ^= u64(tail[5]) << 40;
  case 5:
    k1 ^= u64(tail[4]) << 32;
  case 4:
    k1 ^= u64(tail[3]) << 24;
  case 3:
    k1 ^= u64(tail[2]) << 16;
  case 2:
    k1 ^= u64(tail[1]) << 8;
  case 1:
    k1 ^= u64(tail[0]) << 0;
    bmix64(h1, h2, k1, k2, c1, c2);
  };

  //----------
  // finalization

  h2 ^= len;

  h1 += h2;
  h2 += h1;

  h1 = fmix64(h1);
  h2 = fmix64(h2);

  h1 += h2;

  return h1;
}

#else

//-----------------------------------------------------------------------------
// Block read - if your platform needs to do endian-swapping or can only
// handle aligned reads, do the conversion here

static u32 getblock(const u32* p, int i)
{
  return p[i];
}

//----------
// Finalization mix - force all bits of a hash block to avalanche

// avalanches all bits to within 0.25% bias

static u32 fmix32(u32 h)
{
  h ^= h >> 16;
  h *= 0x85ebca6b;
  h ^= h >> 13;
  h *= 0xc2b2ae35;
  h ^= h >> 16;

  return h;
}

static void bmix32(u32& h1, u32& h2, u32& k1, u32& k2, u32& c1, u32& c2)
{
  k1 *= c1;
  k1 = std::rotl(k1, 11);
  k1 *= c2;
  h1 ^= k1;
  h1 += h2;

  h2 = std::rotl(h2, 17);

  k2 *= c2;
  k2 = std::rotl(k2, 11);
  k2 *= c1;
  h2 ^= k2;
  h2 += h1;

  h1 = h1 * 3 + 0x52dce729;
  h2 = h2 * 3 + 0x38495ab5;

  c1 = c1 * 5 + 0x7b7d159c;
  c2 = c2 * 5 + 0x6bce6396;
}

//----------

static u64 GetMurmurHash3(const u8* src, u32 len, u32 samples)
{
  const u8* data = (const u8*)src;
  u32 out[2];
  const int nblocks = len / 8;
  u32 Step = (len / 4);
  if (samples == 0)
    samples = std::max(Step, 1u);
  Step = Step / samples;
  if (Step < 1)
    Step = 1;

  u32 h1 = 0x8de1c3ac;
  u32 h2 = 0xbab98226;

  u32 c1 = 0x95543787;
  u32 c2 = 0x2ad7eb25;

  //----------
  // body

  const u32* blocks = (const u32*)(data + nblocks * 8);

  for (int i = -nblocks; i < 0; i += Step)
  {
    u32 k1 = getblock(blocks, i * 2 + 0);
    u32 k2 = getblock(blocks, i * 2 + 1);

    bmix32(h1, h2, k1, k2, c1, c2);
  }

  //----------
  // tail

  const u8* tail = (const u8*)(data + nblocks * 8);

  u32 k1 = 0;
  u32 k2 = 0;

  switch (len & 7)
  {
  case 7:
    k2 ^= tail[6] << 16;
  case 6:
    k2 ^= tail[5] << 8;
  case 5:
    k2 ^= tail[4] << 0;
  case 4:
    k1 ^= tail[3] << 24;
  case 3:
    k1 ^= tail[2] << 16;
  case 2:
    k1 ^= tail[1] << 8;
  case 1:
    k1 ^= tail[0] << 0;
    bmix32(h1, h2, k1, k2, c1, c2);
  };

  //----------
  // finalization

  h2 ^= len;

  h1 += h2;
  h2 += h1;

  h1 = fmix32(h1);
  h2 = fmix32(h2);

  h1 += h2;
  h2 += h1;

  out[0] = h1;
  out[1] = h2;

  return *((u64*)&out);
}

#endif

// XXH3 texture cache hash - the default software path, and the A/B partner of the
// MurmurHash3 above. Both are compiled into every binary; GetHash64_Software picks between
// them per call off a SAB scratch cell (see below).
//
// The software path is what every Emscripten build runs: the wasm configuration is built
// with ENABLE_GENERIC (build-wasm-4010/CMakeCache.txt:631 -> -D_M_GENERIC=1), so neither
// _M_X86_64 nor _M_ARM_64 is defined, and CPUInfo::bCRC32 stays false there because
// GenericCPUDetect.cpp's constructor is empty and the member defaults to false
// (CPUDetect.h:45).
//
// SAMPLING SEMANTICS ARE IDENTICAL TO MurmurHash3's, BY CONSTRUCTION. This function changes
// only the mixing function; it does NOT change which bytes are read. That is a hard
// constraint, not an optimisation opportunity: DolphinLibretro/Boot.cpp:408 pins
// GFX_SAFE_TEXTURE_CACHE_COLOR_SAMPLES to 0 (full hashing) precisely because sampled hashing
// left stale THP plane textures and a TEV green band. Hashing fewer bytes would reopen that.
// The hash is a pure function of the sampled bytes plus len - nothing else feeds it.
//
// The returned VALUE differs from MurmurHash3's. That is safe: no GetHash64 result is
// persisted across runs (the texture cache is rebuilt every session), and XXH3 is
// deterministic, so values are stable for a fixed toggle setting.
static u64 GetHash64_XXH3(const u8* src, u32 len, u32 samples)
{
  // Selection arithmetic, carried over verbatim from the _ARCH_32 GetMurmurHash3 above.
  const u32 nblocks = len / 8;
  u32 Step = (len / 4);
  if (samples == 0)
    samples = std::max(Step, 1u);
  Step = Step / samples;
  if (Step < 1)
    Step = 1;

  // Step == 1 - which is what samples == 0 always yields - selects every 8-byte block plus
  // the len & 7 tail, i.e. exactly [src, src + len) with no gaps. Hash it in one shot.
  if (Step == 1)
    return XXH3_64bits(src, len);

  // Sampled: feed XXH3 exactly the bytes MurmurHash3 would have consumed - the 8-byte block
  // at src + i * 8 for i = 0, Step, 2 * Step, ... < nblocks, then the len & 7 tail bytes at
  // src + nblocks * 8.
  XXH3_state_t state;
  XXH3_INITSTATE(&state);
  XXH3_64bits_reset(&state);

  // MurmurHash3 folded the length in explicitly ("h2 ^= len"), and both CRC32 paths below
  // seed h[0] with it. The sampled byte stream alone does not determine len, so fold it in
  // here too. This reads no additional bytes of src.
  XXH3_64bits_update(&state, &len, sizeof(len));

  // Stage the strided blocks contiguously so XXH3 sees long runs instead of one 8-byte
  // update per block.
  alignas(8) u8 gathered[1024];
  u32 filled = 0;
  for (u32 i = 0; i < nblocks; i += Step)
  {
    std::memcpy(gathered + filled, src + static_cast<size_t>(i) * 8, 8);
    filled += 8;
    if (filled == sizeof(gathered))
    {
      XXH3_64bits_update(&state, gathered, filled);
      filled = 0;
    }
  }
  if (filled != 0)
    XXH3_64bits_update(&state, gathered, filled);

  const u32 tail_len = len & 7;
  if (tail_len != 0)
    XXH3_64bits_update(&state, src + static_cast<size_t>(nblocks) * 8, tail_len);

  return XXH3_64bits_digest(&state);
}

#if defined(_M_X86_64)

FUNCTION_TARGET_SSE42
static u64 GetHash64_SSE42_CRC32(const u8* src, u32 len, u32 samples)
{
  u64 h[4] = {len, 0, 0, 0};
  u32 Step = (len / 8);
  const u64* data = (const u64*)src;
  const u64* end = data + Step;
  if (samples == 0)
    samples = std::max(Step, 1u);
  Step = Step / samples;
  if (Step < 1)
    Step = 1;

  while (data < end - Step * 3)
  {
    h[0] = _mm_crc32_u64(h[0], data[Step * 0]);
    h[1] = _mm_crc32_u64(h[1], data[Step * 1]);
    h[2] = _mm_crc32_u64(h[2], data[Step * 2]);
    h[3] = _mm_crc32_u64(h[3], data[Step * 3]);
    data += Step * 4;
  }
  if (data < end - Step * 0)
    h[0] = _mm_crc32_u64(h[0], data[Step * 0]);
  if (data < end - Step * 1)
    h[1] = _mm_crc32_u64(h[1], data[Step * 1]);
  if (data < end - Step * 2)
    h[2] = _mm_crc32_u64(h[2], data[Step * 2]);

  if (len & 7)
  {
    u64 temp = 0;
    memcpy(&temp, end, len & 7);
    h[0] = _mm_crc32_u64(h[0], temp);
  }

  // FIXME: is there a better way to combine these partial hashes?
  return h[0] + (h[1] << 10) + (h[2] << 21) + (h[3] << 32);
}

#elif defined(_M_ARM_64)

static u64 GetHash64_ARMv8_CRC32(const u8* src, u32 len, u32 samples)
{
  u64 h[4] = {len, 0, 0, 0};
  u32 Step = (len / 8);
  const u64* data = (const u64*)src;
  const u64* end = data + Step;
  if (samples == 0)
    samples = std::max(Step, 1u);
  Step = Step / samples;
  if (Step < 1)
    Step = 1;

  while (data < end - Step * 3)
  {
    h[0] = __crc32d(h[0], data[Step * 0]);
    h[1] = __crc32d(h[1], data[Step * 1]);
    h[2] = __crc32d(h[2], data[Step * 2]);
    h[3] = __crc32d(h[3], data[Step * 3]);
    data += Step * 4;
  }
  if (data < end - Step * 0)
    h[0] = __crc32d(h[0], data[Step * 0]);
  if (data < end - Step * 1)
    h[1] = __crc32d(h[1], data[Step * 1]);
  if (data < end - Step * 2)
    h[2] = __crc32d(h[2], data[Step * 2]);

  if (len & 7)
  {
    u64 temp = 0;
    memcpy(&temp, end, len & 7);
    h[0] = __crc32d(h[0], temp);
  }

  // FIXME: is there a better way to combine these partial hashes?
  return h[0] + (h[1] << 10) + (h[2] << 21) + (h[3] << 32);
}

#endif

// [texhash A/B 2026-08-28] Runtime toggle between the two software hashes. Compile-time
// selection would force a rebuild between the two arms of the measurement, and a rebuild
// destroys attribution - CLAUDE.md gate #8 wants a matched pair on ONE binary: same page,
// same ROM, same scene, flip the flag, read the fps delta.
//
// getenv is dead in the worker (cross-thread Module.ENV never reaches the C environ - see
// JitWasm.cpp:509-512), so the toggle rides a SAB scratch cell exactly like
// ?bjit_fp_resident_loop does at 0x026B3408 (gamecube.html:534-540 writes it,
// ppc_emit.cpp:1180 reads it). This one is the next free cell, 0x026B340C:
//
//   cell == 0 (browser-zeroed default) -> XXH3          <- default, what ships
//   cell != 0                          -> MurmurHash3   <- ?bjit_xxh3_texhash=0
//
// Read per call rather than cached, so the flag can also be flipped live from DevTools on a
// running instance for a same-process pair. One u32 load against a hash that reads at least
// hundreds of bytes is not measurable. Flipping live changes the hash function under a
// populated texture cache: every stored hash then mismatches, so entries are re-decoded and
// re-uploaded once. That is the conservative direction (false "changed", never false
// "unchanged" - a Murmur value colliding with an XXH3 value is not a real risk), so it costs
// a brief re-upload storm, not a stale texture. Let it settle before reading fps.
static bool TextureHashForceMurmur()
{
#ifdef __EMSCRIPTEN__
  return *reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B340Cu)) != 0u;
#else
  // Native builds have no page and no SAB scratch region; 0x026B340C is not a valid address
  // there. The toggle is a wasm-page A/B only - native always takes the default.
  return false;
#endif
}

static u64 GetHash64_Software(const u8* src, u32 len, u32 samples)
{
  if (TextureHashForceMurmur())
    return GetMurmurHash3(src, len, samples);

  return GetHash64_XXH3(src, len, samples);
}

#if defined(_M_X86_64) || defined(_M_ARM_64)

// Only these targets compile more than one implementation, so only they need the runtime
// dispatch. The first call resolves the pointer; later calls go straight to the winner.
using TextureHashFunction = u64 (*)(const u8* src, u32 len, u32 samples);
static u64 SetHash64Function(const u8* src, u32 len, u32 samples);
static TextureHashFunction s_texture_hash_func = SetHash64Function;

static u64 SetHash64Function(const u8* src, u32 len, u32 samples)
{
  // Resolve into a local and assign unconditionally. The previous version assigned inside
  // "#if defined(_M_X86_64) / #elif defined(_M_ARM_64)" with no #else, so on any other
  // target both arms preprocessed away: a true cpu_info.bCRC32 would leave
  // s_texture_hash_func still pointing at SetHash64Function and the call below would recurse
  // forever. Guarded structurally - there is no path out of here that does not set the
  // pointer to a real implementation.
  TextureHashFunction func = &GetHash64_Software;
  if (cpu_info.bCRC32)
  {
#if defined(_M_X86_64)
    func = &GetHash64_SSE42_CRC32;
#else
    func = &GetHash64_ARMv8_CRC32;
#endif
  }

  s_texture_hash_func = func;
  return func(src, len, samples);
}

u64 GetHash64(const u8* src, u32 len, u32 samples)
{
  return s_texture_hash_func(src, len, samples);
}

#else

// No hardware CRC32 implementation exists for this target, so the function pointer would
// only ever hold one value - GetHash64_Software, which does its own runtime selection off
// the SAB cell. Call it directly: under Emscripten this turns the per-texture-hash indirect
// call (a call_indirect plus its runtime signature check) into a direct call, and it removes
// the latent recursion above entirely, since SetHash64Function no longer exists here.
u64 GetHash64(const u8* src, u32 len, u32 samples)
{
  return GetHash64_Software(src, len, samples);
}

#endif

u32 StartCRC32()
{
  return crc32_z(0L, Z_NULL, 0);
}

u32 UpdateCRC32(u32 crc, const u8* data, size_t len)
{
  return crc32_z(crc, data, len);
}

u32 ComputeCRC32(const u8* data, size_t len)
{
  return UpdateCRC32(StartCRC32(), data, len);
}

u32 ComputeCRC32(std::string_view data)
{
  return ComputeCRC32(reinterpret_cast<const u8*>(data.data()), data.size());
}
}  // namespace Common

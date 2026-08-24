#ifndef _DOLPHIN_OS_OSFASTCAST_H_
#define _DOLPHIN_OS_OSFASTCAST_H_
// [wasm-recomp 2026-08-21] Portable-C replacement for the Metrowerks inline-asm
// OSFastCast primitives (which used PPC fctiwz/stfd). These are ordinary float->
// integer truncations; standard C casts express the same conversion on a wasm
// target. Functional reimplementation, not a copy of the SDK's asm. Placed on the
// include path BEFORE the decomp's include/ so it overrides the asm header when
// compiling the MarioParty4 decomp to wasm (see gamecube/recomp/PLAN.md).
#ifdef __cplusplus
extern "C" {
#endif
static inline s16 __OSf32tos16(register f32 f) { return (s16)f; }
static inline u16 __OSf32tou16(register f32 f) { return (u16)f; }
static inline s8  __OSf32tos8 (register f32 f) { return (s8)f;  }
static inline u8  __OSf32tou8 (register f32 f) { return (u8)f;  }
static inline void OSf32tos16(f32 *f, s16 *out) { *out = (s16)*f; }
static inline void OSf32tou16(f32 *f, u16 *out) { *out = (u16)*f; }
static inline void OSf32tos8 (f32 *f, s8  *out) { *out = (s8)*f;  }
static inline void OSf32tou8 (f32 *f, u8  *out) { *out = (u8)*f;  }
// int->f32 casts (the reverse direction; same portable-cast principle).
static inline f32 __OSs8tof32 (const s8*  p) { return (f32)*p; }
static inline f32 __OSu8tof32 (const u8*  p) { return (f32)*p; }
static inline f32 __OSs16tof32(const s16* p) { return (f32)*p; }
static inline f32 __OSu16tof32(const u16* p) { return (f32)*p; }
static inline void OSs8tof32 (const s8*  in, f32 *out) { *out = (f32)*in; }
static inline void OSu8tof32 (const u8*  in, f32 *out) { *out = (f32)*in; }
static inline void OSs16tof32(const s16* in, f32 *out) { *out = (f32)*in; }
static inline void OSu16tof32(const u16* in, f32 *out) { *out = (f32)*in; }
#ifdef __cplusplus
}
#endif
#endif

#include "emscripten.h"

#include "display.h"
#include "snes9x.h"
#include "cpuexec.h"
#include "apu.h"
#include "apu_blargg.h"
#include "soundux.h"
#include "memmap.h"
#include "gfx.h"
#include "cheats.h"
#include "spc7110.h"
#include "srtc.h"
#include "sa1.h"

#include <stdio.h>
#include <sys/time.h>

/* FIVE PADS, NOT ONE. This used to be a single `int joyPadInput` and
 * S9xReadJoypad answered `if(port == 0) return joyPadInput; return 0;` — the
 * author's own comment said "1Pのみ対応" (1P only supported), and it was
 * confirmed in live wasm memory: after 200 frames with setJoypadInput(0x0201),
 * IPPU.Joypads[0..4] read 0xffff0201 0 0 0 0.
 *
 * NOTHING ELSE IN THE CORE NEEDED CHANGING, and in particular NO MULTITAP is
 * involved. snes9x already polls all five ports every frame
 * (ppu.c:2056-2062 `for (i = 0; i < 5; i++) IPPU.Joypads[i] = S9xReadJoypad(i)`)
 * and already publishes port 2 to the standard auto-read registers
 * unconditionally (ppu.c:2098-2099 writes IPPU.Joypads[1] into
 * Memory.FillRAM[0x421a]/[0x421b]). Only this function was starving them.
 *
 * Ports 2..4 exist because the array the core polls is five wide; they stay 0
 * unless someone sets them, which is what a Super Multitap game would need
 * (ppu.c:1445/1451). A plain two-player game needs port 1 and nothing more.
 */
#define JOYPAD_PORTS 5
int joyPadInput[JOYPAD_PORTS] = { 0, 0, 0, 0, 0 };
bool runGameFlag = false;
unsigned char *rgba8ScreenBuffer = NULL;
float *f32soundBuffer = NULL;
unsigned int sramDestSize;
unsigned char *sramDest;
int16_t *mixSamplesBuffer = NULL;
unsigned int mixSamplesCount = 0;
int16_t *outToExternalBuffer = NULL;
unsigned int outToExternalBufferSamplePos = 2048;
unsigned int soundBufferOutPos = 0;
unsigned int soundBufferStuckCount = 0;

/* KEPT, and it still means port 0. Callers that predate the second pad — the
 * upstream demo at doc/script.js, and any saved page — keep working unchanged. */
EMSCRIPTEN_KEEPALIVE
void setJoypadInput(int32_t input){
    joyPadInput[0] = input;
}

/* THE SECOND PLAYER'S DOOR. port is 0..4; anything else is dropped rather than
 * writing past the array, because this is reachable from JS and a bad index
 * would corrupt whatever the linker put next to joyPadInput. */
EMSCRIPTEN_KEEPALIVE
void setJoypadInputPort(int32_t port, int32_t input){
    if(port < 0 || port >= JOYPAD_PORTS)return;
    joyPadInput[port] = input;
}

/* Read-back, so a test can assert on what the CORE holds rather than on what
 * the page believes it sent. */
EMSCRIPTEN_KEEPALIVE
int32_t getJoypadInputPort(int32_t port){
    if(port < 0 || port >= JOYPAD_PORTS)return 0;
    return joyPadInput[port];
}

EMSCRIPTEN_KEEPALIVE
int32_t getJoypadPortCount(void){
    return JOYPAD_PORTS;
}

uint32_t S9xReadJoypad(int32_t port){
    if(port < 0 || port >= JOYPAD_PORTS)return 0;
    return (uint32_t)joyPadInput[port];
}

bool S9xReadMousePosition(int32_t which1, int32_t* x, int32_t* y, uint32_t* buttons)
{
   (void) which1;
   (void) x;
   (void) y;
   (void) buttons;
   return false;
}

bool S9xReadSuperScopePosition(int32_t* x, int32_t* y, uint32_t* buttons)
{
   (void) x;
   (void) y;
   (void) buttons;
   return true;
}

EMSCRIPTEN_KEEPALIVE
unsigned char *my_malloc(unsigned int length){
    return (unsigned char*)calloc(length, sizeof(unsigned char));
}

EMSCRIPTEN_KEEPALIVE
void my_free(unsigned char *ptr){
    free(ptr);
}

#ifdef USE_BLARGG_APU
void S9xSoundCallback(void){
    //printf("outToExternalBufferSamplePos = %d\n", outToExternalBufferSamplePos);
    S9xFinalizeSamples();
    if(!outToExternalBuffer)outToExternalBuffer = (int16_t*)calloc(4096 * 2, sizeof(int16_t));
    unsigned int available_samples = S9xGetSampleCount() / 2;
    if(available_samples > mixSamplesCount){
        mixSamplesCount = available_samples;
        if(mixSamplesBuffer)free(mixSamplesBuffer);
        mixSamplesBuffer = (int16_t*)calloc(mixSamplesCount * 2, sizeof(int16_t));
    }
    S9xMixSamples(mixSamplesBuffer, available_samples * 2);
    unsigned int nextPos = (outToExternalBufferSamplePos + available_samples) % 4096;
    if(soundBufferOutPos >= 2048){
        if(outToExternalBufferSamplePos <= 2048 && nextPos >= 2048)return;
    }else{
        if(outToExternalBufferSamplePos > 2048 && nextPos <= 2048)return;
    }
    for(unsigned int i = 0;i < available_samples * 2; i++){
        outToExternalBuffer[(outToExternalBufferSamplePos * 2 + i) % 8192] = mixSamplesBuffer[i];
    }
    outToExternalBufferSamplePos = (outToExternalBufferSamplePos + available_samples) % 4096;
}
#else
void S9xSoundCallback(void){
    //printf("outToExternalBufferSamplePos = %d\n", outToExternalBufferSamplePos);
    if(!outToExternalBuffer)outToExternalBuffer = (int16_t*)calloc(4096 * 2, sizeof(int16_t));
    unsigned int available_samples = 600;
    if(available_samples > mixSamplesCount){
        mixSamplesCount = available_samples;
        if(mixSamplesBuffer)free(mixSamplesBuffer);
        mixSamplesBuffer = (int16_t*)calloc(mixSamplesCount * 2, sizeof(int16_t));
    }
    S9xMixSamples(mixSamplesBuffer, available_samples * 2);
    unsigned int nextPos = (outToExternalBufferSamplePos + available_samples) % 4096;
    if(soundBufferOutPos >= 2048){
        if(outToExternalBufferSamplePos <= 2048 && nextPos >= 2048)return;
    }else{
        if(outToExternalBufferSamplePos > 2048 && nextPos <= 2048)return;
    }
    for(unsigned int i = 0;i < available_samples * 2; i++){
        outToExternalBuffer[(outToExternalBufferSamplePos * 2 + i) % 8192] = mixSamplesBuffer[i];
    }
    outToExternalBufferSamplePos = (outToExternalBufferSamplePos + available_samples) % 4096;
}
#endif

static void init_sfc_setting(unsigned int sampleRate)
{
   memset(&Settings, 0, sizeof(Settings));
   Settings.JoystickEnabled = false;
   Settings.SoundPlaybackRate = sampleRate;
#ifdef USE_BLARGG_APU
   Settings.SoundInputRate = sampleRate;
#endif
   Settings.CyclesPercentage = 100;

   Settings.DisableSoundEcho = false;
   Settings.InterpolatedSound = true;
   Settings.APUEnabled = true;

   Settings.H_Max = SNES_CYCLES_PER_SCANLINE;
   Settings.FrameTimePAL = 20000;
   Settings.FrameTimeNTSC = 16667;
   Settings.DisableMasterVolume = false;
   Settings.Mouse = true;
   Settings.SuperScope = true;
   Settings.MultiPlayer5 = true;
   Settings.ControllerOption = SNES_JOYPAD;
#ifdef USE_BLARGG_APU
   Settings.SoundSync = false;
#endif
   Settings.ApplyCheats = true;
   Settings.HBlankStart = (256 * Settings.H_Max) / SNES_HCOUNTER_MAX;
}

EMSCRIPTEN_KEEPALIVE
void startWithRom(unsigned char *rom, unsigned int romLength, unsigned int sampleRate){
    if(runGameFlag){
        //SRAM初期化
        if(Memory.SRAM)memset(Memory.SRAM, 0, 0x20000);
        LoadROMFromBuffer(rom, romLength);
        S9xReset();
        return;
    }
    memset(&Settings, 0, sizeof(Settings));
    //TO DO:
    //Settingsの設定が不足かも
    /*Settings.MouseMaster = true;
    Settings.SuperScopeMaster = true;
    Settings.JustifierMaster = true;
    Settings.MultiPlayer5Master = true;
    Settings.FrameTimePAL = 20000;
    Settings.FrameTimeNTSC = 16667;
    Settings.SoundPlaybackRate = 32040;
    CPU.Flags = 0;*/
    init_sfc_setting(sampleRate);
    S9xInitMemory();
    S9xInitAPU();
    #ifdef USE_BLARGG_APU
    //S9xInitSound(64, 0);//64ミリ秒のバッファ
    S9xInitSound(0, 0);//初期設定?
    #else
    S9xInitSound();
    S9xSetPlaybackRate(36000);
    #endif
    #ifdef USE_BLARGG_APU
    S9xSetSamplesAvailableCallback(S9xSoundCallback);
    #endif
    S9xInitDisplay();
    S9xInitGFX();
    //コントローラー
    //TO DO:コントローラー関係
    //ROMロード
    LoadROMFromBuffer(rom, romLength);
    //Settings.StopEmulation = false;
    //グラフィック設定
    //GFX.Pitch = 512;
    //リセット
    S9xReset();
    runGameFlag = true;
}

EMSCRIPTEN_KEEPALIVE
void mainLoop(){
    if(!runGameFlag)return;
    S9xMainLoop();//1フレーム分実行される?
    S9xUpdateScreen();
    #ifndef USE_BLARGG_APU
    S9xSoundCallback();
    #endif
}

EMSCRIPTEN_KEEPALIVE
uint8_t *getScreenBuffer(void){
    if(!rgba8ScreenBuffer)rgba8ScreenBuffer = my_malloc(512 * 448 * 4);
    if(!runGameFlag || !GFX.Screen)return rgba8ScreenBuffer;
    for(unsigned int i = 0;i < 512 * 448;i++){
        unsigned short col;
        memcpy(&col, GFX.Screen + 2 * i, 2);
        unsigned char r = ((col >> 11) & 0x1F) << 3;
        unsigned char g = ((col >> 5) & 0x3F) << 2;
        unsigned char b = ((col >> 0) & 0x1F) << 3;
        rgba8ScreenBuffer[i * 4 + 0] = r;
        rgba8ScreenBuffer[i * 4 + 1] = g;
        rgba8ScreenBuffer[i * 4 + 2] = b;
        rgba8ScreenBuffer[i * 4 + 3] = 0xFF;
    }
    return rgba8ScreenBuffer;
}

/*EMSCRIPTEN_KEEPALIVE
float *getSoundBuffer(){
    printf("outToExternalBufferIndex = %d\n", outToExternalBufferIndex);
    if(!outToExternalBuffer)outToExternalBuffer = (int16_t*)calloc(4096 * 2, sizeof(int16_t));
    if(!f32soundBuffer)f32soundBuffer = (float*)calloc(2048 * 2, sizeof(float));
    if(outToExternalBufferIndex == 0){
        if(outToExternalBufferSamplePos < 2048)return f32soundBuffer;
    }else{
        if(outToExternalBufferSamplePos >= 2048)return f32soundBuffer;
    }
    for(unsigned int i = 0;i < 2048;i++){
        for(unsigned int j = 0;j < 2;j++)f32soundBuffer[j * 2048 + i] = outToExternalBuffer[outToExternalBufferIndex * 4096 + 2 * i + j] / ((float)(0x8000));
    }
    if(outToExternalBufferIndex == 0){
        outToExternalBufferIndex = 1;
    }else{
        outToExternalBufferIndex = 0;
    }
    return f32soundBuffer;
}*/

/*EMSCRIPTEN_KEEPALIVE
float *getSoundBuffer(){
    if(!outToExternalBuffer)outToExternalBuffer = (int16_t*)calloc(4096 * 2, sizeof(int16_t));
    if(!f32soundBuffer)f32soundBuffer = (float*)calloc(2048 * 2, sizeof(float));
    unsigned int soundBufferInPos = outToExternalBufferSamplePos;
    if(outToExternalBufferSamplePos < soundBufferOutPos)soundBufferInPos += 4096;
    if(soundBufferOutPos + 2048 > soundBufferInPos)return f32soundBuffer;
    soundBufferOutPos += 2048;
    for(unsigned int i = 0;i < 2048;i++){
        for(unsigned int j = 0;j < 2;j++)f32soundBuffer[j * 2048 + i] = outToExternalBuffer[(soundBufferOutPos * 2 + i * 2 + j) % 8192] / ((float)(0x8000));
    }
    return f32soundBuffer;
}*/

void resetSoundBuffer(){
    soundBufferOutPos = 0;
    outToExternalBufferSamplePos = 0;
    memset(outToExternalBuffer, 0, 4096 * 2 * sizeof(int16_t));
    return;
}

EMSCRIPTEN_KEEPALIVE
float *getSoundBuffer(){
    if(soundBufferStuckCount >= 5){//応急処置
        printf("soundbuffer stuck!!\n");
        printf("outToExternalBufferSamplePos = %d\n", outToExternalBufferSamplePos);
        printf("soundBufferOutPos = %d\n", soundBufferOutPos);
        soundBufferStuckCount = 0;
        resetSoundBuffer();
    }
    soundBufferStuckCount++;
    //printf("soundBufferOutPos = %d\n", soundBufferOutPos);
    if(!outToExternalBuffer)outToExternalBuffer = (int16_t*)calloc(4096 * 2, sizeof(int16_t));
    if(!f32soundBuffer)f32soundBuffer = (float*)calloc(2048 * 2, sizeof(float));
    if(soundBufferOutPos < 2048){
        if(outToExternalBufferSamplePos < 2048)return f32soundBuffer;//getSoundBufferが呼ばれすぎてS9xSoundCallbackによって生成された音声データに追いついた
    }else{
        if(outToExternalBufferSamplePos >= 2048)return f32soundBuffer;//getSoundBufferが呼ばれすぎてS9xSoundCallbackによって生成された音声データに追いついた
    }
    for(unsigned int i = 0;i < 2048;i++){
        for(unsigned int j = 0;j < 2;j++)f32soundBuffer[j * 2048 + i] = outToExternalBuffer[(soundBufferOutPos * 2 + i * 2 + j) % 8192] / ((float)(0x8000));
    }
    soundBufferOutPos = (soundBufferOutPos + 2048) % 4096;
    soundBufferStuckCount = 0;
    return f32soundBuffer;
}


EMSCRIPTEN_KEEPALIVE
void saveSramRequest(void){
    if(!runGameFlag)return;
    sramDestSize = (1 << Memory.SRAMSize) * 1024;
    sramDest = (unsigned char*)calloc(sramDestSize, sizeof(unsigned char));
    memcpy(sramDest, Memory.SRAM, sramDestSize);
}

EMSCRIPTEN_KEEPALIVE
unsigned int getSaveSramSize(void){
    if(!runGameFlag)return 0;
    return sramDestSize;
}

EMSCRIPTEN_KEEPALIVE
unsigned char *getSaveSram(void){
    if(!runGameFlag)return NULL;
    return sramDest;
}

EMSCRIPTEN_KEEPALIVE
void loadSram(unsigned int sramSize, unsigned char *sram){
    if(!runGameFlag)return;
    memcpy(Memory.SRAM, sram, sramSize);
    CommonS9xReset();
}

EMSCRIPTEN_KEEPALIVE
unsigned int getStateSaveSize(void){
    return sizeof(unsigned int) + sizeof(CPU) + sizeof(ICPU) + sizeof(PPU) + sizeof(DMA) +
          0x10000 + 0x20000 + 0x20000 + 0x8000 +
#ifndef USE_BLARGG_APU
          sizeof(APU) + sizeof(IAPU) + 0x10000 + sizeof(SoundData) +
#else
          SPC_SAVE_STATE_BLOCK_SIZE +
#endif
          sizeof(SA1) + sizeof(s7r) + sizeof(rtc_f9);
}

/* ROLLBACK NETPLAY (snes.html, snes/snes_rollback.js) takes a savestate EVERY
   emulated frame, so saveState()'s calloc of ~529 KB per call (and the free the
   page owes for it) is replaced there by saveStateInto(), which serializes into
   a slot the page allocated once. saveState() is now a thin wrapper over it and
   produces byte-for-byte the blob it always did. Returns false (writing nothing)
   when no game runs or `size` is not getStateSaveSize(). */
#define SNES_NOISE_TAG 0x4e534531u /* "NSE1": ICPU.UNUSED2 holds so.noise_gen */
static void saveStateWrite(unsigned char *data);

/* THE LATCHED PADS ARE GUEST STATE, AND THE BLOB DID NOT CARRY THEM.
 * IPPU.Joypads[0..4] is what a MANUAL serial read of $4016/$4017 shifts out
 * (ppu.c S9xGetCPU) — and the Super Multitap's pads 3-5 are reached ONLY
 * that way for pads 4/5. It is refreshed once per frame by S9xUpdateJoypads
 * at V = ScreenHeight + 3, mid-frame, while a frame boundary (and so every
 * savestate rollback takes) is at V = 0. So between V = 0 and V = 227 the
 * running machine holds the PREVIOUS frame's pads — and before this a load
 * held NONE: loadState's S9xReset -> S9xResetPPU zeroes IPPU.Joypads, so a
 * manual read in that window after any load saw no buttons where a straight
 * run saw last frame's. Every console in a rollback room loads before EVERY
 * frame (snes/snes_rollback.js, the canonical step), so they agreed with each
 * other either way; this makes a load restore what the hardware held. NOT
 * measured on a game that reads in that window (none shipped does; the
 * multitap test ROM reads after the auto-read), so the room probes do not
 * depend on it — it is defensive.
 *
 * WHERE: five 16-bit words in PPU fields no code reads (ppu.h UNUSED9[6],
 * UNUSED2, UNUSED10[2]), tagged in UNUSED1, so the layout and the size are
 * unchanged and every savestate written before this still loads exactly as it
 * did (tag absent -> IPPU.Joypads left as S9xReset leaves them, zero: the
 * old behaviour).
 * Only the low 16 bits are kept: S9xUpdateJoypads ORs 0xffff0000 into a
 * NONZERO pad for SNES_JOYPAD / SNES_MULTIPLAYER5 and leaves 0 as 0, so the
 * load re-applies exactly that rule. */
#define SNES_JOY_TAG 0x4a /* 'J' */
static void snesPackJoypads(void){
   uint16_t w[5];
   int i;
   for(i = 0; i < 5; i++) w[i] = (uint16_t)IPPU.Joypads[i];
   memcpy(&PPU.UNUSED9[0], &w[0], 6);
   PPU.UNUSED2 = w[3];
   memcpy(&PPU.UNUSED10[0], &w[4], 2);
   PPU.UNUSED1 = SNES_JOY_TAG;
}
static void snesUnpackJoypads(void){
   uint16_t w[5];
   int i;
   if(PPU.UNUSED1 != SNES_JOY_TAG) return;
   memcpy(&w[0], &PPU.UNUSED9[0], 6);
   w[3] = PPU.UNUSED2;
   memcpy(&w[4], &PPU.UNUSED10[0], 2);
   for(i = 0; i < 5; i++){
      uint32_t v = w[i];
      if(v && (IPPU.Controller == SNES_JOYPAD || IPPU.Controller == SNES_MULTIPLAYER5)) v |= 0xffff0000u;
      IPPU.Joypads[i] = v;
   }
}

/* THE SUPER MULTITAP, ON PORT 2. snes9x has the whole read path (ppu.c
 * S9xGetCPU $4016/$4017 under IPPU.Controller == SNES_MULTIPLAYER5: the
 * adaptor's ID bit on a latched $4017, pads 2/3 on data lines 0/1 while
 * $4201 bit 7 is set, pads 4/5 while it is clear; S9xUpdateJoypads fills
 * $421C-$421F from pads 3) and Settings.MultiPlayer5 is already true, but
 * init_sfc_setting() chose ControllerOption = SNES_JOYPAD, so it was never
 * plugged in. This plugs it in or pulls it out.
 *
 * It is a SETTING, not a register: S9xResetPPU re-derives IPPU.Controller from
 * Settings.ControllerOption, and loadState runs S9xReset(), so a rollback
 * load keeps whichever adaptor is plugged in and no blob byte has to carry it.
 * Every console in a room must therefore call this with the same value before
 * frame 0; snes.html does, from the room's agreed roster.
 *
 * Returns 1 when the multitap is now plugged in. A cart that refuses it
 * (memmap.c InitROM clears MultiPlayer5Master for SuperFX and Sufami Turbo)
 * returns 0 and stays on a plain pad. With on == 0 this restores exactly
 * what init_sfc_setting() set. */
EMSCRIPTEN_KEEPALIVE
int32_t setMultitap(int32_t on){
   if(on && runGameFlag && !Settings.MultiPlayer5Master) on = 0;
   Settings.ControllerOption = on ? SNES_MULTIPLAYER5 : SNES_JOYPAD;
   IPPU.Controller = on ? SNES_MULTIPLAYER5 : SNES_JOYPAD;
   return on ? 1 : 0;
}

/* Read-back for a test: 1 when the core's live controller is the multitap. */
EMSCRIPTEN_KEEPALIVE
int32_t getMultitap(void){
   return IPPU.Controller == SNES_MULTIPLAYER5 ? 1 : 0;
}

/* Read-back for a test: the console's 128 KB of work RAM, where a test ROM
 * (tools/snes_multitap_rom.mjs) leaves what the GUEST read off its pads. */
EMSCRIPTEN_KEEPALIVE
uint8_t *getWramPtr(void){
   return Memory.RAM;
}

/* Read-back for a test: the pad word the CORE latched for port 0..4 (what a
 * manual serial read shifts out), not what the page wrote. */
EMSCRIPTEN_KEEPALIVE
uint32_t getLatchedJoypad(int32_t port){
   if(port < 0 || port >= 5) return 0;
   return IPPU.Joypads[port];
}
EMSCRIPTEN_KEEPALIVE
bool saveStateInto(unsigned char *data, unsigned int size){
    if(!runGameFlag || !data || size != getStateSaveSize())return false;
    saveStateWrite(data);
    return true;
}

EMSCRIPTEN_KEEPALIVE
unsigned char *saveState(void){
    if(!runGameFlag)return NULL;
    unsigned char *data = (unsigned char*)calloc(getStateSaveSize(), sizeof(unsigned char));
    if(!data)return NULL;
    saveStateWrite(data);
    return data;
}

/* THE AUDIO RING'S WRITE POSITION. It is page-side plumbing, not guest state,
   so no savestate carries it: a rollback that re-simulates N frames would push
   N x 600 samples of a repeat into the ring. The page reads the position before
   re-simulating and puts it back after, dropping exactly those samples (the
   genesis core's gpx_audio_wpos / gpx_audio_rewind, same contract). */
EMSCRIPTEN_KEEPALIVE
unsigned int audioWpos(void){
    return outToExternalBufferSamplePos;
}

EMSCRIPTEN_KEEPALIVE
void audioRewind(unsigned int pos){
    outToExternalBufferSamplePos = pos % 4096;
}

static void saveStateWrite(unsigned char *data){
   uint8_t* buffer = (uint8_t*)data;
#ifdef LAGFIX
   S9xPackStatus();
#ifndef USE_BLARGG_APU
   S9xAPUPackStatus();
#endif
#endif
   S9xUpdateRTC();
   S9xSRTCPreSaveState();
   unsigned int version = 0;
   memcpy(buffer, &version, sizeof(unsigned int));
   buffer += sizeof(unsigned int);
   memcpy(buffer, &CPU, sizeof(CPU));
   buffer += sizeof(CPU);
#ifndef USE_BLARGG_APU
   /* The DSP noise generator (so.noise_gen) is guest state that no field of
      the blob carried: loadState reset it to 1 (S9xResetAPU -> S9xResetSound),
      and the mixer writes noise samples into SoundData.channels[].sample, which
      IS in the blob. Rollback (snes/snes_rollback.js) needs a load to be
      faithful, so it rides in SICPU's two never-read words, tagged so a blob
      saved before this change (both 0) loads exactly as it always did. The
      layout and size are unchanged, so every existing savestate still loads. */
   ICPU.UNUSED2 = (uint32_t) so.noise_gen;
   ICPU.UNUSED3 = SNES_NOISE_TAG;
#endif
   memcpy(buffer, &ICPU, sizeof(ICPU));
   buffer += sizeof(ICPU);
   snesPackJoypads();
   memcpy(buffer, &PPU, sizeof(PPU));
   buffer += sizeof(PPU);
   memcpy(buffer, &DMA, sizeof(DMA));
   buffer += sizeof(DMA);
   memcpy(buffer, Memory.VRAM, 0x10000);
   buffer += 0x10000;
   memcpy(buffer, Memory.RAM, 0x20000);
   buffer += 0x20000;
   memcpy(buffer, Memory.SRAM, 0x20000);
   buffer += 0x20000;
   memcpy(buffer, Memory.FillRAM, 0x8000);
   buffer += 0x8000;
#ifndef USE_BLARGG_APU
   memcpy(buffer, &APU, sizeof(APU));
   buffer += sizeof(APU);
   memcpy(buffer, &IAPU, sizeof(IAPU));
   buffer += sizeof(IAPU);
   memcpy(buffer, IAPU.RAM, 0x10000);
   buffer += 0x10000;
   memcpy(buffer, &SoundData, sizeof(SoundData));
   buffer += sizeof(SoundData);
#else
   S9xAPUSaveState(buffer);
   buffer += SPC_SAVE_STATE_BLOCK_SIZE;
#endif

   SA1.Registers.PC = SA1.PC - SA1.PCBase;
   S9xSA1PackStatus();

   memcpy(buffer, &SA1, sizeof(SA1));
   buffer += sizeof(SA1);
   memcpy(buffer, &s7r, sizeof(s7r));
   buffer += sizeof(s7r);
   memcpy(buffer, &rtc_f9, sizeof(rtc_f9));
}

EMSCRIPTEN_KEEPALIVE
bool loadState(const unsigned char* data, unsigned int size){
    if(size != getStateSaveSize())return false;
   const uint8_t* buffer = data;
   unsigned int version;
   memcpy(&version, buffer, sizeof(unsigned int));
   if(version != 0)return false;
   buffer += sizeof(unsigned int);
#ifndef USE_BLARGG_APU
   uint8_t* IAPU_RAM_current = IAPU.RAM;
   uintptr_t IAPU_RAM_offset;
#endif
   uint32_t sa1_old_flags = SA1.Flags;
   SSA1 sa1_state;
   /* A FAITHFUL LOAD (rollback netplay re-simulates from these blobs and must
      land exactly where a console that never rolled back is): the CPU event
      schedule and the sound channels are put back EXACTLY as saved after the
      fix-ups below recompute them. Measured before this, load-then-save was
      not the identity (545 bytes moved: CPU.WhichEvent/NextEvent, every
      channel's needs_decode/envxx), and a run that loaded before each frame
      left a straight run on its first frame. */
   SCPUState cpu_saved;
   memcpy(&cpu_saved, buffer, sizeof(cpu_saved));
#ifndef USE_BLARGG_APU
   const uint8_t* sound_saved;
#endif
   S9xReset();
   memcpy(&CPU, buffer, sizeof(CPU));
   buffer += sizeof(CPU);
   memcpy(&ICPU, buffer, sizeof(ICPU));
   buffer += sizeof(ICPU);
   memcpy(&PPU, buffer, sizeof(PPU));
   buffer += sizeof(PPU);
   memcpy(&DMA, buffer, sizeof(DMA));
   buffer += sizeof(DMA);
   memcpy(Memory.VRAM, buffer, 0x10000);
   buffer += 0x10000;
   memcpy(Memory.RAM, buffer, 0x20000);
   buffer += 0x20000;
   memcpy(Memory.SRAM, buffer, 0x20000);
   buffer += 0x20000;
   memcpy(Memory.FillRAM, buffer, 0x8000);
   buffer += 0x8000;
#ifndef USE_BLARGG_APU
   memcpy(&APU, buffer, sizeof(APU));
   buffer += sizeof(APU);
   memcpy(&IAPU, buffer, sizeof(IAPU));
   buffer += sizeof(IAPU);
   IAPU_RAM_offset = IAPU_RAM_current - IAPU.RAM;
   IAPU.PC += IAPU_RAM_offset;
   IAPU.DirectPage += IAPU_RAM_offset;
   IAPU.WaitAddress1 += IAPU_RAM_offset;
   IAPU.WaitAddress2 += IAPU_RAM_offset;
   IAPU.RAM = IAPU_RAM_current;
   memcpy(IAPU.RAM, buffer, 0x10000);
   buffer += 0x10000;
   memcpy(&SoundData, buffer, sizeof(SoundData));
   sound_saved = buffer;
   buffer += sizeof(SoundData);
#else
   S9xAPULoadState(buffer);
   buffer += SPC_SAVE_STATE_BLOCK_SIZE;
#endif

   memcpy(&sa1_state, buffer, sizeof(sa1_state));
   buffer += sizeof(sa1_state);

   /* SA1 state must be restored 'by hand' */
   SA1.Flags               = sa1_state.Flags;
   SA1.NMIActive           = sa1_state.NMIActive;
   SA1.IRQActive           = sa1_state.IRQActive;
   SA1.WaitingForInterrupt = sa1_state.WaitingForInterrupt;
   SA1.op1                 = sa1_state.op1;
   SA1.op2                 = sa1_state.op2;
   SA1.arithmetic_op       = sa1_state.arithmetic_op;
   SA1.sum                 = sa1_state.sum;
   SA1.overflow            = sa1_state.overflow;
   memcpy(&SA1.Registers, &sa1_state.Registers, sizeof(SA1.Registers));

   memcpy(&s7r, buffer, sizeof(s7r));
   buffer += sizeof(s7r);
   memcpy(&rtc_f9, buffer, sizeof(rtc_f9));

   S9xFixSA1AfterSnapshotLoad();
   SA1.Flags |= sa1_old_flags & (TRACE_FLAG);

   FixROMSpeed();
   IPPU.ColorsChanged = true;
   IPPU.OBJChanged = true;
   CPU.InDMA = false;
   S9xFixColourBrightness();
#ifndef USE_BLARGG_APU
   S9xAPUUnpackStatus();
   S9xFixSoundAfterSnapshotLoad();
   /* The fix-up set needs_decode on every channel (re-decoding a BRR block
      runs its filter on history that already advanced) and rebuilt envxx from
      envx (dropping its low bits). Its other work — filter taps, echo enable —
      lands outside SoundData and stays. SoundData itself goes back as saved. */
   memcpy(&SoundData, sound_saved, sizeof(SoundData));
   if (ICPU.UNUSED3 == SNES_NOISE_TAG)
      so.noise_gen = (int32_t) ICPU.UNUSED2;
#endif
   snesUnpackJoypads();
   ICPU.ShiftedPB = ICPU.Registers.PB << 16;
   ICPU.ShiftedDB = ICPU.Registers.DB << 16;
   S9xSetPCBase(ICPU.ShiftedPB + ICPU.Registers.PC);
   S9xUnpackStatus();
   S9xFixCycles();
   S9xReschedule();
   /* S9xReschedule derives the next event from V_Counter; the saved one is
      what the running machine actually had scheduled. */
   CPU.WhichEvent = cpu_saved.WhichEvent;
   CPU.NextEvent  = cpu_saved.NextEvent;
   return true;
}
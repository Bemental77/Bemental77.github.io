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

int joyPadInput = 0;
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

EMSCRIPTEN_KEEPALIVE
void setJoypadInput(int32_t input){
    joyPadInput = input;
} 

uint32_t S9xReadJoypad(int32_t port){
    if(port == 0)return joyPadInput;//1Pのみ対応
    return 0;
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

EMSCRIPTEN_KEEPALIVE
unsigned char *saveState(void){
    if(!runGameFlag)return NULL;
    int32_t i;
    unsigned char *data = (unsigned char*)calloc(getStateSaveSize(), sizeof(unsigned char));
    if(!data)return NULL;
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
   memcpy(buffer, &ICPU, sizeof(ICPU));
   buffer += sizeof(ICPU);
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

   return data;
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
#endif
   ICPU.ShiftedPB = ICPU.Registers.PB << 16;
   ICPU.ShiftedDB = ICPU.Registers.DB << 16;
   S9xSetPCBase(ICPU.ShiftedPB + ICPU.Registers.PC);
   S9xUnpackStatus();
   S9xFixCycles();
   S9xReschedule();
   return true;
}
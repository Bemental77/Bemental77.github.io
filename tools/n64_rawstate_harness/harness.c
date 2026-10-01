/* headless verification harness: the N64Wasm core WITHOUT mymain.cpp/SDL.
 * Provides the symbols mymain.cpp would, and drives retro_run one frame at a time. */
#include <stdint.h>
#include <stdbool.h>
#include <string.h>
#include <emscripten.h>
#include "neil_controller.h"
int angryVerticalResolution = 240;
int mouseX = 0, mouseY = 0, mousePressed = 0, mouseRange = 40;
int g_jit_bridge = 0;
double g_frame_cost_ms = 0.0;
unsigned int g_frame_cost_n = 0;
struct NeilCheats { uint32_t address; int value; };
struct NeilCheats neilCheats[256];
int neilCheatsLength = 0;
bool doubleSpeed = false;
struct NeilButtons neilbuttons[4];
bool forceAngry = true;
int triangleCount = 0, globalTriangleTrigger = 0;
bool pilotwingsFix = false, vbuf_use_vbo = false;
char toast_message[256];
void neil_toast_message(char* m) { (void)m; }

void retro_init(void);
bool retro_load_game_new(uint8_t* romdata, int size, bool loadEep, bool loadSra, bool loadFla);
void retro_run(void);
int getReadyToSwap(void);
void resetReadyToSwap(void);

EMSCRIPTEN_KEEPALIVE int h_boot(uint8_t* rom, int size)
{
    retro_init();
    return retro_load_game_new(rom, size, false, false, false) ? 1 : 0;
}
EMSCRIPTEN_KEEPALIVE void h_pad(int port, int mask, int ax, int ay)
{
    struct NeilButtons* b = &neilbuttons[port];
    memset(b, 0, sizeof(*b));
    b->upKey = !!(mask & 1); b->downKey = !!(mask & 2); b->leftKey = !!(mask & 4); b->rightKey = !!(mask & 8);
    b->aKey = !!(mask & 16); b->bKey = !!(mask & 32); b->startKey = !!(mask & 64); b->zKey = !!(mask & 128);
    b->lKey = !!(mask & 256); b->rKey = !!(mask & 512);
    b->cbUp = !!(mask & 1024); b->cbDown = !!(mask & 2048); b->cbLeft = !!(mask & 4096); b->cbRight = !!(mask & 8192);
    b->axis0 = ax; b->axis1 = -ay;
}
EMSCRIPTEN_KEEPALIVE int h_frame(void)
{
    retro_run();
    int s = getReadyToSwap();
    if (s) resetReadyToSwap();
    return s;
}
struct rgba { uint8_t r, g, b, a; };
extern struct rgba prescale[];
EMSCRIPTEN_KEEPALIVE void* h_prescale(void) { return prescale; }

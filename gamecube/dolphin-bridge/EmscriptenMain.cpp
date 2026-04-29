#include <SDL/SDL.h>
#include <emscripten.h>
#include <cstdint>
#include <cstdio>
#include <cstring>

static uint8_t g_pad_state[16] = {0};
static SDL_Surface* g_display = nullptr;

extern "C" {

EMSCRIPTEN_KEEPALIVE
void* get_ptr(int idx) {
    switch (idx) {
        case 0: return g_pad_state;
        default: return nullptr;
    }
}

EMSCRIPTEN_KEEPALIVE
void CheckJoy(void) {}

EMSCRIPTEN_KEEPALIVE
void CheckKeyboard(void) {}

EMSCRIPTEN_KEEPALIVE
void render(int x, int y, int w, int h) {
    (void)x; (void)y; (void)w; (void)h;
}

EMSCRIPTEN_KEEPALIVE
void feedAudio(int buf, int len) {
    (void)buf; (void)len;
}

}

int main(void) {
    if (SDL_Init(SDL_INIT_VIDEO | SDL_INIT_AUDIO) < 0) {
        printf("SDL_Init failed: %s\n", SDL_GetError());
    } else {
        g_display = SDL_SetVideoMode(640, 480, 32, SDL_HWSURFACE);
        printf("dolphin_libretro stub: SDL inited\n");
    }
    memset(g_pad_state, 0xff, sizeof(g_pad_state));
    EM_ASM({ if (typeof var_setup === 'function') var_setup(); });
    emscripten_exit_with_live_runtime();
    return 0;
}

// gamecube/native/src/web_stubs.cpp — Party Board front-end entry points the web build does not ship
// (its RmlUi UI in src/port/ui and the achievements popup). The game calls these unconditionally.
#include <SDL3/SDL_events.h>

extern "C" {
void ui_handle_sdl_event(const SDL_Event* event) { (void)event; }
void ui_update(void) {}
}

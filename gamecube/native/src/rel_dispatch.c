// The overlay "loader" of the web build — see gamecube/native/rel_build.py. objdll.c's dlopen /
// dlsym / dlclose become these (it is compiled with them #defined, under __EMSCRIPTEN__).
#include <string.h>
#include <stdlib.h>
#include <stdio.h>
typedef struct { const char* name; void (*setup)(void); char *db, *de, *bb, *be; } RelEntry;
extern const RelEntry mp4web_rel_table[];
static char* s_snap[256];
static const char* s_err = "";

void* mp4web_rel_open(const char* file) {
  char name[64]; size_t n = strcspn(file, ".");
  if (n >= sizeof name) n = sizeof name - 1;
  memcpy(name, file, n); name[n] = 0;
  for (int i = 0; mp4web_rel_table[i].name; i++) {
    const RelEntry* e = &mp4web_rel_table[i];
    if (strcmp(e->name, name) != 0) continue;
    // fresh statics, as a newly loaded library has them: .data as it was at the first link, .bss zero
    size_t dn = (size_t)(e->de - e->db), bn = (size_t)(e->be - e->bb);
    if (i < 256) {
      if (!s_snap[i]) { s_snap[i] = malloc(dn ? dn : 1); memcpy(s_snap[i], e->db, dn); }
      else memcpy(e->db, s_snap[i], dn);
    }
    memset(e->bb, 0, bn);
    return (void*)e;
  }
  s_err = "overlay not built into this module";
  fprintf(stderr, "[rel] %s: %s\n", file, s_err);
  return 0;
}
void* mp4web_rel_sym(void* h, const char* sym) {
  if (!h) return 0;
  if (strcmp(sym, "ObjectSetup") == 0) return (void*)((const RelEntry*)h)->setup;
  return 0;
}
int mp4web_rel_close(void* h) { (void)h; return 0; }
const char* mp4web_rel_error(void) { return s_err; }

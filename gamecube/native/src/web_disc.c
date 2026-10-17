// gamecube/native/src/web_disc.c — the disc image as a NodDiscStream backed by the page.
// The page puts the user's disc into Module.mp4Disc = [Uint8Array, ...] (the parts in order,
// already inflated) before main() runs; aurora_dvd_open("web:") reads through these.
#include <emscripten.h>
#include <stdint.h>
#include <stddef.h>
#include "nod.h"

EM_JS(double, mp4web_disc_len_js, (void), {
  var p = Module.mp4Disc || [], n = 0;
  for (var i = 0; i < p.length; i++) n += p[i].length;
  return n;
});

EM_JS(double, mp4web_disc_read_js, (double off, void* out, double len), {
  var p = Module.mp4Disc || [], base = 0, done = 0;
  for (var i = 0; i < p.length && done < len; i++) {
    var a = p[i], end = base + a.length;
    if (off + done < end) {
      var s = off + done - base, take = Math.min(a.length - s, len - done);
      HEAPU8.set(a.subarray(s, s + take), out + done);
      done += take;
    }
    base = end;
  }
  return done;
});

void mp4web_rb_mark(uint32_t a, uint32_t n);   // rollback.c: log pages JS is about to overwrite
static int64_t web_read_at(void* u, uint64_t off, void* out, size_t len) {
  (void)u;
  mp4web_rb_mark((uint32_t)(uintptr_t)out, (uint32_t)len);
  return (int64_t)mp4web_disc_read_js((double)off, out, (double)len);
}
static int64_t web_len(void* u) { (void)u; return (int64_t)mp4web_disc_len_js(); }
static void web_close(void* u) { (void)u; }

void mp4web_disc_stream(NodDiscStream* s) {
  s->user_data = 0;
  s->read_at = web_read_at;
  s->stream_len = web_len;
  s->close = web_close;
}

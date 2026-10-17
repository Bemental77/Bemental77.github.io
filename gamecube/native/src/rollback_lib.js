// gamecube/native/src/rollback_lib.js (--js-library): stand-ins for the write barrier's entry points.
// wb/instrument.sh merges wb/barrier.wat into the wasm, which resolves these imports inside the
// module; a wasm built without it gets these, and rollback refuses to enable (present() == 0).
addToLibrary({
  mp4web_barrier_init: function (base, pages, table) {},
  mp4web_barrier_present: function () { return 0; },
});

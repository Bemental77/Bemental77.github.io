// gamecube/native/src/post.js (--post-js): hands the page emdawnwebgpu's handle table, which a
// whole-memory snapshot has to save and restore alongside linear memory (C++ objects in memory refer
// to their JS GPU objects by address).
Module['mp4WebGPU'] = (typeof WebGPU !== 'undefined') ? WebGPU : null;

// ROLLBACK: a file read lands in game memory from JS (emscripten's fd_read -> FS.read(stream, HEAP8,
// ptr, len)), where the write barrier never sees it. Log those pages first, as web_disc.c does for the
// disc reader — measured: a restore that left one det-heap page as the later read had written it.
(function () {
  if (typeof FS === 'undefined' || !FS.read) return;
  var read = FS.read;
  FS.read = function (stream, buffer, offset, length, position, canOwn) {
    if (length > 0 && buffer && buffer.buffer === HEAP8.buffer && Module['_mp4web_rb_mark']) Module['_mp4web_rb_mark'](offset >>> 0, length >>> 0);
    return read.apply(this, arguments);
  };
})();

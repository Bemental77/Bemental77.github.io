/* js/worker_pre.js — the --pre-js of wasmpsx_worker.js (Makefile.modern WORKER_FLAGS).
 * THE WASM AND ITS JS ARE ONE BUILD, SO THEY ARE FETCHED AS ONE. ps1.html loads
 * this worker as wasmpsx_worker.js?v=<now>, so the JS is never stale; the .wasm
 * and .data it fetches used to carry no query, so a browser (or CDN) could pair
 * a fresh JS with a cached wasm of an earlier build. Until 2026-10-07 the wasm
 * never changed, so that never bit; a rebuilt core changes both, and a torn pair
 * fails at instantiate. So the worker's own ?v= is carried onto the wasm fetch.
 * (The .data package — the BIOS, unchanged since it shipped — is requested by
 * emcc's file-packager code, which runs BEFORE this pre-js, so it stays as it was.) */
Module['locateFile'] = function (path, prefix) {
  var v = '';
  try { var m = /[?&]v=([^&]*)/.exec(String(self.location.search)); if (m) v = m[1]; } catch (e) {}
  return (prefix || '') + path + (v && /\.(wasm|data)$/.test(path) ? '?v=' + v : '');
};

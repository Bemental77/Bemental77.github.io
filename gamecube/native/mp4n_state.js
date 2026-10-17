// gamecube/native/mp4n_state.js — determinism tools for mp4-native.html.
//   Mp4State.attach(module)            install the per-frame hook (web_port.cpp calls it at the frame boundary)
//   Mp4State.requestSnapshot(cb)       whole linear memory + the WebGPU handle table, taken at the next boundary
//   Mp4State.requestRestore(snap, cb)  put a snapshot back at the next boundary (same instance)
//   Mp4State.hashEvery(n)              record the game-state hash every n frames into Mp4State.hashes
// A snapshot is taken where the C stack has the same shape every frame (inside frame_limiter, before
// its sleep), so restoring memory there resumes the game exactly at the snapshotted frame.
(function () {
  'use strict';
  var mod = null, pending = [], hashN = 0;
  var S = {
    hashes: Object.create(null),
    lastSnapshotMs: 0, lastRestoreMs: 0,
    attach: function (m) {
      mod = m;
      var prev = m.mp4FrameHook;
      m.mp4StatePending = function () { return pending.length ? 1 : 0; };
      m.mp4FrameHook = function (frame) {
        var restored = 0;
        if (hashN && frame % hashN === 0) S.hashes[frame] = m._mp4web_state_hash();
        while (pending.length) {
          var job = pending.shift();
          if (job.kind === 'snap') {
            var t0 = performance.now();
            var snap = { frame: frame, mem: m.HEAPU8.slice(), gpu: copyTable(m) };
            S.lastSnapshotMs = performance.now() - t0;
            if (job.cb) job.cb(snap);
          } else if (job.kind === 'restore') {
            var t1 = performance.now();
            var heap = m.HEAPU8;
            if (job.snap.mem.length > heap.length) throw new Error('snapshot larger than memory');
            heap.set(job.snap.mem);
            if (heap.length > job.snap.mem.length) heap.fill(0, job.snap.mem.length);
            restoreTable(m, job.snap.gpu);
            S.lastRestoreMs = performance.now() - t1;
            restored = 1;
            if (job.cb) job.cb(job.snap.frame);
          }
        }
        if (prev) restored |= prev(frame);
        return restored;
      };
    },
    requestSnapshot: function (cb) { pending.push({ kind: 'snap', cb: cb }); },
    requestRestore: function (snap, cb) { pending.push({ kind: 'restore', snap: snap, cb: cb }); },
    hashEvery: function (n) { hashN = n | 0; },
    hashNow: function () { return mod ? mod._mp4web_state_hash() : null; }
  };
  // emdawnwebgpu maps C++ object addresses to JS GPU objects; memory restored to an older state
  // must see the table as it was then (objects released since are kept alive by the snapshot).
  function internals(m) { return m.mp4WebGPU && m.mp4WebGPU.Internals; }
  function copyTable(m) {
    var I = internals(m); if (!I) return null;
    var out = {}, k;
    for (k in I) {
      var v = I[k];
      if (v && typeof v === 'object' && !(typeof v === 'function')) {
        if (Array.isArray(v)) { var a = []; for (var i in v) a[i] = Array.isArray(v[i]) ? v[i].slice() : v[i]; out[k] = a; }   // inner lists too (bufferOnUnmaps)
        else if (Object.getPrototypeOf(v) === Object.prototype) out[k] = Object.assign({}, v);
      }
    }
    return out;
  }
  function restoreTable(m, saved) {
    var I = internals(m); if (!I || !saved) return;
    for (var k in saved) {
      var v = saved[k];
      if (Array.isArray(v)) { var a = []; for (var i in v) a[i] = Array.isArray(v[i]) ? v[i].slice() : v[i]; I[k] = a; }   // sparse outer: never slice() it
      else I[k] = Object.assign({}, v);
    }
  }
  window.Mp4State = S;
})();

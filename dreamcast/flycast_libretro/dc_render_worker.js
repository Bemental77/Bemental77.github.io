// dreamcast/flycast_libretro/dc_render_worker.js — the CONSUMER half of the
// Dreamcast GL-stream offload (?glsplit, flycast_worker.js "GL STREAM OFFLOAD").
//
// WHY. A WebGL2 context on a transferred OffscreenCanvas presents at the end of
// the task that drew, and that task's thread is HELD until the GPU process has
// rasterised the picture: measured with a 200-quad frame on SwiftShader, 14.7 ms
// per picture on the drawing thread (dcrb-present.mjs, "xfer"), growing with the
// raster work (2.2 ms at 1 quad, 130 ms at 2000). flycast drew on its emulation
// thread, so every picture stopped the SH4: 25% of Gauntlet's and ~50% of PSO
// Pioneer 2's worker second (render-hold). The same frames drawn by a SECOND
// worker left the producing thread at 122 work-ticks/s against 41 (the no-draw
// ceiling is 124) while drawing as many pictures.
//
// So the emulation worker records every GL call into batches (flycast_worker.js
// GLRec) and this worker, which owns the page's canvas and the only real
// WebGL2 context, replays them in order. Queries the core needs answered
// synchronously (shader status, uniform locations, readPixels, ...) come as a
// `sync` op at the end of a batch; the answer goes back through a shared
// buffer the producer waits on (Atomics). After each batch the id of the last
// batch whose task has ENDED (so its picture is presented) is published in
// ctl[2], which is what the producer's fences read.
'use strict';
let gl = null, ctl = null, res = null, objs = new Map(), lastDone = 0, pendingDone = 0, errs = 0;
const ping = new MessageChannel();
ping.port1.onmessage = () => { if (pendingDone > lastDone) { lastDone = pendingDone; Atomics.store(ctl, 2, lastDone); Atomics.notify(ctl, 2); } };
function arg(a) {
  if (a !== null && typeof a === 'object' && a.o !== undefined && !ArrayBuffer.isView(a)) return objs.get(a.o) || null;
  return a;
}
// encode a sync answer into res (bytes) — JSON for values, raw bytes for pixel reads
const enc = new TextEncoder();
function answer(v) {
  let kind = 1, bytes;
  if (v instanceof Uint8Array) { kind = 2; bytes = v; }
  else {
    let j;
    if (v === undefined) j = 'null';
    else if (v && typeof v === 'object' && 'name' in v && 'size' in v && 'type' in v) j = JSON.stringify({ name: v.name, size: v.size, type: v.type });
    else if (ArrayBuffer.isView(v)) j = JSON.stringify(Array.from(v));
    else j = JSON.stringify(v);
    bytes = enc.encode(j);
  }
  const need = 16 + bytes.length;
  if (need > res.byteLength) { bytes = enc.encode('null'); kind = 1; }
  new Uint8Array(res, 16, bytes.length).set(bytes);
  const h = new Int32Array(res, 0, 4); h[0] = kind; h[1] = bytes.length;
  Atomics.store(ctl, 0, 1); Atomics.notify(ctl, 0);
}
const NAMES = [];
function decode(f, blobs) {
  const ops = []; let i = 0;
  while (i < f.length) {
    const name = NAMES[f[i++]], argc = f[i++], op = new Array(argc + 1); op[0] = name;
    for (let k = 1; k <= argc; k++) {
      const t = f[i++], v = f[i++];
      op[k] = t === 0 ? v : t === 1 ? { o: v } : t === 2 ? blobs[v] : t === 3 ? null : !!v;
    }
    ops.push(op);
  }
  return ops;
}
function exec(ops) {
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i], m = op[0];
    try {
      switch (m) {
        case '+': {   // create: ['+', kind, id]
          const k = op[1], id = op[2];
          objs.set(id, gl[k]());
          break;
        }
        case '+s': objs.set(op[2], gl.createShader(op[1])); break;
        case '-': {   // delete: ['-', method, id]
          const o = objs.get(op[2]); if (o) gl[op[1]](o); objs.delete(op[2]);
          break;
        }
        case 'loc': { // ['loc', id, programId, name] — resolve and keep; answered by a sync too
          const l = gl.getUniformLocation(objs.get(op[2]), op[3]);
          if (l) objs.set(op[1], l);
          break;
        }
        case 'sync': {   // ['sync', method, ...args] — a call whose RESULT the producer needs
          const meth = op[1], a = op.slice(2).map(arg);
          let v;
          if (meth === 'getUniformLocation') {   // a: [prog, name, id]
            const l = gl.getUniformLocation(a[0], a[1]);
            if (l) objs.set(op[4], l);
            v = !!l;
          } else if (meth === 'readPixels') {    // [x,y,w,h,format,type,byteLength]
            const n = op[8], buf = new Uint8Array(n);
            gl.readPixels(a[0], a[1], a[2], a[3], a[4], a[5], buf);
            v = buf;
          } else v = gl[meth].apply(gl, a);
          answer(v);
          break;
        }
        default:
          gl[m].apply(gl, op.length > 1 ? op.slice(1).map(arg) : []);
      }
    } catch (e) {
      if (++errs <= 8) postMessage({ cmd: 'print', txt: '[glsplit] replay of ' + m + ' threw: ' + (e && e.message || e) });
      if (m === 'sync') answer(null);
    }
  }
}
onmessage = (e) => {
  const d = e.data;
  if (d.init) {   // can this worker make a WebGL2 context at all? (asked before the canvas comes)
    const c = new Int32Array(d.init); let ok = -1;
    try { const t = new OffscreenCanvas(1, 1).getContext('webgl2'); ok = t ? 1 : -1; const l = t && t.getExtension('WEBGL_lose_context'); if (l) l.loseContext(); } catch (_) {}
    Atomics.store(c, 3, ok); Atomics.notify(c, 3);
    return;
  }
  if (d.canvas) {
    ctl = new Int32Array(d.ctl); res = d.res;
    gl = d.canvas.getContext('webgl2', d.attrs);
    postMessage({ cmd: 'print', txt: '[glsplit] render worker owns the canvas: context ' + (gl ? 'OK' : 'FAILED') });
    return;
  }
  if (d.names) for (const n of d.names) NAMES.push(n);
  if (d.f) exec(decode(d.f, d.blobs));
  if (d.id) { pendingDone = d.id; ping.port2.postMessage(0); }   // published in the NEXT task: after this one's present
};

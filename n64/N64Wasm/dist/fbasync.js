// fbasync.js — ASYNCHRONOUS FRAMEBUFFER READBACK, shared by the page and the core worker.
//
// Moved VERBATIM out of n64/index.html (where the full rationale comment still
// sits above the call site) so that the main-thread core and the worker-hosted
// core (core_worker.js) run ONE implementation: the one-call readback offset is
// part of guest state for read_always titles (it decides which bytes land in
// RDRAM), so two copies that drifted apart would be two different consoles.
// The only edits are `window.` -> `G.` (the global it installs on: the page's
// window or the worker's self) and `location.search` -> `search` (a worker's
// own location is its script URL, not the page's query string).
//
//   __n64InstallFbAsync(G, search)   installs G.__fbAsync, G.__fbDecide and the
//                                    WebGL2RenderingContext.prototype.readPixels
//                                    wrapper of the realm it is called in.
(function (root) {
  root.__n64InstallFbAsync = function (G, search) {
    if (G.__fbAsync) return G.__fbAsync;   // once per realm
  var FB_Q = new URLSearchParams(search);
  var FB_FORCE = FB_Q.get('fbasync');                 // '1' | '0' | null (= per title)
  var FB_WITNESS = FB_Q.get('fbwitness') === '1';
  G.__fbAsync = { on: FB_FORCE === '1', decided: FB_FORCE === '1' ? 'forced on (?fbasync=1)' : null,
                       calls: 0, async: 0, sync: 0, blocked: 0, invalidations: 0, pinned: 0, pool: 0,
                       seq: FB_WITNESS ? [] : null };
  // Glide64_Ini.c's read_always = 1 branches, by the name each one tests
  // (HAVE_HWFBE is not defined in this build, so the #ifndef branches apply).
  var FB_READ_ALWAYS = ['MARIOKART64', 'POKEMON SNAP', 'DONKEY KONG 64', 'BANJO TOOIE',
                        'Banjo-Kazooie', 'BANJO KAZOOIE 2', 'CASTLEVANIA', 'RIDGE RACER 64'];
  function romInternalName(bytes) {
    if (!bytes || bytes.length < 0x40) return null;
    var b = bytes, sig = (b[0] << 24 | b[1] << 16 | b[2] << 8 | b[3]) >>> 0, s = '';
    for (var i = 0x20; i < 0x34; i++) {
      var j = i;                                       // .z64: native big-endian
      if (sig === 0x37804012) j = i ^ 1;               // .v64: 16-bit byte-swapped
      else if (sig === 0x40123780) j = i ^ 3;          // .n64: 32-bit word-swapped
      else if (sig !== 0x80371240) return null;
      s += String.fromCharCode(b[j]);
    }
    return s.replace(/\0/g, '').replace(/ +$/, '');
  }
  G.__fbDecide = function (bytes) {
    var st = G.__fbAsync, name = romInternalName(bytes);
    st.romName = name;
    var hit = null;
    if (name) for (var i = 0; i < FB_READ_ALWAYS.length; i++) if (name.indexOf(FB_READ_ALWAYS[i]) >= 0) { hit = FB_READ_ALWAYS[i]; break; }
    st.readAlways = !!hit;
    if (FB_FORCE === '1') { st.on = true; st.decided = 'forced on (?fbasync=1)'; }
    else if (FB_FORCE === '0') { st.on = false; st.decided = 'opted out (?fbasync=0)'; }
    else { st.on = !!hit; st.decided = hit ? 'read_always title (' + hit + ')' : 'off — glide does not read this title back every frame'; }
    return st.on;
  };
  if (G.WebGL2RenderingContext) {
    (function () {
      var P = WebGL2RenderingContext.prototype, orig = P.readPixels;
      var st = G.__fbAsync, ctxs = [], hooked = false;
      // A pack buffer: { gl, buf, bytes, key, fence, refs }. refs counts the
      // owners — "pending" (the next call hands it over) and every snapshot
      // that pinned it. Only a buffer with refs 0 is ever written again.
      var fbOf = function (gl) {
        if (!gl.__fb) { gl.__fb = { pending: null, pool: [] }; ctxs.push(gl); }
        return gl.__fb;
      };
      var unref = function (b) {
        if (!b || --b.refs > 0) return;
        if (b.fence) { try { b.gl.deleteSync(b.fence); } catch (e) {} b.fence = null; }
        var fb = fbOf(b.gl);
        if (fb.pool.length < 16) { fb.pool.push(b); st.pool = fb.pool.length; }
        else { try { b.gl.deleteBuffer(b.buf); } catch (e) {} }
      };
      var acquire = function (gl, bytes, key) {
        var fb = fbOf(gl), b = null;
        for (var i = 0; i < fb.pool.length; i++) if (fb.pool[i].bytes === bytes) { b = fb.pool.splice(i, 1)[0]; break; }
        if (!b) {
          b = { gl: gl, buf: gl.createBuffer(), bytes: bytes, key: key, fence: null, refs: 0 };
          gl.bindBuffer(gl.PIXEL_PACK_BUFFER, b.buf);
          gl.bufferData(gl.PIXEL_PACK_BUFFER, bytes, gl.STREAM_READ);
          gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        }
        b.key = key; b.refs = 1;
        st.pool = fb.pool.length;
        return b;
      };
      var dropPending = function () {
        for (var c = 0; c < ctxs.length; c++) { var fb = ctxs[c].__fb; if (fb.pending) { unref(fb.pending); fb.pending = null; } }
      };
      st.invalidate = function (why) { dropPending(); st.invalidations++; st.lastInvalidation = why || 'call'; };
      // ROLLBACK / RUN-AHEAD: pin what the NEXT call would hand over.
      st.snapshot = function () {
        var out = [];
        for (var c = 0; c < ctxs.length; c++) {
          var p = ctxs[c].__fb.pending;
          if (p) { p.refs++; st.pinned++; }
          out.push([ctxs[c], p]);
        }
        return out;
      };
      st.restore = function (snap) {
        if (!snap) return;
        dropPending();
        for (var i = 0; i < snap.length; i++) {
          var fb = fbOf(snap[i][0]), p = snap[i][1];
          if (p) p.refs++;
          fb.pending = p;
        }
        st.restores = (st.restores | 0) + 1;
      };
      st.release = function (snap) {
        if (!snap) return;
        for (var i = 0; i < snap.length; i++) if (snap[i][1]) { unref(snap[i][1]); st.pinned--; }
      };
      var hookCore = function () {
        var M = G.Module;
        if (hooked || !M || typeof M._neil_reset !== 'function') return;
        hooked = true;
        ['_neil_reset', '_neil_unserialize'].forEach(function (n) {
          var f = M[n]; if (typeof f !== 'function') return;
          M[n] = function () { st.invalidate(n); return f.apply(this, arguments); };
        });
      };
      // The witness: FNV-1a over every 61st byte of what the core was handed
      // (~20 K reads of a 640x480 copy) — cheap enough not to move the timing.
      var witness = function (x, y, w, h, u8, from, bytes, mode, blocked) {
        var hsh = 2166136261 >>> 0;
        hsh = Math.imul(hsh ^ (x * 65599 + y) , 16777619) >>> 0;
        hsh = Math.imul(hsh ^ (w * 65599 + h), 16777619) >>> 0;
        for (var i = from; i < from + bytes; i += 61) hsh = Math.imul(hsh ^ u8[i], 16777619) >>> 0;
        if (st.seq.length < 40000) st.seq.push([st.calls, hsh, mode, blocked ? 1 : 0]);
      };
      P.readPixels = function (x, y, w, h, format, type, dst, dstIndex) {
        var gl = this;
        if (!st.on && !st.seq) return orig.apply(gl, arguments);
        // ⚠ A ZERO-AREA READ IS NOT A READ. DK64's first readback is (0,480,
        // 640x0). Taken through a pack buffer it created a 0-byte
        // PIXEL_PACK_BUFFER, and the next (real) read on that context came back
        // with bytes that varied by browser context while the context was
        // lost (drawingBufferWidth 0) right after it — measured: two contexts
        // handed the core 2826218052 vs 2297120715 on call #2, a room desync.
        // It moves no pixels, so it goes straight to GL and changes no state.
        if (!(w > 0 && h > 0)) return orig.apply(gl, arguments);
        st.calls++;
        if (!hooked) hookCore();
        if (st.bypass || arguments.length < 7 || !dst || typeof dst !== 'object' || !dst.buffer ||
            format !== gl.RGBA || type !== gl.UNSIGNED_BYTE || gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING)) {
          st.sync++; return orig.apply(gl, arguments);
        }
        var bytes = w * h * 4;
        var dstByte = dst.byteOffset + ((dstIndex | 0) * (dst.BYTES_PER_ELEMENT || 1));
        if (dstByte + bytes > dst.buffer.byteLength) { st.sync++; return orig.apply(gl, arguments); }
        var u8 = st.seq ? new Uint8Array(dst.buffer) : null;
        if (!st.on) {                                       // witness only: the shipped synchronous read
          var r0 = orig.apply(gl, arguments); st.sync++;
          witness(x, y, w, h, u8, dstByte, bytes, 0, false);
          return r0;
        }
        var key = x + ',' + y + ',' + w + 'x' + h + ':' + format + ':' + type;
        var fb = fbOf(gl);
        // A different rect than the pending copy: it is from before the switch.
        if (fb.pending && fb.pending.key !== key) { unref(fb.pending); fb.pending = null; st.invalidations++; st.lastInvalidation = 'rect'; }
        // 1. start this call's copy into a free pack buffer — no wait
        var cur = acquire(gl, bytes, key);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, cur.buf);
        orig.call(gl, x, y, w, h, format, type, 0);
        cur.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        var dstView = new Uint8Array(dst.buffer, dstByte, bytes);
        if (!fb.pending) {
          // Nothing older exists (first call, or just dropped): hand over THIS
          // copy — the synchronous read — and keep it pending as well, so the
          // NEXT call hands over this one: the one-call offset from here on.
          gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, dstView);
          gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
          st.sync++;
          if (u8) witness(x, y, w, h, u8, dstByte, bytes, 0, false);
          fb.pending = cur;
          return;
        }
        // 2. hand the core the PREVIOUS copy — complete, blocking if it must
        var prev = fb.pending;
        var blocked = !!(prev.fence && gl.getSyncParameter(prev.fence, gl.SYNC_STATUS) !== gl.SIGNALED);
        if (blocked) st.blocked++;
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, prev.buf);
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, dstView);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        unref(prev);                                         // consumed (a pinned copy survives)
        fb.pending = cur;
        st.async++;
        if (u8) witness(x, y, w, h, u8, dstByte, bytes, 1, blocked);
      };
    })();
  }
    return G.__fbAsync;
  };
})(typeof window !== 'undefined' ? window : self);

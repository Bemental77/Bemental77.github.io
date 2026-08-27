// gamecube/tools/wgpu_cap_inject.js — self-injected WebGPU GPU-boundary capture
// (the tool that cracked the "board 3D draws produce no fragments" crux 2026-08-26).
//
// WHAT IT DOES: wraps the WebGPU prototypes in dolphin_worker's level-1 realm (where
// emdawnwebgpu's device lives under PROXY_TO_PTHREAD — see memory
// gc_webgpu_debug_tooling_2026_08_20) and, when armed by a page message
//   dolphin_worker.postMessage({cmd:'wgpuCap', tag:'name', submits:2})
// captures per-draw GPU state for the next N queue.submits and dumps chunked JSON
// over the {cmd:'print'} relay:
//   - render passes: attachments, loadOps, clear values
//   - per draw: pipeline (topology/cull/depth/blend/writeMask + WGSL module ids),
//     viewport, scissor, bind groups + dynamic offsets, bound textures,
//     VS uniforms (posnormal, projection, pixelcentercorrection) and PS uniforms
//     (TEV colors/kcolors, alphaTest ctl words, blend words) recovered by matching
//     queue.writeBuffer offsets against the draw's dynamic UBO offsets,
//     and an OCCLUSION QUERY sample count ("frag") — the authoritative
//     "did any fragment pass the per-fragment tests" per draw
//   - WGSL source (head+tail) of shader modules used by perspective draws
//
// HOW TO USE: paste this whole file at the TOP of
// gamecube/dolphin_libretro/dolphin_worker.js (before the main IIFE), run
// gamecube/tools/wgpu_diff_probe.mjs (FIXDIR=<fixture dir> TAG=<name>), analyze with
// gamecube/tools/wgpu_diff.mjs. STRIP from dolphin_worker.js before committing it.
// Captures per-draw GPU-boundary state (render-pass attachments, pipeline, bind
// groups + dynamic offsets, viewport/scissor, and the exact VS/PS uniform bytes
// recovered by matching queue.writeBuffer offsets against the draw's dynamic
// offsets) for the board-vs-title no-fragments diff. Armed by page message
// {cmd:'wgpuCap', tag, submits}; dumps chunked JSON over the {cmd:'print'} relay.
(function () {
  try {
    if (self.__bemWgpuHooked || typeof GPUQueue === 'undefined' || typeof GPUDevice === 'undefined'
        || typeof GPURenderPassEncoder === 'undefined' || typeof GPUCommandEncoder === 'undefined'
        || typeof GPUTexture === 'undefined') return;
    self.__bemWgpuHooked = 1;
    var seq = 0, ids = new WeakMap(), nextId = { b: 1, t: 1, p: 1, g: 1, s: 1 };
    function idOf(o, k) { var v = ids.get(o); if (!v) { v = k + (nextId[k]++); ids.set(o, v); } return v; }
    var texInfo = {}, bufWrites = {}, pipeInfo = {}, bgInfo = {}, shaders = {};
    var viewTex = new WeakMap(), passState = new WeakMap(), qEncoders = new WeakSet();
    var cap = null, dev = null, qs = null, QMAX = 2000;
    function rf(v) { return typeof v === 'number' && isFinite(v) ? +v.toPrecision(6) : String(v); }

    var _createShaderModule = GPUDevice.prototype.createShaderModule;
    GPUDevice.prototype.createShaderModule = function (d) {
      var m = _createShaderModule.call(this, d);
      try {
        var code = d.code || '';
        shaders[idOf(m, 's')] = code.length > 30000
          ? code.slice(0, 6000) + '\n/* ...SNIP ' + (code.length - 30000) + 'B... */\n' + code.slice(-24000)
          : code;
      } catch (e) {}
      return m;
    };

    var _createTexture = GPUDevice.prototype.createTexture;
    GPUDevice.prototype.createTexture = function (d) {
      var t = _createTexture.call(this, d);
      try { texInfo[idOf(t, 't')] = { w: (d.size && (d.size.width || d.size[0])) | 0,
        h: (d.size && (d.size.height || d.size[1])) | 0, f: d.format, u: d.usage }; } catch (e) {}
      return t;
    };
    var _createView = GPUTexture.prototype.createView;
    GPUTexture.prototype.createView = function () {
      var v = _createView.apply(this, arguments);
      try { viewTex.set(v, idOf(this, 't')); } catch (e) {}
      return v;
    };
    var _createRenderPipeline = GPUDevice.prototype.createRenderPipeline;
    GPUDevice.prototype.createRenderPipeline = function (d) {
      var p = _createRenderPipeline.call(this, d);
      try {
        dev = this;
        pipeInfo[idOf(p, 'p')] = {
          label: d.label || '',
          vsm: d.vertex && d.vertex.module ? idOf(d.vertex.module, 's') : null,
          fsm: d.fragment && d.fragment.module ? idOf(d.fragment.module, 's') : null,
          topo: d.primitive && d.primitive.topology, cull: d.primitive && d.primitive.cullMode,
          ff: d.primitive && d.primitive.frontFace,
          ds: d.depthStencil ? { fmt: d.depthStencil.format, cmp: d.depthStencil.depthCompare,
                                 w: d.depthStencil.depthWriteEnabled } : null,
          targets: ((d.fragment && d.fragment.targets) || []).map(function (t) {
            return t ? { fmt: t.format, wm: t.writeMask === undefined ? 0xF : t.writeMask,
                         blend: t.blend ? { c: t.blend.color, a: t.blend.alpha } : null } : null; })
        };
      } catch (e) {}
      return p;
    };
    var _createBindGroup = GPUDevice.prototype.createBindGroup;
    GPUDevice.prototype.createBindGroup = function (d) {
      var g = _createBindGroup.call(this, d);
      try {
        bgInfo[idOf(g, 'g')] = (d.entries || []).map(function (en) {
          var r = en.resource;
          if (r && r.buffer) return { b: en.binding, buf: idOf(r.buffer, 'b'), off: r.offset || 0, sz: r.size || 0 };
          if (r && viewTex.has(r)) return { b: en.binding, tex: viewTex.get(r) };
          return { b: en.binding, o: 1 };
        });
      } catch (e) {}
      return g;
    };
    var _writeBuffer = GPUQueue.prototype.writeBuffer;
    GPUQueue.prototype.writeBuffer = function (buf, off, data, dataOff, size) {
      try {
        var bid = idOf(buf, 'b');
        var ring = bufWrites[bid] || (bufWrites[bid] = []);
        var isAB = data instanceof ArrayBuffer;
        var u8v = isAB ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        var elem = isAB ? 1 : (data.BYTES_PER_ELEMENT || 1);
        var srcOff = dataOff !== undefined ? dataOff * elem : 0;
        var len = size !== undefined ? size * elem : u8v.byteLength - srcOff;
        var e = { off: off >>> 0, size: len >>> 0, seq: ++seq };
        if (len <= 8192) e.bytes = u8v.slice(srcOff, srcOff + len);
        ring.push(e); if (ring.length > 256) ring.shift();
      } catch (err) {}
      return _writeBuffer.apply(this, arguments);
    };
    var _beginRenderPass = GPUCommandEncoder.prototype.beginRenderPass;
    GPUCommandEncoder.prototype.beginRenderPass = function (d) {
      var useQ = false;
      try {
        // occlusion instrumentation: inject a query set into the EFB pass (the one
        // with a depth attachment) so each draw can be bracketed with begin/end
        // OcclusionQuery — the count answers "did ANY sample pass the per-fragment
        // tests" per draw.
        if (cap && d && d.depthStencilAttachment && dev) {
          if (!qs) qs = dev.createQuerySet({ type: 'occlusion', count: QMAX });
          d.occlusionQuerySet = qs;
          useQ = true;
          qEncoders.add(this);
        }
      } catch (e) { useQ = false; }
      var pe = _beginRenderPass.call(this, d);
      try {
        passState.set(pe, { pipe: null, vp: null, sc: null, bgs: [], vb: [], ib: null, q: useQ });
        if (cap) {
          cap.passes.push({
            atts: (d.colorAttachments || []).map(function (a) {
              return a ? { tex: viewTex.get(a.view) || '?', load: a.loadOp, store: a.storeOp,
                clear: a.clearValue ? [rf(a.clearValue.r), rf(a.clearValue.g), rf(a.clearValue.b), rf(a.clearValue.a)] : null } : null; }),
            depth: d.depthStencilAttachment ? { tex: viewTex.get(d.depthStencilAttachment.view) || '?',
              load: d.depthStencilAttachment.depthLoadOp, clear: d.depthStencilAttachment.depthClearValue,
              store: d.depthStencilAttachment.depthStoreOp } : null,
            draws: 0 });
        }
      } catch (e) {}
      return pe;
    };
    function wrapPE(name, fn) {
      var orig = GPURenderPassEncoder.prototype[name];
      if (!orig) return;
      GPURenderPassEncoder.prototype[name] = function () {
        try { fn(this, arguments); } catch (e) {}
        return orig.apply(this, arguments);
      };
    }
    wrapPE('setPipeline', function (pe, a) { var s = passState.get(pe); if (s) s.pipe = idOf(a[0], 'p'); });
    wrapPE('setViewport', function (pe, a) { var s = passState.get(pe); if (s) s.vp = [rf(a[0]), rf(a[1]), rf(a[2]), rf(a[3]), rf(a[4]), rf(a[5])]; });
    wrapPE('setScissorRect', function (pe, a) { var s = passState.get(pe); if (s) s.sc = [a[0], a[1], a[2], a[3]]; });
    wrapPE('setBindGroup', function (pe, a) {
      var s = passState.get(pe); if (!s) return;
      var dyn = null;
      if (a[2]) {
        if (typeof a[3] === 'number') dyn = Array.prototype.slice.call(a[2], a[3], a[3] + a[4]);
        else dyn = Array.prototype.slice.call(a[2]);
      }
      s.bgs[a[0]] = { g: idOf(a[1], 'g'), dyn: dyn };
    });
    wrapPE('setVertexBuffer', function (pe, a) { var s = passState.get(pe); if (s) s.vb[a[0]] = { buf: idOf(a[1], 'b'), off: a[2] || 0 }; });
    wrapPE('setIndexBuffer', function (pe, a) { var s = passState.get(pe); if (s) s.ib = { buf: idOf(a[0], 'b'), fmt: a[1], off: a[2] || 0 }; });
    function uniSnap(s) {
      var out = {};
      function decode(w) {
        var d = new DataView(w.bytes.buffer, w.bytes.byteOffset, w.bytes.byteLength);
        if (w.size >= 4000 && w.size <= 4200 && !out.vs) {         // VertexShaderConstants
          var vs = { sz: w.size, seq: w.seq, m: w.m,
                     hdr: [d.getUint32(0, true), d.getUint32(4, true), d.getUint32(8, true)],
                     pnm: [], proj: [], cpc: [], vpc: [] };
          for (var i = 0; i < 24; i++) vs.pnm.push(rf(d.getFloat32(32 + 4 * i, true)));
          for (i = 0; i < 16; i++) vs.proj.push(rf(d.getFloat32(128 + 4 * i, true)));
          for (i = 0; i < 4; i++) vs.cpc.push(rf(d.getFloat32(3840 + 4 * i, true)));   // pixelcentercorrection
          for (i = 0; i < 2; i++) vs.vpc.push(rf(d.getFloat32(3856 + 4 * i, true)));   // viewport .xy
          out.vs = vs;
        } else if (w.size >= 1500 && w.size <= 1600 && !out.ps) {  // PixelShaderConstants
          var ps = { sz: w.size, seq: w.seq, m: w.m,
                     alpha: [d.getInt32(128, true), d.getInt32(132, true), d.getInt32(136, true), d.getInt32(140, true)],
                     cols: [], ctl: [], blend: [] };
          for (var j = 0; j < 32; j++) ps.cols.push(d.getInt32(4 * j, true));   // colors[4]+kcolors[4] int4s
          for (j = 0; j < 10; j++) ps.ctl.push(d.getUint32(552 + 4 * j, true));
          for (j = 0; j < 9; j++) ps.blend.push(d.getUint32(1488 + 4 * j, true));
          out.ps = ps;
        }
      }
      // exact match: newest write whose offset equals a bound dynamic offset (or static entry offset)
      for (var gi = 0; gi < s.bgs.length; gi++) {
        var bg = s.bgs[gi]; if (!bg) continue;
        var ents = bgInfo[bg.g] || [], di = 0;
        for (var ei = 0; ei < ents.length; ei++) {
          var en = ents[ei]; if (en.buf === undefined) continue;
          var target = bg.dyn && di < bg.dyn.length ? bg.dyn[di++] : en.off;
          var ring = bufWrites[en.buf] || [];
          for (var ri = ring.length - 1; ri >= 0; ri--) {
            var w = ring[ri];
            if (!w.bytes || w.off !== target) continue;
            w.m = 'exact'; decode(w); break;
          }
        }
      }
      // fallback: newest size-matching write anywhere (provenance-marked)
      if (!out.vs || !out.ps) {
        var best = { vs: null, ps: null };
        for (var bid in bufWrites) {
          var r2 = bufWrites[bid];
          for (var k = r2.length - 1; k >= 0; k--) {
            var w2 = r2[k]; if (!w2.bytes) continue;
            if (w2.size >= 4000 && w2.size <= 4200 && (!best.vs || w2.seq > best.vs.seq)) best.vs = w2;
            if (w2.size >= 1500 && w2.size <= 1600 && (!best.ps || w2.seq > best.ps.seq)) best.ps = w2;
          }
        }
        if (!out.vs && best.vs) { best.vs.m = 'latest'; decode(best.vs); }
        if (!out.ps && best.ps) { best.ps.m = 'latest'; decode(best.ps); }
      }
      return out;
    }
    function texListOf(s) {
      var texs = [];
      for (var gi = 0; gi < s.bgs.length; gi++) {
        var bg = s.bgs[gi]; if (!bg) continue;
        var ents = bgInfo[bg.g] || [];
        for (var ei = 0; ei < ents.length; ei++) {
          var en = ents[ei];
          if (en.tex) { var ti = texInfo[en.tex];
            texs.push(en.tex + (ti ? ':' + ti.w + 'x' + ti.h + ':' + ti.f : '')); }
        }
      }
      return texs;
    }
    function drawRec(pe, kind, a) {
      if (!cap || cap.draws.length >= 2500) return null;
      var s = passState.get(pe) || { bgs: [], vb: [] };
      var pass = cap.passes[cap.passes.length - 1];
      if (pass) pass.draws++;
      var rec = { n: cap.draws.length, pass: cap.passes.length - 1, k: kind,
        args: Array.prototype.slice.call(a, 0, 5),
        pipe: s.pipe, vp: s.vp, sc: s.sc,
        bgs: s.bgs.map(function (b) { return b ? { g: b.g, dyn: b.dyn } : null; }),
        ib: s.ib, vb: s.vb, tex: texListOf(s), uni: uniSnap(s) };
      cap.draws.push(rec);
      return rec;
    }
    function wrapDraw(name, kind) {
      var orig = GPURenderPassEncoder.prototype[name];
      if (!orig) return;
      GPURenderPassEncoder.prototype[name] = function () {
        var rec = null, s = null, q = false;
        try {
          rec = drawRec(this, kind, arguments);
          s = passState.get(this);
          q = !!(rec && cap && s && s.q && cap.qn < QMAX);
          if (q) { this.beginOcclusionQuery(cap.qn); rec.q = cap.qn++; }
        } catch (e) { q = false; }
        var r = orig.apply(this, arguments);
        try { if (q) this.endOcclusionQuery(); } catch (e) {}
        return r;
      };
    }
    wrapDraw('draw', 'd');
    wrapDraw('drawIndexed', 'di');
    var _finish = GPUCommandEncoder.prototype.finish;
    GPUCommandEncoder.prototype.finish = function () {
      try {
        // encode the query resolve+readback copy before this encoder's finish, so it
        // rides the same submit as the instrumented pass(es)
        if (cap && cap.qn > 0 && qEncoders.has(this) && dev) {
          var n = cap.qn;
          if (!cap.resolveBuf || cap.resolveN < n) {
            cap.resolveBuf = dev.createBuffer({ size: QMAX * 8, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
            cap.resolveN = QMAX;
          }
          this.resolveQuerySet(qs, 0, n, cap.resolveBuf, 0);
          var rb = dev.createBuffer({ size: n * 8, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
          this.copyBufferToBuffer(cap.resolveBuf, 0, rb, 0, n * 8);
          cap.readBuf = rb; cap.readN = n;
        }
      } catch (e) { try { postMessage({ cmd: 'print', txt: '[wgpuCap] resolve err: ' + (e && e.message) }); } catch (_) {} }
      return _finish.apply(this, arguments);
    };
    function dumpCap(c) {
      var used = {};
      c.draws.forEach(function (dd) { if (dd.pipe && !used[dd.pipe]) used[dd.pipe] = pipeInfo[dd.pipe]; });
      // shader sources: fragment shaders of pipelines used by PERSP-ish draws first, cap 12 modules
      var shOut = {}, shN = 0;
      function wantShader(sid) { if (sid && shN < 12 && !shOut[sid] && shaders[sid]) { shOut[sid] = shaders[sid]; shN++; } }
      c.draws.forEach(function (dd) {
        var p = dd.pipe && pipeInfo[dd.pipe];
        if (p && dd.uni && dd.uni.vs && Math.abs(dd.uni.vs.proj[14] + 1) < 1e-3) { wantShader(p.fsm); wantShader(p.vsm); }
      });
      c.draws.forEach(function (dd) { var p = dd.pipe && pipeInfo[dd.pipe]; if (p) wantShader(p.fsm); });
      var s = JSON.stringify({ tag: c.tag, submits: c.submits, passes: c.passes,
                               pipes: used, texs: texInfo, shaders: shOut, draws: c.draws });
      var CH = 3000, N = Math.ceil(s.length / CH);
      postMessage({ cmd: 'print', txt: '[wgpuCap] BEGIN ' + c.tag + ' bytes=' + s.length + ' chunks=' + N });
      for (var i = 0; i < N; i++)
        postMessage({ cmd: 'print', txt: '[wgpuCapJ]' + i + '/' + N + '|' + s.slice(i * CH, (i + 1) * CH) });
      postMessage({ cmd: 'print', txt: '[wgpuCap] END ' + c.tag });
    }
    function finalize(c) {
      // attach occlusion counts (async map), then dump
      if (c.readBuf) {
        var rb = c.readBuf, n = c.readN;
        var done = false;
        rb.mapAsync(GPUMapMode.READ).then(function () {
          if (done) return; done = true;
          try {
            var counts = new BigUint64Array(rb.getMappedRange().slice(0));
            rb.unmap();
            c.draws.forEach(function (dd) { if (dd.q !== undefined && dd.q < n) dd.frag = Number(counts[dd.q]); });
          } catch (e) { try { postMessage({ cmd: 'print', txt: '[wgpuCap] map read err: ' + (e && e.message) }); } catch (_) {} }
          dumpCap(c);
        }, function (err) {
          if (done) return; done = true;
          try { postMessage({ cmd: 'print', txt: '[wgpuCap] mapAsync FAIL: ' + err }); } catch (_) {}
          dumpCap(c);
        });
        setTimeout(function () { if (!done) { done = true; postMessage({ cmd: 'print', txt: '[wgpuCap] mapAsync TIMEOUT — dumping without counts' }); dumpCap(c); } }, 8000);
      } else dumpCap(c);
    }
    var _submit = GPUQueue.prototype.submit;
    GPUQueue.prototype.submit = function () {
      var r = _submit.apply(this, arguments);
      try {
        if (cap) {
          cap.submits++;
          if ((cap.submits >= cap.wantSubmits && cap.draws.length > 0) || cap.draws.length >= 2500) {
            var c = cap; cap = null;
            finalize(c);
          }
        }
      } catch (e) {}
      return r;
    };
    self.addEventListener('message', function (ev) {
      var d = ev && ev.data;
      if (d && d.cmd === 'wgpuCap') {
        cap = { tag: d.tag || 'cap', draws: [], passes: [], submits: 0, wantSubmits: d.submits || 2, qn: 0 };
        postMessage({ cmd: 'print', txt: '[wgpuCap] armed tag=' + cap.tag + ' wantSubmits=' + cap.wantSubmits + ' occl=' + (dev ? 'ready' : 'NO-DEV') });
      }
    });
    postMessage({ cmd: 'print', txt: '[wgpuCap] hooks installed (realm=' + (self.name || 'level-1') + ')' });
  } catch (e) {
    try { postMessage({ cmd: 'print', txt: '[wgpuCap] install FAILED: ' + (e && e.message) }); } catch (_) {}
  }
})();
// ===== [wgpuCap] END TEMP INSTRUMENTATION ===============================================

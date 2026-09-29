// gcgate.js — SCRATCH HARNESS ONLY (overlay tree, never shipped). Turns every render-pass DRAW into a
// no-op unless the gate is open, so the software GPU only rasterizes the frames the harness picks.
// Command buffers, copies, clears and queue writes all still execute (texture/buffer contents stay current).
(function () {
  if (typeof GPURenderPassEncoder === 'undefined' || self.__gcgate) return;
  self.__gcgate = { open: false, passed: 0, dropped: 0 };
  const ptag = new WeakMap(); let curP = '', curVp = '', trace = [];
  const sp = GPURenderPassEncoder.prototype.setPipeline;
  GPURenderPassEncoder.prototype.setPipeline = function (p) { curP = ptag.get(p) || '?'; return sp.call(this, p); };
  const sv = GPURenderPassEncoder.prototype.setViewport;
  GPURenderPassEncoder.prototype.setViewport = function (x, y, w, h, zn, zf) { curVp = [x, y, w, h, zn, zf].map(v => +(+v).toPrecision(8)).join(','); return sv.call(this, x, y, w, h, zn, zf); };
  const CFG = {}; // @@CFG@@
  const sub = GPUQueue.prototype.submit;
  // uniform shadow: every writeBuffer into an 8 MB buffer (the uniform ring) is mirrored here
  const UB = 8 * 1024 * 1024; let ushadow = null, ubuf = null;
  const wb = GPUQueue.prototype.writeBuffer;
  GPUQueue.prototype.writeBuffer = function (b, off, data, doff, size) {
    if (CFG.udump && b.size === UB) { if (!ushadow) { ushadow = new Uint8Array(UB); ubuf = b; }
      if (b === ubuf) { const src = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset + (doff || 0) * (data.BYTES_PER_ELEMENT || 1), size !== undefined ? size * (data.BYTES_PER_ELEMENT || 1) : data.byteLength - (doff || 0) * (data.BYTES_PER_ELEMENT || 1)) : new Uint8Array(data, doff || 0, size); ushadow.set(src, off); } }
    return wb.call(this, b, off, data, doff, size);
  };
  let curDyn = null;
  const sbg = GPURenderPassEncoder.prototype.setBindGroup;
  GPURenderPassEncoder.prototype.setBindGroup = function (...args) {
    const [i, , dyn, a, b] = args;
    if (i === 0 && dyn && typeof dyn !== 'number' && dyn.length !== undefined) curDyn = Array.from(a !== undefined ? dyn.slice(a, a + b) : dyn);
    return sbg.apply(this, args);
  };
  let udraws = [];
  function decode(ps, vs) {
    const P = new DataView(ushadow.buffer, ps), V = new DataView(ushadow.buffer, vs);
    // PixelShaderConstants: colors16*4=64,k64,alpha16,texdims128,zbias32,indtexscale32,indtexmtx96,fogcolor16,fogi16,fogf16,fogrange48,zslope16,efbscale8 => genmode at 536
    const gm = P.getUint32(552, true);
    const ntg = gm & 15, ncc = (gm >> 4) & 7, nts = ((gm >> 10) & 15) + 1, nind = (gm >> 16) & 7;
    // VS: components@0, dualTex@4, numColorChans@8 ... xfmem_pack1 at offset: 16+16+96+64+64+640+384+1024+512+1024+16+16 = 3872
    const comp = V.getUint32(0, true); const tg = [];
    for (let i = 0; i < ntg; i++) { const m = V.getUint32(3872 + i * 16, true); tg.push(((m >> 4) & 7) + ':' + ((m >> 7) & 31) + (m & 2 ? 'q' : '')); }
    const chans = []; for (let c = 0; c < 2; c++) chans.push((V.getUint32(3872 + c * 16 + 8, true) >>> 0).toString(16) + '/' + (V.getUint32(3872 + c * 16 + 12, true) >>> 0).toString(16));
    const tev = []; for (let i = 0; i < nts; i++) { const cc = P.getUint32(592 + i * 16, true) >>> 0, ac = P.getUint32(596 + i * 16, true) >>> 0, ind = P.getUint32(600 + i * 16, true) >>> 0; tev.push(cc.toString(16) + ',' + ac.toString(16) + (ind ? ',i' + ind.toString(16) : '')); }
    return 'tg=' + ntg + '[' + tg.join(' ') + '] cc=' + ncc + '[' + chans.join(' ') + '] ts=' + nts + ' ind=' + nind + ' comp=' + comp.toString(16) + ' tev=' + tev.join(' | ');
  }
  const crp = GPUDevice.prototype.createRenderPipeline;
  GPUDevice.prototype.createRenderPipeline = function (d) {
    if (d && d.fragment && d.fragment.targets && d.fragment.targets.length === 1 && d.depthStencil) {
      if (CFG.depthAlways) d.depthStencil = Object.assign({}, d.depthStencil, { depthCompare: 'always' });
      if (CFG.cullNone) d.primitive = Object.assign({}, d.primitive, { cullMode: 'none' });
      if (CFG.blendOff) d.fragment = Object.assign({}, d.fragment, { targets: [Object.assign({}, d.fragment.targets[0], { blend: undefined })] });
      if (CFG.writeAll) d.fragment = Object.assign({}, d.fragment, { targets: [Object.assign({}, d.fragment.targets[0], { writeMask: 15 })] });
    }
    const pl = crp.call(this, d);
    try { const ds = d.depthStencil || {}, pr = d.primitive || {}, t = (d.fragment && d.fragment.targets && d.fragment.targets[0]) || {};
      ptag.set(pl, (ds.depthCompare || '-') + (ds.depthWriteEnabled ? '/W' : '/nw') + '/' + (pr.cullMode || 'none') + '/' + (pr.topology || '') + (t.blend ? '/B' + t.blend.color.srcFactor + '-' + t.blend.color.dstFactor : '/noB') + '/m' + t.writeMask); } catch (e) {}
    return pl;
  };
  const csm = GPUDevice.prototype.createShaderModule;
  GPUDevice.prototype.createShaderModule = function (d) {
    if (CFG.noDiscard && d && typeof d.code === 'string' && d.code.includes('@fragment') && d.code.includes('discard')) {
      const n = (d.code.match(/discard;/g) || []).length; d = Object.assign({}, d, { code: d.code.replace(/discard;/g, '{}') });
      postMessage({ cmd: 'print', txt: '[gcgate] stripped ' + n + ' discard(s) from a fragment module' });
    }
    return csm.call(this, d);
  };
  for (const fn of ['draw', 'drawIndexed', 'drawIndirect', 'drawIndexedIndirect']) {
    const orig = GPURenderPassEncoder.prototype[fn];
    if (!orig) continue;
    GPURenderPassEncoder.prototype[fn] = function (...a) {
      if (self.__gcgate.open) { self.__gcgate.passed++; if (fn === 'drawIndexed' || fn === 'draw') trace.push(curP + ' vp=' + curVp + ' n=' + a[0]);
        if (CFG.udump && fn === 'drawIndexed' && curDyn && curDyn.length === 2) udraws.push([curDyn[0], curDyn[1], a[0]]); return orig.apply(this, a); }
      self.__gcgate.dropped++;
    };
  }
  // render-target dump: every color attachment used while the gate is open is copied out when it closes
  const v2t = new WeakMap();
  const cv = GPUTexture.prototype.createView;
  GPUTexture.prototype.createView = function (...a) { const v = cv.apply(this, a); v2t.set(v, this); return v; };
  let rts = [], lastDepth = null, depthSnaps = [];
  const brp = GPUCommandEncoder.prototype.beginRenderPass;
  GPUCommandEncoder.prototype.beginRenderPass = function (desc) {
    if (self.__gcgate.open && desc && desc.colorAttachments) for (const ca of desc.colorAttachments) {
      const t = ca && v2t.get(ca.view); if (t && !rts.includes(t)) rts.push(t); }
    if (self.__gcgate.open && desc && desc.depthStencilAttachment) { const t = v2t.get(desc.depthStencilAttachment.view); if (t) lastDepth = t; }
    if (self.__gcgate.open && desc && !desc.depthStencilAttachment && lastDepth && dev && depthSnaps.length < 4) {
      // a depth-less pass (the EFB->XFB blit) starts: snapshot the EFB depth BEFORE the copy's clear
      const snap = dev.createTexture({ size: [lastDepth.width, lastDepth.height], format: lastDepth.format, usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC });
      this.copyTextureToTexture({ texture: lastDepth }, { texture: snap }, [lastDepth.width, lastDepth.height]);
      depthSnaps.push(snap); rts.push(snap);
    }
    return brp.call(this, desc);
  };
  let dev = null, dumpSeq = 0;
  async function dump(list) {
    for (const t of list.slice(-8).reverse()) {
      postMessage({ cmd: 'print', txt: '[gcgate] dumping ' + t.width + 'x' + t.height + ' ' + t.format });
      const isD = t.format === 'depth32float';
      if (t.format !== 'rgba8unorm' && t.format !== 'bgra8unorm' && !isD) continue;
      const W = t.width, H = t.height, bpr = Math.ceil(W * 4 / 256) * 256;
      const b = dev.createBuffer({ size: bpr * H, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const e = dev.createCommandEncoder(); e.copyTextureToBuffer(isD ? { texture: t, aspect: 'depth-only' } : { texture: t }, { buffer: b, bytesPerRow: bpr }, [W, H]);
      sub.call(dev.queue, [e.finish()]);
      try { await b.mapAsync(GPUMapMode.READ); } catch (err) { postMessage({ cmd: 'print', txt: '[gcgate] map fail ' + t.format + ' u' + t.usage + ' ' + err }); continue; }
      const src = new Uint8Array(b.getMappedRange()); const px = new Uint8Array(W * H * 4);
      if (isD) { const f = new Float32Array(src.buffer, src.byteOffset, src.byteLength / 4); let mn = 1, mx = 0;
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const v = f[y * bpr / 4 + x]; if (v < mn) mn = v; if (v > mx) mx = v; }
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const v = f[y * bpr / 4 + x]; const g = mx > mn ? Math.round(255 * (v - mn) / (mx - mn)) : 0; const o = (y * W + x) * 4; px[o] = px[o + 1] = px[o + 2] = g; px[o + 3] = 255; }
        const pts = [[320, 40], [320, 200], [150, 250], [270, 170], [390, 180], [560, 280], [320, 420], [60, 330], [600, 100]];
        postMessage({ cmd: 'print', txt: '[gcgate] depth ' + W + 'x' + H + ' min=' + mn + ' max=' + mx + ' ' + pts.map(([x, y]) => '(' + x + ',' + y + ')=' + f[y * bpr / 4 + x].toPrecision(7)).join(' ') }); }
      else for (let y = 0; y < H; y++) px.set(src.subarray(y * bpr, y * bpr + W * 4), y * W * 4);
      b.unmap(); b.destroy();
      postMessage({ cmd: 'gcgateDump', seq: dumpSeq++, w: W, h: H, fmt: t.format, px }, [px.buffer]);
    }
  }
  const rd = GPUAdapter.prototype.requestDevice;
  let nerr = 0;
  GPUAdapter.prototype.requestDevice = async function (...a) {
    const d = await rd.apply(this, a); dev = d;
    d.addEventListener('uncapturederror', (e) => { if (nerr++ < 40) postMessage({ cmd: 'print', txt: '[gcgate] UNCAPTURED(' + (self.__gcgate.open ? 'open' : 'closed') + ') ' + String(e.error && e.error.message).slice(0, 600) }); });
    postMessage({ cmd: 'print', txt: '[gcgate] device hooked; features=' + [...d.features].join(',') });
    return d;
  };
  self.addEventListener('message', function (e) {
    const m = e.data;
    if (m && m.cmd === 'recompFrame' && typeof m.gate === 'boolean') {
      if (self.__gcgate.open && !m.gate) { postMessage({ cmd: 'print', txt: '[gcgate] CLOSE: rts=' + rts.map(t => t.width + 'x' + t.height + ':' + t.format + ':u' + t.usage).join(' ') + ' dev=' + !!dev });
        { const out = []; let prev = null, rep = 0; for (const t of trace) { if (t.replace(/ n=\d+$/, '') === prev) { rep++; continue; } if (prev !== null) out.push(prev + (rep > 1 ? ' x' + rep : '')); prev = t.replace(/ n=\d+$/, ''); rep = 1; } if (prev) out.push(prev + (rep > 1 ? ' x' + rep : ''));
          postMessage({ cmd: 'print', txt: '[gcgate] TRACE ' + trace.length + ' draws:\n' + out.join('\n') }); trace = []; }
        if (CFG.udump && ushadow) { const lines = udraws.map((d, i) => i + ' n=' + d[2] + ' ' + decode(d[0], d[1])); postMessage({ cmd: 'print', txt: '[gcgate] UDUMP TRACE ' + lines.length + '\n' + lines.join('\n') }); udraws = []; }
        if (dev && rts.length) { const l = rts; rts = []; dump(l).catch(err => postMessage({ cmd: 'print', txt: '[gcgate] dump ERR ' + err })); } }
      self.__gcgate.open = m.gate;
      if (m.gate) postMessage({ cmd: 'print', txt: '[gcgate] OPEN for frame ' + m.n + ' draws passed=' + self.__gcgate.passed + ' dropped=' + self.__gcgate.dropped });
    }
  });
})();

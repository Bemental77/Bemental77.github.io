// framegen_webgpu.js — [2026-08-20] cosmetic display-side frame interpolation on the MAIN thread.
// Motion-compensated interpolation (MCI): a coarse block-matching motion field between the two
// most-recent SIM frames is estimated in a WGSL compute pass, then both frames are warped toward
// the intermediate time and blended in a render pass. This removes most of the double-image
// ghosting that a plain linear blend (framegen=1) shows on motion. Uses the MAIN-thread browser
// WebGPU (navigator.gpu) — INDEPENDENT of the emulator's own worker-side WebGPU device — so it
// steals no cycles from the guest EmuThread. Renders to an offscreen WebGPU canvas that the caller
// drawImage()s onto the visible 2D canvas. DEFAULT OFF; enabled only via ?framegen=2 in gamecube.html.
//
// Honest limits: still cosmetic (sim rate unchanged), +~1 sim-frame latency, coarse 16px block
// motion (blocky warp on complex motion), and a literal 120 needs a 120Hz display. It is a
// prototype to judge, not a shipped feature. On any failure it throws and the caller falls back
// to the linear blend.

const BLOCK = 16;      // motion-estimation block size (px)
const RADIUS = 8;      // ± search radius (px) — captures typical board pan between 24fps frames
const STRIDE = 4;      // SAD sub-sample stride inside a block (speed; 4 => 16 taps/block)

const ME_WGSL = /* wgsl */`
struct MEUni { dims: vec2<u32>, block: u32, radius: u32, blocksX: u32, blocksY: u32, stride: u32, _p: u32 };
@group(0) @binding(0) var prevT: texture_2d<f32>;
@group(0) @binding(1) var curT:  texture_2d<f32>;
@group(0) @binding(2) var<storage, read_write> mvOut: array<vec2<f32>>;
@group(0) @binding(3) var<uniform> U: MEUni;
fn lum(c: vec4<f32>) -> f32 { return c.r + c.g + c.b; }
fn ld(t: texture_2d<f32>, x: i32, y: i32) -> vec4<f32> {
  let cx = clamp(x, 0, i32(U.dims.x) - 1);
  let cy = clamp(y, 0, i32(U.dims.y) - 1);
  return textureLoad(t, vec2<i32>(cx, cy), 0);
}
@compute @workgroup_size(8, 8, 1)
fn meMain(@builtin(global_invocation_id) gid: vec3<u32>) {
  let bx = gid.x; let by = gid.y;
  if (bx >= U.blocksX || by >= U.blocksY) { return; }
  let ox = i32(bx * U.block); let oy = i32(by * U.block);
  var best: f32 = 1e30; var bmv = vec2<f32>(0.0, 0.0);
  let r = i32(U.radius); let st = i32(U.stride); let bs = i32(U.block);
  for (var dy = -r; dy <= r; dy = dy + 1) {
    for (var dx = -r; dx <= r; dx = dx + 1) {
      var sad: f32 = 0.0;
      for (var yy = 0; yy < bs; yy = yy + st) {
        for (var xx = 0; xx < bs; xx = xx + st) {
          let a = lum(ld(prevT, ox + xx, oy + yy));
          let b = lum(ld(curT,  ox + xx + dx, oy + yy + dy));
          sad = sad + abs(a - b);
        }
      }
      // small bias toward zero motion to avoid spurious vectors in flat regions
      sad = sad + 0.02 * (abs(f32(dx)) + abs(f32(dy)));
      if (sad < best) { best = sad; bmv = vec2<f32>(f32(dx), f32(dy)); }
    }
  }
  mvOut[by * U.blocksX + bx] = bmv;   // displacement prev -> cur, in pixels
}`;

const INTERP_WGSL = /* wgsl */`
struct IUni { dims: vec2<f32>, block: f32, blocksX: f32, blocksY: f32, f: f32, _p0: f32, _p1: f32 };
@group(0) @binding(0) var prevT: texture_2d<f32>;
@group(0) @binding(1) var curT:  texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<storage, read> mvIn: array<vec2<f32>>;
@group(0) @binding(4) var<uniform> U: IUni;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  var p = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  return vec4<f32>(p[i], 0.0, 1.0);
}
@fragment fn fs(@builtin(position) fc: vec4<f32>) -> @location(0) vec4<f32> {
  let px = fc.xy;                                  // pixel coords, origin top-left
  let bx = min(u32(px.x / U.block), u32(U.blocksX) - 1u);
  let by = min(u32(px.y / U.block), u32(U.blocksY) - 1u);
  let m = mvIn[by * u32(U.blocksX) + bx];          // prev -> cur displacement
  let f = U.f;
  let uvP = (px - m * f) / U.dims;                 // prev warped forward by f
  let uvC = (px + m * (1.0 - f)) / U.dims;         // cur warped backward by (1-f)
  let a = textureSampleLevel(prevT, samp, uvP, 0.0);
  let b = textureSampleLevel(curT,  samp, uvC, 0.0);
  return vec4<f32>(mix(a.rgb, b.rgb, f), 1.0);
}`;

export async function initFrameGenWebGPU() {
  if (!navigator.gpu) throw new Error('framegen: navigator.gpu unavailable');
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('framegen: no WebGPU adapter');
  const device = await adapter.requestDevice();
  if (!device) throw new Error('framegen: no WebGPU device');
  device.addEventListener?.('uncapturederror', (e) => console.warn('[framegen] wgpu error:', e.error && e.error.message));

  const off = document.createElement('canvas');
  const ctx = off.getContext('webgpu');
  if (!ctx) throw new Error('framegen: no webgpu canvas context');
  const format = navigator.gpu.getPreferredCanvasFormat();
  ctx.configure({ device, format, alphaMode: 'opaque' });

  const mePipe = device.createComputePipeline({
    layout: 'auto',
    compute: { module: device.createShaderModule({ code: ME_WGSL }), entryPoint: 'meMain' },
  });
  const iModule = device.createShaderModule({ code: INTERP_WGSL });
  const iPipe = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module: iModule, entryPoint: 'vs' },
    fragment: { module: iModule, entryPoint: 'fs', targets: [{ format }] },
    primitive: { topology: 'triangle-list' },
  });
  const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
  const meUni = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const iUni  = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

  let W = 0, H = 0, blocksX = 0, blocksY = 0;
  let prevTex = null, curTex = null, mvBuf = null, meBG = null, iBG = null;

  function ensureSize(w, h) {
    if (w === W && h === H && prevTex) return;
    W = w; H = h; off.width = w; off.height = h;
    blocksX = Math.ceil(w / BLOCK); blocksY = Math.ceil(h / BLOCK);
    prevTex && prevTex.destroy(); curTex && curTex.destroy(); mvBuf && mvBuf.destroy();
    const texUsage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST;
    prevTex = device.createTexture({ size: [w, h], format: 'rgba8unorm', usage: texUsage });
    curTex  = device.createTexture({ size: [w, h], format: 'rgba8unorm', usage: texUsage });
    mvBuf   = device.createBuffer({ size: Math.max(16, blocksX * blocksY * 8), usage: GPUBufferUsage.STORAGE });
    meBG = device.createBindGroup({ layout: mePipe.getBindGroupLayout(0), entries: [
      { binding: 0, resource: prevTex.createView() },
      { binding: 1, resource: curTex.createView() },
      { binding: 2, resource: { buffer: mvBuf } },
      { binding: 3, resource: { buffer: meUni } },
    ]});
    iBG = device.createBindGroup({ layout: iPipe.getBindGroupLayout(0), entries: [
      { binding: 0, resource: prevTex.createView() },
      { binding: 1, resource: curTex.createView() },
      { binding: 2, resource: sampler },
      { binding: 3, resource: { buffer: mvBuf } },
      { binding: 4, resource: { buffer: iUni } },
    ]});
    device.queue.writeBuffer(meUni, 0, new Uint32Array([w, h, BLOCK, RADIUS, blocksX, blocksY, STRIDE, 0]));
  }

  function upload(tex, data, w, h) {
    // data: Uint8ClampedArray/Uint8Array of w*h*4 rgba bytes
    const src = (data instanceof Uint8Array) ? data : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    device.queue.writeTexture({ texture: tex }, src, { bytesPerRow: w * 4, rowsPerImage: h }, { width: w, height: h });
  }

  let haveFrame = false;
  // update() — upload a new prev/cur pair and (re)compute the motion field. Call ONCE per new
  // SIM frame (~sim rate), NOT per display tick. This is the expensive part (block-matching ME +
  // two texture uploads); running it per-frame instead of per-tick is the key to not stealing GPU
  // from the emulator when the display rate (e.g. 120) far exceeds the sim rate (e.g. 18).
  function update(prevData, curData, w, h) {
    ensureSize(w, h);
    upload(prevTex, prevData, w, h);
    upload(curTex, curData, w, h);
    const enc = device.createCommandEncoder();
    const cp = enc.beginComputePass();
    cp.setPipeline(mePipe); cp.setBindGroup(0, meBG);
    cp.dispatchWorkgroups(Math.ceil(blocksX / 8), Math.ceil(blocksY / 8), 1);
    cp.end();
    device.queue.submit([enc.finish()]);
    haveFrame = true;
  }
  // present(f) — warp+blend the cached frames at fraction f in [0,1] (0=prev, 1=cur) using the
  // cached motion field. Cheap (one fullscreen render); call every display tick. Returns the
  // offscreen canvas to drawImage() onto the visible 2D canvas, or null if no frame yet.
  function present(f) {
    if (!haveFrame) return null;
    device.queue.writeBuffer(iUni, 0, new Float32Array([W, H, BLOCK, blocksX, blocksY, Math.min(1, Math.max(0, f)), 0, 0]));
    const enc = device.createCommandEncoder();
    const rp = enc.beginRenderPass({ colorAttachments: [{ view: ctx.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }] });
    rp.setPipeline(iPipe); rp.setBindGroup(0, iBG); rp.draw(3);
    rp.end();
    device.queue.submit([enc.finish()]);
    return off;
  }
  return {
    canvas: off,
    update,
    present,
    // Combined one-shot (upload+ME+render) — used by the functional test.
    render(prevData, curData, w, h, f) { update(prevData, curData, w, h); return present(f); },
  };
}

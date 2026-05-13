// GPU worker — runs the WebGPU paint path on its own thread via
// OffscreenCanvas. Frees the main thread of per-frame paint work.
//
// Lifecycle:
//   main -> {cmd:'init', canvas: OffscreenCanvas} (transferred)
//   main -> {cmd:'frame', pixels: ArrayBuffer, w, h, pitch, pp: {...}}  (pixels transferred)
//   main -> {cmd:'pp', ...}             (update post-processing settings)
//   worker -> {cmd:'ready'} once WebGPU device is acquired
//   worker -> {cmd:'init-failed', reason} if WebGPU unavailable
//   worker -> {cmd:'stats', framesPainted, framesDropped, lastPaintMs} periodically
//
// Render pipeline (richer than a plain blit):
//   - texture: bgra8unorm, sized to source XFB (re-created on resize)
//   - uber-shader: fullscreen quad with @builtin(vertex_index) + UBO of
//     post-processing params (aspect mode, scale mode, gamma, filter)
//   - sampler: nearest OR linear depending on filter setting
//   - viewport: computed from canvas + source aspect to letterbox/pillarbox

let device = null;
let gpuCanvas = null;
let ctx = null;
let format = null;
let pipelineLinear = null;
let pipelineNearest = null;
let samplerLinear = null;
let samplerNearest = null;
let bgLayout = null;
let pplLayout = null;
let texture = null;
let textureView = null;
let texW = 0, texH = 0;
let bindGroupLinear = null;
let bindGroupNearest = null;
let ubo = null;
const UBO_BYTES = 32;
const uboCpu = new Float32Array(UBO_BYTES / 4);

let framesPainted = 0;
let framesDropped = 0;
let lastPaintMs = 0;
let lastStatsTime = 0;

const pp = {
  aspect: 'source',     // 'source' | '4:3' | '16:9' | 'stretch'
  scale: 'fit',         // 'fit' | 'integer' | 'stretch'
  filter: 'linear',     // 'linear' | 'nearest'
  gamma: 1.0,           // 1.0 = passthrough
  brightness: 0.0,      // additive
  saturation: 1.0,      // 1.0 = passthrough
};

const SHADER = `
struct PP {
  // .x = gamma, .y = brightness, .z = saturation, .w = unused
  params: vec4<f32>,
  // .xy = scale (rect within clip space), .zw = offset
  rect: vec4<f32>,
};
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var tex: texture_2d<f32>;
@group(0) @binding(2) var<uniform> pp: PP;

struct VSOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32>, };

@vertex fn vs(@builtin(vertex_index) i: u32) -> VSOut {
  var p = array<vec2<f32>, 6>(
    vec2(-1.0, -1.0), vec2( 1.0, -1.0), vec2(-1.0,  1.0),
    vec2(-1.0,  1.0), vec2( 1.0, -1.0), vec2( 1.0,  1.0));
  var uv = array<vec2<f32>, 6>(
    vec2(0.0, 1.0), vec2(1.0, 1.0), vec2(0.0, 0.0),
    vec2(0.0, 0.0), vec2(1.0, 1.0), vec2(1.0, 0.0));
  var o: VSOut;
  // Apply per-frame rect (scale * pos + offset). Letterbox/pillarbox.
  let scaled = p[i] * pp.rect.xy + pp.rect.zw;
  o.pos = vec4(scaled, 0.0, 1.0);
  o.uv = uv[i];
  return o;
}

@fragment fn fs(in: VSOut) -> @location(0) vec4<f32> {
  let s = textureSample(tex, samp, in.uv);
  // Brightness add, then gamma, then saturation.
  var c = s.rgb + vec3<f32>(pp.params.y);
  let g = pp.params.x;
  if (g != 1.0) {
    c = pow(max(c, vec3<f32>(0.0)), vec3<f32>(1.0 / g));
  }
  let lum = dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
  c = mix(vec3<f32>(lum), c, pp.params.z);
  return vec4<f32>(c, 1.0);
}
`;

// Render mode within the worker. Decided at init() time. WebGPU is the
// preferred path; if the worker doesn't have navigator.gpu (or device
// acquisition fails), fall back to OffscreenCanvas 2D context. Either
// way the main thread stays out of the paint loop.
let mode = 'init';   // 'webgpu' | '2d' | 'init'
let ctx2d = null;
let img2d = null;

async function init(canvas) {
  gpuCanvas = canvas;
  if ('gpu' in navigator) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) throw new Error('no WebGPU adapter');
      device = await adapter.requestDevice();
      ctx = canvas.getContext('webgpu');
      if (!ctx) throw new Error('webgpu context unavailable');
      format = navigator.gpu.getPreferredCanvasFormat();
      ctx.configure({ device, format, alphaMode: 'opaque' });
      const shader = device.createShaderModule({ code: SHADER });
      bgLayout = device.createBindGroupLayout({ entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ]});
      pplLayout = device.createPipelineLayout({ bindGroupLayouts: [bgLayout] });
      pipelineLinear = device.createRenderPipeline({
        layout: pplLayout,
        vertex: { module: shader, entryPoint: 'vs' },
        fragment: { module: shader, entryPoint: 'fs', targets: [{ format }] },
        primitive: { topology: 'triangle-list' },
      });
      pipelineNearest = pipelineLinear;
      samplerLinear = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
      samplerNearest = device.createSampler({ magFilter: 'nearest', minFilter: 'nearest' });
      ubo = device.createBuffer({ size: UBO_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      mode = 'webgpu';
      return;
    } catch (e) {
      // WebGPU init failed; fall through to 2D below.
      device = null; ctx = null;
    }
  }
  // 2D fallback inside the worker. Slower per-frame than WebGPU but still
  // off the main thread, so main-thread input/audio/UI aren't blocked.
  ctx2d = canvas.getContext('2d');
  if (!ctx2d) throw new Error('neither WebGPU nor 2D context available');
  mode = '2d';
}

function ensureTexture(w, h) {
  if (texture && texW === w && texH === h) return;
  if (texture) texture.destroy();
  texture = device.createTexture({
    size: { width: w, height: h, depthOrArrayLayers: 1 },
    format: 'bgra8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  textureView = texture.createView();
  texW = w; texH = h;
  bindGroupLinear = device.createBindGroup({ layout: bgLayout, entries: [
    { binding: 0, resource: samplerLinear },
    { binding: 1, resource: textureView },
    { binding: 2, resource: { buffer: ubo } },
  ]});
  bindGroupNearest = device.createBindGroup({ layout: bgLayout, entries: [
    { binding: 0, resource: samplerNearest },
    { binding: 1, resource: textureView },
    { binding: 2, resource: { buffer: ubo } },
  ]});
}

function computeRect(srcW, srcH, dstW, dstH) {
  // Returns {scaleX, scaleY, offX, offY} in clip space.
  // Defaults to "fit": preserve source aspect, letterbox/pillarbox to fill.
  let aspectSrc;
  switch (pp.aspect) {
    case '4:3':    aspectSrc = 4 / 3; break;
    case '16:9':   aspectSrc = 16 / 9; break;
    case 'stretch':aspectSrc = dstW / dstH; break;
    default:       aspectSrc = srcW / srcH;
  }
  const aspectDst = dstW / dstH;
  let scaleX = 1.0, scaleY = 1.0;
  if (pp.scale === 'stretch') {
    // No clipping; fill canvas regardless of aspect.
    scaleX = 1.0; scaleY = 1.0;
  } else if (pp.scale === 'integer') {
    // Largest integer scale that fits.
    const s = Math.max(1, Math.min(Math.floor(dstW / srcW), Math.floor(dstH / srcH)));
    scaleX = (srcW * s) / dstW;
    scaleY = (srcH * s) / dstH;
  } else {
    // 'fit' — letterbox or pillarbox.
    if (aspectSrc > aspectDst) {
      scaleX = 1.0;
      scaleY = aspectDst / aspectSrc;
    } else {
      scaleX = aspectSrc / aspectDst;
      scaleY = 1.0;
    }
  }
  return { scaleX, scaleY, offX: 0, offY: 0 };
}

function paint2D(pixelsBuf, w, h, pitch) {
  const t0 = performance.now();
  if (!img2d || img2d.width !== w || img2d.height !== h) {
    img2d = ctx2d.createImageData(w, h);
  }
  const dst = img2d.data;
  const src = new Uint8Array(pixelsBuf);
  const stride = pitch || w * 4;
  let di = 0;
  for (let y = 0; y < h; y++) {
    let so = y * stride;
    for (let x = 0; x < w; x++) {
      dst[di++] = src[so + 2];
      dst[di++] = src[so + 1];
      dst[di++] = src[so + 0];
      dst[di++] = 255;
      so += 4;
    }
  }
  ctx2d.putImageData(img2d, 0, 0);
  framesPainted++;
  lastPaintMs = performance.now() - t0;
}

function paint(pixelsBuf, w, h, pitch) {
  if (mode === '2d') { paint2D(pixelsBuf, w, h, pitch); return; }
  const t0 = performance.now();
  ensureTexture(w, h);
  const bytesPerRow = pitch || w * 4;
  device.queue.writeTexture(
    { texture },
    new Uint8Array(pixelsBuf),
    { offset: 0, bytesPerRow, rowsPerImage: h },
    { width: w, height: h, depthOrArrayLayers: 1 }
  );
  // Resize the canvas DRAW target to match its CSS size if the parent
  // resized it. OffscreenCanvas dimensions are independently set by the
  // page; the worker uses whatever the canvas reports.
  const cw = gpuCanvas.width, ch = gpuCanvas.height;
  const r = computeRect(w, h, cw, ch);
  uboCpu[0] = pp.gamma;
  uboCpu[1] = pp.brightness;
  uboCpu[2] = pp.saturation;
  uboCpu[3] = 0;
  uboCpu[4] = r.scaleX;
  uboCpu[5] = r.scaleY;
  uboCpu[6] = r.offX;
  uboCpu[7] = r.offY;
  device.queue.writeBuffer(ubo, 0, uboCpu);
  const enc = device.createCommandEncoder();
  const pass = enc.beginRenderPass({
    colorAttachments: [{
      view: ctx.getCurrentTexture().createView(),
      loadOp: 'clear', storeOp: 'store',
      clearValue: { r: 0, g: 0, b: 0, a: 1 },
    }],
  });
  pass.setPipeline(pipelineLinear);
  pass.setBindGroup(0, pp.filter === 'nearest' ? bindGroupNearest : bindGroupLinear);
  pass.draw(6);
  pass.end();
  device.queue.submit([enc.finish()]);
  framesPainted++;
  lastPaintMs = performance.now() - t0;
}

self.onmessage = async function (e) {
  const m = e.data;
  try {
    if (m.cmd === 'init') {
      await init(m.canvas);
      postMessage({ cmd: 'ready', mode });
      lastStatsTime = performance.now();
    } else if (m.cmd === 'frame') {
      if (mode === 'init') { framesDropped++; return; }
      paint(m.pixels, m.w, m.h, m.pitch);
      const now = performance.now();
      if (now - lastStatsTime > 1000) {
        postMessage({ cmd: 'stats', framesPainted, framesDropped, lastPaintMs });
        framesPainted = 0; framesDropped = 0; lastStatsTime = now;
      }
    } else if (m.cmd === 'pp') {
      // Update post-processing options live.
      if (typeof m.aspect === 'string')     pp.aspect = m.aspect;
      if (typeof m.scale === 'string')      pp.scale = m.scale;
      if (typeof m.filter === 'string')     pp.filter = m.filter;
      if (typeof m.gamma === 'number')      pp.gamma = m.gamma;
      if (typeof m.brightness === 'number') pp.brightness = m.brightness;
      if (typeof m.saturation === 'number') pp.saturation = m.saturation;
    } else if (m.cmd === 'resize') {
      // Canvas resize from main thread (CSS-driven). gpuCanvas.width/height
      // are read-write on the worker side via the transferred OffscreenCanvas.
      if (gpuCanvas && typeof m.w === 'number' && typeof m.h === 'number') {
        gpuCanvas.width = m.w;
        gpuCanvas.height = m.h;
      }
    }
  } catch (err) {
    postMessage({ cmd: 'init-failed', reason: String(err) });
  }
};

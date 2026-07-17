// run_pipeline_vk.cjs
//
// Vulkan-path WebGPU go/no-go driver. For each of the two assembled Vulkan
// ubershaders (dolphin_vk.frag.glsl, dolphin_vk.vert.glsl), runs the full chain:
//   1. glslang : Vulkan GLSL -> Vulkan SPIR-V  (@webgpu/glslang, sync factory)
//   2. naga    : SPIR-V -> WGSL                (naga in.spv out.wgsl)
//   3. naga    : WGSL validate                 (naga in.wgsl)
//
// Same @webgpu/glslang@0.0.15 sync-factory caveat as run_pipeline.cjs.
// naga (v29.0.3) invoked by full path.
//
// Run from repo root with system node 24:
//   node gamecube/wgsl/run_pipeline_vk.cjs

const { readFileSync, writeFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');
const glslangFactory = require('@webgpu/glslang');

const DIR = __dirname;
const NAGA = '/Users/caseybement/.cargo/bin/naga';

function runNaga(args) {
  try {
    const out = execFileSync(NAGA, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, out };
  } catch (e) {
    const stdout = e.stdout ? e.stdout.toString() : '';
    const stderr = e.stderr ? e.stderr.toString() : '';
    return { ok: false, out: stdout, err: (stderr || e.message || '').toString() };
  }
}

const glslang = glslangFactory();

const shaders = [
  { name: 'FRAGMENT', stage: 'fragment', src: 'dolphin_vk.frag.glsl', spv: 'dolphin_vk.frag.spv', wgsl: 'dolphin_vk.frag.wgsl' },
  { name: 'VERTEX',   stage: 'vertex',   src: 'dolphin_vk.vert.glsl', spv: 'dolphin_vk.vert.spv', wgsl: 'dolphin_vk.vert.wgsl' },
];

const results = [];

for (const s of shaders) {
  const srcPath = join(DIR, s.src);
  const spvPath = join(DIR, s.spv);
  const wgslPath = join(DIR, s.wgsl);
  const glslText = readFileSync(srcPath, 'utf8');

  const r = { name: s.name, glslChars: glslText.length };
  console.log(`\n================ ${s.name} (${s.stage}) ================`);
  console.log(`GLSL source: ${s.src}  (${glslText.length} chars)`);

  // --- Stage 1: glslang Vulkan GLSL -> Vulkan SPIR-V ---
  let spirv;
  try {
    spirv = glslang.compileGLSL(glslText, s.stage, false);
    r.spirvWords = spirv.length;
    writeFileSync(spvPath, Buffer.from(new Uint8Array(spirv.buffer, spirv.byteOffset, spirv.byteLength)));
    r.stage1 = 'PASS';
    console.log(`[1] glslang GLSL->SPIR-V : PASS  (${spirv.length} SPIR-V words -> ${s.spv})`);
  } catch (e) {
    r.stage1 = 'FAIL';
    r.stage1err = (e && e.message) ? e.message : String(e);
    console.log(`[1] glslang GLSL->SPIR-V : FAIL`);
    console.log('----- glslang error -----');
    console.log(r.stage1err);
    console.log('-------------------------');
    results.push(r);
    continue;
  }

  // --- Stage 2: naga SPIR-V -> WGSL ---
  const t = runNaga([spvPath, wgslPath]);
  if (t.ok) {
    const wgslText = readFileSync(wgslPath, 'utf8');
    r.wgslChars = wgslText.length;
    r.stage2 = 'PASS';
    console.log(`[2] naga SPIR-V->WGSL    : PASS  (${wgslText.length} WGSL chars -> ${s.wgsl})`);
  } else {
    r.stage2 = 'FAIL';
    r.stage2err = (t.err || t.out || '').trim();
    console.log(`[2] naga SPIR-V->WGSL    : FAIL`);
    console.log('----- naga translate error -----');
    console.log(r.stage2err);
    console.log('--------------------------------');
    results.push(r);
    continue;
  }

  // --- Stage 3: naga WGSL validate ---
  const v = runNaga([wgslPath]);
  if (v.ok) {
    r.stage3 = 'PASS';
    console.log(`[3] naga WGSL validate   : PASS`);
    if (v.out && v.out.trim()) console.log('    ' + v.out.trim());
  } else {
    r.stage3 = 'FAIL';
    r.stage3err = (v.err || v.out || '').trim();
    console.log(`[3] naga WGSL validate   : FAIL`);
    console.log('----- naga validate error -----');
    console.log(r.stage3err);
    console.log('-------------------------------');
  }

  results.push(r);
}

console.log('\n\n================ SUMMARY (VULKAN / separate-descriptor path) ================');
let allPass = true;
for (const r of results) {
  const s1 = r.stage1 || '---', s2 = r.stage2 || '---', s3 = r.stage3 || '---';
  const pass = r.stage1 === 'PASS' && r.stage2 === 'PASS' && r.stage3 === 'PASS';
  if (!pass) allPass = false;
  console.log(`${r.name.padEnd(9)} | glslang:${s1.padEnd(4)} naga->wgsl:${s2.padEnd(4)} wgsl-valid:${s3.padEnd(4)} | ` +
    `glsl=${r.glslChars}ch spirv=${r.spirvWords ?? '-'}w wgsl=${r.wgslChars ?? '-'}ch`);
}
console.log('\nVERDICT: ' + (allPass ? 'GO  (both real Dolphin ubershaders -> valid WGSL via Vulkan/separate-descriptor, zero naga errors)'
                                      : 'NO-GO  (see per-stage errors above)'));

// control_dynidx.cjs
//
// Isolates whether naga 29's SPIR-V frontend rejects a DYNAMIC (runtime) index
// into a binding array of separate texture+sampler resources -- the suspected
// sole remaining fragment blocker (`invalid global var Access ...`).
//
// Two near-identical Vulkan-GLSL fragment shaders, both using SEPARATE
// texture2DArray[8] + sampler[8] (set=1):
//   A) CONST index   : samp_tex[3] / samp_smp[3]
//   B) DYNAMIC index : samp_tex[idx] / samp_smp[idx], idx from a UBO (runtime)
// If A passes naga and B fails with the same error, the blocker is proven to be
// dynamic binding-array indexing, not the separate-descriptor split itself.

const { writeFileSync, readFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');
const glslangFactory = require('@webgpu/glslang');
const DIR = __dirname;
const NAGA = '/Users/caseybement/.cargo/bin/naga';
const glslang = glslangFactory();

const HEADER = `#version 450 core
layout(set = 1, binding = 0) uniform texture2DArray samp_tex[8];
layout(set = 1, binding = 8) uniform sampler samp_smp[8];
layout(set = 0, binding = 0) uniform UBO { uint idx; vec3 uv; } u;
layout(location = 0) out vec4 ocol0;
`;

const A_CONST = HEADER + `
void main() {
  ocol0 = texture(sampler2DArray(samp_tex[3], samp_smp[3]), u.uv);
}
`;

const B_DYN = HEADER + `
void main() {
  ocol0 = texture(sampler2DArray(samp_tex[u.idx], samp_smp[u.idx]), u.uv);
}
`;

function runNaga(args) {
  try { return { ok: true, out: execFileSync(NAGA, args, { encoding: 'utf8' }) }; }
  catch (e) { return { ok: false, err: (e.stderr ? e.stderr.toString() : '') + (e.stdout ? e.stdout.toString() : '') + (e.message || '') }; }
}

for (const [name, src] of [['A_CONST_INDEX', A_CONST], ['B_DYNAMIC_INDEX', B_DYN]]) {
  console.log(`\n================ ${name} ================`);
  let spv;
  try { spv = glslang.compileGLSL(src, 'fragment', false); }
  catch (e) { console.log('  glslang FAIL:', e.message || e); continue; }
  const spvPath = join(DIR, 'control_' + name + '.spv');
  const wgslPath = join(DIR, 'control_' + name + '.wgsl');
  writeFileSync(spvPath, Buffer.from(new Uint8Array(spv.buffer, spv.byteOffset, spv.byteLength)));
  console.log('  glslang PASS (' + spv.length + ' words)');
  const t = runNaga([spvPath, wgslPath]);
  if (t.ok) {
    console.log('  naga translate PASS -> ' + 'control_' + name + '.wgsl');
    const v = runNaga([wgslPath]);
    console.log('  naga validate ' + (v.ok ? 'PASS (' + v.out.trim() + ')' : 'FAIL: ' + v.err.trim()));
  } else {
    console.log('  naga translate FAIL: ' + t.err.trim());
  }
}

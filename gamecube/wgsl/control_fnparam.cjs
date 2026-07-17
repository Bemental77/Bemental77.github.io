// control_fnparam.cjs
//
// Tests whether the fragment blocker is passing a (dynamically-indexed)
// SEPARATE texture+sampler resource as a FUNCTION ARGUMENT through a helper --
// which is exactly what Dolphin's sampleTexture(...) does.
//
//   A) INLINE  : texture(sampler2DArray(samp_tex[idx], samp_smp[idx]), uv) in main
//   B) FN_PARAM: helper(texture2DArray t, sampler s, ...) called with the
//                dynamically-indexed array elements (mirrors Dolphin)

const { writeFileSync } = require('node:fs');
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

const A_INLINE = HEADER + `
void main() {
  ocol0 = texture(sampler2DArray(samp_tex[u.idx], samp_smp[u.idx]), u.uv);
}
`;

const B_FNPARAM = HEADER + `
vec4 helper(uint texmap, texture2DArray t, sampler s, vec3 uv) {
  return texture(sampler2DArray(t, s), uv);
}
void main() {
  ocol0 = helper(u.idx, samp_tex[u.idx], samp_smp[u.idx], u.uv);
}
`;

function runNaga(args) {
  try { return { ok: true, out: execFileSync(NAGA, args, { encoding: 'utf8' }) }; }
  catch (e) { return { ok: false, err: (e.stderr ? e.stderr.toString() : '') + (e.stdout ? e.stdout.toString() : '') + (e.message || '') }; }
}

for (const [name, src] of [['A_INLINE', A_INLINE], ['B_FNPARAM', B_FNPARAM]]) {
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
    console.log('  naga translate PASS -> control_' + name + '.wgsl');
    const v = runNaga([wgslPath]);
    console.log('  naga validate ' + (v.ok ? 'PASS (' + v.out.trim() + ')' : 'FAIL: ' + v.err.trim()));
  } else {
    console.log('  naga translate FAIL: ' + t.err.trim());
  }
}

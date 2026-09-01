// control_fix.cjs
//
// Confirms the FIX for the function-parameter blocker: don't pass the
// texture/sampler resource as an argument; pass the INDEX and access the
// global arrays directly inside the helper (so the only OpAccessChain on the
// resource arrays sits in the same function as the texture() call, and traces
// to a direct global). This is the shape Dolphin's generator would need.
//
//   FIX) helper(uint texmap, vec3 uv) { return texture(sampler2DArray(samp_tex[texmap], samp_smp[texmap]), uv); }

const { writeFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');
const glslangFactory = require('@webgpu/glslang');
const DIR = __dirname;
const NAGA = '/Users/caseybement/.cargo/bin/naga';
const glslang = glslangFactory();

const SRC = `#version 450 core
layout(set = 1, binding = 0) uniform texture2DArray samp_tex[8];
layout(set = 1, binding = 8) uniform sampler samp_smp[8];
layout(set = 0, binding = 0) uniform UBO { uint idx; vec3 uv; } u;
layout(location = 0) out vec4 ocol0;

vec4 helper(uint texmap, vec3 uv) {
  return texture(sampler2DArray(samp_tex[texmap], samp_smp[texmap]), uv);
}
void main() {
  ocol0 = helper(u.idx, u.uv);
}
`;

function runNaga(args) {
  try { return { ok: true, out: execFileSync(NAGA, args, { encoding: 'utf8' }) }; }
  catch (e) { return { ok: false, err: (e.stderr ? e.stderr.toString() : '') + (e.stdout ? e.stdout.toString() : '') + (e.message || '') }; }
}

console.log('================ FIX_INDEX_PARAM ================');
let spv;
try { spv = glslang.compileGLSL(SRC, 'fragment', false); }
catch (e) { console.log('  glslang FAIL:', e.message || e); process.exit(1); }
const spvPath = join(DIR, 'control_FIX.spv');
const wgslPath = join(DIR, 'control_FIX.wgsl');
writeFileSync(spvPath, Buffer.from(new Uint8Array(spv.buffer, spv.byteOffset, spv.byteLength)));
console.log('  glslang PASS (' + spv.length + ' words)');
const t = runNaga([spvPath, wgslPath]);
if (t.ok) {
  console.log('  naga translate PASS -> control_FIX.wgsl');
  const v = runNaga([wgslPath]);
  console.log('  naga validate ' + (v.ok ? 'PASS (' + v.out.trim() + ')' : 'FAIL: ' + v.err.trim()));
} else {
  console.log('  naga translate FAIL: ' + t.err.trim());
}

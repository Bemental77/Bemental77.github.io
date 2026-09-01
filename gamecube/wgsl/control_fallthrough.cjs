// control_fallthrough.cjs
//
// Isolates the "fall-through switch case block" naga error and proves the fix.
//   A) FALLTHROUGH : `case 15:` empty, falls into `case 10:` (Dolphin's shape)
//   B) MERGED      : `case 15: case 10:` with no code between (still 2 labels)
//   C) DUPLICATED  : each case has its own body + break (no fall-through)

const { writeFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');
const glslangFactory = require('@webgpu/glslang');
const DIR = __dirname;
const NAGA = '/Users/caseybement/.cargo/bin/naga';
const glslang = glslangFactory();

const HEAD = `#version 450 core
layout(set=0,binding=0) uniform UBO { int mode; } u;
layout(location=0) out vec4 ocol0;
void main() {
  ivec4 r = ivec4(1);
`;
const TAIL = `
  ocol0 = vec4(r);
}
`;

const A = HEAD + `
  switch (u.mode) {
    case 0:  r = ivec4(0); break;
    case 15: // empty -> falls into 10
    case 10: r = ivec4(255); break;
    default: break;
  }
` + TAIL;

const B = HEAD + `
  switch (u.mode) {
    case 0: r = ivec4(0); break;
    case 15:
    case 10: r = ivec4(255); break;
    default: break;
  }
` + TAIL;  // same source as A essentially; kept for clarity

const C = HEAD + `
  switch (u.mode) {
    case 0:  r = ivec4(0); break;
    case 15: r = ivec4(255); break;
    case 10: r = ivec4(255); break;
    default: break;
  }
` + TAIL;

function runNaga(args) {
  try { return { ok: true, out: execFileSync(NAGA, args, { encoding: 'utf8' }) }; }
  catch (e) { return { ok: false, err: ((e.stderr?e.stderr.toString():'')+(e.stdout?e.stdout.toString():'')+(e.message||'')).trim() }; }
}

for (const [name, src] of [['A_FALLTHROUGH', A], ['B_MERGED_LABELS', B], ['C_DUPLICATED', C]]) {
  console.log(`\n==== ${name} ====`);
  let spv;
  try { spv = glslang.compileGLSL(src, 'fragment', false); }
  catch (e) { console.log('  glslang FAIL:', (e.message||e)); continue; }
  const p = join(DIR, 'control_ft_' + name + '.spv');
  const wp = join(DIR, 'control_ft_' + name + '.wgsl');
  writeFileSync(p, Buffer.from(new Uint8Array(spv.buffer, spv.byteOffset, spv.byteLength)));
  console.log('  glslang PASS (' + spv.length + ' words)');
  const t = runNaga([p, wp]);
  if (t.ok) { const v = runNaga([wp]); console.log('  naga translate PASS; validate ' + (v.ok?'PASS':'FAIL: '+v.err)); }
  else console.log('  naga translate FAIL: ' + t.err);
}

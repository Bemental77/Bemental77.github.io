// Phase 1 WebGPU go/no-go pipeline driver (CommonJS).
//
// For each of the two REAL Dolphin ubershaders (dolphin.frag, dolphin.vert),
// runs the full chain:
//   1. glslang: GLSL  -> SPIR-V  (@webgpu/glslang, synchronous Emscripten factory)
//   2. naga:    SPIR-V -> WGSL   (naga input.spv output.wgsl)
//   3. naga:    WGSL  validate   (naga input.wgsl  -> parses & validates)
//
// NOTE: @webgpu/glslang@0.0.15 node-devel build exports a *synchronous*
// Emscripten Module factory (require(...) === function(Module){...; return Module}).
// Calling it with no args returns a ready object whose .compileGLSL works
// immediately (wasm is instantiated synchronously via new WebAssembly.Instance).
// The advertised `Promise<Glslang>` default-export contract is for a different
// dist build; using ESM `import ... from` + `await` wedges under node 24, so we
// use require() + direct factory call here.
//
// naga (v29.0.3) is invoked by full path (not on PATH).
//
// Run from repo root with system node 24:
//   node gamecube/wgsl/run_pipeline.cjs

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
  { name: 'FRAGMENT', stage: 'fragment', src: 'dolphin.frag', spv: 'dolphin.frag.spv', wgsl: 'dolphin.frag.wgsl' },
  { name: 'VERTEX',   stage: 'vertex',   src: 'dolphin.vert', spv: 'dolphin.vert.spv', wgsl: 'dolphin.vert.wgsl' },
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

  // --- Stage 1: glslang GLSL -> SPIR-V ---
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

console.log('\n\n================ SUMMARY ================');
let allPass = true;
for (const r of results) {
  const s1 = r.stage1 || '---', s2 = r.stage2 || '---', s3 = r.stage3 || '---';
  const pass = r.stage1 === 'PASS' && r.stage2 === 'PASS' && r.stage3 === 'PASS';
  if (!pass) allPass = false;
  console.log(`${r.name.padEnd(9)} | glslang:${s1.padEnd(4)} naga->wgsl:${s2.padEnd(4)} wgsl-valid:${s3.padEnd(4)} | ` +
    `glsl=${r.glslChars}ch spirv=${r.spirvWords ?? '-'}w wgsl=${r.wgslChars ?? '-'}ch`);
}
console.log('\nVERDICT: ' + (allPass ? 'GO  (both real Dolphin ubershaders -> valid WGSL, zero naga errors)'
                                      : 'NO-GO  (see per-stage errors above)'));

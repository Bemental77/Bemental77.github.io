// wgpu_diff.mjs — analyze/diff wgpuCap captures (board vs title).
// Usage: node wgpu_diff.mjs /tmp/wgpu_cap_board.json [/tmp/wgpu_cap_title.json]
import fs from 'fs';

function load(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

// projection class from VS proj (4 rows of float4, row-major):
// perspective row3 = (0,0,-1,0); ortho row3 = (0,0,0,1)
function projClass(vs) {
  if (!vs || !vs.proj) return '?';
  const r3 = vs.proj.slice(12, 16);
  if (Math.abs(r3[2] + 1) < 1e-3 && Math.abs(r3[3]) < 1e-3) return 'PERSP';
  if (Math.abs(r3[3] - 1) < 1e-3 && Math.abs(r3[2]) < 1e-3) return 'ORTHO';
  return 'proj[' + r3.join(',') + ']';
}

function summarize(cap, name) {
  console.log(`\n===== ${name}: ${cap.draws.length} draws, ${cap.passes.length} passes, submits=${cap.submits}`);
  cap.passes.forEach((p, i) => {
    const a = p.atts && p.atts[0];
    console.log(`  pass#${i}: draws=${p.draws} color=${a ? a.tex + ' load=' + a.load + (a.clear ? ' clear=[' + a.clear + ']' : '') : 'none'}` +
      (p.depth ? ` depth=${p.depth.tex} load=${p.depth.load} clear=${p.depth.clear}` : ' depth=none'));
  });
  console.log('  pipelines used:');
  for (const [id, p] of Object.entries(cap.pipes))
    console.log(`    ${id}: ${p.label || '(no label)'} topo=${p.topo} cull=${p.cull} ds=${p.ds ? p.ds.cmp + (p.ds.w ? '+w' : '') : 'none'} ` +
      `targets=${(p.targets || []).map((t) => t ? t.fmt + ':wm' + t.wm + (t.blend ? ':blend' : '') : 'null').join(',')}`);
  // cluster draws by (pass, pipe, projClass, vp, tex-set)
  const clusters = new Map();
  cap.draws.forEach((d) => {
    const key = [d.pass, d.pipe, projClass(d.uni && d.uni.vs), JSON.stringify(d.vp), JSON.stringify(d.sc), (d.tex || []).join('+')].join(' | ');
    if (!clusters.has(key)) clusters.set(key, { n: 0, first: d.n, last: d.n, idx: 0 });
    const c = clusters.get(key);
    c.n++; c.last = d.n; c.idx += d.k === 'di' ? d.args[0] : d.args[0];
  });
  console.log('  draw clusters (pass|pipe|proj|vp|scissor|textures):');
  for (const [k, c] of clusters) console.log(`    [${c.n}x #${c.first}-${c.last} idx=${c.idx}] ${k}`);
  return clusters;
}

function drawDetail(cap, n, label) {
  const d = cap.draws.find((x) => x.n === n);
  if (!d) { console.log('no draw', n); return; }
  console.log(`\n--- ${label} draw#${n} (pass ${d.pass}, ${d.k} args=[${d.args}])`);
  console.log('  pipe:', d.pipe, JSON.stringify(cap.pipes[d.pipe] || {}));
  console.log('  vp:', JSON.stringify(d.vp), 'sc:', JSON.stringify(d.sc));
  console.log('  bgs:', JSON.stringify(d.bgs));
  console.log('  tex:', JSON.stringify(d.tex));
  console.log('  ib:', JSON.stringify(d.ib), 'vb:', JSON.stringify(d.vb));
  if (d.uni && d.uni.vs) {
    const v = d.uni.vs;
    console.log(`  VS(${v.m}, seq=${v.seq}): components=0x${v.hdr[0].toString(16)} dualTex=${v.hdr[1]} numColorChans=${v.hdr[2]}`);
    for (let r = 0; r < 6; r++) console.log(`    pnm[${r}]: ${v.pnm.slice(4 * r, 4 * r + 4).join(', ')}`);
    for (let r = 0; r < 4; r++) console.log(`    proj[${r}]: ${v.proj.slice(4 * r, 4 * r + 4).join(', ')}`);
  } else console.log('  VS: none');
  if (d.uni && d.uni.ps) {
    const p = d.uni.ps;
    console.log(`  PS(${p.m}, seq=${p.seq}): alpha=[${p.alpha}]`);
    console.log(`    ctl(genmode,alphaTest,fogP3,fogRB,dstalpha,ztexop,lateZ,rgba6,dither,bbox): ${p.ctl.map((x) => '0x' + x.toString(16)).join(',')}`);
    console.log(`    blend(en,src,srcA,dst,dstA,sub,subA,logicEn,logicMode): ${p.blend.join(',')}`);
  } else console.log('  PS: none');
}

const capA = load(process.argv[2]);
const cA = summarize(capA, process.argv[2]);
if (process.argv[3]) {
  const capB = load(process.argv[3]);
  summarize(capB, process.argv[3]);
}
// optional: DRAW=<n>[,<n2>] detail dumps against capA / capB
if (process.env.DRAWA) for (const n of process.env.DRAWA.split(',')) drawDetail(capA, +n, 'A');
if (process.env.DRAWB && process.argv[3]) { const capB = load(process.argv[3]); for (const n of process.env.DRAWB.split(',')) drawDetail(capB, +n, 'B'); }

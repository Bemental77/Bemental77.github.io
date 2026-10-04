#!/usr/bin/env node
// n64_jit_corpus.mjs — MAKE A TITLE'S SHIPPED SPAN CORPUS (dist/jit/<internal name>.json.gz).
//
// mips_emit.js "A SHIPPED SPAN CORPUS": every span a session offers to the JIT's compile worker
// is the same from run to run (recompile key, host addresses and all), so a title can ship those
// offers' inputs and the next session compiles them in the worker, at low priority, before the
// guest asks — into the recompile cache only; a span is installed from it only when its key,
// built from memory as it is, matches in full.
//
// This tool runs the REAL page and worker through n64_field_cost_probe.mjs (the shipped clock,
// --clock --nodbg, ?jitcorpus=0 so nothing is answered from an older corpus) once per --plan,
// captures every offer (bementalMips.warm.capture), and merges the runs: one param block (every
// run must agree on it — they do when the core build is the same), pages and jobs de-duplicated
// by their full contents. Output: gzip of
//   { v: 1, name, core, static, flags, tableBase, pages: [[w0, b64 words]],
//     jobs: [[vaddr, entryPtr, span, srcPtr, blockStart, blockEnd, pageIndex, b64 ops]] }
//
// USAGE (a dev server on the tree whose dist/ the corpus is for; probe lock held):
//   bash tools/probe_lock.sh run -- node n64/tools/n64_jit_corpus.mjs --url http://localhost:19300 \
//        --rom mariokart.z64 --plans mk64race:3000,mk642p:3500,idle:4000 [--out n64/N64Wasm/dist/jit]
import fs from 'fs';
import path from 'path';
import os from 'os';
import zlib from 'zlib';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const BASE = flag('url', 'http://localhost:19300');
const ROM = flag('rom', 'mariokart.z64');
const PLANS = flag('plans', 'idle:4000').split(',').map((s) => { const [p, f] = s.split(':'); return { plan: p, frames: +f || 3000 }; });
const OUT = flag('out', path.resolve(__dirname, '../N64Wasm/dist/jit'));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'n64corpus-'));

const END = `(() => {
  const W = self.bementalMips.warm, cap = W.capture || [];
  const b64 = (u) => { const u8 = new Uint8Array(u.buffer, u.byteOffset, u.byteLength); let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
  const PER = { vaddr: 1, entryPtr: 1, span: 1, srcPtr: 1, blockStart: 1, blockEnd: 1 };
  let stat = null, flags = null, tableBase = null; const pages = [], pidx = new Map(), jobs = [];
  for (const c of cap) {
    if (!stat) { stat = {}; for (const k in c.p) if (!PER[k]) stat[k] = c.p[k]; flags = c.flags; tableBase = c.tableBase; }
    const w = b64(c.words), pk = c.w0 + ':' + w;
    let pi = pidx.get(pk); if (pi === undefined) { pi = pages.length; pidx.set(pk, pi); pages.push([c.w0, w]); }
    jobs.push([c.p.vaddr >>> 0, c.p.entryPtr >>> 0, c.p.span, c.p.srcPtr >>> 0, c.p.blockStart >>> 0, c.p.blockEnd >>> 0, pi, b64(c.ops)]);
  }
  return { name: (self.__fbAsync && self.__fbAsync.romName) || '', core: (typeof CORE_V !== 'undefined' ? CORE_V : ''), static: stat, flags, tableBase, pages, jobs };
})()`;
fs.writeFileSync(path.join(TMP, 'end.js'), END);

const runs = [];
for (const { plan, frames } of PLANS) {
  const tag = 'corpus-' + plan;
  execFileSync(process.execPath, [path.join(__dirname, 'n64_field_cost_probe.mjs'), '--url', BASE, '--rom', ROM, '--plan', plan,
    '--frames', String(frames), '--from', String(frames - 10), '--clock', '--nodbg', '--nopic', '--query', 'jitcorpus=0&jitcapture=1',
    '--evalend', path.join(TMP, 'end.js'), '--tag', tag, '--out', TMP], { stdio: ['ignore', 'ignore', 'inherit'] });
  const r = JSON.parse(fs.readFileSync(path.join(TMP, tag + '.json'), 'utf8'));
  if (!r.evalEnd || !r.evalEnd.jobs) throw new Error(`${plan}: no capture (${r.evalEndErr || r.fault || 'evalEnd empty'})`);
  console.error(`[corpus] ${plan} ${frames} fields: ${r.evalEnd.jobs.length} offers, ${r.evalEnd.pages.length} pages`);
  runs.push(r.evalEnd);
}
// merge: one param block, pages and jobs by content
const out = { v: 1, name: runs[0].name, core: runs[0].core, static: runs[0].static, flags: runs[0].flags, tableBase: runs[0].tableBase, pages: [], jobs: [] };
const pidx = new Map(), jseen = new Set();
for (const r of runs) {
  if (JSON.stringify(r.static) !== JSON.stringify(out.static) || JSON.stringify(r.flags) !== JSON.stringify(out.flags) || r.tableBase !== out.tableBase)
    throw new Error('runs disagree on the param block / flags / table base — one core build per corpus');
  for (const j of r.jobs) {
    const pg = r.pages[j[6]], pk = pg[0] + ':' + pg[1];
    let pi = pidx.get(pk); if (pi === undefined) { pi = out.pages.length; pidx.set(pk, pi); out.pages.push(pg); }
    const jk = [j[0], j[1], j[2], j[3], j[4], j[5], pi, j[7]].join(',');
    if (jseen.has(jk)) continue; jseen.add(jk);
    out.jobs.push([j[0], j[1], j[2], j[3], j[4], j[5], pi, j[7]]);
  }
}
fs.mkdirSync(OUT, { recursive: true });
const file = path.join(OUT, out.name.replace(/[^A-Za-z0-9 _-]/g, '_') + '.json.gz');
const gz = zlib.gzipSync(Buffer.from(JSON.stringify(out)), { level: 9 });
fs.writeFileSync(file, gz);
console.log(JSON.stringify({ file, name: out.name, jobs: out.jobs.length, pages: out.pages.length, bytes: gz.length }));
fs.rmSync(TMP, { recursive: true, force: true });

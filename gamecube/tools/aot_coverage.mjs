#!/usr/bin/env node
// aot_coverage.mjs — [AOT A0/A3] re-derive the MP4 board coverage table.
//
// Maps a board-scene guest-PC histogram (PROBE_PC_SAMPLE=1 -> /tmp/wasm_pc_hist.json)
// onto MP4's symbol map (~/gc_refs/marioparty4/config/GMPE01_01/symbols.txt), so the
// AOT campaign can rank functions by executed-sample share and drive A3 down the
// ranked table. Post-load segments only (seg >= MINSEG; the state loads ~25s in).
//
// Output: ranked function list (name, addr, size, samples, share%, cumulative%) to
// stdout AND a machine-readable /tmp/aot_coverage.json (the work-list the leaf-
// classification workflow consumes). Committed campaign artifact, not a scratchpad.
//
// Usage: node gamecube/tools/aot_coverage.mjs [hist.json] [symbols.txt] [minSeg]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HIST = process.argv[2] || '/tmp/wasm_pc_hist.json';
const SYMS = process.argv[3] || path.join(os.homedir(), 'gc_refs/marioparty4/config/GMPE01_01/symbols.txt');
const MINSEG = parseInt(process.argv[4] || '3', 10);  // post-load board segments

// --- parse symbols.txt: Name = .text:0xADDR; // type:function size:0xSIZE ---
const fns = [];
for (const line of fs.readFileSync(SYMS, 'utf8').split('\n')) {
  const m = line.match(/^(\S+)\s*=\s*\.text:0x([0-9A-Fa-f]+);.*?size:0x([0-9A-Fa-f]+)/);
  if (!m) continue;
  const addr = parseInt(m[2], 16), size = parseInt(m[3], 16);
  if (size === 0) continue;
  fns.push({ name: m[1], addr, size, end: addr + size });
}
fns.sort((a, b) => a.addr - b.addr);
const addrs = fns.map(f => f.addr);
function findFn(pc) {  // binary search: largest addr <= pc, then range check
  let lo = 0, hi = addrs.length - 1, best = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (addrs[mid] <= pc) { best = mid; lo = mid + 1; } else hi = mid - 1; }
  if (best < 0) return null;
  const f = fns[best];
  return pc < f.end ? f : null;
}

// --- aggregate post-load histogram PC -> count ---
const segs = (JSON.parse(fs.readFileSync(HIST, 'utf8')) || []).filter(Boolean);
const pcCount = new Map();
let total = 0;
for (const s of segs) {
  if (s.seg < MINSEG) continue;
  for (const [pc, c] of s.hist) { pcCount.set(pc >>> 0, (pcCount.get(pc >>> 0) || 0) + c); total += c; }
}

// --- resolve PCs -> functions ---
const perFn = new Map();  // name -> {name,addr,size,samples}
let unresolved = 0;
for (const [pc, c] of pcCount) {
  const f = findFn(pc);
  if (!f) { unresolved += c; continue; }
  const e = perFn.get(f.name) || { name: f.name, addr: f.addr, size: f.size, samples: 0 };
  e.samples += c; perFn.set(f.name, e);
}

const ranked = [...perFn.values()].sort((a, b) => b.samples - a.samples);
let cum = 0;
const rows = ranked.map(r => {
  const share = (r.samples / total) * 100; cum += share;
  return { ...r, addrHex: '0x' + r.addr.toString(16), share: +share.toFixed(2), cumulative: +cum.toFixed(2) };
});

console.log(`# AOT board coverage — ${total} post-load samples (seg>=${MINSEG}), ` +
  `${((total - unresolved) / total * 100).toFixed(1)}% resolved, ${(unresolved / total * 100).toFixed(1)}% unresolved (interp/OS/no-symbol)`);
console.log(`rank  share%  cum%    samples  addr        size    name`);
for (let i = 0; i < rows.length && rows[i].cumulative <= 85; i++) {
  const r = rows[i];
  console.log(`${String(i + 1).padStart(3)}  ${String(r.share).padStart(6)}  ${String(r.cumulative).padStart(6)}  ` +
    `${String(r.samples).padStart(7)}  ${r.addrHex.padEnd(10)}  ${('0x' + r.size.toString(16)).padEnd(6)}  ${r.name}`);
}
fs.writeFileSync('/tmp/aot_coverage.json', JSON.stringify({ total, unresolved, rows }, null, 0));
console.log(`\n-> /tmp/aot_coverage.json (${rows.length} functions)`);

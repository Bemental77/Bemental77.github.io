#!/usr/bin/env node
// op_census_manifest.mjs — build the op_census input manifest.
//
// Reads the guest-PC histogram the probe already produces (PROBE_PC_SAMPLE=1 ->
// /tmp/wasm_pc_hist.json), recovers the BLOCK-ENTRY PCs inside each hot 256-byte
// bucket from the disc image, and writes one line per block:
//
//     <start_pc_hex> <word0> <word1> ... <word63>
//
// plus a sidecar <out>.weights of "<start_pc_hex> <sample_count>" so the report
// can weight each block by how much execution actually landed in it.
//
// BLOCK-ENTRY RECOVERY. A PC is treated as a block entry when it is a bucket
// base, when the instruction before it is a block terminator that is not a
// coalescable forward conditional (the JitWasm.cpp:983-1007 rule), or when some
// branch inside the scanned window targets it. That is a superset of the real
// entry set: a PC that the guest never actually enters still gets emitted and
// counted. Its weight comes from the bucket it sits in, so a never-entered PC
// dilutes rather than distorts — see the report's `blocks_per_bucket` column.
//
// Usage:
//   node gamecube/tools/op_census_manifest.mjs <hist.json> <out.manifest> [rom]
// rom defaults to the SAB ISO.

import fs from 'node:fs';

const HIST = process.argv[2];
const OUT  = process.argv[3];
const ISO_PATH = process.argv[4] ||
  '/Users/caseybement/Bemental77.github.io/gamecube/roms/Sonic Adventure 2 - Battle (USA).iso';
if (!HIST || !OUT) {
  console.error('usage: op_census_manifest.mjs <hist.json> <out.manifest> [iso]');
  process.exit(2);
}
// Only rank post-boot segments unless told otherwise: __check_pad3 and the
// arena-clear dominate segment 0/1 and are not the steady-state workload.
const SEG_MIN = process.env.SEG_MIN !== undefined ? Number(process.env.SEG_MIN) : 2;
const TOPN    = Number(process.env.TOPN || 24);

const readBE32 = (b, o) => (((b[o] << 24) | (b[o+1] << 16) | (b[o+2] << 8) | b[o+3]) >>> 0);

// ---- disc -> DOL sections -------------------------------------------------
const iso = fs.readFileSync(ISO_PATH);
// Read the DOL offset from the header at 0x420 — never hardcode it
// (CLAUDE.md gate #10: a hardcoded 0x1e700 silently disassembled an empty
// buffer for every PSO run through disasm_hot_pcs.py).
const dolOff = readBE32(iso, 0x420);
const sections = [];
for (let i = 0; i < 18; ++i) {
  const rel  = readBE32(iso, dolOff + i * 4);
  const addr = readBE32(iso, dolOff + 0x48 + i * 4);
  const size = readBE32(iso, dolOff + 0x90 + i * 4);
  if (!size || !addr) continue;
  sections.push({ idx: i, text: i < 7, fileOff: dolOff + rel, addr, size });
}
const textSecs = sections.filter(s => s.text);
if (!textSecs.length) { console.error('no DOL text sections — bad ISO or bad 0x420'); process.exit(1); }
console.error(`[manifest] DOL @0x${dolOff.toString(16)}, ${sections.length} sections (${textSecs.length} text)`);

function read32(pc) {
  for (const s of textSecs)
    if (pc >= s.addr && pc + 4 <= s.addr + s.size) return readBE32(iso, s.fileOff + (pc - s.addr));
  return null;
}

// ---- the two analyst predicates, mirrored ---------------------------------
// ppc_analyst.cpp:55-62 IsBlockTerminator, restricted to the encodings that
// appear in game code (unknown encodings also terminate there; here an unknown
// word simply ends the scan, which is the same effect for our purposes).
function isTerminator(inst) {
  const op = (inst >>> 26) & 0x3f;
  if (op === 18 || op === 16) return true;             // b/bl, bc
  if (op === 19) {                                      // bclr / bcctr / rfi
    const x = (inst >>> 1) & 0x3ff;
    return x === 16 || x === 528 || x === 50;
  }
  if (op === 17) return true;                           // sc
  if (op === 31 && ((inst >>> 1) & 0x3ff) === 467) {    // mtspr — MMCR0/MMCR1 only
    const spr = ((inst >>> 16) & 0x1f) | (((inst >>> 11) & 0x1f) << 5);
    return spr === 952 || spr === 956;
  }
  return false;
}
// ppc_analyst.cpp:74-81 IsForwardConditionalBranch
function isForwardCond(inst) {
  if (((inst >>> 26) & 0x3f) !== 16) return false;
  const bo = (inst >>> 21) & 0x1f;
  if (bo === 20) return false;                          // unconditional
  if (inst & 1) return false;                           // LK
  if (inst & 2) return false;                           // AA
  let bd = inst & 0xfffc;
  if (bd & 0x8000) bd |= 0xffff0000;
  return (bd | 0) > 0;
}
function branchTarget(inst, pc) {
  const op = (inst >>> 26) & 0x3f;
  if (op === 18) {
    let li = inst & 0x03fffffc;
    if (li & 0x02000000) li |= 0xfc000000;
    return ((inst & 2) ? (li >>> 0) : (pc + (li | 0)) >>> 0);
  }
  if (op === 16) {
    let bd = inst & 0xfffc;
    if (bd & 0x8000) bd |= 0xffff0000;
    return ((inst & 2) ? (bd >>> 0) : (pc + (bd | 0)) >>> 0);
  }
  return null;
}

// ---- rank the histogram ---------------------------------------------------
const segs = JSON.parse(fs.readFileSync(HIST, 'utf8')).filter(s => s && s.hist);
const weight = new Map();
let total = 0;
for (const s of segs) {
  if (s.seg < SEG_MIN) continue;
  for (const [pc, n] of s.hist) {
    weight.set(pc >>> 0, (weight.get(pc >>> 0) || 0) + n);
    total += n;
  }
}
const ranked = [...weight.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOPN);
console.error(`[manifest] ${weight.size} buckets, ${total} samples (seg>=${SEG_MIN}); taking top ${ranked.length}`);

// ---- recover block entries inside each hot bucket --------------------------
const manifest = [];
const weights = [];
for (const [base, n] of ranked) {
  if (read32(base) === null) {
    console.error(`[manifest] skip 0x${base.toString(16)} (not in a DOL text section)`);
    continue;
  }
  const end = base + 256;
  const entries = new Set([base]);
  for (let pc = base; pc < end; pc += 4) {
    const inst = read32(pc);
    if (inst === null) break;
    if (isTerminator(inst) && !isForwardCond(inst)) {
      if (pc + 4 < end) entries.add(pc + 4);
    }
    const t = branchTarget(inst, pc);
    if (t !== null && t >= base && t < end) entries.add(t);
  }
  const sorted = [...entries].sort((a, b) => a - b);
  // Split the bucket's samples evenly across its recovered entries: a 256-byte
  // bucket cannot say which of its blocks the sample was in. This is the
  // instrument's coarsest assumption and it is why the report prints the
  // per-bucket block count next to every number.
  const share = n / sorted.length;
  for (const pc of sorted) {
    const words = [];
    for (let i = 0; i < 64; ++i) {
      const w = read32(pc + i * 4);
      if (w === null) break;
      words.push(w);
      if (isTerminator(w) && !isForwardCond(w)) break;
    }
    if (!words.length) continue;
    manifest.push(pc.toString(16).padStart(8, '0') + ' ' +
                  words.map(w => w.toString(16).padStart(8, '0')).join(' '));
    weights.push(pc.toString(16).padStart(8, '0') + ' ' + share.toFixed(4) +
                 ' ' + base.toString(16).padStart(8, '0') + ' ' + sorted.length);
  }
}
fs.writeFileSync(OUT, manifest.join('\n') + '\n');
fs.writeFileSync(OUT + '.weights', weights.join('\n') + '\n');
console.error(`[manifest] wrote ${manifest.length} blocks -> ${OUT}`);

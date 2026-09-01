#!/usr/bin/env node
// aot_classify.mjs — [AOT A3.1] definitive single-entry-safety classification.
//
// Uses the full main.elf disassembly cache (/tmp/mp4_disasm.txt from
// powerpc-eabi-objdump -d) to compute, per ranked function, the two mechanical
// facts that gate single-entry whole-function AOT:
//   - leaf:            no bl/bctrl/blrl (branch-and-link) SOURCED inside the fn
//                      (a call returns to an INTERIOR block-start).
//   - single_entry:    no control transfer from OUTSIDE the fn TARGETS its
//                      interior (addr, end). Catches multi-entry EABI helpers
//                      (__save_gpr's _savegpr_NN interior labels) that a symbol-
//                      name test misses — the interior-entry problem, mechanically.
// A3.1-structural-eligible = leaf && single_entry && size >= MINSIZE.
// (golden class pure_compute vs stateful is assigned by the verify workflow.)
//
// Usage: node gamecube/tools/aot_classify.mjs [coverage.json] [disasm.txt] [topN] [minSizeHex]

import fs from 'node:fs';

const COV = process.argv[2] || '/tmp/aot_coverage.json';
const DIS = process.argv[3] || '/tmp/mp4_disasm.txt';
const TOPN = parseInt(process.argv[4] || '45', 10);
const MINSIZE = parseInt(process.argv[5] || '40', 16);  // 0x40 ~ 16 instrs

const cov = JSON.parse(fs.readFileSync(COV, 'utf8'));
const rows = cov.rows.slice(0, TOPN);

// --- parse the disasm once: collect (srcAddr, kind, tgtAddr) for every transfer ---
// objdump line: "800078cc:\t48 0d ac 01 \tbl      800e24cc <_savegpr_17>"
const calls = [];   // {src, tgt}  bl/bctrl/blrl
const branches = []; // {src, tgt}  b/ba/bc*/bdnz with resolvable target
let indirectInside = [];  // bctr/bcctr sources (computed transfer) — recorded per fn later
// operand is OPTIONAL: operand-less insns (blrl/blr/bctr/bcctr) must still parse.
const lineRe = /^([0-9a-f]{8}):\t[0-9a-f ]+\t([a-z][a-z0-9._+]*)(?:\s+([0-9a-f]{8}))?/;
for (const line of fs.readFileSync(DIS, 'utf8').split('\n')) {
  const m = line.match(lineRe);
  if (!m) continue;
  const src = parseInt(m[1], 16), mn = m[2], tgt = m[3] ? parseInt(m[3], 16) : null;
  // Branch-and-link = a call: control returns to the interior. bctrl/blrl are
  // INDIRECT calls (branch to CTR/LR) with NO static target — they still return
  // interior, so they must disqualify leaf even though tgt is null. (Missing this
  // false-passed GXLoadTexObjPreLoaded's blrl in the first cut.)
  if (mn === 'bl') { if (tgt !== null) calls.push({ src, tgt }); }
  else if (mn === 'bctrl' || mn === 'blrl') calls.push({ src, tgt });  // indirect call, target unknown
  else if (mn === 'bctr' || mn === 'bcctr') indirectInside.push(src);
  else if (/^b/.test(mn) && mn !== 'blr' && mn !== 'blrl' && tgt !== null) branches.push({ src, tgt });
}
const allXfers = calls.concat(branches);

const out = [];
for (const r of rows) {
  const lo = r.addr, hi = r.addr + r.size;
  const inside = a => a >= lo && a < hi;
  const interior = a => a > lo && a < hi;

  const callsInside = calls.filter(c => inside(c.src));
  const leaf = callsInside.length === 0;
  // interior entries: any transfer FROM outside that lands strictly inside.
  const interiorEntries = allXfers.filter(x => !inside(x.src) && interior(x.tgt));
  const single_entry = interiorEntries.length === 0;
  const indirectHere = indirectInside.filter(inside);
  // tail transfers OUT (b/bctr from inside to outside) — noted, not disqualifying for single-entry
  const tailOut = branches.filter(b => inside(b.src) && !inside(b.tgt));

  const structural_eligible = leaf && single_entry && r.size >= MINSIZE;
  out.push({
    rank: rows.indexOf(r) + 1, name: r.name, addr: r.addrHex, size: '0x' + r.size.toString(16),
    sizeBytes: r.size, share: r.share, cumulative: r.cumulative,
    leaf, single_entry, structural_eligible,
    n_calls_inside: callsInside.length,
    interior_entry_srcs: interiorEntries.slice(0, 5).map(x => '0x' + x.src.toString(16) + '->0x' + x.tgt.toString(16)),
    n_indirect_inside: indirectHere.length,
    n_tail_out: tailOut.length,
  });
}

const elig = out.filter(o => o.structural_eligible);
const eligShare = elig.reduce((a, o) => a + o.share, 0);
console.log(`# A3.1 structural eligibility (leaf && single-entry && size>=0x${MINSIZE.toString(16)}): ` +
  `${elig.length}/${out.length} functions, ${eligShare.toFixed(1)}% of board samples\n`);
console.log('## STRUCTURALLY ELIGIBLE (A3.1 line, share order):');
for (const o of elig) console.log(`  ${o.share.toString().padStart(5)}%  ${o.addr.padEnd(10)} ${o.size.padEnd(6)} ${o.name}` +
  (o.n_indirect_inside ? `  [${o.n_indirect_inside} indirect bctr/bcctr inside — verify]` : '') +
  (o.n_tail_out ? `  [${o.n_tail_out} tail-out]` : ''));
console.log('\n## EXCLUDED:');
for (const o of out.filter(x => !x.structural_eligible)) {
  const why = !o.leaf ? `not-leaf(${o.n_calls_inside} calls)` :
    !o.single_entry ? `MULTI-ENTRY(${o.interior_entry_srcs.length} interior callers, e.g. ${o.interior_entry_srcs[0]})` :
      o.sizeBytes < MINSIZE ? `too-small(${o.size})` : '?';
  console.log(`  ${o.share.toString().padStart(5)}%  ${o.addr.padEnd(10)} ${o.name.padEnd(26)} ${why}`);
}
fs.writeFileSync('/tmp/aot_classify.json', JSON.stringify(out, null, 0));
console.log('\n-> /tmp/aot_classify.json');

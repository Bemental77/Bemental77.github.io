#!/usr/bin/env node
// hb_histogram.mjs — extract `[hb]` and `[wild-ct]` heartbeat PCs from a
// probe log, bucket by PC, and report distribution. Tells us where guest
// time is actually spent.
//
// Usage:
//   node gamecube/tools/hb_histogram.mjs <probe.log>

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const LOG = process.argv[2];
if (!LOG) {
    console.error('usage: hb_histogram.mjs <probe.log>');
    process.exit(2);
}

const text = fs.readFileSync(LOG, 'utf8');

// `[hb] iter=N pc=0xXXXX msr=0xMM exc=0xEE state=S`
const RE_HB    = /\[hb\]\s+iter=(\d+)\s+pc=0x([0-9a-fA-F]+).*?msr=0x([0-9a-fA-F]+)\s+exc=0x([0-9a-fA-F]+)/g;
// `[wild-ct] iter=N ticks_lo=0xXXXX ticks_hi=0xYY pc=0xZZ downcount=D`
const RE_WC    = /\[wild-ct\]\s+iter=(\d+)\s+ticks_lo=0x([0-9a-fA-F]+)\s+ticks_hi=0x([0-9a-fA-F]+)\s+pc=0x([0-9a-fA-F]+)/g;

const samples = [];
let m;
while ((m = RE_HB.exec(text)) !== null) {
    samples.push({
        kind: 'hb',
        iter: parseInt(m[1], 10),
        pc:   parseInt(m[2], 16),
        msr:  parseInt(m[3], 16),
        exc:  parseInt(m[4], 16),
    });
}
while ((m = RE_WC.exec(text)) !== null) {
    samples.push({
        kind: 'wild-ct',
        iter: parseInt(m[1], 10),
        pc:   parseInt(m[4], 16),
    });
}

console.log(`[hb-histo] ${samples.length} samples (${samples.filter(s=>s.kind==='hb').length} hb, ${samples.filter(s=>s.kind==='wild-ct').length} wild-ct)`);

// Bucket by PC. Show top-20 PCs and top-10 PC-ranges (64-byte buckets).
const byPc = new Map();
const byRange = new Map();
for (const s of samples) {
    byPc.set(s.pc, (byPc.get(s.pc) || 0) + 1);
    const range = (s.pc & ~0x3F) >>> 0;  // 64-byte bucket (unsigned)
    byRange.set(range, (byRange.get(range) || 0) + 1);
}

console.log('\n--- top 20 exact PCs ---');
const topPcs = [...byPc.entries()].sort((a,b)=>b[1]-a[1]).slice(0, 20);
for (const [pc, n] of topPcs) {
    console.log(`  ${n.toString().padStart(4)}× pc=0x${pc.toString(16).padStart(8,'0')}`);
}

console.log('\n--- top 10 64-byte PC ranges ---');
const topRanges = [...byRange.entries()].sort((a,b)=>b[1]-a[1]).slice(0, 10);
for (const [pc, n] of topRanges) {
    console.log(`  ${n.toString().padStart(4)}× range 0x${pc.toString(16).padStart(8,'0')}..0x${(pc+0x3F).toString(16)}`);
}

// MSR/exc distribution for [hb] samples — what state is the OS in most often?
const stateCounts = new Map();
for (const s of samples.filter(s=>s.kind==='hb')) {
    const k = `msr=0x${s.msr.toString(16)} exc=0x${s.exc.toString(16)}`;
    stateCounts.set(k, (stateCounts.get(k) || 0) + 1);
}
console.log('\n--- MSR/exc state distribution ---');
const topStates = [...stateCounts.entries()].sort((a,b)=>b[1]-a[1]).slice(0, 10);
for (const [k, n] of topStates) {
    console.log(`  ${n.toString().padStart(4)}× ${k}`);
}

// Cross-reference top PCs to SAB function entries (via dump_sab_pc.mjs).
// Run dump for the top-5 unique PCs to identify what functions they're in.
console.log('\n--- top-5 PCs disassembled (function context) ---');
const dumpScript = path.join(path.dirname(LOG), '..', 'gamecube', 'tools', 'dump_sab_pc.mjs');
const dumpScriptAlt = '/Users/caseybement/Bemental77.github.io/gamecube/tools/dump_sab_pc.mjs';
const dump = fs.existsSync(dumpScript) ? dumpScript : dumpScriptAlt;
for (const [pc, n] of topPcs.slice(0, 5)) {
    const hex = '0x' + pc.toString(16);
    console.log(`\n=== ${hex} (${n} samples) ===`);
    try {
        const out = execSync(`node ${dump} ${hex} 2>&1 | tail -10`).toString();
        process.stdout.write(out);
    } catch (e) {
        console.log('  (dump failed)');
    }
}

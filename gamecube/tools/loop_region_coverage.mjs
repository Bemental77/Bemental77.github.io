#!/usr/bin/env node
// loop_region_coverage.mjs
//
// PREDICT step for the structured-CFG merged-region lever (RESEARCH.md 6.5).
//
// QUESTION IT ANSWERS
//   The per-block-boundary tax is only recoverable where blocks sit inside a
//   loop that a region-former can capture. So: weighted by the MP4 board's own
//   PC-sample profile, what fraction of board time runs inside a natural loop
//   spanning >= 2 JIT blocks, and how many block boundaries per iteration would
//   a structured region remove?
//
// WHY THIS SHAPE OF ANALYSIS
//   bementalJIT ends a block at the FIRST branch (FL_ENDBLOCK / canEndBlock,
//   ppc_analyst.cpp:151,560) and does NOT follow branches
//   (m_enable_branch_following is a dead flag, RESEARCH.md:85). So one executed
//   branch == one block boundary == one chain hop. Branches executed per loop
//   iteration is therefore EXACTLY the per-iteration block-boundary count.
//
//   int_fused (PM53h, ppc_emit.cpp:1201) already collapses the 1-branch case
//   (a self-loop: body + terminal bcx back to start). fp_resident_loop (WS-1
//   STEP-3, ppc_emit.cpp:1181) does the same for the FP variant. The
//   INCREMENTAL opportunity is therefore loops with >= 2 branches per
//   iteration, which no shipped shape captures.
//
// INPUTS
//   --profile  board_coverage.json  (per-function samples/share; addr + size)
//   --dol      main.dol             (instruction bytes)
//
// OUTPUT
//   JSON + a human summary on stderr.
//
// USAGE
//   node gamecube/tools/loop_region_coverage.mjs \
//     --profile gamecube/docs/aot/board_coverage.json \
//     --dol ~/gc_refs/marioparty4/orig/GMPE01_01/sys/main.dol

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function arg(name, dflt) {
    const i = process.argv.indexOf('--' + name);
    if (i < 0 || i + 1 >= process.argv.length) return dflt;
    let v = process.argv[i + 1];
    if (v.startsWith('~')) v = path.join(os.homedir(), v.slice(1));
    return v;
}

const PROFILE = arg('profile', 'gamecube/docs/aot/board_coverage.json');
const DOL = arg('dol', path.join(os.homedir(), 'gc_refs/marioparty4/orig/GMPE01_01/sys/main.dol'));
const TOP_SHARE = parseFloat(arg('cum', '90'));   // analyse until cumulative share >= this

// ---------------------------------------------------------------------------
// DOL loader: 7 text sections, 11 data sections.
// ---------------------------------------------------------------------------
function be32(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }

function loadDol(file) {
    const b = fs.readFileSync(file);
    const secs = [];
    for (let i = 0; i < 7; ++i) {
        const off = be32(b, i * 4);
        const addr = be32(b, 0x48 + i * 4);
        const size = be32(b, 0x90 + i * 4);
        if (!size || !addr) continue;
        secs.push({ off, addr, size, buf: b });
    }
    return secs;
}
const SECS = loadDol(DOL);
function readInst(addr) {
    for (const s of SECS) {
        if (addr >= s.addr && addr + 4 <= s.addr + s.size) {
            return be32(s.buf, s.off + (addr - s.addr));
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// PPC branch decode. Mirrors the opcodes ppc_analyst treats as FL_ENDBLOCK.
// ---------------------------------------------------------------------------
const BR = {
    NONE: 0, B: 1, BC: 2, BCLR: 3, BCCTR: 4, SC: 5, RFI: 6,
};
function decodeBranch(inst, addr) {
    const opcd = inst >>> 26;
    if (opcd === 18) {                                  // b / bl / ba / bla
        let li = (inst & 0x03FFFFFC) >>> 0;
        if (li & 0x02000000) li |= 0xFC000000;          // sign-extend 26-bit
        li = li | 0;
        const aa = (inst >>> 1) & 1, lk = inst & 1;
        return { kind: BR.B, target: (aa ? li : (addr + li)) >>> 0, lk, cond: false };
    }
    if (opcd === 16) {                                  // bc / bcl / bca / bcla
        let bd = inst & 0x0000FFFC;
        if (bd & 0x8000) bd |= 0xFFFF0000;
        bd = bd | 0;
        const aa = (inst >>> 1) & 1, lk = inst & 1;
        const bo = (inst >>> 21) & 0x1F;
        // BO 1z1zz = branch always (unconditional bc)
        const always = ((bo & 0b10100) === 0b10100);
        return { kind: BR.BC, target: (aa ? bd : (addr + bd)) >>> 0, lk, cond: !always };
    }
    if (opcd === 19) {
        const sub = (inst >>> 1) & 0x3FF;
        if (sub === 16) return { kind: BR.BCLR, target: null, lk: inst & 1, cond: true };
        if (sub === 528) return { kind: BR.BCCTR, target: null, lk: inst & 1, cond: true };
        if (sub === 50) return { kind: BR.RFI, target: null, lk: 0, cond: false };
        return { kind: BR.NONE };
    }
    if (opcd === 17) return { kind: BR.SC, target: null, lk: 0, cond: false };
    return { kind: BR.NONE };
}

// Ops that make a loop INELIGIBLE for a single-function structured region.
// Conservative, mirroring prescan_int_self_loop's whitelist philosophy: a false
// "ineligible" only under-counts the opportunity; a false "eligible" would
// overstate it.
function usesFPU(inst) {
    const opcd = inst >>> 26;
    if (opcd === 4) return true;                        // paired single
    if (opcd >= 48 && opcd <= 55) return true;          // lfs/lfsu/lfd/lfdu/stfs/stfsu/stfd/stfdu
    if (opcd === 56 || opcd === 57 || opcd === 60 || opcd === 61) return true; // psq_l/psq_lu/psq_st/psq_stu
    if (opcd === 59 || opcd === 63) return true;        // fp single/double arith
    if (opcd === 31) {
        const sub = (inst >>> 1) & 0x3FF;
        // indexed FP loads/stores
        if ([535, 567, 599, 631, 663, 695, 727, 759, 983, 3].includes(sub)) return true;
    }
    return false;
}

// ---------------------------------------------------------------------------
// Per-function loop analysis.
// ---------------------------------------------------------------------------
function analyzeFunction(addr, size) {
    const end = addr + size;
    const insts = [];
    for (let a = addr; a < end; a += 4) {
        const i = readInst(a);
        if (i === null) return null;                    // not in main.dol (DLL/REL)
        insts.push(i);
    }
    const n = insts.length;
    const br = new Array(n).fill(null);
    let nBranch = 0, nCall = 0, nIndirect = 0, nFp = 0;
    for (let k = 0; k < n; ++k) {
        const d = decodeBranch(insts[k], addr + k * 4);
        if (d.kind !== BR.NONE) {
            br[k] = d;
            nBranch++;
            if (d.lk) nCall++;
            if (d.kind === BR.BCLR || d.kind === BR.BCCTR) nIndirect++;
        }
        if (usesFPU(insts[k])) nFp++;
    }

    // Natural loops = backward branches whose target lies inside this function.
    // Body = [target, branchAddr]. Nested/overlapping loops are all reported;
    // the summary uses the INNERMOST (smallest) loop per back-edge, which is
    // the region-formation unit.
    const loops = [];
    for (let k = 0; k < n; ++k) {
        const d = br[k];
        if (!d || d.target === null || d.lk) continue;
        const bAddr = addr + k * 4;
        if (d.target > bAddr) continue;                 // forward -> not a back-edge
        if (d.target < addr || d.target >= end) continue; // leaves the function
        const t0 = (d.target - addr) / 4;
        // Count what executes in ONE iteration of this loop body.
        let brInBody = 0, callInBody = 0, indirectInBody = 0, fpInBody = 0;
        for (let j = t0; j <= k; ++j) {
            if (br[j]) {
                brInBody++;
                if (br[j].lk) callInBody++;
                if (br[j].kind === BR.BCLR || br[j].kind === BR.BCCTR) indirectInBody++;
            }
            if (usesFPU(insts[j])) fpInBody++;
        }
        // Do all in-body branch targets stay inside the body? (structured-region
        // requirement: side exits are fine, but an in-body branch that lands
        // outside the loop is an EXIT, which a region handles; an in-body branch
        // to an unknown target (bcctr/bclr) is not statically formable.)
        loops.push({
            headAddr: d.target >>> 0,
            tailAddr: bAddr >>> 0,
            instrs: k - t0 + 1,
            branches: brInBody,          // == JIT block boundaries per iteration
            calls: callInBody,
            indirect: indirectInBody,
            fp: fpInBody,
            condBackEdge: d.cond,
        });
    }
    // Innermost loops only: drop any loop that strictly contains another.
    const inner = loops.filter(L =>
        !loops.some(M => M !== L && M.headAddr >= L.headAddr && M.tailAddr <= L.tailAddr &&
            (M.headAddr > L.headAddr || M.tailAddr < L.tailAddr)));
    return { n, nBranch, nCall, nIndirect, nFp, loops, inner };
}

// ---------------------------------------------------------------------------
// Drive over the profile.
// ---------------------------------------------------------------------------
const prof = JSON.parse(fs.readFileSync(PROFILE, 'utf8'));
const rows = prof.rows;
const totalSamples = prof.total;

const out = [];
let cum = 0, analysed = 0, notInDol = 0, notInDolShare = 0;

// Buckets, weighted by sample share.
const B = {
    noLoop: 0,               // function has no natural loop at all
    onlySingleBranchLoop: 0, // every innermost loop is 1 branch/iter -> int_fused territory
    multiBranchEligible: 0,  // has an innermost loop with >=2 branches/iter, no call/indirect in body
    multiBranchWithCall: 0,  // >=2 branches/iter but body contains bl (needs call-bearing regions)
    multiBranchIndirect: 0,  // >=2 branches/iter but body contains bcctr/bclr
    notInDol: 0,
};

for (const r of rows) {
    if (cum >= TOP_SHARE) break;
    cum = r.cumulative;
    const a = analyzeFunction(r.addr >>> 0, r.size);
    if (!a) {
        notInDol++; notInDolShare += r.share; B.notInDol += r.share;
        out.push({ name: r.name, addrHex: r.addrHex, share: r.share, status: 'not-in-main.dol' });
        continue;
    }
    analysed++;
    const inner = a.inner;
    let cls;
    if (inner.length === 0) cls = 'noLoop';
    else {
        const multi = inner.filter(L => L.branches >= 2);
        if (multi.length === 0) cls = 'onlySingleBranchLoop';
        else {
            const clean = multi.filter(L => L.calls === 0 && L.indirect === 0);
            if (clean.length > 0) cls = 'multiBranchEligible';
            else if (multi.some(L => L.indirect > 0 && L.calls === 0)) cls = 'multiBranchIndirect';
            else cls = 'multiBranchWithCall';
        }
    }
    B[cls] += r.share;
    out.push({
        name: r.name, addrHex: r.addrHex, share: r.share, cls,
        instrs: a.n, branches: a.nBranch, calls: a.nCall, indirect: a.nIndirect, fp: a.nFp,
        loops: inner.map(L => ({
            head: '0x' + L.headAddr.toString(16), tail: '0x' + L.tailAddr.toString(16),
            instrs: L.instrs, branches: L.branches, calls: L.calls,
            indirect: L.indirect, fp: L.fp,
        })),
    });
}

// Distribution of branches-per-iteration over eligible innermost loops,
// share-weighted by the containing function.
const dist = new Map();
for (const f of out) {
    if (!f.loops) continue;
    for (const L of f.loops) {
        const k = Math.min(L.branches, 8);
        const e = dist.get(k) || { loops: 0, share: 0 };
        e.loops++; e.share += f.share / f.loops.length;
        dist.set(k, e);
    }
}

const summary = {
    profile: PROFILE, dol: DOL, totalSamples,
    functionsAnalysed: analysed, functionsNotInDol: notInDol,
    cumulativeShareCovered: +cum.toFixed(2),
    shareByClass: Object.fromEntries(Object.entries(B).map(([k, v]) => [k, +v.toFixed(2)])),
    branchesPerIterationDistribution: [...dist.entries()].sort((a, b) => a[0] - b[0])
        .map(([k, v]) => ({ branchesPerIter: k, loops: v.loops, shareWeighted: +v.share.toFixed(2) })),
};

console.error('=== loop_region_coverage ===');
console.error('profile               : ' + PROFILE);
console.error('dol                   : ' + DOL);
console.error('functions analysed    : ' + analysed + '  (share cum ' + cum.toFixed(1) + '%)');
console.error('functions not in DOL  : ' + notInDol + '  (share ' + notInDolShare.toFixed(1) + '%)');
console.error('');
console.error('SHARE OF BOARD SAMPLES BY LOOP CLASS');
for (const [k, v] of Object.entries(B)) {
    console.error('  ' + k.padEnd(24) + (v.toFixed(2) + '%').padStart(8));
}
console.error('');
console.error('BRANCHES PER ITERATION (== JIT block boundaries per iteration)');
for (const d of summary.branchesPerIterationDistribution) {
    console.error('  ' + String(d.branchesPerIter).padStart(2) + ' br/iter : ' +
        String(d.loops).padStart(4) + ' loops, share-weighted ' + d.shareWeighted.toFixed(2) + '%');
}

const OUT = arg('out', '/tmp/loop_region_coverage.json');
fs.writeFileSync(OUT, JSON.stringify({ summary, functions: out }, null, 1));
console.error('\nwrote ' + OUT);

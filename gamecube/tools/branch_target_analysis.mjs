#!/usr/bin/env node
// branch_target_analysis.mjs
//
// For a given function range in the SAB DOL, statically enumerate:
//   - All branch INSTRUCTIONS in [start, end)
//   - All branch TARGETS that fall inside [start, end) (internal targets)
//   - All branch TARGETS that fall outside [start, end) (external = inter-fn)
//   - Whether each internal target has multiple sources (multi-source join)
//   - Whether each internal target is reached by a BACKWARD branch (loop header)
//
// This answers: "If JIT64 splits a block at every branch target, where would
// those splits be?" — without needing to GDB-trace.
//
// PPC branch opcodes considered:
//   op 18 : b / bl / ba / bla  (LI-form, 26-bit signed displacement)
//   op 16 : bc / bcl / bca / bcla (BD-form, 16-bit signed displacement)
//   op 19 .528 : bcctr/bcctrl (target unknowable statically)
//   op 19 .16  : bclr/bclrl   (return — block-end, not a target source)

import fs from 'node:fs';

const ISO_PATH = '/Users/caseybement/Bemental77.github.io/gamecube/roms/Sonic Adventure 2 - Battle (USA).iso';

function readBE32(buf, off) {
    return ((buf[off] << 24) | (buf[off+1] << 16) | (buf[off+2] << 8) | buf[off+3]) >>> 0;
}

const iso = fs.readFileSync(ISO_PATH);
const dolFileOffset = readBE32(iso, 0x420);

const sections = [];
for (let i = 0; i < 18; ++i) {
    const dolRelOff = readBE32(iso, dolFileOffset + i * 4);
    const loadAddr = readBE32(iso, dolFileOffset + 0x48 + i * 4);
    const size     = readBE32(iso, dolFileOffset + 0x90 + i * 4);
    if (size === 0 || loadAddr === 0) continue;
    sections.push({ idx: i, type: i < 7 ? 'text' : 'data',
                    fileOff: dolFileOffset + dolRelOff, loadAddr, size });
}

function pcToFileOff(pc) {
    for (const s of sections) {
        if (pc >= s.loadAddr && pc < s.loadAddr + s.size) {
            return s.fileOff + (pc - s.loadAddr);
        }
    }
    return null;
}

function decodeBranch(inst, pc) {
    const op = (inst >>> 26) & 0x3F;
    if (op === 18) {
        let li = inst & 0x03FFFFFC;
        if (li & 0x02000000) li |= 0xFC000000;
        li = li | 0;
        const aa = (inst & 2) !== 0;
        const lk = (inst & 1) !== 0;
        const target = aa ? (li >>> 0) : ((pc + li) >>> 0);
        return { kind: 'b', target, lk, aa, isReturn: false, isCtr: false,
                 fallthrough: lk };
    }
    if (op === 16) {
        let bd = inst & 0xFFFC;
        if (bd & 0x8000) bd |= 0xFFFF0000;
        bd = bd | 0;
        const aa = (inst & 2) !== 0;
        const lk = (inst & 1) !== 0;
        const bo = (inst >>> 21) & 0x1F;
        const target = aa ? (bd >>> 0) : ((pc + bd) >>> 0);
        const unconditional = ((bo & 0x14) === 0x14);
        return { kind: 'bc', target, lk, aa, bo, isReturn: false, isCtr: false,
                 fallthrough: !unconditional || lk };
    }
    if (op === 19) {
        const xo = (inst >>> 1) & 0x3FF;
        const lk = (inst & 1) !== 0;
        const bo = (inst >>> 21) & 0x1F;
        const unconditional = ((bo & 0x14) === 0x14);
        if (xo === 16) {
            return { kind: 'bclr', lk, bo, isReturn: true, isCtr: false,
                     fallthrough: !unconditional || lk };
        }
        if (xo === 528) {
            return { kind: 'bcctr', lk, bo, isReturn: false, isCtr: true,
                     fallthrough: !unconditional || lk };
        }
    }
    return null;
}

function analyze(name, startPC, sizeBytes) {
    const endPC = startPC + sizeBytes;
    const fileOff = pcToFileOff(startPC);
    if (fileOff === null) {
        console.log(`SKIP ${name}: PC not in DOL`);
        return;
    }

    const branches = [];
    for (let pc = startPC; pc < endPC; pc += 4) {
        const inst = readBE32(iso, fileOff + (pc - startPC));
        const dec = decodeBranch(inst, pc);
        if (dec) branches.push({ pc, inst, dec });
    }

    const internalTargets = new Map();
    function noteTarget(targetPC, sourcePC, kind, isBackward) {
        if (targetPC < startPC || targetPC >= endPC) return;
        if (!internalTargets.has(targetPC)) {
            internalTargets.set(targetPC, {
                sources: [], anyBackward: false, kinds: new Set(),
            });
        }
        const t = internalTargets.get(targetPC);
        t.sources.push({ pc: sourcePC, kind });
        if (isBackward) t.anyBackward = true;
        t.kinds.add(kind);
    }
    noteTarget(startPC, 0xFFFFFFFF, 'entry', false);

    for (const b of branches) {
        const d = b.dec;
        if (d.kind === 'b' && !d.lk) {
            if (d.target !== undefined)
                noteTarget(d.target, b.pc, 'b', d.target <= b.pc);
        } else if (d.kind === 'b' && d.lk) {
            noteTarget(b.pc + 4, b.pc, 'bl-resume', false);
        } else if (d.kind === 'bc') {
            if (d.target !== undefined)
                noteTarget(d.target, b.pc, 'bc', d.target <= b.pc);
            noteTarget(b.pc + 4, b.pc, 'bc-fall', false);
        } else if (d.kind === 'bclr') {
            if (d.fallthrough)
                noteTarget(b.pc + 4, b.pc, 'bclr-fall', false);
        } else if (d.kind === 'bcctr') {
            if (d.fallthrough)
                noteTarget(b.pc + 4, b.pc, 'bcctr-fall', false);
        }
    }

    const sorted = [...internalTargets.entries()].sort((a, b) => a[0] - b[0]);

    console.log(`\n========== ${name} @ 0x${startPC.toString(16)}..0x${endPC.toString(16)} (${sizeBytes / 4} insts) ==========`);
    console.log(`Branch instructions in body: ${branches.length}`);
    console.log(`Internal block-boundary PCs: ${sorted.length}`);
    console.log(`Average block size: ${(sizeBytes / 4 / sorted.length).toFixed(1)} insts\n`);

    console.log(`  PC          src-count  backward?  src-kinds            sources`);
    for (const [tgt, info] of sorted) {
        const back = info.anyBackward ? 'YES' : '   ';
        const kinds = [...info.kinds].join(',');
        const src = info.sources.length;
        const srcStr = info.sources.slice(0, 4).map(s =>
            s.pc === 0xFFFFFFFF ? '(entry)' : `0x${s.pc.toString(16)}`).join(' ');
        console.log(`  0x${tgt.toString(16).padStart(8,'0')}  ${String(src).padStart(2)}         ${back}        ${kinds.padEnd(20)} ${srcStr}${info.sources.length > 4 ? ' ...' : ''}`);
    }

    let backwardOnly = 0, multiSourceOnly = 0, both = 0, single = 0;
    for (const [tgt, info] of sorted) {
        if (tgt === startPC) continue;
        const ms = info.sources.length >= 2;
        const bw = info.anyBackward;
        if (bw && ms) both++;
        else if (bw) backwardOnly++;
        else if (ms) multiSourceOnly++;
        else single++;
    }
    console.log(`\nSplit-rule sensitivity (excluding fn entry):`);
    console.log(`  Total internal boundaries:    ${sorted.length - 1}`);
    console.log(`  Backward-target only:          ${backwardOnly}`);
    console.log(`  Multi-source only:             ${multiSourceOnly}`);
    console.log(`  Both backward+multi-source:    ${both}`);
    console.log(`  Single-source forward only:    ${single}`);
    console.log(`  "split-at-every-target" rule  -> ${sorted.length} blocks`);
    console.log(`  "split-at-backward-tgt"  rule -> ${1 + backwardOnly + both} blocks`);
    console.log(`  "split-at-multi-source"  rule -> ${1 + multiSourceOnly + both} blocks`);

    return { name, startPC, endPC, sorted, branches };
}

const FUNCTIONS = [
    { name: 'OSExceptionInit', pc: 0x800e3970, size: 0x280 },
    { name: 'zz_800d2834_',    pc: 0x800d2834, size: 0x3ec },
    { name: 'zz_800e362c_',    pc: 0x800e362c, size: 0x344 },
];

for (const f of FUNCTIONS) analyze(f.name, f.pc, f.size);

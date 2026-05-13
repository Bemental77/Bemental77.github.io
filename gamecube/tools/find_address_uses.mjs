#!/usr/bin/env node
// find_address_uses.mjs — find any place in the SAB DOL where a target
// address appears as either:
//   (a) 32-bit literal in any section (function pointer in data)
//   (b) lis + ori pair (constructing the address in code)
//   (c) lis + addi pair (signed-add form of constant)
// Identifies callback-table installs and indirect-call targets.

import fs from 'node:fs';

const ISO_PATH = '/Users/caseybement/Bemental77.github.io/gamecube/roms/Sonic Adventure 2 - Battle (USA).iso';

function readBE32(buf, off) {
    return ((buf[off] << 24) | (buf[off+1] << 16) | (buf[off+2] << 8) | buf[off+3]) >>> 0;
}

const target = parseInt(process.argv[2] || '0x800f8468', 16);
console.log(`[find] target address: 0x${target.toString(16)}`);

const targetHi = (target >>> 16) & 0xFFFF;
const targetLo = target & 0xFFFF;
console.log(`[find]   hi=0x${targetHi.toString(16)} lo=0x${targetLo.toString(16)}`);

const iso = fs.readFileSync(ISO_PATH);
const dolFileOffset = readBE32(iso, 0x420);

const allSections = [];
for (let i = 0; i < 18; ++i) {
    const dolRelOff = readBE32(iso, dolFileOffset + i * 4);
    const loadAddr  = readBE32(iso, dolFileOffset + 0x48 + i * 4);
    const size      = readBE32(iso, dolFileOffset + 0x90 + i * 4);
    if (size === 0 || loadAddr === 0) continue;
    allSections.push({
        idx: i, type: i < 7 ? 'text' : 'data',
        fileOff: dolFileOffset + dolRelOff, loadAddr, size,
    });
}

// (a) literal 32-bit pointer in any section.
console.log('\n--- 32-bit literal occurrences ---');
let litCount = 0;
for (const sec of allSections) {
    for (let off = 0; off < sec.size; off += 4) {
        const v = readBE32(iso, sec.fileOff + off);
        if (v === target) {
            console.log(`  [${sec.idx} ${sec.type}] 0x${(sec.loadAddr + off).toString(16)}: 0x${v.toString(16)}`);
            litCount++;
        }
    }
}
console.log(`  ${litCount} literal hits`);

// (b) lis + ori pair: lis rN, hi; ori rN, rN, lo
// lis encoded as: 0x3c000000 | (rN<<21) | hi_imm
// ori encoded as: 0x60000000 | (rA<<21) | (rS<<16) | imm
// We search for an `ori` where imm == lo, and check the previous
// instruction is `lis` with hi_imm == hi and same rN.
console.log('\n--- lis + ori pair (forms target as constant) ---');
let pairCount = 0;
for (const sec of allSections.filter(s => s.type === 'text')) {
    for (let off = 4; off < sec.size; off += 4) {
        const ori = readBE32(iso, sec.fileOff + off);
        const oriOp = (ori >>> 26) & 0x3F;
        if (oriOp !== 24) continue;             // not ori
        const oriImm = ori & 0xFFFF;
        if (oriImm !== targetLo) continue;
        const lis = readBE32(iso, sec.fileOff + off - 4);
        const lisOp = (lis >>> 26) & 0x3F;
        if (lisOp !== 15) continue;              // not lis (= addis ra=0)
        const lisRA = (lis >>> 16) & 0x1F;
        if (lisRA !== 0) continue;               // require RA=0 (lis form)
        const lisImm = lis & 0xFFFF;
        if (lisImm !== targetHi) continue;
        // Check rA of ori == rS of ori == rT of lis
        const lisRT = (lis >>> 21) & 0x1F;
        const oriRA = (ori >>> 21) & 0x1F;
        const oriRS = (ori >>> 16) & 0x1F;
        if (lisRT !== oriRA || oriRA !== oriRS) continue;
        console.log(`  [${sec.idx} ${sec.type}] 0x${(sec.loadAddr + off - 4).toString(16)}: lis r${lisRT}, 0x${targetHi.toString(16)}; ori r${oriRA}, r${oriRS}, 0x${targetLo.toString(16)}`);
        pairCount++;
    }
}
console.log(`  ${pairCount} lis+ori pairs`);

// (c) lis + addi pair: lis rN, hi+1; addi rN, rN, -loSign
// when targetLo has bit 15 set, you'd typically use lis (hi+1) + addi -((-targetLo) & 0xFFFF).
// For target=0x800f8468 with lo=0x8468 (bit 15 set), the common encoding is:
//   lis rN, 0x8010; addi rN, rN, -0x7b98
// Equivalently: lis rN, hi+1; addi rN, rN, simm where simm = (target - ((hi+1) << 16))
console.log('\n--- lis + addi pair (signed form) ---');
let addiCount = 0;
const altHi = (targetHi + 1) & 0xFFFF;
const addiSimm = (target - (altHi << 16)) & 0xFFFF;  // 16-bit signed
for (const sec of allSections.filter(s => s.type === 'text')) {
    for (let off = 4; off < sec.size; off += 4) {
        const addi = readBE32(iso, sec.fileOff + off);
        const addiOp = (addi >>> 26) & 0x3F;
        if (addiOp !== 14) continue;             // not addi
        const addiImm = addi & 0xFFFF;
        if (addiImm !== addiSimm) continue;
        const lis = readBE32(iso, sec.fileOff + off - 4);
        const lisOp = (lis >>> 26) & 0x3F;
        if (lisOp !== 15) continue;
        const lisRA = (lis >>> 16) & 0x1F;
        if (lisRA !== 0) continue;
        const lisImm = lis & 0xFFFF;
        if (lisImm !== altHi) continue;
        const lisRT  = (lis >>> 21) & 0x1F;
        const addiRA = (addi >>> 16) & 0x1F;
        const addiRT = (addi >>> 21) & 0x1F;
        if (lisRT !== addiRA || addiRA !== addiRT) continue;
        console.log(`  [${sec.idx} ${sec.type}] 0x${(sec.loadAddr + off - 4).toString(16)}: lis r${lisRT}, 0x${altHi.toString(16)}; addi r${addiRT}, r${addiRA}, ${(addiSimm < 0x8000 ? addiSimm : addiSimm - 0x10000)}`);
        addiCount++;
    }
}
console.log(`  ${addiCount} lis+addi pairs`);

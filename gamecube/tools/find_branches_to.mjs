#!/usr/bin/env node
// find_branches_to.mjs — find ANY relative branch (b/bl/bcx) targeting
// a given PC. Captures both call (bl) and tail-call (b) targets.

import fs from 'node:fs';

const ISO_PATH = '/Users/caseybement/Bemental77.github.io/gamecube/roms/Sonic Adventure 2 - Battle (USA).iso';

function readBE32(buf, off) {
    return ((buf[off] << 24) | (buf[off+1] << 16) | (buf[off+2] << 8) | buf[off+3]) >>> 0;
}

const target = parseInt(process.argv[2] || '0x800f84ec', 16);
console.log(`[find-branches] target: 0x${target.toString(16)}`);

const iso = fs.readFileSync(ISO_PATH);
const dolFileOffset = readBE32(iso, 0x420);

const textSections = [];
for (let i = 0; i < 7; ++i) {
    const dolRelOff = readBE32(iso, dolFileOffset + i * 4);
    const loadAddr  = readBE32(iso, dolFileOffset + 0x48 + i * 4);
    const size      = readBE32(iso, dolFileOffset + 0x90 + i * 4);
    if (size === 0 || loadAddr === 0) continue;
    textSections.push({ idx: i, fileOff: dolFileOffset + dolRelOff, loadAddr, size });
}

const branches = { b: [], bl: [], bcx: [] };
for (const sec of textSections) {
    for (let off = 0; off < sec.size; off += 4) {
        const inst = readBE32(iso, sec.fileOff + off);
        const op = (inst >>> 26) & 0x3F;
        const callPC = sec.loadAddr + off;

        if (op === 18) {
            // b/bl: 24-bit signed displacement * 4
            if (inst & 0x2) continue;  // AA — absolute, skip
            let disp = (inst & 0x03FFFFFC);
            if (disp & 0x02000000) disp |= 0xFC000000;
            const tgt = (callPC + (disp | 0)) >>> 0;
            if (tgt === target) {
                if (inst & 1) branches.bl.push(callPC);
                else branches.b.push(callPC);
            }
        }
        if (op === 16) {
            // bcx: 14-bit signed displacement * 4
            if (inst & 0x2) continue;
            let disp = inst & 0xFFFC;
            if (disp & 0x8000) disp |= 0xFFFF0000;
            const tgt = (callPC + (disp | 0)) >>> 0;
            if (tgt === target) {
                branches.bcx.push(callPC);
            }
        }
    }
}

console.log(`  bl  (call):     ${branches.bl.length}`);
branches.bl.forEach(pc => console.log(`    bl  @ 0x${pc.toString(16)}`));
console.log(`  b   (jump/tail-call): ${branches.b.length}`);
branches.b.forEach(pc => console.log(`    b   @ 0x${pc.toString(16)}`));
console.log(`  bcx (cond branch):    ${branches.bcx.length}`);
branches.bcx.forEach(pc => console.log(`    bcx @ 0x${pc.toString(16)}`));

#!/usr/bin/env node
// find_callers.mjs — find every `bl` (op 18 with LK=1) in the SAB DOL
// whose target equals a given PC. Used to identify who calls a known
// helper function.

import fs from 'node:fs';

const ISO_PATH = '/Users/caseybement/Bemental77.github.io/gamecube/roms/Sonic Adventure 2 - Battle (USA).iso';

function readBE32(buf, off) {
    return ((buf[off] << 24) | (buf[off+1] << 16) | (buf[off+2] << 8) | buf[off+3]) >>> 0;
}

const targetPC = parseInt(process.argv[2] || '0x800f8468', 16);
console.log(`[find-callers] scanning for bl <target=0x${targetPC.toString(16)}>`);

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

const callers = [];
for (const sec of textSections) {
    for (let off = 0; off < sec.size; off += 4) {
        const inst = readBE32(iso, sec.fileOff + off);
        const op = (inst >>> 26) & 0x3F;
        if (op !== 18) continue;       // not b/bx
        if ((inst & 1) === 0) continue; // not LK
        if ((inst & 2) !== 0) continue; // AA set (absolute) — skip
        // LI = bits 25..2 (24 signed bits), sign-extend, *4
        let li = (inst & 0x03FFFFFC);
        if (li & 0x02000000) li |= 0xFC000000;  // sign-extend 26-bit
        const callPC = sec.loadAddr + off;
        const tgt = (callPC + (li | 0)) >>> 0;
        if (tgt === targetPC) {
            callers.push({ callPC, sec: sec.idx });
        }
    }
}

console.log(`[find-callers] ${callers.length} bl instructions target 0x${targetPC.toString(16)}`);
for (const c of callers) {
    console.log(`  0x${c.callPC.toString(16)}  bl 0x${targetPC.toString(16)}  [section ${c.sec}]`);
}

// For each caller, find its containing function entry.
function findFunctionEntry(pc) {
    const sec = textSections.find(s => pc >= s.loadAddr && pc < s.loadAddr + s.size);
    if (!sec) return null;
    const off = sec.fileOff + (pc - sec.loadAddr);
    for (let back = 4; back < 4096; back += 4) {
        const off2 = off - back;
        if (off2 < sec.fileOff) break;
        const inst = readBE32(iso, off2);
        const op = (inst >>> 26) & 0x3F;
        if (op === 37 && ((inst >>> 21) & 0x1F) === 1 && ((inst >>> 16) & 0x1F) === 1) {
            return pc - back;
        }
    }
    return null;
}

console.log('\n[find-callers] containing functions:');
for (const c of callers) {
    const entry = findFunctionEntry(c.callPC);
    if (entry !== null) {
        console.log(`  caller @ 0x${c.callPC.toString(16)} in function 0x${entry.toString(16)} (offset ${(c.callPC - entry) / 4} insts)`);
    } else {
        console.log(`  caller @ 0x${c.callPC.toString(16)} no stwu prologue within 1024 insts`);
    }
}

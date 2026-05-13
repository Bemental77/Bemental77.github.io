#!/usr/bin/env node
// find_readers.mjs — find every lwz/lhz/lbz that reads from a given
// SDA-relative offset in the SAB DOL.

import fs from 'node:fs';

const ISO_PATH = '/Users/caseybement/Bemental77.github.io/gamecube/roms/Sonic Adventure 2 - Battle (USA).iso';

function readBE32(buf, off) {
    return ((buf[off] << 24) | (buf[off+1] << 16) | (buf[off+2] << 8) | buf[off+3]) >>> 0;
}

const offsetArg = process.argv[2] || '0x8cd8';
const simm = parseInt(offsetArg, 16) & 0xFFFF;
console.log(`[find-readers] scanning for lwz/lhz/lbz r?, 0x${simm.toString(16)}(r13)`);

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

const loads = [
    { op: 32, name: 'lwz' },
    { op: 33, name: 'lwzu' },
    { op: 34, name: 'lbz' },
    { op: 35, name: 'lbzu' },
    { op: 40, name: 'lhz' },
    { op: 41, name: 'lhzu' },
];

const matches = [];
for (const sec of textSections) {
    for (let off = 0; off < sec.size; off += 4) {
        const inst = readBE32(iso, sec.fileOff + off);
        const op = (inst >>> 26) & 0x3F;
        const ra = (inst >>> 16) & 0x1F;
        const imm = inst & 0xFFFF;
        if (ra !== 13) continue;
        if (imm !== simm) continue;
        const ld = loads.find(l => l.op === op);
        if (!ld) continue;
        const rt = (inst >>> 21) & 0x1F;
        matches.push({ pc: sec.loadAddr + off, op: ld.name, rt, sec: sec.idx });
    }
}

console.log(`[find-readers] ${matches.length} matches`);
for (const m of matches) {
    console.log(`  0x${m.pc.toString(16)}  ${m.op} r${m.rt}, 0x${simm.toString(16)}(r13)  [section ${m.sec}]`);
}

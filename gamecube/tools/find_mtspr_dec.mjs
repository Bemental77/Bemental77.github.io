#!/usr/bin/env node
// find_mtspr_dec.mjs — find every mtspr SPR_DEC and mfspr SPR_DEC in SAB DOL.
// SPR_DEC = 22. PPC mtspr/mfspr encode SPR as (low5 << 5) | high5.

import fs from 'node:fs';

const ISO_PATH = '/Users/caseybement/Bemental77.github.io/gamecube/roms/Sonic Adventure 2 - Battle (USA).iso';

function readBE32(buf, off) {
    return ((buf[off] << 24) | (buf[off+1] << 16) | (buf[off+2] << 8) | buf[off+3]) >>> 0;
}

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

// SPR encoding for SPR_DEC=22: low5=22, high5=0 → split = (22<<5)|0 = 0x2C0.
const SPR_DEC_FIELD = 0x2c0;

// mtspr: op=31, xo=467
// mfspr: op=31, xo=339
function decodeXO(inst) {
    return (inst >>> 1) & 0x3FF;
}
function decodeSPR(inst) {
    return (inst >>> 11) & 0x3FF;
}
function decodeRT(inst) {
    return (inst >>> 21) & 0x1F;
}

const mtsprs = [];
const mfsprs = [];
for (const sec of textSections) {
    for (let off = 0; off < sec.size; off += 4) {
        const inst = readBE32(iso, sec.fileOff + off);
        const op = (inst >>> 26) & 0x3F;
        if (op !== 31) continue;
        const xo = decodeXO(inst);
        const spr = decodeSPR(inst);
        if (spr !== SPR_DEC_FIELD) continue;
        const pc = sec.loadAddr + off;
        if (xo === 467) mtsprs.push({ pc, rs: decodeRT(inst), sec: sec.idx });
        if (xo === 339) mfsprs.push({ pc, rt: decodeRT(inst), sec: sec.idx });
    }
}

console.log(`mtspr SPR_DEC (writes): ${mtsprs.length}`);
for (const m of mtsprs) {
    console.log(`  0x${m.pc.toString(16)}  mtspr SPR_DEC, r${m.rs}  [section ${m.sec}]`);
}
console.log(`mfspr SPR_DEC (reads): ${mfsprs.length}`);
for (const m of mfsprs) {
    console.log(`  0x${m.pc.toString(16)}  mfspr r${m.rt}, SPR_DEC  [section ${m.sec}]`);
}

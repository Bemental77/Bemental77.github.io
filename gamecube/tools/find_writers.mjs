#!/usr/bin/env node
// find_writers.mjs — scan SAB DOL for any store instruction targeting a
// given SDA-relative offset (r13-relative). Identifies which function
// writes the polling-loop signal that __start is waiting on.
//
// Usage:
//   node gamecube/tools/find_writers.mjs <signed_offset_hex>
//   node gamecube/tools/find_writers.mjs 0x8c5c       # finds writes to r13+0x8c5c (= -0x73A4)
//
// PowerPC store-form encodings (D-form, ra-relative):
//   stw    rT, simm(rA)    op=36 (0x90)
//   stwu   rT, simm(rA)    op=37 (0x94)
//   sth    rT, simm(rA)    op=44 (0xB0)
//   sthu   rT, simm(rA)    op=45 (0xB4)
//   stb    rT, simm(rA)    op=38 (0x98)
//   stbu   rT, simm(rA)    op=39 (0x9C)
// Mask (inst & 0xFC1FFFFF) == (op<<26 | RA<<16 | simm) — RA=13 (SDA), rT=any.

import fs from 'node:fs';

const ISO_PATH = '/Users/caseybement/Bemental77.github.io/gamecube/roms/Sonic Adventure 2 - Battle (USA).iso';

function readBE32(buf, off) {
    return ((buf[off] << 24) | (buf[off+1] << 16) | (buf[off+2] << 8) | buf[off+3]) >>> 0;
}

const offsetArg = process.argv[2] || '0x8c5c';
const simm = parseInt(offsetArg, 16) & 0xFFFF;
console.log(`[find] scanning for stw/stwu/sth/sthu/stb/stbu r?, 0x${simm.toString(16)}(r13)`);

const iso = fs.readFileSync(ISO_PATH);
const dolFileOffset = readBE32(iso, 0x420);

// Walk all text sections.
const textSections = [];
for (let i = 0; i < 7; ++i) {
    const dolRelOff = readBE32(iso, dolFileOffset + i * 4);
    const loadAddr  = readBE32(iso, dolFileOffset + 0x48 + i * 4);
    const size      = readBE32(iso, dolFileOffset + 0x90 + i * 4);
    if (size === 0 || loadAddr === 0) continue;
    textSections.push({ idx: i, fileOff: dolFileOffset + dolRelOff, loadAddr, size });
}

// Match patterns for each store form, RA=13.
const stores = [
    { op: 36, name: 'stw'   },
    { op: 37, name: 'stwu'  },
    { op: 38, name: 'stb'   },
    { op: 39, name: 'stbu'  },
    { op: 44, name: 'sth'   },
    { op: 45, name: 'sthu'  },
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
        const store = stores.find(s => s.op === op);
        if (!store) continue;
        const rt = (inst >>> 21) & 0x1F;
        const pc = sec.loadAddr + off;
        matches.push({ pc, inst, sec: sec.idx, op: store.name, rt });
    }
}

console.log(`[find] ${matches.length} matches`);
for (const m of matches) {
    console.log(`  0x${m.pc.toString(16)}  ${m.op} r${m.rt}, 0x${simm.toString(16)}(r13)  [section ${m.sec}]`);
}

// For each match, find the enclosing function (walk back to nearest stwu r1
// prologue or just-after-blr boundary).
function findFunctionEntry(pc) {
    const sec = textSections.find(s => pc >= s.loadAddr && pc < s.loadAddr + s.size);
    if (!sec) return null;
    const off = sec.fileOff + (pc - sec.loadAddr);
    for (let back = 4; back < 4096; back += 4) {
        const off2 = off - back;
        if (off2 < sec.fileOff) break;
        const inst = readBE32(iso, off2);
        const op = (inst >>> 26) & 0x3F;
        // stwu r1, neg(r1) — function prologue
        if (op === 37 && ((inst >>> 21) & 0x1F) === 1 && ((inst >>> 16) & 0x1F) === 1) {
            return pc - back;
        }
    }
    return null;
}

console.log('\n[find] function entries for the matches:');
for (const m of matches) {
    const entry = findFunctionEntry(m.pc);
    if (entry !== null) {
        console.log(`  store @ 0x${m.pc.toString(16)} → function entry 0x${entry.toString(16)} (offset ${(m.pc - entry) >>> 0} bytes / ${(m.pc - entry) / 4} insts)`);
    } else {
        console.log(`  store @ 0x${m.pc.toString(16)} → no stwu prologue within 1024 instructions back`);
    }
}

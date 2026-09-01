#!/usr/bin/env node
// dump_sab_pc.mjs — read SAB ISO, find DOL, dump instructions at given PCs.
// Identifies what function lives at a given PC by dumping a 32-instruction
// window and noting any preceding stwu r1 prologue (function entry).

import fs from 'node:fs';
import path from 'node:path';

const ISO_PATH = '/Users/caseybement/Bemental77.github.io/gamecube/roms/Sonic Adventure 2 - Battle (USA).iso';
const PCS_TO_DUMP = (process.argv.slice(2).length > 0)
    ? process.argv.slice(2).map(s => parseInt(s, 16))
    : [0x800f857c, 0x800e78cc, 0x800e80a4, 0x800ebd68, 0x800ebea0,
       0x800e34d0, 0x800e62ec, 0x800ecde4, 0x8010c554];

// DOL section table. The DOL contains 7 text + 11 data sections.
// Each entry: 4-byte big-endian fields, all together at start of DOL.
//   Offset 0x00..0x1B : text section file-offsets (7 × 4)
//   Offset 0x1C..0x47 : data section file-offsets (11 × 4)
//   Offset 0x48..0x63 : text section load addrs   (7 × 4)
//   Offset 0x64..0x8F : data section load addrs   (11 × 4)
//   Offset 0x90..0xAB : text section sizes        (7 × 4)
//   Offset 0xAC..0xD7 : data section sizes        (11 × 4)
//   Offset 0xD8       : BSS load address
//   Offset 0xDC       : BSS size
//   Offset 0xE0       : entry point

function readBE32(buf, off) {
    return ((buf[off] << 24) | (buf[off+1] << 16) | (buf[off+2] << 8) | buf[off+3]) >>> 0;
}

function decodePPC(inst) {
    const op = (inst >>> 26) & 0x3F;
    const hex = '0x' + inst.toString(16).padStart(8, '0');
    if (inst === 0x60000000) return `${hex}  nop`;
    if (inst === 0x4e800020) return `${hex}  blr`;
    if (inst === 0x4e800021) return `${hex}  blrl`;
    if (inst === 0x4e800420) return `${hex}  bctr`;
    if (op === 18) {
        let li = inst & 0x03FFFFFC;
        if (li & 0x02000000) li |= 0xFC000000;
        const lk = inst & 1, aa = inst & 2;
        return `${hex}  ${lk ? 'bl' : 'b'} ${li >= 0 ? '+' : ''}${li|0}`;
    }
    if (op === 16) {
        const bo = (inst >>> 21) & 0x1F;
        let bd = inst & 0xFFFC;
        if (bd & 0x8000) bd |= 0xFFFF0000;
        const lk = inst & 1;
        return `${hex}  bc${lk?'l':''} ${bo} ${bd|0}`;
    }
    if (op === 19) {
        const xo = (inst >>> 1) & 0x3FF;
        if (xo === 16) return `${hex}  bclr (depends on BO)`;
        if (xo === 528) return `${hex}  bcctr`;
        return `${hex}  op19.${xo}`;
    }
    if (op === 14) {
        const rt = (inst >>> 21) & 0x1F;
        const ra = (inst >>> 16) & 0x1F;
        let simm = inst & 0xFFFF; if (simm & 0x8000) simm |= 0xFFFF0000;
        return `${hex}  ${ra === 0 ? 'li' : 'addi'} r${rt}, ${ra === 0 ? '' : 'r' + ra + ', '}${simm|0}`;
    }
    if (op === 15) {
        const rt = (inst >>> 21) & 0x1F;
        return `${hex}  lis r${rt}, 0x${(inst & 0xFFFF).toString(16)}`;
    }
    if (op === 32) {
        const rt = (inst >>> 21) & 0x1F, ra = (inst >>> 16) & 0x1F;
        let simm = inst & 0xFFFF; if (simm & 0x8000) simm |= 0xFFFF0000;
        return `${hex}  lwz r${rt}, ${simm|0}(r${ra})`;
    }
    if (op === 36) {
        const rt = (inst >>> 21) & 0x1F, ra = (inst >>> 16) & 0x1F;
        let simm = inst & 0xFFFF; if (simm & 0x8000) simm |= 0xFFFF0000;
        return `${hex}  stw r${rt}, ${simm|0}(r${ra})`;
    }
    if (op === 37) {
        const rt = (inst >>> 21) & 0x1F, ra = (inst >>> 16) & 0x1F;
        let simm = inst & 0xFFFF; if (simm & 0x8000) simm |= 0xFFFF0000;
        return `${hex}  stwu r${rt}, ${simm|0}(r${ra})`;
    }
    if (op === 31) {
        const xo = (inst >>> 1) & 0x3FF;
        if (xo === 339) return `${hex}  mfspr`;
        if (xo === 467) return `${hex}  mtspr`;
        if (xo === 23)  return `${hex}  lwzx`;
        if (xo === 151) return `${hex}  stwx`;
        if (xo === 467) return `${hex}  mtspr`;
        return `${hex}  op31.${xo}`;
    }
    return `${hex}  op${op}.???`;
}

function looksLikePrologue(inst) {
    const op = (inst >>> 26) & 0x3F;
    // stwu r1, -N(r1) — most common GameCube function prologue
    if (op === 37 && ((inst >>> 21) & 0x1F) === 1 && ((inst >>> 16) & 0x1F) === 1) {
        return true;
    }
    // mflr r0 (0x7c0802a6) — functions that save LR at the start before stwu
    if (inst === 0x7c0802a6) return true;
    return false;
}

const iso = fs.readFileSync(ISO_PATH);
console.log(`[dump] ISO size: ${iso.length.toLocaleString()} bytes`);

// DOL is loaded from disc starting at apploader offset; for the actual game
// DOL we need the disc header pointer at 0x420. Per yagcd ch.13:
//   header[0x420] = main DOL offset (BE u32)
const dolFileOffset = readBE32(iso, 0x420);
console.log(`[dump] DOL file offset: 0x${dolFileOffset.toString(16)}`);

// DOL header is 256 bytes (0x100) starting at dolFileOffset.
// Section "fileOff" fields are DOL-relative; convert to ISO-relative for reads.
const sections = [];
for (let i = 0; i < 18; ++i) {
    const dolRelOff = readBE32(iso, dolFileOffset + i * 4);
    const loadAddr = readBE32(iso, dolFileOffset + 0x48 + i * 4);
    const size     = readBE32(iso, dolFileOffset + 0x90 + i * 4);
    if (size === 0 || loadAddr === 0) continue;
    sections.push({ idx: i, type: i < 7 ? 'text' : 'data', fileOff: dolFileOffset + dolRelOff, loadAddr, size });
}
console.log(`[dump] DOL sections (${sections.length}):`);
for (const s of sections) {
    console.log(`  [${s.idx} ${s.type}] file 0x${s.fileOff.toString(16).padStart(7,'0')}  load 0x${s.loadAddr.toString(16).padStart(8,'0')}  size 0x${s.size.toString(16)}`);
}

function lookup(pc) {
    for (const s of sections) {
        if (pc >= s.loadAddr && pc < s.loadAddr + s.size) {
            return { section: s, fileOff: s.fileOff + (pc - s.loadAddr) };
        }
    }
    return null;
}

for (const pc of PCS_TO_DUMP) {
    console.log('\n=== PC = 0x' + pc.toString(16) + ' ===');
    const r = lookup(pc);
    if (!r) {
        console.log('  not in any DOL section (could be IPL/BIOS or libdolphin/SDK loaded later)');
        continue;
    }
    console.log(`  in section [${r.section.idx} ${r.section.type}] file=0x${r.fileOff.toString(16)}`);
    // Walk backwards to find function prologue (up to 64 instructions back).
    // i=0 checks the PC itself (pc IS the entry), i=1 checks pc-4, etc.
    let prologue = -1;
    for (let i = 0; i <= 64; ++i) {
        const off = r.fileOff - i * 4;
        if (off < r.section.fileOff) break;
        const inst = readBE32(iso, off);
        if (looksLikePrologue(inst)) {
            prologue = pc - i * 4;
            break;
        }
    }
    if (prologue >= 0) {
        if (prologue === pc) {
            console.log(`  function entry: PC is the prologue (mflr/stwu at PC itself)`);
        } else {
            console.log(`  function entry (prologue) appears to be: 0x${prologue.toString(16)}`);
            console.log(`  → distance from PC: ${(pc - prologue) / 4} instructions`);
        }
    } else {
        console.log('  no stwu/mflr prologue found within 64 prior instructions — could be a leaf function or middle of a multi-block function');
    }
    // Dump 8 instructions before, target, 16 after.
    const startOff = Math.max(r.section.fileOff, r.fileOff - 8 * 4);
    const startPC  = pc - (r.fileOff - startOff);
    for (let i = 0; i < 24; ++i) {
        const fOff = startOff + i * 4;
        if (fOff + 4 > r.section.fileOff + r.section.size) break;
        const inst = readBE32(iso, fOff);
        const ipc = startPC + i * 4;
        const marker = (ipc === pc) ? '  <-- PC' : '';
        console.log(`  0x${ipc.toString(16).padStart(8, '0')}: ${decodePPC(inst)}${marker}`);
    }
}

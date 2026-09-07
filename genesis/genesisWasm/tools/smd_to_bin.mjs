#!/usr/bin/env node
/* smd_to_bin.mjs — convert a Super Magic Drive (.smd) Mega Drive dump to a plain
 * big-endian binary (.bin/.gen).
 *
 *   node genesis/genesisWasm/tools/smd_to_bin.mjs <in.smd> <out.bin>
 *
 * SMD is NOT raw ROM. It carries a 512-byte header and stores the cartridge in
 * 16 KiB blocks, each block written as 8192 ODD bytes followed by 8192 EVEN
 * bytes. Feeding one to an emulator as if it were raw gives a ROM whose every
 * byte is in the wrong place — the "SEGA" magic the console checks at 0x100 is
 * not there and nothing boots.
 *
 * The conversion is verified, not assumed: the output must carry ASCII "SEGA"
 * at offset 0x100 (the Mega Drive cartridge header's console name field) or
 * this exits non-zero.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
  console.error('usage: smd_to_bin.mjs <in.smd> <out.bin>');
  process.exit(2);
}

const smd = readFileSync(inPath);
const HEADER = 512;
const BLOCK = 16384;
const HALF = BLOCK / 2;

// SMD header: [0] = block count, [8..9] = 0xAA 0xBB magic.
const magicOk = smd[8] === 0xaa && smd[9] === 0xbb;
const body = smd.length - HEADER;
if (!magicOk) console.error(`warning: no 0xAA 0xBB SMD magic at byte 8/9 (got ${smd[8].toString(16)} ${smd[9].toString(16)})`);
if (body <= 0 || body % BLOCK !== 0) {
  console.error(`error: body ${body} bytes is not a whole number of ${BLOCK}-byte blocks`);
  process.exit(1);
}

const out = Buffer.alloc(body);
for (let b = 0; b * BLOCK < body; b++) {
  const src = HEADER + b * BLOCK;
  const dst = b * BLOCK;
  for (let i = 0; i < HALF; i++) {
    out[dst + i * 2 + 0] = smd[src + HALF + i];   // even bytes: second half
    out[dst + i * 2 + 1] = smd[src + i];          // odd bytes: first half
  }
}

const magic = out.subarray(0x100, 0x104).toString('latin1');
if (magic !== 'SEGA') {
  console.error(`error: de-interleaved image has "${magic}" at 0x100, expected "SEGA"`);
  process.exit(1);
}

writeFileSync(outPath, out);
console.log(`${inPath} (${smd.length} B) -> ${outPath} (${out.length} B)`);
console.log(`0x100: ${JSON.stringify(out.subarray(0x100, 0x130).toString('latin1'))}`);

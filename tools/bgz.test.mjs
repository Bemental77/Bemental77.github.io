#!/usr/bin/env node
// bgz.test.mjs — prove lib/bgz.js reads exactly what tools/bgzip.mjs writes.
//
//   node tools/bgz.test.mjs                       # synthetic fixtures
//   node tools/bgz.test.mjs --real <dir>/<name>   # against real shipped .gz parts
//
// WHAT THIS IS GUARDING. The lazy disc reads a guest byte range by ARITHMETIC —
// find the block, find its compressed extent, Range-fetch, inflate. Every one of
// those steps is an off-by-one waiting to happen, and the failure mode is not an
// exception: it is a disc that hands the SH4 the wrong bytes and crashes deep
// inside the game with no hint of where the corruption came from. That is
// exactly how the 2026-08-27 break presented (parts served as 133-byte Git-LFS
// pointers, first seen as an SH4 crash at boot). So the assertions here are
// byte-comparisons against the original data, not "it didn't throw".
//
// The random-read case matters most: sequential reads hide index bugs, because
// walking blocks in order still lands on the right bytes even if the offsets
// are computed from a running total rather than from the index.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { blockCompress } from './bgzip.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
new Function(fs.readFileSync(path.join(ROOT, 'lib/bgz.js'), 'utf8')).call(globalThis);
const BGZ = globalThis.BGZ;

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')); }
}

// A local stand-in for HTTP Range: hand back exactly the bytes asked for.
function makeRanger(files) {
  return (url, from, to) => files.get(url).subarray(from, to + 1);
}

function roundTrip(label, raw, partSizes, block) {
  const files = new Map();
  const parts = [];
  let off = 0;
  for (let i = 0; i < partSizes.length; i++) {
    const slice = raw.subarray(off, off + partSizes[i]);
    const { buf, clen } = blockCompress(slice, block, 6);
    const url = `${label}.part${i}.bgz`;
    files.set(url, buf);
    parts.push({ url, raw: slice.length, csize: buf.length, clen });
    off += partSizes[i];
  }
  const ix = BGZ.prepare({ format: 'bgz1', name: label, bytes: raw.length, block, parts }, '');
  const range = makeRanger(files);

  // Read guest bytes [pos, pos+len) the way the worker does.
  function read(pos, len) {
    const out = Buffer.alloc(len);
    let done = 0;
    while (done < len) {
      const loc = BGZ.locate(ix, pos + done);
      if (!loc) break;
      const blk = Buffer.from(BGZ.inflateMemberSync(range(loc.url, loc.cFrom, loc.cTo)));
      const inBlk = pos + done - loc.uOff;
      const n = Math.min(blk.length - inBlk, len - done);
      blk.copy(out, done, inBlk, inBlk + n);
      done += n;
    }
    return out.subarray(0, done);
  }

  console.log(`\n${label}: ${raw.length} B raw, ${partSizes.length} part(s), block ${block}`);
  ok('index totals agree', ix.bytes === raw.length);

  // 1. whole-image sequential read
  const whole = read(0, raw.length);
  ok('sequential whole-image read is byte-identical',
     whole.length === raw.length && Buffer.compare(whole, raw) === 0,
     `got ${whole.length} B`);

  // 2. every block boundary, both sides — where off-by-ones live
  let boundaryOk = true, firstBad = null;
  for (let b = block; b < raw.length; b += block) {
    for (const [p, l] of [[b - 3, 6], [b, 4], [b - 1, 2]]) {
      if (p < 0 || p + l > raw.length) continue;
      if (Buffer.compare(read(p, l), raw.subarray(p, p + l)) !== 0) {
        boundaryOk = false; firstBad = firstBad ?? `pos ${p} len ${l}`;
      }
    }
  }
  ok('reads straddling every block boundary match', boundaryOk, firstBad);

  // 3. part seams — a block never straddles a part, so the seam is the risk
  let seamOk = true;
  let acc = 0;
  for (let i = 0; i < partSizes.length - 1; i++) {
    acc += partSizes[i];
    const p = Math.max(0, acc - 5), l = Math.min(10, raw.length - p);
    if (Buffer.compare(read(p, l), raw.subarray(p, p + l)) !== 0) seamOk = false;
  }
  ok('reads straddling every part seam match', seamOk);

  // 4. RANDOM access — the case sequential reading cannot falsify
  let randOk = true, randBad = null;
  let rng = 0x2545f491;
  const rnd = () => ((rng = (rng * 1103515245 + 12345) >>> 0) / 4294967296);
  for (let i = 0; i < 300; i++) {
    const len = 1 + Math.floor(rnd() * 5000);
    const pos = Math.floor(rnd() * Math.max(1, raw.length - len));
    if (Buffer.compare(read(pos, len), raw.subarray(pos, pos + len)) !== 0) {
      randOk = false; randBad = randBad ?? `pos ${pos} len ${len}`;
    }
  }
  ok('300 random reads match', randOk, randBad);

  // 5. tail and past-the-end
  const tail = read(raw.length - 7, 7);
  ok('final 7 bytes match', Buffer.compare(tail, raw.subarray(raw.length - 7)) === 0);
  ok('past-the-end locate() returns null', BGZ.locate(ix, raw.length) === null);

  // 6. next() walks every block exactly once
  let n = 0;
  for (let loc = BGZ.locate(ix, 0); loc; loc = BGZ.next(ix, loc)) n++;
  ok('next() visits every block once', n === BGZ.blockCount(ix), `walked ${n} of ${BGZ.blockCount(ix)}`);

  // 7. a corrupted block is REJECTED, not silently returned short.
  // Clobber a CRC byte of BLOCK 0 specifically — a gzip member's CRC32 sits in
  // its last 8 bytes, so block 0's is at clen[0]-8..clen[0]-5. Corrupting the
  // end of the whole PART file instead would land in the LAST block and the
  // read below would never touch it, which is a test that passes vacuously.
  const anyUrl = parts[0].url;
  const good = files.get(anyUrl);
  const bad = Buffer.from(good); bad[parts[0].clen[0] - 6] ^= 0xff;
  files.set(anyUrl, bad);
  let threw = false;
  try { read(0, Math.min(block, raw.length)); } catch (_) { threw = true; }
  ok('a corrupted block throws rather than returning wrong bytes', threw);
  files.set(anyUrl, good);

  // 8. the index catches a truncated/short part before any read happens
  let idxThrew = false;
  try {
    BGZ.prepare({ format: 'bgz1', name: label, bytes: raw.length, block,
                  parts: parts.map((p, i) => (i === 0 ? { ...p, csize: p.csize - 1 } : p)) }, '');
  } catch (_) { idxThrew = true; }
  ok('index rejects a part whose csize disagrees with its block lengths', idxThrew);
}

// ── fixtures ────────────────────────────────────────────────────────────────
const realArg = process.argv.indexOf('--real');
if (realArg >= 0) {
  const target = process.argv[realArg + 1];
  const dir = path.dirname(target), name = path.basename(target);
  const gz = fs.readdirSync(dir).filter((f) => f.startsWith(name + '.part') && f.endsWith('.gz')).sort();
  if (!gz.length) { console.error(`no ${name}.part*.gz in ${dir}`); process.exit(2); }
  // Only the first two parts — enough to exercise a seam without inflating a
  // whole 1.1 GB track in a unit test.
  const bufs = gz.slice(0, 2).map((f) => zlib.gunzipSync(fs.readFileSync(path.join(dir, f))));
  roundTrip(name, Buffer.concat(bufs), bufs.map((b) => b.length), 262144);
} else {
  // Highly compressible (a GD-ROM's padded high-density area is mostly this).
  const zeros = Buffer.alloc(700000);
  roundTrip('zeros', zeros, [400000, 300000], 65536);

  // Incompressible-ish, and a length that is NOT a multiple of the block.
  const noise = Buffer.alloc(533017);
  let s = 12345;
  for (let i = 0; i < noise.length; i++) { s = (s * 1103515245 + 12345) >>> 0; noise[i] = s >>> 24; }
  roundTrip('noise', noise, [300000, 233017], 65536);

  // Mixed, single part, block larger than the data (one short block only).
  const tiny = Buffer.concat([Buffer.alloc(1000, 0x41), noise.subarray(0, 500)]);
  roundTrip('tiny', tiny, [tiny.length], 262144);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

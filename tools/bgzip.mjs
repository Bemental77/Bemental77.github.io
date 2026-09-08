#!/usr/bin/env node
// bgzip.mjs — BLOCK-GZIP a large disc track so it is BOTH small AND randomly
// addressable over HTTP Range.
//
// WHY THIS EXISTS. Two constraints collided and the loser was the phone user:
//
//   1. GitHub Pages refuses to DEPLOY an artifact over 10 GB (deploy.yml:3-21).
//      Five Dreamcast discs of raw GD-ROM do not fit, so every big track ships
//      gzipped. Measured from origin/prod a4d5dad0, the artifact is
//      9,727,438,169 B = 9.059 GiB — already inside the last GB of the ceiling.
//   2. A whole-file gzip has NO random access. dreamcast.html's lazy disc maps a
//      guest byte range onto a part by ARITHMETIC on part sizes; a gzipped
//      part's bytes are not the disc's bytes, so the page refused to stream any
//      gzipped disc (the refusal it logs is at dreamcast.html, "its parts are
//      gzipped, and range-mapping a compressed part would corrupt the disc").
//
// So a phone starting Gauntlet Legends had to download every part of every
// track before the first frame — the user photographed it stuck at
// "Track5.bin 59.3% · 670/1131 MB".
//
// THE FIX is what bgzip/zran do: compress in fixed-size blocks of UNCOMPRESSED
// data, each block an INDEPENDENT gzip member, and write the block lengths to a
// sidecar index. A read of guest bytes [a,b] then costs one Range fetch of just
// the blocks it touches plus one inflate each — while the total stays within a
// fraction of a percent of whole-file gzip.
//
// MEASURED COST of blocking, level 6, on real Gauntlet parts (99,614,720 B each):
//     part            whole-gzip     block=256KiB          block=64KiB
//     Track3.partaa      3,118,372   3,140,434 (+0.71%)   3,273,065 (+4.96%)
//     Track5.partaa     49,208,772  49,303,601 (+0.19%)  49,619,732 (+0.84%)
// and the index itself is 4 B per block (1,520 B per part at 256 KiB).
//
// ⚠ THE FORMAT IS A CONCATENATION OF GZIP MEMBERS, WHICH IS *NOT* SOMETHING A
// BROWSER WILL INFLATE IN ONE PASS. Verified in Chrome 152 on 2026-09-08:
// DecompressionStream('gzip') handed a 3-member concatenation fails outright
// with "TypeError: Failed to fetch", while the SAME stream's middle member,
// sliced out by byte offset, inflates to exactly the right 65,536 B (checksum
// matched). Node's zlib.gunzipSync accepts the concatenation, so a Node-only
// check would have "passed" and shipped a page that cannot read its own discs.
// Both readers therefore go block-by-block via the index — see lib/bgz.js.
//
// The `.bgz` extension is deliberate and is NOT cosmetic: the old `.gz` parts
// are single-member and a stale cached page must not silently feed one format
// to the other's reader. A stale page asking for `.gz` gets a clean 404 instead.
// GitHub Pages serves an unknown extension as application/octet-stream and
// honours Range on it — verified live on caseybement.com against .cue and
// .state, both "HTTP/2 206 · content-type: application/octet-stream".
//
// USAGE
//   node tools/bgzip.mjs <raw-file> --out <dir> --name <logical-name> \
//        [--part-bytes 99614720] [--block 262144] [--level 6]
//   node tools/bgzip.mjs --from-gz <dir>/<name>   # rebuild from the shipped .gz parts
//
// Writes <name>.part{aa,ab,...}.bgz and <name>.bgzi.json into --out.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const DEFAULT_PART = 99614720;   // the split boundary every existing disc uses
const DEFAULT_BLOCK = 262144;    // 256 KiB — see the measured table above
const DEFAULT_LEVEL = 9;         // ⚠ the shipped .gz parts were made with gzip -9, not the
                                 // gzip(1) default. Measured on Gauntlet Track3.partaa:
                                 // shipped 2,951,408 B; L6 whole 3,118,372; L9 whole 2,951,710.
                                 // Blocking at 256 KiB then costs +6.40% at L6 but only +1.03%
                                 // at L9 — i.e. most of what looked like the price of random
                                 // access was just a weaker compression level.

function suffixes(n) {
  // 'aa','ab',... — the same naming `split -b` produced for the existing parts.
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(String.fromCharCode(97 + Math.floor(i / 26)) + String.fromCharCode(97 + (i % 26)));
  }
  return out;
}

// Compress one part buffer into a run of independent gzip members.
// Returns { buf, clen } where clen[i] is member i's COMPRESSED length, so
// member i lives at byte sum(clen[0..i-1]) and covers uncompressed bytes
// [i*block, min((i+1)*block, raw.length)).
export function blockCompress(raw, block, level) {
  const chunks = [];
  const clen = [];
  for (let o = 0; o < raw.length; o += block) {
    const c = zlib.gzipSync(raw.subarray(o, Math.min(o + block, raw.length)), { level });
    chunks.push(c);
    clen.push(c.length);
  }
  return { buf: Buffer.concat(chunks), clen };
}

function build({ readPart, partCount, partSizes, total, name, outDir, block, level }) {
  fs.mkdirSync(outDir, { recursive: true });
  const sfx = suffixes(partCount);
  const parts = [];
  let cTotal = 0;
  for (let i = 0; i < partCount; i++) {
    const raw = readPart(i);
    if (raw.length !== partSizes[i]) {
      throw new Error(`part ${i} is ${raw.length} B, expected ${partSizes[i]}`);
    }
    const { buf, clen } = blockCompress(raw, block, level);
    const file = `${name}.part${sfx[i]}.bgz`;
    fs.writeFileSync(path.join(outDir, file), buf);
    // A part must stay under GitHub's 100 MB per-file limit, which is the whole
    // reason these files are split at all. Blocking makes a part slightly
    // bigger, so re-assert it here rather than discovering it at push time.
    if (buf.length > 100 * 1000 * 1000) {
      throw new Error(`${file} is ${buf.length} B — over GitHub's 100 MB file limit; lower --part-bytes`);
    }
    parts.push({ url: file, raw: raw.length, csize: buf.length, clen });
    cTotal += buf.length;
    process.stderr.write(`  ${file}  ${raw.length} -> ${buf.length} B (${clen.length} blocks)\n`);
  }
  const idx = { format: 'bgz1', name, bytes: total, block, parts };
  const idxFile = `${name}.bgzi.json`;
  fs.writeFileSync(path.join(outDir, idxFile), JSON.stringify(idx));
  const idxSize = fs.statSync(path.join(outDir, idxFile)).size;
  process.stderr.write(`  ${idxFile}  ${idxSize} B\n`);
  process.stderr.write(`TOTAL ${name}: raw ${total} -> bgz ${cTotal} + index ${idxSize} = ${cTotal + idxSize} B\n`);
  return { idx, cTotal, idxSize };
}

function main(argv) {
  const arg = (k, d) => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : d;
  };
  const block = +arg('--block', DEFAULT_BLOCK);
  const level = +arg('--level', DEFAULT_LEVEL);
  const partBytes = +arg('--part-bytes', DEFAULT_PART);

  const fromGz = arg('--from-gz', null);
  if (fromGz) {
    // Rebuild straight from the shipped single-member .gz parts, so the source
    // of truth is what is deployed today and no raw copy has to exist on disk.
    const dir = path.dirname(fromGz);
    const name = path.basename(fromGz);
    const gzParts = fs.readdirSync(dir)
      .filter((f) => f.startsWith(name + '.part') && f.endsWith('.gz') && !f.endsWith('.bgz'))
      .sort();
    if (!gzParts.length) throw new Error(`no ${name}.part*.gz in ${dir}`);
    const sizes = [];
    let total = 0;
    // Two passes so the index can be written with exact sizes without holding
    // every part in memory at once.
    for (const f of gzParts) {
      const n = zlib.gunzipSync(fs.readFileSync(path.join(dir, f))).length;
      sizes.push(n);
      total += n;
    }
    const outDir = arg('--out', dir);
    return build({
      readPart: (i) => zlib.gunzipSync(fs.readFileSync(path.join(dir, gzParts[i]))),
      partCount: gzParts.length, partSizes: sizes, total, name, outDir, block, level,
    });
  }

  const src = argv.find((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--out' &&
    argv[argv.indexOf(a) - 1] !== '--name' && argv[argv.indexOf(a) - 1] !== '--block' &&
    argv[argv.indexOf(a) - 1] !== '--level' && argv[argv.indexOf(a) - 1] !== '--part-bytes');
  if (!src) {
    process.stderr.write('usage: bgzip.mjs <raw-file> --out <dir> --name <name> | --from-gz <dir>/<name>\n');
    process.exit(2);
  }
  const name = arg('--name', path.basename(src));
  const outDir = arg('--out', path.dirname(src));
  const total = fs.statSync(src).size;
  const partCount = Math.ceil(total / partBytes);
  const sizes = [];
  for (let i = 0; i < partCount; i++) sizes.push(Math.min(partBytes, total - i * partBytes));
  const fd = fs.openSync(src, 'r');
  try {
    return build({
      readPart: (i) => {
        const b = Buffer.alloc(sizes[i]);
        fs.readSync(fd, b, 0, sizes[i], i * partBytes);
        return b;
      },
      partCount, partSizes: sizes, total, name, outDir, block, level,
    });
  } finally { fs.closeSync(fd); }
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));

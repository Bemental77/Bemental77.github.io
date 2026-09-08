#!/usr/bin/env node
// bgz_verify.mjs — does the .bgz layout reconstruct the SAME disc as the .gz it
// replaces? Hash equality, whole file, both ways of reading it.
//
// WHY A HASH AND NOT A SPOT CHECK. The failure this guards against is not a
// crash, it is a disc that loads and then hands the SH4 subtly wrong bytes —
// which surfaces as an unexplained hang somewhere deep in a game, with nothing
// pointing back at the loader. That is exactly how the 2026-08-27 break
// presented (parts deployed as 133-byte Git-LFS pointers, first seen as an SH4
// crash at boot). A spot check passes on a disc that is wrong everywhere else.
//
// THREE readings are compared, because they are the three that ship:
//   gz    — inflate the old single-member parts (what production serves today)
//   bgz-seq  — walk every block of the new parts in order (the EAGER path)
//   bgz-rand — read the same bytes through BGZ.locate in a scattered order
//              (the LAZY path). Sequential reading cannot falsify an index bug:
//              walking blocks in order lands on the right bytes even when the
//              offsets are computed from a running total rather than the index.
//
// USAGE
//   node tools/bgz_verify.mjs dreamcast/discs/gauntlet/Track3.bin
//   node tools/bgz_verify.mjs --all
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
new Function(fs.readFileSync(path.join(ROOT, 'lib/bgz.js'), 'utf8')).call(globalThis);
const BGZ = globalThis.BGZ;

function verify(target) {
  const dir = path.dirname(target), name = path.basename(target);
  const gzParts = fs.readdirSync(dir)
    .filter((f) => f.startsWith(name + '.part') && f.endsWith('.gz') && !f.endsWith('.bgz')).sort();
  const idxPath = path.join(dir, name + '.bgzi.json');
  if (!fs.existsSync(idxPath)) { console.log(`SKIP ${target} — no ${name}.bgzi.json`); return true; }
  const ix = BGZ.prepare(JSON.parse(fs.readFileSync(idxPath, 'utf8')), '');

  // Reading a part's compressed bytes off disk, the stand-in for HTTP Range.
  const partBuf = new Map();
  const loadPart = (p) => {
    if (!partBuf.has(p.url)) partBuf.set(p.url, fs.readFileSync(path.join(dir, p.url)));
    return partBuf.get(p.url);
  };

  console.log(`\n${target}`);
  console.log(`  index: ${ix.bytes} B, block ${ix.block}, ${ix.parts.length} parts, ` +
              `${BGZ.blockCount(ix)} blocks`);

  // 1. the OLD reading — hash the disc as production assembles it today
  let gzTotal = 0;
  const hGz = crypto.createHash('sha256');
  for (const f of gzParts) {
    const raw = zlib.gunzipSync(fs.readFileSync(path.join(dir, f)));
    hGz.update(raw); gzTotal += raw.length;
  }
  const digestGz = hGz.digest('hex');

  // 2. the EAGER reading — every block in order
  let seqTotal = 0;
  const hSeq = crypto.createHash('sha256');
  for (const p of ix.parts) {
    const buf = loadPart(p);
    for (let i = 0; i < p.clen.length; i++) {
      const m = BGZ.inflateMemberSync(buf.subarray(p.cOff[i], p.cOff[i + 1]));
      hSeq.update(m); seqTotal += m.length;
    }
    partBuf.delete(p.url);          // one part resident at a time
  }
  const digestSeq = hSeq.digest('hex');

  // 3. the LAZY reading — the same bytes, located block by block, in a
  //    deliberately scattered order, then reassembled. Done over a sample
  //    rather than the whole track: the point is to falsify the INDEX
  //    arithmetic, and a few thousand scattered reads do that as well as a
  //    billion sequential ones while staying inside memory.
  let randOk = true, randBad = null, randRead = 0;
  let rng = 0x9e3779b9;
  const rnd = () => ((rng = (rng * 1103515245 + 12345) >>> 0) / 4294967296);
  const cache = new Map();
  const blockAt = (loc) => {
    if (!cache.has(loc.key)) {
      const buf = loadPart(loc.part);
      cache.set(loc.key, BGZ.inflateMemberSync(buf.subarray(loc.cFrom, loc.cTo + 1)));
      if (cache.size > 64) cache.delete(cache.keys().next().value);
    }
    return cache.get(loc.key);
  };
  // Ground truth for a scattered read: inflate the ONE .gz part that owns it.
  const gzCache = new Map();
  const gzPartAt = (pos) => {
    let acc = 0;
    for (let i = 0; i < gzParts.length; i++) {
      const n = ix.parts[i].raw;
      if (pos < acc + n) {
        if (!gzCache.has(i)) {
          gzCache.clear();
          gzCache.set(i, zlib.gunzipSync(fs.readFileSync(path.join(dir, gzParts[i]))));
        }
        return { buf: gzCache.get(i), base: acc };
      }
      acc += n;
    }
    return null;
  };
  for (let t = 0; t < 400 && randOk; t++) {
    const len = 1 + Math.floor(rnd() * 40000);
    const pos = Math.floor(rnd() * Math.max(1, ix.bytes - len));
    const got = Buffer.alloc(len);
    let done = 0;
    while (done < len) {
      const loc = BGZ.locate(ix, pos + done);
      if (!loc) break;
      const blk = Buffer.from(blockAt(loc));
      const inB = pos + done - loc.uOff;
      const n = Math.min(blk.length - inB, len - done);
      blk.copy(got, done, inB, inB + n);
      done += n;
    }
    const g = gzPartAt(pos);
    if (!g) continue;
    const off = pos - g.base;
    if (off + len > g.buf.length) continue;      // straddles a part; covered by bgz.test.mjs
    randRead++;
    if (Buffer.compare(got, g.buf.subarray(off, off + len)) !== 0) {
      randOk = false; randBad = `pos ${pos} len ${len}`;
    }
  }

  const okLen = gzTotal === seqTotal && seqTotal === ix.bytes;
  const okHash = digestGz === digestSeq;
  console.log(`  gz   ${gzTotal} B  sha256 ${digestGz.slice(0, 16)}…`);
  console.log(`  bgz  ${seqTotal} B  sha256 ${digestSeq.slice(0, 16)}…`);
  console.log(`  lengths agree with the index: ${okLen ? 'YES' : 'NO'}`);
  console.log(`  SHA-256 identical (gz vs bgz sequential): ${okHash ? 'YES' : 'NO'}`);
  console.log(`  ${randRead} scattered reads via the index: ${randOk ? 'all match' : 'MISMATCH at ' + randBad}`);

  const gzSize = gzParts.reduce((s, f) => s + fs.statSync(path.join(dir, f)).size, 0);
  const bgzSize = ix.parts.reduce((s, p) => s + p.csize, 0) + fs.statSync(idxPath).size;
  console.log(`  on disk: gz ${gzSize} -> bgz+index ${bgzSize} B ` +
              `(${bgzSize >= gzSize ? '+' : ''}${(((bgzSize - gzSize) / gzSize) * 100).toFixed(2)}%)`);
  return okLen && okHash && randOk;
}

const targets = process.argv.includes('--all')
  ? ['pso2/Track3.bin', 'cannonspike/Track3.bin', 'sa2/Track3.bin',
     'gauntlet/Track3.bin', 'gauntlet/Track5.bin', 'mvc2/MvC2.cdi']
      .map((p) => path.join(ROOT, 'dreamcast/discs', p))
  : process.argv.slice(2).filter((a) => !a.startsWith('--'));
let allOk = true;
for (const t of targets) allOk = verify(t) && allOk;
console.log(`\n${allOk ? 'ALL VERIFIED' : 'VERIFICATION FAILED'}`);
process.exit(allOk ? 0 : 1);

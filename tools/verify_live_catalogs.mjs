#!/usr/bin/env node
// DOES EVERY URL THE GAME CATALOGS NAME ACTUALLY RESOLVE ON THE LIVE ORIGIN?
//
// WHY THIS EXISTS, AND WHY IT IS NOT tools/verify_deploy_assets.mjs.
// That check asks "is this file present in the artifact?" and it PASSED at
// "67 present · 0 MISSING" while four of five Dreamcast games were 404ing in
// production — every file it knew about existed, the catalog simply named
// different ones. File-existence cannot see that. Neither can it see the class
// of break this file was written for: the library now lives on a DIFFERENT
// REPO's Pages site (Bemental77/gamedata, same origin, /gamedata/...), so
// "present in _deploy" is no longer even the right question for a ROM. The only
// question that survives both is:
//
//     does every URL the catalog NAMES resolve, on the origin a visitor uses?
//
// ⚠ GET, NEVER HEAD. GitHub Pages answers HEAD with 200 even for paths where it
// honours Range on GET, so a HEAD probe cannot tell a working streaming asset
// from a broken one. Every request here is a real GET carrying
// `Range: bytes=0-0`, and the response code is read as evidence:
//
//   206  the byte range was served      — the streaming disc path works
//   200  the whole file came back       — Range NOT honoured for this URL
//   404  the catalog names a dead URL   — the founding bug
//
// A 200 is a HARD FAIL for any part of a block-gzip disc. dreamcast.html's
// lazy path issues Range requests per block; against a 200 it would pull the
// entire track for every block, which on a phone is the exact stall the .bgz
// format was built to remove — restored silently, and only in production.
//
// USAGE
//   node tools/verify_live_catalogs.mjs                     # live origin, working-tree catalogs
//   node tools/verify_live_catalogs.mjs --origin http://localhost:8080
//   node tools/verify_live_catalogs.mjs --ref origin/prod   # catalogs as DEPLOYED
//   node tools/verify_live_catalogs.mjs --limit 40          # sample N urls per catalog
//
// ⚠ SOURCE/TARGET COHERENCE. Reading working-tree catalogs while probing the
// live origin conflates two different questions — "is production broken now?"
// and "will it break once I ship this?". `--ref` answers the first, the default
// answers the second. The report always says which was asked.

import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { extractAll, selfTest, assetBase } from './catalog_urls.mjs';

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const ORIGIN = (arg('--origin', 'https://caseybement.com')).replace(/\/$/, '');
const REF = arg('--ref', null);
const LIMIT = Number(arg('--limit', 0)) || 0;
const CONC = Number(arg('--concurrency', 8)) || 8;

// A checker that cannot fail on the bug it was written for is decoration.
selfTest();

const read = (p) => {
  if (REF) {
    try { return execSync(`git show ${REF}:${p}`, { encoding: 'utf8', maxBuffer: 64 << 20 }); }
    catch { return null; }
  }
  try { return readFileSync(new URL('../' + p, import.meta.url), 'utf8'); } catch { return null; }
};

const { urls, faults, unreadable } = extractAll(read);

// Range is not a nicety for these: the block-gzip reader seeks inside the part
// with per-block Range requests. Anything else is allowed to answer 200.
const rangeCritical = new Set(
  urls.filter(([u, why]) => /\.bgz$/.test(u) && /\.parts\[\]$/.test(why)).map(([u]) => u));

let sample = urls;
if (LIMIT) {
  const bySrc = new Map();
  for (const pair of urls) {
    const k = pair[1].split(' ')[0];
    if (!bySrc.has(k)) bySrc.set(k, []);
    bySrc.get(k).push(pair);
  }
  sample = [...bySrc.values()].flatMap((v) => v.slice(0, LIMIT));
}

async function probe([url, why]) {
  const target = ORIGIN + url.split('/').map(encodeURIComponent).join('/').replace(/%2F/g, '/');
  try {
    const r = await fetch(target, { headers: { Range: 'bytes=0-0' }, redirect: 'follow' });
    // Drain, or the socket is held open and later probes queue behind it.
    await r.arrayBuffer().catch(() => {});
    return { url, why, status: r.status, cr: r.headers.get('content-range') || '' };
  } catch (e) {
    return { url, why, status: 0, cr: '', err: e.message };
  }
}

const results = [];
let next = 0;
await Promise.all(Array.from({ length: CONC }, async () => {
  while (next < sample.length) results.push(await probe(sample[next++]));
}));

const dead = results.filter((r) => r.status === 0 || r.status >= 400);
const noRange = results.filter((r) => r.status === 200 && rangeCritical.has(r.url));
const ok = results.filter((r) => r.status === 206 || r.status === 200);

const bases = [`lib/asset_base.js: ASSET_BASE=${JSON.stringify(assetBase(read))}` +
               '  (the ONE constant; every page loads it)'];

console.log(`[live-catalogs] origin=${ORIGIN}`);
console.log(`[live-catalogs] catalogs read from ${REF ? `git ${REF} (as DEPLOYED)` : 'the WORKING TREE (as it would ship)'}`);
for (const b of bases) console.log(`               ${b}`);
console.log(`[live-catalogs] ${results.length} of ${urls.length} catalog URL(s) probed` +
            (LIMIT ? ` (--limit ${LIMIT} per catalog)` : '') +
            ` · ${ok.length} resolve · ${dead.length} DEAD · ${noRange.length} NO-RANGE`);

const byStatus = results.reduce((m, r) => (m[r.status] = (m[r.status] || 0) + 1, m), {});
console.log(`               status histogram: ${JSON.stringify(byStatus)}`);
for (const u of unreadable) console.log(`  unreadable ${u} — its catalog contributed NOTHING to this run`);
for (const f of faults) console.log(`  CATALOG    ${f}`);
for (const r of dead.slice(0, 40)) {
  console.log(`  DEAD ${r.status || r.err}  ${r.url}\n       named by: ${r.why}`);
}
if (dead.length > 40) console.log(`  … and ${dead.length - 40} more dead URLs`);
for (const r of noRange.slice(0, 20)) {
  console.log(`  NO-RANGE 200  ${r.url}\n       named by: ${r.why}\n       This is a block-gzip disc part. The lazy reader Range-seeks inside it;\n       a 200 makes every block pull the WHOLE part.`);
}

// An unreadable catalog is not a pass. Neither is a structural fault.
if (unreadable.length || faults.length || dead.length || noRange.length) {
  console.error(`\n[live-catalogs] FAIL — ` +
    [dead.length && `${dead.length} dead URL(s)`,
     noRange.length && `${noRange.length} range-critical URL(s) answered 200`,
     faults.length && `${faults.length} catalog fault(s)`,
     unreadable.length && `${unreadable.length} unreadable catalog(s)`].filter(Boolean).join(', '));
  process.exit(1);
}
console.log('[live-catalogs] PASS');

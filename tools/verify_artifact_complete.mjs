#!/usr/bin/env node
// DID EVERY FILE THAT SHOULD BE IN THE ARTIFACT ACTUALLY GET THERE?
//
// WHY THIS EXISTS. The deploy job no longer checks out the whole repository: the
// game library moved to a separate Pages repo, and a plain checkout would still
// DOWNLOAD ~9 GB of it (measured on run 34290489234, checkout alone was 345 s of
// a 960 s deploy). So the checkout is now blobless + sparse.
//
// That is a real speedup and a real hazard. A sparse checkout that omits a path
// by mistake does not fail — `rsync` simply copies nothing for it, prints a
// clean summary, and the artifact silently ships without a file the site needs.
// That is the same silent-omission shape as the two production 404s that
// tools/verify_deploy_assets.mjs was written for (dolphin_captures/sab.map and
// n64/bementalJIT/mips_emit.js), and it would be undetectable from the
// artifact's own contents.
//
// The invariant that closes it: EVERY TRACKED FILE THAT deploy.exclude DOES NOT
// EXCLUDE MUST EXIST IN THE ARTIFACT. Both halves are derived — the tracked list
// from `git ls-files`, the exclusions from deploy.exclude via the SAME matcher
// tools/deploy_should_run.mjs uses. Nothing is hand-listed here, so there is no
// list to drift.
//
// USAGE
//   git ls-files -z | node tools/verify_artifact_complete.mjs _deploy
//   node tools/verify_artifact_complete.mjs _deploy          # runs git ls-files itself

import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { excluderFromExcludeFile } from './deploy_should_run.mjs';

const root = process.argv[2] || '_deploy';

// ⚠ Read stdin ASYNCHRONOUSLY. readFileSync(0) on a pipe throws EAGAIN when the
// writer has not filled the buffer yet, which fails the check for a reason that
// has nothing to do with the artifact.
async function trackedFiles() {
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    if (raw.length) return raw.split('\0').filter(Boolean);
  }
  return execSync('git ls-files -z', { encoding: 'utf8', maxBuffer: 256 << 20 })
    .split('\0').filter(Boolean);
}

const files = await trackedFiles();
// An empty list would make this check pass vacuously, which is the failure mode
// it exists to prevent. The repo has thousands of tracked files; zero means the
// caller is broken, not that everything is fine.
if (files.length < 100) {
  console.error(`[artifact-complete] FATAL: only ${files.length} tracked file(s) were supplied. ` +
                `Refusing to report a result on an obviously-truncated list — a vacuous PASS ` +
                `here would hide exactly the omission this check exists to catch.`);
  process.exit(2);
}

const isExcluded = excluderFromExcludeFile();
const expected = files.filter((f) => !isExcluded(f));
const missing = expected.filter((f) => !existsSync(join(root, f)));

console.log(`[artifact-complete] ${files.length} tracked · ${files.length - expected.length} excluded · ` +
            `${expected.length} expected in the artifact · ${missing.length} MISSING`);

if (missing.length) {
  for (const f of missing.slice(0, 40)) console.log(`  MISSING  ${f}`);
  if (missing.length > 40) console.log(`  … and ${missing.length - 40} more`);
  console.error(
    `\n[artifact-complete] FAIL — ${missing.length} tracked file(s) that deploy.exclude does NOT\n` +
    `exclude are absent from the artifact. The usual cause is the sparse-checkout in\n` +
    `.github/workflows/deploy.yml not materialising a path: it is DERIVED from the\n` +
    `OFFSITE block of deploy.exclude, so check that block and the derivation step.\n` +
    `Do NOT "fix" this by adding the paths to deploy.exclude — that would delete them\n` +
    `from the site to silence the alarm.\n`);
  process.exit(1);
}
console.log('[artifact-complete] PASS');

#!/usr/bin/env node
// DID THIS PUSH CHANGE ANYTHING THE SITE ACTUALLY SERVES?
//
// WHY. A Pages deploy of this repo costs a full artifact upload of the whole
// site — measured on run 34241436456: checkout 199 s, stage 74 s, upload 328 s,
// deploy 217 s, 821 s total, for a ~9.9 GB artifact. And a large share of
// pushes cannot change one served byte: two of the six commits before this one
// touched ONLY tools/, which deploy.exclude has never shipped. Those runs moved
// nothing and cancelled each other on the way (the pages concurrency group has
// cancel-in-progress).
//
// ⚠ THE OBVIOUS IMPLEMENTATION IS THE BUG WE JUST SHIPPED. A `paths-ignore:`
// list in the workflow would be a SECOND hand-maintained copy of the exclude
// list, free to drift from the first — and a drifted copy here does not merely
// deploy something extra, it SILENTLY SKIPS a deploy that was needed, which is
// invisible until a user reports that the site did not change. That is the same
// two-sources-of-truth defect that left a phone offering one disc of five. So
// this reads deploy.exclude, the exact file rsync is given as --exclude-from,
// and nothing else.
//
// USAGE  node tools/deploy_should_run.mjs <changed-file> ...
//        echo "$FILES" | node tools/deploy_should_run.mjs
// Prints `deploy=true|false` plus the reason. Exit 0 either way; the caller
// reads the value. FAILS OPEN: anything unexpected prints deploy=true, because
// a needless deploy costs minutes and a skipped one ships nothing.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const EXCLUDE = path.join(ROOT, 'deploy.exclude');

// rsync pattern semantics, and only the subset this file uses:
//   * a pattern containing a leading '/' is anchored at the transfer root
//   * a pattern with no '/' matches ANY path component at any depth
//   * '*' matches within a component
// The `--exclude='/tools'` / `--exclude='gamecube/tools'` distinction in the
// original list depends on exactly this, so it is implemented rather than
// approximated.
function toRegExp(pat) {
  const anchored = pat.startsWith('/');
  const body = anchored ? pat.slice(1) : pat;
  const rx = body.split('/').map((seg) =>
    seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')
  ).join('/');
  // Match the pattern as a whole path component (or run of components),
  // followed by end-of-path or a '/' — an excluded DIRECTORY excludes its
  // contents, which is what rsync does and what every directory entry here means.
  return new RegExp(anchored ? `^${rx}(/|$)` : `(^|/)${rx}(/|$)`);
}

export function load() {
  const txt = fs.readFileSync(EXCLUDE, 'utf8');
  return txt.split('\n').map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((p) => ({ pat: p, rx: toRegExp(p) }));
}

// Exported so other checkers apply the SAME rsync-semantics matcher against the
// SAME file. tools/verify_artifact_complete.mjs uses it to assert that every
// tracked, non-excluded file survived into the artifact — reimplementing the
// matcher there would be the second copy this whole file exists to avoid.
export function excluderFromExcludeFile() {
  const rules = load();
  return (f) => rules.find((r) => r.rx.test(f)) || null;
}

function main(files) {
  let rules;
  try { rules = load(); } catch (e) {
    console.log('deploy=true');
    console.log(`reason=could not read deploy.exclude (${e.message}) — failing open`);
    return;
  }
  if (!files.length) {
    console.log('deploy=true');
    console.log('reason=no file list was supplied — failing open');
    return;
  }
  // ⚠ THE LIST ITSELF, AND THE WORKFLOW, ALWAYS FORCE A DEPLOY. Editing
  // deploy.exclude changes WHAT IS SERVED even when no page changed — dropping a
  // pattern publishes a directory that was hidden, adding one removes it — so a
  // rule that filtered its own edits out would let exactly that change never
  // reach the site. Same for the workflow that performs the copy.
  const FORCE = ['deploy.exclude', '.github/workflows/deploy.yml'];
  const forced = files.filter((f) => FORCE.includes(f));
  if (forced.length) {
    console.log('deploy=true');
    console.log(`reason=${forced.join(', ')} changed — that changes what the site serves`);
    return;
  }
  const kept = [];
  for (const f of files) {
    const hit = rules.find((r) => r.rx.test(f));
    if (!hit) kept.push(f);
  }
  if (kept.length) {
    console.log('deploy=true');
    console.log(`reason=${kept.length} of ${files.length} changed file(s) are served by the site`);
    kept.slice(0, 25).forEach((f) => console.log(`  serves: ${f}`));
    if (kept.length > 25) console.log(`  … and ${kept.length - 25} more`);
  } else {
    console.log('deploy=false');
    console.log(`reason=all ${files.length} changed file(s) are excluded from the deploy artifact`);
    files.slice(0, 25).forEach((f) => console.log(`  excluded: ${f}`));
    if (files.length > 25) console.log(`  … and ${files.length - 25} more`);
  }
}

// Imported for the matcher alone? Then do not run the CLI.
const invokedDirectly = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
let argv = process.argv.slice(2);
if (!invokedDirectly) { /* imported as a module — no CLI side effects */ }
else if (argv.length) main(argv);
else {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { buf += d; });
  process.stdin.on('end', () => main(buf.split('\n').map((s) => s.trim()).filter(Boolean)));
}

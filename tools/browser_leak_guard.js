// Stop puppeteer harnesses from leaving Chrome running after they die.
//
// WHY THIS EXISTS — measured 2026-09-01, and it invalidated a lot of work.
// Seven orphaned Chrome instances from a run 2 days 17 hours earlier were still
// resident. Two were spinning an emulator page continuously and had accumulated
// 832 and 815 CPU-MINUTES; the summed process trees burned 230.3% of CPU. So
// every "the box is quiet, load ~7" reading in this project was taken on a
// machine that was NOT quiet, and a long run of matched pairs was voided for
// "load contamination" whose largest single source was our own harnesses.
//
// ⚠ THE OBVIOUS FIX IS A PLACEBO, AND IT WAS TESTED BEFORE BEING BELIEVED.
// The first version of this file installed exit/uncaughtException/signal
// handlers that closed the browser. A discriminating test — launch, then throw
// before close() — showed the browser cleaned up in BOTH the guarded and
// unguarded arms, because **puppeteer already installs its own exit handlers**.
// A guard whose arms do not differ is decoration, so that version was discarded
// rather than shipped.
//
// ★ THE REAL MECHANISM, isolated by test: **the browser survives a SIGKILLed
// parent.** Verified directly — parent node killed with -9 while a browser was
// live, and `ps -p <browser>` still showed it running afterwards. SIGKILL is
// uncatchable, so NO in-process handler can ever fix this. And SIGKILL is
// exactly how a background task or an agent harness gets stopped, which is why
// the orphans accumulated across days rather than being cleaned by an atexit.
//
// SO THE FIX IS OUT OF PROCESS: every guarded browser records its own PID and
// its owner's PID in a registry file. `reap()` kills any registered browser
// whose OWNER IS GONE — which is precisely the orphan condition and cannot be
// confused with a live run.
//
// USAGE
//   const guard = require('<repo>/tools/browser_leak_guard.js');
//   const browser = await puppeteer.launch({...});
//   guard.guard(browser);            // one line after launch
//
//   node tools/browser_leak_guard.js reap    # kill orphans; safe to run anytime
//   node tools/browser_leak_guard.js list    # show what is registered
//
// `reap` is safe to run while other harnesses are working: a browser whose owner
// process is alive is never touched, so it cannot kill a sibling agent's run —
// and it never touches a Chrome it did not register, so the user's own browser
// is out of scope by construction.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const REGISTRY = path.join(os.tmpdir(), 'bemental-browser-registry.json');

function readRegistry() {
  try { return JSON.parse(fs.readFileSync(REGISTRY, 'utf8')); } catch (_e) { return []; }
}
function writeRegistry(rows) {
  try { fs.writeFileSync(REGISTRY, JSON.stringify(rows, null, 1)); } catch (_e) {}
}
function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** Track a browser so an orphan can be reaped after this process is SIGKILLed. */
function guard(browser, label) {
  if (!browser || typeof browser.process !== 'function') return browser;
  const proc = browser.process();
  if (!proc || !proc.pid) return browser;
  const row = {
    browserPid: proc.pid,
    ownerPid: process.pid,
    label: label || path.basename(process.argv[1] || 'unknown'),
    startedAt: new Date().toISOString(),
  };
  const rows = readRegistry().filter((r) => r.browserPid !== row.browserPid);
  rows.push(row);
  writeRegistry(rows);

  // Best-effort de-registration on a clean exit. This is a tidiness measure, NOT
  // the mechanism — reap() works purely from the owner-is-dead test, so a row
  // left behind by a SIGKILL is handled correctly without it.
  const drop = () => {
    if (typeof browser.on === 'function') { /* no-op guard for double-drop */ }
    writeRegistry(readRegistry().filter((r) => r.browserPid !== row.browserPid));
  };
  try { browser.on('disconnected', drop); } catch (_e) {}
  process.on('exit', drop);
  return browser;
}

/** Kill every registered browser whose OWNER process is gone. Returns a report. */
function reap(opts) {
  const dryRun = !!(opts && opts.dryRun);
  const rows = readRegistry();
  const kept = [], killed = [], stale = [];
  for (const r of rows) {
    if (!alive(r.browserPid)) { stale.push(r); continue; }   // already gone
    if (alive(r.ownerPid)) { kept.push(r); continue; }       // live run — do not touch
    if (!dryRun) { try { process.kill(r.browserPid, 'SIGKILL'); } catch (_e) {} }
    killed.push(r);
  }
  if (!dryRun) writeRegistry(kept);
  return { killed, kept, stale, registry: REGISTRY };
}

function list() { return { rows: readRegistry(), registry: REGISTRY }; }

module.exports = { guard, reap, list, REGISTRY, _alive: alive };

if (require.main === module) {
  const cmd = process.argv[2] || 'list';
  if (cmd === 'reap' || cmd === 'reap:dry') {
    const rep = reap({ dryRun: cmd === 'reap:dry' });
    console.log(`[leak-guard] ${cmd}: killed=${rep.killed.length} kept-live=${rep.kept.length} already-gone=${rep.stale.length}`);
    rep.killed.forEach((r) => console.log(`  killed browser ${r.browserPid} (owner ${r.ownerPid} gone) from ${r.label} started ${r.startedAt}`));
    rep.kept.forEach((r) => console.log(`  kept   browser ${r.browserPid} (owner ${r.ownerPid} ALIVE) from ${r.label}`));
  } else {
    const l = list();
    console.log(`[leak-guard] registry ${l.registry} — ${l.rows.length} row(s)`);
    l.rows.forEach((r) => console.log(`  browser ${r.browserPid} owner ${r.ownerPid} ${alive(r.ownerPid) ? 'ALIVE' : 'GONE'} ${r.label} ${r.startedAt}`));
  }
}

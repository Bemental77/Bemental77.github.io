#!/usr/bin/env node
// ============================================================================
// audit_all.mjs — THE STANDING AUDITOR. One runner, every harness, one verdict.
// ============================================================================
//
// WHY THIS EXISTS
// ---------------
// Before this file, `ls .github/workflows/` held exactly one workflow
// (deploy.yml) and the only test invocation anywhere in CI was one line —
// `node tools/verify_deploy_assets.mjs`, which runs against the STAGED DEPLOY
// ARTIFACT and only after a push to `prod`. Everything else in tools/ ran when,
// and only when, a human remembered to type it. "The tests passed" therefore
// meant "the tests I happened to remember", and regressions shipped.
//
// This runner does not add a single assertion of its own. It calls the existing
// harnesses exactly as they are documented, in one order, and prints one table.
// Every harness in the repo is either RUN here or NAMED in NOT_RUN below with
// the reason — so a gap is a line you can read, not a silence.
//
// SERIAL, NEVER PARALLEL. CLAUDE.md is explicit about why: a parallel campaign
// drove this box to load 83.93, at which point every measurement in flight is
// uninterpretable, and matched-pair noise has been +-25% at load 11-23. So the
// harnesses run one at a time, the 1-minute load average is printed at the
// start and the end, and `browser_leak_guard.js reap` runs on both ends
// (orphaned Chromes from SIGKILLed harnesses were the single largest source of
// that load — two of them had accumulated 832 and 815 CPU-MINUTES).
//
// USAGE
//   node tools/audit_all.mjs                 # everything runnable here
//   node tools/audit_all.mjs --fast          # skip the emulator-boot harnesses
//   node tools/audit_all.mjs --ci            # only what a CI runner can honour
//   node tools/audit_all.mjs --only netplay,seqlock
//   node tools/audit_all.mjs --skip device-matrix,mp-page
//   node tools/audit_all.mjs --list          # print the table and exit
//
// ENV
//   CHROME_PATH   path to Chrome. If unset, one is resolved and exported to
//                 every child, because most harnesses default to the macOS
//                 bundle path and a Linux runner has no such file.
//   ORIGIN        default http://localhost:8080 (CLAUDE.md gate #2 — the port
//                 is not negotiable and this file never invents another).
//   AUDIT_JSON    machine-readable output path (default /tmp/audit-all.json)
//
// EXIT   0 = every harness that ran passed. Non-zero = at least one FAILED.
//        A SKIP is never a pass: it is printed as SKIP with its reason, and
//        counted separately in the summary.
//
// SERVER. Most browser harnesses need the site on :8080. If nothing answers
// there this starts `npm run web` itself and stops it again on the way out,
// including on SIGINT/SIGTERM. If something is already answering it is left
// completely alone — a sibling agent may own it.
//
// ⚠ `npm run web` IS `node tools/devserver.mjs` (package.json:8) — NOT
// `python3 -m http.server 8080`, which is `npm run web:simple` (package.json:11).
// These two lines used to say it was the python one, and the difference is
// load-bearing rather than cosmetic: python's server ignores HTTP Range and
// answers 200 with the whole file, so on it the block-gzip streaming-disc path
// silently falls back to eager and `live-catalogs` — whose whole contract is
// "every disc part answers 206 rather than 200" — would go red for the server
// rather than for the catalog. CLAUDE.md gate #2 states the same distinction.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = process.env.ORIGIN || 'http://localhost:8080';
const JSON_OUT = process.env.AUDIT_JSON || '/tmp/audit-all.json';

// ---------------------------------------------------------------------------
// THE HARNESS TABLE — declared, not discovered.
// ---------------------------------------------------------------------------
// Every field is load-bearing:
//   file      the harness on disk. Checked before anything runs; one that is
//             absent gets its own MISSING verdict, never a quiet skip.
//   cmd       exactly the documented invocation. This runner does not improvise
//             flags or environments beyond what each harness's own header says.
//   desc      one line: what a PASS from this harness actually means.
//   fast      in the `--fast` set (npm test). Excludes anything that boots an
//             emulator core or downloads a disc.
//   ci        runnable on a GitHub runner. When false, `ciWhy` says why, and
//             the workflow prints that reason so the gap stays visible.
//   server    needs the site served on :8080.
//   requires  repo paths whose ABSENCE makes the harness un-runnable (ROMs,
//             discs, cores). Missing -> SKIP with the missing path named.
//   judge     optional. Two harnesses (n64_boot_test, n64_page_test) emit a
//             JSON line and DO NOT set an exit code, so the runner has to read
//             their verdict out of stdout. Everything else is judged on its
//             own exit status and nothing here second-guesses it.
//   timeoutMs kill and FAIL(timeout) past this. Sized from each harness's own
//             documented internal waits (e.g. DCMP_BOOT_MS defaults to 300 s).

const MIN = 60_000;

const HARNESSES = [
  // ---- static gates: no browser, no server, no assets ---------------------
  {
    name: 'preflight',
    file: 'tools/preflight_all.sh',
    cmd: ['bash', 'tools/preflight_all.sh'],
    desc: 'the 10 no-browser gates: index-collapse guard, agent-worktree bound, SAB cell-collision audit, leaf-inline corpus + mutation matrix, n64 emitter corpus, seqlock, ringbuffer, deploy assets, and "every harness still parses"',
    fast: true, ci: true, server: false, requires: [], timeoutMs: 10 * MIN,
  },
  {
    name: 'undelivered',
    file: 'tools/undelivered.mjs',
    cmd: ['node', 'tools/undelivered.mjs'],
    desc: 'the OPEN WORK — what was promised and is not built, printed on every audit run with the evidence for why each is still open. Asked directly, "how come the auditor let you stop working?": because every other harness answers "is the built thing broken" and NONE answers "what have we not built". A gap left the moment it stopped being spoken about. Each entry carries a verify() that must FAIL while the gap is real, so an entry that silently goes out of date fails the gate instead of quietly lying',
    fast: true, ci: true, server: false, requires: [], timeoutMs: 2 * MIN,
  },
  {
    name: 'netplay-invariants',
    file: 'tools/netplay_invariants.mjs',
    cmd: ['node', 'tools/netplay_invariants.mjs'],
    desc: 'the six code SHAPES that produced user-visible netplay failures, asserted statically — no browser rig can catch these, because a rig only ever drives a HEALTHY room and these only appear when a piece of room state is MISSING. Covers: an unseated console must not drive port 0 (it took over Player 1), the party status must REPLACE the Ready/Play buttons rather than describe them (there is no ready click any more — every console declares itself and the room starts by itself, so the cell now asserts the buttons are gone and the party sentences and seat-state words are present), a WebRTC \'disconnected\' blip must be a grace period and not unseat a player mid-download, the barrier must hold a host who is alone, declaring ready must be visible before the barrier releases (it was circular), class Lockstep must own the disc it publishes in the roster (it read a field only NetplaySession had, so every roster carried game:null), Lockstep events the page listens for on the Session must be forwarded (room-game never arrived), and a joiner must never publish the room\'s disc. ⚠ WHAT IT DOES NOT COVER, named here because a gap has to be a line you can read: ROSTER_REKNOCK_MS — the 20 s SELF RE-KNOCK a guest performs before the room starts when it has heard no roster (lib/netplay.js:1276, guarded at :3120-3121), added by commit ee6e50a0 alongside DISCONNECT_GRACE_MS. The grace period has a cell here (tools/netplay_invariants.mjs:76-83) and `rosterStale` — a DIFFERENT, 9 s flag — has cells in tools/netplay_lockstep_test.mjs:585-608, but the re-knock itself has zero assertions anywhere, static or behavioural: `grep -rn -i reknock tools/ dreamcast/tools/ gamecube/tools/` returns nothing (measured 2026-09-14). The cell it wants sits next to the grace cell: _reknock exists, is gated on ROSTER_REKNOCK_MS, and fires only pre-start. The behavioural arm belongs on room_crossdevice_test\'s late-joiner',
    fast: true, ci: true, server: false, requires: ['dreamcast.html', 'lib/netplay.js'], timeoutMs: 2 * MIN,
  },
  {
    name: 'message-judge',
    file: 'tools/netplay_message_judge.mjs',
    cmd: ['node', 'tools/netplay_message_judge.mjs'],
    // THE ONE GATE HERE THAT JUDGES MEANING RATHER THAN SHAPE. Every other
    // netplay harness asserts EXACT STRINGS, so a reworded message passes all of
    // them and a new message is covered by nothing. The defects that reached the
    // user were bad sentences, not missing ones: 24ee7ffc ("the page told a
    // player their emulator had stopped while it was running fine"), the frozen
    // "Waiting for someone to join..." screen behind netplay-signalling, and the
    // hand-written nonce guard in console-room-crossdevice.
    // It asks TypeSafe System One (Jev) four questions about every player-facing
    // sentence the pages can show, and RATCHETS: a recorded baseline, with only
    // new-or-worsened sentences failing. Its regression deltas are measured, not
    // chosen — two runs over the identical tree moved a score by at most
    // 0.110/0.060/0.050/0.160, and each delta sits clear of its own ceiling.
    desc: 'every sentence the pages can show a player, judged for a leaked internal identifier, a dead end with no next step, blaming the player, and jargon — a ratchet against tools/netplay_message_baseline.json, so existing debt is reported and only new or worsened wording fails',
    fast: true, ci: false,
    ciWhy: 'it calls the TypeSafe API and needs TYPESAFE_API_KEY, which CI does not carry; it SKIPs with that reason stated rather than failing',
    server: false, requires: ['tools/netplay_message_baseline.json'], requiresEnv: ['TYPESAFE_API_KEY'],
    timeoutMs: 5 * MIN,
  },
  {
    name: 'message-judge-pairs',
    file: 'tools/netplay_message_judge.mjs',
    cmd: ['node', 'tools/netplay_message_judge.mjs', '--pairs', '/tmp/console-xdev/xdev.json'],
    // ARM B, and it is a different question from the row above. That one judges
    // a sentence on its own; this one judges a sentence AGAINST THE ROOM IT WAS
    // SHOWN IN, from pairs console-room-crossdevice captured. It is the only
    // gate here that can see 24ee7ffc's defect — a page saying the emulator had
    // stopped while it was running fine — because that fault is invisible in the
    // sentence and only appears beside the state.
    // Proven on synthetic pairs: a "stopped" sentence over two playing seats
    // reads 0.80, "waiting for another player" over a full room 0.86, and THE
    // SAME waiting sentence over a genuinely waiting room 0.10 — so the verdict
    // tracks the pair, not the wording. It also caught "lsx budget exceeded on
    // the ls channel" at 0.70, which `a-stall-fail-never-shows-a-nonce` cannot
    // see at all: that cell greps for a 16-hex peer id and this leak has none.
    desc: 'the party sentence judged AGAINST the room state the rig captured — contradiction, and engine vocabulary surviving into what the player reads; needs a console-room-crossdevice run to have produced /tmp/console-xdev/xdev.json',
    fast: false, ci: false,
    ciWhy: 'needs both a TypeSafe key and a completed console-room-crossdevice run; it SKIPs with the reason stated rather than failing',
    server: false,
    requires: ['/tmp/console-xdev/xdev.json', 'tools/netplay_message_baseline.json'],
    requiresEnv: ['TYPESAFE_API_KEY'],
    timeoutMs: 5 * MIN,
  },
  {
    name: 'delay-stepdown',
    file: 'tools/delay_stepdown_test.mjs',
    cmd: ['node', 'tools/delay_stepdown_test.mjs'],
    desc: 'the input delay can come back DOWN after a stall ratchet, at a frame that cannot fork the room',
    fast: true, ci: true, server: false, requires: ['dreamcast.html', 'lib/netplay.js'], timeoutMs: 2 * MIN,
  },
  {
    name: 'multiplayer-page',
    file: 'tools/multiplayer_page_test.mjs',
    cmd: ['node', 'tools/multiplayer_page_test.mjs'],
    desc: 'the one-URL lobby (multiplayer.html) copies every console\'s game list and hands off to six pages — this parses its catalogue and each page\'s live ROMS[]/romSelect, in order, and FAILS on drift (lib/netplay.js refuses a pairing whose game names differ, so a drifted key fails the room with "the other player is on <game>"); it also proves each page\'s ?np= receiver reads every parameter the lobby sends, incl. host=1 on the cartridge pages',
    fast: true, ci: true, server: false, requires: ['multiplayer.html'], timeoutMs: 2 * MIN,
  },
  {
    name: 'multiplayer-page-browser',
    file: 'tools/multiplayer_page_browser_test.mjs',
    cmd: ['node', 'tools/multiplayer_page_browser_test.mjs'],
    desc: 'the one-URL lobby driven in Chrome: every control reachable (the [hidden] trap that hid a minted code on dreamcast_multiplayer.html), Open a party mints a code and an invite link, Start and Join really NAVIGATE to each of the six console pages under that exact code and game (navigations answered 204 so nothing boots), an invite link opened cold on a phone lands on one Join button, and a browser without WebRTC gets the explanation and no controls',
    fast: true, ci: true, server: true, requires: ['multiplayer.html'], timeoutMs: 8 * MIN,
  },
  {
    name: 'gc-np-handoff',
    file: 'tools/gc_np_handoff_test.mjs',
    cmd: ['node', 'tools/gc_np_handoff_test.mjs'],
    desc: 'gamecube.html honours the lobby hand-off: ?np=<code>&game=<label>[&join=1] preselects the ROM on both selects (and persists it), mounts the shared lobby under THAT code on the right side, and a link naming a game not on the page still mounts and says so',
    fast: true, ci: true, server: true, requires: ['gamecube.html', 'lib/netplay-ui.js'], timeoutMs: 8 * MIN,
  },
  {
    name: 'undefined-calls',
    file: 'tools/undefined_call_scan.mjs',
    cmd: ['node', 'tools/undefined_call_scan.mjs'],
    desc: 'every project-shaped call on a shipped page resolves to a definition reachable at runtime — the gate for the class that cost gamecube.html ALL controller input (gcNetRemoteMask and two more were called and defined nowhere; the page parsed fine and pollController threw before it could post input or re-arm its loop)',
    fast: true, ci: true, server: false, requires: [], timeoutMs: 2 * MIN,
  },
  {
    // ADDED 2026-09-13 by an audit that found it run by NOBODY. It is a gate —
    // its own header says so ("--check verifies the stamps match the files on
    // disk and exits nonzero if not, which is what makes this a GATE rather
    // than a step someone has to remember") — and it was in neither HARNESSES
    // nor NOT_RUN. It was also invisible to this file's own `undeclared()`
    // sweep, whose tools/ patterns only match *_test.mjs / *.test.* /
    // audit_*.mjs; that blind spot is widened below.
    //
    // WHY IT MATTERS MORE THAN ITS SIZE SUGGESTS: caseybement.com sends
    // cache-control max-age=600 on the pages AND the shared libs, so a device
    // that loaded inside that window keeps running the OLD lib/netplay.js
    // against the NEW page. That is not hypothetical — it is the run where an
    // emulated phone with a cache bypass loaded the disc and parked at the
    // barrier while the user's real phone sat at "0% loaded" on the same URL.
    // Every shared lib is therefore loaded as `?v=<content hash of HEAD>`.
    //
    // ⚠ AND ITS LIB LIST HAS A HOLE THIS RUNNER CANNOT FIX FROM HERE, ONE COMMIT
    // FROM BITING. stamp_lib_versions.mjs:27 is ['lib/netplay.js',
    // 'lib/asset_base.js','lib/capability.js','lib/bgz.js'] — lib/netplay-ui.js
    // is NOT in it, while gamecube.html:28 loads it as
    // `/lib/netplay-ui.js?v=66f15769`. MEASURED 2026-09-14:
    // `git show HEAD:lib/netplay-ui.js | md5` = 66f15769f60a695cf3f17be7b3e15081,
    // which the stamp matches, but the WORKING TREE reads 1e5d9259c6a9e9b53a48
    // b305e532611d — a sibling agent's uncommitted edit. The moment that lands,
    // gamecube.html's stamp names bytes that no longer exist and THIS GATE
    // PASSES ANYWAY, because the file it would have to check is not in its list.
    // So the one file that IS the party component (its own header: the
    // '__start__' path is kept "purely as a fallback for a console running a
    // cached copy of this file") is the one shared lib with no stamp gate.
    // ⚠ ONE CORRECTION TO A CLAIM MADE ABOUT THIS: it is ONE page, not four.
    // `grep -rn "netplay-ui.js" --include='*.html' .` returns a <script> tag on
    // gamecube.html:28 and nothing else — dreamcast_multiplayer.html,
    // gamecube_multiplayer.html and multiplayer.html mention the file only in
    // PROSE COMMENTS (dreamcast_multiplayer.html:47-48,170;
    // gamecube_multiplayer.html:15; multiplayer.html:52,186), and load it not at
    // all. The hole is real and it is one page wide.
    name: 'lib-version-stamps',
    file: 'tools/stamp_lib_versions.mjs',
    cmd: ['node', 'tools/stamp_lib_versions.mjs', '--check'],
    desc: 'every `?v=<hash>` a page hangs on a shared lib still names the bytes at HEAD — the gate against a 10-minute CDN cache serving an OLD lib/netplay.js to one device while the other runs the new one, which is how one phone sat at "0% loaded" while an emulated phone on the same URL reached the barrier. ⚠ it does NOT cover lib/netplay-ui.js (see the note above this entry)',
    fast: true, ci: true, server: false, requires: [], timeoutMs: 2 * MIN,
  },
  {
    name: 'seqlock',
    file: 'gamecube/seqlock.test.mjs',
    cmd: ['node', 'gamecube/seqlock.test.mjs'],
    desc: 'SAB seqlock primitive: tear-free cross-worker read/write, overflow, readInto (the SAB smoke test named in CLAUDE.md; also inside preflight)',
    fast: true, ci: true, server: false, requires: [], timeoutMs: 2 * MIN,
  },
  {
    name: 'ringbuffer',
    file: 'gamecube/ringbuffer.test.mjs',
    cmd: ['node', 'gamecube/ringbuffer.test.mjs'],
    desc: 'SAB ring buffer: push/pop across handles and 100 wrap cycles (the second SAB smoke test named in CLAUDE.md; also inside preflight)',
    fast: true, ci: true, server: false, requires: [], timeoutMs: 2 * MIN,
  },
  {
    name: 'n64-emit-unit',
    file: 'tools/n64_emit_unit_test.mjs',
    cmd: ['node', 'tools/n64_emit_unit_test.mjs'],
    desc: 'bementalJIT MIPS emitter unit corpus — runs n64/bementalJIT/mips_emit.js outside a browser and executes the blocks it emits (also inside preflight)',
    fast: true, ci: true, server: false,
    requires: ['n64/bementalJIT/mips_emit.js'], timeoutMs: 5 * MIN,
  },
  {
    name: 'deploy-assets',
    file: 'tools/verify_deploy_assets.mjs',
    cmd: ['node', 'tools/verify_deploy_assets.mjs', '.'],
    desc: 'every runtime asset the pages fetch survives the deploy rsync exclude list — the check that caught dolphin_captures/sab.map and n64/bementalJIT/mips_emit.js 404ing in production (also inside preflight)',
    // ⚠ ci:false, AND THAT IS A CONFESSION RATHER THAN A CONVENIENCE. It was
    // ci:true with requires:[], so in CI it reported
    //     MISSING /dreamcast/discs/{mvc2,pso2,sa2}/*.bgzi.json
    //     [deploy-assets] FAIL — 6 runtime asset(s) referenced by shipped code are absent
    // every single run — not because anything was wrong, but because the CI
    // checkout deliberately omits dreamcast/discs (2.7 GB). A gate that is red
    // for a reason unrelated to the change is worse than no gate: it trains
    // everyone to scroll past it, and this one WAS scrolled past while four of
    // five Dreamcast games were genuinely 404ing on production.
    // `requires` now makes it SKIP with a stated reason when the discs are not
    // checked out, instead of failing. The arm that actually catches a broken
    // catalog is a post-deploy check against the live origin, because the fault
    // is a URL the page NAMES that does not resolve — which no file-existence
    // check on a partial checkout can ever see.
    fast: true, ci: false,
    ciWhy: 'it walks assets under dreamcast/discs and gamecube/roms, which the size-bounded CI checkout omits; running it there reports MISSING for files that exist and are deployed, which is a permanent false red',
    server: false, requires: ['dreamcast/discs/gauntlet'], timeoutMs: 5 * MIN,
  },
  {
    // THE ARM THE ENTRY ABOVE SAYS IS MISSING. deploy-assets asks "is the file
    // present?"; it PASSED at "67 present · 0 MISSING" while four of five
    // Dreamcast games 404'd in production, because the catalog had been changed
    // to name DIFFERENT files and every file it knew about still existed.
    // This asks the only question that catches that: does every URL the catalogs
    // NAME actually resolve? All five catalogs are expanded from their own
    // source (tools/catalog_urls.mjs), including the .map()-built disc part
    // names and the character-code-built ROM chunk names that no static regex
    // can recover.
    //
    // ⚠ It runs against the LOCAL server here, not the live origin. Locally it
    // proves the catalogs are internally consistent with the files on disk —
    // which is what a pre-push gate can honestly assert. The live-origin arm is
    // the same command with --origin, run after a deploy, and it is the only
    // thing that can see a production 404.
    name: 'live-catalogs',
    file: 'tools/verify_live_catalogs.mjs',
    cmd: ['node', 'tools/verify_live_catalogs.mjs', '--origin', 'http://localhost:8080'],
    desc: 'every URL the five game catalogs NAME resolves, with a real ranged GET (never HEAD — Pages answers HEAD 200 even where it honours Range only on GET), and every block-gzip disc part answers 206 rather than 200',
    fast: true, ci: false,
    ciWhy: 'it resolves all 207 catalog URLs, which live under the ROM and disc libraries the size-bounded CI checkout does not carry; against the live origin it is a POST-deploy check, not a pre-merge one',
    server: true,
    requires: ['dreamcast/discs/gauntlet', 'gamecube/roms', 'ps1/ps1Wasm/roms', 'n64/N64Wasm/roms', 'gba/gbaWasm/roms'],
    timeoutMs: 10 * MIN,
  },
  {
    name: 'dc-core-drift',
    file: 'dreamcast/tools/verify_core_tree.sh',
    cmd: ['bash', 'dreamcast/tools/verify_core_tree.sh'],
    desc: 'the Dreamcast drift gate: the 34 ported files under dreamcast/flycast-src still differ from upstream 4be8a48 in the ways they are meant to (eight of them silently reverted on 2026-09-07 and killed the boot)',
    fast: true, ci: false,
    ciWhy: 'dreamcast/flycast-src is a 23,628-file vendored tree that is gitignored apart from the 34 ported files, and the gate compares against a NESTED upstream checkout that is not in the repo — a CI runner has neither',
    server: false, requires: ['dreamcast/flycast-src'], timeoutMs: 5 * MIN,
  },

  // ---- light browser: local server, no ROM, no core -----------------------
  {
    name: 'netplay',
    file: 'tools/netplay_test.mjs',
    cmd: ['node', 'tools/netplay_test.mjs'],
    desc: 'lib/netplay.js pairs two real page contexts over a real RTCPeerConnection and carries video, audio and input between them',
    fast: true, ci: true, server: true, requires: ['lib/netplay.js'], timeoutMs: 8 * MIN,
  },
  {
    name: 'netplay-ui',
    file: 'tools/netplay_ui_test.mjs',
    cmd: ['node', 'tools/netplay_ui_test.mjs'],
    desc: 'the pre-party: two players pair and see each other BEFORE any game loads, and the control renders nothing at all on a browser that cannot do it',
    fast: true, ci: true, server: true, requires: ['lib/netplay-ui.js'], timeoutMs: 8 * MIN,
  },
  {
    name: 'netplay-attack',
    file: 'tools/netplay_attack_test.mjs',
    cmd: ['node', 'tools/netplay_attack_test.mjs'],
    desc: 'an uninvited peer that KNOWS the room code gets no picture, no sound, no SDP, no input path and no save — measured at each place it would leak — while the invited player still works end to end',
    fast: true, ci: true, server: true, requires: ['lib/netplay.js'], timeoutMs: 10 * MIN,
  },
  {
    name: 'netplay-signalling',
    file: 'tools/netplay_signalling_test.mjs',
    cmd: ['node', 'tools/netplay_signalling_test.mjs'],
    desc: 'a broken signalling broker produces a message a person can act on, not the frozen "Waiting for someone to join..." screen a real user sat on',
    fast: true, ci: true, server: true, requires: ['lib/netplay.js'], timeoutMs: 8 * MIN,
  },
  {
    name: 'netplay-relay',
    file: 'tools/netplay_relay_check.mjs',
    cmd: ['node', 'tools/netplay_relay_check.mjs'],
    desc: 'relay-only ICE: with NETPLAY_TURN set the configured relay must carry a whole session; without one, both sides must SAY the direct path is blocked instead of hanging',
    fast: true, ci: true, server: true, requires: ['lib/netplay.js'], timeoutMs: 8 * MIN,
  },
  {
    name: 'audio-tap-selftest',
    file: 'tools/audio_tap_selftest.mjs',
    cmd: ['node', 'tools/audio_tap_selftest.mjs'],
    desc: 'proves tools/audio_tap.js is not a placebo — five arms with ground truth known by construction, which the tap must report DIFFERENTLY before any "this page has no audio" verdict is admissible',
    fast: true, ci: true, server: true,
    requires: ['tools/audio_tap.js', 'tools/fixtures/audio_selftest.html'], timeoutMs: 8 * MIN,
  },
  // ⚠ RETIRED — THE BUG CLASS IS GONE, NOT THE TEST'S NERVE. This compared each
  // emulator page's control tables against its *_multiplayer.html twin, and it
  // earned its keep: it caught genesis with 4 of 6 face buttons swapped, n64
  // with L and Z swapped, and gamecube binding Start to pad index 7 so RT opened
  // the pause menu while Start did nothing.
  //
  // Those pages no longer map controls. Under lockstep every player runs their
  // own core, so the lobby pages became redirects that hand a room code to the
  // real emulator page — genesis_multiplayer.html is 59 lines now, and all seven
  // carry ZERO of GP/KEYMAP/B/D. There is exactly one control table per console,
  // so there is nothing left to drift, and the harness fails with "declaration
  // `B` not found" because it is looking for tables that were deleted.
  //
  // Kept in NOT_RUN rather than deleted: if a second control table ever appears
  // on any console, this is the check to bring back, and tools/no_streaming_test.mjs
  // is what would notice the architecture regressing far enough to need it.
  {
    name: 'mobile-chrome',
    file: 'tools/mobile_chrome_test.mjs',
    cmd: ['node', 'tools/mobile_chrome_test.mjs'],
    desc: 'the phone chrome is reachable in BOTH orientations — the reported "hamburger flashes and disappears on portrait" was a synthesised ghost click landing on whatever the pointerdown handler had just opened, plus a full-screen #rotateHint on six pages',
    fast: false, ci: false,
    ciWhy: 'it presses each page’s own mobile Start and waits for that page’s live seam (up to 300 s per page across seven emulator pages), so it boots every core against the ROM and disc libraries the CI checkout does not carry',
    server: true,
    requires: ['ps1/ps1Wasm/roms', 'snes/snesWasm/roms', 'gba/gbaWasm/roms', 'genesis/genesisWasm', 'n64/N64Wasm/roms', 'dreamcast/discs'],
    timeoutMs: 45 * MIN,
  },
  {
    name: 'mobile-gamelist',
    file: 'tools/mobile_gamelist_test.mjs',
    cmd: ['node', 'tools/mobile_gamelist_test.mjs'],
    desc: 'every page with a mobile ROM picker offers the SAME games and labels as its desktop picker, and the mobile <select> has no hardcoded <option> in source — the class of bug where four of five discs were unreachable from a phone',
    fast: false, ci: false,
    ciWhy: 'the sparse CI checkout carries no ROM or disc libraries, so dreamcast.html’s markUnhostedDiscs relabels EVERY title "— not deployed yet". The label arm would then be judging a state production is never in, and a red cell there would say nothing about the code',
    server: true, requires: ['dreamcast/discs', 'gamecube/roms'], timeoutMs: 15 * MIN,
  },

  // ---- emulator pages: need a core and a ROM ------------------------------
  {
    name: 'legacy-emu-pages',
    file: 'tools/legacy_emu_page_test.mjs',
    cmd: ['node', 'tools/legacy_emu_page_test.mjs'],
    desc: 'ps1.html / gba.html / snes.html actually boot to non-black multi-coloured pixels, run at 1.000x hardware rate measured from a clock the page cannot fake, and deliver keyboard + gamepad input to where the CORE reads it',
    fast: false, ci: false,
    ciWhy: 'boots three cores against multi-GB ROM libraries (ps1/ps1Wasm/roms 3.2 GB, gba/gbaWasm/roms, snes/snesWasm/roms) that a size-bounded runner checkout does not carry',
    server: true, requires: ['ps1/ps1Wasm/roms', 'gba/gbaWasm/roms', 'snes/snesWasm/roms'],
    timeoutMs: 20 * MIN,
  },
  {
    name: 'genesis-page',
    file: 'tools/genesis_page_test.mjs',
    cmd: ['node', 'tools/genesis_page_test.mjs'],
    desc: 'genesis.html boots both shipped ROMs to real pixels, holds the Mega Drive’s true 59.922751 Hz, delivers input to _gpx_set_pad, ships a 4:3 display aspect and has no overlapping controls',
    fast: false, ci: false,
    ciWhy: 'boots the Genesis-Plus-GX core against genesis/genesisWasm ROMs; needs the emulator asset tree',
    server: true, requires: ['genesis/genesisWasm'], timeoutMs: 15 * MIN,
  },
  {
    name: 'n64-page',
    file: 'tools/n64_page_test.mjs',
    cmd: ['node', 'tools/n64_page_test.mjs'],
    desc: 'n64/index.html end to end: desktop boot, mobile touch overlay reaching the core, the page’s own rate-model suite, the live meter wiring, the diagnostics panel, the pace governor and rAF de-duplication, plus the origin invariants',
    fast: false, ci: false,
    ciWhy: 'boots N64Wasm against n64/N64Wasm/roms (836 MB) — the ROM library is not in a size-bounded runner checkout',
    server: true, requires: ['n64/N64Wasm/roms/mariokart.z64'], timeoutMs: 20 * MIN,
    judge: (out) => {
      const j = lastJson(out);
      if (!j) return { ok: false, note: 'no JSON verdict on stdout' };
      const bad = ['desktop', 'mobile', 'ratetest', 'meter', 'diag', 'pace', 'rafdedupe', 'invariants']
        .filter((k) => !(j[k] && j[k].ok === true));
      return { ok: j.ok === true, note: j.ok === true ? 'all 8 passes ok' : 'failing passes: ' + (bad.join(',') || j.error || '?') };
    },
  },
  {
    name: 'n64-boot',
    file: 'tools/n64_boot_test.mjs',
    cmd: ['node', 'tools/n64_boot_test.mjs', 'mariokart.z64'],
    desc: 'one ROM boots on the N64Wasm dist page and reaches non-black pixels with frames advancing (the per-ROM boot/speed rig; one ROM here, the sweep is a separate manual run)',
    fast: false, ci: false,
    ciWhy: 'needs a .z64 out of n64/N64Wasm/roms (836 MB)',
    server: true, requires: ['n64/N64Wasm/roms/mariokart.z64'], timeoutMs: 10 * MIN,
    judge: (out) => {
      const j = lastJson(out);
      if (!j) return { ok: false, note: 'no JSON verdict on stdout' };
      return { ok: j.launched === true, note: j.launched === true
        ? `launched, luminance=${j.luminance}`
        : `launched=false blackScreen=${j.blackScreen} error=${j.error || '-'}` };
    },
  },
  {
    name: 'gba-state-persist',
    file: 'tools/gba_state_persist_test.mjs',
    cmd: ['node', 'tools/gba_state_persist_test.mjs'],
    desc: 'a GBA save state survives a page refresh byte-for-byte AND does not blow the memory budget — the Xbox report that desktop could never reproduce; asserts on renderer RSS from the OS, because the 128 MB copies live outside the JS heap',
    fast: false, ci: false,
    ciWhy: 'boots the GBA core against gba/gbaWasm/roms and samples renderer RSS from the OS',
    server: true, requires: ['gba/gbaWasm/roms'], timeoutMs: 15 * MIN,
  },
  {
    name: 'gba-mobile-controls',
    file: 'tools/gba_mobile_controls_test.mjs',
    cmd: ['node', 'tools/gba_mobile_controls_test.mjs'],
    desc: 'the GBA phone shell has a reachable fullscreen entry that targets the SHELL (not the canvas, which would hide the controls), draggable controls that persist, and no control whose centre is covered by another',
    fast: false, ci: false,
    ciWhy: 'loads a real GBA ROM (gba/gbaWasm/roms) and waits for myApp.isRunning',
    server: true, requires: ['gba/gbaWasm/roms'], timeoutMs: 15 * MIN,
  },
  {
    name: 'state-export-import',
    file: 'tools/state_export_import_test.mjs',
    cmd: ['node', 'tools/state_export_import_test.mjs'],
    desc: 'Export/Import save state on ps1, snes, genesis and n64/index: byte-exact export, byte-exact round trip, junk and truncated-gzip imports refused with the good state intact, and n64 save-memory routed to its own key',
    fast: false, ci: false,
    ciWhy: 'boots four cores against four ROM libraries',
    server: true, requires: ['ps1/ps1Wasm/roms', 'snes/snesWasm/roms', 'genesis/genesisWasm', 'n64/N64Wasm/roms'],
    timeoutMs: 30 * MIN,
  },
  {
    name: 'dreamcast-mp-page',
    file: 'tools/dreamcast_mp_page_test.mjs',
    cmd: ['node', 'tools/dreamcast_mp_page_test.mjs'],
    // ⚠ REWRITTEN 2026-09-16, FROM A PERMANENTLY-RED CELL TO ITS ONE LIVE CHECK.
    // It used to assert the CANCELLED streaming architecture — a video track,
    // pixels out of #mpVideo, a pad mask on __dcmpMask, and the requirement that
    // the guest pull ZERO bytes under /dreamcast/, which under lockstep is not a
    // light guest but a guest with no game. It was carried here labelled STALE
    // and EXPECTED TO FAIL, behind a 563 MB disc boot.
    // It never reached any of that: the run died on its FIRST page assertion
    // ("Cannot read properties of null (reading 'hidden')" — #lobby is gone), so
    // the disc-list drift this table called its one still-live check never ran.
    // A red cell that reaches none of its subjects trains people to read past
    // failures, and the same argument this file already makes for retiring
    // tools/mp_page_test.mjs applies to keeping one red for information it does
    // not produce.
    // It is now exactly that drift check, statically: both LEGACY lobbies'
    // copied game lists against the emulator page AND against multiplayer.html.
    // It found a real drift on its first run — n64_multiplayer.html offered 25
    // of 27 games, missing the two titles whose names carry an apostrophe.
    // The streaming half is covered by tools/no_streaming_test.mjs, and the
    // hand-off by dreamcast/tools/lobby_handoff_test.mjs.
    desc: 'the two LEGACY per-console lobbies copy their game lists rather than fetch them (dreamcast_multiplayer.html:143 says so outright) — this compares each copy against the emulator page AND against multiplayer.html, and fails on drift, because lib/netplay.js refuses a pairing whose game names differ and the barrier FAILS a room whose machines loaded different games',
    fast: true, ci: true,
    server: false,
    timeoutMs: 2 * MIN,
  },
  {
    name: 'dreamcast-lobby-handoff',
    file: 'dreamcast/tools/lobby_handoff_test.mjs',
    cmd: ['node', 'dreamcast/tools/lobby_handoff_test.mjs'],
    desc: 'two browsers, real clicks and keystrokes only: the lobby mints a code and hands BOTH players to dreamcast.html (the joiner carrying &join=1), they take different roles, a human presses Allow, and both rosters seat both players on DIFFERENT maple ports — the other half of no-streaming, which can only prove the machinery is gone and never that the replacement pairs',
    fast: false, ci: false,
    ciWhy: 'pairs two Chrome profiles over the public peerjs broker; --boot also loads a disc on both',
    server: true, requires: ['dreamcast.html', 'dreamcast_multiplayer.html'],
    timeoutMs: 20 * MIN,
  },
  {
    name: 'gamecube-mp-page',
    file: 'tools/gamecube_mp_page_test.mjs',
    cmd: ['node', 'tools/gamecube_mp_page_test.mjs'],
    desc: 'gamecube_multiplayer.html mints a code, gamecube.html hosts under THAT code, the guest pulls ZERO bytes under /gamecube/, and the guest’s pad lands in bytes 8..15 of the port-1 buffer',
    fast: false, ci: false,
    ciWhy: 'boots Dolphin-wasm and defaults to HEADFUL on purpose — its header records that headless Chrome produced ZERO frames for a whole run even with --enable-unsafe-webgpu. A GitHub runner has no display and no WebGPU adapter.',
    server: true, requires: ['gamecube/roms/240pSuite-1.10b.dol', 'gamecube/dolphin_libretro/dolphin_worker_emcc.wasm'],
    timeoutMs: 30 * MIN,
  },
  {
    name: 'device-matrix',
    file: 'tools/device_matrix.mjs',
    cmd: ['node', 'tools/device_matrix.mjs'],
    desc: 'the standing portability gate — desktop / no-webgpu / no-gpu / no-coi / mobile-ios / low-memory / slow-net across the capability-layer pages, each arm carrying an arm-difference proof so a placebo arm reports VOID instead of a false pass; also runs lib/capability.test.js (?captest=1) inside the pages',
    fast: false, ci: false,
    ciWhy: 'its arms are GPU-capability arms (an adapter must exist for --disable-gpu to be a real arm) and it boots gamecube.html and dreamcast.html with their cores; on a runner with no adapter every arm would be VOID, which is a rig with no signal rather than a pass',
    server: true, requires: ['lib/capability.js', 'lib/capability.test.js'], timeoutMs: 60 * MIN,
  },

  // ---- audit rigs (written 2026-09-08 by an independent auditor) ----------
  {
    name: 'audit-peerjs-crossdevice',
    file: 'tools/audit_peerjs_crossdevice.mjs',
    cmd: ['node', 'tools/audit_peerjs_crossdevice.mjs'],
    desc: 'the transport a REAL visitor uses: two SEPARATE Chrome profiles, neither passed ?net=local, so BroadcastChannel is physically unavailable and the pair can only meet through the public PeerJS broker',
    fast: false, ci: false,
    ciWhy: 'depends on a third-party script from unpkg and the PUBLIC PeerJS broker plus ICE over the open internet — an outage anywhere on that path would fail a green tree, which is worse than not running it',
    server: true, requires: ['lib/netplay.js'], timeoutMs: 20 * MIN,
  },
  {
    name: 'audit-save-crossprofile',
    file: 'tools/audit_save_crossprofile.mjs',
    cmd: ['node', 'tools/audit_save_crossprofile.mjs'],
    desc: 'a state exported in profile A must CHANGE profile B — the assertion state_export_import_test cannot make, because a no-op import passes its "digest unchanged" arm — and then Load State must move B’s picture to A’s scene',
    fast: false, ci: false,
    ciWhy: 'boots a core in two separate browser profiles against a ROM library',
    server: true, requires: ['ps1/ps1Wasm/roms'], timeoutMs: 25 * MIN,
  },
  {
    name: 'netplay-latency',
    file: 'tools/netplay_latency_test.mjs',
    cmd: ['node', 'tools/netplay_latency_test.mjs'],
    desc: 'how long player 2’s button takes to reach the game, timed from the guest keydown to the HOST session reporting that pad byte — the software floor, since both browsers are on one machine and the wire is loopback',
    fast: false, ci: false,
    ciWhy: 'it fails on a p90 above one frame (16.67 ms). On a shared 2-vCPU runner that threshold measures the RUNNER, not the code — CLAUDE.md gate #10: a timing number without a controlled load is not a result',
    server: true, requires: ['lib/netplay.js'], timeoutMs: 15 * MIN,
  },
  {
    name: 'dreamcast-room-hud',
    file: 'dreamcast/tools/room_hud_test.mjs',
    cmd: ['node', 'dreamcast/tools/room_hud_test.mjs'],
    desc: 'the room opens BEFORE the emulator (the boot-first gate is gone), the roster draws one seat per PORT from the engine’s own count, per-player disc progress is visible, and the session-truth panel names WHICH player it is stalling on and raises a latched, named DESYNC banner — asserted on layout geometry, not on a class name',
    fast: true, ci: true,
    server: true, requires: ['dreamcast.html'], timeoutMs: 6 * MIN,
  },
  {
    name: 'netplay-realui-pair',
    file: 'tools/netplay_realui_pair_test.mjs',
    cmd: ['node', 'tools/netplay_realui_pair_test.mjs'],
    desc: 'REWRITTEN 2026-09-08 for the lockstep room. The INLINE panel a person actually clicks, across TWO separate browser profiles, on the transport the page picks for itself — asserting the order the product HAS (join the room with nothing booted, ports assigned, a joiner who can start its OWN core) rather than the boot-first streaming order it used to assert while passing 27/27',
    fast: false, ci: false,
    ciWhy: 'same as audit-peerjs-crossdevice — it deliberately uses the real broker and real ICE, so it is network-dependent by design',
    server: true, requires: ['lib/netplay.js'], timeoutMs: 25 * MIN,
  },

  {
    name: 'dreamcast-room-crossdevice',
    file: 'dreamcast/tools/room_crossdevice_test.mjs',
    cmd: ['node', 'dreamcast/tools/room_crossdevice_test.mjs',
          // ⚠ --play, NOT 'none'. With the play phase off this harness paired two
          // browsers and STOPPED before a disc was ever loaded — so the entire
          // phase where the game boots, the barrier releases and pads reach the
          // other console went untested by the standing audit. Six defects
          // reached the user through that hole: the roster publishing game:null,
          // room-game emitted on Lockstep but listened for on the Session, two
          // URL writers letting a joiner name the disc, the host having no seat
          // in its own room, a Ready button whose label contradicted its
          // disabled state, and an unseated console driving PORT 0 — taking over
          // Player 1's character. Every one of them lives past the point this
          // arm used to stop at.
          '--url', ORIGIN, '--play', 'panel-open', '--latems', '45000', '--name', 'audit-xdev',
          '--arms', 'panel-open,panel-closed,host-busy,mobile-joiner,host-ignores,late-joiner,rejoin,host-reload,no-direct-path'],
    desc: 'TWO browsers pairing THE WAY A PERSON DOES — real mouse clicks at real coordinates (hit-tested with elementFromPoint), real keystrokes, and NOTHING else: it never calls approve()/setReady()/any engine method, and a self-audit over its own source refuses to run if it starts to. It exists because every other netplay rig here supplies the human action itself and therefore cannot notice a missing one. Nine arms: the baseline, a host with the lobby panel CLOSED, a host mid disc-download, a phone joiner, a host who never answers the prompt, a 45 s gap before anyone knocks, a joiner who reloads and retries, a host who reloads mid-room, and no-direct-path. ⚠ SIX MORE ARMS ARE IMPLEMENTED AND THIS COMMAND OMITS THEM — host-running, joiner-running, mobile-host-running, mobile-joiner-running, solo and seat-change — and the four *-running ones are the ordering the user actually reported ("omfg, I HAD IT OPEN"): the game is already free-running when the room is opened, which is past the point lsArmBeforeFreerun() can arm the gate. They are registered as `dreamcast-room-running-arms` below rather than added here, because each pre-boots a disc and the nine above already fill this entry\'s 25-minute budget. A one-way roster (the joiner sees the host, the host never sees the joiner) is a NAMED failure, never a timeout. The `no-direct-path` arm forces iceTransportPolicy=relay with no relay configured on both pages so NO RTCPeerConnection can form a candidate pair — the closest thing to two hostile networks that runs on one box — and it carries an arm-difference proof, reporting VOID rather than green if nothing was constructed under the wrapper. ⚠ THAT ARM WAS RED AND IS NOW GREEN, AND BOTH FACTS WERE EARNED. It first reproduced the production one-way roster exactly. It then paired but could not PLAY: both cores advanced a few frames and stopped, holding inputs ABOVE the frame they were stuck on — a HOLE, because the signalling relay LOSES MESSAGES (measured: host pub:46 rxOk:46 gapSeq:12 against 58 published by its peer, 20.7%) and lockstep sends each frame\'s input exactly once. Every relay publish now carries a run-length-compressed window of the last 2*delay frames, so a lost publish is repaired by the next one; measured after, 44 pass / 0 FAIL with core ran [71,71] -> [208,208] on BOTH consoles while gapSeq still read 63/51. It is a real arm, not a placebo, and it must stay green',
    fast: false, ci: false,
    ciWhy: 'it needs the real peerjs broker and real ICE between two Chrome profiles — network-dependent by design, exactly like audit-peerjs-crossdevice and netplay-realui-pair. ⚠ AND IT CANNOT PROVE WHAT IT LOOKS LIKE IT PROVES: both browsers sit on ONE box behind ONE NAT, so a green run closes the real-UI gap and NOT the two-networks gap. With no working TURN relay (public relays measured returning 701/400; peerjs\'s own two do not resolve) symmetric-NAT peers cannot connect at all and nothing here detects it. Marking this ci:true would put a green tick under a claim no rig in this repo can make',
    server: true, requires: ['dreamcast.html', 'lib/netplay.js'], timeoutMs: 25 * MIN,
    // ⚠ THE SIX OMITTED ARMS ARE NAMED IN THE `desc` ABOVE, NOT HERE — corrected
    // 2026-09-14. They were first written into this comment, and `--list` prints
    // `h.desc` and `h.ciWhy` and nothing else, so the arms that cover the
    // ordering the user reported were documented in a place the declaration
    // never prints: `node tools/audit_all.mjs --list | grep -c 'host-running'`
    // returned 0 while the printed desc still read "Nine arms". A comment is not
    // a declaration. They now have both a printed sentence and a row of their
    // own (`dreamcast-room-running-arms`, immediately below).
  },
  {
    // ADDED 2026-09-14. THE ORDERING THE USER ACTUALLY REPORTED, AND NOTHING
    // INVOKED IT. Every other netplay rig in this repo — including all nine
    // arms of the row above — opens or joins the room FIRST and boots the disc
    // afterwards. The state the report came from is the reverse: the game was
    // already free-running when the room was opened. room_crossdevice_test.mjs
    // implements that as six arms (its own header, :119-146) and its default
    // arm list is four (`const ARMS = arg('arms', 'panel-open,panel-closed,
    // host-busy,mobile-joiner')`, :205), so they ran only if someone typed them.
    //
    // WHY seat-change IS IN THIS ROW AND NOT THE ONE ABOVE: it asserts that an
    // AGREED card set is re-agreed after the seating changes, and the cards
    // only exist in the play phase — its own header says "Needs --play
    // seat-change" (room_crossdevice_test.mjs:145). `--play` takes a
    // comma-separated list (:238), so every arm here that has a room gets its
    // play phase; `solo` is excluded from it because solo is ONE BROWSER WITH
    // NO ROOM and has a separate runner (runSoloArm, :2308-2320).
    //
    // ⚠ ITS TIMEOUT IS DERIVED, NOT MEASURED. This auditor has never run this
    // row. 45 min is the sibling row's 25 min for 9 arms scaled to 6 arms that
    // each pre-boot a disc on at least one side and 5 of which run a play
    // phase. Treat the first run as the measurement, and correct this number
    // from it. Four further variants — host-running-reload, joiner-running-
    // reload, mobile-host-running-reload and mobile-joiner-running-reload
    // (:203-204, the reload is taken at the page's OWN live URL) — are still
    // invoked by nothing; that is a price, and this sentence is the line you
    // can read instead of a silence.
    name: 'dreamcast-room-running-arms',
    file: 'dreamcast/tools/room_crossdevice_test.mjs',
    cmd: ['node', 'dreamcast/tools/room_crossdevice_test.mjs',
          '--url', ORIGIN, '--name', 'audit-xdev-running',
          '--arms', 'host-running,joiner-running,mobile-host-running,mobile-joiner-running,solo,seat-change',
          '--play', 'host-running,joiner-running,mobile-host-running,mobile-joiner-running,seat-change'],
    desc: 'THE ROOM IS OPENED ON A GAME THAT IS ALREADY RUNNING — the six arms of room_crossdevice_test.mjs that the nine-arm row above omits, and the ordering the user reported. host-running and joiner-running boot the disc and let the core free-run to a live frame BEFORE a room exists; mobile-host-running and mobile-joiner-running do the same with that side on a phone (the mobile shell hides #wrap, so a phone\'s only Start control is #mobileSplashStart inside the splash the room hand-off hides); solo is the one-browser no-room regression guard for the boot seed (a fix that seeds a room correctly is worthless if it strands a lone player at PSO\'s Serial Number screen); seat-change proves an AGREED card set is re-agreed when the seating changes rather than the room dying. ⚠ NEVER RUN BY THIS AUDITOR — its timeout is derived from the sibling row, not measured; see the note above this entry',
    fast: false, ci: false,
    ciWhy: 'same rig, same reason as dreamcast-room-crossdevice — real peerjs broker and real ICE between two Chrome profiles — and MORE so: four of these six arms boot a Dreamcast disc out of dreamcast/discs before the room exists at all, which the size-bounded CI checkout does not carry',
    server: true, requires: ['dreamcast.html', 'lib/netplay.js', 'dreamcast/discs'], timeoutMs: 45 * MIN,
  },

  // ADDED 2026-09-13. All three were on disk, had real exit-code contracts, and
  // were run by NOBODY — and none of them could even be REPORTED by this file's
  // `undeclared()` sweep, which never looked inside dreamcast/tools or
  // gamecube/tools. The blanket NOT_RUN entry for those two directories claims
  // they "require a built .wasm newer than its sources"; that is true of the
  // emulator probes it was written for and FALSE of these, which consume the
  // shipped binary exactly the way dreamcast-room-hud and
  // dreamcast-room-crossdevice (both already in this table, both from
  // dreamcast/tools) do.
  {
    name: 'dreamcast-room-e2e',
    file: 'dreamcast/tools/netplay_room_e2e.mjs',
    cmd: ['node', 'dreamcast/tools/netplay_room_e2e.mjs', '--players', '2', '--name', 'audit-e2e2'],
    desc: 'N INDEPENDENT BROWSERS, N REAL CORES, one room: seating, the start barrier, everyone on frame 0 with no savestate handoff, and every screenshot paired with liveness read in the same breath (guestX must hold 1.000x — gate #9 — plus fps, framesEver/distinctEver and distinct canvas signatures), because a wedge screenshots a live-looking stale frame. ⚠ ONE CELL IS KNOWN RED AND PRE-DATES the party change: `player-2-plus-is-faster-than-streaming-was` measured 92-102 ms p50 against a [93,73] baseline (recorded in commit 6ac75018). The input path is untouched by that commit; this row is registered RED rather than left unrun',
    fast: false, ci: false,
    ciWhy: 'it boots two full Flycast cores against a disc out of dreamcast/discs (2.7 GB, absent from the size-bounded CI checkout) and its headline cells are timing cells, which on a shared runner measure the runner (CLAUDE.md gate #10)',
    server: true, requires: ['dreamcast.html', 'dreamcast/discs', 'dreamcast/flycast_libretro/flycast_worker_emcc.wasm'],
    timeoutMs: 30 * MIN,
  },
  {
    name: 'dreamcast-present-matched',
    file: 'dreamcast/tools/present_matched.mjs',
    cmd: ['node', 'dreamcast/tools/present_matched.mjs', '--players', '2', '--gated', '1', '--name', 'audit-pm2'],
    // ⚠ WHAT THIS ROW DOES AND DOES NOT JUDGE, because the difference is the
    // difference between a gate and a permanent green.
    // JUDGED: the rig's own ABORTs, which are exit 2 and are exactly the party
    // change's contract — "a console never declared ready by itself … ABORTING
    // rather than measuring parked cores" (present_matched.mjs:299-301) and
    // "the barrier did not release … ABORTING" (:309-311). Under the deleted
    // ceremony those two could only be reached by clicking; now they are the
    // assertion that no click is needed.
    // ALSO JUDGED SINCE 2026-09-14: guestX, the guest's speed against real
    // hardware. It is NOT an invented threshold — it is the product definition.
    // CLAUDE.md gate #9: "Guest simulation must run at exactly 1.000x hardware.
    // Speeding it up is FORBIDDEN." So a run at guestX 1.30 must not read PASS,
    // and as written it did. The band is 0.97-1.02 around the 1.000 the rig
    // itself computes (present_matched.mjs:377, `(dCyc / SH4_HZ) / dt`); a real
    // captured log of this rig reads median 0.99999 (/tmp/dc-e2e/pm-party-fix.log,
    // judged through --judge on 2026-09-14), so the band is loose around a
    // measured value rather than a guess about one.
    // STILL NOT JUDGED: presents/s. `process.exit(0)` at :425 is on the success
    // path whatever that number says, and this auditor has never measured what
    // a healthy presents/s is on a contended box — inventing a floor for it
    // would be the fake green described at the top of this file. It is REPORTED
    // in the note. Quote it; do not read a PASS as "the frame rate is fine".
    // ⚠ AND BOTH REGEX CHECKS NOW FAIL CLOSED. The wasm-stability check used to
    // read `if (w && w[1] !== w[2])`, so a change to the rig's output format
    // would have made `w` null, silently stopped the VOID check, and left the
    // row reading PASS — the same silence this whole file exists to end. An
    // absent line is now a FAIL, not a pass.
    desc: 'the room releases with ZERO clicks and both cores actually PRESENT: it aborts rather than measure if a console did not declare ready by itself or the barrier never released, then reports presents/s, calls/s and the guest ratio side by side so a rate can never be quoted apart from its 1.000x check (gate #9). ⚠ its exit code judges the two ABORTs and the 1.000x guest-rate band (0.97-1.02, gate #9), and does NOT judge presents/s — see the note above this entry',
    fast: false, ci: false,
    ciWhy: 'two live Flycast cores against a disc out of dreamcast/discs, and its output is a contended presents/s figure — CLAUDE.md gate #10 voids a timing pair taken on an unknown load',
    server: true, requires: ['dreamcast.html', 'dreamcast/discs', 'dreamcast/flycast_libretro/flycast_worker_emcc.wasm'],
    timeoutMs: 30 * MIN,
    judge: (out, code) => {
      if (code === 2) {
        const why = (/⚠ ([^\n]*ABORTING[^\n]*)/.exec(out) || [, 'aborted'])[1];
        return { ok: false, note: 'rig ABORTED: ' + why.slice(0, 120) };
      }
      if (code !== 0) return { ok: false, note: `exited ${code} — no measurement produced` };
      const w = /wasm\s+(\S+) -> (\S+)/.exec(out);
      if (!w) return { ok: false, note: 'no "wasm <before> -> <after>" line in the output — cannot prove the binary was stable across the run, so this run is VOID' };
      if (w[1] !== w[2]) return { ok: false, note: `wasm CHANGED mid-run ${w[1]} -> ${w[2]} — run VOID` };
      const pres = (/presents\/s\s+(\S+)\s+median (\S+)/.exec(out) || [])[2];
      const gxRaw = (/guestX\s+\S+\s+median (\S+)/.exec(out) || [])[1];
      const gx = Number(gxRaw);
      if (!Number.isFinite(gx)) return { ok: false, note: `no median guestX in the output (read ${JSON.stringify(gxRaw ?? null)}) — the 1.000x check could not run, so this run is VOID` };
      if (gx > 1.02 || gx < 0.97) return { ok: false, note: `guest ran at ${gx}x hardware, outside 0.97-1.02 — speeding the guest up is FORBIDDEN (CLAUDE.md gate #9); below the band it is not keeping up. presents/s ${pres ?? '?'}` };
      return { ok: true, note: `released with no click; median guestX ${gx} (within 1.000x), median presents/s ${pres ?? '?'} (PRESENTS/S REPORTED, NOT JUDGED — see the entry note)` };
    },
  },
  {
    name: 'gamecube-room',
    file: 'gamecube/tools/gc_room_test.mjs',
    cmd: ['node', 'gamecube/tools/gc_room_test.mjs'],
    desc: 'TWO MARIO PARTY 4s IN ONE ROOM: neither core may run a guest frame while the barrier holds (sampled off the worker\'s own PAD_ACK), both advance after it releases, the host holds port 0 and the guest port 1, and — the cell that cannot be faked from the transport layer — a button pressed on the GUEST is read back out of the HOST\'S GUEST MEMORY via MP4\'s own HuPadBtnDown, on port 1 and NOT on port 0. It is also the only rig `undelivered` cites as proving the GameCube card-divergence DETECTOR',
    fast: false, ci: false,
    ciWhy: 'it boots the Mario Party 4 recomp on two gamecube.html pages against gamecube/roms and the recomp image, which the size-bounded CI checkout omits, and it serves them from its own static server',
    server: false,   // it starts its OWN static server (gc_room_test.mjs:55) — it must not be handed :8080
    requires: ['gamecube.html', 'gamecube/recomp/mp4_game.wasm'],
    timeoutMs: 20 * MIN,
  },

  // ---- the lockstep determinism gate -------------------------------------
  // THE ONLY GATE THAT CAN CATCH THIS REGRESSION, and the reason it is worth
  // three minutes of a full run: the fix it protects is INVISIBLE TO EVERY
  // STATE-DIFF INSTRUMENT. A one-sided-normalize probe showed the operation
  // that removes the divergence is state-NEUTRAL in the serialized set —
  // normalizing instance A alone left A's state hash unchanged (3986917111 ->
  // 3986917111) with `DIFFERING RUNS: 0, 0 B differing across all 27,785,287`.
  // So the carrier is provably NOT in anything retro_serialize writes, no
  // byte-diff of a savestate can see it, and only a BEHAVIOURAL arm — run two
  // independent boots and compare their trajectories — can tell whether it
  // came back. The fix is flush -> serialize/unserialize round-trip -> flush at
  // room start, all three steps AND their order load-bearing, which is why
  // every single-variable isolation of it read null.
  // The four harnesses below were flagged UNDECLARED by this runner's own audit:
  // present on disk, in neither the run table nor NOT_RUN, therefore run by
  // nobody. That is the exact shape of gap this file exists to close — a test
  // that exists but is never invoked is indistinguishable from no test, and it
  // is worse, because its presence implies coverage.
  // ⚠ THE ONLY ARM THAT LOOKS AT PRODUCTION. Every other harness here — and
  // every emulator probe in this repo — reads the WORKING TREE on the machine
  // that built it. That blind spot shipped a real failure: the Dreamcast
  // lockstep desync fix was measured green by two rigs on a wasm that was never
  // committed, so production served the pre-fix binary while the page asked it
  // for an export it did not have. A local pass is not a deployment.
  {
    name: 'deployed-matches-repo',
    file: 'tools/verify_deployed_matches_repo.mjs',
    cmd: ['node', 'tools/verify_deployed_matches_repo.mjs'],
    desc: 'the bytes production serves are the bytes committed at HEAD — a STALE row means either a deploy has not landed or an artifact was built and never committed, and the second is invisible to every other test here',
    fast: false, ci: false,
    ciWhy: 'it fetches the live origin, so in CI it would fail for the entirely normal reason that the push being tested has not deployed yet — a red cell that says nothing about the change. It belongs in a full local run, after a deploy',
    server: false,
    requires: ['tools/verify_deployed_matches_repo.mjs'],
    timeoutMs: 10 * MIN,
  },
  // ⚠ THIS GATE IS RED ON PURPOSE, AND IT IS THE MOST IMPORTANT ROW HERE.
  // Streaming was cancelled by user directive — every player runs their own core
  // and only pad bytes cross the wire. Dreamcast was converted; thirteen pages
  // were not, and NOTHING NOTICED, because no test asserted the architecture.
  // Every one of those pages passes its own suite by correctly implementing the
  // thing that was cancelled. It goes green as each page is ported.
  {
    name: 'no-streaming',
    file: 'tools/no_streaming_test.mjs',
    cmd: ['node', 'tools/no_streaming_test.mjs'],
    desc: 'every page that offers online play drives the lockstep frame loop and carries NO streaming machinery — a requirement that lived only in a conversation until now, which is why thirteen pages kept streaming while passing all their tests',
    fast: true, ci: true,
    server: false,
    requires: ['dreamcast.html'],
    timeoutMs: 5 * MIN,
  },
  // Flagged UNDECLARED by this runner's own audit: present on disk, run by
  // nobody. All three guard the cross-network pairing work — the thing that was
  // deadlocking two real devices — so leaving them unrun would be the same gap
  // that let thirteen pages keep streaming while passing their tests.
  {
    name: 'netplay-ws-signal',
    file: 'tools/netplay_ws_signal_test.mjs',
    cmd: ['node', 'tools/netplay_ws_signal_test.mjs'],
    desc: 'pairing works with every direct WebRTC path deliberately dead — the case two devices on different networks are in, where signalling itself used to need NAT traversal before the game connection existed',
    fast: false, ci: false,
    ciWhy: 'it opens real WSS connections to public brokers and drives two browser profiles; a CI runner without egress to those hosts fails for a reason unrelated to the change',
    server: true, requires: ['lib/netplay.js'], timeoutMs: 20 * MIN,
  },
  {
    name: 'netplay-relay-play',
    file: 'tools/netplay_relay_play_test.mjs',
    cmd: ['node', 'tools/netplay_relay_play_test.mjs'],
    desc: 'a room with NO direct path still plays: pads cross over the relay, and the room discloses the cost rather than pretending it is a direct link',
    fast: false, ci: false,
    ciWhy: 'same as netplay-ws-signal — real brokers and two browsers',
    server: true, requires: ['lib/netplay.js'], timeoutMs: 20 * MIN,
  },
  {
    name: 'ps1-netplay',
    file: 'tools/ps1_netplay_test.mjs',
    cmd: ['node', 'tools/ps1_netplay_test.mjs'],
    desc: 'ps1.html plays two-player lockstep end to end — each machine running its own core, one agreed pad image per frame into BOTH PSX controller ports, fingerprints compared both ways',
    fast: false, ci: false,
    ciWhy: 'it streams a 451 MB PSX disc into two browser windows; the size-bounded CI checkout omits ps1/ps1Wasm/roms',
    server: true, requires: ['ps1.html', 'ps1/ps1Wasm/dist/wasmpsx_worker.js'], timeoutMs: 25 * MIN,
  },
  {
    name: 'ps1-determinism',
    file: 'tools/ps1_determinism_probe.mjs',
    cmd: ['node', 'tools/ps1_determinism_probe.mjs', '--frames', '600', '--every', '150', '--skew', '40'],
    desc: 'the PS1 CORE is deterministic: two independent cores, identical bytes and identical per-frame pads, savestate fingerprints compared — with a SKEW arm that deliberately desynchronises their wall clocks, so a host-clock leak into guest state cannot pass',
    fast: false, ci: false,
    ciWhy: 'needs a PSX disc (ps1/ps1Wasm/roms) and a browser; the size-bounded CI checkout omits both',
    server: true, requires: ['ps1.html', 'ps1/ps1Wasm/dist/wasmpsx_worker.js'], timeoutMs: 25 * MIN,
  },
  {
    name: 'genesis-netplay',
    file: 'tools/genesis_netplay_test.mjs',
    cmd: ['node', 'tools/genesis_netplay_test.mjs'],
    desc: 'genesis.html plays two-player lockstep end to end — each machine running its own core, one agreed pad image per frame, fingerprints compared both ways',
    fast: false, ci: false,
    ciWhy: 'it boots the Genesis core against genesis/genesisWasm ROMs, which the size-bounded CI checkout omits',
    server: true, requires: ['genesis.html', 'genesis/genesisWasm'], timeoutMs: 25 * MIN,
  },
  {
    name: 'snes-netplay',
    file: 'tools/snes_netplay_test.mjs',
    cmd: ['node', 'tools/snes_netplay_test.mjs'],
    desc: 'snes.html plays two-player lockstep end to end — each machine running its own core, one agreed pad image per frame, fingerprints compared both ways, and a CPU-throttled peer proven to STALL the other console rather than predict its pad',
    fast: false, ci: false,
    ciWhy: 'it boots the SNES core against a snes/snesWasm ROM, which the size-bounded CI checkout omits',
    server: true, requires: ['snes.html', 'snes/snesWasm/snes9x_2005.wasm'], timeoutMs: 25 * MIN,
  },
  {
    name: 'console-room-crossdevice',
    file: 'tools/console_room_crossdevice_test.mjs',
    cmd: ['node', 'tools/console_room_crossdevice_test.mjs'],
    desc: 'n64 and genesis play lockstep between TWO SEPARATE CHROME PROFILES over the shipped ws/peerjs signalling — the profiles are proven unable to see each other’s BroadcastChannel, so the room can only have formed the way a real pair of players would; warm and cold profiles both',
    fast: false, ci: false,
    ciWhy: 'it boots both cores against n64/N64Wasm and genesis/genesisWasm ROMs (which the size-bounded CI checkout omits) AND needs a reachable public MQTT broker, so a red run would mean "the internet", not "this repo"',
    server: true, requires: ['genesis.html', 'n64/index.html', 'lib/netplay.js'], timeoutMs: 30 * MIN,
  },
  {
    name: 'netplay-lockstep',
    file: 'tools/netplay_lockstep_test.mjs',
    cmd: ['node', 'tools/netplay_lockstep_test.mjs'],
    desc: 'the lockstep PROTOCOL: frame-numbered input exchange, the stall path when a remote input is missing (it must STALL, never predict — a guess becomes a permanent silent desync), input delay, and the desync report naming frame, peer and field',
    fast: true, ci: true,
    server: true,
    requires: ['lib/netplay.js'],
    timeoutMs: 10 * MIN,
  },
  {
    name: 'netplay-lockstep-pair',
    file: 'tools/netplay_lockstep_pair_test.mjs',
    cmd: ['node', 'tools/netplay_lockstep_pair_test.mjs'],
    desc: 'two peers over a REAL RTCPeerConnection running the lockstep exchange: what the delay buys, and what a stall looks like when the link is slow',
    fast: false, ci: true,
    server: true,
    requires: ['lib/netplay.js'],
    timeoutMs: 15 * MIN,
  },
  {
    name: 'netplay-room',
    file: 'tools/netplay_room_test.mjs',
    cmd: ['node', 'tools/netplay_room_test.mjs'],
    desc: 'the ROOM seats up to the console port count over real WebRTC: agreed rosters on every machine, deterministic port assignment, a full room refusing the next caller, the start barrier, and a leaver not wedging the rest',
    fast: false, ci: true,
    server: true,
    requires: ['lib/netplay.js'],
    timeoutMs: 20 * MIN,
  },
  {
    name: 'bgz',
    file: 'tools/bgz.test.mjs',
    cmd: ['node', 'tools/bgz.test.mjs'],
    desc: 'the block-gzip container the big discs ship in: an index that maps a disc byte range onto compressed blocks, and rejection of a part whose recorded size disagrees with its block lengths — a wrong answer here silently corrupts a disc rather than failing',
    fast: true, ci: true,
    server: false,
    requires: ['lib/bgz.js'],
    timeoutMs: 5 * MIN,
  },
  {
    name: 'dreamcast-determinism',
    file: 'dreamcast/tools/determinism_probe.mjs',
    cmd: ['node', 'dreamcast/tools/determinism_probe.mjs',
          '--frame0', '--normalize', '--arms', 'cross',
          '--frames', '1800', '--runs', '3', '--warmup', '0', '--name', 'audit-det'],
    desc: 'deterministic lockstep still holds: TWO independent cores boot dreamcast.html from frame 0 with no savestate, are normalized at the room-start seam, and are then driven frame-gated through 1800 frames of identical scripted pad input — a PASS means all 3 runs kept BYTE-IDENTICAL retro_serialize state and guest cycle counts the whole way, i.e. two real peers would not desync',
    fast: false, ci: false,
    ciWhy: 'it needs a 503 MB Dreamcast disc out of dreamcast/discs (2.7 GB, absent from the size-bounded CI checkout) AND two live emulator cores in one Chrome with SharedArrayBuffer; with no disc the probe has nothing to boot and would report a rig fault, which is a red cell that says nothing about determinism',
    server: true,
    requires: ['dreamcast/discs/gauntlet', 'dreamcast/flycast_libretro/flycast_worker_emcc.wasm'],
    timeoutMs: 30 * MIN,
    // ⚠ THE PROBE EXITS 0 WHETHER IT PASSES OR FAILS (determinism_probe.mjs
    // ends `await finish(0)` on the success path regardless of the verdict —
    // it is a measurement rig, not a gate). Judging this one on its exit status
    // would therefore be a PERMANENT GREEN. That is still true of the `--gate`
    // convenience mode the probe grew on 2026-09-08: it prints its own
    // `GATE: PASS/FAIL` line and then exits 0 like every other path (verified:
    // the only terminal call on the success path is `await finish(0)`), and it
    // also wipes its Chrome profile on every run, which re-downloads the 503 MB
    // disc. So this entry passes the flags explicitly and reads the verdict out
    // of the long-stable `VERDICT <arm>:` line. The verdict is read out of stdout,
    // and the wasm hash guard (CLAUDE.md gate #10) is read with it: a run whose
    // binary changed underneath it is VOID, not a pass.
    judge: (out, code) => {
      if (code !== 0) return { ok: false, note: `probe exited ${code} — FATAL/rig fault, no verdict produced` };
      const before = /wasm BEFORE: (\S+)/.exec(out);
      const after  = /wasm AFTER: (\S+)/.exec(out);
      if (!before || !after) return { ok: false, note: 'no wasm hash-guard lines on stdout — cannot tell what was measured' };
      if (before[1] !== after[1]) return { ok: false, note: `wasm CHANGED mid-run ${before[1]} -> ${after[1]} (concurrent relink) — run VOID` };
      const m = /VERDICT cross: (\d+)\/(\d+) runs byte-identical over (\d+) frames(?: \(\+(\d+) rig faults\))?; first-divergence frames: (\[[^\]]*\]); watchdog fires: (\d+)/.exec(out);
      if (!m) return { ok: false, note: 'no "VERDICT cross:" line on stdout — the probe never reached a verdict' };
      const identical = +m[1], measured = +m[2], frames = +m[3], faults = +(m[4] || 0), where = m[5], dog = +m[6];
      if (measured < 3) return { ok: false, note: `only ${measured} of 3 cross runs produced a measurement (+${faults} rig faults) — not a verdict` };
      const ok = identical === measured && faults === 0;
      return { ok, note: ok
        ? `cross ${identical}/${measured} runs byte-identical over ${frames} frames, watchdog ${dog}, wasm ${before[1]}`
        : `DESYNC — cross ${identical}/${measured} runs byte-identical over ${frames} frames; first divergence at frame(s) ${where}${faults ? ` (+${faults} rig faults)` : ''}; wasm ${before[1]}` };
    },
  },
];

// ---------------------------------------------------------------------------
// DECLARED AND NOT RUN. Every one of these is a real file in the repo that a
// person could mistake for a test. Naming them here is the whole point: an
// omission you can read is not the same thing as a silence.
// ---------------------------------------------------------------------------
const NOT_RUN = [
  { file: 'tools/control_map_drift_test.mjs',
    why: 'the bug class it policed no longer exists: under lockstep every player runs their own core, so the *_multiplayer.html pages became lobby redirects that map no controls at all (all seven carry zero of GP/KEYMAP/B/D; genesis_multiplayer.html is 59 lines). One control table per console means nothing can drift. It caught real bugs before that — genesis 4 of 6 face buttons swapped, n64 L/Z swapped, gamecube Start bound to pad index 7 — so it is retired rather than deleted, and is the check to restore if a second table ever reappears' },
  { file: 'tools/verify_artifact_complete.mjs',
    why: 'it asserts against a STAGED DEPLOY ARTIFACT, which only the deploy job produces — it is a step in .github/workflows/deploy.yml, run there on every deploy. Its invariant (every tracked file deploy.exclude does not exclude must exist in the artifact) is what makes the blobless+sparse CI checkout safe: a sparse checkout that omits a path does not fail, rsync just copies nothing for it and prints a clean summary. Run it locally with `git ls-files -z | node tools/verify_artifact_complete.mjs .`, which passes trivially because the working tree is complete by construction; the arm that means something needs _deploy' },
  { file: 'tools/catalog_urls.mjs',
    why: 'a MODULE, not a harness — the shared catalog extractor imported by tools/verify_deploy_assets.mjs and tools/verify_live_catalogs.mjs, both of which ARE in the table above. Its own self-tests (the 2026-09-08 four-games-404 case, the ASSET_BASE comment trap, and the falsy-empty-string revert trap) run unconditionally at the start of both callers, so it cannot regress silently' },
  { file: 'tools/dreamcast_netplay_test.mjs',
    why: '⚠ IT ASSERTS A CANCELLED ARCHITECTURE. It judges pixels read from the guest\u2019s own <video> and calls __dcNet().guestAudio / __dcNetStream() \u2014 but streaming was cancelled by user directive 2026-09-08 and dreamcast.html has none of those any more. It is named here rather than quietly deleted because an omission you can read is not a silence: it still holds the only ONE-BROWSER TWO-TAB arm (BroadcastChannel signalling in a single profile, no broker, fast) and should be REWRITTEN as the two-tab room test rather than dropped. Covering it today: dreamcast/tools/room_hud_test.mjs (flow + session honesty, one browser) and dreamcast/tools/netplay_room_e2e.mjs (N browsers, N cores)' },
  { file: 'tools/ps1_pad_test.mjs',
    why: 'superseded in coverage by tools/legacy_emu_page_test.mjs (ps1 arm) and it exits 0 on every path except "runtime never came up" — its own body prints diagnostics rather than asserting, so a green exit here would not mean much' },
  { file: 'tools/n64_jit_diff_test.mjs',
    why: 'the N64 JIT differential ORACLE: three full ROM runs of 600 VI frames each, per ROM. It is the campaign instrument, not a per-push gate; run it from tools/n64_jit_sweep.sh' },
  { file: 'tools/audit_netplay_guest_quality.mjs',
    why: 'TWO reasons, and the second one retires it. (1) It is a measurement rig, not a gate — it reports the guest’s real received frame rate and has NO pass/fail exit code (verified: no process.exit in the file). (2) ⚠ AND ITS SUBJECT NO LONGER EXISTS: every instrument in it reads a STREAM — `document.getElementById("mpVideo")` (:98, :144-145), video.requestVideoFrameCallback, getVideoPlaybackQuality(), and getStats() inbound-rtp `kind === "video"` (:213) — and its PLATFORMS table carries the same dead seams as mp_page_test.mjs — ⚠ it does NOT import them, corrected 2026-09-14: its only imports are puppeteer, fs and child_process (:46-48) and it defines its own copy at :57-63, so the two tables are duplicates that went stale together rather than one reading the other. Streaming was cancelled by user directive 2026-09-08: under lockstep the guest runs its own core and there is no track to measure, so "the guest’s received frame rate" is not a slow number, it is not a number. Its genuinely reusable half is arm A2 — the falsification of a liveness judge by pausing the source with CDP Debugger.pause — which belongs on whatever the lockstep equivalent of "is this picture live" turns out to be' },
  { file: 'lib/capability.test.js',
    why: 'a browser-side suite with no node entry point; it is loaded by ?captest=1 and is executed inside tools/device_matrix.mjs, which IS in the table above' },
  { file: 'lib/audiodiag.test.js',
    why: 'a browser-side suite reached by ?audiotest=1 on ps1.html / gba.html. NO node runner exists for it anywhere in the repo — this is a genuine coverage gap, not a deliberate exclusion' },
  { file: 'gamecube/tools/conformance/run.mjs',
    why: 'the per-instruction conformance runner needs an Emscripten-built target (emcmake + emmake on gamecube/bementalJIT) that does not exist in a fresh tree' },
  { file: 'gamecube/bementalJIT/tests/run_browser_test.mjs',
    why: 'same — a runner for Emscripten-built .html test targets. Its two sibling shell scripts that need no build (run_leaf_inline_test.sh, run_leaf_inline_mutants.sh) DO run, inside preflight' },
  { file: 'gamecube/recomp/sr/test_indirect.mjs',
    why: 'a static-recomp bring-up probe tied to a generated image, not a standing gate' },
  { file: 'dreamcast/test_unknowns_local.sh',
    why: 'drives the native RedDream / Flycast oracles, which are native binaries outside the repo' },
  { file: 'tools/mobile_input_latency.mjs, tools/turn_probe.mjs, tools/pacing_matrix.mjs, tools/audio_probe.mjs, tools/n64_gameplay_ab.mjs, tools/n64_gameplay_probe.mjs, tools/n64_jit_census.mjs, tools/sm64_native_probe.mjs, tools/_jit_speed_ab.mjs',
    why: 'MEASUREMENT probes — they report numbers (latency, ICE relays, pacing, audio rate, A/B throughput) and have no pass/fail contract. A number is not a verdict and must not be dressed as one' },
  { file: 'gamecube/tools/*, dreamcast/tools/* (probes)',
    why: 'the GameCube and Dreamcast probes are the emulators’ canonical inner loops (CLAUDE.md gates #1 and #8) and require a built .wasm newer than its sources. Running them from a generic auditor would violate the freshness gate the .claude hooks enforce. ONE EXCEPTION, and it is deliberate: dreamcast/tools/determinism_probe.mjs runs as the `dreamcast-determinism` harness above, because deterministic lockstep is the one property in this repo that NO state-diff instrument can check — the operation that fixes it is state-neutral in the serialized set — so a behavioural arm is the only gate there can be. It is run against the shipped binary as a CONSUMER, with no build step and no flag this runner invented' },
  { file: 'dreamcast/tools/determinism_ports4.mjs',
    why: 'the FOUR-PORT determinism arm. Not a per-push gate: it plugs four Maple controllers through a throwaway MAIN-world extension, boots the page twice for a plug proof and then twice more for the measurement, and takes about twice the two-port arm. `dreamcast-determinism` above covers the shipping two-player case on every full run; this one is the campaign instrument for the four-player device set (four VMUs, twice the host-time surface) and is run by hand' },
  // ---- newly VISIBLE 2026-09-13, when undeclared() was widened to look inside
  // dreamcast/tools and gamecube/tools. Every one of these was on disk with a
  // real exit-code contract and was named by nothing: not run, not excluded,
  // not reported. Three of the five in that sweep became harnesses above
  // (dreamcast-room-e2e, dreamcast-present-matched, gamecube-room); these are
  // the rest, each with the reason it is not one.
  { file: 'dreamcast/tools/lockstep_pump_test.mjs',
    why: '⚠ THIS ONE IS A GAP, NOT AN EXCLUSION, AND IT IS THE CHEAPEST GATE STILL UNRUN. It drives the REAL dreamcast/flycast_libretro/flycast_worker.js in a real Worker against a STUB core (dreamcast/tools/pump_fixture/stub_core.js) whose frames are exact and free — so it needs NO disc, NO 2.7 GB library and no emulator boot, just :8080 and a browser, and it is the only thing here that asks whether the frame gate advances exactly one emulated frame per delivered input pair, refuses to advance without one, and never repays a stall as a burst (the forbidden speed-up, CLAUDE.md gate #9). It belongs in the fast set; it is left out today only because nobody has yet timed a run of it, and this auditor does not register a harness whose runtime it has not measured' },
  { file: 'dreamcast/tools/netplay_unreachable_test.mjs',
    why: 'A ROOM THAT CANNOT CONNECT MUST SAY SO — the two-real-devices deadlock where both screens read "waiting for players" forever while the browsers had already given up. Not registered because its red/green proof needs `--url` pointed at a DIFFERENT origin carrying the pre-change build, so a single-origin run here can only ever be green and this auditor cannot supply the other arm. It is the natural companion to the `no-direct-path` arm of dreamcast-room-crossdevice' },
  { file: 'dreamcast/tools/vmu_two_player_test.mjs',
    why: 'player 2 has its own memory card and it survives — a real gate (its header: "Exit 0 = every assertion passed"), but it boots a disc out of dreamcast/discs on two machines, so it is priced with dreamcast-room-e2e rather than separately. ⚠ It is also deleted in the git INDEX while present on disk, so a fresh checkout does not have it' },
  { file: 'gamecube/tools/recomp_fourport_test.mjs',
    why: 'does Mario Party 4 itself see FOUR controllers, witnessed on the GAME\'s own winKey rather than on the array we write. Not registered because its matched control arm (ARM=one) loads /gamecube/recomp/oneport/, and that directory is UNTRACKED and staged-deleted — it exists on this box and in no checkout, so the rig is green here and un-runnable anywhere else. Register it once the control build is either tracked or regenerated by a script' },
  { file: 'tools/netplay_broker_check.mjs, tools/netplay_prod_pair_check.mjs',
    why: 'both reach OUTSIDE this machine by design and cannot be part of a tree-local verdict: broker-check connects to each public MQTT-over-WebSocket broker lib/netplay.js falls back down and requires bytes out the far side (a red there means "that broker is down", which says nothing about this repo — the same reason audit-peerjs-crossdevice is ci:false), and prod-pair-check drives https://caseybement.com, i.e. it judges what is DEPLOYED, like deployed-matches-repo. Run broker-check before blaming the signalling list, and prod-pair-check after a deploy' },
  { file: 'dreamcast/tools/port_plug_test.mjs',
    why: 'it asserts (exit code and PASS/FAIL lines) rather than measuring, so it COULD be a gate — naming it here is an honest gap, not a judgement: it boots the Gauntlet disc twice (players=4 and players=1) and belongs in the table once someone has priced its runtime against the rest of the dreamcast set' },

  // ---- MOVED OUT OF THE RUN TABLE 2026-09-14 ------------------------------
  { file: 'tools/mp_page_test.mjs',
    why: '⚠ RETIRED, NOT MERELY RELABELLED. It was left in the run table with a STALE desc, which meant a full local audit still spent up to 45 minutes and five core boots arriving at the red its own description predicted. EVERY subject of it is cancelled, re-measured on this tree 2026-09-14: (1) it drives /ps1_multiplayer.html, /snes_multiplayer.html, /gba_multiplayer.html and /genesis_multiplayer.html as INLINE LOBBIES (its PLATFORMS, mp_page_test.mjs:65-200) and those four files are 60/60/59/59 lines, each a bare location.replace (ps1_multiplayer.html:56, snes:56, gba:55, genesis:55); (2) its guest seams __ps1mp / __genmp / __snesmp / __gbamp appear on NO shipped page (grep --include=*.html across the repo: zero files); (3) it reads the guest\'s picture out of #mpVideo (:436), which survives only in dreamcast_multiplayer.html; (4) its headline requirement, "the guest is LIGHT: ZERO requests for the core or the ROM" (:24), is the OPPOSITE of lockstep, where every player runs their own core and therefore does pull the ROM. What covers those five consoles now: ps1-netplay, snes-netplay, genesis-netplay, console-room-crossdevice (n64 + genesis over two real profiles) and no-streaming; gba has no room at all — see `undelivered`. Its one still-live idea is the game-list drift check against each emulator page, which should be REWRITTEN onto the lockstep pages rather than dropped. ⚠ THE INCONSISTENCY THIS NOTE RECORDED IS GONE, 2026-09-16: `dreamcast-mp-page` was a run-table row carrying the same STALE label, kept because dreamcast_multiplayer.html still contains #mpVideo so that rig had a live subject to fail on. It never reached that subject — it died on #lobby being null — so it was REWRITTEN into precisely the still-live idea named two sentences above: the game-list drift check, now covering BOTH legacy lobbies against their emulator page AND against multiplayer.html, statically, in CI. It caught a real drift immediately (n64_multiplayer.html offered 25 of 27). This entry stays retired: its four subject pages are bare redirects with no list to drift. It is NOT the same case as `dreamcast-room-e2e`, which is registered KNOWN-RED on purpose: that rig asserts live behaviour and one timing cell is red. A rig whose every subject is gone produces no information at any price' },

  // ---- newly VISIBLE 2026-09-14, when undeclared() was widened to *_probe.mjs
  // under tools/. Both have REAL exit-code contracts — neither is a measurement
  // probe — and both were named by nothing: not run, not excluded, not reported.
  { file: 'tools/genesis_determinism_probe.mjs',
    why: '⚠ A GAP, NOT AN EXCLUSION, AND IT IS A GATE BY ITS OWN CONTRACT: `process.exit(failures === 0 ? 0 : 1)` at :648. It asks the question genesis.html\'s lockstep wiring depends on — do two independent Genesis cores, cold-booted from frame 0 with NO savestate and identical inputs applied at identical EMULATED frame numbers, stay byte-identical, and for how long (its header: "⚠ FROM FRAME 0, NO SAVESTATE IS THE HARDER QUESTION AND IT IS THE RIGHT ONE", because lockstep here seats players before anything boots and there is nothing to normalize). dreamcast/tools/determinism_probe.mjs answers the same question for Dreamcast and IS in the run table as `dreamcast-determinism`; this one is its Genesis analogue and is not registered only because nobody has timed a run of it — two cold boots of a Genesis core against genesis/genesisWasm. Time it once and it belongs in the table beside its sibling' },
  { file: 'tools/disc_bytes_probe.mjs',
    why: 'HOW MANY BYTES DOES IT COST TO START A GAME — the measurement the disc-loading path is judged on, from a phone photographed stalled at "Track5.bin 59.3% · 670/1131 MB". It does carry an exit code (:334, `process.exit(firstFrameAt ? 0 : 1)`, and :246 exit 2 when the ROM select fails), but the code only says "a first frame appeared" — the VERDICT it exists for is a byte count, and a number is not a verdict (same reason as the measurement-probe block above). ⚠ Its own header is also explicit that the arm that means anything runs against the DEPLOYED origin, not :8080, so a tree-local audit cannot produce the number it is for' },

  // ---- A BEHAVIOUR WITH NO HARNESS AT ALL. Not a file — named here because
  // this list is where an omission becomes readable, and there is nowhere else
  // for this one to be read.
  { file: 'lib/netplay.js:1276 ROSTER_REKNOCK_MS — a BEHAVIOUR with no gate anywhere (not a file)',
    why: '⚠ ONE OF THE TWO BEHAVIOURS COMMIT ee6e50a0 ADDED AND IT IS ASSERTED BY NOTHING. A guest that has heard no roster for ROSTER_REKNOCK_MS (20 s) re-knocks on the room by itself before the room starts: `const ROSTER_REKNOCK_MS = 20000` at lib/netplay.js:1276, the two guards at :3120-3121 (`if (!ls.rosterAt || (Date.now() - ls.rosterAt) < ROSTER_REKNOCK_MS) return;` and the self-rate-limit on this._reknockAt), the stamp at :3096. Its SIBLING from the same commit, DISCONNECT_GRACE_MS, has a static cell (tools/netplay_invariants.mjs:76-83) and `rosterStale` — a different, 9 s flag — has cells at tools/netplay_lockstep_test.mjs:585-608, so the pairing looks covered and is not. MEASURED 2026-09-14: `grep -rn -i reknock tools/ dreamcast/tools/ gamecube/tools/` returns NO OUTPUT. What it wants, cheapest first: a netplay-invariants static cell beside the grace cell (_reknock exists, is gated on ROSTER_REKNOCK_MS, and fires only pre-start), then a behavioural arm on room_crossdevice_test\'s late-joiner, whose 90 s idle already spans the 20 s window. Both files are outside this runner and neither edit is one it can make' },
];

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const C = process.stdout.isTTY
  ? { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' }
  : { g: '', r: '', y: '', d: '', b: '', x: '' };

function lastJson(out) {
  // n64_page_test pretty-prints its JSON across many lines; n64_boot_test emits
  // one line. Take the last balanced {...} block in the stream.
  const i = out.lastIndexOf('\n{');
  const start = i >= 0 ? i + 1 : out.indexOf('{');
  if (start < 0) return null;
  try { return JSON.parse(out.slice(start)); } catch (_e) { /* fall through */ }
  for (const line of out.split('\n').reverse()) {
    const t = line.trim();
    if (t.startsWith('{') && t.endsWith('}')) { try { return JSON.parse(t); } catch (_e) {} }
  }
  return null;
}

const load1 = () => os.loadavg()[0].toFixed(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function originIsUp() {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 2500);
  try {
    const r = await fetch(ORIGIN + '/', { signal: ac.signal });
    return r.ok || r.status === 404;      // anything answering HTTP counts
  } catch (_e) { return false; } finally { clearTimeout(t); }
}

// CLAUDE.md gate #2: the port is 8080 via `npm run web`. This never invents
// another one; if ORIGIN has been pointed elsewhere and is dead, that is the
// operator's to fix.
async function ensureServer() {
  if (await originIsUp()) {
    console.log(`[serve] ${ORIGIN} already answering — leaving it alone (a sibling agent may own it)`);
    return null;
  }
  if (!/^http:\/\/localhost:8080\/?$/.test(ORIGIN)) {
    console.error(`[serve] ${ORIGIN} is not answering and is not the canonical origin — start it yourself`);
    return 'dead';
  }
  console.log('[serve] nothing on 8080 — starting `npm run web` (node tools/devserver.mjs, package.json:8)');
  const p = spawn('npm', ['run', 'web'], { cwd: ROOT, stdio: 'ignore' });
  for (let i = 0; i < 80; i++) { await sleep(250); if (await originIsUp()) return p; }
  try { p.kill('SIGTERM'); } catch (_e) {}
  return 'dead';
}

// Most harnesses hardcode the macOS Chrome bundle as their default. On any
// other machine that path does not exist and every one of them would fail with
// an unhelpful ENOENT, so resolve one here and hand it down.
function resolveChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/opt/google/chrome/chrome',
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  for (const bin of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    const r = spawnSync('which', [bin], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  try {
    const r = spawnSync(process.execPath,
      ['-e', "import('puppeteer').then(m=>console.log(m.default.executablePath()))"],
      { encoding: 'utf8', cwd: ROOT, timeout: 20000 });
    const p = (r.stdout || '').trim();
    if (p && fs.existsSync(p)) return p;
  } catch (_e) {}
  return null;
}

function reap(label) {
  const r = spawnSync(process.execPath, ['tools/browser_leak_guard.js', 'reap'],
    { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
  const out = ((r.stdout || '') + (r.stderr || '')).trim().split('\n').slice(-3).join(' | ');
  console.log(`[reap:${label}] ${out || '(no output)'}`);
}

function runOne(h, env) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let out = '';
    const child = spawn(h.cmd[0], h.cmd.slice(1), { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch (_e) {} }, h.timeoutMs);
    const grab = (b) => { out += b.toString(); if (out.length > 4_000_000) out = out.slice(-2_000_000); };
    child.stdout.on('data', grab);
    child.stderr.on('data', grab);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ status: 'FAIL', code: null, ms: Date.now() - t0, out, note: 'spawn error: ' + e.message });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const ms = Date.now() - t0;
      if (timedOut) return resolve({ status: 'FAIL', code, ms, out, note: `TIMEOUT after ${Math.round(h.timeoutMs / 1000)}s` });
      let ok = code === 0;
      let note = `exit ${code}${signal ? ' sig ' + signal : ''}`;
      if (h.judge) { const j = h.judge(out, code); ok = j.ok; note = j.note; }
      resolve({ status: ok ? 'PASS' : 'FAIL', code, ms, out, note });
    });
  });
}

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const hasFlag = (f) => argv.includes(f);
function flagVal(f) {
  const i = argv.findIndex((a) => a === f || a.startsWith(f + '='));
  if (i < 0) return null;
  if (argv[i].includes('=')) return argv[i].split('=').slice(1).join('=');
  return argv[i + 1] || null;
}
const FAST = hasFlag('--fast');
const CI = hasFlag('--ci');
const LIST = hasFlag('--list');
const ONLY = (flagVal('--only') || '').split(',').map((s) => s.trim()).filter(Boolean);
const SKIP = (flagVal('--skip') || '').split(',').map((s) => s.trim()).filter(Boolean);

// ---------------------------------------------------------------------------
// --judge <name> --judgelog <file> [--judgecode <n>]
//
// Apply ONE harness's judge to a CAPTURED stdout instead of running it. This
// exists because of a rule this repo has already paid for twice: a gate nobody
// has SEEN GO RED is not evidence. Judges that read a verdict out of stdout are
// the easy place to write a permanent green — a regex that never matches, or a
// tolerance that swallows the failure — and running the harness itself cannot
// show that, because the passing run is the only one you have.
//
// With this, a captured failing log and a captured passing log are fed to the
// same judge, and the red/green pair is the proof. It is not a way to fake a
// result: it prints the harness name and reads a file, and nothing in the
// normal run path consults it.
// ---------------------------------------------------------------------------
const JUDGE_NAME = flagVal('--judge');
if (JUDGE_NAME) {
  const h = HARNESSES.find((x) => x.name === JUDGE_NAME);
  if (!h) {
    console.error(`unknown harness: ${JUDGE_NAME}\nknown: ` + HARNESSES.map((x) => x.name).join(', '));
    process.exit(2);
  }
  const logPath = flagVal('--judgelog');
  if (!logPath) { console.error('--judge needs --judgelog <captured stdout file>'); process.exit(2); }
  if (!fs.existsSync(logPath)) { console.error('no such log: ' + logPath); process.exit(2); }
  const captured = fs.readFileSync(logPath, 'utf8');
  const exitCode = Number(flagVal('--judgecode') ?? 0);
  const j = h.judge ? h.judge(captured, exitCode)
                    : { ok: exitCode === 0, note: `no judge — exit status only (exit ${exitCode})` };
  console.log(`${j.ok ? C.g + 'PASS' + C.x : C.r + 'FAIL' + C.x}  ${C.b}${h.name}${C.x}  ${j.note}`);
  console.log(`${C.d}judged: ${logPath} (${captured.length} B, exit code ${exitCode})${C.x}`);
  process.exit(j.ok ? 0 : 1);
}

// ---------------------------------------------------------------------------
// pre-flight on the table itself: a declared harness that is not on disk is a
// hard error. CLAUDE.md gate #3 — assert nothing about the tree without looking.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// pre-flight on the table itself. A declared harness that is not on disk gets
// its own verdict — MISSING — rather than a crash or a silent pass.
//
// WHY NOT FATAL *TO THE RUN*. Branches move at different speeds: a harness that
// exists on `dev` may not exist on `prod` yet, and aborting the whole suite
// there would blind every other gate for a reason that is not a regression. So
// nothing is aborted — every other row still runs. WHY NOT SILENT: a harness
// that vanished is exactly the thing this runner exists to surface, so MISSING
// is printed in the summary table and recorded in the JSON.
//
// ⚠ AND SINCE 2026-09-14 IT IS ALSO RED WHEN IT MATTERS. A MISSING row whose
// `ci` is true exits this process 1 (see goneCi at the bottom of the file):
// that row is a gate the workflow claims to run, so its disappearance is a
// removed gate rather than a note. ci:false rows stay non-fatal — those are
// exactly the branch-drift case this paragraph was written for. This workflow
// runs on `dev` pushes and pull_request only (.github/workflows/audit.yml:23-27),
// so the prod-drift scenario cannot reach the stricter half.
// ---------------------------------------------------------------------------
const onDisk = (h) => fs.existsSync(path.join(ROOT, h.file));

// The reverse check: a harness on disk that this table has never heard of. An
// unlisted harness is the exact failure this runner exists to end, so it is
// reported loudly rather than silently not run.
function undeclared() {
  const known = new Set(['tools/audit_all.mjs']);   // this runner is not a harness
  for (const h of HARNESSES) known.add(h.file);
  for (const n of NOT_RUN) for (const f of n.file.split(',')) known.add(f.trim());
  const found = [];
  const scan = (dir, re) => {
    let names = [];
    try { names = fs.readdirSync(path.join(ROOT, dir)); } catch (_e) { return; }
    for (const n of names) if (re.test(n)) {
      const rel = dir === '.' ? n : dir + '/' + n;
      if (!known.has(rel)) found.push(rel);
    }
  };
  scan('tools', /(_test|\.test)\.(mjs|js|cjs)$/);
  scan('tools', /^audit_.*\.mjs$/);
  scan('gamecube', /\.test\.mjs$/);
  scan('lib', /\.test\.js$/);
  // ⚠ THE SWEEP HAD A HOLE EXACTLY WHERE THE NETPLAY WORK LIVES — widened
  // 2026-09-13. It never looked inside dreamcast/tools or gamecube/tools, so
  // five files whose own names end in `_test.mjs` could sit there run by
  // nobody AND reported by nobody: dreamcast/tools/{lockstep_pump,
  // netplay_unreachable,vmu_two_player}_test.mjs and
  // gamecube/tools/{gc_room,recomp_fourport}_test.mjs. This file's whole claim
  // is "a gap is a line you can read, not a silence", and that claim was only
  // true of tools/. It also never looked for the `*_check.mjs` naming that
  // three netplay rigs use (one of which, netplay_relay_check, IS a harness
  // above), nor for tools/stamp_lib_versions.mjs — a gate by its own header
  // that matched no pattern here at all.
  scan('dreamcast/tools', /(_test|\.test)\.(mjs|js)$/);
  scan('gamecube/tools', /(_test|\.test)\.(mjs|js)$/);
  scan('tools', /_check\.mjs$/);
  // WIDENED AGAIN 2026-09-14 to `tools/*_probe.mjs`. "probe" is not a synonym
  // for "no verdict": tools/genesis_determinism_probe.mjs ends
  // `process.exit(failures === 0 ? 0 : 1)` (:648) and tools/disc_bytes_probe.mjs
  // exits 1 and 2 (:334, :246), and BOTH were invisible to every pattern here.
  // They are in NOT_RUN now, each with its reason.
  // ⚠ SCOPED TO tools/ ON PURPOSE, and this is the omission rather than an
  // oversight: gamecube/tools and dreamcast/tools hold the emulators' own
  // canonical probes (CLAUDE.md gates #1 and #8), which the blanket NOT_RUN
  // entry above excludes as a class — but that entry's `file` is the literal
  // string "gamecube/tools/*, dreamcast/tools/* (probes)" and this sweep does
  // no globbing, so sweeping *_probe.mjs there would report five files that are
  // already excluded by a class rule. The *_test.mjs sweeps in those two
  // directories stay, because a file named _test is claiming to be a test.
  // NOT SWEPT AT ALL: `.sh`. tools/ holds three — preflight_all.sh (a harness
  // above), probe_lock.sh (the mutex these runs take, not a gate) and
  // n64_jit_sweep.sh (named inside the n64_jit_diff_test NOT_RUN entry) — and
  // dreamcast/tools/verify_core_tree.sh is the `dc-core-drift` harness. All
  // four are accounted for by name today; a fifth would not be.
  scan('tools', /_probe\.mjs$/);
  return found;
}

if (LIST) {
  console.log(`\n${C.b}HARNESSES (${HARNESSES.length})${C.x}\n`);
  for (const h of HARNESSES) {
    console.log(`  ${C.b}${h.name}${C.x}  ${C.d}${h.file}${C.x}`);
    console.log(`      ${h.desc}`);
    console.log(`      ${C.d}fast=${h.fast ? 'yes' : 'no'}  ci=${h.ci ? 'yes' : 'no'}  server=${h.server ? 'yes' : 'no'}${C.x}`);
    if (!h.ci) console.log(`      ${C.y}not in CI:${C.x} ${h.ciWhy}`);
  }
  console.log(`\n${C.b}DECLARED AND NOT RUN (${NOT_RUN.length})${C.x}\n`);
  for (const n of NOT_RUN) console.log(`  ${n.file}\n      ${n.why}`);
  const u = undeclared();
  if (u.length) console.log(`\n${C.r}UNDECLARED${C.x}  ${u.join(', ')}`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// selection
// ---------------------------------------------------------------------------
const unknownOnly = ONLY.filter((n) => !HARNESSES.some((h) => h.name === n));
const unknownSkip = SKIP.filter((n) => !HARNESSES.some((h) => h.name === n));
if (unknownOnly.length || unknownSkip.length) {
  console.error('unknown harness name(s): ' + [...unknownOnly, ...unknownSkip].join(', '));
  console.error('known: ' + HARNESSES.map((h) => h.name).join(', '));
  process.exit(2);
}

const plan = [];
for (const h of HARNESSES) {
  let skipWhy = null;
  if (ONLY.length && !ONLY.includes(h.name)) continue;             // silent: not selected
  if (!onDisk(h)) { plan.push({ h, missing: true }); continue; }
  if (SKIP.includes(h.name)) skipWhy = '--skip';
  else if (FAST && !h.fast) skipWhy = '--fast (not in the fast set)';
  else if (CI && !h.ci) skipWhy = 'not CI-viable: ' + h.ciWhy;
  else {
    // path.resolve, NOT path.join: a harness can require an artifact OUTSIDE the
    // repo (a rig's capture under /tmp), and join() turns "/tmp/x" into
    // "<repo>/tmp/x", which never exists — so the row SKIPped forever with a
    // reason that read exactly like a real missing file.
    const missing = (h.requires || []).filter((p) => !fs.existsSync(path.resolve(ROOT, p)));
    if (missing.length) skipWhy = 'missing asset(s): ' + missing.join(', ');
    // A harness can also need a CREDENTIAL rather than a file. Same rule as
    // `requires`: SKIP with the reason named, never a pass and never a red for
    // something unrelated to the change. The harness itself still refuses to
    // report a pass without its key when run directly.
    const noEnv = (h.requiresEnv || []).filter((k) => !process.env[k]);
    if (!skipWhy && noEnv.length) skipWhy = 'no ' + noEnv.join(', ') + ' in the environment';
  }
  plan.push({ h, skipWhy });
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------
const started = new Date();
console.log('='.repeat(78));
console.log(`  AUDIT ALL — ${HARNESSES.length} declared harnesses, ${plan.filter((p) => !p.skipWhy && !p.missing).length} selected to run`);
console.log(`  ${started.toISOString()}   node ${process.version}   ${os.platform()}/${os.arch()}`);
console.log('='.repeat(78));

reap('start');
const loadStart = load1();
console.log(`[load] 1-min load average at start: ${loadStart}  (CLAUDE.md: a pair taken above ~25 is void)`);

const CHROME = resolveChrome();
const needsBrowser = plan.some((p) => !p.skipWhy && !p.missing && p.h.server);
if (CHROME) console.log(`[chrome] ${CHROME}`);
else if (needsBrowser) console.log(`${C.y}[chrome] none found — browser harnesses will fail; set CHROME_PATH${C.x}`);

let server = null;
if (plan.some((p) => !p.skipWhy && !p.missing && p.h.server)) {
  server = await ensureServer();
  if (server === 'dead') {
    console.error('[serve] could not bring up the local server — browser harnesses cannot run');
    server = null;
  }
}
const stopServer = () => {
  if (server && server !== 'dead' && !server.killed) {
    console.log('[serve] stopping the server this run started');
    try { server.kill('SIGTERM'); } catch (_e) {}
  }
};
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stopServer(); process.exit(130); });

const env = { ...process.env, ORIGIN };
if (CHROME) env.CHROME_PATH = CHROME;

const results = [];
for (const { h, skipWhy, missing } of plan) {
  if (missing) {
    console.log(`\n${C.r}MISSING${C.x}  ${C.b}${h.name}${C.x}  ${C.d}declared as ${h.file}, not present in this tree${C.x}`);
    results.push({ name: h.name, file: h.file, status: 'MISSING', ci: !!h.ci, fast: !!h.fast, why: 'declared but not on disk', ms: 0 });
    continue;
  }
  if (skipWhy) {
    console.log(`\n${C.y}SKIP${C.x}  ${C.b}${h.name}${C.x}  ${C.d}(${skipWhy})${C.x}`);
    results.push({ name: h.name, file: h.file, status: 'SKIP', why: skipWhy, ms: 0 });
    continue;
  }
  console.log(`\n${'-'.repeat(78)}`);
  console.log(`RUN   ${C.b}${h.name}${C.x}   ${h.cmd.join(' ')}   ${C.d}load=${load1()}${C.x}`);
  console.log(`      ${C.d}${h.desc}${C.x}`);
  const r = await runOne(h, env);
  const secs = (r.ms / 1000).toFixed(1);
  const tail = r.out.trimEnd().split('\n').slice(-12);
  console.log(C.d + tail.map((l) => '      | ' + l).join('\n') + C.x);
  const badge = r.status === 'PASS' ? `${C.g}PASS${C.x}` : `${C.r}FAIL${C.x}`;
  console.log(`${badge}  ${h.name}  ${secs}s  (${r.note})`);
  results.push({
    name: h.name, file: h.file, status: r.status, code: r.code,
    ms: r.ms, note: r.note, tail,
  });
}

stopServer();
reap('end');
const loadEnd = load1();

// ---------------------------------------------------------------------------
// summary
// ---------------------------------------------------------------------------
const pass = results.filter((r) => r.status === 'PASS');
const fail = results.filter((r) => r.status === 'FAIL');
const skip = results.filter((r) => r.status === 'SKIP');
const gone = results.filter((r) => r.status === 'MISSING');
// ⚠ A DECLARED ci:true GATE THAT VANISHED USED TO EXIT 0 — fixed 2026-09-14.
// The last line of this file was `process.exit(fail.length ? 1 : 0)`, so MISSING
// was printed, written to the JSON, and then ignored. That is not theoretical
// here: the shared git INDEX on this box holds seven staged deletions of files
// that are still on disk (measured: `git ls-tree -r --name-only HEAD | wc -l`
// = 8189 vs `git ls-files | wc -l` = 8182), and two of them are rows in the
// table above — tools/undelivered.mjs (fast:true ci:true) and
// tools/ps1_determinism_probe.mjs — plus gamecube/tools/gc_room_test.mjs, which
// is the `gamecube-room` row. A bare commit from that index deletes a CI gate,
// CI prints MISSING, and the badge stays GREEN. A gate you can delete without
// going red is not a gate.
const goneCi = gone.filter((r) => r.ci);
const totalMs = results.reduce((a, r) => a + r.ms, 0);

console.log('\n' + '='.repeat(78));
console.log('  SUMMARY');
console.log('='.repeat(78));
console.log(`  ${'HARNESS'.padEnd(26)}${'VERDICT'.padEnd(9)}${'TIME'.padStart(8)}   NOTE`);
console.log('  ' + '-'.repeat(74));
for (const r of results) {
  const badge = r.status === 'PASS' ? `${C.g}PASS${C.x}   `
    : r.status === 'FAIL' ? `${C.r}FAIL${C.x}   `
    : r.status === 'MISSING' ? `${C.r}MISSING${C.x}` : `${C.y}SKIP${C.x}   `;
  const t = r.ms ? (r.ms / 1000).toFixed(1) + 's' : '-';
  console.log(`  ${r.name.padEnd(26)}${badge}${t.padStart(8)}   ${(r.note || r.why || '').slice(0, 78)}`);
}
console.log('  ' + '-'.repeat(74));
console.log(`  ${pass.length} passed, ${fail.length} FAILED, ${skip.length} skipped, ${gone.length} missing   total ${(totalMs / 1000 / 60).toFixed(1)} min`);
console.log(`  load: ${loadStart} at start -> ${loadEnd} at end`);
if (fail.length) console.log(`  ${C.r}FAILED:${C.x} ${fail.map((f) => f.name).join(', ')}`);
if (gone.length) console.log(`  ${C.r}DECLARED BUT ABSENT FROM THIS TREE:${C.x} ${gone.map((f) => f.name + ' (' + f.file + ')').join(', ')}`);
if (goneCi.length) console.log(`  ${C.r}…and ${goneCi.length} of those is a ci:true GATE — THIS RUN IS RED:${C.x} ${goneCi.map((f) => f.name).join(', ')}`);

const u = undeclared();
if (u.length) {
  console.log('\n  ' + C.r + 'UNDECLARED HARNESSES' + C.x + ' — on disk, in neither the run table nor NOT_RUN:');
  for (const f of u) console.log('    ' + f);
  console.log('  Add each to HARNESSES (to run it) or to NOT_RUN (with the reason). Until then it is untested.');
}

console.log('\n  NOT RUN BY DESIGN (' + NOT_RUN.length + ' entries) — see --list for the reasons.');
console.log('  json: ' + JSON_OUT);

fs.writeFileSync(JSON_OUT, JSON.stringify({
  when: started.toISOString(),
  node: process.version, platform: os.platform() + '/' + os.arch(),
  chrome: CHROME, origin: ORIGIN,
  args: argv, fast: FAST, ci: CI,
  loadStart, loadEnd, totalMs,
  counts: { pass: pass.length, fail: fail.length, skip: skip.length, missing: gone.length, declared: HARNESSES.length },
  results,
  notRun: NOT_RUN,
  undeclared: u,
}, null, 2));

// A run that executed NOTHING is the silent green this whole file exists to
// end: every cell skipped or missing, exit 0, and a CI badge that means nothing.
if (pass.length + fail.length === 0) {
  console.log(`\n  ${C.r}NOTHING RAN${C.x} — every selected harness was skipped or absent. That is not a pass.`);
  process.exit(1);
}

// A ci:true row that is not on disk is a REMOVED GATE, and a removed gate is a
// failure, not a note. Rows that are ci:false stay non-fatal on purpose: those
// are the ones whose files legitimately differ between branches and checkouts,
// which is the case the "WHY NOT FATAL" note above was written for. Every
// harness still RUNS either way — nothing is aborted, only the verdict changes.
process.exit(fail.length || goneCi.length ? 1 : 0);

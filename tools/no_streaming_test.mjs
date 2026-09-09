#!/usr/bin/env node
// ONLINE PLAY IS LOCKSTEP ON EVERY PAGE, AND NO PAGE MAY STREAM.
//
// WHY THIS EXISTS. The user cancelled streaming outright: "WE WILL NOT USE
// STREAMING!" — every player runs their own core and only pad bytes cross the
// wire. Dreamcast was converted. Six other pages and seven *_multiplayer.html
// pages were not, and NOTHING NOTICED, because no test anywhere asserted the
// architecture. Measured before this file existed:
//     dreamcast.html   lockstep=56  lsInput=4
//     gamecube.html    lockstep=2   lsInput=0
//     ps1/snes/gba/genesis.html, n64/index.html   lockstep=0
//     all seven *_multiplayer.html                lockstep=0, several with mpVideo
// Every one of those pages passed its own tests, by correctly implementing the
// architecture that had been cancelled. A requirement that lives only in a
// conversation is not a requirement; this is the machine-checkable form of it.
//
// It is a SOURCE check on purpose. The streaming machinery is identifiable by
// name, and a page that still carries it can still reach it — proving absence
// by driving the UI would need every page booted with a room formed, which is
// the expensive rig this cheap gate exists to sit in front of.
//
// USAGE  node tools/no_streaming_test.mjs
import fs from 'node:fs';

// Pages that offer online play. A page with no online play at all is not a
// failure — it is simply not in scope, and is reported as such rather than
// silently skipped.
const PAGES = [
  'dreamcast.html', 'gamecube.html', 'ps1.html', 'snes.html', 'gba.html',
  'genesis.html', 'n64/index.html',
  'dreamcast_multiplayer.html', 'gamecube_multiplayer.html', 'ps1_multiplayer.html',
  'snes_multiplayer.html', 'gba_multiplayer.html', 'genesis_multiplayer.html',
  'n64_multiplayer.html',
];

// Machinery that only exists to stream one machine's picture to another. Each
// is the name of a thing, not a coincidence of English.
const STREAMING = [
  'attachMedia(',        // publishes the captured canvas+audio into the session
  'netCaptureSurface',   // grabs the running canvas to publish
  'captureStream(',      // the capture itself
  'mpVideo',             // the <video> a guest watched instead of running a core
  'netVideo',            // dreamcast's former equivalent
  'remoteStream(',       // reading the far side's media
];

// Evidence the page drives the lockstep loop itself, rather than merely
// mentioning it. `lsInput`/`beginFrame` are the frame-gated feed; a page that
// says "lockstep" in a comment and never feeds a frame is still streaming.
const LOCKSTEP = ['beginFrame', 'lsInput', 'lsNormalize', 'submitHash'];

// ⚠ COMMENTS MUST BE STRIPPED AS BLOCKS, NOT AS LINES. A page that REMOVED the
// streaming machinery says so in prose — dreamcast.html:394 reads "There is no
// #netVideo any more" inside a multi-line HTML comment, and a line-prefix filter
// counted that as evidence the machinery was present. A gate that fails a page
// for documenting its own fix is a gate nobody will keep.
function stripComments(s) {
  return s
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
}

// A LOBBY is a real and correct piece of this architecture, not a half-converted
// page: it agrees on a game and a room code and then HANDS EVERY PLAYER — host
// and joiners alike — to the page that actually runs a core. It therefore drives
// no frame loop of its own and never should. Requiring beginFrame of it would
// force a lobby to pretend to be an emulator.
// What IS required of one is stricter than the old check, not looser: it must
// carry no streaming machinery, and it must hand off to a page that itself
// passes this gate.
const LOBBY_HANDOFF = {
  'n64_multiplayer.html':      { to: 'n64/index.html',   link: /\/n64\/\?np=|'\/n64\/'/ },
  'dreamcast_multiplayer.html':{ to: 'dreamcast.html',   link: /dreamcast\.html\?np=/ },
  'gamecube_multiplayer.html': { to: 'gamecube.html',    link: /gamecube\.html\?np=/ },
};

let fail = 0, scoped = 0, skipped = 0;
const verdict = {};
for (const p of PAGES) {
  let s;
  try { s = fs.readFileSync(p, 'utf8'); }
  catch (e) { console.log(`  SKIP  ${p} — not present`); skipped++; continue; }

  // ⚠ SCOPE IS DECIDED ON LIVE CODE, NOT ON PROSE — the same rule this file
  // already applies to the machinery scan below, and for the same reason. It
  // used to test the RAW source, so a page that had REMOVED its online play and
  // explained the removal in a comment was still scoped as an online page and
  // then failed for not driving a frame loop it deliberately no longer has.
  // MEASURED: gamecube.html, whose only remaining matches were two historical
  // comments describing a menu entry that is not in the DOM (there is no
  // #mNet/#btnNet element on that page at all).
  const stripped = stripComments(s);
  const online = /netHostBtn|lobbyCard|Play Online|NetplayHost|Netplay\.(Session|Lockstep|makeCode)/.test(stripped);
  if (!online) { console.log(`  n/a   ${p} — no online play`); skipped++; continue; }
  scoped++;

  // ⚠ COMMENTS MUST BE STRIPPED AS BLOCKS, NOT AS LINES. A page that REMOVED
  // the streaming machinery says so in prose — dreamcast.html:394 reads "There
  // is no #netVideo any more" inside a multi-line HTML comment, and a
  // line-prefix filter counted that as evidence the machinery was present. A
  // gate that fails a page for documenting its own fix is a gate nobody will
  // keep. Strip <!-- -->, block comments and // lines, then scan what is left.
  const live = stripped;
  const streams = STREAMING.filter((k) => live.includes(k));
  const drives  = LOCKSTEP.filter((k) => live.includes(k));

  const lobby = LOBBY_HANDOFF[p];
  if (streams.length) {
    console.log(`  FAIL  ${p} — still carries streaming machinery: ${streams.join(', ')}`);
    verdict[p] = false; fail++;
  } else if (lobby) {
    // A lobby passes on the hand-off, and the hand-off must be REAL: the URL it
    // sends players to has to appear in live code, not in a comment.
    if (!lobby.link.test(live)) {
      console.log(`  FAIL  ${p} — a lobby must hand players to ${lobby.to}, and no such hand-off is in its live code`);
      verdict[p] = false; fail++;
    } else {
      console.log(`  PASS  ${p} — lobby, no streaming machinery, hands off to ${lobby.to}`);
      verdict[p] = true;
    }
  } else if (!drives.length) {
    console.log(`  FAIL  ${p} — offers online play but drives no lockstep frame loop (looked for ${LOCKSTEP.join(', ')})`);
    verdict[p] = false; fail++;
  } else {
    console.log(`  PASS  ${p} — lockstep (${drives.join(', ')}), no streaming machinery`);
    verdict[p] = true;
  }
}

// A lobby that hands off to a page which itself FAILS is not a pass — it is a
// working front door onto a broken room.
for (const [p, l] of Object.entries(LOBBY_HANDOFF)) {
  if (verdict[p] !== true) continue;
  if (verdict[l.to] === false) {
    console.log(`  FAIL  ${p} — hands off to ${l.to}, which does not pass this gate`);
    fail++;
  }
}

console.log(`\n${scoped - fail}/${scoped} online pages are lockstep-only; ${skipped} not in scope`);
if (fail) {
  console.log('\nStreaming was cancelled by user directive: every player runs their own core and only');
  console.log('pad bytes cross the wire. A page listed FAIL above either still streams or offers');
  console.log('online play without driving the frame gate.');
}
process.exit(fail ? 1 : 0);

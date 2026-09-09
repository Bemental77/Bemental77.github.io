#!/usr/bin/env node
// ---------------------------------------------------------------------------
// STATIC INVARIANTS THAT NO BROWSER RIG CAN CATCH.
//
// Every netplay rig here drives two browsers through a HEALTHY room: both sides
// get seated, both learn the disc, both press Ready. That is the right thing to
// test and it is structurally blind to the failures that only appear when some
// piece of room state is MISSING — because a passing rig never produces a
// missing piece.
//
// The one that reached the user: dreamcast.html routed the local controller as
//
//     const ports = (ls && ls.localPorts && ls.localPorts.length) ? ls.localPorts : [0];
//
// so a console that did not know its seat yet wrote its pad into PORT 0 and
// took over Player 1's character. lib/netplay.js documents a real path where
// `localPorts` stays EMPTY, so this was reachable, not theoretical. The rig
// passed anyway — `each-sides-own-pad-reaches-its-OWN-core` was GREEN — because
// in the rig both sides are always seated.
//
// These assertions are about the SHAPE of the code for exactly those cases.
// They are cheap, need no browser, and fail loudly on a revert.
// ---------------------------------------------------------------------------
import { readFileSync, existsSync } from 'fs';

let pass = 0; const fails = [];
const ok  = (n) => { pass++; console.log('  PASS  ' + n); };
const bad = (n, why) => { fails.push(n); console.log('  FAIL  ' + n + '\n        ' + why); };

const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null);
const dc = read('dreamcast.html');
const np = read('lib/netplay.js');

if (!dc || !np) {
  console.error('[netplay-invariants] FATAL: cannot read dreamcast.html or lib/netplay.js — refusing to report a pass');
  process.exit(2);
}

// ---- 1. AN UNSEATED CONSOLE MUST NOT DRIVE PORT 0 -------------------------
// ⚠ EVERY CONSOLE, NOT JUST THE ONE THE BUG WAS REPORTED ON. This checked only
// dreamcast.html at first — and a sweep then found the IDENTICAL line in
// ps1.html:1278, n64/index.html:3213 and genesis.html:647, all four written the
// same way. A gate that only guards the page somebody happened to complain about
// leaves the same defect live on every other console that shares the engine.
{
  // snes.html joined 2026-09-09, the day it gained a second controller. A page
  // is added HERE at the same time it gains a room — not after somebody reports
  // the bug on it, which is the whole point of the paragraph above.
  const PAGES = ['dreamcast.html', 'ps1.html', 'n64/index.html', 'genesis.html', 'snes.html'];
  for (const page of PAGES) {
    const src = read(page);
    if (!src) continue;
    const n = 'unseated-console-does-not-hijack-port-0 [' + page + ']';
    const bare = /localPorts[^\n]*\?[^\n]*:\s*\[0\]\s*;/.test(src);
    const guarded = /NEVER FALL BACK TO PORT 0/.test(src) && /inRoom/.test(src);
    if (bare && !guarded) {
      bad(n, page + ' falls back to port 0 when localPorts is empty. In a room that means writing ' +
             'this machine\'s pad into ANOTHER PLAYER\'S controller — the user hit this as "player 2 ' +
             'took over as player 1". No seat must mean NO pad; only a solo console (no session) may ' +
             'assume port 0.');
    } else ok(n);
  }
}

// ---- 2. THE READY LABEL MUST NOT CONTRADICT THE DISABLED STATE ------------
{
  const n = 'ready-button-label-names-its-blocker';
  // The regression: textContent computed from load progress alone while
  // `disabled` also required a seat, so a dead button read "I'm ready".
  const namesSeat = /Waiting for a seat in the room/.test(dc);
  if (!namesSeat) {
    bad(n, 'the Ready button can be DISABLED for want of a seat while its label still reads ' +
           '"I\'m ready". A disabled control eats the click silently, so the player presses it ' +
           'again and again with no feedback — reported verbatim three times. The label must ' +
           'state the actual blocker.');
  } else ok(n);
}

// ---- 3. READINESS MUST NOT BE CIRCULAR ------------------------------------
{
  const n = 'declaring-ready-is-visible-before-the-barrier-releases';
  // The regression: ready was derived ONLY from state running/stalled, but
  // declareReady() sets state 'waiting' — so declaring could not show until the
  // barrier released, which required everyone to have declared.
  const usesDeclared = /declaredReady/.test(dc) && /declaredReady/.test(np);
  if (!usesDeclared) {
    bad(n, 'the room derives "ready" from the engine STATE alone. declareReady() sets the state to ' +
           '"waiting", so a peer that HAS declared renders as not-ready until the barrier releases — ' +
           'and the barrier only releases once everyone is ready. The only feedback that the press ' +
           'worked is the thing the press was supposed to cause.');
  } else ok(n);
}

// ---- 4. THE ROOM'S DISC MUST BE OWNED BY THE ENGINE THAT PUBLISHES IT -----
{
  const n = 'lockstep-engine-owns-the-room-disc';
  // The regression: _sendRoster published `this.game` from inside class
  // Lockstep, which never assigned it — the only `this.game =` was in class
  // NetplaySession. Every roster carried game:null and no joiner was ever told
  // which disc the room was for.
  // ⚠ ANCHOR ON THE DECLARATION, NOT THE NAME. A bare indexOf('class Lockstep')
  // matches the first PROSE mention of it — and this file's comments name both
  // classes while explaining the very bug being asserted here, so the boundary
  // landed hundreds of lines early and the check failed on correct code. The
  // instrument was wrong, not the source. Match a real declaration at the start
  // of a line instead.
  const declAt = (name) => {
    const m = new RegExp('^\\s*class\\s+' + name + '\\b', 'm').exec(np);
    return m ? m.index : -1;
  };
  const lsStart = declAt('Lockstep');
  const sessStart = declAt('NetplaySession');
  const assigns = [...np.matchAll(/this\.game\s*=\s*opts\.game/g)].map((m) => m.index);
  const inLockstep = assigns.some((i) => i > lsStart && i < sessStart);
  if (!(lsStart >= 0 && sessStart > lsStart && inLockstep)) {
    bad(n, 'class Lockstep does not assign this.game, but _sendRoster() publishes `game: this.game`. ' +
           'The roster then carries game:null forever, the room-game event never fires, and every ' +
           'joiner keeps whatever disc its own picker held.');
  } else ok(n);
}

// ---- 5. ENGINE EVENTS THE PAGE LISTENS FOR MUST BE FORWARDED --------------
{
  const n = 'lockstep-events-reach-the-session-listeners';
  // The regression: the page does s.on('room-game') on the SESSION while
  // Lockstep emitted it on ITSELF, and startLockstep's forwarding list did not
  // carry it. Same for roster-evicted.
  const missing = [];
  for (const ev of ['room-game', 'roster-evicted']) {
    const pageListens = new RegExp("\\.on\\('" + ev + "'").test(dc);
    const forwarded = new RegExp("ls\\.on\\('" + ev + "'").test(np);
    const emitted = new RegExp("_emit\\('" + ev + "'").test(np);
    if (pageListens && emitted && !forwarded) missing.push(ev);
  }
  if (missing.length) {
    bad(n, 'Lockstep emits ' + missing.join(', ') + ' on ITSELF, the page subscribes on the SESSION, ' +
           'and startLockstep() does not forward it — so the event never arrives. This is how a ' +
           'guest received the room\'s disc in the engine and still booted its own.');
  } else ok(n);
}

// ---- 6. A JOINER MUST NOT PUBLISH THE ROOM'S DISC -------------------------
{
  const n = 'a-joiner-does-not-name-the-rooms-disc';
  // Two separate writers of ?game= both let a joiner publish its own picker.
  const badWriter = /netRememberRoomInUrl\(\s*code\s*,\s*\(\s*\$\('romSelect'\)/.test(dc);
  const badHandoff = /if \(joining\) q\.set\('game'/.test(dc);
  if (badWriter || badHandoff) {
    bad(n, 'a joiner writes its OWN picker into the room URL. The room disc belongs to the HOST; a ' +
           'joiner publishing its default put two consoles in one room on two different games, each ' +
           'correctly gated at frame 0, waiting on a barrier that can never release.');
  } else ok(n);
}

console.log(`\n[netplay-invariants] ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log('These are the shapes that produced user-visible netplay failures. A browser rig');
  console.log('cannot catch them because a healthy room never exercises the missing-state path.');
  process.exit(1);
}

#!/usr/bin/env node
// ---------------------------------------------------------------------------
// THE INPUT DELAY COULD ONLY EVER GO UP, AND THE PLAYER PAID FOR IT ALL EVENING.
//
// Reported from a live room, photographed:
//
//     input delay 30 frames (1000 ms) · frame 2446 · core ran 2438
//     stalled 57.8 s total
//
// 30 is the CEILING, and it is not what that link costs. Asked on the same
// build, in the browser, Lockstep.recommendDelay() answers:
//
//     30 fps:  0ms->1f  100ms->3f  200ms->4f  300ms->6f  500ms->9f
//
// so even a 500 ms round trip asks for 9 frames. 1000 ms of lag is roughly
// three times worse than the worst link the recommender contemplates. It is the
// stall ratchet — 2 -> 4 -> 6 -> 9 -> 13 -> 19 -> 28 -> 30 — climbed during a
// rough patch and then kept forever, because lowering was refused by design.
//
// The refusal named a REAL hazard: the scheduling block queues at f + delay
// unconditionally, so a smaller delay re-sends a frame already on the wire with
// different bytes, which is a fork. That is an argument for picking the right
// frame, not for never lowering. These are the cells for the frame it picks.
//
// ⚠ THE FIRST VERSION OF THIS FILE REPORTED 4 PASSES OVER A GUEST. The
// constructor option is `host`, not `isHost` (lib/netplay.js:1277), so every
// object it built had isHost=false and _scheduleDelay returned on its first
// line. Two cells failed loudly and TWO PASSED VACUOUSLY — including
// "the-step-down-stops-at-the-floor", which was really measuring that a guest
// never steps down at all.
// ---------------------------------------------------------------------------
import { readFileSync } from 'fs';
globalThis.window = globalThis; globalThis.self = globalThis;
new Function(readFileSync('lib/netplay.js', 'utf8'))();
const L = globalThis.Netplay.Lockstep;
let now = 0;
const sent = [];
const mk = () => { const ls = new L({ peerId:'H', host:true, localPorts:[0], portCount:4, padBytes:8,
  delay:2, send:(m)=>sent.push(m), now:()=>now });
  ls.roster=['H','G',null,null]; ls.state='running'; return ls; };
let pass=0, fail=0;
const ok=(n,d)=>{pass++;console.log('  PASS  '+n+(d?' — '+d:''));};
const bad=(n,d)=>{fail++;console.log('  FAIL  '+n+' — '+d);};

// 1. A LOWERING IS SCHEDULED AT A FRAME THAT CLEARS THE QUEUE.
{
  const ls = mk(); ls.delay = 30; ls.frame = 70; ls._queuedTo = 100;
  sent.length = 0;
  const r = ls._scheduleDelay(29);
  const pd = ls._pendingDelay;
  (r && pd && pd.d === 29 && pd.down === true && pd.at === 100 - 29 + 1)
    ? ok('a-lowering-is-scheduled-past-everything-already-queued',
         `at=${pd.at} (queuedTo ${100} - d ${29} + 1), d=${pd.d}`)
    : bad('a-lowering-is-scheduled-past-everything-already-queued', JSON.stringify(pd));
  // and it is announced on the wire so the guest applies the SAME change at the SAME frame
  const w = sent.find((m) => m.t === 'lsdelay');
  (w && w.at === pd.at && w.d === 29)
    ? ok('the-lowering-is-announced-to-the-room', JSON.stringify(w))
    : bad('the-lowering-is-announced-to-the-room', JSON.stringify(sent));
}
// 2. APPLYING IT BACKFILLS NOTHING.
{
  const ls = mk(); ls.delay = 30; ls.frame = 72; ls._queuedTo = 100;
  ls._pendingDelay = { at: 72, d: 29, down: true };
  sent.length = 0;
  ls._applyPendingDelay(72);
  (ls.delay === 29 && sent.filter((m) => m.t === 'ls').length === 0)
    ? ok('applying-a-lowering-sends-no-input', `delay now ${ls.delay}, ${sent.length} message(s)`)
    : bad('applying-a-lowering-sends-no-input', `delay ${ls.delay}, sent ${JSON.stringify(sent)}`);
}
// 3. THE FRAME ALREADY ON THE WIRE IS NEVER RE-SENT.
{
  const ls = mk(); ls.delay = 5; ls.frame = 80; ls._queuedTo = 100; ls._scheduledTo = 80;
  sent.length = 0;
  ls.beginFrame([new Uint8Array(8)]);
  const dupes = sent.filter((m) => m.t === 'ls' && m.f <= 100);
  dupes.length === 0
    ? ok('a-shorter-lead-never-re-sends-a-queued-frame',
         `f+delay = ${80 + 5} is inside the queue (through 100) and nothing was sent`)
    : bad('a-shorter-lead-never-re-sends-a-queued-frame', JSON.stringify(dupes));
  ls._scheduledTo > 80
    ? ok('a-skipped-frame-still-advances', `_scheduledTo = ${ls._scheduledTo}`)
    : bad('a-skipped-frame-still-advances', 'the same frame would be retried forever and the room would stop');
}
// 4. IT NEVER GOES BELOW WHAT THE LINK ASKED FOR.
{
  const ls = mk(); ls.delay = 2; ls._delayFloor = 2; ls.frame = 10; ls._queuedTo = 12;
  ls._lastStallAt = 0; now = 999999;
  const moved = ls._maybeGiveDelayBack();
  (!moved && ls.delay === 2)
    ? ok('the-step-down-stops-at-the-floor', 'delay stayed at the measured floor of 2')
    : bad('the-step-down-stops-at-the-floor', `delay ${ls.delay}`);
}
// 5. A RAISE STILL WINS, IMMEDIATELY.
{
  const ls = mk(); ls.delay = 4; ls.frame = 10; ls._queuedTo = 14;
  const r = ls._scheduleDelay(6);
  (r && ls._pendingDelay && ls._pendingDelay.d === 6 && !ls._pendingDelay.down)
    ? ok('raising-still-works-and-is-not-a-lowering', JSON.stringify(ls._pendingDelay))
    : bad('raising-still-works-and-is-not-a-lowering', JSON.stringify(ls._pendingDelay));
}
console.log(`\n[delay] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

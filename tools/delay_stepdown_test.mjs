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
// 6. THE FLOOR IS THE DELAY CHOSEN AT READY, NOT THE CONSTRUCTOR'S.
// Cell 4 sets `_delayFloor` by hand and so could never see this: the floor was
// assigned ONCE, in the constructor, from opts.delay (2-3), while every page
// chooses the real delay AFTER construction by assigning it — dreamcast.html
// `ls.delay = want`, n64/index.html the same, and the relay path's
// `this.ls.delay = this.relay.delayFrames`. A room that started at 9 carried a
// floor of 2, so the give-back walked it below what the RTT asked for and the
// next stall raised it by half again. begin() now snapshots the delay in force.
{
  // built the way the pages build it: default delay, then the measured one assigned
  const ls = new L({ peerId:'H', host:true, localPorts:[0], portCount:4, padBytes:8,
    send:(m)=>sent.push(m), now:()=>now });
  ls.roster=['H','G',null,null];
  const ctorFloor = ls._delayFloor;
  ls.delay = 9;
  ls.begin();                                   // the host, right after it sends lsgo
  (ls.state === 'running' && ls._delayFloor === 9)
    ? ok('the-floor-is-the-delay-in-force-at-begin',
         `constructor floor ${ctorFloor}, delay set to 9 before begin() -> floor ${ls._delayFloor}`)
    : bad('the-floor-is-the-delay-in-force-at-begin',
          `state ${ls.state}, floor ${ls._delayFloor} (constructor had ${ctorFloor})`);
  // the calm window has GENUINELY elapsed — a nonzero last stall, well in the past —
  // so the floor is the only thing that can stop the step-down here
  ls.frame = 10; ls._queuedTo = 19; ls._lastStallAt = 1000; ls._lastGiveBackAt = 0;
  now = 1000 + ls.delayCalmMs + 1;
  sent.length = 0;
  const moved = ls._maybeGiveDelayBack();
  (!moved && ls.delay === 9 && !ls._pendingDelay && !sent.some((m) => m.t === 'lsdelay'))
    ? ok('the-step-down-never-goes-below-the-delay-chosen-at-ready',
         `delay stayed at 9 with ${now - ls._lastStallAt} ms of calm (calm window ${ls.delayCalmMs} ms)`)
    : bad('the-step-down-never-goes-below-the-delay-chosen-at-ready',
          `delay ${ls.delay}, pending ${JSON.stringify(ls._pendingDelay)}, sent ${JSON.stringify(sent)}`);
  // and on the SAME clock a stall-raised delay still comes back down toward 9 — so
  // the cell above held because of the floor, not because the calm had not elapsed
  ls.delay = 13; ls._queuedTo = 23; ls._pendingDelay = null; ls._lastGiveBackAt = 0;
  const r = ls._maybeGiveDelayBack();
  (r && ls._pendingDelay && ls._pendingDelay.d === 12 && ls._pendingDelay.down === true)
    ? ok('a-stall-raised-delay-still-steps-down-toward-that-floor', `13 -> ${ls._pendingDelay.d} on the same clock`)
    : bad('a-stall-raised-delay-still-steps-down-toward-that-floor', JSON.stringify(ls._pendingDelay));
  // a GUEST takes the same floor from lsgo, which adopts m.delay and then calls begin()
  const g = new L({ peerId:'G', host:false, localPorts:[1], portCount:4, padBytes:8, send:()=>{}, now:()=>now });
  g.receive({ t:'lsgo', delay:9, hashEvery:0, portCount:4, padBytes:8, r:['H','G',null,null] });
  (g.state === 'running' && g.delay === 9 && g._delayFloor === 9)
    ? ok('a-guest-adopts-the-same-floor-from-lsgo', `delay ${g.delay}, floor ${g._delayFloor}`)
    : bad('a-guest-adopts-the-same-floor-from-lsgo', `state ${g.state}, delay ${g.delay}, floor ${g._delayFloor}`);
}
console.log(`\n[delay] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

#!/usr/bin/env node
// governor_sim.mjs — discrete-event model of the Dreamcast pump governor
// (dreamcast/flycast_libretro/flycast_worker.js pumpTick), OLD vs NEW:
//   OLD: setTimeout sleep; behind > 17 ms -> rebase (the debt is dropped)
//   NEW: deadline sleep (Atomics.wait for what is left after the render hold);
//        debt repaid up to 100 ms, only the excess dropped
// Guest frame = 33.33 ms (PSO renders at 30/s). It is a MODEL of the decision
// logic, not a measurement: the browser runs are in
// dreamcast/docs/governor-pacing/TASKS.md. The "no headroom" case uses this
// box's measured Pioneer 2 costs (11 ms emu + 27 ms render hold) and lands on
// the measured 0.86-0.88x under both governors.
//   node dreamcast/tools/governor_sim.mjs
// rate = guest/wall over 120 s; maxWin/minWin = extreme 1 s windows;
// maxLeadAtFrameStart = how far guest leads wall when a frame STARTS (> 0 = a
// sprint past the wall clock; the sub-ms values are the <= 1 ms the governor
// does not bother sleeping).
function rng(seed){ let s=seed>>>0; return ()=>((s=Math.imul(s^(s>>>15),2246822507)^Math.imul(s^(s>>>13),3266489909))>>>0)/4294967296; }
function run(mode, cfg, seed=1){
  const r=rng(seed); const FR=1000/30; let maxLS=-1e9, wall=0, guest=0, baseW=null, baseG=0, drop=0, maxAhead=-1e9, wins=[], lastWinW=0, lastWinG=0;
  const OLD = mode==='old';
  for (let it=0; wall<cfg.T; it++){
    // run one frame
    let busy = cfg.busy*(0.8+0.4*r()); if (r()<cfg.spikeP) busy += cfg.spike;
    wall += busy; guest += FR;
    // render hold happens at end of the task
    const hold = cfg.hold;
    if (baseW===null){ baseW=wall; baseG=guest; }
    let lead = (guest-baseG) - (wall-baseW);
    if (lead > maxAhead) maxAhead = lead;
    let delay=0;
    if (OLD){ if (lead < -17 || lead > 250){ if(lead<-17) drop+=-lead; baseW=wall; baseG=guest; } else delay=Math.max(0,Math.min(50,lead)); }
    else { if (lead>250){baseW=wall;baseG=guest;} else if (lead < -100){ const d=-lead-100; baseW+=d; drop+=d; } else delay=Math.max(0,Math.min(50,lead)); }
    wall += hold;
    if (delay>1){
      if (OLD) wall += Math.max(delay - hold, 0) + cfg.timerLate*r()*2; // timer fires late; hold already elapsed counts toward it
      else wall += Math.max(0, delay - hold) + 0.1;                      // deadline: only what is left, sub-ms wake
    }
    // the guest must never lead the wall clock at the START of a frame
    const leadStart = (guest-baseG)-(wall-baseW); if (leadStart > maxLS) maxLS = leadStart;
    if (wall-lastWinW >= 1000){ wins.push((guest-lastWinG)/(wall-lastWinW)); lastWinW=wall; lastWinG=guest; }
  }
  const rate = guest/wall; // includes start
  return { mode, rate: +rate.toFixed(4), dropMsPerS: +(drop/(wall/1000)).toFixed(1), maxWin: +Math.max(...wins).toFixed(4), minWin: +Math.min(...wins).toFixed(4), maxLeadAfterFrame: +maxAhead.toFixed(1), maxLeadAtFrameStart: +maxLS.toFixed(2) };
}
const cases = {
  'headroom, late timer (+0..80ms), no hold': { T: 120000, busy: 11, spike: 40, spikeP: 0.03, hold: 0, timerLate: 40 },
  'headroom, accurate timer, spikes':          { T: 120000, busy: 11, spike: 40, spikeP: 0.03, hold: 0, timerLate: 0.5 },
  'headroom, 15ms hold, late timer':           { T: 120000, busy: 11, spike: 40, spikeP: 0.03, hold: 15, timerLate: 40 },
  'no headroom (11 emu + 27 hold)':            { T: 120000, busy: 11, spike: 0, spikeP: 0, hold: 27, timerLate: 40 },
};
for (const [k,c] of Object.entries(cases)) { console.log('## '+k); for (const m of ['old','new']) console.log('  '+JSON.stringify(run(m,c))); }

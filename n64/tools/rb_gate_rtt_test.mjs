#!/usr/bin/env node
// rb_gate_rtt_test.mjs — A CAPACITY-GATED ROLLBACK ROOM NEVER HAS MORE INPUT LAG
// THAN A DELAY-LOCKSTEP ROOM ON THE SAME LINK.
//
// n64/docs/rollback-default/RESULTS.md measured every gated N64 room dropping to
// delay at 9-17 frames where lockstep runs the RTT-chosen 6, for four causes.
// This pins the engine's half of each fix, with no browser:
//   rtt-switch-*   a room whose host measured the link before Ready (Lockstep
//                  rttDelay — Session.rttReport sets it, as the N64 page now
//                  does for rollback hosts too) switches to EXACTLY the delay a
//                  lockstep room on that link starts at, never the
//                  trailing-inflated input lateness; never slower than that
//                  lockstep room; 0 desyncs; every state equals a straight run.
//   rtt-start      a console that reported an unaffordable step at Ready starts
//                  the room in delay at exactly that delay (no transient at all).
//   capdelay-unit  Lockstep._capDelay returns rttDelay whatever the lateness says.
//   warmup-unit    during CAP_WARM_MS a console records no capacity sample and
//                  the host decides on the step alone (at CAP_RS_START): a deep
//                  start-up burst switches nothing; a step that is unaffordable
//                  on its own still does.
// The tools/netplay_rb_capacity_test.mjs cells (no rttDelay: the fallback
// sizing) must keep passing alongside this.
// USAGE  node n64/tools/rb_gate_rtt_test.mjs [--secs N]
import { simulate, judge } from '../../tools/netplay_rb_pace_sim.mjs';
const { Lockstep } = globalThis.Netplay;

const argv = process.argv.slice(2);
const flag = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : d; };
const SECS = +flag('secs', '40');
const F = 1000 / 60;
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n + (d ? '  ' + d : '')); } else { fail++; console.log('  FAIL  ' + n + (d ? '  ' + d : '')); } };

// The delay a page picks for a delay-lockstep room on this link (the same
// samples tools/netplay_rb_capacity_test.mjs pageDelay uses).
function pageDelay(players, ow, jit) {
  const samples = {};
  for (let g = 1; g < players; g++) samples['G' + g] = [2 * ow, 2 * ow + jit, 2 * (ow + jit)];
  return Lockstep.recommendDelayForRoom(samples, F) || 3;
}
// The host's page measured the link before Ready: what Session.rttReport does
// (ls.rttDelay = recommendDelayForRoom; ls.netFloorDelay = floorDelayForRoom).
let RTT = null;
const declareReady = Lockstep.prototype.declareReady;
Lockstep.prototype.declareReady = function (d) {
  if (this.isHost && RTT) { this.rttDelay = RTT.d; if (RTT.floor) this.netFloorDelay = RTT.floor; }
  return declareReady.call(this, d);
};
const base = (r) => judge(r).filter((x) => !/no fingerprints compared/.test(x) || !(r.compared > 0));

console.log('=== gated rollback with the RTT-chosen delay: never more lag than delay lockstep ===');
for (const players of [2, 4]) for (const ow of [50, 100]) {
  const name = `rtt-switch-${players}p-${ow}ms`;
  const jit = 10 + 0.2 * ow;
  const slow = players === 2 ? 'G1' : 'G3';
  const d = pageDelay(players, ow, jit);
  const cell = { name, secs: SECS, seed: 11 + ow + players, players, baseMs: ow, jitterMs: jit, loss: 0.02,
                 stepMs: { [slow]: 16 }, runFrac: 0.75, readyStepMs: {} };   // nothing known at Ready: the room starts in rollback
  RTT = { d };
  const g = simulate(cell);
  RTT = null;
  const l = simulate(Object.assign({}, cell, { lockstep: true, delay: d, catchUp: false }));
  const bad = base(g);
  const sw = g.consoles.H.modes.find((m) => m.to === 'delay');
  const maxDelay = Math.max(...Object.values(g.consoles).map((c) => c.modes.filter((m) => m.to === 'delay').reduce((a, m) => Math.max(a, m.delay), 0)));
  if (!sw) bad.push('no switch to delay (a 16 ms step at 60 Hz needs 120%)');
  else if (!(sw.frame > 0)) bad.push('the room started in delay: this cell is the switch mid-room');
  else if (sw.delay !== d) bad.push('switched to ' + sw.delay + ' frames, lockstep starts at ' + d);
  if (maxDelay > d) bad.push('a switch went to ' + maxDelay + ' > ' + d);
  if (g.minRate < l.minRate - 0.005) bad.push('gated ' + g.minRate + 'x < lockstep ' + l.minRate + 'x');
  ok(name, !bad.length, `gated ${g.minRate.toFixed(4)}x, switch ${sw ? 'delay(' + sw.delay + ')@' + sw.frame + ' t=' + (sw.t / 1000).toFixed(1) + 's' : 'none'}, end delay ${g.consoles.H.delay}`
    + ` | lockstep d=${d} ${l.minRate.toFixed(4)}x, end delay ${l.consoles.H.delay} | desync ${g.desyncs} truth ${g.truthChecked - g.truthBad}/${g.truthChecked}`
    + (bad.length ? '\n        ' + bad.join('; ') : ''));
}

{
  const d = pageDelay(2, 50, 20);
  RTT = { d };
  const r = simulate({ name: 'rtt-start', secs: 20, seed: 5, players: 2, baseMs: 50, jitterMs: 20, loss: 0.02, runFrac: 0.75,
                       readyStepMs: { G1: 16 }, stepMs: { G1: 16 } });
  RTT = null;
  const bad = base(r);
  const m0 = r.consoles.H.modes[0];
  if (!m0 || m0.frame !== 0 || m0.to !== 'delay') bad.push('the room did not start in delay: ' + JSON.stringify(m0));
  else if (m0.delay !== d) bad.push('started at ' + m0.delay + ' frames, lockstep starts at ' + d);
  ok('rtt-start', !bad.length, `start ${m0 ? m0.to + '(' + m0.delay + ')@' + m0.frame : 'none'} vs lockstep d=${d}, room ${r.minRate.toFixed(4)}x, desync ${r.desyncs}`
    + (bad.length ? '\n        ' + bad.join('; ') : ''));
}

// ---- unit: _capDelay ----------------------------------------------------------
function hostEngine(extra) {
  let T = 1000;
  const sent = [];
  const ls = new Lockstep(Object.assign({ host: true, peerId: 'H', portCount: 2, padBytes: 2, rollback: 8, frameHz: 50,
                                           now: () => T, send: (m) => sent.push(m) }, extra || {}));
  return { ls, sent, at: (t) => { T = t; } };
}
{
  const { ls } = hostEngine({ rttDelay: 6 });
  ls._rbLateIn = Array.from({ length: 40 }, (_, i) => 12 + (i % 5));   // a console trailing the room: 12-16 frames late
  const rows = [{ peer: 'H' }, { peer: 'G1', li: 16 }];
  const a = ls._capDelay(rows);
  ls.rttDelay = 0;
  const b = ls._capDelay(rows);
  ok('capdelay-unit', a === 6 && b > 6, `rttDelay 6 -> ${a}; not measured -> ${b} (the lateness sizing, kept as the fallback)`);
}

// ---- unit: the warm-up ------------------------------------------------------------
{
  const mk = (st) => {
    const h = hostEngine();
    const { ls } = h;
    ls.roster = ['H', null]; ls.localPorts = [0];
    ls.state = 'running'; ls._capGate = true; ls.selfStepMs = st; ls._paceBornAt = 0;
    ls.expectedPeers = () => [];
    ls._capWarmUntil = 1000 + 5000;
    // a start-up burst: 64 corrections 16 deep, one every other frame
    ls._capDepths = Array(64).fill(16); ls._capSelfCr = 0.5; ls._capSelfRs = 4;
    return h;
  };
  // 6 ms step at 50 Hz: 0.375 of the time on its own; the burst reads far over CAP_HI.
  const a = mk(6);
  for (let t = 1500; t <= 5500; t += 500) { a.at(t); a.ls._capDecide(t); }
  const inWarm = a.ls._modeNext;
  a.at(6500); a.ls._capDecide(6500); a.at(7000); a.ls._capDecide(7000); a.at(7500); a.ls._capDecide(7500);
  const after = a.ls._modeNext;
  // 16 ms step at 50 Hz: 1.0 on its own — not a transient.
  const b = mk(16);
  for (let t = 3500; t <= 4500; t += 500) { b.at(t); b.ls._capDecide(t); }
  const slowInWarm = b.ls._modeNext;
  // and a console records nothing during it
  const c = mk(6); c.ls._capSelfPrev = { frames: 0, resim: 0, rollbacks: 0, at: 0 };
  c.ls._capSelfMeasure(2000);
  ok('warmup-unit', !inWarm && !!after && !!slowInWarm && c.ls._capSelfPrev === null,
     `burst during warm-up: ${inWarm ? 'SWITCHED' : 'no switch'}; same burst after it: ${after ? 'switch (need ' + a.ls._capNeed + ')' : 'NO SWITCH'}; `
     + `an unaffordable step during it: ${slowInWarm ? 'switch' : 'NO SWITCH'}; samples during it: ${c.ls._capSelfPrev === null ? 'none' : 'TAKEN'}`);
}

console.log(`\n[rb-gate-rtt] ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);

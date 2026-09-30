#!/usr/bin/env node
// ============================================================================
// netplay_rb_drop_test.mjs — A HITCH MUST NOT KILL THE ROOM.
//
// A real phone+desktop room died with "engine stopped: no input from
// 76e494f866656aac for 8s": the phone's tab went to the background (its link
// ICE-disconnected), and the HOST failed the whole room after stallBudgetMs.
// Now (lib/netplay.js _silentPeers / _rbGuestRejoin):
//   * nobody fails the room on a stall by default (stallBudgetMs 0);
//   * the HOST drops a player it has heard NOTHING from for RB_DROP_AFTER_MS —
//     their controller goes limp at an agreed frame and the others play on;
//   * when that page comes back it is refilled from the host's input store
//     ('lsfillq'/'lsfill'), catches up as hidden frames, asks back in
//     ('lsrejoin'), and gets its controller back at a future frame ('lsundrop');
//   * every message names a PLAYER, never a peer id.
// Driven by tools/netplay_rb_pace_sim.mjs's model (real engines, star, 2% loss,
// jitter): a guest's tab stops for 6 s (no ticks, no messages either way).
//
// USAGE  node tools/netplay_rb_drop_test.mjs
// ============================================================================
import { simulate, judge } from './netplay_rb_pace_sim.mjs';
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n + (d ? '  ' + d : '')); } else { fail++; console.log('  FAIL  ' + n + (d ? '  ' + d : '')); } };
console.log('=== rollback: a silent player is dropped, the room plays on, and they rejoin ===');
for (const [players, ow, who] of [[2, 50, 'G1'], [2, 100, 'G1'], [4, 100, 'G2']]) {
  const tag = `${players}p-${ow}ms`;
  const r = simulate({ name: tag, secs: 40, players, baseMs: ow, jitterMs: 10 + 0.2 * ow, loss: 0.02,
                       outage: { id: who, from: 12000, to: 18000 } });
  const ev = r.events;
  const leaveH = ev.find((e) => e.at === 'H' && e.ev === 'leave');
  const rejoinH = ev.find((e) => e.at === 'H' && e.ev === 'rejoin');
  const leaveBack = ev.find((e) => e.at === who && e.ev === 'leave');
  const rejoinBack = ev.find((e) => e.at === who && e.ev === 'rejoin');
  const failed = Object.entries(r.consoles).filter(([, c]) => c.state !== 'running' && c.state !== 'stalled');
  ok(`${tag}/the-room-never-fails`, !failed.length, failed.map(([id, c]) => id + ' ' + c.state + ': ' + c.error).join('; ') || 'every console running at the end');
  ok(`${tag}/the-silent-player-is-dropped-by-label`, !!leaveH && /^player \d/.test(leaveH.who) && !/[0-9a-f]{16}/.test(JSON.stringify(ev)),
     leaveH ? `host dropped "${leaveH.who}" at frame ${leaveH.frame}, ${((leaveH.t - 12000) / 1000).toFixed(2)} s into the silence` : 'no drop');
  const others = Object.entries(r.consoles).filter(([id]) => id !== who);
  const minOther = Math.min(...others.map(([, c]) => c.frames));
  ok(`${tag}/the-others-play-on`, minOther > 60 * (40 - 5) * 0.9, `others ran ${others.map(([id, c]) => id + ' ' + c.frames).join(', ')} frames in 40 s (limp for the drop, stalled only until it)`);
  ok(`${tag}/the-player-comes-back`, !!rejoinH && !!rejoinBack && rejoinH.t > 18000,
     rejoinH ? `back at frame ${rejoinH.frame}, ${((rejoinH.t - 18000) / 1000).toFixed(2)} s after the tab returned; it learned of its drop ${!leaveBack ? 'NOT AT ALL' : leaveBack.missed ? 'from the refill\'s limp table (the live notice was lost with its link)' : 'live'}` : 'never rejoined');
  const back = r.consoles[who];
  ok(`${tag}/it-caught-up-to-the-room`, Math.abs(back.frames - r.consoles.H.frames) <= 3 + (back.window || 0),
     `${who} ${back.frames} frames (${back.hidden} hidden catch-up), host ${r.consoles.H.frames}`);
  ok(`${tag}/no-desync-and-every-state-is-the-straight-run`, r.desyncs === 0 && r.truthBad === 0 && r.truthChecked > 0 && r.compared > 0,
     `desyncs ${r.desyncs}, fingerprints compared ${r.compared}, ${r.truthChecked - r.truthBad}/${r.truthChecked} states equal a straight run (limp frames neutral)`);
  ok(`${tag}/zero-local-lag-throughout`, r.lagBad === 0, `${r.lagBad}/${r.lagN} frames ran a pad other than the one sampled for them`);
  ok(`${tag}/never-past-the-room-clock`, r.aheadMax <= 1.5 && r.creditOver <= 2, `max ${r.aheadMax.toFixed(2)} frames vs room clock, ${r.creditOver.toFixed(2)} credited over own clock`);
}
console.log(`\n[rb-drop] ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);

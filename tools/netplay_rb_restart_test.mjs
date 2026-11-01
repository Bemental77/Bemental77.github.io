#!/usr/bin/env node
// ============================================================================
// netplay_rb_restart_test.mjs — A PAGE THAT RELOADS COMES BACK TO THE MATCH.
//
// A reloaded (or closed-and-reopened) tab is a brand-new core at frame 0 with no
// savestate. It used to sit at "waiting for the host" while the match ran on
// without it (rollback), or be refused outright (delay lockstep: "this room has
// already started"). Now (lib/netplay.js _rsServeRestart / _rsServe / _rsReceive):
//   * the host hands the returning page a restart ('lsgo' rj) and drops its
//     controller (limp) so the room plays on;
//   * the page PULLS the match's confirmed inputs from frame 0 ('lshq'/'lshr'),
//     re-simulates them as hidden frames, asks back in ('lsrejoin') and gets its
//     controller back at a future frame ('lsundrop');
//   * a plain input-delay room does the same when every page declared rsReplay.
// Real engines (tools/netplay_rb_pace_sim.mjs); the verdict is the sim's strong
// one: every fingerprinted state, replayed frames included, equals a straight run.
//
// USAGE  node tools/netplay_rb_restart_test.mjs
// ============================================================================
import { simulate } from './netplay_rb_pace_sim.mjs';
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n + (d ? '  ' + d : '')); } else { fail++; console.log('  FAIL  ' + n + (d ? '  ' + d : '')); } };
console.log('=== a reloaded page is replayed back into the running match ===');
const ARMS = [
  ['rb-2p-50ms-early', { players: 2, baseMs: 50, at: 8000, id: 'G1' }],
  ['rb-2p-50ms-late', { players: 2, baseMs: 50, at: 30000, id: 'G1', secs: 80 }],
  ['rb-4p-100ms', { players: 4, baseMs: 100, at: 12000, id: 'G2' }],
  ['delay-2p-50ms', { players: 2, baseMs: 50, at: 10000, id: 'G1', lockstep: true, rsReplay: true }],
  ['delay-4p-50ms', { players: 4, baseMs: 50, at: 10000, id: 'G3', lockstep: true, rsReplay: true }],
];
for (const [tag, a] of ARMS) {
  const r = simulate({ name: tag, secs: a.secs || 50, players: a.players, baseMs: a.baseMs, jitterMs: 10 + 0.2 * a.baseMs, loss: 0.02,
                       lockstep: !!a.lockstep, rsReplay: !!a.rsReplay, restart: { id: a.id, at: a.at, loadMs: 3000 } });
  const ev = r.events;
  const failed = Object.entries(r.consoles).filter(([, c]) => c.state !== 'running' && c.state !== 'stalled');
  ok(`${tag}/the-room-never-fails`, !failed.length, failed.map(([id, c]) => id + ' ' + c.state + ': ' + c.error).join('; ') || 'every console running at the end');
  const restarted = ev.find((e) => e.at === a.id && e.ev === 'restart');
  ok(`${tag}/the-new-page-is-restarted-by-the-host`, !!restarted, restarted ? `restarted at t=${restarted.t} ms` : 'the host never answered the new page');
  const rejoinBack = ev.find((e) => e.at === a.id && e.ev === 'rejoin');
  ok(`${tag}/its-controller-comes-back`, !!rejoinBack, rejoinBack ? `back at frame ${rejoinBack.frame}` : 'never got its controller back');
  const back = r.consoles[a.id], host = r.consoles.H;
  ok(`${tag}/it-is-level-with-the-room`, Math.abs(back.frame - host.frame) <= 12, `${a.id} frame ${back.frame}, host frame ${host.frame}`);
  const others = Object.entries(r.consoles).filter(([id]) => id !== a.id);
  ok(`${tag}/the-others-play-on`, others.every(([, c]) => c.frame > 60 * ((a.secs || 50) - 8)), others.map(([id, c]) => id + ' f' + c.frame).join(', '));
  ok(`${tag}/no-desync-and-every-state-is-the-straight-run`, r.desyncs === 0 && r.truthBad === 0 && r.truthChecked > 0 && r.compared > 0,
     `desyncs ${r.desyncs}, compared ${r.compared}, ${r.truthChecked - r.truthBad}/${r.truthChecked} states equal a straight run${r.truthBadAt.length ? ' bad: ' + r.truthBadAt.join(',') : ''}`);
}
console.log(`\n[rb-restart] ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);

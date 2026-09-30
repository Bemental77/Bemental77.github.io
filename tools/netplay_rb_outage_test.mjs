#!/usr/bin/env node
// ============================================================================
// netplay_rb_outage_test.mjs — THE ADVERSARIAL REVIEW OF THE ADAPTIVE ROOM,
// KEPT AS A REGRESSION TEST.
//
// An independent review of 05d2f48/05d0423/777df13 found that the first cut of
// "a hitch must not kill the room" killed rooms in new ways. Every rig it used
// is a cell here, each with the failure it caught (lib/netplay.js names the fix
// at each site):
//   host-away        the HOST's tab goes away 3/4/8 s at 20/50/100 ms: it used
//                    to read its own absence as the guest's silence and drop a
//                    healthy guest, who then failed its rewind (5/5 at 100 ms).
//   host-away-4p     host away 4 s in a four-player room: all three guests were
//                    dropped and the room ran 0.894x.
//   link-blip        a 3/5 s LINK outage (the pages keep running) of the guest
//                    or of the host: the guest ran past the drop frame the host
//                    later chose and failed (reviewer: 5/5 at 100 ms).
//   undrop-8pct      three players, 8% loss, 900 ms reliable RTO, a guest away
//                    4 s: 9/24 desynced (the undrop did not purge what had been
//                    confirmed on the neutral pad), then consoles failed deep
//                    rewinds (the input frontier stayed past the undrop frame),
//                    then the room FROZE after a rejoin (the host's ack only
//                    rode 'ls', which a stalled host does not send).
//   undrop-2pct      the same at 2%, 40 seeds.
//   seed-38          the returning player compared fingerprints before it
//                    learned it had been dropped.
//   lockstep-9s      a DELAY-LOCKSTEP guest away 9 s: it was dropped, never
//                    heard the drop, and stalled forever. Delay lockstep cannot
//                    take a player back, so it keeps the bounded failure, named
//                    by player — never a silent hang.
//   no-catchup-page  a rollback room whose pages did not declare rbCatchUp
//                    (ps1.html, n64/index.html): a guest away 4 s was left limp
//                    19 s. Such a room is not adaptive and nobody is dropped.
//   mixed-version    a new host with a guest still on the pre-adaptive engine
//                    (git ffc0f52), and both old: the new host dropped the old
//                    guest, which has no way back (6/6 failed or desynced).
//
// USAGE  node tools/netplay_rb_outage_test.mjs [--quick]
// ============================================================================
import { simulate } from './netplay_rb_pace_sim.mjs';
const QUICK = process.argv.includes('--quick');
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n + (d ? '  ' + d : '')); } else { fail++; console.log('  FAIL  ' + n + (d ? '  ' + d : '')); } };
const failedOf = (r) => Object.entries(r.consoles).filter(([, c]) => c.state === 'failed' || c.state === 'desync').map(([k, c]) => k + ' ' + c.state + ': ' + String(c.error || '').slice(0, 70));
const drops = (r) => r.events.filter((e) => e.at === 'H' && e.ev === 'leave').length;
const seeds = (n) => Array.from({ length: QUICK ? Math.min(2, n) : n }, (_, i) => i + 1);

console.log('=== the adaptive rollback room under the reviewer\'s outages ===');
{
  let runs = 0, dropped = 0, bad = [];
  for (const dur of [3000, 4000, 8000]) for (const ms of [20, 50, 100]) for (const seed of seeds(5)) {
    const r = simulate({ name: 'x', seed, secs: 30, players: 2, baseMs: ms, jitterMs: 10 + 0.2 * ms, loss: 0.02, outage: { id: 'H', from: 12000, to: 12000 + dur } });
    runs++; dropped += drops(r);
    const f = failedOf(r); if (f.length || r.desyncs || r.truthBad) bad.push(`${dur}ms@${ms} s${seed}: ${f.join('; ')} desync ${r.desyncs} truth ${r.truthBad}`);
  }
  ok('host-away/no-guest-is-dropped-for-the-hosts-absence', dropped === 0, `${dropped} drops in ${runs} rooms whose HOST tab was away 3-8 s`);
  ok('host-away/nobody-fails-or-desyncs', !bad.length, bad.slice(0, 3).join(' | ') || `${runs} rooms`);
}
{
  const r = simulate({ name: 'x', seed: 1, secs: 30, players: 4, baseMs: 50, jitterMs: 20, loss: 0.02, outage: { id: 'H', from: 12000, to: 16000 } });
  const others = ['G1', 'G2', 'G3'].map((k) => r.consoles[k].frames);
  ok('host-away-4p/no-guest-dropped-and-the-room-goes-on', drops(r) === 0 && !failedOf(r).length && r.desyncs === 0,
     `drops ${drops(r)}, failed ${failedOf(r).join('; ') || 'none'}, guests ${others.join('/')} frames, host ${r.consoles.H.frames}`);
}
{
  let runs = 0, bad = [], rejoinMissing = 0;
  for (const id of ['G1', 'H']) for (const dur of [3000, 5000]) for (const ms of [20, 50, 100]) for (const seed of seeds(5)) {
    const r = simulate({ name: 'x', seed, secs: 30, players: 2, baseMs: ms, jitterMs: 10 + 0.2 * ms, loss: 0.02, outage: { id, from: 12000, to: 12000 + dur }, linkOnly: true });
    runs++;
    const f = failedOf(r); if (f.length || r.desyncs || r.truthBad) bad.push(`${id} ${dur}ms@${ms} s${seed}: ${f.join('; ')} desync ${r.desyncs} truth ${r.truthBad}`);
    const lv = r.events.find((e) => e.at === 'H' && e.ev === 'leave'), rj = r.events.find((e) => e.at === 'H' && e.ev === 'rejoin');
    if (lv && !rj) rejoinMissing++;
  }
  ok('link-blip/nobody-fails-or-desyncs', !bad.length, bad.slice(0, 3).join(' | ') || `${runs} rooms with a 3-5 s link outage of the guest or the host`);
  // Two players cannot tell the host's link from the guest's: the guest may be
  // dropped. What matters is that it always comes back.
  ok('link-blip/a-dropped-guest-always-comes-back', rejoinMissing === 0, `${rejoinMissing} rooms left a player limp for good`);
}
for (const [tag, loss, rto, n] of [['undrop-8pct', 0.08, 900, 24], ['undrop-2pct', 0.02, 0, 40]]) {
  let bad = [], runs = 0;
  for (const seed of seeds(n)) {
    const sc = { name: 'u', seed, secs: 30, players: 3, baseMs: 60, jitterMs: 20, loss, outage: { id: 'G2', from: 10000, to: 14000 } };
    if (rto) sc.rtoMs = rto;
    const r = simulate(sc); runs++;
    const f = failedOf(r); if (f.length || r.desyncs || r.truthBad) bad.push(`s${seed}: ${f.join('; ')} desync ${r.desyncs} truth ${r.truthBad}/${r.truthChecked}`);
    const lv = r.events.find((e) => e.at === 'H' && e.ev === 'leave'), rj = r.events.find((e) => e.at === 'H' && e.ev === 'rejoin');
    if (lv && !rj) bad.push(`s${seed}: never taken back`);
    if (Math.abs(r.consoles.G2.frames - r.consoles.H.frames) > 30) bad.push(`s${seed}: G2 ${r.consoles.G2.frames} vs host ${r.consoles.H.frames} frames`);
  }
  ok(`${tag}/rejoin-never-desyncs-fails-or-freezes`, !bad.length, bad.slice(0, 4).join(' | ') || `${runs} three-player rooms, a guest away 4 s, ${loss * 100}% loss`);
}
{
  const r = simulate({ name: 'u', seed: 38, secs: 30, players: 3, baseMs: 60, jitterMs: 20, loss: 0.02, outage: { id: 'G2', from: 10000, to: 14000 } });
  ok('seed-38/the-returning-player-does-not-compare-before-it-knows', !failedOf(r).length && r.desyncs === 0 && r.truthBad === 0 && r.consoles.G2.frames > 1500,
     `failed ${failedOf(r).join('; ') || 'none'}, desyncs ${r.desyncs}, frames ${Object.values(r.consoles).map((c) => c.frames).join('/')}`);
}
{
  // DELAY LOCKSTEP: a guest away 9 s. Bounded, labelled, never a silent hang.
  const r = simulate({ name: 'l', seed: 1, secs: 40, players: 2, baseMs: 30, jitterMs: 5, loss: 0, lockstep: true, delay: 3, outage: { id: 'G1', from: 10000, to: 19000 } });
  const H = r.consoles.H;
  const hung = Object.values(r.consoles).some((c) => c.state === 'stalled');
  ok('lockstep-9s/never-a-silent-hang', !hung && drops(r) === 0,
     `states ${Object.entries(r.consoles).map(([k, c]) => k + ' ' + c.state).join(', ')}; drops ${drops(r)}; host error "${H.error}"`);
  ok('lockstep-9s/the-failure-names-a-player', !H.error || (/player \d/.test(H.error) && !/[0-9a-f]{16}/.test(H.error)), String(H.error));
}
{
  // A rollback room whose pages did NOT declare rbCatchUp: not adaptive.
  const r = simulate({ name: 'n', seed: 1, secs: 30, players: 2, baseMs: 50, jitterMs: 20, loss: 0.02, catchUp: false, outage: { id: 'G1', from: 12000, to: 16000 } });
  const old = simulate({ name: 'n', seed: 1, secs: 30, players: 2, baseMs: 50, jitterMs: 20, loss: 0.02, catchUp: false, oldIds: ['H', 'G1'], outage: { id: 'G1', from: 12000, to: 16000 } });
  ok('no-catchup-page/nobody-is-dropped', drops(r) === 0 && !failedOf(r).length,
     `drops ${drops(r)}; host ${r.consoles.H.frames} frames (pre-adaptive engine: ${old.consoles.H.frames}), guest ${r.consoles.G1.frames} (${old.consoles.G1.frames}); advantage waits ${r.consoles.H.advWaits}/${r.consoles.G1.advWaits} (pre-adaptive ${old.consoles.H.advWaits}/${old.consoles.G1.advWaits})`);
  ok('no-catchup-page/as-good-as-the-pre-adaptive-engine', r.consoles.H.frames >= old.consoles.H.frames - 30 && r.consoles.G1.frames >= old.consoles.G1.frames - 30,
     `frames host ${r.consoles.H.frames} vs ${old.consoles.H.frames}, guest ${r.consoles.G1.frames} vs ${old.consoles.G1.frames}`);
}
for (const [label, oldIds] of [['old-guest-new-host', ['G1']], ['all-old', ['G1', 'H']]]) {
  const bad = [];
  for (const dur of [3000, 6000]) for (const seed of seeds(3)) {
    const r = simulate({ name: 'm', seed, secs: 40, players: 2, baseMs: 50, jitterMs: 20, loss: 0.02, oldIds, outage: { id: 'G1', from: 12000, to: 12000 + dur } });
    if (drops(r) || failedOf(r).length || r.desyncs) bad.push(`${dur}ms s${seed}: drops ${drops(r)} ${failedOf(r).join('; ')} desync ${r.desyncs}`);
  }
  ok(`mixed-version/${label}/an-old-page-is-never-dropped`, !bad.length, bad.join(' | ') || 'a guest on the pre-adaptive engine, away 3 s and 6 s: never dropped, never failed');
}
console.log(`\n[rb-outage] ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);

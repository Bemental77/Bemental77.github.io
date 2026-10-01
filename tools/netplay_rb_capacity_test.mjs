#!/usr/bin/env node
// ============================================================================
// netplay_rb_capacity_test.mjs — A ROOM MUST NEVER RUN SLOWER BECAUSE ROLLBACK
// WAS CHOSEN.
//
// Rollback costs every console a savestate per frame plus every re-simulated
// frame. Measured: a 4x-CPU N64 rollback room ran 0.37x; a phone measured a
// 1.27x cap. lib/netplay.js now GATES rollback on capacity (the block above
// Lockstep._capDecide): the host reads every console's step cost (`st`) and
// steps per frame (`rs`), switches the room to delay lockstep at an agreed
// frame when a console cannot afford rollback, and back with hysteresis.
//
// Driven by tools/netplay_rb_pace_sim.mjs's model (real engines, star, two
// channels, 2% loss + jitter, single-threaded pages paced like genesis.html).
// A delay-lockstep frame costs the core run only (RUN_FRAC of a rollback step:
// no savestate load + save).
//
// CELLS
//   cap-{2,4}p-{0,50,100}ms-{6,16}  one slow console (6 or 16 ms per rollback
//       step) in a room of 2 or 4: the gated room's rate is never below a
//       delay-lockstep room on the same link and devices (the delay a page
//       picks from the RTT, Lockstep.recommendDelayForRoom), 0 desyncs, every
//       fingerprinted state equal to a straight run of the agreed inputs, and
//       nothing ever ahead of the room clock (gate 9).
//       A cell the gate KEEPS in rollback must still show the slow console on
//       >= 0.7 of its display ticks (the corrections' burst is charged at the
//       rate it happens — lib/netplay.js CAP_LOST_FULL).
//   ps1-rare-corrections  the PS1 room: two 8 ms/step consoles at 50 Hz, 100 ms
//       one way, pads changing every 300-900 frames (a handful of corrections a
//       minute). STAYS in rollback at >= 0.995x, zero lag, both presenting
//       >= 0.9 — where the old frequency-blind burst bar read ~120% and switched.
//   ps1-throttled-peer-switches  the same room with one console 2.5x slower
//       (20 ms/step): switches to delay at the same frame everywhere, never
//       below a delay-lockstep room.
//   switch-both-ways  pages that declare rbResume; the slow console recovers
//       (16 -> 1.5 ms) at 20 s: the room goes to delay, then back to rollback,
//       at the SAME frames on every console.
//   start-delay  a console reports a 16 ms step at Ready: the room starts in
//       delay; it recovers at 12 s and the room goes to rollback (pages that
//       never ran a rollback frame can arm their ring — every shipped page).
//   no-flap  the slow console swings 16 <-> 1.5 ms every 3 s: exactly one
//       switch (to delay), no return inside the calm.
//   no-resume  pages WITHOUT rbResume that already ran rollback: the room goes
//       to delay and stays there even after the console recovers.
//   fast-stays  every console fast (1.5 ms): no switch at all.
//   switch-under-8pct-loss / switch-without-lsmode / away-across-the-switch
//       the switch both ways at 8% loss with a 900 ms reliable RTO; with every
//       reliable 'lsmode' lost (only the notice on the host's inputs gets
//       through); and with a console's tab or link away 4 s right across a
//       switch: every console applies every switch at the SAME frame, nobody
//       fails, 0 desyncs, every fingerprint equals a straight run.
// USAGE  node tools/netplay_rb_capacity_test.mjs [--cell a,b] [--secs N] [--json]
// ============================================================================
import { simulate, judge } from './netplay_rb_pace_sim.mjs';
const { Lockstep } = globalThis.Netplay;

const argv = process.argv.slice(2);
const flag = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : d; };
const SECS = +flag('secs', '40');
const RUN_FRAC = 0.75;
const F = 1000 / 60;
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n + (d ? '  ' + d : '')); } else { fail++; console.log('  FAIL  ' + n + (d ? '  ' + d : '')); } };

// The delay a page picks for a delay-lockstep room on this link: per guest,
// samples of its RTT to the host; a star's worst path is guest -> host -> guest.
function pageDelay(players, ow, jit) {
  const samples = {};
  for (let g = 1; g < players; g++) samples['G' + g] = [2 * ow, 2 * ow + jit, 2 * (ow + jit)];
  return Lockstep.recommendDelayForRoom(samples, F) || 3;
}
// What a test may not see in any cell, rollback or delay.
function base(r) {
  return judge(r).filter((x) => !/no fingerprints compared/.test(x) || !(r.compared > 0));
}
const slowId = (players) => players === 2 ? 'G1' : 'G3';
function modesOf(r) {
  const out = {};
  for (const id in r.consoles) out[id] = r.consoles[id].modes.map((m) => m.to + '@' + m.frame).join(',');
  return out;
}
function sameEverywhere(r) {
  const v = Object.values(modesOf(r));
  return v.every((x) => x === v[0]);
}
const only = flag('cell', null);
const want = (n) => !only || only.split(',').includes(n);
const json = argv.includes('--json');

console.log('=== capacity-gated rollback: never slower than delay lockstep, 0 desyncs, the switch both ways ===');
console.log('    (a delay-lockstep frame costs ' + RUN_FRAC + ' of a rollback step; ' + SECS + ' s per cell)');
for (const players of [2, 4]) for (const ow of [0, 50, 100]) for (const slow of [6, 16]) {
  const name = `cap-${players}p-${ow}ms-${slow}`;
  if (!want(name)) continue;
  const jit = 10 + 0.2 * ow;
  const cell = { name, secs: SECS, seed: 7 + ow + players, players, baseMs: ow, jitterMs: jit, loss: 0.02,
                 stepMs: { [slowId(players)]: slow }, runFrac: RUN_FRAC };
  const d = pageDelay(players, ow, jit);
  const g = simulate(cell);
  const l = simulate(Object.assign({}, cell, { lockstep: true, delay: d, catchUp: false }));
  const bad = base(g);
  const sc = g.consoles[slowId(players)], lc = l.consoles[slowId(players)];
  const line = `gated ${g.minRate.toFixed(4)}x (${Object.values(g.consoles).map((c) => c.mode + (c.mode === 'delay' ? c.delay : '')).join('/')}, `
    + `slow presents ${sc.presented}) vs delay-lockstep d=${d} ${l.minRate.toFixed(4)}x (slow presents ${lc.presented})  `
    + `switches ${sc.modes.map((m) => m.to + '@' + m.frame).join(',') || 'none'}  desync ${g.desyncs} cmp ${g.compared} truth ${g.truthChecked - g.truthBad}/${g.truthChecked}`;
  // THE CADENCE (Lockstep._lsCadenceHold): a console switched to delay runs
  // one frame per display tick again, not three (it presented 0.31-0.33 of its
  // ticks before the fix, against 0.96 for the same room started in delay).
  if (sc.mode === 'delay' && !(sc.presented >= 0.7)) bad.push('the slow console presents only ' + sc.presented + ' of its display ticks after the switch (< 0.7)');
  // ...and a room the gate KEEPS in rollback must not show the slow console in
  // clumps either: the burst is charged at its rate (lib/netplay.js
  // CAP_LOST_FULL), which keeps it presenting about three quarters of its ticks.
  if (sc.mode === 'rollback' && !(sc.presented >= 0.7)) bad.push('the slow console stayed in rollback presenting only ' + sc.presented + ' of its display ticks (< 0.7)');
  ok(name, !bad.length && g.minRate >= l.minRate - 0.005 && sameEverywhere(g), line + (bad.length ? '\n        ' + bad.join('; ') : ''));
  if (json) console.log(JSON.stringify({ g, l }));
}

// ---- RARE CORRECTIONS ON A DEEP PATH: THE PS1 ROOM ---------------------------
// PS1 Monster Rancher 2 in a real desktop room (tools/netplay_device_matrix.mjs
// arm d: 100 ms one way + 2% loss; 50 Hz; a rollback step of ~8 ms on the rig's
// box) corrected ~5 times a MINUTE at p90 depth 7, busy ~40% of its time. The
// old burst bar charged each correction as if one came every third tick
// (st x (p90 + 1) / 3F) and read 87-149%, moving every such room to 8-18 frames
// of input delay. Both consoles 8 ms/step at 50 Hz, pads changing every 300-900
// frames: the room STAYS in rollback (zero lag) at >= 0.995x, both consoles
// presenting >= 0.9 of their ticks. And the same room with one console 2.5x
// slower (a CPU-throttled peer, 20 ms/step) still switches to delay at the same
// frame everywhere, never below a delay-lockstep room on the same link.
if (want('ps1-rare-corrections')) {
  const cell = { name: 'ps1', secs: SECS, seed: 21, players: 2, hz: 50, baseMs: 100, jitterMs: 30, loss: 0.02, stepMsAll: 8,
                 padEvery: [300, 601], runFrac: RUN_FRAC };
  let oldBar = 0, newNeed = 0;
  globalThis.__simTick = (p, T) => {
    if (p.id !== 'H' || !p.ls.rollback || T < 5000) return;
    const F = p.ls._frameMs();
    for (const r of p.ls._capRows(T)) if (r.st > 0) oldBar = Math.max(oldBar, r.st * Math.max(r.rs || 1, ((r.dp || 0) + 1) / 3) / F);
    if (p.ls._capNeed > newNeed) newNeed = p.ls._capNeed;
  };
  let r;
  try { r = simulate(cell); } finally { delete globalThis.__simTick; }
  const bad = base(r), c = Object.values(r.consoles);
  const switched = c.some((x) => x.modes.length);
  if (switched) bad.push('switched: ' + JSON.stringify(modesOf(r)));
  for (const [id, x] of Object.entries(r.consoles)) if (!(x.presented >= 0.9)) bad.push(id + ' presents ' + x.presented + ' of its ticks');
  const rb = c.reduce((a, x) => a + (x.rollbacks || 0), 0);
  ok('ps1-rare-corrections', !bad.length && rb > 0,
     `room ${r.minRate.toFixed(4)}x in ${c.map((x) => x.mode).join('/')}, ${rb} corrections (max depth ${Math.max(...c.map((x) => x.maxDepth || 0))}), `
     + `presents ${c.map((x) => x.presented).join('/')}, lag ${r.lagBad}/${r.lagN}, desync ${r.desyncs}, truth ${r.truthChecked - r.truthBad}/${r.truthChecked}; `
     + `peak need ${Math.round(newNeed * 100)}% (the old burst bar read ${Math.round(oldBar * 100)}%)` + (bad.length ? '\n        ' + bad.join('; ') : ''));
  const tc = Object.assign({}, cell, { stepMsAll: undefined, stepMs: { H: 8, G1: 20 } });
  const g = simulate(tc);
  const l = simulate(Object.assign({}, tc, { lockstep: true, delay: pageDelay(2, 100, 30), catchUp: false }));
  const tbad = base(g), sc = g.consoles.G1;
  if (sc.mode !== 'delay' || !g.consoles.H.modes.length) tbad.push('the throttled console did not switch the room (' + JSON.stringify(modesOf(g)) + ')');
  if (!sameEverywhere(g)) tbad.push('switch frames differ: ' + JSON.stringify(modesOf(g)));
  if (!(g.minRate >= l.minRate - 0.005)) tbad.push('gated ' + g.minRate + 'x below delay lockstep ' + l.minRate + 'x');
  ok('ps1-throttled-peer-switches', !tbad.length,
     `gated ${g.minRate.toFixed(4)}x (${Object.values(g.consoles).map((x) => x.mode + (x.mode === 'delay' ? x.delay : '')).join('/')}, switch ${sc.modes.map((m) => m.to + '@' + m.frame).join(',') || 'none'}: "${(sc.modes[0] || {}).text || ''}") `
     + `vs delay lockstep ${l.minRate.toFixed(4)}x` + (tbad.length ? '\n        ' + tbad.join('; ') : ''));
}

// ---- the switch, both ways ------------------------------------------------
const shapes = {
  'switch-both-ways': { players: 2, baseMs: 50, jitterMs: 20, rbResume: true, stepMsAt: (id, T) => id === 'G1' ? (T < 20000 ? 16 : 1.5) : null, secs: 60,
    expect: (seq) => seq.length === 2 && seq[0] === 'delay' && seq[1] === 'rollback' },
  'switch-both-ways-4p': { players: 4, baseMs: 50, jitterMs: 20, rbResume: true, stepMsAt: (id, T) => id === 'G3' ? (T < 20000 ? 16 : 1.5) : null, secs: 60,
    expect: (seq) => seq.length === 2 && seq[0] === 'delay' && seq[1] === 'rollback' },
  'start-delay': { players: 2, baseMs: 50, jitterMs: 20, readyStepMs: { G1: 16 }, hintMs: 50, stepMsAt: (id, T) => id === 'G1' ? (T < 12000 ? 16 : 1.5) : null,
    rbResumeLs: true, secs: 50, expect: (seq) => seq.length === 2 && seq[0] === 'delay' && seq[1] === 'rollback' },
  'no-flap': { players: 2, baseMs: 50, jitterMs: 20, rbResume: true, stepMsAt: (id, T) => id === 'G1' ? ((Math.floor(T / 3000) & 1) ? 1.5 : 16) : null, secs: 60,
    expect: (seq) => seq.length === 1 && seq[0] === 'delay' },
  'no-resume': { players: 2, baseMs: 50, jitterMs: 20, stepMsAt: (id, T) => id === 'G1' ? (T < 15000 ? 16 : 1.5) : null, secs: 50,
    expect: (seq) => seq.length === 1 && seq[0] === 'delay' },
  'fast-stays': { players: 4, baseMs: 100, jitterMs: 30, secs: 40, expect: (seq) => seq.length === 0 },
};
for (const name in shapes) {
  if (!want(name)) continue;
  const sh = shapes[name];
  const cell = Object.assign({ name, seed: 5, loss: 0.02, runFrac: RUN_FRAC }, sh);
  // A shipped page keeps measuring its step only on rollback frames; the
  // 'start-delay' room never ran one, so its page's estimate is the one it
  // brought to Ready until a page that declares rbResume refreshes it.
  if (sh.rbResumeLs) { cell.stepMsAt = sh.stepMsAt; cell.rbResume = false; cell.freshStep = true; }
  const r = simulate(cell);
  const bad = base(r);
  const host = r.consoles.H;
  const seq = host.modes.map((m) => m.to);
  const line = `room ${r.minRate.toFixed(4)}x  switches ${host.modes.map((m) => m.to + (m.to === 'delay' ? '(' + m.delay + ')' : '') + '@' + m.frame + ' t=' + (m.t / 1000).toFixed(1) + 's').join(' -> ') || 'none'}`
    + `  same on every console: ${sameEverywhere(r)}  end ${Object.values(r.consoles).map((c) => c.mode).join('/')}`
    + `  desync ${r.desyncs} cmp ${r.compared} truth ${r.truthChecked - r.truthBad}/${r.truthChecked}  lag ${r.lagBad}/${r.lagN}`;
  ok(name, !bad.length && sh.expect(seq) && sameEverywhere(r), line + (bad.length ? '\n        ' + bad.join('; ') : ''));
  if (name === 'switch-both-ways') {
    const ev = host.modes[0];
    ok('switch-both-ways/event-text', !!(ev && /too slow for zero-lag mode; using input delay/.test(ev.text) && r.consoles.G1.modes[0] && r.consoles.G1.modes[0].mine
      && /^this device is too slow for zero-lag mode/.test(r.consoles.G1.modes[0].text)),
      'host: "' + (ev && ev.text) + '" | slow console: "' + (r.consoles.G1.modes[0] && r.consoles.G1.modes[0].text) + '"');
  }
  if (json) console.log(JSON.stringify(r));
}
// ---- the switch under loss, a lost notice, and a console away across it ----
// Every console must apply every switch at the same frame, nobody may fail or
// desync, and every fingerprint must equal a straight run of the agreed inputs.
function adversarial(name, cells) {
  if (!want(name)) return;
  let n = 0, switches = 0;
  const bad = [];
  for (const c of cells) {
    const r = simulate(Object.assign({ name, loss: 0.02, rbResume: true, runFrac: RUN_FRAC }, c));
    n++;
    const seqs = Object.values(r.consoles).map((x) => x.modes.map((m) => m.to + '@' + m.frame).join(','));
    switches += r.consoles.H.modes.length;
    const failed = Object.entries(r.consoles).filter(([, x]) => x.state === 'failed').map(([k, x]) => k + ': ' + x.error);
    if (!seqs.every((x) => x === seqs[0]) || r.desyncs || r.truthBad || !r.truthChecked || failed.length) {
      bad.push(`${c.tag}: switches ${JSON.stringify(seqs)} desync ${r.desyncs} truth ${r.truthChecked - r.truthBad}/${r.truthChecked} ${failed.join(' | ').slice(0, 160)}`);
    }
  }
  ok(name, !bad.length && switches > 0, `${n} rooms, ${switches} switches, every one at the same frame on every console, 0 desyncs, 0 failed` + (bad.length ? '\n        ' + bad.slice(0, 4).join('\n        ') : ''));
}
const slowThenFast = (slow, until) => (id, T) => id === slow ? (T < until ? 16 : 1.5) : null;
{
  const cells = [];
  for (const seed of [1, 2, 3]) for (const players of [2, 3, 4]) for (const ow of [20, 100]) {
    cells.push({ tag: `s${seed}/${players}p/${ow}ms/8%`, seed, secs: 45, players, baseMs: ow, jitterMs: 10 + 0.2 * ow, loss: 0.08, rtoMs: 900,
                 stepMsAt: slowThenFast(players === 2 ? 'G1' : 'G' + (players - 1), 15000) });
  }
  adversarial('switch-under-8pct-loss', cells);
}
if (want('switch-without-lsmode')) {
  // only the notice carried on the host's inputs ('ls' mo): every reliable
  // 'lsmode' is lost
  const L = globalThis.Netplay.Lockstep.prototype, rx = L.receive;
  L.receive = function (m) { if (m && m.t === 'lsmode') return true; return rx.apply(this, arguments); };
  const cells = [];
  for (const seed of [1, 2]) for (const players of [2, 4]) cells.push({ tag: `s${seed}/${players}p`, seed, secs: 45, players, baseMs: 50, jitterMs: 20,
    stepMsAt: slowThenFast(players === 2 ? 'G1' : 'G3', 15000) });
  adversarial('switch-without-lsmode', cells);
  L.receive = rx;
}
{
  const cells = [];
  for (const seed of [1, 2, 3, 4]) for (const players of [2, 3]) for (const at of [2500, 3500, 4500, 30000]) for (const who of ['G1', 'H', 'G2']) for (const linkOnly of [false, true]) {
    if (who === 'G2' && players < 3) continue;
    cells.push({ tag: `s${seed}/${players}p/${who}-away-4s@${at}/${linkOnly ? 'link' : 'tab'}`, seed, secs: 50, players, baseMs: 50, jitterMs: 20, linkOnly,
                 outage: { id: who, from: at, to: at + 4000 }, stepMsAt: slowThenFast('G1', 15000) });
  }
  adversarial('away-across-the-switch', cells);
}
// ---- a player AWAY 15 s from a room the gate moved to delay lockstep ----------
// ⚠ The first cut turned drop/rejoin off with the switch: the room failed for
// everyone ("no input from player 3 for 8s", 0.11x) where the same room without
// the gate played on at 0.93x. Now the delay room drops the silent player at an
// agreed frame, plays on, refills it, catches it up hidden and takes it back.
if (want('away-15s-in-a-delay-room')) {
  const L = globalThis.Netplay.Lockstep.prototype, decide = L._capDecide;
  const bad = [];
  let n = 0, rejoins = 0;
  const rows = [];
  // the away player is a fast one, or the slow console itself
  for (const seed of [1, 2, 3]) for (const [players, away] of [[2, 'G1'], [3, 'G2'], [3, 'G1'], [4, 'G3']]) for (const linkOnly of [false, true]) {
    // (a 16 ms/step console away 15 s catches up at what is left of its own
    // capacity, so the room runs long enough for it to be back)
    const cell = { name: 'away', seed, secs: away === 'G1' ? 90 : 50, players, baseMs: 50, jitterMs: 20, loss: 0.02, runFrac: RUN_FRAC, linkOnly,
                   outage: { id: away, from: 10000, to: 25000 }, stepMsAt: (id) => id === 'G1' ? 16 : null };
    const g = simulate(cell);
    L._capDecide = function () {};
    let ng;
    try { ng = simulate(cell); } finally { L._capDecide = decide; }
    n++;
    const failed = Object.entries(g.consoles).filter(([, x]) => x.state === 'failed' || x.state === 'desync').map(([k, x]) => k + ': ' + x.error);
    const back = g.events.some((e) => e.at === 'H' && e.ev === 'rejoin' && e.who);
    if (back) rejoins++;
    const tag = `s${seed}/${players}p/${away}-away-15s/${linkOnly ? 'link' : 'tab'}`;
    rows.push(`${tag} gated ${g.minRate.toFixed(4)}x (${g.consoles.H.mode}) vs ungated ${ng.minRate.toFixed(4)}x`);
    // gate 9 too: nothing presented above 1.02x, nobody past the room clock
    const g9 = judge(g).filter((x) => /PRESENTED|credited|past the room clock|did not run the pad/.test(x));
    if (g9.length) bad.push(`${tag}: ${g9.join('; ')}`);
    // A two-player delay room drops after LS_DROP_AFTER_MS (6 s) rather than
    // rollback's 2.5 s (lib/netplay.js): the 3.5 s more it stalls is allowed.
    const slack = players === 2 ? 3500 / (cell.secs * 1000) + 0.01 : 0.01;
    if (g.consoles.H.mode !== 'delay' || failed.length || g.desyncs || g.truthBad || !g.truthChecked || !back || g.minRate < ng.minRate - slack) {
      bad.push(`${tag}: mode ${g.consoles.H.mode} rate ${g.minRate} vs ${ng.minRate} rejoined ${back} desync ${g.desyncs} truth ${g.truthChecked - g.truthBad}/${g.truthChecked} ${failed.join(' | ').slice(0, 160)}`);
    }
  }
  ok('away-15s-in-a-delay-room', !bad.length, `${n} rooms in delay lockstep, a player away 15 s: ${rejoins} taken back, none failed, 0 desyncs, never below the ungated room (two players: but for the 3.5 s longer stall before the drop)`
     + '\n        ' + (bad.length ? bad.slice(0, 4).join('\n        ') : rows.slice(0, 4).join('\n        ')));
}
// ---- THE DEVICE CAP ON THE WINDOW (opts.rbMaxWindow, 'lsrb'/'lsready' mw) ----
// A path that wants a deep window (150 ms one way: ~27 frames) and a console
// whose savestate ring holds only 12: the host never decides a window deeper
// than the smallest declared ring (never below RB_WINDOW_MIN), from the start
// (declared at Ready) or when a console declares it later; nobody fails, no
// desync, and the room still runs.
if (want('window-cap')) {
  const bad = [], rows = [];
  for (const [players, atReady] of [[2, true], [4, true], [2, false], [4, false]]) {
    const slow = players === 2 ? 'G1' : 'G2';
    const sc = { name: 'cap', seed: 4, secs: 40, players, baseMs: 150, jitterMs: 40, loss: 0.02 };
    if (atReady) sc.maxWindow = { [slow]: 12 };
    else sc.maxWindowAt = (id, T) => (id === slow && T >= 15000 ? 12 : null);   // its page re-measured memory at 15 s
    const free = simulate(Object.assign({}, sc, { maxWindow: null, maxWindowAt: null }));
    const r = simulate(sc);
    const tag = `${players}p/150ms/${atReady ? 'declared-at-Ready' : 'declared-at-15s'}`;
    const c = Object.values(r.consoles);
    const peak = Math.max(...c.map((x) => x.windowPeak || x.window));
    const end = Math.max(...c.map((x) => x.window));
    const failed = Object.entries(r.consoles).filter(([, x]) => x.state === 'failed' || x.state === 'desync').map(([k, x]) => k + ': ' + x.error);
    rows.push(`${tag}: window peak ${peak}, end ${end} (uncapped room: peak ${Math.max(...Object.values(free.consoles).map((x) => x.windowPeak || x.window))}); room ${r.minRate.toFixed(4)}x; desync ${r.desyncs}; truth ${r.truthChecked - r.truthBad}/${r.truthChecked}`);
    // ...and a capped window the path outgrows is not run at 0.5x: the gate
    // moves the room to delay lockstep, said as a memory limit.
    const sw = r.consoles.H.modes.find((m) => m.to === 'delay');
    rows[rows.length - 1] += `; switch ${sw ? 'delay@' + sw.frame + ' "' + sw.text + '"' : 'none'}`;
    const cappedPeak = atReady ? peak : Math.max(...c.map((x) => x.window));
    // (a four-player 150 ms room needs most of a step's time for its deep
    // corrections, so it may already have switched for TIME before 15 s; and
    // the delay a capped room switches to starts low — inputs looked no later
    // than the cap — and is raised by the pace machinery: >= 0.9x, not 0.5x)
    const memOk = sw && (/cannot keep enough savestates/.test(sw.text) || (!atReady && sw.t < 15000 && /too slow/.test(sw.text)));
    if ((sw && sw.t < 15000 && !atReady ? false : cappedPeak > 12) || failed.length || r.desyncs || r.truthBad || !r.truthChecked || r.minRate < 0.9
        || !memOk || !sameEverywhere(r)) bad.push(rows[rows.length - 1] + ' ' + failed.join(' | '));
  }
  ok('window-cap', !bad.length, 'no window deeper than the smallest declared ring (12), and a room the cap would hold at ~0.5x switches to delay\n        ' + (bad.length ? bad : rows).join('\n        '));
}
console.log(`\n[rb-capacity] ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);

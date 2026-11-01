// node tools/n64_netreport_test.mjs — bounds, serialisation, extraction and diagnosis of the
// netplay flight recorder (n64/N64Wasm/dist/netreport.js).
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const NR = createRequire(import.meta.url)('../n64/N64Wasm/dist/netreport.js');
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('ok  ' + name); };

const fakeNet = (o = {}) => Object.assign({
  role: 'host', state: 'running', frame: 1000, mode: 'rollback', stalls: 2, stallMs: 100, costMaxMs: 21, costAvgMs: 6, advWaits: 1,
  step: { selfStepMs: 5.234, selfPresentMs: 6.1 }, selfCap: 3.2, waitingOn: [],
  rollback: { page: { rollbacks: 40, resimMsTotal: 123, maxResimMs: 9.44, allocated: 12, cap: 20, depthAvg: 2.1, maxDepth: 6 }, state: { size: 4096, ptr: 7, located: true } },
  engine: { delay: 0, mode: { mode: 'rollback', need: 0.41, history: [] },
            rollback: { window: 8, windowPeak: 10, lateP99: 2.5, lateMax: 4, rttFrames: 3.2, rollbacks: 40, ringFrames: 9, silentDrops: 1, holeNaks: 2, meanDepth: 2.1, maxDepth: 6 },
            peersPace: { self: { rtt: 30, lost: 0.01, share: 0.02 }, peers: [{ rtt: 55 }, { rtt: 80 }] }, msgs: { in: { lsnak: 3 } } },
}, o);

ok('extract maps existing getters and tolerates empties', () => {
  const r = NR.extract(fakeNet(), { shown: 58, made: 60, speed: 0.97, viHz: 60, costMs: 5.1 }, { reanchors: 2 }, { u: 4 }, { heapMB: 55.5, timerLagMs: 3 });
  assert.equal(r.mode, 'rollback'); assert.deepEqual(r.rtt, [55, 80]); assert.equal(r.rttMax, 80);
  assert.equal(r.fps, 58); assert.equal(r.aud, 4); assert.equal(r.st, 5.23); assert.equal(r.need, 0.41); assert.equal(r.rbs, 40);
  assert.equal(r.ring, 9); assert.deepEqual(r.ringMem, { size: 4096 });
  const e = NR.extract(null, null, null, null, null);   // nothing available: no throw, all null
  assert.equal(e.fps, null); assert.equal(e.rtt, null);
  assert.equal(NR.extract({ mode: 'lockstep' }).mode, 'delay');
});

ok('sample ring is bounded (rows)', () => {
  const rec = new NR.Recorder({ maxSamples: 50 });
  for (let i = 0; i < 500; i++) rec.sample(i * 1000, { fps: 60 }, null);
  assert.equal(rec.rows.length, 50); assert.equal(rec.droppedRows, 450);
  assert.equal(rec.rows[0].t, 450000); assert.equal(rec.rows[49].t, 499000);
});

ok('events and logs are bounded and strings truncated', () => {
  const rec = new NR.Recorder({ maxEvents: 10, maxLogs: 5 });
  for (let i = 0; i < 100; i++) { rec.event(i, 'x', 'y'.repeat(2000)); rec.log(i, 'z'.repeat(2000)); }
  assert.equal(rec.events.length, 10); assert.equal(rec.logs.length, 5);
  assert.ok(rec.events[0].d.length <= 301); assert.ok(rec.logs[0].s.length <= 301);
  assert.equal(rec.droppedEvents, 90);
});

ok('default capacity is 30 min at 1 Hz and memory stays bounded', () => {
  const rec = new NR.Recorder();
  const row = () => NR.extract(fakeNet(), { shown: 60, viHz: 60 }, {}, {}, {});
  for (let i = 0; i < 4000; i++) rec.sample(i * 1000, row(), fakeNet());
  assert.equal(rec.rows.length, 1800);
  const bytes = rec.serialize().length;
  assert.ok(bytes < 2.5e6, 'full report ' + bytes + ' bytes');
});

ok('serialise round-trips as JSON and respects a byte budget', () => {
  const rec = new NR.Recorder({ meta: { ua: 'x' } });
  for (let i = 0; i < 1800; i++) rec.sample(i * 1000, NR.extract(fakeNet(), { shown: 60 }, {}, {}, {}), null);
  const full = JSON.parse(rec.serialize());
  assert.equal(full.v, 1); assert.equal(full.kind, 'n64-netreport'); assert.equal(full.rows.length, 1800); assert.equal(full.meta.ua, 'x');
  assert.ok(full.summary.fpsMean === 60);
  const cap = 100000, small = rec.serialize(600, cap);
  assert.ok(small.length <= cap, 'budgeted ' + small.length);
  assert.ok(JSON.parse(small).rows.length >= 30);
});

ok('mode switches, desync and failures become events (history deduped)', () => {
  const rec = new NR.Recorder();
  const a = NR.extract(fakeNet(), { shown: 60 }, {}, {}, {});
  rec.sample(0, a, fakeNet());
  const hist = [{ frame: 500, to: 'delay', delay: 3, kind: 'time', mine: true, why: 'host too slow' }];
  const net2 = fakeNet({ mode: 'lockstep' }); net2.engine.delay = 3; net2.engine.mode.history = hist; net2.engine.desync = { frame: 9 }; net2.engine.error = 'boom';
  const b = NR.extract(net2, { shown: 30 }, {}, {}, {});
  rec.sample(1000, b, net2);
  rec.sample(2000, Object.assign({}, b), net2);                     // same history again: no duplicate
  const kinds = rec.events.map((e) => e.k);
  assert.ok(kinds.includes('mode')); assert.equal(kinds.filter((k) => k === 'mode-switch').length, 1);
  assert.ok(kinds.includes('desync')); assert.ok(kinds.includes('failure'));
  assert.ok(rec.events.find((e) => e.k === 'mode-switch').d.includes('host too slow'));
});

const rowsOf = (n, o) => Array.from({ length: n }, (_, i) => Object.assign({ t: i * 1000, fps: 60, viHz: 60, stallMs: 0, rttMax: 20 }, o, o && o.fn ? o.fn(i) : {}));

ok('diagnose: silent when fps is healthy or not sustained', () => {
  assert.equal(NR.diagnose(rowsOf(10, {}), []), null);
  const r = rowsOf(10, {}); for (let i = 5; i < 9; i++) r[i].fps = 20;     // only 4 low seconds at the end? last is 60
  assert.equal(NR.diagnose(r, []), null);
  assert.equal(NR.diagnose(rowsOf(3, { fps: 10 }), []), null);              // too short
});
ok('diagnose: host CPU', () => {
  const d = NR.diagnose(rowsOf(6, { fps: 30, st: 15, sp: 17 }), []);
  assert.equal(d.kind, 'host-cpu'); assert.match(d.text, /host CPU/);
});
ok('diagnose: network RTT', () => {
  const d = NR.diagnose(rowsOf(6, { fps: 30, rttMax: 220, st: 3, fn: (i) => ({ stallMs: i * 500 }) }), []);
  assert.equal(d.kind, 'network'); assert.match(d.text, /RTT 220 ms/);
});
ok('diagnose: slow console is not blamed on the network (RTT 1 ms, stalled 34%, shown 40 of made 62)', () => {
  const d = NR.diagnose(rowsOf(6, { fps: 40, made: 62, rttMax: 1, st: 10, sp: 10, fn: (i) => ({ stallMs: i * 340 }) }), []);
  assert.equal(d.kind, 'host-present'); assert.match(d.text, /this device/); assert.doesNotMatch(d.text, /network/);
  // made unknown, link healthy, stalled, step 60% of a frame: host CPU, still not the network
  const e = NR.diagnose(rowsOf(6, { fps: 40, rttMax: 1, st: 10, sp: 10, fn: (i) => ({ stallMs: i * 340 }) }), []);
  assert.equal(e.kind, 'host-cpu');
});
ok('diagnose: mode flap beats the rest', () => {
  const ev = [{ t: 4000, k: 'mode-switch' }, { t: 5000, k: 'mode' }, { t: 5500, k: 'mode' }];
  const d = NR.diagnose(rowsOf(6, { fps: 30, st: 15 }), ev); assert.equal(d.kind, 'mode-flap');
});
ok('diagnose: unknown is honest', () => {
  const d = NR.diagnose(rowsOf(6, { fps: 30, st: 2, rttMax: 20 }), []); assert.equal(d.kind, 'unknown');
});

// ---- connection path per seat (lib/netplay.js Session.linkReport -> window.__n64Net().links) ----
ok('extract: links become [seat, kind, rtt] and flag a relay', () => {
  const r = NR.extract(fakeNet({ links: [{ port: 1, kind: 'direct', relayed: false, rttMs: 4 }, { port: 2, kind: 'turn', relayed: true, rttMs: 180 }] }), {}, {}, {}, {});
  assert.deepEqual(r.lnk, [[1, 'direct', 4], [2, 'turn', 180]]); assert.equal(r.relayed, 1);
  const b = NR.extract(fakeNet({ links: [{ port: 0, kind: 'broker', relayed: true, rttMs: null }] }), {}, {}, {}, {});
  assert.deepEqual(b.lnk, [[0, 'broker', null]]); assert.equal(b.relayed, 1);
  const d = NR.extract(fakeNet({ links: [{ port: 0, kind: 'stun', relayed: false, rttMs: 30 }] }), {}, {}, {}, {});
  assert.equal(d.relayed, 0);
  const none = NR.extract(fakeNet({}), {}, {}, {}, {}); assert.equal(none.lnk, null); assert.equal(none.relayed, 0); assert.equal(none.build, null);
  assert.equal(NR.extract(fakeNet({ buildMismatch: ['netplay.js'] }), {}, {}, {}, {}).build, 'netplay.js');
});
ok('events: a path change is recorded once, RELAYED is spelled out', () => {
  const rec = new NR.Recorder({});
  const mk = (kind) => NR.extract(fakeNet({ links: [{ port: 1, kind, relayed: kind === 'turn', rttMs: 20 }] }), {}, {}, {}, {});
  rec.sample(0, mk('stun'), null); rec.sample(1000, mk('stun'), null); rec.sample(2000, mk('turn'), null); rec.sample(3000, mk('turn'), null);
  const links = rec.events.filter((e) => e.k === 'link');
  assert.equal(links.length, 1, JSON.stringify(rec.events));        // the FIRST row has no prev, so only the stun -> turn change fires
  assert.match(links[0].d, /seat 2 path stun -> turn \(RELAYED\), rtt 20 ms/);
});
ok('summary + the copied JSON carry the link story', () => {
  const rec = new NR.Recorder({});
  const mk = (kind, bm) => NR.extract(fakeNet({ links: [{ port: 1, kind, relayed: kind === 'turn', rttMs: 20 }], buildMismatch: bm }), {}, {}, {}, {});
  for (let i = 0; i < 4; i++) rec.sample(i * 1000, mk('direct'), null);
  for (let i = 4; i < 10; i++) rec.sample(i * 1000, mk('turn', ['room_core.js']), null);
  const j = JSON.parse(rec.serialize());
  assert.equal(j.summary.relayedSeconds, 6); assert.equal(j.summary.linkKinds.direct, 4); assert.equal(j.summary.linkKinds.turn, 6); assert.equal(j.summary.buildMismatch, true);
  assert.ok(j.rows.every((r) => Array.isArray(r.lnk)));
  assert.ok(j.events.some((e) => e.k === 'build-mismatch'));
});
ok('diagnose: a sustained lag on a RELAYED link says so, and a healthy direct link is not blamed on it', () => {
  const lnk = (kind) => [[1, kind, 150]];
  const d = NR.diagnose(rowsOf(6, { fps: 30, rttMax: 150, st: 3, relayed: 1, lnk: lnk('broker'), fn: (i) => ({ stallMs: i * 500 }) }), []);
  assert.equal(d.kind, 'relay'); assert.match(d.text, /RELAYED \(broker - the lossy signalling-broker channel\)/);
  const t = NR.diagnose(rowsOf(6, { fps: 30, rttMax: 150, st: 3, relayed: 1, lnk: lnk('turn'), fn: (i) => ({ stallMs: i * 500 }) }), []);
  assert.equal(t.kind, 'relay'); assert.match(t.text, /through a relay server/);
  const direct = NR.diagnose(rowsOf(6, { fps: 30, rttMax: 150, st: 3, relayed: 0, lnk: lnk('direct'), fn: (i) => ({ stallMs: i * 500 }) }), []);
  assert.equal(direct.kind, 'network');
  // a relayed link with a quiet wire and a slow CPU is still the CPU
  const cpu = NR.diagnose(rowsOf(6, { fps: 40, rttMax: 5, st: 12, sp: 12, relayed: 1, lnk: lnk('turn'), fn: (i) => ({ stallMs: i * 340 }) }), []);
  assert.equal(cpu.kind, 'host-cpu');
});

console.log('PASS ' + n + ' tests');

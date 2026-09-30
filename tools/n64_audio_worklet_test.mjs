#!/usr/bin/env node
// ---------------------------------------------------------------------------
// DOES N64 AUDIO RIDE THROUGH A ROOM'S STALLS? — the real AudioWorklet
// processor (n64/audio-worklet.js), run in Node against a synthetic producer.
//
// Live report (room 49K4T): "audio cuts out" in a room at 0.93x. The producer
// here is the core as lockstep drives it: one field (20 ms of PAL audio, 882
// stereo frames at 44.1 kHz) per guest frame, handed to the worklet by the
// page's 8 ms pump, at a given room rate with given stalls. The consumer is
// the processor's own process() at the device quantum (128 frames). Counted:
// underruns (the processor ran dry and re-buffered = an audible cut) and
// silenced time.
//
// USAGE  node tools/n64_audio_worklet_test.mjs [--file n64/audio-worklet.js]
// ---------------------------------------------------------------------------
import { readFileSync } from 'fs';
const argv = process.argv.slice(2);
const FILE = argv.includes('--file') ? argv[argv.indexOf('--file') + 1] : 'n64/audio-worklet.js';
let Proc = null;
globalThis.sampleRate = 44100;
globalThis.AudioWorkletProcessor = class { constructor() { this.port = { postMessage: (m) => { this._last = m; }, onmessage: null }; } };
globalThis.registerProcessor = (n, c) => { Proc = c; };
new Function(readFileSync(FILE, 'utf8'))();

const SR = 44100, Q = 128, FIELD = SR / 50;          // 882 stereo frames per PAL field
// pace(tMs) -> the room rate at that instant (0 during a stall)
function run(name, secs, pace, opts = {}) {
  const p = new Proc({ processorOptions: { start: 24000 } });
  const out = [new Float32Array(Q), new Float32Array(Q)];
  let t = 0, guest = 0, produced = 0, pumped = 0, nextPump = 0;
  const qms = Q / SR * 1000;
  let playedFrames = 0;
  const ratios = [];
  // produce a sine so an underrun is also visible as silence
  const chunk = (n) => { const a = new Int16Array(n * 2); for (let i = 0; i < n; i++) { const v = Math.round(8000 * Math.sin((produced + i) / 20)); a[2 * i] = v; a[2 * i + 1] = v; } return a; };
  while (t < secs * 1000) {
    // the guest advances at the room's pace (continuous model of fields)
    guest += pace(t) * qms / 20;
    const want = Math.floor(guest) * FIELD;
    // the page pumps what the core wrote every 8 ms
    if (t >= nextPump) {
      nextPump += 8;
      if (want > pumped) { p.port.onmessage({ data: { s: chunk(want - pumped) } }); produced += want - pumped; pumped = want; }
    }
    p.process([], [out]);
    playedFrames += Q;
    if (p.ratio != null && (playedFrames % (Q * 344)) === 0) ratios.push(p.ratio);
    t += qms;
  }
  const r = { name, secs, underruns: p.underruns, silencedMs: +(p.missing / 2 / SR * 1000).toFixed(0),
              ratioMin: +Math.min(...ratios).toFixed(3), ratioEnd: +p.ratio.toFixed(3) };
  return r;
}
let pass = 0, fail = 0;
const judge = (r, okFn, why) => { const good = okFn(r); good ? pass++ : fail++; console.log((good ? '  PASS  ' : '  FAIL  ') + JSON.stringify(r) + (good ? '' : ' — ' + why)); };

// 1.000x with no stalls: nothing to ride through.
judge(run('1.000x clean, 60 s', 60, () => 1), (r) => r.underruns === 0 && r.silencedMs === 0, 'a clean 1.000x room cut out');
// 1.000x with a 150 ms stall every 5 s (a lost packet / a hitch): the room
// repays nothing (gate #9), so each stall is 150 ms of audio that never
// arrives. It must be ridden through, not cut.
judge(run('1.000x + 150 ms stall every 5 s, 60 s', 60, (t) => ((t % 5000) < 150 ? 0 : 1)),
  (r) => r.underruns === 0, 'short stalls cut the audio');
// 1.000x with a 400 ms stall every 10 s — LONGER than the 272 ms cushion, so
// some silence is forced. Graceful = at most one short cut per stall, never
// the old extra 272 ms re-buffer on top (baseline: 5 cuts, 1964 ms silent).
judge(run('1.000x + 400 ms stall every 10 s, 60 s', 60, (t) => ((t % 10000) < 400 ? 0 : 1)),
  (r) => r.underruns <= 6 && r.silencedMs <= 6 * 200, 'more silence than the stalls force');
// A SUSTAINED 0.93x room (49K4T). No buffer can hide a 7% deficit; what it
// must not do is cut in and out. Graceful = continuous, slightly slower.
judge(run('0.93x sustained, 90 s', 90, () => 0.93), (r) => r.underruns <= 1, 'a 0.93x room cuts in and out');
// 0.93x made of stalls: 1.000x with a 140 ms stall every 2 s.
judge(run('0.93x as 140 ms stalls every 2 s, 90 s', 90, (t) => ((t % 2000) < 140 ? 0 : 1)), (r) => r.underruns <= 1, 'cuts in and out');
console.log(`\n[audio-worklet] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

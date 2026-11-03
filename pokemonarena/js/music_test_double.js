// pokemonarena/js/music_test_double.js -- a recording AudioContext test double for music.js and its integrators (MU3 reuses it).
//
// It opens no audio device, makes no sound and needs no DOM: every node, buffer, source and parameter automation is
// recorded into `fake.log`, time only moves when the test calls fake.advance(seconds), and the timers music.js uses
// (setInterval/setTimeout) are fakes driven by the same clock. Pass `fake.ctx` as `ctx`, `fake.timers` as `timers`.
//
//   const fake = createFakeAudio();
//   const music = await createMusic({ ctx: fake.ctx, destination: fake.destination, rom, timers: fake.timers });
//   music.play(802); fake.advance(2);
//   fake.counts()  ->  { createBuffer, createBufferSource, start, stop, createGain, ... }
//   fake.scheduledSeconds() -> total audio duration scheduled through createBufferSource().start()

export function createFakeAudio({ sampleRate = 48000, keepData = false } = {}) {
  const log = [];
  const nodes = [];
  let now = 0;
  const timers = new Map();
  let nextTimer = 1;
  const counts = {};
  const bump = (k) => { counts[k] = (counts[k] || 0) + 1; };
  let nodeId = 0;

  function hasSignal(a) { for (let i = 0; i < a.length; i += 7) if (a[i] !== 0) return true; return false; }

  function param(owner, name, initial) {
    const p = {
      value: initial,
      setValueAtTime(v, t) { log.push({ ev: 'param', node: owner, param: name, op: 'set', v, t }); p.value = v; return p; },
      linearRampToValueAtTime(v, t) { log.push({ ev: 'param', node: owner, param: name, op: 'ramp', v, t }); p.value = v; return p; },
      setTargetAtTime(v, t, k) { log.push({ ev: 'param', node: owner, param: name, op: 'target', v, t, k }); p.value = v; return p; },
      cancelScheduledValues(t) { log.push({ ev: 'param', node: owner, param: name, op: 'cancel', t }); return p; },
    };
    return p;
  }
  function node(kind, extra) {
    const n = {
      id: ++nodeId, kind, connections: [],
      connect(dst) { n.connections.push(dst && dst.id); log.push({ ev: 'connect', from: n.id, to: dst && dst.id }); return dst; },
      disconnect() { n.connections = []; log.push({ ev: 'disconnect', from: n.id }); },
      ...extra,
    };
    nodes.push(n);
    return n;
  }
  const destination = node('destination');
  const ctx = {
    get currentTime() { return now; },
    sampleRate,
    state: 'running',
    destination,
    createGain() { bump('createGain'); const n = node('gain'); n.gain = param(n.id, 'gain', 1); return n; },
    createStereoPanner() { bump('createStereoPanner'); const n = node('panner'); n.pan = param(n.id, 'pan', 0); return n; },
    createBuffer(channels, length, rate) {
      bump('createBuffer');
      const data = Array.from({ length: channels }, () => new Float32Array(keepData ? length : 0));
      const b = {
        numberOfChannels: channels, length, sampleRate: rate, duration: length / rate, nonSilent: false,
        getChannelData(c) { return data[c]; },
        copyToChannel(src, c) { if (keepData) data[c].set(src); if (hasSignal(src)) b.nonSilent = true; },
      };
      return b;
    },
    createBufferSource() {
      bump('createBufferSource');
      const n = node('source');
      n.buffer = null; n.started = null; n.stopped = null; n.onended = null;
      n.start = (when = 0, offset = 0) => { bump('start'); n.started = { when, offset }; log.push({ ev: 'start', node: n.id, when, offset, dur: n.buffer ? n.buffer.duration : 0, rate: n.buffer ? n.buffer.sampleRate : 0, frames: n.buffer ? n.buffer.length : 0, buffer: n.buffer, nonSilent: !!(n.buffer && n.buffer.nonSilent), now }); };
      n.stop = (when = 0) => { bump('stop'); n.stopped = when; log.push({ ev: 'stop', node: n.id, when, now }); };
      return n;
    },
  };
  const fakeTimers = {
    setInterval(fn, ms) { const id = nextTimer++; timers.set(id, { fn, ms, every: true, due: now * 1000 + ms }); return id; },
    clearInterval(id) { timers.delete(id); },
    setTimeout(fn, ms) { const id = nextTimer++; timers.set(id, { fn, ms, every: false, due: now * 1000 + ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  function advance(seconds, stepMs = 25) {
    const end = now + seconds;
    while (now < end - 1e-9) {
      now = Math.min(end, now + stepMs / 1000);
      for (const [id, t] of [...timers]) {
        if (!timers.has(id)) continue;
        while (t.due <= now * 1000 + 1e-6) {
          if (t.every) { t.due += t.ms; t.fn(); } else { timers.delete(id); t.fn(); break; }
          if (!timers.has(id)) break;
        }
      }
    }
  }
  return {
    ctx, destination, timers: fakeTimers, log, nodes, advance, counts: () => ({ ...counts }),
    scheduledSeconds() { let s = 0; for (const e of log) if (e.ev === 'start') s += e.dur; return s; },
    liveTimers: () => timers.size,
    starts: () => log.filter((e) => e.ev === 'start'),
    stops: () => log.filter((e) => e.ev === 'stop'),
    paramOps: (nodeIdFilter) => log.filter((e) => e.ev === 'param' && (nodeIdFilter === undefined || e.node === nodeIdFilter)),
    setTime(t) { now = t; },
  };
}

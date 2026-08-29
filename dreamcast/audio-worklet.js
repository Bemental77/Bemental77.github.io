// AudioWorkletProcessor for the Flycast (Dreamcast) audio ring.
//
// Ring layout written by dreamcast/flycast-bridge/EmscriptenWorker.cpp's
// audio_sample_batch_cb (SAB-backed, no postMessage hop):
//   [0..3]  uint32 head  (writer = SH4/AICA via flycast worker)
//   [4..7]  uint32 tail  (reader = this processor)
//   [8..]   int16 stereo samples (capacity * 2 sizeof(int16))
//
// head/tail are STEREO-FRAME counters (not sample counters); the writer does
// `(head & mask) * 2u` to index the int16 array. capacity is power-of-two and
// passed in via processorOptions (the C side doesn't store it in the header).
// The writer publishes head with a RELEASE store, which pairs with the
// Atomics.load(head) below; do not "simplify" either side back to a plain read.
//
// Underrun = silence. The SH4 thread cannot stall on us; if we starve the
// ring, we just emit zeros and keep the audio graph alive. Overrun is the
// writer's problem and is counted on the writer's side (drop-on-full).
//
// SOURCE RATE. AICA emits one stereo frame per AICA_TICK = 4535 SH4 cycles at
// SH4_MAIN_CLOCK = 200 MHz, i.e. 44101.43 Hz. The core reports 44100 and the
// page asks for a 44100 Hz AudioContext; the residual 32 ppm is inaudible and
// shows up only as the ring gaining ~1.4 frames/s, which never matters at a
// 16384-frame capacity. Do NOT try to correct it with the resampler below —
// that would trade an inaudible offset for interpolation on every frame.
//
// RESAMPLING (ported from gamecube/audio-worklet.js, 2026-08-28). The 1:1 path
// is correct only while the AudioContext actually runs at the core's rate.
// `new AudioContext({sampleRate})` may throw, or be silently clamped to the
// device rate — and a page that then falls back to a default-rate context
// while this processor keeps reading 1:1 plays FAST (48000/44100 = 1.088x)
// AND starves the ring forever, because the sink drains faster than AICA can
// fill it. Given both rates we linear-interpolate instead, so a clamped rate
// degrades in quality rather than in pitch. srcRate/dstRate default to
// `sampleRate`, i.e. ratio 1 and the original byte-for-byte 1:1 path, so a
// page that passes neither behaves exactly as before.
//
// The page must pass  srcRate: <core rate, 44100>  and
// dstRate: audioContext.sampleRate  for this to engage.

class DcAudioProcessor extends AudioWorkletProcessor {
  constructor(opts) {
    super();
    const t = (opts && opts.processorOptions) || {};
    this.sab = t.sab;
    this.ringOffset = t.ringOffset >>> 0;
    this.capacity = (t.ringCapacity | 0) >>> 0;  // stereo frames, power-of-two
    this.mask = (this.capacity - 1) >>> 0;
    this.header = new Uint32Array(this.sab, this.ringOffset, 2);
    this.data = new Int16Array(this.sab, this.ringOffset + 8, this.capacity * 2);
    this.srcRate = t.srcRate || sampleRate;
    this.dstRate = t.dstRate || sampleRate;
    this.ratio = this.srcRate / this.dstRate;
    if (!isFinite(this.ratio) || this.ratio <= 0) this.ratio = 1;
    this.resampling = Math.abs(this.ratio - 1) > 1e-6;
    this.frac = 0; this.primed = false;
    this.pL = 0; this.pR = 0; this.cL = 0; this.cR = 0;
    this.totalUnderrunFrames = 0;
    this.totalConsumedFrames = 0;
    this.totalOutputFrames = 0;
    this.lastReportTime = currentTime;
    this.port.onmessage = (e) => {
      if (e.data && e.data.cmd === 'reset') {
        Atomics.store(this.header, 0, 0);
        Atomics.store(this.header, 1, 0);
        this.frac = 0; this.primed = false;
      }
    };
  }
  process(inputs, outputs) {
    const out = outputs[0];
    const left = out[0];
    const right = out[1] || left;
    const numFrames = left.length;  // 128 in practice
    const head = Atomics.load(this.header, 0) >>> 0;
    const tail = Atomics.load(this.header, 1) >>> 0;
    const avail = (head - tail) >>> 0;   // stereo frames the writer has published
    const inv = 1 / 32768;
    const d = this.data;
    const mask = this.mask;
    let framesRead;      // SOURCE frames consumed from the ring
    let outFrames = 0;   // output frames actually filled with audio (rest is silence)

    if (!this.resampling) {
      // ---- 1:1 fast path (the normal case: ctx rate === core rate) -----------------------
      const framesToRead = avail >= numFrames ? numFrames : avail;
      for (let f = 0; f < framesToRead; ++f) {
        const slot = ((tail + f) & mask) * 2;
        left[f]  = d[slot]     * inv;
        right[f] = d[slot + 1] * inv;
      }
      for (let f = framesToRead; f < numFrames; ++f) {
        left[f]  = 0;
        right[f] = 0;
      }
      if (framesToRead > 0) {
        Atomics.store(this.header, 1, (tail + framesToRead) >>> 0);
      }
      framesRead = framesToRead;
      outFrames = framesToRead;
    } else {
      // ---- resampling path (linear interpolation, srcRate -> dstRate) --------------------
      // Only reached when the browser refused/clamped the requested AudioContext rate. Walk
      // the ring at `ratio` source frames per output frame, committing tail by the number
      // actually consumed. The power-of-two mask means we can index the ring directly — no
      // scratch copy and no wrap special-case (the GC original needed both because its ring
      // is sample-counted with a non-power-of-two capacity).
      let si = 0;  // source frames consumed this quantum
      if (!this.primed && avail >= 2) {
        const s0 = (tail & mask) * 2, s1 = ((tail + 1) & mask) * 2;
        this.pL = d[s0] * inv; this.pR = d[s0 + 1] * inv;
        this.cL = d[s1] * inv; this.cR = d[s1 + 1] * inv;
        si = 2; this.frac = 0; this.primed = true;
      }
      let f = 0;
      while (f < numFrames && this.primed) {
        const t2 = this.frac;
        left[f]  = this.pL + (this.cL - this.pL) * t2;
        right[f] = this.pR + (this.cR - this.pR) * t2;
        ++f;
        this.frac += this.ratio;
        while (this.frac >= 1) {
          if (si >= avail) { this.primed = false; break; }  // ring starved mid-quantum
          this.pL = this.cL; this.pR = this.cR;
          const s = ((tail + si) & mask) * 2;
          this.cL = d[s] * inv; this.cR = d[s + 1] * inv;
          ++si;
          this.frac -= 1;
        }
      }
      outFrames = f;
      for (; f < numFrames; ++f) { left[f] = 0; right[f] = 0; }
      if (si > 0) Atomics.store(this.header, 1, (tail + si) >>> 0);
      framesRead = si;
    }

    this.totalConsumedFrames += framesRead;
    this.totalOutputFrames += numFrames;
    if (outFrames < numFrames) {
      this.totalUnderrunFrames += (numFrames - outFrames);
    }
    // Periodic health report. Until 2026-08-28 nothing on the page ever assigned
    // node.port.onmessage, so every one of these was posted into a port with no
    // listener and garbage-collected — DC audio health had literally never been
    // observed. The page-side listener expects exactly the shape below.
    //
    //   consumedFrames / dt  ~= srcRate      -> the reader is draining at rate
    //   outputFrames   / dt  ==  dstRate     -> the context's REAL rate; if this
    //                                            disagrees with dstRate the browser
    //                                            clamped and the ratio is wrong
    //   underrunFrames > 0                   -> starving (writer too slow / stalled)
    //   fill near capacity                   -> writer saturating; the C side is
    //                                            dropping (see its [audio] line)
    if (currentTime - this.lastReportTime > 1.0) {
      const dt = currentTime - this.lastReportTime;
      this.lastReportTime = currentTime;
      const ur = this.totalUnderrunFrames;
      const cf = this.totalConsumedFrames;
      const of = this.totalOutputFrames;
      this.totalUnderrunFrames = 0;
      this.totalConsumedFrames = 0;
      this.totalOutputFrames = 0;
      this.port.postMessage({
        cmd: 'stats',
        underrunFrames: ur,
        consumedFrames: cf,
        outputFrames: of,
        dt: dt,
        fill: avail,
        capacity: this.capacity,
        srcRate: this.srcRate,
        dstRate: this.dstRate,
        ctxRate: sampleRate,
        resampling: this.resampling,
      });
    }
    return true;
  }
}

registerProcessor('dc-audio-processor', DcAudioProcessor);

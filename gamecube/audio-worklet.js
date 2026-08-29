// AudioWorkletProcessor that consumes int16 PCM stereo from a SAB ring
// buffer (gamecube/ringbuffer.js layout) and outputs float32 stereo to the
// AudioContext. Runs at audio-rate in the AudioWorkletGlobalScope; cannot
// import ES modules, so the SAB layout is inlined.
//
// Constructor receives the SAB transfer descriptor via processorOptions.
// Underrun handling: emit silence for missing frames; don't block.

const HDR_HEAD = 0;
const HDR_TAIL = 1;
const HDR_CAPACITY = 2;
const HDR_ELEMSIZE = 3;
const HDR_BYTES = 16;

class GcAudioProcessor extends AudioWorkletProcessor {
  constructor(opts) {
    super();
    const t = opts.processorOptions;
    this.sab = t.sab;
    this.byteOffset = t.byteOffset || 0;
    this.header = new Int32Array(this.sab, this.byteOffset, 4);
    this.capacity = this.header[HDR_CAPACITY];
    this.data = new Int16Array(this.sab, this.byteOffset + HDR_BYTES, this.capacity);
    this.scratch = new Int16Array(2048 * 2);  // 2048 frames * 2 channels max
    this.scratchFrames = 2048;
    // [audio fix 2026-08-28] Resampling support. The page normally creates the AudioContext at the
    // core's exact reported rate, in which case srcRate === dstRate and process() takes the
    // original byte-for-byte 1:1 path below. But `new AudioContext({sampleRate})` can throw or be
    // clamped; the page used to silently fall back to a default-rate context while this worklet
    // kept reading the ring 1:1 — which plays fast (48000/32029 = 1.5x) AND starves the ring
    // forever, since the sink drains faster than the core can fill. Given the two rates we
    // linear-interpolate instead, so a clamped rate degrades in quality rather than in pitch.
    this.srcRate = t.srcRate || sampleRate;
    this.dstRate = t.dstRate || sampleRate;
    this.ratio = this.srcRate / this.dstRate;
    if (!isFinite(this.ratio) || this.ratio <= 0) this.ratio = 1;
    this.resampling = Math.abs(this.ratio - 1) > 1e-6;
    this.frac = 0; this.primed = false;
    this.pL = 0; this.pR = 0; this.cL = 0; this.cR = 0;
    this.totalUnderrunFrames = 0;
    this.totalConsumedFrames = 0;
    this.lastReportTime = currentTime;
    // Optional notification port for diagnostics.
    this.port.onmessage = (e) => {
      if (e.data && e.data.cmd === 'reset') {
        Atomics.store(this.header, HDR_HEAD, 0);
        Atomics.store(this.header, HDR_TAIL, 0);
        this.frac = 0; this.primed = false;
      }
    };
  }
  process(inputs, outputs) {
    const out = outputs[0];
    const left = out[0];
    const right = out[1] || left;
    const numFrames = left.length;  // 128 in practice
    const inv = 1 / 32768;
    const head = Atomics.load(this.header, HDR_HEAD);
    const tail = Atomics.load(this.header, HDR_TAIL);
    const avail = (head - tail) | 0;
    let framesRead;        // source frames consumed from the ring
    let outFrames = 0;     // output frames actually filled with audio (rest is silence padding)

    if (!this.resampling) {
      // ---- 1:1 fast path (the normal case: ctx rate === core rate) -------------------------
      const samplesNeeded = numFrames * 2;  // stereo interleaved
      const samplesToRead = avail >= samplesNeeded ? samplesNeeded : avail;
      if (samplesToRead > 0) {
        const start = (tail >>> 0) % this.capacity;
        const first = Math.min(samplesToRead, this.capacity - start);
        for (let i = 0; i < first; ++i) this.scratch[i] = this.data[start + i];
        const second = samplesToRead - first;
        for (let i = 0; i < second; ++i) this.scratch[first + i] = this.data[i];
        Atomics.store(this.header, HDR_TAIL, ((tail + samplesToRead) | 0));
      }
      // De-interleave int16 -> float32 stereo. Pad with silence on underrun.
      framesRead = samplesToRead >> 1;
      outFrames = framesRead;
      for (let f = 0; f < framesRead; ++f) {
        left[f]  = this.scratch[f * 2]     * inv;
        right[f] = this.scratch[f * 2 + 1] * inv;
      }
      for (let f = framesRead; f < numFrames; ++f) {
        left[f]  = 0;
        right[f] = 0;
      }
    } else {
      // ---- resampling path (linear interpolation, srcRate -> dstRate) ----------------------
      // Only reached when the browser refused/clamped the requested AudioContext rate. Pull the
      // most source frames this quantum could possibly need, then walk them at `ratio` per
      // output frame, committing HDR_TAIL by the number actually consumed.
      let wantFrames = Math.ceil(this.frac + numFrames * this.ratio) + 2;
      if (wantFrames > this.scratchFrames) wantFrames = this.scratchFrames;
      let samplesToRead = wantFrames * 2;
      if (samplesToRead > avail) samplesToRead = avail;
      if (samplesToRead > 0) {
        const start = (tail >>> 0) % this.capacity;
        const first = Math.min(samplesToRead, this.capacity - start);
        for (let i = 0; i < first; ++i) this.scratch[i] = this.data[start + i];
        const second = samplesToRead - first;
        for (let i = 0; i < second; ++i) this.scratch[first + i] = this.data[i];
      }
      const haveFrames = samplesToRead >> 1;
      let si = 0;  // next unconsumed source frame in scratch
      if (!this.primed && haveFrames >= 2) {
        this.pL = this.scratch[0] * inv; this.pR = this.scratch[1] * inv;
        this.cL = this.scratch[2] * inv; this.cR = this.scratch[3] * inv;
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
          if (si >= haveFrames) { this.primed = false; break; }  // ring starved mid-quantum
          this.pL = this.cL; this.pR = this.cR;
          this.cL = this.scratch[si * 2] * inv; this.cR = this.scratch[si * 2 + 1] * inv;
          ++si;
          this.frac -= 1;
        }
      }
      outFrames = f;
      for (; f < numFrames; ++f) { left[f] = 0; right[f] = 0; }
      if (si > 0) Atomics.store(this.header, HDR_TAIL, ((tail + si * 2) | 0));
      framesRead = si;
    }

    this.totalConsumedFrames += framesRead;
    if (outFrames < numFrames) {
      this.totalUnderrunFrames += (numFrames - outFrames);
    }
    // Periodic underrun report so we can see if we're starving.
    if (currentTime - this.lastReportTime > 1.0) {
      this.lastReportTime = currentTime;
      const ur = this.totalUnderrunFrames;
      const cf = this.totalConsumedFrames;
      this.totalUnderrunFrames = 0;
      this.totalConsumedFrames = 0;
      this.port.postMessage({ cmd: 'stats', underrunFrames: ur, consumedFrames: cf });
    }
    return true;  // keep node alive
  }
}

registerProcessor('gc-audio-processor', GcAudioProcessor);

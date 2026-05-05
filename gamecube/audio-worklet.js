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
    this.scratch = new Int16Array(256 * 2);  // 256 frames * 2 channels max
    this.totalUnderrunFrames = 0;
    this.totalConsumedFrames = 0;
    this.lastReportTime = currentTime;
    // Optional notification port for diagnostics.
    this.port.onmessage = (e) => {
      if (e.data && e.data.cmd === 'reset') {
        Atomics.store(this.header, HDR_HEAD, 0);
        Atomics.store(this.header, HDR_TAIL, 0);
      }
    };
  }
  process(inputs, outputs) {
    const out = outputs[0];
    const left = out[0];
    const right = out[1] || left;
    const numFrames = left.length;  // 128 in practice
    const samplesNeeded = numFrames * 2;  // stereo interleaved
    const head = Atomics.load(this.header, HDR_HEAD);
    const tail = Atomics.load(this.header, HDR_TAIL);
    const avail = (head - tail) | 0;
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
    const framesRead = samplesToRead >> 1;
    const inv = 1 / 32768;
    for (let f = 0; f < framesRead; ++f) {
      left[f]  = this.scratch[f * 2]     * inv;
      right[f] = this.scratch[f * 2 + 1] * inv;
    }
    for (let f = framesRead; f < numFrames; ++f) {
      left[f]  = 0;
      right[f] = 0;
    }
    this.totalConsumedFrames += framesRead;
    if (framesRead < numFrames) {
      this.totalUnderrunFrames += (numFrames - framesRead);
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

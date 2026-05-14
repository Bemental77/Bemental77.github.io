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
//
// Underrun = silence. The SH4 thread cannot stall on us; if we starve the
// ring, we just emit zeros and keep the audio graph alive.

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
    this.totalUnderrunFrames = 0;
    this.totalConsumedFrames = 0;
    this.lastReportTime = currentTime;
    this.port.onmessage = (e) => {
      if (e.data && e.data.cmd === 'reset') {
        Atomics.store(this.header, 0, 0);
        Atomics.store(this.header, 1, 0);
      }
    };
  }
  process(inputs, outputs) {
    const out = outputs[0];
    const left = out[0];
    const right = out[1] || left;
    const numFrames = left.length;  // 128 in practice
    const head = Atomics.load(this.header, 0) >>> 0;
    let tail = Atomics.load(this.header, 1) >>> 0;
    const avail = (head - tail) >>> 0;
    const framesToRead = avail >= numFrames ? numFrames : avail;
    const inv = 1 / 32768;
    for (let f = 0; f < framesToRead; ++f) {
      const slot = ((tail + f) & this.mask) * 2;
      left[f]  = this.data[slot]     * inv;
      right[f] = this.data[slot + 1] * inv;
    }
    for (let f = framesToRead; f < numFrames; ++f) {
      left[f]  = 0;
      right[f] = 0;
    }
    if (framesToRead > 0) {
      Atomics.store(this.header, 1, (tail + framesToRead) >>> 0);
    }
    this.totalConsumedFrames += framesToRead;
    if (framesToRead < numFrames) {
      this.totalUnderrunFrames += (numFrames - framesToRead);
    }
    if (currentTime - this.lastReportTime > 1.0) {
      this.lastReportTime = currentTime;
      const ur = this.totalUnderrunFrames;
      const cf = this.totalConsumedFrames;
      this.totalUnderrunFrames = 0;
      this.totalConsumedFrames = 0;
      this.port.postMessage({ cmd: 'stats', underrunFrames: ur, consumedFrames: cf });
    }
    return true;
  }
}

registerProcessor('dc-audio-processor', DcAudioProcessor);

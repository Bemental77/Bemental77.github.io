// AudioWorklet processor for the /n64/ page.
//
// Replaces N64Wasm's main-thread ScriptProcessorNode: the page pumps stereo
// interleaved Int16 samples (read out of the core's HEAP ring) to this
// processor, which plays them from the audio rendering thread. Main-thread
// stalls (heavy emulation frames, paint, GC) no longer starve the audio
// device — the buffered cushion rides them out.
//
// Dynamic rate control (the RetroArch technique): the emulator produces
// audio locked to its own achieved speed — a device running a game at 95%
// produces 5% fewer samples than the DAC consumes, and NO buffer can hide
// a sustained deficit (it just turns crackle into a gap every couple of
// seconds). Instead, output is continuously resampled (linear
// interpolation) by a ratio steered to hold the queue at its target fill:
// sustained slowdowns play continuously at a slightly lower pitch (≤5%,
// under a semitone) instead of skipping.
//
// Pre-buffer gating still applies: silent until `start` frames are queued
// after a reset/drain, so a hard drain is one clean gap, not crackle.
//
// Port protocol:
//   in:  { s: Int16Array }  — stereo interleaved samples to enqueue
//        { cmd: 'clear' }   — drop the queue (reset to buffering)
//        { port }           — adopt a MessagePort as a second input speaking
//                             this same protocol (the core worker's direct feed)
//   out: { b, u, m, r }     — backlog in Int16 entries, dry/drain events,
//                             cumulative silenced entries, current ratio;
//                             sent ~every 32 ms
const RING_FRAMES = 1 << 16; // 65536 stereo frames (~1.49 s)
class N64AudioProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.ringL = new Float32Array(RING_FRAMES);
    this.ringR = new Float32Array(RING_FRAMES);
    this.writeFrame = 0;          // absolute frames written
    this.readPos = 0;             // absolute fractional frame read position
    const startEntries = (options && options.processorOptions && options.processorOptions.start) || 8000;
    this.targetFrames = startEntries / 2; // queue fill the ratio steers toward
    this.buffering = true;
    this.everPlayed = false;
    this.ratio = 1;
    this.underruns = 0;
    this.missing = 0;
    this.sinceReport = 0;
    // THE PRODUCER'S OWN RATE, measured: frames received per frame of audio
    // time, over ~4 s. A room that runs at 0.93x (online play goes as fast as
    // its slowest console) produces 7% fewer samples than the DAC eats, and a
    // fixed 0.95 floor could only cover 5%: the queue drained, the processor
    // re-buffered 272 ms of silence, and it did that every ~14 s — "audio cuts
    // out" (room 49K4T). So the floor FOLLOWS the measured production rate,
    // slowly (<= 0.5% per second, never below 0.85): a sustained slow room
    // plays continuously at its own speed, as the game itself is running,
    // and a short stall is still ridden through by the cushion.
    this.rxFrames = 0; this.rxAtLast = 0; this.qSinceRate = 0;
    this.prodEst = 1; this.floor = 0.95;
    // After a real underrun, resume as soon as a SMALL amount is queued and
    // let the steering refill the cushion — re-buffering the whole 272 ms
    // turned every dry spell into a quarter second of extra silence.
    this.resumeFrames = 2048;
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d && d.s) {
        const s = d.s, n = s.length >> 1;
        for (let i = 0; i < n; i++) {
          const w = (this.writeFrame + i) & (RING_FRAMES - 1);
          this.ringL[w] = s[2 * i] / 32768;
          this.ringR[w] = s[2 * i + 1] / 32768;
        }
        this.writeFrame += n;
        this.rxFrames += n;
        // never let the writer lap the reader (drop oldest by advancing read)
        if (this.writeFrame - this.readPos > RING_FRAMES - 256) {
          this.readPos = this.writeFrame - (RING_FRAMES - 256);
        }
      } else if (d && d.cmd === 'clear') {
        this.writeFrame = 0; this.readPos = 0; this.buffering = true; this.ratio = 1;
      } else if (d && d.port) {
        // A SECOND producer port: the page's core worker (n64/N64Wasm/dist/
        // core_worker.js) feeds samples here directly, so audio never waits on
        // the page's main thread. Same protocol, same queue.
        d.port.onmessage = this.port.onmessage;
      }
    };
  }
  process(inputs, outputs) {
    const out = outputs[0];
    const left = out[0], right = out[1] || out[0];
    const frames = left.length; // 128
    let backlog = this.writeFrame - this.readPos;
    // production-rate estimate, once a second of audio time
    if (++this.qSinceRate >= 344) {
      const inst = (this.rxFrames - this.rxAtLast) / (this.qSinceRate * frames);
      this.rxAtLast = this.rxFrames; this.qSinceRate = 0;
      if (this.everPlayed) this.prodEst += 0.25 * (Math.min(1.1, inst) - this.prodEst);
      const tgt = Math.min(0.95, Math.max(0.85, this.prodEst - 0.01));
      this.floor += Math.max(-0.005, Math.min(0.005, tgt - this.floor));
    }
    const resumeAt = this.everPlayed ? Math.min(this.targetFrames, this.resumeFrames) : this.targetFrames;
    if (this.buffering && backlog >= resumeAt) this.buffering = false;
    let i = 0;
    if (!this.buffering) {
      // steer the resample ratio to hold the queue at target (±5%, smoothed);
      // the audible 0.90 'emergency stretch' is gone — pitch warble traded a
      // dropout for an equally objectionable artifact (user-rejected)
      const want = Math.min(1.05, Math.max(this.floor, 1 + (backlog - this.targetFrames) / (this.targetFrames * 8)));
      this.ratio += 0.05 * (want - this.ratio);
      const mask = RING_FRAMES - 1;
      for (; i < frames; i++) {
        // need one frame of lookahead for interpolation
        if (this.writeFrame - this.readPos < 2) break;
        const i0 = Math.floor(this.readPos), frac = this.readPos - i0;
        const a = i0 & mask, b = (i0 + 1) & mask;
        left[i] = this.ringL[a] + (this.ringL[b] - this.ringL[a]) * frac;
        right[i] = this.ringR[a] + (this.ringR[b] - this.ringR[a]) * frac;
        this.readPos += this.ratio;
      }
      this.everPlayed = true;
      if (i < frames) { this.buffering = true; this.underruns++; }
    }
    if (i < frames && this.everPlayed) this.missing += (frames - i) * 2;
    for (; i < frames; i++) { left[i] = 0; right[i] = 0; }
    if (++this.sinceReport >= 11) { // ~32 ms at 128-frame quanta / 44.1 kHz
      this.sinceReport = 0;
      backlog = Math.max(0, this.writeFrame - this.readPos);
      this.port.postMessage({ b: Math.round(backlog * 2), u: this.underruns, m: this.missing, r: Math.round(this.ratio * 1000) / 1000,
                              p: Math.round(this.prodEst * 1000) / 1000, f: Math.round(this.floor * 1000) / 1000 });
    }
    return true;
  }
}
registerProcessor('n64-audio', N64AudioProcessor);

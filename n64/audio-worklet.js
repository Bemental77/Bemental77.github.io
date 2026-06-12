// AudioWorklet processor for the /n64/ page.
//
// Replaces N64Wasm's main-thread ScriptProcessorNode: the page pumps stereo
// interleaved Int16 samples (read out of the core's HEAP ring) to this
// processor, which plays them from the audio rendering thread. Main-thread
// stalls (heavy emulation frames, paint, GC) then no longer starve the audio
// device — the buffered cushion here rides them out.
//
// Pre-buffer gating: output stays silent until `start` entries are queued,
// and re-enters buffering whenever the queue fully drains. The emulator
// produces audio locked to real time (it can only catch up after stalls,
// never run ahead — mymain.cpp IsFrameReady), so the cushion can only be
// built by delaying playback; the cost is `start`/88200 seconds of fixed
// audio latency. A drain therefore becomes ONE clean ~90 ms gap instead of
// per-sample crackle.
//
// Port protocol:
//   in:  { s: Int16Array }  — stereo interleaved samples to enqueue
//        { cmd: 'clear' }   — drop the queue (reset to buffering)
//   out: { b, u, m }        — queued entries, dry process() calls,
//                             cumulative silenced entries (post-first-play);
//                             sent ~every 32 ms
class N64AudioProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.chunks = [];      // queue of Int16Array (stereo interleaved)
    this.offset = 0;       // read offset into chunks[0], in Int16 entries
    this.backlog = 0;      // total queued Int16 entries
    this.start = (options && options.processorOptions && options.processorOptions.start) || 8000;
    this.buffering = true; // gate output until `start` entries queued
    this.everPlayed = false;
    this.underruns = 0;    // drains back into buffering
    this.missing = 0;      // entries silenced after first play (gap size proxy)
    this.sinceReport = 0;
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d && d.s) { this.chunks.push(d.s); this.backlog += d.s.length; }
      else if (d && d.cmd === 'clear') { this.chunks = []; this.offset = 0; this.backlog = 0; this.buffering = true; }
    };
  }
  process(inputs, outputs) {
    const out = outputs[0];
    const left = out[0], right = out[1] || out[0];
    const frames = left.length; // 128
    if (this.buffering && this.backlog >= this.start) this.buffering = false;
    let i = 0;
    if (!this.buffering) {
      let need = frames * 2;
      while (need > 0 && this.chunks.length) {
        const head = this.chunks[0];
        const avail = head.length - this.offset;
        const take = Math.min(avail, need);
        for (let k = 0; k < take; k += 2) {
          left[i] = head[this.offset + k] / 32768;
          right[i] = head[this.offset + k + 1] / 32768;
          i++;
        }
        this.offset += take; this.backlog -= take; need -= take;
        if (this.offset >= head.length) { this.chunks.shift(); this.offset = 0; }
      }
      this.everPlayed = true;
      if (need > 0) { this.buffering = true; this.underruns++; }
    }
    if (i < frames && this.everPlayed) this.missing += (frames - i) * 2;
    for (; i < frames; i++) { left[i] = 0; right[i] = 0; }
    if (++this.sinceReport >= 11) { // ~32 ms at 128-frame quanta / 44.1 kHz
      this.sinceReport = 0;
      this.port.postMessage({ b: this.backlog, u: this.underruns, m: this.missing });
    }
    return true;
  }
}
registerProcessor('n64-audio', N64AudioProcessor);

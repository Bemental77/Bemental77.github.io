// AudioWorklet processor for lib/cart_audio.js (gba / snes / genesis).
//
// Plays the samples the page pushed, from the audio rendering thread, at ONE
// FIXED resample ratio (srcRate / sampleRate). No dynamic rate control, no
// time-stretch (lib/audiodiag.js FORBIDDEN_REMEDIES): a shortfall is a gap and
// is counted, never hidden.
//
//   in : { s: Float32Array interleaved stereo }  |  { cmd: 'clear' }
//   out: { u, m, o, b, c, cap, step }  ~every 100 ms
//        u underruns (dry events after audio had started)
//        m frames of silence inserted by those underruns
//        o frames dropped because the queue passed maxMs (producer ahead)
//        b backlog frames now;  c frames consumed (source frames)
const RING = 1 << 16;
class CartAudioProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.srcRate = o.srcRate || sampleRate;
    this.step = this.srcRate / sampleRate;
    this.target = Math.round(this.srcRate * (o.targetMs || 80) / 1000);
    this.max = Math.round(this.srcRate * (o.maxMs || 400) / 1000);
    // After a real underrun, resume at half the cushion: a full re-buffer
    // turns every dry spell into extra silence (n64/audio-worklet.js notes).
    this.resume = Math.max(256, this.target >> 1);
    this.L = new Float32Array(RING); this.R = new Float32Array(RING);
    this.w = 0; this.r = 0; this.buffering = true; this.played = false;
    this.u = 0; this.m = 0; this.o = 0; this.c = 0; this.q = 0;
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d && d.s) {
        const s = d.s, n = s.length >> 1, M = RING - 1;
        for (let i = 0; i < n; i++) { const k = (this.w + i) & M; this.L[k] = s[2 * i]; this.R[k] = s[2 * i + 1]; }
        this.w += n;
        const back = this.w - this.r;
        if (back > this.max) { const drop = back - this.target; this.r += drop; this.o += Math.round(drop); }
      } else if (d && d.cmd === 'clear') {
        this.r = this.w; this.buffering = true; this.played = false;
      }
    };
  }
  process(inputs, outputs) {
    const out = outputs[0], L = out[0], R = out[1] || out[0], n = L.length, M = RING - 1;
    let i = 0;
    const back = this.w - this.r;
    if (this.buffering && back >= (this.played ? this.resume : this.target)) this.buffering = false;
    if (!this.buffering) {
      const r0 = this.r;
      for (; i < n; i++) {
        if (this.w - this.r < 2) break;
        const i0 = Math.floor(this.r), f = this.r - i0, a = i0 & M, b = (i0 + 1) & M;
        L[i] = this.L[a] + (this.L[b] - this.L[a]) * f;
        R[i] = this.R[a] + (this.R[b] - this.R[a]) * f;
        this.r += this.step;
      }
      this.c += this.r - r0;
      this.played = true;
      if (i < n) { this.buffering = true; this.u++; }
    }
    if (i < n && this.played) this.m += n - i;
    for (; i < n; i++) { L[i] = 0; R[i] = 0; }
    if (++this.q >= 32) {
      this.q = 0;
      this.port.postMessage({ u: this.u, m: this.m, o: this.o, b: Math.max(0, Math.round(this.w - this.r)),
                              c: Math.round(this.c), cap: RING, step: this.step });
    }
    return true;
  }
}
registerProcessor('cart-audio', CartAudioProcessor);

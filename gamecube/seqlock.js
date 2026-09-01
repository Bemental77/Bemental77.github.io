// Seqlock primitive on SharedArrayBuffer.
//
// Pattern: Linux-kernel seqlock. One writer, many readers. Writers never
// block; readers retry on conflict. Used for high-frequency producer/
// consumer relationships where a lock would stall the consumer. The
// canonical SHaR-WASM use case is DSP -> AudioWorklet PCM transfer; the
// AudioWorklet must return within microseconds and cannot block.
//
// Memory layout (Int32Array view over SAB):
//   [0]   = sequence counter (atomic). Even = stable, odd = write in progress.
//   [1]   = data length in bytes (current valid payload size).
//   [2..] = double-buffered payload. Two buffers of size `payloadSize` each.
//
// Bit layout of seq (interpreted as int32):
//   bit 0   = write-in-progress (1 = writer mid-update; reader retries)
//   bits 1+ = version counter; active buffer = (seq >> 1) & 1, alternates
//             on every published write
//
// Writer protocol (single writer):
//   1. seq0 = current seq (must be even = no write in progress)
//   2. Atomics.add(seq, +1)            -> seq = seq0 + 1 (odd, in-progress)
//   3. inactive = ((seq0 >> 1) & 1) ^ 1  // write to the OTHER buffer
//   4. memcpy into bufN where N = inactive
//   5. Atomics.store(length, len)
//   6. Atomics.add(seq, +1)            -> seq = seq0 + 2 (even; new active
//                                          = (seq>>1)&1 = the one just written)
//
// Reader protocol (multi-reader, lock-free, retry on conflict):
//   1. s0 = Atomics.load(seq); if s0 & 1, retry
//   2. active = (s0 >> 1) & 1; copy bufN where N = active
//   3. s1 = Atomics.load(seq); if s1 != s0, retry
//
// Each published write strictly alternates the active buffer because the
// "+1 +1" sequence increments bit 1 once per complete write cycle.

const HEADER_I32 = 2;          // seq + length
const HEADER_BYTES = HEADER_I32 * 4;

export class Seqlock {
  /**
   * Create a Seqlock view over an existing SAB, OR allocate a new SAB
   * sized for the given payload.
   * @param {object} opts
   * @param {SharedArrayBuffer} [opts.sab]      - existing buffer to share
   * @param {number}            [opts.payloadBytes] - per-buffer payload size
   *                                              (only when allocating)
   * @param {number}            [opts.byteOffset]   - offset within sab
   *                                              (only when wrapping)
   */
  constructor(opts) {
    if (opts.sab) {
      this.sab = opts.sab;
      this.byteOffset = opts.byteOffset || 0;
      // Header tells us payload size: total - header = 2 * payload
      this.payloadBytes = ((opts.sab.byteLength - this.byteOffset) - HEADER_BYTES) >> 1;
    } else {
      this.payloadBytes = opts.payloadBytes;
      this.sab = new SharedArrayBuffer(HEADER_BYTES + 2 * this.payloadBytes);
      this.byteOffset = 0;
    }
    this.header  = new Int32Array(this.sab, this.byteOffset, HEADER_I32);
    this.buf0    = new Uint8Array(this.sab, this.byteOffset + HEADER_BYTES,
                                  this.payloadBytes);
    this.buf1    = new Uint8Array(this.sab, this.byteOffset + HEADER_BYTES + this.payloadBytes,
                                  this.payloadBytes);
  }
  /** Returns transferable info for postMessage. Use Seqlock.fromTransfer
   *  on the receiving thread to wrap. */
  toTransfer() {
    return { sab: this.sab, byteOffset: this.byteOffset };
  }
  static fromTransfer(t) {
    return new Seqlock({ sab: t.sab, byteOffset: t.byteOffset });
  }
  /** Writer: copy `bytes` into the inactive buffer and publish atomically.
   *  Pass length explicitly (or omit for full payloadBytes). */
  write(bytes, length) {
    const len = length === undefined ? bytes.byteLength : length;
    if (len > this.payloadBytes) throw new Error('seqlock: payload overflow');
    // Read seq before incrementing so we can compute which buffer is
    // currently inactive (= the one we should write into).
    const seq0 = Atomics.load(this.header, 0);
    // 1. Mark write-in-progress (seq becomes odd).
    Atomics.add(this.header, 0, 1);
    // 2. Pick the inactive buffer (opposite of current active).
    const activeNow = (seq0 >> 1) & 1;
    const dest = activeNow === 0 ? this.buf1 : this.buf0;
    // 3. Copy payload.
    dest.set(bytes.subarray ? bytes.subarray(0, len) : bytes.slice(0, len));
    // 4. Update length.
    Atomics.store(this.header, 1, len);
    // 5. Publish: another +1 → seq becomes even, bit 1 of seq has now
    //    incremented exactly once per full write cycle, so the new active
    //    buffer = inactive_now = the one we just wrote into.
    Atomics.add(this.header, 0, 1);
  }
  /** Reader: returns a fresh Uint8Array (copy) of the most recent published
   *  payload. Returns null if write contention exhausted retry budget —
   *  caller should retry on next tick. The audio worklet variant uses
   *  readInto to avoid allocation. */
  read() {
    for (let attempt = 0; attempt < 8; ++attempt) {
      const seq0 = Atomics.load(this.header, 0);
      if (seq0 & 1) continue;                    // write in progress
      const active = (seq0 >> 1) & 1;
      const len = Atomics.load(this.header, 1);
      const src = active === 0 ? this.buf0 : this.buf1;
      const out = new Uint8Array(len);
      out.set(src.subarray(0, len));
      const seq1 = Atomics.load(this.header, 0);
      if (seq1 === seq0) return out;             // consistent read
    }
    return null;
  }
  /** Reader variant for hot paths (e.g., AudioWorklet): copy into caller-
   *  provided buffer, return bytes copied (or 0 if no consistent read). */
  readInto(out) {
    for (let attempt = 0; attempt < 8; ++attempt) {
      const seq0 = Atomics.load(this.header, 0);
      if (seq0 & 1) continue;
      const active = (seq0 >> 1) & 1;
      const len = Atomics.load(this.header, 1);
      const src = active === 0 ? this.buf0 : this.buf1;
      const n = Math.min(len, out.length);
      for (let i = 0; i < n; ++i) out[i] = src[i];
      const seq1 = Atomics.load(this.header, 0);
      if (seq1 === seq0) return n;
    }
    return 0;
  }
  /** Diagnostic: current sequence value (even = stable). */
  sequence() { return Atomics.load(this.header, 0); }
}

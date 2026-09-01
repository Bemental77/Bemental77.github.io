// Single-producer / single-consumer (SPSC) ring buffer on SharedArrayBuffer.
//
// Lock-free. Producer writes via Atomics.store(head, ...) with release
// semantics; consumer reads via Atomics.load(head, ...) with acquire
// semantics. Same for tail in the reverse direction. Standard SPSC
// pattern from Lamport's 1983 paper, well-known in lock-free literature.
//
// Memory layout (Int32Array view over SAB):
//   [0]   = head (producer-only writes; consumer-only reads)
//   [1]   = tail (consumer-only writes; producer-only reads)
//   [2]   = capacity in elements (immutable)
//   [3]   = element size in bytes (immutable; 1, 2, or 4)
//   [4..] = element storage
//
// Producer:
//   pushN(items, n):
//     head = load(head, acquire)
//     tail = load(tail, acquire)
//     free = capacity - (head - tail)        // wrapping arithmetic
//     n = min(n, free)
//     copy items[0..n] into ring at head%capacity
//     store(head, head + n, release)
//     return n
//
// Consumer:
//   popN(out, n):
//     head = load(head, acquire)
//     tail = load(tail, acquire)
//     avail = head - tail
//     n = min(n, avail)
//     copy ring[tail%capacity..] into out
//     store(tail, tail + n, release)
//     return n
//
// head and tail are unsigned 32-bit counters that monotonically increase.
// Subtraction in 2's-complement gives correct distance for any wrap of
// (head - tail) up to 2^31 elements. Capacity is bounded by 2^31 so the
// distance never overflows.

const HDR_HEAD     = 0;
const HDR_TAIL     = 1;
const HDR_CAPACITY = 2;
const HDR_ELEMSIZE = 3;
const HDR_BYTES    = 4 * 4;  // 4 i32 fields

export class RingBuffer {
  /**
   * Create a ring buffer view over an existing SAB, OR allocate a new SAB.
   * @param {object} opts
   * @param {SharedArrayBuffer} [opts.sab]  - existing buffer
   * @param {number}            [opts.byteOffset] - offset within sab
   * @param {number}            [opts.capacity]   - element count (only when allocating)
   * @param {number}            [opts.elemSize]   - 1 (u8), 2 (i16), 4 (i32) (only when allocating)
   */
  constructor(opts) {
    if (opts.sab) {
      this.sab = opts.sab;
      this.byteOffset = opts.byteOffset || 0;
      this.header = new Int32Array(this.sab, this.byteOffset, 4);
      this.capacity = this.header[HDR_CAPACITY];
      this.elemSize = this.header[HDR_ELEMSIZE];
    } else {
      this.elemSize = opts.elemSize || 4;
      this.capacity = opts.capacity;
      const totalBytes = HDR_BYTES + this.elemSize * this.capacity;
      this.sab = new SharedArrayBuffer(totalBytes);
      this.byteOffset = 0;
      this.header = new Int32Array(this.sab, 0, 4);
      Atomics.store(this.header, HDR_CAPACITY, this.capacity);
      Atomics.store(this.header, HDR_ELEMSIZE, this.elemSize);
    }
    const dataOffset = this.byteOffset + HDR_BYTES;
    if (this.elemSize === 1) {
      this.data = new Uint8Array(this.sab, dataOffset, this.capacity);
    } else if (this.elemSize === 2) {
      this.data = new Int16Array(this.sab, dataOffset, this.capacity);
    } else if (this.elemSize === 4) {
      this.data = new Int32Array(this.sab, dataOffset, this.capacity);
    } else {
      throw new Error('ringbuffer: elemSize must be 1, 2, or 4');
    }
  }
  toTransfer() {
    return { sab: this.sab, byteOffset: this.byteOffset };
  }
  static fromTransfer(t) {
    return new RingBuffer({ sab: t.sab, byteOffset: t.byteOffset });
  }
  /** Producer: how many elements can be pushed right now. */
  freeCount() {
    const head = Atomics.load(this.header, HDR_HEAD);
    const tail = Atomics.load(this.header, HDR_TAIL);
    return this.capacity - ((head - tail) | 0);
  }
  /** Consumer: how many elements are currently readable. */
  availCount() {
    const head = Atomics.load(this.header, HDR_HEAD);
    const tail = Atomics.load(this.header, HDR_TAIL);
    return (head - tail) | 0;
  }
  /** Producer: push up to `items.length` elements. Returns count actually
   *  pushed (may be less than items.length if buffer was full). */
  push(items) {
    const head = Atomics.load(this.header, HDR_HEAD);
    const tail = Atomics.load(this.header, HDR_TAIL);
    const free = this.capacity - ((head - tail) | 0);
    let n = items.length;
    if (n > free) n = free;
    if (n === 0) return 0;
    const start = ((head | 0) >>> 0) % this.capacity;
    const first = Math.min(n, this.capacity - start);
    for (let i = 0; i < first; ++i) this.data[start + i] = items[i];
    const second = n - first;
    for (let i = 0; i < second; ++i) this.data[i] = items[first + i];
    Atomics.store(this.header, HDR_HEAD, ((head + n) | 0));
    return n;
  }
  /** Consumer: pop up to `out.length` elements into `out`. Returns count
   *  actually copied. */
  pop(out) {
    const head = Atomics.load(this.header, HDR_HEAD);
    const tail = Atomics.load(this.header, HDR_TAIL);
    const avail = (head - tail) | 0;
    let n = out.length;
    if (n > avail) n = avail;
    if (n === 0) return 0;
    const start = ((tail | 0) >>> 0) % this.capacity;
    const first = Math.min(n, this.capacity - start);
    for (let i = 0; i < first; ++i) out[i] = this.data[start + i];
    const second = n - first;
    for (let i = 0; i < second; ++i) out[first + i] = this.data[i];
    Atomics.store(this.header, HDR_TAIL, ((tail + n) | 0));
    return n;
  }
  /** Consumer: peek without consuming. Returns count copied. */
  peek(out) {
    const head = Atomics.load(this.header, HDR_HEAD);
    const tail = Atomics.load(this.header, HDR_TAIL);
    const avail = (head - tail) | 0;
    let n = out.length;
    if (n > avail) n = avail;
    if (n === 0) return 0;
    const start = ((tail | 0) >>> 0) % this.capacity;
    const first = Math.min(n, this.capacity - start);
    for (let i = 0; i < first; ++i) out[i] = this.data[start + i];
    const second = n - first;
    for (let i = 0; i < second; ++i) out[first + i] = this.data[i];
    return n;
  }
}

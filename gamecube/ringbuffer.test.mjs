// Smoke test for RingBuffer SPSC primitive. Single-thread (no worker).
// Verifies wrap-around, capacity bounds, and transferable handoff.

import { RingBuffer } from './ringbuffer.js';

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log('PASS', msg); }
  else      { fail++; console.error('FAIL', msg); }
}

// Int16 ring buffer for PCM samples.
const rb = new RingBuffer({ capacity: 8, elemSize: 2 });
assert(rb.capacity === 8, 'capacity = 8');
assert(rb.elemSize === 2, 'elemSize = 2');
assert(rb.availCount() === 0, 'initially empty');
assert(rb.freeCount() === 8, 'initially full free');

// Push 4 samples.
const n1 = rb.push(new Int16Array([10, 20, 30, 40]));
assert(n1 === 4, 'pushed 4 samples');
assert(rb.availCount() === 4, 'avail after push = 4');
assert(rb.freeCount() === 4, 'free after push = 4');

// Pop 2 samples.
const out1 = new Int16Array(2);
const m1 = rb.pop(out1);
assert(m1 === 2, 'popped 2 samples');
assert(out1[0] === 10 && out1[1] === 20, 'pop returns FIFO order');
assert(rb.availCount() === 2, 'avail after pop = 2');

// Push 6 more samples — should wrap.
const n2 = rb.push(new Int16Array([50, 60, 70, 80, 90, 100]));
assert(n2 === 6, 'pushed 6 more samples');
assert(rb.availCount() === 8, 'buffer now full');
assert(rb.freeCount() === 0, 'no free space');

// Try to push one more — should be rejected.
const n3 = rb.push(new Int16Array([999]));
assert(n3 === 0, 'push to full buffer returns 0');

// Pop everything — should preserve FIFO order across the wrap.
const out2 = new Int16Array(8);
const m2 = rb.pop(out2);
assert(m2 === 8, 'popped 8 samples');
assert(out2[0] === 30 && out2[1] === 40 && out2[2] === 50 && out2[3] === 60
    && out2[4] === 70 && out2[5] === 80 && out2[6] === 90 && out2[7] === 100,
       'FIFO order preserved across wrap');
assert(rb.availCount() === 0, 'empty after drain');

// Peek does not consume.
rb.push(new Int16Array([1, 2, 3]));
const peek = new Int16Array(3);
rb.peek(peek);
assert(peek[0] === 1 && peek[1] === 2 && peek[2] === 3, 'peek returns data');
assert(rb.availCount() === 3, 'peek did not consume');

// Transfer + reconstruct.
const t = rb.toTransfer();
const rb2 = RingBuffer.fromTransfer(t);
const popOut = new Int16Array(3);
rb2.pop(popOut);
assert(popOut[0] === 1 && popOut[1] === 2 && popOut[2] === 3,
       'reconstructed ring buffer reads same data');
assert(rb.availCount() === 0, 'pop visible to original handle');

// Many roundtrips test wrapping integrity.
const big = new Int16Array(4);
for (let cycle = 0; cycle < 100; ++cycle) {
  rb.push(new Int16Array([cycle, cycle + 1, cycle + 2, cycle + 3]));
  rb.pop(big);
  if (big[0] !== cycle || big[3] !== cycle + 3) { fail++; break; }
}
if (fail === 0) { pass++; console.log('PASS 100 cycles of wrap'); }

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);

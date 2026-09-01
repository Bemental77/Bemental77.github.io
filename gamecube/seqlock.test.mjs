// Smoke test for Seqlock primitive. Single-thread (no worker) — verifies
// write -> read round-trip, sequence-counter transitions, active-buffer
// alternation, and the version monotonicity protocol.
//
// Real concurrent test requires Workers (browser or node:worker_threads);
// the lock-freedom is structural so single-thread test exercises the
// protocol without timing.

import { Seqlock } from './seqlock.js';

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log('PASS', msg); }
  else      { fail++; console.error('FAIL', msg); }
}

// 1. Allocation.
const lock = new Seqlock({ payloadBytes: 1024 });
assert(lock.payloadBytes === 1024, 'payloadBytes set');
assert(lock.sab.byteLength === 8 + 2 * 1024, 'SAB total bytes correct');
assert(lock.sequence() === 0, 'initial seq = 0 (stable, active=buf0)');

// 2. Write/read round-trip.
const payload = new Uint8Array([1, 2, 3, 4, 5]);
lock.write(payload);
assert(lock.sequence() === 2, 'seq after write 1 = 2 (active=buf1, version=1)');
const r1 = lock.read();
assert(r1 !== null && r1.byteLength === 5, 'read 1: length 5');
assert(r1[0] === 1 && r1[4] === 5, 'read 1: payload bytes match');

// 3. Verify the active buffer DID alternate (writer 1 wrote into buf1).
//    seq=2 → active = (2 >> 1) & 1 = 1 → buf1.
//    Therefore buf1 should contain payload, buf0 should still be zero.
assert(lock.buf1[0] === 1 && lock.buf1[4] === 5, 'buf1 holds payload after write 1');
assert(lock.buf0[0] === 0, 'buf0 untouched after write 1');

// 4. Second write alternates again.
const payload2 = new Uint8Array([10, 20, 30]);
lock.write(payload2);
assert(lock.sequence() === 4, 'seq after write 2 = 4 (active=buf0, version=2)');
const r2 = lock.read();
assert(r2 !== null && r2.byteLength === 3, 'read 2: length 3');
assert(r2[0] === 10 && r2[2] === 30, 'read 2: payload bytes match');
assert(lock.buf0[0] === 10, 'buf0 holds payload after write 2');
assert(lock.buf1[0] === 1, 'buf1 still holds previous payload (proves alternation)');

// 5. Many writes — sequence and active-buffer pattern.
for (let i = 0; i < 100; ++i) lock.write(new Uint8Array([i & 0xff]));
assert(lock.sequence() === 4 + 2 * 100, 'sequence grows by 2 per write');
const rN = lock.read();
assert(rN[0] === 99, 'last write payload visible');

// 6. Transfer + reconstruct (simulates worker handoff).
const tx = lock.toTransfer();
const lockB = Seqlock.fromTransfer(tx);
const rB = lockB.read();
assert(rB[0] === 99, 'reconstructed seqlock reads same data');
lockB.write(new Uint8Array([0xAB, 0xCD]));
const rA = lock.read();
assert(rA[0] === 0xAB && rA[1] === 0xCD, 'write through one handle visible to the other');

// 7. Overflow protection.
let threw = false;
try { lock.write(new Uint8Array(2000)); } catch { threw = true; }
assert(threw, 'overflow throws');

// 8. readInto avoids allocation.
const out = new Uint8Array(8);
const n = lock.readInto(out);
assert(n === 2 && out[0] === 0xAB && out[1] === 0xCD, 'readInto fills caller buffer');

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);

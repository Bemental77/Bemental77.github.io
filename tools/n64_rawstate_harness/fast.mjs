import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const M = await require('./core.js')();
const rom = readFileSync(process.argv[2]); const WARM = +(process.argv[3] || 900);
const rp = M._malloc(rom.length); M.HEAPU8.set(rom, rp); if (!M._h_boot(rp, rom.length)) throw 'boot';
const drive = (f) => { const mask = (1 << 4) | ((f % 90) < 30 ? 8 : 0) | ((f % 240) === 7 ? 64 : 0) | ((f % 50) === 3 ? 32 : 0);
  M._h_pad(0, mask, Math.round(Math.sin(f / 20) * 20000), Math.round(Math.cos(f / 33) * 9000)); for (let p = 1; p < 4; p++) M._h_pad(p, 0, 0, 0); M._h_frame(); };
const SIZE = M._neil_state_size(), REG = M._neil_state_m64p_region();
const RING = +(process.env.RING || 8), ring = []; for (let i = 0; i < RING; i++) ring.push(M._malloc(SIZE));
const REF = M._malloc(SIZE);
const H = () => M.HEAPU8;
const bodyEq = (a, b) => { // compare all bytes except header bookkeeping (trailer +16..+28)
  const x = H().subarray(a, a + SIZE), y = H().subarray(b, b + SIZE);
  for (let i = 0; i < SIZE; i++) { if (i >= REG + 16 && i < REG + 28) continue; if (x[i] !== y[i]) return i; } return -1; };
let f = 0; for (; f < WARM; f++) drive(f);
// 1) ring of fast saves: each must equal a full save of the same moment, byte for byte
let mism = 0, checks = 0; const tf = [], tfull = [];
for (let k = 0; k < 64; k++) {
  drive(f++); const slot = ring[k % RING];
  let t = performance.now(); M._neil_state_save_raw_fast(slot); tf.push(performance.now() - t);
  t = performance.now(); M._neil_state_save_raw(REF); tfull.push(performance.now() - t);
  const d = bodyEq(slot, REF); checks++; if (d >= 0) { mism++; console.log('MISMATCH at byte', d, 'k', k); }
  if (k % 16 === 15) { // rollback 5 frames through the ring mid-stream, then keep going
    const back = ring[(k - 5 + RING) % RING]; M._neil_state_load_raw(back); f -= 5; }
}
// 2) determinism: rollback via fast-saved slot reproduces the same states
const f0 = f; M._neil_state_save_raw_fast(ring[0]);
const X = []; for (let i = 0; i < 60; i++) { drive(f0 + i); M._neil_state_save_raw(REF); X.push(H().slice(REF, REF + SIZE)); }
M._neil_state_load_raw(ring[0]);
let first = -1; for (let i = 0; i < 60; i++) { drive(f0 + i); M._neil_state_save_raw(REF); const d = bodyEq(REF, REF) ; const y = H().subarray(REF, REF + SIZE); let bad = -1; for (let j = 0; j < SIZE; j++) { if (j >= REG + 16 && j < REG + 28) continue; if (y[j] !== X[i][j]) { bad = j; break; } } if (bad >= 0) { first = i; console.log('diverge frame', i, 'byte', bad); break; } }
const med = a => { a = a.slice().sort((x, y) => x - y); return +a[a.length >> 1].toFixed(3); };
console.log(JSON.stringify({ ringChecks: checks, ringMismatches: mism, rollbackExact60: first < 0, medFastSaveMs: med(tf.slice(RING)), medFullSaveMs: med(tfull), p90Fast: +tf.slice(RING).sort((a,b)=>a-b)[Math.floor(0.9*(tf.length-RING))].toFixed(3) }));

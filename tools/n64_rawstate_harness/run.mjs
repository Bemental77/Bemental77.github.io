// harness determinism + timing test (Node, headless core, no JIT)
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Core = require(process.env.HCORE || './core.js');
const ROM = process.argv[2], WARM = +(process.argv[3] || 600), K = +(process.argv[4] || 120);
const M = await Core();
const rom = readFileSync(ROM);
const rp = M._malloc(rom.length); M.HEAPU8.set(rom, rp);
if (!M._h_boot(rp, rom.length)) throw new Error('boot failed');
const drive = (f) => {
  const mask = (1 << 4) | ((f % 90) < 30 ? (1 << 3) : 0) | ((f % 240) === 7 ? (1 << 6) : 0) | ((f % 50) === 3 ? (1 << 5) : 0);
  M._h_pad(0, mask, Math.round(Math.sin(f / 20) * 20000), Math.round(Math.cos(f / 33) * 9000));
  for (let p = 1; p < 4; p++) M._h_pad(p, 0, 0, 0);
  M._h_frame();
};
const SIZE = M._neil_state_size(), REG = M._neil_state_m64p_region();
const A = M._malloc(SIZE), B = M._malloc(SIZE), S = M._malloc(SIZE);
function h32(u8off, len) { // fnv-ish over u32
  const u = new Uint32Array(M.HEAPU8.buffer, u8off, len >>> 2); let h = 0x811c9dc5 | 0;
  for (let i = 0; i < u.length; i++) h = Math.imul(h ^ u[i], 16777619);
  return h >>> 0;
}
const PRE = M._h_prescale();
function frameHash() { // full raw state (guest + trailer) and presented pixels
  M._neil_state_save_raw(B);
  M.HEAPU32.fill(0, (B + REG + 16) >> 2, (B + REG + 28) >> 2); // header nonce + tlb_gen + hid_epoch are bookkeeping, not machine state
  return [h32(B + 448, 8 << 20), h32(B, REG), h32(B + REG, SIZE - REG), h32(PRE, 640 * 576 * 4)].map(x => x.toString(16)).join(':');
}
let f = 0; for (; f < WARM; f++) drive(f);
console.log('state size', SIZE, 'm64p region', REG);
const res = [];
for (let rep = 0; rep < 3; rep++) {
  const f0 = f;
  let t = performance.now(); const n = M._neil_state_save_raw(S); const saveMs = performance.now() - t;
  const X = []; for (let i = 0; i < K; i++) { drive(f0 + i); X.push(frameHash()); }
  t = performance.now(); const ok = M._neil_state_load_raw(S); const loadMs = performance.now() - t;
  const mode = M._neil_state_last_load_mode(), pages = M._neil_state_last_load_pages();
  const Y = []; for (let i = 0; i < K; i++) { drive(f0 + i); Y.push(frameHash()); }
  let first = -1; for (let i = 0; i < K; i++) if (X[i] !== Y[i]) { first = i; break; }
  res.push({ at: f0, bytes: n, ok, mode, pages, saveMs: +saveMs.toFixed(2), loadMs: +loadMs.toFixed(2), exact: first < 0, firstDiff: first, a: first >= 0 ? X[first] : null, b: first >= 0 ? Y[first] : null, distinct: new Set(X).size });
  f = f0 + K; for (let i = 0; i < 37; i++) drive(f++);
}
// timing distribution of save/load alone
const ts = [], tl = [];
for (let i = 0; i < 30; i++) { drive(f++); let t = performance.now(); M._neil_state_save_raw(A); ts.push(performance.now() - t); t = performance.now(); M._neil_state_load_raw(A); tl.push(performance.now() - t); }
const med = a => a.sort((x, y) => x - y)[a.length >> 1];
console.log(JSON.stringify({ res, medSaveMs: +med(ts).toFixed(3), medLoadMs: +med(tl).toFixed(3) }, null, 1));

// Hand-patches sm64.us.wasm so an orphaned Wiggler body part deletes itself instead of running.
//
//   node sm64daily/patch_wiggler_orphans.mjs <in.wasm> <out.wasm>
//
// Why: daily.c replaces the Wiggler head whenever it respawns the course's enemies (Mario dies, the
// run restarts, the boss is thrown off the arena). The head's three bhvWigglerBody objects are not
// deleted, so they keep running bhv_wiggler_body_part_update against a dead parentObj. Once that
// slot is recycled its oWigglerSegments is whatever the new tenant keeps in that field (0, or a small
// integer such as 7), and the body parts store their posY floats through it into addresses ~0..80 --
// onto the emscripten stack canary, which aborts the module.
//
// The proper fix is in the C source (sm64-port-daily.patch). This script applies the same guard to
// the shipped binary when the decomp can't be rebuilt:
//
//   if (o->parentObj == NULL || o->parentObj->activeFlags == 0 || o->parentObj->behavior != bhvWigglerHead)
//       { o->activeFlags = 0; return; }
//
// The function is found by its code shape (the only function that loads gCurrentObject->parentObj->
// oWigglerSegments and contains f32.const -37.5), not by index, so it survives a rebuild. The head's
// behavior address is read from the module's own data: it is the value the guard compares against.
import { readFileSync, writeFileSync } from 'node:fs';

const [inPath, outPath] = process.argv.slice(2);
if (!inPath || !outPath) { console.error('usage: patch_wiggler_orphans.mjs <in.wasm> <out.wasm>'); process.exit(2); }
const buf = readFileSync(inPath);

const lebU = (b, p) => { let r = 0, s = 0, x, n = 0; do { x = b[p + n++]; r += (x & 0x7f) * 2 ** s; s += 7; } while (x & 0x80); return [r, n]; };
const encU = v => { const o = []; do { let b = v & 0x7f; v = Math.floor(v / 128); if (v) b |= 0x80; o.push(b); } while (v); return o; };
const encS = v => { const o = []; for (;;) { const b = v & 0x7f; v >>= 7; if ((v === 0 && !(b & 0x40)) || (v === -1 && (b & 0x40))) { o.push(b); return o; } o.push(b | 0x80); } };
const has = (a, pat, from = 0, to = a.length) => { for (let k = from; k + pat.length <= to; k++) { let ok = true; for (let j = 0; j < pat.length; j++) if (a[k + j] !== pat[j]) { ok = false; break; } if (ok) return k; } return -1; };

// sections
let p = 8; const secs = [];
while (p < buf.length) { const id = buf[p++]; const [size, n] = lebU(buf, p); secs.push({ id, sizePos: p, sizeLen: n, start: p + n, size }); p += n + size; }
const code = secs.find(s => s.id === 10);
let q = code.start; const [count, cn] = lebU(buf, q); q += cn;
const fns = [];
for (let i = 0; i < count; i++) { const [sz, n] = lebU(buf, q); fns.push({ i, sizePos: q, sizeLen: n, start: q + n, size: sz }); q += n + sz; }

// the body-part update: f32.const -37.5, an i32.load offset=0x68 (parentObj) and an i32.load offset=0xF8 (oWigglerSegments)
const hits = fns.filter(f => has(buf, [0x43, 0x00, 0x00, 0x16, 0xc2], f.start, f.start + f.size) >= 0
  && has(buf, [0x28, 0x02, 0x68], f.start, f.start + f.size) >= 0 && has(buf, [0x28, 0x02, 0xf8, 0x01], f.start, f.start + f.size) >= 0);
if (hits.length !== 1) { console.error('expected exactly one body-part function, found', hits.length); process.exit(1); }
const fn = hits[0];

// locals vector, then the first expression: i32.const 0 ; i32.load offset=<gCurrentObject>
let c = fn.start; const [nloc, nl] = lebU(buf, c); c += nl;
for (let i = 0; i < nloc; i++) { const [, n] = lebU(buf, c); c += n + 1; }
if (buf[c] !== 0x41 || buf[c + 1] !== 0x00 || buf[c + 2] !== 0x28 || buf[c + 3] !== 0x02) { console.error('unexpected function prologue'); process.exit(1); }
const [gco, gl] = lebU(buf, c + 4);
const loadO = [...buf.subarray(c, c + 4 + gl)];   // i32.const 0 ; i32.load a=2 offset=gCurrentObject  -> o

// bhvWigglerHead: no symbol survives, so take it from the body-part spawn: the head's behavior is what
// objects with a child at +0x68 carry. We are given it on the command line when it is not the shipped build.
const HEAD_BEH = Number(process.env.WIGGLER_HEAD_BEH || 3184976);

const parent = [...loadO, 0x28, 0x02, 0x68];
const kill = [0x04, 0x40, ...loadO, 0x41, 0x00, 0x3b, 0x01, 0x74, 0x0f, 0x0b];          // if { o->activeFlags = 0; return } end
const guard = [
  ...parent, 0x45, ...kill,                                                              // parentObj == NULL
  ...parent, 0x2f, 0x01, 0x74, 0x45, ...kill,                                            // parentObj->activeFlags == 0
  ...parent, 0x28, 0x02, ...encU(0x20c), 0x41, ...encS(HEAD_BEH), 0x47, ...kill,        // parentObj->behavior != bhvWigglerHead
];

const insertAt = c;
if (has(buf, guard, insertAt, insertAt + guard.length) === insertAt) { console.log(`function #${fn.i} is already patched; nothing written`); process.exit(0); }
const out = Buffer.concat([buf.subarray(0, insertAt), Buffer.from(guard), buf.subarray(insertAt)]);
// re-encode: the function's size, then the code section's size (both LEBs may change length)
const newFnSize = fn.size + guard.length;
const fnSizeBytes = Buffer.from(encU(newFnSize));
const newCodeSize = code.size + guard.length + (fnSizeBytes.length - fn.sizeLen);
const codeSizeBytes = Buffer.from(encU(newCodeSize));
const parts = [
  out.subarray(0, code.sizePos), codeSizeBytes,
  out.subarray(code.sizePos + code.sizeLen, fn.sizePos), fnSizeBytes,
  out.subarray(fn.sizePos + fn.sizeLen),
];
const patched = Buffer.concat(parts);
if (!WebAssembly.validate(patched)) { console.error('patched module does not validate'); process.exit(1); }
writeFileSync(outPath, patched);
console.log(`patched function #${fn.i} (gCurrentObject=0x${gco.toString(16)}, head behavior=${HEAD_BEH}): +${guard.length} bytes, ${buf.length} -> ${patched.length}`);

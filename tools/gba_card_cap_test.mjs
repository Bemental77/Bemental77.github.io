#!/usr/bin/env node
// THE CARD CAP IN lib/netplay.js (_cardTake): a seated peer can no longer make every console hold what it likes.
//
// Background (gba/mgba/README.md "Known limits of the room page", verifier finding A4): the engine reassembles a save ("card") from the piece
// count `n` and the length `len` that the SENDER announces, before any page code sees a byte. Measured before the cap existed: 20,000 pieces
// announced as one card of 2^31-1 bytes were all held (245,760,000 B, RSS 62 -> 324 MB, no error), and a complete 24 MiB card was assembled
// and re-broadcast to every guest. The cap is OPT-IN (opts.cardLimits / ls.cardLimits = ROOM_CARD_LIMITS from gba/mgba/room.js) and must
// leave every other emulator byte-for-byte unchanged.
//
// This test loads lib/netplay.js UNMODIFIED in Node (no browser, no server), the way tools/netplay_lockstep_test.mjs does, and checks:
//   A. the hostile flood is HELD with no limits (the control that shows the flood is real), DROPPED with them (nothing held, ONE report that
//      names the seat), and HELD AGAIN when the cap is cut out of a copy of the engine (the negative control: the check has teeth);
//   B. each reason a piece can be refused (bytes, pieces, shape, piece-size, slots), reported once however many pieces follow;
//   C. honest cards still work with the cap ON, including the largest honest one (135,240 B) and one byte over it being refused;
//   D. WITHOUT the option a legitimate 24 MiB card (what another emulator may send) is still assembled, broadcast and received unchanged.
//
// USAGE  node tools/gba_card_cap_test.mjs        (no server, no browser)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'lib/netplay.js'), 'utf8');
const load = (text) => { delete globalThis.Netplay; (0, eval)(text); const L = globalThis.Netplay.Lockstep; delete globalThis.Netplay; return L; };
const Lockstep = load(SRC);
const R = await import(pathToFileURL(path.join(ROOT, 'gba/mgba/room.js')).href);
const LIM = R.ROOM_CARD_LIMITS;

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { if (cond) { pass++; console.log('  ok   ' + name + (detail ? '  ' + detail : '')); } else { fail++; console.log('  FAIL ' + name + (detail ? '  ' + detail : '')); } };
const section = (t) => console.log('\n== ' + t);
const CAP_CALL = 'if (this.cardLimits && this._cardOverLimit(store, key, m, n, len)) return null;';
if (!SRC.replace(/\r\n/g, '\n').includes(CAP_CALL)) { console.log('FAIL the cap call site moved: update CAP_CALL in this test'); process.exit(1); }
const LockstepNoCap = load(SRC.replace(CAP_CALL, ''));   // a copy of the engine with the cap cut out: the negative control

const mem = () => { const m = process.memoryUsage(); return { rssMB: +(m.rss / 1048576).toFixed(1), abMB: +(m.arrayBuffers / 1048576).toFixed(1) }; };
const b64 = (u8) => Buffer.from(u8).toString('base64');

// N engines on a scriptable bus (the same shape tools/netplay_lockstep_test.mjs uses). relay=false: the host hears only what the test injects.
function room(LS, ids, opts = {}) {
  const bus = { engines: [], relay: opts.relay !== false, events: {} };
  const deliver = (from, m) => { for (const e of bus.engines) if (e.peerId !== from) e.receive(m); };
  ids.forEach((id, i) => {
    const e = new LS({ host: i === 0, peerId: id, portCount: 4, delay: 2, hashEvery: 0, fieldNames: ['a', 'b'], cardLimits: opts.cardLimits,
      send: (m) => { if (bus.relay) deliver(id, Object.assign({ peer: id }, m)); } });
    bus.events[id] = [];
    e.on('cards', (c) => bus.events[id].push(c));
    bus.engines.push(e); bus[id] = e;
  });
  for (const id of ids) bus[ids[0]].seat(id, 1);
  return bus;
}
const refusals = (bus, id) => bus.events[id].filter((c) => c && c.code === 'CARD_LIMIT');

// ── A ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
section('A. the hostile flood: 20,000 x 12 KiB pieces announced as ONE card of 2^31-1 bytes from a seated peer');
const PIECE = new Uint8Array(12 * 1024).fill(0xab), D = b64(PIECE), N = 20000;
function flood(LS, limits) {
  const b = room(LS, ['H', 'A'], { cardLimits: limits, relay: false });
  const before = mem();
  for (let i = 0; i < N; i++) b.H.receive({ t: 'lsvmu', peer: 'A', port: 1, size: 0x7fffffff, hash: 'deadbeef', enc: 'gba1;raw', len: 0x7fffffff, n: 0x7fffffff, i, d: D });
  const after = mem(), slot = b.H._cardParts.get('A#1');
  return { held: slot ? slot.got : 0, heldBytes: slot ? slot.parts.reduce((a, c) => a + (c ? c.length : 0), 0) : 0, slots: b.H._cardParts.size, refusals: refusals(b, 'H'), assembled: !!b.H.cards, abGrowthMB: +(after.abMB - before.abMB).toFixed(1), rssMB: [before.rssMB, after.rssMB] };
}
const fNone = flood(Lockstep, null);
ok('control, no limits (every other emulator): the flood IS held - 20,000 pieces, 245,760,000 B - and nothing is reported', fNone.held === N && fNone.heldBytes === N * PIECE.length && fNone.refusals.length === 0, JSON.stringify(fNone));
const fCap = flood(Lockstep, LIM);
ok('with ROOM_CARD_LIMITS: NOTHING is held (no reassembly slot, 0 pieces, 0 bytes) and the card is never assembled', fCap.held === 0 && fCap.heldBytes === 0 && fCap.slots === 0 && !fCap.assembled, JSON.stringify(fCap));
ok('...and the engine memory does not grow with the flood (ArrayBuffers < 5 MB, was 234.5 MB in the verifier\'s run)', fCap.abGrowthMB < 5, fCap.abGrowthMB + ' MB, RSS ' + fCap.rssMB.join(' -> '));
ok('...and the refusal is reported ONCE for 20,000 pieces, by name: code CARD_LIMIT, what "bytes", seat 2 (port 1), peer A, "seat 2" in the sentence', fCap.refusals.length === 1 && fCap.refusals[0].code === 'CARD_LIMIT' && fCap.refusals[0].what === 'bytes' && fCap.refusals[0].port === 1 && fCap.refusals[0].peer === 'A' && /seat 2/.test(fCap.refusals[0].error) && fCap.refusals[0].set === null, JSON.stringify(fCap.refusals[0]));
const fCut = flood(LockstepNoCap, LIM);
ok('NEGATIVE CONTROL, the cap cut out of a copy of the engine (limits still passed): the 20,000-piece card is HELD AGAIN (20,000 pieces, 245,760,000 B)', fCut.held === N && fCut.heldBytes === N * PIECE.length && fCut.refusals.length === 0, JSON.stringify(fCut));

// ── B ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
section('B. every reason a piece is refused: dropped, nothing allocated, reported once however many follow');
const honestPiece = (n) => ({ t: 'lsvmu', peer: 'A', port: 1, size: 1, hash: 'h', enc: 'gba1;raw', d: D, ...n });
const reasons = [
  ['bytes', { len: LIM.maxCardBytes + 1, n: Math.ceil((LIM.maxCardBytes + 1) / 12288), i: 0 }, LIM.maxCardBytes],
  ['pieces', { len: 1000, n: 0x7fffffff, i: 5 }, LIM.maxPieces],
  ['shape', { len: 100000, n: 3, i: 0 }, 9],
  ['piece-size', { len: 12288, n: 1, i: 0, d: 'A'.repeat(40000) }, 16384],
];
for (const [what, msg, max] of reasons) {
  const b = room(Lockstep, ['H', 'A'], { cardLimits: LIM, relay: false });
  for (let k = 0; k < 500; k++) b.H.receive(honestPiece(msg));
  const r = refusals(b, 'H');
  ok('"' + what + '": dropped (no slot opened), reported exactly once over 500 pieces, with the limit in the report', b.H._cardParts.size === 0 && r.length === 1 && r[0].what === what && r[0].max === max && r[0].port === 1, JSON.stringify(r[0]));
}
{ // slots: a guest's keys come from the message, so an unvalidated port could open endless slots; the cap holds it to maxCards
  const g = new Lockstep({ host: false, peerId: 'G', portCount: 4, cardLimits: LIM, send() {} }), seen = [], store = new Map();
  g.on('cards', (c) => seen.push(c));
  const first = (port) => ({ port, size: 24576, hash: 'h' + port, enc: 'gba1;raw', len: 24576, n: 2, i: 0, d: D });
  for (let p = 0; p < LIM.maxCards; p++) g._cardTake(store, 'p' + p, first(p));
  const accepted = store.size;
  for (let k = 0; k < 50; k++) g._cardTake(store, 'p' + (LIM.maxCards + k), first(LIM.maxCards + k));
  ok('"slots": ' + LIM.maxCards + ' in-flight cards are accepted, the next ones are refused (store stays at ' + LIM.maxCards + ') and reported', accepted === LIM.maxCards && store.size === LIM.maxCards && seen.some((c) => c.what === 'slots'), JSON.stringify({ accepted, final: store.size, reports: seen.length }));
  ok('...and a card already in flight is still completed (its second piece lands)', (() => { const r = g._cardTake(store, 'p0', { port: 0, size: 24576, hash: 'h0', enc: 'gba1;raw', len: 24576, n: 2, i: 1, d: D }); return !!r && r.bytes.length === 24576; })());
}

// ── C ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
section('C. honest cards with the cap ON: the room still forms; the largest honest card passes; one byte more does not');
const mk = (port, n, fill) => { const u = new Uint8Array(n).fill(fill); return { port, size: u.length, hash: Lockstep.cardHash(u), enc: 'gba1;raw', bytes: u }; };
{
  const b = room(Lockstep, ['H', 'A', 'B'], { cardLimits: LIM });
  const sizes = [131072, 1, LIM.maxCardBytes];
  b.H.contributeCards([mk(0, sizes[0], 1)]); b.A.contributeCards([mk(1, sizes[1], 2)]); b.B.contributeCards([mk(2, sizes[2], 3)]);
  const got = (e) => e.cards && [0, 1, 2].map((p) => e.cards[p] && e.cards[p].bytes.length);
  ok('three seats contribute 131,072 B, 1 B and the largest honest card (' + LIM.maxCardBytes + ' B): the host assembles the set', JSON.stringify(got(b.H)) === JSON.stringify(sizes), JSON.stringify(got(b.H)));
  ok('...both guests receive the identical set (same sizes, same hashes, same bytes) and nothing was refused', [b.A, b.B].every((g) => JSON.stringify(got(g)) === JSON.stringify(sizes) && g.cardSetHash === b.H.cardSetHash && [0, 1, 2].every((p) => Lockstep.cardHash(g.cards[p].bytes) === b.H.cards[p].hash)) && ['H', 'A', 'B'].every((id) => refusals(b, id).length === 0), 'set ' + b.H.cardSetHash);
}
{
  const b = room(Lockstep, ['H', 'A'], { cardLimits: LIM });
  b.H.contributeCards([mk(0, 100, 1)]);
  b.A.contributeCards([mk(1, LIM.maxCardBytes + 1, 9)]);
  const r = refusals(b, 'H');
  ok('one byte over the limit (' + (LIM.maxCardBytes + 1) + ' B): refused by name on the host, the set is NOT assembled and nothing is broadcast', !b.H.cards && r.length === 1 && r[0].what === 'bytes' && r[0].port === 1 && b.H._cardParts.size === 0, JSON.stringify(r[0] && { what: r[0].what, got: r[0].got, max: r[0].max, port: r[0].port }));
}
{ // the option may also be assigned after construction (ls.cardLimits = ...)
  const b = room(Lockstep, ['H', 'A'], { relay: false });
  b.H.cardLimits = LIM;
  for (let i = 0; i < 100; i++) b.H.receive({ t: 'lsvmu', peer: 'A', port: 1, size: 5, hash: 'x', enc: 'gba1;raw', len: 0x7fffffff, n: 0x7fffffff, i, d: D });
  ok('assigning ls.cardLimits after construction works the same way', b.H._cardParts.size === 0 && refusals(b, 'H').length === 1);
}

// ── D ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
section('D. WITHOUT the option (every other emulator) a legitimate large card is assembled and broadcast exactly as before');
{
  const b = room(Lockstep, ['H', 'A', 'B']);
  const BIG = 24 * 1024 * 1024;
  b.H.contributeCards([mk(0, 1000, 1)]); b.B.contributeCards([mk(2, 1000, 3)]);
  const big = mk(1, BIG, 2);
  b.A.contributeCards([big]);
  ok('a 24 MiB card from seat 2 is assembled on the host with no refusal and no error event', !!b.H.cards && b.H.cards[1].bytes.length === BIG && ['H', 'A', 'B'].every((id) => b.events[id].every((c) => !c.error)), 'host set ' + b.H.cardSetHash);
  ok('...and re-broadcast byte-for-byte: guest B holds all 25,165,824 B and they hash to what seat 2 contributed', !!b.B.cards && b.B.cards[1].bytes.length === BIG && Lockstep.cardHash(b.B.cards[1].bytes) === big.hash && b.B.cardSetHash === b.H.cardSetHash);
  ok('...and an engine built without the option carries no cap state (cardLimits null, nothing recorded as refused)', b.H.cardLimits === null && b.H._cardRefused.size === 0);
}

console.log(`\n[gba-card-cap] ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

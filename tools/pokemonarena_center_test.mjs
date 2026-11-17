// tools/pokemonarena_center_test.mjs -- THE TRAINER CENTER (pokemonarena/center.html): the avatar code and its sprites, the room and its walks, the room's messages and roster, the board's
// `av` field, the one-time MEET token, and then real browser tabs: walking in, seeing each other, walking, a new look, an emote, a hub player on a bench, a challenge that is declined,
// one that is accepted and becomes a battle on both screens, leaving, and the phone layout.
//
//   node tools/pokemonarena_center_test.mjs                 Node checks (C*), then the browser cases (CB*)
//   node tools/pokemonarena_center_test.mjs node            Node checks only (about a second)
//   node tools/pokemonarena_center_test.mjs --mutants       also: a copy of the code with ONE defect at a time; each must fail the case it names (Node mutants run on a copy of pokemonarena/js,
//                                                           browser mutants are served over the real files by a small overlay server)
//   CENTER_PORT (default 8241), CENTER_CDP (default 9441), CENTER_OUT=<dir> for screenshots
//   CENTER_ORIGIN=https://caseybement.com runs the browser cases against a DEPLOYED site (no local server; the pairing is still the same-browser transport)
//
// Browsers: tools/headless_cdp.mjs only (bare CDP, throwaway profile, --mute-audio). The tabs share one profile, which is what lets the same-browser transport (net=local) pair them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const args = process.argv.slice(2);
const MUTANTS = args.includes('--mutants');
const NODE_ONLY = args.includes('node');
const PAGE_MUTANTS_ONLY = args.includes('page-mutants');          // (with --mutants: skip the browser cases on the real tree, run only the page mutants)
const PORT = Number(process.env.CENTER_PORT || 8241);
const CDP0 = Number(process.env.CENTER_CDP || 9441);
const OUT = process.env.CENTER_OUT || path.join(os.tmpdir(), 'arena-center-shots');
const ORIGIN = (process.env.CENTER_ORIGIN || '').replace(/\/+$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (x) => JSON.stringify(x);
fs.mkdirSync(OUT, { recursive: true });

/* ================================================================================================ Node checks */
// runNode(jsDir) -> list of failed case names. jsDir is pokemonarena/js or a mutated copy of it.
async function runNode(jsDir, log) {
  const failed = [];
  const ok = (c, name, detail) => { if (!c) { failed.push(name); if (log) console.log('FAIL', name, detail === undefined ? '' : String(detail).slice(0, 300)); } else if (log && process.env.CENTER_VERBOSE) console.log('ok  ', name); };
  const imp = (f) => import(pathToFileURL(path.join(jsDir, f)).href + '?v=' + encodeURIComponent(jsDir));
  const A = await imp('avatar.js'), M = await imp('center_map.js'), N = await imp('center_net.js'), L = await imp('openlobby.js'), P = await imp('presence.js'), O = await imp('online.js');

  // ---- C1 the avatar code
  const all = [];
  for (let i = 0; i < 400; i++) { const u = (n) => Uint8Array.from({ length: n }, (_x, k) => (i * 37 + k * 101 + (i >> 2) * 13) & 255); all.push(A.encodeAvatar(A.randomAvatar(u))); }
  ok(all.every((c) => A.AV_RE.test(c) && A.parseAvatar(c) && A.encodeAvatar(A.parseAvatar(c)) === c), 'C1a every random look encodes to 7 characters and back unchanged', all.find((c) => !A.parseAvatar(c)));
  const junk = ['', '000000', '00000000', '000000Z', 'zzzzzzz', '6000000', '0600000', '00a0000', '0005000', '0000c00', '00000c0', '000000c', null, 7, {}, '0000-00'];
  ok(junk.every((c) => A.parseAvatar(c) === null), 'C1b a code outside any field\'s range, of the wrong length or of the wrong characters is no look at all', J(junk.filter((c) => A.parseAvatar(c) !== null)));
  ok(A.parseAvatar('5594bbb') && A.parseAvatar('0000000') && !A.parseAvatar('5595bbb') && !A.parseAvatar('55a4bbb'), 'C1c the largest and the smallest value of every field are valid', '');
  const st = A.stepField(A.DEFAULT_AVATAR, 'hair', -1), st2 = A.stepField({ ...A.DEFAULT_AVATAR, hair: 5 }, 'hair', 1);
  ok(st.hair === 5 && st2.hair === 0, 'C1d stepping a field wraps round both ways', J([st.hair, st2.hair]));
  ok(A.encodeAvatar({ skin: 99, hair: -3 }) === '5' + '0' + A.DEFAULT_CODE.slice(2), 'C1e a value out of range is clamped, a missing one is the default (encodeAvatar never makes a code nobody accepts)', A.encodeAvatar({ skin: 99, hair: -3 }));
  {
    const mem = new Map(), store = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)) };
    const saved = A.saveAvatar(store, '0371a52'), bad = A.saveAvatar(store, 'nope');
    mem.set(A.AVATAR_KEY + 'x', 'q');
    ok(saved && !bad && A.loadAvatar(store) === '0371a52' && A.loadAvatar({ getItem: () => { throw new Error('x'); } }) === null && A.loadAvatar({ getItem: () => 'zzzzzzz' }) === null, 'C1f the stored look: kept when valid, refused when not, and a storage that throws or holds junk reads as none', '');
  }
  // ---- C2 the sprites
  let shapeOk = true, mirrorOk = true, letters = true, stepsDiffer = true;
  const LET = new Set('.ksSetTpPbhHcCw'.split(''));
  for (const code of all.slice(0, 60)) {
    for (const d of A.DIRS) for (let s = 0; s < 3; s++) {
      const g = A.frameGrid(code, d, s);
      if (g.length !== A.SPRITE_H || g.some((r) => r.length !== A.SPRITE_W)) shapeOk = false;
      if (g.some((r) => r.some((c) => !LET.has(c)))) letters = false;
    }
    for (let s = 0; s < 3; s++) { const l = A.frameGrid(code, 'left', s), r = A.frameGrid(code, 'right', s); if (l.some((row, y) => row.join('') !== r[y].slice().reverse().join(''))) mirrorOk = false; }
    if (A.frameGrid(code, 'down', 0).map((r) => r.join('')).join() === A.frameGrid(code, 'down', 1).map((r) => r.join('')).join()) stepsDiffer = false;
  }
  ok(shapeOk && letters, 'C2a every frame of every look is a 16 x 24 grid of palette letters', '');
  ok(mirrorOk, 'C2b facing right is facing left mirrored', '');
  ok(stepsDiffer, 'C2c a walking step is a different picture from standing', '');
  const hat0 = A.frameGrid(A.encodeAvatar({ ...A.DEFAULT_AVATAR, hat: 0 }), 'down', 0).flat().filter((c) => c === 'c').length;
  const hat1 = A.frameGrid(A.encodeAvatar({ ...A.DEFAULT_AVATAR, hat: 1 }), 'down', 0).flat().filter((c) => c === 'c' || c === 'C').length;
  const pal = A.paletteOf(A.encodeAvatar({ ...A.DEFAULT_AVATAR, top: 0, legs: 5 }));
  ok(hat0 === 0 && hat1 > 20 && pal.t === A.CLOTH[0] && pal.p === A.CLOTH[5], 'C2d the parts the player picks are what is drawn (no hat paints no hat; the top and the trousers take their colours)', J([hat0, hat1, pal.t, pal.p]));
  const styles = new Set(A.HAIR_STYLES.map((_n, h) => A.frameGrid(A.encodeAvatar({ ...A.DEFAULT_AVATAR, hat: 0, hair: h }), 'down', 0).map((r) => r.join('')).join('/')));
  ok(styles.size === A.HAIR_STYLES.length, 'C2e every hair style looks different', styles.size);
  ok(/hair/.test(A.describeAvatar('0371a52')) && /cap/.test(A.describeAvatar('0371a52')) && A.describeAvatar('junk') === 'a trainer', 'C2f a look can be said in words (the editor\'s preview is labelled with it)', A.describeAvatar('0371a52'));

  // ---- C3 the room
  ok(M.ROWS.length === M.MAP_H && M.ROWS.every((r) => r.length === M.MAP_W) && M.MAP_W * M.TILE === 240 && M.MAP_H * M.TILE === 160, 'C3a the room is 15 x 10 tiles: the 240 x 160 picture of the rest of the Arena', '');
  ok(M.SPAWNS.every((s) => M.walkable(s.x, s.y) && !M.isExit(s.x, s.y)) && M.walkable(M.SPAWN.x, M.SPAWN.y), 'C3b every place a trainer can walk in at is floor, not the door mat', '');
  ok(M.SEATS.length >= 12 && M.SEATS.every((s) => M.tileAt(s.x, s.y) === 'B') && new Set(M.SEATS.map((s) => s.x + ',' + s.y)).size === M.SEATS.length, 'C3c every seat is a distinct bench tile', '');
  const spots = ['wardrobe', 'board', 'counter'].map((k) => M.useSpot(k));
  ok(spots.every((s) => s && M.walkable(s.x, s.y) && M.thingAt(s.x, s.y - 1)), 'C3d the wardrobe, the notice board and the counter can each be walked up to and faced', J(spots));
  // every floor tile can be reached from the door
  let unreachable = [];
  for (let y = 0; y < M.MAP_H; y++) for (let x = 0; x < M.MAP_W; x++) if (M.walkable(x, y) && !M.findPath(M.SPAWN, { x, y })) unreachable.push([x, y]);
  ok(!unreachable.length, 'C3e every floor tile can be reached from the door', J(unreachable));
  const p1 = M.findPath({ x: 7, y: 8 }, { x: 1, y: 2 });
  let at = { x: 7, y: 8 }, crossed = false;
  for (const d of (p1 || {}).steps || []) { at = M.ahead(at.x, at.y, d); if (!M.walkable(at.x, at.y)) crossed = true; }
  ok(p1 && !crossed && at.x === 1 && at.y === 2 && p1.steps.length === 12, 'C3f a walk is the shortest one and only ever crosses floor', J(p1));
  // the door mat is never crossed nor ended on unless it is where you asked to go
  const pAdj = M.findPath({ x: 7, y: 8 }, { x: 7, y: 8 }, { adjacent: true });
  const pMat = M.findPath({ x: 6, y: 8 }, { x: 8, y: 8 });
  let viaMat = false; at = { x: 6, y: 8 }; for (const d of (pMat || {}).steps || []) { at = M.ahead(at.x, at.y, d); if (M.isExit(at.x, at.y)) viaMat = true; }
  const pExit = M.findPath({ x: 7, y: 7 }, { x: 7, y: 9 });
  ok(pAdj && pAdj.steps.length === 1 && !M.isExit(...[M.ahead(7, 8, pAdj.steps[0])].map((t) => [t.x, t.y]).flat()) && !viaMat && pExit && pExit.steps.length === 2, 'C3g walking up to somebody (or anywhere) never steps on the door mat; walking TO the mat does', J([pAdj, pMat, pExit]));
  const toBench = M.findPath({ x: 7, y: 8 }, { x: 0, y: 5 });
  ok(toBench && toBench.face === 'left', 'C3h a walk to a bench ends beside it, facing the trainer on it', J(toBench));
  ok(M.findPath({ x: 0, y: 0 }, { x: 7, y: 8 }) === null && M.findPath({ x: 7, y: 8 }, { x: 0, y: 0 }) === null, 'C3i there is no walk from or into a wall', '');

  // ---- C4 the room's messages (checkCenterMsg)
  const S1 = 'a'.repeat(16), S2 = 'b'.repeat(16);
  const base = { t: N.KIND, v: N.VERSION, s: S1 };
  const here = { ...base, k: 'here', name: 'Alice', av: '0371a52', x: 7, y: 8, d: 'up' };
  const c = (m) => N.checkCenterMsg(m);
  ok(c(here).ok && c({ ...here, b: S2, rec: [3, 1] }).ok && c({ ...base, k: 'mv', x: 6, y: 8, d: 'left' }).ok && c({ ...base, k: 'emo', e: 4 }).ok && c({ ...base, k: 'ask' }).ok && c({ ...base, k: 'bye' }).ok, 'C4a every kind the room defines is accepted', '');
  const refused = [
    ['wrong type', { ...here, t: 'arenaopen' }], ['version', { ...here, v: 2 }], ['sender', { ...here, s: 'XYZ' }], ['kind', { ...here, k: 'chal' }],
    ['a wall', { ...here, x: 0, y: 0 }], ['the counter', { ...here, x: 6, y: 2 }], ['off the map', { ...here, x: 15, y: 3 }], ['a fraction', { ...here, x: 7.5 }], ['a negative', { ...here, x: -1 }],
    ['direction', { ...here, d: 'north' }], ['look', { ...here, av: 'zzzzzzz' }], ['no look', { ...here, av: undefined }], ['empty name', { ...here, name: '' }], ['long name', { ...here, name: 'x'.repeat(41) }],
    ['board id', { ...here, b: 'nothex' }], ['record', { ...here, rec: [1, -1] }], ['record size', { ...here, rec: [1, 2, 3] }], ['emote', { ...base, k: 'emo', e: N.EMOTES.length }], ['emote text', { ...base, k: 'emo', e: 'hi' }],
    ['array', [here]], ['null', null],
  ];
  const leaked = refused.filter(([, m]) => c(m).ok).map(([n]) => n);
  ok(!leaked.length, 'C4b a message with any field out of shape is refused (wrong type, version, sender, kind, a position that is not floor, a direction, a look, a name, a board id, a record, an emote)', J(leaked));
  const cleaned = c({ ...here, name: '<img src=x onerror=1>Al‮ice', room: 'ABCD', extra: 'x', b: S2 });
  ok(cleaned.ok && !/[<>]/.test(cleaned.b.name) && !('room' in cleaned.b) && !('extra' in cleaned.b) && Object.keys(cleaned.b).sort().join() === 'av,b,d,k,name,rec,s,x,y', 'C4c only the fields the room defines come out, and the name is reduced to safe text', J(cleaned));

  // ---- C5 the roster
  let t = 0;
  const R = N.createRoster({ now: () => t, ttlMs: 10000, max: 3, emoteShowMs: 2000 });
  const H = (s, extra) => c({ ...here, s, ...extra }).b;
  ok(!R.hear(c({ ...base, s: S2, k: 'mv', x: 6, y: 8, d: 'up' }).b) && R.size() === 0, 'C5a a step from somebody who never said who they are puts nobody in the room', '');
  ok(R.hear(H(S1)) && R.size() === 1 && R.get(S1).name === 'Alice', 'C5b a `here` puts a trainer in the room', '');
  t = 500; R.hear(c({ ...base, k: 'mv', x: 6, y: 8, d: 'left' }).b);
  ok(R.get(S1).x === 6 && R.get(S1).d === 'left', 'C5c a step moves them', J(R.get(S1)));
  t = 900; R.hear(c({ ...base, k: 'emo', e: 2 }).b);
  t = 2000; R.prune(); const e1 = R.get(S1).emote;
  t = 3000; R.prune(); const e2 = R.get(S1).emote;
  ok(e1 && e1.e === 2 && e2 === null, 'C5d an emote shows for a moment, then goes', J([e1, e2]));
  R.hear(H('c'.repeat(16))); R.hear(H('d'.repeat(16))); const capped = !R.hear(H('e'.repeat(16))) && R.size() === 3;
  ok(capped, 'C5e the room holds at most its cap of trainers', R.size());
  t = 12999; R.hear(c({ ...base, k: 'mv', x: 7, y: 8, d: 'up' }).b); t = 13500; R.prune();
  ok(R.get(S1) && !R.get('c'.repeat(16)), 'C5f a trainer who has gone quiet for the ttl drops out; one who keeps stepping does not', J(R.list().map((w) => w.s.slice(0, 2))));
  R.hear(c({ ...base, k: 'bye' }).b);
  ok(!R.get(S1), 'C5g a bye takes the trainer out at once', '');

  // ---- C6 one page in the room (createCenter): fake bus, fake clock, fake timers
  const mkTimers = () => {
    let id = 0; const q = new Map();
    return {
      T: { setInterval: (f, ms) => { q.set(++id, { f, at: t + ms, every: ms }); return id; }, clearInterval: (h) => q.delete(h), setTimeout: (f, ms) => { q.set(++id, { f, at: t + ms }); return id; }, clearTimeout: (h) => q.delete(h) },
      run(to) { for (;;) { let best = null; for (const [h, e] of q) if (e.at <= to && (!best || e.at < best[1].at)) best = [h, e]; if (!best) break; const [h, e] = best; t = e.at; if (e.every) e.at += e.every; else q.delete(h); e.f(); } t = to; },
    };
  };
  t = 0;
  const sent = [], bus = { cb: null, send: (o) => sent.push(o), onMessage(f) { this.cb = f; }, close() { this.closed = true; } };
  const tm = mkTimers();
  const mine = { name: 'Bob', av: '4192305', x: 7, y: 8, d: 'up', b: null, rec: null };
  let rbyte = 0;
  const C = N.createCenter({ bus, me: () => mine, now: () => t, timers: tm.T, random: (n) => Uint8Array.from({ length: n }, () => (rbyte = (rbyte + 77) & 255)) });
  C.start();
  ok(sent.length === 2 && sent[0].k === 'here' && sent[0].name === 'Bob' && sent[1].k === 'ask' && sent.every((m) => m.s === C.sid && m.t === N.KIND), 'C6a walking in says who we are and asks who is here', J(sent));
  tm.run(3000);
  ok(sent.filter((m) => m.k === 'here').length === 2, 'C6b ... and says it again every few seconds', sent.length);
  sent.length = 0;
  mine.x = 6; C.moved(); mine.x = 5; C.moved(); mine.x = 4; C.moved();
  const mv1 = sent.filter((m) => m.k === 'mv').length;
  tm.run(t + 100);
  const mvs = sent.filter((m) => m.k === 'mv');
  ok(mv1 === 1 && mvs.length === 2 && mvs[1].x === 4, 'C6c steps that come faster than the gap are sent once the gap is over, as the latest position (nothing in between is lost for good)', J(mvs));
  sent.length = 0;
  const e1ok = C.emote(1), e2ok = C.emote(2); tm.run(t + N.TIMING.emoteGapMs); const e3ok = C.emote(3), e4ok = C.emote(99);
  ok(e1ok && !e2ok && e3ok && !e4ok && sent.filter((m) => m.k === 'emo').length === 2, 'C6d emotes are spaced out, and only real ones are sent', J(sent));
  sent.length = 0;
  bus.cb({ ...base, s: S2, k: 'ask' }); bus.cb({ ...base, s: S2, k: 'ask' });
  tm.run(t + N.TIMING.jitterMs + 5);
  ok(sent.filter((m) => m.k === 'here').length === 1, 'C6e an ask is answered once (after a little random wait), however often it is repeated', J(sent));
  sent.length = 0;
  bus.cb({ ...base, s: S2, k: 'mv', x: 6, y: 8, d: 'up' });
  ok(sent.some((m) => m.k === 'ask') && C.roster.size() === 0, 'C6f a step from somebody we have not met makes us ask who they are (their `here` was lost)', J(sent));
  bus.cb({ ...here, s: S2, name: 'Eve' });
  ok(C.list().length === 1 && C.list()[0].name === 'Eve', 'C6g ... and their answer puts them in the room', J(C.list()));
  bus.cb({ ...here, s: C.sid, name: 'Echo' });
  ok(C.list().length === 1, 'C6h our own messages coming back from the broker are not a second trainer', '');
  // flood: one sender, many messages in one second
  const S3 = '3'.repeat(16);
  bus.cb({ ...here, s: S3, name: 'Flood' });
  for (let i = 0; i < 60; i++) bus.cb({ ...base, s: S3, k: 'mv', x: 3 + (i % 2), y: 3, d: 'up' });
  const fx = C.roster.get(S3).x;
  t += 1001; bus.cb({ ...base, s: S3, k: 'mv', x: 10, y: 3, d: 'up' });
  // (the `here` counts too: perSenderMax - 1 steps are heard, the last of them is step perSenderMax - 2)
  ok(fx === 3 + ((N.TIMING.perSenderMax - 2) % 2) && C.roster.get(S3).x === 10, 'C6i one sender cannot send more than its share in a second (the rest is dropped unread); the next second they are heard again', J([fx, C.roster.get(S3).x]));
  sent.length = 0; C.close();
  ok(sent.length === 1 && sent[0].k === 'bye' && bus.closed, 'C6j leaving says bye and lets go of the connection', J(sent));
  C.moved(); C.emote(1); C.update();
  ok(sent.length === 1, 'C6k nothing is sent after leaving', sent.length);

  // ---- C7 the board carries the look (openlobby.js `av`)
  const ROM = 'f'.repeat(64);
  const open = { t: L.BEACON, v: L.BEACON_V, k: 'open', s: S1, room: 'H1234', name: 'Hub', fmt: '3v3', rom: ROM, fp: 'fp', rs: 'rs', h: 1 };
  const bOk = L.checkBeacon({ ...open, av: '0371a52' }), bNone = L.checkBeacon(open), bBad = L.checkBeacon({ ...open, av: '<script>' });
  ok(bOk.ok && bOk.b.av === '0371a52' && bNone.ok && bNone.b.av === null && !bBad.ok, 'C7a a listing may carry a look; one that is not seven base-36 characters is refused', J([bOk, bBad]));
  {
    const out = []; let tt = 0;
    const lb = L.createOpenLobbies({ bus: { send: (o) => out.push(o), onMessage() {}, close() {} }, now: () => tt, mine: { rom: ROM, fp: 'fp' }, timers: { setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {} }, random: (n) => new Uint8Array(n).fill(5) });
    lb.host({ room: 'H9999', name: 'Me', fmt: '3v3', rom: ROM, fp: 'fp', rs: 'rs', h: true, av: '0371a52' });
    ok(out[0] && out[0].av === '0371a52', 'C7b a listing with a look sends it', J(out[0]));
    const D = L.createDirectory({ now: () => tt });
    D.hear(bOk.b); tt = 100; const changed = D.hear({ ...bOk.b, av: '1111111' });
    ok(changed && D.list()[0].av === '1111111' && D.list()[0].first === 0, 'C7c a new look is news for the board but is the same listing (it keeps its place)', J(D.list()[0]));
  }

  // ---- C8 the meet token (presence.js) and the battle page's address (online.js)
  {
    const mem = new Map(), store = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
    const w = P.writeMeetToken(store, 'afumt', 1000);
    ok(w && P.takeMeetToken(store, 'AFUMT', 2000) && !P.takeMeetToken(store, 'AFUMT', 2000), 'C8a the meet token is taken once, for its room', '');
    P.writeMeetToken(store, 'AFUMT', 1000);
    ok(!P.takeMeetToken(store, 'OTHER', 1500) && !mem.has(P.MEET_KEY), 'C8b a token for another room starts nothing (and is gone)', '');
    P.writeMeetToken(store, 'AFUMT', 1000);
    ok(!P.takeMeetToken(store, 'AFUMT', 1000 + P.MEET_MAX_AGE_MS + 1), 'C8c an old token starts nothing', '');
    mem.set(P.MEET_KEY, '{"room":"AFUMT"');
    ok(!P.takeMeetToken(store, 'AFUMT', 1000) && !P.writeMeetToken(store, 'no spaces!', 1) && !P.takeMeetToken(null, 'AFUMT', 1), 'C8d junk, a bad room or no storage starts nothing', '');
    const stuck = { getItem: () => '{"room":"AFUMT","at":1000}', removeItem() {} };
    ok(!P.takeMeetToken(stuck, 'AFUMT', 1500), 'C8e a token that will not go away is not usable (one use or no use)', '');
    const qy = O.parseOnlineQuery('?np=AFUMT&join=1&meet=1'), qh = O.parseOnlineQuery('?np=AFUMT&host=1&meet=1'), qo = O.parseOnlineQuery('?online=1&meet=1');
    ok(qy.meet === true && qh.meet === false && qo.meet === false, 'C8f only a JOIN address with a room can ask to be joined by itself', J([qy.meet, qh.meet, qo.meet]));
    const ca = O.canonicalAddress('http://x/pokemonarena/battle.html?np=AFUMT&join=1&meet=1&net=local', 'guest', 'AFUMT'), ba = O.boardAddress('http://x/pokemonarena/battle.html?np=AFUMT&join=1&meet=1');
    ok(!/meet/.test(ca) && /net=local/.test(ca) && !/meet/.test(ba), 'C8g the address a reload comes back to does not ask again', J([ca, ba]));
  }
  return failed;
}

/* ================================================================================================ Node mutants */
// each: { id, file, from, to, fails }  (fails: a case id prefix that must be among the failures)
const NODE_MUTANTS = [
  { id: 'NM1', file: 'avatar.js', from: "    if (!(v >= 0 && v < FIELDS[i].names.length)) return null;", to: "    if (!(v >= 0)) return null;", fails: 'C1b' },
  { id: 'NM2', file: 'avatar.js', from: "  const out = dir === 'right' ? g.map((r) => r.slice().reverse()) : g;", to: "  const out = g;", fails: 'C2b' },
  { id: 'NM3', file: 'center_net.js', from: "  if (!isPos(m.x, m.y)) return bad('position');", to: "  if (!Number.isInteger(m.x) || !Number.isInteger(m.y)) return bad('position');", fails: 'C4b' },
  { id: 'NM4', file: 'center_net.js', from: "    if (++p.n > timing.perSenderMax) return;", to: "    ++p.n;", fails: 'C6i' },
  { id: 'NM5', file: 'center_net.js', from: "      if (!w) return false;\n      w.seen = t;", to: "      if (!w) { if (b.k !== 'mv') return false; walkers.set(b.s, { s: b.s, name: 'Trainer', av: '0000000', x: b.x, y: b.y, d: b.d, b: null, rec: null, first: t, seen: t, movedAt: t, emote: null }); return true; }\n      w.seen = t;", fails: 'C5a' },
  { id: 'NM6', file: 'center_net.js', from: "      if (t - lastMove >= timing.moveGapMs) { T.clearTimeout(moveTimer); go(); }\n      else if (!moveTimer) moveTimer = T.setTimeout(go, timing.moveGapMs - (t - lastMove));", to: "      if (t - lastMove >= timing.moveGapMs) { T.clearTimeout(moveTimer); go(); }", fails: 'C6c' },
  { id: 'NM7', file: 'center_net.js', from: "      if (started) send({ k: 'bye' });", to: "", fails: 'C6j' },
  { id: 'NM8', file: 'center_net.js', from: "    if (!r.ok || r.b.s === sid) return;", to: "    if (!r.ok) return;", fails: 'C6h' },
  { id: 'NM9', file: 'center_map.js', from: "  const passable = (x, y) => walkable(x, y) && (!isExit(x, y) || (x === to.x && y === to.y && !adjacent));", to: "  const passable = (x, y) => walkable(x, y);", fails: 'C3g' },
  { id: 'NM10', file: 'presence.js', from: "    return t.room === room.toUpperCase() && age <= maxAgeMs && age >= -5000;", to: "    return age <= maxAgeMs && age >= -5000;", fails: 'C8b' },
  { id: 'NM11', file: 'presence.js', from: "    storage.removeItem(MEET_KEY);\n    if (storage.getItem(MEET_KEY) !== null) return false;", to: "    storage.removeItem(MEET_KEY);", fails: 'C8e' },
  { id: 'NM12', file: 'online.js', from: "meet: q.get('meet') === '1' && join && room !== null };", to: "meet: q.get('meet') === '1' };", fails: 'C8f' },
  { id: 'NM13', file: 'openlobby.js', from: "  if (!(m.av === undefined || m.av === null || (typeof m.av === 'string' && AV_RE.test(m.av)))) return bad('look');\n", to: "", fails: 'C7a' },
  { id: 'NM14', file: 'center_net.js', from: "  return { ok: true, b: { k: 'here', s, name: cleanName(m.name, 'Trainer'),", to: "  return { ok: true, b: { k: 'here', s, name: m.name,", fails: 'C4c' },
];
async function runNodeMutants() {
  let killed = 0;
  const src = path.join(root, 'pokemonarena', 'js');
  for (const m of NODE_MUTANTS) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctr-mut-'));
    for (const f of fs.readdirSync(src)) if (f.endsWith('.js')) fs.copyFileSync(path.join(src, f), path.join(dir, f));
    const fp = path.join(dir, m.file);
    const body = fs.readFileSync(fp, 'utf8').replace(/\r\n/g, '\n');
    const n = body.split(m.from).length - 1;
    if (n !== 1) { console.log('MUTANT', m.id, 'snippet occurs', n, 'times in', m.file); fs.rmSync(dir, { recursive: true, force: true }); continue; }
    fs.writeFileSync(fp, body.replace(m.from, () => m.to));
    let failed = [];
    try { failed = await runNode(dir, false); } catch (e) { failed = ['threw: ' + e.message]; }
    const hit = failed.some((f) => f.startsWith(m.fails));
    if (hit) killed++; else console.log('MUTANT SURVIVED', m.id, m.file, '(expected', m.fails, 'to fail; failed:', J(failed) + ')');
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('node mutants killed', killed + '/' + NODE_MUTANTS.length);
  return killed === NODE_MUTANTS.length;
}

/* ================================================================================================ browser cases */
let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, detail) { if (cond) { pass++; if (process.env.CENTER_VERBOSE) console.log('ok  ', name); } else { fail++; failures.push(name); console.log('FAIL', name, detail === undefined ? '' : String(detail).slice(0, 400)); } }
const NO_THROTTLE = ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-features=BackForwardCache,IntensiveWakeUpThrottling'];

let server = null;
async function startServer(port) {
  const probe = async () => { try { return (await fetch(`http://localhost:${port}/pokemonarena/center.html`)).ok; } catch (_e) { return false; } };
  if (await probe()) throw new Error('port ' + port + ' already serves something (a stale dev server would test an old tree): set CENTER_PORT');
  server = spawn(process.execPath, [path.join(root, 'tools', 'devserver.mjs')], { env: { ...process.env, PORT: String(port), WEB_ROOT: root }, stdio: 'ignore', windowsHide: true });
  for (let i = 0; i < 60 && !(await probe()); i++) await sleep(250);
}
// The overlay server for the browser mutants: everything is the dev server's, except the files a mutant changes.
function overlay(port, upstream, files) {
  const srv = http.createServer(async (req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (files[p] !== undefined) { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' }); res.end(files[p]); return; }
    try {
      const headers = {}; if (req.headers.range) headers.range = req.headers.range;
      const r = await fetch(`http://localhost:${upstream}${req.url}`, { headers });
      const h = {}; r.headers.forEach((v, k) => { if (!/^(content-encoding|transfer-encoding|connection)$/.test(k)) h[k] = v; });
      res.writeHead(r.status, h); res.end(Buffer.from(await r.arrayBuffer()));
    } catch (e) { res.writeHead(502); res.end(String(e)); }
  });
  return new Promise((r) => srv.listen(port, () => r(srv)));
}

async function browserCases(origin, cdp, only) {
  const { withBrowser } = await import('./headless_cdp.mjs');
  const U = (n, av, extra = '') => `${origin}/pokemonarena/center.html?net=local&anim=0&ctrname=${n}&ctrav=${av}${extra}`;
  const ready = 'window.__arenaCenter && window.__arenaCenter.ready';
  const walkIn = async (p) => { await p.waitFor(ready, { timeoutMs: 60000 }); await p.eval('(() => { const b = document.getElementById("ctrWalkIn"); if (b && !document.getElementById("ctrDlg").hidden) b.click(); })()'); await p.waitFor('window.__arenaCenter.phase === "in"', { timeoutMs: 10000 }); };
  const people = (p) => p.eval('window.__arenaCenter.people()');
  // a case runs when it is the one asked for, or the group it belongs to is (want('CB2') for 'CB2c'), or it is inside a group asked for (want('CB2c') for 'CB2')
  const want = (id) => !only || only.some((x) => id.startsWith(x) || x.startsWith(id));
  const clickId = (p, id) => p.eval(`(() => { const b = document.getElementById(${J(id)}); if (!b) return false; b.click(); return true; })()`);
  const front = (p) => p.send('Page.bringToFront').catch(() => {});
  const shot = async (p, n) => { try { await p.screenshot(path.join(OUT, n + '.png')); } catch (_e) { /* evidence, not the test */ } };

  // ---- the room: walking in, seeing each other, walking, a new look, an emote, leaving
  await withBrowser({ port: cdp, width: 1000, height: 900, lock: false, args: NO_THROTTLE }, async (a) => {
    // a spy on the room's channel: what goes out, and when
    const spy = await a.openTab({ width: 600, height: 400 });
    await spy.navigate(origin + '/pokemonarena/text_manifest.json');          // any page of the site's origin will do (pokemonarena/dev is not deployed)
    await spy.eval('window.__spy = []; window.__ch = new BroadcastChannel("bemental-arena-center-1"); window.__ch.onmessage = (e) => window.__spy.push(e.data); window.__bd = []; window.__bc = new BroadcastChannel("bemental-arena-open-1"); window.__bc.onmessage = (e) => window.__bd.push(e.data); true');
    await a.navigate(U('Alice', '0371a52'));
    await a.waitFor(ready, { timeoutMs: 60000 });
    await sleep(1200);
    const pre = await a.eval('({ dlg: window.__arenaCenter.dialog, phase: window.__arenaCenter.phase, shares: (document.getElementById("ctrEntryShares") || {}).textContent || "" })');
    const spied0 = await spy.eval('window.__spy.length + window.__bd.length');
    if (want('CB1')) {
      ok(pre.dlg === 'entry' && pre.phase === 'outside', 'CB1a a player who is not Open to battles is asked first: the Center starts outside, with the Walk in card', J(pre));
      ok(/trainer name/.test(pre.shares) && /look/.test(pre.shares) && /where you stand/.test(pre.shares) && /online record/.test(pre.shares) && /public servers/.test(pre.shares), 'CB1b the card says what walking in shares (name, look, position, record) and where', pre.shares);
      ok(spied0 === 0, 'CB1c nothing at all is published before Walk in', spied0);
    }
    await shot(a, 'cb_entry');
    await walkIn(a);
    const b = await a.openTab({ width: 1000, height: 900 });
    await b.navigate(U('Bob', '4192305'));
    await walkIn(b);
    await b.waitFor('window.__arenaCenter.people().some((p) => p.name === "Alice")', { timeoutMs: 15000 }).catch(() => {});
    await a.waitFor('window.__arenaCenter.people().some((p) => p.name === "Bob")', { timeoutMs: 15000 }).catch(() => {});
    const pa = await people(a), pb = await people(b);
    if (want('CB2')) {
      ok(pb.some((p) => p.name === 'Alice' && p.av === '0371a52' && !p.seated) && pa.some((p) => p.name === 'Bob' && p.av === '4192305' && !p.seated), 'CB2a two trainers who walk in see each other, walking, in their own looks', J([pa, pb]));
      const herePub = await spy.eval('window.__spy.filter((m) => m.k === "here").map((m) => Object.keys(m).sort().join())');
      ok(herePub.length > 0 && herePub.every((k) => /^(av,)?(b,)?d,k,name,(rec,)?s,t,v,x,y$/.test(k)), 'CB2b what a trainer publishes in the room is only its defined fields (no team, no room)', J(herePub.slice(0, 3)));
    }
    await b.waitFor('window.__arenaCenter.people().some((p) => p.name === "Alice" && p.battle === "challenge")', { timeoutMs: 60000 }).catch(() => {});
    if (want('CB2')) ok((await people(b)).some((p) => p.name === 'Alice' && p.battle === 'challenge'), 'CB2c once the game file has loaded, a trainer in the room is also open to battles: talking to them is a challenge', J(await people(b)));
    // Bob walks: Alice sees him arrive
    await front(b);
    await b.eval('window.__arenaCenter.walkTo(3, 3)');
    await b.waitFor('(() => { const m = window.__arenaCenter.me; return m.x === 3 && m.y === 3 && !m.moving; })()', { timeoutMs: 15000 }).catch(() => {});
    await a.waitFor('window.__arenaCenter.people().some((p) => p.name === "Bob" && p.x === 3 && p.y === 3)', { timeoutMs: 5000 }).catch(() => {});
    if (want('CB3')) ok((await people(a)).some((p) => p.name === 'Bob' && p.x === 3 && p.y === 3), 'CB3a a tap-walk across the room arrives, and the other screen sees where they are', J(await people(a)));
    // keys walk too: Bob presses Right for a while
    await b.eval('(() => { const k = (type) => window.dispatchEvent(new KeyboardEvent(type, { code: "ArrowRight", key: "ArrowRight", bubbles: true })); k("keydown"); window.__up = () => k("keyup"); })()');
    await sleep(700);
    await b.eval('window.__up()');
    await sleep(500);
    const mb = await b.eval('window.__arenaCenter.me');
    if (want('CB3')) ok(mb.x >= 5 && mb.y === 3 && mb.d === 'right', 'CB3b holding a direction key walks that way, tile by tile', J(mb));
    await b.eval('window.dispatchEvent(new KeyboardEvent("keydown", { code: "ArrowDown", key: "ArrowDown", bubbles: true })); window.dispatchEvent(new KeyboardEvent("keyup", { code: "ArrowDown", key: "ArrowDown", bubbles: true }))');
    await sleep(300);
    const mt = await b.eval('window.__arenaCenter.me');
    if (want('CB3')) ok(mt.d === 'down' && mt.x === mb.x && mt.y === mb.y, 'CB3c a tap of a direction only turns on the spot', J([mb, mt]));
    // a new look
    await b.eval('document.getElementById("ctrLook").click()');
    await b.waitFor('window.__arenaCenter.dialog === "look"', { timeoutMs: 5000 });
    await b.eval('document.getElementById("ctrNext-hair").click(); document.getElementById("ctrNext-top").click()');
    await shot(b, 'cb_look');
    await b.eval('document.getElementById("ctrLookSave").click()');
    const newAv = await b.eval('window.__arenaCenter.av');
    await a.waitFor(`window.__arenaCenter.people().some((p) => p.name === "Bob" && p.av === ${J(newAv)})`, { timeoutMs: 6000 }).catch(() => {});
    if (want('CB4')) {
      ok(newAv !== '4192305' && newAv[1] === '2' && newAv[5] === '1', 'CB4a the wardrobe changes the look one part at a time', newAv);
      ok((await people(a)).some((p) => p.name === 'Bob' && p.av === newAv), 'CB4b the new look is seen by the others at once', J(await people(a)));
      ok((await b.eval('localStorage.getItem("arena.avatar")')) === newAv, 'CB4c ... and is kept for the next visit', '');
    }
    // an emote
    await b.eval('document.getElementById("ctrEmote").click()');
    await b.waitFor('window.__arenaCenter.dialog === "emote"', { timeoutMs: 5000 });
    await b.eval('document.getElementById("ctrEmo0").click()');
    await a.waitFor('window.__arenaCenter.people().some((p) => p.name === "Bob" && p.emote === "!")', { timeoutMs: 4000 }).catch(() => {});
    if (want('CB5')) ok((await people(a)).some((p) => p.name === 'Bob' && p.emote === '!'), 'CB5a an emote shows over the head on the other screen', J(await people(a)));
    // a hub player with Open on: on a bench
    const hub = await a.openTab({ width: 900, height: 760 });
    await hub.navigate(origin + '/pokemonarena/?net=local');
    await hub.waitFor('document.body.dataset.state === "ready" && window.__arenaPresence', { timeoutMs: 90000 });
    await hub.eval('localStorage.setItem("arena.avatar", "2234847"); document.getElementById("openToggle").click()');
    await hub.waitFor('window.__arenaPresence.isOn() && window.__arenaPresence.presence', { timeoutMs: 30000 });
    await b.waitFor('window.__arenaCenter.people().some((p) => p.seated)', { timeoutMs: 20000 }).catch(() => {});
    const seated = (await people(b)).filter((p) => p.seated);
    if (want('CB6')) ok(seated.length === 1 && seated[0].battle === 'challenge' && seated[0].av === '2234847', 'CB6a a player who is open from the hub sits on a bench, in their own look, and can be challenged from the Center', J(seated));
    // (switching Open off in the hub would switch it off in THIS browser, and the Center tabs follow the switch and leave: closing the hub page is the bench's own case)
    await hub.navigate('about:blank');
    await b.waitFor('!window.__arenaCenter.people().some((p) => p.seated)', { timeoutMs: 20000 }).catch(() => {});
    if (want('CB6')) ok(!(await people(b)).some((p) => p.seated), 'CB6b ... and leaves the bench when they close the page', J(await people(b)));
    // (the hub left Open switched on in this browser: every Center tab simply stays in)
    await front(b);
    // a challenge that is declined
    const alice = (await people(b)).find((p) => p.name === 'Alice');
    await b.eval(`window.__arenaCenter.talk(${J(alice.id)})`);
    await b.waitFor('window.__arenaCenter.dialog === "talk"', { timeoutMs: 20000 }).catch(() => {});
    const talkText = await b.eval('(document.getElementById("ctrDlgTitle").textContent + " | " + (document.getElementById("ctrBattle") || {}).textContent)');
    const meNext = await b.eval('window.__arenaCenter.me');
    if (!/^Battle Alice/.test(talkText)) console.log('  (CB7 debug)', await b.eval('JSON.stringify({ d: window.__arenaCenter.dialog, ph: window.__arenaCenter.phase, t: document.getElementById("ctrDlgText") && document.getElementById("ctrDlgText").textContent, st: document.getElementById("ctrStatus").textContent })'));
    if (want('CB7')) ok(/^Battle Alice\?/.test(talkText) && /Ask to battle/.test(talkText) && Math.abs(meNext.x - alice.x) + Math.abs(meNext.y - alice.y) === 1, 'CB7a talking to a trainer walks up next to them and asks "Battle Alice?" with Ask to battle', J([talkText, meNext, alice]));
    await shot(b, 'cb_talk');
    await clickId(b, 'ctrBattle');
    await a.waitFor('(() => { const d = document.getElementById("challenge"); return !!d && !d.hidden; })()', { timeoutMs: 20000 }).catch(() => {});
    const chText = await a.eval('(document.getElementById("chText") || {}).textContent || ""');
    if (want('CB7')) ok(/^Bob wants to battle you/.test(chText), 'CB7b the trainer asked sees "Bob wants to battle you" (the dialog every Arena page shows)', chText);
    await shot(a, 'cb_challenged');
    await clickId(a, 'chDecline');
    await b.waitFor('window.__arenaCenter.dialog === "answer"', { timeoutMs: 15000 }).catch(() => {});
    const ans = await b.eval('document.getElementById("ctrDlgText") ? document.getElementById("ctrDlgText").textContent : ""');
    if (want('CB7')) ok(/Alice said not now/.test(ans), 'CB7c a declined challenge says so, and the challenger is still in the Center', ans);
    await clickId(b, 'ctrOk');
    // leaving: Alice speaks first, so the room's own time-out (10 s after the last word) cannot be what takes her off Bob's screen in the next 3 s; only her bye can
    await a.eval('window.__arenaCenter.center && window.__arenaCenter.center.update()');
    await b.waitFor('window.__arenaCenter.people().some((p) => p.name === "Alice")', { timeoutMs: 3000 }).catch(() => {});
    await a.eval('document.getElementById("ctrLeave").click()');
    await a.waitFor('window.__arenaCenter && window.__arenaCenter.dialog === "leave"', { timeoutMs: 5000 });
    await a.eval('document.getElementById("ctrLeaveGo").click()');
    await b.waitFor('!window.__arenaCenter.people().some((p) => p.name === "Alice")', { timeoutMs: 3000 }).catch(() => {});
    if (process.env.CENTER_DEBUG) console.log('  (CB8 debug)', await spy.eval('JSON.stringify(window.__spy.filter((m) => m.k === "bye" || m.k === "here").slice(-6).map((m) => [m.k, m.s.slice(0, 4), m.name]))'), J(await people(b)));
    if (want('CB8')) {
      // (Bob must still BE in the room: an empty room also has no Alice in it, and that is how this case once passed with the bye removed)
      const bIn = await b.eval('window.__arenaCenter.phase === "in" && !!window.__arenaCenter.center && window.__arenaCenter.center.isIn()');
      ok(bIn && !(await people(b)).some((p) => p.name === 'Alice'), 'CB8a a trainer who leaves is gone from the other screen at once (not after the time-out), and the other is still in the room', J([bIn, await people(b)]));
      await a.waitFor('location.pathname === "/pokemonarena/"', { timeoutMs: 10000 }).catch(() => {});
      ok((await a.eval('location.pathname + location.search')) === '/pokemonarena/?net=local', 'CB8b Leave goes back to the Arena\'s menu (on the same transport: a test must not dial the public brokers)', await a.eval('location.href'));
    }
    const errs = (await a.eval('[]')) && [];
    if (want('CB9')) ok(!b.errors.length && !(await b.eval('window.__arenaCenter.errors.length')), 'CB9a no page errors', J(b.errors.concat(errs)).slice(0, 300));
  });

  // ---- a challenge accepted in the Center is a battle on both screens; the meet token is what joins
  if (want('CB10') || want('CB11')) await withBrowser({ port: cdp + 1, width: 1000, height: 900, lock: false, args: NO_THROTTLE }, async (a) => {
    const phase = (p) => p.eval('(window.__arenaOnline && window.__arenaOnline.nm() ? window.__arenaOnline.nm().status().phase : null)').catch(() => null);
    // CB11 first: an address alone does not join
    await a.navigate(`${origin}/pokemonarena/battle.html?np=NOBODY&join=1&meet=1&net=local&anim=0`);
    await a.waitFor('window.__arenaOnline && window.__arenaOnline.state && document.getElementById("olGo")', { timeoutMs: 90000 });
    await sleep(1500);
    const st = await a.eval('({ stage: window.__arenaOnline.state.stage, go: document.getElementById("olGo").textContent })');
    if (want('CB11')) ok(st.stage === 'setup' && /Join the battle/.test(st.go), 'CB11a a join address with meet=1 but no token from the Center is the ordinary invite page: nothing is pressed for the player', J(st));
    await a.navigate(U('Alice', '0371a52'));
    await walkIn(a);
    const b = await a.openTab({ width: 1000, height: 900 });
    await b.navigate(U('Bob', '4192305'));
    await walkIn(b);
    await b.waitFor('window.__arenaCenter.people().some((p) => p.name === "Alice" && p.battle === "challenge")', { timeoutMs: 90000 });
    const alice = (await people(b)).find((p) => p.name === 'Alice');
    await b.eval(`window.__arenaCenter.talk(${J(alice.id)})`);
    await b.waitFor('window.__arenaCenter.dialog === "talk"', { timeoutMs: 20000 });
    await b.eval('document.getElementById("ctrBattle").click()');
    await a.waitFor('(() => { const d = document.getElementById("challenge"); return !!d && !d.hidden; })()', { timeoutMs: 20000 });
    await sleep(800);
    await a.eval('document.getElementById("chAccept").click()');
    await a.waitFor('location.pathname === "/pokemonarena/battle.html"', { timeoutMs: 30000 });
    await b.waitFor('location.pathname === "/pokemonarena/battle.html"', { timeoutMs: 30000 });
    const bu = new URL(await b.eval('location.href'));
    let p1 = null, p2 = null;
    for (let i = 0; i < 480; i++) { p1 = await phase(a); p2 = await phase(b); if (p1 === 'playing' && p2 === 'playing') break; await sleep(250); }
    if (want('CB10')) {
      ok(bu.searchParams.get('meet') === null || bu.searchParams.get('join') === '1', 'CB10a the challenger is taken to the battle page as the one who joins', bu.search);
      ok(p1 === 'playing' && p2 === 'playing', 'CB10b Accept in the Center: the battle starts on both screens, and the challenger did not have to press Join', J([p1, p2]));
      const roles = [await a.eval('window.__arenaOnline.state.role'), await b.eval('window.__arenaOnline.state.role')];
      ok(roles[0] === 'host' && roles[1] === 'guest', 'CB10c the one who accepted hosts, the one who asked joins', J(roles));
      ok((await b.eval('sessionStorage.getItem("arena.meet")')) === null, 'CB10d the meet token was used up', '');
      ok(!a.errors.length && !b.errors.length, 'CB10e no page errors', J(a.errors.concat(b.errors)).slice(0, 300));
    }
    await shot(b, 'cb_battle');
  });

  // ---- a phone
  if (want('CB12')) await withBrowser({ port: cdp + 2, width: 390, height: 844, mobile: true, lock: false, args: NO_THROTTLE }, async (p) => {
    await p.navigate(U('Casey', '0371a52'));
    await walkIn(p);
    await sleep(800);
    const L = await p.eval('(() => { const c = document.getElementById("center").getBoundingClientRect(), h = document.getElementById("ctrHint"), bar = document.getElementById("ctrBar").getBoundingClientRect(); return { sw: document.documentElement.scrollWidth, vw: innerWidth, cw: c.width, ch: c.height, hint: h.textContent, hintTop: h.getBoundingClientRect().top, cBottom: c.bottom, barBottom: bar.bottom, vh: innerHeight, pad: document.body.dataset.pad }; })()');
    ok(L.sw <= L.vw && L.cw >= 360 && L.pad === 'on', 'CB12a on a phone the room runs edge to edge with the touch pad, and nothing scrolls sideways', J(L));
    ok(L.hint.length > 5 && L.hintTop >= L.cBottom - 1 && L.barBottom <= L.vh, 'CB12b what A does is a line right under the picture, and the buttons fit on the screen', J(L));
    // a tap on the wardrobe walks there and opens the look editor
    await p.eval('(() => { const c = document.getElementById("center").getBoundingClientRect(); const x = c.left + (4.5 * 16) * c.width / 240, y = c.top + (0.9 * 16) * c.height / 160; const t = (type) => c && document.getElementById("center").dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, bubbles: true, pointerType: "touch", pointerId: 7, isPrimary: true, button: 0, buttons: type === "pointerdown" ? 1 : 0 })); t("pointerdown"); t("pointerup"); })()');
    await p.waitFor('window.__arenaCenter.dialog === "look"', { timeoutMs: 15000 }).catch(() => {});
    ok((await p.eval('window.__arenaCenter.dialog')) === 'look', 'CB12c tapping the wardrobe walks there and opens Your look', await p.eval('JSON.stringify([window.__arenaCenter.dialog, window.__arenaCenter.me])'));
    await shot(p, 'cb_phone_look');
    const fits = await p.eval('(() => { const d = document.querySelector("#ctrDlg .dlg").getBoundingClientRect(); return d.right <= innerWidth && d.left >= 0 && document.documentElement.scrollWidth <= innerWidth; })()');
    ok(fits, 'CB12d the look editor fits a phone', '');
    ok(!p.errors.length, 'CB12e no page errors', J(p.errors).slice(0, 300));
  });
}

// Browser mutants: one defect in the page glue at a time, served over the real files; each must fail its case.
const BROWSER_MUTANTS = [
  { id: 'BM1', file: '/pokemonarena/js/center_boot.js', from: "  if (wasIn || isOpen(ls)) enter(); else showOutside();", to: "  enter();", fails: 'CB1' },
  { id: 'BM2', file: '/pokemonarena/js/center_boot.js', from: "      const g = w.b && !linked.has(w.b) ? board.find((x) => x.s === w.b) || null : null;", to: "      const g = null;", fails: 'CB2c' },
  { id: 'BM3', file: '/pokemonarena/js/online.js', from: "    else if (meetTok && state.role === 'guest' && state.room) { meetTok = false; startAs('guest'); }\n", to: "    else if (query.meet && state.role === 'guest' && state.room) { startAs('guest'); }\n", fails: 'CB11' },
  { id: 'BM4', file: '/pokemonarena/js/center_boot.js', from: "  window.addEventListener('pagehide', () => { if (S.center) { S.center.close(); S.center = null; } });", to: "", fails: 'CB8a', also: "    leaveQuietly();\n    if (S.presence) { try { S.presence.dispose(); } catch (_e) { /* ignore */ } S.presence = null; }\n    location.href = hubUrl;", alsoTo: "    if (S.presence) { try { S.presence.dispose(); } catch (_e) { /* ignore */ } S.presence = null; }\n    location.href = hubUrl;" },
  { id: 'BM5', file: '/pokemonarena/js/center_boot.js', from: "    else if (a.use) use(a.use);", to: "", fails: 'CB12c' },
];
async function runBrowserMutants() {
  let killed = 0;
  for (const [i, m] of BROWSER_MUTANTS.entries()) {
    if (process.env.CENTER_MUT && process.env.CENTER_MUT !== m.id) continue;
    let body = fs.readFileSync(path.join(root, m.file), 'utf8').replace(/\r\n/g, '\n');
    const n = body.split(m.from).length - 1;
    if (n !== 1) { console.log('MUTANT', m.id, 'snippet occurs', n, 'times'); continue; }
    body = body.replace(m.from, () => m.to);
    if (m.also) { if (body.split(m.also).length - 1 !== 1) { console.log('MUTANT', m.id, 'second snippet not found once'); continue; } body = body.replace(m.also, () => m.alsoTo); }
    const port = PORT + 20 + i;
    const srv = await overlay(port, PORT, { [m.file]: body });
    const before = failures.length;
    pass = 0; fail = 0;
    try { await browserCases(`http://localhost:${port}`, CDP0 + 10 + i * 4, [m.fails]); } catch (e) { failures.push(m.fails + ' threw ' + e.message); }
    const hit = failures.slice(before).some((f) => f.startsWith(m.fails));
    failures.length = before;
    srv.close();
    if (hit) killed++; else console.log('MUTANT SURVIVED', m.id, '(expected', m.fails, 'to fail)');
  }
  console.log('browser mutants killed', killed + '/' + BROWSER_MUTANTS.length);
  return killed === BROWSER_MUTANTS.length;
}

/* ================================================================================================ main */
const nodeFailed = await runNode(path.join(root, 'pokemonarena', 'js'), true);
console.log('node checks:', nodeFailed.length ? nodeFailed.length + ' failed' : 'all passed');
let mutOk = true;
if (MUTANTS) mutOk = await runNodeMutants();
let browserOk = true;
if (!NODE_ONLY) {
  if (!ORIGIN) await startServer(PORT);
  try {
    if (!PAGE_MUTANTS_ONLY) await browserCases(ORIGIN || `http://localhost:${PORT}`, CDP0, null);
    console.log(`browser cases: ${pass} passed, ${fail} failed`);
    browserOk = fail === 0;
    if (MUTANTS && !ORIGIN) { const real = failures.length; const bm = await runBrowserMutants(); mutOk = mutOk && bm; failures.length = real; }
  } finally { if (server) server.kill(); }
}
if (failures.length) console.log('failures:\n  ' + failures.join('\n  '));
process.exit(nodeFailed.length || !browserOk || !mutOk ? 1 : 0);

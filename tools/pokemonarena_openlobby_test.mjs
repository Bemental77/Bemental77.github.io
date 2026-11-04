// tools/pokemonarena_openlobby_test.mjs -- the OPEN GAMES board (pokemonarena/js/openlobby.js), in Node: no browser, no network, no real clock.
//
//   node tools/pokemonarena_openlobby_test.mjs             the cases
//   node tools/pokemonarena_openlobby_test.mjs --mutants   ALSO break openlobby.js one way at a time; every break must fail a case (the suite is not vacuous)
//
// What is proved here: a message from the board is never trusted (shape, text, size, rate); a game is on the board only while its beacons keep arriving; one sender keeps one room; the
// board is capped; leaving takes a game down at once and only the lister can; an ask is answered once per gap however hard it is hammered; two players who both opened a game agree
// WHICH ONE stays; the brokers' extra copies, retained messages, other topics and half-open sockets cannot put a wrong thing on the board. The page half (the panel, the join, a real
// match) is tools/pokemonarena_online_page_test.mjs, group `open`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const SRC = path.join(root, 'pokemonarena', 'js');
const WANT_MUTANTS = process.argv.includes('--mutants');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, detail) { if (cond) pass++; else { fail++; failures.push(name + (detail ? ' :: ' + detail : '')); if (!process.env.ARENA_QUIET) console.log('FAIL', name, detail || ''); } }
const J = (x) => JSON.stringify(x);

/* ------------------------------------------------------------------------------------------------ doubles */
function makeClock() {
  let t = 0, seq = 0;
  const jobs = new Map();
  const timers = {
    setTimeout(fn, ms) { const id = ++seq; jobs.set(id, { at: t + ms, fn, every: 0 }); return id; },
    setInterval(fn, ms) { const id = ++seq; jobs.set(id, { at: t + ms, fn, every: ms }); return id; },
    clearTimeout(id) { jobs.delete(id); }, clearInterval(id) { jobs.delete(id); },
  };
  const advance = (ms) => {
    const end = t + ms;
    for (;;) {
      let next = null;
      for (const [id, j] of jobs) if (j.at <= end && (!next || j.at < next.j.at)) next = { id, j };
      if (!next) break;
      t = next.j.at;
      if (next.j.every) next.j.at += next.j.every; else jobs.delete(next.id);
      next.j.fn();
    }
    t = end;
  };
  return { now: () => t, timers, advance, count: () => jobs.size };
}
const rng = (seed) => { let x = seed >>> 0; return (n) => { const a = new Uint8Array(n); for (let i = 0; i < n; i++) { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; a[i] = x >>> 24; } return a; }; };
// a shared medium: every bus on it hears what the others send (synchronously); echo = the broker returns a sender its own message too
function makeHub({ echo = false } = {}) {
  const members = new Set();
  return {
    join() {
      const m = { cb: null, stCb: null, sent: [], status: 'up', closed: false };
      m.bus = {
        send(o) { if (m.closed) return; m.sent.push(o); for (const x of members) if ((x !== m || echo) && x.cb && !x.closed) x.cb(JSON.parse(JSON.stringify(o))); },
        onMessage(f) { m.cb = f; }, onStatus(f) { m.stCb = f; }, status: () => m.status, close() { m.closed = true; members.delete(m); },
      };
      m.setStatus = (s) => { m.status = s; if (m.stCb) m.stCb(s); };
      members.add(m);
      return m;
    },
    inject(o) { for (const x of members) if (x.cb && !x.closed) x.cb(o); },
  };
}

const ROM = 'a'.repeat(64), ROM2 = 'b'.repeat(64);
const FP = 'e1.abc', RS = 'gen3-standard';
const beacon = (over = {}) => ({ t: 'arenaopen', v: 1, k: 'open', s: '0123456789abcdef', room: 'ABCDE', name: 'Alice', fmt: '3v3', rom: ROM, fp: FP, rs: RS, q: 0, ...over });
// shapes only (checkBeacon never does the maths): a one-time P-256 public key 'x.y', an AES-GCM iv, and a sealed room (4..8 characters + the 16-byte tag, base64url)
const PK = 'A'.repeat(43) + '.' + 'B'.repeat(43), IV = 'I'.repeat(16), CT = 'C'.repeat(32);
const info = (over = {}) => ({ room: 'AQ111', name: 'Host', fmt: '3v3', rom: ROM, fp: FP, rs: RS, q: false, ...over });

/* ------------------------------------------------------------------------------------------------ the cases */
async function suite(M, tag) {
  const T = (s) => (tag ? '[' + tag + '] ' : '') + s;

  /* A. a message from the board is never trusted */
  {
    const good = M.checkBeacon(beacon());
    ok(good.ok && good.b.room === 'ABCDE' && good.b.name === 'Alice' && good.b.fmt === '3v3' && good.b.q === 0, T('A1 a well-formed beacon is accepted and normalised'), J(good));
    ok(M.checkBeacon(beacon({ room: 'abcde' })).b.room === 'ABCDE', T('A2 the room code is upper-cased'), '');
    const hostile = M.checkBeacon(beacon({ name: '<img src=x onerror=alert(1)>Bob‮\u0000' }));
    ok(hostile.ok && /^[A-Za-z0-9 .'_!?-]{1,10}$/.test(hostile.b.name), T('A3 a hostile name is reduced to safe text, at most 10 characters (the same cleanName the match uses)'), J(hostile));
    ok(M.checkBeacon(beacon({ name: '!!' })).ok && M.checkBeacon(beacon({ name: '☃☃' })).b.name === 'Player', T('A4 a name with nothing safe in it becomes the stand-in'), '');
    const rejects = [
      ['null', null], ['an array', []], ['a string', 'x'], ['a number', 7],
      ['wrong type', beacon({ t: 'lsarena' })], ['wrong version', beacon({ v: 2 })], ['no sender', beacon({ s: undefined })], ['a short sender', beacon({ s: 'abcd' })], ['an upper-case sender', beacon({ s: '0123456789ABCDEF' })],
      ['unknown kind', beacon({ k: 'steal' })], ['room too short', beacon({ room: 'ABC' })], ['room too long', beacon({ room: 'ABCDEFGHI' })], ['room with symbols', beacon({ room: 'AB-DE' })], ['room a number', beacon({ room: 12345 })],
      ['no name', beacon({ name: undefined })], ['empty name', beacon({ name: '' })], ['a 41-character name', beacon({ name: 'x'.repeat(41) })],
      ['format 4v4', beacon({ fmt: '4v4' })], ['no format', beacon({ fmt: undefined })], ['short rom', beacon({ rom: 'a'.repeat(63) })], ['non-hex rom', beacon({ rom: 'z'.repeat(64) })],
      ['no fingerprint', beacon({ fp: '' })], ['a 65-character fingerprint', beacon({ fp: 'f'.repeat(65) })], ['no ruleset', beacon({ rs: undefined })], ['quick flag 2', beacon({ q: 2 })], ['quick flag a string', beacon({ q: '1' })],
      ['gone without a room', beacon({ k: 'gone', room: undefined })],
    ];
    const accepted = rejects.filter(([, m]) => M.checkBeacon(m).ok).map(([n]) => n);
    ok(accepted.length === 0, T('A5 every malformed beacon is refused (' + rejects.length + ' kinds)'), accepted.join(', '));
    ok(M.checkBeacon({ t: 'arenaopen', v: 1, k: 'ask', s: '0123456789abcdef' }).ok && M.checkBeacon({ t: 'arenaopen', v: 1, k: 'gone', s: '0123456789abcdef', room: 'ABCDE' }).ok, T('A6 an ask and a gone need no more than they use'), '');
    const extra = M.checkBeacon(beacon({ evil: 'x', __proto__: { polluted: 1 }, constructor: 'y' }));
    ok(extra.ok && !('evil' in extra.b) && !({}).polluted, T('A7 fields the board does not define are not carried through'), J(extra));
    const withRec = M.checkBeacon(beacon({ rec: [12, 5] }));
    ok(withRec.ok && J(withRec.b.rec) === '[12,5]' && M.checkBeacon(beacon()).b.rec === null && M.checkBeacon(beacon({ rec: null })).b.rec === null, T('A9 a trainer record [wins, losses] is carried, and is optional'), J(withRec));
    const badRecs = [[1], [1, 2, 3], ['1', 2], [-1, 0], [1.5, 2], [1000000, 0], 'x', {}, [null, 1]].filter((r) => M.checkBeacon(beacon({ rec: r })).ok);
    ok(badRecs.length === 0, T('A10 a malformed record is refused'), J(badRecs));
    const q1 = M.checkBeacon(beacon({ q: 1 }));
    ok(q1.ok && q1.b.q === 1 && M.checkBeacon(beacon({ q: undefined })).b.q === 0, T('A8 the quick flag is 0 or 1'), '');
  }

  /* B. the directory */
  {
    const c = makeClock();
    const d = M.createDirectory({ now: c.now });
    const b1 = M.checkBeacon(beacon({ room: 'AAAAA', s: '1111111111111111' })).b;
    ok(d.hear(b1) === true && d.size() === 1, T('B1 a new game is a change'), '');
    ok(d.hear(b1) === false, T('B2 the same beacon again is not a change'), '');
    c.advance(12000);
    ok(d.hear(b1) === true && d.list({ rom: ROM, fp: FP }).length === 1, T('B3 a beacon every few seconds keeps a game on the board past the ttl (this one is also the first repeat a beacon interval on, which CONFIRMS the game: a change, see B22)'), '');
    ok(d.hear(b1) === false, T('B3a ... and the next repeat is not a change'), '');
    c.advance(12000);
    ok(d.list({ rom: ROM, fp: FP }).length === 1, T('B3b ... as long as they keep coming'), '');
    c.advance(13001);
    ok(d.list({ rom: ROM, fp: FP }).length === 0 && d.size() === 0, T('B4 a game whose beacons stopped falls off the board after the ttl'), String(d.size()));
    d.hear(b1);
    c.advance(13001);
    ok(d.prune() === true && d.prune() === false, T('B5 prune says whether anything fell off, once'), '');
    // a second sender cannot take over a room
    d.hear(b1);
    const hijack = M.checkBeacon(beacon({ room: 'AAAAA', s: '2222222222222222', name: 'Mallory' })).b;
    ok(d.hear(hijack) === false && d.list({ rom: ROM, fp: FP })[0].name === 'Alice', T('B6 the first sender keeps the room: a second sender claiming it changes nothing'), J(d.list({ rom: ROM, fp: FP })));
    const rename = M.checkBeacon(beacon({ room: 'AAAAA', s: '1111111111111111', name: 'Alicia' })).b;
    ok(d.hear(rename) === true && d.list({ rom: ROM, fp: FP })[0].name === 'Alicia', T('B7 the same sender may change its own listing'), '');
    // gone: only the lister
    ok(d.gone('AAAAA', '2222222222222222') === false && d.size() === 1, T('B8 a stranger cannot take a game down'), '');
    ok(d.gone('AAAAA', '1111111111111111') === true && d.size() === 0, T('B9 the lister can'), '');
    // the cap
    const many = M.createDirectory({ now: c.now, max: 24 });
    for (let i = 0; i < 40; i++) many.hear(M.checkBeacon(beacon({ room: 'R' + String(1000 + i), s: ('0000000000000000' + i.toString(16)).slice(-16) })).b);
    ok(many.size() === 24, T('B10 the board holds at most 24 games however many beacons arrive'), String(many.size()));
    c.advance(14000);
    ok(many.hear(M.checkBeacon(beacon({ room: 'RNEWR', s: 'f'.repeat(16) })).b) === true && many.size() === 1, T('B11 old games free their places'), String(many.size()));
    // ONE SENDER KEEPS ONE ROOM (the header's claim): a second room from the same sender replaces its first, so one sender cannot fill the board, and a relisted game does not stand twice
    {
      const sc = M.createDirectory({ now: c.now }), as = (room, s) => sc.hear(M.checkBeacon(beacon({ room, s })).b);
      const E = 'e'.repeat(16), F = 'f'.repeat(16);
      as('SROO1', E);
      ok(as('SROO2', E) === true && sc.list({ rom: ROM, fp: FP }).map((g) => g.room).join() === 'SROO2', T('B16 a sender that lists a second room takes its first one down (and that is a change)'), J(sc.list({ rom: ROM, fp: FP }).map((g) => g.room)));
      as('SROO3', F);
      ok(sc.list({ rom: ROM, fp: FP }).map((g) => g.room).sort().join() === 'SROO2,SROO3', T('B17 and another sender\'s room is not touched'), J(sc.list({ rom: ROM, fp: FP }).map((g) => g.room)));
      const flood = M.createDirectory({ now: c.now });
      for (let i = 0; i < 40; i++) flood.hear(M.checkBeacon(beacon({ room: 'FL' + String(1000 + i), s: 'd'.repeat(16) })).b);
      ok(flood.size() === 1, T('B18 forty rooms from ONE sender leave one on the board'), String(flood.size()));
      const full = M.createDirectory({ now: c.now, max: 2 });
      full.hear(M.checkBeacon(beacon({ room: 'FULL1', s: '1'.repeat(16) })).b); full.hear(M.checkBeacon(beacon({ room: 'FULL2', s: '2'.repeat(16) })).b);
      ok(full.hear(M.checkBeacon(beacon({ room: 'FULL3', s: '1'.repeat(16) })).b) === true && full.list().map((g) => g.room).sort().join() === 'FULL2,FULL3', T('B19 a full board still takes a sender\'s NEW room in place of its old one'), J(full.list().map((g) => g.room)));
    }
    // CONFIRMED: a listing heard once is not evidence of a game (anyone can publish it); the same listing a beacon interval later is. A listing that changes starts again.
    {
      const cc = makeClock(), dd = M.createDirectory({ now: cc.now });
      const b1 = M.checkBeacon(beacon({ room: 'QAAAA', s: 'a'.repeat(16), q: 1 })).b;
      const conf = () => dd.list({ rom: ROM, fp: FP })[0].confirmed;
      dd.hear(b1);
      ok(conf() === false && dd.hear(b1) === false && conf() === false, T('B20 a listing heard once (or twice in the same instant) is not confirmed'), String(conf()));
      cc.advance(3000);
      ok(dd.hear(b1) === false && conf() === false, T('B21 heard again inside a beacon interval it is still not confirmed, and that is not a change'), String(conf()));
      cc.advance(1000);
      ok(dd.hear(b1) === true && conf() === true, T('B22 a beacon interval after it started, it is confirmed, and that IS a change (the page looks at the board again)'), String(conf()));
      ok(dd.hear(b1) === false && conf() === true, T('B23 and a repeat afterwards is not a change'), '');
      ok(dd.hear({ ...b1, name: 'Mallory' }) === true && conf() === false, T('B24 a listing that CHANGES (here: another name) starts again: it is not confirmed'), String(conf()));
      cc.advance(4000);
      dd.hear({ ...b1, name: 'Mallory' });
      ok(conf() === true, T('B25 ... and is confirmed again one interval later'), String(conf()));
    }
    // order, compatibility, mute
    const o = M.createDirectory({ now: c.now });
    o.hear(M.checkBeacon(beacon({ room: 'ZZZZZ', s: '1'.repeat(16) })).b); c.advance(500);
    o.hear(M.checkBeacon(beacon({ room: 'AAAAB', s: '2'.repeat(16), rom: ROM2 })).b); c.advance(500);
    o.hear(M.checkBeacon(beacon({ room: 'AAAAA', s: '3'.repeat(16), fp: 'other' })).b);
    const l = o.list({ rom: ROM, fp: FP });
    ok(l.map((g) => g.room).join() === 'ZZZZZ,AAAAB,AAAAA', T('B12 the game that has waited longest is first'), l.map((g) => g.room).join());
    ok(l.map((g) => g.compatible).join() === 'true,false,false', T('B13 a game on another ROM or another engine build is marked not compatible'), l.map((g) => g.compatible).join());
    o.mute('zzzzz', 5000);
    ok(o.list({ rom: ROM, fp: FP }).every((g) => g.room !== 'ZZZZZ') && o.hear(M.checkBeacon(beacon({ room: 'ZZZZZ', s: '1'.repeat(16) })).b) === false, T('B14 a muted game stays off the board, even if it keeps announcing itself'), '');
    c.advance(5001);
    ok(o.hear(M.checkBeacon(beacon({ room: 'ZZZZZ', s: '1'.repeat(16) })).b) === true, T('B15 ... until the mute runs out'), '');
  }

  /* C. the lobbies: two browsers, one medium, a clock we step by hand */
  {
    const c = makeClock(), hub = makeHub();
    const A = hub.join(), B = hub.join();
    const la = M.createOpenLobbies({ bus: A.bus, now: c.now, mine: { rom: ROM, fp: FP }, timers: c.timers, random: rng(1) });
    const lb = M.createOpenLobbies({ bus: B.bus, now: c.now, mine: { rom: ROM, fp: FP }, timers: c.timers, random: rng(2) });
    ok(la.sid !== lb.sid && /^[0-9a-f]{16}$/.test(la.sid), T('C0 each browser has its own 16-hex sender id'), la.sid + ' ' + lb.sid);
    let changes = 0; lb.watch(() => { changes++; });
    la.host(info());
    ok(lb.list().length === 1 && lb.list()[0].room === 'AQ111' && lb.list()[0].name === 'Host' && lb.list()[0].compatible, T('C1 listing a game puts it on the other browser\'s board'), J(lb.list()));
    ok(changes === 1, T('C2 and the watcher is told once'), String(changes));
    ok(la.list().length === 0, T('C3 a browser never sees its own game on its board'), J(la.list()));
    const sentBefore = A.sent.length;
    c.advance(12000);
    ok(A.sent.length - sentBefore === 3 && A.sent.slice(sentBefore).every((m) => m.k === 'open'), T('C4 a listed game repeats its beacon every 4 s (3 in 12 s)'), String(A.sent.length - sentBefore));
    ok(lb.list().length === 1 && changes === 2, T('C5 and the repeats are not changes, except the one a beacon interval after the game appeared, which confirms it (two changes in 12 s, not four)'), String(changes));
    la.unhost();
    ok(A.sent[A.sent.length - 1].k === 'gone' && lb.list().length === 0, T('C6 taking the game down says so, and the other board drops it at once'), J(A.sent[A.sent.length - 1]));
    const nBefore = A.sent.length; c.advance(20000);
    ok(A.sent.length === nBefore && c.count() === 0, T('C7 and nothing keeps announcing it (no timer left)'), A.sent.length - nBefore + ' sent, ' + c.count() + ' timers');
    ok(la.unhost() === false, T('C8 taking down a game that is not listed is a no-op'), '');
    la.unhost(); la.host(info({ rec: [7, 3] }));
    ok(J(lb.list()[0].rec) === '[7,3]', T('C3b a listed game carries the trainer record to the other board'), J(lb.list()));
    la.unhost(); la.host(info());
    ok(lb.list()[0].rec === null, T('C3c ... and none when there is none'), J(lb.list()));
    la.unhost();

    // listing is checked the way the receivers will check it
    let threw = 0;
    for (const bad of [info({ fmt: '9v9' }), info({ room: 'x' }), info({ rom: 'nope' }), info({ fp: '' }), null]) { try { la.host(bad); } catch (e) { if (e instanceof RangeError) threw++; } }
    ok(threw === 5 && la.hosting() === null, T('C9 a listing the board would reject is refused at the source, loudly'), String(threw));

    // watching: periodic asks, ageing
    const w0 = B.sent.length;
    lb.startWatching(); lb.startWatching();
    ok(B.sent.length - w0 === 1 && B.sent[B.sent.length - 1].k === 'ask', T('C13 looking asks at once (and starting twice does not ask twice)'), String(B.sent.length - w0));
    c.advance(14000);
    ok(B.sent.length - w0 === 3, T('C14 ... and again every 7 s'), String(B.sent.length - w0));
    lb.stopWatching();
    const w1 = B.sent.length; c.advance(30000);
    ok(B.sent.length === w1, T('C15 stopping stops it'), '');
    // ageing emits
    la.host(info({ room: 'AQ333' })); la.unhost(); c.advance(0);
    lb.dir.hear(M.checkBeacon(beacon({ room: 'AQ444', s: '9'.repeat(16) })).b);
    let aged = 0; const un = lb.watch(() => { aged++; }); lb.startWatching();
    c.advance(14000);
    ok(lb.list().every((g) => g.room !== 'AQ444') && aged >= 1, T('C16 a game whose beacons stopped drops off the board and the page is told'), String(aged));
    un(); lb.stopWatching();

    // junk
    const lc = hub.join(); lc.bus = lc.bus;
    // the cap is lifted here so that ONLY the rate limit can hold a flood back
    const lj = M.createOpenLobbies({ bus: lc.bus, now: c.now, mine: { rom: ROM, fp: FP }, timers: c.timers, random: rng(3), timing: { ...M.TIMING, maxListed: 100000 } });
    const junk = ['x', 7, null, undefined, [], {}, { t: 'arenaopen' }, 'x'.repeat(5000), { t: 'arenaopen', v: 1, k: 'open', s: 'q' }, beacon({ rom: 'x' })];
    let threwJunk = false;
    try { for (const m of junk) hub.inject(m); } catch (_e) { threwJunk = true; }
    ok(!threwJunk && lj.list().length === 0, T('C17 junk on the board is dropped without a sound'), J(lj.list()));
    // rate limit: a flood in one window, then calm
    c.advance(2500);        // the junk above shares a window with whatever follows it: start the flood in a fresh one
    for (let i = 0; i < 200; i++) hub.inject(beacon({ room: 'F' + String(1000 + i), s: ('0000000000000000' + i.toString(16)).slice(-16) }));
    ok(lj.list().length === 80, T('C18 a flood is cut off after exactly 80 messages in a window'), String(lj.list().length));
    c.advance(2500);
    const sizeBefore = lj.list().length;
    hub.inject(beacon({ room: 'CALMM', s: 'c'.repeat(16) }));
    ok(lj.list().length === sizeBefore + 1, T('C19 and the next window is heard again'), sizeBefore + ' -> ' + lj.list().length);
    lj.close();

    // my own message coming back from the broker
    const echo = makeHub({ echo: true }), E = echo.join();
    const le = M.createOpenLobbies({ bus: E.bus, now: c.now, mine: { rom: ROM, fp: FP }, timers: c.timers, random: rng(4) });
    le.host(info({ room: 'AQ555' }));
    ok(le.list().length === 0, T('C20 a broker that echoes my own beacon back does not put my game on my board'), J(le.list()));
    le.close();

    // a status change is news
    let st = 0; const lw = M.createOpenLobbies({ bus: B.bus, now: c.now, mine: { rom: ROM, fp: FP }, timers: c.timers, random: rng(5) });
    lw.watch(() => { st++; }); B.setStatus('connecting'); B.setStatus('up');
    ok(st === 2 && lw.status() === 'up', T('C21 a connection change reaches the page'), String(st));
    lw.close();
  }

  /* C2. ask and answer, with the periodic beacon switched off so only the answers are counted */
  {
    const c = makeClock(), hub = makeHub();
    const A = hub.join(), B = hub.join();
    const quiet = { ...M.TIMING, beaconMs: 1e9 };
    const la = M.createOpenLobbies({ bus: A.bus, now: c.now, mine: { rom: ROM, fp: FP }, timers: c.timers, random: rng(1), timing: quiet });
    const lb = M.createOpenLobbies({ bus: B.bus, now: c.now, mine: { rom: ROM, fp: FP }, timers: c.timers, random: rng(2), timing: quiet });
    la.host(info({ room: 'AQ222' }));
    lb.dir.gone('AQ222', la.sid);
    const before = A.sent.length;
    lb.refresh();
    c.advance(1000);
    ok(A.sent.length - before === 1 && A.sent[A.sent.length - 1].k === 'open' && lb.list().length === 1, T('C10 an ask is answered by a listed game within a second (the jitter), and the asker sees it'), String(A.sent.length - before));
    const b2 = A.sent.length;
    c.advance(2000);
    for (let i = 0; i < 100; i++) lb.refresh();
    c.advance(1000);
    ok(A.sent.length - b2 === 1, T('C11 a hundred asks in a row are answered once (an ask loop cannot become a flood)'), String(A.sent.length - b2));
    // asks SPREAD over time: the second comes after the first was answered but inside the gap, and must not be answered
    c.advance(2000); const b2a = A.sent.length; lb.refresh(); c.advance(600); lb.refresh(); c.advance(600);
    ok(A.sent.length - b2a === 1, T('C11b an ask that follows an answered ask inside the 1.5 s gap is not answered'), String(A.sent.length - b2a));
    c.advance(2000); const b3 = A.sent.length; lb.refresh(); c.advance(1000);
    ok(A.sent.length - b3 === 1, T('C12 ... and the next ask, after the gap, is answered'), String(A.sent.length - b3));
    la.close(); lb.close();
  }

  /* G. directed messages (a challenge and its answers) and resident games */
  {
    const S1 = '1'.repeat(16), S2 = '2'.repeat(16), R = '3'.repeat(16);
    const dm = (k, over = {}) => ({ t: 'arenaopen', v: 1, k, s: S1, to: S2, r: R, ...(k === 'chal' ? { pk: PK } : {}), ...(k === 'acc' ? { pk: PK, iv: IV, ct: CT } : {}), ...over });
    const chal = M.checkBeacon(dm('chal', { name: 'Alice', rec: [12, 5] }));
    ok(chal.ok && chal.b.k === 'chal' && chal.b.to === S2 && chal.b.r === R && chal.b.name === 'Alice' && J(chal.b.rec) === '[12,5]' && chal.b.pk === PK, T('G1 a challenge names who it is for, which request it is, who is asking, their record and the one-time key the room will be sealed to'), J(chal));
    ok(M.checkBeacon(dm('chal', { name: 'Al' })).b.rec === null, T('G2 the record in a challenge is optional'), '');
    ok(/^[A-Za-z0-9 .'_!?-]{1,10}$/.test(M.checkBeacon(dm('chal', { name: '<script>alert(1)</script>' })).b.name), T('G3 a hostile name in a challenge is reduced to safe text'), '');
    ok(M.checkBeacon(dm('can')).ok && M.checkBeacon(dm('ok')).ok && M.checkBeacon(dm('dec', { why: 'declined' })).ok && M.checkBeacon(dm('dec', { why: 'busy' })).ok, T('G4 cancel, accepted and declined need no more than they use'), '');
    const acc = M.checkBeacon(dm('acc'));
    ok(acc.ok && acc.b.pk === PK && acc.b.iv === IV && acc.b.ct === CT && !('room' in acc.b), T('G5 an accepted challenge carries the room SEALED (the owner\'s one-time key, the iv, the ciphertext) and no room'), J(acc));
    ok(!M.checkBeacon(dm('acc', { room: 'abc12', pk: undefined, iv: undefined, ct: undefined })).ok, T('G5b a "come in" that names the room in the clear and seals nothing is not one'), '');
    const both = M.checkBeacon(dm('acc', { room: 'abc12' }));
    ok(both.ok && !('room' in both.b) && !J(both.b).toLowerCase().includes('abc12'), T('G5c a clear room sent beside the sealed one is dropped, never passed on to a listener'), J(both));
    const badDirected = [
      ['no recipient', dm('chal', { name: 'A', to: undefined })], ['a recipient that is not an id', dm('chal', { name: 'A', to: 'bob' })], ['no request id', dm('chal', { name: 'A', r: undefined })], ['a short request id', dm('ok', { r: 'abc' })],
      ['a challenge with no name', dm('chal')], ['a challenge with an empty name', dm('chal', { name: '' })], ['a challenge with a bad record', dm('chal', { name: 'A', rec: [1] })],
      ['a challenge with no key', dm('chal', { name: 'A', pk: undefined })], ['a challenge with half a key', dm('chal', { name: 'A', pk: 'A'.repeat(43) })], ['a challenge with a short y', dm('chal', { name: 'A', pk: 'A'.repeat(43) + '.' + 'B'.repeat(42) })],
      ['a challenge with a key that is not base64url', dm('chal', { name: 'A', pk: 'A'.repeat(43) + '.' + '*'.repeat(43) })], ['a challenge with a key as an object', dm('chal', { name: 'A', pk: { x: 'A'.repeat(43), y: 'B'.repeat(43) } })],
      ['a decline with no reason', dm('dec')], ['a decline with an invented reason', dm('dec', { why: 'go away' })],
      ['an acceptance with no key', dm('acc', { pk: undefined })], ['an acceptance with a bad key', dm('acc', { pk: 'nope' })], ['an acceptance with no iv', dm('acc', { iv: undefined })], ['an acceptance with a short iv', dm('acc', { iv: 'I'.repeat(15) })],
      ['an acceptance with a long iv', dm('acc', { iv: 'I'.repeat(17) })], ['an acceptance with no sealed room', dm('acc', { ct: undefined })], ['an acceptance with a ciphertext too short to hold a tag', dm('acc', { ct: 'C'.repeat(26) })],
      ['an acceptance with a ciphertext too long for a room', dm('acc', { ct: 'C'.repeat(33) })], ['an acceptance with a ciphertext that is not base64url', dm('acc', { ct: '+'.repeat(30) })],
    ];
    const took = badDirected.filter(([, m]) => M.checkBeacon(m).ok).map(([n]) => n);
    ok(took.length === 0, T('G6 every malformed directed message is refused (' + badDirected.length + ' kinds)'), took.join(', '));
    ok(M.checkBeacon(beacon({ h: 1 })).b.h === 1 && M.checkBeacon(beacon()).b.h === 0 && !M.checkBeacon(beacon({ h: 2 })).ok && !M.checkBeacon(beacon({ h: '1' })).ok, T('G7 a resident game is flagged h:1 (0 when absent), and nothing else is a flag'), '');

    const c = makeClock(), hub = makeHub();
    const A = hub.join(), B = hub.join(), C = hub.join();
    const mk = (m, seed) => M.createOpenLobbies({ bus: m.bus, now: c.now, mine: { rom: ROM, fp: FP }, timers: c.timers, random: rng(seed) });
    const la = mk(A, 41), lb = mk(B, 42), lc = mk(C, 43);
    const gotB = [], gotC = [], gotA = [];
    lb.onSignal((m) => gotB.push(m)); lc.onSignal((m) => gotC.push(m)); la.onSignal((m) => gotA.push(m));
    const rq = la.newRequest();
    ok(/^[0-9a-f]{16}$/.test(rq) && rq !== la.newRequest(), T('G8 every request gets its own 16-hex id'), rq);
    la.signal('chal', { to: lb.sid, r: rq, name: 'Alice', rec: [3, 4], pk: PK });
    ok(gotB.length === 1 && gotB[0].k === 'chal' && gotB[0].s === la.sid && gotB[0].r === rq && gotB[0].name === 'Alice' && gotB[0].pk === PK, T('G9 a directed message reaches the one it is for, with the sender\'s id'), J(gotB));
    ok(gotC.length === 0 && gotA.length === 0, T('G10 and nobody else (not a bystander, not the sender)'), J([gotC, gotA]));
    ok(lb.list().length === 0 && lc.list().length === 0, T('G11 a directed message never puts anything on a board'), '');
    lb.signal('dec', { to: la.sid, r: rq, why: 'busy' });
    ok(gotA.length === 1 && gotA[0].k === 'dec' && gotA[0].why === 'busy', T('G12 the answer comes back the same way'), J(gotA));
    const sent0 = A.sent.length;
    let threw = 0;
    for (const [k, f] of [['chal', { to: 'nobody', r: rq, name: 'A', pk: PK }], ['dec', { to: lb.sid, r: rq }], ['open', { to: lb.sid, r: rq }], ['acc', { to: lb.sid, r: rq, room: 'ABCDE' }], ['chal', { to: lb.sid, r: rq, name: 'A' }]]) { try { la.signal(k, f); } catch (e) { if (e instanceof RangeError) threw++; } }
    ok(threw === 5 && A.sent.length === sent0, T('G13 a message the receivers would drop (or a kind that is not directed) is refused at the source, loudly, and nothing is sent'), threw + ' ' + (A.sent.length - sent0));
    const sent1 = A.sent.length;
    la.signal('acc', { to: lc.sid, r: rq, pk: PK, iv: IV, ct: CT, room: 'SECRT', extra: 'x' });
    const wire = A.sent[A.sent.length - 1];
    ok(A.sent.length === sent1 + 1 && !('room' in wire) && !('extra' in wire) && wire.ct === CT && wire.t === 'arenaopen' && wire.v === 1 && wire.s === la.sid, T('G13b only the fields the board defines go on the public bus: a stray field (a clear room) cannot ride along'), J(wire));
    const un = lb.onSignal(() => { throw new Error('a listener that breaks'); });
    const after = []; const un3 = lb.onSignal((m) => after.push(m));        // registered AFTER the one that throws
    let broke = false;
    try { la.signal('can', { to: lb.sid, r: rq }); } catch (_e) { broke = true; }
    ok(!broke && gotB.length === 2 && after.length === 1, T('G14 a listener that throws does not break the board or the listeners after it'), gotB.length + ' ' + after.length);
    un(); un3();
    // a message "from me" to me (a broker that echoes) is not a signal
    const echo = makeHub({ echo: true }), E = echo.join();
    const le = M.createOpenLobbies({ bus: E.bus, now: c.now, mine: { rom: ROM, fp: FP }, timers: c.timers, random: rng(44) });
    const gotE = []; le.onSignal((m) => gotE.push(m));
    le.signal('can', { to: le.sid, r: rq });
    ok(gotE.length === 0, T('G15 my own message coming back is not delivered to me'), String(gotE.length));
    // unsubscribe and close
    const un2 = lb.onSignal((m) => gotB.push(m)); un2();
    const n = gotB.length; la.signal('ok', { to: lb.sid, r: rq });
    ok(gotB.length === n + 1, T('G16 an unsubscribed listener hears nothing more (the first one still does)'), String(gotB.length - n));
    lb.close();
    la.signal('ok', { to: lb.sid, r: rq });
    ok(la.close() === undefined && la.signal('ok', { to: lb.sid, r: rq }) === false, T('G17 a closed board neither hears nor sends'), '');
    // a resident game is listed with its flag and is not a room
    const lr = mk(hub.join(), 45), lw = mk(hub.join(), 46);
    lr.host(info({ room: 'HAB12', h: true, name: 'Resident' }));
    ok(lw.list().length === 1 && lw.list()[0].h === 1 && lw.list()[0].s === lr.sid, T('G18 a resident game is on the board flagged h:1 and carries its owner\'s id (what a challenge is addressed to)'), J(lw.list()));
    lr.unhost(); lr.host(info({ room: 'AQ123' }));
    ok(lw.list().length === 1 && lw.list()[0].h === 0, T('G19 an ordinary game is not'), J(lw.list()));
    lr.close(); lw.close(); lc.close(); le.close();
  }

  /* D. two players press Find a battle together and both open a game: exactly one stays */
  {
    const c = makeClock(), hub = makeHub();
    const A = hub.join(), B = hub.join(), C = hub.join();
    const mk = (m, seed) => M.createOpenLobbies({ bus: m.bus, now: c.now, mine: { rom: ROM, fp: FP }, timers: c.timers, random: rng(seed) });
    const la = mk(A, 1), lb = mk(B, 2), lc = mk(C, 3);
    la.host(info({ room: 'AQ900', q: true })); lb.host(info({ room: 'AQ100', q: true }));
    ok(la.rival() === null && lb.rival() === null, T('D8 a rival that has been heard ONCE is nobody\'s rival yet (a single beacon can be made up by anyone)'), J([la.rival(), lb.rival()]));
    c.advance(4000);                       // both listings have now been heard a second time, a beacon interval after the first
    const ra = la.rival(), rb = lb.rival();
    ok(ra && ra.room === 'AQ100' && rb === null, T('D1 of two quick games the one with the larger room code joins the other, and the other stays'), J([ra && ra.room, rb && rb.room]));
    ok(!!ra !== !!rb, T('D2 exactly one of them defects (never both, never neither)'), J([!!ra, !!rb]));
    lc.host(info({ room: 'AQ500', q: false })); c.advance(4000);
    ok(lc.rival() === null && la.rival().room === 'AQ100', T('D3 a game that was not opened by Find a battle is nobody\'s rival'), '');
    ok(la.rival((g) => g.room !== 'AQ100') === null, T('D4 a game the player\'s team cannot play (the page\'s own check) is not a rival either'), '');
    lb.unhost(); lb.host(info({ room: 'AQ100', q: true, fp: 'other-build' })); c.advance(4000);
    ok(la.rival() === null && la.list().some((g) => g.room === 'AQ100' && g.confirmed), T('D5 a game on another engine build is not a rival (it was heard long enough: only the build rules it out)'), J(la.list().map((g) => [g.room, g.confirmed, g.compatible])));
    la.startWatching(); lb.startWatching();
    ok(c.count() > 0, T('D6a (a board that is looking and listing has timers running)'), String(c.count()));
    const asks0 = A.sent.length;
    la.close(); lb.close(); lc.close();
    c.advance(60000);
    ok(c.count() === 0 && A.sent.length - asks0 <= 1, T('D6 closing a board that was looking and listing leaves no timer behind and sends nothing more (at most the goodbye)'), c.count() + ' timers, ' + (A.sent.length - asks0) + ' sent');
    const before = A.sent.length; la.refresh(); la.host && 0;
    ok(A.sent.length === before, T('D7 a closed board sends nothing'), '');
  }

  /* D2. the tie-break is hardened against a board anyone can write to */
  {
    const c = makeClock(), hub = makeHub();
    const A = hub.join();
    const la = M.createOpenLobbies({ bus: A.bus, now: c.now, mine: { rom: ROM, fp: FP }, timers: c.timers, random: rng(7) });
    la.host(info({ room: 'AQ900', q: true }));
    const forged = (over = {}) => beacon({ room: '0AAAA', s: 'f'.repeat(16), q: 1, rom: ROM, fp: FP, rs: RS, ...over });
    hub.inject(forged());
    ok(la.list().some((g) => g.room === '0AAAA') && la.rival() === null, T('D9 ONE forged q:1 beacon with a code below every real one is on the board but is not a rival (this is what used to make every waiting host leave its game)'), J(la.list()));
    c.advance(3000); hub.inject(forged());
    ok(la.rival() === null, T('D10 nor is the same beacon heard again inside a beacon interval'), J(la.rival()));
    c.advance(1000); hub.inject(forged());
    ok(la.rival() && la.rival().room === '0AAAA', T('D11 only once it has been heard a beacon interval apart (the board is advice: a forger who keeps at it gets that far, and online.js makes the cost a failed join and the host\'s own game back)'), J(la.rival()));
    la.mute('0AAAA', 120000);
    hub.inject(forged());
    ok(la.rival() === null, T('D12 a rival the page muted (its join failed) is nobody\'s rival while muted, however often it is heard'), J(la.rival()));
    // a RESIDENT label is a name, not a room: it can never be defected to
    c.advance(125000); la.dir.prune();
    const res = (over = {}) => beacon({ room: '0BBBB', s: 'e'.repeat(16), q: 1, h: 1, ...over });
    hub.inject(res()); c.advance(4000); hub.inject(res());
    ok(la.list().some((g) => g.room === '0BBBB' && g.confirmed && g.h === 1) && la.rival() === null, T('D13 a confirmed q:1 beacon that is also h:1 (a resident label has no room to join) is not a rival'), J(la.list().map((g) => [g.room, g.confirmed, g.h])));
    la.close();
  }
  /* D3. the failure memory does not depend on the room code: a forger that ROTATES its code (and its sender id) is a new room to mute(), and used to be believed again 4 s after each new one */
  {
    const c = makeClock(), hub = makeHub();
    const A = hub.join();
    const la = M.createOpenLobbies({ bus: A.bus, now: c.now, mine: { rom: ROM, fp: FP }, timers: c.timers, random: rng(8) });
    la.host(info({ room: 'AQ900', q: true }));
    const ghost = (i) => beacon({ room: '0AAA' + 'BCDEFGH'[i], s: String(i + 1).repeat(16), q: 1, rom: ROM, fp: FP, rs: RS });
    const believe = (i) => { hub.inject(ghost(i)); c.advance(4000); hub.inject(ghost(i)); };
    believe(0);
    ok(la.rival() && la.rival().room === '0AAAB', T('D15 a forged listing heard twice, a beacon interval apart, IS believed (the board is advice: what the page pays for being wrong is a failed join, then the cooldown below)'), J(la.rival()));
    // the page's reaction to the failed join: that room is muted, and no rival at all moves the host for the cooldown; it then lists its own game again under a NEW code
    la.mute('0AAAB', 120000); la.muteRivals(120000);
    la.unhost(); la.host(info({ room: 'AQ901', q: true }));
    ok(la.rival() === null, T('D15b right after the failure the same forger is nobody\'s rival (the old, room-keyed mute)'), J(la.rival()));
    const rotated = [];
    for (let i = 1; i <= 4; i++) { believe(i); rotated.push(la.list().some((g) => g.room === ghost(i).room && g.confirmed) && la.rival() === null); }
    ok(rotated.length === 4 && rotated.every(Boolean), T('D16 after a failed defection NO rival moves the host for the cooldown, whatever room code and sender id it has: four listings with four new codes, each heard twice and CONFIRMED, none is a rival'), J(rotated));
    c.advance(98000);                      // 114 s after the failure
    hub.inject(ghost(5)); c.advance(4000); hub.inject(ghost(5));
    ok(la.list().some((g) => g.room === ghost(5).room && g.confirmed) && la.rival() === null, T('D17 ... still 2 s before the cooldown ends, and a rival that was confirmed a moment ago does not count'), J(la.rival()));
    c.advance(2000);
    ok(la.rival() && la.rival().room === ghost(5).room, T('D18 ... and only for the cooldown: when it ends a confirmed rival is believed again (the host is not deaf to a real rival for ever)'), J(la.rival()));
    la.close();
    // without a length it is the board's own mute period; another board is not affected
    const c2 = makeClock(), hub2 = makeHub();
    let seed2 = 9;          // (a different seed for each board: the sender id comes from it, and a board ignores messages that carry its own)
    const mk2 = () => M.createOpenLobbies({ bus: hub2.join().bus, now: c2.now, mine: { rom: ROM, fp: FP }, timers: c2.timers, random: rng(seed2++) });
    const x = mk2(), y = mk2(), z = mk2();
    x.host(info({ room: 'AQ900', q: true })); y.host(info({ room: 'AQ100', q: true })); z.host(info({ room: 'AQ950', q: true }));
    c2.advance(4000);
    ok(x.rival() && x.rival().room === 'AQ100' && z.rival() && z.rival().room === 'AQ100' && y.rival() === null, T('D19a (the rig) x and z would both move to the smallest code, y would not'), J([x.rival(), z.rival(), y.rival()]));
    x.muteRivals();
    ok(x.rival() === null && z.rival() && z.rival().room === 'AQ100', T('D19 muteRivals() with no length uses the board\'s own mute period, and only THIS board is silenced (z still moves to AQ100)'), J([x.rival(), z.rival()]));
    c2.advance(29999);
    ok(x.rival() === null, T('D19b ... for the whole period'), J(x.rival()));
    c2.advance(2);
    ok(x.rival() && x.rival().room === 'AQ100', T('D19c ... and then x is free to move again'), J(x.rival()));
    for (const l of [x, y, z]) l.close();
    // D20. the board SAYS when the cooldown is over: a real rival that was listed during it (so it is confirmed but was ignored) is acted on at once, not at the next unrelated change
    {
      const c3 = makeClock(), hub3 = makeHub();
      const h3 = M.createOpenLobbies({ bus: hub3.join().bus, now: c3.now, mine: { rom: ROM, fp: FP }, timers: c3.timers, random: rng(31) });
      const r3 = M.createOpenLobbies({ bus: hub3.join().bus, now: c3.now, mine: { rom: ROM, fp: FP }, timers: c3.timers, random: rng(32) });
      let wakes = 0; h3.watch(() => { wakes++; });
      h3.host(info({ room: 'AQ900', q: true })); r3.host(info({ room: 'AQ100', q: true }));
      c3.advance(4000);
      h3.muteRivals(20000);
      c3.advance(5000);
      const before = wakes;
      ok(h3.rival() === null, T('D20a (the rig) a confirmed rival is ignored during the cooldown'), J(h3.rival()));
      c3.advance(15500);
      ok(wakes > before, T('D20 the board announces the end of the cooldown (so the page looks at the rival again)'), 'wakes ' + before + ' -> ' + wakes);
      ok(h3.rival() && h3.rival().room === 'AQ100', T('D20b ... and the rival is there to be acted on'), J(h3.rival()));
      const w0 = wakes; h3.muteRivals(20000); h3.close(); c3.advance(30000);
      ok(wakes === w0, T('D20c a closed board never speaks again'), 'wakes ' + w0 + ' -> ' + wakes);
      r3.close();
    }
  }
  {
    // three Find-a-battle hosts and the one that will have to move: everybody agrees on the SMALLEST code, not on whichever has waited longest
    const c = makeClock(), hub = makeHub();
    const mk = (seed) => { const m = hub.join(); return M.createOpenLobbies({ bus: m.bus, now: c.now, mine: { rom: ROM, fp: FP }, timers: c.timers, random: rng(seed) }); };
    const b300 = mk(31), b100 = mk(32), b900 = mk(33), b200 = mk(34);
    b300.host(info({ room: 'AQ300', q: true })); c.advance(500); b100.host(info({ room: 'AQ100', q: true })); c.advance(500); b200.host(info({ room: 'AQ200', q: true })); c.advance(500); b900.host(info({ room: 'AQ900', q: true }));
    c.advance(4000);
    ok(b900.rival().room === 'AQ100' && b300.rival().room === 'AQ100' && b200.rival().room === 'AQ100' && b100.rival() === null, T('D14 of several waiting hosts every one that moves goes to the SMALLEST code (the oldest, AQ300, is not the pick), so they do not pick each other'), J([b900.rival(), b300.rival(), b200.rival(), b100.rival()].map((g) => g && g.room)));
    for (const l of [b300, b100, b900, b200]) l.close();
  }

  /* H. the broker list the hub uses is the library's */
  {
    const lib = fs.readFileSync(path.join(root, 'lib', 'netplay.js'), 'utf8');
    const m = /const WS_BROKERS = \[([\s\S]*?)\];/.exec(lib);
    const theirs = m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : [];
    ok(theirs.length >= 3 && J([...M.DEFAULT_BROKERS].sort()) === J(theirs.slice().sort()), T('H1 the hub\'s fallback broker list is exactly lib/netplay.js\'s WS_BROKERS (so the two cannot drift)'), J([M.DEFAULT_BROKERS, theirs]));
    const withLib = M.brokersFor({ Netplay: { signalBrokers: () => ['wss://mine:1'] }, location: { search: '?wsbroker=wss://x:2' } });
    ok(J(withLib) === '["wss://mine:1"]', T('H2 when the library is loaded its list (and its overrides) win'), J(withLib));
    ok(J(M.brokersFor({ location: { search: '?wsbroker=wss://a:1,%20wss://b:2' } })) === '["wss://a:1","wss://b:2"]', T('H3 otherwise ?wsbroker= is honoured, comma separated'), J(M.brokersFor({ location: { search: '?wsbroker=wss://a:1,%20wss://b:2' } })));
    ok(J(M.brokersFor({ location: { search: '' } })) === J(M.DEFAULT_BROKERS) && M.brokersFor({}).length === M.DEFAULT_BROKERS.length, T('H4 otherwise the default list, and never a crash'), '');
    const copy = M.brokersFor({}); copy.push('x');
    ok(M.DEFAULT_BROKERS.length === 5, T('H5 the default list cannot be changed by a caller'), String(M.DEFAULT_BROKERS.length));
  }

  /* E. the same-browser bus */
  {
    const reg = new Set();
    class BC { constructor(n) { this.name = n; this.onmessage = null; reg.add(this); } postMessage(m) { for (const x of reg) if (x !== this && x.name === this.name && x.onmessage) x.onmessage({ data: structuredClone(m) }); } close() { reg.delete(this); } }
    const win = { BroadcastChannel: BC };
    const a = M.createLocalBus(win), b = M.createLocalBus(win), other = M.createLocalBus(win, 'something-else');
    const got = [], gotOther = [];
    b.onMessage((m) => got.push(m)); other.onMessage((m) => gotOther.push(m)); a.onMessage(() => got.push('SELF'));
    a.send({ hi: 1 });
    ok(got.length === 1 && got[0].hi === 1 && gotOther.length === 0, T('E1 a message reaches the other browser on the channel, not the sender and not another channel'), J([got, gotOther]));
    ok(a.status() === 'up' && M.createLocalBus({}).status() === 'down', T('E2 no BroadcastChannel is "down", not a crash'), '');
    a.close(); a.send({ x: 1 });
    ok(got.length === 1, T('E3 a closed bus sends nothing'), '');
  }

  /* F. the broker bus, against brokers that behave and brokers that do not */
  {
    const world = { clients: [], published: [], up: new Set(), subCalls: 0 };
    const mq = {
      connect(url, opts) {
        const c = { url, opts, connected: false, subs: new Set(), h: {}, ended: false, published: [] };
        c.on = (ev, fn) => { (c.h[ev] = c.h[ev] || []).push(fn); return c; };
        c.emit = (ev, ...a) => (c.h[ev] || []).forEach((f) => f(...a));
        c.subscribe = (t, o, cb) => { world.subCalls++; c.subs.add(t); cb && cb(null); };
        c.publish = (t, p, o) => { const rec = { url, t, p, o }; c.published.push(rec); world.published.push(rec); for (const x of world.clients) if (x.url === url && x.subs.has(t) && x.connected) x.emit('message', t, Buffer.from(p)); };
        c.end = () => { c.ended = true; c.connected = false; };
        world.clients.push(c);
        return c;
      },
    };
    const bringUp = (url) => { for (const c of world.clients) if (c.url === url && !c.ended) { c.connected = true; c.emit('connect'); } };
    const c = makeClock();
    const mkBus = (brokers, over = {}) => M.createMqttBus({}, { brokers, lib: Promise.resolve(mq), random: rng(9), setTimeout: c.timers.setTimeout, clearTimeout: c.timers.clearTimeout, ...over });
    const tick = () => new Promise((r) => setImmediate(r));

    ok(M.parseBroker('wss://public.cloud.shiftr.io:443|public|public').username === 'public' && M.parseBroker('wss://h:1/mqtt').username === null && M.parseBroker('wss://demo.tbmq.io:443/mqtt|demo|').password === null, T('F0 the broker list parses the pipe form'), '');

    const bus = mkBus(['wss://one:1/mqtt', 'wss://two:2/mqtt|u|p', 'wss://dead:3/mqtt']);
    const seen = []; bus.onMessage((m) => seen.push(m));
    const states = []; bus.onStatus((s) => states.push(s));
    await tick();
    ok(bus.status() === 'connecting' && world.clients.length === 3, T('F1 it dials every broker and starts out connecting'), bus.status() + ' ' + world.clients.length);
    ok(world.clients[1].opts.username === 'u' && world.clients[1].opts.password === 'p' && world.clients[0].opts.username === undefined, T('F2 credentials go only to the broker that has them'), J(world.clients[1].opts));
    bus.send({ k: 'ask' });
    ok(world.published.length === 0, T('F3 nothing is published to a broker that has not connected'), String(world.published.length));
    bringUp('wss://one:1/mqtt'); bringUp('wss://two:2/mqtt|u|p'.split('|')[0]);
    ok(bus.status() === 'up' && states.join() === 'up', T('F4 the first broker to connect makes the board "up"'), bus.status() + ' ' + states.join());
    ok(world.clients[0].subs.has('bemental/arena/open/1') && world.clients[1].subs.has('bemental/arena/open/1') && world.clients[2].subs.size === 0, T('F5 every broker that connects is subscribed to the board\'s topic'), '');
    bus.send({ t: 'arenaopen', v: 1, k: 'ask', s: '0123456789abcdef' });
    ok(world.published.length === 2 && world.published.every((r) => r.o.qos === 0 && r.o.retain === false && r.t === 'bemental/arena/open/1'), T('F6 a send goes to every connected broker, qos 0, NOT retained'), J(world.published.map((r) => r.o)));
    // delivery
    const wire = (o) => JSON.stringify(o);
    const nb = seen.length;       // F6's own send came back through the fake broker, as a real broker does
    world.clients[0].emit('message', 'bemental/arena/open/1', Buffer.from(wire({ i: 'm1', k: 'ask' })));
    world.clients[1].emit('message', 'bemental/arena/open/1', Buffer.from(wire({ i: 'm1', k: 'ask' })));
    ok(seen.length - nb === 1 && !('i' in seen[seen.length - 1]), T('F7 the same message over two brokers is delivered once, with its transport id removed'), J(seen));
    const n0 = seen.length;
    world.clients[0].emit('message', 'some/other/topic', Buffer.from(wire({ i: 'm2', k: 'ask' })));
    world.clients[0].emit('message', 'bemental/arena/open/1', Buffer.from('not json'));
    world.clients[0].emit('message', 'bemental/arena/open/1', Buffer.from(wire({ k: 'ask' })));
    world.clients[0].emit('message', 'bemental/arena/open/1', Buffer.from(wire({ i: 'x'.repeat(40), k: 'ask' })));
    world.clients[0].emit('message', 'bemental/arena/open/1', Buffer.from(wire({ i: 'm3', pad: 'x'.repeat(2000) })));
    world.clients[0].emit('message', 'bemental/arena/open/1', Buffer.from('[1,2'));
    ok(seen.length === n0, T('F8 another topic, junk, a message with no id, an oversize one: none reach the board'), String(seen.length - n0));
    // a broker dropping
    world.clients[0].connected = false; world.clients[0].emit('close');
    ok(bus.status() === 'up', T('F9 one broker dropping is not news while another carries the board'), bus.status());
    world.clients[1].connected = false; world.clients[1].emit('close');
    ok(bus.status() === 'connecting' && states[states.length - 1] === 'connecting', T('F10 all of them dropping is'), bus.status());
    c.advance(9999);
    ok(bus.status() === 'connecting', T('F10b ... and stays connecting for the same wait a first connect gets (a blip is not news)'), bus.status());
    c.advance(2);
    ok(bus.status() === 'down' && states[states.length - 1] === 'down', T('F10c ... and then it is DOWN: a board that was up and lost every broker stops saying it is connecting (the page then stops telling a host that nobody can see their game)'), bus.status() + ' ' + states.join());
    bringUp('wss://one:1/mqtt');
    ok(bus.status() === 'up' && states[states.length - 1] === 'up', T('F11 and any broker coming back, even from down, is up again'), bus.status());
    world.clients[0].connected = false; world.clients[0].emit('close');
    ok(bus.status() === 'connecting', T('F11b a second total drop is connecting again ...'), bus.status());
    c.advance(10001);
    ok(bus.status() === 'down', T('F11c ... and down again after the wait (the clock is re-armed every time, not just once)'), bus.status());
    bringUp('wss://one:1/mqtt');
    bus.close();
    ok(world.clients.every((x) => x.ended), T('F12 closing ends every connection'), '');
    const pc = world.published.length; bus.send({ x: 1 });
    ok(world.published.length === pc, T('F13 a closed bus sends nothing'), '');
    // the library can still deliver events from a connection it has been told to end: none of them may reach the page, subscribe, or send anything
    const news0 = states.length, subs0 = world.subCalls, pub1 = world.published.length;
    for (const x of world.clients) { x.connected = true; x.emit('connect'); x.emit('close'); x.emit('offline'); }
    bus.send({ t: 'arenaopen', v: 1, k: 'ask', s: '0123456789abcdef' });
    ok(states.length === news0 && world.subCalls === subs0 && world.published.length === pub1, T('F14 a late connect / close after close() is harmless: no status news, no subscribe, nothing published'), J([states.length - news0, world.subCalls - subs0, world.published.length - pub1]));

    // nobody answers: the board says "down" after the wait, and a late broker still brings it back up
    const world0 = world.clients.length;
    const slow = mkBus(['wss://slow:1/mqtt']);
    await tick();
    c.advance(10001);
    ok(slow.status() === 'down', T('F15 no broker answering for 10 s is "down" (the page says the list cannot be reached)'), slow.status());
    for (const x of world.clients.slice(world0)) { x.connected = true; x.emit('connect'); }
    ok(slow.status() === 'up', T('F16 a broker that answers late brings it back'), slow.status());
    slow.close();
    ok(mkBus([]).status() === 'down', T('F17 no brokers configured is "down", at once'), '');
    const nolib = M.createMqttBus({}, { brokers: ['wss://x:1'], lib: Promise.reject(new Error('blocked')), random: rng(1), setTimeout: c.timers.setTimeout, clearTimeout: c.timers.clearTimeout });
    await tick(); await tick();
    ok(nolib.status() === 'down', T('F18 a library that will not load is "down", not a crash'), nolib.status());
    nolib.close();
    // full path: two lobbies over the broker bus
    const w2 = { clients: [], published: [] };
    const mq2 = { connect(url) { const cl = { url, connected: true, subs: new Set(), h: {}, ended: false }; cl.on = (ev, fn) => { (cl.h[ev] = cl.h[ev] || []).push(fn); if (ev === 'connect') setImmediate(fn); return cl; }; cl.emit = (ev, ...a) => (cl.h[ev] || []).forEach((f) => f(...a)); cl.subscribe = (t) => { cl.subs.add(t); }; cl.publish = (t, p) => { for (const x of w2.clients) if (x.url === url && x.subs.has(t)) x.emit('message', t, Buffer.from(p)); }; cl.end = () => { cl.ended = true; }; w2.clients.push(cl); return cl; } };
    const mkb = (seed) => M.createMqttBus({}, { brokers: ['wss://p:1', 'wss://q:2'], lib: Promise.resolve(mq2), random: rng(seed), setTimeout: c.timers.setTimeout, clearTimeout: c.timers.clearTimeout });
    const c2 = makeClock();
    const X = M.createOpenLobbies({ bus: mkb(21), now: c2.now, mine: { rom: ROM, fp: FP }, timers: c2.timers, random: rng(21) });
    const Y = M.createOpenLobbies({ bus: mkb(22), now: c2.now, mine: { rom: ROM, fp: FP }, timers: c2.timers, random: rng(22) });
    await tick(); await tick(); await tick();
    X.host(info({ room: 'AQ777', name: 'Xavier' }));
    ok(Y.list().length === 1 && Y.list()[0].name === 'Xavier', T('F19 a game listed over two brokers appears once on the other board'), J(Y.list()));
    X.close(); Y.close();
  }
}

/* ------------------------------------------------------------------------------------------------ the mutants */
// Each breaks ONE guarantee in a copy of openlobby.js. The suite must then fail; if it does not, it was not testing that guarantee.
const MUTANTS = [
  { id: 'ttl-never-expires', why: 'a game whose host has gone stays on the board for ever', from: 'if (t - g.seen > ttlMs) { games.delete(r); changed = true; }', to: 'if (false) { games.delete(r); changed = true; }' },
  { id: 'anyone-can-take-it-down', why: 'any sender can remove anyone\'s game', from: 'if (!g || g.s !== s) return false;', to: 'if (!g) return false;' },
  { id: 'second-sender-takes-the-room', why: 'a second sender can rename or hijack a listed game', from: 'if (g.s !== b.s) return false;', to: '' },
  { id: 'no-cap', why: 'the board grows without limit', from: 'if (games.size >= max) return changed;', to: '' },
  { id: 'name-not-cleaned', why: 'a hostile name reaches the page as sent', from: 'name: cleanName(m.name, \'Player\'),', to: 'name: m.name,' },
  { id: 'any-format', why: 'a format the Arena does not play is listed', from: 'if (!FORMATS.includes(m.fmt)) return bad(\'format\');', to: '' },
  { id: 'record-unchecked', why: 'a record of any shape or size reaches the page', from: "if (!Array.isArray(x) || x.length !== 2 || !x.every((n) => Number.isInteger(n) && n >= 0 && n <= REC_MAX)) return { ok: false };", to: '' },
  { id: 'signal-to-everyone', why: 'a directed message is delivered to every browser', from: 'if (b.to === sid) for (const f of [...signalFns])', to: 'if (true) for (const f of [...signalFns])' },
  { id: 'resident-flag-dropped', why: 'a resident game is shown as an ordinary one, so a joiner knocks on a room that does not exist', from: 'h: m.h === 1 ? 1 : 0, rec: rr.rec', to: 'h: 0, rec: rr.rec' },
  { id: 'decline-reason-unchecked', why: 'a decline can carry any text', from: 'if (!DECLINE_WHY.includes(m.why)) return bad(\'why\');', to: '' },
  { id: 'no-recipient-needed', why: 'a directed message without a valid recipient is accepted', from: 'if (typeof m.to !== \'string\' || !HEX16.test(m.to)) return bad(\'to\');', to: '' },
  { id: 'signal-unchecked', why: 'a message the receivers would drop is sent anyway', from: 'if (!chk.ok) throw new RangeError(', to: 'if (false) throw new RangeError(' },
  { id: 'acc-key-unchecked', why: 'a "come in" with no usable key reaches the challenger', from: "if (typeof m.pk !== 'string' || !PK_RE.test(m.pk)) return bad('key');\n      if (typeof m.iv", to: 'if (typeof m.iv' },
  { id: 'acc-iv-unchecked', why: 'a "come in" with a malformed iv reaches the challenger', from: "if (typeof m.iv !== 'string' || !IV_RE.test(m.iv)) return bad('iv');\n", to: '' },
  { id: 'acc-ct-unchecked', why: 'a "come in" with a sealed room of any shape or size reaches the challenger', from: "if (typeof m.ct !== 'string' || !CT_RE.test(m.ct)) return bad('sealed room');\n", to: '' },
  { id: 'acc-room-in-clear', why: 'the room of an accepted challenge goes on the public board in the clear (or a clear one is passed to the challenger)', from: 'd.pk = m.pk; d.iv = m.iv; d.ct = m.ct;', to: 'd.pk = m.pk; d.iv = m.iv; d.ct = m.ct; d.room = String(m.room).toUpperCase();' },
  { id: 'chal-key-unchecked', why: 'a challenge with no key to answer in private is shown to the owner', from: "if (typeof m.pk !== 'string' || !PK_RE.test(m.pk)) return bad('key');           // no key, no way to answer in private: such a challenge is not shown\n      d.pk = m.pk;", to: 'd.pk = m.pk;' },
  { id: 'signal-sends-raw', why: 'whatever fields a caller passes go on the public bus, a clear room included', from: 'bus.send({ t: BEACON, v: BEACON_V, ...chk.b })', to: 'bus.send(msg)' },
  { id: 'listener-breaks-board', why: 'a throwing listener stops the others', from: 'try { f(b); } catch (_e) { /* a listener must not break the board */ }', to: 'f(b);' },
  { id: 'broker-list-drifts', why: 'the hub\'s fallback list differs from the library\'s', from: "'wss://demo.tbmq.io:443/mqtt|demo|',", to: "'wss://demo.tbmq.io:443/mqtt|demo|x'," },
  { id: 'any-room', why: 'a room code of any shape is accepted on an open or gone message', from: "if (m.k !== 'open' && m.k !== 'gone') return bad('unknown kind');\n  if (typeof m.room !== 'string' || !ROOM_RE.test(m.room)) return bad('room');", to: "if (m.k !== 'open' && m.k !== 'gone') return bad('unknown kind');\n  if (typeof m.room !== 'string') return bad('room');" },
  { id: 'own-echo-listed', why: 'my own beacon coming back from the broker puts my game on my board', from: 'if (!r.ok || r.b.s === sid) return;', to: 'if (!r.ok) return;' },
  { id: 'no-rate-limit', why: 'a flood is processed in full', from: 'if (++winCount > timing.rateMax) return;', to: '' },
  { id: 'answer-every-ask', why: 'every ask is answered, so an ask loop floods the broker', from: 'else if (b.k === \'ask\' && hosting && t - lastAnswer >= timing.answerGapMs) {', to: 'else if (b.k === \'ask\' && hosting) {' },
  { id: 'unhost-silent', why: 'a game taken down is not announced, so it lingers for the ttl', from: 'if (!closed) { try { bus.send(beaconOf(\'gone\')); }', to: 'if (false) { try { bus.send(beaconOf(\'gone\')); }' },
  { id: 'both-defect', why: 'of two quick games each one joins the other', from: 'g.room < hosting.room', to: 'g.room !== hosting.room' },
  { id: 'rival-ignores-quick', why: 'a game that was not opened by Find a battle counts as a rival', from: 'g.q && !g.h && g.compatible', to: '!g.h && g.compatible' },
  { id: 'rival-ignores-build', why: 'a game on another engine build counts as a rival', from: '!g.h && g.compatible && g.confirmed', to: '!g.h && g.confirmed' },
  { id: 'rival-unconfirmed', why: 'a single forged beacon moves a waiting host out of its own game', from: 'g.compatible && g.confirmed && g.room', to: 'g.compatible && g.room' },
  { id: 'rival-resident', why: 'a resident label (no room to join) counts as a rival', from: 'g.q && !g.h && g.compatible', to: 'g.q && g.compatible' },
  { id: 'rival-first-listed', why: 'a host moves to the longest-waiting rival instead of the smallest code, so three hosts pick each other', from: '(!best || g.room < best.room)', to: '!best' },
  { id: 'rival-cooldown-ignored', why: 'after a failed defection a forger that rotates its room code is believed again 4 s after each new code', from: 'if (clock() < rivalsMutedUntil) return null;', to: '' },
  { id: 'rival-cooldown-never-ends', why: 'after one failed defection no rival can ever move the host again', from: 'if (clock() < rivalsMutedUntil) return null;', to: 'if (rivalsMutedUntil > -Infinity) return null;' },
  { id: 'rival-cooldown-ignores-length', why: 'the cooldown after a failed defection is one second, whatever the page asked for', from: 'rivalsMutedUntil = clock() + (ms === undefined ? timing.mutedMs : ms);', to: 'rivalsMutedUntil = clock() + 1000;' },
  { id: 'rival-cooldown-default-forever', why: 'muteRivals() with no length never ends', from: 'rivalsMutedUntil = clock() + (ms === undefined ? timing.mutedMs : ms);', to: 'rivalsMutedUntil = clock() + (ms === undefined ? Infinity : ms);' },
  { id: 'rival-cooldown-cleared-by-relisting', why: 'listing the player\'s own game again (what the page does right after the failure) forgets the cooldown', from: 'L.unhost();\n      hosting = next;', to: 'L.unhost(); rivalsMutedUntil = -Infinity;\n      hosting = next;' },
  { id: 'rival-cooldown-end-silent', why: 'the board never announces the end of the cooldown, so a real rival listed during it waits for an unrelated change', from: 'if (!closed) emit(); }, Math.max(0, rivalsMutedUntil - clock()) + 1);', to: 'if (false) emit(); }, Math.max(0, rivalsMutedUntil - clock()) + 1);' },
  { id: 'confirmed-at-first-beacon', why: 'a listing is confirmed the moment it is heard', from: 'first: t, since: t, confirmed: false, seen: t', to: 'first: t, since: t, confirmed: true, seen: t' },
  { id: 'confirmed-without-interval', why: 'two beacons in the same instant confirm a listing', from: 'if (!g.confirmed && t - g.since >= confirmMs)', to: 'if (!g.confirmed)' },
  { id: 'changed-listing-stays-confirmed', why: 'a confirmed listing can change into anything and stay confirmed', from: 'rec: b.rec, since: t, confirmed: false });', to: 'rec: b.rec });' },
  { id: 'sender-many-rooms', why: 'one sender can fill the board with rooms of its own', from: 'for (const [r, o] of games) if (o.s === b.s) { games.delete(r); changed = true; }', to: '' },
  { id: 'compatible-always', why: 'every game is marked compatible', from: 'compatible: !!mine && g.rom === mine.rom && g.fp === mine.fp', to: 'compatible: true' },
  { id: 'newest-first', why: 'the game that has waited longest is last', from: 'a.first - b.first ||', to: 'b.first - a.first ||' },
  { id: 'host-accepts-anything', why: 'a listing the other browsers would drop is accepted silently', from: 'if (!probe || !probe.ok) throw new RangeError(', to: 'if (false) throw new RangeError(' },
  { id: 'close-leaves-timers', why: 'a closed board keeps asking', from: 'L.unhost(); L.stopWatching();\n      closed = true;', to: 'L.unhost();\n      closed = true;' },
  { id: 'start-twice-asks-twice', why: 'looking twice stacks two ask timers', from: 'if (closed || watching) return;\n      watching = true;', to: 'if (closed) return;\n      watching = true;' },
  { id: 'mqtt-no-dedupe', why: 'a message that arrives over two brokers is delivered twice', from: 'if (seen.has(m.i)) return;', to: '' },
  { id: 'mqtt-retained', why: 'beacons are retained, so a dead game outlives its host on the broker', from: '{ qos: 0, retain: false }', to: '{ qos: 0, retain: true }' },
  { id: 'mqtt-publish-unconnected', why: 'a send goes to brokers that never connected', from: 'for (const c of clients) if (c.connected) { try { c.publish', to: 'for (const c of clients) if (true) { try { c.publish' },
  { id: 'mqtt-any-topic', why: 'a message on another topic reaches the board', from: 'if (t === topic) deliver(payload);', to: 'deliver(payload);' },
  { id: 'mqtt-no-size-limit', why: 'an oversize message is parsed', from: 'if (text.length > timing.wireMax) return;', to: '' },
  { id: 'mqtt-never-down', why: 'a board whose brokers never answer says "connecting" for ever', from: "if (!clients.some((c) => c.connected)) setStatus('down'); }, timing.mqttDownMs); };", to: '}, timing.mqttDownMs); };' },
  { id: 'mqtt-no-redown', why: 'a board that was up and lost every broker says "connecting" for ever', from: "setStatus('connecting'); armDown(); }", to: "setStatus('connecting'); }" },
  { id: 'mqtt-subscribe-after-close', why: 'a connect event from a connection that was ended subscribes it again', from: "c.on('connect', () => { if (closed) return; try {", to: "c.on('connect', () => { try {" },
  { id: 'mqtt-news-after-close', why: 'a closed board still reports status changes to the page', edits: [["if (s !== status && !closed) {", "if (s !== status) {"], ["const update = () => { if (closed) return; if (clients.some", "const update = () => { if (clients.some"]], from: '', to: '' },
  { id: 'mqtt-id-kept', why: 'the transport id is passed on as if it were part of the message', from: '    delete m.i;\n', to: '' },
];

async function loadFrom(dir) { return import(pathToFileURL(path.join(dir, 'openlobby.js')).href + '?x=' + Math.random().toString(36).slice(2)); }

async function runMutants() {
  const out = [];
  for (const mu of MUTANTS) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-lob-mut-'));
    try {
      for (const f of fs.readdirSync(SRC)) { const p = path.join(SRC, f); if (fs.statSync(p).isFile() && f.endsWith('.js')) fs.copyFileSync(p, path.join(dir, f)); }
      const target = path.join(dir, 'openlobby.js');
      const text = fs.readFileSync(target, 'utf8');
      const edits = mu.edits || [[mu.from, mu.to]];
      let mutated = text, bad = null;
      for (const [from, to] of edits) { const n = mutated.split(from).length - 1; if (n !== 1) { bad = 'PATTERN FOUND ' + n + 'x (the mutant did not apply once): ' + from.slice(0, 50); break; } mutated = mutated.replace(from, () => to); }
      if (bad) { out.push({ id: mu.id, killed: false, why: bad }); continue; }
      fs.writeFileSync(target, mutated);
      const before = fail, saveQ = process.env.ARENA_QUIET; process.env.ARENA_QUIET = '1';
      let threw = null;
      try { const M2 = await loadFrom(dir); await Promise.race([suite(M2, mu.id), new Promise((_r, rej) => setTimeout(() => rej(new Error('mutant run timed out')), 30000))]); } catch (e) { threw = e; }
      const killed = fail > before || !!threw;
      out.push({ id: mu.id, killed, why: mu.why, threw: threw ? String(threw.message || threw).slice(0, 80) : null });
      fail = before; failures.length = Math.min(failures.length, before);
      process.env.ARENA_QUIET = saveQ || '';
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  return out;
}

/* ------------------------------------------------------------------------------------------------ main */
const M = await import(pathToFileURL(path.join(SRC, 'openlobby.js')).href);
const t0 = Date.now();
await suite(M, '');
console.log(`openlobby: ${pass} passed, ${fail} failed (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
let survived = 0;
if (WANT_MUTANTS) {
  const keep = fail, keepFailures = failures.slice();
  const res = await runMutants();
  fail = keep; failures.length = 0; failures.push(...keepFailures);
  for (const m of res) { console.log((m.killed ? 'killed  ' : 'SURVIVED') + ' ' + m.id + ' -- ' + m.why + (m.threw ? ' (threw: ' + m.threw + ')' : '') + (m.killed ? '' : '  <-- the suite did not notice')); if (!m.killed) survived++; }
  console.log(`mutants: ${res.length - survived}/${res.length} killed`);
}
if (fail || survived) { console.log('\nFAILURES:\n  ' + failures.join('\n  ')); process.exit(1); }

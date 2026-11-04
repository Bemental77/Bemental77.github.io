// tools/pokemonarena_presence_test.mjs -- OPEN TO BATTLES (pokemonarena/js/presence.js), in Node: no browser, no network, no real clock.
//
//   node tools/pokemonarena_presence_test.mjs             the cases
//   node tools/pokemonarena_presence_test.mjs --mutants   ALSO break presence.js (and the few pure parts of online.js) one way at a time; every break must fail a case
//
// The cases run the WHOLE challenge protocol across three real board instances (openlobby.js) joined by an in-memory medium: the challenger (the battle page's Open games),
// the owner (the hub or a CPU battle: createPresence + a dialog double + a sessionStorage double) and the owner's battle page after Accept (createAcceptor). What is proved: a challenge shows ONE dialog and
// is answered ONCE however often it is repeated; Not now is the quiet default and is remembered; a second challenger while a dialog is up is told busy; a flood is capped; nobody
// answering is a decline, not a hang; a forged answer from the wrong sender or for the wrong request changes nothing; a challenge that arrives after its own cancel opens nothing; everything stops and
// nothing is left running. And the SECRECY of the hand-off, with the real WebCrypto of Node: the room reaches the challenger SEALED to a one-time key that only it holds (the board never carries the room; an
// observer, a forger and a wrong request cannot open it; a browser without WebCrypto fails closed instead of sending it in the clear), the Accept token that lets the next page host exactly one accepted
// challenge (written by Accept, matched, fresh, used once), who an open game may let in without Allow (admission(): the first, the returning player after a rebuilt Session, nobody else), and the address
// a reload of an accepted-challenge page comes back to (online.js canonicalAddress / parseOnlineQuery), and the plain Play online address a board page goes back to when a join ends without a match (boardAddress). The page half (the switch, the real dialog, a real battle) is tools/pokemonarena_online_page_test.mjs, group `presence`.
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
// real time, for the few things that are genuinely asynchronous (WebCrypto resolves off the event loop); the protocol's own clock is the fake one below
const settle = async (cond, ms = 3000) => { const t0 = Date.now(); while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 2)); return cond(); };
const quiet = (ms = 60) => new Promise((r) => setTimeout(r, ms));

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
function makeHub() {
  const members = new Set();
  return {
    join() {
      const m = { cb: null, sent: [], closed: false };
      m.bus = {
        send(o) { if (m.closed) return; m.sent.push(o); for (const x of members) if (x !== m && x.cb && !x.closed) x.cb(JSON.parse(JSON.stringify(o))); },
        onMessage(f) { m.cb = f; }, onStatus() {}, status: () => 'up', close() { m.closed = true; members.delete(m); },
      };
      members.add(m);
      return m;
    },
  };
}
const memStorage = () => { const store = {}; return { store, getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } }; };
const ROM = 'a'.repeat(64), FP = 'e1.abc', RS = 'gen3-standard';
const WALL0 = 1700000000000;                                  // the "wall clock" of the tests: the fake clock's time on top of this
const PK_FAKE = 'A'.repeat(43) + '.' + 'B'.repeat(43);        // the SHAPE of a one-time key (checkBeacon only checks shapes); the real maths is in group L

async function suite(L, P, O, tag) {
  const T = (s) => (tag ? '[' + tag + '] ' : '') + s;
  const world = () => {
    const c = makeClock(), hub = makeHub();
    const mk = (seed) => { const m = hub.join(); return { m, lob: L.createOpenLobbies({ bus: m.bus, now: c.now, mine: { rom: ROM, fp: FP }, timers: c.timers, random: rng(seed) }) }; };
    return { c, hub, mk };
  };
  const dialog = () => { const d = { shown: [], hidden: 0 }; d.ui = { show: (x) => d.shown.push(x), hide: () => { d.hidden++; } }; return d; };
  const owner = (w, over = {}) => {
    const { m, lob } = w.mk(over.seed || 11);
    const d = dialog();
    const nav = [];
    const session = over.session !== undefined ? over.session : memStorage();
    const wall = () => WALL0 + w.c.now();
    let ident = { name: 'Olive', fmt: '3v3', rec: [4, 2], rom: ROM, fp: FP, rs: RS };
    const pres = P.createPresence({ lobbies: lob, identity: () => ident, ui: d.ui, navigate: (u) => nav.push(u), hrefFor: (p, id) => P.acceptHref({ s: p.s, r: p.r, fmt: id.fmt, extra: '&net=local' }), now: w.c.now, timers: w.c.timers, random: rng(77), session, wall });
    return { m, lob, d, nav, pres, session, wall, setIdent: (x) => { ident = x; } };
  };
  // ch() makes the challenge and waits for its one-time key pair to exist (the challenge is sent when it does): WebCrypto is asynchronous
  const challenger = (w, o, seed, name = 'Cara', rec = [1, 0]) => {
    const { m, lob } = w.mk(seed);
    if (!lob.list().length) { lob.refresh(); w.c.advance(2000); }          // a browser that opens the panel ASKS who is open (an owner answers an ask at most every 1.5 s, within a second)
    const board = () => lob.list().find((g) => g.h === 1) || null;
    const ev = { states: [], accepted: [], failed: [] };
    const mkch = (extra) => P.createChallenge({ lobbies: lob, target: board(), name, rec, now: w.c.now, timers: w.c.timers, on: { state: (s) => ev.states.push(s), accepted: (r) => ev.accepted.push(r), failed: (x) => ev.failed.push(x) }, ...(extra || {}) });
    const ch = async (extra) => { const c = mkch(extra); await c.ready; return c; };
    const chalSent = () => m.sent.find((x) => x.k === 'chal') || null;
    return { m, lob, board, ev, ch, mkch, chalSent };
  };
  // a challenge from a bare lobby with a made-up key (shape only), for the cases that are about the owner's side
  const rawChal = (lob, to, r, over = {}) => lob.signal('chal', { to, r, name: 'Cara', pk: PK_FAKE, ...over });

  /* A. the switch and the label */
  {
    const store = {}; const st = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
    ok(P.isOpen(st) === false && P.setOpen(st, true) && P.isOpen(st) === true && P.setOpen(st, false) && P.isOpen(st) === false && !(P.OPEN_KEY in store), T('A1 the switch is stored as "1" and removed when off'), J(store));
    const boom = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
    ok(P.isOpen(boom) === false && P.setOpen(boom, true) === false && P.isOpen(null) === false, T('A2 a browser that blocks storage is simply "off", never a crash'), '');
    const labels = new Set(); const r = rng(5);
    for (let i = 0; i < 200; i++) labels.add(P.residentLabel(r));
    ok([...labels].every((x) => /^H[A-HJ-NP-Z2-9]{4}$/.test(x) && L.ROOM_RE.test(x)) && labels.size > 150, T('A3 a resident label is H + 4 characters, valid as a room-shaped label, and varied'), String(labels.size));
    const u = new URL('http://x' + P.acceptHref({ s: 'ab12', r: 'c d&e=f', fmt: '3v3', extra: '&net=local' }));
    ok(u.pathname === '/pokemonarena/battle.html' && u.searchParams.get('auto') === 'host' && u.searchParams.get('for') === 'ab12' && u.searchParams.get('rq') === 'c d&e=f' && u.searchParams.get('format') === '3v3' && u.searchParams.get('net') === 'local' && u.searchParams.get('online') === '1' && [...u.searchParams.keys()].length === 6, T('A4 the Accept address names the host role, the challenger, the request and the format, and encodes what it was given'), u.search);
  }

  /* B. the owner is listed; a challenge shows ONE dialog */
  {
    const w = world(), o = owner(w), cr = challenger(w, o, 21);
    o.pres.start();
    const g = cr.board();
    ok(g && g.h === 1 && g.name === 'Olive' && J(g.rec) === '[4,2]' && g.s === o.lob.sid && /^H/.test(g.room) && g.room === o.pres.label, T('B1 the owner is on the challenger\'s board as a RESIDENT game: flagged, with their id, their record and a label that is not a room'), J(g));
    ok(o.pres.isOn() && o.pres.start() === false, T('B2 starting twice is a no-op'), '');
    const c1 = await cr.ch();
    ok(o.d.shown.length === 1 && o.d.shown[0].name === 'Cara' && J(o.d.shown[0].rec) === '[1,0]' && o.d.shown[0].s === cr.lob.sid && o.d.shown[0].r === c1.r, T('B3 the challenge opens a dialog naming who is asking, their record, and carrying the request'), J(o.d.shown));
    w.c.advance(10000);
    ok(o.d.shown.length === 1, T('B4 the challenger repeating itself (every 3 s) does not open it again'), String(o.d.shown.length));
    ok(o.pres.pending() && o.pres.pending().r === c1.r, T('B5 the owner has exactly that request pending'), J(o.pres.pending()));
    const sent = cr.chalSent();
    ok(sent && L.PK_RE.test(sent.pk) && o.pres.pending().pk === sent.pk, T('B6 the challenge carries a one-time public key, and the owner holds exactly that key for the hand-off'), J(sent));
    c1.cancel();
  }

  /* C. Accept: ok goes back, the token is written, the page leaves, the listing comes down */
  {
    const w = world(), o = owner(w), cr = challenger(w, o, 22);
    o.pres.start();
    const c1 = await cr.ch();
    const sentBefore = cr.m.sent.length, wallAtAccept = o.wall();
    o.pres.accept();
    ok(cr.ev.states.join() === 'accepted', T('C1 the challenger is told it was accepted'), J(cr.ev));
    ok(o.nav.length === 1 && o.nav[0].includes('for=' + cr.lob.sid) && o.nav[0].includes('rq=' + c1.r) && o.nav[0].includes('format=3v3'), T('C2 the owner is sent to the battle page, once, with the challenger and the request in the address'), J(o.nav));
    ok(cr.board() === null && !o.pres.isOn(), T('C3 the listing comes down and the owner is no longer open (the page is leaving)'), '');
    ok(o.d.hidden >= 1 && o.pres.pending() === null, T('C4 the dialog is closed'), '');
    w.c.advance(20000);
    const chals = cr.m.sent.slice(sentBefore).filter((x) => x.k === 'chal');
    ok(chals.length === 0, T('C5 once it is accepted the challenger stops repeating the challenge'), String(chals.length));
    ok(o.pres.accept() === false, T('C6 accepting with nothing pending does nothing'), '');
    // the hand-off to the next page: a one-time token in THIS tab's sessionStorage, naming the challenger and the request, carrying the challenger's key, stamped with the WALL clock
    const raw = o.session.store[P.ACCEPT_KEY] ? JSON.parse(o.session.store[P.ACCEPT_KEY]) : null;
    ok(raw && raw.for === cr.lob.sid && raw.rq === c1.r && raw.ck === cr.chalSent().pk && raw.at === wallAtAccept && raw.at >= WALL0, T('C7 Accept leaves the accept token for the page it opens: who, which request, the challenger\'s key, the wall-clock time'), J(raw));
  }
  {
    // no storage to leave a token in: the next page would (rightly) refuse to host, so Accept must not pretend
    const w = world(), o = owner(w, { session: null }), cr = challenger(w, o, 52);
    o.pres.start();
    await cr.ch();
    const r = o.pres.accept();
    ok(r === false && o.nav.length === 0 && cr.ev.failed.join() === 'busy' && cr.ev.states.length === 0 && o.pres.pending() === null && o.pres.isOn(), T('C8 with no sessionStorage Accept fails closed: nobody is sent anywhere, the challenger is told busy at once (not left to wait for a room), the owner stays open'), J([r, o.nav, cr.ev]));
    const w2 = world(), o2 = owner(w2, { session: { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } } }), cr2 = challenger(w2, o2, 53);
    o2.pres.start(); await cr2.ch();
    ok(o2.pres.accept() === false && o2.nav.length === 0 && cr2.ev.failed.join() === 'busy', T('C9 ... and so does a sessionStorage that throws'), J(cr2.ev));
    // left out altogether, the page's own sessionStorage is used (the page need not pass it)
    const had = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
    const g = memStorage();
    try {
      Object.defineProperty(globalThis, 'sessionStorage', { value: g, configurable: true, writable: true });
      const w3 = world(), c3 = w3.c, m3 = w3.mk(61), d3 = dialog(), nav3 = [];
      const pres3 = P.createPresence({ lobbies: m3.lob, identity: () => ({ name: 'Olive', fmt: '3v3', rec: null, rom: ROM, fp: FP, rs: RS }), ui: d3.ui, navigate: (u) => nav3.push(u), hrefFor: (p, id) => P.acceptHref({ s: p.s, r: p.r, fmt: id.fmt }), now: c3.now, timers: c3.timers, random: rng(78) });
      const cr3 = challenger(w3, { lob: m3.lob }, 62);
      pres3.start(); await cr3.ch(); pres3.accept();
      ok(nav3.length === 1 && P.ACCEPT_KEY in g.store, T('C10 ... and left out of createPresence it defaults to the page\'s own sessionStorage'), J(Object.keys(g.store)));
    } finally { if (had) Object.defineProperty(globalThis, 'sessionStorage', had); else delete globalThis.sessionStorage; }
  }

  /* D. the room reaches the challenger by the request id, SEALED, from a NEW page */
  {
    const w = world(), o = owner(w), cr = challenger(w, o, 23);
    o.pres.start();
    const c1 = await cr.ch(); o.pres.accept();
    const tok = P.takeAcceptToken(o.session, { for: cr.lob.sid, rq: c1.r }, o.wall());
    const page = w.mk(31);         // the owner's battle page: a new page, a new sender id
    const acc = P.createAcceptor({ lobbies: page.lob, to: cr.lob.sid, r: c1.r, room: 'aq777', ck: tok && tok.ck, timers: w.c.timers });
    await acc.ready;
    await settle(() => cr.ev.accepted.length > 0);
    ok(cr.ev.accepted.join() === 'AQ777', T('D1 the challenger gets the room (upper-cased) from the new page: opened with its own one-time key, matched by the request id'), J(cr.ev));
    const onWire = page.m.sent.filter((x) => x.k === 'acc');
    ok(onWire.length === 1 && !J(onWire).toUpperCase().includes('AQ777') && !J(onWire).includes('QVE3Nzc') && L.checkBeacon(onWire[0]).ok, T('D1b and what crossed the board says no room, in any case or in base64: it is a sealed message the other boards accept the SHAPE of'), J(onWire));
    w.c.advance(10000);
    ok(cr.ev.accepted.length === 1 && c1.done(), T('D2 the repeats of "come in" do not make it start twice'), J(cr.ev));
    const sent = page.m.sent.length; w.c.advance(120000);
    ok(acc.live() === false && page.m.sent.length - sent <= 44 && w.c.count() === 0, T('D3 the acceptor gives up after 90 s and leaves no timer'), w.c.count() + ' timers, ' + (page.m.sent.length - sent) + ' sent');
    // repeats: before the challenger heard, they are sent every 2 s
    const w2 = world(); const pg = w2.mk(32), lis = w2.mk(33);
    const rq = 'f'.repeat(16);
    const kp = await P.makeKeyPair();
    const a2 = P.createAcceptor({ lobbies: pg.lob, to: lis.lob.sid, r: rq, room: 'AQ888', ck: kp.pk, timers: w2.c.timers });
    await a2.ready;
    const accs = () => pg.m.sent.filter((x) => x.k === 'acc').length;
    const n0 = accs(); w2.c.advance(6000);
    ok(n0 === 1 && accs() === 4, T('D4 "come in" is sent at once and every 2 s (1 + 3 in 6 s)'), n0 + ' ' + accs());
    const distinct = new Set(pg.m.sent.filter((x) => x.k === 'acc').map((x) => x.ct + x.iv + x.pk));
    ok(distinct.size === 1, T('D4b ... the same sealed message each time (it is sealed once)'), String(distinct.size));
    a2.stop(); const n1 = accs(); w2.c.advance(20000);
    ok(accs() === n1 && w2.c.count() === 0, T('D5 stop() stops it, and nothing is left running'), accs() + ' ' + w2.c.count());
    // an acceptor stopped before the room was sealed sends nothing at all
    const w3 = world(); const pg3 = w3.mk(34); const a3 = P.createAcceptor({ lobbies: pg3.lob, to: 'c'.repeat(16), r: rq, room: 'AQ999', ck: kp.pk, timers: w3.c.timers });
    a3.stop(); await a3.ready;
    ok(pg3.m.sent.filter((x) => x.k === 'acc').length === 0 && a3.live() === false, T('D6 an acceptor stopped before its message was ready sends nothing'), '');
  }

  /* E. Not now: quiet default, remembered */
  {
    const w = world(), o = owner(w), cr = challenger(w, o, 24);
    o.pres.start();
    const c1 = await cr.ch();
    o.pres.decline();
    ok(cr.ev.failed.join() === 'declined' && o.pres.pending() === null && o.d.hidden >= 1, T('E1 Not now tells the challenger "declined" and closes the dialog'), J(cr.ev));
    const again = P.createChallenge({ lobbies: cr.lob, target: cr.board(), name: 'Cara', rec: null, now: w.c.now, timers: w.c.timers, on: { state() {}, accepted() {}, failed: (x) => cr.ev.failed.push(x) } });
    await again.ready;
    ok(o.d.shown.length === 1 && cr.ev.failed.join() === 'declined,declined', T('E2 the same person asking again straight away is told no without a dialog'), J([o.d.shown.length, cr.ev.failed]));
    w.c.advance(21000);
    const third = P.createChallenge({ lobbies: cr.lob, target: cr.board(), name: 'Cara', rec: null, now: w.c.now, timers: w.c.timers, on: { state() {}, accepted() {}, failed() {} } });
    await third.ready;
    ok(o.d.shown.length === 2, T('E3 after the quiet period the dialog can open again'), String(o.d.shown.length));
    third.cancel(); again.cancel();
    // the same request repeated after it was answered gets the SAME answer, never a new dialog
    const w2 = world(), o2 = owner(w2), cr2 = challenger(w2, o2, 25);
    o2.pres.start();
    const R = 'a'.repeat(16);
    rawChal(cr2.lob, o2.lob.sid, R); o2.pres.decline();
    const got = []; cr2.lob.onSignal((x) => got.push(x));
    rawChal(cr2.lob, o2.lob.sid, R); rawChal(cr2.lob, o2.lob.sid, R);
    ok(o2.d.shown.length === 1 && got.length === 2 && got.every((x) => x.k === 'dec' && x.why === 'declined'), T('E4 a repeat of an answered request is answered the same way, with no new dialog'), J([o2.d.shown.length, got]));
  }

  /* F. one dialog at a time; a flood is capped */
  {
    const w0 = world(), o0 = owner(w0), a0 = challenger(w0, o0, 60, 'Ann'), b0 = challenger(w0, o0, 61, 'Bob');
    o0.pres.start(); await a0.ch();
    const rb = 'b'.repeat(16), gotB = []; b0.lob.onSignal((x) => gotB.push(x));
    rawChal(b0.lob, o0.lob.sid, rb, { name: 'Bob' });
    o0.pres.decline();                               // Ann's dialog is dealt with; Bob was told busy a moment ago
    rawChal(b0.lob, o0.lob.sid, rb, { name: 'Bob' });
    ok(o0.d.shown.length === 1 && gotB.length === 2 && gotB.every((x) => x.k === 'dec' && x.why === 'busy'), T('F0 a request that was told busy gets the same answer if it is repeated, not a dialog of its own'), J([o0.d.shown.length, gotB]));
  }
  {
    const w = world(), o = owner(w), a = challenger(w, o, 26, 'Ann'), b = challenger(w, o, 27, 'Bob');
    o.pres.start();
    await a.ch();
    const cb = await b.ch();
    ok(b.ev.failed.join() === 'busy' && o.d.shown.length === 1 && o.pres.pending().s === a.lob.sid, T('F1 a second challenger while a dialog is up is told busy, and the dialog on screen is not replaced'), J([b.ev, o.pres.pending()]));
    o.pres.decline();
    cb.cancel();
    // the per-minute cap
    const w2 = world(), o2 = owner(w2); o2.pres.start();
    const outcomes = [];
    for (let i = 0; i < 9; i++) {
      const c = challenger(w2, o2, 100 + i, 'N' + i);
      const ev = c.ev; await c.ch();
      if (o2.pres.pending()) o2.pres.decline();
      outcomes.push(ev.failed.join());
    }
    ok(o2.d.shown.length === 6 && outcomes.slice(6).every((x) => x === 'busy'), T('F2 at most 6 dialogs per minute; the rest are told busy'), o2.d.shown.length + ' ' + J(outcomes));
    w2.c.advance(61000);
    const late = challenger(w2, o2, 200, 'Late'); await late.ch();
    ok(o2.d.shown.length === 7, T('F3 a minute later the owner can be asked again'), String(o2.d.shown.length));
  }

  /* G. nobody answers */
  {
    const w = world(), o = owner(w), cr = challenger(w, o, 28);
    o.pres.start();
    await cr.ch();
    w.c.advance(24999);
    ok(o.pres.pending() !== null && cr.ev.failed.length === 0, T('G1 25 s is the owner\'s time to answer'), '');
    w.c.advance(3000);
    ok(o.pres.pending() === null && o.d.hidden >= 1 && cr.ev.failed.join() === 'declined', T('G2 a dialog nobody answers is closed and declined (the challenger is told, not left hanging)'), J(cr.ev));
    // no owner at all: the challenger gives up by itself
    const w2 = world(); const ghost = w2.mk(5), me = w2.mk(6);
    ghost.lob.host({ room: 'HGHST', name: 'Ghost', fmt: '3v3', rom: ROM, fp: FP, rs: RS, h: true });     // listed, but nobody is listening to challenges
    const ev = { failed: [] };
    const gc = P.createChallenge({ lobbies: me.lob, target: me.lob.list()[0], name: 'Me', rec: null, now: w2.c.now, timers: w2.c.timers, on: { state() {}, accepted() {}, failed: (x) => ev.failed.push(x) } });
    await gc.ready;
    w2.c.advance(26000);
    ok(ev.failed.length === 0, T('G3 the challenger waits a little longer than the owner\'s own timeout'), J(ev));
    w2.c.advance(2000);
    ok(ev.failed.join() === 'timeout', T('G4 then says nobody answered'), J(ev));
    ghost.lob.close();
    ok(w2.c.count() === 0, T('G5 and nothing is left running (the ghost\'s own beacon aside)'), String(w2.c.count()));
  }

  /* H. cancel, and "ok" with no room */
  {
    const w = world(), o = owner(w), cr = challenger(w, o, 29);
    o.pres.start();
    const c1 = await cr.ch();
    c1.cancel();
    ok(o.pres.pending() === null && o.d.hidden >= 1 && cr.ev.failed.length === 0, T('H1 cancelling closes the owner\'s dialog and is not a failure'), J(cr.ev));
    // a "can" from somebody else does not close it
    const w2 = world(), o2 = owner(w2), a = challenger(w2, o2, 30, 'Ann'), x = challenger(w2, o2, 31, 'Xan');
    o2.pres.start(); await a.ch();
    x.lob.signal('can', { to: o2.lob.sid, r: o2.pres.pending().r });
    ok(o2.pres.pending() !== null, T('H2 a cancel from somebody who is not the asker does not close the dialog'), '');
    // ok, then no room ever comes
    const w3 = world(), o3 = owner(w3), c3 = challenger(w3, o3, 32);
    o3.pres.start(); const h = await c3.ch(); o3.pres.accept();
    const chals = () => c3.m.sent.filter((m) => m.k === 'chal').length;
    const n = chals(); w3.c.advance(30000);
    ok(chals() === n && c3.ev.failed.length === 0, T('H3 after "ok" the challenge is not repeated, and the challenger keeps waiting for the room'), chals() - n + ' ' + J(c3.ev));
    w3.c.advance(31000);
    ok(c3.ev.failed.join() === 'timeout' && h.done(), T('H4 ... for 60 s, then says the room never came'), J(c3.ev));
  }

  /* I. forged answers */
  {
    const w = world(), o = owner(w), cr = challenger(w, o, 33);
    o.pres.start();
    const c1 = await cr.ch();
    const stranger = w.mk(34), strangerPage = w.mk(35);
    stranger.lob.signal('dec', { to: cr.lob.sid, r: c1.r, why: 'declined' });
    stranger.lob.signal('ok', { to: cr.lob.sid, r: c1.r });
    ok(cr.ev.failed.length === 0 && cr.ev.states.length === 0, T('I1 a decline or an ok from somebody who was not asked changes nothing'), J(cr.ev));
    strangerPage.lob.signal('acc', { to: cr.lob.sid, r: 'e'.repeat(16), pk: PK_FAKE, iv: 'I'.repeat(16), ct: 'C'.repeat(32) });
    await quiet();
    ok(cr.ev.accepted.length === 0, T('I2 a "come in" for a different request is ignored'), J(cr.ev));
    // ... even one that IS sealed to the challenger, if its envelope names another request (the request id is checked before anything is opened, not only inside the seal)
    const wrongEnvelope = await P.sealRoom({ to: cr.lob.sid, r: c1.r, ck: cr.chalSent().pk, room: 'AWRNG' });
    strangerPage.lob.signal('acc', { to: cr.lob.sid, r: 'e'.repeat(16), ...wrongEnvelope });
    await quiet();
    ok(cr.ev.accepted.length === 0 && !c1.done(), T('I2b a properly sealed room inside an envelope for another request is ignored'), J(cr.ev));
    o.pres.accept();
    ok(cr.ev.accepted.length === 0 && cr.ev.states.join() === 'accepted', T('I3 and the challenger still waits for the real one'), J(cr.ev));
    // a stranger who READ the challenge (it is public) knows the request id and the challenger's sender id, but cannot make a "come in" the challenger will believe unless it is sealed to the challenger's key
    strangerPage.lob.signal('acc', { to: cr.lob.sid, r: c1.r, pk: PK_FAKE, iv: 'I'.repeat(16), ct: 'C'.repeat(32) });
    await quiet();
    ok(cr.ev.accepted.length === 0, T('I4 a forged "come in" for THIS request that is not a sealed room is NOT believed'), J(cr.ev));
    const other = await P.makeKeyPair();
    const toSomeoneElse = await P.sealRoom({ to: cr.lob.sid, r: c1.r, ck: other.pk, room: 'AEVIL' });         // sealed, but to a key the challenger does not hold
    strangerPage.lob.signal('acc', { to: cr.lob.sid, r: c1.r, ...toSomeoneElse });
    await quiet();
    ok(cr.ev.accepted.length === 0 && !c1.done(), T('I5 ... nor one sealed to somebody else\'s key, and the challenger is still waiting'), J(cr.ev));
    const goodSeal = await P.sealRoom({ to: cr.lob.sid, r: c1.r, ck: cr.chalSent().pk, room: 'AEVIL' });
    strangerPage.lob.signal('acc', { to: cr.lob.sid, r: c1.r, ...goodSeal });
    await settle(() => cr.ev.accepted.length > 0);
    // KNOWN LIMIT, written down so the docs stay true: the challenge carries the challenger's PUBLIC key, so a stranger who read it can seal a pointer to THEIR OWN room and the challenger will follow it.
    // What sealing buys is that nobody learns the REAL room (and so cannot take the seat); the challenger would meet a stranger's name in the handshake and the room's own admission.
    ok(cr.ev.accepted.join() === 'AEVIL', T('I6 (known limit) a stranger who read the challenge CAN seal a pointer to their own room; it is not authenticated, only secret'), J(cr.ev));
  }

  /* J. stop, refresh */
  {
    const w = world(), o = owner(w), cr = challenger(w, o, 36);
    o.pres.start();
    await cr.ch();
    ok(o.pres.stop() === true && o.pres.isOn() === false && o.pres.pending() === null && cr.board() === null, T('J1 stopping closes an open dialog and takes the listing down'), '');
    const later = challenger(w, o, 37, 'Late');
    ok(later.board() === null, T('J2 and nothing is listed any more'), '');
    ok(o.pres.stop() === false, T('J3 stopping twice is a no-op'), '');
    const w2 = world(), o2 = owner(w2), c2 = challenger(w2, o2, 38);
    o2.pres.start();
    const labelBefore = c2.board().room;
    o2.setIdent({ name: 'Olivia', fmt: '6v6', rec: [9, 9], rom: ROM, fp: FP, rs: RS }); o2.pres.refresh();
    const g = c2.board();
    ok(g && g.name === 'Olivia' && g.fmt === '6v6' && J(g.rec) === '[9,9]' && g.room === labelBefore && c2.lob.list().length === 1, T('J4 a rename or a new record is re-listed under the SAME label'), J(g));
    o2.pres.stop(); w2.c.advance(100000);
    ok(w2.c.count() === 0, T('J5 nothing is left running'), String(w2.c.count()));
  }

  /* K. the accept token: the only thing that lets an address host an accepted challenge */
  {
    const FOR = 'a'.repeat(16), RQ = 'b'.repeat(16), NOW = WALL0;
    const mem = memStorage();
    ok(P.writeAcceptToken(mem, { for: FOR, rq: RQ, ck: PK_FAKE }, NOW) === true && JSON.parse(mem.store[P.ACCEPT_KEY]).ck === PK_FAKE, T('K1 a token is stored under arena.accept with who, which request, the key and the time'), J(mem.store));
    const got = P.takeAcceptToken(mem, { for: FOR, rq: RQ }, NOW + 1000);
    ok(got && got.ck === PK_FAKE && !(P.ACCEPT_KEY in mem.store), T('K2 taking it gives the challenger\'s key and removes it in the same step'), J([got, mem.store]));
    ok(P.takeAcceptToken(mem, { for: FOR, rq: RQ }, NOW + 2000) === null, T('K3 a token is good ONCE: the address that used it is a plain address from then on'), '');
    ok(P.takeAcceptToken(memStorage(), { for: FOR, rq: RQ }, NOW) === null && P.takeAcceptToken(null, { for: FOR, rq: RQ }, NOW) === null, T('K3b no token, or no storage: nothing'), '');
    P.writeAcceptToken(mem, { for: FOR, rq: RQ, ck: PK_FAKE }, NOW);
    ok(P.takeAcceptToken(mem, { for: 'c'.repeat(16), rq: RQ }, NOW) === null && P.takeAcceptToken(mem, { for: FOR, rq: 'c'.repeat(16) }, NOW) === null && P.ACCEPT_KEY in mem.store, T('K4 a token for another challenger or another request is refused, and left for its own page'), J(mem.store));
    ok(P.takeAcceptToken(mem, { for: FOR, rq: RQ }, NOW + 5) !== null, T('K4b ... which can still take it'), '');
    P.writeAcceptToken(mem, { for: FOR, rq: RQ, ck: PK_FAKE }, NOW);
    ok(P.takeAcceptToken(mem, { for: FOR, rq: RQ }, NOW + P.ACCEPT_MAX_AGE_MS + 1) === null && !(P.ACCEPT_KEY in mem.store), T('K5 a token older than 2 minutes is refused (and removed): it was not written for this page load'), J(mem.store));
    P.writeAcceptToken(mem, { for: FOR, rq: RQ, ck: PK_FAKE }, NOW);
    ok(P.takeAcceptToken(mem, { for: FOR, rq: RQ }, NOW + P.ACCEPT_MAX_AGE_MS) !== null, T('K5b ... exactly 2 minutes old is still fresh'), '');
    P.writeAcceptToken(mem, { for: FOR, rq: RQ, ck: PK_FAKE }, NOW + 60000);
    ok(P.takeAcceptToken(mem, { for: FOR, rq: RQ }, NOW) === null, T('K6 a token dated in the future (a clock that moved, or a made-up one) is refused'), '');
    const junk = ['', 'x', '[]', 'null', '7', '{"for":1}', J({ for: FOR, rq: RQ, ck: 'nope', at: NOW }), J({ for: FOR, rq: RQ, ck: PK_FAKE, at: 'now' }), J({ for: 'zz', rq: RQ, ck: PK_FAKE, at: NOW })];
    const taken = junk.filter((j) => { mem.store[P.ACCEPT_KEY] = j; const r = P.takeAcceptToken(mem, { for: FOR, rq: RQ }, NOW); return r !== null || P.ACCEPT_KEY in mem.store; });
    ok(taken.length === 0, T('K7 junk in the slot is refused and cleared (' + junk.length + ' kinds)'), J(taken));
    const badWrites = [{ for: 'x', rq: RQ, ck: PK_FAKE }, { for: FOR, rq: 'x', ck: PK_FAKE }, { for: FOR, rq: RQ, ck: 'nope' }, { for: FOR, rq: RQ, ck: undefined }, { for: FOR, rq: RQ, ck: PK_FAKE + 'x' }];
    const m2 = memStorage();
    ok(badWrites.every((b) => P.writeAcceptToken(m2, b, NOW) === false) && P.writeAcceptToken(m2, { for: FOR, rq: RQ, ck: PK_FAKE }, NaN) === false && Object.keys(m2.store).length === 0 && P.writeAcceptToken(null, { for: FOR, rq: RQ, ck: PK_FAKE }, NOW) === false, T('K8 a token that names nobody, or has no key, is never written'), J(m2.store));
    const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
    ok(P.writeAcceptToken(blocked, { for: FOR, rq: RQ, ck: PK_FAKE }, NOW) === false && P.takeAcceptToken(blocked, { for: FOR, rq: RQ }, NOW) === null, T('K9 a storage that throws neither writes nor yields a token'), '');
    const stuck = memStorage(); stuck.removeItem = () => {};            // a storage that will not forget
    P.writeAcceptToken(stuck, { for: FOR, rq: RQ, ck: PK_FAKE }, NOW);
    ok(P.takeAcceptToken(stuck, { for: FOR, rq: RQ }, NOW) === null, T('K10 a token that cannot be removed is not used (one use, or none)'), '');
    const unrem = memStorage(); const real = unrem.removeItem; let boom = false; unrem.removeItem = (k) => { if (boom) throw new Error('blocked'); return real(k); };
    P.writeAcceptToken(unrem, { for: FOR, rq: RQ, ck: PK_FAKE }, NOW); boom = true;
    ok(P.takeAcceptToken(unrem, { for: FOR, rq: RQ }, NOW) === null, T('K11 ... nor one whose removal throws'), '');
  }

  /* L. the sealed room: real WebCrypto */
  {
    const cr = globalThis.crypto;
    const TO = 'a'.repeat(16), R = 'b'.repeat(16);
    ok(P.canSeal(cr) === true && P.canSeal(null) === false && P.canSeal({}) === false && P.canSeal({ subtle: {}, getRandomValues() {} }) === false && P.canSeal({ getRandomValues() {} }) === false, T('L1 a browser can seal if it has WebCrypto with key generation and derivation, and not otherwise'), '');
    const A = await P.makeKeyPair(cr);                // the challenger
    ok(L.PK_RE.test(A.pk) && A.priv.extractable === false && A.priv.type === 'private', T('L2 a one-time key pair: the public half is the board\'s shape, the private half cannot be exported'), A.pk);
    const sealed = await P.sealRoom({ crypto: cr, to: TO, r: R, ck: A.pk, room: 'aq777' });
    const msg = { t: 'arenaopen', v: 1, k: 'acc', s: 'c'.repeat(16), to: TO, r: R, ...sealed };
    ok(L.checkBeacon(msg).ok && L.PK_RE.test(sealed.pk) && sealed.pk !== A.pk, T('L3 what sealRoom makes is a valid "come in" for the board, under the owner\'s OWN one-time key'), J(sealed));
    ok(await P.unsealRoom({ crypto: cr, priv: A.priv, to: TO, r: R, msg: sealed }) === 'AQ777', T('L4 the challenger opens it with its private key: the room, upper case'), '');
    ok(!J(msg).toUpperCase().includes('AQ777') && !J(msg).includes('QVE3Nzc') && !J(msg).includes('YXE3Nzc'), T('L5 the room is not in what goes on the board, in upper or lower case or as plain base64'), J(msg));
    const E = await P.makeKeyPair(cr);                // an observer, with a key pair of its own
    ok(await P.unsealRoom({ crypto: cr, priv: E.priv, to: TO, r: R, msg: sealed }) === null, T('L6 an observer with another key pair cannot open it'), '');
    ok(await P.unsealRoom({ crypto: cr, priv: A.priv, to: TO, r: 'c'.repeat(16), msg: sealed }) === null && await P.unsealRoom({ crypto: cr, priv: A.priv, to: 'd'.repeat(16), r: R, msg: sealed }) === null, T('L7 it is bound to the request and to the challenger: replayed to another request or another browser it opens to nothing'), '');
    const flip = (s) => (s[0] === 'A' ? 'B' : 'A') + s.slice(1);
    const tampered = [{ ...sealed, ct: flip(sealed.ct) }, { ...sealed, iv: flip(sealed.iv) }, { ...sealed, pk: flip(sealed.pk) }, { ...sealed, ct: sealed.ct.slice(0, -2) }, { ...sealed, ct: 'C'.repeat(32) }];
    const opened = [];
    for (const t of tampered) { const r = await P.unsealRoom({ crypto: cr, priv: A.priv, to: TO, r: R, msg: t }); if (r !== null) opened.push(r); }
    ok(opened.length === 0, T('L8 a ciphertext, iv or key that was touched opens to nothing (' + tampered.length + ' ways), and never throws'), J(opened));
    ok(await P.unsealRoom({ crypto: cr, priv: A.priv, to: TO, r: R, msg: { pk: PK_FAKE, iv: sealed.iv, ct: sealed.ct } }) === null && await P.unsealRoom({ crypto: cr, priv: A.priv, to: TO, r: R, msg: null }) === null && await P.unsealRoom({ crypto: cr, priv: null, to: TO, r: R, msg: sealed }) === null, T('L9 a key of the right shape that is not a point on the curve, no message, no private key: nothing, no throw'), '');
    let rej = 0;
    for (const bad of [PK_FAKE, 'nope', undefined]) { try { await P.sealRoom({ crypto: cr, to: TO, r: R, ck: bad, room: 'AQ777' }); } catch (_e) { rej++; } }
    try { await P.sealRoom({ crypto: cr, to: TO, r: R, ck: A.pk, room: 'no' }); } catch (_e) { rej++; }
    ok(rej === 4, T('L10 sealing to a key that is not a usable P-256 point (or a room that is not a room) is refused'), String(rej));
    const again = await P.sealRoom({ crypto: cr, to: TO, r: R, ck: A.pk, room: 'AQ777' });
    ok(again.ct !== sealed.ct && again.iv !== sealed.iv && again.pk !== sealed.pk, T('L11 sealing the same room twice gives two different messages (fresh iv, fresh key): they cannot be matched'), '');
    // no WebCrypto: nothing is sent in the clear instead
    let threw = false; try { await P.sealRoom({ crypto: {}, to: TO, r: R, ck: A.pk, room: 'AQ777' }); } catch (_e) { threw = true; }
    ok(threw && await P.unsealRoom({ crypto: {}, priv: A.priv, to: TO, r: R, msg: sealed }) === null, T('L12 without WebCrypto sealing fails and opening yields nothing'), '');
    const w = world(), o = owner(w), cr1 = challenger(w, o, 70);
    o.pres.start();
    const ch0 = cr1.mkch({ crypto: {} });
    const okReady = await ch0.ready;
    await settle(() => cr1.ev.failed.length > 0);
    ok(okReady === false && cr1.ev.failed.join() === 'unsupported' && cr1.chalSent() === null && o.d.shown.length === 0 && ch0.done(), T('L13 a challenger without WebCrypto fails with "unsupported" and sends NOTHING (no challenge in the clear, no dialog on the owner\'s screen)'), J([cr1.ev, cr1.m.sent.length]));
    w.c.advance(100000);
    ok(cr1.ev.failed.length === 1, T('L14 and it fails once, not again when its timers would have run out'), J(cr1.ev));
    const pg = w.mk(71); const fails = [];
    const acc0 = P.createAcceptor({ lobbies: pg.lob, to: cr1.lob.sid, r: 'f'.repeat(16), room: 'AQ777', ck: A.pk, crypto: {}, timers: w.c.timers, onFail: (e) => fails.push(String(e && e.message)) });
    const accReady = await acc0.ready;
    ok(accReady === false && fails.length === 1 && acc0.live() === false && pg.m.sent.filter((x) => x.k === 'acc').length === 0, T('L15 an owner\'s page without WebCrypto sends no "come in" at all, says why, and stops'), J([fails, pg.m.sent.length]));
    const acc1 = P.createAcceptor({ lobbies: pg.lob, to: cr1.lob.sid, r: 'f'.repeat(16), room: 'AQ777', ck: undefined, timers: w.c.timers, onFail: (e) => fails.push('x') });
    await acc1.ready;
    ok(acc1.live() === false && fails.length === 2 && pg.m.sent.filter((x) => x.k === 'acc').length === 0, T('L16 ... and so does a page that was handed no key (a room is never sent in the clear instead)'), J(fails));
    // a challenge cancelled before its key pair exists is never sent
    const w2 = world(), o2 = owner(w2), c2 = challenger(w2, o2, 72);
    o2.pres.start();
    const early = c2.mkch(); early.cancel(); await early.ready;
    ok(c2.chalSent() === null && o2.d.shown.length === 0, T('L17 a challenge cancelled before its one-time key existed is never sent'), J(c2.m.sent.map((x) => x.k)));
  }

  /* M. who an open game may let in without Allow */
  {
    const base = { open: true, invite: null, nm: null, closed: false, admitted: false, admittedId: null };
    const ID = 'a'.repeat(16), OTHER = 'b'.repeat(16);
    ok(P.admission(base, ID) === 'approve' && P.admission({ ...base, open: false, invite: { for: 'x' } }, ID) === 'approve', T('M1 the first player to knock at an open or an invited game is let in'), '');
    ok(P.admission({ ...base, open: false }, ID) === 'deny', T('M2 a game that is neither open nor invited lets nobody in by itself'), '');
    ok(P.admission({ ...base, admitted: true, admittedId: ID }, OTHER) === 'deny', T('M3 once somebody is in, the next to knock is told the game is taken'), '');
    ok(P.admission({ ...base, admitted: true, admittedId: ID }, ID) === 'return', T('M4 ... but the one who is in may knock again (a retry that crossed the offer)'), '');
    ok(P.admission({ ...base, nm: {}, admitted: true, admittedId: ID }, ID) === 'return', T('M5 a match exists and the host\'s Session was REBUILT: the player in the match is let back in, not told the game is taken'), '');
    ok(P.admission({ ...base, nm: {}, admitted: true, admittedId: ID }, OTHER) === 'deny', T('M6 ... and a THIRD player is still told it is taken'), '');
    ok(P.admission({ ...base, nm: {}, admitted: false, admittedId: null }, ID) === 'deny', T('M7 a match with nobody recorded as let in lets nobody else in (online.js records a player the library re-admitted by itself through its peer-joined event, so that state is not reached that way; this is the safe answer if it ever is)'), '');
    ok(P.admission({ ...base, closed: true, admitted: true, admittedId: ID }, ID) === 'deny' && P.admission({ ...base, closed: true }, ID) === 'deny', T('M8 a page that has been closed lets nobody in'), '');
    ok(P.admission({ ...base, nm: {} , admitted: true, admittedId: ID }, undefined) === 'deny' && P.admission({ ...base, nm: {} , admitted: true, admittedId: null }, null) === 'deny', T('M9 a knock with no id is never "the same player"'), '');
  }

  /* N. a challenge that arrives after its own cancel */
  {
    const w = world(), o = owner(w), cr = challenger(w, o, 40), xan = challenger(w, o, 41, 'Xan');
    o.pres.start();
    const R = 'c'.repeat(16);
    cr.lob.signal('can', { to: o.lob.sid, r: R });
    rawChal(cr.lob, o.lob.sid, R);
    ok(o.d.shown.length === 0 && o.pres.pending() === null && cr.m.sent.filter((x) => x.k === 'chal').length === 1, T('N1 a challenge that arrives AFTER its own cancel (the slower broker) opens no dialog'), J(o.d.shown));
    const got = []; cr.lob.onSignal((x) => got.push(x));
    rawChal(cr.lob, o.lob.sid, R);
    ok(o.d.shown.length === 0 && got.length === 0, T('N2 ... nor on its repeats, and the owner does not answer it (the asker has gone)'), J(got));
    // somebody else cancelling that request id is not the asker cancelling it
    const R2 = 'd'.repeat(16);
    xan.lob.signal('can', { to: o.lob.sid, r: R2 });
    rawChal(cr.lob, o.lob.sid, R2);
    ok(o.d.shown.length === 1 && o.d.shown[0].r === R2, T('N3 a cancel from another sender does not silence the real asker\'s challenge'), J(o.d.shown));
    // a cancel closes the dialog (as before) and a slow copy of the challenge after it opens nothing
    cr.lob.signal('can', { to: o.lob.sid, r: R2 });
    rawChal(cr.lob, o.lob.sid, R2);
    ok(o.pres.pending() === null && o.d.shown.length === 1, T('N4 a cancel closes the dialog, and a slow copy of the challenge after it does not bring it back'), J([o.pres.pending(), o.d.shown.length]));
    // and a request that WAS cancelled never reaches the owner's "answered" memory as a no
    const R3 = 'e'.repeat(16);
    rawChal(cr.lob, o.lob.sid, R3); o.pres.decline();
    const got3 = []; cr.lob.onSignal((x) => got3.push(x));
    rawChal(cr.lob, o.lob.sid, R3);
    ok(got3.length === 1 && got3[0].k === 'dec', T('N5 a request that was not cancelled is still answered the same way when it repeats'), J(got3));
  }

  /* O. the address of an accepted-challenge page (online.js) */
  {
    const F = 'a'.repeat(16), Q = 'b'.repeat(16);
    const bare = O.parseOnlineQuery('?online=1&auto=host&for=' + F + '&rq=' + Q + '&format=3v3');
    ok(bare && bare.role === 'host' && bare.room === null && bare.auto && bare.auto.for === F && bare.auto.rq === Q, T('O1 a bare accepted-challenge address parses as one (whether it is believed is the token\'s job, not the parser\'s)'), J(bare));
    const lib = O.canonicalAddress('http://x/pokemonarena/battle.html?online=1&auto=host&for=' + F + '&rq=' + Q + '&ck=' + encodeURIComponent(PK_FAKE) + '&format=3v3&net=local#top', 'host', 'ABCDE');
    const u = new URL(lib, 'http://x');
    ok(['online', 'auto', 'for', 'rq', 'ck', 'join'].every((k) => !u.searchParams.has(k)) && u.searchParams.get('np') === 'ABCDE' && u.searchParams.get('host') === '1' && u.searchParams.get('format') === '3v3' && u.searchParams.get('net') === 'local' && u.hash === '#top' && u.pathname === '/pokemonarena/battle.html', T('O2 once the room is open the address keeps the room and the role and drops everything that started the game (online, auto, for, rq, ck)'), lib);
    const back = O.parseOnlineQuery(u.search);
    ok(back && back.role === 'host' && back.room === 'ABCDE' && back.auto === null, T('O3 so a reload, Back or a restored tab parses as an ORDINARY host of that room (its resume record is found, no second room is opened)'), J(back));
    const stale = O.parseOnlineQuery('?auto=host&for=' + F + '&rq=' + Q + '&format=3v3&np=ABCDE&host=1');
    ok(stale && stale.role === 'host' && stale.room === 'ABCDE' && stale.auto === null, T('O4 an address that still has auto beside a room (an older tab) is the room\'s ordinary host address: a room in the address always wins'), J(stale));
    const gu = new URL(O.canonicalAddress('http://x/pokemonarena/battle.html?online=1&net=local', 'guest', 'QWERT'), 'http://x');
    ok(gu.searchParams.get('np') === 'QWERT' && gu.searchParams.get('join') === '1' && !gu.searchParams.has('host') && !gu.searchParams.has('online'), T('O5 a guest\'s address names the room and join, not host'), gu.search);
    const bad = O.parseOnlineQuery('?online=1&auto=host&for=zz&rq=' + Q);
    ok(bad && bad.error, T('O6 an auto address that does not name a challenger and a request is an error, not a game'), J(bad));
    // the address a board page goes BACK to when a join it launched from the list ends without a match (Cancel, a game that never answered): launch() had rewritten it to ?np=ROOM&join=1
    const joined = O.boardAddress('http://x/pokemonarena/battle.html?np=AGHOS&join=1&net=local&anim=0&team=ARENA1.abc&format=6v6#top');
    const ju = new URL(joined, 'http://x');
    ok(['np', 'join', 'host', 'auto', 'for', 'rq', 'ck'].every((k) => !ju.searchParams.has(k)) && ju.searchParams.get('online') === '1' && ju.searchParams.get('net') === 'local' && ju.searchParams.get('anim') === '0' && ju.searchParams.get('team') === 'ARENA1.abc' && ju.searchParams.get('format') === '6v6' && ju.hash === '#top' && ju.pathname === '/pokemonarena/battle.html', T('O7 the board address drops the room and the role of a join that ended and keeps the rest (online=1 is back; net, anim, team, format, #hash stay)'), joined);
    const back2 = O.parseOnlineQuery(ju.search);
    ok(back2 && back2.role === null && back2.room === null && back2.auto === null && !back2.error, T('O8 so a RELOAD of it is the plain Play online page again (no role, no room: the open games board shows), not the join-by-code form with the dead room filled in'), J(back2));
    const fromAuto = new URL(O.boardAddress('http://x/pokemonarena/battle.html?online=1&auto=host&for=' + F + '&rq=' + Q + '&ck=' + encodeURIComponent(PK_FAKE) + '&format=3v3&np=ABCDE&host=1'), 'http://x');
    ok(['auto', 'for', 'rq', 'ck', 'np', 'host'].every((k) => !fromAuto.searchParams.has(k)) && O.parseOnlineQuery(fromAuto.search).role === null, T('O9 nothing that starts a game (auto, for, rq, ck) or names a room survives into the board address'), fromAuto.search);
    const plain = O.boardAddress('http://x/pokemonarena/battle.html?online=1&net=local');
    ok(plain === '/pokemonarena/battle.html?online=1&net=local' && O.boardAddress('http://x' + plain) === plain, T('O10 the plain board address is its own board address (idempotent)'), plain);
    const hold = (qs) => (O.parseOnlineQuery(qs).limits || {}).holdMs;
    ok(hold('?online=1&net=local&openhold=1500') === 1500 && hold('?online=1&openhold=1500') === undefined && hold('?online=1&net=local&openhold=299') === undefined && hold('?online=1&net=local&openhold=120001') === undefined && hold('?online=1&net=local&openhold=x') === undefined, T('O11 the seat-holding clock can be shortened for the same-browser transport only, within 300 ms to 2 min'), J([hold('?online=1&net=local&openhold=1500'), hold('?online=1&openhold=1500')]));
  }
}

/* ------------------------------------------------------------------------------------------------ the mutants */
// Each breaks ONE guarantee in a copy of presence.js (file: 'online.js' for the few pure parts of the page file) and the suite must then fail.
const MUTANTS = [
  { id: 'cooldown-ignored', why: 'somebody told no can ask again at once', from: 'if (told.has(p.s) && t - told.get(p.s) < timing.cooldownMs)', to: 'if (false)' },
  { id: 'repeat-reopens-dialog', why: 'a repeated challenge opens the dialog again', from: 'if (pending && pending.r === p.r) return;', to: '' },
  { id: 'answered-forgotten', why: 'a repeat of an answered request is treated as a new one', from: 'if (answered.has(p.r)) {', to: 'if (false) {' },
  { id: 'busy-replaces-dialog', why: 'a second challenger replaces the dialog the owner is looking at', from: 'if (pending || shown.length >= timing.perMinute)', to: 'if (shown.length >= timing.perMinute)' },
  { id: 'no-flood-cap', why: 'any number of dialogs per minute', from: 'if (pending || shown.length >= timing.perMinute)', to: 'if (pending)' },
  { id: 'no-dialog-timeout', why: 'a dialog nobody answers stays for ever', from: 'pendingTimer = T.setTimeout(() => { if (pending && pending.r === p.r) decline(); }, timing.answerMs);', to: '' },
  { id: 'cancel-from-anyone', why: 'anybody can close the dialog on screen', from: 'if (pending && pending.r === m.r && pending.s === m.s) dismiss();', to: 'if (pending && pending.r === m.r) dismiss();' },
  { id: 'accept-silent', why: 'Accept does not tell the challenger', from: "    reply('ok', p);\n    const href", to: '    const href' },
  { id: 'decline-silent', why: 'Not now does not tell the challenger', from: "    reply('dec', p, { why: 'declined' });\n    return true;", to: '    return true;' },
  { id: 'accept-keeps-listing', why: 'the listing stays up after the owner has left for the battle page', from: "    stop();                                    // the listing comes down: this page is about to go\n", to: '' },
  { id: 'href-unencoded', why: 'the Accept address carries unencoded text', from: "encodeURIComponent(r)", to: 'r' },
  { id: 'stop-leaves-dialog', why: 'switching off leaves a dialog open', from: '    if (off) { off(); off = null; }\n    dismiss();', to: '    if (off) { off(); off = null; }' },
  { id: 'challenge-never-times-out', why: 'a challenge to nobody waits for ever', from: 'wait = T.setTimeout(() => fail(\'timeout\'), timing.answerMs + 2000);', to: '' },
  { id: 'ok-from-anyone', why: 'an ok or a decline from somebody who was not asked is believed', from: 'if (m.s !== target.s) return;', to: '' },
  { id: 'acc-any-request', why: 'a "come in" for another request is believed', from: 'if (finished || m.r !== r) return;', to: 'if (finished) return;' },
  { id: 'challenge-repeats-after-ok', why: 'the challenge keeps being sent after it was accepted', from: 'okSeen = true; T.clearInterval(resend); resend = 0;', to: 'okSeen = true;' },
  { id: 'no-room-timeout', why: 'an accepted challenge whose room never comes waits for ever', from: 'T.clearTimeout(wait); wait = T.setTimeout(() => fail(\'timeout\'), timing.connectMs);', to: 'T.clearTimeout(wait);' },
  { id: 'cancel-silent', why: 'cancelling does not close the owner\'s dialog', from: "try { lobbies.signal('can', { to: target.s, r }); }", to: 'try { /* nothing */ }' },
  { id: 'acceptor-never-stops', why: 'the owner\'s battle page says "come in" for ever', from: 'limit = T.setTimeout(stop, timing.accForMs);', to: '' },
  { id: 'refresh-new-label', why: 'a re-listing gets a new label, so the old entry lingers', from: 'if (label === null) label = residentLabel(rnd);', to: 'label = residentLabel(rnd);' },
  { id: 'storage-throws', why: 'a browser that blocks storage breaks the page', from: "export function isOpen(storage) { try { return !!storage && storage.getItem(OPEN_KEY) === '1'; } catch (_e) { return false; } }", to: "export function isOpen(storage) { return !!storage && storage.getItem(OPEN_KEY) === '1'; }" },
  // ---- the hand-off: secrecy and who may host
  { id: 'seal-unbound', why: 'a sealed room can be replayed to another request or another challenger', from: "enc.encode('pokemonarena/acc/1|' + r + '|' + to)", to: "enc.encode('pokemonarena/acc/1')" },
  { id: 'seal-fixed-iv', why: 'every sealed room reuses one iv', from: 'const iv = cr.getRandomValues(new Uint8Array(12));', to: 'const iv = new Uint8Array(12);' },
  { id: 'unseal-accepts-anything', why: 'the challenger believes a "come in" it cannot open', from: "    const room = dec.decode(pt);\n    return ROOM_RE.test(room) ? room.toUpperCase() : null;\n  } catch (_e) { return null; }", to: "    const room = dec.decode(pt);\n    return ROOM_RE.test(room) ? room.toUpperCase() : null;\n  } catch (_e) { return 'AQ777'; }" },
  { id: 'challenge-without-crypto', why: 'a challenger without WebCrypto sends its challenge anyway', from: "    kp = await makeKeyPair(cr);                    // no WebCrypto: this throws, and nothing at all is sent", to: "    try { kp = await makeKeyPair(cr); } catch (_e) { kp = { pk: 'A'.repeat(43) + '.' + 'B'.repeat(43) }; }" },
  { id: 'accept-without-token', why: 'Accept does not leave the token the next page needs', from: 'if (!writeAcceptToken(store, { for: p.s, rq: p.r, ck: p.pk }, wallClock())) {', to: 'if (false) {' },
  { id: 'token-monotonic-clock', why: 'the token is stamped with the monotonic clock, which means nothing to the next page', from: 'ck: p.pk }, wallClock())', to: 'ck: p.pk }, clock())' },
  { id: 'token-wrong-key', why: 'the token carries somebody else\'s key', from: 'ck: p.pk }, wallClock())', to: 'ck: PK_RE_SAMPLE }, wallClock())' },
  { id: 'token-reusable', why: 'a token is not removed when it is used', from: '    storage.removeItem(ACCEPT_KEY);                                                           // used, expired or junk: gone either way\n', to: '' },
  { id: 'token-any-challenge', why: 'a token for another challenge opens this page\'s game', from: 'if (shaped && fresh && (t.for !== forSid || t.rq !== rq)) return null;', to: '' },
  { id: 'token-never-expires', why: 'an old token is as good as a new one', from: 'const fresh = shaped && age >= -5000 && age <= maxAgeMs;', to: 'const fresh = shaped;' },
  { id: 'token-future', why: 'a token dated in the future is accepted', from: 'age >= -5000 && age <= maxAgeMs', to: 'age <= maxAgeMs' },
  { id: 'token-unremovable-used', why: 'a token that cannot be removed is used anyway', from: "    if (left !== null && left !== undefined) return null;                                     // it would not go: it must not be usable twice\n", to: '' },
  { id: 'token-no-shape', why: 'any key is accepted into a token', from: "typeof t.ck === 'string' && PK_RE.test(t.ck) && Number.isFinite(t.at);", to: 'Number.isFinite(t.at);' },
  { id: 'admission-denies-returning', why: 'a host Session rebuilt mid-match denies the player who is in the match', from: "if (g.nm) return same ? 'return' : 'deny';", to: "if (g.nm) return 'deny';" },
  { id: 'admission-admits-third', why: 'a rebuilt Session lets any third player into the match', from: "if (g.nm) return same ? 'return' : 'deny';", to: "if (g.nm) return 'return';" },
  { id: 'admission-second-knocker', why: 'an open game lets a second player in', from: "if ((g.open || g.invite) && !g.admitted) return 'approve';", to: "if (g.open || g.invite) return 'approve';" },
  { id: 'admission-closed', why: 'a closed page still lets people in', from: "if (g.closed) return 'deny';", to: '' },
  { id: 'admission-no-id', why: 'a knock with no id is taken for the player who is in', from: 'const same = !!g.admittedId && reqId === g.admittedId;', to: 'const same = reqId === g.admittedId;' },
  { id: 'cancel-not-remembered', why: 'a challenge that arrives after its own cancel opens a dialog nobody can answer', from: "rememberCancel(m.s + ':' + m.r); ", to: '' },
  { id: 'cancelled-still-shown', why: 'the memory of cancelled requests is never consulted', from: "    if (cancelled.has(p.s + ':' + p.r)) return;                                                                                     // withdrawn before this copy arrived\n", to: '' },
  { id: 'cancel-by-request-only', why: 'anybody\'s cancel of a request id silences the real asker', from: "rememberCancel(m.s + ':' + m.r); ", to: "rememberCancel(':' + m.r); " },
  { id: 'canonical-keeps-auto', why: 'the address after the room opens still says auto=host, so a reload opens a SECOND room', file: 'online.js', from: "['online', 'host', 'join', 'auto', 'for', 'rq', 'ck']", to: "['online', 'host', 'join']" },
  { id: 'canonical-keeps-key', why: 'the challenger\'s key stays in the address', file: 'online.js', from: "'auto', 'for', 'rq', 'ck']", to: "'auto', 'for', 'rq']" },
  { id: 'auto-beats-room', why: 'an address with both a room and auto=host forgets the room (the reload cannot find its record)', file: 'online.js', from: "if (q.get('auto') === 'host' && np === null) {", to: "if (q.get('auto') === 'host') {" },
  { id: 'board-address-keeps-room', why: 'after a cancelled join the address still names the dead room, so a reload opens the join-by-code form with it filled in', file: 'online.js', from: "['np', 'host', 'join', 'rq', 'for', 'ck', 'auto']", to: "['host', 'join', 'rq', 'for', 'ck', 'auto']" },
  { id: 'board-address-keeps-role', why: 'after a cancelled join the address still says join=1, so a reload is a guest page and the board is hidden', file: 'online.js', from: "['np', 'host', 'join', 'rq', 'for', 'ck', 'auto']", to: "['np', 'host', 'rq', 'for', 'ck', 'auto']" },
  { id: 'board-address-keeps-auto', why: 'the board address keeps the challenge that started a game', file: 'online.js', from: "['np', 'host', 'join', 'rq', 'for', 'ck', 'auto']", to: "['np', 'host', 'join', 'rq', 'for', 'ck']" },
  { id: 'board-address-no-online', why: 'the board address does not say online=1, so a reload is not the Play online page at all', file: 'online.js', from: "u.searchParams.set('online', '1');", to: '' },
  { id: 'hold-limit-unbounded', why: 'the seat-holding clock can be set to anything, a 0 ms hold included', file: 'online.js', from: 'Number.isInteger(hm) && hm >= 300 && hm <= 120000', to: 'Number.isInteger(hm)' },
];

async function loadFrom(dir, file) { return import(pathToFileURL(path.join(dir, file)).href + '?x=' + Math.random().toString(36).slice(2)); }
async function runMutants() {
  const out = [];
  for (const mu of MUTANTS) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-pres-mut-'));
    try {
      for (const f of fs.readdirSync(SRC)) { const p = path.join(SRC, f); if (fs.statSync(p).isFile() && f.endsWith('.js')) fs.copyFileSync(p, path.join(dir, f)); }
      const target = path.join(dir, mu.file || 'presence.js');
      const text = fs.readFileSync(target, 'utf8');
      const n = text.split(mu.from).length - 1;
      if (n !== 1) { out.push({ id: mu.id, killed: false, why: 'PATTERN FOUND ' + n + 'x (the mutant did not apply once)' }); continue; }
      let mutated = text.replace(mu.from, () => mu.to);
      if (mu.to.includes('PK_RE_SAMPLE')) mutated = mutated.replace('PK_RE_SAMPLE', "'A'.repeat(43) + '.' + 'B'.repeat(43)");
      fs.writeFileSync(target, mutated);
      const before = fail, saveQ = process.env.ARENA_QUIET; process.env.ARENA_QUIET = '1';
      let threw = null;
      try { const [L2, P2, O2] = await Promise.all([loadFrom(dir, 'openlobby.js'), loadFrom(dir, 'presence.js'), loadFrom(dir, 'online.js')]); await Promise.race([suite(L2, P2, O2, mu.id), new Promise((_r, rej) => setTimeout(() => rej(new Error('mutant run timed out')), 60000))]); } catch (e) { threw = e; }
      const killed = fail > before || !!threw;
      out.push({ id: mu.id, killed, why: mu.why, threw: threw ? String(threw.message || threw).slice(0, 80) : null });
      fail = before; failures.length = Math.min(failures.length, before);
      process.env.ARENA_QUIET = saveQ || '';
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  return out;
}

const L = await import(pathToFileURL(path.join(SRC, 'openlobby.js')).href);
const P = await import(pathToFileURL(path.join(SRC, 'presence.js')).href);
const O = await import(pathToFileURL(path.join(SRC, 'online.js')).href);
const t0 = Date.now();
await suite(L, P, O, '');
console.log(`presence: ${pass} passed, ${fail} failed (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
let survived = 0;
if (WANT_MUTANTS) {
  const keep = fail, keepFailures = failures.slice();
  const res = await runMutants();
  fail = keep; failures.length = 0; failures.push(...keepFailures);
  for (const m of res) { console.log((m.killed ? 'killed  ' : 'SURVIVED') + ' ' + m.id + ' -- ' + m.why + (m.threw ? ' (threw: ' + m.threw + ')' : '') + (m.killed ? '' : '  <-- the suite did not notice')); if (!m.killed) survived++; }
  console.log(`mutants: ${res.length - survived}/${res.length} killed`);
}
if (fail || survived) { console.log('\nFAILURES:\n  ' + failures.join('\n  ')); process.exit(1); }

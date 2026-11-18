// pokemonarena/js/center_net.js -- WHO IS IN THE TRAINER CENTER, and where they stand. The room's own messages, the roster built from them, and nothing else.
//
// The Center is one more topic on the public MQTT brokers lib/netplay.js and the open-games board (openlobby.js) already use (the same-browser transport is a BroadcastChannel, which is
// what the tests use). It carries only what you can SEE in the room: a trainer's name, their look (center_look.js: seven characters naming one of the ROM's overworld trainer sprites), the
// cell they stand on and which way they face, an emote (the number of one of the ROM's emote icons), and the id of their listing on the open-games board (`b`), so the page can tell which
// trainer in the room is which open game. Challenges and rooms are NOT here: a battle is asked for through the board (presence.js), so everything that protects a challenge (the sealed
// room, the accept token) is unchanged.
//
// VERSION 2 (the room in the hub's picture, drawn from the ROM): the cells are the ROM Pokemon Center's and a look is a ROM sprite, so a page of the first Trainer Center (version 1: a
// hand-drawn room and hand-drawn looks) must not mix with this one. The topic, the same-browser channel and the version in every message all changed; the messages themselves did not.
//
// THE ROOM IS HANDED IN, NOT WRITTEN HERE. Which cells can be stood on, which looks exist and how many emotes there are come from the ROM at run time (center_room.js roomFromWorld,
// center_look.js): this module is given them as RULES (roomRules) and holds nothing ROM-derived. Without rules every position, look and emote is refused.
//
//   ask   { s }                                   who is here? (a page that just came in; the others answer with `here`, after a little random wait)
//   here  { s, name, av, x, y, d, b?, rec? }      I am here, this is me (every TIMING.hereMs, and after an ask); a trainer drops out of the room TIMING.ttlMs after their last one
//   mv    { s, x, y, d }                          I stepped onto (x, y) facing d (or turned on the spot)
//   emo   { s, e }                                an emote (the ROM's emote icon number e) over my head for a moment
//   bye   { s }                                   I left (the page closed, or went to a battle)
//
// LIKE THE BOARD, EVERYTHING HERE IS ADVICE FROM STRANGERS. Every message is shape-checked (checkCenterMsg): a name that is not already safe text (what the board's cleanName leaves of it)
// is refused, a look that is not a valid code of a sprite a player can be is refused, a position that is not a cell of THIS room a trainer can stand on is refused, an emote that is not
// one of the ROM's is refused, one sender cannot send more than TIMING.perSenderMax messages a second,
// the whole room is cut off above TIMING.totalMax, and the roster holds at most TIMING.maxWalkers trainers. Nobody can move anybody but themselves (a sender id is just a claim,
// but the worst a copycat can do is draw a second trainer with the same name; talking to a trainer always goes through the board, where their own listing answers).
// There is no free text: an emote is the number of an icon.
//
// Pure: no DOM, no network, timers injected. tools/pokemonarena_center_test.mjs runs it in Node.

import { cleanName } from './netmatch.js';

export const CENTER_TOPIC = 'bemental/arena/center/2';
export const CENTER_CHANNEL = 'bemental-arena-center-2';      // the same-browser transport
export const KIND = 'arenactr';
export const VERSION = 2;
export const DIRS = Object.freeze(['down', 'up', 'left', 'right']);
export const TIMING = Object.freeze({
  hereMs: 3000,           // a trainer in the room says so this often
  ttlMs: 10000,           // ... and is gone this long after the last time
  askEveryMs: 20000,      // a page asks "who is here?" this often (a lost `here` is repaired by the next one anyway)
  answerGapMs: 1000,      // answer an ask at most this often
  jitterMs: 400,          // ... after a random wait up to this
  moveGapMs: 60,          // our own steps are sent at most this often (a step takes longer than this, so in practice every step goes)
  emoteGapMs: 900,        // our own emotes at most this often
  emoteShowMs: 2000,      // how long an emote stays over a head
  maxWalkers: 30,         // the room holds at most this many other trainers
  perSenderMax: 14,       // messages per second from one sender above this are dropped unread
  totalMax: 260,          // messages per second from everybody above this are dropped unread
  wireMax: 600,           // a message longer than this (characters, as it came off the broker) is junk
});

const HEX16 = /^[0-9a-f]{16}$/;
const REC_MAX = 999999;
const EMOTES_MAX = 64;
const POS_MAX = 255;
const bad = (why) => ({ ok: false, why });
const isDir = (d) => DIRS.includes(d);

/** The rules of no room at all: nothing can be stood on, nothing is a look, there is no emote. What checkCenterMsg uses when it is handed none. */
export const NO_ROOM = Object.freeze({ walkable: () => false, look: () => false, emotes: 0 });
/**
 * THE RULES OF A ROOM, from what the ROM says at run time. o: { walkable(x, y) -> can a trainer stand there (center_room.js createGrid(room).walkable), look(code) -> is it a look a player can
 * have (center_look.js isLook(code, room.looks)), emotes: how many emote icons there are (room.emotes) }. Anything left out refuses (NO_ROOM): rules never default to "anything goes".
 */
export function roomRules(o) {
  const r = o && typeof o === 'object' ? o : {};
  const n = Number.isInteger(r.emotes) && r.emotes > 0 ? Math.min(r.emotes, EMOTES_MAX) : 0;
  const ask = (f) => (typeof f === 'function' ? (...a) => { try { return f(...a) === true; } catch (_e) { return false; } } : () => false);
  return Object.freeze({ walkable: ask(r.walkable), look: ask(r.look), emotes: n });
}
const isPos = (rules, x, y) => Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x <= POS_MAX && y <= POS_MAX && rules.walkable(x, y);

/** Strict shape check of ONE message against a room's rules (roomRules). -> { ok: true, b } (only the fields the room defines) | { ok: false, why } */
export function checkCenterMsg(m, rules = NO_ROOM) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return bad('not an object');
  if (m.t !== KIND) return bad('wrong type');
  if (m.v !== VERSION) return bad('version');
  if (typeof m.s !== 'string' || !HEX16.test(m.s)) return bad('sender');
  const s = m.s;
  if (m.k === 'ask' || m.k === 'bye') return { ok: true, b: { k: m.k, s } };
  if (m.k === 'emo') {
    if (!Number.isInteger(m.e) || m.e < 0 || m.e >= rules.emotes) return bad('emote');
    return { ok: true, b: { k: 'emo', s, e: m.e } };
  }
  if (m.k !== 'here' && m.k !== 'mv') return bad('unknown kind');
  if (!isPos(rules, m.x, m.y)) return bad('position');
  if (!isDir(m.d)) return bad('direction');
  if (m.k === 'mv') return { ok: true, b: { k: 'mv', s, x: m.x, y: m.y, d: m.d } };
  // a name is what cleanName leaves of a name, nothing else: a page of this build never sends one it would have to change (hereMsg cleans it first)
  if (typeof m.name !== 'string' || m.name.length < 1 || m.name.length > 40 || cleanName(m.name, '') !== m.name) return bad('name');
  if (typeof m.av !== 'string' || !rules.look(m.av)) return bad('look');
  if (!(m.b === undefined || (typeof m.b === 'string' && HEX16.test(m.b)))) return bad('board id');
  let rec = null;
  if (m.rec !== undefined && m.rec !== null) {
    if (!Array.isArray(m.rec) || m.rec.length !== 2 || !m.rec.every((n) => Number.isInteger(n) && n >= 0 && n <= REC_MAX)) return bad('record');
    rec = [m.rec[0], m.rec[1]];
  }
  return { ok: true, b: { k: 'here', s, name: m.name, av: m.av, x: m.x, y: m.y, d: m.d, b: m.b || null, rec } };
}

/**
 * The room as this page knows it. now() is a monotonic clock in ms.
 * -> { hear(b) -> changed, prune() -> changed, list(), get(s), size() }
 * A trainer is IN once their `here` has arrived; a `mv` or `emo` from a sender who has not said `here` changes nothing (the caller may ask who they are).
 */
export function createRoster({ now, ttlMs = TIMING.ttlMs, max = TIMING.maxWalkers, emoteShowMs = TIMING.emoteShowMs } = {}) {
  const clock = now || (() => Date.now());
  const walkers = new Map();
  const R = {
    hear(b) {
      const t = clock();
      if (b.k === 'bye') return walkers.delete(b.s);
      const w = walkers.get(b.s);
      if (b.k === 'here') {
        if (!w) {
          if (walkers.size >= max) return false;
          walkers.set(b.s, { s: b.s, name: b.name, av: b.av, x: b.x, y: b.y, d: b.d, b: b.b, rec: b.rec, first: t, seen: t, movedAt: t, emote: null });
          return true;
        }
        const moved = w.x !== b.x || w.y !== b.y || w.d !== b.d;
        const changed = moved || w.name !== b.name || w.av !== b.av || w.b !== b.b || JSON.stringify(w.rec) !== JSON.stringify(b.rec);
        Object.assign(w, { name: b.name, av: b.av, x: b.x, y: b.y, d: b.d, b: b.b, rec: b.rec, seen: t });
        if (moved) w.movedAt = t;
        return changed;
      }
      if (!w) return false;
      w.seen = t;
      if (b.k === 'mv') { const moved = w.x !== b.x || w.y !== b.y || w.d !== b.d; w.x = b.x; w.y = b.y; w.d = b.d; if (moved) w.movedAt = t; return moved; }
      if (b.k === 'emo') { w.emote = { e: b.e, at: t }; return true; }
      return false;
    },
    prune() {
      const t = clock(); let changed = false;
      for (const [s, w] of walkers) {
        if (t - w.seen > ttlMs) { walkers.delete(s); changed = true; continue; }
        if (w.emote && t - w.emote.at > emoteShowMs) { w.emote = null; changed = true; }
      }
      return changed;
    },
    /** Everybody in the room, the ones who came first first. */
    list() { return [...walkers.values()].sort((a, b) => a.first - b.first || (a.s < b.s ? -1 : 1)).map((w) => ({ ...w, emote: w.emote ? { ...w.emote } : null })); },
    get(s) { const w = walkers.get(s); return w ? { ...w } : null; },
    size() { return walkers.size; },
  };
  return R;
}

const randomHex = (random, n) => { const u = random(n); let s = ''; for (let i = 0; i < n; i++) s += (u[i] & 255).toString(16).padStart(2, '0'); return s; };
const defaultRandom = (n) => { const a = new Uint8Array(n); globalThis.crypto.getRandomValues(a); return a; };

/**
 * This page in the room.
 *   bus     { send(obj), onMessage(fn), onStatus?(fn), status?(), close() }   openlobby.js createLocalBus / createMqttBus on CENTER_TOPIC / CENTER_CHANNEL
 *   me      () -> { name, av, x, y, d, b, rec }    read every time something is sent, so a new look, a new board id or a step is always what goes out
 *   rules   roomRules({ walkable, look, emotes }): what a position, a look and an emote may be in THIS room (from the ROM, at run time). Left out, everything heard is refused
 * -> { sid, start(), moved(), emote(e), update(), list(), roster, watch(fn) -> off, status(), isIn(), close() }
 */
export function createCenter({ bus, me, rules = NO_ROOM, now, timers, random = defaultRandom, timing = TIMING }) {
  const T = timers || { setInterval: globalThis.setInterval.bind(globalThis), clearInterval: globalThis.clearInterval.bind(globalThis), setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis) };
  const clock = now || (() => Date.now());
  const sid = randomHex(random, 8);
  const roster = createRoster({ now: clock, ttlMs: timing.ttlMs, max: timing.maxWalkers, emoteShowMs: timing.emoteShowMs });
  const listeners = new Set();
  let started = false, closed = false, hereTimer = 0, askTimer = 0, pruneTimer = 0, answerTimer = 0, moveTimer = 0;
  let lastAnswer = -Infinity, lastMove = -Infinity, lastEmote = -Infinity, lastAskBack = -Infinity;
  let winStart = -Infinity, winCount = 0;
  const per = new Map();               // sender -> { start, n }
  const emit = () => { for (const f of [...listeners]) { try { f(); } catch (_e) { /* a listener must not break the room */ } } };
  const send = (o) => { if (closed) return; try { bus.send({ t: KIND, v: VERSION, s: sid, ...o }); } catch (_e) { /* the bus is down: the next heartbeat tries again */ } };
  const hereMsg = () => {
    const m = me();
    const o = { k: 'here', name: cleanName(m.name, 'Trainer'), av: m.av, x: m.x, y: m.y, d: m.d };
    if (m.b) o.b = m.b;
    if (m.rec) o.rec = m.rec;
    return o;
  };
  const sayHere = () => { if (started) send(hereMsg()); };

  bus.onMessage((raw) => {
    if (closed) return;
    const t = clock();
    if (t - winStart > 1000) { winStart = t; winCount = 0; }
    if (++winCount > timing.totalMax) return;
    const r = checkCenterMsg(raw, rules);
    if (!r.ok || r.b.s === sid) return;
    const b = r.b;
    let p = per.get(b.s);
    if (!p || t - p.start > 1000) { p = { start: t, n: 0 }; per.set(b.s, p); if (per.size > 200) per.delete(per.keys().next().value); }
    if (++p.n > timing.perSenderMax) return;
    if (b.k === 'ask') {
      if (started && t - lastAnswer >= timing.answerGapMs) {
        lastAnswer = t;
        T.clearTimeout(answerTimer);
        answerTimer = T.setTimeout(sayHere, Math.floor((random(1)[0] / 256) * timing.jitterMs));
      }
      return;
    }
    const known = !!roster.get(b.s);
    if (roster.hear(b)) emit();
    // somebody moving whom we have not met (their `here` was lost, or we arrived between two): ask, at most once a second
    if (!known && (b.k === 'mv' || b.k === 'emo') && started && t - lastAskBack > 1000) { lastAskBack = t; send({ k: 'ask' }); }
  });

  const C = {
    sid, roster,
    /** Walk in: say who we are, ask who is here, and keep saying it. */
    start() {
      if (started || closed) return false;
      started = true;
      sayHere(); send({ k: 'ask' });
      hereTimer = T.setInterval(sayHere, timing.hereMs);
      askTimer = T.setInterval(() => send({ k: 'ask' }), timing.askEveryMs);
      pruneTimer = T.setInterval(() => { if (roster.prune()) emit(); }, 500);
      return true;
    },
    /** We stepped or turned: tell the room (at most every moveGapMs; a step that comes sooner is sent when the gap is over, as the latest position). */
    moved() {
      if (!started || closed) return;
      const t = clock();
      const go = () => { moveTimer = 0; lastMove = clock(); const m = me(); send({ k: 'mv', x: m.x, y: m.y, d: m.d }); };
      if (t - lastMove >= timing.moveGapMs) { T.clearTimeout(moveTimer); go(); }
      else if (!moveTimer) moveTimer = T.setTimeout(go, timing.moveGapMs - (t - lastMove));
    },
    /** An emote over our own head. -> false when it was too soon after the last one (nothing sent). */
    emote(e) {
      if (!started || closed || !Number.isInteger(e) || e < 0 || e >= rules.emotes) return false;
      const t = clock();
      if (t - lastEmote < timing.emoteGapMs) return false;
      lastEmote = t;
      send({ k: 'emo', e });
      return true;
    },
    /** Something about us changed (a new look, the board listing appeared): say so now instead of at the next heartbeat. */
    update() { sayHere(); },
    list() { roster.prune(); return roster.list(); },
    watch(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    status() { return typeof bus.status === 'function' ? bus.status() : 'up'; },
    isIn() { return started && !closed; },
    /** Leave: say bye (the others drop us at once) and stop. */
    close() {
      if (closed) return;
      if (started) send({ k: 'bye' });
      closed = true; started = false;
      for (const h of [hereTimer, askTimer, pruneTimer]) T.clearInterval(h);
      T.clearTimeout(answerTimer); T.clearTimeout(moveTimer);
      hereTimer = askTimer = pruneTimer = answerTimer = moveTimer = 0;
      listeners.clear();
      try { bus.close(); } catch (_e) { /* ignore */ }
    },
  };
  if (typeof bus.onStatus === 'function') bus.onStatus(() => { if (closed) return; if (started) { sayHere(); send({ k: 'ask' }); } emit(); });
  return C;
}

// pokemonarena/js/openlobby.js -- OPEN GAMES. A player who is waiting for an opponent LISTS their game; anyone who opens the online panel sees the list and joins with one press.
// Nothing here knows what a Pokemon is, and nothing here pairs two browsers: pairing, the room code and the admission are still lib/netplay.js. This module is only the
// NOTICE BOARD that says "room A4F2K is open, hosted by Alice, 3v3".
//
// WHY A BEACON AND NOT A SERVER. The site has no server of its own (GitHub Pages). lib/netplay.js already pairs two browsers through public MQTT-over-WebSocket brokers
// (Netplay.signalBrokers()), so the board is one more topic on those brokers: a listed game publishes a small JSON beacon every few seconds, a browser that opens the list
// subscribes and also asks "who is open?" so it need not wait for the next beacon. NOTHING IS RETAINED (a retained message is how a dead game would stay on the board
// forever): a game is on the board only while its beacons keep arriving, and it falls off ttlMs after the last one. The same-browser transport (net=local) uses a
// BroadcastChannel, which is what the tests use.
//
// THE BOARD IS PUBLIC AND UNAUTHENTICATED, SO EVERYTHING ON IT IS ADVICE, NEVER TRUTH. Anyone can publish anything on a public broker. So every message is shape-checked and
// every field reduced to safe text (checkBeacon), the list is capped, one sender keeps one room, and the join itself is still lib/netplay.js's (a made-up room code simply
// finds nobody; a real one is gated by the room-key proof). The worst a stranger can do with a fake beacon is show a game that is not there, which the joiner's own
// timeout turns into "that game did not answer" (and, for a game that says it is a Find-a-battle game, make a waiting Find-a-battle host try it: see rival() for why that takes
// two beacons a beacon interval apart, and online.js for what happens when it fails: the host's own game comes back).
// WHAT A FORGER CAN STILL DO TO A WAITING FIND-A-BATTLE HOST, honestly. It cannot be stopped from costing one attempt: a made-up q:1 listing with a low room code, kept up for 4 s, makes the host leave its
// own game for it, and the host's own game is off the board for the join watchdog (40 s) before it comes back. What it CANNOT do is repeat that cheaply. After a failed defection NO rival at all moves the host
// for a cooldown (muteRivals, 2 minutes), whatever room code or sender id the rival has: the first version remembered only the failed ROOM CODE, so a forger that rotated codes was believed again 4 s after each new
// one and kept the host out of its own game about 40 s of every 44. Now it is at most one 40 s absence per ~160 s (about a quarter of the time) for as long as the forger keeps publishing and the player keeps waiting; the
// host's game comes back, listed again (for a forger that only publishes beacons; one that also runs a real room and lets the joiner in costs the joiner that game: the handshake fails and the player sees the usual 'match could not start' and presses Find a battle again), and a friend with the room code, or a Join from the list when the game is on it, is not affected. It cannot move a host that is not waiting through Find a battle
// (q), one that has let somebody in, or one in a match. What the board does NOT hide: the listed player's display name and room code are visible to anyone on the broker. That is
// the point of an open game; a private game (a code given to a friend) never goes near this module.
//
// A game can also be RESIDENT (h:1): its owner is somewhere in the Arena (the hub, a CPU battle) and has not opened a room, because a room needs the battle page. Such a game is
// joined by CHALLENGING it: a few directed messages on the same topic (chal -> ok | dec | acc), answered by a dialog on the owner's page. See presence.js. A directed message is addressed
// by a field every subscriber can read, so NOTHING SECRET RIDES IN THE CLEAR: the room of an accepted challenge travels sealed to the challenger's one-time key (acc: pk, iv, ct).
//
// Pure: no DOM, no timers of its own (they are injected), no globals except what the two buses are handed. tools/pokemonarena_openlobby_test.mjs runs it in Node.

import { cleanName } from './netmatch.js';

export const TOPIC = 'bemental/arena/open/1';
export const BEACON = 'arenaopen';
export const BEACON_V = 1;
export const ROOM_RE = /^[A-Za-z0-9]{4,8}$/;
export const FORMATS = Object.freeze(['3v3', '6v6']);
export const TIMING = Object.freeze({
  beaconMs: 4000,        // a listed game says so this often
  ttlMs: 13000,          // ... and falls off the board this long after the last time (three beacons missed)
  askEveryMs: 7000,      // a browser that is looking asks "who is open?" this often
  answerGapMs: 1500,     // a listed game answers an ask at most this often (an attacker's ask loop must not become a flood)
  jitterMs: 500,         // ... after a random wait up to this, so a room full of listed games does not answer in one burst
  maxListed: 24,         // the board shows at most this many games
  rateWindowMs: 2000, rateMax: 80,      // more than this many messages in a window are dropped unread
  wireMax: 1024,         // a message longer than this is junk
  mutedMs: 30000,        // a game that did not answer is left off the board this long
  mqttDownMs: 10000,     // no broker answering for this long is "the list cannot be reached"
});

const HEX16 = /^[0-9a-f]{16}$/, HEX64 = /^[0-9a-f]{64}$/;
const CONFIRM_SLACK_MS = 250;      // two beacons a beacon interval apart arrive a few ms either side of it (timer jitter, the network): that is still "a beacon interval apart"
// A one-time P-256 public key as its two base64url coordinates, 'x.y' (43 characters each); the AES-GCM iv (12 bytes); the sealed room (4..8 characters + the 16-byte tag = 20..24 bytes).
// Shape only: whether the point is on the curve is WebCrypto's to refuse when the key is imported (presence.js).
export const PK_RE = /^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/;
const IV_RE = /^[A-Za-z0-9_-]{16}$/, CT_RE = /^[A-Za-z0-9_-]{27,32}$/;
const REC_MAX = 999999;
/** The directed kinds: addressed to ONE sender id (`to`) and one request (`r`). chal = please battle me (carries the challenger's one-time public key pk), can = never mind, ok = I accepted, I am coming up, dec = no,
 *  acc = the room is open: come in (the room itself SEALED to that key: the owner's one-time public key pk, the iv, the ciphertext ct). */
export const DIRECTED = Object.freeze(['chal', 'can', 'ok', 'dec', 'acc']);
export const DECLINE_WHY = Object.freeze(['declined', 'busy']);
const isStr = (x, n) => typeof x === 'string' && x.length >= 1 && x.length <= n;
const bad = (why) => ({ ok: false, why });

function recOf(x) {
  if (x === undefined || x === null) return { ok: true, rec: null };
  if (!Array.isArray(x) || x.length !== 2 || !x.every((n) => Number.isInteger(n) && n >= 0 && n <= REC_MAX)) return { ok: false };
  return { ok: true, rec: [x[0], x[1]] };
}

/**
 * Strict shape check of ONE message from the board. Nothing here trusts the sender.
 * -> { ok:true, b } with b = { k:'ask', s } | { k:'gone', s, room } | { k:'open', s, room, name, fmt, rom, fp, rs, q, h, rec } | a directed kind (DIRECTED: chal adds name, rec, pk; dec adds why; acc adds pk, iv, ct) | { ok:false, why }
 */
export function checkBeacon(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return bad('not an object');
  if (m.t !== BEACON) return bad('wrong type');
  if (m.v !== BEACON_V) return bad('version');
  if (typeof m.s !== 'string' || !HEX16.test(m.s)) return bad('sender');
  if (m.k === 'ask') return { ok: true, b: { k: 'ask', s: m.s } };
  if (DIRECTED.includes(m.k)) {
    if (typeof m.to !== 'string' || !HEX16.test(m.to)) return bad('to');
    if (typeof m.r !== 'string' || !HEX16.test(m.r)) return bad('request');
    const d = { k: m.k, s: m.s, to: m.to, r: m.r };
    if (m.k === 'chal') {
      if (!isStr(m.name, 40)) return bad('name');
      d.name = cleanName(m.name, 'Player');
      const rr = recOf(m.rec); if (!rr.ok) return bad('record'); d.rec = rr.rec;
      if (typeof m.pk !== 'string' || !PK_RE.test(m.pk)) return bad('key');           // no key, no way to answer in private: such a challenge is not shown
      d.pk = m.pk;
    } else if (m.k === 'dec') {
      if (!DECLINE_WHY.includes(m.why)) return bad('why');
      d.why = m.why;
    } else if (m.k === 'acc') {
      // the room is SEALED to the challenger's key: a "come in" that carries it in the clear (or carries nothing) is not a "come in"
      if (typeof m.pk !== 'string' || !PK_RE.test(m.pk)) return bad('key');
      if (typeof m.iv !== 'string' || !IV_RE.test(m.iv)) return bad('iv');
      if (typeof m.ct !== 'string' || !CT_RE.test(m.ct)) return bad('sealed room');
      d.pk = m.pk; d.iv = m.iv; d.ct = m.ct;
    }
    return { ok: true, b: d };
  }
  if (m.k !== 'open' && m.k !== 'gone') return bad('unknown kind');
  if (typeof m.room !== 'string' || !ROOM_RE.test(m.room)) return bad('room');
  const room = m.room.toUpperCase();
  if (m.k === 'gone') return { ok: true, b: { k: 'gone', s: m.s, room } };
  if (!isStr(m.name, 40)) return bad('name');
  if (!FORMATS.includes(m.fmt)) return bad('format');
  if (typeof m.rom !== 'string' || !HEX64.test(m.rom)) return bad('rom');
  if (!isStr(m.fp, 64) || !isStr(m.rs, 64)) return bad('version fields');
  if (!(m.q === undefined || m.q === 0 || m.q === 1)) return bad('quick flag');
  if (!(m.h === undefined || m.h === 0 || m.h === 1)) return bad('resident flag');
  // the trainer's online record, [wins, losses]: self-reported and shown beside the name, never used for anything else
  const rr = recOf(m.rec);
  if (!rr.ok) return bad('record');
  return { ok: true, b: { k: 'open', s: m.s, room, name: cleanName(m.name, 'Player'), fmt: m.fmt, rom: m.rom, fp: m.fp, rs: m.rs, q: m.q === 1 ? 1 : 0, h: m.h === 1 ? 1 : 0, rec: rr.rec } };
}

/**
 * The board: which rooms are open right now, from what the browser has heard. now() is a monotonic clock in ms.
 * A game is put on the board by its beacons and falls off when they stop (ttlMs) or when it says it is gone.
 */
export function createDirectory({ now, ttlMs = TIMING.ttlMs, max = TIMING.maxListed, mutedMs = TIMING.mutedMs, confirmMs = TIMING.beaconMs - CONFIRM_SLACK_MS } = {}) {
  const clock = now || (() => Date.now());
  const games = new Map();      // room -> { room, s, name, fmt, rom, fp, rs, q, h, rec, first (when the room was first heard), since (when it started saying what it says now), confirmed, seen }
  const muted = new Map();      // room -> until
  const dir = {
    /** -> true when the board CHANGED (a game appeared, something about it did, or it became CONFIRMED); a plain repeat of a beacon is not a change.
     *  CONFIRMED = the same listing has been heard again a beacon interval after it started saying it: a message that was heard ONCE, which anyone can forge, is not yet evidence of a
     *  game (rival() will not move a host on it). A listing that CHANGES (a different name, format, flags) starts again. ONE SENDER KEEPS ONE ROOM: a new room from the same sender
     *  replaces its old one, so a sender cannot fill the board by itself, and a relisted game does not stand twice for a ttl. */
    hear(b) {
      if (!b || b.k !== 'open') return false;
      const t = clock();
      dir.prune();
      if (muted.has(b.room)) return false;
      const g = games.get(b.room);
      if (g) {
        if (g.s !== b.s) return false;                    // the first sender keeps the room; a second one claiming it is a copy or a hijack
        g.seen = t;
        if (g.name === b.name && g.fmt === b.fmt && g.rom === b.rom && g.fp === b.fp && g.rs === b.rs && g.q === b.q && g.h === b.h && JSON.stringify(g.rec) === JSON.stringify(b.rec)) {
          if (!g.confirmed && t - g.since >= confirmMs) { g.confirmed = true; return true; }
          return false;
        }
        Object.assign(g, { name: b.name, fmt: b.fmt, rom: b.rom, fp: b.fp, rs: b.rs, q: b.q, h: b.h, rec: b.rec, since: t, confirmed: false });
        return true;
      }
      let changed = false;
      for (const [r, o] of games) if (o.s === b.s) { games.delete(r); changed = true; }
      if (games.size >= max) return changed;
      games.set(b.room, { room: b.room, s: b.s, name: b.name, fmt: b.fmt, rom: b.rom, fp: b.fp, rs: b.rs, q: b.q, h: b.h, rec: b.rec, first: t, since: t, confirmed: false, seen: t });
      return true;
    },
    /** A game says it is gone. Only the sender that listed it can take it down. */
    gone(room, s) { const g = games.get(room); if (!g || g.s !== s) return false; games.delete(room); return true; },
    /** Leave a game off the board for a while (it did not answer, or it was taken). */
    mute(room, ms) { const R = String(room || '').toUpperCase(); games.delete(R); muted.set(R, clock() + (ms === undefined ? mutedMs : ms)); },
    /** -> true when something fell off. */
    prune() {
      const t = clock(); let changed = false;
      for (const [r, g] of games) if (t - g.seen > ttlMs) { games.delete(r); changed = true; }
      for (const [r, u] of muted) if (t >= u) muted.delete(r);
      return changed;
    },
    /** Open games, longest waiting first. compatible = it runs the same ROM and the same engine build as `mine` { rom, fp }: anything else would only be refused by name at the handshake. */
    list(mine) {
      dir.prune();
      return [...games.values()].sort((a, b) => a.first - b.first || (a.room < b.room ? -1 : 1)).map((g) => ({ ...g, compatible: !!mine && g.rom === mine.rom && g.fp === mine.fp }));
    },
    size() { return games.size; },
  };
  return dir;
}

const randomHex = (random, n) => { const u = random(n); let s = ''; for (let i = 0; i < n; i++) s += (u[i] & 255).toString(16).padStart(2, '0'); return s; };
const defaultRandom = (n) => { const a = new Uint8Array(n); globalThis.crypto.getRandomValues(a); return a; };

/**
 * One browser's view of the board AND its own listing.
 *   bus      { send(obj), onMessage(fn), onStatus(fn), status(), close() }   createLocalBus / createMqttBus (or a test double)
 *   mine     { rom, fp }                   what this page runs; the board marks games on another build as not compatible
 *   timers   { setInterval, clearInterval, setTimeout, clearTimeout }   injected so a test can step time
 * host(info) lists MY game: { room, name, fmt, rom, fp, rs, q, h, rec: [wins, losses] | null }. h = resident (see the top of the file): `room` is then only a unique label, never a room to knock on.
 */
export function createOpenLobbies({ bus, now, mine, timers, random = defaultRandom, timing = TIMING }) {
  const T = timers || { setInterval: globalThis.setInterval.bind(globalThis), clearInterval: globalThis.clearInterval.bind(globalThis), setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis) };
  const clock = now || (() => Date.now());
  const sid = randomHex(random, 8);
  const dir = createDirectory({ now: clock, ttlMs: timing.ttlMs, max: timing.maxListed, mutedMs: timing.mutedMs, confirmMs: Math.max(0, timing.beaconMs - CONFIRM_SLACK_MS) });
  const listeners = new Set();
  const signalFns = new Set();
  let hosting = null, beaconTimer = 0, askTimer = 0, pruneTimer = 0, lastAnswer = -Infinity, answerTimer = 0, closed = false, watching = false;
  let winStart = -Infinity, winCount = 0, rivalsMutedUntil = -Infinity, muteWake = 0;
  const emit = () => { for (const f of [...listeners]) { try { f(); } catch (_e) { /* a listener must not break the board */ } } };
  const beaconOf = (k) => (k === 'ask' ? { t: BEACON, v: BEACON_V, k, s: sid } : { t: BEACON, v: BEACON_V, k, s: sid, room: hosting.room, name: hosting.name, fmt: hosting.fmt, rom: hosting.rom, fp: hosting.fp, rs: hosting.rs, q: hosting.q ? 1 : 0, ...(hosting.h ? { h: 1 } : {}), ...(hosting.rec ? { rec: hosting.rec } : {}) });
  const sendBeacon = () => { if (closed || !hosting) return; try { bus.send(beaconOf('open')); } catch (_e) { /* the bus is down: the next beacon tries again */ } };

  bus.onMessage((raw) => {
    if (closed) return;
    const t = clock();
    if (t - winStart > timing.rateWindowMs) { winStart = t; winCount = 0; }
    if (++winCount > timing.rateMax) return;
    const r = checkBeacon(raw);
    if (!r.ok || r.b.s === sid) return;                  // junk, or our own message coming back from the broker
    const b = r.b;
    if (b.to !== undefined) {                              // a directed message: only the one it is addressed to hears it
      if (b.to === sid) for (const f of [...signalFns]) { try { f(b); } catch (_e) { /* a listener must not break the board */ } }
      return;
    }
    if (b.k === 'open') { if (dir.hear(b)) emit(); }
    else if (b.k === 'gone') { if (dir.gone(b.room, b.s)) emit(); }
    else if (b.k === 'ask' && hosting && t - lastAnswer >= timing.answerGapMs) {
      lastAnswer = t;
      T.clearTimeout(answerTimer);
      const wait = Math.floor((random(1)[0] / 256) * timing.jitterMs);
      answerTimer = T.setTimeout(sendBeacon, wait);
    }
  });
  const L = {
    sid, dir, mine: { ...mine },
    /** Call fn whenever the board changes (a game appears, changes or leaves) or the connection changes. -> unsubscribe */
    watch(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    /** A fresh request id for a challenge. */
    newRequest() { return randomHex(random, 8); },
    /** Send a directed message (DIRECTED kinds): signal('chal', { to, r, name, rec, pk }). Throws RangeError for a message the receivers would drop.
     *  What goes on the PUBLIC board is the message as the board defines it (what checkBeacon keeps), never the caller's object as it was: a stray field (a room code that should have been sealed) cannot ride along. */
    signal(kind, fields) {
      if (closed) return false;
      const msg = { t: BEACON, v: BEACON_V, k: kind, s: sid, ...fields };
      const chk = DIRECTED.includes(kind) ? checkBeacon(msg) : { ok: false, why: 'not a directed kind' };
      if (!chk.ok) throw new RangeError('signal(): ' + chk.why);
      try { bus.send({ t: BEACON, v: BEACON_V, ...chk.b }); } catch (_e) { /* the bus is down: the caller\'s own timeout says so */ }
      return true;
    },
    /** Call fn(message) for every directed message addressed to THIS browser. -> unsubscribe */
    onSignal(fn) { signalFns.add(fn); return () => signalFns.delete(fn); },
    /** Ask the room who is open (answers arrive as beacons). */
    refresh() { if (closed) return; try { bus.send(beaconOf('ask')); } catch (_e) { /* ignore */ } },
    /** Start looking: ask now, keep asking, and age games off the board. */
    startWatching() {
      if (closed || watching) return;
      watching = true;
      L.refresh();
      askTimer = T.setInterval(() => L.refresh(), timing.askEveryMs);
      pruneTimer = T.setInterval(() => { if (dir.prune()) emit(); }, 1000);
    },
    stopWatching() { watching = false; T.clearInterval(askTimer); T.clearInterval(pruneTimer); askTimer = pruneTimer = 0; },
    isWatching() { return watching; },
    /** The board, longest waiting first, each marked compatible or not. A game this browser itself lists is never on it. */
    list() { return dir.list(mine); },
    /** List MY game: info { room, name, fmt, rom, fp, rs, q }. Re-listing replaces the previous one. */
    host(info) {
      if (closed) return false;
      const next = info && { room: String(info.room).toUpperCase(), name: cleanName(info.name, 'Player'), fmt: info.fmt, rom: info.rom, fp: info.fp, rs: info.rs, q: !!info.q, h: !!info.h, rec: info.rec || null };
      // the SAME check every other browser will apply: a listing they would drop is a bug here, not a quiet failure there
      const probe = next && checkBeacon({ t: BEACON, v: BEACON_V, k: 'open', s: sid, room: next.room, name: next.name, fmt: next.fmt, rom: next.rom, fp: next.fp, rs: next.rs, q: next.q ? 1 : 0, h: next.h ? 1 : 0, rec: next.rec });
      if (!probe || !probe.ok) throw new RangeError('host(): the listing would be rejected by the board (' + (probe ? probe.why : 'nothing given') + ')');
      L.unhost();
      hosting = next;
      sendBeacon();
      beaconTimer = T.setInterval(sendBeacon, timing.beaconMs);
      return true;
    },
    /** Take my game off the board (the other listeners drop it at once instead of waiting for the ttl). */
    unhost() {
      if (!hosting) return false;
      T.clearInterval(beaconTimer); T.clearTimeout(answerTimer); beaconTimer = answerTimer = 0;
      if (!closed) { try { bus.send(beaconOf('gone')); } catch (_e) { /* the ttl takes it down */ } }
      hosting = null;
      return true;
    },
    hosting() { return hosting ? { ...hosting } : null; },
    /** Two players who both pressed "Find a battle" and both listed a game: the one with the LARGER room code joins the other. -> the game to join, or null.
     *  The board is public and nothing on it is authenticated, so a rival must have been CONFIRMED (heard twice, a beacon interval apart: one forged beacon cannot move a host), must not be a
     *  resident label (h: there is no room to join), and the choice is the SMALLEST code of those (three waiting hosts all agree on one, instead of each picking the oldest).
     *  And never while muteRivals() is in force: a defection that failed is not tried again for the cooldown, for any rival (see the top of the file). */
    rival(usable) {
      if (!hosting || !hosting.q) return null;
      if (clock() < rivalsMutedUntil) return null;          // a defection just failed (muteRivals): NO rival moves this host until the cooldown ends, whatever room code it has
      const eligible = (g) => g.q && !g.h && g.compatible && g.confirmed && g.room < hosting.room && (!usable || usable(g));
      let best = null;
      for (const g of L.list()) if (eligible(g) && (!best || g.room < best.room)) best = g;
      return best;
    },
    mute(room, ms) { dir.mute(room, ms); emit(); },
    /** A defection to a rival FAILED (the rival was made up, or somebody got there first): rival() returns null for the next `ms`, for EVERY code. mute(room) is keyed by the room code, and a forger
     *  that publishes a fresh code is a new room each time, so that alone would only slow it down by the four seconds a new listing needs to be believed; this memory is the cost the forger cannot dodge. */
    muteRivals(ms) {
      rivalsMutedUntil = clock() + (ms === undefined ? timing.mutedMs : ms);
      // Nothing else tells the page that the cooldown is over: a real rival that was listed DURING it (confirmed, but ignored) would sit there until some unrelated board change. So the board speaks once when it ends.
      T.clearTimeout(muteWake); muteWake = 0;
      if (Number.isFinite(rivalsMutedUntil)) muteWake = T.setTimeout(() => { muteWake = 0; if (!closed) emit(); }, Math.max(0, rivalsMutedUntil - clock()) + 1);
    },
    status() { return typeof bus.status === 'function' ? bus.status() : 'up'; },
    close() {
      if (closed) return;
      L.unhost(); L.stopWatching();
      closed = true; T.clearTimeout(muteWake); muteWake = 0; listeners.clear(); signalFns.clear();
      try { bus.close(); } catch (_e) { /* ignore */ }
    },
  };
  // a broker coming up (or going away) is news: ask again, say again, and let the page redraw
  if (typeof bus.onStatus === 'function') bus.onStatus(() => { if (closed) return; if (watching) L.refresh(); if (hosting) sendBeacon(); emit(); });
  return L;
}

/* ------------------------------------------------------------------------------------------------ the two buses */

/** The same-browser board (BroadcastChannel): what the tests use, and what net=local pairing means. */
export function createLocalBus(win, name = 'bemental-arena-open-1') {
  let ch = null, cb = null;
  try { ch = new win.BroadcastChannel(name); } catch (_e) { ch = null; }
  if (ch) ch.onmessage = (ev) => { if (cb) cb(ev.data); };
  return {
    kind: 'local',
    send(o) { if (ch) { try { ch.postMessage(o); } catch (_e) { /* ignore */ } } },
    onMessage(f) { cb = f; },
    onStatus(f) { /* a BroadcastChannel is up or it does not exist */ },
    status() { return ch ? 'up' : 'down'; },
    close() { cb = null; if (ch) { try { ch.close(); } catch (_e) { /* ignore */ } ch = null; } },
  };
}

// The same library and version lib/netplay.js loads for its signalling (WS_LIB there); keep them equal so one copy serves both.
export const MQTT_LIB = 'https://cdnjs.cloudflare.com/ajax/libs/mqtt/5.3.4/mqtt.min.js';

/**
 * The brokers lib/netplay.js pairs through (its WS_BROKERS), for a page that has not loaded that library (the hub). A TEST compares this list with the library's, so they cannot drift.
 * Order matters to nothing here: the board dials them all.
 */
export const DEFAULT_BROKERS = Object.freeze([
  'wss://public.cloud.shiftr.io:443|public|public',
  'wss://demo.tbmq.io:443/mqtt|demo|',
  'wss://broker.emqx.io:8084/mqtt',
  'wss://test.mosquitto.org:8081/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
]);
/** The brokers this page should use: lib/netplay.js's own list when it is loaded (so a ?wsbroker= or NETPLAY_WS_BROKERS override applies to both), else ?wsbroker=, else DEFAULT_BROKERS. */
export function brokersFor(win) {
  try { if (win.Netplay && typeof win.Netplay.signalBrokers === 'function') return win.Netplay.signalBrokers(); } catch (_e) { /* fall through */ }
  try { const raw = new URLSearchParams(win.location.search).get('wsbroker'); if (raw) return String(raw).split(',').map((x) => x.trim()).filter(Boolean); } catch (_e) { /* fall through */ }
  return DEFAULT_BROKERS.slice();
}

/** `url|username|password` (lib/netplay.js's pipe form) -> { url, username, password }. */
export function parseBroker(entry) {
  const bits = String(entry).split('|');
  const b = { url: bits[0].trim(), username: null, password: null };
  if (bits.length > 1 && bits[1]) b.username = bits[1];
  if (bits.length > 2 && bits[2]) b.password = bits[2];
  return b;
}

/** The mqtt.js library, from the page if it is already there (lib/netplay.js loads it when a room is opened), else from the CDN. */
export function loadMqttLib(win, timeoutMs = 12000) {
  if (win.mqtt) return Promise.resolve(win.mqtt);
  return new Promise((res, rej) => {
    const doc = win.document;
    const s = doc.createElement('script');
    const t = win.setTimeout(() => rej(new Error('the broker library did not load')), timeoutMs);
    s.src = MQTT_LIB;
    s.onload = () => { win.clearTimeout(t); win.mqtt ? res(win.mqtt) : rej(new Error('the broker library loaded but defined nothing')); };
    s.onerror = () => { win.clearTimeout(t); rej(new Error('could not load the broker library')); };
    doc.head.appendChild(s);
  });
}

/**
 * The board on the public MQTT brokers lib/netplay.js already uses. Every broker that answers is subscribed and published to (two people only meet on a broker they BOTH
 * reached, and behind a firewall that is a different subset of the list); a message that arrives over two of them is delivered once.
 * opts: { brokers: ['wss://host|user|pass', ...], lib: Promise<mqtt> | (() => Promise<mqtt>), topic, random, setTimeout, clearTimeout, timing }
 */
export function createMqttBus(win, opts = {}) {
  const brokers = (opts.brokers || []).slice();
  const topic = opts.topic || TOPIC;
  const random = opts.random || defaultRandom;
  const timing = opts.timing || TIMING;
  const setT = opts.setTimeout || win.setTimeout.bind(win), clearT = opts.clearTimeout || win.clearTimeout.bind(win);
  const clients = [];
  const seen = new Set(), seenQ = [];
  let cb = null, stCb = null, status = brokers.length ? 'connecting' : 'down', closed = false, downTimer = 0;
  const setStatus = (s) => { if (s !== status && !closed) { status = s; if (stCb) { try { stCb(s); } catch (_e) { /* ignore */ } } } };
  // "down" = no broker has answered for mqttDownMs. That clock runs at the start AND every time the last broker drops: a board that was up and lost every broker is "connecting" for that long
  // and then "down" (the page stops telling a host that nobody can see their game), and any broker coming back is "up" again.
  const armDown = () => { clearT(downTimer); downTimer = setT(() => { downTimer = 0; if (!clients.some((c) => c.connected)) setStatus('down'); }, timing.mqttDownMs); };
  const update = () => { if (closed) return; if (clients.some((c) => c.connected)) { clearT(downTimer); downTimer = 0; setStatus('up'); } else if (status === 'up') { setStatus('connecting'); armDown(); } };
  if (brokers.length) armDown();

  const deliver = (payload) => {
    if (closed || !cb) return;
    let text;
    try { text = payload && payload.toString ? payload.toString() : String(payload); } catch (_e) { return; }
    if (text.length > timing.wireMax) return;
    let m;
    try { m = JSON.parse(text); } catch (_e) { return; }
    if (!m || typeof m !== 'object' || typeof m.i !== 'string' || m.i.length > 32) return;
    if (seen.has(m.i)) return;                           // the same message over a second broker
    seen.add(m.i); seenQ.push(m.i);
    while (seenQ.length > 256) seen.delete(seenQ.shift());
    delete m.i;
    cb(m);
  };

  (async () => {
    let mq;
    try { mq = await (typeof opts.lib === 'function' ? opts.lib() : opts.lib || loadMqttLib(win)); } catch (_e) { setStatus('down'); return; }
    if (closed) return;
    for (const entry of brokers) {
      const B = parseBroker(entry);
      let c;
      try {
        c = mq.connect(B.url, Object.assign({
          clientId: 'arena-' + randomHex(random, 8), clean: true, keepalive: 30, protocolVersion: 4, resubscribe: true, reconnectPeriod: 5000, connectTimeout: 9000,
        }, B.username ? { username: B.username } : {}, B.password ? { password: B.password } : {}));
      } catch (_e) { continue; }
      clients.push(c);
      c.on('connect', () => { if (closed) return; try { c.subscribe(topic, { qos: 0 }, () => {}); } catch (_e) { /* ignore */ } update(); });
      c.on('close', update); c.on('offline', update);
      c.on('error', () => { /* one broker hiccuping is not news while another carries the board */ });
      c.on('message', (t, payload) => { if (t === topic) deliver(payload); });
    }
  })();

  return {
    kind: 'mqtt',
    get brokers() { return clients.map((c, i) => ({ url: parseBroker(brokers[i]).url, up: !!c.connected })); },
    send(o) {
      if (closed) return;
      const wire = JSON.stringify({ ...o, i: randomHex(random, 8) });
      for (const c of clients) if (c.connected) { try { c.publish(topic, wire, { qos: 0, retain: false }); } catch (_e) { /* ignore */ } }
    },
    onMessage(f) { cb = f; },
    onStatus(f) { stCb = f; },
    status() { return status; },
    close() { closed = true; clearT(downTimer); cb = null; for (const c of clients.splice(0)) { try { c.end(true); } catch (_e) { /* ignore */ } } },
  };
}

// pokemonarena/js/presence.js -- OPEN TO BATTLES while you use the rest of the Arena (the hub, a battle against the CPU), and the three little state machines that make it work.
// Pure: no DOM, no network, no clock of its own (all injected). presence_boot.js is the page half (the switch, the dialog, the store); tools/pokemonarena_presence_test.mjs runs this in Node.
//
// THE PROBLEM. A battle against a person needs a ROOM, and a room can only be opened by the battle page (it owns the lib/netplay.js session). A player in the hub has no room. So an
// "open" player in the hub is listed as a RESIDENT game (openlobby.js, h:1: a label, not a room) and a challenger ASKS instead of knocking:
//
//   challenger (battle page, Open games)                 owner (hub or a CPU battle)                          owner (battle page, after Accept)
//   chal  { to: owner sid, r, name, rec, pk }  ------->  a dialog: "Alice wants to battle you"
//                                          <------------  ok  { r }      Accept: "I am coming"  -> navigates to battle.html?auto=host&for=..&rq=r
//                                          <------------  dec { r, why }  Not now / busy / no answer
//   can  { r }  ------------------------>  the dialog closes (the challenger gave up)
//                                          <------------------------------------------------------  acc { to: challenger sid, r, pk, iv, ct }   (repeated until they are in)
//   ... the challenger opens `ct` with its one-time key and joins the room exactly like any listed game (online.js launch).
//
// `r` is a 64-bit request id the challenger makes; every answer repeats it, and the `acc` (which comes from a NEW page, so a new sender id) is matched by it alone.
//
// WHAT IS PUBLIC AND WHAT IS NOT. Everything above rides the PUBLIC board (openlobby.js): any stranger can read it and send any of it. So:
//   * THE ROOM CODE IS NEVER ON THE BOARD IN THE CLEAR. The room code is the credential for the room (lib/netplay.js keys the room by it), so an `acc` that said it would hand the seat to
//     whoever was listening. The challenger puts a ONE-TIME ECDH P-256 PUBLIC KEY in its `chal` (pk); the owner's battle page makes its own one-time key pair, derives an AES-GCM key from the
//     two (ECDH, then HKDF-SHA-256 with a fixed label), and sends the room SEALED (pk, iv, ct). Only the challenger holds the private half. A browser without WebCrypto cannot challenge
//     (it says so): there is no fallback to the clear. What this does NOT do is authenticate the owner: a stranger who read the `chal` knows the challenger's public key, so can still seal a
//     pointer to THEIR OWN room. The challenger would then see a stranger's name in the handshake, and a room it joins is still gated by the room-key proof and its host's admission.
//   * AN ADDRESS DOES NOT START A GAME. The page Accept opens will host a room and publish it only if THIS TAB'S sessionStorage holds a fresh one-time token that accept() wrote (writeAcceptToken /
//     takeAcceptToken below). A link from anywhere else (battle.html?online=1&auto=host&for=..&rq=..) carries no token and is ignored.
//   * A forged message can still show a dialog (rate-limited, "Not now" is the default button), point a challenger at another room (above), or be ignored by the real owner. Admission of whoever
//     knocks on a room is still the host's.

import { ROOM_RE, PK_RE } from './openlobby.js';

export const OPEN_KEY = 'arena.open';
export const ACCEPT_KEY = 'arena.accept';             // sessionStorage: the one-time hand-off from the dialog's Accept to the battle page it opens (this tab only)
export const ACCEPT_MAX_AGE_MS = 120000;              // a token older than this was not written for the page that is reading it
export const SEAL_INFO = 'bemental/pokemonarena/acc/1';           // the fixed HKDF label of the sealed room
export const TIMING = Object.freeze({
  answerMs: 25000,        // a dialog nobody answers is declined after this long (and a challenger gives up on an owner who never answers after about this long)
  connectMs: 60000,       // after "ok" the challenger waits this long for the room to appear
  resendMs: 3000,         // a challenge is repeated this often until it is answered (one lost message must not lose it)
  accResendMs: 2000, accForMs: 90000,    // the owner's battle page repeats "come in" this often, for this long
  cooldownMs: 20000,      // somebody who was told no is answered "no" quietly for this long
  perMinute: 6,           // challenges shown to the owner per minute; the rest are told "busy"
});

/** The stored switch: '1' = this browser is open to battles. A thrown storage is "off". */
export function isOpen(storage) { try { return !!storage && storage.getItem(OPEN_KEY) === '1'; } catch (_e) { return false; } }
export function setOpen(storage, on) { try { if (!storage) return false; if (on) storage.setItem(OPEN_KEY, '1'); else storage.removeItem(OPEN_KEY); return true; } catch (_e) { return false; } }

const HEX16 = /^[0-9a-f]{16}$/;
/**
 * THE ACCEPT TOKEN. accept() writes { for (the challenger's sender id), rq (the request id), ck (the challenger's one-time public key), at } into THIS TAB's sessionStorage just before it navigates;
 * the battle page it opens hosts an accepted challenge only if it can take a token that matches `for` and `rq` and is fresh, and removes it in the same step (one use). sessionStorage is per
 * tab and is not reachable from a link, so an address alone proves nothing. `at` is WALL-CLOCK ms (the token crosses a page load, which a monotonic clock does not).
 * -> true when the token was stored.
 */
export function writeAcceptToken(storage, { for: forSid, rq, ck }, nowMs) {
  try {
    if (!storage || !HEX16.test(forSid || '') || !HEX16.test(rq || '') || typeof ck !== 'string' || !PK_RE.test(ck) || !Number.isFinite(nowMs)) return false;
    storage.setItem(ACCEPT_KEY, JSON.stringify({ for: forSid, rq, ck, at: nowMs }));
    return true;
  } catch (_e) { return false; }
}
/**
 * -> { ck } and the token is gone, or null (none, another challenge's, expired, malformed, from the future, or storage that will not let it be removed: one use or no use).
 * An expired or unreadable token is removed; one that is merely for another challenge is left alone (its own page may still be on its way).
 */
export function takeAcceptToken(storage, { for: forSid, rq }, nowMs, maxAgeMs = ACCEPT_MAX_AGE_MS) {
  try {
    if (!storage) return null;
    const raw = storage.getItem(ACCEPT_KEY);
    if (raw === null || raw === undefined) return null;
    let t = null;
    try { t = JSON.parse(raw); } catch (_e) { t = null; }
    const shaped = !!t && typeof t === 'object' && HEX16.test(t.for || '') && HEX16.test(t.rq || '') && typeof t.ck === 'string' && PK_RE.test(t.ck) && Number.isFinite(t.at);
    const age = shaped ? nowMs - t.at : NaN;
    const fresh = shaped && age >= -5000 && age <= maxAgeMs;
    if (shaped && fresh && (t.for !== forSid || t.rq !== rq)) return null;                    // somebody else's: not this page's to take or to destroy
    storage.removeItem(ACCEPT_KEY);                                                           // used, expired or junk: gone either way
    const left = storage.getItem(ACCEPT_KEY);
    if (left !== null && left !== undefined) return null;                                     // it would not go: it must not be usable twice
    return fresh ? { ck: t.ck } : null;
  } catch (_e) { return null; }
}

/**
 * Who may be let into an OPEN or INVITED game without the host pressing Allow. -> 'approve' (the first player to knock) | 'return' (the one admitted, knocking again: their Session was replaced) | 'deny'.
 *   g { open, invite (truthy for an accepted challenge), nm (a match exists), closed, admitted, admittedId }       reqId = the knocker's stable id (lib/netplay.js req.id)
 * A MATCH that exists belongs to the player in it: the host's Session can be rebuilt under the same code (online.js scheduleReconnect), and a fresh Session has forgotten who it let in, so the
 * returning player is recognised by the id it was admitted under. Anybody else is a THIRD player and is told the game is taken. (An impostor with the right id still cannot play: the match
 * protocol cannot continue without the match history.)
 */
export function admission(g, reqId) {
  if (g.closed) return 'deny';
  const same = !!g.admittedId && reqId === g.admittedId;
  if (g.nm) return same ? 'return' : 'deny';
  if ((g.open || g.invite) && !g.admitted) return 'approve';
  return same ? 'return' : 'deny';
}

const ALNUM = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
/** The unique label a resident game is listed under: 'H' + 4 characters. It is never a room code anyone can knock on. */
export function residentLabel(random) { const u = random(4); let s = 'H'; for (let i = 0; i < 4; i++) s += ALNUM[u[i] % ALNUM.length]; return s; }

/** Where the owner goes when they press Accept: the battle page opens a room, auto-starts as host (if it finds the accept token), and tells the challenger the room. */
export function acceptHref({ s, r, fmt, extra = '' }) {
  return '/pokemonarena/battle.html?online=1&auto=host&for=' + encodeURIComponent(s) + '&rq=' + encodeURIComponent(r) + '&format=' + encodeURIComponent(fmt) + extra;
}

/* ------------------------------------------------------------------------------------------------ the sealed room (WebCrypto) */
const enc = new TextEncoder(), dec = new TextDecoder();
const ECDH = { name: 'ECDH', namedCurve: 'P-256' };
const b64u = (bytes) => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const unb64u = (str) => { const t = String(str).replace(/-/g, '+').replace(/_/g, '/'); const bin = atob(t + '='.repeat((4 - (t.length % 4)) % 4)); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };
// what the ciphertext is bound to: this request, for this challenger. A sealed room cannot be replayed to another request or another browser.
const aadOf = (r, to) => enc.encode('pokemonarena/acc/1|' + r + '|' + to);

/** True when this browser can do the sealing (WebCrypto with ECDH, HKDF and AES-GCM). A browser that cannot has no private way to be told a room, so it does not challenge. */
export function canSeal(cr = globalThis.crypto) {
  try { return !!(cr && cr.subtle && typeof cr.subtle.generateKey === 'function' && typeof cr.subtle.deriveKey === 'function' && typeof cr.getRandomValues === 'function'); } catch (_e) { return false; }
}
/** A fresh ONE-TIME key pair. -> { pk: 'x.y' (public, goes on the board), priv (a non-extractable CryptoKey: it never leaves this page) } */
export async function makeKeyPair(cr = globalThis.crypto) {
  if (!canSeal(cr)) throw new Error('this browser has no WebCrypto');
  const kp = await cr.subtle.generateKey(ECDH, false, ['deriveBits']);
  const jwk = await cr.subtle.exportKey('jwk', kp.publicKey);
  const pk = jwk.x + '.' + jwk.y;
  if (!PK_RE.test(pk)) throw new Error('unexpected public key');
  return { pk, priv: kp.privateKey };
}
async function sharedAesKey(cr, priv, peerPk, usage) {
  const [x, y] = String(peerPk).split('.');
  const peer = await cr.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x, y, ext: true }, ECDH, false, []);      // refuses a point that is not on the curve
  const bits = await cr.subtle.deriveBits({ name: 'ECDH', public: peer }, priv, 256);
  const hk = await cr.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return cr.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode(SEAL_INFO) }, hk, { name: 'AES-GCM', length: 256 }, false, [usage]);
}
/**
 * The owner's battle page: seal `room` to the challenger's key `ck`. to = the challenger's sender id, r = the request id (both are bound into the ciphertext).
 * -> { pk, iv, ct } (the three fields of an `acc`). Rejects when there is no WebCrypto or the key is not a usable P-256 point.
 */
export async function sealRoom({ crypto: cr = globalThis.crypto, to, r, ck, room }) {
  if (!canSeal(cr)) throw new Error('this browser has no WebCrypto');
  if (typeof ck !== 'string' || !PK_RE.test(ck)) throw new Error('no challenger key');
  if (typeof room !== 'string' || !ROOM_RE.test(room)) throw new Error('not a room code');
  const eph = await makeKeyPair(cr);
  const key = await sharedAesKey(cr, eph.priv, ck, 'encrypt');
  const iv = cr.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await cr.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aadOf(r, to) }, key, enc.encode(room.toUpperCase())));
  return { pk: eph.pk, iv: b64u(iv), ct: b64u(ct) };
}
/** The challenger: open an `acc` with the private key made for this request. -> the room (upper case) or null for anything that is not a room sealed to us for this request. Never throws. */
export async function unsealRoom({ crypto: cr = globalThis.crypto, priv, to, r, msg }) {
  try {
    if (!canSeal(cr) || !priv || !msg || typeof msg.pk !== 'string' || !PK_RE.test(msg.pk)) return null;
    const key = await sharedAesKey(cr, priv, msg.pk, 'decrypt');
    const pt = await cr.subtle.decrypt({ name: 'AES-GCM', iv: unb64u(msg.iv), additionalData: aadOf(r, to) }, key, unb64u(msg.ct));
    const room = dec.decode(pt);
    return ROOM_RE.test(room) ? room.toUpperCase() : null;
  } catch (_e) { return null; }
}

/**
 * The owner's side.
 *   lobbies   openlobby.js createOpenLobbies(...)
 *   identity  () -> { name, fmt, rec, rom, fp, rs }   what the listing says about this player (read when the switch goes on and whenever refresh() is called)
 *   ui        { show({ name, rec, s, r }), hide() }   the dialog (presence_boot.js); `show` is only called with a request that passed every check
 *   navigate  (url)  called once, after "ok" has been sent, when the owner accepts
 *   hrefFor   (pending, identity) -> url
 *   session   the tab's sessionStorage (where the accept token goes). Left out, this page's own is used; null = none: then Accept cannot be honoured and says "busy" to the challenger instead
 *   wall      () -> wall-clock ms for the token's `at` (default Date.now: `now` is usually the monotonic clock, which means nothing to the next page)
 * -> { start, stop, refresh, accept, decline, isOn, pending }
 */
export function createPresence({ lobbies, identity, ui, navigate, hrefFor, now, timers, random, timing = TIMING, session, wall }) {
  const T = timers || { setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis) };
  const clock = now || (() => Date.now());
  const wallClock = wall || (() => Date.now());
  const store = session !== undefined ? session : (() => { try { return globalThis.sessionStorage || null; } catch (_e) { return null; } })();
  const rnd = random || ((n) => { const a = new Uint8Array(n); globalThis.crypto.getRandomValues(a); return a; });
  let on = false, off = null, label = null, pending = null, pendingTimer = 0, who = null;
  const told = new Map();             // sender id -> when they were told no (a quiet cooldown)
  const answered = new Map();         // request id -> 'ok' | 'declined' | 'busy': a repeated challenge gets the same answer again
  const cancelled = new Set();        // 'sender:request' of a challenge its sender withdrew: a copy of the challenge that arrives AFTER the cancel (another broker was slower) is not a challenge
  const shown = [];                   // when each dialog was shown, for the per-minute cap

  const remember = (map, k, v) => { map.set(k, v); if (map.size > 64) map.delete(map.keys().next().value); };
  const rememberCancel = (k) => { cancelled.add(k); if (cancelled.size > 64) cancelled.delete(cancelled.values().next().value); };
  const reply = (kind, p, extra) => { try { lobbies.signal(kind, { to: p.s, r: p.r, ...(extra || {}) }); } catch (_e) { /* the board is down: the challenger's own timeout says so */ } };
  const clear = () => { T.clearTimeout(pendingTimer); pendingTimer = 0; };
  const dismiss = () => { clear(); pending = null; try { ui.hide(); } catch (_e) { /* ignore */ } };

  function list() {
    who = identity();
    if (label === null) label = residentLabel(rnd);
    lobbies.host({ room: label, name: who.name, fmt: who.fmt, rom: who.rom, fp: who.fp, rs: who.rs, q: false, h: true, rec: who.rec || null });
  }
  function handle(m) {
    if (!on) return;
    if (m.k === 'can') { rememberCancel(m.s + ':' + m.r); if (pending && pending.r === m.r && pending.s === m.s) dismiss(); return; }
    if (m.k !== 'chal') return;
    const p = { s: m.s, r: m.r, name: m.name, rec: m.rec, pk: m.pk };
    const t = clock();
    if (cancelled.has(p.s + ':' + p.r)) return;                                                                                     // withdrawn before this copy arrived
    if (answered.has(p.r)) { const a = answered.get(p.r); if (a === 'ok') reply('ok', p); else reply('dec', p, { why: a }); return; }     // a repeat of one we already answered
    if (pending && pending.r === p.r) return;                                                                                       // a repeat of the one on screen
    if (told.has(p.s) && t - told.get(p.s) < timing.cooldownMs) { remember(answered, p.r, 'declined'); reply('dec', p, { why: 'declined' }); return; }
    while (shown.length && t - shown[0] > 60000) shown.shift();
    if (pending || shown.length >= timing.perMinute) { remember(answered, p.r, 'busy'); reply('dec', p, { why: 'busy' }); return; }
    shown.push(t);
    pending = p;
    pendingTimer = T.setTimeout(() => { if (pending && pending.r === p.r) decline(); }, timing.answerMs);
    try { ui.show({ name: p.name, rec: p.rec, s: p.s, r: p.r }); } catch (_e) { /* a dialog that will not draw: the timeout declines it */ }
  }
  function decline() {
    const p = pending; if (!p) return false;
    dismiss();
    remember(answered, p.r, 'declined'); told.set(p.s, clock());
    reply('dec', p, { why: 'declined' });
    return true;
  }
  function accept() {
    const p = pending; if (!p) return false;
    dismiss();
    // The battle page will host only against the token written here. If it cannot be written the page would refuse, and the challenger would wait for a room that never comes: say "busy" now.
    if (!writeAcceptToken(store, { for: p.s, rq: p.r, ck: p.pk }, wallClock())) { remember(answered, p.r, 'busy'); reply('dec', p, { why: 'busy' }); return false; }
    remember(answered, p.r, 'ok');
    reply('ok', p);
    const href = hrefFor(p, who || identity());
    stop();                                    // the listing comes down: this page is about to go
    navigate(href);
    return true;
  }
  function start() {
    if (on) return false;
    on = true;
    off = lobbies.onSignal(handle);
    list();
    return true;
  }
  function stop() {
    if (!on) return false;
    on = false;
    if (off) { off(); off = null; }
    dismiss();
    lobbies.unhost();
    return true;
  }
  /** The trainer changed (a rename, another profile): say so on the board. */
  function refresh() { if (on) list(); }
  return { start, stop, refresh, accept, decline, isOn: () => on, pending: () => (pending ? { ...pending } : null), get label() { return label; } };
}

/**
 * The challenger's side: ask one resident game to battle, and learn the room.
 *   target  the board entry (its `s` is who is asked)         on  { state(name), accepted(room), failed(why) }   why = 'declined' | 'busy' | 'timeout' | 'unsupported' (no WebCrypto: nothing is sent)
 * The challenge is sent once a one-time key pair exists (a moment: WebCrypto is asynchronous); `ready` resolves when it has gone out (false: it will not).
 * -> { r, cancel, done, ready }
 */
export function createChallenge({ lobbies, target, name, rec, now, timers, timing = TIMING, on, crypto: cr = globalThis.crypto }) {
  const T = timers || { setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis), setInterval: globalThis.setInterval.bind(globalThis), clearInterval: globalThis.clearInterval.bind(globalThis) };
  const r = lobbies.newRequest();
  let finished = false, okSeen = false, resend = 0, wait = 0, kp = null;
  const send = () => { if (!kp) return; try { lobbies.signal('chal', { to: target.s, r, name, pk: kp.pk, ...(rec ? { rec } : {}) }); } catch (_e) { /* the board is down: the timeout says so */ } };
  const end = () => { finished = true; T.clearInterval(resend); T.clearTimeout(wait); resend = wait = 0; unsub(); };
  const fail = (why) => { if (finished) return; end(); try { on.failed(why); } catch (_e) { /* ignore */ } };
  const unsub = lobbies.onSignal((m) => {
    if (finished || m.r !== r) return;
    if (m.k === 'acc') {                                                                                    // from the owner's NEW page: matched by the request id, and OPENED with our one-time key
      if (!kp) return;
      unsealRoom({ crypto: cr, priv: kp.priv, to: lobbies.sid, r, msg: m }).then((room) => {
        if (finished || !room) return;                                                                      // not sealed to us (a forger, a stale copy): ignored, we keep waiting for the real one
        end(); try { on.accepted(room); } catch (_e) { /* ignore */ }
      });
      return;
    }
    if (m.s !== target.s) return;                                                                          // ok / dec only count from the one that was asked
    if (m.k === 'ok' && !okSeen) {
      okSeen = true; T.clearInterval(resend); resend = 0;
      T.clearTimeout(wait); wait = T.setTimeout(() => fail('timeout'), timing.connectMs);
      try { on.state('accepted'); } catch (_e) { /* ignore */ }
    } else if (m.k === 'dec') fail(m.why === 'busy' ? 'busy' : 'declined');
  });
  wait = T.setTimeout(() => fail('timeout'), timing.answerMs + 2000);
  const ready = (async () => {
    kp = await makeKeyPair(cr);                    // no WebCrypto: this throws, and nothing at all is sent
    if (finished) return false;
    send();
    resend = T.setInterval(send, timing.resendMs);
    return true;
  })().catch(() => { fail('unsupported'); return false; });
  return {
    r, ready,
    cancel() { if (finished) return false; try { lobbies.signal('can', { to: target.s, r }); } catch (_e) { /* ignore */ } end(); return true; },
    done: () => finished,
  };
}

/**
 * The owner's battle page, after Accept: say "come in" to the challenger until they are in (or it is not wanted any more). The room is SEALED to the challenger's key `ck` (from the accept
 * token): the board carries { pk, iv, ct }, never the room. If it cannot be sealed (no WebCrypto, a key that is not a P-256 point) nothing is sent and onFail(error) says why.
 * `ready` resolves true when the first "come in" has gone out.
 * -> { stop, live, ready }
 */
export function createAcceptor({ lobbies, to, r, room, ck, crypto: cr = globalThis.crypto, timers, timing = TIMING, onFail }) {
  const T = timers || { setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis), setInterval: globalThis.setInterval.bind(globalThis), clearInterval: globalThis.clearInterval.bind(globalThis) };
  let timer = 0, limit = 0, live = true, sealed = null;
  const send = () => { if (!live || !sealed) return; try { lobbies.signal('acc', { to, r, ...sealed }); } catch (_e) { /* ignore */ } };
  const stop = () => { live = false; T.clearInterval(timer); T.clearTimeout(limit); timer = limit = 0; };
  timer = T.setInterval(send, timing.accResendMs);
  limit = T.setTimeout(stop, timing.accForMs);
  const ready = sealRoom({ crypto: cr, to, r, ck, room }).then(
    (s) => { if (!live) return false; sealed = s; send(); return true; },
    (e) => { stop(); try { if (onFail) onFail(e); } catch (_e) { /* ignore */ } return false; });
  return { stop, live: () => live, ready };
}

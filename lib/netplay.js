// lib/netplay.js — pair two browsers and exchange emulator input between them.
//
// WHY THIS SHAPE. The site is STATIC (GitHub Pages), so there is no server to
// relay a game session and no place to keep a list of who is online. Everything
// here therefore runs in the two browsers, and the only thing that ever needs an
// outside party is SIGNALLING — the one-time exchange of connection offers that
// WebRTC needs before the peers can talk directly. After that the game data goes
// peer-to-peer and touches no third party at all.
//
// SIGNALLING IS PLUGGABLE ON PURPOSE, because the two transports answer
// different questions and neither one alone is enough:
//   'local'  BroadcastChannel — same browser only. It cannot pair two devices,
//            but it is REAL pairing between two page contexts, so the whole
//            protocol (offer/answer, channel open, input exchange, drop) can be
//            tested headlessly with no network and no third-party service. This
//            is what the test harness uses.
//   'peerjs' the public PeerJS broker — cross-device, no infrastructure to run.
//            ⚠ A third party we do not control. It is used ONLY to trade the
//            connection offer; it never sees a frame of gameplay. If it is down,
//            pairing fails and the page must keep working single-player, which
//            is why every entry point below is guarded and non-fatal.
//
// THE MODEL: EVERY MACHINE RUNS THE GAME. There are N cores, one per player's
// machine, and the only thing that crosses the wire is pad bytes. Each core
// advances emulated frame F once it holds every occupied port's input for F.
// A player's OWN input is applied locally — it never makes a network trip
// before something moves — which is the whole requirement: "the players should
// act as if they are connected to the same console - and need to be."
// Up to as many players as the console has ports (four on Dreamcast).
// Detail, including the lobby-first start and the desync reporting, is in the
// block above class Lockstep.
//
// STREAMING IS CANCELLED — the previous architecture, recorded here because
// this comment argued for it and the argument was wrong in the way that
// matters. One machine ran the emulator and sent an encoded picture to
// everyone else, who sent controller state back. It made every player but the
// host a spectator with a joypad: their every button cost a network round trip
// plus an encode plus a decode before the screen moved. A console does not
// work that way. attachMedia()/remoteStream() are still defined below — they
// are harmless and deleting them is churn — but nothing routes to them, there
// is no mode selector, and no page should reach them.
//
// ⚠ WHAT THE OLD ARGUMENT GOT RIGHT, AND WHICH STILL STANDS: lockstep requires
// the cores to be FRAME-DETERMINISTIC — same frame, same inputs, same starting
// state, forever — and a divergence is permanent. NOTHING IN THIS FILE HAS
// ESTABLISHED THAT; it is measured separately and it is the real risk.
// What has changed is the conclusion drawn from it. That risk is not a reason
// to ship an architecture the product does not want; it is the work. So this is
// built to FIND divergence rather than to avoid depending on its absence:
//   * two things are removed as sources of it rather than compensated for —
//     everyone boots the same disc from frame 0 (no savestate is transferred,
//     so no restore can fail silently into a cold boot), and every machine
//     plugs exactly one controller per player before load, so the device set is
//     identical too;
//   * every machine fingerprints its core every hashEvery frames, and a
//     mismatch STOPS the session and reports which frame, which peer, which
//     field, and the last frame everyone agreed on — a divergence is a work
//     list to be shortened, not a mystery to be endured;
//   * a missing input STALLS. It is never guessed, because a guess is a silent
//     permanent fork.
// The frame-exchange helpers further down (exchange/sendPad) predate all of
// this; they are kept because they are tested and cost nothing.
//
// ===========================================================================
// WHO IS ALLOWED IN — added 2026-09-08 after an independent audit
// (docs/audit-2026-09-08.md, "New finding: any session can be joined by a
// stranger") found that a session had NO AUTHENTICATION OF ANY KIND.
//
// WHAT WAS WRONG. The host registered on the PUBLIC PeerJS broker as
// `bemental-<CODE>-h` and ran `peer.on('connection', wire)` — it accepted every
// inbound connection — then sent an SDP offer CARRYING ITS VIDEO AND AUDIO
// TRACKS the moment start() returned. The 5-character room code was the only
// secret (32^5 = 33,554,432) and it was written into a fixed, globally visible
// broker id, so anyone who guessed or enumerated one got:
//   * the host's live screen and sound;
//   * player-2 input into the running game;
//   * whatever sendSave() transmitted at the end of the session.
//
// THREE THINGS CHANGED, and the order matters:
//
// 1. THE OFFER IS NOT PUBLISHED UNTIL A HUMAN SAYS YES. The media is IN the
//    offer, so anything that gates after the DataChannel opens is already too
//    late. The host now builds its RTCPeerConnection, adds its tracks and
//    creates its DataChannel, and then STOPS — no createOffer, no
//    setLocalDescription, so not one ICE candidate is gathered either (the
//    host's LAN addresses used to go out to any caller). approve() is what
//    creates and sends the offer.
//    A human in the loop is the only thing that separates "the friend I read
//    the code to" from "someone who guessed it", which is why this and not a
//    longer code is the primary control. A longer code would also have to stop
//    being something you can say out loud.
//
// 2. THE BROKER NEVER SEES THE CODE. The peer id is now derived through
//    PBKDF2-SHA256 (120k iterations) instead of containing the code verbatim,
//    and joining requires an HMAC proof over a per-session challenge, so
//    knowing the broker id is no longer the same as knowing the code. The
//    broker is a third party we do not control; the audit's constraint was that
//    the fix must not depend on it keeping anything secret, and none of this
//    does — approval is the gate, this only stops a bystander getting as far as
//    the prompt.
//
// 3. LEAST PRIVILEGE REGARDLESS. remotePad() reads 0, inbound pad/input/save
//    messages are dropped, and sendSave() refuses, for as long as the peer is
//    unapproved — belt and braces behind (1), so that a future change which
//    opens a channel earlier cannot quietly re-expose the game.
//
// ⚠ RESIDUAL, STATED PLAINLY. An attacker who knows the code AND can take over
// the signalling connection in the instant between the prompt appearing and the
// human clicking Allow can still receive the offer that was meant for someone
// else — the signalling relay is untrusted by construction and cannot be made
// to address one peer honestly. That is what the four-character CONFIRMATION
// CODE in the prompt is for: both sides derive it from the challenge, and a
// host who reads it out to the person joining will not be talking to anybody
// else. approve() also locks the signalling socket against further callers.
// ===========================================================================
'use strict';

(function (global) {
  // 2: joining takes a proof + host approval. A version-1 peer cannot pair with
  // a version-2 one and is told so rather than left hanging.
  const PROTO = 2;
  const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no I/O/0/1

  function makeCode(n) {
    let s = '';
    const a = new Uint8Array(n);
    (global.crypto || {}).getRandomValues ? crypto.getRandomValues(a) : a.forEach((_, i) => (a[i] = Math.random() * 256));
    for (let i = 0; i < n; i++) s += CODE_ALPHABET[a[i] % CODE_ALPHABET.length];
    return s;
  }

  // ---- the room code as a KEY, not as a name ---------------------------------
  // The code used to BE the broker id. Two separate values are derived from it
  // instead, so the id the broker stores is not the secret and not the key:
  //   idHex  the peer id registered on the broker
  //   key    an HMAC key, used to prove code knowledge over a fresh challenge
  //
  // ⚠ PBKDF2 AND NOT A PLAIN HASH, because the code only carries ~25 bits. A
  // single SHA-256 would let anyone holding a broker id (or one recorded proof)
  // walk all 33.5 M codes in seconds. 120,000 iterations costs the two real
  // participants one derivation each — measured in the low hundreds of ms — and
  // multiplies an offline sweep by the same factor.
  //
  // ⚠ NEEDS A SECURE CONTEXT (crypto.subtle). https and localhost have one; a
  // page opened over plain http on a LAN address does not, and there the id
  // falls back to the old plaintext form and the proof is skipped, so BOTH
  // sides must be in the same boat to pair. Approval still gates everything.
  const KDF_ITERATIONS = 120000;
  const KDF_SALT = 'bemental-netplay-v1';
  const _roomKeys = new Map();      // room -> Promise<{ key, idHex }>

  function subtle() {
    const c = global.crypto || (typeof crypto !== 'undefined' ? crypto : null);
    return (c && c.subtle) ? c.subtle : null;
  }
  function utf8(s) { return new TextEncoder().encode(s); }
  function toHex(buf) {
    const b = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < b.length; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16);
    return s;
  }
  function randomHex(nBytes) {
    const a = new Uint8Array(nBytes);
    if (global.crypto && global.crypto.getRandomValues) global.crypto.getRandomValues(a);
    else for (let i = 0; i < nBytes; i++) a[i] = (Math.random() * 256) | 0;
    return toHex(a);
  }
  // ⚠ AN IDENTITY THAT SURVIVES A RELOAD, BECAUSE A RELOAD IS PART OF THIS FLOW.
  // A session's nonce is what owns a maple port: `startLockstep` passes it as
  // `peerId` and the host's roster is a list of them. It used to be a fresh
  // randomHex(8) per Session, i.e. per PAGE LOAD — so a console that came back
  // (a phone discarding a backgrounded tab, a pull-to-refresh, or the room
  // hand-off's own deliberate `location.replace`, which dreamcast.html performs
  // on purpose whenever a room is formed from a running game) presented as a
  // COMPLETE STRANGER. The host then either seated it in a SECOND port beside
  // the ghost of its old one, or — if it had already unseated the ghost — asked
  // a human to admit it again while nobody was looking at that screen.
  //
  // Keyed by role and room code, in sessionStorage: it survives a reload of THIS
  // tab, dies with the tab, and never leaks between two tabs (so two profiles,
  // or two tabs, are still two players). Storage can throw outright — Safari
  // private mode, a browser set to block site data — and a thrown getItem must
  // degrade to the old behaviour rather than fail the pairing.
  function stableNonce(room, isHost) {
    const k = 'bemental-np-id:' + (isHost ? 'h:' : 'g:') + String(room || '');
    try {
      const ss = global.sessionStorage;
      if (!ss) return randomHex(8);
      const v = ss.getItem(k);
      if (v && /^[0-9a-f]{16}$/.test(v)) return v;
      const n = randomHex(8);
      ss.setItem(k, n);
      return n;
    } catch (e) { return randomHex(8); }
  }
  async function roomKey(room) {
    if (_roomKeys.has(room)) return _roomKeys.get(room);
    const p = (async () => {
      const s = subtle();
      if (!s) return { key: null, idHex: null };
      try {
        const base = await s.importKey('raw', utf8(String(room)), 'PBKDF2', false, ['deriveBits']);
        const bits = await s.deriveBits(
          { name: 'PBKDF2', salt: utf8(KDF_SALT), iterations: KDF_ITERATIONS, hash: 'SHA-256' }, base, 256);
        const key = await s.importKey('raw', bits, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
        // The id is a SEPARATE derivation off the key, so what the broker holds
        // is not the key the proofs are signed with.
        const id = await s.sign('HMAC', key, utf8('peer-id'));
        return { key, idHex: toHex(id).slice(0, 16) };
      } catch (e) { return { key: null, idHex: null }; }
    })();
    _roomKeys.set(room, p);
    return p;
  }
  // null when there is no crypto to do it with — callers treat that as "cannot
  // prove, cannot verify" and say so rather than pretending either way.
  async function mac(room, msg) {
    const { key } = await roomKey(room);
    const s = subtle();
    if (!key || !s) return null;
    try { return toHex(await s.sign('HMAC', key, utf8(msg))); } catch (e) { return null; }
  }
  // Compare without an early return on the first differing character.
  function sameMac(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || !a.length) return false;
    let d = 0;
    for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return d === 0;
  }
  // THE CONFIRMATION CODE both sides show. Four characters off the same
  // alphabet as a room code, derived from the challenge and the joiner's nonce,
  // so it is different every time and cannot be predicted by anyone who does
  // not hold the room key. It is what makes a hijacked pairing VISIBLE.
  async function sasFor(room, nonce, chal) {
    const h = await mac(room, 'sas|' + nonce + '|' + chal);
    if (!h) return null;
    let s = '';
    for (let i = 0; i < 4; i++) s += CODE_ALPHABET[parseInt(h.substr(i * 2, 2), 16) % CODE_ALPHABET.length];
    return s;
  }

  // ---- signalling transports -------------------------------------------------
  // Each exposes: send(msg), onMessage(cb), close(). `msg` is a plain object and
  // is always tagged with the room code so a broker that fans out cannot cross
  // two sessions.
  function localSignal(room) {
    const ch = new BroadcastChannel('netplay:' + room);
    let cb = null;
    ch.onmessage = (e) => { if (cb && e.data && e.data.room === room) cb(e.data); };
    return {
      kind: 'local',
      send: (m) => ch.postMessage(Object.assign({ room }, m)),
      onMessage: (f) => { cb = f; },
      // Shape parity with peerSignal. A BroadcastChannel has no socket that can
      // drop, so there is never anything to report — but the session calls this
      // unconditionally and a missing method would throw on the 'local'
      // transport only, i.e. in exactly the arm the tests run.
      onError: () => {},
      onGone: () => {},
      // A BroadcastChannel is a broadcast — there is no socket to refuse, and
      // every page in this browser can hear everything. That is fine for the
      // headless tests it exists for, and it is why the addressing below is by
      // NONCE rather than by connection. It is also why a room on this
      // transport is not evidence that a room works on a real one: only the
      // peerjs arm has per-caller sockets to get wrong.
      lock: () => {},
      close: () => { try { ch.close(); } catch (e) {} },
    };
  }

  // ⚠ THE SIGNALLING PATH COULD HANG FOREVER, SILENTLY — and it is what a user
  // hit on production: host frozen on "Waiting for someone to join with code
  // EUQTF…", guest frozen on "Looking for the host…", neither screen ever
  // saying anything else. Both of those strings are the page's rendering of
  // state 'signalling', so ANY stall between `start()` and the data channel
  // opening looks exactly like that. There were three distinct ways to get
  // stuck there, none of which reported a fault anywhere:
  //
  //   1. NEVER-SETTLING PROMISE. `new Peer()` that never fires 'open' — an
  //      unreachable, rate-limited or half-open broker socket — left the
  //      promise below pending forever, so `await peerSignal(...)` in start()
  //      never returned, and no status after 'signalling' was ever emitted.
  //      PEER_OPEN_TIMEOUT_MS bounds it: a broker that has not issued an id by
  //      then is a failed broker and is reported as one.
  //
  //   2. ERRORS AFTER 'open' WENT NOWHERE. The error handler called reject(),
  //      but once peer.on('open') has resolved the promise, reject() is a
  //      no-op — so a broker socket that dropped mid-session was swallowed
  //      whole and the session kept waiting on a dead transport. The transport
  //      now carries an onError() channel that stays live for its whole life.
  //
  //   3. UNBOUNDED SILENT KNOCKING. 'peer-unavailable' means "no peer with
  //      that id is registered", i.e. the host has not opened its side yet.
  //      Retrying is right, but it retried forever with nothing on screen, so
  //      a MISTYPED CODE was indistinguishable from a slow host — both are an
  //      eternal "Looking for the host…". It is bounded and announced now:
  //      after PEER_MAX_KNOCKS the guest is told that nobody is hosting that
  //      code, which is a thing a person can act on.
  //
  // The timeout is generous on purpose. A phone on a bad connection that is
  // still making progress must not be cut off; these values only fire when
  // something is genuinely not going to happen.
  // ---- ICE: what makes two browsers able to reach each other ----------------
  //
  // ⚠ EVERY PUBLIC RELAY IS DEAD, AND ONE OF THEM IS DEAD *INSIDE PEERJS*. This
  // block is the honest version of a fix I nearly shipped decorative: I added
  // peerjs's own TURN servers here, and only then measured them.
  //
  // Measured 2026-09-08 from this machine, by counting the candidate TYPES a
  // real RTCPeerConnection gathers (an entry in an iceServers array proves
  // nothing; only a 'relay' candidate does). Not one returned a relay:
  //   turn:eu-0.turn.peerjs.com:3478   701 TURN host lookup received error
  //   turn:us-0.turn.peerjs.com:3478   701 TURN host lookup received error
  //   turn:openrelay.metered.ca:80     400 TURN allocate error
  //   turn:openrelay.metered.ca:443    400 TURN allocate error   (udp and tcp)
  //   turns:global.relay.metered.ca:443  400 TURN allocate error
  //   turn:standard.relay.metered.ca:80  400 TURN allocate error
  //   turn:numb.viagenie.ca / freeturn / anyfirewall  701 lookup / no connection
  // And the peerjs ones do not resolve AT ALL — `dig +short A
  // eu-0.turn.peerjs.com @8.8.8.8` is empty, so it is not this network's
  // resolver. That matters far beyond this array: peerjs 1.5.4 hardcodes those
  // two as its DEFAULT iceServers, so THE SIGNALLING CHANNEL ITSELF has no
  // working relay either. Two browsers on networks that will not let them talk
  // directly therefore fail at the broker's DataConnection, before this file's
  // RTCPeerConnection is ever reached — which is precisely the reported
  // symptom: host frozen on "Waiting for someone to join…", guest frozen on
  // "Looking for the host…", forever.
  //
  // So STUN is what ships, because a relay that does not relay is a lie in a
  // config object. A REAL relay is one setting away and there are three ways in
  // (page config, a global, or ?turn= for testing) — see turnFromEnv().
  const STUN = [{ urls: 'stun:stun.l.google.com:19302' }];

  // turn:HOST:PORT|username|credential  — pipe-separated so a credential
  // containing ':' survives. Accepts several, comma-separated.
  function turnFromEnv() {
    let raw = null;
    try { raw = (global.NETPLAY_TURN || null); } catch (e) {}
    try {
      if (!raw && global.location) raw = new URLSearchParams(global.location.search).get('turn');
    } catch (e) {}
    if (!raw) return [];
    return String(raw).split(',').map((one) => {
      const bits = one.split('|');
      if (!bits[0]) return null;
      const srv = { urls: bits[0].trim() };
      if (bits.length > 1) { srv.username = bits[1]; srv.credential = bits[2] || ''; }
      return srv;
    }).filter(Boolean);
  }

  let extraIce = [];
  function iceServers() { return STUN.concat(extraIce, turnFromEnv()); }

  const PEER_OPEN_TIMEOUT_MS = 15000;   // broker must issue an id within this
  const PEER_KNOCK_MS = 1200;           // gap between "is the host there yet?"
  const PEER_MAX_KNOCKS = 30;           // ~36s of knocking before we say nobody is home
  // ⚠ A DIALLED CONNECTION THAT NEVER OPENS AND NEVER ERRORS. This is the
  // fourth and worst stall, and the one that best fits the reported failure: a
  // peerjs DataConnection is ITSELF a WebRTC connection, so when the two
  // networks cannot carry a direct path it is created, emits no error, and
  // simply never opens. The guest had no timer on it — it dialled once and
  // waited forever on a socket that was never going to come up, which is an
  // eternal "Looking for the host…" with the host equally unaware on the other
  // side. A dial that has not opened by then is a failed dial: hang up and
  // knock again, and if the budget runs out, say what actually went wrong.
  const PEER_DIAL_OPEN_MS = 6000;
  // How long ICE gets to find a path once both sides have an offer. Generous:
  // gathering plus checking on a slow mobile link is routinely several seconds,
  // and cutting off a connection that was going to succeed is worse than a late
  // message.
  const ICE_CONNECT_MS = 25000;
  // How long a WebRTC 'disconnected' blip may last before the link is declared
  // dead. Chrome's own consent-freshness failure takes ~30 s to reach 'failed';
  // a cellular hand-off recovers in a few seconds. 12 s catches the second
  // without waiting for the first. See pc.onconnectionstatechange.
  const DISCONNECT_GRACE_MS = 12000;

  // ---- WHEN THE GAME PATH CANNOT OPEN AT ALL --------------------------------
  //
  // Pairing no longer needs the two networks to reach each other; the GAME
  // still does. When ICE_CONNECT_MS expires the session used to say "one of
  // these networks is blocking direct peer-to-peer traffic … needs a relay
  // server" and end. That sentence is true and it is still a dead end for the
  // person reading it, because there is no working free relay to point them at.
  //
  // Lockstep sends a few bytes per frame per player. That fits down the
  // signalling relay, so instead of ending, the room CARRIES THE PADS OVER THE
  // SAME WEBSOCKET. A playable slow room beats "cannot connect".
  //
  // ⚠ AND THE PLAYER IS TOLD WHICH ONE THEY HAVE. A relayed room is not a
  // direct room that happens to be slower; the input delay it forces is a
  // different game feel, and hiding that would make the product feel broken
  // rather than degraded. session.relay carries the measured one-way time and
  // the delay it forces, roomInfo() reports it, and a 'relay' event fires so a
  // page can say so on screen.
  //
  // ⚠ WHAT RELAY MODE COSTS IN PRIVACY, STATED PLAINLY. A direct room's game
  // traffic is peer-to-peer and touches no third party. A relayed room's does
  // not: the pads go through a public broker. They are sealed twice — once by
  // the transport under the room key, and again under a PER-LINK key derived
  // from the room key, the joiner's nonce and the pairing challenge — so a
  // stranger sees nothing and cannot inject. But the challenge crossed that
  // same topic, so somebody who knew the room CODE *and* was subscribed during
  // the handshake could follow it. That is exactly the residual already
  // documented at the top of this file for pairing; relay mode extends it from
  // the handshake to the pad traffic, and does not create a new one. Someone
  // who learns the code afterwards gets nothing.
  //
  // Off with ?relay=0 / window.NETPLAY_NO_RELAY = true.
  const RELAY_BATCH_MS = 33;      // coalesce a couple of frames per publish
  // ===========================================================================
  // ⚠ THE RELAY LOSES MESSAGES, AND LOCKSTEP CANNOT SURVIVE ONE.
  //
  // MEASURED, not assumed. Two browsers, a direct peer path made impossible
  // (relay-only ICE, no relay configured), production code, the counters in
  // this file (/tmp/dc-xdev/diag2.stdout):
  //     host  pub:46 rxOk:46 dropSeq:0 gapSeq:12     joiner published 58
  //     join  pub:58 rxOk:42 dropSeq:0 gapSeq:1  dropAuth:3
  // 46 + 12 = 58 exactly: TWELVE of the joiner's fifty-eight publishes never
  // arrived — 20.7% loss — and `dropSeq:0` says the reorder guard did not do
  // it. A free public MQTT broker at QoS 0 is a datagram service.
  //
  // What that does to a lockstep room is not "jitter": it is a PERMANENT
  // deadlock on the first loss, because a frame's input is sent exactly once
  // and the engine will never guess. The two consoles read, in their own
  // words, with the frames each actually held for the port it was waiting on:
  //     host  HELD port1 = 6..22,24..30   (want f=23)
  //     join  HELD port0 = 6..23,25..29   (want f=24)
  // A HOLE, not a horizon — inputs present ABOVE the missing frame. No amount
  // of extra input delay repairs a hole, which is why the delay-raise
  // machinery fired ten times into that stall and changed nothing.
  //
  // THE FIX IS RETRANSMISSION, AND IT IS FREE OF NEW PROTOCOL because lockstep
  // bounds its own divergence. A peer stalled at frame g cannot let its
  // partner past g+delay, and that partner has therefore queued no further
  // than g+2*delay — so a window of 2*delay frames PROVABLY covers every frame
  // any peer can still be waiting for. Every publish carries that whole
  // window, run-length compressed (a held button is one run), so a lost
  // publish is repaired by the next one with no ACK, no NACK and no round
  // trip. Input is idempotent — the same pad bytes for the same frame — so a
  // repeat cannot change what any core simulates.
  //
  // ⚠ AND SOMETHING MUST STILL BE PUBLISHED WHILE STALLED. A stalled peer
  // stops advancing frames, so it stops producing new input, so nothing would
  // flush and the window would never be re-sent — the deadlock would hold with
  // the cure sitting in memory. RELAY_REPAIR_MS re-publishes the window while
  // the room is live, and stops on its own when the room is not.
  // ===========================================================================
  const RELAY_REPAIR_MS = 150;    // republish the input window this often while a room is live
  const RELAY_WIN_MIN = 24;       // frames; floor for the retransmission window
  const RELAY_WIN_MAX = 96;       // frames; ceiling, so a wedged room cannot grow one without bound
  const RELAY_MAX_DELAY = 30;     // frames; past this the room is not worth playing
  const RELAY_PING_MS = 4000;     // how often relay round-trip is re-measured
  // A relayed link has no socket to drop and its RTCPeerConnection is closed,
  // so silence is the only way to notice somebody left. Several missed beats,
  // because one lost publish on a free broker is ordinary.
  const RELAY_DEAD_MS = 20000;

  // PeerJS is loaded lazily and ONLY when a cross-device session is requested, so
  // a page that never opens the lobby pays nothing and works with the script
  // blocked entirely.
  async function peerSignal(room, opts) {
    // ⚠ THE ID IS DERIVED, NOT THE CODE. `bemental-<CODE>-h` handed the room's
    // only secret to a third party and put every live session in one guessable
    // namespace. What the broker sees now is 16 hex characters of PBKDF2 output.
    const { idHex } = await roomKey(room);
    const base = 'bemental-' + (idHex || room);
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (msg) => { if (settled) return; settled = true; reject(new Error(msg)); };
      const start = () => {
        try {
          // ⚠ EVERY JOINER USED THE SAME BROKER ID, WHICH CAPPED THE ROOM AT TWO.
          // This was `base + '-g'` for every guest, so the second joiner asked
          // the broker for an id the first one already held and died with
          // `unavailable-id`. Measured by the room rig: four cores boot fine and
          // the console has four Maple ports, but players 3 and 4 could never
          // register — a two-seat room wearing four-player clothes, and nothing
          // about ports or determinism would have revealed it.
          // The host keeps a DERIVED, PREDICTABLE id because that is the one a
          // joiner has to be able to dial from the code alone. A joiner needs no
          // such property — it dials out and is never dialled — so it gets a
          // random suffix, which also means a joiner leaking its id tells nobody
          // anything about the room.
          const id = base + (opts.host ? '-h' : '-g' + randomHex(8));
          const peer = new global.Peer(id, { debug: 0 });
          let cb = null, conn = null, locked = false, onErr = null, onGone = null, knocks = 0;
          // The timer on the dial currently in flight. It has to be cancellable
          // from the error handler: 'peer-unavailable' arrives ABOUT that dial
          // and settles the question — nobody is there — so letting its timer
          // also fire would report a mistyped code as a blocked network, which
          // is a confidently wrong diagnosis and worse than none.
          let dialTimer = null;
          const cancelDial = () => { if (dialTimer) { clearTimeout(dialTimer); dialTimer = null; } };
          // Reported through onError() rather than thrown, because by the time
          // most of these can happen the promise is long since resolved and
          // throwing would land in nobody's catch. `dead` stops a late error
          // from re-reporting after the caller has closed the transport.
          let dead = false;
          const report = (msg) => { if (!dead && onErr) { try { onErr(msg); } catch (e) {} } };
          // ⚠ 1 above: a broker that never issues an id must not stall the
          // session forever. Cleared on 'open'.
          const openTimer = setTimeout(() => {
            try { peer.destroy(); } catch (e) {}
            fail('the signalling broker did not answer — it may be down or blocked on this network');
          }, PEER_OPEN_TIMEOUT_MS);
          // ⚠ AN OUTBOX IS NOT OPTIONAL HERE, and leaving it out is what made the
          // first cross-device attempt fail with both peers stuck at
          // "signalling" while the broker script loaded fine (HEAD 200):
          //   * a PeerJS DataConnection SILENTLY DISCARDS anything sent before
          //     its own 'open' fires — and the session sends its offer the moment
          //     start() returns; and
          //   * the HOST has no connection at all until a guest arrives, so its
          //     offer is written into nothing.
          // Everything is therefore queued and flushed on open, and the host
          // re-flushes when a guest connects, so a late joiner still gets the
          // offer it needs.
          //
          // ⚠ AND A ROOM NEEDS ONE SOCKET PER CALLER, NOT ONE SOCKET. This used
          // to keep a single `conn` that every `wire()` REPLACED, which capped a
          // room at one guest for a reason that had nothing to do with ports:
          // the second joiner's socket overwrote the first's, so the host could
          // only ever be addressing one person. The host now keeps every
          // caller's socket and addresses messages BY NONCE.
          const outbox = [];               // [{ to, m }] — `to` is a nonce, or null for "everyone"
          const conns = new Set();         // host: one per caller. guest: its single dial.
          const byNonce = new Map();       // nonce -> the socket that nonce is CURRENTLY on
          const incByNonce = new Map();    // nonce -> the page-load id last seen for it
          const openConns = () => { const o = []; for (const c of conns) if (c.open) o.push(c); return o; };
          const deliver = (c, m) => { try { c.send(m); return true; } catch (e) { return false; } };
          const flush = () => {
            const keep = [];
            for (const item of outbox) {
              if (item.to) {
                // ⚠ AN ADDRESSED MESSAGE IS NEVER BROADCAST AS A FALLBACK. The
                // offer is addressed, and the offer carries the game; sending it
                // to "whoever is connected" because the intended socket is not
                // ready yet is precisely the leak the admission gate exists to
                // stop. Hold it instead — the socket opening re-runs this.
                const c = byNonce.get(item.to);
                if (c && c.open && deliver(c, item.m)) continue;
                keep.push(item);
                continue;
              }
              const o = openConns();
              if (!o.length) { keep.push(item); continue; }
              for (const c of o) deliver(c, item.m);
            }
            outbox.length = 0;
            for (const k of keep) outbox.push(k);
          };
          const wire = (c) => {
            // ⚠ `locked` NOW MEANS "THE ROOM IS FULL", NOT "SOMEBODY IS IN".
            // It used to be set at the top of approve() to stop a late caller
            // REPLACING `conn` and being handed the offer just approved for
            // someone else. That hazard is now removed structurally rather than
            // raced — see the nonce binding below — so the door only shuts when
            // there is no seat left to give away.
            if (locked) { try { c.close(); } catch (e) {} return; }
            // A guest dials out and keeps exactly one socket; a stale dial that
            // is still open would double-send every hello.
            if (!opts.host) for (const old of conns) if (old !== c) { try { old.close(); } catch (e) {} conns.delete(old); }
            conns.add(c);
            conn = c;
            c.on('data', (d) => {
              if (!d || d.room !== room) return;
              // ⚠ A NONCE IS BOUND TO THE SOCKET IT FIRST SPOKE ON. Without
              // this, any caller could put somebody else's nonce in a message
              // and the host's next addressed reply — the OFFER included — would
              // be delivered to the impostor. Binding is strictly stronger than
              // the old "last caller wins, then lock": there is no window at all,
              // and it is what makes addressing several guests safe.
              // The binding is dropped when the socket closes, because a guest
              // whose dial died legitimately knocks again with the same nonce on
              // a new one.
              if (d.n) {
                // ⚠ ONE EXCEPTION, AND IT IS THE RELOAD: THE SAME PERSON ON A
                // NEW PAGE DIALS A NEW SOCKET. A nonce is stable across a page
                // load now (see stableNonce), and a PeerJS DataConnection is
                // not — so a returning player arrives on a socket the host has
                // never seen, holding a nonce bound to the corpse of the last
                // one. Refusing that rebind is silent and total: the host's
                // 'ready' is addressed BY NONCE and goes to the dead socket,
                // every retry from the live one is dropped here, and the only
                // thing that reaches the log is 'a caller was refused: bad
                // proof' when a message from the dying page answers a challenge
                // that has already been replaced. Measured exactly that way in
                // dreamcast/tools/room_crossdevice_test.mjs (arm joiner-reload,
                // the SECOND navigation): host "P1 you · P2 open", joiner "the
                // session has not published a room yet".
                // The rebind is gated on a hello carrying a NEW incarnation, so
                // a replayed message cannot move a binding, and admission is
                // unaffected either way: nothing is published until the caller
                // proves it holds the room key and a human (or a prior Allow
                // for that same identity) admits it.
                const bound = byNonce.get(d.n);
                if (!bound) byNonce.set(d.n, c);
                else if (bound !== c) {
                  const fresh = (d.t === 'hello' && d.inc && incByNonce.get(d.n) !== d.inc);
                  if (!fresh) return;
                  byNonce.set(d.n, c);
                }
                if (d.t === 'hello' && d.inc) incByNonce.set(d.n, d.inc);
              }
              if (cb) cb(d);
            });
            c.on('close', () => {
              conns.delete(c);
              const lost = [];
              for (const [k, v] of byNonce) if (v === c) { lost.push(k); byNonce.delete(k); incByNonce.delete(k); }
              if (onGone && lost.length) { try { onGone(lost); } catch (e) {} }
            });
            if (c.open) { flush(); return; }
            c.on('open', flush);
            if (opts.host) return;          // the host answers dials, it does not place them
            cancelDial();
            dialTimer = setTimeout(() => {
              dialTimer = null;
              if (c.open) return;
              try { c.close(); } catch (e) {}
              conns.delete(c);
              if (conn === c) conn = null;
              knock('dial');
            }, PEER_DIAL_OPEN_MS);
            c.on('open', cancelDial);
          };
          // `why` is 'absent' when the broker said no such peer, 'dial' when the
          // peer IS registered but the connection to it would not come up. They
          // are completely different faults and used to produce the same blank
          // screen: the first is a wrong code, the second is a network that
          // will not carry a direct path.
          let sawDialFailure = false;
          const knock = (why) => {
            if (why === 'dial') sawDialFailure = true;
            knocks += 1;
            if (knocks > PEER_MAX_KNOCKS) {
              report(sawDialFailure
                ? 'found the host, but the two browsers could not open a connection — one of these networks is blocking direct peer-to-peer traffic, which needs a relay server to get past'
                : 'nobody is hosting that code — check the code, and that the other player has pressed "Host a game"');
              return;
            }
            try { wire(peer.connect(base + '-h', { reliable: true })); } catch (_) {}
          };
          peer.on('open', () => {
            clearTimeout(openTimer);
            settled = true;
            if (opts.host) peer.on('connection', wire);
            else knock('first');
            resolve({
              kind: 'peerjs',
              send: (m) => { outbox.push({ to: m.to || null, m: Object.assign({ room }, m) }); flush(); },
              onMessage: (f) => { cb = f; },
              // ⚠ 2 above: the caller's only window onto a transport that
              // breaks after it was handed over.
              onError: (f) => { onErr = f; },
              // A caller's signalling socket went away. On the host that is how
              // a joiner who closed the tab BEFORE the game connection came up
              // is noticed at all.
              onGone: (f) => { onGone = f; },
              // Shut the door: called when the room has no free seat left, and
              // released if one comes back.
              lock: (on) => { locked = on !== false; },
              close: () => { dead = true; try { peer.destroy(); } catch (e) {} },
            });
          });
          peer.on('error', (e) => {
            const t = (e && e.type) ? e.type : String(e);
            // 'peer-unavailable' just means the host is not there YET. Retrying
            // is correct; failing the session on it would make joining a race
            // the guest usually loses. It is bounded now — see 3 above.
            if (t === 'peer-unavailable' && !opts.host) {
              // Settles the dial in flight: there is no peer to reach, so its
              // watchdog must not also fire and blame the network.
              cancelDial();
              setTimeout(() => knock('absent'), PEER_KNOCK_MS);
              return;
            }
            clearTimeout(openTimer);
            // Before 'open' this is the only way out and must reject. After it,
            // rejecting is a no-op, so say it on the channel that still works.
            if (settled) report('signalling broker error: ' + t);
            else fail('signalling failed: ' + t);
          });
        } catch (e) { fail(e && e.message ? e.message : String(e)); }
      };
      if (global.Peer) return start();
      const s2 = document.createElement('script');
      s2.src = 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js';
      s2.onload = start;
      s2.onerror = () => fail('could not load the signalling library');
      document.head.appendChild(s2);
    });
  }
  // ---- 'ws': PAIRING OVER AN ORDINARY WEBSOCKET RELAY -----------------------
  //
  // ⚠ WHY THIS EXISTS — IT IS THE BUG TWO REAL DEVICES HIT ON PRODUCTION.
  // A PEERJS DataConnection IS ITSELF A WEBRTC CONNECTION. So the 'peerjs'
  // transport above needs NAT traversal BEFORE the game connection is even
  // attempted: `peer.connect(base + '-h')` dials a peer-to-peer socket, and
  // when the two networks will not carry a direct path that dial is created,
  // emits NO error, and never opens. Reported from production with a PC and a
  // phone on DIFFERENT networks: host roster "P1 you / P2 open", phone roster
  // "P1 <host> / P2 you", both "waiting for players", frame 0, core ran 0. The
  // joiner's hello never reached the host, no prompt was ever raised and no
  // error was ever shown. Two Chrome profiles on ONE box pair perfectly —
  // because they SHARE A NAT — which is why every rig on this machine said the
  // code worked.
  //
  // And there was nothing underneath to catch it: measured 2026-09-08, every
  // public TURN server answered 701/400 and peerjs's own defaults do not
  // resolve at all (the ICE block above has the table), so peerjs's OWN
  // signalling socket had no relay either.
  //
  // THE FIX IS TO STOP SIGNALLING OVER WEBRTC. A public MQTT-over-WebSocket
  // broker carries messages between two clients over ordinary WSS — the same
  // kind of connection that fetched this file — which traverses anything a
  // browser can reach. Measured here, two browser contexts, publish on one and
  // receive on the other:
  //   wss://broker.emqx.io:8084/mqtt       connect=true relayed=true  159 ms
  //   wss://test.mosquitto.org:8081/mqtt   connect=true relayed=true  148 ms
  //   wss://broker.hivemq.com:8884/mqtt    connect=true relayed=true  407 ms
  //
  // ⚠ THAT LATENCY IS IRRELEVANT AND IS NOT AN ARGUMENT AGAINST THIS. Pairing
  // is a ONE-TIME exchange of a handful of messages; 148 ms to be let into a
  // room is invisible. The GAME path does not change and stays peer-to-peer
  // WebRTC, which is the only place latency is the product.
  //
  // ---- WHAT A STRANGER ON THIS TOPIC CAN SEE -------------------------------
  // Everything that is put there — so nothing readable is put there. A public
  // broker lets ANYONE subscribe to `#` and read every topic on it, which makes
  // this a megaphone in a public square where the peerjs socket was at least
  // point-to-point. Therefore:
  //   * THE TOPIC IS DERIVED, NEVER THE CODE — 128 bits of HMAC output under
  //     the PBKDF2 room key, the same discipline as the peer id above.
  //   * THE ROOM CODE IS NEVER TRANSMITTED IN ANY FORM, not even sealed. The
  //     room binding IS the topic plus the key, and `room` is re-attached
  //     locally on receipt purely for shape parity with the other transports.
  //   * EVERY PAYLOAD IS AES-GCM SEALED under a key expanded off the same room
  //     key. So the SDP offer — which carries this machine's LAN and public
  //     addresses — is not legible to a bystander, and cannot be FORGED
  //     either: GCM authenticates, so anything that does not decrypt is dropped
  //     without being parsed. That makes this transport STRICTLY STRONGER than
  //     the peerjs one, where the broker sees the whole handshake in clear.
  //   * A REPLAY IS NOT A MESSAGE. Every seal carries a fresh random IV and an
  //     IV is accepted once, so a recorded packet cannot be pushed back at
  //     either side.
  //   * NO CRYPTO, NO TRANSPORT. Without crypto.subtle — a page served over
  //     plain http to a LAN address — there is no key, so this REFUSES to run
  //     rather than broadcasting a handshake in clear.
  // An eavesdropper therefore learns: that a room with derived id X exists, and
  // the size and timing of its handshake. Not the code, not the offer, and
  // nothing that admits them — admission is still a human pressing Allow on a
  // caller that has already proved it holds the room key, and none of that
  // changed.
  //
  // ⚠ NOTHING IS RETAINED AND NOTHING IS QUEUED BY THE BROKER: qos 0, retain
  // false, clean session. A retained message would hand a stale offer to
  // whoever subscribed next, which is the one way this shape could leak.
  const WS_BROKERS = [
    'wss://broker.emqx.io:8084/mqtt',
    'wss://test.mosquitto.org:8081/mqtt',
    'wss://broker.hivemq.com:8884/mqtt',
  ];
  const WS_LIB = 'https://cdnjs.cloudflare.com/ajax/libs/mqtt/5.3.4/mqtt.min.js';
  const WS_CONNECT_MS = 9000;     // per broker, before moving to the next one
  const WS_SEEN_MAX = 512;        // remembered IVs, i.e. the replay window
  // ⚠ A WRONG CODE MUST NOT LOOK LIKE A SLOW HOST. peerSignal can tell those
  // two apart because the broker answers 'peer-unavailable'; a broadcast topic
  // answers NOTHING, so silence is the only signal a guest gets. This is how
  // long a guest publishes into a topic hearing nothing back before it says so.
  // Generous on purpose — the host may still be working through its own broker
  // list — and it is longer than the offer/answer exchange by a wide margin.
  const WS_QUIET_MS = 30000;

  function wsBrokers() {
    let raw = null;
    try { raw = global.NETPLAY_WS_BROKERS || null; } catch (e) {}
    try { if (!raw && global.location) raw = new URLSearchParams(global.location.search).get('wsbroker'); } catch (e) {}
    if (!raw) return WS_BROKERS.slice();
    return String(raw).split(',').map((s) => s.trim()).filter(Boolean);
  }

  // Loaded lazily and only when a cross-device session is requested, exactly
  // like peerjs, so a page that never opens the lobby pays nothing for it.
  let _mqttLoad = null;
  function loadMqtt() {
    if (global.mqtt) return Promise.resolve(global.mqtt);
    if (_mqttLoad) return _mqttLoad;
    _mqttLoad = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = WS_LIB;
      s.onload = () => (global.mqtt ? res(global.mqtt) : rej(new Error('the relay library loaded but defined nothing')));
      s.onerror = () => rej(new Error('could not load the relay library'));
      document.head.appendChild(s);
    });
    // A failed load must not be cached as a permanent verdict.
    _mqttLoad.catch(() => { _mqttLoad = null; });
    return _mqttLoad;
  }

  function b64enc(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return btoa(s);
  }
  function b64dec(s) {
    const b = atob(s);
    const u = new Uint8Array(b.length);
    for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
    return u;
  }
  function fromHex(h) {
    const n = (h.length / 2) | 0;
    const u = new Uint8Array(n);
    for (let i = 0; i < n; i++) u[i] = parseInt(h.substr(i * 2, 2), 16);
    return u;
  }
  function randomBytes(n) {
    const a = new Uint8Array(n);
    if (global.crypto && global.crypto.getRandomValues) global.crypto.getRandomValues(a);
    else for (let i = 0; i < n; i++) a[i] = (Math.random() * 256) | 0;
    return a;
  }

  // The topic and the sealing key, both EXPANDED OFF the existing room key with
  // a label. The PBKDF2 derivation itself is untouched, so the peerjs peer id
  // and every join proof are bit-for-bit what they were before this transport
  // existed — adding a relay must not move the security gate.
  const _wsSeals = new Map();
  function wsSeal(room) {
    if (_wsSeals.has(room)) return _wsSeals.get(room);
    const p = (async () => {
      const s = subtle();
      const { key } = await roomKey(room);
      if (!s || !key) return null;
      try {
        const bits = await s.sign('HMAC', key, utf8('ws-enc'));
        const aes = await s.importKey('raw', bits, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
        const t = await mac(room, 'ws-topic');
        if (!t) return null;
        return { aes, topic: 'bemental/np/' + t.slice(0, 32) };
      } catch (e) { return null; }
    })();
    _wsSeals.set(room, p);
    return p;
  }

  // One broker, connected AND subscribed, or a rejection naming it. Subscribing
  // before resolving matters: the host must already be listening when it says
  // it is hosting, or the first hello lands on nobody.
  function wsConnect(mq, url, topic) {
    return new Promise((res, rej) => {
      let done = false, c = null;
      const bail = (msg) => {
        if (done) return;
        done = true;
        clearTimeout(t);
        try { c && c.end(true); } catch (e) {}
        rej(new Error(url + ' — ' + msg));
      };
      const t = setTimeout(() => bail('no answer in ' + WS_CONNECT_MS + ' ms'), WS_CONNECT_MS);
      try {
        c = mq.connect(url, {
          // ⚠ NOT DERIVED FROM THE ROOM. A client id is visible to the broker
          // and to anything that can list clients; it says nothing about which
          // room this is.
          clientId: 'np-' + randomHex(8),
          clean: true, keepalive: 30, protocolVersion: 4,
          resubscribe: true,
          // Zero WHILE RACING: a broker that will not come up must lose
          // promptly so the next one is tried. Raised on success below, so a
          // socket that drops during a long wait for a joiner comes back.
          reconnectPeriod: 0,
          connectTimeout: WS_CONNECT_MS,
        });
      } catch (e) { return bail((e && e.message) || String(e)); }
      c.on('error', (e) => bail((e && e.message) || String(e)));
      c.on('close', () => bail('the connection closed before it was usable'));
      c.on('connect', () => {
        c.subscribe(topic, { qos: 0 }, (err) => {
          if (done) return;
          if (err) return bail('subscribe failed: ' + ((err && err.message) || err));
          done = true;
          clearTimeout(t);
          res(c);
        });
      });
    });
  }

  async function wsSignal(room, opts) {
    const seal = await wsSeal(room);
    // Refusing is the whole point — see NO CRYPTO, NO TRANSPORT above.
    if (!seal) throw new Error('this page has no secure crypto, so the relay cannot be used');
    const mq = await loadMqtt();
    const s = subtle();
    const me = randomHex(8);          // to recognise this client's own echoes
    const seen = new Set(); const seenQ = [];

    // ⚠ A BROKER THAT WILL NOT CONNECT IS NOT A FAILED SESSION while another
    // one is left to try. Only running out of brokers is a failure.
    let client = null, url = null;
    const tried = [];
    for (const u of wsBrokers()) {
      try { client = await wsConnect(mq, u, seal.topic); url = u; break; }
      catch (e) { tried.push((e && e.message) || String(e)); }
    }
    if (!client) throw new Error('could not reach any signalling relay — ' + (tried.join('; ') || 'no brokers configured'));
    try { client.options.reconnectPeriod = 4000; } catch (e) {}

    let cb = null, onErr = null, onGone = null, dead = false;
    let heard = false, quiet = 0;
    const report = (msg) => { if (!dead && onErr) { try { onErr(msg); } catch (e) {} } };

    // ⚠ IN ORDER, BOTH WAYS. Sealing and unsealing are async, so handing every
    // message straight to the crypto would let an ICE candidate overtake the
    // offer it belongs to — addIceCandidate() then throws into the catch in
    // _onSignal and the candidate is silently lost, which degrades exactly the
    // path this transport exists to keep working. One chain each way.
    let rx = Promise.resolve(), tx = Promise.resolve();

    const unseal = async (t, payload) => {
      if (dead || t !== seal.topic) return;
      let text;
      try { text = payload && payload.toString ? payload.toString() : String(payload); } catch (e) { return; }
      const dot = text.indexOf('.');
      if (dot < 1) return;
      const ivB = text.slice(0, dot);
      if (seen.has(ivB)) return;                       // a replay is not a message
      let obj = null;
      try {
        const pt = await s.decrypt({ name: 'AES-GCM', iv: b64dec(ivB) }, seal.aes, b64dec(text.slice(dot + 1)));
        obj = JSON.parse(new TextDecoder().decode(pt));
      } catch (e) { return; }                          // not ours, or forged
      seen.add(ivB); seenQ.push(ivB);
      while (seenQ.length > WS_SEEN_MAX) seen.delete(seenQ.shift());
      if (!obj || typeof obj !== 'object') return;
      if (obj._s === me) return;                       // our own broadcast, returned by the broker
      // Somebody else is on this topic and holds the room key. Whatever else
      // happens, "nobody is hosting that code" is now a false statement.
      heard = true;
      if (quiet) { clearTimeout(quiet); quiet = 0; }
      delete obj._s;
      // Re-attached HERE, never on the wire. Every other transport tags its
      // messages with the room so the session can trust `m.room`; on this one
      // the topic and the key are the binding, and sending the code would undo
      // the entire point of deriving the topic.
      obj.room = room;
      if (cb) cb(obj);
    };
    client.on('message', (t, payload) => { rx = rx.then(() => unseal(t, payload)).catch(() => {}); });
    client.on('error', (e) => report('signalling relay error: ' + ((e && e.message) || e)));
    // Fires once, and only for a guest: a host waiting for a friend is supposed
    // to hear nothing, for as long as it likes.
    if (!opts || !opts.host) {
      quiet = setTimeout(() => {
        quiet = 0;
        if (heard || dead) return;
        report('nobody is hosting that code — check the code, and that the other player has pressed "Host a game"');
      }, WS_QUIET_MS);
    }

    const publish = async (m) => {
      if (dead) return;
      const body = Object.assign({}, m, { _s: me });
      delete body.room;                                // belt and braces: never the code
      const iv = randomBytes(12);
      try {
        const ct = await s.encrypt({ name: 'AES-GCM', iv: iv }, seal.aes, utf8(JSON.stringify(body)));
        client.publish(seal.topic, b64enc(iv) + '.' + b64enc(new Uint8Array(ct)), { qos: 0, retain: false });
      } catch (e) { report('could not send over the signalling relay: ' + ((e && e.message) || e)); }
    };

    return {
      kind: 'ws',
      url: url,
      send: (m) => { tx = tx.then(() => publish(m)).catch(() => {}); },
      onMessage: (f) => { cb = f; },
      onError: (f) => { onErr = f; },
      // ⚠ THERE IS NO PER-CALLER SOCKET ON A BROADCAST TOPIC, so a joiner that
      // walked away cannot be noticed the way peerSignal notices a dropped
      // DataConnection. Same shape and same silence as localSignal: a prompt
      // for somebody who left is dismissed by the human or by the session's own
      // ICE timeout, not by this.
      onGone: (f) => { onGone = f; },
      // Nothing to shut. Every subscriber hears the topic — which is precisely
      // why the protocol addresses BY NONCE and gates on approval rather than
      // on who managed to open a socket. Shape parity only.
      lock: () => {},
      close: () => { dead = true; if (quiet) { clearTimeout(quiet); quiet = 0; } try { client.end(true); } catch (e) {} },
    };
  }

  // ---- SEVERAL SIGNALLING PATHS AT ONCE ------------------------------------
  //
  // ⚠ BOTH AT ONCE, NOT "TRY WS, FALL BACK TO PEERJS". A fallback needs a
  // FAILURE to trigger on, and the failure this whole change exists to fix does
  // not produce one: a peerjs dial across two networks that will not carry a
  // direct path is created, emits nothing, and hangs. Waiting to detect that
  // before trying the other path would reintroduce the deadlock with extra
  // steps. Both are opened, the hello goes out on both, and pairing completes
  // over whichever one the other side can also hear.
  //
  // That also covers the case a staged rollout guarantees: a device holding a
  // CACHED copy of the previous version of this file speaks peerjs and nothing
  // else. A ws-only client could never reach it. Running both means the fix can
  // ship without a flag day.
  //
  // ⚠ THE FIRST PATH UP WINS THE RESOLVE, and the others join afterwards. The
  // session must not wait on the slowest broker before it can send a hello.
  function fanSignal(kinds, room, opts) {
    return new Promise((resolve, reject) => {
      const paths = kinds.map((k) => ({ kind: k, t: null, err: null, done: false }));
      const opened = () => { const o = []; for (const p of paths) if (p.t) o.push(p.t); return o; };
      const carrying = () => paths.filter((p) => p.t && !p.err).length;
      const allDone = () => paths.every((p) => p.done);
      let cb = null, onErr = null, onGone = null;
      let closed = false, settled = false, lockState = null, said = null;

      // ⚠ ONE LOGICAL MESSAGE, N PATHS, EXACTLY ONE DELIVERY. Everything sent
      // goes out on every open path, so the far side receives it once per path
      // the two of them share — and a duplicate is NOT harmless. Two identical
      // 'answer' messages arriving together both pass the
      // `!L.pc.currentRemoteDescription` check before either await resolves,
      // and the second setRemoteDescription throws "Called in wrong state:
      // stable" into the catch in _onSignal — which fails a session that was
      // connecting perfectly well. Every send is stamped; every stamp is
      // accepted once. A peer that predates the stamp has only one path to
      // reach us on anyway, so an unstamped message is always fresh.
      const seen = new Set(); const seenQ = [];
      const fresh = (m) => {
        if (!m || !m._f) return true;
        if (seen.has(m._f)) return false;
        seen.add(m._f); seenQ.push(m._f);
        while (seenQ.length > 256) seen.delete(seenQ.shift());
        return true;
      };

      // Only when NOTHING is left carrying the session, and naming every path,
      // because "the relay is fine but peerjs gave up" must not read as a dead
      // session — and a bug report wants both halves.
      const say = () => {
        if (closed || !onErr) return;
        if (!allDone() || carrying()) return;
        const msg = paths.map((p) => (p.err ? p.kind + ': ' + p.err : null)).filter(Boolean).join(' · ');
        if (!msg || msg === said) return;
        said = msg;
        try { onErr(msg); } catch (e) {}
      };

      const api = {
        kind: kinds.join('+'),
        // What is actually carrying this session, for a bug report or a rig.
        get url() { return paths.filter((p) => p.t).map((p) => p.kind + (p.t.url ? ' ' + p.t.url : '')).join(', '); },
        get paths() { return paths.map((p) => ({ kind: p.kind, up: !!p.t, error: p.err })); },
        send: (m) => {
          const s = Object.assign({ _f: randomHex(6) }, m);
          for (const t of opened()) { try { t.send(s); } catch (e) {} }
        },
        onMessage: (f) => { cb = f; },
        onError: (f) => { onErr = f; },
        onGone: (f) => { onGone = f; },
        lock: (on) => { lockState = on !== false; for (const t of opened()) { try { t.lock(on); } catch (e) {} } },
        close: () => {
          closed = true;
          for (const p of paths) { if (p.t) { try { p.t.close(); } catch (e) {} p.t = null; } }
        },
      };

      paths.forEach((p) => {
        let started;
        try { started = Promise.resolve((SIGNALS[p.kind] || SIGNALS.local)(room, opts)); }
        catch (e) { started = Promise.reject(e); }
        started.then((t) => {
          p.done = true;
          // A path that came up after the caller gave up is closed, not kept.
          if (closed) { try { t.close(); } catch (e) {} return; }
          p.t = t;
          t.onMessage((m) => {
            if (!fresh(m)) return;
            // A path that is DELIVERING is not a path that has failed. The ws
            // guest watchdog can legitimately say "nobody is hosting that code"
            // and then be proved wrong by a host that was still connecting.
            if (p.err) { p.err = null; said = null; }
            if (m && m._f) delete m._f;
            if (cb) cb(m);
          });
          t.onError((msg) => { p.err = msg; say(); });
          t.onGone((n) => { if (onGone) { try { onGone(n); } catch (e) {} } });
          if (lockState !== null) { try { t.lock(lockState); } catch (e) {} }
          if (!settled) { settled = true; resolve(api); }
        }, (e) => {
          p.done = true;
          p.err = (e && e.message) || String(e);
          // Every path refused to open: there is no session to have.
          if (!settled && allDone() && !carrying()) {
            settled = true;
            return reject(new Error(paths.map((q) => q.kind + ': ' + (q.err || 'no answer')).join(' · ')));
          }
          say();
        });
      });
    });
  }

  // ---- WHICH SIGNALLING A SESSION ACTUALLY OPENS ---------------------------
  // One table instead of the ternary this used to be. That ternary read
  // `transport === 'peerjs' ? peerSignal : localSignal`, so ANY value that was
  // not exactly 'peerjs' silently became BroadcastChannel — i.e. a page that
  // asked for a transport it had spelled wrong got same-browser-only pairing
  // and no complaint about it. A name that is not here still falls back to
  // 'local', because that is the one that cannot fail, but the set is now
  // stated in one place a reader can enumerate.
  const SIGNALS = {
    local: (room) => localSignal(room),
    peerjs: (room, opts) => peerSignal(room, opts),
    ws: (room, opts) => wsSignal(room, opts),
  };

  // ⚠ 'peerjs' NO LONGER MEANS ONLY PEERJS — IT MEANS CROSS-DEVICE. That is
  // deliberate. Six pages and two library helpers spell the cross-device
  // transport 'peerjs' (lib/netplay-host.js:110, lib/netplay-guest.js:217,
  // dreamcast.html, gamecube.html, dreamcast_multiplayer.html:211,
  // gamecube_multiplayer.html:207), and two audits assert that exact string is
  // what a page reports (tools/audit_peerjs_crossdevice.mjs:178 and :221,
  // tools/netplay_realui_pair_test.mjs:247). Resolving the NAME here instead of
  // editing six pages means the fix reaches every one of them at once — and
  // does not touch files other work has open.
  //
  //   'local'        BroadcastChannel, same browser only. Unchanged.
  //   'ws'           the relay alone. For a rig that needs it isolated.
  //   'peerjs-only'  the old DataConnection alone. Kept so the failure this
  //                  change fixes can still be REPRODUCED on demand.
  //   anything else  both, concurrently. This is what every page gets.
  //
  // Overridable per page load for testing: ?signal=ws / window.NETPLAY_SIGNAL.
  function signalPlan(want) {
    let forced = null;
    try { forced = global.NETPLAY_SIGNAL || null; } catch (e) {}
    try { if (!forced && global.location) forced = new URLSearchParams(global.location.search).get('signal'); } catch (e) {}
    const t = forced || want;
    if (t === 'local') return ['local'];
    if (t === 'ws') return ['ws'];
    if (t === 'peerjs-only') return ['peerjs'];
    return ['ws', 'peerjs'];
  }

  async function openSignal(want, room, opts) {
    const plan = signalPlan(want);
    if (plan.length === 1) return await (SIGNALS[plan[0]] || SIGNALS.local)(room, opts);
    return await fanSignal(plan, room, opts);
  }

  // ===========================================================================
  // LOCKSTEP — EVERY MACHINE RUNS THE GAME. ONLY INPUTS CROSS THE WIRE.
  //
  // THE PRODUCT RULE, in the user's words: "the players should act as if they
  // are connected to the same console - and need to be", and "you need this to
  // be immediate input like a local console". A player's OWN pad must never
  // make a network trip before it moves anything.
  //
  // SO: N machines, N cores, one shared frame clock. Each core runs emulated
  // frame F only once it holds EVERY occupied port's input for F. Your own
  // input is applied locally, `delay` frames late; what the delay is hiding is
  // everyone ELSE's input, which is the only thing the wire carries.
  //
  // AS MANY PLAYERS AS THE CONSOLE HAS. Not two. The Dreamcast has four maple
  // ports (MAPLE_PORTS, core/hw/maple/maple_devs.h:193) and the bridge already
  // serves four (g_maple_pad_state[256] = 4 x 64 B, EmscriptenWorker.cpp:112).
  // portCount is therefore a CONSTRUCTOR ARGUMENT taken from the core, never a
  // constant here — GameCube's bridge currently wires only port 0
  // (gamecube/dolphin-bridge/EmscriptenWorker.cpp:473), so the number is a
  // per-platform fact this file must not assume.
  // One machine may own SEVERAL ports: two controllers plugged into one
  // computer are two players, in two ports, not two pads OR'd into one.
  //
  // ---------------------------------------------------------------------------
  // HOW A SESSION STARTS: A LOBBY, NOT A SAVESTATE.
  //
  // Everyone joins BEFORE any core boots. Ports are assigned in the lobby, then
  // every machine boots the SAME disc and holds at frame 0 until all of them
  // report ready. Identical starting states then hold BY CONSTRUCTION — there is
  // no serialize, no 27 MB transfer, and above all no restore that can fail
  // silently and leave a cold boot wearing the mask of a running game (the trap
  // CLAUDE.md gate #10 was written for). A common boot is a stronger guarantee
  // than a transferred state and it costs nothing.
  //   The barrier ENFORCES the disc, it does not hope for it: a peer whose disc
  //   identity differs is refused at the barrier, because two different discs
  //   diverge on frame 1.
  //   A peer still downloading HOLDS the others — visibly. A 1.18 GB disc on a
  //   phone is an ordinary state, not an edge case, so 'waiting for N players'
  //   is a first-class thing the barrier reports.
  // sendSave()/sendStartState() are KEPT but are no longer on the critical path;
  // they are there for a future late-join or resync, and nothing in the start
  // sequence calls them.
  //
  // ---------------------------------------------------------------------------
  // WHAT IT COSTS, STATED UP FRONT.
  //
  // Every player's input — local and remote alike — is delayed by `delay`
  // frames, deliberately and symmetrically. That is the trade: a local-feeling
  // pad in exchange for a CONSTANT lag instead of a variable network one.
  // ⚠ A FRAME HERE IS ONE retro_run, NOT ONE VBLANK. One _emscripten_run_iter()
  // returns when the core has produced a video frame, so on a title that renders
  // every other VBlank (PSO Ver.2 — flycast_worker.js's two-knobs block; native
  // flycast measures R: 29.72) the quantum is ~33.3 ms, not ~16.7. delay=3 is
  // 100 ms there and 50 ms on a 60 fps title. Read the delay in MILLISECONDS
  // (latencyMs) and choose it from the measured RTT (recommendDelay).
  //
  // DELAY MUST BE >= 1 OR EVERYONE DEADLOCKS. Executing frame F needs every
  // peer's input FOR F, which each produced when it first attempted F-delay. At
  // delay 0 that is F itself and all N sides wait on each other forever.
  //
  // ---------------------------------------------------------------------------
  // IT NEVER GUESSES. A missing input STALLS the core, and the stall names the
  // PORTS it is waiting on so a frozen picture is explainable instead of a
  // mystery. The alternative — predict, run on, roll back — is rollback
  // netplay, which needs cheap savestates this core does not have (its state is
  // 27,652,485 B). Predicting WITHOUT rollback is the one thing that must never
  // happen: it forks the machines silently and permanently.
  //   One slow peer stalls everyone. That is inherent to lockstep, not a defect
  //   to be engineered around by running ahead.
  //
  // ---------------------------------------------------------------------------
  // DETERMINISM IS AN ASSUMPTION, AND THIS IS BUILT TO FIND OUT WHERE IT BREAKS.
  //
  // ⚠ Nothing in THIS file establishes that the cores are frame-deterministic.
  // That is a separate measurement. The risk is real and it is not designed
  // away — it is designed FOR: every machine fingerprints its core every
  // `hashEvery` frames and the fingerprints are compared. A mismatch stops the
  // session and produces a REPORT — which frame, which peer, which field, and
  // the last frame everyone still agreed on — because divergence is a work list
  // to be shortened, not a reason to fall back to something else.
  // (Streaming one machine's picture to the others was the old architecture and
  // is cancelled: it made everyone but the host a spectator with a joypad.)
  // ===========================================================================

  // FNV-1a over 32-bit words. Not cryptographic and does not need to be: it
  // compares a value against the same value computed by a peer running the same
  // code. It has to be cheap and identical in every browser.
  function fnv32(h, v) { return (Math.imul((h ^ (v >>> 0)) >>> 0, 0x01000193) >>> 0); }
  function fnvBytes(h, u8) { for (let i = 0; i < u8.length; i++) h = fnv32(h, u8[i]); return h >>> 0; }
  const FNV_SEED = 0x811c9dc5;
  function fnvWords(words) { let h = FNV_SEED; for (let i = 0; i < words.length; i++) h = fnv32(h, words[i]); return h >>> 0; }

  function b64enc(u8) { let s = ''; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return btoa(s); }
  function b64dec(s) {
    const bin = atob(s); const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  }

  const LS_KEEP = 240;        // frames of input/fingerprint history to retain
  // The deepest rollback window a room may ask for. A window is paid in
  // savestates (one per frame in it) and in the worst-case re-simulation burst
  // (W frames inside one display tick); tools/rollback_state_measure.mjs
  // measured W=8 to fit 16.7 ms on Genesis (p90) and SNES. 30 is a sanity cap.
  const ROLLBACK_MAX = 30;
  const ROLLBACK_PORTS_MAX = 8;  // the constructor's own portCount ceiling
  // At most one advantage wait per this many frames (see _beginFrameRb).
  const RB_ADV_EVERY = 8;
  const RB_ADV_SMOOTH = 16;      // frames in the advantage mean (see _beginFrameRb step 2)
  // ---- THE ADAPTIVE WINDOW AND THE ROOM CLOCK (see the block above rbCatchUp) --
  // The smallest window a room may run: one frame of sampling phase, one of
  // phase error between the consoles, and two of travel on a LAN.
  const RB_WINDOW_MIN = 4;
  // Frames of window beyond what the measured path needs, when the slowest
  // console can afford to re-simulate them (Lockstep.recommendWindow).
  const RB_SLACK = 3;
  // How often every console tells the host how late the room's inputs reach
  // it ('lsrb'), and how often the host re-decides the window. Also the
  // heartbeat a stalled console keeps sending, so it is never mistaken for a
  // silent one.
  const RB_REPORT_MS = 500;
  // Lateness samples kept per console: the horizon of the percentile the
  // window is sized from (~2 s of a two-player room's input).
  const RB_LATE_KEEP = 240;
  // Consecutive reports that must ask for a SMALLER window before it shrinks
  // by one frame. Growing is immediate: too small stalls the room, too big
  // costs nothing but a few savestates.
  const RB_SHRINK_VOTES = 8;
  // How much input history a ROLLBACK HOST keeps, in frames: what a peer that
  // dropped out for a while is refilled from ('lsfill') to re-simulate itself
  // back into the room. 3600 = one minute at 60 Hz; a frame's input is a few
  // bytes per port.
  const RB_KEEP_INPUTS = 3600;
  // One 'lsfill' message is kept under this many bytes of JSON (an SCTP
  // message is limited to ~256 KB; the savestate chunker uses 16 KB).
  const RB_FILL_BYTES = 48 * 1024;
  // A HOST that has heard NOTHING from a peer for this long drops that peer's
  // controller (it goes limp at an agreed frame, lsdrop) and the room plays
  // on. A stalled console still sends its 'lsrb' heartbeat every RB_REPORT_MS
  // and a lockstep one its 'lspace', so only a console that has stopped running
  // (a backgrounded tab, a dead link) is ever silent this long. Rollback rooms
  // take the player back when they return (lsrejoin), so the bar is short;
  // delay-lockstep rooms cannot re-admit a peer, so it matches the old stall
  // budget there.
  const RB_DROP_AFTER_MS = 2500;
  // ...in a TWO-player capacity-gated room the gate moved to DELAY lockstep.
  // Longer: a delay room cannot rewind, and with two players the host cannot
  // tell its own link dying from the guest's (with three or more, "everyone
  // went quiet at once" is the host's own link and nobody is dropped). A guest
  // whose link died while it kept running may have run frames on its own pad
  // that the drop makes neutral, and _applyDrop then takes it out of the room
  // — so a two-player blip shorter than this is a stall, as delay lockstep
  // always had, and nobody is dropped.
  const LS_DROP_AFTER_MS = 6000;
  // A console at least this many frames behind the room is REJOINING (it was
  // away), not jittering: its page shows a held frame and "rejoining" instead of
  // the catch-up (rbRejoining). Below it a catch-up is at most ONE hidden frame
  // per display tick — a one-frame skip, never a visible fast-forward.
  const RB_REJOIN_GAP = 8;
  // A console that spent at least this share of a pace window stalled is
  // "waiting"; the host raises the delay only after PACE_HOT_WINDOWS such
  // windows IN A ROW that were link-shaped (see Lockstep._paceTick). Three
  // one-second windows: a single hiccup, however long, cannot span them.
  const PACE_HOT_SHARE = 0.01;
  const PACE_HOT_WINDOWS = 3;
  // How long a console waits on a missing input before asking the room to
  // resend it (see Lockstep._maybeNak).
  const NAK_AFTER_MS = 150;
  // ---- CAPACITY-GATED ROLLBACK (see the block above _capDecide) -------------
  // A console's NEED is the share of its own time rollback asks of it at
  // 1.000x: its measured step (load + run + save) x the steps it runs per room
  // frame (1 + its re-simulated frames) x frames per second. Above CAP_HI for
  // CAP_HOT host decisions in a row the room switches to delay lockstep; it
  // switches back only when every console would need at most CAP_LO, for a
  // calm that starts at CAP_UP_MS and doubles each time a return is undone.
  const CAP_HI = 0.8;
  const CAP_LO = 0.6;
  // ...and THE BURST, CHARGED AT THE RATE IT HAPPENS. One correction (the
  // present frame plus a re-simulation of `d` frames) holds a console for
  // u = st x (d + 1) / F display ticks, so it misses ceil(u) - 1 of them, and a
  // device that does that often shows the room in clumps (measured: a 6 ms-step
  // phone in a four-player room at 50 ms presented 47% of its display ticks
  // while every desktop presented 96%). LOST = corrections per room frame (`cr`,
  // measured) x the ticks a correction misses, averaged over the console's last
  // CAP_DEPTHS corrections (`lt`, each console's own; a console in delay mode
  // is judged at its p90 depth instead, which is never less): the share of
  // display ticks rollback costs it. Its need is LOST / CAP_LOST_FULL — at
  // CAP_HI a console may lose 20% of its ticks, at CAP_LO 15%.
  // Calibrated with tools/netplay_rb_pace_sim.mjs, gate held off, slow console
  // presented vs. LOST: 0.89 / 0.067, 0.77 / 0.159, 0.75 / 0.145, 0.72 / 0.220,
  // 0.69 / 0.205, 0.68 / 0.395, 0.47 / 0.500 (2-4 players, 50-150 ms, 4-6 ms
  // steps) — the bar keeps a rollback console presenting ~3/4 of its ticks.
  // ⚠ IT USED TO BE st x (p90 + 1) / (3 x F) ON ITS OWN — a correction charged as
  // if one came every third tick, however rare. PS1 Monster Rancher 2 corrects
  // ~5 times a MINUTE in a desktop room at 100 ms one way (p90 depth 7, a step of
  // ~8 ms at 50 Hz: busy ~40% of the time), and that bar read 87-149% and moved
  // the room to 8-18 frames of input delay (tools/netplay_device_matrix.mjs,
  // /tmp/npdm/ps1m5r1..ps1m6r2). Charged at its rate, that burst costs ~0.5% of
  // the ticks.
  // ⚠ BUT A CONSOLE WHOSE STEP IS OVER HALF A FRAME (2 x st > F) KEEPS THE OLD
  // BAR. It cannot run a repaid frame and its own in one tick, so every frame it
  // has to make up — after a correction, a jittered tick, a catch-up — misses
  // the next tick too, and it settles into two frames every other tick: the sim
  // measured it presenting 0.49 of its ticks at 10 ms per step (60 Hz, 50 ms
  // one way) with LOST only 0.135. Charging its corrections at their rate would
  // let that through; the old bar does not.
  // A console whose report carries no `cr` (a page on an older lib/netplay.js)
  // is judged by the old bar too — never more leniently than before.
  const CAP_LOST_FULL = 0.25;
  const CAP_BURST_TICKS = 3;
  // ...and however rare, ONE correction may hold a console for at most
  // CAP_BURST_MAX_TICKS display ticks at need 1.0 (6.4 at CAP_HI, ~107 ms at
  // 60 Hz): a longer hold is a visible freeze, outruns the timeline debt the
  // pages repay (ps1.html RB_MAX_DEBT, 4 frames), and holds back the inputs
  // the other consoles' windows are waiting on.
  const CAP_BURST_MAX_TICKS = 8;
  const CAP_DEPTHS = 64;           // rollback depths kept per console for that p90
  const CAP_HOT = 3;
  // The first switch to delay waits until the room has run this long: the
  // path's lateness is what sizes the delay, and in the first seconds of a
  // room (guests started a latency late, the window still growing) it reads
  // low — measured: 10-12 frames at 1.8 s on a four-player 100 ms path whose
  // two-hop inputs arrive 17-19 frames late, a delay the room then stalled on.
  const CAP_SETTLE_MS = 3000;
  // THE WARM-UP: for this long after a console starts running rollback (the
  // room's start, or a return from delay) it records NO capacity measurement —
  // no rollback depths, no steps or corrections per frame — and the host judges
  // the step alone, at CAP_RS_START (_capDecide). The start of a rollback room is a transient: the
  // adaptive window is still growing (8 -> 16-20) and the first corrections
  // are the deepest the room will see. Measured on N64 MK64, 2 players, 40-100
  // ms: seconds 1-2 ran 13-18 rollbacks/s and 70-123 re-simulated frames/s,
  // seconds 4-5 ran 1-6 and 3-17, and the CAP_DEPTHS ring still held the start's
  // corrections when the host decided — a console that needed 125% at the
  // switch needed 45% by the end of the run (n64/docs/rollback-default/RESULTS.md,
  // cause 2). A console that said at Ready it cannot afford rollback (_capEager)
  // is not held by this: that is not a transient.
  const CAP_WARM_MS = 5000;
  const CAP_UP_MS = 10000;
  const CAP_UP_MAX_MS = 160000;
  // Steps per frame assumed for a console never measured in rollback.
  const CAP_RS_START = 1.25;

  // A memory card is 128 KB and an SCTP DataChannel message is limited to
  // roughly 256 KB — the same wall sendSave() documents for savestates — so a
  // four-port card set cannot be one message. 12 KB of raw payload is ~16 KB
  // once base64'd and JSON-wrapped, which is the headroom the savestate chunker
  // already chose and proved.
  const CARD_CHUNK = 12 * 1024;

  // ⚠ THE ROSTER IS RE-SENT, NOT PUSHED ONCE. See _rosterBeat().
  // 2 s is well under the time a person needs to notice anything is wrong, and
  // it only runs while the room is still forming — never during play.
  const ROSTER_BEAT_MS  = 2000;
  // How long a peer may go without hearing an authoritative roster before it
  // must stop claiming to know what the room looks like. Four missed beats:
  // one lost publish on a free broker is ordinary, four in a row is not.
  const ROSTER_STALE_MS = 9000;
  // A GUEST that has heard no roster for this long before the game started
  // re-knocks by itself (Session._armRosterWatch). Longer than the host's
  // DISCONNECT_GRACE_MS so a blip the host forgave is not answered with a
  // needless re-join, shorter than "the player gives up".
  const ROSTER_REKNOCK_MS = 20000;

  class Lockstep {
    // ⚠ TRANSPORT-FREE ON PURPOSE. `send` is a callback and `receive` takes an
    // already-parsed object, so the whole protocol runs in Node with no
    // browser, no WebRTC and no emulator — which is what lets
    // tools/netplay_lockstep_test.mjs inject the failures (a withheld input, a
    // diverged core, a peer walking out, a wrong disc) that a live rig cannot
    // produce on demand.
    constructor(opts) {
      opts = opts || {};
      this.isHost = !!opts.host;
      // ⚠ THE ENGINE MUST OWN THE ROOM'S DISC, because _sendRoster() publishes
      // `this.game` — and `this` there is a Lockstep, which never assigned one.
      // class Lockstep opens at 1220; the file's only `this.game =` sat at 1940,
      // inside class NetplaySession. A different object. So every roster this
      // engine ever sent carried `game: null`, the 'room-game' event never fired
      // on any joiner, and a guest kept whatever disc its own picker held.
      // Measured end to end on production driving both sides: host on gauntlet,
      // guest booted PSO2 and gated at frame 0 on it, with no `room-game` line
      // anywhere in the guest's log. Two consoles, one room, two different
      // games — a barrier that can never release.
      this.game = opts.game || null;
      // How long a stall is tolerated before the host concludes the delay is too
      // small for this path and raises it. Deliberately a few frames' worth: long
      // enough that ordinary jitter does not trip it, short enough that a room on
      // a slow link converges instead of sitting dead.
      this.delayBumpAfterMs = opts.delayBumpAfterMs == null ? 400 : opts.delayBumpAfterMs | 0;
      // How long the room must run WITHOUT stalling before it buys one frame of
      // delay back, and the smallest delay it will ever step down to. The floor
      // is what the measured RTT asked for at Ready — the step-down undoes the
      // stall ratchet, it does not second-guess the measurement.
      this.delayCalmMs = opts.delayCalmMs == null ? 5000 : opts.delayCalmMs | 0;
      this._delayFloor = Math.max(2, (opts.delay | 0) || 2);
      this._lastStallAt = 0;
      this._lastGiveBackAt = 0;
      this._lastBumpAt = 0;
      // ---- THE PACE WINDOW (see _paceTick) ---------------------------------
      // Every console measures, per window, what share of its wall time it
      // spent STALLED, and tells the room ('lspace'). That one number is what
      // separates the two reasons a room runs slow, which call for opposite
      // responses: a LINK that is slower than the delay stalls EVERY console
      // (each waits on the other's input in flight), while a MACHINE that is
      // slower than real time stalls everyone EXCEPT itself — it never waits,
      // it is what is waited on. Raising the delay cures the first and does
      // nothing for the second but add lag.
      this.paceWindowMs = opts.paceWindowMs == null ? 1000 : Math.max(100, opts.paceWindowMs | 0);
      // The rate the room is meant to run at, in frames per second, when the
      // page knows it (n64/index.html: the ROM header's field rate). 0 = unknown.
      this.frameHz = opts.frameHz > 0 ? +opts.frameHz : 0;
      this._paceWinOpen = false;    // a window is open (its start may legitimately be t=0)
      this._paceWinStart = 0;       // wall time the open window began
      this._paceStallBase = 0;      // total stalled ms at that instant
      this._paceFrameBase = 0;      // stats.frames at that instant
      this._paceHot = 0;            // consecutive windows the LINK was too slow
      // When the room began. The old single-long-stall raise is kept ONLY for a
      // peer that never reports its pace (an older page) — and a new peer's
      // first report cannot arrive before the first window closes, so that
      // rule waits three windows before concluding the peer is old. Measured
      // without this: a 4x-throttled host raised 3->5 at FRAME 3, on the
      // start-up stall of a joiner that was still booting, not on the link.
      this._paceBornAt = 0;
      this._peerPace = new Map();   // peerId -> { share, frames, w, at, cap, lost, rtt, wo, hist } from 'lspace'
      this._stallByPeer = new Map();// peerId -> ms this console spent stalled waiting on them (total)
      this._stallOn = null;         // peers the stall in progress is waiting on
      this._paceByPeerBase = new Map();
      this._paceLostBase = 0;
      // What the PAGE knows about this console and the engine cannot: its
      // measured capacity (x real time, from the core's own frame cost), the
      // wall time it lost WITHOUT waiting (a frame that ran late and whose debt
      // the 1.000x governor discarded), and its round trip to the host. The
      // page writes these; the engine publishes them in every 'lspace'.
      this.selfCap = 0;
      this.selfLostMs = 0;
      this.rttMs = 0;
      this.pace = null;             // this console's last closed window
      // ---- THE DELAY THE LINK LAST FAILED AT --------------------------------
      // A give-back may not step down to (or below) a delay the room just
      // stalled at until a cooldown has passed, and the cooldown doubles each
      // time a give-back walks straight back into a stall. Without this the
      // host raised on a stall, gave back 5 s later, stalled again, raised
      // again — measured in tools/netplay_pace_sim.mjs big-hiccups as
      // 4->6->5->4->6 every 12 s, 9 reversals in 120 s.
      this.delayFailCooldownMs = opts.delayFailCooldownMs == null ? 60000 : opts.delayFailCooldownMs | 0;
      this._failedDelay = 0;        // the delay in force when the room last had to raise
      this._failedUntil = 0;        // ...and no give-back to it or below until this time
      this._failCooldown = 0;       // the cooldown that set _failedUntil (it doubles)
      this._lastFailAt = 0;         // when the link last failed
      this._lastGiveBackTo = 0;     // the delay the last give-back stepped DOWN to
      // Smallest input lead in the current and the previous calm-length bucket,
      // so "the link has slack" describes the last few seconds, not the whole
      // session since the last stall. Reset by a stall and by a delay change.
      this._leadMinCur = Infinity; this._leadMinPrev = Infinity; this._leadBucketAt = 0;
      this.delayHistory = [];       // [{ t, frame, from, to, why }] — every change the host decided
      this._pendingDelay = null;   // { at, d } — a delay raise agreed for a future frame
      this._lastLocal = null;      // port -> last pad this console queued, for backfill
      this._queuedTo = -1;         // highest frame queued for our OWN ports (see _applyPendingDelay)
      this.peerId = opts.peerId || (this.isHost ? 'host' : 'peer');
      // THE CONSOLE'S port count, handed in by whoever knows the core.
      this.portCount = Math.max(1, Math.min(8, opts.portCount == null ? 4 : opts.portCount | 0));
      this.padBytes = opts.padBytes || 64;
      this.delay = Math.max(1, Math.min(30, opts.delay == null ? 3 : opts.delay | 0));
      this.hashEvery = opts.hashEvery == null ? 60 : Math.max(0, opts.hashEvery | 0);
      // ROLLBACK (opt-in). 0 = delay-based lockstep exactly as before. N > 0 =
      // the rollback window in frames: local input is applied on the frame it
      // was sampled (NO input delay), a remote port with no input yet is
      // PREDICTED, and a late input that disagrees rewinds the page to the
      // earliest wrong frame. See the ROLLBACK block above _beginFrameRb. The
      // HOST's value wins (sent in 'lsgo'), like every other room parameter.
      this.rollback = Math.max(0, Math.min(ROLLBACK_MAX, opts.rollback | 0));
      // THE PAGE'S HALF OF THE ADAPTIVE ROOM (see the block above rbCatchUp).
      // A page that declares opts.rbCatchUp promises three things: it runs
      // rbCatchUp() hidden frames each display tick, it multiplies its credit
      // by rbPace(), and it sizes its savestate ring to rbRingFrames() before
      // every beginFrame. Only a room in which EVERY console promised this is
      // ADAPTIVE (the host decides, 'lsgo' rba); any other room keeps the fixed
      // window and the whole-frame advantage wait exactly as before, so a page
      // that never heard of this (n64/index.html) cannot be handed a window its
      // ring does not hold.
      this.rbCatchUpOn = !!opts.rbCatchUp;
      // THIS PAGE CAN RUN A ROLLBACK ROOM AT ALL: it keeps a savestate ring and
      // re-simulates the plan beginFrame hands it. Declared in 'lsready' (`rb`);
      // the host runs rollback only if EVERY seated console declared it, and
      // falls back to delay lockstep otherwise — a page with no rollback branch
      // (an old cached ps1.html) runs predicted frames and never rewinds, which
      // forks the room (measured: 3 rooms of 3 desynced). A page that asks for
      // rollback itself (opts.rollback > 0) can obviously run it; a page that
      // can run it but does not want to host it says so with opts.rollbackOk.
      this.rbCapable = opts.rollbackOk != null ? !!opts.rollbackOk : (opts.rollback | 0) > 0;
      // What the page measured one rollback step (load + run + save) to cost,
      // in ms. Published in 'lsrb' so the HOST can size the window to what the
      // slowest console can re-simulate, and used by rbCatchUp() to spend at
      // most half a frame of this console's time on hidden frames. 0 = unknown.
      this.selfStepMs = +opts.selfStepMs || 0;
      // The deepest window this console can HOLD (frames its savestate ring
      // reaches back without thinning), set by the page — and updated by it as
      // memory is measured. Published in 'lsrb' as `mw`; the HOST never decides
      // a window deeper than the smallest one in the room. 0 = no limit.
      this.rbMaxWindow = Math.max(0, opts.rbMaxWindow | 0);
      // ---- CAPACITY-GATED ROLLBACK (see the block above _capDecide) --------
      // `rbResume`: this PAGE can run a rollback frame after a stretch of delay
      // frames — it keeps the start of that first rollback frame itself, because
      // its ring holds nothing the delay frames ran. A page that never declares
      // it can still be switched from rollback to delay at any time, and from
      // delay to rollback only before it has ever run a rollback frame (its ring
      // is armed lazily, on that first frame).
      this.rbResume = !!opts.rbResume;
      this._capGate = false;         // this room switches rollback <-> delay by capacity (host: decided; guest: lsgo cg)
      this._capW = 0;                // the rollback window the room runs / returns to
      this._capAdaptive = false;     // ...and whether that rollback room is adaptive
      this._capPeer = new Map();     // host: peer -> { st, rs, li, rr, at } from 'lsrb' / 'lspace'
      this._capRs = new Map();       // host: peer -> steps per frame last measured in rollback
      this._capHot = 0;              // host: consecutive decisions with a console over CAP_HI
      this._capCalmSince = 0;        // host: since when every console would afford rollback
      this._capUpCooldown = CAP_UP_MS;
      this._capUpAt = 0; this._capDownAt = 0;
      this._capSelfPrev = null;      // { frames, resim, rollbacks, at } at this console's last measurement
      this._capSelfRs = 0;           // this console's steps per frame over its last report
      this._capSelfCr = null;        // ...and corrections (rollbacks) per room frame (null = not measured yet)
      this._capDepths = [];          // this console's last CAP_DEPTHS rollback depths (a ring)
      this._capDepthAt = 0;
      this._capDp = new Map();       // host: peer -> p90 rollback depth last reported in rollback
      this._capCr = new Map();       // host: peer -> corrections per frame last reported in rollback
      this._capEager = false;        // host: a console reported an unaffordable step at Ready — decide on the first measurement
      this._capWarmUntil = 0;        // no capacity measurement before this (CAP_WARM_MS from the start / a return to rollback)
      // THE DELAY PLAIN LOCKSTEP WOULD RUN ON THIS LINK: what the page's RTT
      // pings before Ready recommended (Session.rttReport sets it, with
      // netFloorDelay; Lockstep.recommendDelayForRoom). 0 = not measured. A
      // capacity-gated room that has to use input delay uses exactly this
      // (_capDelay, and a room that starts in delay), so a console that cannot
      // afford rollback never gets more input lag than a lockstep room would
      // have given it on the same link.
      this.rttDelay = Math.max(0, Math.min(30, opts.rttDelay | 0));
      this._modeEpoch = 0;           // mode switches applied here
      this._modeNext = null;         // { e, at, m (1 rollback / 0 delay), d, w, who } agreed, not yet applied
      this._moWire = null;           // host: the pending/last switch, carried on every 'ls' while it matters
      this.modeHistory = [];         // [{ frame, to, delay, window, why }]
      this._rbRanAny = false;        // this console has run a rollback frame (its page's ring is armed)
      this._rbAdaptive = false;      // set at the start: every console promised the above
      this._rbReset();
      // HOW LONG A STALL MAY LAST BEFORE THIS CONSOLE GIVES UP. null = the
      // default for the room (see _stallBudget): 8 s in every room EXCEPT an
      // adaptive rollback room, where the host never gives up on a stall — it
      // drops the silent player instead (_silentPeers) — and a guest gives up
      // only after 30 s waiting on its host. A room that cannot drop and take a
      // player back (delay lockstep, a rollback room with a page that did not
      // declare rbCatchUp, an older peer) keeps the bounded failure: a silent
      // hang is never an outcome. An explicit number wins; 0 = never.
      this.stallBudgetMs = opts.stallBudgetMs == null ? null : opts.stallBudgetMs | 0;
      // How long the HOST waits on a peer that sends nothing before that
      // player's controller goes limp and the room plays on without them.
      // null = the default for the room's mode (RB_DROP_AFTER_MS / LS_DROP_AFTER_MS);
      // 0 = never.
      this.dropAfterMs = opts.dropAfterMs == null ? null : Math.max(0, opts.dropAfterMs | 0);
      this._heardAt = new Map();     // host: peer -> when anything was last heard from it
      // A one-way latency the Session already measured before the start (the
      // relay mode's pings), so the host's FIRST window covers the path instead
      // of learning it from a second of stalls. 0 = unknown.
      this.rbHintMs = +opts.rbHintMs || 0;
      this.fieldNames = opts.fieldNames || null;   // for naming a diverged field
      // Every message this engine sends, counted by type with its size — what a
      // remote diagnosis needs to tell "the link is slow" from "we flood it".
      // One JSON length per message; the transport stringifies it anyway.
      this._sendRaw = opts.send || function () {};
      this.msgStats = { out: {}, outBytes: 0, in: {}, inBytes: 0, since: 0 };
      this._send = (m) => {
        try {
          const t = (m && m.t) || '?', ms = this.msgStats;
          ms.out[t] = (ms.out[t] || 0) + 1;
          ms.outBytes += JSON.stringify(m).length;
        } catch (e) {}
        return this._sendRaw(m);
      };
      this._now = opts.now || (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));

      // roster[port] = peerId, or null for an empty port. Assigned by the host
      // in the lobby and broadcast, so EVERY core maps the same person to the
      // same port. Get this wrong and players drive each other's characters.
      this.roster = new Array(this.portCount).fill(null);
      // ⚠ WHICH PORT EACH PERSON HAD, kept across an unseat. Ports are handed
      // out lowest-free-first, so without this a player who dropped and came
      // back could be given somebody else's character while that somebody was
      // still downloading. It is a preference, not an entitlement: a port that
      // has since been taken is not clawed back.
      this.seatHistory = new Map();  // peerId -> [ports]
      // The roster's version. A roster is now RETRANSMITTED (see _rosterBeat),
      // and a relay can deliver two of them out of order, so every copy carries
      // a sequence and a guest applies only what is at least as new as what it
      // holds. Without it a heartbeat could put back a roster a seat change had
      // just superseded.
      this.rosterSeq = 0;
      this.rosterAt = 0;             // when THIS side last heard an authoritative roster
      this.rosterEvicted = false;    // guest: the host's latest roster does not contain me
      this._rosterTimer = 0;
      this.localPorts = [];
      this.dropped = new Map();      // port -> frame from which it runs neutral (while limp)
      // Every limp span a port has had, [from, to) — `to` Infinity while it is
      // still limp. A ROLLBACK room can take a dropped player BACK (lsundrop),
      // so "neutral from frame F forever" is no longer the whole rule: frames
      // inside a span are neutral on every machine, frames after it are that
      // player's real input again. See _applyUndrop.
      this._limp = new Map();        // port -> [[from, to], ...]
      this._limpEpoch = 0;           // drop/undrop decisions applied here (the host: made)
      this._rbHostEpoch = 0;         // guest: the host's count, as last heard
      this.lobby = new Map();        // host: peerId -> { disc, ready }
      this.disc = null;              // this machine's disc identity
      this.roomGame = null;          // the disc the HOST opened the room for

      this.frame = 0;
      this._scheduledTo = 0;
      this.inputs = new Map();       // frame -> Map(port -> Uint8Array)
      this.myHash = new Map();       // frame -> our fingerprint
      this.myWords = new Map();      // frame -> our raw fingerprint words
      this.peerHash = new Map();     // frame -> Map(peerId -> fingerprint)
      this.neutral = new Uint8Array(this.padBytes);
      this.lastAgreedFrame = -1;

      // idle -> lobby -> waiting -> running -> (stalled) -> ended|desync|failed
      this.state = 'idle';
      this.error = null;
      this.desync = null;
      this._stalled = false;         // ⚠ NOT `_stallSince != 0`: a clock may read 0
      this._stallSince = 0;
      this._handlers = { desync: [], 'desync-detail': [], stall: [], resume: [], state: [],
                         ready: [], roster: [], barrier: [], 'barrier-failed': [], leave: [],
                         'room-game': [], 'roster-evicted': [], cards: [] };

      // ---- the room's memory cards (see the block above _checkBarrier) ------
      this.cards = null;             // the AGREED set: {port:{port,size,hash,enc,bytes}}
      this.cardSetHash = null;       // its fingerprint, for the barrier declaration
      this._cardMine = null;         // what THIS console contributed, by port
      this._cardIn = new Map();      // host: peerId -> {port -> entry} contributed
      this._cardParts = new Map();   // host: reassembly of an in-flight contribution
      this._cardRx = null;           // guest: reassembly of the host's set
      this._cardSeq = 0;             // host: bumped every time a new set is agreed
      this.stats = { frames: 0, stalls: 0, stallMs: 0, maxStallMs: 0, sent: 0, received: 0,
                     hashesSent: 0, hashesCompared: 0, minLead: Infinity, leadSamples: 0, leadSum: 0 };
    }
    on(ev, fn) { (this._handlers[ev] || (this._handlers[ev] = [])).push(fn); return this; }
    _emit(ev, a) { (this._handlers[ev] || []).forEach((f) => { try { f(a); } catch (e) {} }); }
    _setState(s, detail) {
      if (this.state === s) return;
      this.state = s;
      this._emit('state', { state: s, detail: detail || null, frame: this.frame });
    }

    // ---- what the delay costs, in the unit a player feels -------------------
    // ⚠ THE CEILING IS 30, THE SAME AS `delay` ITSELF — a 10 here made every
    // slow path unplayable no matter what anyone measured.
    //
    // The constructor accepts `delay` up to 30 (see this.delay above), but this
    // function clamped its RECOMMENDATION to 10, so a path needing more could
    // never be described. On a direct link nobody noticed: the worst RTT there
    // measures ~2 ms and this returns 2. Over the relay it is the whole story.
    // Measured with a direct peer path made impossible (relay-only ICE, no
    // relay configured, no candidate pair possible), against production:
    //     relay mode engaged (195-200 ms ONE WAY)
    //     chosen from the worst measured RTT 122 ms -> input delay 11 -> 5 frames
    //     core ran [34,35] -> [34,35]      (stopped)
    //     join port1=false                 (own pad never reached own port)
    // Five frames is 83 ms. The room formed, gated, seated both players and
    // compared fingerprints correctly, and then starved, because every core sat
    // waiting on input still in flight. A cap below what the path costs is not
    // a safety margin — it guarantees the stall it looks like it is preventing.
    //
    // The +1 stays: it is the frame the input is queued FOR, on top of the
    // travel time. The /2 stays too — delay-based lockstep has to cover the ONE
    // WAY trip, since what a console waits for is the other side's input
    // arriving, not a round trip completing.
    // ---- RAISING THE INPUT DELAY MID-SESSION -------------------------------
    // The delay is chosen ONCE, at Ready, from a single RTT sample. Fine on a
    // direct link. Not fine on the signalling relay, which measured 101, 195,
    // 200 and 259 ms ONE WAY on the SAME link inside one run. A fixed choice
    // that covers the fast sample starves on the slow one, and a core waiting on
    // input still in flight never advances:
    //     core ran [34,35] -> [34,35]      core ran [31,36] -> [31,36]
    // That is why a room with no direct path could pair, seat, gate and compare
    // fingerprints correctly and still be unplayable.
    //
    // ⚠ THE DANGEROUS PART IS THE SWITCH, NOT THE NUMBER. Two consoles running
    // different delays disagree about which frame an input belongs to — a silent
    // fork, the one thing this architecture exists to prevent. So the change is
    // HOST-AUTHORITATIVE and takes effect at an AGREED FUTURE FRAME: the host
    // names the frame, everyone adopts it there, nobody switches early.
    //
    // ⚠ AND RAISING IT OPENS A HOLE. Going from D to D' at frame F leaves frames
    // F+D+1 .. F+D' with nothing queued from this peer — a stall, i.e. the thing
    // being fixed. Each peer backfills that span with its own most recent pad,
    // for its OWN ports only, and sends those fills, so every console receives
    // identical bytes and the simulation stays identical. Holding the last input
    // across a few frames is what a controller does anyway when nobody moves.
    _scheduleDelay(next, reason) {
      if (!this.isHost || this._modeNext) return false;   // a mode switch in flight names the delay itself
      // ⚠ A RAISE ALREADY AGREED IS RE-SENT, NOT RE-DECIDED. Two different
      // reasons, both paid for by measurement:
      //   * the stall branch calls this every time it is reached, so without a
      //     guard the host emitted `12 -> 18 at f=49` on a loop — ten times
      //     in one 8 s stall (/tmp/dc-xdev/diag1.stdout) — publishing into the
      //     very link it had just concluded was too slow;
      //   * but a relayed room LOSES messages (measured: 12 of 58 publishes,
      //     20.7%), and a lost `lsdelay` leaves the two consoles queueing to
      //     two different schedules. So the pending raise is retransmitted
      //     verbatim — same frame, same delay, idempotent on arrival — instead
      //     of being either spammed as a new decision or sent once and hoped for.
      if (this._pendingDelay) {
        const pd = this._pendingDelay;
        this._send({ t: 'lsdelay', at: pd.at, d: pd.d });
        return false;
      }
      const d = Math.max(1, Math.min(30, next | 0));
      // ⚠ IT USED TO ONLY EVER GO UP, AND THAT IS WHAT THE PLAYER FELT.
      // Reported from a live room: "input delay 30 frames (1000 ms) · stalled
      // 57.8 s total". 30 is the CEILING, and it is not what that link costs —
      // recommendDelay() on the same build answers 9 frames for a 500 ms RTT at
      // 30 fps, so a 1000 ms delay is roughly 3x worse than even a bad link
      // justifies. It is the ratchet: 2 -> 4 -> 6 -> 9 -> 13 -> 19 -> 28 -> 30,
      // climbed during a rough patch and then kept for the rest of the evening
      // however good the link became.
      //
      // The original reasoning for never lowering was sound about the HAZARD and
      // wrong about the conclusion. Lowering naively IS a fork: the scheduling
      // block queues at f + delay unconditionally, so a smaller delay re-sends a
      // frame that is already on the wire, with different bytes. But that is an
      // argument for choosing the right frame, not for never doing it — the
      // first frame at which the shorter lead clears everything already queued
      // is _queuedTo - d + 1, and from there the pipeline simply runs shorter.
      // Nothing queued is invalidated and nothing is sent twice.
      if (d < this.delay) {
        const atDown = Math.max(this.frame + 1, this._queuedTo - d + 1);
        this._pendingDelay = { at: atDown, d: d, down: true };
        this._send({ t: 'lsdelay', at: atDown, d: d });
        const why = 'the link has been steady, so the room is giving the lag back';
        this._noteDelay(d, atDown, why);
        this._emit('delay', { from: this.delay, to: d, at: atDown, reason: why });
        return true;
      }
      if (d === this.delay) return false;
      const at = this.frame + this.delay + 2;   // beats the frame it names, even on the slow path
      this._pendingDelay = { at: at, d: d };
      this._send({ t: 'lsdelay', at: at, d: d });
      const why = reason || 'the room stalled on a slow link';
      this._noteLinkFailed();
      this._noteDelay(d, at, why);
      this._emit('delay', { from: this.delay, to: d, at: at, reason: why });
      return true;
    }
    // Bounded: a room that changes its delay every few seconds for an evening
    // must not grow this without limit. The last 64 changes are plenty to read
    // an oscillation off.
    _noteDelay(to, at, why) {
      this.delayHistory.push({ t: Math.round(this._now()), frame: this.frame, from: this.delay, to: to, at: at, why: why });
      if (this.delayHistory.length > 64) this.delayHistory.splice(0, this.delayHistory.length - 64);
    }
    // THE DELAY IN FORCE HAS JUST FAILED. Remember it, and for how long a
    // give-back must stay above it. If the room fails AGAIN at (or below) the
    // level it failed at last time — i.e. a give-back walked straight back into
    // the stall once the previous cooldown ran out — the cooldown doubles, up
    // to 8x, so a link that cannot sustain a delay stops being offered it.
    //
    // "Again" is judged in TIME, not by comparing delays: a probe that fails at
    // 9 and is then taken back up through 10 and 11 raises two or three times
    // in a row, and comparing each raise to the one before read the second as
    // a fresh failure and RESET the cooldown to base — measured in
    // tools/netplay_pace_sim.mjs four-slow-link as a probe every 60 s instead
    // of 60, 120, 240 s. Any failure within the previous cooldown (plus 30 s)
    // of the last one doubles it. The lead-evidence path in the give-back is
    // unaffected, so a link that genuinely improves still gets its lag back.
    _noteLinkFailed() {
      const now = this._now();
      const base = Math.max(0, this.delayFailCooldownMs | 0);
      const again = this._lastFailAt > 0 && (now - this._lastFailAt) < Math.max(base, this._failCooldown) + 30000;
      this._failCooldown = again ? Math.min(base * 8, Math.max(base, this._failCooldown * 2)) : base;
      this._failedDelay = this.delay;
      this._failedUntil = now + this._failCooldown;
      this._lastFailAt = now;
    }
    // ⚠ THE GAP IS MEASURED FROM WHAT THIS PEER HAS ACTUALLY QUEUED, NOT FROM
    // ARITHMETIC ON f. The old form filled f+D+1 .. f+D', which is right only
    // if this console has already queued exactly through f+D at the moment the
    // raise lands — and it never has in either of the two cases that occur:
    //   * the HOST reaches pd.at on a FIRST attempt at that frame, so it has
    //     queued only through (f-1)+D. Filling from f+D+1 left frame f+D with
    //     nothing queued: a hole, which is a permanent stall — the raise
    //     manufacturing the exact failure it exists to cure. It also collided
    //     with the scheduling block, sending f+D' twice with different bytes.
    //   * a GUEST whose `lsdelay` arrived late applies it on a REPEAT attempt
    //     at a stalled frame, where the scheduling block is already spent and
    //     will not run at all — so nothing would have queued f+D' either.
    // `_queuedTo` is the highest frame this console has queued for its own
    // ports, so "fill from _queuedTo+1 to f+D'" is correct from either
    // position, is contiguous by construction, and sends each frame once.
    // Called AFTER the scheduling block for the same reason.
    // GIVE THE LAG BACK WHEN THE LINK EARNS IT.
    //
    // The raise is aggressive because a room that stalls is a room that is not
    // being played. Nothing balanced that, so a single rough patch left the
    // player at the ceiling for the rest of the session: reported live as
    // "input delay 30 frames (1000 ms) · stalled 57.8 s total" on a link whose
    // own recommendDelay() answers 9 frames for a 500 ms RTT at 30 fps.
    //
    // ⚠ ONE FRAME AT A TIME, AFTER A LONG CALM, AND NEVER BELOW WHAT THE LINK
    // ASKED FOR. Asymmetry is the whole design: a stall raises the delay by half
    // again immediately, and calm buys back a single frame every DELAY_CALM_MS.
    // A pair like that settles at the smallest delay the link actually sustains
    // rather than oscillating — and if a step down is wrong, the very next stall
    // takes it straight back, which costs one stall rather than an evening of
    // 1000 ms lag.
    _maybeGiveDelayBack() {
      if (!this.isHost || this._pendingDelay || this._modeNext) return false;
      if (this.state !== 'running') return false;
      const floor = Math.max(2, this._delayFloor | 0);
      if (this.delay <= floor) return false;
      const now = this._now();
      const calm = this.delayCalmMs || 5000;
      if (!this._lastStallAt) this._lastStallAt = now;
      if ((now - this._lastStallAt) < calm) return false;
      if (this._lastGiveBackAt && (now - this._lastGiveBackAt) < calm) return false;
      // Give back a THIRD of the excess per calm window (at least one frame),
      // not one frame: at one frame per window a spike to the 30-frame ceiling
      // took 27 windows to undo, while the player felt every frame of it.
      // ⚠ AND BY THE MEASURED SLACK WHEN THERE IS MORE OF IT. `proven` (below)
      // is the smallest lead over a whole calm bucket minus a frame of margin:
      // frames of delay the link has demonstrably not needed. A start inflated
      // by a busy peer (17 on a link that needs 3) then comes down in ONE calm
      // window instead of nine.
      const seen0 = Math.min(this._leadMinPrev, this._leadMinCur);
      const proven0 = isFinite(this._leadMinPrev) ? seen0 - 1 : 0;
      const step = Math.max(1, Math.floor((this.delay - floor) / 3), proven0);
      let to = Math.max(floor, this.delay - step);
      // ⚠ NEVER BACK INTO A DELAY THE LINK JUST FAILED AT. Until the cooldown
      // runs out the lowest this may reach is one above the delay that last
      // stalled. That is what stops the raise/give-back pair oscillating.
      //
      // ⚠ UNLESS THE LINK HAS PROVED IT GOT BETTER. `lead` is how many frames
      // past the one being run already hold every console's input — the slack
      // the current delay has over what the link costs right now. If the
      // smallest lead over the whole calm window leaves at least a frame of
      // margin after the step, the step is not a guess, it is measured. That is
      // what brings the delay back down promptly after a spike ends, instead of
      // holding the spike's lag for the rest of the cooldown.
      const seen = Math.min(this._leadMinPrev, this._leadMinCur);
      const proven = isFinite(this._leadMinPrev) ? seen - 1 : 0;   // a FULL bucket, or no evidence
      if (this._failedDelay && now < this._failedUntil && (this.delay - to) > proven) {
        to = Math.max(to, this._failedDelay + 1);
      }
      if (to >= this.delay) return false;
      this._lastGiveBackAt = now;
      this._lastGiveBackTo = to;
      return this._scheduleDelay(to);
    }

    // ---- THE PACE WINDOW ------------------------------------------------------
    // Called on every lockstep beginFrame (ready or stalled — a stalled page
    // keeps calling it, so windows keep closing through a stall). At each close
    // this console publishes its stalled share and, if it is the host, decides
    // whether the LINK is what is slow.
    //
    // ⚠ WHY THE SINGLE-LONG-STALL RAISE IS NOT ENOUGH, MEASURED. The raise used
    // to fire only when ONE stall outlasted delayBumpAfterMs (400 ms). A link
    // a few frames slower than the delay never produces such a stall: the room
    // just runs slow, every frame waiting a little. tools/netplay_pace_sim.mjs
    // `low-sample` (floor 3, link needs ~6): 0.6727x for 120 s with ZERO raises.
    // And the opposite error: a single 900 ms hiccup DID raise (by half), which
    // no delay a player would accept can cover, and the give-back then walked
    // into the next hiccup — 9 reversals in 120 s (`big-hiccups`).
    //
    // So the host raises on a SUSTAINED stall share, and only when it is
    // link-shaped: every console reported waiting at least half as much as the
    // host did. A console slower than real time is waited ON and never waits,
    // so its report reads ~0 — and the room is then held to its pace without
    // piling lag on top (CLAUDE.md gate #9: nothing here can speed a guest up;
    // the only lever is the delay, and the only effect of a wrong raise is lag).
    // A peer that sends no report (an older page) keeps the old rule.
    _paceTick() {
      const now = this._now();
      if (!this._paceWinOpen) {
        this._paceWinOpen = true;
        this._paceWinStart = now;
        this._paceStallBase = this.stats.stallMs + (this._stalled ? now - this._stallSince : 0);
        this._paceFrameBase = this.stats.frames;
        return;
      }
      const w = now - this._paceWinStart;
      if (w < this.paceWindowMs) return;
      const stalledTotal = this.stats.stallMs + (this._stalled ? now - this._stallSince : 0);
      const share = Math.max(0, Math.min(1, (stalledTotal - this._paceStallBase) / w));
      const frames = this.stats.frames - this._paceFrameBase;
      // Per-peer waiting in this window (a stall in progress counts toward the
      // peers it is waiting on), and the time lost without waiting.
      const wo = {};
      const ongoing = this._stalled ? now - this._stallSince : 0;
      for (const [pid, ms] of this._stallByPeer) {
        const tot = ms + ((this._stallOn && this._stallOn.indexOf(pid) >= 0) ? ongoing : 0);
        const d = tot - (this._paceByPeerBase.get(pid) || 0);
        this._paceByPeerBase.set(pid, tot);
        if (d > 0) wo[pid] = +Math.min(1, d / w).toFixed(3);
      }
      if (this._stallOn) for (const pid of this._stallOn) {
        if (!this._stallByPeer.has(pid)) {
          const d = ongoing - (this._paceByPeerBase.get(pid) || 0);
          this._paceByPeerBase.set(pid, ongoing);
          if (d > 0) wo[pid] = +Math.min(1, d / w).toFixed(3);
        }
      }
      const lostMs = Math.max(0, (+this.selfLostMs || 0) - this._paceLostBase);
      this._paceLostBase = +this.selfLostMs || 0;
      this._paceWinStart = now; this._paceStallBase = stalledTotal; this._paceFrameBase = this.stats.frames;
      this.pace = { share: +share.toFixed(3), frames: frames, w: Math.round(w), at: Math.round(now),
                    lost: +Math.min(1, lostMs / w).toFixed(3), cap: +(+this.selfCap || 0).toFixed(3),
                    wo: wo, waitingOn: this._stalled ? this._waitingPeersNow() : [] };
      const ph = this._paceHist || (this._paceHist = []);
      ph.push(this.pace); if (ph.length > 5) ph.shift();
      const pm = { t: 'lspace', s: this.pace.share, fr: frames, w: this.pace.w, c: this.pace.cap,
                   h: this.pace.lost, rt: Math.round(+this.rttMs || 0), wo: wo, peer: this.peerId };
      // capacity gating: this console's rollback step cost, and whether its page
      // has ever run a rollback frame (see _capDecide).
      if (this._capGate) { pm.st = Math.round((+this.selfStepMs || 0) * 10) / 10; if (this._rbRanAny) pm.rr = 1; }
      this._send(pm);
      if (!this.isHost || (this.state !== 'running' && this.state !== 'stalled')) return;
      this._capDecide(now);
      if (this._modeNext) return;
      if (share < PACE_HOT_SHARE) { this._paceHot = 0; return; }
      // Reports older than three windows describe a room that has moved on.
      const fresh = [];
      for (const [pid, r] of this._peerPace) {
        if (pid !== this.peerId && (now - r.at) <= this.paceWindowMs * 3) fresh.push(r);
      }
      // ⚠ AND WAITING MUST EXPLAIN THE LOST TIME. Two consoles that are BOTH
      // slower than real time (and jittery) each wait on the other now and
      // then, so both report a stall share and the rule above reads "link".
      // Measured in the two-window browser rig on this 4-core box (two MK64
      // cores that manage 0.69x/0.40x even SOLO): 6 -> 7 -> 8 -> 9 -> 10 on a
      // 70 +-30 ms link that needs 6, with a stalled share of ~7% against ~45%
      // of the frames lost. When the page says what rate the room SHOULD run
      // at (frameHz), the stalls must account for at least half the frames
      // that did not happen, or the time went to computing, not to waiting.
      let waitingExplains = true;
      if (this.frameHz > 0) {
        const expected = this.frameHz * w / 1000;
        const lost = expected > 0 ? Math.max(0, 1 - frames / expected) : 0;
        waitingExplains = share >= lost * 0.5;
      }
      let linkShaped = waitingExplains && fresh.length > 0 && fresh.every((r) => r.share >= share * 0.5);
      // A gated room waiting on a player who has gone SILENT is not a slow
      // link: that player is dropped (_silentPeers), and raising the delay for
      // everybody would be paid for long after they are back.
      if (linkShaped && this._capGate) {
        for (const pid of this.expectedPeers()) {
          const at = this._heardAt.get(pid);
          if (at != null && now - at > 1500 && !this._portsOf(pid).every((q) => this.dropped.has(q))) { linkShaped = false; break; }
        }
      }
      this._paceHot = linkShaped ? this._paceHot + 1 : 0;
      // A give-back that the link cannot sustain is taken back on the FIRST
      // link-shaped window, not the third: the room was fine one step up
      // seconds ago, so there is nothing left to learn by waiting.
      const justGaveBack = this._lastGiveBackTo === this.delay && this._lastGiveBackAt &&
                           (now - this._lastGiveBackAt) < Math.max(10000, this.paceWindowMs * 10);
      const need = justGaveBack ? 1 : PACE_HOT_WINDOWS;
      if (this._paceHot < need || this._pendingDelay || this.delay >= 30) return;
      this._paceHot = 0;
      this._lastStallAt = now;      // a raise restarts the calm clock, as the old bump did
      this._lastBumpAt = now;
      const pct = Math.round(share * 100);
      this._scheduleDelay(Math.min(30, this.delay + (share >= 0.25 ? 2 : 1)),
        'the link is slower than the input delay — every console spent ' + pct + '% of the last second waiting');
    }
    _waitingPeersNow() {
      const f = this.frame, out = [];
      for (const p of this.occupiedPorts()) {
        if (this._inputFor(f, p) === undefined && this.roster[p] && out.indexOf(this.roster[p]) < 0) out.push(this.roster[p]);
      }
      return out;
    }
    // What a page (and lib/debugreport.js) shows about the room's pace. Every
    // console appears with its PORTS, never its peer id: its stalled share
    // (averaged over the last three windows), the share it lost without
    // waiting, its self-measured capacity, its RTT, and WHOM it waited on
    // (by port). `self` is this console in the same shape. Cheap: no copies
    // beyond a few small arrays.
    paceReport() {
      const now = this._now();
      const portsOf = (pid) => { const ps = []; for (let p = 0; p < this.roster.length; p++) if (this.roster[p] === pid) ps.push(p); return ps; };
      const woPorts = (wo) => {
        const out = {};
        for (const pid in (wo || {})) { const ps = portsOf(pid); if (ps.length) out[ps[0]] = (out[ps[0]] || 0) + wo[pid]; }
        return out;
      };
      const avg = (hist, k) => hist.length ? hist.reduce((a, x) => a + (+x[k] || 0), 0) / hist.length : 0;
      const avgWo = (hist) => {
        const out = {};
        for (const x of hist) { const w = woPorts(x.wo); for (const k in w) out[k] = (out[k] || 0) + w[k] / hist.length; }
        for (const k in out) out[k] = +out[k].toFixed(3);
        return out;
      };
      const peers = [];
      for (const [pid, r] of this._peerPace) {
        const hist = r.hist && r.hist.length ? r.hist : [r];
        peers.push({ peer: pid, ports: portsOf(pid), share: +avg(hist, 'share').toFixed(3), lost: +avg(hist, 'lost').toFixed(3),
                     cap: r.cap || null, rtt: r.rtt || null, waitOn: avgWo(hist), frames: r.frames, w: r.w,
                     ageMs: Math.round(now - r.at) });
      }
      const mh = (this._paceHist || []).slice(-3);
      const self = { ports: this.localPorts.slice(), share: +avg(mh, 'share').toFixed(3), lost: +avg(mh, 'lost').toFixed(3),
                     cap: (+this.selfCap || null), rtt: (+this.rttMs || null), waitOn: avgWo(mh) };
      return { own: this.pace, self: self, ownPorts: this.localPorts.slice(), peers: peers, delay: this.delay,
               failedDelay: this._failedDelay || null,
               failedForMs: this._failedUntil > now ? Math.round(this._failedUntil - now) : 0,
               history: this.delayHistory.slice() };
    }

    // WHO IS THE ROOM WAITING ON — a pure function of a paceReport and the
    // room's measured rate, so a page, a rig and a test all get the same
    // answer. `lost` = 1 - rate is the time the room did not run. A console
    // that spent at least half of that WAITING was held up by somebody; one
    // that did not was itself the thing that was slow.
    //
    // ⚠ THE BUG THIS REPLACED (live, room 49K4T): the page compared its own
    // stalled share to a FIXED 10%. At 0.93x a desktop host with a 4.28x cap
    // had waited ~7% — all of the lost time — and still read "< 10%", so it
    // blamed itself: "this device cannot run this game at full speed".
    //   kind: 'ok' | 'self' | 'device' | 'link' | 'network' | 'all-slow' | 'unknown'
    static paceVerdict(rep, rate, opts) {
      opts = opts || {};
      const slowBelow = opts.slowBelow || 0.95;
      const name = opts.name || ((ports) => (!ports || !ports.length) ? 'another player'
        : ports[0] === 0 ? 'the host' : 'player ' + (ports[0] + 1));
      const fx = (x) => (x >= 10 ? x.toFixed(1) : x.toFixed(2));
      const v = { kind: 'ok', rate: rate, port: null, cap: null, text: '', caps: [] };
      if (!rep || !(rate > 0)) { v.kind = 'unknown'; return v; }
      const me = Object.assign({ me: true }, rep.self || { ports: rep.ownPorts || [], share: 0, lost: 0, cap: null, waitOn: {} });
      const all = [me].concat((rep.peers || []).filter((p) => p.ageMs == null || p.ageMs < 5000));
      v.caps = all.map((c) => ({ ports: c.ports, me: !!c.me, cap: c.cap || null }));
      if (rate >= slowBelow) return v;
      const L = Math.max(0.001, 1 - rate);
      const who = (c) => c.me ? 'this device' : name(c.ports);
      const Who = (c) => { const w = who(c); return w.charAt(0).toUpperCase() + w.slice(1); };
      const head = 'The room is running at ' + rate.toFixed(2) + 'x';
      const waiting = all.filter((c) => c.share >= 0.5 * L);
      const calm = all.filter((c) => c.share < 0.5 * L);
      // How much every OTHER console reports waiting on this one, by port.
      const waitedOn = (c) => {
        let t = 0; const k = c.ports && c.ports.length ? c.ports[0] : null;
        if (k == null) return 0;
        for (const o of all) if (o !== c && o.waitOn && o.waitOn[k] != null) t += +o.waitOn[k];
        return t;
      };
      const capTxt = (c) => c.cap ? (who(c) === 'this device' ? 'this device' : who(c) + '\'s device') + ' runs this game at ' + fx(c.cap) + 'x' : '';
      if (waiting.length && calm.length) {
        // Somebody waits, somebody does not: the one(s) not waiting are what is
        // waited on. Pick the one the others waited on most (ties: lowest cap).
        calm.sort((a, b) => (waitedOn(b) - waitedOn(a)) || ((a.cap || 99) - (b.cap || 99)));
        const c = calm[0];
        v.kind = c.me ? 'self' : 'device'; v.port = c.ports && c.ports.length ? c.ports[0] : null; v.cap = c.cap || null;
        let why;
        if (c.cap && c.cap < 1) why = capTxt(c) + ', and online play goes only as fast as the slowest console';
        else if (c.cap) why = (c.me ? 'this device falls' : who(c) + '\'s device falls') + ' behind in bursts though it runs this game at '
                            + fx(c.cap) + 'x on average' + (c.lost > 0.01 ? ' (' + Math.round(c.lost * 100) + '% of the time lost to late frames)' : '');
        else why = (c.me ? 'this device' : who(c) + '\'s device') + ' is not keeping up';
        v.text = head + ' — ' + (!c.me && me.share >= 0.5 * L ? 'waiting on ' + who(c) + ': ' : '') + why + '.';
        return v;
      }
      if (waiting.length && !calm.length) {
        // Everybody waits: the path is slow. If the waiting concentrates on one
        // console, it is THAT console's connection.
        let best = null, bestW = 0, tot = 0;
        for (const c of all) { const w = waitedOn(c); tot += w; if (w > bestW) { bestW = w; best = c; } }
        if (best && all.length > 2 && tot > 0 && bestW / tot >= 0.6) {
          v.kind = 'link'; v.port = best.ports && best.ports.length ? best.ports[0] : null;
          v.text = head + ' — ' + (best.me ? 'this device\'s connection' : 'the connection to ' + who(best)) + ' is slower than the '
                 + 'input delay covers' + (best.rtt ? ' (' + best.rtt + ' ms round trip)' : '') + '; the delay rises to cover it (now '
                 + rep.delay + ' frames).';
        } else {
          v.kind = 'network';
          v.text = head + ' — every console is waiting on inputs still in flight: the connection is slower than the input delay '
                 + 'covers; the delay rises to cover it (now ' + rep.delay + ' frames).';
        }
        return v;
      }
      // Nobody waits much: every console is losing time on its own.
      const slowest = all.slice().sort((a, b) => (a.cap || 99) - (b.cap || 99))[0];
      v.kind = slowest.me ? 'self' : 'all-slow'; v.port = slowest.ports && slowest.ports.length ? slowest.ports[0] : null; v.cap = slowest.cap || null;
      v.text = head + ' — ' + (slowest.cap ? capTxt(slowest) : Who(slowest) + ' is running slower than real time') + '.';
      return v;
    }

    _leadReset() { this._leadMinCur = Infinity; this._leadMinPrev = Infinity; this._leadBucketAt = this._now(); }
    _leadNote(lead) {
      const now = this._now();
      if (!this._leadBucketAt) this._leadBucketAt = now;
      if (now - this._leadBucketAt >= (this.delayCalmMs || 5000)) {
        this._leadMinPrev = this._leadMinCur; this._leadMinCur = Infinity; this._leadBucketAt = now;
      }
      if (lead < this._leadMinCur) this._leadMinCur = lead;
    }

    // One message's worth of a peer's inputs for ONE frame: { f, i, peer }.
    // Shared by the frame an 'ls' names and every frame in its window.
    // THE SAFETY NET UNDER THE REDUNDANCY WINDOW. On an unreliable channel a
    // burst longer than the window leaves a HOLE, and lockstep never guesses,
    // so a hole is a permanent stall. A console stalled on one frame for
    // NAK_AFTER_MS asks the room (reliably) for everything from that frame on;
    // every peer answers with what it holds (_resendInputsFrom). Rate-limited.
    _maybeNak(f) {
      const now = this._now();
      if (!this._stalled || (now - this._stallSince) < NAK_AFTER_MS) return;
      if (this._lastNakAt && (now - this._lastNakAt) < NAK_AFTER_MS) return;
      this._lastNakAt = now;
      this.stats.naksSent = (this.stats.naksSent || 0) + 1;
      this._send({ t: 'lsnak', f: f, peer: this.peerId });
    }
    _rxInputs(m) {
      for (const pair of m.i) {
        const port = pair[0] | 0;
        if (port < 0 || port >= this.portCount) continue;
        // ⚠ A PEER MAY ONLY DRIVE ITS OWN PORTS. Without this a buggy or
        // hostile peer could write everyone's controller.
        if (m.peer && this.roster[port] && this.roster[port] !== m.peer) continue;
        // ⚠ COUNT ARRIVALS, NOT DELIVERIES. A relayed room retransmits a
        // window of recent frames on every publish, so most of what lands
        // here is a repeat of something already held. Counting those would
        // make `inputsReceived` a measure of the redundancy rather than of
        // the input, and it is the one number that says whether a peer's
        // pads are reaching this console at all.
        const held = this.inputs.get(m.f);
        const fresh = !(held && held.has(port));
        // ⚠ ROLLBACK: A REAL INPUT NEVER OVERWRITES A REAL INPUT. A relayed
        // room retransmits; the first arrival is the truth, and a second
        // copy with different bytes would silently rewrite a frame that may
        // already be confirmed and fingerprinted.
        // In delay-based lockstep a frame is never sent twice with different
        // bytes (see "NEVER PRODUCE A FRAME THAT IS ALREADY ON THE WIRE"), so a
        // repeat — the redundancy window, a relay retransmit — carries nothing
        // new and is not even decoded.
        if (!fresh) continue;
        // ⚠ A LIMP FRAME HAS NO INPUT TO RECEIVE. A player who dropped out and
        // came back sends the frames it re-simulated while it was limp; those
        // frames are neutral on every machine by agreement, and storing the
        // bytes would make a rollback room see a "misprediction" and rewind.
        if (this._limp.size && this._isLimp(port, m.f)) continue;
        let bytes = null;
        try { bytes = b64dec(pair[1]); } catch (e) { continue; }
        this._put(m.f, port, bytes); if (fresh) this.stats.received++;
        if (this.rollback) this._rbArrived(m.f, port, bytes);
      }
    }
    // THE INPUT MESSAGE. Each carries, besides the frame it is for, the last
    // few frames this console already sent (`w`, newest last) — K = delay + 2,
    // at most 16. On a lossy link a dropped packet is then covered by the very
    // next one, 20 ms later, instead of costing a retransmission round trip
    // with everything behind it held up (a reliable ORDERED channel). The
    // encoded items are cached per frame, so the window costs no re-encoding.
    // An older peer ignores `w` and reads the frame exactly as before.
    _sendInputs(f, items, extra) {
      const cache = this._sentItems || (this._sentItems = new Map());
      cache.set(f, items);
      // HOW MANY PAST FRAMES RIDE ALONG, SIZED TO THE LOSS THE ROOM SEES.
      // Rollback has no delay, so the lockstep rule (delay + 2) would be 2. A
      // clean path gets 3: a hole then needs three consecutive losses (at 2%
      // loss, one per ~35 min per link). A path that has LOST something — any
      // peer NAKed us in the last 30 s — gets the window (8..16), so a burst
      // needs that many. ⚠ It used to be the window always, and each 'ls' went
      // from ~80 B to ~380 B: 42.9 KiB/s for a two-player room and ~193 KiB/s
      // out of a four-player host (tools/netplay_rb_msgcost_test.mjs).
      const lossy = this._nakRxAt && (this._now() - this._nakRxAt) < 30000;
      const K = Math.max(1, Math.min(16, (this.redundancy != null ? this.redundancy
        : this.rollback ? (lossy ? Math.max(8, this.rollback | 0) : 3) : (this.delay | 0) + 2)));
      // A capacity-gated room keeps a longer history: across a mode switch a
      // console can run (window + 2 x delay) frames past what a peer that was
      // away still needs, and a NAK is answered from here.
      const keep = this._capGate ? LS_KEEP : 32;
      if (cache.size > keep * 2) { for (const k of cache.keys()) { if (k < f - keep) cache.delete(k); else break; } }
      const m = { t: 'ls', f: f, i: items, peer: this.peerId };
      if (this._wr) {
        // RUN-LENGTH: a pad rarely changes from one frame to the next, so the
        // window is sent as runs [first frame, count, items] (every console in
        // the room declared it reads these — lsready/lsgo `wr`).
        const wr = [];
        let run = null, runKey = null;
        for (let g = f - K + 1; g < f; g++) {
          const it = cache.get(g);
          if (!it) { run = null; continue; }
          const key = it.__k || (it.__k = JSON.stringify(it));
          if (run && runKey === key && run[0] + run[1] === g) run[1]++;
          else { run = [g, 1, it]; runKey = key; wr.push(run); }
        }
        // A run whose pad is this frame's pad says so with 0 instead of repeating it.
        const ik = items.__k || (items.__k = JSON.stringify(items));
        for (const r of wr) if (r[2] !== 0 && (r[2].__k || JSON.stringify(r[2])) === ik) r[2] = 0;
        if (wr.length) m.wr = wr;
      } else {
        const w = [];
        for (let g = f - K + 1; g < f; g++) { const it = cache.get(g); if (it) w.push([g, it]); }
        if (w.length) m.w = w;
      }
      if (extra) Object.assign(m, extra);
      // A gated host's count of drop/undrop decisions rides its input in delay
      // lockstep too (see _lsResyncHold).
      if (this._capGate && this.isHost && !this.rollback && m.le == null) m.le = this._limpEpoch | 0;
      // A frame queued AHEAD of the one this console runs: say where it is.
      if (this._capGate && f > this.frame) m.q = this.frame;
      this._moStamp(m);
      this.stats.sent++;
      this._send(m);
    }
    // Answer an 'lsnak': every frame from `from` that we sent and still hold,
    // in one message, flagged for the RELIABLE channel (`rel`).
    _resendInputsFrom(from) {
      const cache = this._sentItems; if (!cache || !cache.size) return;
      const frames = [...cache.keys()].filter((k) => k >= from).sort((x, y) => x - y);
      if (!frames.length) return;
      const last = frames[frames.length - 1];
      const w = frames.slice(0, -1).map((k) => [k, cache.get(k)]);
      this.stats.naksAnswered = (this.stats.naksAnswered || 0) + 1;
      this._send(this._moStamp({ t: 'ls', f: last, i: cache.get(last), peer: this.peerId, w: w, rel: 1 }));
    }
    // HOST: a mode switch rides every input message from the decision until
    // the room is well past it (LS_KEEP frames) — see _scheduleMode.
    _moStamp(m) {
      if (this.isHost && this._moWire) {
        if (this.frame > this._moWire[1] + LS_KEEP) this._moWire = null;
        else m.mo = this._moWire;
      }
      return m;
    }

    _applyPendingDelay(f) {
      const pd = this._pendingDelay;
      if (!pd || f < pd.at) return;
      this._pendingDelay = null;
      this._leadReset();
      // A LOWERING NEEDS NO BACKFILL. Every frame up to _queuedTo already has
      // this peer's input; the only change is that from here we produce with a
      // shorter lead. The scheduling block's `at > this._queuedTo` guard keeps
      // it from re-sending anything while the queue drains.
      if (pd.d < this.delay) { this.delay = pd.d; return; }
      if (pd.d === this.delay) return;
      if (!this.localPorts.length) { this.delay = pd.d; return; }
      const last = this._lastLocal || {};
      for (let t = this._queuedTo + 1; t <= f + pd.d; t++) {
        const items = [];
        for (const p of this.localPorts) {
          const bytes = last[p] || this.neutral;
          this._put(t, p, bytes);
          items.push([p, b64enc(bytes)]);
        }
        if (items.length) this._sendInputs(t, items);
        this._queuedTo = t;
      }
      this.delay = pd.d;
    }

    static recommendDelay(rttMs, frameMs) {
      const q = frameMs > 0 ? frameMs : 1000 / 60;
      return Math.max(1, Math.min(30, Math.ceil(Math.max(0, rttMs) / 2 / q) + 1));
    }
    // FROM SEVERAL RTT SAMPLES, NOT ONE. A single ping measures one moment of
    // a link whose one-way time swings by tens of ms; a delay sized to the
    // MEAN stalls on every slow packet, and the 1.000x governor never repays a
    // stall. So the one-way budget is the larger of half the worst sample and
    // half of (mean + 2 standard deviations) — the jitter margin — and the
    // frame quantum is the console's real one (20 ms for a PAL field, not a
    // fixed 16.7). Measured in tools/netplay_pace_sim.mjs: 50-150 ms one way
    // with 0.3% loss held 0.996x at the single-sample choice (7) and 1.000x at
    // this one.
    static recommendDelayFromSamples(rtts, frameMs) {
      const budget = Lockstep.rttBudget(rtts);
      return budget == null ? null : Lockstep.recommendDelay(budget, frameMs);
    }
    // ⚠ A PING MEASURES BOTH MACHINES' MAIN THREADS, NOT JUST THE WIRE. It is
    // an application-level round trip, so a peer whose JS thread is busy —
    // booting its core, compiling wasm, a 500 ms long task — answers late, and
    // that sample describes the peer's CPU, not the link. The old budget took
    // max(worst, mean + 2 sd), which is exactly the statistic one such sample
    // owns. Reported from a live room (2026-09-30, N64 Mario Kart 64, phone
    // guest): ICE candidate-pair RTT 51 ms, but one ping taken while the phone
    // was still booting read 506 ms -> "input delay 3 -> 17 frames" = 340 ms of
    // input lag at 50 Hz, and the floor (see begin()) then held it there for
    // the whole session: delay history [].
    // A busy thread can only ever ADD time to a ping, so the budget is built
    // from the median and a robust spread (MAD), and a sample far above that
    // spread is discarded as a busy-thread artefact. A link that really is that
    // slow stalls within a second and the stall raise corrects upward — too
    // small costs one short stall; too big cost a whole evening of 340 ms lag.
    static rttBudget(rtts) {
      const xs = (rtts || []).filter((x) => typeof x === 'number' && x >= 0 && isFinite(x)).sort((a, b) => a - b);
      if (!xs.length) return null;
      if (xs.length === 1) return xs[0];
      const med = (v) => { const n = v.length, h = n >> 1; return n & 1 ? v[h] : (v[h - 1] + v[h]) / 2; };
      const m = med(xs);
      const mad = med(xs.map((x) => Math.abs(x - m)).sort((a, b) => a - b));
      const sigma = Math.max(1.4826 * mad, 0.1 * m, 2);
      const kept = xs.filter((x) => x <= m + 4 * sigma);
      return Math.max(kept[kept.length - 1], m + 2 * sigma);
    }
    // THE WIRE'S OWN FLOOR: the smallest delay the link could ever sustain,
    // from the FASTEST sample per peer (a busy thread only adds). This is what
    // a give-back may walk down to; see begin() and _maybeGiveDelayBack().
    static floorDelayForRoom(samplesByPeer, frameMs) {
      const mins = [];
      for (const k in (samplesByPeer || {})) {
        const xs = (samplesByPeer[k] || []).filter((x) => typeof x === 'number' && x >= 0 && isFinite(x));
        if (xs.length) mins.push(Math.min.apply(null, xs));
      }
      if (!mins.length) return null;
      mins.sort((a, b) => b - a);
      return Lockstep.recommendDelay(mins.length > 1 ? mins[0] + mins[1] : mins[0], frameMs);
    }
    // A ROOM OF THREE OR FOUR IS A STAR: guest-to-guest input goes through the
    // host, so the longest path one input travels is guest A -> host -> guest
    // B, i.e. about (RTT_A + RTT_B) / 2 one way — not either RTT the host can
    // ping. samplesByPeer: { peer: [rtt, ...] } as measured from the host.
    // Each peer's budget carries its own jitter margin; the room's budget is
    // the larger of the worst single peer and the sum of the two worst.
    // Measured in tools/netplay_pace_sim.mjs four-wan-loss-unreliable.
    static recommendDelayForRoom(samplesByPeer, frameMs) {
      const budgets = [];
      for (const k in (samplesByPeer || {})) {
        const b = Lockstep.rttBudget(samplesByPeer[k]);
        if (b != null) budgets.push(b);
      }
      if (!budgets.length) return null;
      budgets.sort((a, b) => b - a);
      const room = budgets.length > 1 ? Math.max(budgets[0], budgets[0] + budgets[1]) : budgets[0];
      return Lockstep.recommendDelay(room, frameMs);
    }
    // ---- THE ROLLBACK WINDOW FOR A MEASURED PATH (see the ADAPTIVE ROOM block)
    // `lateFrames`: how late the room's inputs reach its slowest console, in
    // frames (a high percentile of "frame about to run minus frame the input is
    // for"). A frame runs only while it is within the window of the newest frame
    // every port is known for, so the window must be at least that, plus one for
    // the frame being presented. On top: RB_SLACK frames of jitter margin — fewer
    // when `stepMs` (the slowest console's cost of one re-simulated frame) says
    // a rollback that deep would not fit two display ticks. The margin is the
    // only thing capacity may take away; what the path needs is never cut, or
    // the room would stall on every frame instead.
    static recommendWindow(lateFrames, stepMs, frameMs) {
      const F = frameMs > 0 ? frameMs : 1000 / 60;
      const need = Math.max(0, Math.ceil(+lateFrames || 0)) + 1;
      let slack = RB_SLACK;
      if (stepMs > 0) while (slack > 1 && stepMs * (need + slack + 2) > 2 * F) slack--;
      return Math.max(RB_WINDOW_MIN, Math.min(ROLLBACK_MAX, need + slack));
    }
    // The same from a one-way latency (ms) and its jitter, before any input has
    // been measured: travel plus one frame of sampling phase plus one of phase
    // between the two consoles' display ticks.
    static recommendWindowForPath(oneWayMs, jitterMs, frameMs, stepMs) {
      const F = frameMs > 0 ? frameMs : 1000 / 60;
      return Lockstep.recommendWindow((Math.max(0, +oneWayMs || 0) + Math.max(0, +jitterMs || 0)) / F + 2, stepMs, F);
    }
    latencyMs(frameMs) { return this.delay * (frameMs > 0 ? frameMs : 1000 / 60); }

    // ---- the lobby ----------------------------------------------------------
    // HOST. Seat a peer. Ports are handed out lowest-free-first so the
    // assignment is a pure function of join order and every machine agrees.
    // ⚠ A LATE JOINER IS REFUSED, and that is a decision, not an oversight.
    // The device set is part of the starting state: every machine plugs one
    // controller per player BEFORE the disc loads (EmscriptenWorker.cpp's
    // g_player_ports block), because mcfg_CreateDevices runs inside
    // retro_load_game. Seating someone after frame 0 would need a maple hotplug
    // landing on the identical emulated frame on every machine — the core does
    // support one (retro_run -> refresh_devices -> maple_ReconnectDevices,
    // libretro.cpp:1210) but a frame-exact agreed hotplug is a whole protocol of
    // its own. Until that exists the honest answer to a late joiner is "this
    // room has started, ask for a new one", said out loud.
    seat(peerId, count) {
      if (!this.isHost) return [];
      if (this.state === 'running' || this.state === 'stalled') {
        this._emit('barrier-failed', { error: 'the game has already started — a player cannot be seated mid-session', peer: peerId });
        return [];
      }
      const want = Math.max(1, count | 0 || 1);
      const got = [];
      // Already seated (a reconnect that kept its seat) — nothing to hand out,
      // but the roster still goes out so the returning page learns its port.
      for (let p = 0; p < this.portCount; p++) if (this.roster[p] === peerId && got.length < want) got.push(p);
      // ⚠ THE PORT THIS PERSON HELD BEFORE COMES FIRST. A player whose page
      // reloaded is the same player; giving them P3 because P2 was momentarily
      // free-and-then-taken would change which character they are mid-lobby.
      const prev = this.seatHistory.get(peerId) || [];
      for (const p of prev) {
        if (got.length >= want) break;
        if (p >= 0 && p < this.portCount && this.roster[p] == null) { this.roster[p] = peerId; got.push(p); }
      }
      for (let p = 0; p < this.portCount && got.length < want; p++) {
        if (this.roster[p] == null) { this.roster[p] = peerId; got.push(p); }
      }
      if (got.length) this.seatHistory.set(peerId, got.slice());
      // ⚠ A NEW SEAT MEANS A NEW SET. The agreed card set covers exactly the
      // OCCUPIED ports, so a seat handed out after one was assembled makes that
      // set incomplete — and a console that installed it would hold a blank
      // where the new player's card belongs while they hold their own. Drop it
      // and re-agree; nothing can start on a set that is not current, because
      // the barrier compares its fingerprint.
      if (got.length) this._cardInvalidate('a player took a seat');
      this._recount();
      this._sendRoster();
      if (got.length) this._cardTryAssemble();
      // ⚠ THE BARRIER IS A FUNCTION OF THE ROSTER, SO A ROSTER CHANGE RE-RUNS
      // IT. Declares are irrevocable and only ever arrived one at a time, so
      // this was only evaluated on a declare: a room whose still-loading third
      // player left stayed stuck forever with two able consoles, because nobody
      // could declare again. Same for a seat taken after the host declared —
      // lsbar has to name the new seat as waiting at once.
      if (this.state !== 'running' && this.state !== 'stalled') this._checkBarrier();
      return got;
    }
    unseat(peerId) {
      if (!this.isHost) return;
      const had = [];
      for (let p = 0; p < this.portCount; p++) if (this.roster[p] === peerId) { had.push(p); this.roster[p] = null; }
      if (had.length) this.seatHistory.set(peerId, had);   // remembered FOR their return
      this.lobby.delete(peerId);
      // ⚠ AND THEIR CARD. A set assembled around a player who has left names a
      // port nobody will play and carries bytes nobody contributed; leaving it
      // in place would let the room start on a set that no longer describes it.
      this._cardIn.delete(peerId);
      this._cardInvalidate('a player left the room');
      this._recount();
      this._sendRoster();
      if (this.isHost) this._cardTryAssemble();
      if (this.state !== 'running' && this.state !== 'stalled') this._checkBarrier();
    }
    _recount() {
      this.localPorts = [];
      for (let p = 0; p < this.portCount; p++) if (this.roster[p] === this.peerId) this.localPorts.push(p);
      this._emit('roster', this.rosterReport());
    }
    _sendRoster() {
      // ⚠ THE ROOM CARRIES THE DISC. The host chose the game when it opened the
      // room; a joiner should be TOLD which one, never asked to guess it from a
      // dropdown and be refused when the two strings differ. That guess is what
      // produced "Could not connect: the other player is on gauntlet" for a
      // player who was on gauntlet.
      //
      // This does not replace the barrier's disc check — that one compares what
      // each machine ACTUALLY LOADED and is the only check that can be trusted,
      // because it reads the loaded disc rather than an intention. This is how
      // a joiner learns WHICH disc to load in the first place.
      this.rosterSeq++;
      this.rosterAt = Date.now();
      this._rosterSend();
      this._rosterBeat();
    }
    // The wire form, separated from the version bump so a HEARTBEAT can repeat
    // the current roster without pretending it is a new one.
    _rosterSend() {
      this._send({ t: 'lsroster', r: this.roster.slice(), portCount: this.portCount,
                   padBytes: this.padBytes, delay: this.delay, hashEvery: this.hashEvery,
                   game: this.game || null, seq: this.rosterSeq });
    }
    // ⚠ A ROSTER SENT ONCE CANNOT SURVIVE THIS PRODUCT.
    // _sendRoster() had exactly three callers — seat(), unseat(), and the
    // barrier release — so the roster was a host push at three discrete
    // moments with NO retransmit and no way to ask for one. Every way a peer
    // can miss one of those three moments therefore left it holding a snapshot
    // it could never learn was stale, and this page RELOADS ON PURPOSE as part
    // of forming a room (dreamcast.html's lsRestartIntoRoom). That is the
    // user's phone: "P1 f126ff364842db19 · P2 you", a roster it received before
    // the disruption, drawn over a room the host had already emptied.
    // A heartbeat costs one small JSON message every ROSTER_BEAT_MS while the
    // room is still forming, and it stops the moment the game starts — after
    // the barrier the roster cannot change, so there is nothing to converge on
    // and nothing to spend bandwidth on during play.
    _rosterBeat() {
      if (!this.isHost) return;
      if (this._rosterTimer) return;
      const tick = () => {
        if (!this.isHost || this.state === 'running' || this.state === 'stalled' ||
            this.state === 'ended' || this.state === 'failed' || this.state === 'desync') {
          this.stopRosterBeat(); return;
        }
        this._rosterSend();
      };
      const t = setInterval(tick, ROSTER_BEAT_MS);
      // A Node test constructs a Lockstep with an injected channel; an
      // un-unref'd interval would hold that process open forever.
      if (t && typeof t.unref === 'function') t.unref();
      this._rosterTimer = t;
    }
    stopRosterBeat() {
      if (this._rosterTimer) { clearInterval(this._rosterTimer); this._rosterTimer = 0; }
    }
    // GUEST: "tell me what the room looks like." Harmless on a host (which
    // answers its own question with the roster it already holds).
    requestRoster() { if (!this.isHost) this._send({ t: 'lsrosterq', peer: this.peerId }); }
    occupiedPorts() {
      const out = [];
      for (let p = 0; p < this.portCount; p++) if (this.roster[p] != null) out.push(p);
      return out;
    }
    rosterReport() {
      return this.roster.map((peer, port) => ({
        port, peer, local: peer === this.peerId,
        dropped: this.dropped.has(port) ? this.dropped.get(port) : null,
      }));
    }

    // EVERY MACHINE. "My core is booted and holding at frame 0, on this disc."
    // `disc` is whatever identifies the loaded game — a name plus a size, a
    // content hash, anything, as long as two machines with the same game
    // produce the same string. It is COMPARED, not trusted.
    declareReady(disc) {
      // ⚠ REMEMBER THAT WE DECLARED. The page derived "ready" from the engine
      // STATE, and declareReady sets that state to 'waiting' — so a peer that
      // had successfully declared still rendered as NOT READY until the barrier
      // released, and the barrier only releases once everyone is ready. The
      // player presses Ready, the row does not change, so they press again.
      // Reported verbatim: "I keep hitting I'm ready, nothing is happening."
      this._declaredReady = true;
      this.disc = String(disc == null ? '' : disc);
      this._setState('waiting', 'holding at frame 0');
      // `cu`: this console's page can follow an ADAPTIVE rollback room (see
      // opts.rbCatchUp). An older host ignores it.
      // `ms`: this ENGINE can switch the room between rollback and delay at an
      // agreed frame (capacity gating); `st`: what the page has measured one
      // rollback step to cost so far (0 = nothing yet); `rz`: see opts.rbResume.
      const st = Math.round((+this.selfStepMs || 0) * 10) / 10;
      if (this.isHost) {
        this._lobbySet(this.peerId, this.disc, this.rbCatchUpOn, this.rbCapable, true, { ms: true, st, rz: this.rbResume, mw: this.rbMaxWindow });
        this._checkBarrier();
      } else {
        const m = { t: 'lsready', peer: this.peerId, disc: this.disc, wr: 1, ms: 1 };
        if (this.rbCatchUpOn) m.cu = 1;
        if (this.rbCapable) m.rb = 1;
        if (st > 0) m.st = st;
        if (this.rbResume) m.rz = 1;
        if (this.rbMaxWindow > 0) m.mw = this.rbMaxWindow | 0;
        this._send(m);
      }
    }
    // cu: follows an adaptive room; rb: can run rollback at all; wr: reads the
    // run-length redundancy window (see _sendInputs); x: { ms, st, rz } (see declareReady).
    _lobbySet(peer, disc, cu, rb, wr, x) {
      x = x || {};
      this.lobby.set(peer, { disc, ready: true, cu: !!cu, rb: !!rb, wr: !!wr, ms: !!x.ms,
                             st: Math.max(0, +x.st || 0), rz: !!x.rz, mw: Math.max(0, x.mw | 0) });
    }
    // ⚠ A PAGE THAT CAME BACK IS NOT THE PAGE THAT DECLARED. The host keeps a
    // returning incarnation's SEAT (see Session._linkGone's keepSeat), but the
    // lobby entry {ready:true} was made by the page that died, and the new one
    // is still loading. With every page now declaring by itself the moment it
    // is able, leaving that entry in place lets the barrier release onto a
    // core that does not exist yet. Forget the declare; the returning page
    // re-declares after its own load, and the barrier is re-checked so lsbar
    // names the seat honestly as waiting.
    forgetReady(peer) {
      if (!this.isHost || this.state === 'running' || this.state === 'stalled') return false;
      const had = this.lobby.delete(peer);
      this._checkBarrier();
      return had;
    }

    // =========================================================================
    // THE ROOM'S MEMORY CARDS, AGREED BEFORE FRAME 0.
    //
    // A VMU is GUEST-VISIBLE MEMORY. Two consoles that begin with different
    // card bytes are already forked at frame 0 and will diverge the first time
    // a game reads one — silently, and possibly an hour later. That is why
    // dreamcast.html refused to seed a stored card in a room at all: blank on
    // everybody was the only state two peers could be SURE they shared.
    //
    // Blank-on-everybody is not the product. A player's save has to come with
    // them. So the room agrees on a whole card SET before frame 0:
    //
    //   1. every console contributes the card for THE SEAT IT HOLDS — its own
    //      stored card, or, having none, the exact bytes of its own blank
    //      power-on card;
    //   2. the HOST assembles the set once every occupied port has contributed,
    //      and broadcasts it;
    //   3. every console — the host included — installs THE SAME SET FOR ALL
    //      PORTS, and only then declares itself ready.
    //
    // The barrier does the rest. It already refuses a room whose peers declare
    // different discs, and dreamcast.html folds this set's fingerprint into that
    // declaration, so a console holding a different set is REFUSED BY NAME
    // instead of being allowed to fork. That is the same trade the page already
    // made for the boot seed ('#seeded' / '#coldboot'): same disc, different
    // machine at frame 0 is the same class of mismatch and is refused the same
    // tested way.
    //
    // ⚠ THE BYTES TRAVEL, NOT A DESCRIPTION OF THEM. "Everyone starts blank"
    // sounds like agreement and is not: it makes every peer depend on its own
    // build producing a byte-identical blank card. This one does — maple_devs.cpp
    // uncompresses a single baked-in `vmu_default` — but that is a property of a
    // build, not of the protocol, and a room can hold two builds. A console with
    // no stored card therefore contributes ITS OWN card's bytes and everybody
    // installs those.
    //
    // ⚠ THE ENGINE CARRIES, IT DOES NOT INTERPRET. `bytes` is whatever the page
    // chose to transport (compressed, normally) and `enc` is an opaque tag. The
    // fingerprint compared at the barrier is over the RAW card and is computed
    // by the page, because two browsers' deflate output for identical input is
    // NOT guaranteed to be identical — hashing the compressed form would refuse
    // rooms that agree.
    //
    // ⚠ AND NOTHING HERE RUNS A FRAME. The exchange happens while every core is
    // parked at the start barrier, which is the one window in which a console
    // has loaded the disc and executed zero guest instructions.
    // =========================================================================

    // EVERY MACHINE. "Here is the card for the seat I hold."
    //   entries: [{ port, size, hash, enc, bytes }]
    // `size` and `hash` describe the RAW card; `bytes` is what to transport.
    // Safe to call again — a repeat is how a console recovers a contribution
    // that was sent before its link was carrying anything.
    contributeCards(entries) {
      const mine = {};
      for (const e of (Array.isArray(entries) ? entries : [])) {
        const port = e.port | 0;
        // ⚠ A CONSOLE MAY ONLY SPEAK FOR ITS OWN SEAT — the same rule as an
        // input packet ("a peer may only drive its own ports"), for a worse
        // reason: a card is guest-visible memory on EVERY machine, so a peer
        // allowed to write another port's card could fork the entire room.
        if (port < 0 || port >= this.portCount || this.roster[port] !== this.peerId) continue;
        mine[port] = { port, size: e.size | 0, hash: String(e.hash == null ? '' : e.hash),
                       enc: String(e.enc || 'raw'),
                       bytes: e.bytes instanceof Uint8Array ? e.bytes : new Uint8Array(e.bytes || 0) };
      }
      this._cardMine = mine;
      if (this.isHost) { this._cardIn.set(this.peerId, mine); return this._cardTryAssemble(); }
      for (const k of Object.keys(mine)) this._cardSend('lsvmu', { port: k | 0 }, mine[k]);
      return false;
    }

    // GUEST: "I do not have the room's card set." Harmless on a host, which
    // answers its own question with the set it already holds. Same shape, and
    // the same reason, as requestRoster().
    requestCards() { if (!this.isHost) this._send({ t: 'lsvmuq', peer: this.peerId }); }

    // WHICH SEATS THE ROOM IS STILL WAITING ON — by port AND by peer, so a page
    // can name them rather than print an unexplained wait. Host-authoritative;
    // a guest reads its own emptiness and defers.
    cardsWaitingFor() {
      const out = [];
      if (!this.isHost) return this.cards ? out : [{ port: null, peer: null }];
      for (const p of this.occupiedPorts()) {
        const peer = this.roster[p];
        const got = this._cardIn.get(peer);
        if (!got || !got[p]) out.push({ port: p, peer });
      }
      return out;
    }

    // ONE CARD'S FINGERPRINT, over the RAW bytes. Exposed rather than left to
    // each caller because the page computes it for what it contributes and
    // recomputes it for what it installs, and the two have to be the same
    // function or a healthy set would be refused as corrupt.
    static cardHash(u8) { return ('0000000' + (fnvBytes(FNV_SEED, u8) >>> 0).toString(16)).slice(-8); }

    // The fingerprint the barrier compares. Over the RAW card descriptions, in
    // port order, so every machine computes the same string from the same set.
    static cardSetHash(set) {
      if (!set) return null;
      const ports = Object.keys(set).map((p) => p | 0).sort((a, b) => a - b);
      let s = '';
      for (const p of ports) s += p + ':' + (set[p].size | 0) + ':' + set[p].hash + ';';
      let h = FNV_SEED;
      for (let i = 0; i < s.length; i++) h = fnv32(h, s.charCodeAt(i));
      return ('0000000' + (h >>> 0).toString(16)).slice(-8);
    }

    _cardInvalidate(why) {
      if (!this.cards && !this.cardSetHash) return;
      this.cards = null; this.cardSetHash = null; this._cardRx = null;
      this._emit('cards', { set: null, hash: null, error: why + ' — the card set has to be agreed again' });
    }

    // ---- the wire: one card at a time, in pieces ----------------------------
    _cardSend(t, extra, entry) {
      const b = entry.bytes;
      const n = Math.max(1, Math.ceil(b.length / CARD_CHUNK));
      for (let i = 0; i < n; i++) {
        const s = b.subarray(i * CARD_CHUNK, Math.min((i + 1) * CARD_CHUNK, b.length));
        this._send(Object.assign({ t, size: entry.size, hash: entry.hash, enc: entry.enc,
                                   len: b.length, n, i, d: b64enc(s) }, extra));
      }
    }
    // Reassemble one card. Returns null until it is WHOLE — and null, not a
    // short buffer, if the pieces do not add up to the length the sender
    // announced. A truncated card installs as a corrupt card, which is the
    // silent fork this whole path exists to prevent.
    _cardTake(store, key, m) {
      const n = m.n | 0, len = m.len | 0;
      if (n <= 0 || len < 0) return null;
      let r = store.get(key);
      if (!r || r.hash !== m.hash || r.n !== n || r.len !== len) {
        r = { hash: String(m.hash == null ? '' : m.hash), enc: String(m.enc || 'raw'),
              size: m.size | 0, len, n, parts: new Array(n), got: 0 };
        store.set(key, r);
      }
      const i = m.i | 0;
      if (i < 0 || i >= n || r.parts[i] !== undefined) return null;
      let piece = null;
      try { piece = b64dec(String(m.d || '')); } catch (e) { return null; }
      r.parts[i] = piece; r.got++;
      if (r.got !== n) return null;
      store.delete(key);
      let total = 0; for (const c of r.parts) total += c.length;
      if (total !== len) return null;
      const out = new Uint8Array(total);
      let o = 0; for (const c of r.parts) { out.set(c, o); o += c.length; }
      return { size: r.size, hash: r.hash, enc: r.enc, bytes: out };
    }

    // ---- the host assembles, and only when the set is COMPLETE --------------
    _cardTryAssemble() {
      if (!this.isHost) return false;
      const ports = this.occupiedPorts();
      if (!ports.length || this.cardsWaitingFor().length) return false;
      const set = {};
      for (const p of ports) set[p] = this._cardIn.get(this.roster[p])[p];
      const h = Lockstep.cardSetHash(set);
      if (this.cards && this.cardSetHash === h) return true;   // nothing new to say
      this.cards = set; this.cardSetHash = h; this._cardSeq++;
      this._cardBroadcast();
      this._emit('cards', { set: this.cards, hash: h, seq: this._cardSeq });
      return true;
    }
    _cardBroadcast() {
      if (!this.isHost || !this.cards) return;
      const ports = Object.keys(this.cards).map((p) => p | 0).sort((a, b) => a - b);
      // ⚠ THE MANIFEST GOES FIRST. A receiver has to know how many pieces are
      // coming, for which ports, and what the whole set should fingerprint to,
      // BEFORE any of them lands — otherwise it cannot tell a set that is still
      // arriving from one that arrived truncated, and "still arriving" that is
      // really "truncated" is a console that never starts with no reason given.
      this._send({ t: 'lsvmuz', seq: this._cardSeq, set: this.cardSetHash,
                   ports: ports.map((p) => ({ port: p, size: this.cards[p].size,
                                              hash: this.cards[p].hash, enc: this.cards[p].enc,
                                              len: this.cards[p].bytes.length })) });
      for (const p of ports) this._cardSend('lsvmus', { seq: this._cardSeq, port: p }, this.cards[p]);
    }

    // HOST. Nobody runs frame 0 until every seated peer is ready ON THE SAME
    // DISC. A peer still downloading holds the rest, and that wait is reported
    // rather than being an unexplained pause.
    _checkBarrier() {
      // ⚠ 'stalled' IS A STARTED ROOM TOO. The guard read only 'running', so a
      // late or repeated 'lsready' reaching a host that happened to be waiting
      // on an input re-sent 'lsgo' and re-ran begin(): the host jumped back to
      // frame 0 mid-game (tools/delay_stepdown_test.mjs pins it).
      if (!this.isHost || this.state === 'running' || this.state === 'stalled') return;
      const seated = [];
      for (const p of this.roster) if (p != null && seated.indexOf(p) < 0) seated.push(p);
      const missing = seated.filter((p) => !this.lobby.has(p));
      const discs = {};
      for (const p of seated) if (this.lobby.has(p)) discs[p] = this.lobby.get(p).disc;
      // ⚠ `alone` IS A BARRIER CONDITION, NOT A HINT. See the guard below.
      const info = { seated, ready: seated.length - missing.length, waitingFor: missing, discs,
                     alone: seated.length < 2 };
      this._bar = info;
      this._emit('barrier', info);
      // ⚠ AND TELL THE OTHERS. Only the host holds `lobby`, so without this a
      // joiner staring at "waiting…" has no idea WHO it is waiting for — and
      // "a peer still downloading HOLDS the others, visibly" is the whole point
      // of the barrier. Host-authoritative, so guests only ever render it.
      this._send({ t: 'lsbar', b: info });
      if (missing.length) return;
      // ⚠ A HOST ALONE NEVER STARTS. `seated` is DISTINCT PEERS, so a couch
      // host holding two pads is still one person. This guard did not exist,
      // and its absence is why every page had to make a HUMAN press "I'm
      // ready": n64/index.html records the failure an auto-ready cut produced
      // without it — the machine that booted first passed the barrier ALONE,
      // and every later joiner was then refused as a late joiner. The user's
      // directive (2026-09-13) is that the room starts BY ITSELF when both
      // consoles are able and that there is no ready button, so the minimum
      // has to live HERE, where every page's declare arrives, or a page that
      // auto-declares on boot starts a party of one. `info.alone` goes out in
      // lsbar so the party panel can say "waiting for another player".
      if (info.alone) return;
      // Same disc, or nobody starts.
      const mine = discs[this.peerId];
      const wrong = seated.filter((p) => discs[p] !== mine);
      if (wrong.length) {
        const detail = wrong.map((p) => p + ' has "' + discs[p] + '"').join(', ');
        this._send({ t: 'lsx', f: 0, why: 'different game: everyone must load "' + mine + '" (' + detail + ')' });
        this.fail('the players are not all on the same game — ' + detail);
        this._emit('barrier-failed', { expected: mine, discs, wrong });
        return;
      }
      this._sendRoster();
      // ADAPTIVE ROLLBACK only when every seated console's page said it can
      // follow a window that moves and run catch-up frames (lsready `cu`).
      // The first window then covers what the Session already measured of the
      // path, if anything (rbHintMs); the room measures the rest itself.
      // ROLLBACK ONLY IF EVERY CONSOLE CAN RUN IT (lsready `rb`), else delay lockstep.
      if (this.rollback && !seated.every((p) => this.lobby.has(p) && this.lobby.get(p).rb)) {
        const without = seated.filter((p) => !(this.lobby.get(p) || {}).rb);
        this._emit('rollback-off', { why: this._labels(without) + ' cannot run rollback, so the room uses input delay', peers: without });
        this.rollback = 0;
      }
      this._rbAdaptive = !!(this.rollback && seated.every((p) => this.lobby.has(p) && this.lobby.get(p).cu));
      // The compact (run-length) redundancy window, only if every console reads it.
      this._wr = seated.every((p) => this.lobby.has(p) && this.lobby.get(p).wr);
      if (this._rbAdaptive && this.rbHintMs > 0) {
        this.rollback = Math.max(this.rollback, Lockstep.recommendWindowForPath(this.rbHintMs, this.rbHintMs * 0.25,
                                                                                this._frameMs(), this.selfStepMs));
      }
      // ...and never deeper than the smallest savestate ring a console declared
      // at Ready (rbMaxWindow; see _rbDecideWindow).
      if (this.rollback > 0) {
        let cap = 0;
        for (const p of seated) { const mw = (this.lobby.get(p) || {}).mw | 0; if (mw > 0) cap = cap > 0 ? Math.min(cap, mw) : mw; }
        if (cap > 0 && this.rollback > cap) this.rollback = Math.max(Math.min(this.rollback, RB_WINDOW_MIN), cap);
      }
      // CAPACITY GATING (see the block above _capDecide): only a rollback room
      // whose every console's ENGINE can switch modes at an agreed frame (`ms`),
      // and whose host plays (its inputs are what carries the switch). The room
      // STARTS in delay lockstep if a console already reported, at Ready, a
      // rollback step it cannot afford.
      this._capGate = !!(this.rollback && this.localPorts.length && seated.every((p) => this.lobby.has(p) && this.lobby.get(p).ms));
      let startDelay = null;
      if (this._capGate) {
        this._capW = this.rollback; this._capAdaptive = this._rbAdaptive;
        const fps = 1000 / this._frameMs(), slow = [];
        let worst = 0;
        for (const p of seated) {
          const st = (this.lobby.get(p) || {}).st || 0;
          const need = st * CAP_RS_START * fps / 1000;
          if (need > worst) worst = need;
          if (need > CAP_HI) slow.push(p);
        }
        // ...but only when the path is known well enough to SIZE the delay (a
        // one-way hint the Session measured, or the wire's floor): a room
        // started at a delay the link outruns stalls until the pace machinery
        // has raised it. Without one the room starts in rollback and the first
        // measurement decides (_capEager).
        const hint = this.rttDelay > 0 || this.rbHintMs > 0 || this.netFloorDelay > 0;
        if (slow.length && hint) {
          startDelay = { slow, need: worst };
          this.rollback = 0; this._rbAdaptive = false;
          if (this.rttDelay > 0) {
            // The delay a lockstep room on this link starts at — exactly (rttDelay).
            this.delay = Math.max(1, Math.min(30, this.rttDelay | 0));
          } else {
            let d = this.rbHintMs > 0 ? Lockstep.recommendDelay(2 * this.rbHintMs * 1.25 * (seated.length > 2 ? 2 : 1), this._frameMs()) : 2;
            if (this.netFloorDelay > 0) d = Math.max(d, this.netFloorDelay | 0);
            this.delay = Math.max(2, Math.min(30, Math.max(d, this.delay | 0)));
          }
        } else if (slow.length) this._capEager = true;
      }
      const go = { t: 'lsgo', peer: this.peerId, delay: this.delay, hashEvery: this.hashEvery, rb: this.rollback,
                   portCount: this.portCount, padBytes: this.padBytes, r: this.roster.slice() };
      if (this._rbAdaptive || (this._capGate && this._capAdaptive)) go.rba = 1;
      if (this._wr) go.wr = 1;
      if (this._capGate) { go.cg = 1; go.cw = this._capW; }
      if (startDelay) go.cs = startDelay.slow;
      this._send(go);
      this.begin();
      if (startDelay) {
        this._capDownAt = this._now();
        this._modeNote(0, this.delay, this._capW, this._capWhy(startDelay.slow, startDelay.need, true), startDelay.slow);
      }
    }

    begin() {
      // Same reason as _checkBarrier: a repeated 'lsgo' reaching a guest that
      // is stalled must not reset it to frame 0 and wipe the inputs it holds.
      if (this.state === 'running' || this.state === 'stalled') return;
      // ⚠ THE FLOOR IS THE DELAY IN FORCE WHEN THE ROOM STARTS, NOT THE ONE THE
      // CONSTRUCTOR SAW. _maybeGiveDelayBack() promises never to step below what
      // the measured RTT asked for at Ready, and it did not deliver: _delayFloor
      // was assigned once, in the constructor, from opts.delay (the 2-3 default),
      // while every page chooses the real delay AFTER construction by assigning
      // it directly — dreamcast.html `ls.delay = want`, n64/index.html the same,
      // and the relay path's `this.ls.delay = this.relay.delayFrames` before the
      // barrier. So a room that started at 9 carried a floor of 2, the give-back
      // walked it 9 -> 8 -> 7 ... one calm window at a time, the next stall
      // raised it by half again, and the pair oscillated around the measurement
      // instead of settling on it. This is the one point both sides pass through
      // holding the host's chosen delay — the host right after it sends `lsgo`,
      // a guest after the 'lsgo' case adopts m.delay — so the snapshot here IS
      // the delay the room started with, on every machine. The constructor's
      // line stays as the pre-begin value; tools/delay_stepdown_test.mjs pins
      // both.
      this._delayFloor = Math.max(2, this.delay | 0);
      // ⚠ ...BUT NEVER ABOVE WHAT THE WIRE ITSELF NEEDS. When the host measured
      // the link (Session.rttReport sets netFloorDelay from the fastest ping per
      // peer), a start delay inflated by a busy peer can be given back down to
      // that — without this the 17-frame start above was also the floor, and
      // the room could never leave it.
      if (this.netFloorDelay > 0) this._delayFloor = Math.max(2, Math.min(this._delayFloor, this.netFloorDelay | 0));
      // ⚠ ROLLBACK HAS NO INPUT DELAY. That is the whole point of it — see
      // _beginFrameRb. `delay` stays a number every reader understands (0).
      if (this.rollback) this.delay = 0;
      if (!this.rollback) this._rbAdaptive = false;
      this._rbReset();
      // Everybody is heard from as of the start: the silence a host drops a
      // player for is measured from here, not from before the barrier.
      this._heardAt.clear();
      { const t0 = this._now(); for (const pid of this.expectedPeers()) this._heardAt.set(pid, t0); }
      this.frame = 0; this._scheduledTo = 0; this._stalled = false; this._stallSince = 0;
      this._queuedTo = -1; this._pendingDelay = null;
      this._modeNext = null; this._moWire = null; this._capHot = 0; this._capCalmSince = 0; this._lsHostSeenF = 0;
      this._capWarmUntil = this._now() + CAP_WARM_MS;
      this._lsTickMark = false; this._lsTickRan = 0; this._lsCadAt = 0; this._lsCadBase = 0;
      this._capSelfPrev = null; this._rbRanAny = false;
      this._paceWinOpen = false; this._paceHot = 0; this.pace = null; this._paceBornAt = this._now();
      this.inputs.clear(); this.myHash.clear(); this.myWords.clear(); this.peerHash.clear();
      this.lastAgreedFrame = -1;
      this._recount();
      this._setState('running');
      this._emit('ready', { delay: this.delay, hashEvery: this.hashEvery, rollback: this.rollback,
                            portCount: this.portCount, ports: this.rosterReport() });
    }

    // ---- a player walks out -------------------------------------------------
    // THE DECISION, MADE EXPLICITLY BECAUSE IT HAS A GAMEPLAY CONSEQUENCE:
    // the leaver's CONTROLLER STAYS PLUGGED IN AND GOES LIMP. From an agreed
    // future frame their port reads all-zero on every machine, forever.
    //   * not "stall until they come back" — one person closing a tab would
    //     wedge everyone else, which is the worst possible outcome;
    //   * not "unplug the port" — removing a maple device is GUEST-VISIBLE
    //     state, so it would itself have to happen on the identical frame
    //     everywhere and would change what the game sees mid-match. A limp pad
    //     is what a real player putting the controller down looks like.
    // The frame is in the FUTURE (delay + margin) precisely so that no machine
    // has already run past it when the notice arrives — a drop applied at
    // different frames on different machines IS a desync.
    dropPeer(peerId, why) {
      if (!this.isHost) return [];
      const ports = [];
      for (let p = 0; p < this.portCount; p++) if (this.roster[p] === peerId) ports.push(p);
      if (!ports.length) return [];
      // ⚠ THE BOUNDARY IS ONE PAST THE LEAVER'S LAST INPUT, AND A MARGIN MAKES
      // IT WRONG IN BOTH DIRECTIONS.
      //   too HIGH and every frame in between still needs input that is never
      //     coming — an earlier version added 30 frames of "notice" and thereby
      //     manufactured 30 permanently unsatisfiable frames, deadlocking the
      //     room instead of continuing (measured: 0 frames run past the drop,
      //     which is the exact failure this path exists to prevent);
      //   too LOW and it rewrites a frame some machine has already executed,
      //     which is itself a desync.
      // Both constraints are satisfied by exactly one value. NOBODY can have
      // executed past the leaver's last input — running frame f needs EVERY
      // occupied port's input for f, theirs included — so "one past the last
      // input we hold for their ports" is simultaneously the first untouched
      // frame and the last satisfiable one.
      let last = -1;
      for (const [f, m] of this.inputs) for (const p of ports) if (m.has(p) && f > last) last = f;
      // ⚠ IN ROLLBACK "NOBODY RAN PAST THE LEAVER'S LAST INPUT" IS FALSE — every
      // machine ran ahead on a prediction. The boundary is then one past the
      // last frame through which the host holds EVERY frame of their input
      // (real, or already limp) — CONTIGUOUSLY, not the newest one it holds:
      // on a lossy channel the newest can sit past a hole the leaver will never
      // fill now, and a frame nobody can ever cover would stop the room for
      // good. Nobody else can hold more of it than the host does (a guest hears
      // another guest only through the host's relay), so no machine has
      // CONFIRMED a frame at or past the boundary, and each re-simulates from
      // it (_applyDrop) — never deeper than its window, because every console's
      // own confirmed frontier is below it too.
      if (ports.every((p) => this.dropped.has(p))) return ports;   // already limp
      let at;
      if (this.rollback || this._capGate) {
        // Bounded: never past what has actually been received (an open limp
        // span reads neutral forever).
        // (A capacity-gated room in DELAY lockstep counts from the frame the
        // host last ran — it holds every input before it — so the boundary is
        // likewise one past the CONTIGUOUS input, never past a hole the leaver
        // will not fill now.)
        let hi = -1;
        for (const k of this.inputs.keys()) if (k > hi) hi = k;
        let c = Infinity;
        for (const p of ports) {
          let k = this.rollback ? Math.max(-1, this._rbInputsTo) : this.frame - 1;
          while (k < hi && this._inputFor(k + 1, p) !== undefined) k++;
          if (k < c) c = k;
        }
        at = c + 1;
      } else at = Math.max(last + 1, this.frame);
      this._send({ t: 'lsdrop', ports, at, peer: peerId, why: why || null, e: this._limpEpoch + 1 });
      this._applyDrop(ports, at, peerId, why);
      return ports;
    }
    // `fromTable`: applied from the host's limp table in an 'lsfill' — a drop
    // this console missed while it was away, rather than one announced live.
    _applyDrop(ports, at, peerId, why, fromTable) {
      let changed = false;
      for (const p of ports) {
        if (this.dropped.has(p)) continue;
        const spans = this._limp.get(p) || [];
        // Never let a new span start inside or before the previous one.
        const prevEnd = spans.length ? spans[spans.length - 1][1] : -Infinity;
        const from = Math.max(at, prevEnd === Infinity ? at : prevEnd);
        this.dropped.set(p, from);
        spans.push([from, Infinity]);
        this._limp.set(p, spans);
        changed = true;
        // ⚠ FINGERPRINTS OF A STATE THE ROOM DOES NOT SHARE. From `from` this
        // port is neutral everywhere; a state its OWNER computed on its own pad
        // there is not the room's, and must neither be compared nor count
        // against the owner when it re-simulates on the neutral pad.
        const owner = this.roster[p];
        // ⚠ DELAY LOCKSTEP CANNOT REWIND. If this console already ran frames at
        // or past `from` on its own non-neutral pad (its link died while it kept
        // running, and what it sent never reached the host), it no longer has
        // the room's state. It leaves the room — the others are unaffected,
        // their copy of this port is the neutral one.
        if (owner != null && owner === this.peerId && !this.rollback && from < this.frame) {
          let ran = false;
          for (let k = from; k < this.frame && !ran; k++) {
            const m = this.inputs.get(k), v = m && m.get(p);
            if (v) for (let i = 0; i < v.length; i++) if (v[i] !== this.neutral[i]) { ran = true; break; }
          }
          if (ran) this._lsOutOfStep = from;
        }
        if (owner != null && owner === this.peerId) {
          for (const k of Array.from(this.myHash.keys())) if (k >= from) { this.myHash.delete(k); this.myWords.delete(k); }
          if (this._rbHashQ) this._rbHashQ = this._rbHashQ.filter((k) => k < from);
          if (this.rollback && this._rbConfirmed >= from) this._rbConfirmed = from - 1;
        } else if (owner != null) {
          for (const [k, byPeer] of this.peerHash) if (k >= from) byPeer.delete(owner);
        }
      }
      if (!changed) return;
      this._limpEpoch = (this._limpEpoch | 0) + 1;
      this._limpEventAt = at;
      if (this._lsOutOfStep != null) {
        const k = this._lsOutOfStep; this._lsOutOfStep = null;
        this.fail('this console lost its link while it kept playing: the room had already let go of its controller at frame ' + k
                  + ' and played on without it — leave the party and join again');
      }
      // ROLLBACK: frames from `at` on may already have run on a PREDICTION of
      // the leaver's pad; from `at` their port is neutral on every machine, so
      // anything simulated past it is re-run on the neutral pad.
      if (this.rollback && at < this.frame && at < this._rbFrom) this._rbFrom = at;
      this._emit('leave', { peer: peerId || null, ports: ports.slice(), at, who: this.labelOf(peerId, ports),
                            why: why || null, mine: ports.some((p) => this.localPorts.indexOf(p) >= 0),
                            missed: !!fromTable });
      this._emit('roster', this.rosterReport());
    }
    // ---- A DROPPED PLAYER COMES BACK (rollback rooms) -----------------------
    // The mirror of dropPeer. The HOST names a FUTURE frame R; on every machine
    // that port stays neutral for frames < R and reads the returning player's
    // real input from R on. R is past every console's present by the window, so
    // nobody has run it on a guess of "limp" — and if somebody has (a guest far
    // ahead of the host), _applyUndrop rewinds it to R like any late input.
    // Only a ROLLBACK room can do this: its returning console re-simulates the
    // frames it missed as hidden catch-up frames (rbCatchUp) and asks to come
    // back only once it is caught up, so its input for R is on the wire before
    // anybody needs it.
    rejoinPeer(peerId) {
      if (!this.isHost || !this._dropRoom() || this._modeNext) return [];   // (the guest asks again)
      const ports = [];
      for (let p = 0; p < this.portCount; p++) if (this.roster[p] === peerId && this.dropped.has(p)) ports.push(p);
      if (!ports.length) return [];
      if (!this.rollback) {
        // DELAY LOCKSTEP (a gated room): past every frame anybody can have run
        // (nobody runs more than the delay past the host's own input) and past
        // what the returning console has already queued (its pad goes `delay`
        // ahead of the frame it runs, and it is level with the room).
        const d = Math.max(this.delay, this._pendingDelay ? this._pendingDelay.d | 0 : 0);
        const at = this.frame + 2 * d + 8;
        this._heardAt.set(peerId, this._now());
        this._send({ t: 'lsundrop', ports, at, peer: peerId, e: this._limpEpoch + 1 });
        this._applyUndrop(ports, at, peerId);
        return ports;
      }
      // Two windows ahead: a guest may itself run a window ahead of the host,
      // and the notice can trail by a retransmission; the rewind it causes must
      // stay inside every ring (measured at one window: 4 of 24 three-player
      // rooms at 8% loss rewound one or two frames past theirs).
      const at = this.frame + 2 * Math.max(4, this.rollback) + 4;
      this._heardAt.set(peerId, this._now());
      this._send({ t: 'lsundrop', ports, at, peer: peerId, e: this._limpEpoch + 1 });
      this._applyUndrop(ports, at, peerId);
      return ports;
    }
    _applyUndrop(ports, at, peerId, fromTable) {
      let changed = false;
      for (const p of ports) {
        const spans = this._limp.get(p);
        if (!spans || !spans.length) continue;
        const s = spans[spans.length - 1];
        if (s[1] !== Infinity) continue;            // already back
        s[1] = Math.max(s[0], at);
        this.dropped.delete(p);
        changed = true;
      }
      if (!changed) return;
      this._limpEpoch = (this._limpEpoch | 0) + 1;
      this._limpEventAt = at;
      this.rbStats.rejoins++;
      // ⚠ FROM `at` THAT PORT IS A REAL PAD AGAIN, SO NOTHING CONFIRMED OR
      // FINGERPRINTED AT OR PAST IT ON THE NEUTRAL PAD STANDS — on ANY console,
      // not only the returning one (the mirror of _applyDrop's purge; measured
      // without it: 9 desyncs in 24 three-player rooms at 8% loss).
      for (const k of Array.from(this.myHash.keys())) if (k >= at) { this.myHash.delete(k); this.myWords.delete(k); }
      for (const k of Array.from(this.peerHash.keys())) if (k >= at) this.peerHash.delete(k);
      if (this._rbHashQ) this._rbHashQ = this._rbHashQ.filter((k) => k < at);
      if (this.rollback && this._rbConfirmed >= at) this._rbConfirmed = at - 1;
      // ...and the INPUT frontier comes back too: while the port was limp its
      // frames counted as known; from `at` they are real inputs still to
      // arrive, and a frontier left past them would let the window run on
      // unchecked (measured: a 22-frame rewind in a 21-frame ring).
      if (this.rollback && this._rbInputsTo >= at) this._rbInputsTo = at - 1;
      if (this._sentDiag) for (const k of Array.from(this._sentDiag)) if (k >= at) this._sentDiag.delete(k);
      // Anything already simulated at or past `at` ran this port neutral;
      // from `at` it is a real (or predicted) pad, so re-run it.
      if (this.rollback && at < this.frame && at < this._rbFrom) this._rbFrom = at;
      const mine = ports.some((p) => this.localPorts.indexOf(p) >= 0);
      // THE RETURNING PLAYER'S OWN INPUT FROM `at` ON. Anything it already sent
      // for those frames reached the room while they were still limp and was
      // discarded; send it again (reliably) instead of waiting for the NAKs.
      if (mine && (this.rollback || this._capGate)) { this._rbOwed = 0; this._resendInputsFrom(at); }
      this._emit('rejoin', { peer: peerId || null, ports: ports.slice(), at, who: this.labelOf(peerId, ports),
                             mine, missed: !!fromTable });
      this._emit('roster', this.rosterReport());
    }
    // ⚠ A PLAYER IS NAMED BY THE SEAT THEY HOLD, NEVER BY THEIR PEER ID. A peer
    // id is the session's 16-hex nonce; the host's old stall failure printed
    // "no input from 76e494f866656aac for 8s" to a person holding a phone.
    labelOf(peerId, ports) {
      let ps = ports;
      if (!ps || !ps.length) { ps = []; for (let p = 0; p < this.portCount; p++) if (this.roster[p] === peerId) ps.push(p); }
      if (!ps.length) return 'a player';
      if (peerId != null && peerId === this.peerId) return 'this console (player ' + (ps[0] + 1) + ')';
      return 'player ' + (ps[0] + 1) + (ps[0] === 0 && this.roster[0] != null && !this.isHost && peerId === this.roster[0] ? ' (the host)' : '');
    }
    _labels(peers) {
      const out = [];
      for (const pid of peers || []) { const l = this.labelOf(pid); if (out.indexOf(l) < 0) out.push(l); }
      return out.join(', ') || 'another player';
    }

    // ---- the frame loop -----------------------------------------------------
    // Call ONCE per attempt at the current frame, with this machine's pads.
    //   pads: a Uint8Array when this machine owns exactly one port, or
    //         { <port>: Uint8Array } / Map when it owns several.
    // Returns
    //   { ready:true,  frame, image, pads }        run one frame with `image`
    //   { ready:false, frame, reason, waitingOn, waitingPeers }   DO NOT RUN
    // `image` is the whole maple picture — portCount * padBytes — which is
    // exactly what the worker's 'lsInput' takes.
    //
    // The local input is scheduled and SENT on the first attempt at a frame even
    // when that attempt then stalls; otherwise a stalled machine starves its
    // peers and the whole room deadlocks.
    // `opt` (rollback only): { hidden: true } for a catch-up frame rbCatchUp()
    // granted — see the ADAPTIVE ROOM block.
    beginFrame(pads, opt) {
      if (this.state === 'desync' || this.state === 'ended' || this.state === 'failed') {
        return { ready: false, frame: this.frame, reason: this.state, waitingOn: [], waitingPeers: [] };
      }
      if (this.state !== 'running' && this.state !== 'stalled') {
        return { ready: false, frame: this.frame, reason: 'not-started', waitingOn: [], waitingPeers: [] };
      }
      // A MODE SWITCH THE HOST AGREED FOR THIS FRAME (capacity gating) is applied
      // before anything else: frame `at` runs in the new mode on every console.
      if (this._modeNext && this.frame >= this._modeNext.at && !this._applyMode()) {
        return { ready: false, frame: this.frame, reason: this.state, waitingOn: [], waitingPeers: [] };
      }
      if (this.rollback) return this._beginFrameRb(pads, opt);
      if (this._capGate) {
        this._lsDropTick(this._now());
        const hold = this._lsResyncHold();
        if (hold) return hold;
        if (!(opt && opt.hidden) && this._lsCadenceHold()) {
          return { ready: false, frame: this.frame, reason: 'cadence', waitingOn: [], waitingPeers: [] };
        }
      }
      this._paceTick();
      const f = this.frame;
      // ⚠ NEVER PRODUCE A FRAME THAT IS ALREADY ON THE WIRE. With a delay that
      // only ever rose, `at` was monotonic and this could not happen. Now that
      // the delay can come back DOWN, `f + delay` can land on a frame this peer
      // already queued at the old, longer lead — and re-sending it with
      // different bytes is a fork. Skipping is correct: that frame's input is
      // already sent and already agreed. The queue simply drains until the
      // shorter lead is ahead of it again, which is the same instant
      // _scheduleDelay picked for the change.
      if (this._scheduledTo <= f && (f + this.delay) > this._queuedTo) {
        const at = f + this.delay;
        const items = [];
        for (const p of this.localPorts) {
          const bytes = this._coerce(pads, p);
          this._put(at, p, bytes);
          // Kept so a delay RAISE can fill the frames it skips. See
          // _applyPendingDelay(): going from D to D' leaves f+D+1 .. f+D' with
          // no input from this peer, and a hole is a stall.
          if (!this._lastLocal) this._lastLocal = {};
          this._lastLocal[p] = bytes;
          items.push([p, b64enc(bytes)]);
        }
        this._scheduledTo = f + 1;
        if (at > this._queuedTo) this._queuedTo = at;
        // ⚠ NAME THE SENDER. receive() refuses an input for a port its sender
        // does not own — but only when `m.peer` is present, and this message
        // never carried one, so with two peers the check was dead code. In a
        // relayed room it is the thing that stops one player writing another's
        // controller, so it has to be on the wire.
        if (items.length) this._sendInputs(at, items);
      }
      // Advance past this frame even when the block above SKIPPED it, or a
      // drained-queue frame would be retried forever and the room would stop.
      if (this._scheduledTo <= f) this._scheduledTo = f + 1;
      // ⚠ AFTER the scheduling block, never before it — see _applyPendingDelay.
      this._applyPendingDelay(f);
      const image = new Uint8Array(this.portCount * this.padBytes);
      const waitingOn = [];
      const byPort = {};
      for (const p of this.occupiedPorts()) {
        const v = this._inputFor(f, p);
        if (v === undefined) { waitingOn.push(p); continue; }
        image.set(v, p * this.padBytes);
        byPort[p] = v;
      }
      if (waitingOn.length) {
        const waitingPeers = waitingOn.map((p) => this.roster[p]).filter((x, i, a) => x && a.indexOf(x) === i);
        if (!this._stalled) {
          this._stalled = true; this._stallSince = this._now(); this.stats.stalls++;
          this._stallOn = waitingPeers;
          this._setState('stalled');
          this._emit('stall', { frame: f, on: true, waitingOn, waitingPeers });
        } else if (this.isHost && this.delay < 30 && !this._peerPace.size &&
                   (this._now() - Math.max(this._paceBornAt, this._lsModeAt || 0)) > this.paceWindowMs * 3 &&
                   (this._now() - this._stallSince) > this.delayBumpAfterMs &&
                   (this._now() - (this._lastBumpAt || 0)) > this.delayBumpAfterMs * 2) {
          // ⚠ A STALL IS THE ONLY HONEST MEASUREMENT OF THE PATH. rttReport
          // samples once, at Ready, and the relay's latency is not stable enough
          // for one sample to describe it — the same link measured 101 and
          // 259 ms one way inside a single run. So the room is told what it costs
          // by the thing it costs: if input is still not here after the current
          // delay has plainly been outrun, the delay was too small, and the host
          // raises it for everyone at an agreed frame.
          //
          // ⚠ IT USED TO ONLY GO UP. That is now half the story — see the
          // step-down in _maybeGiveDelayBack(). The hazard named here is real
          // (lowering while peers queue for the old target) and is solved by
          // choosing the frame rather than by never lowering. Raising stays
          // AGGRESSIVE and lowering is one frame at a time, so the pair settles
          // instead of oscillating: the cost of too small is a room that stops,
          // so it is bought back slowly and given up instantly.
          this._lastBumpAt = this._now();
          this._lastStallAt = this._now();
          this._scheduleDelay(Math.min(30, this.delay + Math.max(2, this.delay >> 1)));
        } else if (this._stallBudget() > 0 && (this._now() - this._stallSince) > this._stallBudget()) {
          // Only a page that set a budget explicitly; the default is 0 and a
          // silent player is dropped by the host instead (_silentPeers).
          this.fail('no input from ' + (this._labels(waitingPeers) || ('port ' + waitingOn.map((p) => p + 1).join(','))) +
                    ' for ' + Math.round((this._now() - this._stallSince) / 1000) + 's');
        }
        this._maybeNak(f);
        this._capFillAsk(f);
        return { ready: false, frame: f, reason: 'stall', waitingOn, waitingPeers };
      }
      if (this._stalled) {
        const d = this._now() - this._stallSince;
        this._stalled = false; this._stallSince = 0;
        this.stats.stallMs += d;
        if (d > this.stats.maxStallMs) this.stats.maxStallMs = d;
        // WHO the time was spent waiting on — every peer this console lacked an
        // input from when the stall began. In a four-player room this is what
        // names the one slow player or slow link.
        for (const pid of (this._stallOn || [])) this._stallByPeer.set(pid, (this._stallByPeer.get(pid) || 0) + d);
        this._stallOn = null;
        this._setState('running');
        // The calm window is measured from the END of the last stall, so a room
        // that stalls every few seconds never buys anything back.
        this._lastStallAt = this._now();
        this._leadReset();
        this._emit('resume', { frame: f, ms: d });
      }
      // ⚠ ONLY ON A FRAME THAT WAS READY. This is the definition of a healthy
      // link — every seated port's input was here when it was needed — and it is
      // the only place the room has earned the right to give a frame of lag back.
      this._maybeGiveDelayBack();
      // Slack: how many further frames are already fully covered. This is the
      // number that says whether `delay` is big enough for this link — a run
      // whose minimum is 0 was living on the edge and any jitter is a stall.
      let lead = 0;
      while (this._covered(f + lead + 1)) lead++;
      this.stats.leadSamples++; this.stats.leadSum += lead;
      this._leadNote(lead);
      if (lead < this.stats.minLead) this.stats.minLead = lead;
      if (!(opt && opt.hidden)) this._lsTickRan++;
      return { ready: true, frame: f, image, pads: byPort, waitingOn: [], waitingPeers: [] };
    }
    // ⚠ THE CADENCE A SWITCH LEAVES BEHIND. A page credits frames off the wall
    // clock and runs every credited frame in one display tick; a tick that ran
    // k frames takes k frames of work, so the next tick comes k vsyncs later
    // with k frames of credit — and k frames per tick holds itself forever,
    // for ANY k the device can afford. A room that started in delay lockstep
    // sits at k = 1; the stall at a switch (and rollback's re-simulation before
    // it) knocked the slow console into k = 3, where it ran at 1.000x while
    // presenting a third of its ticks (measured: 0.31-0.33 against 0.96 for
    // the same room started in delay). So in a gated delay room a console that
    // is level with its own wall clock runs ONE frame per display tick: the
    // page drops the extra credit (a frame it may never bank, gate 9), the
    // next tick comes one vsync later, and the cadence is k = 1 again. A
    // console that has fallen behind its own clock (a device that cannot do
    // one frame per vsync) is never held. The tick is what rbCatchUp() marks:
    // a page that does not call it every tick is never held.
    _lsCadenceHold() {
      if (!this._lsTickMark || this._lsTickRan < 1) return false;
      const now = this._now(), F = this._frameMs();
      if (!this._lsCadAt || this._stalled) { this._lsCadAt = now; this._lsCadBase = this.frame; return false; }
      const expected = this._lsCadBase + (now - this._lsCadAt) / F;
      if (this.frame < expected - 1) return false;               // behind its own clock: let it run
      if (this.frame > expected + 2) { this._lsCadAt = now; this._lsCadBase = this.frame; }
      this.stats.cadenceHolds = (this.stats.cadenceHolds | 0) + 1;
      return true;
    }

    // =========================================================================
    // ROLLBACK — ZERO LOCAL INPUT LAG (opt-in: opts.rollback / 'lsgo' rb = W).
    //
    // User requirement: "there need to be ZERO input lag". Delay-based lockstep
    // cannot give that: it applies EVERY input, the player's own included,
    // `delay` frames late (floor 2), because frame F may only run once every
    // port's input for F is in hand. Rollback runs F at once instead:
    //   * the local pad sampled for F is applied TO F — zero frames late;
    //   * a remote port whose input for F has not arrived is PREDICTED as its
    //     last real input (repeat-last);
    //   * the PAGE keeps a savestate of every frame's start (the engine is
    //     core-free and never touches one);
    //   * when a real input lands for a frame already run and differs from what
    //     that frame used, beginFrame hands the page a re-simulation plan: load
    //     the start of the earliest wrong frame and re-run up to the present,
    //     WITHOUT PRESENTING, then run the present frame.
    //
    // ⚠ WHAT ROLLBACK CANNOT DO. The remote input still arrives only as fast
    // as the network carries it — one-way latency plus a frame of sampling. A
    // prediction hides that wait; a misprediction shows up as the remote
    // player's action being corrected a few frames after it happened (the
    // re-simulated frames). Only the LOCAL player's lag goes to zero.
    //
    // ⚠ THE GUEST RATE (CLAUDE.md gate 9). A re-simulation is catch-up of
    // frames the guest ALREADY lived through once on a guess: it does not
    // advance the guest clock past wall time. After it, exactly one NEW frame
    // (the present one) runs per credit of the page's 1.000x accumulator —
    // the same pacing as lockstep. The engine only ever WITHHOLDS frames (the
    // window cap, the advantage wait), never adds any.
    //
    // ⚠ FINGERPRINTS COMPARE CONFIRMED FRAMES ONLY. A frame run on a guess may
    // be re-run, so its state is not final. The engine queues a hash frame k
    // only once every port's REAL input for every frame <= k is in hand and
    // was the input the (re-)simulation used (_rbConfirm); the page hashes its
    // saved state after k and calls submitHash(k) — the same wire message and
    // the same comparison as lockstep.
    //
    // THE WINDOW. The engine never runs frame F while F - (last frame with all
    // real inputs) > W, so a rollback is never deeper than W and the page's
    // ring of W+2 (+margin) savestates always holds the frame it must load.
    //
    // THE ADVANTAGE WAIT. Two consoles that started a few frames apart see each
    // other's input with asymmetric lateness, so the one ahead would roll back
    // far more than the one behind. Every 'ls' carries `a` = sender frame minus
    // the newest remote input it holds; the side whose `a` exceeds its peer's
    // by >= 2 skips ONE frame (at most one per RB_ADV_EVERY). Skipping is
    // slowing down — the one direction gate 9 allows — and it happens BEFORE
    // the local pad is sampled, so it adds no lag to any input.
    // =========================================================================
    _rbReset() {
      this._rbFrom = Infinity;       // earliest frame that must be re-simulated
      this._rbUsed = new Map();      // frame -> the image that frame last ran on
      this._rbInputsTo = -1;         // every port has a REAL input for every frame <= this
      this._rbConfirmed = -1;        // ...and it was simulated on exactly those inputs
      this._rbHashQ = [];            // confirmed hash frames waiting for the page
      this._rbPeerAdv = new Map();   // peer -> its last reported advantage
      this._rbPeerAdvAvg = new Map(); // peer -> exponential mean of what it reported
      this._rbMyAdvAvg = null;        // exponential mean of this console's own advantage
      this._rbNewestRemote = -1;     // newest frame any remote input arrived for
      this._rbAdvNext = 0;           // no advantage wait before this frame
      // ---- the room clock (see the block above rbCatchUp) -----------------
      this._rbNewestBy = new Array(ROLLBACK_PORTS_MAX).fill(-1);  // port -> newest frame received from it
      this._rbAdvBy = new Array(ROLLBACK_PORTS_MAX).fill(null);   // port -> smoothed (my frame - newest from it)
      this._rbPeerAv = new Map();    // peer -> { av: [its smoothed advantage per port], at }
      this._rbLate = [];             // lateness samples: my frame when a remote input arrived, minus its frame
      this._rbLateAt = 0;            // ...where the next sample goes (a ring of RB_LATE_KEEP)
      this._rbLateIn = [];           // the same, remote INPUTS only (an ack's lateness is a round trip)
      this._rbLateInAt = 0;
      // ---- a mode switch in flight (capacity gating) ------------------------
      // While a console queues its own pad AHEAD of the frame it runs (moving
      // to delay lockstep, or draining the delay queue after coming back), the
      // newest frame received from it is not where it is. Each such 'ls'
      // carries its sender's present frame (`q`); `_rbLeadBy[port]` is the
      // lead it implies, and the room clock (catch-up, rejoin, the advantage
      // wait) stands still while any lead is non-zero (_rbTransit).
      this._rbLeadBy = new Array(ROLLBACK_PORTS_MAX).fill(0);
      this._rbLeadF = new Array(ROLLBACK_PORTS_MAX).fill(-1);
      this._rbAtBy = new Array(ROLLBACK_PORTS_MAX).fill(-1);    // the newest present frame each port's owner named ('ls' q)
      this._rbDrainTo = -1;          // this console drains its delay queue through this frame
      this._rbReportAt = 0;          // when this console last reported ('lsrb') / the host last decided
      this._rbStallsAt = 0;          // rbStats.windowStalls at the last report
      this._rbPeerRb = new Map();    // host: peer -> its last 'lsrb' { lp, lx, st, ws, at }
      this._rbShrink = 0;            // host: consecutive reports that asked for a smaller window
      this._rbCatchUpLeft = 0;       // hidden frames granted by the last rbCatchUp() not yet run
      this._rbOwed = 0;              // frames still owed from the last latency-shaped catch-up decision
      this._rbSettleUntil = 0;       // no new latency-shaped decision before this time (its effect is in flight)
      this._rbAheadSince = 0;        // when this console first led a peer that is not closing the gap
      this._rbPaceNow = 1;           // the credit multiplier last handed to the page
      this._rbPendingW = null;       // { at, w } — a window change agreed for a future frame
      this._rbWinPeak = this.rollback; // the largest window this room has run (the page's ring)
      this._rbHoleAt = 0;            // when the input frontier first sat behind a newer arrival
      this._rbHoleNakAt = 0;         // last hole NAK sent
      this._rbRejoinAt = 0;          // guest: last 'lsrejoin' sent
      this._rbFillAt = 0;            // guest: last 'lsfillq' sent
      this._rbFillGone = false;      // guest: the host no longer holds the input this console needs
      this._rbPortTo = new Array(ROLLBACK_PORTS_MAX).fill(-1); // host: contiguous input frontier per port
      this._rbAck = null;            // guest: the host's last acknowledged frontier per port ('ls' ak)
      this._rbRejoinMode = false;    // this console is a rejoin-sized gap behind (rbRejoining)
      this.rbStats = { predictedFrames: 0, mispredicted: 0, rollbacks: 0, resimFrames: 0,
                       maxDepth: 0, depthSum: 0, windowStalls: 0, advantageWaits: 0,
                       hashesQueued: 0, lateArrivals: 0,
                       catchUpFrames: 0, catchUps: 0, pacedTicks: 0, windowChanges: 0,
                       fills: 0, fillFrames: 0, silentDrops: 0, rejoins: 0, holeNaks: 0 };
    }
    _rbAdvanceInputs() {
      while (this._covered(this._rbInputsTo + 1)) this._rbInputsTo++;
    }
    _rbPredict(k, port) {
      const lo = Math.max(0, k - LS_KEEP);
      for (let j = k - 1; j >= lo; j--) {
        const v = this._inputFor(j, port);
        if (v !== undefined) return v;
      }
      return this.neutral;
    }
    // The image frame k runs on: real inputs where they exist, predictions
    // where they do not. Recomputed at re-simulation, so a correction that
    // arrived for k-3 also re-predicts k-2..k from it.
    _rbImage(k) {
      const image = new Uint8Array(this.portCount * this.padBytes);
      const pads = {};
      let predicted = false;
      for (const p of this.occupiedPorts()) {
        let v = this._inputFor(k, p);
        if (v === undefined) { v = this._rbPredict(k, p); predicted = true; }
        image.set(v, p * this.padBytes);
        pads[p] = v;
      }
      return { image, pads, predicted };
    }
    // `noLate`: a refill ('lsfill') — it says how long this console was away,
    // not how late the room's inputs travel, so it is not a lateness sample.
    _rbArrived(f, port, bytes, noLate) {
      const remote = this.localPorts.indexOf(port) < 0;
      if (f > this._rbNewestRemote && remote) this._rbNewestRemote = f;
      if (port < ROLLBACK_PORTS_MAX && f > this._rbNewestBy[port]) this._rbNewestBy[port] = f;
      // HOW LATE THE ROOM'S INPUT REACHES THIS CONSOLE, in frames: the frame it
      // is about to run minus the frame the input is for. The window must cover
      // this (a frame runs only while it is within `rollback` of the newest
      // frame every port is known for), so it is what the host sizes it from.
      if (remote && !noLate) {
        const late = this.frame - f;
        if (this._rbLate.length < RB_LATE_KEEP) this._rbLate.push(late);
        else { this._rbLate[this._rbLateAt] = late; this._rbLateAt = (this._rbLateAt + 1) % RB_LATE_KEEP; }
        if (this._rbLateIn.length < RB_LATE_KEEP) this._rbLateIn.push(late);
        else { this._rbLateIn[this._rbLateInAt] = late; this._rbLateInAt = (this._rbLateInAt + 1) % RB_LATE_KEEP; }
      }
      if (f >= this.frame) return;               // not run yet: it will simply be used
      this.rbStats.lateArrivals++;
      const used = this._rbUsed.get(f);
      if (!used) return;                          // older than the history: nothing ran on it here
      const o = port * this.padBytes;
      let same = true;
      for (let i = 0; i < this.padBytes; i++) if ((used[o + i] | 0) !== ((bytes[i] | 0))) { same = false; break; }
      if (same) return;
      this.rbStats.mispredicted++;
      if (f < this._rbFrom) this._rbFrom = f;
    }
    _rbStall(f, why) {
      // Same bookkeeping as the lockstep stall, minus the delay bump: rollback
      // has no delay to raise. waitingOn names the ports the window is short of.
      const need = this._rbInputsTo + 1;
      const waitingOn = [];
      for (const p of this.occupiedPorts()) if (this._inputFor(need, p) === undefined) waitingOn.push(p);
      const waitingPeers = waitingOn.map((p) => this.roster[p]).filter((x, i, a) => x && a.indexOf(x) === i);
      if (!this._stalled) {
        this._stalled = true; this._stallSince = this._now(); this.stats.stalls++;
        this._stallOn = waitingPeers;
        this.rbStats.windowStalls++;
        this._setState('stalled');
        this._emit('stall', { frame: f, on: true, waitingOn, waitingPeers, why, who: this._labels(waitingPeers) });
      } else if (this._stallBudget() > 0 && (this._now() - this._stallSince) > this._stallBudget()) {
        // ⚠ ONLY A PAGE THAT ASKED FOR IT (stallBudgetMs > 0). A silent peer is
        // the HOST's to drop (_silentPeers) and the room plays on; failing the
        // whole room here is what a phone's backgrounded tab used to cost.
        this.fail('no input from ' + (this._labels(waitingPeers) || ('port ' + waitingOn.map((p) => p + 1).join(','))) +
                  ' for ' + Math.round((this._now() - this._stallSince) / 1000) + 's');
      }
      this._maybeNak(need);
      this._capFillAsk(need);
      return { ready: false, frame: f, reason: 'stall', waitingOn, waitingPeers };
    }
    // A CAPACITY-GATED ROOM: a console stalled this long on an input nobody
    // answered a NAK for asks the HOST's store ('lsfillq') — the input may be
    // older than its sender still caches (a console away across a mode switch
    // misses a stretch the sender has long since moved past).
    _capFillAsk(need) {
      if (!this._capGate || this.isHost || !this._stalled) return;
      const now = this._now();
      if (now - this._stallSince < 4 * NAK_AFTER_MS || now - this._rbFillAt < RB_REPORT_MS) return;
      this._rbFillAt = now;
      this._send({ t: 'lsfillq', f: need, peer: this.peerId });
    }
    // THIS CONSOLE'S PAD, sampled for frame f, goes to frame f + dIn (0 in a
    // rollback room; the coming delay while the room switches to delay
    // lockstep). The frames a raised lead skips hold the last pad, for this
    // console's own ports only, and are sent like any input — the same fill
    // _applyPendingDelay makes. A frame already on the wire is never re-sent
    // (a room just back from delay lockstep drains the queue it had built).
    _rbPutLocal(f, pads, myAdv, dIn) {
      this._scheduledTo = f + 1;
      const target = f + Math.max(0, dIn | 0);
      if (target <= this._queuedTo) return;
      if (!this._lastLocal) this._lastLocal = {};
      for (let t = this._queuedTo + 1; t < target; t++) {
        const fill = [];
        for (const p of this.localPorts) {
          const b = this._lastLocal[p] || this.neutral;
          this._put(t, p, b);
          fill.push([p, b64enc(b)]);
        }
        if (fill.length) this._sendInputs(t, fill);
      }
      const items = [];
      for (const p of this.localPorts) {
        const bytes = this._coerce(pads, p);
        this._put(target, p, bytes);
        this._lastLocal[p] = bytes;
        items.push([p, b64enc(bytes)]);
      }
      this._queuedTo = target;
      if (items.length) this._sendInputs(target, items, this._rbWireExtra(myAdv));
      this._rbAdvanceInputs();
    }
    // True while an input for some frame <= f is still missing — this
    // console's own pad for f excepted on its first attempt (it is put then).
    _rbModeHold(f, first) {
      this._rbAdvanceInputs();
      const ports = this.occupiedPorts();
      for (let k = this._rbInputsTo + 1; k <= f; k++) {
        for (const p of ports) {
          if (this._inputFor(k, p) !== undefined) continue;
          if (k === f && first && this.localPorts.indexOf(p) >= 0) continue;
          return true;
        }
      }
      return false;
    }
    // `opt.hidden`: this frame is one of the hidden catch-up frames rbCatchUp()
    // granted (the page runs it without presenting it). See rbCatchUp.
    _beginFrameRb(pads, opt) {
      const f = this.frame;
      const now = this._now();
      // ---- 0. the room's housekeeping: reports, the window, silent peers,
      // rejoining. Runs on EVERY attempt, stalled or not, because a stalled
      // console's report is also its heartbeat.
      this._rbTick(now);
      if (this.state !== 'running' && this.state !== 'stalled') {
        return { ready: false, frame: f, reason: this.state, waitingOn: [], waitingPeers: [] };
      }
      const pw = this._rbPendingW;
      if (pw && f >= pw.at) { this._rbPendingW = null; this._rbSetWindowNow(pw.w); }
      this._rbAdvanceInputs();
      this._rbHoleCheck(now);
      // ---- 1. the window: never run a frame a rollback could not reach back from
      if (f - this._rbFront() > this.rollback) return this._rbStall(f, 'window');
      const first = this._scheduledTo <= f;
      // ---- 1b. A SWITCH TO DELAY LOCKSTEP AT FRAME S (capacity gating). From the
      // moment this console knows, its own pad goes `d` frames ahead (the delay
      // the room will run — so the delay frames' inputs are on the wire before
      // they are needed), and frame S-1 runs on REAL inputs only, its
      // re-simulation included: at S every frame before it is final on every
      // console, and S runs as a plain delay-lockstep frame everywhere.
      const mn = this._modeNext, toLs = !!(mn && mn.m === 0);
      if (toLs && f >= mn.at - 1 && this._rbModeHold(f, first)) {
        if (first) this._rbPutLocal(f, pads, f - this._rbNewestRemote, mn.d);
        return this._rbStall(f, 'mode');
      }
      if (this._stalled) {
        const d = now - this._stallSince;
        this._stalled = false; this._stallSince = 0;
        this.stats.stallMs += d;
        if (d > this.stats.maxStallMs) this.stats.maxStallMs = d;
        for (const pid of (this._stallOn || [])) this._stallByPeer.set(pid, (this._stallByPeer.get(pid) || 0) + d);
        this._stallOn = null;
        this._setState('running');
        this._emit('resume', { frame: f, ms: d });
      }
      const hidden = !!(opt && opt.hidden);
      // ---- 2. the advantage — BEFORE sampling, so no input pays for a wait
      const myAdv = f - this._rbNewestRemote;
      // ⚠ AVERAGED, NOT INSTANTANEOUS. Both samples jitter by a frame or two with
      // nothing wrong: each console runs 0, 1 or 2 frames per display tick, and a
      // peer's reported advantage is one link-latency old. Compared raw, the
      // difference crossed 2 on BOTH consoles ~1.4 times a second in a room
      // where neither was ahead — measured with tools/netplay_device_matrix.mjs,
      // Genesis, two desktop players: 81 and 84 advantage waits in 60 s, zero
      // stalls, and every wait a frame the page may never give back (gate #9),
      // so the room ran at 0.979x (/tmp/npdm/gen-a-fix1). An exponential mean
      // over ~16 frames still sees a console that is REALLY ahead (a persistent
      // lead moves the mean within a quarter-second) and ignores the jitter.
      if (this._rbNewestRemote >= 0) {
        this._rbMyAdvAvg = (this._rbMyAdvAvg == null) ? myAdv : this._rbMyAdvAvg + (myAdv - this._rbMyAdvAvg) / RB_ADV_SMOOTH;
      }
      const transit = this._capGate && this._rbTransit();
      if (first && !transit) {
        // PER PORT, once per frame: what the room clock is read from (rbCatchUp).
        // A hidden frame moves this console one frame further than the wall
        // clock did — a known, exact shift — so it moves the means with it,
        // instead of leaving them to discover it over 16 frames and read the
        // catch-up as a lag that is still there.
        for (const p of this.occupiedPorts()) {
          if (p >= ROLLBACK_PORTS_MAX || this.localPorts.indexOf(p) >= 0) continue;
          const nb = this._rbNewestBy[p];
          if (nb < 0) continue;
          if (hidden && this._rbAdvBy[p] != null) this._rbAdvBy[p] += 1;
          const a = f - nb, prev = this._rbAdvBy[p];
          this._rbAdvBy[p] = prev == null ? a : prev + (a - prev) / RB_ADV_SMOOTH;
        }
      }
      // THE WHOLE-FRAME ADVANTAGE WAIT survives only in a room that is NOT
      // adaptive — one where some console's page cannot run catch-up frames
      // (n64/index.html today). In an adaptive room the console BEHIND catches
      // up instead (rbCatchUp), and the one ahead never waits.
      if (!this._rbAdaptive && !transit && this._rbNewestRemote >= 0 && this._rbPeerAdv.size && f >= this._rbAdvNext && first) {
        let theirs = Infinity;
        for (const a of this._rbPeerAdvAvg.values()) if (a < theirs) theirs = a;
        if (this._rbMyAdvAvg - theirs >= 2) {
          this._rbAdvNext = f + RB_ADV_EVERY;
          this.rbStats.advantageWaits++;
          return { ready: false, frame: f, reason: 'advantage', waitingOn: [], waitingPeers: [] };
        }
      }
      // ---- 3. this machine's pad FOR THIS FRAME — no delay (see 1b for the one exception)
      if (first) this._rbPutLocal(f, pads, myAdv, toLs ? mn.d : 0);
      // ---- 4. the re-simulation plan, if a late input contradicted a guess
      let rollback = null;
      if (this._rbFrom < f) {
        const from = this._rbFrom;
        const depth = f - from;
        // ⚠ THE RING HOLDS THE LARGEST WINDOW THIS ROOM HAS RUN, not the
        // current one: a window that shrank leaves frames run under the old
        // one, and they may still be corrected.
        const reach = Math.max(this.rollback, this._rbWinPeak) + 1;
        if (depth > reach) {
          const mine = this.localPorts.some((p) => this.dropped.has(p));
          this.fail(mine
            ? 'this console ran ' + depth + ' frames past the point where the room took its controller while its link was down — '
              + 'more than it keeps (' + reach + '), so it cannot rewind to rejoin; leave the party and join again'
            : 'rollback of ' + depth + ' frames is deeper than the window (' + reach + ')');
          return { ready: false, frame: f, reason: 'failed', waitingOn: [], waitingPeers: [] };
        }
        const n = depth;
        const frames = [];
        for (let k = from; k < from + n; k++) {
          const r = this._rbImage(k);
          this._rbUsed.set(k, r.image);
          frames.push({ frame: k, image: r.image, pads: r.pads });
        }
        this.rbStats.rollbacks++; this.rbStats.resimFrames += n; this.rbStats.depthSum += depth;
        // (none during the warm-up: CAP_WARM_MS)
        if (!this._capWarmUntil || this._now() >= this._capWarmUntil) {
          if (this._capDepths.length < CAP_DEPTHS) this._capDepths.push(depth);
          else { this._capDepths[this._capDepthAt] = depth; this._capDepthAt = (this._capDepthAt + 1) % CAP_DEPTHS; }
        }
        if (depth > this.rbStats.maxDepth) this.rbStats.maxDepth = depth;
        rollback = { from, depth, frames };
      }
      this._rbFrom = Infinity;
      // ---- 5. the present frame
      const cur = this._rbImage(f);
      this._rbUsed.set(f, cur.image);
      if (cur.predicted) this.rbStats.predictedFrames++;
      if (hidden) this.rbStats.catchUpFrames++;
      this._rbRanAny = true;
      return { ready: true, frame: f, image: cur.image, pads: cur.pads, rollback, predicted: cur.predicted, hidden,
               waitingOn: [], waitingPeers: [] };
    }

    // =========================================================================
    // THE ADAPTIVE ROOM — THE WINDOW, THE ROOM CLOCK, AND A PLAYER WHO COMES BACK.
    //
    // Measured before this existed (tools/netplay_device_matrix.mjs, Genesis,
    // RB_WINDOW 8): 0.76x at 100 ms one way (120 window stalls) and 0.85x over
    // the relay (393). tools/netplay_rb_pace_sim.mjs reproduces the shape with
    // no browser: 0.987x at 2p/100 ms, 0.729x at 2p/150 ms, 0.528x at 4p/100 ms
    // (guest-to-guest input takes two hops through the host). Two causes, and
    // neither is fixed by input delay, which the product forbids (zero input
    // lag is the point of rollback):
    //
    //   1. A FIXED WINDOW. A frame runs only while it is within `rollback` of
    //      the newest frame every port is known for. At 60 Hz, 100 ms one way
    //      is 6 frames before a frame of sampling phase and the jitter; 150 ms
    //      two hops is 18. Eight covers neither.
    //   2. A GUEST THAT STARTED LATE STAYS LATE. It hears 'lsgo' one latency
    //      after the host starts, so for the rest of the room the host saw its
    //      inputs 2L late and it saw the host's on time — the host's rollbacks
    //      were twice as deep as they needed to be, and the old cure (the host
    //      skipping whole frames until they met) is a frame the player sees
    //      missing, every time.
    //
    // THE CURE, IN THREE PARTS — none of them delays a single input:
    //
    //   THE WINDOW IS MEASURED, NOT CHOSEN. Every console records how late each
    //   remote input reaches it (the frame it is about to run minus the frame
    //   the input is for — exactly the quantity the window must cover) and
    //   reports the 99th percentile to the host every RB_REPORT_MS ('lsrb').
    //   The host sets window = that + 1 + slack (Lockstep.recommendWindow;
    //   slack shrinks when the slowest console's re-simulation step is too
    //   expensive to afford it), grows it at once and shrinks it one frame at a
    //   time after RB_SHRINK_VOTES calm reports ('lsrbw', effective at a named
    //   frame). The window is pure local pacing — it changes WHEN a console
    //   runs a frame, never WHAT the frame computes — so a console that applies
    //   a change a frame late cannot fork.
    //
    //   THE ROOM CLOCK. The room runs at the pace of whoever is furthest along;
    //   nobody runs faster than 1.000x, so that console is never ahead of real
    //   time. A console that is BEHIND it — it started late, it hitched, a tab
    //   stalled, a hole in its input was just filled — CATCHES UP by running
    //   hidden frames (rbCatchUp: the page runs them without presenting them
    //   and drops their audio, as it does a re-simulation), using at most half
    //   a frame of its own measured step time per display tick. How far behind
    //   it is comes from two measurements:
    //     * EXACT: every other console has already sampled the newest frame this
    //       one holds all their inputs for, so anything up to it is behind.
    //     * LATENCY-SHAPED: GGPO's frame advantage, per peer. A = my frame minus
    //       the newest frame I hold from you; you report yours of me in every
    //       'ls' (`av`). (theirs - mine) / 2 is how far I trail you, and
    //       theirs + mine is the round trip in frames. It is acted on once per
    //       round trip plus two smoothing spans, because half its effect is
    //       only visible after the peer's reply.
    //   The console AHEAD is never made to skip a frame for advantage (the old
    //   whole-frame advantage wait is gone from adaptive rooms) and is never
    //   slowed: rbPace() is always 1 (a 0.98-0.99x version was a visible
    //   sustained slowdown on a room with a phone). It still WINDOW-STALLS when
    //   a peer's inputs are later than the window covers — counted in
    //   rbStats.windowStalls, and followed by its own catch-up. A catch-up of
    //   fewer than RB_REJOIN_GAP frames is at most one hidden frame per display
    //   tick; a bigger one (a player coming back) is shown as a held picture
    //   and "rejoining" (rbRejoining), never as fast-forwarded play.
    //
    //   THE GUEST RATE (gate 9). A console's frame count never passes the room
    //   clock: catch-up only ever runs frames the room has already run, or is
    //   running now; hidden frames are presented as a skip, not as a sprint;
    //   and a console that fell behind because EVERYONE stalled (the leader
    //   included) owes nothing, because nobody is ahead of it.
    //   tools/netplay_rb_pace_sim.mjs asserts, on every console: never more
    //   than 1.5 frames past (now - host start) x 60; never more CREDITED
    //   (presented) frames than its own wall clock allowed, +2; and no 5 s
    //   window of presented frames above 1.02x (the device matrix's bar — a
    //   hiccup's frames repaid in the next tick can put a window a few frames
    //   over without ever running ahead of wall time).
    //
    // ⚠ ONLY IN AN ADAPTIVE ROOM. The host makes a room adaptive only if every
    // seated console declared opts.rbCatchUp in its 'lsready' (the page can run
    // hidden frames AND grows its ring to rbRingFrames()), and says so in
    // 'lsgo' (rba). Anything else runs the fixed window and the whole-frame
    // advantage wait exactly as before.
    //
    // A PLAYER WHO GOES SILENT, AND COMES BACK. See _silentPeers and
    // _rbGuestRejoin: the host drops a silent player's controller at an agreed
    // frame (it goes limp; the room plays on), and when the page returns it is
    // refilled from the host's input store ('lsfillq'/'lsfill', RB_KEEP_INPUTS
    // frames), re-simulates itself up to the room as hidden frames, asks back
    // in ('lsrejoin'), and the host hands its controller back at a future frame
    // ('lsundrop').
    // =========================================================================

    // PAGE: how many hidden catch-up frames to run NOW, before this tick's
    // credited frames. Each is an ordinary beginFrame(pads, { hidden: true }) /
    // run / endFrame, presented to nobody, its audio dropped.
    rbCatchUp() {
      if (!this.rollback) return this._lsCatchUp();
      if (!this._rbAdaptive) return 0;
      if (this.state !== 'running' && this.state !== 'stalled') return 0;
      if (this._capGate && this._rbTransit()) { this._rbOwed = 0; return 0; }
      const f = this.frame, now = this._now();
      this._rbAdvanceInputs();
      // A. EXACT: frames every other console has already sampled.
      let solid = Infinity, others = 0;
      for (const p of this.occupiedPorts()) {
        if (p >= ROLLBACK_PORTS_MAX || this.localPorts.indexOf(p) >= 0 || this.dropped.has(p)) continue;
        others++;
        if (this._rbNewestBy[p] < solid) solid = this._rbNewestBy[p];
      }
      if (!others) return 0;                 // nobody to keep up with
      // Up to `solid` - 1 hidden, so that this tick's credited frame IS `solid`:
      // level with the slowest of the others, never past anyone. (Running
      // `solid` itself hidden let two consoles leapfrog each other by a tick's
      // phase on a fast link, each "catching up" to the other, and the whole
      // room ratcheted ahead of real time — tools/netplay_rb_pace_sim.mjs
      // rb-4p-0ms: 76 frames past the room clock in 60 s.)
      // ⚠ AND A GAP OF ONE FRAME IS PHASE, NOT LAG: two consoles whose display
      // ticks interleave see each other one frame "ahead" in turn, and each
      // catching that up walked the pair ahead of real time (rb-2p-0ms: 2.5
      // frames past the room clock in 60 s). Outside a rejoin, stop one short.
      let want = solid > f ? solid - f : 0;
      if (!this._rbRejoinMode) want = Math.max(0, want - 1);
      // B. LATENCY-SHAPED: the advantage exchange. Not while this console's own
      // controller is limp — the room ignores its inputs then, so the peers'
      // view of it goes stale and would read as an ever-growing lag.
      const myLimp = this.localPorts.some((p) => this.dropped.has(p));
      if (!myLimp && now >= this._rbSettleUntil) {
        const s = this._rbSyncNow(now);
        if (s.n && s.lag >= 1.5) {
          this._rbOwed = Math.max(this._rbOwed, Math.round(s.lag - 0.5));
          this._rbSettleUntil = now + (Math.max(2, s.rtt) + 2 * RB_ADV_SMOOTH) * this._frameMs();
        }
      }
      want = Math.max(want, this._rbOwed);
      // Never past the window, and never more than half a frame of this
      // console's own time: a phone that has no spare capacity catches up
      // slowly rather than missing its own present frame.
      const room = this._rbFront() + this.rollback - f;
      const step = this.selfStepMs > 0 ? this.selfStepMs : 4;
      const cap = this._rbRejoinMode ? Math.max(1, Math.floor(this._frameMs() * 0.5 / step)) : 1;
      want = Math.max(0, Math.min(want, room, cap));
      // Charged when GRANTED, not when run: a page that stops short (a frame
      // that was not ready) leaves the rest to be re-measured, never owed twice.
      this._rbOwed = Math.max(0, this._rbOwed - want);
      if (want > 0) this.rbStats.catchUps++;
      return want;
    }
    // PAGE: the credit multiplier for this display tick. ALWAYS 1: a console
    // ahead of the room is never slowed (a 0.98-0.99x "fractional wait" was a
    // visible sustained slowdown — measured on 67-83% of ticks in a room with a
    // phone). The console BEHIND catches up instead; one that cannot is a
    // device limit, reported by the pace verdict, not hidden by slowing the
    // others. Kept as a method so a page written against it keeps working.
    rbPace() { this._rbPaceNow = 1; return 1; }
    // PAGE: this console is a REJOIN-sized gap behind the room (it was away) —
    // present nothing, run every frame hidden, and say "rejoining" until it is
    // back. A catch-up that size shown as it runs would be a fast-forward.
    rbRejoining() {
      if (!this.rollback) { this._lsCatchUpGap(); return !!this._rbRejoinMode; }
      if (!this._rbAdaptive || (this.state !== 'running' && this.state !== 'stalled')) return false;
      if (this._capGate && this._rbTransit()) { this._rbRejoinMode = false; return false; }
      const gap = this._rbGap();
      if (this._rbRejoinMode) { if (gap <= 2) this._rbRejoinMode = false; }
      else if (gap >= RB_REJOIN_GAP) this._rbRejoinMode = true;
      return !!this._rbRejoinMode;
    }
    // THE FRONTIER THE WINDOW IS MEASURED FROM. Everywhere: the newest frame every
    // port's input is known for. On a GUEST of an adaptive room, also no later
    // than the frame the HOST has acknowledged holding this console's own input
    // through ('ls' ak) — because that, plus one, is where the host would drop
    // this console's controller if it went silent (dropPeer), and a drop frame
    // further back than the window would be out of the ring's reach: the
    // console would fail instead of going limp. (Measured without it: a 3-5 s
    // link blip at 100 ms failed the guest 5 runs of 5.) It costs the guest a
    // window that covers its own round trip; the host sizes the window from
    // that too (the ack's lateness is one of the guest's samples).
    _rbFront() {
      let f = this._rbInputsTo;
      // A drop/undrop the host has decided and this console has not applied yet
      // (its reliable notice can trail the host's inputs by a retransmission):
      // do not run further than the window past the frame it names, or applying
      // it would reach out of the ring.
      if (!this.isHost && this._rbHostEpoch > this._limpEpoch && typeof this._rbHostEventAt === 'number') {
        f = Math.min(f, this._rbHostEventAt - 1);
      }
      // ...except while a switch to delay lockstep is agreed: the host decides
      // no drop then (and none at all once it runs delay lockstep, where it
      // sends no acknowledgement), so waiting on one would deadlock the room.
      const ackFree = !!(this._modeNext && this._modeNext.m === 0);
      if (ackFree) { /* the frontier alone */ }
      else if (!this.isHost && this._rbAdaptive && this._rbAck) {
        for (const p of this.localPorts) {
          if (this.dropped.has(p) || p >= ROLLBACK_PORTS_MAX) continue;
          const a = this._rbAck[p];
          if (typeof a !== 'number') return Math.min(f, -1);
          if (a < f) f = a;
        }
      } else if (!this.isHost && this._rbAdaptive && this.localPorts.some((p) => !this.dropped.has(p))) f = Math.min(f, -1);
      return f;
    }
    // Frames this console is behind the room by: the inputs every other console
    // has already sampled (exact), or what it still owes.
    _rbGap() {
      let solid = Infinity, others = 0;
      for (const p of this.occupiedPorts()) {
        if (p >= ROLLBACK_PORTS_MAX || this.localPorts.indexOf(p) >= 0 || this.dropped.has(p)) continue;
        others++;
        if (this._rbNewestBy[p] < solid) solid = this._rbNewestBy[p];
      }
      const exact = (others && solid > this.frame) ? solid - this.frame : 0;
      return Math.max(exact, this._rbOwed | 0);
    }
    // PAGE: how many consecutive frame-start savestates the ring must hold
    // BEFORE the next beginFrame — the largest window this room has run or has
    // agreed to run, plus the page's usual margin. It only ever grows.
    rbRingFrames() {
      const pw = this._rbPendingW ? this._rbPendingW.w : 0;
      return Math.max(this.rollback, this._rbWinPeak, pw) + 4;
    }
    _frameMs() { return 1000 / (this.frameHz > 0 ? this.frameHz : 60); }
    // { lag, lead, rtt, n } in frames, from the per-peer advantage exchange.
    _rbSyncNow(now) {
      const out = { lag: 0, lead: 0, rtt: 0, n: 0 };
      const myPort = this.localPorts.length ? this.localPorts[0] : -1;
      if (myPort < 0) return out;
      for (const [peer, rec] of this._rbPeerAv) {
        if (now - rec.at > 1000 || !Array.isArray(rec.av)) continue;
        const pq = this._portsOf(peer)[0];
        if (pq == null || pq >= ROLLBACK_PORTS_MAX || this.dropped.has(pq)) continue;
        const theirs = rec.av[myPort], mine = this._rbAdvBy[pq];
        if (typeof theirs !== 'number' || mine == null) continue;
        const d = (theirs - mine) / 2;
        if (d > out.lag) out.lag = d;
        if (-d > out.lead) out.lead = -d;
        if (theirs + mine > out.rtt) out.rtt = theirs + mine;
        out.n++;
      }
      return out;
    }
    // What rides on every rollback 'ls': the old scalar advantage (an older
    // engine reads only this) and, in an adaptive room, the per-port means the
    // room clock is computed from — plus, from the host, how many drop/undrop
    // decisions it has made, so a guest that missed one notices.
    _rbWireExtra(myAdv) {
      // `a` is read only by the whole-frame advantage wait, which an adaptive
      // room does not run (and by older engines, which never join one).
      const x = this._rbAdaptive ? {} : { a: myAdv };
      // The per-port means move slowly (a 16-frame average); every 4th message
      // is plenty, and each copy is ~20 B.
      if (this.rbCatchUpOn && ((this._avSeq = (this._avSeq | 0) + 1) & 3) === 1) {
        const av = [];
        let last = -1;
        for (let p = 0; p < this.portCount && p < ROLLBACK_PORTS_MAX; p++) {
          const v = (this.roster[p] != null && this.localPorts.indexOf(p) < 0) ? this._rbAdvBy[p] : null;
          av.push(v == null ? null : Math.round(v * 10) / 10);
          if (v != null) last = p;
        }
        if (last >= 0) x.av = av.slice(0, last + 1);
      }
      if (this.isHost && this._limpEpoch) { x.le = this._limpEpoch; x.lf = this._limpEventAt | 0; }
      // THE HOST'S ACKNOWLEDGEMENT, per port: every frame through ak[p] of that
      // port's input is held here (real, or agreed limp). See _rbFront.
      if (this.isHost && this._rbAdaptive && (this._ackForce || ((this._akSeq = (this._akSeq | 0) + 1) & 1))) {
        let hi = -1;
        for (let p = 0; p < this.portCount && p < ROLLBACK_PORTS_MAX; p++) {
          if (this.roster[p] == null || this.localPorts.indexOf(p) >= 0) continue;
          // From this port's OWN frontier — never the room's (_rbInputsTo), which
          // an open limp span carries straight through.
          let k = this._rbPortTo[p];
          // (_ackable stops at the first gap; the bound only has to reach past a
          // closed limp span, whose frames were never stored as inputs.)
          const top = Math.max(this._rbNewestBy[p], this.frame + ROLLBACK_MAX, k);
          // A REAL input, or a frame inside a limp span that has ENDED. Never
          // an OPEN span: the console it belongs to may not know it was dropped
          // yet, and an ack running on through its limp frames would free it to
          // run on past the drop frame it is about to be told about.
          while (k < top && this._ackable(k + 1, p)) k++;
          this._rbPortTo[p] = k; hi = p;
        }
        if (hi >= 0) x.ak = this._rbPortTo.slice(0, hi + 1);
      }
      return x;
    }
    _ackable(k, p) {
      const m = this.inputs.get(k);
      if (m && m.has(p) && !this._isLimp(p, k)) return true;
      const spans = this._limp.get(p);
      if (spans) for (const sp of spans) if (k >= sp[0] && k < sp[1]) return sp[1] !== Infinity;
      return false;
    }
    // GUEST: what the host's 'ls' / 'lsak' says it holds and has decided.
    _rbTakeAck(m) {
      if (this.isHost || !m.peer || m.peer !== this._hostPeer()) return;
      if (typeof m.le === 'number' && m.le > (this._rbHostEpoch | 0)) {
        this._rbHostEpoch = m.le | 0;
        if (typeof m.lf === 'number') this._rbHostEventAt = m.lf | 0;
      }
      if (!this.rollback || !Array.isArray(m.ak)) return;
      if (!this._rbAck) this._rbAck = [];
      for (const p of this.localPorts) {
        const a = m.ak[p];
        if (typeof a !== 'number' || (typeof this._rbAck[p] === 'number' && a <= this._rbAck[p])) continue;
        this._rbAck[p] = a;
        // the ack's lateness is a lateness sample: the window must cover it
        const late = this.frame - a;
        if (this._rbLate.length < RB_LATE_KEEP) this._rbLate.push(late);
        else { this._rbLate[this._rbLateAt] = late; this._rbLateAt = (this._rbLateAt + 1) % RB_LATE_KEEP; }
      }
    }
    // The host's peer id as a guest knows it: the sender of 'lsgo'.
    _hostPeer() { return this._hostId || null; }
    _portsOf(peer) {
      const out = [];
      for (let p = 0; p < this.portCount; p++) if (this.roster[p] === peer) out.push(p);
      return out;
    }
    // Every RB_REPORT_MS: a guest reports (its heartbeat, too); the host drops
    // silent players and re-decides the window; a limp guest works its way back.
    _rbTick(now) {
      if (this._rbReportAt && now - this._rbReportAt < RB_REPORT_MS) return;
      this._rbReportAt = now;
      const late = this._rbLatePct();
      const ws = this.rbStats.windowStalls - this._rbStallsAt;
      this._rbStallsAt = this.rbStats.windowStalls;
      if (this.isHost) {
        this._silentPeers(now);
        // (not while a mode switch is in flight: the frame it names was chosen
        // against the window in force — see _scheduleMode)
        if (this._rbAdaptive && this.state !== 'failed' && !this._modeNext) this._rbDecideWindow(now, late);
        this._capSelfMeasure(now);
        this._capDecide(now);
        // ⚠ THE ACKNOWLEDGEMENT MUST FLOW WHILE THE HOST IS STALLED TOO. It rides
        // every 'ls', and a host waiting on a returning player sends none — while
        // that player waits on the ack to run the frames the host is waiting for
        // (measured: a three-player room frozen for good after a rejoin).
        if (this._rbAdaptive) {
          this._ackForce = true;
          const x = this._rbWireExtra(0);
          this._ackForce = false;
          this._send({ t: 'lsak', peer: this.peerId, ak: x.ak || [], le: x.le, lf: x.lf });
        }
      } else {
        const rb = { t: 'lsrb', peer: this.peerId, lp: late.p99, lx: late.max, n: late.n,
                     st: Math.round((+this.selfStepMs || 0) * 10) / 10, ws, f: this.frame, w: this.rollback };
        if (this.rbMaxWindow > 0) rb.mw = this.rbMaxWindow | 0;
        // capacity gating: steps per frame (1 + re-simulated) and how late the
        // room's INPUTS reach this console (frames, p99) — see _capDecide.
        if (this._capGate) {
          rb.rs = Math.round(this._capSelfMeasure(now) * 100) / 100;
          rb.dp = this._capSelfDp();
          if (this._capSelfCr != null) { rb.cr = Math.round(this._capSelfCr * 10000) / 10000; rb.lt = Math.round(this._capSelfLost() * 10000) / 10000; }
          rb.li = this._rbLateInP99();
        }
        this._send(rb);
        this._rbGuestRejoin(now);
      }
    }
    // How far ahead of the frame it runs a sender queues its pad (see _rbReset).
    _rbNoteLead(m) {
      const lead = typeof m.q === 'number' ? Math.max(0, (m.f | 0) - (m.q | 0)) : 0;
      for (const it of m.i) {
        const p = Array.isArray(it) ? it[0] | 0 : -1;
        if (p < 0 || p >= ROLLBACK_PORTS_MAX || this.roster[p] !== m.peer || m.f < this._rbLeadF[p]) continue;
        this._rbLeadF[p] = m.f | 0; this._rbLeadBy[p] = lead;
        if (typeof m.q === 'number' && (m.q | 0) > this._rbAtBy[p]) this._rbAtBy[p] = m.q | 0;
      }
    }
    // A mode switch is in flight here or at a peer: the newest inputs do not
    // say where the consoles are, so the room clock is not read from them.
    _rbTransit() {
      if ((this._modeNext && this._modeNext.m === 0) || this.frame <= this._rbDrainTo) return true;
      for (const p of this.occupiedPorts()) {
        if (p < ROLLBACK_PORTS_MAX && this.localPorts.indexOf(p) < 0 && this._rbLeadBy[p] > 0) return true;
      }
      return false;
    }
    _rbLateInP99() {
      const a = this._rbLateIn;
      if (!a.length) return null;
      const s = a.slice().sort((x, y) => x - y);
      return s[Math.min(s.length - 1, Math.floor(s.length * 0.99))];
    }
    _rbLatePct() {
      const a = this._rbLate;
      if (!a.length) return { p99: 0, max: 0, n: 0 };
      const s = a.slice().sort((x, y) => x - y);
      return { p99: s[Math.min(s.length - 1, Math.floor(s.length * 0.99))], max: s[s.length - 1], n: s.length };
    }
    // HOST. The window every console will run, from what they all measured.
    _rbDecideWindow(now, own) {
      let late = own.n ? own.p99 : 0, st = +this.selfStepMs || 0, cap = this.rbMaxWindow | 0;
      const capBy = new Map();
      if (cap > 0) capBy.set(this.peerId, cap);
      for (const [pid, r] of this._rbPeerRb) {
        if (now - r.at > RB_REPORT_MS * 4) continue;
        if (this._portsOf(pid).every((p) => this.dropped.has(p))) continue;
        if (r.n) late = Math.max(late, r.lp);
        st = Math.max(st, r.st || 0);
        if (r.mw > 0) { cap = cap > 0 ? Math.min(cap, r.mw) : r.mw; capBy.set(pid, r.mw); }
      }
      // THE DEVICE CAP: never a window deeper than the smallest console's ring
      // can hold. Late inputs beyond it stall (delay-like) instead of failing a
      // console whose memory cannot reach back that far.
      let target = Lockstep.recommendWindow(late, st, this._frameMs());
      // ⚠ A WINDOW CAPPED BELOW WHAT THE PATH NEEDS IS NOT "DELAY-LIKE": every
      // input later than the window stalls the whole room (measured: 0.52-0.54x
      // at 150 ms one way with a 12-frame cap, where the path wants ~28). A
      // capacity-gated room switches to delay lockstep instead (_capDecide).
      this._capWinShort = (cap > 0 && target > Math.max(RB_WINDOW_MIN, cap) + 2)
        ? { need: target, cap, who: [...capBy].filter(([, w]) => w <= cap).map(([pid]) => pid) } : null;
      if (cap > 0 && target > cap) target = Math.max(RB_WINDOW_MIN, cap);
      const cur = this._rbPendingW ? this._rbPendingW.w : this.rollback;
      if (cap > 0 && cur > Math.max(RB_WINDOW_MIN, cap)) {
        // A console's ring shrank under the window the room runs (its page
        // re-measured memory): down to it now, not one frame per vote.
        this._rbShrink = 0;
        this._rbSetWindow(Math.max(RB_WINDOW_MIN, cap), 'a console\'s savestate ring holds only ' + cap + ' frames');
      } else if (target > cur) {
        this._rbShrink = 0;
        this._rbSetWindow(target, 'inputs reach the room up to ' + late + ' frames late');
      } else if (target < cur - 1) {
        if (++this._rbShrink >= RB_SHRINK_VOTES) {
          this._rbShrink = 0;
          this._rbSetWindow(cur - 1, 'the room\'s inputs have arrived within ' + late + ' frames for ' +
                            Math.round(RB_SHRINK_VOTES * RB_REPORT_MS / 1000) + ' s');
        }
      } else this._rbShrink = 0;
    }
    // =========================================================================
    // CAPACITY-GATED ROLLBACK — A ROOM MUST NEVER RUN SLOWER BECAUSE ROLLBACK
    // WAS CHOSEN.
    //
    // Rollback is paid for in the slowest console's time: a savestate every
    // frame plus every re-simulated frame. Measured: a 4x-CPU N64 rollback room
    // ran 0.37x where delay lockstep holds 1.000x, and a phone that measured
    // a 1.27x cap could not afford the re-simulation at all. So the HOST
    // watches what rollback asks of every console — its NEED, the share of its
    // own time it would spend at 1.000x: its step cost (`st`, load + run +
    // save, published by the page) x its steps per room frame (`rs`, 1 + the
    // re-simulated frames, measured) x frames per second; and the display
    // ticks its corrections cost it, charged at the rate they happen (`cr`,
    // `lt`; see CAP_LOST_FULL) — and:
    //   * a console above CAP_HI for CAP_HOT reports in a row — after the
    //     warm-up (CAP_WARM_MS) — switches the room to DELAY LOCKSTEP at an
    //     agreed future frame S, at the delay plain lockstep would run on this
    //     link (_capDelay; the pace machinery raises or gives it back from there);
    //   * the room goes back to rollback only when every console would need at
    //     most CAP_LO, after a calm of _capUpCooldown (doubled, up to
    //     CAP_UP_MAX_MS, each time a return is undone) — and only if every
    //     page can re-arm its savestate ring (opts.rbResume, or it never ran a
    //     rollback frame: every shipped page arms its ring on its first one);
    //   * a room whose console reported, at Ready, a step it cannot afford
    //     STARTS in delay lockstep.
    //
    // ⚠ DESYNC-FREE BY CONSTRUCTION. The mode is part of what a frame computes
    // (genesis.html loads a savestate before every rollback frame, and a load
    // resets state the blob does not carry), so frame S runs in the new mode
    // on EVERY console, never on a guess:
    //   * S is named by the host and carried on every input it sends from the
    //     decision on ('ls' mo) as well as reliably ('lsmode'). A rollback
    //     console can run at most its window past the host's input it holds,
    //     and a lockstep one not past it at all, so S (window + delay + 4
    //     frames out; delay + 2 the other way) cannot be reached unknowing.
    //   * rollback -> delay: from the moment a console knows, its own pad goes
    //     `d` frames ahead (filled like _applyPendingDelay), and S-1 runs on
    //     REAL inputs only — its re-simulation included (_rbModeHold). At S
    //     every frame before it is final everywhere: no rewind can ever reach
    //     back across the switch.
    //   * delay -> rollback: at R every input before R is held (lockstep ran
    //     R-1); the confirmed frontier starts at R-1 and the queued delay
    //     frames drain (_rbPutLocal), so nothing is ever sent twice.
    // No switch is decided while a player is limp, and no drop or rejoin is
    // decided while a switch is in flight.
    // =========================================================================
    // This console's steps per room frame (1 + re-simulated) and corrections
    // per room frame, smoothed over reports. Hidden catch-up frames are room
    // frames.
    _capSelfMeasure(now) {
      // The warm-up measures nothing; the first report after it starts the baseline.
      if (now < this._capWarmUntil) { this._capSelfPrev = null; return this._capSelfRs || 1; }
      const fr = this.stats.frames, rs = this.rbStats.resimFrames, rb = this.rbStats.rollbacks, p = this._capSelfPrev;
      if (!p || now - p.at >= RB_REPORT_MS * 0.9) {
        this._capSelfPrev = { frames: fr, resim: rs, rollbacks: rb, at: now };
        if (p && fr > p.frames && this.rollback) {
          const x = 1 + (rs - p.resim) / (fr - p.frames);
          this._capSelfRs = this._capSelfRs ? this._capSelfRs + (x - this._capSelfRs) / 4 : x;
          const c = Math.max(0, rb - p.rollbacks) / (fr - p.frames);
          this._capSelfCr = this._capSelfCr != null ? this._capSelfCr + (c - this._capSelfCr) / 4 : c;
        }
      }
      return this._capSelfRs || 1;
    }
    // p90 of this console's recent rollback depths (0 = none yet).
    _capSelfDp() {
      const a = this._capDepths;
      if (!a.length) return 0;
      const s = a.slice().sort((x, y) => x - y);
      return s[Math.min(s.length - 1, Math.floor(s.length * 0.9))];
    }
    // The display ticks one correction of `d` frames misses on a console whose
    // step costs `st`: whole ticks, because a page presents on a display tick —
    // a hold of 2.1 ticks costs it 2 presents, not 1.1.
    _capMissed(st, d) { return Math.max(0, Math.ceil(st * (Math.max(0, d) + 1) / this._frameMs() - 1e-9) - 1); }
    // LOST for this console: corrections per frame x the ticks its last
    // CAP_DEPTHS corrections missed on average, at its current step (null =
    // corrections not measured yet).
    _capSelfLost() {
      const cr = this._capSelfCr, a = this._capDepths, st = +this.selfStepMs || 0;
      if (cr == null) return null;
      if (!a.length || !(st > 0)) return 0;
      let m = 0;
      for (const d of a) m += this._capMissed(st, d);
      return cr * m / a.length;
    }
    // THE NEED (see CAP_HI .. CAP_BURST_MAX_TICKS), the largest of: the share
    // of a console's time rollback asks of it at 1.000x (step x steps per
    // frame); the display ticks its corrections cost it (`lt` as the console
    // measured it, else `cr` corrections per frame each missing what a p90-deep
    // one does) against CAP_LOST_FULL; and one p90-deep correction against
    // CAP_BURST_MAX_TICKS. A step over half a frame, or neither `lt` nor `cr`
    // (a console on an older engine): the old bar, one correction over
    // CAP_BURST_TICKS.
    _capNeedOf(st, rs, dp, cr, lt) {
      const F = this._frameMs();
      const mean = st * Math.max(1, rs || 1) / F, u = st * (Math.max(0, dp || 0) + 1) / F;
      const lost = typeof lt === 'number' && lt >= 0 ? lt : typeof cr === 'number' && cr >= 0 ? cr * this._capMissed(st, dp || 0) : null;
      if (lost == null || 2 * st > F) return Math.max(mean, u / CAP_BURST_TICKS);
      return Math.max(mean, lost / CAP_LOST_FULL, u / CAP_BURST_MAX_TICKS);
    }
    // HOST: every console's latest capacity report, this one included.
    _capRows(now) {
      const fresh = this.rollback ? RB_REPORT_MS * 4 : this.paceWindowMs * 3;
      const lob = (pid) => this.lobby.get(pid) || {};
      const rows = [{ peer: this.peerId, st: +this.selfStepMs || 0, rs: this._capSelfRs || 1, dp: this._capSelfDp(),
                      cr: this._capSelfCr != null ? this._capSelfCr : 0, lt: this._capSelfLost(),
                      rr: this._rbRanAny, rz: this.rbResume || !!lob(this.peerId).rz }];
      for (const pid of this.expectedPeers()) {
        const r = this._capPeer.get(pid);
        if (!r || now - r.at > fresh || (this.rollback ? !r.mode : r.mode)) continue;
        if (this._portsOf(pid).every((p) => this.dropped.has(p))) continue;
        rows.push({ peer: pid, st: r.st, rs: r.rs || 1, dp: r.dp || 0, cr: r.cr, lt: r.lt, li: r.li, rr: r.rr, rz: !!lob(pid).rz });
      }
      return rows;
    }
    // HOST, every report: is rollback still affordable — or, in a delay room,
    // affordable again?
    _capDecide(now) {
      if (!this.isHost || !this._capGate || this._modeNext) return;
      if (this.state !== 'running' && this.state !== 'stalled') return;
      if (this.dropped.size || this._pendingDelay) { this._capHot = 0; this._capCalmSince = 0; return; }
      const rows = this._capRows(now);
      if (this.rollback) {
        let worst = 0;
        const slow = [];
        // THE WARM-UP (CAP_WARM_MS): what the start of a rollback stretch asks of
        // a console — the steps per frame and the depth of the corrections while
        // the window is still growing — is not what the room asks of it, so no
        // decision rides on it. The step itself is judged, at the steps per frame
        // assumed for a console never measured (CAP_RS_START): a console whose
        // step alone is unaffordable is not a transient, and every report it runs
        // rollback the room trails it further.
        const warm = !this._capEager && now < this._capWarmUntil;
        for (const r of rows) {
          if (!(r.st > 0)) continue;
          const need = warm ? r.st * CAP_RS_START / this._frameMs() : this._capNeedOf(r.st, r.rs, r.dp, r.cr, r.lt);
          if (need > worst) worst = need;
          if (need > CAP_HI) slow.push(r.peer);
        }
        this._capNeed = +worst.toFixed(3);
        // A console whose savestate ring cannot reach back as far as the path
        // needs (rbMaxWindow): the same switch, for memory instead of time.
        const mem = !slow.length && this._capWinShort ? this._capWinShort : null;
        if (mem) for (const pid of mem.who) slow.push(pid);
        if (!slow.length) { this._capHot = 0; return; }
        // EAGER: a console already said at Ready that it cannot afford this —
        // the first decision with a second of the path measured is enough.
        const hot = (this._capEager && this.stats.frames >= 60) ? 1 : CAP_HOT;
        if (++this._capHot < hot) return;
        if (now - this._paceBornAt < CAP_SETTLE_MS) { this._capHot = hot - 1; return; }
        this._capEager = false;
        this._capHot = 0;
        // A return to rollback that did not last: the next one waits twice as long.
        if (this._capUpAt && now - this._capUpAt < this._capUpCooldown + 30000) {
          this._capUpCooldown = Math.min(CAP_UP_MAX_MS, this._capUpCooldown * 2);
        }
        this._capDownAt = now; this._capCalmSince = 0;
        const d = this._capDelay(rows);
        this._capFloor = this._capWireFloor();
        const wmax = Math.max(this.rollback, this._rbWinPeak, this._rbPendingW ? this._rbPendingW.w : 0);
        if (mem) this._capMemDown = true;
        this._scheduleMode(0, this.frame + wmax + d + 4, d, this.rollback, slow,
          mem ? this._labels(slow) + ' can hold ' + mem.cap + ' frames of savestates; this connection needs ' + mem.need + ' for zero-lag (rollback) mode'
              : this._capWhy(slow, worst), mem ? 1 : 0);
        return;
      }
      // DELAY -> ROLLBACK: every seated console reported, every one can afford
      // it with room to spare, and every page can re-arm its ring.
      const seated = this.expectedPeers().length + 1;
      let worst = 0, known = 0, resumable = true;
      for (const r of rows) {
        if (!(r.st > 0)) continue;
        known++;
        if (r.rr && !r.rz) resumable = false;
        // As measured the last time this console ran rollback; never measured:
        // the steps assumed at the start, and a correction as deep as the
        // delay the link needs now.
        const self = r.peer === this.peerId;
        const rs = Math.max(CAP_RS_START, (self ? this._capSelfRs : this._capRs.get(r.peer)) || 0);
        // A correction is about as deep as inputs are late, which the delay the
        // room needs now measures; depths recorded while a slow console dragged
        // the room are deeper than that, so the smaller of the two.
        const dpl = self ? (this._capDepths.length ? this._capSelfDp() : null) : this._capDp.get(r.peer);
        // ...and corrections as often as it had them then (never measured: the
        // old, frequency-blind bar).
        const cr = self ? this._capSelfCr : this._capCr.get(r.peer);
        const need = this._capNeedOf(r.st, rs, Math.min(dpl != null ? dpl : this.delay, this.delay), cr != null ? cr : undefined);
        if (need > worst) worst = need;
      }
      this._capNeed = known ? +worst.toFixed(3) : null;
      // (a room that left rollback because a console's ring could not reach
      // back far enough stays in delay: nothing in delay lockstep re-measures it)
      if (known < seated || !resumable || worst > CAP_LO || this._capMemDown) { this._capCalmSince = 0; return; }
      if (!this._capCalmSince) { this._capCalmSince = now; return; }
      if (now - this._capCalmSince < this._capUpCooldown || now - this._capDownAt < this._capUpCooldown) return;
      this._capUpAt = now; this._capCalmSince = 0;
      this._scheduleMode(1, this.frame + this.delay + 2, 0, this._capW || 8, [],
        'every console can afford zero-lag (rollback) mode again (the slowest needs ' + Math.round(worst * 100) + '% of its time)');
    }
    // THE DELAY THE ROOM SWITCHES TO — NEVER MORE THAN PLAIN LOCKSTEP WOULD RUN.
    // When the page measured the link before Ready (rttDelay: its RTT pings,
    // Lockstep.recommendDelayForRoom — the delay a lockstep room on this link
    // starts at), exactly that. The lockstep pace machinery raises it on a
    // link-shaped stall and gives it back when calm, exactly as in a room that
    // started in delay.
    // ⚠ IT USED TO BE SIZED FROM INPUT LATENESS, AND IN A ROLLBACK ROOM THAT IS NOT
    // THE LINK: it includes how far the slowest console trails the room, up to
    // the window — and the console that cannot afford rollback is exactly the one
    // that trails. Measured (N64 MK64, 2 players, 40-100 ms one way,
    // n64/docs/rollback-default/RESULTS.md cause 1): at every gated switch the
    // wire read 5-6 frames, the trailing console's lateness p99 14-16, and the
    // switch went to 9-17 where a lockstep room on the same link starts at 6 —
    // up to twice the input lag, walked down by a third per 5 s of calm.
    // A page that measured nothing still gets that sizing (below): how late the
    // room's INPUTS reach each console (frames, p99 — two hops for a guest's
    // view of another guest), as a robust budget over this console's own samples
    // (Lockstep.rttBudget) and each other console's p99, plus the frame the
    // input is queued for, never below the wire's longest path plus this
    // console's own jitter. At least 2. (The wire alone under-reads a 4-player
    // star whose slow console is far behind: tools/netplay_rb_capacity_test.mjs
    // switch-both-ways-4p and window-cap fail on it.)
    _capDelay(rows) {
      if (this.rttDelay > 0) return Math.max(1, Math.min(30, this.rttDelay | 0));
      const F = this._frameMs();
      let d = 2;
      if (this._rbLateIn.length) {
        const b = Lockstep.rttBudget(this._rbLateIn.map((l) => Math.max(0, 2 * l * F)));
        if (b != null) d = Math.max(d, Lockstep.recommendDelay(b, F));
      }
      for (const r of rows || []) if (r.peer !== this.peerId && typeof r.li === 'number') d = Math.max(d, Math.ceil(Math.max(0, r.li)) + 1);
      const wire = this._capWireFloor();
      if (wire != null) {
        let spread = 1;
        if (this._rbLateIn.length >= 8) {
          const s = this._rbLateIn.slice().sort((x, y) => x - y);
          spread = Math.max(1, Math.ceil(s[Math.min(s.length - 1, Math.floor(s.length * 0.99))] - s[s.length >> 1]));
        }
        d = Math.max(d, wire + spread);
      }
      if (this.netFloorDelay > 0) d = Math.max(d, this.netFloorDelay | 0);
      return Math.max(2, Math.min(30, d));
    }
    // THE WIRE'S FLOOR for that delay, free of how far a slow console trails:
    // the round trip in frames to each guest from the advantage exchange (a
    // guest's view of this console plus this console's of it — the offsets
    // cancel), the longest one-way path of the star (guest -> host -> guest)
    // plus the frame the input is queued for. null = not measured (a room that
    // is not adaptive exchanges no per-port advantage).
    _capWireFloor() {
      const myPort = this.localPorts.length ? this.localPorts[0] : -1;
      if (myPort < 0) return null;
      const now = this._now(), rtts = [];
      for (const [peer, rec] of this._rbPeerAv) {
        if (now - rec.at > 2000 || !Array.isArray(rec.av)) continue;
        const pq = this._portsOf(peer)[0];
        if (pq == null || pq >= ROLLBACK_PORTS_MAX) continue;
        const theirs = rec.av[myPort], mine = this._rbAdvBy[pq];
        if (typeof theirs === 'number' && mine != null) rtts.push(Math.max(0, theirs + mine));
      }
      if (!rtts.length) return null;
      rtts.sort((a, b) => b - a);
      const oneWay = rtts.length > 1 ? (rtts[0] + rtts[1]) / 2 : rtts[0] / 2;
      return Math.max(2, Math.min(30, Math.ceil(oneWay) + 1));
    }
    // HOST: name the frame and tell the room — reliably, and on every input it
    // sends until the room is well past it (_moStamp).
    _scheduleMode(m, at, d, w, who, why, kind) {
      const e = this._modeEpoch + 1;
      this._modeNext = { e, at, m, d, w, who: (who || []).slice(), why: why || null, kind: kind | 0 };
      this._moWire = [e, at, m, d, w, (who || []).slice(), kind | 0];
      this._send({ t: 'lsmode', mo: this._moWire, why: why || null, peer: this.peerId });
    }
    // GUEST: the host's word — from the host only, and only a switch newer than
    // the last one applied.
    _takeMode(mo, why, from) {
      if (this.isHost || !this._capGate) return;
      if (from && this._hostPeer() && from !== this._hostPeer()) return;
      const e = mo[0] | 0;
      if (!(e > this._modeEpoch) || (this._modeNext && this._modeNext.e >= e)) return;
      this._modeNext = { e, at: mo[1] | 0, m: mo[2] ? 1 : 0, d: Math.max(1, Math.min(30, mo[3] | 0)),
                         w: Math.max(1, Math.min(ROLLBACK_MAX, mo[4] | 0 || this._capW || 8)),
                         who: Array.isArray(mo[5]) ? mo[5].slice() : [], why: why || null, kind: mo[6] | 0 };
    }
    // EVERY CONSOLE, at the agreed frame (beginFrame, before anything else).
    _applyMode() {
      const mn = this._modeNext, f = this.frame;
      this._modeNext = null;
      if (!mn) return true;
      const now = this._now();
      if (mn.m === 0) {
        if (!this.rollback) { this._modeEpoch = mn.e; return true; }
        if (f !== mn.at || this._rbInputsTo < f - 1 || this._rbFrom < f) {
          this.fail('the room switched to input delay at frame ' + mn.at + ', and this console reached frame ' + f +
                    ' without every input before it — it cannot follow the switch; leave the party and join again');
          return false;
        }
        this._capW = Math.max(1, this.rollback);
        this.rollback = 0; this._rbAdaptive = false;
        this._lsHostSeenF = f; this._lsCadAt = 0;
        this.delay = Math.max(1, Math.min(30, mn.d | 0));
        // A console that learned of the switch too late to move its pad ahead
        // (it never does in practice: S is far enough out) fills the gap here.
        const last = this._lastLocal || {};
        for (let t = this._queuedTo + 1; t < f + this.delay; t++) {
          const fill = [];
          for (const p of this.localPorts) { const b = last[p] || this.neutral; this._put(t, p, b); fill.push([p, b64enc(b)]); }
          if (fill.length) this._sendInputs(t, fill);
          this._queuedTo = t;
        }
        if (this._scheduledTo > f) this._scheduledTo = f;
        this._pendingDelay = null;
        // The pace machinery starts fresh. The floor is the WIRE's (or 2) and
        // never above the floor a lockstep room on this link gets (netFloorDelay,
        // begin()): the give-back (_maybeGiveDelayBack, on measured slack) may
        // walk the delay down exactly as far as it would there.
        this._paceWinOpen = false; this._paceHot = 0; this._lsModeAt = now;
        this._lastBumpAt = now; this._leadReset();
        // ⚠ THE CALM IS NOT RESTARTED BY THE SWITCH. At the RTT-chosen delay
        // (rttDelay) the room is exactly where a lockstep room on this link was
        // at its start, and that room's give-back calm runs from its start (or
        // its last stall). Restarted here, a gated room held the start delay for
        // as long as it had run rollback first — measured (N64 MK64, 2 players,
        // 40-100 ms, the worker core slowed 4x, switch at frame 56): +0.04 to
        // +0.24 frames of input lag over 30 s against lockstep on the same link,
        // in every pair. Without a measured link (rttDelay 0) the switch's delay
        // is a guess from lateness, and the calm starts at the switch, as before.
        this._lastStallAt = this.rttDelay > 0 ? Math.min(now, Math.max(this._paceBornAt || now, this._lastStallAt || 0)) : now;
        const wire = this.isHost ? this._capFloor : null;
        this._delayFloor = Math.max(2, Math.min(this.delay, wire != null ? wire : this.delay));
        if (this.netFloorDelay > 0) this._delayFloor = Math.max(2, Math.min(this._delayFloor, this.netFloorDelay | 0));
        this._modeEpoch = mn.e;
        this._modeNote(0, this.delay, this._capW, mn.why, mn.who, mn.kind);
        return true;
      }
      if (this.rollback) { this._modeEpoch = mn.e; return true; }
      if (f !== mn.at) {
        this.fail('the room switched back to zero-lag mode at frame ' + mn.at + ', and this console reached frame ' + f +
                  ' first — it cannot follow the switch; leave the party and join again');
        return false;
      }
      const dPrev = this.delay | 0;
      this.rollback = Math.max(1, Math.min(ROLLBACK_MAX, mn.w | 0 || this._capW || 8));
      this._rbAdaptive = this._capAdaptive;
      this.delay = 0;
      this._pendingDelay = null;
      this._rbResumeAt(f);
      this._rbDrainTo = Math.max(this._queuedTo, f - 1 + dPrev);
      this._modeEpoch = mn.e;
      this._modeNote(1, 0, this.rollback, mn.why, mn.who);
      return true;
    }
    // Rollback bookkeeping for a room that ran delay lockstep up to frame f-1:
    // every input before f is held and final.
    _rbResumeAt(f) {
      this._rbFrom = Infinity; this._rbUsed = new Map(); this._rbHashQ = [];
      this._rbInputsTo = f - 1; this._rbAdvanceInputs(); this._rbConfirmed = f - 1;
      this._rbPeerAdv.clear(); this._rbPeerAdvAvg.clear(); this._rbMyAdvAvg = null; this._rbAdvNext = f;
      this._rbAdvBy.fill(null); this._rbPeerAv.clear();
      this._rbLate = []; this._rbLateAt = 0; this._rbLateIn = []; this._rbLateInAt = 0;
      this._rbOwed = 0; this._rbSettleUntil = 0; this._rbAheadSince = 0; this._rbPendingW = null; this._rbShrink = 0;
      this._rbHoleAt = 0; this._rbRejoinMode = false; this._rbCatchUpLeft = 0;
      this._rbWinPeak = Math.max(this._rbWinPeak, this.rollback);
      this._rbNewestBy.fill(-1); this._rbNewestRemote = -1;
      for (const [k, mp] of this.inputs) for (const p of mp.keys()) {
        if (p < ROLLBACK_PORTS_MAX && k > this._rbNewestBy[p]) this._rbNewestBy[p] = k;
        if (this.localPorts.indexOf(p) < 0 && k > this._rbNewestRemote) this._rbNewestRemote = k;
      }
      // The host's acknowledgement starts where the room is (it ran f-1, so it
      // holds every input before f); a guest's view of it likewise. A stale
      // pre-switch value would hold every guest's window shut.
      if (this.isHost) { for (let p = 0; p < ROLLBACK_PORTS_MAX; p++) this._rbPortTo[p] = Math.max(this._rbPortTo[p], f - 1); }
      else {
        if (!this._rbAck) this._rbAck = [];
        for (const p of this.localPorts) this._rbAck[p] = Math.max(typeof this._rbAck[p] === 'number' ? this._rbAck[p] : -1, f - 1);
      }
      this._rbReportAt = 0; this._rbStallsAt = this.rbStats.windowStalls;
      this._capSelfPrev = null;
      // A return to rollback is a start like any other: it warms up (CAP_WARM_MS),
      // and what this console measures from here describes this stretch, not
      // the one that ended in the switch to delay.
      this._capWarmUntil = this._now() + CAP_WARM_MS;
      this._capDepths = []; this._capDepthAt = 0; this._capSelfRs = 0; this._capSelfCr = null;
    }
    // Every console records the switch and tells its page, in a sentence a
    // player can read.
    _modeNote(to, delay, w, why, who, kind) {
      const peers = (who || []).filter((x) => x != null);
      const mine = peers.indexOf(this.peerId) >= 0;
      const fm = this._frameMs();
      let text;
      if (to) text = 'every device has the headroom for zero-lag mode again — input delay is off';
      else if (kind === 1) text = (mine ? 'this device' : peers.length ? this._labels(peers) + '\'s device' : 'a device in the room') +
                                  ' cannot keep enough savestates for zero-lag mode on this connection; using input delay (' + delay + ' frames, ' +
                                  Math.round(delay * fm) + ' ms) to keep full speed';
      else if (mine) text = 'this device is too slow for zero-lag mode; using input delay (' + delay + ' frames, ' +
                            Math.round(delay * fm) + ' ms) to keep full speed';
      else text = (peers.length ? this._labels(peers) + (peers.length > 1 ? '\'s devices are' : '\'s device is') : 'a device in the room is') +
                  ' too slow for zero-lag mode; using input delay (' + delay + ' frames, ' + Math.round(delay * fm) + ' ms) to keep full speed';
      const rec = { frame: this.frame, to: to ? 'rollback' : 'delay', delay: delay, window: w, why: why || null, kind: kind === 1 ? 'memory' : 'time',
                    slow: peers.map((p) => this.labelOf(p)), mine: mine, text: text };
      this.modeHistory.push(rec);
      if (this.modeHistory.length > 32) this.modeHistory.splice(0, this.modeHistory.length - 32);
      this._emit('mode', rec);
    }
    _capWhy(peers, need) {
      const n = (peers || []).length;
      return this._labels(peers) + (n > 1 ? ' need' : ' needs') + (need > 0 ? ' ' + Math.round(need * 100) + '% of ' + (n > 1 ? 'their' : 'its') + ' time' : ' more time than it has')
        + ' for zero-lag (rollback) mode';
    }
    // A summary for report() and the page.
    modeReport() {
      return { mode: this.rollback ? 'rollback' : 'delay', gated: !!this._capGate, epoch: this._modeEpoch,
               pending: this._modeNext ? { at: this._modeNext.at, to: this._modeNext.m ? 'rollback' : 'delay', delay: this._modeNext.d } : null,
               need: this._capNeed == null ? null : this._capNeed, returnAfterMs: this._capUpCooldown,
               window: this._capW || null, history: this.modeHistory.slice(-8) };
    }
    _rbSetWindow(w, why) {
      w = Math.max(RB_WINDOW_MIN, Math.min(ROLLBACK_MAX, w | 0));
      const at = this.frame + 1;
      this._rbPendingW = { at, w };
      if (w > this._rbWinPeak) this._rbWinPeak = w;
      this._send({ t: 'lsrbw', w, at, why: why || null });
      this._emit('window', { from: this.rollback, to: w, at, why: why || null });
    }
    _rbSetWindowNow(w) {
      w = Math.max(1, Math.min(ROLLBACK_MAX, w | 0));
      if (w === this.rollback) return;
      this.rbStats.windowChanges++;
      this.rollback = w;
      if (w > this._rbWinPeak) this._rbWinPeak = w;
    }
    // A HOLE is an input missing at the confirmed frontier while a LATER frame
    // from the same port has already arrived — lost, not late. Ask for it at
    // once instead of waiting for the window to run out: first from whoever
    // sent it ('lsnak', answered from its cache of recent frames), and if that
    // cannot fill it (an old hole — a link that was down), from the host's
    // store ('lsfillq').
    _rbHoleCheck(now) {
      const need = this._rbInputsTo + 1;
      let gap = 0;
      for (const p of this.occupiedPorts()) {
        if (p >= ROLLBACK_PORTS_MAX || this.localPorts.indexOf(p) >= 0) continue;
        if (this._inputFor(need, p) !== undefined) continue;
        const g = this._rbNewestBy[p] - need;
        if (g > gap) gap = g;
      }
      if (gap <= 0) { this._rbHoleAt = 0; return; }
      if (!this._rbHoleAt) this._rbHoleAt = now;
      const age = now - this._rbHoleAt;
      const old = gap > 48 || age >= 4 * NAK_AFTER_MS;
      if (!old && age >= NAK_AFTER_MS / 3 && now - this._rbHoleNakAt >= NAK_AFTER_MS) {
        this._rbHoleNakAt = now; this.rbStats.holeNaks++;
        this._send({ t: 'lsnak', f: need, peer: this.peerId });
      }
      if (old && !this.isHost && now - this._rbFillAt >= RB_REPORT_MS) {
        this._rbFillAt = now;
        this._send({ t: 'lsfillq', f: need, peer: this.peerId });
      }
    }
    // A room that can take a silent player BACK: an adaptive rollback room, or
    // a capacity-gated room whose rollback room was adaptive and which the gate
    // has moved to delay lockstep. ⚠ Before this, the switch to delay turned
    // drop/rejoin off: one player away for more than 8 s failed the whole room
    // for everyone ("no input from player 3 for 8s", 0.11x), where the same
    // room without the gate played on at 0.93x and took them back.
    _dropRoom() {
      return this.rollback ? !!this._rbAdaptive : !!(this._capGate && this._capAdaptive);
    }
    // DELAY LOCKSTEP IN A GATED ROOM, every RB_REPORT_MS: the host drops a
    // silent player (_silentPeers, the same rule as rollback); a dropped guest
    // that is back asks for the host's table, catches up (rbCatchUp, hidden)
    // and asks back in ('lsrejoin'); the host names a future frame (rejoinPeer).
    _lsDropTick(now) {
      if (this.state !== 'running' && this.state !== 'stalled') return;
      if (this._rbReportAt && now - this._rbReportAt < RB_REPORT_MS) return;
      this._rbReportAt = now;
      if (this.isHost) { this._silentPeers(now); return; }
      if (!this._dropRoom() || this._rbFillGone) return;
      if (this._rbHostEpoch > this._limpEpoch && now - this._rbFillAt >= RB_REPORT_MS) {
        this._rbFillAt = now;
        this._send({ t: 'lsfillq', f: this.frame, peer: this.peerId });
      }
      if (!this.localPorts.some((p) => this.dropped.has(p))) return;
      const gap = this._lsCatchUpGap();
      if (gap != null && gap <= 2 && now - this._rbRejoinAt >= 1000) {
        this._rbRejoinAt = now;
        this._send({ t: 'lsrejoin', peer: this.peerId, f: this.frame });
      }
    }
    // GUEST, DELAY LOCKSTEP IN A GATED ROOM: never run a frame the host may
    // already have made limp for this console. The host drops a silent player
    // at one past the last input it holds from them (dropPeer), and that input
    // runs `delay` frames ahead of the frame this console runs — so a console
    // that has run fewer than `delay` frames since it last heard the host
    // cannot be past the drop frame. Past that it waits for the host, and while
    // the host has made a drop/undrop this console has not applied (its 'ls'
    // carries the host's count, `le`) it waits for the host's table ('lsfill').
    // Without this a console whose link died ran on to the end of the host's
    // queued input on its own pad, while the room ran those frames neutral.
    _lsResyncHold() {
      if (this.isHost || this.rollback || !this._dropRoom() || this._rbFillGone) return null;
      const f = this.frame, now = this._now();
      const behindTable = (this._rbHostEpoch | 0) > (this._limpEpoch | 0);
      const quiet = f - this._lsHostSeenF >= Math.max(2, (this.delay | 0) - 1);
      if (!behindTable && !quiet) return null;
      if (behindTable && now - this._rbFillAt >= RB_REPORT_MS) {
        this._rbFillAt = now;
        this._send({ t: 'lsfillq', f, peer: this.peerId });
      }
      const host = this._hostPeer();
      const waitingOn = this._portsOf(host);
      if (!this._stalled) {
        this._stalled = true; this._stallSince = now; this.stats.stalls++;
        this._stallOn = host ? [host] : [];
        this._setState('stalled');
        this._emit('stall', { frame: f, on: true, waitingOn, waitingPeers: this._stallOn.slice() });
      } else if (this._stallBudget() > 0 && now - this._stallSince > this._stallBudget()) {
        this.fail('nothing heard from the host for ' + Math.round((now - this._stallSince) / 1000) + 's');
      }
      this.stats.resyncHolds = (this.stats.resyncHolds | 0) + 1;
      return { ready: false, frame: f, reason: 'stall', waitingOn, waitingPeers: this._stallOn.slice() };
    }
    // How far behind the room this console is in DELAY lockstep: the slowest
    // other live console's present frame (each 'ls' names it, `q`) minus ours.
    // Sets the rejoin mode (hidden catch-up) for a console whose own controller
    // is limp and that is a rejoin-sized gap behind; null = not known yet.
    _lsCatchUpGap() {
      if (!this._dropRoom() || (this.state !== 'running' && this.state !== 'stalled')) { this._rbRejoinMode = false; return null; }
      let solid = Infinity, others = 0;
      for (const p of this.occupiedPorts()) {
        if (p >= ROLLBACK_PORTS_MAX || this.localPorts.indexOf(p) >= 0 || this.dropped.has(p)) continue;
        others++;
        if (this._rbAtBy[p] < solid) solid = this._rbAtBy[p];
      }
      if (!others || solid < 0) { this._rbRejoinMode = false; return null; }
      const gap = solid - this.frame;
      const myLimp = this.localPorts.some((p) => this.dropped.has(p));
      if (this._rbRejoinMode) { if (gap <= 2 || !myLimp) this._rbRejoinMode = false; }
      else if (myLimp && gap >= RB_REJOIN_GAP) this._rbRejoinMode = true;
      return gap;
    }
    // DELAY LOCKSTEP: hidden catch-up frames for a returning console only (a
    // delay room never otherwise runs ahead of its credit): up to one short of
    // the room, half a frame of this console's time per tick.
    _lsCatchUp() {
      // (called once per display tick: the tick _lsCadenceHold counts frames in)
      if (this._capGate) { this._lsTickMark = true; this._lsTickRan = 0; }
      const gap = this._lsCatchUpGap();
      if (!this._rbRejoinMode || gap == null || gap <= 1) return 0;
      // A rejoining console presents nothing, so it may spend up to a whole
      // frame of its time on hidden frames each tick (at least two: a slow
      // device must still gain on the room).
      const step = this.selfStepMs > 0 ? this.selfStepMs : 4;
      const cap = Math.max(2, Math.floor(this._frameMs() / step));
      return Math.max(0, Math.min(gap - 1, cap));
    }
    _stallBudget() {
      if (this.stallBudgetMs != null) return this.stallBudgetMs;
      if (this._dropRoom()) return this.isHost ? 0 : 30000;
      return 8000;
    }
    // HOST. A player the host has heard NOTHING from for dropAfterMs is not
    // "late" — its page has stopped (a backgrounded tab, a dead link). Its
    // controller goes limp at an agreed frame (dropPeer) and the room plays on.
    _silentPeers(now) {
      // ⚠ ONLY IN AN ADAPTIVE ROLLBACK ROOM: the only room whose players can be
      // taken BACK (refill, catch-up, lsrejoin) and whose every page declared it
      // can. Anywhere else a drop is for good, so a room keeps the bounded stall
      // failure it always had (_stallBudget) rather than silently shedding a
      // player — or a cached older page that has no way back at all.
      // (...or a capacity-gated room the gate moved to delay lockstep: see
      // _dropRoom — it takes its players back the same way.)
      if (!this.isHost || !this._dropRoom()) return;
      // Not while a mode switch is in flight: a drop frame must stay where every
      // console can still re-simulate it (the switch freezes frames before it).
      if (this._modeNext) return;
      const bar = this.dropAfterMs != null ? this.dropAfterMs
        : (this.rollback || this.expectedPeers().length >= 2 ? RB_DROP_AFTER_MS : LS_DROP_AFTER_MS);
      if (!(bar > 0)) return;
      // ⚠ THE HOST'S OWN ABSENCE IS NOT THEIR SILENCE. A host whose tab was in
      // the background ran no ticks and read no messages; everyone it "has not
      // heard from" is simply unread. Any gap in the host's own ticks restarts
      // every clock (measured without this: a host away 4 s dropped all three
      // healthy guests of a four-player room).
      const gap = this._silentTickAt ? now - this._silentTickAt : 0;
      this._silentTickAt = now;
      if (gap > RB_REPORT_MS * 2) { for (const pid of this._heardAt.keys()) this._heardAt.set(pid, now); return; }
      const live = [], silent = [];
      for (const pid of this.expectedPeers()) {
        const ports = this._portsOf(pid);
        if (!ports.length || ports.every((p) => this.dropped.has(p))) continue;
        const at = this._heardAt.get(pid);
        if (at == null) { this._heardAt.set(pid, now); live.push(pid); continue; }
        (now - at > bar ? silent : live).push(pid);
      }
      // ⚠ WHEN EVERY OTHER PLAYER GOES QUIET AT ONCE, THE LIKELY CAUSE IS THE
      // HOST'S OWN LINK. With three or more players that is told apart and
      // nobody is dropped. With two it cannot be: the guest is dropped, and
      // because a guest never runs further than the window past the input the
      // host has acknowledged from it (see _rbOwnAck), the drop frame is always
      // within its reach — it goes limp, is refilled and comes back; it does
      // not fail.
      if (!silent.length || (silent.length > 1 && !live.length)) return;
      for (const pid of silent) {
        const at = this._heardAt.get(pid);
        this.stats.silentDrops = (this.stats.silentDrops || 0) + 1;
        this.rbStats.silentDrops++;
        this.dropPeer(pid, 'nothing heard from them for ' + (Math.round((now - at) / 100) / 10) + ' s');
      }
    }
    // GUEST. This console's controller is limp (the host dropped it while it
    // was away). Once it holds the room's inputs up to where the room is, ask
    // back in; the host names the frame its controller comes back at.
    _rbGuestRejoin(now) {
      if (!this.rollback || this._rbFillGone) return;
      // A drop/undrop the host made that this console never heard (its link
      // was down when it went out): ask for the host's table with a refill.
      if (this._rbHostEpoch > this._limpEpoch && now - this._rbFillAt >= RB_REPORT_MS) {
        this._rbFillAt = now;
        this._send({ t: 'lsfillq', f: this._rbInputsTo + 1, peer: this.peerId });
      }
      const mine = this.localPorts.filter((p) => this.dropped.has(p));
      if (!mine.length) return;
      let solid = Infinity, others = 0;
      for (const p of this.occupiedPorts()) {
        if (p >= ROLLBACK_PORTS_MAX || this.localPorts.indexOf(p) >= 0 || this.dropped.has(p)) continue;
        others++;
        if (this._rbNewestBy[p] < solid) solid = this._rbNewestBy[p];
      }
      if (!others) return;
      const behind = solid >= this.frame ? solid - this.frame + 1 : 0;
      if (behind <= 2 && this.frame - this._rbFront() <= this.rollback && now - this._rbRejoinAt >= 1000) {
        this._rbRejoinAt = now;
        this._send({ t: 'lsrejoin', peer: this.peerId, f: this.frame });
      }
    }
    // HOST: the input store a returning player is refilled from. Everything
    // held from `from` on, for every port but the asker's own (it holds those,
    // and from its drop they are limp), in messages under RB_FILL_BYTES, plus
    // the whole limp table so a player who missed a drop learns it.
    _rbServeFill(peer, from) {
      const limp = this._limpTable();
      let lo = Infinity, hi = -1;
      for (const k of this.inputs.keys()) { if (k < lo) lo = k; if (k > hi) hi = k; }
      if (from < lo && lo !== Infinity && from < this.frame - LS_KEEP) {
        this._send({ t: 'lsfill', to: peer, gone: 1, lo, limp, e: this._limpEpoch });
        return;
      }
      const theirs = this._portsOf(peer);
      let chunk = [], bytes = 0, sent = 0, first = from;
      for (let k = Math.max(0, from); k <= hi && sent < 8; k++) {
        const m = this.inputs.get(k);
        const items = [];
        if (m) for (const [p, v] of m) {
          if (theirs.indexOf(p) >= 0 || (this._limp.size && this._isLimp(p, k))) continue;
          items.push([p, b64enc(v)]);
        }
        if (!items.length) continue;
        chunk.push([k, items]);
        bytes += 12 + items.length * (8 + Math.ceil(this.padBytes / 3) * 4);
        if (bytes >= RB_FILL_BYTES) {
          this._send({ t: 'lsfill', to: peer, from: first, i: chunk, limp, e: this._limpEpoch });
          sent++; chunk = []; bytes = 0; first = k + 1;
        }
      }
      if (chunk.length || !sent) this._send({ t: 'lsfill', to: peer, from: first, i: chunk, limp, e: this._limpEpoch });
      this.rbStats.fills++;
    }
    _limpTable() {
      const t = [];
      for (const [p, spans] of this._limp) for (const s of spans) t.push([p, s[0], s[1] === Infinity ? null : s[1]]);
      return t;
    }
    // GUEST: bring this console's limp spans in line with the host's table.
    // Spans only ever append (a port is dropped, then maybe taken back, then
    // maybe dropped again), so the host's list extends ours.
    _applyLimpTable(table, epoch) {
      const byPort = new Map();
      for (const e of table) {
        if (!Array.isArray(e)) continue;
        const p = e[0] | 0;
        if (!byPort.has(p)) byPort.set(p, []);
        byPort.get(p).push([e[1] | 0, e[2] == null ? Infinity : (e[2] | 0)]);
      }
      for (const [p, hs] of byPort) {
        hs.sort((a, b) => a[0] - b[0]);
        const mine = this._limp.get(p) || [];
        for (let i = 0; i < hs.length; i++) {
          const h = hs[i], m = mine[i];
          if (!m) {
            this._applyDrop([p], h[0], this.roster[p] || null, 'while this console was away', true);
            if (h[1] !== Infinity) this._applyUndrop([p], h[1], this.roster[p] || null, true);
          } else if (m[1] === Infinity && h[1] !== Infinity) {
            this._applyUndrop([p], h[1], this.roster[p] || null, true);
          }
        }
      }
      if (typeof epoch === 'number' && epoch > this._limpEpoch) this._limpEpoch = epoch;
    }
    // THE HOST'S RELAY MUST NOT CARRY WHAT THE ROOM HAS AGREED IS LIMP.
    // Session._relay forwards a guest's frame traffic raw; an input for a frame
    // its sender is limp at, or a fingerprint of a state its sender computed on
    // its own pad after the room took its controller, is not the room's. Null
    // = do not forward.
    filterRelay(m) {
      if (!m || !this._limp.size) return m;
      if (m.t === 'lsh' || m.t === 'lsd') return this._peerLimpAt(m.peer, m.f | 0) ? null : m;
      if (m.t !== 'ls' || !Array.isArray(m.i)) return m;
      const keep = (f, items) => items.filter((it) => Array.isArray(it) && !this._isLimp(it[0] | 0, f));
      const out = Object.assign({}, m, { i: keep(m.f, m.i) });
      if (Array.isArray(m.wr)) {
        // A run may straddle a limp span: expand it, filter per frame (rare —
        // only while somebody is limp), and re-encode as runs.
        const wr = [];
        for (const e of m.wr) {
          const src = e && e[2] === 0 ? m.i : (e && e[2]);
          if (!Array.isArray(e) || !Array.isArray(src)) continue;
          for (let g = e[0]; g < e[0] + Math.min(32, e[1] | 0); g++) {
            const it = keep(g, src);
            if (!it.length) continue;
            const last = wr[wr.length - 1];
            if (last && last[0] + last[1] === g && JSON.stringify(last[2]) === JSON.stringify(it)) last[1]++;
            else wr.push([g, 1, it]);
          }
        }
        out.wr = wr;
        if (!out.i.length && !wr.length) return null;
        return out;
      }
      if (Array.isArray(m.w)) out.w = m.w.map((e) => (Array.isArray(e) && Array.isArray(e[1])) ? [e[0], keep(e[0], e[1])] : e)
        .filter((e) => Array.isArray(e) && Array.isArray(e[1]) && e[1].length);
      if (!out.i.length && !(out.w && out.w.length)) return null;
      return out;
    }
    _peerLimpAt(peer, f) {
      if (!peer || !this._limp.size) return false;
      const ps = this._portsOf(peer);
      return ps.length > 0 && ps.some((p) => this._isLimp(p, f));
    }
    // After a frame ran: advance the CONFIRMED frontier and queue the hash
    // frames it crossed. A frame is confirmed only when every port's real input
    // for it is in hand AND the image it last ran on is exactly those inputs.
    _rbConfirm() {
      this._rbAdvanceInputs();
      // ⚠ A DROP OR UNDROP THE HOST HAS MADE AND THIS CONSOLE HAS NOT YET APPLIED
      // changes what some frames compute; confirming (and fingerprinting) now
      // could publish a state the room does not share. The host's 'ls' carries
      // its count (le) — hold until this console has caught up with it.
      if (!this.isHost && this._rbHostEpoch > this._limpEpoch) return;
      const upto = Math.min(this._rbInputsTo, this.frame - 1);
      while (this._rbConfirmed < upto) {
        const k = this._rbConfirmed + 1;
        if (this._rbFrom <= k) break;
        const used = this._rbUsed.get(k);
        const real = this._rbImage(k);
        let same = !!used && !real.predicted && used.length === real.image.length;
        if (same) for (let i = 0; i < used.length; i++) if (used[i] !== real.image[i]) { same = false; break; }
        if (!same) { if (k < this._rbFrom) this._rbFrom = k; break; }   // defensive: re-run it
        this._rbConfirmed = k;
        // Only a frame whose state the page's ring still holds (a confirmation
        // held back while a drop/undrop was in flight can land far behind).
        if (this.hashEvery > 0 && (k % this.hashEvery) === 0 && k + 1 >= this.frame - this._rbWinPeak - 2) {
          this._rbHashQ.push(k); this.rbStats.hashesQueued++;
        }
      }
    }
    // PAGE: the confirmed frames whose fingerprint is now due. For each k the
    // page hashes its saved state AFTER frame k (= the start of k+1) and calls
    // submitHash(k, h). Each frame is handed out once.
    takeHashDue() {
      if (!this.rollback || !this._rbHashQ.length) return [];
      const q = this._rbHashQ; this._rbHashQ = [];
      return q;
    }
    rollbackReport() {
      const r = this.rbStats;
      // BY PORT, never by peer id (a peer id is the session's nonce).
      const adv = {};
      for (const [pid, a] of this._rbPeerAdv) { const ps = this._portsOf(pid); adv[ps.length ? ps[0] : '?'] = a; }
      const late = this._rbLatePct();
      const sync = this._rbSyncNow(this._now());
      const limp = {};
      for (const [p, spans] of this._limp) limp[p] = spans.map((x) => [x[0], x[1] === Infinity ? null : x[1]]);
      return Object.assign({ window: this.rollback, windowPeak: this._rbWinPeak, adaptive: !!this._rbAdaptive,
                             ringFrames: this.rbRingFrames(), confirmedFrame: this._rbConfirmed,
                             inputsTo: this._rbInputsTo,
                             myAdvantage: this._rbNewestRemote >= 0 ? this.frame - this._rbNewestRemote : null,
                             peerAdvantage: adv,
                             // how late the room's inputs reach this console (frames), and where it
                             // sits against the room clock: lag = behind, lead = ahead, rtt in frames
                             lateP99: late.p99, lateMax: late.max,
                             lag: +sync.lag.toFixed(2), lead: +sync.lead.toFixed(2), rttFrames: +sync.rtt.toFixed(1),
                             pace: this._rbPaceNow, limp,
                             meanDepth: r.rollbacks ? +(r.depthSum / r.rollbacks).toFixed(2) : 0 }, r);
    }

    _covered(f) {
      for (const p of this.occupiedPorts()) if (this._inputFor(f, p) === undefined) return false;
      return true;
    }
    // The one place an input is resolved, so the neutral rules live together:
    // the agreed prologue, and a port whose player has left.
    _inputFor(f, port) {
      if (f < this.delay) return this.neutral;
      if (this._limp.size && this._isLimp(port, f)) return this.neutral;
      const m = this.inputs.get(f);
      return m ? m.get(port) : undefined;
    }
    _isLimp(port, f) {
      const spans = this._limp.get(port);
      if (!spans) return false;
      for (const s of spans) if (f >= s[0] && f < s[1]) return true;
      return false;
    }
    _put(f, port, bytes) {
      let m = this.inputs.get(f);
      if (!m) { m = new Map(); this.inputs.set(f, m); }
      m.set(port, bytes);
    }
    _coerce(pads, port) {
      let v = pads;
      if (pads && !(pads instanceof Uint8Array)) {
        v = (typeof pads.get === 'function') ? pads.get(port) : pads[port];
      }
      if (v instanceof Uint8Array) {
        if (v.length === this.padBytes) return v;
        const out = new Uint8Array(this.padBytes);
        out.set(v.subarray(0, Math.min(v.length, this.padBytes)));
        return out;
      }
      return new Uint8Array(this.padBytes);
    }

    // Call after the frame has actually run. `hash` is this core's fingerprint
    // for the frame just completed; `words` is the raw vector it was folded
    // from, kept locally so a mismatch can name the field that diverged.
    endFrame(hash, words) {
      const f = this.frame;
      this.frame = f + 1;
      this.stats.frames++;
      // ⚠ IN ROLLBACK A FRAME'S HASH IS NOT KNOWN WHEN IT RUNS — it may have
      // run on a guess. The page submits it later, once the frame is CONFIRMED
      // (takeHashDue), so a fingerprint is only ever of a frame every peer ran
      // on the same real inputs.
      if (hash != null && !this.rollback) this.submitHash(f, hash, words);
      if (this.rollback) this._rbConfirm();
      const cut = f - LS_KEEP;
      if (cut > 0 && (f % 64) === 0) {
        for (const k of this._rbUsed.keys()) if (k < cut) this._rbUsed.delete(k);
        // A ROLLBACK HOST keeps a minute of the room's input: it is what a
        // player who was away is refilled from ('lsfill'). A few bytes a port a
        // frame; nobody else needs more than the history above.
        // (a capacity-gated room keeps it in delay lockstep too: a console that
        // missed the switch, or was away across it, is refilled from it)
        const icut = ((this.rollback || this._capGate) && this.isHost) ? f - RB_KEEP_INPUTS : cut;
        if (icut > 0) for (const k of this.inputs.keys()) if (k < icut) this.inputs.delete(k);
        for (const k of this.myHash.keys()) if (k < cut) this.myHash.delete(k);
        for (const k of this.myWords.keys()) if (k < cut) this.myWords.delete(k);
        for (const k of this.peerHash.keys()) if (k < cut) this.peerHash.delete(k);
      }
      return this.frame;
    }
    wantsHash(frame) {
      const f = frame == null ? this.frame : frame;
      return this.hashEvery > 0 && (f % this.hashEvery) === 0;
    }

    // THE FINGERPRINT FOR A NAMED FRAME, WHICH MAY ARRIVE LATE.
    //
    // ⚠ endFrame(hash) ASSUMES THE CORE IS SYNCHRONOUS — that whoever advances
    // the frame counter is also holding the state the frame just produced. A
    // core in a Worker is not: dreamcast.html hands the worker one frame's
    // input, the worker runs it on its own pump, and the state hash comes back
    // as a message some milliseconds later, by which time the page has already
    // had to advance the engine so it can build the NEXT frame's image. Without
    // this method that page has exactly two options, and both are wrong: call
    // endFrame(null) and compare NOTHING (frame-gated cores with no divergence
    // detection at all — the failure this whole class exists to catch), or
    // block the engine on a worker round trip per frame.
    //
    // Same body as endFrame's hash branch, for an explicit frame instead of the
    // current one, and idempotent so a duplicate delivery cannot re-send.
    // _compare() is symmetric — receive('lsh') calls it too — so a hash landing
    // after a peer's is compared just as one landing before it is.
    submitHash(frame, hash, words) {
      if (hash == null) return false;
      const f = frame | 0;
      if (this.myHash.has(f)) return false;
      const h = hash >>> 0;
      this.myHash.set(f, h);
      if (words) this.myWords.set(f, Array.prototype.slice.call(words));
      this.stats.hashesSent++;
      this._send({ t: 'lsh', f, h, peer: this.peerId });
      this._compare(f);
      return true;
    }

    // ---- divergence: detect it, then NAME it --------------------------------
    _compare(f) {
      if (!this.myHash.has(f)) return;
      if (!this.isHost && this.rollback && this._rbHostEpoch > this._limpEpoch) return;   // see _rbConfirm
      const theirs = this.peerHash.get(f);
      if (!theirs || theirs.size === 0) return;
      const mine = this.myHash.get(f);
      const agree = [], differ = [];
      for (const [peer, h] of theirs) {
        // A peer that was limp at f computed that state on its own pad while the
        // room ran its port neutral (see _applyDrop): not comparable.
        if (this._peerLimpAt(peer, f)) continue;
        (h === mine ? agree : differ).push(peer);
      }
      if (!agree.length && !differ.length) return;
      this.stats.hashesCompared++;
      if (!differ.length) {
        // ⚠ ONLY when EVERY expected peer has reported. Advancing this on a
        // PARTIAL agreement made the divergence window useless: the first peer
        // to report agreed, so a later peer's mismatch said "last agreed = the
        // frame that just diverged". That window IS the diagnosis.
        const expect = this.expectedPeers(f);
        if (theirs.size >= expect.length && f > this.lastAgreedFrame) this.lastAgreedFrame = f;
        return;
      }
      if (this.desync) return;
      // WHICH peer, WHICH frame, and the last frame everyone still agreed on —
      // the window the divergence happened inside. That window is the work list.
      const peers = {};
      for (const [peer, h] of theirs) peers[peer] = h >>> 0;
      this.desync = {
        frame: f, lastAgreedFrame: this.lastAgreedFrame,
        mine: mine >>> 0, peers, agree, differ,
        myWords: this.myWords.get(f) || null, fields: null,
      };
      this._setState('desync', 'frame ' + f + ', diverged from ' + this._labels(differ));
      // Offer our raw fingerprint so whoever receives it can name the field.
      if (!this._sentDiag) this._sentDiag = new Set();
      this._sentDiag.add(f);
      this._send({ t: 'lsd', f, peer: this.peerId, w: this.myWords.get(f) || null,
                   why: 'hash mismatch at frame ' + f });
      this._emit('desync', this.desync);
    }
    // Everyone whose fingerprint we expect: the distinct peers seated in a port,
    // other than us — and, for a named frame, not limp at it.
    expectedPeers(f) {
      const out = [];
      for (const p of this.roster) if (p != null && p !== this.peerId && out.indexOf(p) < 0) out.push(p);
      if (f == null || !this._limp.size) return out;
      return out.filter((pid) => !this._peerLimpAt(pid, f));
    }
    _diagnose(f, peer, words) {
      const mineW = this.myWords.get(f);
      if (!mineW || !words || mineW.length !== words.length) return null;
      const fields = [];
      for (let i = 0; i < mineW.length; i++) {
        if ((mineW[i] >>> 0) !== (words[i] >>> 0)) {
          fields.push({ index: i, name: (this.fieldNames && this.fieldNames[i]) || ('w' + i),
                        mine: mineW[i] >>> 0, theirs: words[i] >>> 0 });
        }
      }
      return { frame: f, peer, fields, lastAgreedFrame: this.lastAgreedFrame };
    }

    receive(m) {
      if (!m || typeof m.t !== 'string') return false;
      { const ms = this.msgStats; ms.in[m.t] = (ms.in[m.t] || 0) + 1; }
      // WHO IS STILL THERE (host): anything at all from a peer is proof its page
      // is running. See _silentPeers. (The Session stamps a guest's messages
      // with the link they came in on, so this cannot be claimed for another.)
      if (this.isHost && m.peer && m.peer !== this.peerId) this._heardAt.set(m.peer, this._now());
      else if (!this.isHost && m.peer && m.peer === this._hostId) this._lsHostSeenF = this.frame;
      switch (m.t) {
        case 'ls': {
          if (typeof m.f !== 'number' || !Array.isArray(m.i)) return true;
          // THE REDUNDANCY WINDOW FIRST (see _sendInputs): the frames before
          // m.f that this sender already sent, repeated so a lost packet is
          // covered by the next one. Same per-item rules as the frame itself.
          if (Array.isArray(m.wr)) {
            for (const e of m.wr) {
              if (!Array.isArray(e) || typeof e[0] !== 'number') continue;
              const items = e[2] === 0 ? m.i : e[2];      // 0: the same pad as this frame's
              if (!Array.isArray(items)) continue;
              const n = Math.max(0, Math.min(32, e[1] | 0));
              for (let g = e[0]; g < e[0] + n; g++) if (g >= this.frame - LS_KEEP) this._rxInputs({ f: g, i: items, peer: m.peer });
            }
          }
          if (Array.isArray(m.w)) {
            for (const e of m.w) {
              if (Array.isArray(e) && typeof e[0] === 'number' && Array.isArray(e[1]) && e[0] >= this.frame - LS_KEEP) {
                this._rxInputs({ f: e[0], i: e[1], peer: m.peer });
              }
            }
          }
          if (m.f < this.frame - LS_KEEP) return true;
          this._rxInputs(m);
          if (this._capGate && !m.rel && m.peer) this._rbNoteLead(m);
          if (this.rollback && typeof m.a === 'number') {
            this._rbPeerAdv.set(m.peer || 'peer', m.a | 0);
            const k = m.peer || 'peer', prev = this._rbPeerAdvAvg.get(k);
            this._rbPeerAdvAvg.set(k, prev == null ? (m.a | 0) : prev + ((m.a | 0) - prev) / RB_ADV_SMOOTH);
          }
          // The per-port advantage the room clock is read from (rbCatchUp).
          if (this.rollback && m.peer && Array.isArray(m.av)) this._rbPeerAv.set(m.peer, { av: m.av, at: this._now() });
          // The host's count of drop/undrop decisions: a guest that has applied
          // fewer missed one while its link was down (see _rbGuestRejoin).
          this._rbTakeAck(m);
          // A mode switch the host decided (capacity gating), carried on its inputs.
          if (Array.isArray(m.mo)) this._takeMode(m.mo, null, m.peer);
          return true;
        }
        case 'lsmode': {           // guest: the host switches the room's mode at a named frame
          if (Array.isArray(m.mo)) this._takeMode(m.mo, m.why || null, m.peer);
          return true;
        }
        case 'lsak': {             // guest: the host's acknowledgement heartbeat (see _rbTick)
          this._rbTakeAck(m);
          return true;
        }
        case 'lsnak': {
          // A console stalled on a frame it has NO input for from us, long
          // enough that the redundancy window evidently missed it (a burst of
          // loss on the unreliable channel). Answer with everything we hold
          // from that frame on, on the RELIABLE channel.
          if (m.peer === this.peerId || typeof m.f !== 'number') return true;
          this._nakRxAt = this._now();     // somebody lost something: widen the redundancy window
          this._resendInputsFrom(m.f | 0);
          return true;
        }
        case 'lsh': {
          if (typeof m.f !== 'number' || typeof m.h !== 'number') return true;
          // A fingerprint of a frame its sender was limp at is of a state the
          // room does not share (see _applyDrop) — never compared.
          if (this._peerLimpAt(m.peer, m.f | 0)) return true;
          let byPeer = this.peerHash.get(m.f);
          if (!byPeer) { byPeer = new Map(); this.peerHash.set(m.f, byPeer); }
          byPeer.set(m.peer || 'peer', m.h >>> 0);
          this._compare(m.f);
          return true;
        }
        case 'lsd': {
          const df = m.f | 0;
          // ...nor is a divergence report about one: that console was out of
          // the room at that frame and is re-simulating itself back into it.
          if (this._peerLimpAt(m.peer, df)) return true;
          const d = this._diagnose(df, m.peer || 'peer', m.w);
          // ⚠ ANSWER WITH OURS. Whoever detects first sends its words; without a
          // reply only the RECEIVER can name the diverged field and the detector
          // is left holding two hashes and no explanation. Guarded with a set so
          // two machines cannot ping-pong forever.
          if (!this._sentDiag) this._sentDiag = new Set();
          if (!this._sentDiag.has(df) && this.myWords.has(df)) {
            this._sentDiag.add(df);
            this._send({ t: 'lsd', f: df, peer: this.peerId, w: this.myWords.get(df),
                         why: 'my fingerprint for frame ' + df });
          }
          if (!this.desync) {
            this.desync = { frame: m.f | 0, lastAgreedFrame: this.lastAgreedFrame, mine: null,
                            peers: {}, agree: [], differ: [m.peer || 'peer'],
                            myWords: this.myWords.get(m.f | 0) || null, fields: d ? d.fields : null,
                            peerReported: String(m.why || '') };
            this._setState('desync', 'reported by ' + (m.peer ? this.labelOf(m.peer) : 'a player') + ': ' + (m.why || ''));
            this._emit('desync', this.desync);
          } else if (d) this.desync.fields = d.fields;
          if (d) this._emit('desync-detail', d);
          return true;
        }
        case 'lsx': {
          if (this.state !== 'desync' && this.state !== 'failed') {
            this.fail(String(m.why || 'the session was stopped by another player'));
          }
          return true;
        }
        case 'lsrosterq': {
          // A peer is asking what the room looks like. Only the host can
          // answer, and answering is the cheapest possible convergence: a page
          // that just came back does not have to guess whether it caught the
          // last push, it asks. (The heartbeat covers the peer that does not
          // know it needs to ask; this covers the one that does.)
          if (this.isHost) this._rosterSend();
          return true;
        }
        case 'lsroster': {
          if (Array.isArray(m.r)) {
            // ⚠ NEVER GO BACKWARDS. A retransmit and a seat change can cross on
            // a relay, and applying the older one would un-seat somebody who is
            // in the room. Rosters without a seq come from an older build and
            // are accepted as they always were.
            const seq = (m.seq == null) ? null : (m.seq | 0);
            if (seq != null && seq < this.rosterSeq) return true;
            if (seq != null) this.rosterSeq = seq;
            this.portCount = m.portCount || m.r.length;
            if (m.padBytes) this.padBytes = m.padBytes | 0;
            this.roster = m.r.slice();
            // ⚠ "THE HOST'S ROOM DOES NOT CONTAIN ME" IS A FACT THIS SIDE CAN
            // PROVE, and it is the guest half of the user's two screenshots.
            // A peer that WAS seated and is not in the newest authoritative
            // roster is not in the room any more, whatever its screen still
            // says. It gets its own flag so the page can say so out loud
            // instead of quietly dropping the "you are Player 2" line.
            const mineNow = this.roster.indexOf(this.peerId) >= 0;
            const wasSeated = this._wasSeated === true;
            if (mineNow) this._wasSeated = true;
            this.rosterEvicted = !this.isHost && wasSeated && !mineNow;
            this.rosterAt = Date.now();
            this._recount();
            if (this.rosterEvicted) this._emit('roster-evicted', { peerId: this.peerId, roster: this.rosterReport() });
          }
          // The host named the room's disc. Announce it so the page can select
          // and load that game without the player choosing anything — announced
          // once per change, because the roster is re-sent on every seat.
          if (m.game && m.game !== this.roomGame) {
            this.roomGame = m.game;
            this._emit('room-game', { game: m.game });
          }
          return true;
        }
        // ---- the card set (see the block above _checkBarrier) ------------
        case 'lsvmu': {            // host only: one peer's contribution, in pieces
          // ⚠ A GUEST MUST IGNORE THIS. In the star topology a guest only ever
          // hears the host, and the host does not forward contributions
          // (RELAYED carries frame traffic only) — but the scriptable bus the
          // protocol test runs on delivers everything to everybody, and a guest
          // that recorded another guest's contribution would be assembling a
          // set it has no authority over.
          if (!this.isHost) return true;
          const peer = m.peer || 'peer';
          const port = m.port | 0;
          // The sender is stamped by the link it arrived on (NetplaySession
          // _onRoomMsg), so this is what makes "only your own seat" real.
          if (port < 0 || port >= this.portCount || this.roster[port] !== peer) return true;
          const done = this._cardTake(this._cardParts, peer + '#' + port, m);
          if (!done) return true;
          const cur = this._cardIn.get(peer) || {};
          cur[port] = Object.assign({ port }, done);
          this._cardIn.set(peer, cur);
          this._cardTryAssemble();
          return true;
        }
        case 'lsvmuz': {           // the host announced a set: what is coming
          if (this.isHost) return true;
          this._cardRx = { seq: m.seq | 0, set: String(m.set || ''), want: {}, parts: new Map(), have: {} };
          for (const e of (Array.isArray(m.ports) ? m.ports : [])) this._cardRx.want[e.port | 0] = e;
          return true;
        }
        case 'lsvmus': {           // ...and one of its cards, in pieces
          if (this.isHost) return true;
          const rx = this._cardRx;
          if (!rx || (m.seq | 0) !== rx.seq) return true;   // a set we were never told about
          const done = this._cardTake(rx.parts, 'p' + (m.port | 0), m);
          if (!done) return true;
          rx.have[m.port | 0] = Object.assign({ port: m.port | 0 }, done);
          const want = Object.keys(rx.want).map((p) => p | 0);
          if (!want.length || want.some((p) => !rx.have[p])) return true;
          const set = {};
          for (const p of want) set[p] = rx.have[p];
          const h = Lockstep.cardSetHash(set);
          // ⚠ THE HOST'S OWN FINGERPRINT IS COMPARED, NOT ASSUMED. A set that
          // does not hash to what the manifest announced is a crossed or
          // truncated transfer, and installing it would fork this console from
          // the room — exactly what the exchange exists to prevent. Refuse it
          // and say so; the page holds this console out of the barrier and the
          // player is told why.
          this._cardRx = null;
          if (h !== rx.set) {
            this._emit('cards', { set: null, hash: null,
                                  error: 'the card set arrived fingerprinting ' + h + ' but the host announced ' +
                                         rx.set + ' — it was truncated or crossed in flight' });
            return true;
          }
          this.cards = set; this.cardSetHash = h;
          this._emit('cards', { set, hash: h, seq: rx.seq });
          return true;
        }
        case 'lsvmuq': {           // a guest is asking for the set again
          if (this.isHost) this._cardBroadcast();
          return true;
        }
        case 'lsready': {          // host only: a peer reached the barrier
          if (!this.isHost) return true;
          this._lobbySet(m.peer || 'peer', String(m.disc == null ? '' : m.disc), !!m.cu, !!m.rb, !!m.wr,
                         { ms: !!m.ms, st: m.st, rz: !!m.rz, mw: m.mw });
          this._checkBarrier();
          return true;
        }
        case 'lspace': {    // a console's stalled share over its last pace window
          if (m.peer && m.peer !== this.peerId) {
            const clamp = (x) => Math.max(0, Math.min(1, +x || 0));
            const prev = this._peerPace.get(m.peer);
            const r = { share: clamp(m.s), frames: m.fr | 0, w: m.w | 0, at: this._now(),
                        cap: Math.max(0, +m.c || 0), lost: clamp(m.h), rtt: Math.max(0, m.rt | 0),
                        wo: (m.wo && typeof m.wo === 'object') ? m.wo : {} };
            r.hist = ((prev && prev.hist) || []).concat([{ share: r.share, lost: r.lost, cap: r.cap, wo: r.wo }]).slice(-3);
            this._peerPace.set(m.peer, r);
            if (this.isHost && this._capGate && m.st != null) {
              this._capPeer.set(m.peer, { st: Math.max(0, +m.st || 0), rs: 0, li: null, rr: !!m.rr, at: this._now(), mode: 0 });
            }
          }
          return true;
        }
        case 'lsdelay': {   // host raises the input delay, effective at an agreed frame
          if (!this.isHost && m.at != null) {
            this._pendingDelay = { at: m.at | 0, d: Math.max(1, Math.min(30, m.d | 0)) };
          }
          return true;
        }
        case 'lsgo': {
          // The HOST's parameters win everywhere. Two machines configured with
          // different delays would desync by construction, so this is adopted,
          // never merged.
          this.delay = Math.max(1, Math.min(30, m.delay | 0));
          this.hashEvery = Math.max(0, m.hashEvery | 0);
          // Rollback or not is the HOST's decision too: a guest that predicted
          // while the host waited (or the reverse) would schedule its input on
          // different frames — a desync by construction. An 'lsgo' from a build
          // that predates rollback carries no `rb`, which reads as 0: lockstep.
          this.rollback = Math.max(0, Math.min(ROLLBACK_MAX, m.rb | 0));
          if (m.peer) this._hostId = m.peer;
          // ADAPTIVE only if the host found every console able to follow it (see
          // the ADAPTIVE ROOM block) — never this console's own opinion.
          this._rbAdaptive = !!(this.rollback && m.rba);
          // CAPACITY GATING: the host may switch this room between rollback
          // and delay lockstep at agreed frames ('lsmode' / 'ls' mo); `cw` is the
          // window a delay room returns to, `cs` the consoles a room that STARTS
          // in delay was too slow on.
          this._capGate = !!m.cg;
          this._capW = this._capGate ? Math.max(1, Math.min(ROLLBACK_MAX, (m.cw | 0) || this.rollback || 1)) : 0;
          this._capAdaptive = !!(this._capGate && m.rba);
          this._wr = !!m.wr;
          if (m.portCount) this.portCount = m.portCount | 0;
          if (m.padBytes) this.padBytes = m.padBytes | 0;
          if (Array.isArray(m.r)) this.roster = m.r.slice();
          this.neutral = new Uint8Array(this.padBytes);
          const fresh = this.state !== 'running' && this.state !== 'stalled';
          this.begin();
          if (fresh && this._capGate && !this.rollback && Array.isArray(m.cs)) {
            this._modeNote(0, this.delay, this._capW, this._capWhy(m.cs, 0, true), m.cs);
          }
          return true;
        }
        case 'lsdrop': {
          // The host's decision; a guest never forwards one (Session RELAYED),
          // and a host ignores a copy — it is the one that makes them.
          if (this.isHost) return true;
          if (Array.isArray(m.ports)) this._applyDrop(m.ports.map((p) => p | 0), m.at | 0, m.peer || null, m.why || null);
          if (typeof m.e === 'number' && m.e > (this._rbHostEpoch | 0)) this._rbHostEpoch = m.e | 0;
          return true;
        }
        case 'lsundrop': {         // host: a dropped player's controller comes back at `at`
          if (this.isHost || !(this.rollback || this._capGate)) return true;
          if (Array.isArray(m.ports)) this._applyUndrop(m.ports.map((p) => p | 0), m.at | 0, m.peer || null);
          if (typeof m.e === 'number' && m.e > (this._rbHostEpoch | 0)) this._rbHostEpoch = m.e | 0;
          return true;
        }
        case 'lsrb': {             // host: a console's lateness report — and its heartbeat
          if (!this.isHost || !m.peer || m.peer === this.peerId) return true;
          this._rbPeerRb.set(m.peer, { lp: Math.max(0, +m.lp || 0), lx: Math.max(0, +m.lx || 0), n: m.n | 0,
                                       st: Math.max(0, +m.st || 0), ws: m.ws | 0, w: m.w | 0, f: m.f | 0, at: this._now(),
                                       mw: Math.max(0, m.mw | 0) });
          if (this._capGate && this.rollback) {
            const rs = Math.max(1, +m.rs || 1);
            const dp = Math.max(0, m.dp | 0);
            // `cr` (corrections per frame) is absent from an older engine's
            // report: that console is judged by the old burst bar (_capNeedOf).
            const cr = typeof m.cr === 'number' && m.cr >= 0 ? Math.min(1, m.cr) : undefined;
            const lt = typeof m.lt === 'number' && m.lt >= 0 ? Math.min(1, m.lt) : undefined;
            this._capPeer.set(m.peer, { st: Math.max(0, +m.st || 0), rs, dp, cr, lt, li: typeof m.li === 'number' ? m.li : null,
                                        rr: true, at: this._now(), mode: 1 });
            if (+m.rs > 0) this._capRs.set(m.peer, rs);
            if (m.dp != null) this._capDp.set(m.peer, dp);
            if (cr != null) this._capCr.set(m.peer, cr);
          }
          return true;
        }
        case 'lsrbw': {            // guest: the host re-sized the window, from a named frame
          if (this.isHost || !this.rollback) return true;
          const w = Math.max(1, Math.min(ROLLBACK_MAX, m.w | 0));
          this._rbPendingW = { at: m.at | 0, w };
          if (w > this._rbWinPeak) this._rbWinPeak = w;
          this._emit('window', { from: this.rollback, to: w, at: m.at | 0, why: m.why || null });
          return true;
        }
        case 'lsfillq': {          // host: a guest that was away asks for the room's inputs
          if (!this.isHost || !(this.rollback || this._capGate) || !m.peer || m.peer === this.peerId) return true;
          const now = this._now(), key = '_fillAt:' + m.peer;
          if (this[key] && now - this[key] < RB_REPORT_MS / 2) return true;   // one answer per half-report
          this[key] = now;
          this._rbServeFill(m.peer, Math.max(0, m.f | 0));
          return true;
        }
        case 'lsfill': {           // guest: the host's store, from a frame on
          if (this.isHost || !(this.rollback || this._capGate) || (m.to && m.to !== this.peerId)) return true;
          if (Array.isArray(m.limp)) this._applyLimpTable(m.limp, m.e);
          if (typeof m.e === 'number' && m.e > (this._rbHostEpoch | 0)) this._rbHostEpoch = m.e | 0;
          if (m.gone) {
            // The room no longer holds the frames this console would have to
            // re-simulate. It is out of the room for good; the others are not
            // affected (its controller is limp).
            this._rbFillGone = true;
            if (this.localPorts.some((p) => this.dropped.has(p))) {
              this.fail('this console was away longer than the room keeps its inputs (' + Math.round(RB_KEEP_INPUTS * this._frameMs() / 1000)
                        + ' s), so it cannot catch back up — leave the party and join again');
            }
            return true;
          }
          let n = 0;
          for (const e of (Array.isArray(m.i) ? m.i : [])) {
            if (!Array.isArray(e) || typeof e[0] !== 'number' || !Array.isArray(e[1])) continue;
            const k = e[0] | 0;
            if (k < this.frame - LS_KEEP) continue;
            for (const pair of e[1]) {
              const port = pair[0] | 0;
              if (port < 0 || port >= this.portCount || this.localPorts.indexOf(port) >= 0) continue;
              if (this._limp.size && this._isLimp(port, k)) continue;
              const held = this.inputs.get(k);
              if (held && held.has(port)) continue;
              let bytes = null;
              try { bytes = b64dec(pair[1]); } catch (x) { continue; }
              this._put(k, port, bytes); this.stats.received++; n++;
              if (this.rollback) this._rbArrived(k, port, bytes, true);
            }
          }
          this.rbStats.fillFrames += n;
          return true;
        }
        case 'lsrejoin': {         // host: a dropped player is caught up and asks back in
          if (!this.isHost || !this._dropRoom() || !m.peer) return true;
          this.rejoinPeer(m.peer);
          return true;
        }
        case 'lsbar': {          // the host's view of who the room is waiting on
          // ⚠ KEEP IT. Emitting it and forgetting it left every page unable to
          // answer "is this player ready", which is the one thing the room
          // panel is for. See report()'s declaredReady/readyPeers.
          if (!this.isHost && m.b) { this._bar = m.b; this._emit('barrier', m.b); }
          return true;
        }
        default: return false;
      }
    }

    fail(why) { this.error = why; this._setState('failed', why); }
    end() { this._setState('ended'); }
    report() {
      const s = this.stats;
      return {
        state: this.state, frame: this.frame, delay: this.delay,
        rollback: this.rollback ? this.rollbackReport() : null,
        mode: this._capGate || this.modeHistory.length ? this.modeReport() : null,
        portCount: this.portCount, ports: this.rosterReport(), localPorts: this.localPorts.slice(),
        desync: this.desync, error: this.error, lastAgreedFrame: this.lastAgreedFrame,
        frames: s.frames, stalls: s.stalls,
        stallMs: Math.round(s.stallMs), maxStallMs: Math.round(s.maxStallMs),
        hashesCompared: s.hashesCompared, hashesSent: s.hashesSent,
        inputsSent: s.sent, inputsReceived: s.received,
        minLead: s.minLead === Infinity ? null : s.minLead,
        meanLead: s.leadSamples ? +(s.leadSum / s.leadSamples).toFixed(2) : null,
        // ---- WHICH DISC DOES THIS SIDE THINK THE ROOM IS FOR? -------------
        // Unobservable until now, and that is why the disc-agreement failure
        // survived every rig: room_crossdevice_test.mjs:911 sets the JOINER's
        // #romSelect to the same game as the host, so it can never detect a
        // room that failed to name its own disc — 45+ green cells over a bug a
        // real player hit on his first try. `game` is what this engine
        // publishes in the roster; `roomGame` is what a guest has been TOLD.
        // A host with game:null, or a guest with roomGame:null after the room
        // is connected, is the whole defect, visible in one field.
        game: this.game || null,
        roomGame: this.roomGame || null,
        // ---- WHO HAS ACTUALLY DECLARED READY -------------------------------
        // `declaredReady` is this side's own answer; `readyPeers` is the host's
        // view of everyone else's, derived from the barrier's waitingFor, which
        // was already computed and broadcast and then thrown away by every
        // reader. Without these a page can only guess from the engine state,
        // which cannot distinguish "has not declared" from "declared, waiting
        // for the others".
        declaredReady: !!this._declaredReady,
        readyPeers: (() => {
          const b = this._bar;
          if (!b || !Array.isArray(b.seated)) return null;
          const waiting = Array.isArray(b.waitingFor) ? b.waitingFor : [];
          return b.seated.filter((p) => waiting.indexOf(p) < 0);
        })(),
        // ---- IS THIS PICTURE OF THE ROOM STILL TRUE? ----------------------
        // The host is authoritative by construction, so only a GUEST can be
        // holding a lie. Both of these are answers to "should this side still
        // be drawing a roster", and a page that renders one without the other
        // is the panel the user photographed: a full room drawn from a message
        // that arrived before everything went wrong.
        //   rosterAgeMs  ms since the last authoritative roster (null = never)
        //   rosterStale  no roster for longer than four heartbeats
        //   rosterEvicted the host's newest roster does not contain this peer
        // ⚠ THE CARD SET IS PART OF WHAT THIS MACHINE HOLDS AT FRAME 0, so it
        // is reportable for the same reason the disc is: a room that will not
        // start has to be able to say which seat it is still waiting on a card
        // from. `hash` is null until the room has agreed one.
        // THE ROOM'S PACE — this console's last window and the delay's own
        // history (every raise and give-back the host decided, newest last).
        pace: this.pace,
        failedDelay: this._failedDelay || null,
        delayHistory: this.delayHistory.slice(-16),
        // FOR A REMOTE DIAGNOSIS (lib/debugreport.js): every console's last
        // reported pace — its self-measured cap, stalled and lost shares, RTT
        // and whom it waited on — by PORT; the ms THIS console spent stalled
        // on each port; and what it sent and received, by message type.
        peersPace: (() => { try { const r = this.paceReport(); return { self: r.self, peers: r.peers.map((p) => {
          const o = Object.assign({}, p); delete o.peer; return o; }) }; } catch (e) { return null; } })(),
        stallByPort: (() => { const o = {};
          for (const [pid, ms] of this._stallByPeer) for (let p = 0; p < this.roster.length; p++) if (this.roster[p] === pid) o[p] = Math.round(ms);
          return o; })(),
        msgs: { out: Object.assign({}, this.msgStats.out), outBytes: this.msgStats.outBytes,
                in: Object.assign({}, this.msgStats.in), frames: this.stats.frames,
                runMs: this._paceBornAt ? Math.round(this._now() - this._paceBornAt) : 0 },
        cardSetHash: this.cardSetHash,
        cardsWaitingFor: this.cardsWaitingFor(),
        rosterSeq: this.rosterSeq,
        rosterAgeMs: this.rosterAt ? (Date.now() - this.rosterAt) : null,
        rosterStale: !this.isHost && this.state !== 'running' && this.state !== 'stalled' &&
                     !!this.rosterAt && (Date.now() - this.rosterAt) > ROSTER_STALE_MS,
        rosterEvicted: !!this.rosterEvicted,
        // The barrier's own verdict that fewer than two PEOPLE are seated — the
        // one sentence a party panel needs before anyone has declared. Public
        // here so no page has to read the private _bar.
        alone: !!(this._bar && this._bar.alone),
      };
    }
  }

  // ---- the session ----------------------------------------------------------
  // Every live session, newest last. dreamcast.html and gamecube.html both keep
  // their session inside a closure and publish only a REPORT of it, so there is
  // otherwise no handle for a page or a rig to ask admission() of — and "was
  // this peer approved" has to be answerable from outside the session's own
  // report shape, which those two pages own and which must not move.
  const LIVE = [];
  // A guest has exactly one link and it is to the host, so it needs a key but
  // never a real nonce for it.
  const HOST_LINK = '#host';
  // What the host forwards from one guest to the others: FRAME TRAFFIC ONLY.
  // 'ls' pads, 'lsh' fingerprints, 'lsd' divergence diagnostics. Deliberately
  // NOT lsroster / lsgo / lsdrop (the host's decisions — a forwarded forgery
  // would let one player reseat, start or unplug the room) and not lsready /
  // lsx (addressed to the host, or its call to make).
  // The label of the unordered, unreliable input channel (Session._bindUnreliable).
  const LSU_LABEL = 'lsu';
  // An input message without its redundancy window, for a channel that cannot
  // lose it (see Session._send).
  function leanInputs(m) { const c = Object.assign({}, m); delete c.w; delete c.wr; return JSON.stringify(c); }
  const RELAYED = { ls: 1, lsh: 1, lsd: 1, lsping: 1, lspong: 1, lspace: 1, lsnak: 1 };
  class NetplaySession {
    constructor(opts) {
      opts = opts || {};
      // ⚠ NULL, NOT 'unknown'. A JOINER IS CONSTRUCTED WITH NO GAME ON PURPOSE
      // — the host names the disc and the room announces it ('lsroster' ->
      // 'room-game'), so a player is never asked to guess a string before they
      // are allowed to talk. The pairing handshake below is guarded on
      // `m.game && this.game` precisely so that a gameless joiner SKIPS the
      // comparison, and dreamcast.html's netStartGuest() documents that it
      // relies on exactly this. It did not work: `|| 'unknown'` made the guest's
      // game a TRUTHY STRING, so the guard passed and the host denied the
      // pairing with "the other player is on gauntlet" — to a player who was on
      // gauntlet. Measured in dreamcast/tools/room_crossdevice_test.mjs:
      //   [join] [net] FAULT (net) the other player is on gauntlet
      //   [join] [net] guest failed (the other player is on gauntlet)
      // Every consumer of this field is already null-safe (`this.game || null`,
      // `req.game || 'this game'`, and the three `m.game && this.game` guards).
      // The check that actually protects a room is the START BARRIER, which
      // compares what each machine LOADED rather than what it typed.
      this.game = opts.game || null;
      this.isHost = !!opts.host;
      this.code = opts.code || makeCode(5);
      this.transport = opts.transport || 'local';
      this.delayFrames = opts.delayFrames == null ? 3 : opts.delayFrames;
      this.state = 'idle';          // idle | signalling | connected | closed | failed
      this.peerReady = false;
      this.frame = 0;
      // remoteInputs[frame] = input value the OTHER side pressed on that frame.
      this.remoteInputs = new Map();
      this.localInputs = new Map();
      this._sig = null; this._pc = null; this._dc = null;
      this._stream = null;       // host: what we send. guest: what we received.
      this._ownStream = false;   // true when _stream is one WE built (no msid)
      this._sink = null;         // guest: the element that RENDERS the sound
      this._remotePad = 0;       // legacy single-peer mirror of _remotePads
      this._remotePads = new Map();   // link nonce -> that player's latest pad mask
      this._padOrder = [];            // link nonces in order of admission
      this._padSeq = -1;
      this._handlers = { status: [], input: [], sync: [], close: [], stream: [], save: [],
                         'save-progress': [], 'join-request': [], reject: [],
                         // lockstep
                         'sync-state': [], 'sync-failed': [], desync: [], lockstep: [],
                         warning: [], cards: [],
                         // the room: a seat filled, a seat vacated, the roster moved
                         'peer-joined': [], 'peer-left': [], room: [] };
      this._padSeqRx = null;
      this._answered = false;
      this.lastError = null;
      // ---- admission control (see the block at the top of this file) --------
      // ⚠ STABLE ACROSS A RELOAD (see stableNonce above): this is what owns a
      // maple port, so a page that comes back has to come back as the SAME
      // player and not as a third one standing next to its own ghost.
      this._nonce = stableNonce(this.code, this.isHost);
      // ...AND THE INCARNATION IS NOT. `_nonce` says WHO; `_inc` says WHICH PAGE
      // LOAD. The host needs both: a hello from a nonce it already holds a link
      // for is an ordinary retry when the incarnation matches (its hello simply
      // crossed the offer) and a RECONNECT when it does not (that person's page
      // was replaced and the link the host is still holding is a corpse). With
      // only the nonce the two are indistinguishable, and the host's existing
      // `if (this._links.has(m.n)) return` would ignore the returning player
      // forever.
      this._inc = randomHex(8);
      // Nonces a human has ALREADY admitted to this room. A returning peer that
      // is on this list is re-admitted without a second dialog — see _ask().
      this._known = new Set();
      this._approved = false;       // host: a human said yes. guest: it was told yes.
      this._pending = null;         // host: {nonce, chal, proven, checking, sas}
      this._denials = 0;            // host: how many joiners have been refused
      this._quietUntil = 0;         // host: stop raising prompts after a spree
      this._chal = null;            // guest: the challenge it answered
      this._joinSent = false;
      // ---- relay mode (see the block above ICE_CONNECT_MS) -----------------
      // null until the direct path has actually failed. A page reads this to
      // say, on screen, that the room is on a relay and slower.
      this.relay = null;
      this._relayOut = [];          // coalesced non-'ls' traffic awaiting a publish
      this._relayTimer = 0;
      this._relayTimerAt = 0;       // that timer's deadline, so the earliest wins
      this._relayWin = new Map();   // frame -> this console's own encoded input, for retransmission
      this._relayWinPeer = null;    // the peerId those inputs were sent under
      this._relaySeq = 0;
      this._relayRx = new Map();    // sender nonce -> highest sequence accepted
      // ⚠ COUNTED, BECAUSE A DROPPED BATCH IS INVISIBLE OTHERWISE. Every path
      // out of _onRelay() that discards a message is silent by construction
      // (an unauthenticated publish, a failed decrypt, a stale sequence), and
      // on a lockstep room a single discarded batch is a PERMANENT deadlock —
      // the frames it carried are never re-sent. Without these the symptom is
      // "the room froze" with nothing to attribute it to.
      this._relayStats = { pub: 0, items: 0, rxOk: 0, rxItems: 0,
                           dropAuth: 0, dropDecrypt: 0, dropSeq: 0, gapSeq: 0, sendFail: 0 };
      this._relayPing = 0;
      this._helloTimer = 0;
      this._promptTimer = 0;
      this._prompt = null;          // the built-in Allow/Deny element, if shown
      this._notice = null;          // the guest's "waiting to be let in" element
      this._promptUnfollow = null;  // fullscreenchange listener teardown
      this._noticeUnfollow = null;
      this.sas = null;              // the confirmation code, once there is one
      // A page that wants to draw its own prompt registers on('join-request').
      // ui:false with no handler means there is NO WAY TO ASK A HUMAN, and the
      // session then refuses every joiner rather than defaulting to open.
      this._ui = opts.ui !== false;
      // ---- LOCKSTEP IS THE ARCHITECTURE ------------------------------------
      // There is no mode selector. Streaming one machine's picture to the
      // others is CANCELLED: it made everyone but the host a spectator with a
      // joypad, which is not what a console does. attachMedia/remoteStream are
      // still defined below because deleting them is churn, but nothing here
      // routes to them and no page should.
      this.mode = 'lockstep';
      this.ls = null;               // the Lockstep engine, once startLockstep()
      // ---- THE ROOM: AS MANY PLAYERS AS THE CONSOLE HAS ---------------------
      // ⚠ portCount IS THE CONSOLE'S, HANDED IN. Dreamcast has four maple ports
      // (flycast-src/core/hw/maple/maple_devs.h:193 MAPLE_PORTS 4); GameCube's
      // bridge wires one. It is never a constant in this file.
      this.portCount = Math.max(1, Math.min(8, opts.portCount == null ? 4 : opts.portCount | 0));
      // The host occupies a seat too, so a four-port console admits three guests.
      this.maxPeers = opts.maxPeers == null ? this.portCount - 1
                                            : Math.max(0, Math.min(7, opts.maxPeers | 0));
      this._links = new Map();      // nonce -> { nonce, pc, dc, approved, answered, iceTimer, open }
      this._seatedSelf = false;
      this._load = new Map();       // peerId -> 0..100, what the room panel draws
      this._autoSeat = opts.autoSeat !== false;
      LIVE.push(this);
      while (LIVE.length > 8) LIVE.shift();
    }
    on(ev, fn) { (this._handlers[ev] || (this._handlers[ev] = [])).push(fn); return this; }

    // ---- host: stream the running game -------------------------------------
    // canvas.captureStream is the whole trick — the emulator keeps drawing to its
    // own canvas and is not aware any of this exists.
    // ⚠ Must be called BEFORE start(): tracks added after the offer is created do
    // not appear in it, and the guest would connect to a session with no picture.
    attachMedia(canvas, audioNode) {
      try {
        if (!canvas || typeof canvas.captureStream !== 'function') return false;
        const ms = canvas.captureStream(60);
        if (audioNode && audioNode.context) {
          // Route a COPY of the audio out: connecting to a MediaStreamDestination
          // is additive, so the host keeps hearing the game normally.
          const dest = audioNode.context.createMediaStreamDestination();
          audioNode.connect(dest);
          dest.stream.getAudioTracks().forEach((t) => ms.addTrack(t));
        }
        this._stream = ms;
        return true;
      } catch (e) { this.lastError = 'capture failed: ' + e.message; return false; }
    }
    // guest: the received stream, for a <video srcObject>.
    remoteStream() { return this._stream; }

    // ---- guest: MAKE THE RECEIVED SOUND ACTUALLY PLAY -----------------------
    //
    // ⚠ A RECEIVED WEBRTC AUDIO TRACK PRODUCES NO SAMPLES AT ALL UNTIL AN
    // HTMLMediaElement PULLS IT. This is the whole reason a guest could sit on a
    // track reporting `audio:live` and hear silence.
    //
    // MEASURED (Chrome 152.0.7977.76, two real tabs, real RTCPeerConnection,
    // host emitting 440 Hz at amplitude 0.5, the tone verified on the host's own
    // captured track at peak 0.50000 before it ever left the machine):
    //
    //   guest graph                                        peak    inbound-rtp
    //   createMediaStreamSource -> analyser                0.00000 totalSamplesReceived 0,
    //                                                              audioLevel 0
    //                                                              ...while 82 packets /
    //                                                              6,741 B had ALREADY arrived
    //   ...analyser -> gain(0) -> ctx.destination          0.00000 unchanged
    //   ...plus the stream on a MUTED <audio>              0.50577 totalSamplesReceived
    //                                                              289,920, audioLevel 0.5045
    //
    // Two things that reading looks like but is NOT:
    //   * it is not "an AnalyserNode needs a path to a destination" — adding one
    //     changed nothing, and on a LOCAL source an unsunk analyser read the
    //     identical 0.5 as a sunk one;
    //   * it is not a silent tap on the host — the host read its OWN captured
    //     MediaStreamDestination track back at peak 0.50000 and getStats put
    //     media-source audioLevel at 0.500015.
    // The decoder simply is not run until something renders the track.
    //
    // So the SESSION owns a sink rather than trusting its page to know this.
    // It is MUTED on purpose: it exists to make the samples flow, not to be the
    // speaker. The page stays the one audible renderer (dreamcast.html plays the
    // stream through #netVideo), so nothing is heard twice.
    _sinkRemoteAudio() {
      if (this._sink || typeof document === 'undefined' || !this._stream) return;
      try {
        const a = document.createElement('audio');
        a.autoplay = true; a.playsInline = true;
        a.muted = true;                 // see above: still renders, never doubles
        a.setAttribute('aria-hidden', 'true');
        a.style.cssText = 'position:absolute;width:0;height:0;opacity:0;pointer-events:none';
        a.srcObject = this._stream;
        (document.body || document.documentElement).appendChild(a);
        this._sink = a;
        // A muted element is never refused by the autoplay policy, but a
        // rejected promise must still not become an unhandled rejection.
        const p = a.play(); if (p && p.catch) p.catch(() => {});
      } catch (e) { /* no sink is the old behaviour, not a reason to fail a session */ }
    }
    _dropSink() {
      const a = this._sink;
      this._sink = null;
      if (!a) return;
      try { a.pause(); a.srcObject = null; a.remove(); } catch (e) {}
    }

    // ---- guest -> host pad --------------------------------------------------
    // Fire-and-forget and UNRELIABLE ON PURPOSE: a pad state is only interesting
    // while it is current, so a late packet is worse than a lost one. Sequence
    // numbers drop anything that arrives out of order.
    sendPad(mask) {
      const o = { t: 'pad', v: mask | 0, s: ++this._padSeq };
      if (this._dc && this._dc.readyState === 'open') {
        try { this._dc.send(JSON.stringify(o)); } catch (e) {}
        return;
      }
      // ⚠ NOT AN ELSE THAT DOES NOTHING. On a relayed room there is no
      // DataChannel at all, and a pad helper that quietly dropped every press
      // would make an admission arm measured through remotePad() pass while
      // nothing was being tested.
      for (const L of this._links.values()) {
        if (L.relay && !L.dead) { this._relaySend(o); return; }
      }
    }
    // host: what a remote player is holding right now. The emulator reads this
    // exactly like a local pad — so an unapproved peer must read as NOBODY
    // PRESSING ANYTHING, not as the last value it managed to set.
    //
    // ⚠ ONE SCALAR CANNOT HOLD FOUR PLAYERS. `this._remotePad` was written by
    // whichever peer's message arrived last, so as soon as a room could hold
    // more than one guest, three players' pads raced into one value and all of
    // them landed in port 1. Pads are kept per peer now.
    // Called with no argument it still means "player 2" — the peer in the
    // lowest occupied port that is not ours — because that is what
    // dreamcast.html:4453 asks for while its per-frame path is still the
    // pre-lockstep one. Called with a PORT it answers for that port.
    remotePad(port) {
      if (this.isHost && !this._approved) return 0;
      if (port == null) {
        const first = this._padOrder.length ? this._padOrder[0] : null;
        if (first == null) return this._remotePad | 0;
        return this._remotePads.get(first) | 0;
      }
      const ls = this.ls;
      const peer = ls && ls.roster[port | 0];
      if (!peer || (ls && peer === ls.peerId)) return 0;
      return this._remotePads.has(peer) ? (this._remotePads.get(peer) | 0) : 0;
    }
    // Every remote player's pad, by port — what a page wiring more than two
    // players needs, without reaching into a private map.
    remotePads() {
      const out = {};
      const ls = this.ls;
      if (!ls) return out;
      for (let p = 0; p < ls.portCount; p++) {
        const peer = ls.roster[p];
        if (peer && peer !== ls.peerId && this._remotePads.has(peer)) out[p] = this._remotePads.get(peer) | 0;
      }
      return out;
    }
    // What a page or a test rig needs to know about admission WITHOUT reaching
    // into private fields — every value here is the state that actually decides
    // whether anything flows, not a display flag.
    admission() {
      const p = this._pending;
      return {
        approved: this._approved,
        pending: p ? { id: p.nonce, proven: !!p.proven, sas: p.sas || null } : null,
        sas: this.sas || null,
        promptShown: !!this._prompt,
        denials: this._denials,
        // The host has published an offer only once this is non-null, and the
        // offer is what carries the picture and the sound.
        offered: !!(this._pc && this._pc.localDescription && this._pc.localDescription.sdp),
      };
    }
    _emit(ev, a) { (this._handlers[ev] || []).forEach((f) => { try { f(a); } catch (e) {} }); }
    _status(s, detail) {
      this.state = s;
      if (s === 'connected' || s === 'closed' || s === 'failed') {
        for (const L of this._links.values()) this._disarmIce(L);
      }
      // The two bits of session-owned DOM never outlive the thing they describe.
      if (s === 'connected' || s === 'closed' || s === 'failed') this._closeNotice();
      if (s === 'closed' || s === 'failed') this._closePrompt();
      this._emit('status', { state: s, detail: detail || null, code: this.code, sas: this.sas || null });
    }

    async start() {
      this._status('signalling');
      try {
        this._sig = await openSignal(this.transport, this.code, { host: this.isHost });
      } catch (e) {
        this.lastError = e.message; this._status('failed', e.message); return false;
      }
      this._sig.onMessage((m) => this._onSignal(m));
      // ⚠ A TRANSPORT THAT BREAKS AFTER start() USED TO BE INVISIBLE. Nothing
      // read it, so the page kept rendering 'signalling' — "Waiting for someone
      // to join…" / "Looking for the host…" — over a dead broker. A session
      // that is already playing does not need the broker any more (the game is
      // peer-to-peer by then), so this only fails a session that has not
      // connected yet; otherwise it is logged and left alone.
      this._sig.onError((msg) => {
        this.lastError = msg;
        if (this.state === 'connected') { this._emit('warning', { detail: msg }); return; }
        this._status('failed', msg);
      });
      this._sig.onGone((nonces) => this._sweepSignalling(nonces));
      if (this.isHost) {
        // ⚠ THE HOST BUILDS NO PEER CONNECTION UNTIL IT APPROVES SOMEBODY.
        // It used to build one in start() and hold it for the single guest it
        // could ever have. A room has one per joiner, each created inside
        // approve() — which also means an unapproved caller cannot cause an
        // RTCPeerConnection to exist at all, let alone gather the host's
        // addresses into it.
        this._status('signalling', 'waiting for someone to ask to join');
      } else {
        // A guest has exactly one link, and it is to the host. It exists from
        // start() because the guest must be ready to answer an offer the
        // instant a human allows it in.
        this._link(HOST_LINK);
        this._sendHello();
      }
      return true;
    }

    // ---- ONE LINK PER PEER ---------------------------------------------------
    // Everything that used to be a single `_pc`/`_dc` pair lives here, keyed by
    // the far side's nonce. `_pc` and `_dc` still alias the FIRST link so that
    // the pages, the attack rig and the save path — none of which know about
    // rooms — keep reading the field they always read.
    _link(nonce) {
      let L = this._links.get(nonce);
      if (L) return L;
      const pc = new RTCPeerConnection({ iceServers: iceServers() });
      L = { nonce, pc, dc: null, approved: false, answered: false, iceTimer: 0, open: false };
      this._links.set(nonce, L);
      if (!this._pc) this._pc = pc;
      // ⚠ ICE CANDIDATES ARE THIS MACHINE'S LOCAL ADDRESSES, and they are
      // ADDRESSED to the one peer this link belongs to. Nothing is gathered
      // until setLocalDescription runs, and on the host that only happens inside
      // approve() — so an unapproved caller does not learn them either.
      pc.onicecandidate = (e) => {
        if (!e.candidate) return;
        this._sig.send({ t: 'ice', c: e.candidate.toJSON(), n: this._nonce,
                         to: this.isHost ? nonce : null });
      };
      if (this._stream) this._stream.getTracks().forEach((t) => pc.addTrack(t, this._stream));
      pc.ontrack = (e) => this._onTrack(e);
      pc.oniceconnectionstatechange = () => {
        if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') this._disarmIce(L);
      };
      // ⚠ 'disconnected' IS NOT DEATH. The WebRTC spec defines it as TRANSIENT —
      // a transport lost consent or a check timed out, and it may return to
      // 'connected' on its own — and on a phone on cellular it is ordinary: a
      // radio hand-off, a NAT rebinding, a >1 GB disc fetch saturating the same
      // link. This used to call _linkGone on it directly, which on the HOST
      // unseated the guest (Lockstep.unseat, pre-start) and printed "the other
      // player dropped out — their seat is held … P2 open", while the guest,
      // whose own side never left 'connected', still drew itself seated as
      // Player 2 and went on loading the disc. Photographed live 2026-09-13,
      // host on desktop, guest on a phone. Now a blip gets DISCONNECT_GRACE_MS
      // to recover; only 'failed' — or a blip that never comes back — is a
      // dead link. A 'connected' inside the window cancels it.
      pc.onconnectionstatechange = () => {
        const st = pc.connectionState;
        if (st === 'connected') { this._disarmIce(L); this._clearDisconnectGrace(L); return; }
        if (st === 'failed') { this._clearDisconnectGrace(L); this._linkGone(L, st); return; }
        if (st === 'disconnected') this._armDisconnectGrace(L);
      };
      if (this.isHost) this._bindChannel(pc.createDataChannel('play', { ordered: true }), L);
      else pc.ondatachannel = (e) => {
        if (e.channel && e.channel.label === LSU_LABEL) this._bindUnreliable(e.channel, L);
        else this._bindChannel(e.channel, L);
      };
      return L;
    }

    // ---- THE UNRELIABLE INPUT CHANNEL ----------------------------------------
    // Lockstep input ('ls') used to ride the one reliable, ORDERED channel. On a
    // lossy path one dropped packet is retransmitted after an RTO and every
    // later packet waits behind it (head-of-line), so the room stalls on a
    // retransmission it did not need: each 'ls' now carries the last delay+2
    // frames (Lockstep._sendInputs), so the NEXT packet already covers a lost
    // one. So inputs go on a second channel, unordered with maxRetransmits:0,
    // and everything else (roster, start, delay changes, fingerprints, NAK
    // answers) stays on the reliable one. Measured in tools/netplay_pace_sim.mjs,
    // 50-150 ms one way with 0.3% loss: 0.956x on the ordered channel, 1.0000x
    // on this one with the jitter-aware delay.
    // ⚠ NEGOTIATED, so a mixed-version room cannot break: each side announces
    // 'lscap' on its reliable channel when it opens; only a HOST that has heard
    // it from a guest opens 'lsu' to that guest (an older guest would bind any
    // new channel as its main one), and a side sends input on 'lsu' only once it
    // is open. An older peer never announces and never gets one.
    _bindUnreliable(dc, L) {
      if (!L) return;
      L.dcu = dc;
      dc.onopen = () => { L.dcuOpen = true; this._emit('carrier-up', { peer: L.nonce, carrier: 'unreliable' }); };
      dc.onclose = () => { L.dcuOpen = false; if (L.dcu === dc) L.dcu = null; };
      dc.onmessage = (e) => {
        let m; try { m = JSON.parse(e.data); } catch (_) { return; }
        // Only input is accepted here; anything else must come reliably.
        if (!m || m.t !== 'ls') return;
        this._onData(m, L);
      };
    }
    _onCap(m, L) {
      if (!L) return;
      L.capU = !!m.u;
      if (this.isHost && L.capU && !L.dcu && L.pc && typeof L.pc.createDataChannel === 'function') {
        try { this._bindUnreliable(L.pc.createDataChannel(LSU_LABEL, { ordered: false, maxRetransmits: 0 }), L); } catch (e) {}
      }
    }
    _unreliableFor(L) { return (L && L.dcu && L.dcu.readyState === 'open') ? L.dcu : null; }

    // ⚠ ONE PEER LEAVING MUST NOT CLOSE THE ROOM. The old handler called
    // _status('closed') from the single channel's onclose, and dreamcast.html
    // tears the whole room panel down on that status — so with several players
    // the first person to quit would have ended everyone else's session. A
    // link's death is now a LINK event; the session only reports 'closed' when
    // nothing is left.
    _linkGone(L, why, keepSeat) {
      if (!L || L.dead) return;
      // ⚠ CAPTURED BEFORE IT IS CLEARED. The guest's re-knock below must fire
      // only for a link that WAS UP and then died — a room that worked and
      // dropped. A link that never came up at all is the unreachable-network
      // case, and that one has already reported a diagnosis ("one of these
      // networks is blocking direct peer-to-peer traffic…"); re-knocking there
      // would overwrite that sentence with "asking to be let back in" and hide
      // the only useful thing either screen had to say.
      const wasOpen = !!L.open;
      L.dead = true; L.open = false;
      this._disarmIce(L);
      this._clearDisconnectGrace(L);
      this._links.delete(L.nonce);
      // A player who has gone is not still holding a button down.
      this._remotePads.delete(L.nonce);
      if (this._padSeqBy) this._padSeqBy.delete(L.nonce);
      const oi = this._padOrder.indexOf(L.nonce);
      if (oi >= 0) this._padOrder.splice(oi, 1);
      if (!this._padOrder.length) this._remotePad = 0;
      try { L.pc && L.pc.close(); } catch (e) {}
      if (this._dc === L.dc) this._dc = this._firstOpenChannel();
      if (this._pc === L.pc) this._pc = this._links.size ? this._links.values().next().value.pc : this._pc;
      this._emit('peer-left', { peer: L.nonce, why: why || 'closed', remaining: this._links.size });
      // THE PORT GOES LIMP, IT IS NOT UNPLUGGED, and it is not given away.
      // Lockstep.dropPeer() picks the one frame that is simultaneously past the
      // leaver's last input and not yet executed anywhere; unseating instead
      // would free a seat that a maple hotplug would have to fill on a
      // frame-exact agreed frame on every machine, which is a protocol that
      // does not exist yet (Lockstep.seat() says so out loud).
      // ⚠ `keepSeat` IS FOR A PEER THAT IS STANDING RIGHT THERE ASKING TO COME
      // BACK. The host tears down a corpse-link the moment a returning
      // incarnation knocks; unseating in that path would free the port between
      // the teardown and the re-seat, and lowest-free-first would then be free
      // to hand that player's character to somebody else who knocked in
      // between. Nothing has run a frame, so holding the seat costs nothing.
      if (this.isHost && this.ls && !keepSeat) {
        if (this.ls.state === 'running' || this.ls.state === 'stalled') this.ls.dropPeer(L.nonce);
        else this.ls.unseat(L.nonce);
        this._syncCapacity();
      }
      // The seat is kept; the DECLARE is not — the page that made it is gone.
      if (keepSeat && this.isHost && this.ls) this.ls.forgetReady(L.nonce);
      // Mid-reconnect: the player is knocking as this runs, so "the room is
      // empty" is a claim that is about to be false and would flash on screen.
      if (keepSeat) return;
      if (!this._links.size) {
        this.peerReady = false;
        // ⚠ AND A GUEST WHOSE LINK DIED BEFORE THE GAME STARTED ASKS TO COME
        // BACK. It used to go straight to 'closed', which is honest but final:
        // nothing in the product then re-knocked, so a dropped link in a room
        // that had not started meant the person had to notice, leave, and type
        // the code again — on a phone, while looking at a canvas. The host has
        // kept their seat (see _linkGone's keepSeat, and seatHistory), the
        // simulation has not run a frame, and re-knocking is the same tested
        // path a first join takes. Bounded by the hello retry's own knock
        // budget, so an unreachable room still fails rather than spinning.
        const started = !!(this.ls && (this.ls.state === 'running' || this.ls.state === 'stalled'));
        if (!this.isHost && !started && wasOpen && this._sig && this.state !== 'closed' && why !== 'left') {
          this._reknock('the link to the room dropped — asking to be let back in');
          return;
        }
        // ⚠ A ROOM THAT CAN TAKE A PLAYER BACK DOES NOT CLOSE WHEN A LINK DIES.
        // An adaptive rollback room drops a silent player's controller (it goes
        // limp at an agreed frame; the others play on) and takes them back —
        // refilled from the host's input store, caught up as hidden frames, the
        // controller handed back at a future frame (Lockstep._rbGuestRejoin /
        // rejoinPeer). That worked for a link that BLIPPED; a link that died
        // outright (longer than DISCONNECT_GRACE_MS) still closed both
        // sessions, so the page disarmed and nobody could come back. Now:
        //   * the GUEST re-knocks (same nonce: the host lets a known, seated
        //     player straight back in — see the hello branch of _onSignal) and
        //     its engine keeps the room until it is back or its own stall
        //     budget says it is not coming back;
        //   * the HOST keeps the room open for them.
        if (started && this._rejoinableRoom() && why !== 'left' && this._sig && this.state !== 'closed') {
          if (!this.isHost) { this._rejoining = true; this._reknock('the link to the room dropped — rejoining the game'); return; }
          this._status('signalling', 'a player\'s link dropped — the game plays on, and they can rejoin');
          return;
        }
        // ⚠ AN EMPTY ROOM IS NOT A CLOSED ONE, ON THE HOST. dreamcast.html tears
        // the room panel down on 'closed'; a host whose last guest quit before
        // the disc loaded is back to waiting for someone, not finished. Once the
        // game HAS started there is nothing to wait for, so it does end.
        if (this.isHost && !started) {
          this._status('signalling', 'waiting for someone to ask to join');
        } else {
          this._status('closed');
          this._emit('close');
        }
      }
    }
    // An adaptive rollback room: the one kind that can take a player back mid-game.
    _rejoinableRoom() {
      const ls = this.ls;
      return !!(ls && ls.rollback > 0 && ls._rbAdaptive && (ls.state === 'running' || ls.state === 'stalled'));
    }
    // GUEST: go back to the front door with the same nonce. The host auto-
    // approves a `_known` nonce and seat() hands the remembered port back, so
    // this is the same tested path a first join takes, minus the human.
    _reknock(why) {
      if (this.isHost || !this._sig || this.state === 'closed' || this.state === 'failed') return false;
      this._approved = false;
      this._joinSent = false;
      this._answered = false;
      this._chal = null;
      this._reknockAt = Date.now();
      this._status('signalling', why);
      this._sendHello();
      return true;
    }
    // ⚠ THE PHONE HALF OF THE 2026-09-13 SCREENSHOT. When the host tears a
    // guest's link down it unseats the guest and re-sends the roster — over the
    // links it still has, which no longer include that guest. So the evicted
    // page never receives the roster that evicts it, `rosterEvicted` can never
    // be set, and the only thing that would make it re-knock is its OWN
    // pc/dc dying, which on a phone that merely blipped may not happen for a
    // long time. Meanwhile it draws "you are Player 2" from a roster the host
    // has superseded. The roster is a heartbeat (ROSTER_BEAT_MS), so silence
    // IS the signal: a guest that has heard nothing for ROSTER_REKNOCK_MS
    // before the game started goes back to the front door itself. Armed on
    // the first roster heard; stops once the game starts or the room closes.
    _armRosterWatch() {
      if (this.isHost || this._rosterWatch) return;
      const tick = () => {
        const ls = this.ls;
        if (!ls || this.state === 'closed' || this.state === 'failed' || this.state === 'ended' ||
            ls.state === 'running' || ls.state === 'stalled' || ls.state === 'ended' || ls.state === 'failed') {
          clearInterval(this._rosterWatch); this._rosterWatch = 0; return;
        }
        if (!ls.rosterAt || (Date.now() - ls.rosterAt) < ROSTER_REKNOCK_MS) return;
        if (this._reknockAt && (Date.now() - this._reknockAt) < ROSTER_REKNOCK_MS) return;
        this._emit('warning', { detail: 'nothing heard from the host for ' + Math.round((Date.now() - ls.rosterAt) / 1000) + ' s — asking to be let back in', peer: null });
        this._reknock('nothing heard from the host — asking to be let back in');
      };
      const t = setInterval(tick, ROSTER_BEAT_MS);
      if (t && typeof t.unref === 'function') t.unref();
      this._rosterWatch = t;
    }
    // A caller's SIGNALLING socket died. That is not a game-link death — the
    // game link reports itself — but if it belonged to the person the host is
    // being asked about right now, the prompt is for somebody who has gone.
    _sweepSignalling(nonces) {
      if (!this.isHost || !this._pending || !nonces) return;
      if (nonces.indexOf(this._pending.nonce) < 0) return;
      if (this._links.has(this._pending.nonce)) return;
      this.deny(this._pending.nonce, 'the player who asked to join went away');
    }
    _firstOpenChannel() {
      for (const L of this._links.values()) if (L.dc && L.dc.readyState === 'open') return L.dc;
      return null;
    }
    _onTrack(e) {
      // ONE STREAM FOR THE SESSION. When the offer carries an msid — the
      // normal case, because attachMedia publishes both tracks under the same
      // MediaStream — every track event names that same object and the branch
      // below just re-reads it.
      // ⚠ The fallback matters: a track can arrive with e.streams EMPTY, and
      // building `new MediaStream([e.track])` per track then hands the page
      // two different objects for one session. A page can only put one of them
      // in an element's srcObject, so whichever it keeps, the other track is
      // silently dropped — the picture or the sound, with nothing anywhere
      // reporting a fault. Accumulate into one stream instead.
      const named = e.streams && e.streams[0];
      if (named) { this._stream = named; this._ownStream = false; }
      else {
        if (!this._stream || !this._ownStream) { this._stream = new MediaStream(); this._ownStream = true; }
        if (this._stream.getTracks().indexOf(e.track) < 0) this._stream.addTrack(e.track);
      }
      // The received sound is inaudible — literally undecoded — until an
      // element renders it. See _sinkRemoteAudio.
      if (e.track.kind === 'audio') this._sinkRemoteAudio();
      this._emit('stream', this._stream);
    }

    // ⚠ A GAME CONNECTION THAT NEVER COMES UP AND NEVER FAILS. The fifth and
    // last way to sit on 'signalling' forever, and the one still open after
    // the four broker-side stalls were closed: once the offer and answer have
    // been exchanged, ICE either finds a path or it does not — and when it
    // does not, some browsers park in 'checking'/'new' indefinitely rather
    // than declaring 'failed'. Reproduced deliberately with
    // tools/netplay_relay_check.mjs, which forces iceTransportPolicy:'relay'
    // with no relay configured: both sides sat on 'signalling' for the whole
    // run with no error anywhere. Armed only once an offer exists, because a
    // host legitimately waits for a joiner for as long as it likes.
    // ⚠ AND IT IS PER LINK. One timer for the whole session would let a fourth
    // player whose ICE never comes up FAIL the session for the three who are
    // already playing. A link that cannot connect kills that link.
    // ---- RELAY MODE ---------------------------------------------------------
    _relayAllowed() {
      if (this._relayOff == null) {
        let off = false;
        try { off = !!global.NETPLAY_NO_RELAY; } catch (e) {}
        try { if (!off && global.location) off = new URLSearchParams(global.location.search).get('relay') === '0'; } catch (e) {}
        this._relayOff = off;
      }
      return !this._relayOff && !!this._sig && this.state !== 'closed';
    }

    // Seat this link on the signalling relay instead of losing it.
    _startRelay(L, why) {
      if (!this._relayAllowed() || !L || L.dead || L.relay) return false;
      // The host stashed the pairing challenge on the link at approve() time;
      // without it there is no per-link key and relaying would fall back to the
      // room key alone, which is a weaker guarantee than this file promises.
      const chal = this.isHost ? L.chal : this._chal;
      if (!chal) return false;
      L.relay = true;
      L.open = true;
      this.peerReady = true;
      this._disarmIce(L);
      // ⚠ A DYING PEER CONNECTION MUST NOT TAKE THE RELAYED LINK WITH IT. This
      // is the bug the first draft of relay mode shipped, and it presented as
      // "relay mode works but nothing ever crosses it".
      // The host builds its DataChannel eagerly in _link(), so closing the
      // failed RTCPeerConnection fired dc.onclose -> _linkGone(), which deleted
      // the very link relay mode had just seated. Only on the HOST, because a
      // guest never receives a channel when ICE fails — which is why one side
      // looked healthy and the diagnosis was not obvious.
      // Measured before the fix: host `links:[] relay.active:true`, receiving
      // 'lsr' after 'lsr' and dropping every one of them for want of a link, so
      // no pong ever came back, oneWayMs stayed null, and the guest's silence
      // watchdog eventually closed the room. Detach first, close second.
      try {
        if (L.pc) {
          L.pc.onconnectionstatechange = null;
          L.pc.oniceconnectionstatechange = null;
          L.pc.onicecandidate = null;
          L.pc.ondatachannel = null;
          L.pc.ontrack = null;
        }
        if (L.dc) { L.dc.onclose = null; L.dc.onmessage = null; L.dc.onopen = null; }
      } catch (e) {}
      try { L.dc && L.dc.close(); } catch (e) {}
      try { L.pc && L.pc.close(); } catch (e) {}
      L.dc = null;
      // _dc aliases the first link's channel for the pages and the save path;
      // leaving it pointing at a closed one would have _send() try it forever.
      if (this._dc && this._dc.readyState !== 'open') this._dc = this._firstOpenChannel();
      let n = 0;
      for (const K of this._links.values()) if (K.relay && !K.dead) n++;
      this.relay = {
        active: true, since: this.relay ? this.relay.since : Date.now(),
        why: why || null, peers: n,
        // Filled in by the first round trip. Null means "not measured yet" and
        // a page must render it as such, never as zero.
        oneWayMs: this.relay ? this.relay.oneWayMs : null,
        delayFrames: this.relay ? this.relay.delayFrames : null,
        path: this._sig ? this._sig.kind : null,
      };
      this._onPeerUp(L);
      this._emit('peer-joined', { peer: L.nonce, seated: this._links.size, relay: true });
      this._emit('relay', this.relayInfo());
      this._emit('warning', { detail: this.relayNotice(), peer: L.nonce, relay: true });
      this._status('connected', 'connected over a relay — slower than a direct link');
      this._emit('room', this.roomInfo());
      this._relayMeasure();
      return true;
    }

    // What a page should put on screen. One sentence, no jargon, and it never
    // claims a number it has not measured.
    relayNotice() {
      const r = this.relay;
      if (!r || !r.active) return null;
      const d = r.delayFrames;
      const w = r.oneWayMs;
      if (w == null || d == null) {
        return 'This room is on a relay: the two networks would not connect directly, '
             + 'so everything is going through a middleman. It works, but it is slower than a direct link.';
      }
      return 'This room is on a relay — the two networks would not connect directly. '
           + 'Messages take about ' + Math.round(w) + ' ms each way, so the controls run '
           + d + ' frames (' + Math.round(d * 1000 / 60) + ' ms) behind. It is playable, but it is not a direct link.';
    }
    relayInfo() {
      const r = this.relay;
      if (!r || !r.active) return null;
      return { active: true, path: r.path, peers: r.peers, oneWayMs: r.oneWayMs,
               delayFrames: r.delayFrames, sinceMs: Date.now() - r.since, notice: this.relayNotice(),
               stats: Object.assign({}, this._relayStats) };
    }

    // ---- the per-link key ---------------------------------------------------
    // Room key + the joiner's nonce + the pairing challenge. Both sides hold
    // all three: the guest by construction, the host because approve() stashed
    // the challenge on the link. See the privacy note above ICE_CONNECT_MS for
    // exactly what this does and does not defend against.
    async _relaySeal(L) {
      if (L.seal) return L.seal;
      const s = subtle();
      const { key } = await roomKey(this.code);
      const chal = this.isHost ? L.chal : this._chal;
      const who = this.isHost ? L.nonce : this._nonce;
      if (!s || !key || !chal) return null;
      try {
        const bits = await s.sign('HMAC', key, utf8('relay|' + who + '|' + chal));
        L.seal = await s.importKey('raw', bits, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
        return L.seal;
      } catch (e) { return null; }
    }

    // ⚠ COALESCED, BECAUSE A PUBLIC BROKER IS NOT A DATA CHANNEL. Lockstep
    // emits one 'ls' per frame per player; 60 publishes a second per player
    // into a shared free broker is both rude and unreliable. A relayed room
    // already carries an input delay far larger than this window, so batching
    // inside it costs nothing that has not already been paid.
    _relaySend(o) {
      if (!this._relayAllowed()) return;
      // Anything that is not per-frame goes immediately: a roster, a start, a
      // drop or a desync report is not something to sit on for 33 ms.
      // ⚠ AN 'ls' NO LONGER RIDES THE BATCH AT ALL. It is remembered in the
      // retransmission window (see the block above RELAY_REPAIR_MS) and the
      // window is what gets published — so the newest frame travels exactly as
      // it did before, and every recent frame travels with it. Keeping it in
      // both would double the wire cost to say the same thing twice.
      if (o && o.t === 'ls') { this._relayNote(o); this._relayArm(RELAY_BATCH_MS); return; }
      this._relayFlush([o]);
    }

    // How far back the window has to reach, in frames. A peer stalled at g
    // holds its partner to g+delay, and that partner has queued no further
    // than g+2*delay, so 2*delay covers every frame anyone can still want. The
    // margin is for the frames a delay RAISE backfills.
    _relayWinDepth() {
      const d = (this.ls && this.ls.delay) || this.delayFrames || 6;
      return Math.max(RELAY_WIN_MIN, Math.min(RELAY_WIN_MAX, 2 * (d | 0) + 12));
    }
    // Remember one frame of this console's OWN input. Stored as the encoded
    // items string so the run-length pass can compare frames with `===` and
    // the wire carries an identical run once.
    _relayNote(o) {
      if (!o || typeof o.f !== 'number' || !Array.isArray(o.i)) return;
      if (o.peer) this._relayWinPeer = o.peer;
      let s = null;
      try { s = JSON.stringify(o.i); } catch (e) { return; }
      this._relayWin.set(o.f | 0, s);
      const depth = this._relayWinDepth();
      let newest = -Infinity;
      for (const f of this._relayWin.keys()) if (f > newest) newest = f;
      const lo = newest - depth;
      for (const f of Array.from(this._relayWin.keys())) if (f < lo) this._relayWin.delete(f);
    }
    // [[startFrame, count, itemsJSON], ...] over contiguous frames whose input
    // is identical. A pad held across the window is ONE entry.
    _relayWindow() {
      if (!this._relayWin.size) return null;
      const fs = Array.from(this._relayWin.keys()).sort((a, b) => a - b);
      const v = [];
      let cur = null;
      for (const f of fs) {
        const s = this._relayWin.get(f);
        if (cur && f === cur[0] + cur[1] && s === cur[2]) { cur[1]++; continue; }
        cur = [f, 1, s]; v.push(cur);
      }
      return { p: this._relayWinPeer || null, v: v };
    }
    // Is there a room whose frames are still being exchanged? The repair
    // heartbeat runs only while there is, so it cannot outlive the session.
    _relayLive() {
      const s = this.ls && this.ls.state;
      return s === 'running' || s === 'stalled';
    }
    // One timer, earliest deadline wins: a fresh input must not have to wait
    // out a repair heartbeat that was armed first.
    _relayArm(ms) {
      const at = Date.now() + ms;
      if (this._relayTimer && this._relayTimerAt && this._relayTimerAt <= at) return;
      if (this._relayTimer) clearTimeout(this._relayTimer);
      this._relayTimerAt = at;
      this._relayTimer = setTimeout(() => {
        this._relayTimer = 0; this._relayTimerAt = 0; this._relayFlush();
      }, ms);
    }
    _relayFlush(extra) {
      if (this._relayTimer) { clearTimeout(this._relayTimer); this._relayTimer = 0; this._relayTimerAt = 0; }
      const batch = this._relayOut.length ? this._relayOut.splice(0) : [];
      if (extra) for (const e of extra) batch.push(e);
      const win = this._relayLive() ? this._relayWindow() : null;
      if (!batch.length && !win) return;
      for (const L of this._links.values()) {
        if (!L.relay || L.dead) continue;
        this._relayEmit(L, batch, win);
      }
      if (win) this._relayArm(RELAY_REPAIR_MS);
    }
    // ⚠ SERIALISED, AND THE SEQUENCE NUMBER IS TAKEN INSIDE THE CHAIN. Sealing
    // is async: the first draft incremented _relaySeq after an await, so two
    // sends could be numbered in one order and published in the other — and the
    // receiver's `q > prev` check would then DROP the later-numbered one, i.e.
    // silently eat a frame of input. Ordering is not optional on a path that
    // carries lockstep.
    _relayEmit(L, batch, win) {
      this._relayTx = (this._relayTx || Promise.resolve())
        .then(() => this._relayEmit1(L, batch, win)).catch(() => {});
    }
    async _relayEmit1(L, batch, win) {
      const seal = await this._relaySeal(L);
      if (!seal || !this._sig || L.dead) return;
      const s = subtle();
      const iv = randomBytes(12);
      const body = JSON.stringify(win ? { q: ++this._relaySeq, b: batch, w: win }
                                      : { q: ++this._relaySeq, b: batch });
      try {
        const ct = await s.encrypt({ name: 'AES-GCM', iv: iv }, seal, utf8(body));
        this._sig.send({ t: 'lsr', n: this._nonce, to: this.isHost ? L.nonce : null,
                         iv: toHex(iv), d: toHex(new Uint8Array(ct)) });
        this._relayStats.pub++; this._relayStats.items += batch.length;
      } catch (e) { this._relayStats.sendFail++; }
    }

    // ⚠ THE ADMISSION GATE APPLIES HERE TOO, AND IT HAS TO BE CHECKED FIRST.
    // A relayed frame arrives on a topic anyone can publish to, so unlike a
    // DataChannel — which cannot exist before approval — this path has to prove
    // for itself that the sender is a seated player. It does so twice: the
    // per-link key (which an unapproved caller never receives the ingredients
    // for) and the approval check below.
    async _onRelay(m) {
      if (!m || !m.iv || !m.d) return;
      let L = null;
      if (this.isHost) {
        L = m.n ? this._links.get(m.n) : null;
        if (!L || !L.approved || !L.relay) { this._relayStats.dropAuth++; return; }
      } else {
        if (m.to && m.to !== this._nonce) return;
        if (!this._approved) { this._relayStats.dropAuth++; return; }
        L = this._links.get(HOST_LINK);
        if (!L || !L.relay) { this._relayStats.dropAuth++; return; }
      }
      const seal = await this._relaySeal(L);
      const s = subtle();
      if (!seal || !s) { this._relayStats.dropDecrypt++; return; }
      let obj = null;
      try {
        const pt = await s.decrypt({ name: 'AES-GCM', iv: fromHex(m.iv) }, seal, fromHex(m.d));
        obj = JSON.parse(new TextDecoder().decode(pt));
      } catch (e) { this._relayStats.dropDecrypt++; return; }   // not from the peer this link belongs to
      if (!obj || !Array.isArray(obj.b)) { this._relayStats.dropDecrypt++; return; }
      // Replays and reorderings are dropped rather than replayed into a core.
      const prev = this._relayRx.get(L.nonce);
      if (prev != null && !(obj.q > prev)) { this._relayStats.dropSeq++; return; }
      // ⚠ THE SEQUENCE IS DENSE ON THE SENDER, so a jump is a batch that never
      // arrived. Counted separately from dropSeq: one is "the broker reordered
      // and we refused it", the other is "the broker lost it". They have
      // different fixes and conflating them cost a wrong diagnosis once.
      if (prev != null && obj.q > prev + 1) this._relayStats.gapSeq += (obj.q - prev - 1);
      this._relayRx.set(L.nonce, obj.q);
      this._relayStats.rxOk++; this._relayStats.rxItems += obj.b.length;
      // ⚠ THE ONLY LIVENESS SIGNAL A RELAYED LINK HAS. There is no socket to
      // drop and the RTCPeerConnection was closed when relay mode engaged, so
      // without this a player who closed their tab would stay on the roster
      // forever and lockstep would stall on them with no explanation.
      L.lastHeard = Date.now();
      for (const one of obj.b) {
        if (one && one.t === 'rping') { this._relayEmit(L, [{ t: 'rpong', ts: one.ts }], null); continue; }
        if (one && one.t === 'rpong') { this._relayHeard(one.ts); continue; }
        this._onData(one, L);
      }
      // ---- the retransmission window ----------------------------------------
      // Expanded back into the ordinary 'ls' messages it was built from, so
      // every check the engine makes about an input — the port-ownership rule,
      // the too-old cutoff, the accounting — applies exactly as it does on a
      // direct link. Nothing here reaches past receive(); a repeat of a frame
      // already held is the same bytes and changes nothing.
      this._relayApplyWindow(obj.w, L);
    }
    _relayApplyWindow(w, L) {
      if (!w || !Array.isArray(w.v)) return 0;
      let n = 0;
      for (const run of w.v) {
        if (!Array.isArray(run) || run.length < 3) continue;
        const start = run[0] | 0, count = run[1] | 0;
        if (!(count > 0) || count > RELAY_WIN_MAX * 4) continue;
        let items = null;
        try { items = JSON.parse(run[2]); } catch (e) { continue; }
        if (!Array.isArray(items)) continue;
        for (let k = 0; k < count; k++) {
          this._onData({ t: 'ls', f: start + k, i: items, peer: w.p || undefined }, L);
          n++;
        }
      }
      return n;
    }

    // ---- how far behind this room actually is -------------------------------
    _relayMeasure() {
      if (this._relayPing) return;
      const beat = () => {
        if (!this.relay || !this.relay.active || this.state === 'closed') {
          clearInterval(this._relayPing); this._relayPing = 0; return;
        }
        const now = Date.now();
        for (const L of Array.from(this._links.values())) {
          if (!L.relay || L.dead) continue;
          if (L.lastHeard == null) { L.lastHeard = now; continue; }
          if (now - L.lastHeard > RELAY_DEAD_MS) this._linkGone(L, 'relay-silent');
        }
        this._relayFlush([{ t: 'rping', ts: now }]);
      };
      beat();
      this._relayPing = setInterval(beat, RELAY_PING_MS);
    }
    _relayHeard(ts) {
      const rtt = Date.now() - ts;
      if (!(rtt >= 0) || !this.relay) return;
      const oneWay = rtt / 2;
      // Smoothed, because one sample off a public broker is noise.
      this.relay.oneWayMs = this.relay.oneWayMs == null ? oneWay : (this.relay.oneWayMs * 0.7 + oneWay * 0.3);
      // ⚠ THE DELAY IS DERIVED FROM THE MEASUREMENT, NOT GUESSED. My input for
      // frame F+delay has to be in your hands before you run F+delay, so the
      // delay must cover one-way time, plus a margin for jitter.
      const frameMs = 1000 / 60;
      const want = Math.min(RELAY_MAX_DELAY, Math.ceil(this.relay.oneWayMs / frameMs) + 3);
      const before = this.relay.delayFrames;
      this.relay.delayFrames = Math.max(this.delayFrames || 0, want, before || 0);
      // ⚠ ONLY BEFORE THE BARRIER. Every machine must run the same delay or the
      // room desyncs by construction, and there is no protocol for changing it
      // mid-game. After the start it is REPORTED and not applied.
      const running = this.ls && (this.ls.state === 'running' || this.ls.state === 'stalled');
      if (!running && this.isHost) {
        // A rollback room's first window covers the measured one-way path.
        if (this.ls) this.ls.rbHintMs = Math.max(+this.ls.rbHintMs || 0, this.relay.oneWayMs || 0);
        this.delayFrames = this.relay.delayFrames;
        if (this._lsOpts) this._lsOpts.delay = this.relay.delayFrames;
        if (this.ls) this.ls.delay = this.relay.delayFrames;
      }
      if (before !== this.relay.delayFrames) {
        this._emit('relay', this.relayInfo());
        this._emit('room', this.roomInfo());
      }
    }

    _armIce(L) {
      if (!L || L.iceTimer) return;
      L.iceTimer = setTimeout(() => {
        L.iceTimer = 0;
        const pc = L.pc;
        if (!pc || pc.connectionState === 'connected' || L.open) return;
        const st = pc.connectionState + '/' + pc.iceConnectionState;
        const msg = 'the two browsers agreed on a connection but could not open one (' + st
          + ') — one of these networks is blocking direct peer-to-peer traffic. '
          + 'Playing across it needs a relay server; see Netplay.useRelay().';
        this.lastError = msg;
        // ⚠ A DEAD DIRECT PATH IS NO LONGER A DEAD ROOM. The pads fit down the
        // signalling relay; take it, tell the page what it costs, and keep the
        // diagnosis above as the REASON rather than as the ending.
        if (this._startRelay(L, msg)) return;
        // Only the LAST link failing is a failed session. While anyone else is
        // still connected the room plays on and this is a warning about one seat.
        if (this._links.size <= 1 && this.state !== 'connected') this._status('failed', msg);
        else this._emit('warning', { detail: msg, peer: L.nonce });
        this._linkGone(L, 'ice-timeout');
      }, ICE_CONNECT_MS);
    }
    _disarmIce(L) { if (L && L.iceTimer) { clearTimeout(L.iceTimer); L.iceTimer = 0; } }
    // A link in WebRTC's transient 'disconnected' state gets this long to come
    // back before it is treated as gone. See pc.onconnectionstatechange.
    _armDisconnectGrace(L) {
      if (!L || L.dead || L.graceTimer) return;
      this._emit('warning', { detail: 'the link to a player blipped — giving it ' + (DISCONNECT_GRACE_MS / 1000) + ' s to come back', peer: L.nonce });
      L.graceTimer = setTimeout(() => {
        L.graceTimer = 0;
        const pc = L.pc;
        if (!pc || pc.connectionState === 'connected' || pc.connectionState === 'connecting') return;
        this._linkGone(L, 'disconnected');
      }, DISCONNECT_GRACE_MS);
    }
    _clearDisconnectGrace(L) { if (L && L.graceTimer) { clearTimeout(L.graceTimer); L.graceTimer = 0; } }

    // GUEST: knock, and keep knocking. The host answers a hello with a
    // challenge; until then there is nothing to answer.
    // ⚠ IT HAS TO REPEAT. The host no longer broadcasts anything at start(), so
    // a guest whose first hello was sent before the host existed — the ordinary
    // case on BroadcastChannel, and after a signalling reconnect on PeerJS —
    // would otherwise wait forever. A repeat with the same nonce is idempotent:
    // the host re-sends the SAME challenge and the guest ignores it.
    _sendHello() {
      const send = () => {
        if (!this._sig || this._approved) return;
        if (this.state === 'closed' || this.state === 'failed') return;
        // A guest knocking to REJOIN a game stops once its engine has given up
        // (its stall budget: it is not coming back), and says the room is over.
        if (this._rejoining && this.ls && ['failed', 'ended', 'desync'].indexOf(this.ls.state) >= 0) {
          this._rejoining = false;
          this._status('closed', 'could not get back into the room before the game gave up waiting');
          this._emit('close');
          return;
        }
        try { this._sig.send({ t: 'hello', proto: PROTO, game: this.game, n: this._nonce, inc: this._inc }); } catch (e) {}
      };
      send();
      if (this._helloTimer) return;
      this._helloTimer = setInterval(() => {
        if (this._approved || this.state === 'connected' || this.state === 'closed' || this.state === 'failed') {
          clearInterval(this._helloTimer); this._helloTimer = 0; return;
        }
        send();
      }, 1500);
    }

    async _onSignal(m) {
      // ⚠ NO `if (!this._pc) return` HERE ANY MORE. The host has no peer
      // connection until it approves somebody, and that guard would have made it
      // deaf to the very hello it is waiting for.
      const pc = this.isHost ? null : (this._links.get(HOST_LINK) || {}).pc;
      try {
        // ---- ADMISSION: hello -> ready -> join -> (a human) -> offer --------
        if (m.t === 'hello' && this.isHost) {
          if (!m.n) return;
          // A caller who is already in is knocking again — its hello retry
          // simply crossed the offer. Idempotent, and never a second prompt.
          // ⚠ UNLESS THE INCARNATION CHANGED, IN WHICH CASE IT IS NOT A RETRY —
          // IT IS THE SAME PERSON ON A NEW PAGE. This `return` used to be
          // unconditional, and it is one half of the deadlock the user
          // photographed: a phone whose tab was discarded (or which went round
          // the room hand-off's own location.replace) comes back and knocks,
          // and a host still holding the dead link answered NOTHING, forever.
          // The other half is that the host might not have noticed the death at
          // all — a DataChannel close is not delivered when a page is killed
          // rather than closed — so the corpse is torn down HERE, on evidence
          // from the peer itself, rather than waiting on a watchdog.
          // ⚠ THE SEAT IS KEPT. Nothing has run a frame (a room that has
          // started refuses a hello a few lines below), so the returning player
          // takes back the SAME maple port and every other peer's roster is
          // unchanged. Freeing it would hand their character to somebody else.
          const running = !!(this.ls && (this.ls.state === 'running' || this.ls.state === 'stalled'));
          // A known player, seated in a room that can take them back.
          const back = running && this._known.has(m.n) && this.ls.roster.indexOf(m.n) >= 0 && this._rejoinableRoom();
          if (this._links.has(m.n)) {
            const old = this._links.get(m.n);
            // ⚠ MID-GAME, A KNOCK FROM A PLAYER WHOSE LINK THIS HOST STILL HOLDS
            // BUT CANNOT USE (it died and the disconnect grace has not run out)
            // is the same person coming back: tear the corpse down — keeping the
            // seat; the engine has already dropped their controller, or will —
            // and let them in.
            const usable = old.open && old.dc && old.dc.readyState === 'open';
            if (!(back && !usable) && (!m.inc || old.inc === m.inc)) return;
            this._status('signalling', 'a player\'s page came back — reconnecting them to their seat');
            this._linkGone(old, back ? 'peer-rejoining' : 'peer-reloaded', true);
          }
          // ⚠ THE ROOM CLOSES AT THE CONSOLE'S PORT COUNT, NOT AT ONE.
          // This used to read `if (this._approved) return denied('that session
          // has ended')` — a single latch that made the FIRST approval the last
          // one, so the room was two seats wearing four-player clothes. What
          // genuinely cannot happen is seating somebody AFTER frame 0: every
          // machine plugs its maple devices inside retro_load_game, so the seat
          // count has to be final before the disc loads. Both refusals say
          // which one it is, because "full" and "already started" are different
          // things for the person holding the code.
          // ⚠ A ROOM THAT HAS STARTED SEATS NOBODY NEW — but a known player whose
          // link died is not new: their seat is still theirs (the roster never
          // changes mid-game), and an adaptive rollback room takes them back
          // (Lockstep.rejoinPeer). Only they are let through.
          if (running && !back) {
            return this._sig.send({ t: 'denied', to: m.n,
              why: this._known.has(m.n) && this.ls.roster.indexOf(m.n) >= 0
                ? 'this room is running with input delay, which cannot take a player back mid-game — ask for a new code'
                : 'this room has already started — the controllers were plugged in when the disc loaded, so ask for a new code' });
          }
          if (this._links.size >= this.maxPeers) {
            return this._sig.send({ t: 'denied', to: m.n,
              why: 'this room is full — the console has ' + this.portCount + ' controller ports' });
          }
          if (m.proto !== PROTO) return this._sig.send({ t: 'denied', to: m.n, why: 'version mismatch' });
          // The game check moves here so a mismatched disc is refused BEFORE a
          // human is bothered, and with the same wording it always had.
          if (m.game && this.game && m.game !== this.game) {
            return this._sig.send({ t: 'denied', to: m.n, why: 'the other player is on ' + this.game });
          }
          // ⚠ DO NOT REPLACE A REQUEST SOMEBODY IS LOOKING AT. Swapping the
          // pending joiner while the prompt is up is how an Allow meant for one
          // person lands on another.
          if (this._pending && this._pending.nonce !== m.n) return this._sig.send({ t: 'busy', to: m.n });
          if (!this._pending) this._pending = { nonce: m.n, chal: randomHex(16), proven: false, checking: false, sas: null, inc: m.inc || null };
          const p = this._pending;
          // A retry from the SAME person on a NEWER page updates the record
          // rather than being ignored: whichever incarnation ends up approved
          // is the one the link is stamped with, and the stamp is what tells a
          // later hello whether it is a retry or another reconnect.
          if (m.inc && p.inc !== m.inc) p.inc = m.inc;
          // The host proves it holds the room key too, over the GUEST's nonce,
          // so a squatter who took the broker id cannot impersonate a host.
          const hp = await mac(this.code, 'host|' + m.n + '|' + p.chal);
          return this._sig.send({ t: 'ready', to: m.n, chal: p.chal, hp: hp, proto: PROTO, game: this.game });
        }
        if (m.t === 'ready' && !this.isHost) {
          if (m.to !== this._nonce) return;
          if (this._joinSent && m.chal === this._chal) return;      // a repeat
          if (m.proto !== PROTO) { this.lastError = 'version mismatch'; return this._status('failed', this.lastError); }
          if (m.game && this.game && m.game !== this.game) {
            this.lastError = 'the other player is on ' + m.game;
            return this._status('failed', this.lastError);
          }
          // Set before the awaits: two 'ready' messages can be in flight.
          this._joinSent = true;
          this._chal = m.chal;
          const want = await mac(this.code, 'host|' + this._nonce + '|' + m.chal);
          if (want && !sameMac(want, m.hp || '')) {
            this.lastError = 'the other end could not prove it knows the code';
            return this._status('failed', this.lastError);
          }
          const proof = await mac(this.code, 'join|' + this._nonce + '|' + m.chal);
          this.sas = await sasFor(this.code, this._nonce, m.chal);
          // ⚠ NAME THE CHALLENGE BEING ANSWERED. Two admissions can be in
          // flight when a page reloads twice in quick succession, and a `join`
          // computed over a SUPERSEDED challenge then reads to the host as a
          // caller who does not know the room key — it logged "a caller was
          // refused: bad proof" and cleared the pending request of the live
          // page that was knocking beside it. Echoing the challenge lets the
          // host drop a stale answer instead of mistaking it for an attack. It
          // is not a secret: the host sent it in the clear a moment ago.
          this._sig.send({ t: 'join', n: this._nonce, proof: proof, chal: m.chal });
          this._status('signalling', 'waiting for the host to let you in');
          this._showNotice();
          return;
        }
        if (m.t === 'join' && this.isHost) {
          const p = this._pending;
          if (!p || p.nonce !== m.n || p.proven || p.checking) return;
          // An answer to a challenge this host has already replaced is stale,
          // not hostile — see the note on the guest's send.
          if (m.chal && m.chal !== p.chal) return;
          p.checking = true;
          const want = await mac(this.code, 'join|' + m.n + '|' + p.chal);
          p.checking = false;
          if (want && !sameMac(want, m.proof || '')) {
            // Someone reached the broker id without the code. They never get as
            // far as the human.
            this.lastError = 'a caller failed the code check';
            this._emit('reject', { nonce: m.n, why: 'bad proof' });
            this._pending = null;
            return;
          }
          p.proven = true;
          p.sas = this.sas = await sasFor(this.code, m.n, p.chal);
          return this._ask(p);
        }
        if (m.t === 'denied' && !this.isHost) {
          if (m.to && m.to !== this._nonce) return;
          if (this._helloTimer) { clearInterval(this._helloTimer); this._helloTimer = 0; }
          this._closeNotice();
          this.lastError = m.why || 'the host did not let you in';
          return this._status('failed', this.lastError);
        }
        if (m.t === 'busy' && !this.isHost) {
          if (m.to && m.to !== this._nonce) return;
          return this._status('signalling', 'the host is already talking to someone else');
        }
        if (m.t === 'offer' && !this.isHost) {
          // ⚠ ADDRESSED. An offer for another joiner's nonce is not this
          // session's to answer — see the residual note at the top of the file.
          if (m.to && m.to !== this._nonce) return;
          // ⚠ THE OFFER ARRIVES MORE THAN ONCE BY DESIGN: the host re-sends one
          // on a repeated approval so a guest that was not listening yet
          // still gets one. Answering the duplicate throws
          //   Failed to set local answer sdp: Called in wrong state: stable
          // which surfaced as a 'failed' status on a session that then connected
          // anyway — an alarming log line for a working pairing, and a real
          // failure under other timing. Answer exactly once.
          // Set the flag BEFORE the first await. _onSignal is async, so two
          // offers arriving together both reach the check and both pass it if the
          // flag is only set after setRemoteDescription resolves — which is
          // exactly what still produced the wrong-state error after the first
          // attempt at this guard.
          if (this._answered) return;
          this._answered = true;
          // A mismatched game is a guaranteed desync, so refuse the pairing
          // rather than let two different discs "connect" and diverge.
          if (m.game && this.game && m.game !== this.game) {
            this._answered = false;
            this.lastError = 'the other player is on ' + m.game;
            return this._status('failed', this.lastError);
          }
          if (m.proto !== PROTO) { this._answered = false; this.lastError = 'version mismatch'; return this._status('failed', this.lastError); }
          this._approved = true;          // the host let this guest in
          if (this._helloTimer) { clearInterval(this._helloTimer); this._helloTimer = 0; }
          this._closeNotice();
          // ⚠ TAKE THE PEER CONNECTION FROM THE LINK, NOT FROM THE SNAPSHOT
          // AT THE TOP OF THIS FUNCTION. `pc` was read as
          // `(this._links.get(HOST_LINK) || {}).pc` before any of this ran, so
          // on a RECONNECT — where _linkGone has deleted that link — it is
          // undefined and the very next line throws into the catch, reporting
          // a 'failed' session for a host that was answering correctly. _link()
          // builds a fresh RTCPeerConnection when there is none, which is
          // exactly what a returning guest needs.
          const GL = this._link(HOST_LINK);
          const gpc = GL.pc;
          await gpc.setRemoteDescription({ type: 'offer', sdp: m.sdp });
          const ans = await gpc.createAnswer();
          await gpc.setLocalDescription(ans);
          this._armIce(GL);
          this._sig.send({ t: 'answer', sdp: gpc.localDescription.sdp, n: this._nonce });
        } else if (m.t === 'answer' && this.isHost) {
          // ⚠ ROUTED TO THE LINK THAT NONCE OWNS. With one peer connection this
          // only had to check that the answer came from the approved joiner;
          // with several it must also land on the right one, or two players'
          // negotiations cross and neither connects.
          const L = m.n ? this._links.get(m.n) : null;
          if (!L || !L.approved || !L.pc) return;
          // ⚠ LATCHED BEFORE THE AWAIT, for exactly the reason spelled out on
          // the guest's `_answered` above: _onSignal is async, so two answers
          // arriving together BOTH pass a check that only reads
          // currentRemoteDescription, and the second setRemoteDescription
          // throws "Called in wrong state: stable" into the catch below — which
          // fails a session that was connecting fine. `answered` has been on
          // the link object since it was written and was never read; this is
          // what it was for.
          if (L.answered || L.pc.currentRemoteDescription) return;
          L.answered = true;
          try { await L.pc.setRemoteDescription({ type: 'answer', sdp: m.sdp }); }
          catch (e) { L.answered = false; throw e; }
        } else if (m.t === 'lsr') {
          // ⚠ CHAINED. The transport hands messages up in order, but _onSignal
          // is async and nobody awaits it, so that guarantee stops at the
          // callback — two relayed batches could be unsealed concurrently and
          // applied backwards, and the sequence check would then discard the
          // one that lost the race. Frames of input are not something to drop
          // to a scheduling accident.
          this._relayRxChain = (this._relayRxChain || Promise.resolve())
            .then(() => this._onRelay(m)).catch(() => {});
          return;
        } else if (m.t === 'ice') {
          if (this.isHost) {
            // An unapproved caller has no negotiation in flight, so it has no
            // business adding candidates to one — and a candidate for one
            // player's link must never be applied to another's.
            const L = m.n ? this._links.get(m.n) : null;
            if (!L || !L.approved || !L.pc) return;
            try { await L.pc.addIceCandidate(m.c); } catch (e) {}
            return;
          }
          if (m.to && m.to !== this._nonce) return;
          if (!pc) return;
          try { await pc.addIceCandidate(m.c); } catch (e) {}
        }
      } catch (e) { this.lastError = e.message; this._status('failed', e.message); }
    }

    // ---- ASKING A HUMAN --------------------------------------------------
    // A page that wants its own dialog does on('join-request', req => …) and
    // calls req.approve() / req.deny(). A page that does not gets the built-in
    // one, so the SEVEN pages that host a game did not each have to grow a
    // prompt — and the two that already ship (dreamcast.html, gamecube.html)
    // did not have to be touched at all.
    _ask(p) {
      // ⚠ A PLAYER A HUMAN ALREADY LET IN DOES NOT GET ASKED ABOUT TWICE.
      // This is the recovery half of the reload fix. A phone that reloads (or
      // is discarded and restored) knocks again with the SAME stable nonce and
      // a FRESH proof of the room code; making that wait for a second Allow
      // strands it, because the person holding the host is looking at a game,
      // not at a dialog — which is exactly the state the user photographed,
      // with the host saying "this room is empty again, waiting for them to
      // rejoin" and nothing on either screen able to finish the sentence.
      // Nothing is weakened: the caller still proved it holds the code (that
      // happens before this is reached, in the 'join' branch), the identity is
      // one a human approved IN THIS SESSION, and a stranger who has never been
      // admitted still raises the dialog exactly as before.
      // ⚠ NOT VIA _emit('warning'). dreamcast.html maps 'warning' straight onto
      // netSetFault(), which raises the red CANNOT CONNECT banner — putting it
      // over a room that is RECOVERING would be a false alarm of exactly the
      // class this panel has already been fixed twice to stop raising.
      if (this._known.has(p.nonce)) {
        this._status('signalling', 'a player who was already in this room is reconnecting');
        return this.approve(p.nonce);
      }
      if (this._quietUntil && Date.now() < this._quietUntil) {
        return this.deny(p.nonce, 'too many join attempts — try again in a minute');
      }
      const req = {
        id: p.nonce,
        sas: p.sas,                       // the 4-character confirmation code
        game: this.game,
        code: this.code,
        at: Date.now(),
        approve: () => this.approve(p.nonce),
        deny: (why) => this.deny(p.nonce, why),
      };
      this._status('signalling', 'someone is asking to join');
      // A stale prompt on a machine nobody is sitting at must not stay open
      // forever holding a slot; it closes as a refusal, which is the safe way
      // for it to fail.
      clearTimeout(this._promptTimer);
      this._promptTimer = setTimeout(() => {
        // ⚠ NOT `&& !this._approved`. In a room the host has usually already
        // approved somebody by the time the next person knocks, and that
        // condition would have left every prompt after the first one open
        // forever — a stale dialog holding the one prompt slot, so nobody else
        // could even ask. approve() clears _pending, which is the real test.
        if (this._pending && this._pending.nonce === p.nonce) {
          this.deny(p.nonce, 'nobody answered the request');
        }
      }, 120000);
      const hs = this._handlers['join-request'] || [];
      if (hs.length) return this._emit('join-request', req);
      if (this._ui && typeof document !== 'undefined') return this._promptUI(req);
      // No handler and no way to draw one: REFUSE. Failing open here would put
      // the hole straight back.
      return this.deny(p.nonce, 'this host cannot ask anyone for permission');
    }

    // THE MOMENT THE GAME BECOMES VISIBLE. Everything before this point is a
    // negotiation about whether it should.
    // ⚠ EACH JOINER GETS ITS OWN ADMISSION AND ITS OWN CONNECTION.
    // `|| this._approved` used to sit in the guard below, which meant the first
    // Allow was the last one this session could ever grant — the four-port
    // console could seat two people. What is kept, exactly as it was, is that
    // NOTHING is published until a human says yes, and that only ONE request is
    // ever pending at a time (a second caller is told 'busy'), because an Allow
    // meant for one person must not land on whoever knocked last.
    async approve(id) {
      const p = this._pending;
      if (!this.isHost || !p || !p.proven) return false;
      if (id && id !== p.nonce) return false;
      if (this._links.has(p.nonce)) return false;
      clearTimeout(this._promptTimer); this._promptTimer = 0;
      this._closePrompt();
      const L = this._link(p.nonce);
      L.approved = true;
      L.inc = p.inc || null;                 // WHICH page load this link belongs to
      this._known.add(p.nonce);              // a human said yes to this identity
      // ⚠ KEPT BECAUSE _pending IS CLEARED THREE LINES DOWN. The challenge is
      // half the per-link relay key (see _relaySeal), and it is the half that
      // makes that key mean "this pairing" rather than "anyone with the code".
      L.chal = p.chal;
      this._approved = true;                 // "somebody is in" — what remotePad()/sendSave() gate on
      // The prompt slot frees the moment this one is decided, so the NEXT
      // player can knock. It is a queue of one, not a cap of one.
      this._pending = null;
      this._syncCapacity();
      try {
        const offer = await L.pc.createOffer();
        await L.pc.setLocalDescription(offer);      // ICE gathering starts HERE
        this._armIce(L);
        this._sig.send({ t: 'offer', to: L.nonce, sdp: L.pc.localDescription.sdp,
                         proto: PROTO, game: this.game });
        this._status('signalling', this._links.size >= this.maxPeers
          ? 'allowed — connecting (the room is now full)'
          : 'allowed — connecting');
        return true;
      } catch (e) {
        this._linkGone(L, 'offer-failed');
        this._approved = this._links.size > 0;
        this.lastError = e.message;
        if (!this._links.size) this._status('failed', e.message);
        return false;
      }
    }

    // ⚠ A FULL ROOM DELIBERATELY DOES NOT SHUT THE SIGNALLING DOOR, and this
    // is not an oversight — it is a bug I wrote and then measured.
    // The obvious move is `_sig.lock()` once every port is taken. Doing that
    // closes the fourth caller's socket before its hello is even read, so the
    // host never gets to say "this room is full": the caller knocks 30 times
    // over ~36 s and is then told "one of these networks is blocking direct
    // peer-to-peer traffic", which is a CONFIDENTLY WRONG diagnosis of a room
    // that is simply full. Measured in tools/netplay_room_test.mjs, arm
    // `the-N+1th-caller-is-REFUSED-and-told-why`: with the lock in, the fifth
    // player sat at state="signalling" with lastError=null.
    // A refusal nobody can hear is worse than no refusal, so the socket stays
    // open and the hello handler answers it. The transport keeps lock() — the
    // hazard it was written for (a late caller being handed an offer approved
    // for someone else) is now removed by the nonce-to-socket binding instead.
    _syncCapacity() { this._emit('room', this.roomInfo()); }

    deny(id, why) {
      const p = this._pending;
      if (!this.isHost || !p) return false;
      if (id && id !== p.nonce) return false;
      clearTimeout(this._promptTimer); this._promptTimer = 0;
      this._closePrompt();
      try { this._sig.send({ t: 'denied', to: p.nonce, why: why || 'the host declined' }); } catch (e) {}
      this._pending = null;
      this._denials++;
      // A refused caller can mint a new nonce and knock again. After a few, stop
      // putting a dialog in front of the person playing.
      if (this._denials >= 3) this._quietUntil = Date.now() + 60000;
      this._status('signalling', 'waiting for someone to ask to join');
      return true;
    }

    // ⚠ A FULLSCREEN HOST WOULD NEVER SEE A DIALOG ON document.body. All seven
    // pages that host a game call requestFullscreen somewhere, and while an
    // element is fullscreen the browser renders ONLY that element's subtree —
    // so a prompt appended to <body> is invisible, the person playing is never
    // asked, and the invited player is auto-denied two minutes later with no
    // explanation on either side. Mount into the fullscreen element when there
    // is one, and follow it when it changes.
    _mountTarget() {
      const fs = (typeof document !== 'undefined') &&
        (document.fullscreenElement || document.webkitFullscreenElement);
      return fs || document.body || document.documentElement;
    }
    _followFullscreen(node) {
      const move = () => {
        if (!node.isConnected && !this._prompt && !this._notice) return;
        const t = this._mountTarget();
        if (t && node.parentNode !== t) { try { t.appendChild(node); } catch (e) {} }
      };
      ['fullscreenchange', 'webkitfullscreenchange'].forEach((ev) => document.addEventListener(ev, move));
      return () => ['fullscreenchange', 'webkitfullscreenchange'].forEach((ev) => document.removeEventListener(ev, move));
    }

    // The built-in dialog. Deliberately plain DOM with inline styles: it has to
    // land on top of seven different pages, one of which is a fullscreen
    // emulator, without depending on any of their stylesheets.
    _promptUI(req) {
      try {
        this._closePrompt();
        const wrap = document.createElement('div');
        wrap.id = 'npApprove';
        wrap.setAttribute('role', 'dialog');
        wrap.setAttribute('aria-modal', 'true');
        wrap.style.cssText = 'position:fixed;inset:0;z-index:2147483600;display:flex;align-items:center;' +
          'justify-content:center;background:rgba(0,0,0,.72);font:14px/1.45 -apple-system,BlinkMacSystemFont,' +
          '"Segoe UI",Roboto,sans-serif;color:#e8e8e8';
        const card = document.createElement('div');
        card.style.cssText = 'background:#15171a;border:1px solid #556;border-radius:14px;padding:22px;' +
          'width:min(420px,92vw);box-shadow:0 12px 48px rgba(0,0,0,.6)';
        const h = document.createElement('h3');
        h.textContent = 'Someone wants to join your game';
        h.style.cssText = 'margin:0 0 6px;font-size:19px;color:#fff';
        const sub = document.createElement('p');
        sub.style.cssText = 'margin:0 0 12px;color:#9aa;font-size:13px';
        sub.textContent = 'They know the code for "' + (req.game || 'this game') + '". Until you allow it they ' +
          'cannot see your screen, hear your game, press anything or receive your save.';
        const sas = document.createElement('div');
        sas.id = 'npApproveSas';
        sas.setAttribute('data-sas', req.sas || '');
        sas.style.cssText = 'font:700 26px/1.1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:6px;' +
          'text-align:center;background:#0e1013;border:1px dashed #4a4;border-radius:10px;padding:12px;' +
          'color:#9f9;margin:0 0 8px';
        sas.textContent = req.sas || '— — — —';
        const sasNote = document.createElement('p');
        sasNote.style.cssText = 'margin:0 0 14px;color:#9aa;font-size:12.5px;text-align:center';
        sasNote.textContent = req.sas
          ? 'Confirmation code. The person joining sees the same four characters — ask them.'
          : 'This browser cannot compute a confirmation code (no secure context).';
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:10px';
        const mk = (id, label, bg) => {
          const b = document.createElement('button');
          b.type = 'button'; b.id = id; b.textContent = label;
          b.style.cssText = 'flex:1;min-height:44px;border-radius:9px;border:0;color:#fff;font-weight:600;' +
            'font-size:15px;cursor:pointer;background:' + bg;
          return b;
        };
        const no = mk('npApproveDeny', 'Deny', '#3a3d42');
        const yes = mk('npApproveAllow', 'Allow', '#2b7cd3');
        no.onclick = () => this.deny(req.id, 'the host declined');
        yes.onclick = () => this.approve(req.id);
        row.append(no, yes);
        card.append(h, sub, sas, sasNote, row);
        wrap.appendChild(card);
        // The host page's own key handlers own W/A/S/D and Enter for the game;
        // a dialog that let them through would drive the emulator while the
        // person is deciding.
        wrap.addEventListener('keydown', (e) => e.stopPropagation(), true);
        this._mountTarget().appendChild(wrap);
        this._promptUnfollow = this._followFullscreen(wrap);
        try { yes.focus(); } catch (e) {}
        this._prompt = wrap;
      } catch (e) { this.deny(req.id, 'the host could not show the request'); }
    }
    _closePrompt() {
      const w = this._prompt; this._prompt = null;
      if (this._promptUnfollow) { try { this._promptUnfollow(); } catch (e) {} this._promptUnfollow = null; }
      if (w) { try { w.remove(); } catch (e) {} }
    }

    // GUEST SIDE: say what is being waited for, and show the same confirmation
    // code the host is looking at. A silent wait reads as a broken code.
    _showNotice() {
      if (!this._ui || typeof document === 'undefined' || this._notice) return;
      try {
        const n = document.createElement('div');
        n.id = 'npWaiting';
        n.setAttribute('data-sas', this.sas || '');
        n.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);top:12px;z-index:2147483600;' +
          'max-width:92vw;padding:10px 14px;border-radius:10px;border:1px solid #556;background:rgba(16,18,22,.94);' +
          'color:#dde;font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;text-align:center';
        n.textContent = this.sas
          ? 'Waiting for the host to let you in — confirmation code ' + this.sas
          : 'Waiting for the host to let you in…';
        this._mountTarget().appendChild(n);
        this._noticeUnfollow = this._followFullscreen(n);
        this._notice = n;
      } catch (e) {}
    }
    _closeNotice() {
      const n = this._notice; this._notice = null;
      if (this._noticeUnfollow) { try { this._noticeUnfollow(); } catch (e) {} this._noticeUnfollow = null; }
      if (n) { try { n.remove(); } catch (e) {} }
    }

    _bindChannel(dc, L) {
      L = L || this._links.get(HOST_LINK) || { nonce: HOST_LINK, approved: !this.isHost };
      L.dc = dc;
      if (!this._dc) this._dc = dc;
      dc.onopen = () => {
        L.open = true; this.peerReady = true;
        this._disarmIce(L);
        if (!this._dc || this._dc.readyState !== 'open') this._dc = dc;
        try { dc.send(JSON.stringify({ t: 'lscap', u: 1 })); } catch (e) {}
        this._onPeerUp(L);
        this._status('connected');
        this._emit('peer-joined', { peer: L.nonce, seated: this._links.size });
      };
      // ⚠ A CLOSING DATACHANNEL MUST NOT EVICT A LINK THE RELAY IS CARRYING.
      // This read `dc.onclose = () => this._linkGone(L, 'channel-closed')`, and
      // _linkGone tears down the WHOLE link — deletes it from this._links, drops
      // its pads, closes the peer connection. With fan-out there are TWO
      // carriers per link (this DataChannel and the relay), so the LOSING
      // carrier's close killed the peer the WINNING relay was still carrying.
      //
      // A cross-device rig reproduced the user's exact screenshots from it:
      //   37.7s  BOTH: "relay mode engaged", both report connected over a relay
      //   37.7s  HOST, same second: "a player left: channel-closed" -> waiting
      //   61.9s  JOINER finally notices: "relay-silent" -> closed
      // leaving ~24 s in which the host shows `P1 you · P2 open` while the
      // joiner still shows `P1 <hex> · P2 you · maple port 1`. That one-way
      // roster IS this line.
      //
      // The relay has its own liveness (L.lastHeard + the RELAY_DEAD_MS sweep
      // at the top of the tick loop), so it does not need this one to notice a
      // dead peer — it needs this one to stop lying about a live one.
      dc.onclose = () => {
        if (L.relay && !L.dead) {
          // Demote the carrier, keep the link. If this was the session's
          // preferred channel, hand that role to another open one.
          L.open = false;
          if (this._dc === dc) this._dc = this._firstOpenChannel();
          this._emit('carrier-down', { peer: L.nonce, carrier: 'datachannel', stillUp: 'relay' });
          return;
        }
        this._linkGone(L, 'channel-closed');
      };
      dc.onmessage = (e) => {
        let m; try { m = JSON.parse(e.data); } catch (_) { return; }
        this._onData(m, L);
      };
    }

    // ⚠ ONE DISPATCH, TWO CARRIERS. Split out of dc.onmessage so that traffic
    // arriving over the relay is subject to exactly the same rules as traffic
    // arriving on a DataChannel — including the per-link approval check below.
    // Two copies of this would be two places for the admission gate to drift.
    _onData(m, L) {
      {
        // ⚠ LEAST PRIVILEGE, SECOND LINE — and now PER LINK. On the host a
        // channel cannot exist before that peer's approval, so this can only
        // fire for an approved peer today. It is here so that a later change
        // which opens a channel earlier cannot silently put someone's input
        // into the game, and it is checked against THIS link rather than
        // against "anyone has been approved".
        if (this.isHost && !L.approved) return;
        // Lockstep traffic is namespaced 'ls*' and never collides with the
        // stream path's 'in'/'pad'.
        if (m.t && m.t.charCodeAt(0) === 108 /*l*/ && m.t.charCodeAt(1) === 115 /*s*/) {
          this._onRoomMsg(m, L); return;
        }
        if (m.t === 'in') { this.remoteInputs.set(m.f, m.v); this._emit('input', m); }
        else if (m.t === 'pad') {
          // ⚠ THE SEQUENCE GUARD IS PER PEER. One counter for the room would
          // let player 3's seq 40 silently discard player 2's seq 12 — the
          // ordering guarantee only ever held within one sender's stream.
          if (!this._padSeqBy) this._padSeqBy = new Map();
          const prev = this._padSeqBy.get(L.nonce);
          if (prev == null || m.s > prev) {
            this._padSeqBy.set(L.nonce, m.s);
            this._remotePads.set(L.nonce, m.v | 0);
            if (this._padOrder.indexOf(L.nonce) < 0) this._padOrder.push(L.nonce);
            this._remotePad = m.v | 0;         // legacy mirror
            this._padSeqRx = m.s;
          }
          this._emit('input', m);
        }
        else if (m.t === 'sync') this._emit('sync', m);
        else if (m.t === 'save-begin' || m.t === 'save-chunk' || m.t === 'save-end') this._onSaveMsg(m);
      }
    }

    // =========================================================================
    // THE TOPOLOGY: A HOST-RELAYED STAR, AND WHY IT IS NOT A MESH.
    //
    // Every guest holds ONE connection, to the host. The host holds N-1, and
    // FORWARDS each guest's frame traffic to all the others, so every core ends
    // up holding every player's pad — which is the requirement ("it will be as
    // if multiplayer are on the same console"), and lockstep gives no choice
    // about it: a machine cannot run frame F until it has EVERY occupied port's
    // input for F, so "send it to the host" would not be a design, it would be
    // a deadlock.
    //
    // A full mesh would give guest-to-guest input one hop instead of two. It was
    // rejected for three reasons, in this order:
    //
    //   1. CONNECTIVITY, which is measured and bad. A star needs N-1 peer
    //      connections; a mesh needs N(N-1)/2 — for four players, 3 against 6.
    //      A star works if every guest can reach the host; a mesh ALSO requires
    //      every guest to reach every other guest, and one unreachable PAIR
    //      breaks the room for everybody. That is not hypothetical here: the ICE
    //      block at the top of this file records every free public TURN relay
    //      tested from this machine returning 701/400 and peerjs's own two
    //      failing to resolve at all. With no working relay, each extra pair is
    //      another chance to need one.
    //   2. ADMISSION. The security property this file was rewritten for is that
    //      a HUMAN admits each peer. In a mesh, guests would have to admit each
    //      other — either N-1 more prompts per player, or trusting a host
    //      introduction, which is exactly the "an offer approved for someone
    //      else" hazard tools/netplay_attack_test.mjs exists to catch.
    //   3. AUTHORITY. seat(), _checkBarrier() and dropPeer() are already
    //      host-only by construction (`if (!this.isHost) return`). The roster
    //      has to be one agreed thing or players drive each other's characters,
    //      and a star has an obvious place to decide it.
    //
    // WHAT IT COSTS, STATED SO IT IS NOT DISCOVERED LATER: guest-to-guest input
    // takes two hops, so the delay must cover the WORST path, which is
    // guest->host->guest rather than host->guest. Lockstep.recommendDelay()
    // takes an RTT, so feed it the worst measured pair, not the average.
    //
    // ⚠ ONLY FRAME TRAFFIC IS RELAYED. lsroster/lsgo/lsdrop are the host's
    // decisions and lsready/lsload are addressed to it; forwarding a guest's
    // copy of any of them would let one player rewrite everyone's roster, start
    // the game, or unplug another player's controller. A guest only ever has one
    // link — to the host — so anything it receives is the host's word.
    // =========================================================================
    _onRoomMsg(m, L) {
      if (m.t === 'lscap') { this._onCap(m, L); return true; }
      // ---- RTT, because `delay` has to be CHOSEN and nothing measured it -----
      // Lockstep.recommendDelay() takes an RTT and there was no way to obtain
      // one. In a relayed star the number that matters is the WORST pair, which
      // is guest->host->guest, not host->guest — so this pings a named peer end
      // to end, through however many hops separate them.
      const me = (this.ls && this.ls.peerId) || this._nonce;
      if (m.t === 'lsping') {
        if (m.to === me) this._send({ t: 'lspong', id: m.id, to: m.from, from: me });
        else if (this.isHost) this._relay(m, L);
        return true;
      }
      if (m.t === 'lspong') {
        if (m.to === me) {
          const w = this._pings && this._pings.get(m.id);
          if (w) { this._pings.delete(m.id); w(); }
        } else if (this.isHost) this._relay(m, L);
        return true;
      }
      // ⚠ STAMPED HERE, NOT ONLY BELOW. The lsload branch used to run before the
      // sender stamp, so a guest could publish another seat's progress and the
      // host would relay it. A peer only ever speaks as itself.
      if (this.isHost && L && L.nonce !== HOST_LINK) m.peer = L.nonce;
      if (m.t === 'lsload') {
        if (m.peer) this._load.set(m.peer, Math.max(0, Math.min(100, m.pct | 0)));
        if (this.isHost) this._relay(m, L);
        this._emit('room', this.roomInfo());
        return true;
      }
      // ⚠ A PEER MAY ONLY EVER SPEAK AS ITSELF. The link is authenticated (a
      // human approved that nonce), so stamping the sender here is what makes
      // Lockstep's "a peer may only drive its own ports" check real: without it
      // `m.peer` is whatever the sender wrote, and in a relayed star every
      // guest's traffic passes through code that could be lied to.
      if (m.t === 'lsroster' && !this.isHost) this._armRosterWatch();
      const handled = this._onLockstepMsg(m);
      if (this.isHost && RELAYED[m.t]) {
        // Never forward what the room agreed is limp (Lockstep.filterRelay).
        const fwd = (this.ls && typeof this.ls.filterRelay === 'function') ? this.ls.filterRelay(m) : m;
        if (fwd) this._relay(fwd, L);
      }
      return handled;
    }
    _relay(m, from) {
      const s = JSON.stringify(m);
      const inputs = m.t === 'ls' && !m.rel;
      let lean = null;
      for (const L of this._links.values()) {
        if (L === from) continue;
        const u = inputs ? this._unreliableFor(L) : null;
        if (u) { try { u.send(s); } catch (e) {} continue; }
        if (!L.dc || L.dc.readyState !== 'open') continue;
        if (inputs && (m.w || m.wr) && lean == null) lean = leanInputs(m);
        try { L.dc.send(inputs && (m.w || m.wr) ? lean : s); } catch (e) {}
      }
    }

    // A peer's game channel came up. THE ROSTER IS DECIDED HERE, by the host,
    // and broadcast — so every core maps the same person to the same port.
    _onPeerUp(L) {
      // ⚠ THE GUEST NEEDS ITS ENGINE BEFORE THE FIRST ROSTER ARRIVES, and the
      // roster is the very first thing the host sends down a channel it has just
      // seated somebody on. `_onLockstepMsg` drops everything while `ls` is
      // null, so without this the joiner would silently never learn its port.
      // Building it in dc.onopen is safe because 'open' precedes 'message' on
      // the same channel.
      const ls = this._ensureLockstep();
      // ⚠ A GUEST ASKS THE MOMENT IT HAS A CHANNEL. The roster is host state
      // and the host pushes it on a seat change, but a page that has just come
      // back has no idea whether the push it needs already happened — and the
      // seat it is re-taking may not CHANGE the roster at all (a reconnect
      // keeps its port), so there may be no push to catch. Asking is one small
      // message and it makes convergence the returning page's own business
      // rather than a matter of timing.
      if (ls && !this.isHost) { this._rejoining = false; try { ls.requestRoster(); } catch (e) {} }
      if (!ls || !this.isHost || !this._autoSeat) return;
      // The host takes the lowest free port first, so player 1 is the person who
      // opened the room on every machine, and each joiner takes the next one in
      // ORDER OF ADMISSION. That is a pure function of join order, the host is
      // the only one computing it, and it is pushed to everybody — including to
      // the players already seated, whose roster gains a row rather than moving.
      if (!this._seatedSelf) { this._seatedSelf = true; ls.seat(ls.peerId, 1); }
      // ⚠ NEVER RE-SEAT MID-GAME. A player coming back into a running room
      // still holds their seat (the roster is fixed once frame 0 ran); seat()
      // would refuse and raise 'barrier-failed' at the page. They get the
      // roster, and the engine takes them back (refill, catch-up, lsundrop).
      const live = ls.state === 'running' || ls.state === 'stalled';
      if (L && L.nonce !== HOST_LINK) {
        if (live && ls.roster.indexOf(L.nonce) >= 0) { try { ls._rosterSend(); } catch (e) {} }
        else ls.seat(L.nonce, 1);
      }
      this._emit('room', this.roomInfo());
    }

    // ---- LOCKSTEP: the session side of it ----------------------------------
    // Everything protocol-shaped lives in class Lockstep; this is only the
    // plumbing between that engine and the DataChannel, plus the ONE thing the
    // engine cannot do for itself — agreeing on the starting state.
    // ⚠ THIS IS A BROADCAST NOW, NOT A PIPE. The engine below has always
    // believed it was speaking to "the other side"; on a host it is speaking to
    // every seated player at once, and a roster or a start that reached only one
    // of them would be a desync by construction.
    // The `_dc` arm is kept and is not dead code: tools/netplay_lockstep_test.mjs
    // drives sessions with an injected channel and no links at all.
    _send(o) {
      const s = JSON.stringify(o);
      let sent = 0;
      const done = new Set();
      // Input goes on the unreliable channel where one is open (see
      // _bindUnreliable); a NAK answer (`rel`) and everything else stay reliable.
      const inputs = o && o.t === 'ls' && !o.rel;
      // ⚠ THE REDUNDANCY WINDOW IS FOR LOSSY PATHS ONLY. A reliable ordered
      // DataChannel cannot lose a message, so re-sending the last delay+2
      // frames on it is dead weight — measured 675 KB vs 173 KB over 40 s
      // (3.9x the bytes) with the window on every reliable send. The lsu
      // channel and the signalling relay keep it.
      let lean = null;
      for (const L of this._links.values()) {
        const u = inputs ? this._unreliableFor(L) : null;
        if (u) { if (L.dc) done.add(L.dc); try { u.send(s); sent++; } catch (e) {} continue; }
        if (!L.dc || L.dc.readyState !== 'open' || done.has(L.dc)) continue;
        done.add(L.dc);
        if (inputs && (o.w || o.wr) && lean == null) lean = leanInputs(o);
        try { L.dc.send(inputs && (o.w || o.wr) ? lean : s); sent++; } catch (e) {}
      }
      if (this._dc && !done.has(this._dc) && this._dc.readyState === 'open') {
        try { this._dc.send(s); sent++; } catch (e) {}
      }
      // ⚠ A ROOM CAN BE MIXED. One guest may hold a direct channel while
      // another only has the relay, so this is an ADDITION to the loop above
      // and not an else-branch: the roster and the start have to reach both.
      for (const L of this._links.values()) {
        if (L.relay && !L.dead) { this._relaySend(o); sent++; break; }
      }
      return sent > 0;
    }

    // Build the engine. Both sides call it; the HOST's parameters win (they are
    // pushed to the guest in 'lsgo'), because two sides configured with
    // different delays would desync by construction.
    startLockstep(opts) {
      opts = opts || {};
      const ls = this.ls = new Lockstep(Object.assign({ game: this.game }, opts, {
        host: this.isHost,
        // The session's own per-pairing identity doubles as the peer id, so a
        // port is owned by a party the admission layer already authenticated
        // rather than by a name anyone can claim.
        peerId: opts.peerId || this._nonce,
        send: (o) => this._send(o),
      }));
      ls.on('desync', (d) => this._emit('desync', d));
      ls.on('desync-detail', (d) => this._emit('desync', Object.assign({ detail: true }, d)));
      ls.on('state', (e) => this._emit('lockstep', e));
      ls.on('roster', (r) => this._emit('lockstep', { state: ls.state, roster: r }));
      ls.on('barrier', (b) => this._emit('lockstep', { state: 'waiting', barrier: b }));
      ls.on('leave', (e) => this._emit('lockstep', { state: ls.state, leave: e }));
      // A dropped player coming back, and the rollback window moving.
      ls.on('rejoin', (e) => this._emit('lockstep', { state: ls.state, rejoin: e }));
      ls.on('window', (e) => this._emit('lockstep', { state: ls.state, window: e }));
      // Capacity gating: the room switched between zero-lag (rollback) and input
      // delay — `e.text` is the sentence for the player ("this device is too slow
      // for zero-lag mode; using input delay to keep full speed").
      ls.on('mode', (e) => { this._emit('lockstep', { state: ls.state, mode: e }); this._emit('mode', e); });
      // The agreed memory-card set, forwarded for the same reason 'barrier' is:
      // the page renders the room's state and must not have to reach into the
      // engine to learn that the cards are settled — or that they are not.
      ls.on('cards', (c) => this._emit('cards', c));
      // ⚠ FORWARD THE TWO EVENTS THE PAGE LISTENS FOR ON THE *SESSION*.
      // Lockstep emits 'room-game' and 'roster-evicted' on ITSELF, but
      // dreamcast.html subscribes with `s.on('room-game', ...)` on the SESSION
      // (dreamcast.html:6181) — and this forwarding list did not carry either,
      // so neither ever reached the page. That is the last link in the disc
      // failure: with the engine fixed, a guest's engine correctly received the
      // room's disc (report().roomGame === 'gauntlet', measured), while the
      // page went on showing pso2 and booting it, because the handler that
      // selects the disc and auto-starts was subscribed to an emitter that
      // never fired. Verified in the browser: toldDisc "gauntlet", picker
      // "pso2", and ZERO "room is playing" lines in the guest's log.
      ls.on('room-game', (e) => this._emit('room-game', e));
      ls.on('roster-evicted', (e) => this._emit('roster-evicted', e));
      this._lsOpts = opts;
      return ls;
    }
    // The engine has to exist before the first peer can be SEATED, and seating
    // happens when a game channel opens — which is well before any page has had
    // a reason to call startLockstep(). A page that does call it still wins:
    // this only ever fills in a missing engine.
    _ensureLockstep() {
      // `game` travels here too: this lazy path builds the engine for almost
      // every room (on the first channel open), so omitting it would leave the
      // roster publishing null exactly where it matters most.
      if (!this.ls) this.startLockstep(Object.assign({ portCount: this.portCount, game: this.game }, this._lsOpts || {}));
      // ⚠ THE HOST IS A PLAYER IN ITS OWN ROOM, FROM THE MOMENT THERE IS ONE.
      // Seating self used to happen ONLY in _onPeerUp, i.e. when somebody else
      // connected. So a host sitting in a room it just opened had NO SEAT, and
      // everything gated on a seat was therefore dead for it: netRoomRender()'s
      // canReady requires `youPort != null`, so the Ready control was disabled —
      // while its own label, computed from load progress alone, read "I'm ready".
      // The user pressed that button repeatedly and reported "nothing is
      // happening". Measured on production: booted true, armed true, readyTxt
      // "I'm ready", readyDisabled TRUE on every sample.
      // Seat order is unchanged: the host still takes the lowest free port, so
      // it is player 1 exactly as before — this only stops that from waiting on
      // a stranger's arrival.
      if (this.ls && this.isHost && this._autoSeat && !this._seatedSelf) {
        this._seatedSelf = true;
        try { this.ls.seat(this.ls.peerId, 1); } catch (e) {}
      }
      return this.ls;
    }

    // ---- THE START BARRIER, from the page's side ----------------------------
    // "My core is booted and holding at frame 0, on this disc." Nobody advances
    // frame 0 until EVERY seated peer has said this — and said it about the same
    // disc. dreamcast.html already calls setReady()/setLoadProgress() behind a
    // `typeof === 'function'` guard and logs "this build has no start barrier
    // yet" when they are missing; these are those two methods.
    setReady(on, disc) {
      const ls = this._ensureLockstep();
      if (!ls || on === false) return false;
      this.setLoadProgress(100);
      ls.declareReady(disc == null ? this.game : disc);
      return true;
    }
    // A peer still downloading a 1.18 GB disc HOLDS the others, visibly. This is
    // what makes that wait a reported thing rather than an unexplained pause.
    setLoadProgress(pct) {
      const v = Math.max(0, Math.min(100, Math.round(pct || 0)));
      const me = (this.ls && this.ls.peerId) || this._nonce;
      if (this._load.get(me) === v) return v;
      this._load.set(me, v);
      this._send({ t: 'lsload', peer: me, pct: v });
      this._emit('room', this.roomInfo());
      return v;
    }
    // Round trip to ONE named peer, on this machine's own clock — so it needs
    // no clock agreement between browsers, which there is none of.
    // ⚠ IT IS AN APPLICATION-LEVEL RTT, not an ICE one: it includes the relay
    // hop when the far side is another guest, which is exactly the number the
    // delay has to cover. getStats()'s currentRoundTripTime would report the
    // single link and understate the worst path.
    pingPeer(peerId, timeoutMs) {
      const me = (this.ls && this.ls.peerId) || this._nonce;
      if (!peerId || peerId === me) return Promise.resolve(null);
      if (!this._pings) this._pings = new Map();
      const id = randomHex(6);
      const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      return new Promise((res) => {
        let done = false;
        const timer = setTimeout(() => { if (!done) { done = true; this._pings.delete(id); res(null); } },
                                 timeoutMs || 4000);
        this._pings.set(id, () => {
          if (done) return;
          done = true; clearTimeout(timer);
          res((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0);
        });
        if (!this._send({ t: 'lsping', id, from: me, to: peerId })) {
          done = true; clearTimeout(timer); this._pings.delete(id); res(null);
        }
      });
    }
    // Every other seated player, pinged. The WORST of these is what
    // Lockstep.recommendDelay() should be fed.
    // opts.samples: pings per peer (default 1 — the old behaviour); opts.frameMs:
    // the console's frame quantum. With several samples the recommendation
    // carries a jitter margin (Lockstep.recommendDelayFromSamples).
    async rttReport(timeoutMs, opts) {
      // A bare number is the frame quantum (dreamcast.html passes lsFrameMs()).
      if (typeof opts === 'number') opts = { frameMs: opts };
      opts = opts || {};
      // Default 5: one sample cannot tell a busy peer from a slow wire (see
      // Lockstep.rttBudget). Peers are pinged CONCURRENTLY, each its own
      // sequence, so three guests cost one guest's worth of wall time.
      const n = Math.max(1, Math.min(16, opts.samples | 0 || 5));
      const frameMs = opts.frameMs > 0 ? opts.frameMs : 1000 / 60;
      const ls = this.ls;
      const me = (ls && ls.peerId) || this._nonce;
      const peers = [];
      if (ls) for (const p of ls.roster) if (p != null && p !== me && peers.indexOf(p) < 0) peers.push(p);
      const out = {}, all = [], samples = {};
      await Promise.all(peers.map(async (p) => {
        samples[p] = [];
        for (let i = 0; i < n; i++) { const v = await this.pingPeer(p, timeoutMs); if (v != null) { samples[p].push(v); all.push(v); } }
        out[p] = samples[p].length ? Math.max.apply(null, samples[p]) : null;
      }));
      const got = Object.keys(out).map((k) => out[k]).filter((v) => v != null);
      // `worstMs` is kept for the pages' logs; `budgetMs` is what the delay was
      // actually sized from (per peer, outliers dropped — Lockstep.rttBudget).
      const budgets = {};
      for (const p of peers) budgets[p] = Lockstep.rttBudget(samples[p]);
      const bs = Object.keys(budgets).map((k) => budgets[k]).filter((v) => v != null);
      const floorDelay = Lockstep.floorDelayForRoom(samples, frameMs);
      if (ls && floorDelay != null) ls.netFloorDelay = floorDelay;
      // ...and the delay a lockstep room starts at on this link, which is the
      // most a capacity-gated rollback room may ever switch to (Lockstep.rttDelay).
      const recommendedDelay = Lockstep.recommendDelayForRoom(samples, frameMs);
      if (ls && recommendedDelay != null) ls.rttDelay = Math.max(1, Math.min(30, recommendedDelay | 0));
      return { peers: out, samples: samples, worstMs: got.length ? Math.max.apply(null, got) : null,
               budgets: budgets, budgetMs: bs.length ? Math.round(Math.max.apply(null, bs)) : null, floorDelay: floorDelay,
               recommendedDelay: recommendedDelay };
    }

    // One shape for "who is in this room, in which port, and how far along" —
    // for the page's roster, and for a rig that has to assert it.
    roomInfo() {
      const ls = this.ls;
      const me = (ls && ls.peerId) || this._nonce;
      const seats = [];
      const n = ls ? ls.portCount : this.portCount;
      for (let p = 0; p < n; p++) {
        const peer = ls ? ls.roster[p] : null;
        seats.push({
          port: p, peer, local: !!peer && peer === me,
          load: peer == null ? null : (this._load.has(peer) ? this._load.get(peer) : 0),
          ready: !!(ls && ls.isHost && peer != null && ls.lobby.has(peer)),
          dropped: ls && ls.dropped.has(p) ? ls.dropped.get(p) : null,
        });
      }
      return {
        code: this.code, host: this.isHost, me,
        portCount: n, maxPeers: this.maxPeers,
        links: this._links.size, full: this._links.size >= this.maxPeers,
        seats, state: ls ? ls.state : 'idle',
        started: !!(ls && (ls.state === 'running' || ls.state === 'stalled')),
        // null on a direct room. A page that renders this must say the room is
        // on a relay and slower — see relayNotice() for the wording.
        relay: this.relayInfo(),
        // The host's latest barrier verdict ({seated, ready, waitingFor, discs,
        // alone}) as every side last heard it; null before the first lsbar.
        barrier: ls ? (ls._bar || null) : null,
      };
    }

    // ---- THE STARTING STATE IS NOT TRANSFERRED ANY MORE ---------------------
    // Players join the room BEFORE any core boots, everyone loads the same
    // disc, and the barrier holds all of them at frame 0 — so identical
    // starting states hold BY CONSTRUCTION. There is no serialize, no 27 MB
    // transfer, and no restore that can fail silently and leave a cold boot
    // wearing the mask of a running game (CLAUDE.md gate #10).
    //
    // sendSave(bytes, meta, 'sync') and the 'sync-state' event are KEPT, not
    // deleted, and nothing in the start sequence calls them: they are the
    // transport a future late-join or mid-session resync would need, and they
    // are already chunked, integrity-checked and tested. Said out loud here so
    // nobody reads their presence as evidence that the start path uses them.
    sendStartState(bytes, meta) { return this.sendSave(bytes, meta, 'sync'); }

    // ⚠ CREATE THE ENGINE ON DEMAND — DO NOT DROP THE MESSAGE. This read
    // `this.ls ? this.ls.receive(m) : false`, and there is no replay: an
    // 'lsroster' that arrives before this side has built its engine is gone
    // FOREVER. That is not a rare window — the host seats itself and the joiner
    // in the same breath the moment a peer connects, and both roster
    // broadcasts can land before the guest has any reason to have built one
    // (the guest's engine was otherwise created lazily, by setReady()).
    // What the guest loses when they are dropped is everything the roster
    // carries: _recount() never runs so `localPorts` stays EMPTY, 'room-game'
    // is never emitted so the joiner is never told which disc the room is on
    // and never auto-starts, and — worst — lsSeatedCount() floors at 1, so the
    // guest plugs in ONE controller while the host plugs in two and the two
    // machines disagree about the console they are booting. The mismatch guard
    // in lsArmBeforeFreerun() cannot see it, because both of ITS numbers come
    // from the same empty roster.
    // Measured: dreamcast.html's joiner never printed "[net] auto-starting …"
    // in any arm, and the restarted side printed "⚠ the room published no
    // lockstep engine, so this core cannot be frame-gated".
    // _ensureLockstep() is the method that already exists for exactly this and
    // is what setReady() uses; ls* traffic only arrives when there IS a room,
    // so this cannot build an engine for a page that is not in one.
    _onLockstepMsg(m) { const ls = this._ensureLockstep(); return ls ? ls.receive(m) : false; }

    // Called once per emulated frame with THIS player's input. Returns the input
    // the remote player had for the frame being executed, or null when it has not
    // arrived — the caller must stall rather than guess, because guessing is what
    // turns a hiccup into a permanent desync.
    exchange(localValue) {
      const f = this.frame++;
      this.localInputs.set(f, localValue);
      if (this._dc && this._dc.readyState === 'open') {
        try { this._dc.send(JSON.stringify({ t: 'in', f: f + this.delayFrames, v: localValue })); } catch (e) {}
      }
      const want = f;
      return this.remoteInputs.has(want) ? this.remoteInputs.get(want) : null;
    }

    // Send an opaque savestate so the joiner starts from the host's exact state.
    // Determinism starts HERE: without a common starting state, identical inputs
    // still diverge.
    sendSync(payload) {
      if (this._dc && this._dc.readyState === 'open') {
        try { this._dc.send(JSON.stringify({ t: 'sync', payload })); } catch (e) {}
      }
    }

    // ---- SESSION SAVES: memory cards and savestates, for EVERY player --------
    //
    // In this model only the host runs the emulator, so only the host's browser
    // ends the session holding the memory card everyone just played on. That is
    // not good enough: each player has to come away with their own copy. So the
    // host SENDS the save at the end of a session (or on request) and every peer
    // stores it locally.
    //
    // ⚠ IT CANNOT GO IN ONE MESSAGE. A Dreamcast savestate is 27,652,485 B
    // (dreamcast.html states this, and the shipped seed is that size) while an
    // SCTP DataChannel message is limited to roughly 256 KB — a single send
    // would throw or silently kill the channel. It is therefore gzipped first
    // (the same page measures 3.22x on exactly this data: 27,652,485 ->
    // 8,595,603) and then chunked, with the receiver reassembling by index so an
    // out-of-order chunk cannot corrupt the result.
    //
    // ⚠ SEPARATE FROM THE SINGLE-PLAYER SAVE, deliberately. A co-op session's
    // memory card is not the same artifact as the one from playing alone, and
    // silently overwriting the second with the first would destroy progress the
    // player did not agree to trade. Keys are namespaced :mp.
    static saveKey(game, kind) { return 'mp:' + game + ':' + (kind || 'state'); }

    // `kind` names what this transfer IS: 'save' (default — the end-of-session
    // memory card, which is what this was built for) or 'sync' (the starting
    // machine state for a lockstep session). Same chunking, same integrity
    // check, different event on the far side — a start state delivered as a
    // memory card would be written over the player's save.
    async sendSave(bytes, meta, kind) {
      const dc = this._dc;
      // ⚠ A SAVE IS THE PLAYER'S FILE. It does not go to a peer nobody let in,
      // whatever the caller thinks the session state is.
      if (this.isHost && !this._approved) {
        this.lastError = 'refused: nobody has been allowed into this session';
        return false;
      }
      if (!dc || dc.readyState !== 'open') return false;
      let payload = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      let encoding = 'raw';
      // Compress when the browser can. A guest on a device with a small storage
      // budget (a console browser, a phone) is exactly who cannot afford 27 MB.
      if (typeof CompressionStream === 'function') {
        try {
          const cs = new CompressionStream('gzip');
          const w = cs.writable.getWriter(); w.write(payload); w.close();
          payload = new Uint8Array(await new Response(cs.readable).arrayBuffer());
          encoding = 'gzip';
        } catch (e) { /* fall through uncompressed rather than fail the handoff */ }
      }
      const CHUNK = 16 * 1024;          // well under the SCTP limit, with headroom
      const total = Math.ceil(payload.length / CHUNK);
      const id = Math.random().toString(36).slice(2, 10);
      dc.send(JSON.stringify({ t: 'save-begin', id, total, bytes: payload.length,
                               encoding, meta: meta || {}, game: this.game,
                               kind: kind === 'sync' ? 'sync' : 'save' }));
      for (let i = 0; i < total; i++) {
        // Respect backpressure: blasting 500+ chunks at a full send buffer is how
        // a DataChannel gets torn down mid-transfer.
        while (dc.bufferedAmount > 4 * 1024 * 1024) await new Promise((r) => setTimeout(r, 15));
        if (dc.readyState !== 'open') return false;
        const slice = payload.subarray(i * CHUNK, Math.min((i + 1) * CHUNK, payload.length));
        let b = '';
        for (let k = 0; k < slice.length; k++) b += String.fromCharCode(slice[k]);
        dc.send(JSON.stringify({ t: 'save-chunk', id, i, d: btoa(b) }));
        this._emit('save-progress', { dir: 'send', i: i + 1, total });
      }
      dc.send(JSON.stringify({ t: 'save-end', id }));
      return true;
    }

    _onSaveMsg(m) {
      this._rx = this._rx || {};
      if (m.t === 'save-begin') {
        this._rx[m.id] = { chunks: new Array(m.total), got: 0, meta: m.meta,
                           total: m.total, bytes: m.bytes, encoding: m.encoding,
                           kind: m.kind === 'sync' ? 'sync' : 'save' };
      } else if (m.t === 'save-chunk') {
        const r = this._rx[m.id];
        if (!r || r.chunks[m.i] !== undefined) return;   // unknown or duplicate
        const bin = atob(m.d);
        const u = new Uint8Array(bin.length);
        for (let k = 0; k < bin.length; k++) u[k] = bin.charCodeAt(k);
        r.chunks[m.i] = u; r.got++;
        this._emit('save-progress', { dir: 'recv', i: r.got, total: r.total });
      } else if (m.t === 'save-end') {
        const r = this._rx[m.id];
        if (!r) return;
        delete this._rx[m.id];
        // A missing chunk means a TRUNCATED save. Report the failure rather than
        // hand back a short buffer that would restore as a corrupt machine.
        if (r.got !== r.total) {
          const err = 'incomplete: ' + r.got + '/' + r.total;
          if (r.kind === 'sync') {
            // A truncated START STATE must never be handed to the emulator: a
            // short buffer restores as a corrupt machine or not at all, and
            // "not at all" leaves a cold boot that looks fine.
            this._emit('sync-failed', { where: 'transfer', error: err });
            if (this.ls) this.ls.fail('a transferred state arrived truncated (' + err + ')');
            return;
          }
          return this._emit('save', { ok: false, error: err });
        }
        let out = new Uint8Array(r.chunks.reduce((n, c) => n + c.length, 0));
        let o = 0; for (const c of r.chunks) { out.set(c, o); o += c.length; }
        const ev = r.kind === 'sync' ? 'sync-state' : 'save';
        const finish = (bytes) => this._emit(ev, { ok: true, bytes, meta: r.meta, encoding: r.encoding,
                                                   words: null });
        if (r.encoding === 'gzip' && typeof DecompressionStream === 'function') {
          const ds = new DecompressionStream('gzip');
          const w = ds.writable.getWriter(); w.write(out); w.close();
          new Response(ds.readable).arrayBuffer()
            .then((ab) => finish(new Uint8Array(ab)))
            .catch((e) => {
              this._emit(ev, { ok: false, error: 'inflate failed: ' + e.message });
              if (r.kind === 'sync' && this.ls) this.ls.fail('a transferred state failed to decompress');
            });
        } else finish(out);
      }
    }

    close() {
      this._dropSink();
      // The roster heartbeat outlives the links unless it is stopped here — it
      // is an interval on the ENGINE, not on a channel.
      try { if (this.ls) this.ls.stopRosterBeat(); } catch (e) {}
      if (this._helloTimer) { clearInterval(this._helloTimer); this._helloTimer = 0; }
      if (this._rosterWatch) { clearInterval(this._rosterWatch); this._rosterWatch = 0; }
      if (this._promptTimer) { clearTimeout(this._promptTimer); this._promptTimer = 0; }
      if (this._relayTimer) { clearTimeout(this._relayTimer); this._relayTimer = 0; }
      if (this._relayPing) { clearInterval(this._relayPing); this._relayPing = 0; }
      this._relayOut.length = 0;
      if (this.relay) this.relay.active = false;
      this._closePrompt();
      this._closeNotice();
      for (const L of Array.from(this._links.values())) {
        L.dead = true;                       // do not re-enter _linkGone per channel
        this._disarmIce(L);
        try { L.dc && L.dc.close(); } catch (e) {}
        try { L.pc && L.pc.close(); } catch (e) {}
      }
      this._links.clear();
      try { this._dc && this._dc.close(); } catch (e) {}
      try { this._pc && this._pc.close(); } catch (e) {}
      try { this._sig && this._sig.close(); } catch (e) {}
      const i = LIVE.indexOf(this); if (i >= 0) LIVE.splice(i, 1);
      this._status('closed');
    }
  }

  // ---- WHERE A PLAYER'S COPY LIVES -----------------------------------------
  // Every player keeps their own save, on whatever they are playing on — desktop
  // Chrome, a phone, a console browser. IndexedDB is the only store that is both
  // large enough and available everywhere; localStorage is measured in single-digit
  // MB and cannot hold a machine state.
  //
  // ⚠ STORAGE IS BEST-EFFORT UNTIL YOU ASK. Without navigator.storage.persist()
  // the browser may evict this under pressure, which on a small-budget device
  // (a console browser is the case that prompted this) reads to the player as
  // "my save vanished". Asking is free and a refusal is not fatal.
  const SaveStore = {
    _db: null,
    async open() {
      if (this._db) return this._db;
      this._db = await new Promise((res, rej) => {
        const r = indexedDB.open('netplay-saves', 1);
        r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains('saves')) r.result.createObjectStore('saves'); };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      return this._db;
    },
    async requestPersistence() {
      try {
        if (!navigator.storage || !navigator.storage.persist) return null;
        return (await navigator.storage.persisted()) || (await navigator.storage.persist());
      } catch (e) { return null; }
    },
    async put(key, bytes, meta) {
      await this.requestPersistence();
      const db = await this.open();
      return new Promise((res, rej) => {
        const tx = db.transaction('saves', 'readwrite');
        tx.objectStore('saves').put({ bytes, meta: meta || {}, at: Date.now() }, key);
        tx.oncomplete = () => res(true);
        // Name the reason. "Save failed" on a console browser that is simply out
        // of room is a dead end for the player; QuotaExceededError is actionable.
        tx.onerror = () => rej(tx.error || new Error('write failed'));
      });
    },
    async get(key) {
      const db = await this.open();
      return new Promise((res, rej) => {
        const rq = db.transaction('saves', 'readonly').objectStore('saves').get(key);
        rq.onsuccess = () => res(rq.result || null);
        rq.onerror = () => rej(rq.error);
      });
    },
    async list() {
      const db = await this.open();
      return new Promise((res, rej) => {
        const out = [];
        const st = db.transaction('saves', 'readonly').objectStore('saves');
        st.openCursor().onsuccess = (e) => {
          const c = e.target.result;
          if (c) { out.push({ key: String(c.key), bytes: (c.value.bytes || {}).length || 0, meta: c.value.meta, at: c.value.at }); c.continue(); }
          else res(out);
        };
        st.transaction.onerror = () => rej(st.transaction.error);
      });
    },
    // Would this device even hold it? Better to say so before a session than to
    // fail at the end holding the only copy of everyone's progress.
    async fits(bytes) {
      try {
        if (!navigator.storage || !navigator.storage.estimate) return { known: false };
        const e = await navigator.storage.estimate();
        const free = (e.quota || 0) - (e.usage || 0);
        return { known: true, free, quota: e.quota, usage: e.usage, fits: free > bytes * 1.5 };
      } catch (err) { return { known: false }; }
    },
  };

  global.Netplay = {
    SaveStore,
    PROTO,
    makeCode,
    Session: NetplaySession,
    // The lockstep protocol engine, exported so it can be unit-tested and
    // driven without a session (tools/netplay_lockstep_test.mjs does exactly
    // that: two engines, a scriptable wire, no browser and no emulator).
    Lockstep,
    fnv32, fnvBytes, FNV_SEED,
    sessions: LIVE,
    // The session this page is HOSTING with, or null. Pages keep theirs in a
    // closure; this is how a page control or a test rig reaches admission(),
    // approve() and deny() without every page growing another seam.
    hostSession() { for (let i = LIVE.length - 1; i >= 0; i--) if (LIVE[i].isHost) return LIVE[i]; return null; },
    // True when the browser can do any of this at all. A page must check before
    // showing the button rather than presenting a control that cannot work.
    supported() {
      return typeof RTCPeerConnection === 'function' && typeof BroadcastChannel === 'function';
    },
    // ---- relay configuration -------------------------------------------------
    // Two browsers on networks that will not carry a direct path between them
    // need a TURN relay, and there is no working free public one (see the ICE
    // block above for the measurements). When a relay DOES exist, this is the
    // whole integration — no code change, and it takes effect on the next
    // session because iceServers() is read at connect time, not at load.
    //   Netplay.useRelay([{ urls:'turn:my.host:3478', username:'u', credential:'p' }])
    //   window.NETPLAY_TURN = 'turn:my.host:3478|u|p'
    //   ?turn=turn:my.host:3478|u|p                      (for testing)
    useRelay(list) { extraIce = Array.isArray(list) ? list.slice() : []; return iceServers(); },
    // What the NEXT connection will actually be given. Exposed because "is a
    // relay configured" must be answerable by a page, a test and a bug report
    // without reading source — an entry here is still not proof that the relay
    // relays, which only a 'relay' candidate can show.
    iceConfig() { return iceServers(); },
    // ---- signalling configuration --------------------------------------------
    // Which paths a session started with this transport name would OPEN. Named
    // separately from the transport option because they are no longer the same
    // thing: every page still asks for 'peerjs', and what it gets is the relay
    // and the peerjs DataConnection concurrently. A page, a rig and a bug
    // report all need to be able to ask which, without reading source.
    //   Netplay.signalPlan('peerjs')  ->  ['ws', 'peerjs']
    //   ?signal=ws  /  window.NETPLAY_SIGNAL = 'peerjs-only'   (for testing)
    signalPlan(want) { return signalPlan(want == null ? 'peerjs' : want); },
    // The brokers the relay will try, in order. Overridable the same two ways
    // as the TURN list, for a deployment that would rather run its own.
    //   window.NETPLAY_WS_BROKERS = 'wss://my.broker:8084/mqtt'
    //   ?wsbroker=wss://my.broker:8084/mqtt
    signalBrokers() { return wsBrokers(); },
    // The message types a host forwards between guests (for rigs that model
    // the star, e.g. tools/netplay_rb_pace_sim.mjs).
    RELAYED: Object.assign({}, RELAYED),
  };
})(typeof window !== 'undefined' ? window : globalThis);

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
      // A BroadcastChannel is a broadcast — there is no socket to refuse, and
      // every page in this browser can hear everything. That is fine for the
      // headless tests it exists for, and it is why the addressing below is by
      // NONCE rather than by connection.
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
          const id = base + (opts.host ? '-h' : '-g');
          const peer = new global.Peer(id, { debug: 0 });
          let cb = null, conn = null, locked = false, onErr = null, knocks = 0;
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
          const outbox = [];
          const flush = () => {
            if (!conn || !conn.open) return;
            while (outbox.length) { try { conn.send(outbox.shift()); } catch (e) { break; } }
          };
          const wire = (c) => {
            // ⚠ ONCE A JOINER HAS BEEN APPROVED, NOBODY ELSE GETS THE SOCKET.
            // Before the lock the last caller wins, which is what makes the
            // guest's retry work; after it, a late caller replacing `conn`
            // would be handed the offer the host just approved for someone
            // else. lock() is called at the top of approve(), before the offer
            // exists.
            if (locked) { try { c.close(); } catch (e) {} return; }
            conn = c;
            c.on('data', (d) => { if (cb && d && d.room === room) cb(d); });
            if (c.open) { flush(); return; }
            c.on('open', flush);
            if (opts.host) return;          // the host answers dials, it does not place them
            cancelDial();
            dialTimer = setTimeout(() => {
              dialTimer = null;
              if (c.open) return;
              try { c.close(); } catch (e) {}
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
              send: (m) => { outbox.push(Object.assign({ room }, m)); flush(); },
              onMessage: (f) => { cb = f; },
              // ⚠ 2 above: the caller's only window onto a transport that
              // breaks after it was handed over.
              onError: (f) => { onErr = f; },
              lock: () => { locked = true; },
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
      this.peerId = opts.peerId || (this.isHost ? 'host' : 'peer');
      // THE CONSOLE'S port count, handed in by whoever knows the core.
      this.portCount = Math.max(1, Math.min(8, opts.portCount == null ? 4 : opts.portCount | 0));
      this.padBytes = opts.padBytes || 64;
      this.delay = Math.max(1, Math.min(30, opts.delay == null ? 3 : opts.delay | 0));
      this.hashEvery = opts.hashEvery == null ? 60 : Math.max(0, opts.hashEvery | 0);
      this.stallBudgetMs = opts.stallBudgetMs == null ? 8000 : opts.stallBudgetMs | 0;
      this.fieldNames = opts.fieldNames || null;   // for naming a diverged field
      this._send = opts.send || function () {};
      this._now = opts.now || (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));

      // roster[port] = peerId, or null for an empty port. Assigned by the host
      // in the lobby and broadcast, so EVERY core maps the same person to the
      // same port. Get this wrong and players drive each other's characters.
      this.roster = new Array(this.portCount).fill(null);
      this.localPorts = [];
      this.dropped = new Map();      // port -> frame from which it runs neutral
      this.lobby = new Map();        // host: peerId -> { disc, ready }
      this.disc = null;              // this machine's disc identity

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
                         ready: [], roster: [], barrier: [], 'barrier-failed': [], leave: [] };
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
    static recommendDelay(rttMs, frameMs) {
      const q = frameMs > 0 ? frameMs : 1000 / 60;
      return Math.max(1, Math.min(10, Math.ceil(Math.max(0, rttMs) / 2 / q) + 1));
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
      for (let p = 0; p < this.portCount && got.length < want; p++) {
        if (this.roster[p] == null) { this.roster[p] = peerId; got.push(p); }
      }
      this._recount();
      this._sendRoster();
      return got;
    }
    unseat(peerId) {
      if (!this.isHost) return;
      for (let p = 0; p < this.portCount; p++) if (this.roster[p] === peerId) this.roster[p] = null;
      this.lobby.delete(peerId);
      this._recount();
      this._sendRoster();
    }
    _recount() {
      this.localPorts = [];
      for (let p = 0; p < this.portCount; p++) if (this.roster[p] === this.peerId) this.localPorts.push(p);
      this._emit('roster', this.rosterReport());
    }
    _sendRoster() {
      this._send({ t: 'lsroster', r: this.roster.slice(), portCount: this.portCount,
                   padBytes: this.padBytes, delay: this.delay, hashEvery: this.hashEvery });
    }
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
      this.disc = String(disc == null ? '' : disc);
      this._setState('waiting', 'holding at frame 0');
      if (this.isHost) { this._lobbySet(this.peerId, this.disc); this._checkBarrier(); }
      else this._send({ t: 'lsready', peer: this.peerId, disc: this.disc });
    }
    _lobbySet(peer, disc) { this.lobby.set(peer, { disc, ready: true }); }

    // HOST. Nobody runs frame 0 until every seated peer is ready ON THE SAME
    // DISC. A peer still downloading holds the rest, and that wait is reported
    // rather than being an unexplained pause.
    _checkBarrier() {
      if (!this.isHost || this.state === 'running') return;
      const seated = [];
      for (const p of this.roster) if (p != null && seated.indexOf(p) < 0) seated.push(p);
      const missing = seated.filter((p) => !this.lobby.has(p));
      const discs = {};
      for (const p of seated) if (this.lobby.has(p)) discs[p] = this.lobby.get(p).disc;
      this._emit('barrier', { seated, ready: seated.length - missing.length, waitingFor: missing, discs });
      if (missing.length) return;
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
      this._send({ t: 'lsgo', delay: this.delay, hashEvery: this.hashEvery,
                   portCount: this.portCount, padBytes: this.padBytes, r: this.roster.slice() });
      this.begin();
    }

    begin() {
      if (this.state === 'running') return;
      this.frame = 0; this._scheduledTo = 0; this._stalled = false; this._stallSince = 0;
      this.inputs.clear(); this.myHash.clear(); this.myWords.clear(); this.peerHash.clear();
      this.lastAgreedFrame = -1;
      this._recount();
      this._setState('running');
      this._emit('ready', { delay: this.delay, hashEvery: this.hashEvery,
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
    dropPeer(peerId) {
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
      const at = Math.max(last + 1, this.frame);
      this._send({ t: 'lsdrop', ports, at, peer: peerId });
      this._applyDrop(ports, at, peerId);
      return ports;
    }
    _applyDrop(ports, at, peerId) {
      for (const p of ports) if (!this.dropped.has(p)) this.dropped.set(p, at);
      this._emit('leave', { peer: peerId || null, ports: ports.slice(), at });
      this._emit('roster', this.rosterReport());
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
    beginFrame(pads) {
      if (this.state === 'desync' || this.state === 'ended' || this.state === 'failed') {
        return { ready: false, frame: this.frame, reason: this.state, waitingOn: [], waitingPeers: [] };
      }
      if (this.state !== 'running' && this.state !== 'stalled') {
        return { ready: false, frame: this.frame, reason: 'not-started', waitingOn: [], waitingPeers: [] };
      }
      const f = this.frame;
      if (this._scheduledTo <= f) {
        const at = f + this.delay;
        const items = [];
        for (const p of this.localPorts) {
          const bytes = this._coerce(pads, p);
          this._put(at, p, bytes);
          items.push([p, b64enc(bytes)]);
        }
        this._scheduledTo = f + 1;
        if (items.length) { this.stats.sent++; this._send({ t: 'ls', f: at, i: items }); }
      }
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
          this._setState('stalled');
          this._emit('stall', { frame: f, on: true, waitingOn, waitingPeers });
        } else if (this.stallBudgetMs > 0 && (this._now() - this._stallSince) > this.stallBudgetMs) {
          this.fail('no input from ' + (waitingPeers.join(', ') || ('port ' + waitingOn.join(','))) +
                    ' for ' + Math.round((this._now() - this._stallSince) / 1000) + 's');
        }
        return { ready: false, frame: f, reason: 'stall', waitingOn, waitingPeers };
      }
      if (this._stalled) {
        const d = this._now() - this._stallSince;
        this._stalled = false; this._stallSince = 0;
        this.stats.stallMs += d;
        if (d > this.stats.maxStallMs) this.stats.maxStallMs = d;
        this._setState('running');
        this._emit('resume', { frame: f, ms: d });
      }
      // Slack: how many further frames are already fully covered. This is the
      // number that says whether `delay` is big enough for this link — a run
      // whose minimum is 0 was living on the edge and any jitter is a stall.
      let lead = 0;
      while (this._covered(f + lead + 1)) lead++;
      this.stats.leadSamples++; this.stats.leadSum += lead;
      if (lead < this.stats.minLead) this.stats.minLead = lead;
      return { ready: true, frame: f, image, pads: byPort, waitingOn: [], waitingPeers: [] };
    }

    _covered(f) {
      for (const p of this.occupiedPorts()) if (this._inputFor(f, p) === undefined) return false;
      return true;
    }
    // The one place an input is resolved, so the neutral rules live together:
    // the agreed prologue, and a port whose player has left.
    _inputFor(f, port) {
      if (f < this.delay) return this.neutral;
      const at = this.dropped.get(port);
      if (at != null && f >= at) return this.neutral;
      const m = this.inputs.get(f);
      return m ? m.get(port) : undefined;
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
      if (hash != null) {
        const h = hash >>> 0;
        this.myHash.set(f, h);
        if (words) this.myWords.set(f, Array.prototype.slice.call(words));
        this.stats.hashesSent++;
        this._send({ t: 'lsh', f, h, peer: this.peerId });
        this._compare(f);
      }
      const cut = f - LS_KEEP;
      if (cut > 0 && (f % 64) === 0) {
        for (const k of this.inputs.keys()) if (k < cut) this.inputs.delete(k);
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

    // ---- divergence: detect it, then NAME it --------------------------------
    _compare(f) {
      if (!this.myHash.has(f)) return;
      const theirs = this.peerHash.get(f);
      if (!theirs || theirs.size === 0) return;
      const mine = this.myHash.get(f);
      const agree = [], differ = [];
      for (const [peer, h] of theirs) (h === mine ? agree : differ).push(peer);
      this.stats.hashesCompared++;
      if (!differ.length) {
        // ⚠ ONLY when EVERY expected peer has reported. Advancing this on a
        // PARTIAL agreement made the divergence window useless: the first peer
        // to report agreed, so a later peer's mismatch said "last agreed = the
        // frame that just diverged". That window IS the diagnosis.
        const expect = this.expectedPeers();
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
      this._setState('desync', 'frame ' + f + ', diverged from ' + differ.join(', '));
      // Offer our raw fingerprint so whoever receives it can name the field.
      if (!this._sentDiag) this._sentDiag = new Set();
      this._sentDiag.add(f);
      this._send({ t: 'lsd', f, peer: this.peerId, w: this.myWords.get(f) || null,
                   why: 'hash mismatch at frame ' + f });
      this._emit('desync', this.desync);
    }
    // Everyone whose fingerprint we expect: the distinct peers seated in a port,
    // other than us.
    expectedPeers() {
      const out = [];
      for (const p of this.roster) if (p != null && p !== this.peerId && out.indexOf(p) < 0) out.push(p);
      return out;
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
      switch (m.t) {
        case 'ls': {
          if (typeof m.f !== 'number' || !Array.isArray(m.i)) return true;
          if (m.f < this.frame - LS_KEEP) return true;
          for (const pair of m.i) {
            const port = pair[0] | 0;
            if (port < 0 || port >= this.portCount) continue;
            // ⚠ A PEER MAY ONLY DRIVE ITS OWN PORTS. Without this a buggy or
            // hostile peer could write everyone's controller.
            if (m.peer && this.roster[port] && this.roster[port] !== m.peer) continue;
            try { this._put(m.f, port, b64dec(pair[1])); this.stats.received++; } catch (e) {}
          }
          return true;
        }
        case 'lsh': {
          if (typeof m.f !== 'number' || typeof m.h !== 'number') return true;
          let byPeer = this.peerHash.get(m.f);
          if (!byPeer) { byPeer = new Map(); this.peerHash.set(m.f, byPeer); }
          byPeer.set(m.peer || 'peer', m.h >>> 0);
          this._compare(m.f);
          return true;
        }
        case 'lsd': {
          const df = m.f | 0;
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
            this._setState('desync', 'reported by ' + (m.peer || 'a peer') + ': ' + (m.why || ''));
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
        case 'lsroster': {
          if (Array.isArray(m.r)) {
            this.portCount = m.portCount || m.r.length;
            if (m.padBytes) this.padBytes = m.padBytes | 0;
            this.roster = m.r.slice();
            this._recount();
          }
          return true;
        }
        case 'lsready': {          // host only: a peer reached the barrier
          if (!this.isHost) return true;
          this._lobbySet(m.peer || 'peer', String(m.disc == null ? '' : m.disc));
          this._checkBarrier();
          return true;
        }
        case 'lsgo': {
          // The HOST's parameters win everywhere. Two machines configured with
          // different delays would desync by construction, so this is adopted,
          // never merged.
          this.delay = Math.max(1, Math.min(30, m.delay | 0));
          this.hashEvery = Math.max(0, m.hashEvery | 0);
          if (m.portCount) this.portCount = m.portCount | 0;
          if (m.padBytes) this.padBytes = m.padBytes | 0;
          if (Array.isArray(m.r)) this.roster = m.r.slice();
          this.neutral = new Uint8Array(this.padBytes);
          this.begin();
          return true;
        }
        case 'lsdrop': {
          if (Array.isArray(m.ports)) this._applyDrop(m.ports.map((p) => p | 0), m.at | 0, m.peer || null);
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
        portCount: this.portCount, ports: this.rosterReport(), localPorts: this.localPorts.slice(),
        desync: this.desync, error: this.error, lastAgreedFrame: this.lastAgreedFrame,
        frames: s.frames, stalls: s.stalls,
        stallMs: Math.round(s.stallMs), maxStallMs: Math.round(s.maxStallMs),
        hashesCompared: s.hashesCompared, hashesSent: s.hashesSent,
        inputsSent: s.sent, inputsReceived: s.received,
        minLead: s.minLead === Infinity ? null : s.minLead,
        meanLead: s.leadSamples ? +(s.leadSum / s.leadSamples).toFixed(2) : null,
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
  class NetplaySession {
    constructor(opts) {
      opts = opts || {};
      this.game = opts.game || 'unknown';
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
      this._remotePad = 0;       // host: the guest's latest pad state
      this._padSeq = -1;
      this._handlers = { status: [], input: [], sync: [], close: [], stream: [], save: [],
                         'save-progress': [], 'join-request': [], reject: [],
                         // lockstep
                         'sync-state': [], 'sync-failed': [], desync: [], lockstep: [],
                         warning: [] };
      this._padSeqRx = null;
      this._answered = false;
      this.lastError = null;
      // ---- admission control (see the block at the top of this file) --------
      this._nonce = randomHex(8);   // this side's identity within the pairing
      this._approved = false;       // host: a human said yes. guest: it was told yes.
      this._pending = null;         // host: {nonce, chal, proven, checking, sas}
      this._denials = 0;            // host: how many joiners have been refused
      this._quietUntil = 0;         // host: stop raising prompts after a spree
      this._chal = null;            // guest: the challenge it answered
      this._joinSent = false;
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
      if (this._dc && this._dc.readyState === 'open') {
        try { this._dc.send(JSON.stringify({ t: 'pad', v: mask | 0, s: ++this._padSeq })); } catch (e) {}
      }
    }
    // host: what player 2 is holding right now. The emulator reads this exactly
    // like a local pad — so an unapproved peer must read as NOBODY PRESSING
    // ANYTHING, not as the last value it managed to set.
    remotePad() {
      if (this.isHost && !this._approved) return 0;
      return this._remotePad | 0;
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
        if (this._iceTimer) { clearTimeout(this._iceTimer); this._iceTimer = null; }
      }
      // The two bits of session-owned DOM never outlive the thing they describe.
      if (s === 'connected' || s === 'closed' || s === 'failed') this._closeNotice();
      if (s === 'closed' || s === 'failed') this._closePrompt();
      this._emit('status', { state: s, detail: detail || null, code: this.code, sas: this.sas || null });
    }

    async start() {
      this._status('signalling');
      try {
        this._sig = this.transport === 'peerjs'
          ? await peerSignal(this.code, { host: this.isHost })
          : localSignal(this.code);
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
      const pc = this._pc = new RTCPeerConnection({ iceServers: iceServers() });
      // ⚠ ICE CANDIDATES ARE THE HOST'S LOCAL ADDRESSES. Nothing is gathered
      // until setLocalDescription runs, and on the host that only happens
      // inside approve() — so an unapproved caller does not learn the host's
      // LAN or public addresses either.
      pc.onicecandidate = (e) => {
        if (!e.candidate) return;
        const to = this._pending ? this._pending.nonce : null;
        this._sig.send({ t: 'ice', c: e.candidate.toJSON(), n: this._nonce, to });
      };
      // Host: publish the game. Guest: receive it.
      if (this._stream) this._stream.getTracks().forEach((t) => pc.addTrack(t, this._stream));
      pc.ontrack = (e) => {
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
      };
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
      this._armIce = () => {
        if (this._iceTimer) return;
        this._iceTimer = setTimeout(() => {
          this._iceTimer = null;
          const st = pc.connectionState + '/' + pc.iceConnectionState;
          if (pc.connectionState === 'connected' || this.state === 'connected') return;
          this._status('failed', 'the two browsers agreed on a connection but could not open one ('
            + st + ') — one of these networks is blocking direct peer-to-peer traffic. '
            + 'Playing across it needs a relay server; see Netplay.useRelay().');
        }, ICE_CONNECT_MS);
      };
      const disarmIce = () => { if (this._iceTimer) { clearTimeout(this._iceTimer); this._iceTimer = null; } };
      pc.oniceconnectionstatechange = () => {
        if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') disarmIce();
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') disarmIce();
        if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') this._status('failed', pc.connectionState);
      };
      if (this.isHost) {
        this._bindChannel(pc.createDataChannel('play', { ordered: true }));
        // ⚠ AND THEN NOTHING. This used to createOffer/setLocalDescription and
        // publish the offer immediately — and the offer carries the video and
        // audio tracks attachMedia added, so the game went out to whoever was
        // listening before anybody had agreed to anything. The offer is built
        // in approve() now. See the block at the top of this file.
        this._status('signalling', 'waiting for someone to ask to join');
      } else {
        pc.ondatachannel = (e) => this._bindChannel(e.channel);
        this._sendHello();
      }
      return true;
    }

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
        try { this._sig.send({ t: 'hello', proto: PROTO, game: this.game, n: this._nonce }); } catch (e) {}
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
      const pc = this._pc;
      if (!pc) return;
      try {
        // ---- ADMISSION: hello -> ready -> join -> (a human) -> offer --------
        if (m.t === 'hello' && this.isHost) {
          // A live session is not a lobby. Once somebody is in, further callers
          // are not offered a challenge at all.
          //
          // ⚠ AND THAT LATCH DOES NOT LIFT WHEN THE GUEST LEAVES. One
          // RTCPeerConnection cannot be renegotiated onto a different peer once
          // its offer has been answered, so admitting a replacement needs a NEW
          // session, which is the host page's decision and not this file's.
          // What this file can do is say so instead of leaving the caller
          // knocking at something that will never answer. (I have not measured
          // whether rejoin worked before this change; reading the old code, a
          // second guest was re-sent an offer the pc had already answered and
          // the host then ignored its answer, so I do not believe it did.)
          if (this._approved) {
            if (m.n && (!this._dc || this._dc.readyState !== 'open')) {
              this._sig.send({ t: 'denied', to: m.n, why: 'that session has ended — ask the host for a new code' });
            }
            return;
          }
          if (!m.n) return;
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
          if (!this._pending) this._pending = { nonce: m.n, chal: randomHex(16), proven: false, checking: false, sas: null };
          const p = this._pending;
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
          this._sig.send({ t: 'join', n: this._nonce, proof: proof });
          this._status('signalling', 'waiting for the host to let you in');
          this._showNotice();
          return;
        }
        if (m.t === 'join' && this.isHost) {
          const p = this._pending;
          if (!p || p.nonce !== m.n || p.proven || p.checking) return;
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
          await pc.setRemoteDescription({ type: 'offer', sdp: m.sdp });
          const ans = await pc.createAnswer();
          await pc.setLocalDescription(ans);
          if (this._armIce) this._armIce();
          this._sig.send({ t: 'answer', sdp: pc.localDescription.sdp, n: this._nonce });
        } else if (m.t === 'answer' && this.isHost) {
          // Only from the joiner a human actually approved.
          if (!this._approved) return;
          if (m.n && this._pending && m.n !== this._pending.nonce) return;
          if (!pc.currentRemoteDescription) await pc.setRemoteDescription({ type: 'answer', sdp: m.sdp });
        } else if (m.t === 'ice') {
          // An unapproved caller has no negotiation in flight, so it has no
          // business adding candidates to one.
          if (this.isHost && !this._approved) return;
          if (this.isHost && m.n && this._pending && m.n !== this._pending.nonce) return;
          if (!this.isHost && m.to && m.to !== this._nonce) return;
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
        if (this._pending && this._pending.nonce === p.nonce && !this._approved) {
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
    async approve(id) {
      const p = this._pending;
      if (!this.isHost || !p || !p.proven || this._approved) return false;
      if (id && id !== p.nonce) return false;
      this._approved = true;
      clearTimeout(this._promptTimer); this._promptTimer = 0;
      this._closePrompt();
      // Shut the door behind the approved joiner before the offer exists.
      try { this._sig.lock && this._sig.lock(); } catch (e) {}
      try {
        const pc = this._pc;
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);      // ICE gathering starts HERE
        if (this._armIce) this._armIce();
        this._sig.send({ t: 'offer', to: p.nonce, sdp: pc.localDescription.sdp,
                         proto: PROTO, game: this.game });
        this._status('signalling', 'allowed — connecting');
        return true;
      } catch (e) {
        this._approved = false;
        this.lastError = e.message;
        this._status('failed', e.message);
        return false;
      }
    }

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

    _bindChannel(dc) {
      this._dc = dc;
      dc.onopen = () => { this.peerReady = true; this._status('connected'); };
      dc.onclose = () => { this.peerReady = false; this._status('closed'); this._emit('close'); };
      dc.onmessage = (e) => {
        let m; try { m = JSON.parse(e.data); } catch (_) { return; }
        // ⚠ LEAST PRIVILEGE, SECOND LINE. On the host this channel cannot exist
        // before approval — the offer that carries it is not sent until then —
        // so this can only fire for an approved peer today. It is here so that
        // a later change which opens a channel earlier cannot silently put
        // player-2 input back into the game.
        if (this.isHost && !this._approved) return;
        // Lockstep traffic is namespaced 'ls*' and never collides with the
        // stream path's 'in'/'pad'. A session in stream mode simply has no
        // engine and drops it.
        if (m.t && m.t.charCodeAt(0) === 108 /*l*/ && m.t.charCodeAt(1) === 115 /*s*/) {
          this._onLockstepMsg(m); return;
        }
        if (m.t === 'in') { this.remoteInputs.set(m.f, m.v); this._emit('input', m); }
        else if (m.t === 'pad') {
          if (m.s > this._padSeqRx || this._padSeqRx == null) { this._padSeqRx = m.s; this._remotePad = m.v | 0; }
          this._emit('input', m);
        }
        else if (m.t === 'sync') this._emit('sync', m);
        else if (m.t === 'save-begin' || m.t === 'save-chunk' || m.t === 'save-end') this._onSaveMsg(m);
      };
    }

    // ---- LOCKSTEP: the session side of it ----------------------------------
    // Everything protocol-shaped lives in class Lockstep; this is only the
    // plumbing between that engine and the DataChannel, plus the ONE thing the
    // engine cannot do for itself — agreeing on the starting state.
    _send(o) {
      if (this._dc && this._dc.readyState === 'open') {
        try { this._dc.send(JSON.stringify(o)); return true; } catch (e) { return false; }
      }
      return false;
    }

    // Build the engine. Both sides call it; the HOST's parameters win (they are
    // pushed to the guest in 'lsgo'), because two sides configured with
    // different delays would desync by construction.
    startLockstep(opts) {
      opts = opts || {};
      const ls = this.ls = new Lockstep(Object.assign({}, opts, {
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
      return ls;
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

    _onLockstepMsg(m) { return this.ls ? this.ls.receive(m) : false; }

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
      if (this._helloTimer) { clearInterval(this._helloTimer); this._helloTimer = 0; }
      if (this._promptTimer) { clearTimeout(this._promptTimer); this._promptTimer = 0; }
      this._closePrompt();
      this._closeNotice();
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
  };
})(typeof window !== 'undefined' ? window : globalThis);

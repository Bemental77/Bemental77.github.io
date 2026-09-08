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
// THE MODEL: ONE INSTANCE RUNS THE GAME. The host's emulator is the only
// emulator. It captures its canvas and audio and streams them to the guests, and
// the guests send back controller state which the host feeds in as PLAYER 2.
// From the emulator's point of view nothing is networked at all — it sees a
// second pad on the same machine, which is exactly how Gauntlet Legends' own
// co-op works.
//
// WHY THIS AND NOT LOCKSTEP. The classic alternative runs an emulator on BOTH
// sides and exchanges inputs per frame. That requires the cores to be
// FRAME-DETERMINISTIC — same frame, same inputs, same starting state, forever —
// and any divergence is permanent and silent. Nothing here has been shown to be
// deterministic to that standard, so lockstep would be building on an unproven
// assumption. Streaming one instance removes the assumption entirely: there is
// only one machine, so there is nothing to keep in sync.
//   cost: the guest sees one network round trip of input lag, and needs bandwidth
//         for video. Those are real and measurable, unlike a desync.
// The frame-exchange helpers below are kept because they are tested and cost
// nothing, but the pages use the pad/stream path.
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
      // A BroadcastChannel is a broadcast — there is no socket to refuse, and
      // every page in this browser can hear everything. That is fine for the
      // headless tests it exists for, and it is why the addressing below is by
      // NONCE rather than by connection.
      lock: () => {},
      close: () => { try { ch.close(); } catch (e) {} },
    };
  }

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
      const start = () => {
        try {
          const id = base + (opts.host ? '-h' : '-g');
          const peer = new global.Peer(id, { debug: 0 });
          let cb = null, conn = null, locked = false;
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
            if (c.open) flush(); else c.on('open', flush);
          };
          peer.on('open', () => {
            if (opts.host) peer.on('connection', wire);
            else wire(peer.connect(base + '-h', { reliable: true }));
            resolve({
              kind: 'peerjs',
              send: (m) => { outbox.push(Object.assign({ room }, m)); flush(); },
              onMessage: (f) => { cb = f; },
              lock: () => { locked = true; },
              close: () => { try { peer.destroy(); } catch (e) {} },
            });
          });
          peer.on('error', (e) => {
            const t = (e && e.type) ? e.type : String(e);
            // 'peer-unavailable' just means the host is not there YET. Retrying
            // is correct; failing the session on it would make joining a race
            // the guest usually loses.
            if (t === 'peer-unavailable' && !opts.host) {
              setTimeout(() => { try { wire(peer.connect(base + '-h', { reliable: true })); } catch (_) {} }, 1200);
              return;
            }
            reject(new Error('signalling failed: ' + t));
          });
        } catch (e) { reject(e); }
      };
      if (global.Peer) return start();
      const s2 = document.createElement('script');
      s2.src = 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js';
      s2.onload = start;
      s2.onerror = () => reject(new Error('could not load the signalling library'));
      document.head.appendChild(s2);
    });
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
                         'save-progress': [], 'join-request': [], reject: [] };
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
      const pc = this._pc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
      });
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
      pc.onconnectionstatechange = () => {
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
          if (this._approved) return;
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
        if (m.t === 'in') { this.remoteInputs.set(m.f, m.v); this._emit('input', m); }
        else if (m.t === 'pad') {
          if (m.s > this._padSeqRx || this._padSeqRx == null) { this._padSeqRx = m.s; this._remotePad = m.v | 0; }
          this._emit('input', m);
        }
        else if (m.t === 'sync') this._emit('sync', m);
        else if (m.t === 'save-begin' || m.t === 'save-chunk' || m.t === 'save-end') this._onSaveMsg(m);
      };
    }

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

    async sendSave(bytes, meta) {
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
                               encoding, meta: meta || {}, game: this.game }));
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
                           total: m.total, bytes: m.bytes, encoding: m.encoding };
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
          return this._emit('save', { ok: false, error: 'incomplete: ' + r.got + '/' + r.total });
        }
        let out = new Uint8Array(r.chunks.reduce((n, c) => n + c.length, 0));
        let o = 0; for (const c of r.chunks) { out.set(c, o); o += c.length; }
        const finish = (bytes) => this._emit('save', { ok: true, bytes, meta: r.meta, encoding: r.encoding });
        if (r.encoding === 'gzip' && typeof DecompressionStream === 'function') {
          const ds = new DecompressionStream('gzip');
          const w = ds.writable.getWriter(); w.write(out); w.close();
          new Response(ds.readable).arrayBuffer()
            .then((ab) => finish(new Uint8Array(ab)))
            .catch((e) => this._emit('save', { ok: false, error: 'inflate failed: ' + e.message }));
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
  };
})(typeof window !== 'undefined' ? window : globalThis);

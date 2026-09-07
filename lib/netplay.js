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
'use strict';

(function (global) {
  const PROTO = 1;              // bumped when the wire format changes
  const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no I/O/0/1

  function makeCode(n) {
    let s = '';
    const a = new Uint8Array(n);
    (global.crypto || {}).getRandomValues ? crypto.getRandomValues(a) : a.forEach((_, i) => (a[i] = Math.random() * 256));
    for (let i = 0; i < n; i++) s += CODE_ALPHABET[a[i] % CODE_ALPHABET.length];
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
      close: () => { try { ch.close(); } catch (e) {} },
    };
  }

  // PeerJS is loaded lazily and ONLY when a cross-device session is requested, so
  // a page that never opens the lobby pays nothing and works with the script
  // blocked entirely.
  function peerSignal(room, opts) {
    return new Promise((resolve, reject) => {
      const done = (p) => resolve(p);
      const start = () => {
        try {
          const id = 'bemental-' + room + (opts.host ? '-h' : '-g');
          const peer = new global.Peer(id, { debug: 0 });
          let cb = null, conn = null;
          const wire = (c) => {
            conn = c;
            c.on('data', (d) => { if (cb && d && d.room === room) cb(d); });
          };
          peer.on('open', () => {
            if (opts.host) peer.on('connection', wire);
            else wire(peer.connect('bemental-' + room + '-h', { reliable: true }));
            done({
              kind: 'peerjs',
              send: (m) => { try { conn && conn.send(Object.assign({ room }, m)); } catch (e) {} },
              onMessage: (f) => { cb = f; },
              close: () => { try { peer.destroy(); } catch (e) {} },
            });
          });
          peer.on('error', (e) => reject(new Error('signalling failed: ' + (e && e.type ? e.type : e))));
        } catch (e) { reject(e); }
      };
      if (global.Peer) return start();
      const s = document.createElement('script');
      s.src = 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js';
      s.onload = start;
      s.onerror = () => reject(new Error('could not load the signalling library'));
      document.head.appendChild(s);
    });
  }

  // ---- the session ----------------------------------------------------------
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
      this._remotePad = 0;       // host: the guest's latest pad state
      this._padSeq = -1;
      this._handlers = { status: [], input: [], sync: [], close: [], stream: [], save: [], 'save-progress': [] };
      this._padSeqRx = null;
      this.lastError = null;
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
    // like a local pad.
    remotePad() { return this._remotePad | 0; }
    _emit(ev, a) { (this._handlers[ev] || []).forEach((f) => { try { f(a); } catch (e) {} }); }
    _status(s, detail) { this.state = s; this._emit('status', { state: s, detail: detail || null, code: this.code }); }

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
      pc.onicecandidate = (e) => { if (e.candidate) this._sig.send({ t: 'ice', c: e.candidate.toJSON() }); };
      // Host: publish the game. Guest: receive it.
      if (this._stream) this._stream.getTracks().forEach((t) => pc.addTrack(t, this._stream));
      pc.ontrack = (e) => {
        this._stream = e.streams && e.streams[0] ? e.streams[0] : new MediaStream([e.track]);
        this._emit('stream', this._stream);
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') this._status('failed', pc.connectionState);
      };
      if (this.isHost) {
        this._bindChannel(pc.createDataChannel('play', { ordered: true }));
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        this._sig.send({ t: 'offer', sdp: pc.localDescription.sdp, proto: PROTO, game: this.game });
      } else {
        pc.ondatachannel = (e) => this._bindChannel(e.channel);
        this._sig.send({ t: 'hello', proto: PROTO, game: this.game });
      }
      return true;
    }

    async _onSignal(m) {
      const pc = this._pc;
      if (!pc) return;
      try {
        if (m.t === 'hello' && this.isHost && pc.localDescription) {
          this._sig.send({ t: 'offer', sdp: pc.localDescription.sdp, proto: PROTO, game: this.game });
        } else if (m.t === 'offer' && !this.isHost) {
          // A mismatched game is a guaranteed desync, so refuse the pairing
          // rather than let two different discs "connect" and diverge.
          if (m.game && this.game && m.game !== this.game) {
            this.lastError = 'the other player is on ' + m.game;
            return this._status('failed', this.lastError);
          }
          if (m.proto !== PROTO) { this.lastError = 'version mismatch'; return this._status('failed', this.lastError); }
          await pc.setRemoteDescription({ type: 'offer', sdp: m.sdp });
          const ans = await pc.createAnswer();
          await pc.setLocalDescription(ans);
          this._sig.send({ t: 'answer', sdp: pc.localDescription.sdp });
        } else if (m.t === 'answer' && this.isHost) {
          if (!pc.currentRemoteDescription) await pc.setRemoteDescription({ type: 'answer', sdp: m.sdp });
        } else if (m.t === 'ice') {
          try { await pc.addIceCandidate(m.c); } catch (e) {}
        }
      } catch (e) { this.lastError = e.message; this._status('failed', e.message); }
    }

    _bindChannel(dc) {
      this._dc = dc;
      dc.onopen = () => { this.peerReady = true; this._status('connected'); };
      dc.onclose = () => { this.peerReady = false; this._status('closed'); this._emit('close'); };
      dc.onmessage = (e) => {
        let m; try { m = JSON.parse(e.data); } catch (_) { return; }
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
      try { this._dc && this._dc.close(); } catch (e) {}
      try { this._pc && this._pc.close(); } catch (e) {}
      try { this._sig && this._sig.close(); } catch (e) {}
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
    // True when the browser can do any of this at all. A page must check before
    // showing the button rather than presenting a control that cannot work.
    supported() {
      return typeof RTCPeerConnection === 'function' && typeof BroadcastChannel === 'function';
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);

// PublicLobby — a live list of open public games, so anyone can find a match without an invite.
//
// There is no server of ours. A public MQTT-over-WebSocket broker (the same kind lib/netplay.js already
// uses to pair two browsers) carries one small message per open game:
//   topic    bemental77.com/lobby/v1/<console>/<CODE>
//   payload  {"code","game","seated","ports","state","t"}   (retained, refreshed every BEAT_MS)
// A lobby subscribes to <console>/+ and shows what it hears. A game that stops refreshing falls off the
// list after STALE_MS; a host that leaves clears its entry (an empty retained message, also sent as the
// connection's last-will, so a closed tab clears it too).
//
// ⚠ THIS PUBLISHES THE ROOM CODE, ON PURPOSE. In a private room the code is the key and is never sent
// anywhere (lib/netplay.js, "WHAT A STRANGER ON THIS TOPIC CAN SEE"). A game is only advertised here when the
// host chose "public game": that choice is the invitation, and anyone who can read the list can join it.
// Private (invite-only) rooms never touch this file.
//
// Everything read from the broker is untrusted input from strangers: fields are shape-checked and the
// caller must render them with textContent, never as HTML.
(function (root) {
  'use strict';
  var LIB = 'https://cdnjs.cloudflare.com/ajax/libs/mqtt/5.3.4/mqtt.min.js';   // same pinned build as lib/netplay.js
  // Several brokers at once (a host and a joiner may reach different ones); entries are de-duplicated by code.
  var BROKERS = [
    { url: 'wss://public.cloud.shiftr.io:443', username: 'public', password: 'public' },
    { url: 'wss://demo.tbmq.io:443/mqtt', username: 'demo' },
    { url: 'wss://broker.emqx.io:8084/mqtt' },
  ];
  var ROOT = 'bemental77.com/lobby/v1/';
  var CODE_RE = /^[A-HJ-NP-Z2-9]{5}$/;
  var BEAT_MS = 10000, STALE_MS = 35000, MAX_AGE_MS = 90000;

  var loading = null;
  function loadMqtt() {
    if (root.mqtt) return Promise.resolve(root.mqtt);
    if (loading) return loading;
    loading = new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = LIB; s.async = true;
      s.onload = function () { root.mqtt ? res(root.mqtt) : rej(new Error('mqtt library missing')); };
      s.onerror = function () { rej(new Error('could not load the mqtt library')); };
      document.head.appendChild(s);
    });
    loading.catch(function () { loading = null; });
    return loading;
  }

  // Open every broker; `setup(client, broker)` runs on each client, `onUp` after each connect.
  function open(setup, optsFor) {
    var clients = [], dead = false;
    loadMqtt().then(function (mqtt) {
      if (dead) return;
      BROKERS.forEach(function (b) {
        var o = { clean: true, reconnectPeriod: 4000, connectTimeout: 8000, keepalive: 20,
                  clientId: 'bl_' + Math.random().toString(16).slice(2, 12) };
        if (b.username) o.username = b.username;
        if (b.password) o.password = b.password;
        if (optsFor) optsFor(o);
        var c;
        try { c = mqtt.connect(b.url, o); } catch (e) { return; }
        c.on('error', function () {});
        setup(c, b);
        clients.push(c);
      });
    }, function () {});
    return {
      clients: clients,
      connected: function () { return clients.filter(function (c) { return c.connected; }).length; },
      close: function () { dead = true; clients.forEach(function (c) { try { c.end(true); } catch (e) {} }); clients.length = 0; },
    };
  }

  function clean(sys, code, raw) {
    var d; try { d = JSON.parse(raw); } catch (e) { return null; }
    if (!d || typeof d !== 'object' || d.code !== code || !CODE_RE.test(code)) return null;
    if (typeof d.game !== 'string' || !d.game || d.game.length > 80) return null;
    var seated = d.seated | 0, ports = d.ports | 0;
    if (seated < 0 || seated > 8 || ports < 1 || ports > 8) return null;
    return { sys: sys, code: code, game: d.game, seated: seated, ports: ports,
             state: typeof d.state === 'string' ? d.state.slice(0, 16) : 'waiting', t: +d.t || 0 };
  }

  // watch('n64', function (rooms) {...}) -> { stop(), status() }. `rooms` is every open game right now.
  function watch(sys, onChange) {
    var rooms = {}, stopped = false;
    var topic = ROOT + sys + '/+';
    var emit = function () {
      if (stopped) return;
      var list = Object.keys(rooms).map(function (k) { return rooms[k]; });
      list.sort(function (a, b) { return b.seen - a.seen; });
      try { onChange(list); } catch (e) {}
    };
    var link = open(function (c) {
      c.on('connect', function () { c.subscribe(topic, { qos: 0 }); });
      c.on('message', function (t, payload) {
        var code = t.slice(t.lastIndexOf('/') + 1);
        var txt = payload && payload.length ? String(payload) : '';
        if (!txt) { delete rooms[code]; emit(); return; }          // the host cleared it
        var r = clean(sys, code, txt);
        if (!r) return;
        if (r.t && Date.now() - r.t > MAX_AGE_MS) return;            // a retained message from a host that is long gone
        r.seen = Date.now();
        rooms[code] = r; emit();
      });
    });
    var prune = setInterval(function () {
      var changed = false, now = Date.now();
      Object.keys(rooms).forEach(function (k) { if (now - rooms[k].seen > STALE_MS) { delete rooms[k]; changed = true; } });
      if (changed) emit();
    }, 5000);
    return {
      stop: function () { stopped = true; clearInterval(prune); link.close(); },
      status: function () { return { brokers: link.connected(), rooms: Object.keys(rooms).length }; },
    };
  }

  // advertise('n64', function () { return {code, game, seated, ports, state}; }) -> { poke(), stop() }
  // Lists the game while it can still take players; clears itself once it is full or running.
  function advertise(sys, getInfo) {
    var code = null, stopped = false, timer = 0;
    var first = getInfo(); code = first && first.code;
    if (!code || !CODE_RE.test(code)) return { poke: function () {}, stop: function () {} };
    var topic = ROOT + sys + '/' + code;
    var link = open(function (c) {
      c.on('connect', beat);
    }, function (o) { o.will = { topic: topic, payload: '', retain: true, qos: 0 }; });
    function beat() {
      if (stopped) return;
      var i; try { i = getInfo(); } catch (e) { return; }
      var open_ = i && i.state !== 'playing' && i.seated < i.ports;
      var msg = open_ ? JSON.stringify({ code: code, game: i.game, seated: i.seated, ports: i.ports, state: i.state, t: Date.now() }) : '';
      link.clients.forEach(function (c) { if (c.connected) { try { c.publish(topic, msg, { retain: true, qos: 0 }); } catch (e) {} } });
    }
    timer = setInterval(beat, BEAT_MS);
    function clear() {
      link.clients.forEach(function (c) { if (c.connected) { try { c.publish(topic, '', { retain: true, qos: 0 }); } catch (e) {} } });
    }
    if (root.addEventListener) root.addEventListener('pagehide', function () { stopped = true; clear(); });
    return {
      poke: beat,
      stop: function () { stopped = true; clearInterval(timer); clear(); setTimeout(link.close, 300); },
    };
  }

  root.PublicLobby = { watch: watch, advertise: advertise, brokers: BROKERS };
})(typeof window !== 'undefined' ? window : this);

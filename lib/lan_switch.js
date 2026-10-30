// lib/lan_switch.js - the host-side half of a "virtual Ethernet switch over WebRTC".
//
// STATUS: NOT WIRED INTO ANYTHING. The Flycast core that ships today has no JS
// hook on the Broadband Adapter's transmit/receive path, so nothing calls this
// yet. See dreamcast/docs/quake3-lan/PLAN.md for what exists, what is missing,
// and why no claim is made that two consoles can see each other. What IS proven
// is the switching logic itself: tools/lan_switch.test.mjs (node, no browser).
//
// MODEL. Every console is one port of a virtual LAN. A console owns a LanNode;
// the node is connected to every other console by a transport (a WebRTC data
// channel from lib/netplay.js, or anything with send(Uint8Array)). The guest's
// adapter hands the node each frame it transmits (egress); frames that arrive
// from peers are handed back to the adapter (ingress -> deliver callback).
//
// A LAN is a broadcast domain, so:
//   * a broadcast or multicast frame (dst MAC bit 0 set, which covers Quake
//     III's UDP broadcast server discovery and ARP who-has) goes to EVERY peer;
//   * a unicast frame goes to the peer that last SOURCED that MAC (learning),
//     and is flooded to all peers if the MAC has not been seen yet;
//   * a frame is NEVER forwarded again after it arrives from a peer (full mesh,
//     so one hop reaches everyone; relaying would create loops);
//   * a frame we receive whose source MAC equals our own is dropped and
//     reported (two seats configured with the same MAC would otherwise be
//     indistinguishable - flycast's bba.cpp hardcodes 0c:0a:0f:0e:00:00).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LanSwitch = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var MAGIC = 0x4c; // 'L'
  var MIN_FRAME = 14, MAX_FRAME = 1518;

  // Seat -> identity. Seats are 0-based. MAC keeps flycast's 0c:0a:0f:0e prefix.
  function macFor(seat) { return [0x0c, 0x0a, 0x0f, 0x0e, 0x00, seat + 1]; }
  function ipFor(seat) { return [192, 168, 169, 10 + seat]; }  // /24, no DHCP: static
  function macStr(m) {
    return Array.prototype.map.call(m, function (b) { return ('0' + b.toString(16)).slice(-2); }).join(':');
  }

  function pack(seat, frame) {
    var out = new Uint8Array(4 + frame.length);
    out[0] = MAGIC; out[1] = seat; out[2] = frame.length >> 8; out[3] = frame.length & 255;
    out.set(frame, 4);
    return out;
  }
  function unpack(buf) {
    if (!buf || buf.length < 4 + MIN_FRAME || buf[0] !== MAGIC) return null;
    var n = (buf[2] << 8) | buf[3];
    if (n < MIN_FRAME || n > MAX_FRAME || buf.length !== 4 + n) return null;
    return { seat: buf[1], frame: buf.subarray(4) };
  }
  function isGroup(frame) { return (frame[0] & 1) === 1; }

  // opts: { seat, deliver(frame) -> injects into the local adapter, onConflict(seat, mac) }
  function LanNode(opts) {
    this.seat = opts.seat;
    this.mac = macFor(opts.seat);
    this.deliver = opts.deliver;
    this.onConflict = opts.onConflict || function () {};
    this.peers = {};       // peerSeat -> transport {send(Uint8Array)}
    this.table = {};       // 'aa:bb:..' -> peerSeat
    this.stats = { tx: 0, rx: 0, bcast: 0, flood: 0, uni: 0, dropped: 0 };
  }
  LanNode.prototype.addPeer = function (seat, transport) { this.peers[seat] = transport; };
  LanNode.prototype.removePeer = function (seat) {
    delete this.peers[seat];
    for (var k in this.table) if (this.table[k] === seat) delete this.table[k];
  };
  // The local guest transmitted `frame` (an Ethernet frame without FCS).
  LanNode.prototype.egress = function (frame) {
    if (frame.length < MIN_FRAME || frame.length > MAX_FRAME) { this.stats.dropped++; return; }
    var msg = pack(this.seat, frame), self = this, seats = Object.keys(this.peers);
    var dst = macStr(frame.subarray(0, 6)), target = this.table[dst];
    this.stats.tx++;
    if (isGroup(frame)) { this.stats.bcast++; seats.forEach(function (s) { self.peers[s].send(msg); }); return; }
    if (target !== undefined && this.peers[target]) { this.stats.uni++; this.peers[target].send(msg); return; }
    this.stats.flood++; seats.forEach(function (s) { self.peers[s].send(msg); });
  };
  // A peer's transport delivered `buf`.
  LanNode.prototype.ingress = function (buf) {
    var m = unpack(buf);
    if (!m || m.seat === this.seat) { this.stats.dropped++; return; }
    var srcStr = macStr(m.frame.subarray(6, 12));
    if (srcStr === macStr(this.mac)) { this.stats.dropped++; this.onConflict(m.seat, srcStr); return; }
    this.table[srcStr] = m.seat;
    // Unicast not addressed to us: a switch would not deliver it; a flooded
    // unknown-unicast reaching the wrong seat is dropped here, not injected.
    if (!isGroup(m.frame) && macStr(m.frame.subarray(0, 6)) !== macStr(this.mac)) { this.stats.dropped++; return; }
    this.stats.rx++;
    this.deliver(m.frame);
  };

  return { LanNode: LanNode, macFor: macFor, ipFor: ipFor, macStr: macStr, pack: pack, unpack: unpack, MAGIC: MAGIC };
});

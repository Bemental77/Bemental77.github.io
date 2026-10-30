// node tools/lan_switch.test.mjs - exercises lib/lan_switch.js with an in-memory mesh.
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const L = require('../lib/lan_switch.js');

function mesh(n) {
  const rx = Array.from({ length: n }, () => []);
  const conflicts = [];
  const nodes = Array.from({ length: n }, (_, i) => new L.LanNode({
    seat: i, deliver: (f) => rx[i].push(Uint8Array.from(f)), onConflict: (s, m) => conflicts.push([i, s, m]) }));
  const wire = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (i !== j)
    nodes[i].addPeer(j, { send: (b) => { wire.push([i, j]); nodes[j].ingress(b); } });
  return { nodes, rx, wire, conflicts };
}
function frame(dst, src, payloadLen = 46) {
  const f = new Uint8Array(14 + payloadLen); f.set(dst, 0); f.set(src, 6); f[12] = 0x08; f[13] = 0x00; return f;
}
const BC = [255, 255, 255, 255, 255, 255];

// broadcast (Quake III server discovery, ARP who-has) reaches every other seat, not the sender
let t = mesh(4);
t.nodes[0].egress(frame(BC, L.macFor(0)));
assert.deepEqual(t.rx.map((r) => r.length), [0, 1, 1, 1]);
assert.equal(t.wire.length, 3);

// unknown unicast floods but is injected ONLY at the addressed seat
t = mesh(3);
t.nodes[0].egress(frame(L.macFor(2), L.macFor(0)));
assert.deepEqual(t.rx.map((r) => r.length), [0, 0, 1]);
assert.equal(t.nodes[0].stats.flood, 1);
assert.equal(t.wire.length, 2);

// after the reply is seen, unicast is sent to ONE peer only (learning)
t.nodes[2].egress(frame(L.macFor(0), L.macFor(2)));
assert.equal(t.rx[0].length, 1);
const before = t.wire.length;
t.nodes[0].egress(frame(L.macFor(2), L.macFor(0)));
assert.equal(t.wire.length - before, 1);
assert.equal(t.nodes[0].stats.uni, 1);

// a peer that leaves is forgotten (table purged)
t.nodes[0].removePeer(2);
assert.equal(Object.keys(t.nodes[0].peers).length, 1);
assert.equal(t.nodes[0].table[L.macStr(L.macFor(2))], undefined);

// duplicate MAC (two consoles with flycast's hardcoded 0c:0a:0f:0e:00:00) is detected, not silently merged
t = mesh(2);
t.nodes[0].egress(frame(BC, t.nodes[1].mac));
assert.equal(t.conflicts.length, 1);
assert.equal(t.rx[1].length, 0);

// malformed / truncated / wrong-length envelopes are dropped
t = mesh(2);
t.nodes[1].ingress(new Uint8Array([1, 2, 3]));
t.nodes[1].ingress(Uint8Array.from([L.MAGIC, 0, 0, 20, 1, 2, 3]));
assert.equal(t.rx[1].length, 0);

// identity plan
assert.equal(L.macStr(L.macFor(3)), '0c:0a:0f:0e:00:04');
assert.equal(L.ipFor(1).join('.'), '192.168.169.11');
console.log('lan_switch: all assertions passed');

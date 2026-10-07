#!/usr/bin/env node
// ============================================================================
// mqtt_ws_broker.mjs — a minimal MQTT 3.1.1 broker over WebSocket, for rigs.
// ============================================================================
//
// WHY. lib/netplay.js signals over public MQTT-over-WSS brokers (WS_BROKERS,
// lib/netplay.js:761-765) and, when two browsers cannot open a direct WebRTC
// path, carries the GAME over the same broker ("relay mode", the block above
// ICE_CONNECT_MS). From this sandbox those public brokers reset the connection,
// and BroadcastChannel (`?net=local`) never crosses a browser PROCESS — so two
// separate Chrome instances had no way to find each other at all. The page
// already accepts a broker override (`?wsbroker=`, lib/netplay.js:776-783), so
// a local broker is all a two-process rig needs: the pages run their SHIPPED
// signalling path (`?signal=ws`), and only the broker's address differs.
//
// SCOPE — exactly what lib/netplay.js uses, nothing else:
//   CONNECT/CONNACK, SUBSCRIBE/SUBACK (exact-match topics; the page never
//   subscribes with a wildcard), UNSUBSCRIBE/UNSUBACK, PUBLISH at QoS 0 (the
//   page publishes `{ qos: 0, retain: false }`, lib/netplay.js:972), PINGREQ/
//   PINGRESP, DISCONNECT. No retain, no sessions, no QoS 1/2 — a QoS>0 publish
//   is still forwarded (at QoS 0) and acknowledged, so a client never wedges.
//
// IMPAIRMENT (for the relay arm of tools/netplay_device_matrix.mjs). Every
// forwarded PUBLISH can be delayed by `delayMs` and dropped with probability
// `loss`. Delivery order per subscriber is preserved (a delayed message holds
// the ones behind it), which is what a TCP/WebSocket path does: a WebSocket
// never reorders, so a broker that did would be modelling a network that does
// not exist. Loss is applied per delivery, because on a real public broker the
// drop is on one leg, not on the publish.
//
// USAGE (standalone):  node tools/mqtt_ws_broker.mjs [port] [delayMs] [loss]
// As a module:         const b = await startBroker({ port: 0 }); b.url; b.setImpair({delayMs, loss}); await b.close();
import { createRequire } from 'node:module';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

function loadWs() {
  // ws lives in the probe-deps tree on this box (same place puppeteer does).
  const tries = [path.join(os.homedir(), 'probe-deps') + '/', import.meta.url];
  for (const t of tries) {
    try { return createRequire(t)('ws'); } catch (e) { /* next */ }
  }
  throw new Error('the `ws` package is not installed (looked in ~/probe-deps and beside this file)');
}

function encLen(n) {
  const out = [];
  do { let b = n % 128; n = Math.floor(n / 128); if (n > 0) b |= 0x80; out.push(b); } while (n > 0);
  return Buffer.from(out);
}
function packet(type, flags, body) {
  return Buffer.concat([Buffer.from([(type << 4) | (flags & 0x0f)]), encLen(body.length), body]);
}
function str(s) { const b = Buffer.from(s, 'utf8'); const l = Buffer.alloc(2); l.writeUInt16BE(b.length); return Buffer.concat([l, b]); }

export async function startBroker(opts = {}) {
  const { WebSocketServer } = loadWs();
  const impair = { delayMs: +(opts.delayMs || 0), loss: +(opts.loss || 0) };
  const stats = { connects: 0, publishes: 0, delivered: 0, dropped: 0, clients: 0 };
  const subs = new Map();           // topic -> Set(client)
  const server = http.createServer((req, res) => { res.writeHead(426); res.end('websocket only'); });
  const wss = new WebSocketServer({
    server,
    handleProtocols: (protos) => (protos.has('mqtt') ? 'mqtt' : (protos.has('mqttv3.1') ? 'mqttv3.1' : false)),
  });

  wss.on('connection', (ws) => {
    const c = { ws, buf: Buffer.alloc(0), topics: new Set(), q: [], qTimer: 0, lastAt: 0 };
    stats.clients++;
    const send = (b) => { try { if (ws.readyState === 1) ws.send(b); } catch (e) {} };
    // Per-subscriber FIFO with release times: the delay never reorders.
    const deliver = (b) => {
      if (impair.loss > 0 && Math.random() < impair.loss) { stats.dropped++; return; }
      if (!(impair.delayMs > 0)) { stats.delivered++; send(b); return; }
      const at = Math.max(Date.now() + impair.delayMs, c.lastAt);
      c.lastAt = at;
      c.q.push({ at, b });
      pump();
    };
    const pump = () => {
      if (c.qTimer) return;
      const next = c.q[0];
      if (!next) return;
      c.qTimer = setTimeout(() => {
        c.qTimer = 0;
        const now = Date.now();
        while (c.q.length && c.q[0].at <= now + 1) { stats.delivered++; send(c.q.shift().b); }
        pump();
      }, Math.max(0, next.at - Date.now()));
    };
    c.deliver = deliver;

    const handle = (type, flags, body) => {
      switch (type) {
        case 1: // CONNECT
          stats.connects++;
          send(packet(2, 0, Buffer.from([0, 0])));
          break;
        case 3: { // PUBLISH
          const tl = body.readUInt16BE(0);
          const topic = body.slice(2, 2 + tl).toString('utf8');
          const qos = (flags >> 1) & 3;
          let off = 2 + tl;
          let pid = null;
          if (qos > 0) { pid = body.readUInt16BE(off); off += 2; }
          const payload = body.slice(off);
          stats.publishes++;
          stats.pubBytes = (stats.pubBytes || 0) + payload.length;   // payload bytes published (the rate a public broker would meter)
          const out = packet(3, 0, Buffer.concat([str(topic), payload]));
          const set = subs.get(topic);
          if (set) for (const s of set) s.deliver(out);
          if (qos === 1) send(packet(4, 0, Buffer.from([pid >> 8, pid & 255])));
          if (qos === 2) send(packet(5, 0, Buffer.from([pid >> 8, pid & 255])));
          break;
        }
        case 6: { // PUBREL -> PUBCOMP
          send(packet(7, 0, body.slice(0, 2)));
          break;
        }
        case 8: { // SUBSCRIBE
          const pid = body.readUInt16BE(0);
          let off = 2; const granted = [];
          while (off < body.length) {
            const tl = body.readUInt16BE(off); off += 2;
            const topic = body.slice(off, off + tl).toString('utf8'); off += tl;
            off += 1; // requested qos
            if (!subs.has(topic)) subs.set(topic, new Set());
            subs.get(topic).add(c); c.topics.add(topic);
            granted.push(0);
          }
          send(packet(9, 0, Buffer.from([pid >> 8, pid & 255, ...granted])));
          break;
        }
        case 10: { // UNSUBSCRIBE
          const pid = body.readUInt16BE(0);
          let off = 2;
          while (off < body.length) {
            const tl = body.readUInt16BE(off); off += 2;
            const topic = body.slice(off, off + tl).toString('utf8'); off += tl;
            const set = subs.get(topic); if (set) set.delete(c);
            c.topics.delete(topic);
          }
          send(packet(11, 0, Buffer.from([pid >> 8, pid & 255])));
          break;
        }
        case 12: send(packet(13, 0, Buffer.alloc(0))); break; // PINGREQ
        case 14: try { ws.close(); } catch (e) {} break;      // DISCONNECT
        default: break;
      }
    };

    ws.on('message', (data) => {
      c.buf = Buffer.concat([c.buf, Buffer.isBuffer(data) ? data : Buffer.from(data)]);
      for (;;) {
        if (c.buf.length < 2) return;
        let mul = 1, len = 0, i = 1, b;
        do {
          if (i >= c.buf.length) return;
          b = c.buf[i++]; len += (b & 127) * mul; mul *= 128;
        } while (b & 128);
        if (c.buf.length < i + len) return;
        const h = c.buf[0];
        const body = c.buf.slice(i, i + len);
        c.buf = c.buf.slice(i + len);
        try { handle(h >> 4, h & 15, body); } catch (e) { /* malformed: ignore this packet */ }
      }
    });
    ws.on('close', () => {
      stats.clients--;
      for (const t of c.topics) { const s = subs.get(t); if (s) { s.delete(c); if (!s.size) subs.delete(t); } }
      if (c.qTimer) clearTimeout(c.qTimer);
    });
    ws.on('error', () => {});
  });

  await new Promise((res) => server.listen(opts.port || 0, opts.host || '127.0.0.1', res));
  const port = server.address().port;
  return {
    port,
    url: `ws://localhost:${port}/mqtt`,
    stats,
    setImpair(o) { impair.delayMs = +(o.delayMs || 0); impair.loss = +(o.loss || 0); },
    impair,
    close: () => new Promise((res) => {
      for (const ws of wss.clients) { try { ws.terminate(); } catch (e) {} }
      wss.close(() => server.close(() => res()));
    }),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [port, delayMs, loss] = process.argv.slice(2);
  startBroker({ port: +(port || 0), delayMs: +(delayMs || 0), loss: +(loss || 0) }).then((b) => {
    console.log(`[mqtt-ws] listening ${b.url} delay=${b.impair.delayMs}ms loss=${b.impair.loss}`);
    setInterval(() => console.log('[mqtt-ws] ' + JSON.stringify(b.stats)), 2000).unref();
    // A parent that runs this out of process reads the final numbers off SIGTERM.
    process.on('SIGTERM', () => { console.log('[mqtt-ws] ' + JSON.stringify(b.stats)); process.exit(0); });
  });
}

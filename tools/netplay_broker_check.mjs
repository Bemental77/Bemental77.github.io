#!/usr/bin/env node
// ============================================================================
// netplay_broker_check.mjs — DOES EACH SIGNALLING BROKER ACTUALLY RELAY?
// ============================================================================
//
// lib/netplay.js ships a LIST of public MQTT-over-WebSocket brokers and falls
// back down it, so that one being down is not a failed session. A list is only
// worth having if the entries below the first one work — and this project has
// been burned by exactly that shape before: the ICE block in lib/netplay.js
// documents an iceServers array full of TURN servers that returned 701/400, i.e.
// a relay that does not relay is a lie in a config object.
//
// So this connects to each broker IN TURN, with TWO clients, subscribes on one,
// publishes on the other, and requires the bytes to come out the far side. An
// entry that connects but does not carry a message is reported as a failure,
// not as a success.
//
// ⚠ NO BROWSER AND NO PUPPETEER, deliberately. It speaks MQTT 3.1.1 over the
// WebSocket built into node, so it costs nothing on a shared box and does not
// need the probe lock. It also means it tests the BROKER, not this machine's
// Chrome.
//
// ⚠ THE TIMES BELOW ARE NETWORK LATENCIES, NOT PERFORMANCE NUMBERS. They vary
// with the route and say nothing about this repo. They are printed because a
// broker that relays in 3 s is materially different to one that relays in 150
// ms, not because they are a measurement of anything here.
//
// USAGE  node tools/netplay_broker_check.mjs
// ============================================================================

// The list is READ OUT OF lib/netplay.js rather than duplicated, so this cannot
// drift into testing brokers the product does not use.
import fs from 'fs';
import path from 'path';
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SRC = fs.readFileSync(path.join(REPO, 'lib/netplay.js'), 'utf8');
const block = SRC.match(/const WS_BROKERS = \[([\s\S]*?)\];/);
if (!block) { console.error('could not find WS_BROKERS in lib/netplay.js'); process.exit(2); }
// Entries are `url|username|password` (lib/netplay.js parseBroker).
const BROKERS = Array.from(block[1].matchAll(/'([^']+)'/g)).map((m) => {
  const b = m[1].split('|');
  return { url: b[0], user: b[1] || '', pass: b[2] || '' };
});
// --rate N --secs S --bytes B: after the relay check, publish N/s of B bytes for
// S seconds and report loss and one-way latency — the budget a relayed room
// spends (lib/netplay.js relayInfo().rate). Default: no rate test.
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const RATE = +opt('rate', 0), SECS = +opt('secs', 20), BYTES = +opt('bytes', 300);
const ONLY = opt('only', null);

// ---- THIS BOX'S EGRESS IS A 443-ONLY FIREWALL ------------------------------
// When HTTPS_PROXY is set, every connection goes out as an HTTP CONNECT through
// it — which is how a browser behind a corporate proxy reaches a broker, and on
// this sandbox it is the ONLY way out: node's built-in WebSocket ignores the
// proxy and every broker reads "websocket error". So the WebSocket below comes
// from the `ws` package with a CONNECT-tunnelling agent. A CONNECT to a port
// the egress refuses (anything but 443 here) fails exactly as it would for a
// player behind that firewall, which is what makes this a firewall test.
import http from 'http';
import https from 'https';
import tls from 'tls';
import os from 'os';
import { createRequire } from 'module';
let WSImpl = null;
const PROXY = process.env.HTTPS_PROXY || process.env.https_proxy || '';
if (PROXY) {
  for (const t of [path.join(os.homedir(), 'probe-deps') + '/', import.meta.url]) {
    try { WSImpl = createRequire(t)('ws'); break; } catch (e) {}
  }
  if (!WSImpl) console.log('⚠ HTTPS_PROXY is set but the `ws` package is missing; connecting directly');
}
class Tunnel extends https.Agent {
  createConnection(o, cb) {
    const p = new URL(PROXY);
    const req = http.request({ host: p.hostname, port: p.port, method: 'CONNECT', path: `${o.host}:${o.port}` });
    req.on('connect', (res, sock) => {
      if (res.statusCode !== 200) return cb(new Error('proxy CONNECT ' + res.statusCode));
      const t = tls.connect({ socket: sock, servername: o.servername || o.host, ALPNProtocols: ['http/1.1'] }, () => cb(null, t));
      t.on('error', cb);
    });
    req.on('error', cb); req.end();
  }
}
function openWs(url) {
  if (WSImpl) {
    const ws = new WSImpl(url, ['mqtt'], { agent: new Tunnel(), handshakeTimeout: 12000 });
    // the browser-shaped surface the client below uses
    const shim = { binaryType: 'arraybuffer', send: (b) => ws.send(b), close: () => ws.close(), onmessage: null, onerror: null, onclose: null, onopen: null };
    ws.on('open', () => shim.onopen && shim.onopen());
    ws.on('message', (d) => shim.onmessage && shim.onmessage({ data: d }));
    ws.on('error', () => shim.onerror && shim.onerror());
    ws.on('unexpected-response', (q, r) => { shim.onerror && shim.onerror(); });
    ws.on('close', (c) => shim.onclose && shim.onclose({ code: c }));
    return shim;
  }
  return new WebSocket(url, ['mqtt']);
}

// ---- just enough MQTT 3.1.1 ------------------------------------------------
const enc = new TextEncoder();
function mkstr(s) { const b = enc.encode(s); return [b.length >> 8, b.length & 255, ...b]; }
function remlen(n) { const out = []; do { let d = n % 128; n = (n / 128) | 0; if (n > 0) d |= 128; out.push(d); } while (n > 0); return out; }
function packet(type, flags, body) { return Uint8Array.from([(type << 4) | flags, ...remlen(body.length), ...body]); }
const CONNECT = (id, user, pass) => {
  let fl = 0x02; const tail = [];
  if (user) { fl |= 0x80; tail.push(...mkstr(user)); }
  if (pass) { fl |= 0x40; tail.push(...mkstr(pass)); }
  return packet(1, 0, [...mkstr('MQTT'), 4, fl, 0, 30, ...mkstr(id), ...tail]);
};
const SUBSCRIBE = (topic, pid) => packet(8, 2, [pid >> 8, pid & 255, ...mkstr(topic), 0]);
const PUBLISH = (topic, payload) => packet(3, 0, [...mkstr(topic), ...enc.encode(payload)]);

function parse(buf) {
  // Returns [{type, body}], ignoring anything it does not need.
  const out = [];
  let i = 0;
  while (i < buf.length) {
    const type = buf[i] >> 4;
    let mult = 1, len = 0, j = i + 1, d;
    do { if (j >= buf.length) return out; d = buf[j++]; len += (d & 127) * mult; mult *= 128; } while (d & 128);
    if (j + len > buf.length) return out;
    out.push({ type, body: buf.slice(j, j + len) });
    i = j + len;
  }
  return out;
}

function client(url, tag, user, pass) {
  return new Promise((res, rej) => {
    let ws;
    const t = setTimeout(() => { try { ws && ws.close(); } catch (e) {} rej(new Error('connect timeout')); }, 12000);
    try { ws = openWs(url); } catch (e) { clearTimeout(t); return rej(e); }
    ws.binaryType = 'arraybuffer';
    const handlers = [];
    ws.onmessage = (e) => {
      const buf = new Uint8Array(e.data);
      for (const p of parse(buf)) for (const h of handlers.slice()) h(p);
    };
    ws.onerror = () => { clearTimeout(t); rej(new Error('websocket error')); };
    ws.onclose = (e) => { clearTimeout(t); rej(new Error('closed (' + e.code + ')')); };
    ws.onopen = () => {
      const onAck = (p) => {
        if (p.type !== 2) return;
        clearTimeout(t);
        const rc = p.body[1];
        handlers.splice(handlers.indexOf(onAck), 1);
        if (rc !== 0) return rej(new Error('CONNACK refused, code ' + rc));
        res({
          ws, handlers,
          sub: (topic) => new Promise((r2, j2) => {
            const to = setTimeout(() => j2(new Error('SUBACK timeout')), 10000);
            const onSub = (p2) => {
              if (p2.type !== 9) return;
              clearTimeout(to);
              handlers.splice(handlers.indexOf(onSub), 1);
              r2();
            };
            handlers.push(onSub);
            ws.send(SUBSCRIBE(topic, 1));
          }),
          onPublish: (cb) => handlers.push((p2) => { if (p2.type === 3) cb(p2.body); }),
          pub: (topic, payload) => ws.send(PUBLISH(topic, payload)),
          close: () => { try { ws.onclose = null; ws.close(); } catch (e) {} },
        });
      };
      handlers.push(onAck);
      ws.send(CONNECT(tag, user, pass));
    };
  });
}

const rand = () => Math.random().toString(16).slice(2, 10);
const res = [];
console.log(`brokers read from lib/netplay.js: ${BROKERS.length}\n`);

for (const { url, user, pass } of BROKERS) {
  if (ONLY && !url.includes(ONLY)) continue;
  const topic = 'bemental/np/check-' + rand() + rand() + rand() + rand();
  const marker = 'relayed-' + rand();
  let A = null, B = null;
  try {
    A = await client(url, 'npchk-a-' + rand(), user, pass);
    B = await client(url, 'npchk-b-' + rand(), user, pass);
    await A.sub(topic);
    const got = new Promise((r) => {
      A.onPublish((body) => {
        const tl = (body[0] << 8) | body[1];
        const payload = new TextDecoder().decode(body.slice(2 + tl));
        if (payload.includes(marker)) r(Date.now());
      });
    });
    const t0 = Date.now();
    B.pub(topic, marker);
    const t1 = await Promise.race([got, new Promise((_, j) => setTimeout(() => j(new Error('published but nothing came out the other side')), 12000))]);
    const ms = t1 - t0;
    const row = { url, ok: true, ms, port: new URL(url).port || '443' };
    res.push(row);
    console.log(`  PASS  ${url}  (port ${row.port})\n        connect=true  relayed=true  one-way ${ms} ms`);
    if (RATE > 0) {
      const lat = new Map();
      A.onPublish((body) => {
        const tl = (body[0] << 8) | body[1];
        const s2 = new TextDecoder().decode(body.slice(2 + tl));
        const m2 = /^r(\d+)\|(\d+)\|/.exec(s2);
        if (m2) lat.set(+m2[1], Date.now() - +m2[2]);
      });
      const n = Math.round(RATE * SECS), pad = 'x'.repeat(Math.max(0, BYTES - 24));
      const tr = Date.now();
      for (let i = 1; i <= n; i++) {
        B.pub(topic, `r${i}|${Date.now()}|${pad}`);
        const due = tr + (i * 1000) / RATE - Date.now();
        if (due > 0) await new Promise((r) => setTimeout(r, due));
      }
      await new Promise((r) => setTimeout(r, 3000));
      const v = Array.from(lat.values()).sort((a, b) => a - b);
      const q = (f) => (v.length ? v[Math.min(v.length - 1, Math.floor(v.length * f))] : null);
      row.rate = { perSec: RATE, secs: SECS, bytes: BYTES, sent: n, got: v.length, lossPct: +(100 * (1 - v.length / n)).toFixed(2), p50: q(0.5), p95: q(0.95), max: v[v.length - 1] };
      console.log(`        rate ${RATE}/s x ${SECS}s x ${BYTES} B (${Math.round(RATE * BYTES)} B/s): sent ${n} got ${v.length} loss ${row.rate.lossPct}%  one-way p50 ${row.rate.p50} p95 ${row.rate.p95} max ${row.rate.max} ms`);
    }
  } catch (e) {
    res.push({ url, ok: false, why: (e && e.message) || String(e) });
    console.log(`  FAIL  ${url}\n        ${(e && e.message) || e}`);
  } finally {
    try { A && A.close(); } catch (e) {}
    try { B && B.close(); } catch (e) {}
  }
}

const good = res.filter((r) => r.ok);
const good443 = good.filter((r) => r.port === '443');
console.log(`${good443.length} of them on port 443 (the only port a strict firewall leaves open)` + (PROXY ? ' — via HTTPS_PROXY' : ''));
if (process.env.OUT_JSON) fs.writeFileSync(process.env.OUT_JSON, JSON.stringify({ when: new Date().toISOString(), proxy: !!PROXY, res }, null, 2));
console.log(`\n${good.length}/${res.length} brokers actually relayed`);
// ⚠ THE BAR IS NOT "ALL OF THEM". The point of a list is that one being down is
// survivable; the point of TESTING it is that the list must not be decorative.
// One working broker ships. Fewer than two means there is no spare, which is
// the state this check exists to notice BEFORE a user does.
if (!good.length) { console.log('RESULT: FAIL — no broker relays, pairing has no path at all'); process.exit(1); }
if (!good443.length) { console.log('RESULT: FAIL — no broker on port 443 relays, so a 443-only firewall cannot pair at all'); process.exit(1); }
if (good.length < 2) { console.log('RESULT: FAIL — only one broker relays, so the fallback list is decorative'); process.exit(1); }
console.log('RESULT: PASS — there is a working broker and at least one spare');
process.exit(0);

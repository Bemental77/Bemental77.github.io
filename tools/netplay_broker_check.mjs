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
const BROKERS = Array.from(block[1].matchAll(/'([^']+)'/g)).map((m) => m[1]);

// ---- just enough MQTT 3.1.1 ------------------------------------------------
const enc = new TextEncoder();
function mkstr(s) { const b = enc.encode(s); return [b.length >> 8, b.length & 255, ...b]; }
function remlen(n) { const out = []; do { let d = n % 128; n = (n / 128) | 0; if (n > 0) d |= 128; out.push(d); } while (n > 0); return out; }
function packet(type, flags, body) { return Uint8Array.from([(type << 4) | flags, ...remlen(body.length), ...body]); }
const CONNECT = (id) => packet(1, 0, [...mkstr('MQTT'), 4, 0x02, 0, 30, ...mkstr(id)]);
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

function client(url, tag) {
  return new Promise((res, rej) => {
    let ws;
    const t = setTimeout(() => { try { ws && ws.close(); } catch (e) {} rej(new Error('connect timeout')); }, 12000);
    try { ws = new WebSocket(url, ['mqtt']); } catch (e) { clearTimeout(t); return rej(e); }
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
      ws.send(CONNECT(tag));
    };
  });
}

const rand = () => Math.random().toString(16).slice(2, 10);
const res = [];
console.log(`brokers read from lib/netplay.js: ${BROKERS.length}\n`);

for (const url of BROKERS) {
  const topic = 'bemental/np/check-' + rand() + rand() + rand() + rand();
  const marker = 'relayed-' + rand();
  let A = null, B = null;
  try {
    A = await client(url, 'npchk-a-' + rand());
    B = await client(url, 'npchk-b-' + rand());
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
    res.push({ url, ok: true, ms });
    console.log(`  PASS  ${url}\n        connect=true  relayed=true  one-way ${ms} ms`);
  } catch (e) {
    res.push({ url, ok: false, why: (e && e.message) || String(e) });
    console.log(`  FAIL  ${url}\n        ${(e && e.message) || e}`);
  } finally {
    try { A && A.close(); } catch (e) {}
    try { B && B.close(); } catch (e) {}
  }
}

const good = res.filter((r) => r.ok);
console.log(`\n${good.length}/${res.length} brokers actually relayed`);
// ⚠ THE BAR IS NOT "ALL OF THEM". The point of a list is that one being down is
// survivable; the point of TESTING it is that the list must not be decorative.
// One working broker ships. Fewer than two means there is no spare, which is
// the state this check exists to notice BEFORE a user does.
if (!good.length) { console.log('RESULT: FAIL — no broker relays, pairing has no path at all'); process.exit(1); }
if (good.length < 2) { console.log('RESULT: FAIL — only one broker relays, so the fallback list is decorative'); process.exit(1); }
console.log('RESULT: PASS — there is a working broker and at least one spare');
process.exit(0);

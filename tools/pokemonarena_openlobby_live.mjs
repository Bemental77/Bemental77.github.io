// tools/pokemonarena_openlobby_live.mjs -- the notice board (pokemonarena/js/openlobby.js) against the REAL public MQTT brokers, from two real headless Chrome pages.
//
//   node tools/pokemonarena_openlobby_live.mjs          needs internet; NOT part of any gate (the suites use in-memory brokers so they are hermetic)
//   ARENA_PORT=8097 (dev server; started if not running)   ARENA_CDP=9283
//
// What it proves that the hermetic suites cannot: the mqtt.js library really loads from the CDN, at least one of the five brokers really accepts the connection, a listing really
// crosses a real broker to a second page, a directed challenge really comes back, and a withdrawn listing really disappears. It uses a THROWAWAY TOPIC
// (bemental/arena/open/live-<random>), so nothing it does can show on the real board. It lists a game named "LiveProbe" for a few seconds on third-party brokers on that topic;
// it sends nothing else and reads nothing from anybody else.
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withBrowser } from './headless_cdp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const PORT = Number(process.env.ARENA_PORT || 8097);
const CDP = Number(process.env.ARENA_CDP || 9283);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NO_THROTTLE = ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'];
let pass = 0, fail = 0;
const ok = (c, name, d) => { if (c) { pass++; console.log('ok  ', name, d ? ':: ' + String(d).slice(0, 160) : ''); } else { fail++; console.log('FAIL', name, d || ''); } };

let server = null;
const probe = async () => { try { return (await fetch(`http://localhost:${PORT}/pokemonarena/input.css`)).ok; } catch (_e) { return false; } };
if (!(await probe())) {
  server = spawn(process.execPath, [path.join(root, 'tools', 'devserver.mjs')], { env: { ...process.env, PORT: String(PORT), WEB_ROOT: root }, stdio: 'ignore', windowsHide: true });
  for (let i = 0; i < 40 && !(await probe()); i++) await sleep(250);
}
const topic = 'bemental/arena/open/live-' + Math.random().toString(36).slice(2, 10);
const SETUP = (name) => `(async () => {
  const M = await import('/pokemonarena/js/openlobby.js');
  const brokers = M.DEFAULT_BROKERS.slice();
  const bus = M.createMqttBus(window, { brokers, topic: ${JSON.stringify(topic)} });
  const lob = M.createOpenLobbies({ bus, mine: { rom: 'a'.repeat(64), fp: 'live' }, now: () => performance.now() });
  window.__live = { M, bus, lob, got: [], name: ${JSON.stringify(name)} };
  lob.onSignal((m) => window.__live.got.push(m));
  return lob.sid;
})()`;
try {
  await withBrowser({ port: CDP, width: 800, height: 600, lock: false, args: NO_THROTTLE }, async (a) => {
    const b = await a.openTab({ width: 800, height: 600 });
    for (const p of [a, b]) await p.navigate(`http://localhost:${PORT}/pokemonarena/input.css`);
    const [sa, sb] = [await a.eval(SETUP('A')), await b.eval(SETUP('B'))];
    for (const [n, p] of [['A', a], ['B', b]]) {
      const up = await p.waitFor('window.__live.bus.status() === "up"', { timeoutMs: 30000 }).then(() => true, () => false);
      ok(up, `L1${n} page ${n} reaches at least one real broker`, JSON.stringify(await p.eval('window.__live.bus.brokers')));
    }
    ok(sa !== sb, 'L2 the two pages have different sender ids', sa + ' ' + sb);
    // a broker that is "up" has subscribed asynchronously: give both a moment before listing
    await sleep(1500);
    const t0 = Date.now();
    await a.eval('window.__live.lob.host({ room: "AL1VE", name: "LiveProbe", fmt: "3v3", rom: "a".repeat(64), fp: "live", rs: "rs", h: false, rec: [3, 1] }); true');
    await b.eval('window.__live.lob.startWatching(); true');
    const seen = await b.waitFor('window.__live.lob.list().some((g) => g.room === "AL1VE")', { timeoutMs: 30000 }).then(() => true, () => false);
    ok(seen, 'L3 a listing made on page A crosses a real broker and appears on page B', (Date.now() - t0) + ' ms');
    const row = seen ? await b.eval('window.__live.lob.list().find((g) => g.room === "AL1VE")') : null;
    ok(row && row.name === 'LiveProbe' && row.fmt === '3v3' && row.compatible === true && JSON.stringify(row.rec) === '[3,1]' && row.s === sa, 'L4 with its name, format, record and sender id intact', JSON.stringify(row));
    // a directed challenge, B -> A
    if (seen) {
      await b.eval(`window.__live.lob.signal('chal', { to: ${JSON.stringify(sa)}, r: window.__live.lob.newRequest(), name: 'Bee', pk: 'A'.repeat(43) + '.' + 'B'.repeat(43) }); true`);       // a challenge carries the challenger's one-time public key (shape only here)
      const got = await a.waitFor('window.__live.got.some((m) => m.k === "chal" && m.name === "Bee")', { timeoutMs: 20000 }).then(() => true, () => false);
      ok(got, 'L5 a challenge from B to A comes through a real broker, only to A', await a.eval('JSON.stringify(window.__live.got)'));
      ok((await b.eval('window.__live.got.length')) === 0, 'L6 and B did not receive its own message', '');
    }
    const t1 = Date.now();
    await a.eval('window.__live.lob.unhost(); true');
    const gone = await b.waitFor('!window.__live.lob.list().some((g) => g.room === "AL1VE")', { timeoutMs: 10000 }).then(() => true, () => false);
    ok(gone, 'L7 taking the listing down removes it from B at once (not after the 13 s ttl)', (Date.now() - t1) + ' ms');
    // retained messages must not exist: a page that joins AFTER the listing's host has gone sees nothing. A broker keeps only the LAST retained message of a topic, so the listing must be the last thing
    // published (a 'gone' after it would be the retained one, and the late page ignores that): A lists, waits for the beacon to be out, and drops its connection WITHOUT saying gone.
    await a.eval('window.__live.lob.host({ room: "AL2VE", name: "LiveProbe", fmt: "3v3", rom: "a".repeat(64), fp: "live", rs: "rs" }); true');
    await sleep(1500);
    await a.eval('window.__live.bus.close(); true');
    await sleep(2000);
    await b.navigate(`http://localhost:${PORT}/pokemonarena/input.css`);
    await b.eval(SETUP('B2'));
    await b.waitFor('window.__live.bus.status() === "up"', { timeoutMs: 30000 });
    await b.eval('window.__live.lob.startWatching(); true');
    await sleep(4000);
    ok((await b.eval('window.__live.lob.list().length')) === 0, 'L8 nothing is retained: a page that arrives after the host of a listing has gone (no "gone" was sent) sees nothing', await b.eval('JSON.stringify(window.__live.lob.list())'));
    // a public broker that refuses a connection, and the missing favicon, are console noise, not page errors: they are reported, not counted
    const noise = (e) => /favicon.ico|WebSocket connection to/.test(e);
    const real = a.errors.concat(b.errors).filter((e) => !noise(e));
    ok(real.length === 0, 'L9 no page errors (a broker that refuses a connection is noise: ' + new Set(a.errors.concat(b.errors).filter((e) => /WebSocket connection to/.test(e)).map((e) => (/wss:[^' ]+/.exec(e) || [''])[0])).size + ' refused)', JSON.stringify(real).slice(0, 200));
    await a.eval('window.__live.lob.close(); true'); await b.eval('window.__live.lob.close(); true');
  });
} finally { if (server) { try { server.kill(); } catch (_e) { /* ignore */ } } }
console.log(`\nopenlobby live: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

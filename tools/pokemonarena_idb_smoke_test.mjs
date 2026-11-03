#!/usr/bin/env node
// POKEMONARENA INDEXEDDB SMOKE TEST  (stage C3 / workstream R2)
//
// The Node test (tools/pokemonarena_profile_test.mjs) proves the store logic against an in-memory twin. This test proves the
// twin is not lying: it drives pokemonarena/dev/idb_smoke.html in a REAL headless Chrome (tools/headless_cdp.mjs: one browser
// at a time machine-wide, throwaway profile, bare CDP, no puppeteer) against REAL IndexedDB, a real non-extractable CryptoKey
// kept in IndexedDB, and the browser's own CompressionStream.
//
// WHAT IT RUNS
//   launch 1   phase a (fresh database): the adapter contract (12 cases), store open + functional probe, create/save, the history
//              ring, compare-and-swap between two real connections, BroadcastChannel between them, identity key in IndexedDB,
//              gzip export/import, team code, a database written by a "newer build", unavailable IndexedDB -> memory fallback
//              CROSS-ENGINE checks between this Node process and Chrome: the card bytes are byte-identical; each side decodes
//              the other's team code; each side parses the other's gzip export; each side verifies the other's ECDSA receipt
//              phase b after a RELOAD: the marker, the profile (same rev, same content), the history ring, the private key (still
//              non-extractable, still signs), the stored team code; CAS still works
//              NEGATIVE CONTROLS: mode=memory (the store lives in page memory: phase b after a reload MUST fail to find its
//              marker) and mode=nonatomic (each write commits alone: the contract's rollback and lost-update cases MUST fail)
//   restart    tools/headless_cdp.mjs gives every launch its OWN throwaway profile and deletes it (a second --user-data-dir switch
//              is ignored: Chrome keeps the first, measured with chrome://version), so it cannot show persistence across a browser
//              RESTART. That part uses a ~40-line launcher below on a profile directory this test owns and deletes, taking the same
//              machine-wide browser lock and leak-guard registration as the helper: launch X runs phase a + a reload + phase b, Chrome
//              is then closed (Browser.close, graceful, with a kill fallback), launch Y is a NEW process on the same directory and runs
//              phase b, then phase c (cleanup), then phase b once more which MUST fail (the marker is gone)
//
// WHAT IT DOES NOT PROVE (also printed): Firefox / Safari IndexedDB (Chrome only; Safari's storage policies are the usual
// surprise), quota exhaustion or eviction, private-browsing modes, behaviour with several real tabs (two connections in one tab
// are used), mobile browsers, or that navigator.storage.persist() is granted (the answer is printed, not asserted).
//
// USAGE   node tools/pokemonarena_idb_smoke_test.mjs      (no server needed: it starts tools/devserver.mjs on a free port)
// ENV     ARENA_CDP_PORT   first CDP port (default 9245; the second launch uses +1)
//         ARENA_BASE       use an already running server instead of starting one (e.g. http://localhost:8093)
//         CHROME_PATH      Chrome binary (headless_cdp.mjs default otherwise)
//
// Writes nothing in the repo. Pure ASCII.

import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { withBrowser, acquireBrowserLock, CHROME } from './headless_cdp.mjs';
import * as P from '../pokemonarena/js/profile.js';
import * as T from '../pokemonarena/js/teamcode.js';
import * as I from '../pokemonarena/js/identity.js';
import { canonicalJSON } from '../pokemonarena/js/stats.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const CDP1 = Number(process.env.ARENA_CDP_PORT || 9245);
const J = (x) => JSON.stringify(x);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
const failures = [];
function t(name, ok, detail = '') {
  if (ok === true) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; const why = typeof ok === 'string' ? ok : detail; failures.push(`${name}: ${why}`); console.log(`  FAIL ${name}${why ? '  -- ' + why : ''}`); }
}
const head = (s) => console.log(`\n== ${s}`);

function freePort() {
  return new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });
}
async function cpuBusy(ms = 1000) {
  const snap = () => os.cpus().reduce((a, c) => { const tot = Object.values(c.times).reduce((x, y) => x + y, 0); return [a[0] + tot, a[1] + c.times.idle]; }, [0, 0]);
  const a = snap(); await sleep(ms); const b = snap();
  return 100 * (1 - (b[1] - a[1]) / Math.max(1, b[0] - a[0]));
}
function killTree(pid) { try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch (_e) { /* gone */ } }

let server = null;
async function startServer() {
  if (process.env.ARENA_BASE) return process.env.ARENA_BASE.replace(/\/$/, '');
  const port = await freePort();
  server = spawn(process.execPath, [path.join(here, 'devserver.mjs')], { env: { ...process.env, PORT: String(port) }, stdio: 'ignore', windowsHide: true });
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://localhost:${port}/pokemonarena/dev/idb_smoke.html`); if (r.ok) return `http://localhost:${port}`; } catch (_e) { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('devserver did not come up on ' + port);
}

const UID = Math.random().toString(36).slice(2, 8);
const D1 = `pa-smoke-real-${UID}`, D2 = `pa-smoke-memory-${UID}`, D3 = `pa-smoke-nonatomic-${UID}`, D4 = `pa-smoke-restart-${UID}`;

async function runPage(page, base, query, label) {
  const errBefore = page.errors.length;
  await page.navigate(`${base}/pokemonarena/dev/idb_smoke.html?${query}`);
  await page.waitFor('window.__smoke && window.__smoke.done === true', { timeoutMs: 90000 });
  const s = await page.eval('JSON.parse(JSON.stringify(window.__smoke))');
  s.pageErrors = page.errors.slice(errBefore);
  console.log(`  info ${label}: ${s.passed} passed, ${s.failed} failed in the page${s.pageErrors.length ? ', ' + s.pageErrors.length + ' page error(s)' : ''}`);
  return s;
}
const failedNames = (s) => s.cases.filter((c) => !c.ok).map((c) => c.name);
const show = (s) => s.cases.filter((c) => !c.ok).map((c) => c.name + ': ' + c.detail).join(' | ').slice(0, 600);

const evalJson = async (page, expr) => page.eval(`(async () => JSON.stringify(await (${expr})))()`).then((x) => JSON.parse(x));

// ---- a minimal launcher for the restart test only (see the header): own profile directory, same lock and leak guard as the helper
async function launch(dir, port) {
  const child = spawn(CHROME, ['--headless=new', '--mute-audio', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--window-size=800,600', 'about:blank'], { stdio: 'ignore', windowsHide: true });
  try { createRequire(import.meta.url)('./browser_leak_guard.js').guard({ process: () => child, on() {} }, 'pokemonarena_idb_smoke'); } catch (_e) { /* best effort, as in the helper */ }
  let targets = null;
  for (let i = 0; i < 80 && !targets; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); } catch (_e) { await sleep(250); } }
  if (!targets) { killTree(child.pid); throw new Error('Chrome did not expose CDP on ' + port); }
  const tgt = targets.find((x) => x.type === 'page');
  const ws = new WebSocket(tgt.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('CDP websocket error'))); });
  let id = 0;
  const pending = new Map();
  const handlers = [];
  const page = { errors: [] };
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); if (m.error) rej(new Error(m.error.message)); else res(m.result); return; }
    if (m.method === 'Runtime.exceptionThrown') page.errors.push((m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description) || m.params.exceptionDetails.text);
    else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') page.errors.push('log: ' + m.params.entry.text + ' ' + (m.params.entry.url || ''));
    for (const h of handlers) h(m);
  });
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
  page.eval = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error('eval failed: ' + r.exceptionDetails.text); return r.result.value; };
  page.navigate = async (url) => {
    const loaded = new Promise((res) => { const h = (m) => { if (m.method === 'Page.loadEventFired') { handlers.splice(handlers.indexOf(h), 1); res(); } }; handlers.push(h); });
    await send('Page.navigate', { url });
    await Promise.race([loaded, sleep(15000)]);
  };
  page.waitFor = async (expr, { timeoutMs = 30000 } = {}) => {
    const t1 = Date.now();
    for (;;) { let v; try { v = await page.eval(expr); } catch (_e) { v = false; } if (v) return v; if (Date.now() - t1 > timeoutMs) throw new Error('waitFor timeout: ' + expr); await sleep(250); }
  };
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  page.closeGracefully = async () => {
    send('Browser.close').catch(() => {});
    for (let i = 0; i < 40 && !exited(); i++) await sleep(250);
    if (exited()) return { how: 'gracefully (Browser.close)', exited: true };
    killTree(child.pid);
    for (let i = 0; i < 20 && !exited(); i++) await sleep(250);
    return { how: 'by kill after Browser.close did not exit', exited: exited() };
  };
  page.kill = async () => { try { ws.close(); } catch (_e) { /* ignore */ } if (!exited()) killTree(child.pid); await sleep(400); };
  return page;
}

async function main() {
  const t0 = Date.now();
  const reap = spawnSync(process.execPath, [path.join(here, 'browser_leak_guard.js'), 'reap'], { encoding: 'utf8' });
  console.log('pokemonarena IndexedDB smoke');
  console.log(`  info leak guard: ${(reap.stdout || reap.stderr || '').trim().split('\n').pop()}`);
  console.log(`  info machine load: ${os.cpus().length} logical CPUs, ${(await cpuBusy()).toFixed(0)}% busy over 1 s (Windows has no load average; os.loadavg() is ${J(os.loadavg())})`);
  const base = await startServer();
  console.log(`  info server ${base} (${process.env.ARENA_BASE ? 'external' : 'started by this test'})`);
  const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pokemonarena-idb-smoke-'));
  try {
    head('LAUNCH 1: tools/headless_cdp.mjs withBrowser (throwaway profile)');
    await withBrowser({ port: CDP1, width: 800, height: 600 }, async (page) => {
      const ua = await page.eval('navigator.userAgent');
      console.log(`  info ${ua}`);

      head('phase a: real IndexedDB');
      const a = await runPage(page, base, `phase=a&mode=idb&db=${D1}`, 'phase a');
      t('phase a: every case passed in the page (1 environment + 12 contract + 10 store/identity/export/code cases)', a.failed === 0 && a.passed === 23, `${a.passed} passed, ${a.failed} failed: ${show(a)}`);
      t('phase a: the 12 adapter-contract cases ran on real IndexedDB', a.cases.filter((c) => c.name.startsWith('contract/') && c.name.endsWith('[idb]') && c.ok).length === 12, show(a) || 'fewer than 12 contract cases ran');
      t('phase a: no uncaught page errors', a.pageErrors.length === 0, a.pageErrors.join(' | '));
      t('phase a: the page really had a secure context, WebCrypto, IndexedDB, CompressionStream, BroadcastChannel', a.env.isSecureContext === true && a.env.subtle && a.env.indexedDB === 'object' && a.env.CompressionStream === 'function' && a.env.BroadcastChannel === 'function', J(a.env));
      console.log(`  info navigator.storage.persist(): ${J(a.data.persistence)}`);
      console.log(`  info origin ${a.env.origin}, crossOriginIsolated ${a.env.crossOriginIsolated}, storage manager ${a.env.storageManager}`);

      head('cross-engine checks (Node <-> Chrome), page still on phase a');
      const team = await evalJson(page, 'window.__arena.sampleTeam()');
      // ---- stage T1 additions (the editor's two changes to these modules, proven on REAL IndexedDB / real Chrome)
      head('T1 additions: the ROM pin is the default; delete-everything on real IndexedDB; a blocked IndexedDB falls back');
      const pin = await evalJson(page, `(async () => { const T = window.__arena.T; const team = window.__arena.sampleTeam(); const foreign = await T.encodeTeamCode({ ...team, romSha256: 'f'.repeat(64) }); const own = await T.encodeTeamCode(team); const a = await T.decodeTeamCode(foreign); const b = await T.decodeTeamCode(own); const c = await T.decodeTeamCode(foreign, { allowRomMismatch: true }); return { foreign: a.ok ? 'ACCEPTED' : a.code, own: b.ok, allowed: c.ok }; })()`);
      t('Chrome: decodeTeamCode with NO options refuses a card built for another ROM (code.rom), accepts the pinned one, and allowRomMismatch is the explicit way round it', pin.foreign === 'code.rom' && pin.own === true && pin.allowed === true, J(pin));
      const wipe = await evalJson(page, `(async () => { const S = window.__arena.S; const name = 'wipe-' + Math.random().toString(36).slice(2); const store = await S.openStore({ dbName: name, channel: false }); const a = await store.createProfile({ trainerName: 'AAA' }); await store.createProfile({ trainerName: 'BBB' }); await store.keys.put(a.id + ':k', { privateKey: null, publicKeyJwk: null, createdAt: 1 }); await store.setActiveId(a.id); await store.setMeta('x', 1); const before = (await store.listProfiles()).length; const n = await store.deleteEverything(); const after = { profiles: (await store.listProfiles()).length, key: (await store.keys.get(a.id + ':k')) === undefined, active: await store.getActiveId(), meta: (await store.getMeta('x')) === undefined, mode: store.status.mode }; await store.close(); await new Promise((r) => { const q = indexedDB.deleteDatabase(name); q.onsuccess = q.onerror = q.onblocked = () => r(); }); return { before, n, after }; })()`);
      t('Chrome real IndexedDB: deleteEverything removed both profiles, the identity key slot, the active pointer and the meta record in one go', wipe.before === 2 && wipe.n === 2 && wipe.after.profiles === 0 && wipe.after.key && wipe.after.active === null && wipe.after.meta && wipe.after.mode === 'indexeddb', J(wipe));
      const blocked = await evalJson(page, `(async () => { const S = window.__arena.S; const saved = Object.getOwnPropertyDescriptor(window, 'indexedDB'); Object.defineProperty(window, 'indexedDB', { get() { throw new DOMException('blocked by test', 'SecurityError'); }, configurable: true }); try { const store = await S.openStore({ dbName: 'blocked-' + Math.random().toString(36).slice(2), channel: false }); const st = store.status; const p = await store.createProfile({ trainerName: 'MEM' }); return { mode: st.mode, notSaved: st.notSaved, reason: String(st.reason).slice(0, 60), created: p.rev }; } catch (e) { return { threw: String(e && e.message) }; } finally { if (saved) Object.defineProperty(window, 'indexedDB', saved); else delete window.indexedDB; } })()`);
      t('Chrome: a browser whose indexedDB getter throws SecurityError falls back to memory with notSaved set (it used to die while building the adapter)', blocked.mode === 'memory' && blocked.notSaved === true && /storage-unavailable/.test(blocked.reason) && blocked.created === 1, J(blocked));
      const nodeCard = Buffer.from(T.encodeTeamBinary(team)).toString('hex');
      t('the team card bytes are byte-identical in Node and in Chrome', nodeCard === a.data.cardHex && /^[0-9a-f]+$/.test(nodeCard), `node ${nodeCard.slice(0, 40)} chrome ${String(a.data.cardHex).slice(0, 40)}`);
      const nodeCode = await T.encodeTeamCode(team);
      const chromeDecodesNode = await evalJson(page, `window.__arena.T.decodeTeamCode(${J(nodeCode)}).then((d) => d.ok ? window.__arena.canonicalJSON(d.team.mons) + '|' + d.hash : 'ERR ' + d.code)`);
      const nodeDecodesChrome = await T.decodeTeamCode(a.data.teamCode, {});
      const want = canonicalJSON(team.mons.map(T.battleView));
      t('Chrome decodes the code Node made', chromeDecodesNode === want + '|' + T.cardHash(T.encodeTeamBinary(team)), String(chromeDecodesNode).slice(0, 160));
      t('Node decodes the code Chrome made', nodeDecodesChrome.ok && canonicalJSON(nodeDecodesChrome.team.mons) === want && nodeDecodesChrome.hash === a.data.cardHash, J(nodeDecodesChrome).slice(0, 160));
      console.log(`  info the two compressed code strings are ${nodeCode === a.data.teamCode ? 'IDENTICAL' : 'different (expected: deflate output is engine-specific; only the card bytes are canonical)'} (${nodeCode.length} vs ${a.data.teamCode.length} chars)`);
      const gzBytes = Uint8Array.from(Buffer.from(a.data.exportGzBase64, 'base64'));
      const nodeParsed = await P.parseExport(gzBytes, {});
      const strip = (x) => { const c = JSON.parse(JSON.stringify(x)); delete c.rev; return canonicalJSON(c); };
      t('Node parses the gzip profile export Chrome wrote', nodeParsed.ok && nodeParsed.gzip && strip(nodeParsed.profile) === a.data.exportCanon, J(nodeParsed).slice(0, 200));
      const nodeExport = await P.exportBytes(nodeParsed.profile, { gzip: true });
      const chromeParsed = await evalJson(page, `window.__arena.P.parseExport(Uint8Array.from(atob(${J(Buffer.from(nodeExport.bytes).toString('base64'))}), (ch) => ch.charCodeAt(0)), {}).then((r) => r.ok ? window.__arena.canonicalJSON((() => { const c = JSON.parse(JSON.stringify(r.profile)); delete c.rev; return c; })()) : 'ERR ' + r.code)`);
      t('Chrome parses the gzip profile export Node wrote', chromeParsed === a.data.exportCanon, String(chromeParsed).slice(0, 160));
      const chromeReceiptOk = await I.verifyReceipt(a.data.receiptDoc, { requireKeyIds: [a.data.keyId] });
      t('Node verifies the ECDSA receipt that Chrome signed with its non-extractable IndexedDB key', chromeReceiptOk.ok, chromeReceiptOk.reasons.join('; '));
      const tamper = JSON.parse(JSON.stringify(a.data.receiptDoc));
      tamper.receipt.winner = 1;
      t('... and rejects the same receipt after one field is changed', (await I.verifyReceipt(tamper)).ok === false);
      const keys = { persistent: true, map: new Map(), async get(id) { return this.map.get(id); }, async put(id, r) { this.map.set(id, { ...r, id }); }, async delete(id) { this.map.delete(id); } };
      const nodeProfile = P.createProfile({ trainerName: 'NODE' }, undefined);
      const ens = await I.ensureIdentity(nodeProfile, keys, undefined);
      const nodeEntry = await I.signReceipt(ens.profile, keys, { v: 1, kind: 'smoke-result', matchId: 'from-node', winner: 0 });
      const nodeDoc = I.makeReceiptDoc({ v: 1, kind: 'smoke-result', matchId: 'from-node', winner: 0 }, [nodeEntry]);
      const chromeVerifies = await evalJson(page, `window.__arena.I.verifyReceipt(${J(nodeDoc)}, { requireKeyIds: [${J(nodeEntry.keyId)}] }).then((v) => v.ok ? 'ok' : v.reasons.join('; '))`);
      t('Chrome verifies the ECDSA receipt that Node signed', chromeVerifies === 'ok', String(chromeVerifies));

      head('phase b after a RELOAD (same Chrome process, new document)');
      const b = await runPage(page, base, `phase=b&mode=idb&db=${D1}`, 'phase b (reload)');
      t('phase b: marker, profile, history ring, private key, team code and CAS all survived the reload', b.failed === 0 && b.passed >= 6, `${b.passed} passed, ${b.failed} failed: ${show(b)}`);
      t('phase b: no uncaught page errors', b.pageErrors.length === 0, b.pageErrors.join(' | '));
      const afterDoc = b.data.receiptDocAfter;
      const afterOk = await I.verifyReceipt(afterDoc, { requireKeyIds: [a.data.keyId] });
      t('a receipt signed AFTER the reload by the key read back from IndexedDB verifies in Node under the original public key', afterOk.ok && afterDoc.signatures[0].keyId === a.data.keyId, afterOk.reasons.join('; '));

      head('negative control 1: the store lives in page memory (mode=memory)');
      const ma = await runPage(page, base, `phase=a&mode=memory&db=${D2}`, 'memory phase a');
      t('memory control, phase a: passes (memory is internally consistent)', ma.failed === 0, show(ma));
      const mb = await runPage(page, base, `phase=b&mode=memory&db=${D2}`, 'memory phase b (reload)');
      const markerCase = 'persist/the state marker written before the reload is there [memory]';
      t('memory control, phase b after the reload: FAILS on the marker, so the persistence check can fail', failedNames(mb).includes(markerCase), `failed: ${failedNames(mb).join(', ') || 'nothing'}`);

      head('negative control 2: writes that commit one by one (mode=nonatomic)');
      const na = await runPage(page, base, `phase=a&mode=nonatomic&db=${D3}`, 'nonatomic phase a');
      const fn = failedNames(na);
      t('non-atomic control: the rollback case FAILS', fn.includes('contract/error-rolls-back-every-write-and-propagates [nonatomic]'), `failed: ${fn.join(', ') || 'nothing'}`);
      t('non-atomic control: the lost-update case FAILS', fn.includes('contract/read-modify-write-is-serialised-no-lost-update [nonatomic]'), `failed: ${fn.join(', ') || 'nothing'}`);
      t('non-atomic control: the other contract cases that do not depend on atomicity still pass', na.cases.filter((c) => c.ok).length >= 8, `${na.cases.filter((c) => c.ok).length} passed`);
    });

    head('RESTART PERSISTENCE: two Chrome processes on one user-data-dir');
    const release = await acquireBrowserLock();
    try {
      const x = await launch(persistDir, CDP1 + 1);
      let how;
      try {
        const a4 = await runPage(x, base, `phase=a&mode=idb&db=${D4}`, 'launch X phase a');
        t('launch X, phase a: every case passed', a4.failed === 0 && a4.passed === 23, show(a4));
        const b4 = await runPage(x, base, `phase=b&mode=idb&db=${D4}`, 'launch X phase b (reload)');
        t('launch X, phase b after a reload: everything survived', b4.failed === 0 && b4.passed >= 6, show(b4));
        how = await x.closeGracefully();
      } finally { await x.kill(); }
      t('Chrome exited (' + how.how + ')', how.exited, J(how));
      const idbDir = path.join(persistDir, 'Default', 'IndexedDB');
      t('Chrome wrote its IndexedDB into the directory this test owns, so the next launch really reads old data', fs.existsSync(idbDir) && fs.readdirSync(idbDir).some((n) => n.includes('indexeddb')), 'no *indexeddb* entry in ' + idbDir);
      const y = await launch(persistDir, CDP1 + 2);
      try {
        const b5 = await runPage(y, base, `phase=b&mode=idb&db=${D4}`, 'launch Y phase b (NEW process)');
        t('launch Y, a new Chrome process: marker, profile (rev advanced by launch X), history ring, private key, team code and CAS', b5.failed === 0 && b5.passed >= 6, show(b5));
        t('launch Y: no uncaught page errors', b5.pageErrors.length === 0, b5.pageErrors.join(' | '));
        const rd = await I.verifyReceipt(b5.data.receiptDocAfter, {});
        t('launch Y: the key read back from disk after a restart still produces receipts that verify in Node', rd.ok, rd.reasons.join('; '));
        const c = await runPage(y, base, `phase=c&mode=idb&db=${D4}`, 'launch Y phase c (cleanup)');
        t('cleanup: the databases are deleted', c.failed === 0, show(c));
        const gone = await runPage(y, base, `phase=b&mode=idb&db=${D4}`, 'launch Y phase b after cleanup');
        t('after cleanup, phase b FAILS on the marker: a deleted database is noticed', failedNames(gone).includes('persist/the state marker written before the reload is there [idb]'), `failed: ${failedNames(gone).join(', ') || 'nothing'}`);
      } finally { await y.kill(); }
    } finally { release(); }
  } finally {
    if (server) killTree(server.pid);
    await sleep(500);
    try { fs.rmSync(persistDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch (e) { console.log('  info could not delete the throwaway profile ' + persistDir + ': ' + e.message); }
  }
  const reap2 = spawnSync(process.execPath, [path.join(here, 'browser_leak_guard.js'), 'reap'], { encoding: 'utf8' });
  console.log(`\n  info leak guard after the run: ${(reap2.stdout || reap2.stderr || '').trim().split('\n').pop()}`);
  console.log(`\n== RESULT\n  ${passed} passed, ${failed} failed  (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  console.log('  NOT proven here: Firefox / Safari IndexedDB, quota exhaustion or eviction, private-browsing modes, several real tabs (two connections in one tab are used),');
  console.log('  mobile browsers, a granted storage.persist() (the answer is printed, not asserted).');
  if (failed) { console.log('\nFAILURES:'); for (const f of failures) console.log('  ' + f); process.exit(1); }
}

main().catch((e) => { console.error(e); if (server) killTree(server.pid); process.exit(2); });

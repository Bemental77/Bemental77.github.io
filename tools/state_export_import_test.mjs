#!/usr/bin/env node
// Standing gate for EXPORT / IMPORT SAVE STATE on ps1.html, snes.html,
// genesis.html and n64/index.html.
//
// WHY IT EXISTS: a save state that only lives in one browser's IndexedDB is one
// cleared-site-data away from gone, and cannot move to another device. The four
// pages above had a save/load path but no way to get the bytes OUT. gba.html got
// Export/Import first (gba/gbaWasm/dist/script.js exportStateLocal/importStateLocal);
// this asserts the same four properties on the other four pages.
//
// WHAT EACH ARM MEASURES — all measured values, never a property being present:
//   1. BYTE-EXACT EXPORT. sha256 of the bytes stored in the page's OWN IndexedDB
//      key, versus sha256 of the file the Export button actually wrote to disk.
//      A length compare alone would pass on a re-encode that changed content, so
//      the assertion is on the digest.
//   2. BYTE-EXACT ROUND TRIP. Import the exported file back and re-read the
//      stored bytes: same digest. Proves import stores what export wrote, with
//      no re-encoding step in between.
//   3. JUNK IMPORT REFUSED, GOOD STATE SURVIVES. Feed a file with no gzip magic.
//      The page must refuse it AND the stored digest must be unchanged — writing
//      an unreadable blob over a good state destroys the thing the visitor was
//      trying to protect.
//   4. TRUNCATED-GZIP IMPORT REFUSED. A file that keeps the 1f 8b magic but whose
//      body is cut in half passes a magic-only check. These pages also run the
//      stream through DecompressionStream before storing it, so a half-written
//      download is refused too — and again the stored digest must not move.
//   5. (n64 only) SAVE-MEMORY ROUTING. n64 keeps the cartridge save memory in a
//      SECOND IndexedDB entry (<rom>.sram, a fixed 296,960-byte image), because
//      the savestate stores only the flashram mode/status. A 296,960-byte import
//      must land on the .sram key and must NOT overwrite the state.
//
// The page is driven through its REAL buttons (#btnSave / #btnExport / #btnImport),
// not through internal functions, so the wiring is under test too.
//
// USAGE   npm run web                                  # required: http://localhost:8080
//         node tools/browser_leak_guard.js reap && uptime
//         node tools/state_export_import_test.mjs
//         PAGES=snes,genesis HEADFUL=1 node tools/state_export_import_test.mjs
// Serialize against other browser harnesses on a shared box.

import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const guard = require('./browser_leak_guard.js');

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ORIGIN = process.env.ORIGIN || 'http://localhost:8080';
const SCRATCH = process.env.SCRATCH ||
  '/private/tmp/claude-501/-Users-caseybement-Bemental77-github-io/67bfe5d2-d703-4b56-897a-da90f004135a/scratchpad';
const BOOT_MS = parseInt(process.env.BOOT_MS || '180000', 10);
const PLAY_MS = parseInt(process.env.PLAY_MS || '6000', 10);

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── page adapters ────────────────────────────────────────────────────────────
// Each names the page's OWN existing storage — nothing here invents a key.
const PAGES = {
  ps1: {
    url: '/ps1.html',
    db: 'PS1WASMDB', store: 'PS1WASMSTATES',
    // SAVE_KEY = ROM_NAME + '.ps1state' (ps1.html:807). The page's script is an
    // IIFE, so the key is not reachable from window — it is DISCOVERED from the
    // store instead, which also keeps the rig honest about which key was written.
    keySuffix: '.ps1state',
    romIdx: parseInt(process.env.PS1_ROM_IDX || '3', 10),   // Harry Potter, the smallest disc
    coi: true,
    // ps1.html arms #btnSave the moment it hands the disc to the worker
    // (fetchRomStreamAndBoot / fetchRomLazyAndBoot), which is well BEFORE the
    // machine is running — a SaveState issued then never returns. #fps only gets
    // text once a frame has actually rendered, so that is the real ready signal.
    ready: (page, ms) => page.waitForFunction(
      () => /FPS:/.test(document.getElementById('fps').textContent || ''),
      { timeout: ms, polling: 1000 }),
  },
  snes: {
    url: '/snes.html',
    db: 'SNESWASMDB', store: 'SNESWASMSTATES',
    // saveKey() = romName + '.snesstate' (snes.html)
    keySuffix: '.snesstate',
    romIdx: 0,
    coi: true,
  },
  genesis: {
    url: '/genesis.html',
    db: 'GENESISWASMDB', store: 'GENESISWASMSTATES',
    // saveKey() = romName + '.genstate' (genesis.html)
    keySuffix: '.genstate',
    romIdx: 0,
    coi: false,
  },
  n64: {
    url: '/n64/',
    db: 'N64WASMDB', store: 'N64WASMSTATES',
    // script.js:958 keys the state on rom_name with NO suffix; the cartridge
    // save memory is the same name + '.sram' (script.js:933).
    keySuffix: '',
    romIdx: parseInt(process.env.N64_ROM_IDX || '13', 10),  // The New Tetris (small, boots fast)
    coi: false,
    saveMemSuffix: '.sram',
    saveMemBytes: 0x800 + 0x8000 + 4 * 0x8000 + 0x20000,    // 296960, libretronew.c:1462-1474
  },
};

const want = (process.env.PAGES || 'ps1,snes,genesis,n64').split(',').map(s => s.trim()).filter(Boolean);

// ── in-page helpers (all read the DB directly, independent of the app) ───
// Real functions, passed to page.evaluate with args — a string pageFunction is
// evaluated as a bare expression and would silently drop the arguments.
//
// ⚠ THE RIG MUST NEVER CREATE THE DATABASE. `indexedDB.open(name)` with no
// version CREATES an empty version-1 database when none exists — and the pages'
// own openDB() then finds version 1 already current, never fires
// onupgradeneeded, and dies on `transaction(...)` with "One of the specified
// object stores was not found". That is exactly what happened on ps1 the first
// time this ran: the rig polled for the state while the PS1 save was still in
// flight (its save round-trips the whole worker heap, which takes seconds), the
// poll created PS1WASMDB, and the page's save then failed. A rig that breaks the
// thing it measures reports a page bug that is not there. So: check
// indexedDB.databases() first and open NOTHING that is not already there.
async function idbKeys(page, dbName, storeName) {
  return page.evaluate(async (dbName, storeName) => {
    const dbs = await indexedDB.databases();
    if (!dbs.some(d => d.name === dbName)) return [];
    return new Promise((res) => {
    const q = indexedDB.open(dbName);
    q.onsuccess = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(storeName)) { res([]); return; }
      const out = [];
      const st = db.transaction(storeName, 'readonly').objectStore(storeName);
      st.openCursor().onsuccess = (ev) => {
        const c = ev.target.result;
        if (c) { out.push(String(c.key)); c.continue(); } else res(out);
      };
    };
    q.onerror = () => res([]);
    });
  }, dbName, storeName);
}

async function idbRead(page, dbName, storeName, key) {
  return page.evaluate(async (dbName, storeName, key) => {
    const dbs = await indexedDB.databases();
    if (!dbs.some(d => d.name === dbName)) return null;
    return new Promise((res) => {
    const q = indexedDB.open(dbName);
    q.onsuccess = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(storeName)) { res(null); return; }
      const t = db.transaction(storeName, 'readonly').objectStore(storeName).get(key);
      t.onsuccess = async () => {
        const v = t.result;
        if (!v) { res(null); return; }
        const b = v instanceof Uint8Array ? v : new Uint8Array(v);
        const d = await crypto.subtle.digest('SHA-256', b);
        res({ bytes: b.byteLength, sha: [...new Uint8Array(d)].map(x => x.toString(16).padStart(2, '0')).join('') });
      };
      t.onerror = () => res(null);
    };
    q.onerror = () => res(null);
    });
  }, dbName, storeName, key);
}

// Which key did Save State actually write? Read the store's keys rather than
// reconstructing the name from page internals the IIFE does not expose.
function pickKey(keys, suffix) {
  if (suffix) return keys.filter(k => k.endsWith(suffix)).sort()[0] || null;
  return keys.filter(k => !k.endsWith('.sram')).sort()[0] || null;   // n64
}

function shaOfFile(p) {
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function newDownloads(dir, seen) {
  return fs.readdirSync(dir)
    .filter(f => !f.endsWith('.crdownload') && !seen.has(f))
    .map(f => path.join(dir, f));
}

async function waitForDownloads(dir, seen, count, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const fresh = newDownloads(dir, seen);
    if (fresh.length >= count) { await sleep(300); return newDownloads(dir, seen); }
    await sleep(150);
  }
  return newDownloads(dir, seen);
}

// ── the run ──────────────────────────────────────────────────────────────────
const results = [];
const dlRoot = path.join(SCRATCH, 'state-xfer-dl');
fs.rmSync(dlRoot, { recursive: true, force: true });
fs.mkdirSync(dlRoot, { recursive: true });

// A junk file: 4 KB of bytes whose first two are deliberately NOT 1f 8b.
const junkPath = path.join(dlRoot, 'junk.not-a-state.bin');
{
  const b = Buffer.alloc(4096);
  for (let i = 0; i < b.length; i++) b[i] = (i * 7 + 13) & 0xff;
  b[0] = 0x4a; b[1] = 0x55;   // 'JU'
  fs.writeFileSync(junkPath, b);
}

for (const name of want) {
  const cfg = PAGES[name];
  if (!cfg) { log(`!! unknown page '${name}'`); continue; }
  const fails = [];
  const facts = {};
  const profile = path.join(SCRATCH, 'state-xfer-profile-' + name);
  const dlDir = path.join(dlRoot, name);
  fs.rmSync(profile, { recursive: true, force: true });
  fs.mkdirSync(dlDir, { recursive: true });

  log(`\n================ ${name} (${cfg.url}) ================`);
  const browser = await puppeteer.launch({
    headless: process.env.HEADFUL === '1' ? false : 'new',
    executablePath: CHROME,
    userDataDir: profile,
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--window-size=1920,1080'],
  });
  try { guard.guard(browser); } catch (e) { log('  [guard] not registered:', e.message); }

  try {
    const page = (await browser.pages())[0];
    await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
    page.on('pageerror', e => log('  [pageerror]', String(e).slice(0, 200)));
    if (process.env.PAGE_LOG === '1') page.on('console', m => log('  [page]', m.text().slice(0, 220)));
    const cdp = await page.createCDPSession();
    await cdp.send('Browser.setDownloadBehavior', {
      behavior: 'allow', downloadPath: dlDir, eventsEnabled: true,
    }).catch(async () => {
      await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir });
    });

    // coi-serviceworker reloads the page once on a fresh profile; a second goto
    // lands on the already-isolated page instead of racing that reload.
    await page.goto(ORIGIN + cfg.url, { waitUntil: 'networkidle2', timeout: 90000 });
    if (cfg.coi) { await sleep(1500); await page.goto(ORIGIN + cfg.url, { waitUntil: 'networkidle2', timeout: 90000 }); }
    facts.crossOriginIsolated = await page.evaluate(() => window.crossOriginIsolated === true);

    // Start the selected ROM through the page's own controls.
    await page.waitForSelector('#btnStart', { timeout: 30000 });
    await page.evaluate((i) => {
      const s = document.getElementById('romSelect');
      if (s) { s.value = String(i); s.dispatchEvent(new Event('change')); }
    }, cfg.romIdx);
    await page.click('#btnStart');
    log('  start pressed, waiting for Save State to arm…');
    await page.waitForFunction(() => {
      const b = document.getElementById('btnSave');
      return b && !b.disabled;
    }, { timeout: BOOT_MS, polling: 500 });
    if (cfg.ready) { log('  buttons armed, waiting for the machine to actually run…'); await cfg.ready(page, BOOT_MS); }
    await sleep(PLAY_MS);   // let the machine actually run before snapshotting it

    // ── save a state through the page's own button ────────────────────────
    await page.evaluate(() => { document.getElementById('toast').textContent = ''; });
    await page.click('#btnSave');
    let key = null, stored = null;
    for (let i = 0; i < 240 && !stored; i++) {
      key = pickKey(await idbKeys(page, cfg.db, cfg.store), cfg.keySuffix);
      if (key) stored = await idbRead(page, cfg.db, cfg.store, key);
      if (!stored) await sleep(500);
    }
    facts.key = key;
    facts.allKeys = await idbKeys(page, cfg.db, cfg.store);
    log('  storage key:', JSON.stringify(key), 'in', cfg.db + '/' + cfg.store, '| all keys:', JSON.stringify(facts.allKeys));
    if (!stored) {
      const t = await page.evaluate(() => ({ toast: document.getElementById('toast').textContent, status: (document.getElementById('status') || {}).textContent }));
      fails.push('Save State never wrote a state to ' + cfg.db + '/' + cfg.store + ' (toast="' + t.toast + '" status="' + t.status + '")');
      throw new Error('no state');
    }
    facts.stored = stored;
    log(`  stored: ${stored.bytes} B  sha256=${stored.sha}`);

    // ── 1. EXPORT: the file on disk must be the stored bytes, digest-for-digest
    const seen = new Set(fs.readdirSync(dlDir));
    await page.click('#btnExport');
    const files = await waitForDownloads(dlDir, seen, 1);
    if (!files.length) { fails.push('Export wrote no file'); }
    else {
      const stateFile = files.find(f => shaOfFile(f) === stored.sha) || files[0];
      const exp = { bytes: fs.statSync(stateFile).size, sha: shaOfFile(stateFile) };
      facts.exported = { name: path.basename(stateFile), ...exp };
      log(`  exported "${path.basename(stateFile)}": ${exp.bytes} B  sha256=${exp.sha}`);
      if (files.length > 1) log('  (also wrote: ' + files.filter(f => f !== stateFile).map(f => path.basename(f) + ' ' + fs.statSync(f).size + ' B').join(', ') + ')');
      if (exp.sha !== stored.sha) fails.push(`exported bytes differ from stored bytes (${exp.sha} vs ${stored.sha})`);
      if (exp.bytes !== stored.bytes) fails.push(`exported length ${exp.bytes} != stored length ${stored.bytes}`);

      // ── 2. IMPORT the export back: stored digest must be unchanged ───────
      await page.evaluate(() => { document.getElementById('toast').textContent = ''; });
      const [chooser] = await Promise.all([
        page.waitForFileChooser({ timeout: 20000 }),
        page.click('#btnImport'),
      ]);
      await chooser.accept([stateFile]);
      await page.waitForFunction(() => (document.getElementById('toast').textContent || '').length > 0,
        { timeout: 60000 }).catch(() => {});
      facts.importToast = await page.evaluate(() => document.getElementById('toast').textContent);
      const after = await idbRead(page, cfg.db, cfg.store, key);
      log(`  after re-import: ${after ? after.bytes + ' B sha256=' + after.sha : 'MISSING'}   toast="${facts.importToast}"`);
      if (!after) fails.push('re-import destroyed the stored state');
      else if (after.sha !== stored.sha) fails.push(`round trip is not byte-exact (${after.sha} vs ${stored.sha})`);
      if (!/import/i.test(facts.importToast || '')) fails.push('import produced no import message: "' + facts.importToast + '"');
    }

    // ── 3b. A TRUNCATED gzip keeps the magic; only a real decompress catches it
    if (facts.exported) {
      const truncPath = path.join(dlRoot, name + '.truncated.gz');
      const full = fs.readFileSync(path.join(dlDir, facts.exported.name));
      fs.writeFileSync(truncPath, full.subarray(0, Math.max(16, Math.floor(full.length / 2))));
      await page.evaluate(() => { document.getElementById('toast').textContent = ''; });
      const [chooserT] = await Promise.all([
        page.waitForFileChooser({ timeout: 20000 }),
        page.click('#btnImport'),
      ]);
      await chooserT.accept([truncPath]);
      await page.waitForFunction(() => (document.getElementById('toast').textContent || '').length > 0,
        { timeout: 60000 }).catch(() => {});
      facts.truncToast = await page.evaluate(() => document.getElementById('toast').textContent);
      const afterTrunc = await idbRead(page, cfg.db, cfg.store, key);
      log(`  after truncated-gzip import: ${afterTrunc ? afterTrunc.bytes + ' B sha256=' + afterTrunc.sha : 'MISSING'}   toast="${facts.truncToast}"`);
      if (!afterTrunc) fails.push('a truncated-gzip import DESTROYED the stored state');
      else if (afterTrunc.sha !== stored.sha) fails.push('a truncated-gzip import CHANGED the stored state');
      if (!/corrupt|not a|not an|refus/i.test(facts.truncToast || '')) fails.push('truncated gzip was not visibly refused: "' + facts.truncToast + '"');
    }

    // ── 4. JUNK IMPORT must be refused and must not touch the good state ──
    await page.evaluate(() => { document.getElementById('toast').textContent = ''; });
    const [chooser2] = await Promise.all([
      page.waitForFileChooser({ timeout: 20000 }),
      page.click('#btnImport'),
    ]);
    await chooser2.accept([junkPath]);
    await page.waitForFunction(() => (document.getElementById('toast').textContent || '').length > 0,
      { timeout: 30000 }).catch(() => {});
    facts.junkToast = await page.evaluate(() => document.getElementById('toast').textContent);
    const afterJunk = await idbRead(page, cfg.db, cfg.store, key);
    log(`  after junk import: ${afterJunk ? afterJunk.bytes + ' B sha256=' + afterJunk.sha : 'MISSING'}   toast="${facts.junkToast}"`);
    if (!afterJunk) fails.push('a junk import DESTROYED the stored state');
    else if (afterJunk.sha !== stored.sha) fails.push('a junk import CHANGED the stored state');
    if (!/not a|not an|corrupt|refus/i.test(facts.junkToast || '')) fails.push('junk import was not visibly refused: "' + facts.junkToast + '"');

    // ── 5. n64 only: a 296,960 B save-memory image routes to the .sram key ─
    if (cfg.saveMemSuffix) {
      const smPath = path.join(dlRoot, 'n64.savememory.bin');
      const sm = Buffer.alloc(cfg.saveMemBytes);
      for (let i = 0; i < sm.length; i += 977) sm[i] = (i / 977) & 0xff;
      fs.writeFileSync(smPath, sm);
      const smKey = key + cfg.saveMemSuffix;
      await page.evaluate(() => { document.getElementById('toast').textContent = ''; });
      const [chooser3] = await Promise.all([
        page.waitForFileChooser({ timeout: 20000 }),
        page.click('#btnImport'),
      ]);
      await chooser3.accept([smPath]);
      await page.waitForFunction(() => (document.getElementById('toast').textContent || '').length > 0,
        { timeout: 30000 }).catch(() => {});
      facts.saveMemToast = await page.evaluate(() => document.getElementById('toast').textContent);
      const smStored = await idbRead(page, cfg.db, cfg.store, smKey);
      const stateStill = await idbRead(page, cfg.db, cfg.store, key);
      const smSha = require('crypto').createHash('sha256').update(sm).digest('hex');
      log(`  save-memory import -> key ${JSON.stringify(smKey)}: ${smStored ? smStored.bytes + ' B sha256=' + smStored.sha : 'MISSING'}   toast="${facts.saveMemToast}"`);
      if (!smStored) fails.push('a 296,960 B save-memory image was not stored at the .sram key');
      else if (smStored.sha !== smSha) fails.push('save-memory bytes were altered on import');
      if (!stateStill || stateStill.sha !== stored.sha) fails.push('the save-memory import clobbered the save STATE');
      facts.saveMem = { key: smKey, bytes: smStored && smStored.bytes, sha: smStored && smStored.sha, expectSha: smSha };
    }
  } catch (e) {
    fails.push('harness: ' + (e && e.message ? e.message : String(e)));
  } finally {
    await browser.close().catch(() => {});
  }

  results.push({ name, fails, facts });
  log(fails.length ? `  [${name}] FAILED (${fails.length})` : `  [${name}] PASSED`);
  for (const f of fails) log('    FAIL — ' + f);
}

log('\n=================== SUMMARY ===================');
let bad = 0;
for (const r of results) {
  const s = r.facts.stored, e = r.facts.exported;
  log(`${r.fails.length ? 'FAIL' : 'PASS'}  ${r.name.padEnd(8)} key=${JSON.stringify(r.facts.key || '?')}`);
  if (s) log(`        stored   ${String(s.bytes).padStart(10)} B  ${s.sha}`);
  if (e) log(`        exported ${String(e.bytes).padStart(10)} B  ${e.sha}   (${e.name})`);
  if (r.facts.truncToast !== undefined) log(`        truncated gzip: "${r.facts.truncToast}"`);
  if (r.facts.junkToast !== undefined) log(`        junk import:    "${r.facts.junkToast}"`);
  if (r.facts.saveMem) log(`        save memory -> ${r.facts.saveMem.key} ${r.facts.saveMem.bytes} B ${r.facts.saveMem.sha}`);
  if (r.fails.length) bad++;
}
fs.writeFileSync(path.join(SCRATCH, 'state-export-import.json'), JSON.stringify(results, null, 2));
log(`\nfull JSON: ${path.join(SCRATCH, 'state-export-import.json')}`);
log(bad ? `\n[state-xfer] FAILED (${bad}/${results.length} pages)` : `\n[state-xfer] PASSED (${results.length}/${results.length} pages)`);
process.exit(bad ? 1 : 0);

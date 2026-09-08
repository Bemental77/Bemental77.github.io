#!/usr/bin/env node
// AUDIT RIG — written 2026-09-08 by an independent auditor.
//
// WHAT tools/state_export_import_test.mjs ACTUALLY PROVES, AND WHAT IT CANNOT
// ----------------------------------------------------------------------------
// Its arm 2, "BYTE-EXACT ROUND TRIP", does this (state_export_import_test.mjs:298-311):
//     export  -> file          (file sha == stored sha, asserted at :295)
//     import  <- that file
//     re-read the SAME key in the SAME profile -> assert sha unchanged
// The key already held those exact bytes before the import. **An import that did
// nothing at all would pass that assertion**, because "unchanged" is the pass
// condition and a no-op leaves it unchanged. The only thing standing between a
// dead Import button and a green arm 2 is the toast regex at :312.
//
// It also never clicks Load State. Nothing in that file asserts that an imported
// state RESTORES a machine — and the whole point of Export/Import is to carry a
// save to another browser or another device, which it never leaves.
//
// WHAT THIS RIG DOES INSTEAD — the import has to CHANGE something
//   Profile A: boot, drive the game to a distinctive scene, Save, Export.
//   Profile B: a SEPARATE user-data directory — a different browser as far as
//              IndexedDB, storage and service workers are concerned. Boot the
//              same ROM, leave it somewhere ELSE, Save. Now B's stored state is a
//              DIFFERENT blob (asserted: sha_B != sha_A).
//   Then import A's file into B and require the stored bytes to BECOME sha_A.
//   A no-op import fails this. So does an import that writes to the wrong key.
//   Then click Load State in B and measure whether the picture actually moves to
//   A's scene: the coarse block signature of B's canvas is compared against the
//   one captured in A at the moment of saving, and against B's own pre-load
//   picture. Restoring means the distance to A collapses.
//
// USAGE
//   node tools/browser_leak_guard.js reap && uptime
//   npm run web
//   node tools/audit_save_crossprofile.mjs genesis snes
import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execSync } from 'child_process';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ORIGIN = process.env.ORIGIN || 'http://localhost:8080';
const SCRATCH = process.env.SCRATCH ||
  '/private/tmp/claude-501/-Users-caseybement-Bemental77-github-io/67bfe5d2-d703-4b56-897a-da90f004135a/scratchpad';
const BOOT_MS = +(process.env.BOOT_MS || 240000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGES = {
  genesis: { url: '/genesis.html', db: 'GENESISWASMDB', store: 'GENESISWASMSTATES', keySuffix: '.genstate', romIdx: 0, coi: true,
             // A: press Start to leave the title screen. B: never press anything.
             advance: ['Enter'], canvas: 'canvas' },
  snes:    { url: '/snes.html',    db: 'SNESWASMDB',    store: 'SNESWASMSTATES',    keySuffix: '.snesstate', romIdx: 0, coi: true,
             advance: ['Enter'], canvas: 'canvas' },
};

const log = (...a) => console.log(...a);
const rec = [];
const ok  = (n, d) => { rec.push({ n, ok: true }); log(`  PASS  ${n}  ${d}`); };
const bad = (n, d) => { rec.push({ n, ok: false }); log(`  FAIL  ${n}  ${d}`); };
const info = (n, d) => log(`  ....  ${n}  ${d}`);

// The rig must never CREATE the database — state_export_import_test.mjs:114-123
// records that indexedDB.open() with no version creates an empty v1 DB and then
// breaks the page's own openDB(). Check databases() first.
async function idbAll(page, dbName, storeName) {
  return page.evaluate(async (dbName, storeName) => {
    const dbs = await indexedDB.databases();
    if (!dbs.some((d) => d.name === dbName)) return { exists: false, entries: [] };
    return new Promise((res) => {
      const q = indexedDB.open(dbName);
      q.onsuccess = async (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(storeName)) return res({ exists: true, entries: [] });
        const out = [];
        const st = db.transaction(storeName, 'readonly').objectStore(storeName);
        st.openCursor().onsuccess = async (ev) => {
          const c = ev.target.result;
          if (c) {
            const v = c.value;
            const b = v instanceof Uint8Array ? v : (v && v.byteLength !== undefined ? new Uint8Array(v) : null);
            let sha = null;
            if (b) { const d = await crypto.subtle.digest('SHA-256', b);
                     sha = [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join(''); }
            out.push({ key: String(c.key), bytes: b ? b.byteLength : 0, sha });
            c.continue();
          } else res({ exists: true, entries: out });
        };
      };
      q.onerror = () => res({ exists: false, entries: [] });
    });
  }, dbName, storeName);
}

// Coarse 4x3 block-mean signature of the EMULATOR'S OWN canvas (not a video).
// Same shape as the netplay judge so the numbers are comparable, but read
// straight off the page there is no codec in the way at all.
async function canvasSig(page, sel) {
  return page.evaluate((sel) => {
    const src = document.querySelector(sel);
    if (!src) return null;
    const c = document.createElement('canvas'); c.width = 160; c.height = 120;
    const g = c.getContext('2d', { willReadFrequently: true });
    try { g.drawImage(src, 0, 0, 160, 120); } catch (e) { return null; }
    const d = g.getImageData(0, 0, 160, 120).data;
    const gw = 4, gh = 3, acc = new Float64Array(12), cnt = new Float64Array(12);
    let nonBlack = 0;
    for (let y = 0; y < 120; y++) for (let x = 0; x < 160; x++) {
      const k = (y * 160 + x) * 4, lum = d[k] + d[k + 1] + d[k + 2];
      if (d[k] | d[k + 1] | d[k + 2]) nonBlack++;
      acc[((y * gh / 120) | 0) * gw + ((x * gw / 160) | 0)] += lum / 3;
      cnt[((y * gh / 120) | 0) * gw + ((x * gw / 160) | 0)]++;
    }
    return { means: Array.from(acc, (a, i) => +(a / cnt[i]).toFixed(2)), nonBlack };
  }, sel);
}
const dist = (a, b) => (a && b)
  ? +Math.sqrt(a.means.reduce((s, v, i) => s + (v - b.means[i]) ** 2, 0) / a.means.length).toFixed(2)
  : null;
// Averaged over several samples so an animating scene is represented by its
// centre rather than by whichever frame happened to be up.
async function sigAvg(page, sel, n = 6, gap = 220) {
  const s = [];
  for (let i = 0; i < n; i++) { const v = await canvasSig(page, sel); if (v) s.push(v); await sleep(gap); }
  if (!s.length) return null;
  return { means: s[0].means.map((_, i) => +(s.reduce((t, x) => t + x.means[i], 0) / s.length).toFixed(2)),
           nonBlack: Math.max(...s.map((x) => x.nonBlack)) };
}

async function openProfile(cfg, tag, dlDir) {
  const profile = path.join(SCRATCH, 'audit-xprof-' + tag);
  fs.rmSync(profile, { recursive: true, force: true });
  fs.mkdirSync(profile, { recursive: true });
  const browser = await puppeteer.launch({
    headless: 'new', executablePath: CHROME, userDataDir: profile,
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required',
           '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
           '--disable-renderer-backgrounding', '--window-size=1280,900'],
  });
  try { (await import('./browser_leak_guard.js')).default.guard(browser, 'audit_save_crossprofile'); } catch (_e) {}
  const page = (await browser.pages())[0];
  page.on('pageerror', (e) => log(`  [${tag} pageerror] ${String(e).slice(0, 160)}`));
  const cdp = await page.createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir, eventsEnabled: true })
    .catch(async () => cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir }));
  try { await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }); } catch (e) {}
  await page.goto(ORIGIN + cfg.url, { waitUntil: 'networkidle2', timeout: 90000 });
  if (cfg.coi) { await sleep(1800); await page.goto(ORIGIN + cfg.url, { waitUntil: 'networkidle2', timeout: 90000 }); }
  await page.waitForSelector('#btnStart', { timeout: 30000 });
  await page.evaluate((i) => {
    const s = document.getElementById('romSelect');
    if (s) { s.value = String(i); s.dispatchEvent(new Event('change')); }
  }, cfg.romIdx);
  await page.click('#btnStart');
  await page.waitForFunction(() => { const b = document.getElementById('btnSave'); return b && !b.disabled; },
                             { timeout: BOOT_MS, polling: 500 });
  return { browser, page };
}

async function saveAndRead(page, cfg) {
  await page.evaluate(() => { const t = document.getElementById('toast'); if (t) t.textContent = ''; });
  await page.click('#btnSave');
  for (let i = 0; i < 200; i++) {
    const all = await idbAll(page, cfg.db, cfg.store);
    const e = all.entries.filter((x) => x.key.endsWith(cfg.keySuffix)).sort((a, b) => a.key < b.key ? -1 : 1)[0];
    if (e && e.sha) return e;
    await sleep(400);
  }
  return null;
}

const want = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const platforms = want.length ? want : ['genesis'];
const load = (() => { try { return execSync('uptime').toString().trim(); } catch (e) { return 'unknown'; } })();
log('== audit_save_crossprofile ==');
log('  uptime  ' + load);
log('  arms    ' + platforms.join(', '));

const dlRoot = path.join(SCRATCH, 'audit-xprof-dl');
fs.rmSync(dlRoot, { recursive: true, force: true });
fs.mkdirSync(dlRoot, { recursive: true });
const out = {};

for (const name of platforms) {
  const cfg = PAGES[name];
  if (!cfg) { log('unknown page ' + name); continue; }
  log(`\n╔══ ${name} ${'═'.repeat(48)}`);
  const o = out[name] = {};
  const dlA = path.join(dlRoot, name + '-A'); fs.mkdirSync(dlA, { recursive: true });
  let A = null, B = null;
  try {
    // ---- profile A: get somewhere distinctive, save, export ---------------
    A = await openProfile(cfg, name + '-A', dlA);
    await sleep(6000);
    // Drive A past the title so its saved scene differs from B's.
    for (let i = 0; i < 3; i++) {
      await A.page.evaluate((keys) => keys.forEach((k) => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: k }));
        setTimeout(() => window.dispatchEvent(new KeyboardEvent('keyup', { key: k })), 120);
      }), cfg.advance);
      await sleep(1400);
    }
    await sleep(6000);
    const sigA = await sigAvg(A.page, cfg.canvas);
    o.sigA = sigA;
    const stA = await saveAndRead(A.page, cfg);
    if (!stA) { bad(`${name}/A-save`, 'profile A never stored a state'); throw new Error('A save'); }
    info('A stored', `${stA.key}  ${stA.bytes} B  sha=${stA.sha.slice(0, 16)}…`);
    const seen = new Set(fs.readdirSync(dlA));
    await A.page.click('#btnExport');
    let files = [];
    for (let i = 0; i < 100 && !files.length; i++) {
      files = fs.readdirSync(dlA).filter((f) => !f.endsWith('.crdownload') && !seen.has(f));
      if (!files.length) await sleep(300);
    }
    if (!files.length) { bad(`${name}/A-export`, 'Export wrote no file'); throw new Error('A export'); }
    const fileA = path.join(dlA, files.find((f) =>
      crypto.createHash('sha256').update(fs.readFileSync(path.join(dlA, f))).digest('hex') === stA.sha) || files[0]);
    const shaFile = crypto.createHash('sha256').update(fs.readFileSync(fileA)).digest('hex');
    (shaFile === stA.sha)
      ? ok(`${name}/export-is-byte-exact`, `${path.basename(fileA)} ${fs.statSync(fileA).size} B`)
      : bad(`${name}/export-is-byte-exact`, `${shaFile} vs ${stA.sha}`);
    o.A = { key: stA.key, bytes: stA.bytes, sha: stA.sha, file: path.basename(fileA) };
    await A.browser.close(); A = null;

    // ---- profile B: a genuinely different browser ------------------------
    log('  ── a SEPARATE browser profile — different IndexedDB, different everything');
    const dlB = path.join(dlRoot, name + '-B'); fs.mkdirSync(dlB, { recursive: true });
    B = await openProfile(cfg, name + '-B', dlB);
    const preexisting = await idbAll(B.page, cfg.db, cfg.store);
    (!preexisting.entries.some((e) => e.sha === stA.sha))
      ? ok(`${name}/profiles-are-isolated`, `profile B does not have A's state (${preexisting.entries.length} entr(ies) of its own)`)
      : bad(`${name}/profiles-are-isolated`, 'profile B already had A\'s exact bytes — the profiles are not separate');
    await sleep(9000);   // B stays where it lands: a DIFFERENT scene from A
    const sigBpre = await sigAvg(B.page, cfg.canvas);
    const stB = await saveAndRead(B.page, cfg);
    if (!stB) { bad(`${name}/B-save`, 'profile B never stored a state'); throw new Error('B save'); }
    info('B stored', `${stB.key}  ${stB.bytes} B  sha=${stB.sha.slice(0, 16)}…`);
    (stB.sha !== stA.sha)
      ? ok(`${name}/B-state-differs-from-A`, `sha_B ${stB.sha.slice(0, 12)}… != sha_A ${stA.sha.slice(0, 12)}…  — so an import that does NOTHING cannot pass the next arm`)
      : bad(`${name}/B-state-differs-from-A`, 'the two profiles produced identical bytes; this arm cannot discriminate');
    o.B = { key: stB.key, bytes: stB.bytes, sha: stB.sha };

    // ---- THE ARM THE EXISTING SUITE CANNOT RUN --------------------------
    await B.page.evaluate(() => { const t = document.getElementById('toast'); if (t) t.textContent = ''; });
    const [chooser] = await Promise.all([
      B.page.waitForFileChooser({ timeout: 20000 }),
      B.page.click('#btnImport'),
    ]);
    await chooser.accept([fileA]);
    await B.page.waitForFunction(() => (document.getElementById('toast').textContent || '').length > 0,
      { timeout: 60000 }).catch(() => {});
    const importToast = await B.page.evaluate(() => document.getElementById('toast').textContent);
    let afterImport = null;
    for (let i = 0; i < 40 && !afterImport; i++) {
      const all = await idbAll(B.page, cfg.db, cfg.store);
      afterImport = all.entries.filter((x) => x.key.endsWith(cfg.keySuffix))[0];
      if (afterImport && afterImport.sha === stB.sha) { afterImport = null; await sleep(400); }
    }
    o.afterImport = afterImport; o.importToast = importToast;
    (afterImport && afterImport.sha === stA.sha)
      ? ok(`${name}/IMPORT-REALLY-WRITES-ACROSS-PROFILES`,
           `profile B's stored state changed ${stB.sha.slice(0, 12)}… -> ${afterImport.sha.slice(0, 12)}… = profile A's exported bytes. `
           + `toast="${importToast}"`)
      : bad(`${name}/IMPORT-REALLY-WRITES-ACROSS-PROFILES`,
            `stored sha is ${afterImport ? afterImport.sha.slice(0, 12) + '…' : 'MISSING'}, wanted A's ${stA.sha.slice(0, 12)}…  toast="${importToast}"`);

    // ---- and does it RESTORE? -------------------------------------------
    log('  ── Load State: does the imported save actually restore the machine?');
    const before = await sigAvg(B.page, cfg.canvas);
    await B.page.evaluate(() => { const t = document.getElementById('toast'); if (t) t.textContent = ''; });
    const hasLoad = await B.page.evaluate(() => !!document.getElementById('btnLoad'));
    if (!hasLoad) { bad(`${name}/restore`, 'no #btnLoad on the page'); }
    else {
      await B.page.click('#btnLoad');
      await sleep(4000);
      const loadToast = await B.page.evaluate(() => document.getElementById('toast').textContent);
      const after = await sigAvg(B.page, cfg.canvas);
      const dAfterToA   = dist(after, sigA);
      const dBeforeToA  = dist(before, sigA);
      const dAfterToBefore = dist(after, before);
      o.restore = { loadToast, dBeforeToA, dAfterToA, dAfterToBefore, sigA, before, after };
      info('distances', `B-before -> A: ${dBeforeToA}   B-after-load -> A: ${dAfterToA}   B-after -> B-before: ${dAfterToBefore}`);
      // Restoring A's machine should pull B's picture toward A's saved scene.
      (dAfterToA !== null && dBeforeToA !== null && dAfterToA < dBeforeToA)
        ? ok(`${name}/RESTORE-MOVES-THE-PICTURE-TOWARD-A`,
             `distance to profile A's saved scene fell ${dBeforeToA} -> ${dAfterToA} after Load State. toast="${loadToast}"`)
        : bad(`${name}/RESTORE-MOVES-THE-PICTURE-TOWARD-A`,
             `distance to A did NOT fall (${dBeforeToA} -> ${dAfterToA}); the imported state may not have been restored. toast="${loadToast}"`);
      const alive = await B.page.evaluate(() => (document.getElementById('fps') || {}).textContent || '');
      info('after-load fps line', JSON.stringify(alive));
      try { await B.page.screenshot({ path: `/tmp/audit-xprof-${name}-B-after-load.png` }); } catch (e) {}
    }
  } catch (e) {
    bad(`${name}/harness`, (e && e.message) ? e.message : String(e));
  } finally {
    if (A) await A.browser.close().catch(() => {});
    if (B) await B.browser.close().catch(() => {});
  }
  log(`╚══ ${name} done`);
}

fs.writeFileSync('/tmp/audit-xprof.json', JSON.stringify({ when: new Date().toISOString(), uptime: load, out, rec }, null, 2));
const failed = rec.filter((r) => !r.ok).length;
log(`\n[audit-xprof] ${failed ? failed + ' FAILED' : 'all ' + rec.length + ' passed'}   json /tmp/audit-xprof.json`);
log(`load at start: ${load.split('load averages:').pop().trim()}`);
process.exit(failed ? 1 : 0);

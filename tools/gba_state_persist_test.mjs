#!/usr/bin/env node
// Standing gate for GBA SAVE STATES SURVIVING A PAGE REFRESH.
//
// WHY IT EXISTS: reported from an Xbox Series X — "GBA is not saving progress on
// xbox with a save state after a refresh." Desktop could never reproduce it, and
// that is the point: the page behaved correctly here while doing things that only
// fail on a device with a small memory and storage budget. So this gate asserts on
// the RESOURCE COST of a save/restore, not only on the happy path.
//
// WHAT EACH ARM MEASURES (all measured values, never a property being present):
//   * round trip  — a sampled hash of the whole 128 MB wasm heap, captured in the
//                   SAME synchronous turn as the save and as the restore, so no
//                   emulated frame can advance the heap between the two reads. The
//                   hash covers the ROM window too, which is what proves the
//                   ROM-exclusion ranges are right.
//   * state size  — bytes actually written to IndexedDB.
//   * memory      — renderer RSS sampled from the OS. ArrayBuffers live OUTSIDE the
//                   JS heap, so page.metrics() and performance.memory cannot see the
//                   128 MB copies this path used to make; only the OS can.
//
// REGRESSIONS THIS PINS (all measured 2026-09-06, all were live):
//   restore-memory  loadStateLocal accumulated every decompressed chunk AND then
//       copied the lot again through `new Blob(chunks).arrayBuffer()` before touching
//       the heap: peak renderer RSS +305 MB on top of a page already at ~450 MB.
//       Now streams straight into the heap (+80..121 MB, all transient garbage).
//   save-memory     saveStateLocal copied the whole 128 MB heap before compressing
//       it: +133 MB. Now compresses in 4 MB slices out of the live heap (+~100 MB).
//   state-size      the ROM was stored INSIDE every save state. Kirby: the 128 MB
//       heap gzipped to 4,972,418 B while the ROM alone gzips to 4,728,261 B — 95.1%
//       of the state was a second copy of a file the page re-fetches on every load.
//       Now 207,623 B, a 23.9x cut; the 16 MB ROMs would have paid ~10 MB per state.
//   load-btn-gate   _findInDatabase probed the SRAM key `<rom>.sav` and used the
//       answer to enable the LOAD STATE button, but a state lives at `<rom>.sav.state`.
//       A visitor who saved a state and refreshed could find Load State greyed out
//       while the state sat on disk.
//
// ⚠ LIMIT: this runs desktop Chrome with an Xbox user agent. It reproduces the
// ENVIRONMENT's shape, not the Xbox's memory or storage budget, and it cannot prove
// which of the above was the failure on the visitor's console. It CAN prove the page
// no longer needs the headroom that made a console the only place it could fail.
//
// USAGE   npm run web    # required: http://localhost:8080
//         node tools/gba_state_persist_test.mjs
//         HEADFUL=1 ROM_IDX=0 DESKTOP_UA=1 node tools/gba_state_persist_test.mjs
// Serialize against other browser harnesses on a shared box.

import puppeteer from 'puppeteer';
import fs from 'fs';
import { execSync } from 'child_process';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const ORIGIN = 'http://localhost:8080';
const PROFILE = process.env.PROFILE || '/private/tmp/claude-501/-Users-caseybement-Bemental77-github-io/67bfe5d2-d703-4b56-897a-da90f004135a/scratchpad/gba-profile';
const ROM_IDX = parseInt(process.env.ROM_IDX || '4', 10);   // Kirby
const XBOX_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; Xbox; Xbox Series X) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Edg/125.0.0.0';
const UA = process.env.DESKTOP_UA === '1' ? undefined : XBOX_UA;

if (process.env.KEEP_PROFILE !== '1') fs.rmSync(PROFILE, { recursive: true, force: true });

const log = (...a) => console.log(...a);

const browser = await puppeteer.launch({
  headless: process.env.HEADFUL === '1' ? false : 'new',
  executablePath: CHROME,
  userDataDir: PROFILE,
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--window-size=1920,1080'],
});
const page = (await browser.pages())[0];
if (UA) await page.setUserAgent(UA);
await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
page.on('console', m => { const t = m.text(); if (/state|save|quota|error|Error/i.test(t)) log('  [page]', t.slice(0, 200)); });
page.on('pageerror', e => log('  [pageerror]', String(e).slice(0, 200)));

// Capture every toastr message the app raises — that is the user-visible truth.
async function installToastrTap() {
  await page.evaluate(() => {
    window.__hashHeap = () => {
      const h = Module.HEAPU8; let a = 2166136261 >>> 0;
      for (let i = 0; i < h.length; i += 4093) { a ^= h[i]; a = Math.imul(a, 16777619) >>> 0; }
      return a.toString(16);
    };
    window.__toasts = [];
    window.__hashAtRestore = null;
    const wrap = (kind) => {
      const orig = toastr[kind];
      toastr[kind] = function (msg) {
        window.__toasts.push(kind + ': ' + msg);
        // Captured in the SAME synchronous turn the restore finishes in, so no
        // emulated frame can advance the heap before it is read.
        if (/State restored/.test(msg)) window.__hashAtRestore = window.__hashHeap();
        return orig.apply(this, arguments);
      };
    };
    ['info', 'error', 'success', 'warning'].forEach(wrap);
  });
}

async function bootAndLoadRom(label) {
  await page.goto(ORIGIN + '/gba.html', { waitUntil: 'networkidle2', timeout: 60000 });
  await page.waitForFunction(() => window.myApp && window.myApp.isWasmReady === true, { timeout: 60000 });
  await installToastrTap();
  const romUrl = await page.evaluate((i) => window.ROMLIST[i].url, ROM_IDX);
  await page.evaluate((url) => {
    document.getElementById('romselect').value = url;
    window.myClass.loadRom();
  }, romUrl);
  await page.waitForFunction(() => window.myApp && window.myApp.isRunning === true, { timeout: 60000 });
  log(`[${label}] ROM running: ${romUrl.split('/').pop()}`);
  return romUrl;
}

// Sampled hash of the wasm heap — a full 128 MB compare would dominate the run.
const heapHash = () => page.evaluate(() => {
  const h = Module.HEAPU8; let a = 2166136261 >>> 0, n = 0;
  for (let i = 0; i < h.length; i += 4093) { a ^= h[i]; a = Math.imul(a, 16777619) >>> 0; n++; }
  return { hash: a.toString(16), samples: n, heapBytes: h.length };
});

const storageInfo = () => page.evaluate(async () => {
  const est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null;
  const persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : null;
  return { quota: est && est.quota, usage: est && est.usage, persisted };
});

// Read the GBAWASMDB keys + byte lengths directly, independent of the app.
const dbDump = () => page.evaluate(() => new Promise((res) => {
  const req = indexedDB.open('GBAWASMDB');
  req.onsuccess = (ev) => {
    const db = ev.target.result;
    if (!db.objectStoreNames.contains('GBAWASMSTATES')) { res({ error: 'store missing', stores: [...db.objectStoreNames] }); return; }
    const out = [];
    const st = db.transaction('GBAWASMSTATES', 'readonly').objectStore('GBAWASMSTATES');
    st.openCursor().onsuccess = (e) => {
      const c = e.target.result;
      if (c) { out.push({ key: String(c.key), bytes: (c.value && c.value.byteLength) || (c.value && c.value.length) || 0 }); c.continue(); }
      else res({ entries: out });
    };
  };
  req.onerror = () => res({ error: 'open failed' });
}));

const runFrames = async (ms) => { await new Promise(r => setTimeout(r, ms)); };

// Renderer RSS in MB, summed over this browser's renderer processes. ArrayBuffers
// live OUTSIDE the JS heap, so page.metrics()/performance.memory cannot see the
// 128 MB copies this path makes; the OS can.
const rssDelta = {};
const PROF_TAG = PROFILE.split('/').pop();
function rendererRssMB() {
  try {
    const out = execSync(`ps -axo rss,command | grep -F "${PROF_TAG}" | grep -F "type=renderer" | grep -v grep`, { encoding: 'utf8' });
    let kb = 0;
    for (const line of out.trim().split('\n')) { const m = line.trim().match(/^(\d+)/); if (m) kb += parseInt(m[1], 10); }
    return Math.round(kb / 1024);
  } catch (e) { return -1; }
}
// Sample RSS while an async page action runs; return {peak, base, result}.
async function withRssPeak(label, fn) {
  const base = rendererRssMB();
  let peak = base, stop = false;
  const sampler = (async () => { while (!stop) { const v = rendererRssMB(); if (v > peak) peak = v; await new Promise(r => setTimeout(r, 60)); } })();
  const result = await fn();
  stop = true; await sampler;
  const after = rendererRssMB();
  log(`  [rss] ${label}: base=${base}MB peak=${peak}MB after=${after}MB  (delta peak-base = ${peak - base}MB)`);
  rssDelta[label] = peak - base;
  return result;
}

// ── PASS 1: boot, play, save state ───────────────────────────────────────────
log('\n=== PASS 1: boot, play, Save State ===');
await bootAndLoadRom('pass1');
await runFrames(5000);
log('  storage before   :', JSON.stringify(await storageInfo()));

let beforeSaveHash = null;
await withRssPeak('SAVE', async () => {
  // hash -> save in ONE turn: saveStateLocal runs synchronously up to its first
  // await (where it pauses the loop), so the bytes hashed ARE the bytes saved.
  beforeSaveHash = await page.evaluate(() => {
    window.myApp.isRunning = false;
    const h = window.__hashHeap();
    window.myApp.isRunning = true;
    window.myApp.saveStateLocal();
    return h;
  });
  await page.waitForFunction(() => window.__toasts.some(t => /State saved|State save failed|State save error/.test(t)), { timeout: 120000 })
    .catch(() => log('  !! no save-result toast within 120s'));
});
log('  toasts:', JSON.stringify(await page.evaluate(() => window.__toasts)));
log('  DB after save    :', JSON.stringify(await dbDump()));
log('  storage after    :', JSON.stringify(await storageInfo()));
const noLocalSave1 = await page.evaluate(() => window.myApp.rivetsData.noLocalSave);
log('  noLocalSave      :', noLocalSave1);

// ── PASS 2: refresh, reload same ROM, Load State ─────────────────────────────
log('\n=== PASS 2: REFRESH, reload ROM, Load State ===');
await bootAndLoadRom('pass2');
const freshBoot = await heapHash();
log('  heap after fresh boot:', JSON.stringify(freshBoot));
const dbAfterRefresh = await dbDump();
log('  DB after refresh     :', JSON.stringify(dbAfterRefresh));
log('  storage after refresh:', JSON.stringify(await storageInfo()));
const gating2 = await page.evaluate(() => ({
  noLocalSave: window.myApp.rivetsData.noLocalSave,
  noLocalState: window.myApp.rivetsData.noLocalState,
  loadBtnDisabled: (document.querySelector('button[rv-disabled="data.noLocalState"]') || {}).disabled,
  spLoadBtnExists: !!document.getElementById('spLoadBtn'),
}));
log('  gating               :', JSON.stringify(gating2));

await withRssPeak('RESTORE', async () => {
  await page.evaluate(() => window.myApp.loadStateLocal());
  await page.waitForFunction(() => window.__toasts.some(t => /State restored|No save state found|State restore error/.test(t)), { timeout: 120000 })
    .catch(() => log('  !! no restore-result toast within 120s'));
});
log('  toasts:', JSON.stringify(await page.evaluate(() => window.__toasts)));
const restoreHash = await page.evaluate(() => window.__hashAtRestore);
const rssSaveDelta = rssDelta['SAVE'] ?? -1, rssRestoreDelta = rssDelta['RESTORE'] ?? -1;

log('\n=== VERDICT ===');
const fails = [];
const stateBytes = (dbAfterRefresh.entries || []).filter(e => e.key.endsWith('.state'))[0];
if (!stateBytes) fails.push('the save state was not in IndexedDB after the refresh');
else if (stateBytes.bytes > 2 * 1024 * 1024)
  fails.push('state is ' + stateBytes.bytes + ' B — the ROM is being stored inside it again (expect < 2 MB)');
if (gating2.loadBtnDisabled) fails.push('Load State was disabled even though a state exists');
if (rssRestoreDelta > 200) fails.push('restore peaked at +' + rssRestoreDelta + ' MB — the whole-buffer copies are back');
log('  state bytes   =', stateBytes ? stateBytes.bytes : 'MISSING');
log('  rss delta     = save +' + rssSaveDelta + ' MB, restore +' + rssRestoreDelta + ' MB');
log('  heap(save)    =', beforeSaveHash);
log('  heap(fresh)   =', freshBoot.hash);
log('  heap(restore) =', restoreHash);
if (restoreHash && restoreHash === beforeSaveHash) log('  PASS — restored heap is byte-identical to the saved heap');
else if (!restoreHash) fails.push('restore never completed');
else if (restoreHash === freshBoot.hash) fails.push('Load State did not change the heap');
else fails.push('restored heap differs from the saved heap');

for (const f of fails) log('  FAIL — ' + f);
log(fails.length ? `\n[gba-state] FAILED (${fails.length})` : '\n[gba-state] PASSED');
await browser.close();
process.exit(fails.length ? 1 : 0);

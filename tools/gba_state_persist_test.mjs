#!/usr/bin/env node
// Standing gate for GBA SAVE STATES SURVIVING A PAGE REFRESH.
//
// WHY IT EXISTS: reported from an Xbox Series X - "GBA is not saving progress on xbox with a save state after a
// refresh." Desktop could never reproduce it, and that is the point: the page behaved correctly here while doing things that
// only fail on a device with a small memory and storage budget. So this gate asserts on the RESOURCE COST of a save/restore,
// not only on the happy path.
//
// ── 2026-11-01: PORTED FROM THE 44vba CORE TO mGBA (stage G3) AND FROM puppeteer TO tools/headless_cdp.mjs ──────────────────
// What was 44vba-specific, and what replaced it:
//   * the state WAS a gzip of the whole 128 MB wasm heap, hashed by sampling `Module.HEAPU8` (4093-byte stride) in the same
//     synchronous turn as the save and the restore. There is no `Module.HEAPU8` any more (the core is gba/mgba, a separate
//     instance), so the witness is now the core's own state hash: script.js publishes `myApp.lastSavedState` and
//     `myApp.lastRestore`, each captured in the SAME synchronous turn as the save / the restore, holding
//     core.hashGame(0) (FNV-1a 32 over the 0x61000-byte serialisation with the PSG block masked - the block mGBA's savestate does
//     not round-trip bit-exactly, see mgba_core.js hashGame) and the core's own frame counter.
//   * the state key was '<rom>.sav.state'; it is now '<rom>.mgba.state.gz' (the old key is left alone by the page and is
//     reported to the visitor, never loaded).
//   * the size ceiling (2 MB, "the ROM is stored inside it again") is now the raw state size: an mGBA state holds no ROM, so
//     the gzip must come out BELOW 0x61000 bytes.
//   * the renderer-RSS arm is DROPPED. It existed to catch the 128 MB whole-heap copies the old save/restore made (+133 MB /
//     +305 MB measured); mGBA's whole state is 397,312 bytes, so there is no allocation of that class left to measure, and the
//     arm needed `ps -axo rss,command` (POSIX only; this suite now runs on Windows under tools/headless_cdp.mjs).
//   * puppeteer -> tools/headless_cdp.mjs: headless Chrome over bare CDP, a throwaway profile, ONE browser at a time machine-wide,
//     and --mute-audio (a test browser must never reach the user's speakers/headphones).
// What is unchanged: pass 1 (boot, play, Save State), pass 2 (REFRESH, reload ROM, Load State), the three verdict arms
// (state is in IndexedDB after the refresh / Load State is enabled while a state exists / the restore reproduces the saved
// machine), and the Xbox user agent.
//
// 2026-11-01 (stage GP, gba.html on the site's page standard): selectors only — #romselect -> #romSelect, Load State is #btnLoad (the
// phone twin #mLoad), and the toastr tap became an alias of window.__gbaToasts (script.js gbaToast), because there is no toastr now.
//
// REGRESSIONS THIS PINS (all measured 2026-09-06 on the old core; the first two cannot recur on mGBA but the arms stay):
//   state-size      the ROM was stored INSIDE every save state (95.1% of a Kirby state).
//   load-btn-gate   _findInDatabase probed the SRAM key `<rom>.sav` and used the answer to enable the LOAD STATE button, but a
//                   state lives under its own key. A visitor who saved a state and refreshed could find Load State greyed out
//                   while the state sat on disk.
//
// ⚠ LIMIT: this runs desktop Chrome with an Xbox user agent. It reproduces the ENVIRONMENT's shape, not the Xbox's memory or
// storage budget, and it cannot prove which failure the visitor's console had. It CAN prove the page no longer needs the headroom
// that made a console the only place it could fail.
//
// NEGATIVE CONTROL: MUTANT=noop-restore makes the core's loadState() report success without applying the state (what a restore that
// silently did nothing looks like). The verdict MUST then FAIL (exit 1); the unmutated twin (no MUTANT) must PASS.
//
// USAGE   PORT=8092 node tools/devserver.mjs        # required (Range-capable); ORIGIN overrides the whole origin
//         node tools/gba_state_persist_test.mjs
//         DESKTOP_UA=1 ROM_TITLE=Sonic node tools/gba_state_persist_test.mjs
// Serialize against other browser harnesses on a shared box (the helper takes a machine-wide lock).

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { withBrowser } = await import(pathToFileURL(path.join(ROOT, 'tools/headless_cdp.mjs')).href);

const ORIGIN = process.env.ORIGIN || `http://localhost:${process.env.PORT || 8080}`;
const CDP_PORT = Number(process.env.CDP_PORT || 9254);
const ROM_TITLE = process.env.ROM_TITLE || 'Kirby';           // matched against ROMLIST[].title (index 4 is no longer Kirby)
const XBOX_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; Xbox; Xbox Series X) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Edg/125.0.0.0';
const UA = process.env.DESKTOP_UA === '1' ? undefined : XBOX_UA;
const STATE_RAW = 0x61000;
const MUTANT = process.env.MUTANT || '';

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [];

await withBrowser({ port: CDP_PORT, width: 1920, height: 1080 }, async (page) => {
  if (UA) await page.send('Emulation.setUserAgentOverride', { userAgent: UA });

  // Every message the app raises is the user-visible truth. There is no toastr to tap any more (stage GP, 2026-11-01): the page's
  // toast helper (script.js gbaToast) appends "<kind>: <text>" to window.__gbaToasts, so this only aliases it to the old name.
  async function installToastrTap() {
    await page.eval(`(() => { Object.defineProperty(window, '__toasts', { configurable: true, get: () => window.__gbaToasts }); return true; })()`);
  }

  async function bootAndLoadRom(label) {
    await page.navigate(ORIGIN + '/gba.html');
    await page.waitFor('window.myApp && window.myApp.isWasmReady === true', { timeoutMs: 60000 });
    await installToastrTap();
    const romUrl = await page.eval(`(() => { const r = window.ROMLIST.find((x) => x.title.includes(${JSON.stringify(ROM_TITLE)})); return r ? r.url : null; })()`);
    if (!romUrl) throw new Error('no ROMLIST entry matches ROM_TITLE=' + ROM_TITLE);
    await page.eval(`(() => { document.getElementById('romSelect').value = ${JSON.stringify(romUrl)}; window.myClass.loadRom(); return true; })()`);
    await page.waitFor('window.myApp && window.myApp.isRunning === true', { timeoutMs: 60000 });
    log(`[${label}] ROM running: ${decodeURIComponent(romUrl.split('/').pop())}`);
    return romUrl;
  }

  const storageInfo = () => page.eval(`(async () => {
    const est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null;
    const persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : null;
    return { quota: est && est.quota, usage: est && est.usage, persisted }; })()`);

  // Read the GBAWASMDB keys + byte lengths directly, independent of the app.
  const dbDump = () => page.eval(`new Promise((res) => {
    const req = indexedDB.open('GBAWASMDB');
    req.onsuccess = (ev) => {
      const db = ev.target.result;
      if (!db.objectStoreNames.contains('GBAWASMSTATES')) { res({ error: 'store missing', stores: [...db.objectStoreNames] }); return; }
      const out = [];
      db.transaction('GBAWASMSTATES', 'readonly').objectStore('GBAWASMSTATES').openCursor().onsuccess = (e) => {
        const c = e.target.result;
        if (c) { out.push({ key: String(c.key), bytes: (c.value && c.value.byteLength) || (c.value && c.value.length) || 0 }); c.continue(); }
        else res({ entries: out });
      };
    };
    req.onerror = () => res({ error: 'open failed' });
  })`);

  // ── PASS 1: boot, play, save state ─────────────────────────────────────────
  log('\n=== PASS 1: boot, play, Save State ===');
  await bootAndLoadRom('pass1');
  await sleep(5000);
  log('  storage before   :', JSON.stringify(await storageInfo()));

  // saveStateLocal snapshots synchronously (core.saveState + hash in ONE turn) before its first await, so the machine that was
  // hashed IS the machine that was saved; page.lastSavedState carries that hash.
  await page.eval('(() => { window.myApp.lastSavedState = null; window.myApp.saveStateLocal(); return true; })()');
  await page.waitFor(`window.__toasts.some((t) => /State saved|State save failed|State save error/.test(t))`, { timeoutMs: 120000 })
    .catch(() => log('  !! no save-result toast within 120s'));
  const saved = await page.eval('JSON.parse(JSON.stringify(window.myApp.lastSavedState || null))');
  log('  toasts:', JSON.stringify(await page.eval('window.__toasts')));
  log('  DB after save    :', JSON.stringify(await dbDump()));
  log('  storage after    :', JSON.stringify(await storageInfo()));
  log('  noLocalSave      :', await page.eval('window.myApp.rivetsData.noLocalSave'));

  // ── PASS 2: refresh, reload same ROM, Load State ───────────────────────────
  log('\n=== PASS 2: REFRESH, reload ROM, Load State ===');
  await bootAndLoadRom('pass2');
  if (MUTANT === 'noop-restore') {
    await page.eval('(() => { myApp.core.loadState = () => true; return true; })()');
    log('  [MUTANT noop-restore] core.loadState now reports success without applying anything');
  }
  const fresh = await page.eval('JSON.parse(JSON.stringify({ hashGame: myApp.core.hashGame(0), frames: myApp.core.frames(0) }))');
  log('  machine after fresh boot:', JSON.stringify(fresh));
  const dbAfterRefresh = await dbDump();
  log('  DB after refresh     :', JSON.stringify(dbAfterRefresh));
  log('  storage after refresh:', JSON.stringify(await storageInfo()));
  const gating2 = await page.eval(`({
    noLocalSave: window.myApp.rivetsData.noLocalSave,
    noLocalState: window.myApp.rivetsData.noLocalState,
    loadBtnDisabled: document.getElementById('btnLoad').disabled,
    touchLoadBtnExists: !!document.getElementById('mLoad'),
  })`);
  log('  gating               :', JSON.stringify(gating2));

  await page.eval('(() => { window.myApp.lastRestore = null; window.myApp.loadStateLocal(); return true; })()');
  await page.waitFor(`window.__toasts.some((t) => /State restored|No save state found|State restore failed|did not accept/.test(t))`, { timeoutMs: 120000 })
    .catch(() => log('  !! no restore-result toast within 120s'));
  log('  toasts:', JSON.stringify(await page.eval('window.__toasts')));
  const restored = await page.eval('JSON.parse(JSON.stringify(window.myApp.lastRestore || null))');

  log('\n=== VERDICT ===');
  const stateEntry = (dbAfterRefresh.entries || []).filter((e) => e.key.endsWith('.mgba.state.gz'))[0];
  if (!saved) fails.push('Save State never captured a machine hash (lastSavedState is empty)');
  if (!stateEntry) fails.push('the save state was not in IndexedDB after the refresh');
  else if (stateEntry.bytes >= STATE_RAW)
    fails.push('state is ' + stateEntry.bytes + ' B - not smaller than the raw ' + STATE_RAW + ' B state it should compress (expect well under)');
  if (gating2.loadBtnDisabled) fails.push('Load State was disabled even though a state exists');
  log('  state bytes   =', stateEntry ? stateEntry.bytes : 'MISSING', '(raw state ' + STATE_RAW + ')');
  log('  machine(save)    =', JSON.stringify(saved));
  log('  machine(fresh)   =', JSON.stringify(fresh));
  log('  machine(restore) =', JSON.stringify(restored));
  // The control that makes the final comparison mean something: a restore that did nothing would leave the FRESH machine in
  // place, so the fresh machine must differ from the saved one or this whole arm is vacuous.
  if (saved && fresh && saved.hashGame === fresh.hashGame) fails.push('the fresh-boot machine equals the saved one, so a no-op restore would pass: the arm is vacuous');
  if (restored && saved && restored.hashGame === saved.hashGame && restored.frames === saved.frames) log('  PASS - restored machine is identical to the saved machine (hashGame and frame counter)');
  else if (!restored) fails.push('restore never completed');
  else if (fresh && restored.hashGame === fresh.hashGame) fails.push('Load State did not change the machine');
  else fails.push('restored machine differs from the saved machine');
  const pe = page.errors.slice(0, 3);
  if (pe.length) fails.push('page errors: ' + JSON.stringify(pe));
});

for (const f of fails) log('  FAIL - ' + f);
log(fails.length ? `\n[gba-state] FAILED (${fails.length})` : '\n[gba-state] PASSED');
process.exit(fails.length ? 1 : 0);

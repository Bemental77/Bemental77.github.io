#!/usr/bin/env node
// ============================================================================
// vmu_two_player_test.mjs — PLAYER 2 HAS ITS OWN MEMORY CARD, AND IT SURVIVES
// ============================================================================
//
// WHAT WENT WRONG, AND WHY NOTHING CAUGHT IT
// ------------------------------------------
// The core has always given every seated player their own VMU: the MAPLE_PORTS
// loop in createDreamcastDevices() (core/hw/maple/maple_cfg.cpp) attaches an
// expansion card to each controller, and `[maple] bus … p0[1,…,0] p1[1,…,0]`
// in any two-player probe log shows both of them.
//
// What did NOT exist was any way to SEE more than one of them:
//
//   * the core published ONE pointer — `u8 *g_vmu_flash_ptr` — and every card
//     overwrote it as it was created. The comment above it said so out loud:
//     "Single card (slot A1): last attached device wins."
//   * `flycast_vmu_ptr()/size()/gen()` in the bridge took no port.
//   * and the page NEVER SENT `vmuLoad` OR HANDLED `vmuChanged` AT ALL — the
//     worker shim's whole VMU API was unreachable code. dreamcast.html would
//     have logged a card snapshot as `[page] unknown worker cmd: vmuChanged`.
//
// So player 2 saved, the guest wrote player 2's card, and the bytes died with
// the tab. Player 1's did too. Every existing test passes on that build,
// because none of them ever asked a card a question.
//
// THIS RIG ASKS THE THREE QUESTIONS THAT DISTINGUISH FIXED FROM BROKEN
// --------------------------------------------------------------------
//   1. TWO BUFFERS, NOT ONE. `flycast_vmu_ptr(0)` and `flycast_vmu_ptr(1)` must
//      be DIFFERENT ADDRESSES. On the single-pointer build they are equal by
//      construction — one variable — so this alone fails the old binary.
//   2. INDEPENDENT CONTENT. Write a distinct pattern into each card and read
//      both back OUT OF THE CORE. Player 1's card must not contain player 2's
//      bytes and vice versa.
//   3. IT COMES BACK. Reload the page, boot again, and both cards must restore
//      from this browser's own IndexedDB — player 2's intact, AND player 1's
//      unchanged by player 2's save. That third clause is the one that catches
//      a single shared storage key, which would look fine until the moment it
//      silently overwrote the other player.
//
// It also asserts the storage keys are genuinely distinct (`vmu:p0` vs
// `vmu:p1`) by reading them straight back out of IndexedDB, so "it came back"
// cannot be satisfied by one card being handed to both seats.
//
// ⚠ WHAT THIS DOES NOT PROVE. It does not play a game to a save screen — it
// writes the card through the page's own seam and lets the real seed/persist
// path carry it. It proves the PLUMBING carries two cards independently and
// keeps them. Whether a particular game writes the port-1 card when player 2
// saves is the game's business, and `[vmu] Player N: card saved` in a normal
// probe log is the witness for that (a plain PSO boot already produces the
// Player 1 line, because PSO writes its card during boot).
//
// USAGE
//   npm run web                       # port 8080; devserver.mjs, not python
//   node dreamcast/tools/vmu_two_player_test.mjs
//   node dreamcast/tools/vmu_two_player_test.mjs --game gauntlet --headful
//
// Exit 0 = every assertion passed. Exit 1 = at least one failed, and the
// failing assertion names what it saw.
// ============================================================================

import puppeteer from 'puppeteer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const ORIGIN = process.env.VMU_ORIGIN || 'http://localhost:8080';
// The repo's own Chrome, the same one flycast_probe.js and room_crossdevice_test
// use. The bundled puppeteer download is not present on this box, and a rig that
// silently launches a DIFFERENT Chrome from every other rig is a rig whose
// results cannot be compared with theirs.
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
let GAME = 'pso2';
let HEADFUL = false;
let BOOT_MS = 180000;

for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--game') GAME = process.argv[++i];
  else if (a === '--headful') HEADFUL = true;
  else if (a === '--boot-ms') BOOT_MS = parseInt(process.argv[++i], 10);
  else if (a === '--help' || a === '-h') {
    console.log('usage: node dreamcast/tools/vmu_two_player_test.mjs [--game pso2|cannonspike|sa2|gauntlet|mvc2] [--headful] [--boot-ms N]');
    process.exit(0);
  }
}

const P1_BYTE = 0xa1, P2_BYTE = 0xb2, PATTERN_LEN = 256;

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  PASS  ' + name + (detail ? '  — ' + detail : '')); }
  else { fail++; failures.push(name + (detail ? ' — ' + detail : '')); console.log('  FAIL  ' + name + (detail ? '  — ' + detail : '')); }
}

// The leak guard registers every puppeteer.launch site in this repo so an
// orphaned Chrome can be reaped by owner PID. A SIGKILLed parent orphans its
// browser and no in-process handler can prevent it — two such browsers with
// 800+ CPU-minutes were once the largest single source of "machine load".
const require_ = createRequire(import.meta.url);
let leakGuard = null;
try { leakGuard = require_(path.resolve('tools/browser_leak_guard.js')); }
catch (e) { /* advisory; its absence must not fail the test */ }

async function serverUp() {
  try {
    const r = await fetch(ORIGIN + '/dreamcast.html', { method: 'GET' });
    return r.ok;
  } catch (e) { return false; }
}

if (!(await serverUp())) {
  console.error('[vmu-test] ' + ORIGIN + '/dreamcast.html is not being served.');
  console.error('[vmu-test] Start it first:  npm run web    (= node tools/devserver.mjs, port 8080)');
  process.exit(2);
}

// A PERSISTENT PROFILE IS THE POINT. IndexedDB is what carries a card across a
// reload; a throwaway profile per navigation would make the restore assertion
// vacuous. Reused across the whole run, deleted at the end.
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-vmu-profile-'));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: HEADFUL ? false : 'new',
  userDataDir: PROFILE,
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--autoplay-policy=no-user-gesture-required',
    '--mute-audio',
  ],
});
try { if (leakGuard && leakGuard.guard) leakGuard.guard(browser); } catch (e) {}

const pageLogs = [];
let page = await browser.newPage();

function wirePage(p) {
  p.on('console', (m) => {
    const t = m.text();
    if (/\[vmu\]|\[maple\]|\[page\] state |\[page\] unknown worker cmd/.test(t)) pageLogs.push(t);
  });
  p.on('pageerror', (e) => pageLogs.push('PAGEERROR: ' + (e && e.message ? e.message : String(e))));
}
wirePage(page);

const url = ORIGIN + '/dreamcast.html?game=' + encodeURIComponent(GAME);

// Boot the console and wait for the memory-card watch to be armed. The page
// arms it after the disc load and before the pump is switched on, so "armed"
// is exactly the moment the cards exist and nothing has run.
async function bootAndArm(label) {
  console.log('\n[' + label + '] navigating ' + url);
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  // coi-serviceworker reloads the page ONCE on a server with no COOP/COEP
  // (tools/devserver.mjs sends none). Wait for isolation before touching Start:
  // a click into a page that is about to reload is a click into nothing.
  await page.waitForFunction(() => self.crossOriginIsolated === true, { timeout: 60000 })
    .catch(() => { throw new Error('page never became cross-origin isolated'); });

  await page.waitForFunction(() => {
    const b = document.getElementById('btnStart');
    return b && !b.disabled && b.getAttribute('aria-disabled') !== 'true';
  }, { timeout: 60000 }).catch(() => { throw new Error('Start never became clickable — the capability gate may be holding it'); });

  await page.click('#btnStart');
  console.log('[' + label + '] Start clicked, waiting for the memory-card watch to arm…');

  await page.waitForFunction(() => {
    try { return !!(window.__dcVmu && window.__dcVmu().armed); } catch (e) { return false; }
  }, { timeout: BOOT_MS, polling: 500 })
    .catch(() => { throw new Error('the memory-card watch never armed within ' + BOOT_MS + ' ms — see the [vmu] lines above'); });

  const v = await page.evaluate(() => window.__dcVmu());
  console.log('[' + label + '] slots: ' + JSON.stringify(v.slots) + '  ownPorts=' + JSON.stringify(v.ownPorts) +
              (v.seedSkipped ? '  seedSkipped=' + v.seedSkipped : ''));
  return v;
}

const hex = (n) => '0x' + (n >>> 0).toString(16);
const allAre = (arr, val, n) => { if (!arr) return false; for (let i = 0; i < n; i++) if (arr[i] !== val) return false; return true; };

// Read a card OUT OF THE CORE and bring back only what is needed. A 128 KB
// Uint8Array does not survive a page.evaluate boundary usefully (CDP turns it
// into a 131072-key object), so the slice happens IN THE PAGE.
async function readCard(port, n = PATTERN_LEN) {
  return page.evaluate(async (p, len) => {
    const d = await window.__dcVmuLive(p);
    if (!d) return null;
    const bytes = d.data ? new Uint8Array(d.data) : null;
    return {
      ptr: d.ptr >>> 0, size: d.size >>> 0, gen: d.gen >>> 0,
      head: bytes ? Array.from(bytes.slice(0, len)) : null,
      // a cheap whole-card fingerprint, so "it came back" is not judged on 256
      // bytes out of 131072
      sum: bytes ? bytes.reduce((a, b) => (a + b) >>> 0, 0) : null,
    };
  }, port, n);
}

try {
  // -------------------------------------------------------------- FIRST BOOT
  const v1 = await bootAndArm('boot 1');

  const present = v1.slots.filter((s) => s.present);
  check('two seats have a memory card',
        present.length >= 2,
        present.length + ' present: ' + present.map((s) => 'p' + s.port + '=' + s.size + 'B').join(' '));
  if (present.length < 2) throw new Error('cannot test two players with ' + present.length + ' card(s)');

  // 1. TWO BUFFERS, NOT ONE. This is the assertion the single-pointer build
  //    cannot pass: it had one variable, so both ports answered one address.
  const live0a = await readCard(0);
  const live1a = await readCard(1);
  check('player 1 and player 2 are DIFFERENT buffers in the core',
        !!live0a && !!live1a && live0a.ptr !== 0 && live1a.ptr !== 0 && live0a.ptr !== live1a.ptr,
        'p0 ptr=' + hex(live0a && live0a.ptr) + '  p1 ptr=' + hex(live1a && live1a.ptr));

  check('both cards are the real 128 KB VMU size',
        live0a.size === 131072 && live1a.size === 131072,
        'p0=' + live0a.size + 'B p1=' + live1a.size + 'B');

  // 2. INDEPENDENT CONTENT. Distinct pattern per card, read back OUT OF THE CORE.
  const poke0 = await page.evaluate((b, n) => window.__dcVmuPoke(0, b, n), P1_BYTE, PATTERN_LEN);
  const poke1 = await page.evaluate((b, n) => window.__dcVmuPoke(1, b, n), P2_BYTE, PATTERN_LEN);
  check('player 1 card accepted a write and was persisted', !!poke0.ok && !!poke0.persisted, JSON.stringify(poke0));
  check('player 2 card accepted a write and was persisted', !!poke1.ok && !!poke1.persisted, JSON.stringify(poke1));

  const live0b = await readCard(0);
  const live1b = await readCard(1);
  const b0 = live0b && live0b.head, b1 = live1b && live1b.head;

  check('the CORE holds player 1\'s pattern on port 0',
        !!b0 && allAre(b0, P1_BYTE, PATTERN_LEN),
        b0 ? 'first bytes ' + hex(b0[0]) + ' ' + hex(b0[1]) + ' ' + hex(b0[2]) : 'no data');
  check('the CORE holds player 2\'s pattern on port 1',
        !!b1 && allAre(b1, P2_BYTE, PATTERN_LEN),
        b1 ? 'first bytes ' + hex(b1[0]) + ' ' + hex(b1[1]) + ' ' + hex(b1[2]) : 'no data');
  check('writing player 2\'s card did NOT touch player 1\'s',
        !!b0 && b0[0] === P1_BYTE && b0[0] !== b1[0],
        'p0[0]=' + hex(b0 && b0[0]) + '  p1[0]=' + hex(b1 && b1[0]));

  // The keys really are separate rows, not one row read twice.
  const stored0a = await page.evaluate(async () => { const v = await window.__dcVmuStored(0); return v ? Array.from(v.slice(0, 4)) : null; });
  const stored1a = await page.evaluate(async () => { const v = await window.__dcVmuStored(1); return v ? Array.from(v.slice(0, 4)) : null; });
  check('IndexedDB holds two SEPARATE cards (vmu:p0 != vmu:p1)',
        stored0a && stored1a && stored0a[0] === P1_BYTE && stored1a[0] === P2_BYTE,
        'vmu:p0[0]=' + hex(stored0a && stored0a[0]) + '  vmu:p1[0]=' + hex(stored1a && stored1a[0]));

  // -------------------------------------------------- RELOAD AND BOOT AGAIN
  // Same browser, same profile, same origin — so IndexedDB is the ONLY thing
  // carrying the cards across. A fresh page object is used so nothing from the
  // first run can be mistaken for a restore.
  await page.close();
  page = await browser.newPage();
  wirePage(page);
  pageLogs.push('---- reload ----');

  const v2 = await bootAndArm('boot 2 (after reload)');
  check('the reloaded console still has two cards',
        v2.slots.filter((s) => s.present).length >= 2,
        JSON.stringify(v2.slots.filter((s) => s.present).map((s) => 'p' + s.port)));

  const live0c = await readCard(0);
  const live1c = await readCard(1);
  const c0 = live0c && live0c.head, c1 = live1c && live1c.head;

  check('PLAYER 2\'S CARD CAME BACK after the reload',
        !!c1 && allAre(c1, P2_BYTE, PATTERN_LEN),
        c1 ? 'p1 first bytes ' + hex(c1[0]) + ' ' + hex(c1[1]) : 'no data');
  check('PLAYER 1\'S CARD IS UNCHANGED after the reload',
        !!c0 && allAre(c0, P1_BYTE, PATTERN_LEN),
        c0 ? 'p0 first bytes ' + hex(c0[0]) + ' ' + hex(c0[1]) : 'no data');
  check('the two restored cards are still DIFFERENT from each other',
        !!c0 && !!c1 && c0[0] !== c1[0],
        'p0[0]=' + hex(c0 && c0[0]) + ' vs p1[0]=' + hex(c1 && c1[0]));
  check('restored cards landed in two DIFFERENT buffers',
        live0c.ptr !== live1c.ptr,
        'p0 ptr=' + hex(live0c.ptr) + '  p1 ptr=' + hex(live1c.ptr));

  const restoredLines = pageLogs.filter((l) => /\[vmu\].*restored/.test(l));
  check('the page LOGGED a restore for both players',
        restoredLines.length >= 2,
        restoredLines.join(' | ') || 'no restore lines');

  check('no worker message went unhandled',
        !pageLogs.some((l) => /unknown worker cmd: vmu/.test(l)),
        pageLogs.filter((l) => /unknown worker cmd/.test(l)).join(' | ') || 'none');

  // ---------------------------------------------------------------- SAVE STATE
  // Does a savestate carry BOTH players' cards, or only player 1's?
  //
  // The code says all four: mcfg_SerializeDevices() (core/hw/maple/maple_cfg.cpp)
  // loops MAPLE_PORTS x 6 slots and calls device->serialize() on every one, and
  // maple_sega_vmu::serialize() writes the whole 128 KB flash_data. But a
  // code-read is not a measurement, so this arm makes the machine answer:
  // snapshot -> deliberately corrupt BOTH cards -> restore -> both must be back
  // to the exact bytes the snapshot was taken on, fingerprinted over all
  // 131072 bytes and not just the pattern.
  const beforeSave0 = await readCard(0);
  const beforeSave1 = await readCard(1);

  // The page mirrors its own log to the console, which wirePage() taps, so the
  // wait is on the page's OWN words rather than on a fixed sleep.
  const waitForLog = async (re, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (pageLogs.some((l) => re.test(l))) return true;
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  };
  await page.click('#btnSave');
  const sawSaved = await waitForLog(/state saved \d+ B/, 180000);
  check('Save State produced a state', sawSaved,
        pageLogs.filter((l) => /\[page\] state/.test(l)).slice(-2).join(' | ') || 'no state line');

  // Corrupt both cards so a restore that only covers player 1 is unmistakable.
  await page.evaluate((b, n) => window.__dcVmuPoke(0, b, n), 0xc3, PATTERN_LEN);
  await page.evaluate((b, n) => window.__dcVmuPoke(1, b, n), 0xd4, PATTERN_LEN);
  const dirty0 = await readCard(0), dirty1 = await readCard(1);
  check('both cards were deliberately dirtied before the restore',
        dirty0.head[0] === 0xc3 && dirty1.head[0] === 0xd4,
        'p0[0]=' + hex(dirty0.head[0]) + ' p1[0]=' + hex(dirty1.head[0]));

  await page.click('#btnLoad');
  const loadedOk = await waitForLog(/state loaded OK/, 180000);
  check('Load State was accepted by the core', loadedOk,
        pageLogs.filter((l) => /\[page\] state/.test(l)).slice(-2).join(' | ') || 'no state line');

  const after0 = await readCard(0), after1 = await readCard(1);
  check('Save State captured PLAYER 1\'s card (restored byte-for-byte)',
        after0.sum === beforeSave0.sum && after0.head[0] === beforeSave0.head[0],
        'sum ' + beforeSave0.sum + ' -> dirty ' + dirty0.sum + ' -> restored ' + after0.sum);
  check('Save State captured PLAYER 2\'s card (restored byte-for-byte)',
        after1.sum === beforeSave1.sum && after1.head[0] === beforeSave1.head[0],
        'sum ' + beforeSave1.sum + ' -> dirty ' + dirty1.sum + ' -> restored ' + after1.sum);
  check('the two restored cards are still distinct after a state load',
        after0.sum !== after1.sum && after0.ptr !== after1.ptr,
        'p0 sum=' + after0.sum + ' ptr=' + hex(after0.ptr) + '  p1 sum=' + after1.sum + ' ptr=' + hex(after1.ptr));

  // A state load replaces the cards wholesale, so the page must re-persist them
  // or IndexedDB would silently keep the pre-load bytes and the next reload
  // would undo the restore.
  await new Promise((r) => setTimeout(r, 3000));
  const stored1b = await page.evaluate(async () => { const v = await window.__dcVmuStored(1); return v ? Array.from(v.slice(0, 2)) : null; });
  check('the restored player 2 card was written back to storage',
        !!stored1b && stored1b[0] === after1.head[0],
        'vmu:p1[0]=' + hex(stored1b && stored1b[0]) + ' vs live ' + hex(after1.head[0]));

} catch (err) {
  fail++;
  failures.push('threw: ' + (err && err.message ? err.message : String(err)));
  console.log('  FAIL  ' + (err && err.message ? err.message : String(err)));
} finally {
  console.log('\n---- [vmu] / [maple] lines the page printed ----');
  for (const l of pageLogs) console.log('  ' + l);
  try { await browser.close(); } catch (e) {}
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
}

console.log('\n[vmu-two-player] ' + pass + '/' + (pass + fail) + ' passed');
if (fail) {
  console.log('[vmu-two-player] FAILURES:');
  for (const f of failures) console.log('  - ' + f);
}
process.exit(fail ? 1 : 0);

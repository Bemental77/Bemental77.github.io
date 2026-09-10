// gamecube/tools/recomp_fourport_test.mjs
//
// DOES MARIO PARTY 4 SEE FOUR CONTROLLERS? — asked of the GAME, not of our own flag.
//
// The recomp engine (gamecube/recomp/) is the only GameCube path that runs a title at
// 1.000x, and until 2026-09-10 it could express exactly ONE player: shims/src/gc_input.c
// held four SCALARS, their setters took no port, and build_wasm.sh baked the literal
// `HuPadBtnDown[0]`. This harness is the acceptance test for making that four ports.
//
// ── WHY winKey IS THE WITNESS (and why HuPadBtnDown is NOT) ─────────────────────────────
// Our injection WRITES HuPadBtnDown[p]. Reading HuPadBtnDown back therefore proves only
// that we can write memory — it is circular, and this repo has shipped circular evidence
// before. The non-circular witness is `winKey` (guest 0x801953C0, u32[4]): MP4's OWN
// HuWinComKeyGet loops i = 0..3 and computes
//
//     winKey[i] = HuPadDStkRep[i] | HuPadBtnDown[i]        (src/game/window.c:1564-1580)
//
// every frame a message window is in stat 2 or 3 (src/game/window.c:558-568), for all four
// pads (player_disable defaults to 0, src/game/window.c:279). If four distinct injected
// pads come back out of winKey as four distinct values, the GAME read four ports.
//
// ── THE ARMS ────────────────────────────────────────────────────────────────────────────
//   ARM=four   the SHIPPED gamecube/recomp/mp4_game.wasm — which IS the per-port build
//   ARM=one    /gamecube/recomp/oneport/    — the MATCHED single-port control, built from the
//                                             identical tree with RECOMP_SINGLEPORT=1, which
//                                             bakes the pre-2026-09-10 `HuPadBtnDown[0] |= ...`
//                                             line and changes NOTHING else.
// ⚠ THE PREVIOUSLY-SHIPPED WASM IS NOT A VALID CONTROL. It predates ___recomp_pad_witness, so
// it reads four zeros for the trivial reason that it has no witness at all — a vacuous pass
// that would "prove" the fix while measuring nothing. That is exactly the placebo-arm failure
// tools/device_matrix.mjs voids cells for. This harness refuses the same way: if the control's
// `injected` row is all zeros (the host never reached the shim) the arm is VOID, not PASS.
//
// Usage:
//   node gamecube/tools/recomp_fourport_test.mjs              # both arms
//   ARM=four node gamecube/tools/recomp_fourport_test.mjs     # one arm
// Env: RECOMPBUILD (default '' = the shipped pair), RECOMPBUILD_ONE (default 'oneport'),
//      RUN_MS (default 150000), PROBE_HEADLESS=0,
//      PADBITS="10,20,40,30" (per-port GC button bits, hex, no 0x).
//
// ⚠ SERIALIZE IT: bash tools/probe_lock.sh run -- node gamecube/tools/recomp_fourport_test.mjs

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const RUN_MS = parseInt(process.env.RUN_MS || '150000', 10);
// Empty = the SHIPPED pair, which IS the four-port build. The test measures what a
// visitor gets, not a side build (CLAUDE.md gate #11).
const RECOMPBUILD = process.env.RECOMPBUILD ?? '';
const RECOMPBUILD_ONE = process.env.RECOMPBUILD_ONE ?? 'oneport';
const ARM = process.env.ARM || '';
const PADBITS = (process.env.PADBITS || '10,20,40,30').split(',').map((s) => parseInt(s, 16));

// Guest windows mirrored into the pace SAB every frame by recomp_worker.js publishPeek().
// ?peek= takes MEM1 OFFSETS (guest address minus 0x80000000), 64 bytes each.
//   w0 winKey[4]            0x801953C0  — THE WITNESS (u32 BE x4)
//   w1 HuPadStkY/StkX/BtnRep/BtnDown/Btn at 0x801D3AC0/AC4/AC8/AD0/AD8
//   w2 GlobalCounter 0x801D3A54 (+0x14) and _PadErr[4] 0x801D3A60 (+0x20)
//   w3 GWPlayerCfg[4]       0x8018FC10  — stride 0x0A: character, pad_idx, diff, group, iscom
const PEEK = '1953C0,1D3AC0,1D3A40,18FC10';

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
               '.wasm': 'application/wasm', '.json': 'application/json',
               '.bin': 'application/octet-stream', '.gz': 'application/gzip',
               '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml',
               '.dol': 'application/octet-stream', '.raw': 'application/octet-stream' };

// ⚠ /gamedata/... IS THIS SAME TREE, LOCALLY. lib/asset_base.js moved the game library to a
// separate Pages repo published at the same origin under /gamedata/, so gamecube.html asks
// for '/gamedata/gamecube/roms/...'. A private static server that does not know the prefix
// 404s every disc part and the run reads as a dead emulator — this cost a whole run here on
// 2026-09-10 via gamecube/tools/recomp_live_probe.mjs, which still has the bug.
// ⚠ ANCHORED REGEX: asset_base.js documents the switch with COMMENTED example assignments,
// and an unanchored match picks up "window.ASSET_BASE = '';" from a comment and strips nothing.
const OFFSITE_PREFIX = (() => {
  try {
    const m = /^window\.ASSET_BASE\s*=\s*'([^']*)'/m
      .exec(fs.readFileSync(path.join(ROOT, 'lib', 'asset_base.js'), 'utf8'));
    return m ? m[1] : '';
  } catch (e) { return ''; }
})();

function startServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      let urlPath = decodeURIComponent(req.url.split('?')[0]);
      if (OFFSITE_PREFIX && (urlPath === OFFSITE_PREFIX || urlPath.startsWith(OFFSITE_PREFIX + '/')))
        urlPath = urlPath.slice(OFFSITE_PREFIX.length) || '/';
      if (urlPath === '/') urlPath = '/gamecube.html';
      const filePath = path.join(ROOT, urlPath);
      fs.stat(filePath, (err, stat) => {
        if (err) { res.statusCode = 404; res.end('404'); return; }
        res.setHeader('Content-Type', MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream');
        res.setHeader('Content-Length', stat.size);
        fs.createReadStream(filePath).pipe(res);
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

const be32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const be16 = (b, o) => ((b[o] << 8) | b[o + 1]) >>> 0;
const s8 = (v) => (v > 127 ? v - 256 : v);
const hex = (v) => '0x' + (v >>> 0).toString(16);

async function runArm(arm) {
  const { srv, port } = await startServer();
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: process.env.PROBE_HEADLESS === '0' ? false : 'new',
    args: ['--no-sandbox', '--enable-features=SharedArrayBuffer', '--disable-web-security',
           '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
           '--disable-backgrounding-occluded-windows',
           '--disable-features=IntensiveWakeUpThrottling',
           '--js-flags=--max-old-space-size=4096', '--disk-cache-size=1'],
  });
  try { (await import('../../tools/browser_leak_guard.js')).default.guard(browser, 'recomp_fourport_test'); }
  catch (_e) { /* guard is best-effort */ }

  const page = await browser.newPage();
  const logs = [];
  page.on('console', (m) => { logs.push(m.text().slice(0, 220)); });
  page.on('pageerror', (e) => { logs.push('PAGEERROR ' + String(e).slice(0, 220)); });
  page.on('requestfailed', (r) => { logs.push('REQFAIL ' + r.url().slice(-70) + ' ' + (r.failure() || {}).errorText); });

  const dir = arm === 'four' ? RECOMPBUILD : RECOMPBUILD_ONE;
  const build = dir ? '&recompbuild=' + dir : '';
  const url = `http://127.0.0.1:${port}/gamecube.html?recomp=1&peek=${PEEK}${build}&v=${Date.now()}`;
  console.log(`\n===== ARM ${arm} =====  ${build || '(the shipped pair)'}`);
  await page.setCacheEnabled(false);
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  // ⚠ WAIT OUT coi-serviceworker's RELOAD BEFORE CLICKING START. The port is ephemeral, so
  // every run is a fresh origin and coi-serviceworker.js reloads the page once to install
  // COOP/COEP. Clicking Start before that reload boots a document that is about to be thrown
  // away: the log reads "[ui] loading dolphin_libretro.js" then "Reloading page…" and the
  // second document is never started — which presents as "the guest never ran" and cost a
  // 180 s run here. Same handshake dolphin_render_probe.js:365-377 uses: settle on two
  // consecutive evaluates returning the same href (crossOriginIsolated is NOT the signal —
  // --disable-web-security makes it read false while SAB works fine).
  // ⚠ AN HREF-ONLY SETTLE IS NOT ENOUGH and measured so here: the reload fires only once the
  // service worker reaches `active`, which took longer than the two-poll settle, so Start was
  // clicked on the doomed document ("[ui] loading dolphin_libretro.js" then "Reloading page…"
  // then silence) and 200 s of run reported peekSeq=0 — a live emulator reading as dead. The
  // signal that the reload is BEHIND us is navigator.serviceWorker.controller being non-null:
  // coi-serviceworker.js reloads exactly on `registration.active && !controller`, so once the
  // page is controlled it will not reload again.
  {
    let controlled = false, tries = 0;
    while (!controlled && tries < 160) {
      tries++;
      try {
        controlled = await page.evaluate(() =>
          !!(navigator.serviceWorker && navigator.serviceWorker.controller) || window.crossOriginIsolated === true);
      } catch (e) { controlled = false; }   // reload tore the context down: that IS the event
      if (!controlled) await new Promise((r) => setTimeout(r, 250));
    }
    let ok = 0, lastHref = '';
    for (let i = 0; i < 20 && ok < 3; i++) {
      try {
        const href = await page.evaluate(() => location.href);
        if (href === lastHref) ok++; else { ok = 1; lastHref = href; }
      } catch (e) { ok = 0; }
      await new Promise((r) => setTimeout(r, 250));
    }
    console.log(`[arm ${arm}] coi settled: controlled=${controlled} after ${tries} polls, href stable=${ok >= 3}`);
  }
  await page.evaluate(() => {
    localStorage.setItem('gcwasm_romIdx', '0');
    const sel = document.getElementById('romSelect');
    if (sel) sel.value = '0';
    document.getElementById('btnStart')?.click();
  });

  // Wait for the recomp worker to actually be producing frames — window.__gcPad.seq() is
  // bumped once per GUEST frame by publishPeek(), so a rising seq is proof of a live guest
  // (a stale canvas is not; CLAUDE.md gate #10).
  const t0 = Date.now();
  let live = false;
  while (Date.now() - t0 < RUN_MS) {
    await new Promise((r) => setTimeout(r, 2000));
    const s = await page.evaluate(() => (window.__gcPad ? window.__gcPad.seq() : -1));
    const el = ((Date.now() - t0) / 1000).toFixed(0);
    if ((+el) % 10 < 2) console.log(`[arm ${arm}] t=${el}s peekSeq=${s}`);
    if (s > 30) { live = true; console.log(`[arm ${arm}] guest live at seq=${s} after ${el}s`); break; }
  }
  if (!live) {
    console.log(`[arm ${arm}] FAIL: the guest never produced frames (no rising peek seq)`);
    logs.slice(-40).forEach((l) => console.log('   page|', l));
    await page.screenshot({ path: `/tmp/fourport-${arm}-dead.png` }).catch(() => {});
    await browser.close(); srv.close();
    return { arm, ok: false, why: 'guest never ran' };
  }

  // Hold four DISTINCT pads. Written every 8ms so every guest frame sees them: the worker
  // exchange-clears the edge cells after delivering exactly one frame of them.
  await page.evaluate((bits) => {
    window.__fpTimer = setInterval(() => {
      for (let p = 0; p < 4; p++) window.__gcPad.edge(p, bits[p], 0);
    }, 8);
  }, PADBITS);

  // Drive toward a MESSAGE WINDOW and sample continuously.
  //
  // ⚠ TIMING THE JOURNEY BY WALL CLOCK DOES NOT WORK and one run was lost to it: the guest is
  // still in the boot/logo when the first frames appear, the title lands tens of seconds later,
  // and after the title MP4 rolls its attract demo — whose THP movie this port stubs out, so the
  // canvas goes WHITE and stays white. Pressing Start on a fixed schedule pressed it into the
  // logo and then sat through the demo. So the journey is driven off the GAME'S OWN state
  // instead: keep tapping Start/A while `openWindows` is 0, and stop the moment the game says a
  // message window is in stat 2/3 (which is precisely when HuWinComKeyGet fills winKey).
  let best = null, sawWitness = false, lastOvl = null, nextPress = 0, pressIdx = 0;
  const PRESS_SEQ = ['Enter', 'KeyX', 'Enter', 'KeyX', 'KeyX'];
  const deadline = Date.now() + Math.max(20000, RUN_MS - (Date.now() - t0));
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    const snap = await page.evaluate(() => ({
      seq: window.__gcPad.seq(), w: window.__gcPad.witness(),
    }));
    if (!snap || !snap.w) continue;
    sawWitness = true;
    const w = snap.w;
    if (lastOvl === null || w.ovl !== lastOvl) {
      console.log(`[arm ${arm}] t=${((Date.now() - t0) / 1000).toFixed(0)}s omcurovl ${lastOvl} -> ${w.ovl}`
        + ` evt=${w.ovlEvt} openWindows=${w.openWindows} frames=${snap.seq}`);
      lastOvl = w.ovl;
    }
    const nz = w.winKey.filter((v) => v !== 0).length;
    const distinct = new Set(w.winKey.filter((v) => v !== 0)).size;
    const cand = { seq: snap.seq, nz, distinct, ...w };
    // Prefer the sample where the GAME'S winKey separated the most ports; fall back to the one
    // where its HuPadBtnDown did, so a run that never opened a window still reports something.
    const score = (c) => c.distinct * 100 + c.nz * 10
      + new Set(c.btnDown.filter((v) => v !== 0)).size;
    if (!best || score(cand) > score(best)) best = cand;
    if (best.distinct >= 4) break;
    if (w.openWindows === 0 && Date.now() > nextPress) {
      nextPress = Date.now() + 3000;
      const k = PRESS_SEQ[pressIdx++ % PRESS_SEQ.length];
      await page.keyboard.press(k).catch(() => {});
    }
  }
  await page.evaluate(() => { if (window.__fpTimer) clearInterval(window.__fpTimer); });
  await page.screenshot({ path: `/tmp/fourport-${arm}.png` }).catch(() => {});
  await browser.close(); srv.close();

  if (!best) {
    console.log(`[arm ${arm}] FAIL: no witness sample (witness fn present: ${sawWitness})`);
    logs.slice(-20).forEach((l) => console.log('   page|', l));
    return { arm, ok: false, why: 'no witness sample' };
  }
  const row = (n, a, f) => console.log(`[arm ${arm}] ${n.padEnd(18)}= ` + a.map(f || hex).join(' '));
  console.log(`[arm ${arm}] injected per-port btn bits: ` + PADBITS.map(hex).join(' '));
  row('winKey[0..3]', best.winKey);
  console.log(`[arm ${arm}]   ^ MP4's OWN HuWinComKeyGet output (window.c:1564-1580) — `
    + `${best.distinct} distinct non-zero across four ports`);
  row('__inject_btn', best.injected);
  row('HuPadBtnDown', best.btnDown);
  row('HuPadBtn', best.btn);
  row('HuPadDStkRep', best.dstkRep);
  row('HuPadStkX', best.stkX, String);
  row('HuPadStkY', best.stkY, String);
  row('HuPadErr', best.err, String);
  console.log(`[arm ${arm}]   ^ 0 = PAD_ERR_NONE: the game believes all four controllers are present`);
  console.log(`[arm ${arm}] GWPlayerCfg       = ` + [0, 1, 2, 3].map((i) =>
    `P${i + 1}{char=${best.cfgChar[i]} pad=${best.cfgPad[i]} com=${best.cfgCom[i]}}`).join(' '));
  console.log(`[arm ${arm}]   ^ pad_idx is the game's OWN port assignment (gamework.c:30 /`
    + ` modeseldll/main.c:140-149); com=0 means it read HuPadStatGet(i)==0 and called that slot HUMAN`);
  console.log(`[arm ${arm}] omcurovl=${best.ovl} evt=${best.ovlEvt} openWindows=${best.openWindows}`);
  console.log(`[arm ${arm}] screenshot -> /tmp/fourport-${arm}.png   (guest frames seen: ${best.seq})`);
  return { arm, ok: true, ...best };
}

const arms = ARM ? [ARM] : ['four', 'one'];
const results = [];
for (const a of arms) results.push(await runArm(a));

console.log('\n========== FOUR-PORT VERDICT ==========');
let fail = 0;
for (const r of results) {
  if (!r.ok) { console.log(`  ${r.arm}: NO RESULT — ${r.why}`); fail++; continue; }
  const expect = PADBITS.map((b) => b >>> 0);
  if (r.arm === 'four') {
    const exact = r.winKey.every((v, i) => (v & expect[i]) === expect[i]);
    const bdExact = r.btnDown.every((v, i) => (v & expect[i]) === expect[i]);
    const bdDistinct = new Set(r.btnDown.filter((v) => v !== 0)).size;
    const ok = r.distinct >= 4 && exact;
    console.log(`  four: ${ok ? 'PASS' : 'FAIL'} — MP4's own winKey carried ${r.distinct}/4 distinct pads`
      + (exact ? " with every port's exact injected bits" : ' — bits did not match what was injected'));
    console.log(`        HuPadBtnDown separated ${bdDistinct}/4 ports${bdExact ? ' with the exact injected bits' : ''}`
      + ' (the game\'s pad array; winKey is the non-circular half)');
    if (!ok) fail++;
  } else {
    // ARM-DIFFERENCE PROOF. The control only means something if the host reached the shim and
    // the shim reached port 0 — otherwise four zeros are the trivial result of a wasm with no
    // witness or no injection at all, and the arm is a placebo. Void it rather than pass it.
    const hostReached = r.injected.some((v) => v !== 0);
    const p0Live = (r.winKey[0] & expect[0]) === expect[0] || (r.btnDown[0] & expect[0]) === expect[0];
    if (!hostReached || !p0Live) {
      console.log(`  one:  VOID — no arm-difference proof (host injected=${r.injected.map(hex).join(' ')},`
        + ` port 0 winKey=${hex(r.winKey[0])} btnDown=${hex(r.btnDown[0])}).`
        + ' Four zeros here would prove nothing about ports 1-3.');
      fail++;
    } else {
      const silent = r.winKey.slice(1).every((v) => (v & 0xFFFF) === 0)
                  && r.btnDown.slice(1).every((v) => (v & 0xFFFF) === 0);
      console.log(`  one:  ${silent ? 'PASS (control reproduces the single-port defect: player 1 only)' : 'FAIL — the control was NOT single-port'}`
        + ` — port 0 got ${hex(r.winKey[0])} while winKey[1..3] = ` + r.winKey.slice(1).map(hex).join(' ')
        + `, HuPadBtnDown[1..3] = ` + r.btnDown.slice(1).map(hex).join(' '));
      if (!silent) fail++;
    }
  }
}
console.log(fail === 0 ? 'ALL ARMS AS EXPECTED' : `${fail} ARM(S) FAILED`);
process.exit(fail === 0 ? 0 : 1);

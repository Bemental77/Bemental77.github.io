#!/usr/bin/env node
// ARE THE CONTROLLERS ACTUALLY PLUGGED IN — AND DOES THE GUEST READ THEM?
//
// A missing maple device is SILENT. The player's bytes arrive at the worker,
// input_state_cb is never called for that port, and nothing on screen moves.
// That is how port 1 was once broken ("port 1 = 0x81 lx=+32766 while no device
// existed to read them"), and until this rig ports 2 and 3 were in exactly that
// state. So "delivered" is not the question. "READ" is.
//
// THE WITNESS is emscripten_get_port_polls(port): a counter bumped inside
// input_state_cb, which flycast only calls for a port that HAS a device. A
// nonzero count is direct evidence the plug took; a zero is direct evidence it
// did not, whatever the config says.
//
// TWO ARMS, and the second one matters as much as the first:
//   players=4  ports 0..3 must all be polled     (the four-player claim)
//   players=1  port 0 polled, 1..3 SILENT        (an empty port must stay empty:
//              plugging four for a solo player would change what the game sees)
//
// USAGE  npm run web && node dreamcast/tools/port_plug_test.mjs
//        PLAYERS=4 node dreamcast/tools/port_plug_test.mjs    (one arm only)
import puppeteer from 'puppeteer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ORIGIN = process.env.ORIGIN || 'http://localhost:8080';
const BOOT_MS = Number(process.env.BOOT_MS || 90000);

let pass = 0, fail = 0;
const ok  = (n, d = '') => { pass++; console.log(`  PASS  ${n}${d ? '  ' + d : ''}`); };
const bad = (n, d = '') => { fail++; console.log(`  FAIL  ${n}${d ? '  ' + d : ''}`); };

async function arm(players) {
  console.log(`\n== players=${players} ==`);
  const browser = await puppeteer.launch({ headless: 'new', executablePath: CHROME,
    args: ['--no-sandbox', '--use-gl=angle', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
  try { (await import(path.join(root, 'tools/browser_leak_guard.js'))).default.guard(browser, 'dc_port_plug'); } catch (e) {}
  try {
    const page = await browser.newPage();
    // ⚠ INJECTED, NOT EDITED. dreamcast.html is owned by another agent; the
    // player count is wired there separately. This rig reaches the same seam
    // from outside by wrapping Worker.postMessage, so it tests the SHIPPED page
    // and the SHIPPED worker with nothing forked.
    // The count MUST go in before the disc load — devices are created inside
    // retro_load_game — so it rides in front of the first discLazy/discReady.
    await page.evaluateOnNewDocument((n) => {
      window.__portPollReplies = [];
      const OP = Worker.prototype.postMessage;
      let sent = false;
      Worker.prototype.postMessage = function (msg, ...rest) {
        if (!sent && msg && (msg.cmd === 'discLazy' || msg.cmd === 'discReady')) {
          sent = true;
          window.__dcWorker = this;
          OP.call(this, { cmd: 'players', n });
        }
        if (!window.__dcWorker && msg && msg.cmd === 'mem-init') window.__dcWorker = this;
        return OP.call(this, msg, ...rest);
      };
      const AEL = Worker.prototype.addEventListener;
      window.__hookWorker = (w) => {
        w.addEventListener('message', (e) => {
          const m = e.data || {};
          if (m.cmd === 'portPolls' || m.cmd === 'players') window.__portPollReplies.push(m);
          if (m.cmd === 'print' && /plugged|players/.test(m.txt || '')) window.__portPollReplies.push({ cmd: 'print', txt: m.txt });
        });
      };
    }, players);
    const logs = [];
    page.on('console', (m) => { const t = m.text(); if (/plugged|\[players\]|portPolls/.test(t)) logs.push(t); });
    await page.goto(ORIGIN + '/dreamcast.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
    // coi-serviceworker reloads the page on first visit; wait for the settled load.
    await page.waitForFunction(() => window.crossOriginIsolated === true, { timeout: 60000 }).catch(() => {});
    await page.waitForFunction(() => !!document.getElementById('btnStart'), { timeout: 30000 });
    await page.evaluate(() => { if (window.__dcWorker) window.__hookWorker(window.__dcWorker); });
    await page.evaluate(() => {
      const b = document.getElementById('btnStart') || document.getElementById('mobileSplashStart');
      if (b) b.click();
    });
    // Give the guest time to boot far enough to poll maple at all.
    const got = await page.waitForFunction((deadline) => {
      if (!window.__dcWorker) return false;
      if (!window.__hooked) { window.__hookWorker(window.__dcWorker); window.__hooked = true; }
      window.__dcWorker.postMessage({ cmd: 'portPolls' });
      const r = window.__portPollReplies.filter((m) => m.cmd === 'portPolls' && m.ok);
      const last = r[r.length - 1];
      return (last && last.polls.some((v) => v > 0)) ? last : false;
    }, { timeout: BOOT_MS, polling: 1000 }, Date.now() + BOOT_MS).then((h) => h.jsonValue()).catch(() => null);

    if (!got) {
      const say = await page.evaluate(() => window.__portPollReplies.slice(-6));
      bad(`polls-p${players}`, 'the core never polled ANY port within ' + BOOT_MS + ' ms — ' + JSON.stringify(say));
      return;
    }
    console.log(`  polls = [${got.polls.join(', ')}]   worker reports players=${got.players}`);
    if (got.players !== players) bad(`players-applied-p${players}`, `worker says players=${got.players}`);
    else ok(`players-applied-p${players}`, `the worker accepted the count before the disc load`);
    const live = got.polls.map((v, i) => (v > 0 ? i : -1)).filter((i) => i >= 0);
    const want = [];
    for (let i = 0; i < players; i++) want.push(i);
    JSON.stringify(live) === JSON.stringify(want)
      ? ok(`ports-read-p${players}`, `the guest POLLED exactly ports ${want.join(',')} — ${players === 1 ? 'an empty port stayed empty' : 'every seated player is read'}`)
      : bad(`ports-read-p${players}`, `polled ${JSON.stringify(live)}, expected ${JSON.stringify(want)}`);
  } catch (e) {
    bad(`arm-p${players}`, e.message);
  } finally {
    await browser.close();
  }
}

const only = process.env.PLAYERS ? [Number(process.env.PLAYERS)] : [4, 1];
for (const n of only) await arm(n);
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

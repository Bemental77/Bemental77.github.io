// Load the daily start state, hold the stick for 120 VIs under lockstep, print Mario every 10 VIs.
import puppeteer from 'puppeteer';
import fs from 'node:fs';
const base = process.env.URL || 'http://localhost:8080/n64/';
const browser = await puppeteer.launch({ headless: 'new', executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required', '--no-sandbox'] });
const page = await browser.newPage();
await page.goto(base + '?game=sm64.z64&autostart', { waitUntil: 'load' });
await page.waitForFunction('window.myApp && myApp.rivetsData && myApp.rivetsData.beforeEmulatorStarted === false', { timeout: 90000 });
await new Promise(r => setTimeout(r, 3000));
const st = Array.from(fs.readFileSync(new URL('../daily/states/castle_grounds.gz', import.meta.url)));
const out = await page.evaluate((st, ax, ay) => {
  const M = Module, p = M._neil_rdram_ptr(), f = a => M.HEAPF32[(p + (a & 0x1FFFFFFF)) >>> 2], u = a => M.HEAPU32[(p + (a & 0x1FFFFFFF)) >>> 2] >>> 0;
  myApp.SaveStateEvent = () => {};
  M._neil_ls_arm(1);
  M.FS.writeFile('/savestate.gz', new Uint8Array(st)); const ok = M._neil_unserialize();
  const rows = [];
  for (let t = 0; t < 120; t++) { M._neil_ls_set_pad(0, 0, ax, ay); M._neil_ls_run_frame(); if (t % 10 === 9) rows.push([t + 1, u(0x8033B170 + 0x0C).toString(16), f(0x8033B1AC).toFixed(0), f(0x8033B1B0).toFixed(0), f(0x8033B1B4).toFixed(0), f(0x8033B1C4).toFixed(1), M.HEAP16[(p + ((0x8033B19E & 0x1FFFFFFF) ^ 2)) >>> 1]]); }
  return { ok, rows };
}, st, +(process.env.AX || 0), +(process.env.AY || 32000));
console.log(JSON.stringify(out));
await browser.close(); process.exit(0);

// Gameplay (not attract) capacity probe for one N64 ROM.
//
//   node n64_gameplay_probe.mjs <rom.z64> [startPresses]
//
// Why this exists: tools/n64_boot_test.mjs measures whatever scene the ROM
// lands on after the settle window -- usually a title/attract screen. Per the
// GameCube lesson, an idle/menu scene is NOT a gameplay measurement. This
// drives Start through input_controller.Key_Action_Start to push past title
// and menu screens, then measures.
//
// Metric of record is frameCostMs (mean wall ms per retro_run, the emulated
// VI frame) -- NOT any fps counter, which is structurally clamped to the
// region rate by IsFrameReady() (mymain.cpp:818-842).
import puppeteer from 'puppeteer';
import { execSync } from 'node:child_process';

const rom = process.argv[2];
const PRESSES = +(process.argv[3] || 10);
if (!rom) { console.error('usage: node n64_gameplay_probe.mjs <rom.z64> [startPresses]'); process.exit(2); }
const PAGE = 'http://localhost:8080/n64/N64Wasm/dist/n64.html';
const MEASURE_MS = +(process.env.MEASURE_MS || 10000);

function treeCpuSeconds(rootPid) {
  try {
    const rows = execSync('ps -Ao pid=,ppid=,time=', { encoding: 'utf8' }).trim().split('\n');
    const kids = new Map(), cpu = new Map();
    for (const line of rows) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)$/);
      if (!m) continue;
      const p = m[3].split(':').map(Number);
      cpu.set(+m[1], p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1]);
      if (!kids.has(+m[2])) kids.set(+m[2], []);
      kids.get(+m[2]).push(+m[1]);
    }
    let total = 0, stack = [rootPid]; const seen = new Set();
    while (stack.length) { const p = stack.pop(); if (seen.has(p)) continue; seen.add(p); total += cpu.get(p) || 0; for (const k of kids.get(p) || []) stack.push(k); }
    return total;
  } catch { return null; }
}

const out = { rom, phase: 'gameplay-attempt', startPresses: PRESSES };
const browser = await puppeteer.launch({
  headless: 'new', executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox', '--disable-dev-shm-usage'],
  protocolTimeout: 240000,
});
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(120000);
  page.on('pageerror', (e) => (out.pageError = String(e).slice(0, 200)));
  await page.goto(PAGE, { waitUntil: 'networkidle2' });
  await page.waitForFunction('!!(window.Module && Module.calledRun)', { timeout: 60000 });
  await page.evaluate((r) => { myApp.load_url('../roms/' + r); }, rom);
  await page.waitForFunction('myApp.rivetsData.beforeEmulatorStarted === false', { timeout: 120000 });
  await page.evaluate(() => myApp.audioContext && myApp.audioContext.resume());
  await new Promise((r) => setTimeout(r, 15000)); // boot to title

  const shotTitle = await (await page.$('#canvas')).screenshot().catch(() => null);

  // Drive Start to get past title/menus. Held ~180ms, released ~1.4s, so the
  // guest sees a clean press/release edge at 60Hz regardless of emulator speed.
  for (let i = 0; i < PRESSES; i++) {
    await page.evaluate(() => { if (window.input_controller) input_controller.Key_Action_Start = true; });
    await new Promise((r) => setTimeout(r, 180));
    await page.evaluate(() => { if (window.input_controller) input_controller.Key_Action_Start = false; });
    await new Promise((r) => setTimeout(r, 1400));
  }
  await new Promise((r) => setTimeout(r, 4000)); // let the scene settle

  await page.evaluate(() => {
    Module._neil_frame_cost_reset();
    window.__t0 = performance.now();
    window.__ar = { last: Module._neilGetAudioWritePosition(), sum: 0 };
    window.__ariv = setInterval(() => {
      const c = Module._neilGetAudioWritePosition();
      window.__ar.sum += (c - window.__ar.last + 64000) % 64000; window.__ar.last = c;
    }, 100);
  });
  const cpu0 = treeCpuSeconds(browser.process()?.pid);
  const shotA = await (await page.$('#canvas')).screenshot().catch(() => null);
  await new Promise((r) => setTimeout(r, MEASURE_MS));
  const cpu1 = treeCpuSeconds(browser.process()?.pid);
  const m = await page.evaluate(() => {
    clearInterval(window.__ariv);
    const el = (performance.now() - window.__t0) / 1000;
    return { ms: Module._neil_frame_cost_ms(), n: Module._neil_frame_cost_n(), el, aud: window.__ar.sum };
  });
  const shotB = await (await page.$('#canvas')).screenshot({ path: `/tmp/n64-sweep/gameplay-${rom.replace(/\.z64$/, '')}.png` }).catch(() => null);

  out.frameCostMs = Math.round((m.ms / m.n) * 1000) / 1000;
  out.frameCostN = m.n;
  out.viRatePerSec = Math.round((m.n / m.el) * 10) / 10;
  out.speedPct = Math.round((m.aud / m.el / 88200) * 100);
  out.headroomX = Math.round(((1000 / 60) / out.frameCostMs) * 100) / 100;
  if (cpu0 !== null && cpu1 !== null) {
    out.cpuMsPerFrame = Math.round(((cpu1 - cpu0) * 1000 / m.n) * 100) / 100;
    out.headroomCpuX = Math.round(((1000 / 60) / out.cpuMsPerFrame) * 100) / 100;
  }
  // did the Start presses actually change the scene? (title vs measured frame)
  out.sceneChangedFromTitle = shotTitle && shotB ? Buffer.compare(shotTitle, shotB) !== 0 : null;
  // is the picture live during the measure window? (stale-frame guard)
  out.sceneLiveDuringMeasure = shotA && shotB ? Buffer.compare(shotA, shotB) !== 0 : null;
  out.screenshot = `/tmp/n64-sweep/gameplay-${rom.replace(/\.z64$/, '')}.png`;
  out.load = execSync("uptime | sed 's/.*load averages*: //' | awk '{print $1}'", { encoding: 'utf8' }).trim();
  try { out.cpuSpeedLimit = +execSync('pmset -g therm', { encoding: 'utf8' }).match(/CPU_Speed_Limit\s*=\s*(\d+)/)[1]; } catch {}
} catch (e) { out.error = String(e).slice(0, 300); } finally { await browser.close(); }
console.log(JSON.stringify(out));

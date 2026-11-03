// tools/pokemonarena_sys_tick.mjs -- how long the system animations take PER TICK in a real browser (headless Chrome 140-class, throwaway profile, --mute-audio, behind the machine-wide
// browser lock of tools/headless_cdp.mjs: one browser at a time).
//   node tools/pokemonarena_sys_tick.mjs [--out <file.json>] [--budgets 2,4]
// The page tools/fixtures/pokemonarena/sys_tick.html plays 23 system runs (a scripted 3 v 3 battle: intro, hits, faints, send-outs, recalls) on a requestAnimationFrame loop with a
// step + draw + putImageData per tick and measures (a) the JS time of every tick, (b) the gap between rAF callbacks, in these modes:
//   sync, cache off        animator.start('system', ...) inside the tick that needs the run, no battle-state cache (the round-3 behaviour: the stall AN1 measured)
//   sync, cache on         the same with the battle-state cache (the events of one battle share the pre-roll; the first event of each battle still stalls)
//   sliced <b> ms [, cache off]  the NEXT run is prepared with animator.prepare() + advance(b) once per tick while the current one plays, begin() takes it
//   sliced <b> ms + warm   the same, and the battle states of the coming runs are also pre-rolled in the background (prepare('system', 'battle', ctx))
// A dev server on port 8106 is started for the run (tools/devserver.mjs, PORT=8106) and stopped after; CDP uses port 9381.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withBrowser } from './headless_cdp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2), opt = {};
for (let i = 0; i < args.length; i += 2) opt[args[i].replace(/^--/, '')] = args[i + 1];
const PORT = Number(process.env.PORT || 8106), CDP = Number(process.env.CDP_PORT || 9381);
const budgets = (opt.budgets || '2,4').split(',').map(Number);

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'tools/devserver.mjs')], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const t = setTimeout(() => reject(new Error('dev server did not start')), 15000);
    child.stdout.on('data', (d) => { if (/\[devserver\]/.test(String(d))) { clearTimeout(t); resolve(child); } });
    child.on('error', reject);
    child.on('exit', (c) => { if (c) reject(new Error('dev server exited ' + c)); });
  });
}

const server = await startServer();
const results = [];
try {
  await withBrowser({ port: CDP, width: 480, height: 320 }, async (page) => {
    await page.navigate(`http://localhost:${PORT}/tools/fixtures/pokemonarena/sys_tick.html`);
    await page.waitFor('window.READY === true', { timeoutMs: 30000 });
    const romLen = await page.eval('window.init()');
    console.log('ROM bytes', romLen, 'user agent', await page.eval('navigator.userAgent'), 'hardwareConcurrency', await page.eval('navigator.hardwareConcurrency'));
    await page.eval("window.runPass('sync', 0, 'warm-up')");                 // JIT warm-up, discarded
    results.push(await page.eval("window.runPass('sync', 0, 'sync, cache off (r3)', false, 0)"));
    results.push(await page.eval("window.runPass('sync', 0, 'sync, cache on', false)"));
    for (const b of budgets) {
      results.push(await page.eval(`window.runPass('sliced', ${b}, 'sliced ${b} ms, cache off', false, 0)`));
      results.push(await page.eval(`window.runPass('sliced', ${b}, 'sliced ${b} ms', false)`));
      results.push(await page.eval(`window.runPass('sliced', ${b}, 'sliced ${b} ms + warm', true)`));
    }
    if (page.errors.length) console.log('page errors:', page.errors.slice(0, 3));
  });
} finally { try { server.kill(); } catch (_e) {} }
if (opt.out) fs.writeFileSync(opt.out, JSON.stringify(results, null, 1) + '\n');
const f = (s) => (s ? `${s.min}/${s.median}/${s.max}` : '-');
console.log('mode'.padEnd(22), 'frames', 'tick ms min/med/max'.padEnd(20), 'ticks>16.7', 'ticks>33', 'gap max', 'gaps>34', 'start() ms min/med/max'.padEnd(24), 'advance ms min/med/max'.padEnd(24), 'begin ms', 'waited');
for (const r of results) console.log(r.tag.padEnd(22), String(r.frames).padStart(6), f(r.tickMs).padEnd(20), String(r.ticksOver16ms).padStart(10), String(r.ticksOver33ms).padStart(8), String(r.gapMs.max).padStart(7), String(r.gapsOver34ms).padStart(7), f(r.startMs).padEnd(24), f(r.advanceMs).padEnd(24), r.beginMs ? r.beginMs.max : '-', r.waitedTicks);

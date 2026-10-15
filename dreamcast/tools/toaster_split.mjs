#!/usr/bin/env node
// ============================================================================
// toaster_split.mjs — WHERE A DREAMCAST TOASTER FRAME'S TIME GOES, PER SECOND.
//
// tools/toaster_bench.mjs gives the verdict (pass/speed/over); this gives the
// split behind it, from counters the shipped worker already publishes — no
// instrumentation is added to the page or the core:
//   __dcProbe().pace  {emu, held, gate, paced, wall, drop}  (flycast_worker.js
//                     'ips': emu = inside run_iter, held = render hand-off,
//                     gate = parked on the lockstep gate, drop = governor debt
//                     thrown away)
//   __dcProbe().fskip {frames, drawn, skipped, lagSkips}
//   the worker's [split] line (EmscriptenWorker.cpp): rr / ml / rnd / jit*
// Same arm as the gate: SwiftShader, --max-old-space-size=512, and the
// tools/toaster_duty.py SIGSTOP duty cycle at <rate> on every renderer process.
// --room opens the bench's loopback room directly and prints the joiner (J)
// beside the host. --prof S takes a CDP CPU profile of the emulation worker for
// S seconds once the seed restore has settled (attribution only — CLAUDE.md
// gate 10: never size a win from a profile).
//
//   npm run web
//   node tools/browser_leak_guard.js reap && uptime
//   bash tools/probe_lock.sh run -- node dreamcast/tools/toaster_split.mjs <rate> <sec> [extra-query] \
//        [--room] [--prof S --profout F.cpuprofile] [--shot F.png]
//
// Findings: dreamcast/docs/toaster-split/TASKS.md
// ============================================================================
import { createRequire } from 'module'; import fs from 'fs'; import os from 'os'; import path from 'path'; import { spawn } from 'child_process';
const require = createRequire(process.env.PUPPETEER_FROM || (process.env.HOME + '/probe-deps/'));
const puppeteer = require('puppeteer');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const guard = (await import(path.join(ROOT, 'tools/browser_leak_guard.js'))).default;
const a = process.argv.slice(2); const rate = +a[0] || 1, secs = +a[1] || 30, extra = a[2] && !a[2].startsWith('--') ? a[2] : '';
const fl = (n) => { const i = a.indexOf('--' + n); return i >= 0 ? a[i + 1] : null; };
const prof = +fl('prof') || 0, shot = fl('shot'), room = a.includes('--room');
const BASE = process.env.BASE_URL || 'http://localhost:8080';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'toaster-split-'));
const b = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', headless: 'new', userDataDir: udd,
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--js-flags=--max-old-space-size=512'], protocolTimeout: 600000 });
guard.guard(b, 'dreamcast/tools/toaster_split.mjs');
let duty = null;
if (rate > 1) duty = spawn('python3', [path.join(ROOT, 'tools/toaster_duty.py'), String(b.process().pid), String(rate), '2'], { stdio: 'ignore' });
const p = await b.newPage(); const errs = [];
p.on('pageerror', (e) => errs.push(String(e.message).slice(0, 200)));
p.on('console', (m) => { const t = m.text(); if (/error|threw|desync/i.test(t)) errs.push(t.slice(0, 200)); if (/\[split\]/.test(t)) console.log('  ' + t.replace(/^.*\[split\]/, '[split]').slice(0, 260)); if (/\[(pchist|pswff|gwff|xff|g2|ctxsnap|setg2|armhist|armcode|armtime|aicatime)/.test(t)) console.log('  ' + t.slice(0, /ctxsnap/.test(t) ? 4000 : 520)); if (/\[peek\]/.test(t)) console.log(t); });
const code = 'Z' + Math.random().toString(36).slice(2, 6).toUpperCase().replace(/[^A-Z2-9]/g, 'Q');
await p.goto(room ? `${BASE}/dreamcast.html?bench=1&benchauto=1&benchsec=${secs}&benchphase=room&np=${code}&host=1&net=local&game=pso2${extra}` : `${BASE}/dreamcast.html?bench=1&benchauto=1&benchroom=0&benchsec=${secs}${extra}`, { waitUntil: 'load', timeout: 180000 });
const rows = []; let profd = false; const t0 = Date.now();
while (Date.now() - t0 < (secs + 240 * Math.max(1, rate / 3)) * 1000) {
  await sleep(1000);
  const r = await p.evaluate(() => { const q = window.__dcProbe && window.__dcProbe(); return q && { hb: q.hb, booted: q.booted, aicaX: q.aicaX, fps: q.fps, pace: q.pace, fs: q.fskip, rest: q.restoring, hbr: q.hbSinceRestore, done: !!window.__benchResult, res: window.__benchResult && (window.__benchResult.room || window.__benchResult.solo), j: (() => { try { const f = document.querySelector('iframe'); const q = f && f.contentWindow.__dcProbe && f.contentWindow.__dcProbe(); return q && { x: q.aicaX, pace: q.pace, fs: q.fskip }; } catch (e) { return null; } })() }; }).catch(() => null);
  if (!r) continue;
  if (r.booted && (!rows.length || rows[rows.length - 1].hb !== r.hb)) { rows.push(r); const pc = r.pace || {}; const f = r.fs || {};
    console.log(`hb${r.hb} x=${(+r.aicaX).toFixed(3)} fps=${r.fps} emu=${pc.emu} held=${pc.held} gate=${pc.gate} paced=${pc.paced} wall=${pc.wall} drop=${pc.drop} fs=${f.frames}/${f.drawn}/${f.skipped}/${f.lagSkips}` + (r.j && r.j.pace ? ` | J x=${(+r.j.x).toFixed(3)} emu=${r.j.pace.emu} held=${r.j.pace.held} gate=${r.j.pace.gate} paced=${r.j.pace.paced} drop=${r.j.pace.drop}` : '')); }
  if (prof && !profd && r.booted && !r.rest && r.hbr >= 3) {
    profd = true;
    const wt = b.targets().find((t) => /worker|other/.test(t.type()) && /flycast_worker\.js/.test(t.url()));
    if (wt) { const s = await wt.createCDPSession(); await s.send('Profiler.enable'); await s.send('Profiler.setSamplingInterval', { interval: 200 }); await s.send('Profiler.start');
      await sleep(prof * 1000); const { profile } = await s.send('Profiler.stop'); fs.writeFileSync(fl('profout') || '/tmp/dcsplit.cpuprofile', JSON.stringify(profile)); console.log('profile saved'); }
    else console.log('no worker target', b.targets().map((t) => t.type() + ' ' + t.url()).join('\n'));
  }
  if (r.done) { console.log('RESULT', JSON.stringify(r.res && { speed: r.res.speed, over: r.res.over, frames: r.res.frames, ms: r.res.ms })); break; }
}
if (shot) await p.screenshot({ path: shot }).catch(() => {});
console.log('errors', JSON.stringify(errs.slice(0, 5)), 'load', os.loadavg().map((x) => x.toFixed(2)).join(' '));
if (duty) duty.kill('SIGTERM'); await b.close(); fs.rmSync(udd, { recursive: true, force: true });

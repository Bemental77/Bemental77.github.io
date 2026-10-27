// Regression: the Wiggler day froze the page after the run was restarted (or Mario died) in the arena.
//
// daily.c replaces the Wiggler head on every respawn but not its three body parts. The orphans kept running
// bhv_wiggler_body_part_update against a dead parent; once that slot was recycled its oWigglerSegments was
// NULL, and they wrote floats and angles through it over addresses 0..79 -- on the emscripten stack canary,
// which aborted the module (the page stays up on its last frame: a "freeze").
//
//   npm run web                                  # the devserver, in another terminal
//   node sm64daily/test_wiggler_respawn.mjs      # URL=... CHROME=... to override
//
// Headless Chrome over a bare CDP WebSocket (Node's global WebSocket): no puppeteer. Own throwaway profile.
// Passes when, after N respawns of the head: the module has not aborted, nothing but zeros sits in the dead
// bottom of the stack (addresses 12..20000; the real stack stays above ~28000), the canary is intact, and the
// glue's repair counter (Module.strayWrites) is 0.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_ = process.env.URL || 'http://localhost:8080/sm64daily/?date=2026-10-26';   // 2026-10-26 is a Wiggler day
const RESPAWNS = +(process.env.RESPAWNS || 12);
const CHROME = process.env.CHROME || [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync);
if (!CHROME) { console.error('no Chrome found; set CHROME=...'); process.exit(2); }

const PORT = 9400 + Math.floor(Math.random() * 400), PROF = mkdtempSync(join(tmpdir(), 'sm64daily-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROF}`, '--no-first-run', '--mute-audio',
  '--autoplay-policy=no-user-gesture-required', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--window-size=900,700', 'about:blank'], { stdio: 'ignore' });
const w = ms => new Promise(r => setTimeout(r, ms));
const cleanup = () => { try { chrome.kill(); } catch (_e) {} };
process.on('exit', cleanup);
let failed = 0;
const check = (name, ok, detail = '') => { console.log((ok ? 'ok   ' : 'FAIL ') + name + (detail ? '  ' + detail : '')); if (!ok) failed++; };

try {
  let tgt; for (let i = 0; i < 40 && !tgt; i++) { await w(500); try { tgt = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find(t => t.type === 'page'); } catch (_e) {} }
  if (!tgt) throw new Error('chrome did not start');
  const ws = new WebSocket(tgt.webSocketDebuggerUrl); await new Promise(r => { ws.onopen = r; });
  let id = 0; const pend = new Map(); const logs = [];
  ws.onmessage = m => {
    const d = JSON.parse(m.data);
    if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); }
    else if (d.method === 'Runtime.exceptionThrown') logs.push('EXC ' + JSON.stringify(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text).slice(0, 300));
    else if (d.method === 'Runtime.consoleAPICalled') logs.push(d.params.type + ' ' + d.params.args.map(a => a.value ?? a.description).join(' ').slice(0, 300));
  };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async expr => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return r.result?.result?.value ?? r.result?.exceptionDetails?.text; };
  await send('Runtime.enable'); await send('Page.enable'); await send('Page.navigate', { url: URL_ });
  for (let i = 0; i < 60; i++) { await w(1000); if (await ev("!!document.querySelector('#play')")) break; }   // coi-serviceworker reloads once
  const chip = await ev("document.querySelector('.chip.mode')?.textContent");
  check('the day is a Wiggler boss battle', /Wiggler/i.test(chip || ''), JSON.stringify(chip));
  await ev("window.__ready=null; const r=window.sm64DailyReady; window.sm64DailyReady=(n,p)=>{window.__ready=n; r&&r(n,p)}; document.querySelector('#play').click(); 1");
  for (let i = 0; i < 90; i++) { await w(1000); if (await ev('window.__ready')) break; }
  const n = await ev('window.__ready'); check('game started', n > 2, 'stations=' + n);
  await ev("window.D=(f,...a)=>Module['_daily_debug_'+f](...a); 1");
  const aborted = () => logs.some(l => /Aborted/.test(l));
  const deadStack = () => ev('(()=>{const a=new Uint8Array(Module.HEAPU8.buffer,12,20000-12);let n=0;for(let i=0;i<a.length;i++)if(a[i])n++;return n})()');
  await ev(`D('warp',${n}-2)`); await w(500); await ev(`D('warp',${n}-1)`); await w(3000);   // to the boss arena (the last station)
  const boss = await ev("(()=>{const nd=D('num_dyn'); for(let i=0;i<nd;i++) if(D('dyn',i,0)===10) return i; return -1})()");
  const part = await ev(`D('dyn',${boss},5)`);
  const ax = await ev(`D('part',${part},0)`), ay = await ev(`D('part',${part},1)`), az = await ev(`D('part',${part},2)`);
  // What the player does: ground-pound the head, stand in the dialogue, get hit, die, and the run restarts -- which
  // replaces every enemy (the Wiggler head included) and frees dozens of object slots at once. Each pass leaves three
  // orphaned body parts; once their dead parent's slot is handed to another object, they write through NULL.
  const tapA = async () => { await ev('window.__padOverride={btn:0x8000,x:0,y:0}; 1'); await w(150); await ev('window.__padOverride={btn:0,x:0,y:0}; 1'); await w(300); };
  for (let k = 0; k < RESPAWNS && !aborted(); k++) {
    await ev(`D('dyn_move',${boss},${ax},${ay},${az})`); await w(200);
    await ev(`D('put',${ax},${ay}+260,${az},0)`); await ev(`D('action',8390825,0)`);   // ACT_GROUND_POUND onto the head
    for (let t = 0; t < 12; t++) { await w(400); if (t > 3) await tapA(); }
  }
  check('module did not abort', !aborted(), JSON.stringify(logs.filter(l => /Abort/.test(l)).slice(0, 1)));
  check('dead stack (12..20000) is all zero', (await deadStack()) === 0, 'nonzero bytes: ' + (await deadStack()));
  check('stack canary intact', (await ev('(()=>{const H=Module.HEAPU8;return H[11]===0x89&&H[7]===0x02})()')) === true);
  check('no stray writes repaired by the glue', !(await ev('Module.strayWrites|0')), 'strayWrites=' + (await ev('Module.strayWrites|0')));
  check('page is not showing the crash card', !/The game stopped/.test((await ev("document.getElementById('box').innerText")) || ''));
} catch (e) { console.log('ERR', e.stack || e); failed++; }
finally { cleanup(); await w(500); try { rmSync(PROF, { recursive: true, force: true }); } catch (_e) {} }
console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);

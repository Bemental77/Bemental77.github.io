#!/usr/bin/env node
// gamecube/native/tools/mp4n_capability_test.mjs — A BROWSER WITHOUT WEBGPU NEVER GETS A DEAD PAGE.
//
// mp4-native.html draws only through WebGPU. Arms (fresh profile each):
//   webgpu        SwiftShader Vulkan WebGPU: the native game starts here
//   no-adapter    navigator.gpu is an object but requestAdapter() resolves null — a blocklisted GPU
//                 (the case a presence check misses). Injected: --disable-features=WebGPUService,Dawn
//                 did NOT take WebGPU away under the Vulkan flags here (measured: native ran).
//   no-gpu-api    navigator.gpu removed before any script runs (Firefox / older Safari)
//   force         no-adapter + ?forcenative=1: the check is skipped, no redirect (the page then fails
//                 visibly in its own start(), never silently)
//   room          no-adapter + a room hand-off (?np=…&join=1): no redirect (a native room cannot be
//                 joined from the recomp engine), a note that links the lobby
// Asserted per arm: the routed arms show the note, then land on /gamecube.html with Mario Party 4
// selected; the webgpu arm runs the native game and shows no note.
//   bash tools/probe_lock.sh run -- node gamecube/native/tools/mp4n_capability_test.mjs
import { createRequire } from 'module';
import fs from 'fs'; import os from 'os'; import path from 'path'; import { spawn } from 'child_process';
const require = createRequire(process.env.PUPPETEER_FROM || (process.env.HOME + '/probe-deps/'));
const puppeteer = require('puppeteer');
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
let guard = null; try { guard = (await import(path.join(REPO, 'tools/browser_leak_guard.js'))).default; } catch (_e) {}
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const PORT = 19000 + Math.floor(Math.random() * 900);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, d) => { (c ? pass++ : fail++); console.log(`  ${c ? 'PASS' : 'FAIL'}  ${n}  ${d == null ? '' : d}`); };
const srv = spawn('node', [path.join(REPO, 'tools/devserver.mjs')], { cwd: REPO, env: Object.assign({}, process.env, { PORT: String(PORT) }), stdio: 'ignore' });
await sleep(1500);
const BASE = `http://127.0.0.1:${PORT}`;
const VK = ['--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
async function arm(name, { flags = [], noGpuApi = false, nullAdapter = false, qs = '' }, check) {
  const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'mp4cap-'));
  const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new', userDataDir: udd,
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--enable-unsafe-webgpu', ...flags] });
  try { if (guard) guard.guard(b, 'mp4n_capability_test'); } catch (_e) {}
  try {
    const p = await b.newPage();
    const errs = []; p.on('pageerror', (e) => errs.push(String(e.message)));
    if (nullAdapter) await p.evaluateOnNewDocument(() => { try { GPU.prototype.requestAdapter = function () { return Promise.resolve(null); }; } catch (e) {} });
    if (noGpuApi) await p.evaluateOnNewDocument(() => { try { Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined, configurable: true }); } catch (e) {} });
    await p.goto(`${BASE}/mp4-native.html?autostart=1${qs}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await check(p, errs);
  } catch (e) { ok(name + '-harness', false, (e && e.stack) || e); }
  finally { try { await b.close(); } catch (_e) {} fs.rmSync(udd, { recursive: true, force: true }); }
}
const noteOf = (p) => p.evaluate(() => { const n = document.getElementById('capNote'); return n && !n.hidden ? n.textContent.replace(/\s+/g, ' ').trim() : null; }).catch(() => null);
const landed = (p, ms) => p.waitForFunction(() => /\/gamecube\.html$/.test(location.pathname), { timeout: ms, polling: 250 }).then(() => true).catch(() => false);

await arm('webgpu', { flags: VK }, async (p, errs) => {
  const ran = await p.waitForFunction(() => { const m = window.__mp4n && window.__mp4n.module; return m && m._mp4web_total() > 30; }, { timeout: 240000, polling: 500 }).then(() => true).catch(() => false);
  ok('webgpu-runs-native', ran && !(await noteOf(p)), `ran=${ran} cap=${JSON.stringify(await p.evaluate(() => window.__mp4n && window.__mp4n.cap))} path=${await p.evaluate(() => location.pathname)}`);
});
for (const [name, opt] of [['no-adapter', { flags: VK, nullAdapter: true }], ['no-gpu-api', { flags: VK, noGpuApi: true }]]) {
  await arm(name, opt, async (p, errs) => {
    await p.waitForFunction(() => { const n = document.getElementById('capNote'); return n && !n.hidden; }, { timeout: 20000, polling: 200 }).catch(() => {});
    const note = await noteOf(p);
    const went = await landed(p, 20000);
    // gamecube.html reloads itself once (coi-serviceworker), so every read here survives a navigation
    const retry = async (f) => { for (let i = 0; i < 20; i++) { try { const v = await f(); if (v != null) return v; } catch (e) {} await sleep(1000); } return null; };
    const rom = went ? await retry(() => p.evaluate(() => localStorage.getItem('gcwasm_romIdx'))) : null;
    const sel = went ? await retry(() => p.evaluate(() => { const s = document.getElementById('romSelect'); return s && s.options.length ? s.options[s.selectedIndex].textContent : null; })) : null;
    ok(`${name}-told-then-routed-to-gamecube-mp4`, !!note && went && rom === '0' && sel === 'Mario Party 4', `note="${(note || '').slice(0, 150)}" landed=${went} romIdx=${rom} selected=${sel}`);
  });
}
await arm('force', { flags: VK, nullAdapter: true, qs: '&forcenative=1' }, async (p) => {
  await sleep(9000);
  const path_ = await p.evaluate(() => location.pathname);
  ok('forcenative-stays', path_ === '/mp4-native.html' && !(await noteOf(p)), `path=${path_} phase=${await p.evaluate(() => window.__mp4n && window.__mp4n.phase)}`);
});
await arm('room', { flags: VK, nullAdapter: true, qs: '&np=ABCDE&join=1&net=local' }, async (p) => {
  await p.waitForFunction(() => { const n = document.getElementById('capNote'); return n && !n.hidden; }, { timeout: 20000, polling: 200 }).catch(() => {});
  await sleep(6000);
  const note = await noteOf(p), path_ = await p.evaluate(() => location.pathname);
  const lobby = await p.evaluate(() => !!document.querySelector('#capNote a[href="/multiplayer.html"]'));
  ok('room-explains-and-links-the-lobby', !!note && path_ === '/mp4-native.html' && lobby, `path=${path_} lobbyLink=${lobby} note="${(note || '').slice(0, 150)}"`);
});
srv.kill();
console.log(`\n[mp4n-capability] ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);

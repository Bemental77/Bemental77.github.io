#!/usr/bin/env node
// tools/gc_np_handoff_test.mjs — gamecube.html's ?np=<code>&game=<label>[&join=1]
// receiver, the hand-off multiplayer.html sends a GameCube party through.
//
//   node tools/browser_leak_guard.js reap && uptime
//   npm run web                    # port 8080 — the only server (gate #2)
//   node tools/gc_np_handoff_test.mjs
//
// Originally a smoke for the gamecube.html ?np= receiver. Launch pattern copied from
// tools/netplay_ui_test.mjs; browser registered with tools/browser_leak_guard.js
// the way tools/device_matrix.mjs does. puppeteer resolves from the tools/ dir
// (it lives in /Users/caseybement/node_modules, not the repo), hence createRequire.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(REPO + '/tools/_anchor.js');
const puppeteer = require('puppeteer');
const guard = require(REPO + '/tools/browser_leak_guard.js');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ORIGIN = process.env.ORIGIN || 'http://localhost:8080';
const res = [];
const ok = (n, d) => { res.push(1); console.log(`  PASS  ${n}  ${d}`); };
const bad = (n, d) => { res.push(0); console.log(`  FAIL  ${n}  ${d}`); };

const b = await puppeteer.launch({ headless: 'new', executablePath: CHROME, args: ['--no-sandbox'] });
guard.guard(b, 'gc_np_handoff_test');

// coi-serviceworker reloads the page once on first visit; poll and tolerate the
// context teardown rather than racing it (CLAUDE.md / device_matrix note).
const snapshot = (p) => p.evaluate(() => {
  const s = window.NetplayUI && window.NetplayUI.session;
  return {
    handoff: window.__gcNetHandoff === undefined ? 'undefined' : window.__gcNetHandoff,
    romSel: (document.getElementById('romSelect') || {}).value,
    mobileSel: (document.getElementById('mobileRomSelect') || {}).value,
    saved: localStorage.getItem('gcwasm_romIdx'),
    hasUI: !!window.NetplayUI,
    session: !!s,
    state: s ? s.state : null,
    host: s ? s.isHost : null,
    code: s ? s.code : null,
    game: s ? s.game : null,
    panelOpen: !!document.querySelector('.np-wrap.open'),
    codeBox: (document.querySelector('.np-code') || {}).textContent,
    inputVal: (document.querySelector('.np-in') || {}).value,
    joinOn: (() => { const r = document.querySelectorAll('.np-row button'); return r.length ? r[1].classList.contains('on') : null; })(),
    coi: crossOriginIsolated,
  };
});
async function visit(url, done, maxIter = 160) {
  const p = await b.newPage();
  const logs = [];
  p.on('console', (m) => { const t = m.text(); if (/gc-lockstep/.test(t)) logs.push(t); });
  await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  let s = null;
  for (let i = 0; i < maxIter; i++) {
    try { s = await snapshot(p); } catch (e) { s = { err: String(e).slice(0, 90) }; }
    if (s && !s.err && done(s)) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  await p.close(); return { s, logs };
}

// ---- ARM 1 (the mandated one): host hand-off ------------------------------
{
  const url = ORIGIN + '/gamecube.html?np=ABCDE&game=Mario%20Party%204&net=local';
  const { s, logs } = await visit(url, (x) => x.session && x.state && x.state !== 'idle');
  console.log('[arm host] ' + JSON.stringify(s));
  console.log('[arm host] console: ' + JSON.stringify(logs));
  s.handoff && s.handoff.code === 'ABCDE' ? ok('host/handoff-code', `__gcNetHandoff.code=${s.handoff.code}`) : bad('host/handoff-code', JSON.stringify(s.handoff));
  s.romSel === '0' ? ok('host/rom-select', `romSelect.value=${s.romSel} mobile=${s.mobileSel} saved=${s.saved}`) : bad('host/rom-select', `romSelect.value=${s.romSel}`);
  s.handoff && s.handoff.romIdx === 0 && s.handoff.join === false ? ok('host/handoff-fields', JSON.stringify(s.handoff)) : bad('host/handoff-fields', JSON.stringify(s.handoff));
  s.session && s.state && s.state !== 'idle' ? ok('host/session-state', `state=${s.state} host=${s.host} code=${s.code} game=${s.game}`) : bad('host/session-state', JSON.stringify(s));
  s.codeBox === 'ABCDE' && s.panelOpen ? ok('host/panel-shows-this-code', `codeBox=${s.codeBox} panelOpen=${s.panelOpen}`) : bad('host/panel-shows-this-code', `codeBox=${s.codeBox} panelOpen=${s.panelOpen}`);
}
// ---- ARM 2: joiner hand-off --------------------------------------------------
{
  const url = ORIGIN + '/gamecube.html?np=ABCDE&game=Mario%20Party%204&join=1&net=local';
  const { s, logs } = await visit(url, (x) => x.session && x.state && x.state !== 'idle');
  console.log('[arm join] ' + JSON.stringify(s));
  console.log('[arm join] console: ' + JSON.stringify(logs));
  s.handoff && s.handoff.join === true && s.session && s.host === false && s.joinOn === true && s.inputVal === 'ABCDE'
    ? ok('join/guest-side', `state=${s.state} host=${s.host} joinOn=${s.joinOn} input=${s.inputVal}`)
    : bad('join/guest-side', JSON.stringify(s));
}
// ---- ARM 3: a game not on this page -------------------------------------------
{
  const url = ORIGIN + '/gamecube.html?np=ABCDE&game=Gauntlet%20Legends&net=local';
  const { s, logs } = await visit(url, (x) => x.session && x.state && x.state !== 'idle');
  console.log('[arm unknown] ' + JSON.stringify(s));
  console.log('[arm unknown] console: ' + JSON.stringify(logs));
  s.handoff && s.handoff.romIdx === -1 && s.session && logs.some((l) => /not on this page/.test(l))
    ? ok('unknown-game/still-mounts-and-says-so', `romIdx=${s.handoff.romIdx} state=${s.state}`)
    : bad('unknown-game/still-mounts-and-says-so', JSON.stringify({ s, logs }));
}
// ---- ARM 4: control — no ?np= is exactly the old flow ------------------------
{
  const url = ORIGIN + '/gamecube.html?net=local';
  const { s, logs } = await visit(url, (x) => x.hasUI && x.handoff !== 'undefined', 40);
  console.log('[arm plain] ' + JSON.stringify(s));
  console.log('[arm plain] console: ' + JSON.stringify(logs));
  s.handoff === null && s.session === false && s.panelOpen === false
    ? ok('plain/unchanged', `handoff=null session=false panelOpen=false`)
    : bad('plain/unchanged', JSON.stringify(s));
}

await b.close();
const nbad = res.filter((r) => !r).length;
console.log(`\n[gc-np-handoff] ${res.length - nbad}/${res.length} passed`);
process.exit(nbad ? 1 : 0);

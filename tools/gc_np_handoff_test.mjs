#!/usr/bin/env node
// tools/gc_np_handoff_test.mjs — gamecube.html's ?np=<code>&game=<label>[&join=1]
// receiver, the hand-off multiplayer.html sends a GameCube party through.
//
//   node tools/browser_leak_guard.js reap && uptime
//   npm run web                    # port 8080 — the only server (gate #2)
//   node tools/gc_np_handoff_test.mjs
//
// Arms 5 and 6 are the party itself on this page, with no core booting: Leave must hand
// the panel back clean, and THREE players — all Starts held by the capability layer —
// must each be pressed by the room and drawn in their roster seat.
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
    // The party seam (gamecube.html gcNetParty): the auto-declare and the auto-start are
    // asserted from data, not from a button — there is no button.
    party: (typeof window.__gcNetParty === 'function' ? window.__gcNetParty() : 'undefined'),
    label: (document.querySelector('.np-btn') || {}).textContent,
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
  // Alone in a room it was handed: nothing has declared, nothing is gated, and the button
  // says so — "Party · ABCDE · 1/N · waiting" (or "loading": the MP4 route prefetches the disc
  // at engine() entry, so the host's own seat may already read "loading N%" by the time the
  // session exists). autoStart is the contract, not a measurement.
  const P = s.party;
  (P && typeof P === 'object' && P.code === 'ABCDE' && P.autoStart === true && P.alone === true &&
   P.declared === false && P.able === false && P.seated === 1 && /^(waiting|loading)$/.test(P.state) &&
   /^Party · ABCDE · 1\/\d · (waiting|loading)$/.test(s.label))
    ? ok('host/party-seam-alone', `label="${s.label}" party=${JSON.stringify({ code: P.code, seated: P.seated, ports: P.ports, state: P.state, alone: P.alone, declared: P.declared, able: P.able })}`)
    : bad('host/party-seam-alone', JSON.stringify({ party: P, label: s.label }));
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
  // No room: the seam still answers (a rig must not have to guess whether it exists), with
  // no code and nothing seated, and the button is the bare word.
  const P = s.party;
  (P && typeof P === 'object' && P.code === null && P.seated === 0 && P.autoStart === true && s.label === 'Party')
    ? ok('plain/party-seam-idle', `label="${s.label}" party.code=null seated=0`)
    : bad('plain/party-seam-idle', JSON.stringify({ party: P, label: s.label }));
}

// ---- helpers for the pages that stay open ----------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const open = async (who) => {
  const p = await b.newPage();
  p.on('console', (m) => { const t = m.text(); if (/gc-lockstep/.test(t)) console.log(`  [${who}] ${t.slice(0, 150)}`); });
  await p.goto(ORIGIN + '/gamecube.html?net=local', { waitUntil: 'load', timeout: 60000 });
  for (let i = 0; i < 120; i++) {     // the coi-serviceworker reload tears the context down once
    try { if (await p.evaluate(() => crossOriginIsolated && !!document.querySelector('.np-btn') && !!window.__gcNetParty)) break; } catch (e) {}
    await sleep(250);
  }
  return p;
};
const until = async (p, done, iters = 60) => { let s = null; for (let i = 0; i < iters; i++) {
  try { s = await snapshot(p); } catch (e) { s = { err: String(e).slice(0, 90) }; }
  if (s && !s.err && done(s)) return s; await sleep(250); } return s; };
const rowsOf = (p) => p.evaluate(() => [...document.querySelectorAll('.np-p')].map((r) => r.textContent));
const joinWith = (p, code) => p.evaluate((c) => {
  document.querySelector('.np-btn').click();
  document.querySelectorAll('.np-row button')[1].click();
  const i = document.querySelector('.np-in'); i.value = c; i.dispatchEvent(new Event('change'));
}, code);
const allowOn = async (host) => { for (let i = 0; i < 160; i++) {
  if (await host.evaluate(() => { const x = document.getElementById('npApproveAllow'); if (x) { x.click(); return true; } return false; })) return true;
  await sleep(250); } return false; };

// ---- ARM 5: Leave hands the panel back CLEAN ----------------------------------------
// ⚠ MEASURED 2026-09-13: GCROOM.session was never cleared on Leave, and the page's 1 s tick
// re-pushed the closed room's rows — "host (you) connecting" under a button reading "Party",
// with __gcNetParty() still naming the code. The one control is LIVE status; a room that
// was left has to be gone from the button, the rows and the seam alike.
{
  const p = await open('leave');
  await p.evaluate(() => document.querySelector('.np-btn').click());
  const before = await until(p, (x) => x.session && /^Party · [A-HJ-NP-Z2-9]{5} · 1\/\d · (waiting|loading)$/.test(x.label));
  const leaveIdx = await p.evaluate(() => [...document.querySelectorAll('.np-act button')].findIndex((x) => /^Leave/.test(x.textContent) && x.style.display !== 'none'));
  (before && before.session && leaveIdx >= 0)
    ? ok('leave/room-open', `label="${before.label}" Leave offered at .np-act[${leaveIdx}]`)
    : bad('leave/room-open', JSON.stringify({ before, leaveIdx }));
  await p.evaluate((k) => document.querySelectorAll('.np-act button')[k].click(), leaveIdx);
  await sleep(2600);                 // past the page's 1 s tick, more than once
  const after = await snapshot(p);
  const dom = await rowsOf(p);
  const P = after.party;
  (after.label === 'Party' && after.session === false && P && P.code === null && P.seated === 0 &&
   P.rows.every((r) => r.state === 'open') && dom.every((t) => /open$/.test(t)))
    ? ok('leave/resets-panel-and-seam', `label="${after.label}" session=${after.session} party.code=${P && P.code} seated=${P && P.seated} rows=${JSON.stringify(dom)}`)
    : bad('leave/resets-panel-and-seam', JSON.stringify({ label: after.label, session: after.session, party: P, dom }));
  await p.close();
}
// ---- ARM 6: THREE PLAYERS, every Start held ---------------------------------------------
// The capability hold (aria-disabled — lib/capability.js's mark) keeps every core from
// booting, which makes this cheap AND is exactly what proves the room pressed Start on each
// console: gcNetPressStart records the hold sentence in party.held only when it was asked to
// press. ⚠ MEASURED 2026-09-13: the third joiner's onReady NEVER fired ('__start__' rides one
// DataChannel), and the host read "2/4" over a port-2 row of "open" with three people in.
{
  const host = await open('host'), g1 = await open('guest1'), g2 = await open('guest2');
  for (const p of [host, g1, g2]) await p.evaluate(() => {
    const s = document.getElementById('btnStart');
    s.setAttribute('aria-disabled', 'true'); s.setAttribute('data-cap-blocked', 'rig-hold');
  });
  await host.evaluate(() => document.querySelector('.np-btn').click());
  const opened = await until(host, (x) => x.session && x.code);
  const code = opened && opened.code;
  await joinWith(g1, code);
  const a1 = await allowOn(host);
  const G1 = await until(g1, (x) => x.party && x.party.held != null);
  await joinWith(g2, code);
  const a2 = await allowOn(host);
  const G2 = await until(g2, (x) => x.party && x.party.held != null);
  const H = await until(host, (x) => x.party && /3\/\d/.test(x.label) && x.party.held != null);
  const started = await Promise.all([host, g1, g2].map((p) => p.evaluate(() => !!window.__gcStartedAtMs)));
  console.log('[arm three] host ' + JSON.stringify({ label: H && H.label, party: H && H.party }));
  console.log('[arm three] g1 ' + JSON.stringify({ label: G1 && G1.label, rows: G1 && G1.party && G1.party.rows }));
  console.log('[arm three] g2 ' + JSON.stringify({ label: G2 && G2.label, rows: G2 && G2.party && G2.party.rows }));
  const heldOn = (s) => !!(s && s.party && /is held/.test(s.party.held || ''));
  (a1 && a2 && heldOn(H) && heldOn(G1) && heldOn(G2) && !started.some(Boolean))
    ? ok('three/room-pressed-start-on-all-three', `party.held on host, guest1 AND guest2 with no click; no core booted (started=${JSON.stringify(started)})`)
    : bad('three/room-pressed-start-on-all-three', JSON.stringify({ a1, a2, host: H && H.party && H.party.held, g1: G1 && G1.party && G1.party.held, g2: G2 && G2.party && G2.party.held, started }));
  const hr = (H && H.party && H.party.rows) || [];
  (H && new RegExp(`^Party · ${code} · 3/\\d · waiting$`).test(H.label) && H.party.seated === 3 && H.party.alone === false &&
   hr[0] && hr[0].who === 'host (you)' && hr[1] && hr[1].who === 'player' && hr[1].state !== 'open' &&
   hr[2] && hr[2].who === 'player' && hr[2].state !== 'open' && hr[3] && hr[3].state === 'open')
    ? ok('three/host-counts-three-from-the-roster', `label="${H.label}" rows=${JSON.stringify(hr.map((r) => r.who + ': ' + r.state))}`)
    : bad('three/host-counts-three-from-the-roster', JSON.stringify({ label: H && H.label, rows: hr }));
  // Each guest's "(you)" sits at its ROSTER port — the third player in the third seat.
  const you = (s) => (s && s.party ? s.party.rows.findIndex((r) => /\(you\)/.test(r.who)) : -1);
  const seatAt = (p, port) => until(p, (x) => you(x) === port, 40);
  const S1 = await seatAt(g1, 1), S2 = await seatAt(g2, 2);
  const nonce = /[0-9a-f]{16}/;
  (you(S1) === 1 && you(S2) === 2 && S2.party.seated === 3 &&
   !S1.party.rows.some((r) => nonce.test(r.who)) && !S2.party.rows.some((r) => nonce.test(r.who)))
    ? ok('three/each-guest-in-its-roster-seat', `guest1 (you) at port ${you(S1)}, guest2 (you) at port ${you(S2)}; guest2 counts ${S2.party.seated} seated, no nonce`)
    : bad('three/each-guest-in-its-roster-seat', JSON.stringify({ g1: S1 && S1.party && S1.party.rows, g2: S2 && S2.party && S2.party.rows }));
  await host.close(); await g1.close(); await g2.close();
}

await b.close();
const nbad = res.filter((r) => !r).length;
console.log(`\n[gc-np-handoff] ${res.length - nbad}/${res.length} passed`);
process.exit(nbad ? 1 : 0);

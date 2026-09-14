#!/usr/bin/env node
// THE PARTY: players pair and see each other BEFORE any game loads, and the
// room STARTS BY ITSELF — nobody clicks Start, nobody clicks "I'm ready" — on
// EVERY console, a third joiner included.
// Uses the same-browser transport so this is deterministic and needs no broker;
// the cross-device transport is exercised separately.
//
//   node tools/browser_leak_guard.js reap && uptime
//   npm run web                    # port 8080 — the only server (gate #2)
//   bash tools/probe_lock.sh run -- node tools/netplay_ui_test.mjs
import puppeteer from 'puppeteer';
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ORIGIN = process.env.ORIGIN || 'http://localhost:8080';
const res = [];
const ok = (n,d)=>{res.push(1);console.log(`  PASS  ${n}  ${d}`)};
const bad = (n,d)=>{res.push(0);console.log(`  FAIL  ${n}  ${d}`)};
const b = await puppeteer.launch({ headless:'new', executablePath:CHROME, args:['--no-sandbox'] });
const mk = async () => { const p = await b.newPage();
  await p.goto(ORIGIN + '/contact.html', { waitUntil:'domcontentloaded', timeout:60000 });
  await p.addScriptTag({ url: ORIGIN + '/lib/netplay.js' });
  await p.addScriptTag({ url: ORIGIN + '/lib/netplay-ui.js' });
  await p.waitForFunction(()=>window.Netplay&&window.NetplayUI,{timeout:20000});
  return p; };
const host = await mk(), guest = await mk();
// The row vocabulary, verbatim (lib/netplay-ui.js). A row may carry nothing else.
const VOCAB = /^(open|connecting|loading \d+%|loaded|ready|playing|disconnected)$/;

const mount = (p) => p.evaluate(() => {
  window.__ready = null;
  window.__ui = NetplayUI.mount({ game:'gauntlet', transport:'local',
    onReady: (s, role) => { window.__ready = role; } });
  return { supported: window.__ui.supported, hasButton: !!document.querySelector('.np-btn'),
           label: (document.querySelector('.np-btn') || {}).textContent };
});
const m = await mount(host); await mount(guest);
(m.supported && m.hasButton && m.label === 'Party')
  ? ok('button-appears', `a single shared control labelled "${m.label}", gated on Netplay.supported()`)
  : bad('button-appears', JSON.stringify(m));

// unsupported browser -> render NOTHING rather than a dead control
const dead = await host.evaluate(() => {
  const real = Netplay.supported; Netplay.supported = () => false;
  const r = NetplayUI.mount({ game:'x' });
  Netplay.supported = real;
  return r.supported;
});
dead === false ? ok('hides-when-unsupported','no button on a browser that cannot do it')
               : bad('hides-when-unsupported', String(dead));

// host opens the panel: a code is generated and the party shows one player in
await host.evaluate(() => document.querySelector('.np-btn').click());
await new Promise(r=>setTimeout(r,400));
const code = await host.evaluate(() => document.querySelector('.np-code').textContent.trim());
/^[A-HJ-NP-Z2-9]{5}$/.test(code) ? ok('host-gets-code', `"${code}" shown before any game loads`)
                                 : bad('host-gets-code', code);
const waiting = await host.evaluate(() => document.querySelectorAll('.np-p')[1].querySelector('.np-dot').className);
waiting.includes('wait') ? ok('shows-waiting-state','second seat is pulsing "open"')
                         : bad('shows-waiting-state', waiting);

// ⚠ A HOST ALONE NEVER STARTS. The old panel could not either — its Start stayed
// disabled — but now that nothing is clicked, "did not start" has to be asserted
// rather than assumed: the label reads waiting, party() counts one seat, and
// onReady has not fired.
const alone = await host.evaluate(() => ({ ready: window.__ready, party: window.__ui.party(),
  label: document.querySelector('.np-btn').textContent }));
(alone.ready === null && alone.party.seated === 1 && alone.party.state === 'waiting' &&
 new RegExp(`^Party · ${code} · 1/\\d · waiting$`).test(alone.label))
  ? ok('host-alone-never-starts', `label "${alone.label}", onReady not fired`)
  : bad('host-alone-never-starts', JSON.stringify(alone));

// guest joins with that code
await guest.evaluate((c) => {
  document.querySelector('.np-btn').click();
  document.querySelectorAll('.np-row button')[1].click();     // Join
  const i = document.querySelector('.np-in'); i.value = c;
  i.dispatchEvent(new Event('change'));
}, code);

// ⚠ THE HOST IS ASKED FIRST. Since docs/audit-2026-09-08.md, an inbound peer is
// held with no media, no input and no save until a human allows it. The lobby
// does not draw its own dialog, so lib/netplay.js's built-in one appears on the
// host page — and clicking it is now part of the flow this suite covers.
const prompt = await (async () => { for (let i=0;i<100;i++){
  const s = await host.evaluate(() => { const p = document.getElementById('npApprove');
    return p ? { sas: document.getElementById('npApproveSas').getAttribute('data-sas'),
                 allow: !!document.getElementById('npApproveAllow') } : null; });
  if (s) return s; await new Promise(r=>setTimeout(r,200)); } return null; })();
prompt && prompt.allow
  ? ok('host-is-asked-before-anything-flows', `Allow/Deny raised on the host with confirmation code ${prompt.sas}`)
  : bad('host-is-asked-before-anything-flows', 'no approval dialog appeared — a guesser would have been let straight in');
const beforeAllow = await host.evaluate(() => NetplayUI.session.admission());
(beforeAllow.approved === false && beforeAllow.offered === false)
  ? ok('no-offer-before-allow', 'the host has not created an SDP offer yet — the tracks have not left the page')
  : bad('no-offer-before-allow', JSON.stringify(beforeAllow));
await host.evaluate(() => document.getElementById('npApproveAllow').click());

// the PEER's row: the host sees the player in seat 1, the guest sees the host in seat 0
const settled = async (p, idx) => { for (let i=0;i<80;i++){
  const s = await p.evaluate((k)=>document.querySelectorAll('.np-p')[k].querySelector('.np-dot').className, idx);
  if (s.includes('on')) return true; await new Promise(r=>setTimeout(r,200)); } return false; };
const [hOn,gOn] = [await settled(host, 1), await settled(guest, 0)];
(hOn&&gOn) ? ok('both-see-each-other-live','both parties show the other seat lit green')
           : bad('both-see-each-other-live', `host=${hOn} guest=${gOn}`);
const rowsOf = (p) => p.evaluate(() => [...document.querySelectorAll('.np-p')].map((r) => r.textContent));
const [hRows, gRows] = await Promise.all([rowsOf(host), rowsOf(guest)]);
// ⚠ NEVER A NONCE. Peers are "host" and "player"; dreamcast's HUD once printed a
// 16-hex stableNonce as a player's name, and nobody can act on that.
const nonce = /[0-9a-f]{16}/;
(/^host \(you\)/.test(hRows[0]) && /^player/.test(hRows[1]) && /^host/.test(gRows[0]) && /^player \(you\)/.test(gRows[1]) &&
 !hRows.some((t) => nonce.test(t)) && !gRows.some((t) => nonce.test(t)))
  ? ok('roles-named', `host sees ${JSON.stringify(hRows)}, guest sees ${JSON.stringify(gRows)}`)
  : bad('roles-named', JSON.stringify({ hRows, gRows }));

// ⚠ NO START, NO READY — on either side. A control that does nothing must not
// exist, and the one that did something now happens by itself.
const acts = await Promise.all([
  host.evaluate(()=>[...document.querySelectorAll('.np-act button')].map((b)=>b.textContent)),
  guest.evaluate(()=>[...document.querySelectorAll('.np-act button')].map((b)=>b.textContent))]);
(!acts.flat().some((t) => /start|ready|play/i.test(t)))
  ? ok('no-start-control', `panel buttons are ${JSON.stringify(acts[0])} / ${JSON.stringify(acts[1])}`)
  : bad('no-start-control', JSON.stringify(acts));

// THE ROOM STARTS BY ITSELF: nothing is clicked from here on, and BOTH pages
// are handed a live session with their role.
const roles = await (async () => { for (let i=0;i<50;i++){
  const r = await Promise.all([host.evaluate(()=>window.__ready), guest.evaluate(()=>window.__ready)]);
  if (r[0] && r[1]) return r; await new Promise(r=>setTimeout(r,200)); }
  return await Promise.all([host.evaluate(()=>window.__ready), guest.evaluate(()=>window.__ready)]); })();
(roles[0]==='host' && roles[1]==='guest')
  ? ok('start-takes-both-in', `onReady fired as ${JSON.stringify(roles)} with no click — the guest is not left behind`)
  : bad('start-takes-both-in', JSON.stringify(roles));

// THE BUTTON IS THE STATUS: code · seated/ports · state, live, and every row in the vocabulary.
const live = await host.evaluate(() => ({ label: document.querySelector('.np-btn').textContent, party: window.__ui.party() }));
(new RegExp(`^Party · ${code} · 2/\\d · starting$`).test(live.label) && live.party.seated === 2 &&
 live.party.state === 'starting' && live.party.rows.every((r) => VOCAB.test(r.state)))
  ? ok('button-is-live-status', `"${live.label}", rows ${JSON.stringify(live.party.rows.map((r) => r.who + ': ' + r.state))}`)
  : bad('button-is-live-status', JSON.stringify(live));

// ⚠ A THIRD PLAYER STARTS TOO — WITHOUT '__start__'. That message rides ONE
// DataChannel (lib/netplay.js sendSync → this._dc, the first open channel), so a
// third joiner never received it and a 3-4 player room could never start by
// itself. Each console now starts on its OWN 'connected'; proven on a third page
// whose session is watched for '__start__': onReady fires and the message never came.
const third = await mk(); await mount(third);
await third.evaluate((c) => {
  document.querySelector('.np-btn').click();
  document.querySelectorAll('.np-row button')[1].click();
  const i = document.querySelector('.np-in'); i.value = c; i.dispatchEvent(new Event('change'));
  window.__gotStart = false;
  NetplayUI.session.on('sync', (m) => { if (m && m.payload === '__start__') window.__gotStart = true; });
}, code);
const allow2 = await (async () => { for (let i=0;i<100;i++){
  if (await host.evaluate(() => { const a = document.getElementById('npApproveAllow'); if (a) { a.click(); return true; } return false; })) return true;
  await new Promise(r=>setTimeout(r,200)); } return false; })();
const thirdState = () => third.evaluate(() => ({ ready: window.__ready, gotStart: window.__gotStart }));
const thirdReady = await (async () => { for (let i=0;i<75;i++){
  const s = await thirdState(); if (s.ready) return s; await new Promise(r=>setTimeout(r,200)); }
  return await thirdState(); })();
(allow2 && thirdReady.ready === 'guest' && thirdReady.gotStart === false)
  ? ok('third-starts-by-itself', `onReady fired as "guest" on the third page with no click and no '__start__' received (gotStart=${thirdReady.gotStart})`)
  : bad('third-starts-by-itself', JSON.stringify({ allow2, ...thirdReady }));
// THE ROSTER, NOT A GUESS: the host counts three, and the third player is in the
// THIRD seat on its own screen — seats go in order of admission (lib/netplay.js _onPeerUp).
const labelOf = (p) => p.evaluate(() => document.querySelector('.np-btn').textContent);
const seated3 = await (async () => { let s; for (let i=0;i<50;i++){
  s = { host: await labelOf(host), rows: await rowsOf(third) };
  if (/3\/\d/.test(s.host) && /^player \(you\)/.test(s.rows[2] || '')) return s;
  await new Promise(r=>setTimeout(r,200)); } return s; })();
(new RegExp(`^Party · ${code} · 3/\\d · starting$`).test(seated3.host) && /^player \(you\)/.test(seated3.rows[2] || '') &&
 !seated3.rows.some((t) => nonce.test(t)))
  ? ok('third-seat-is-the-third-row', `host "${seated3.host}", third page sees ${JSON.stringify(seated3.rows)}`)
  : bad('third-seat-is-the-third-row', JSON.stringify(seated3));

await b.close();
const nbad = res.filter(r=>!r).length;
console.log(`\n[netplay-ui] ${res.length-nbad}/${res.length} passed`);
process.exit(nbad?1:0);

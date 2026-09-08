#!/usr/bin/env node
// The PRE-PARTY: two players pair and see each other BEFORE any game loads.
// Uses the same-browser transport so this is deterministic and needs no broker;
// the cross-device transport is exercised separately.
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

const mount = (p) => p.evaluate(() => {
  window.__ready = null;
  window.__ui = NetplayUI.mount({ game:'gauntlet', transport:'local',
    onReady: (s, role) => { window.__ready = role; } });
  return { supported: window.__ui.supported, hasButton: !!document.querySelector('.np-btn') };
});
const m = await mount(host); await mount(guest);
m.supported && m.hasButton ? ok('button-appears','a single shared control, gated on Netplay.supported()')
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
waiting.includes('wait') ? ok('shows-waiting-state','second slot is pulsing "waiting"')
                         : bad('shows-waiting-state', waiting);

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

const settled = async (p) => { for (let i=0;i<80;i++){
  const s = await p.evaluate(()=>document.querySelectorAll('.np-p')[1].querySelector('.np-dot').className);
  if (s.includes('on')) return true; await new Promise(r=>setTimeout(r,200)); } return false; };
const [hOn,gOn] = [await settled(host), await settled(guest)];
(hOn&&gOn) ? ok('both-see-each-other-live','both parties show a green connected dot')
           : bad('both-see-each-other-live', `host=${hOn} guest=${gOn}`);
const labels = await Promise.all([
  host.evaluate(()=>document.querySelectorAll('.np-p')[1].textContent),
  guest.evaluate(()=>document.querySelectorAll('.np-p')[1].textContent)]);
(/Player 2/.test(labels[0]) && /Host/.test(labels[1]))
  ? ok('roles-named', `host sees "${labels[0]}", guest sees "${labels[1]}"`)
  : bad('roles-named', JSON.stringify(labels));

// only the host may start — the guest has no emulator to start
const btns = await Promise.all([
  host.evaluate(()=>document.querySelector('.np-act button').disabled),
  guest.evaluate(()=>document.querySelector('.np-act button').disabled)]);
(btns[0]===false && btns[1]===true) ? ok('only-host-can-start','guest Start stays disabled')
                                     : bad('only-host-can-start', JSON.stringify(btns));

// host starts -> BOTH pages are handed a live session with their role
await host.evaluate(()=>document.querySelector('.np-act button').click());
await new Promise(r=>setTimeout(r,900));
const roles = await Promise.all([host.evaluate(()=>window.__ready), guest.evaluate(()=>window.__ready)]);
(roles[0]==='host' && roles[1]==='guest')
  ? ok('start-takes-both-in', `onReady fired as ${JSON.stringify(roles)} — the guest is not left behind`)
  : bad('start-takes-both-in', JSON.stringify(roles));

await b.close();
const nbad = res.filter(r=>!r).length;
console.log(`\n[netplay-ui] ${res.length-nbad}/${res.length} passed`);
process.exit(nbad?1:0);

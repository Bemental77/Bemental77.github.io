// tools/pokemonarena_online_page_test.mjs -- two real browser tabs play a networked Pokemon Arena battle through /pokemonarena/battle.html, paired with lib/netplay.js's
// same-browser transport (net=local), including the host's approval prompt, the handshake, the scene on both sides, rematch, leaving, timeouts and refusals.
//
//   node tools/pokemonarena_online_page_test.mjs            starts its own dev server (ARENA_PORT, default 8097) and one muted headless Chrome (ARENA_CDP, default 9283)
//   ARENA_OUT=<dir> for screenshots (judged by eye); ARENA_SKIP_SHOTS=1 to skip them
//
// Browsers: tools/headless_cdp.mjs only (bare CDP, throwaway profile, --mute-audio). Nothing here touches the user's browser, and nothing makes a sound.
// The two tabs share one profile, which is what makes BroadcastChannel pairing possible; a fresh browser is started for each group so no state leaks between cases.
// The "player" in each tab is the engine's own AI, installed on the scene (scene.S.auto, the same seam the battle page's own autoplay uses); everything else -
// the panel, the prompt, the handshake, the clock, the netbar, the result screen - is the page's own code.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withBrowser } from './headless_cdp.mjs';
import { loadStack } from './pokemonarena_netmatch_lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const PORT = Number(process.env.ARENA_PORT || 8097);
const CDP0 = Number(process.env.ARENA_CDP || 9283);
const OUT = process.env.ARENA_OUT || path.join(os.tmpdir(), 'arena-online-shots');
const SHOTS = process.env.ARENA_SKIP_SHOTS !== '1';
// ARENA_ORIGIN=https://caseybement.com runs the same cases against a DEPLOYED site (no local server is started); the pairing is still the same-browser transport
const ORIGIN = (process.env.ARENA_ORIGIN || `http://localhost:${PORT}`).replace(/\/+$/, '');
const REMOTE = !!process.env.ARENA_ORIGIN;
const BASE = `${ORIGIN}/pokemonarena/battle.html`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });
// TWO TABS, ONE BROWSER: whichever tab is not in front is "hidden", and Chrome throttles a hidden tab's timers to about one a second, which would make the
// background player's scene crawl and the match time out for reasons that have nothing to do with the product. Real players are on two devices.
const NO_THROTTLE = ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'];

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, detail) { if (cond) { pass++; if (process.env.ARENA_VERBOSE) console.log('ok  ', name, detail ? ':: ' + String(detail).slice(0, 140) : ''); } else { fail++; failures.push(name + (detail ? ' :: ' + detail : '')); console.log('FAIL', name, detail || ''); } }

/* ---------------------------------------------------------------------------------------------- dev server */
let server = null;
async function startServer() {
  if (REMOTE) return false;
  const probe = async () => { try { const r = await fetch(`http://localhost:${PORT}/pokemonarena/battle.html`); return r.ok; } catch (_e) { return false; } };
  if (await probe()) return false;
  server = spawn(process.execPath, [path.join(root, 'tools', 'devserver.mjs')], { env: { ...process.env, PORT: String(PORT), WEB_ROOT: root }, stdio: 'ignore', windowsHide: true });
  for (let i = 0; i < 40 && !(await probe()); i++) await sleep(250);
  return true;
}
const stopServer = () => { if (server) { try { server.kill(); } catch (_e) { /* ignore */ } server = null; } };

/* ---------------------------------------------------------------------------------------------- page helpers */
const nmStatus = (p) => p.eval('(window.__arenaOnline && window.__arenaOnline.nm() ? window.__arenaOnline.nm().status() : null)');
const phase = async (p) => { const s = await nmStatus(p); return s ? s.phase : null; };
const bar = (p) => p.eval('(() => { const b = document.getElementById("netbar"); return b ? { who: b.querySelector("#nbWho").textContent, msg: b.querySelector("#nbMsg").textContent, clock: b.querySelector("#nbClock").textContent, kind: b.dataset.kind, phase: b.dataset.phase } : null; })()');
const shot = async (p, name) => { if (SHOTS) { try { await p.screenshot(path.join(OUT, name + '.png')); } catch (_e) { /* a screenshot is evidence, not the test */ } } };

let ANIM = '&anim=0';           // the scene's move animations take real time to play; the cases that are not about them skip them (groupMatch plays one with them ON, the production default)
async function openRoom(page, room, role, extra = '') {
  await page.navigate(`${BASE}?np=${room}&${role === 'host' ? 'host=1' : 'join=1'}&net=local${ANIM}${extra}`);
  await page.waitFor('window.__arenaOnline && document.getElementById("olGo") && !document.getElementById("olGo").disabled && window.__arenaBattle && window.__arenaBattle.state === "online"', { timeoutMs: 90000 });
}
// fill the setup panel and press the button. team: 'random' | 'paste' (with code) ; fmt only matters to the host
async function fillAndGo(page, { name, team = 'random', code = '', fmt }) {
  return page.eval(`(() => {
    document.getElementById('olName').value = ${JSON.stringify(name)};
    const t = document.getElementById('olTeam'); t.value = ${JSON.stringify(team)}; t.dispatchEvent(new Event('change'));
    ${code ? `document.getElementById('olPaste').value = ${JSON.stringify(code)};` : ''}
    ${fmt ? `document.getElementById('olFmt').value = ${JSON.stringify(fmt)};` : ''}
    document.getElementById('olGo').click();
    return document.getElementById('olStatus').textContent; })()`);
}
async function approve(host, allow = true) {
  await host.waitFor('document.getElementById("npApproveAllow")', { timeoutMs: 60000 });
  await host.eval(`document.getElementById(${JSON.stringify(allow ? 'npApproveAllow' : 'npApproveDeny')}).click()`);
}
// two tabs paired and past the handshake (or failed): returns the final phases
async function pair(host, guest, room, o = {}) {
  await openRoom(host, room, 'host', o.hostExtra || '');
  await openRoom(guest, room, 'guest', o.guestExtra || '');
  await fillAndGo(host, { name: o.hostName || 'Alice', team: o.hostTeam || 'random', code: o.hostCode, fmt: o.fmt || '3v3' });
  await host.waitFor('document.getElementById("olCode").hidden === false', { timeoutMs: 30000 });      // the room is open: now a friend may knock
  await fillAndGo(guest, { name: o.guestName || 'Bob', team: o.guestTeam || 'random', code: o.guestCode });
  if (o.deny) { await approve(host, false); return; }
  await approve(host, true);
  for (let i = 0; i < 120; i++) {
    const [a, b] = [await phase(host), await phase(guest)];
    if ((a === 'playing' || a === 'failed') && (b === 'playing' || b === 'failed')) return [a, b];
    await sleep(250);
  }
  return [await phase(host), await phase(guest)];
}
// the AI plays this tab's seat until the scene reaches the result screen (or maxMs)
const DRIVE = `(async (maxMs, withAi) => {
  const H = window.__arenaBattle, O = window.__arenaOnline;
  const side = O.state.info.mySide;
  if (withAi) {
    const mod = await import('/pokemonarena/js/ai.js');
    if (window.__aiFor !== H.scene) { window.__aiFor = H.scene; const ai = mod.createAi({ pack: H.pack, level: 'normal', seed: 7 + side });
      H.scene.S.auto = { ai, decide(req) { return ai.choose(req, H.ctl.view(side), { previewInfo: { foe: H.ctl.previewInfo[side ^ 1] } }); } }; }
  }
  const t0 = performance.now();
  while (performance.now() - t0 < maxMs && H.scene.mode !== 'result') {
    H.scene.tick();
    if (H.scene.mode === 'steps' && H.scene.S.cur && H.scene.S.cur.t === 'text') H.scene.press('a');
    await new Promise((r) => setTimeout(r, 0));
  }
  return H.scene.mode;
})`;
const drive = (p, maxMs = 120000, withAi = true) => p.eval(`${DRIVE}(${maxMs}, ${withAi})`);

/* ---------------------------------------------------------------------------------------------- the cases */
async function groupMatch(S) {
  ANIM = '';
  await withBrowser({ port: CDP0, width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (host) => {
    const guest = await host.openTab({ width: 900, height: 760 });
    const room = 'AMTCH';
    const ph = await pair(host, guest, room);
    ok(ph && ph[0] === 'playing' && ph[1] === 'playing', 'M1 two tabs pair, the host allows the joiner and the handshake completes', JSON.stringify(ph));
    await host.waitFor('window.__arenaBattle.state === "ready"', { timeoutMs: 30000 });
    await guest.waitFor('window.__arenaBattle.state === "ready"', { timeoutMs: 30000 });
    ok(host.errors.length === 0 && guest.errors.length === 0, 'M2 no page errors through setup and handshake', JSON.stringify(host.errors.concat(guest.errors)).slice(0, 200));
    const info = [await host.eval('window.__arenaOnline.state.info'), await guest.eval('window.__arenaOnline.state.info')];
    ok(info[0].mySide === 0 && info[1].mySide === 1 && info[0].seed === info[1].seed && info[0].names.join('|') === info[1].names.join('|'), 'M3 host is side 0, guest side 1, one seed, one pair of names', JSON.stringify(info));
    ok(info[0].names[0] === 'Alice' && info[0].names[1] === 'Bob', 'M4 the names typed in the panels are the names in the battle', info[0].names.join('|'));
    // each side sees ITS team on the player's side and the other's as the foe
    const views = [await host.eval('window.__arenaBattle.scene.view()'), await guest.eval('window.__arenaBattle.scene.view()')];
    ok(JSON.stringify(views[0]).includes('Bob') && JSON.stringify(views[1]).includes('Alice'), 'M5 each scene names the OTHER player', '');
    await shot(host, 'M_host_preview'); await shot(guest, 'M_guest_preview');
    const b0 = await bar(host), b1 = await bar(guest);
    ok(/vs Bob/.test(b0.who) && /vs Alice/.test(b1.who), 'M6 the status bar names the opponent', JSON.stringify([b0, b1]));

    const modes = await Promise.all([drive(host, 240000), drive(guest, 240000)]);
    ok(modes[0] === 'result' && modes[1] === 'result', 'M7 both scenes play the battle to the result screen', JSON.stringify(modes));
    await sleep(400);
    const [sa, sb] = [await nmStatus(host), await nmStatus(guest)];
    ok(sa.phase === 'over' && sb.phase === 'over' && !sa.error && !sb.error, 'M8 both protocols finish, with no error', JSON.stringify([sa.phase, sb.phase, sa.error, sb.error]));
    ok(sa.result.hash === sb.result.hash && sa.result.winnerSide === sb.result.winnerSide, 'M9 the same final position and the same winner on both machines', JSON.stringify([sa.result, sb.result]));
    ok(sa.result.iWon !== sb.result.iWon || sa.result.draw, 'M10 exactly one of them won', '');
    const [ba, bb] = [await bar(host), await bar(guest)];
    const winnerBar = sa.result.iWon ? ba : bb, loserBar = sa.result.iWon ? bb : ba;
    ok(/You won/.test(winnerBar.msg) && /won\./.test(loserBar.msg), 'M11 the bars say who won', JSON.stringify([ba.msg, bb.msg]));
    ok(JSON.stringify(await host.eval('window.__arenaBattle.resultOptions')) === '["REMATCH","BACK TO HUB"]', 'M12 the result screen offers REMATCH and BACK TO HUB only', '');
    await shot(host, 'M_host_result'); await shot(guest, 'M_guest_result');
    ok(await host.eval('window.__arenaBattle.career.state') !== 'saved', 'M13 an online battle is not written into a profile', await host.eval('window.__arenaBattle.career.state'));

    // rematch: one asks, then the other
    const seed1 = info[0].seed;
    await host.eval('window.__arenaOnline.onResult("REMATCH")');
    await sleep(500);
    const waiting = await bar(host);
    ok(/Rematch requested/.test(waiting.msg), 'M14 the player who asked is told they are waiting', waiting.msg);
    const asked = await bar(guest);
    ok(/wants a rematch/.test(asked.msg), 'M15 the other player is told a rematch was asked for', asked.msg);
    await guest.eval('window.__arenaOnline.onResult("REMATCH")');
    await host.waitFor('window.__arenaBattle.mountCount === 2', { timeoutMs: 30000 });
    await guest.waitFor('window.__arenaBattle.mountCount === 2', { timeoutMs: 30000 });
    const info2 = [await host.eval('window.__arenaOnline.state.info'), await guest.eval('window.__arenaOnline.state.info')];
    ok(info2[0].mn === 2 && info2[0].seed === info2[1].seed && info2[0].seed !== seed1, 'M16 the rematch is match 2 with a fresh seed, the same on both', JSON.stringify([seed1, info2[0].seed, info2[1].seed]));
    const modes2 = await Promise.all([drive(host, 240000), drive(guest, 240000)]);
    await sleep(400);
    const [ra, rb] = [await nmStatus(host), await nmStatus(guest)];
    ok(modes2.every((m) => m === 'result') && ra.phase === 'over' && rb.phase === 'over' && ra.result.hash === rb.result.hash, 'M17 the rematch plays to the end in agreement', JSON.stringify([modes2, ra.phase, rb.phase]));
    ok(host.errors.length === 0 && guest.errors.length === 0, 'M18 no page errors through two matches', JSON.stringify(host.errors.concat(guest.errors)).slice(0, 200));
    // BACK TO HUB leaves: the other side is told
    await guest.eval('window.__arenaNavigate = (u) => { window.__left = u; }; window.__arenaOnline.onResult("BACK TO HUB")');
    await sleep(800);
    ok(await guest.eval('window.__left') === '/pokemonarena/', 'M19 BACK TO HUB goes to the hub', String(await guest.eval('window.__left')));
    const after = await bar(host);
    ok(/left/i.test(after.msg), 'M20 the other player is told their friend left', after.msg);
    await host.eval('window.__arenaOnline.onResult("REMATCH")');
    ok((await bar(host)).msg.length > 0 && (await host.eval('window.__arenaOnline.nm().status().rematch.mine')) === false, 'M21 a rematch cannot be asked for after the friend left', '');
  });
}

async function groupLeaving(S) {
  ANIM = '&anim=0';
  await withBrowser({ port: CDP0 + 1, width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (host) => {
    // a forfeit through the controller (what the pause menu's FORFEIT calls), while the other side is still choosing
    const guest = await host.openTab({ width: 900, height: 760 });
    let ph = await pair(host, guest, 'ALEAV');
    ok(ph[0] === 'playing' && ph[1] === 'playing', 'L1 pair for the forfeit case', JSON.stringify(ph));
    await host.waitFor('window.__arenaBattle.state === "ready"', { timeoutMs: 30000 });
    await guest.waitFor('window.__arenaBattle.state === "ready"', { timeoutMs: 30000 });
    // the host chooses at the team preview and waits; the guest forfeits instead
    await host.eval(`(async () => { const H = window.__arenaBattle; const mod = await import('/pokemonarena/js/ai.js'); const ai = mod.createAi({ pack: H.pack, level: 'normal', seed: 3 });
      const req = H.ctl.pending(0); const c = ai.choose(req, H.ctl.view(0), { previewInfo: { foe: H.ctl.previewInfo[1] } }); return H.ctl.submit(0, c).ok; })()`);
    await sleep(300);
    const r = await guest.eval('window.__arenaBattle.ctl.submit(1, { kind: "forfeit" }).ok');
    ok(r === true, 'L2 a forfeit is accepted while the other player is still choosing', String(r));
    await sleep(1200);
    const [sh, sg] = [await nmStatus(host), await nmStatus(guest)];
    ok(sh.phase === 'over' && sg.phase === 'over' && sh.result.iWon && !sg.result.iWon && sh.result.reason !== 'result', 'L3 the forfeit ends the match, the host wins', JSON.stringify([sh.phase, sg.phase, sh.result, sg.result]));
    ok(!sh.error && !sg.error, 'L4 neither side calls a forfeit a desync', JSON.stringify([sh.error, sg.error]));
    await host.eval('(async () => { await window.__arenaBattle.scene.settle(); })()').catch(() => {});
    await drive(host, 20000, false);
    ok(await host.eval('window.__arenaBattle.scene.mode') === 'result', 'L5 the winner\'s scene reaches the result screen', await host.eval('window.__arenaBattle.scene.mode'));
    await shot(host, 'L_forfeit_host');
  });
  await withBrowser({ port: CDP0 + 2, width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (host) => {
    // the other player closes the page mid-battle
    const guest = await host.openTab({ width: 900, height: 760 });
    const ph = await pair(host, guest, 'ACLOS');
    ok(ph[0] === 'playing' && ph[1] === 'playing', 'L6 pair for the closed-page case', JSON.stringify(ph));
    await host.waitFor('window.__arenaBattle.state === "ready"', { timeoutMs: 30000 });
    await guest.waitFor('window.__arenaBattle.state === "ready"', { timeoutMs: 30000 });
    await guest.navigate('about:blank');
    await host.waitFor('window.__arenaOnline.nm().status().phase === "over"', { timeoutMs: 20000 }).catch(() => {});
    const st = await nmStatus(host);
    ok(st.phase === 'over' && st.result && st.result.iWon, 'L7 a closed page forfeits the match; the other player wins at once', JSON.stringify([st.phase, st.result]));
    ok(/left|forfeit/i.test((await bar(host)).msg), 'L8 and the bar says why', (await bar(host)).msg);
  });
}

async function groupTimeout(S) {
  await withBrowser({ port: CDP0 + 3, width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (host) => {
    const guest = await host.openTab({ width: 900, height: 760 });
    // a 2.5 s limit (net=local only): the guest never answers, the host's clock runs out
    const ph = await pair(host, guest, 'ATIME', { hostExtra: '&arenaturn=2500', guestExtra: '&arenaturn=2500' });
    ok(ph[0] === 'playing' && ph[1] === 'playing', 'T1 pair with a short clock', JSON.stringify(ph));
    await host.waitFor('window.__arenaBattle.state === "ready"', { timeoutMs: 30000 });
    await guest.waitFor('window.__arenaBattle.state === "ready"', { timeoutMs: 30000 });
    // the guest's screen gets to the team preview (its scene is ticked by hand: the tab is in the background) but the player never picks
    const gm = await guest.eval('(async () => { const H = window.__arenaBattle; for (let i = 0; i < 6000 && H.scene.mode !== "preview"; i++) { H.scene.tick(); if (H.scene.mode === "steps" && H.scene.S.cur && H.scene.S.cur.t === "text") H.scene.press("a"); await new Promise((r) => setTimeout(r, 0)); } return H.scene.mode; })()');
    ok(gm === 'preview', 'T1b the idle guest screen reaches the team preview', gm);
    await host.eval(`(async () => { const H = window.__arenaBattle; const mod = await import('/pokemonarena/js/ai.js'); const ai = mod.createAi({ pack: H.pack, level: 'normal', seed: 3 });
      const req = H.ctl.pending(0); const c = ai.choose(req, H.ctl.view(0), { previewInfo: { foe: H.ctl.previewInfo[1] } }); return H.ctl.submit(0, c).ok; })()`);
    await guest.waitFor('document.querySelector("#nbClock").textContent.length > 0', { timeoutMs: 5000 }).catch(() => {});
    const g0 = await bar(guest);
    // with a 2.5 s clock the "10 seconds left" announcement (which a screen reader gets instead of the per-second clock) is already due, and it takes the message line
    ok(/Your move|seconds left to choose/.test(g0.msg) && /\d:\d\d/.test(g0.clock), 'T2 the player being waited for sees their own countdown', JSON.stringify(g0));
    const ariaOk = await guest.eval('(() => { const b = document.getElementById("netbar"); return b.getAttribute("role") === "group" && document.getElementById("nbMsg").getAttribute("aria-live") === "polite" && document.getElementById("nbClock").getAttribute("aria-hidden") === "true"; })()');
    ok(ariaOk === true, 'T2b only the message is a live region: the per-second clock is hidden from screen readers', '');
    await host.waitFor('window.__arenaOnline.nm().status().phase === "over"', { timeoutMs: 30000 }).catch(() => {});
    await sleep(600);
    const [sh, sg] = [await nmStatus(host), await nmStatus(guest)];
    ok(sh.phase === 'over' && sg.phase === 'over', 'T3 the match ends when a player runs out of time', JSON.stringify([sh.phase, sg.phase]));
    ok(sh.result && sg.result && (sh.result.iWon !== sg.result.iWon), 'T4 one wins and one loses', JSON.stringify([sh.result, sg.result]));
    ok(sh.result.reason === 'timeout' || sg.result.reason === 'timeout' || sh.result.reason === 'forfeit' || sg.result.reason === 'forfeit', 'T5 and the result says it was the clock, not a normal finish', JSON.stringify([sh.result.reason, sg.result.reason]));
    ok(!sh.error && !sg.error, 'T6 no desync is reported for a timeout', JSON.stringify([sh.error, sg.error]));
    // the guest was the slow one: it should have been the one to lose
    ok(sg.result.iWon === false && sh.result.iWon === true, 'T7 the player who did not answer is the one who loses', JSON.stringify([sh.result.iWon, sg.result.iWon]));
    await shot(host, 'T_timeout_host'); await shot(guest, 'T_timeout_guest');
  });
}

async function groupRefusals(S) {
  await withBrowser({ port: CDP0 + 4, width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (host) => {
    const guest = await host.openTab({ width: 900, height: 760 });
    // the host says no
    await pair(host, guest, 'ADENY', { deny: true });
    await guest.waitFor('document.getElementById("olStatus").textContent.length > 0 && !document.getElementById("olGo").disabled', { timeoutMs: 30000 }).catch(() => {});
    const st = await guest.eval('document.getElementById("olStatus").textContent');
    ok(/did not let you in|declin|denied/i.test(st), 'R1 a joiner who is refused is told so', st);
    ok(await guest.eval('!document.getElementById("olGo").disabled'), 'R2 and can try again', '');
    await shot(guest, 'R_denied');
  });
  await withBrowser({ port: CDP0 + 5, width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (host) => {
    // bad inputs never reach the network
    await host.navigate(BASE + '?np=!!&host=1&net=local');
    await host.waitFor('window.__arenaBattle && window.__arenaBattle.state === "error"', { timeoutMs: 60000 });
    ok(/room code/i.test(await host.eval('document.getElementById("errMsg").textContent')), 'R3 an invalid room code in the address is refused', await host.eval('document.getElementById("errMsg").textContent'));
    await host.navigate(BASE + '?np=ABCDE&host=1&join=1&net=local');
    await host.waitFor('window.__arenaBattle && window.__arenaBattle.state === "error"', { timeoutMs: 60000 });
    ok(/both host and join/i.test(await host.eval('document.getElementById("errMsg").textContent')), 'R4 an address that asks to host AND join is refused', '');
    await openRoom(host, 'ABAD1', 'host');
    const s1 = await fillAndGo(host, { name: 'Zed', team: 'paste', code: 'ARENA1.AAAA.0000', fmt: '3v3' });
    await sleep(600);
    const s2 = await host.eval('document.getElementById("olStatus").textContent');
    ok(s2.length > 0 && /team|code|check/i.test(s2) && !(await host.eval('document.getElementById("olCode").hidden === false')), 'R5 a team code that does not decode is refused before anything connects', s2);
    ok(await host.eval('!document.getElementById("olGo").disabled'), 'R6 and the panel stays usable', '');
    const sIn = await host.eval(`(() => { document.getElementById('olTeam').value = 'paste'; document.getElementById('olPaste').value = ''; document.getElementById('olGo').click(); return document.getElementById('olStatus').textContent; })()`);
    await sleep(300);
    ok(/Paste a team code/i.test(await host.eval('document.getElementById("olStatus").textContent')), 'R7 pasting nothing says to paste a team code', '');
    // the host's waiting screen shows the code and the invite link
    await host.eval(`(() => { document.getElementById('olTeam').value = 'random'; document.getElementById('olTeam').dispatchEvent(new Event('change')); document.getElementById('olGo').click(); })()`);
    await host.waitFor('document.getElementById("olCode").hidden === false', { timeoutMs: 20000 });
    ok(await host.eval('document.getElementById("olCode").textContent') === 'ABAD1', 'R8 the host sees the room code to give out', await host.eval('document.getElementById("olCode").textContent'));
    ok(/ABAD1/.test(await host.eval('document.getElementById("olStatus").textContent')), 'R9 and the waiting message names it', '');
    await shot(host, 'R_host_waiting');
  });
}

async function groupTeams(S) {
  const small = await S.om.randomTeamCode(S.pack, 4242, 2, 'arena-gen3-standard');
  const full = await S.om.randomTeamCode(S.pack, 4243, 6, 'arena-gen3-standard');
  await withBrowser({ port: CDP0 + 6, width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (host) => {
    // a pasted team plays, and a team too small for 3v3 is refused by name on BOTH screens
    const guest = await host.openTab({ width: 900, height: 760 });
    const ph = await pair(host, guest, 'ASMAL', { guestTeam: 'paste', guestCode: small, fmt: '3v3' });
    ok(ph[0] === 'failed' && ph[1] === 'failed', 'P1 a 2-Pokemon team cannot play 3v3: the match is refused on both sides', JSON.stringify(ph));
    const eh = await host.eval('document.getElementById("errMsg").textContent'), eg = await guest.eval('document.getElementById("errMsg").textContent');
    ok(/3 Pokemon|3v3/i.test(eh + eg), 'P2 and says why in words', eh + ' / ' + eg);
    ok(!(await host.eval('document.getElementById("error").hidden')) && !(await guest.eval('document.getElementById("error").hidden')), 'P3 both pages show the error panel', '');
    await shot(host, 'P_refused_host');
  });
  await withBrowser({ port: CDP0 + 7, width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (host) => {
    const guest = await host.openTab({ width: 900, height: 760 });
    const ph = await pair(host, guest, 'ASIX1', { hostTeam: 'paste', hostCode: full, guestTeam: 'paste', guestCode: small, fmt: '6v6' });
    ok(ph[0] === 'playing' && ph[1] === 'playing', 'P4 a 2-Pokemon team can play 6v6 against a full team (no team preview)', JSON.stringify(ph));
    await host.waitFor('window.__arenaBattle.state === "ready"', { timeoutMs: 30000 });
    await guest.waitFor('window.__arenaBattle.state === "ready"', { timeoutMs: 30000 });
    const modes = await Promise.all([drive(host), drive(guest)]);
    await sleep(400);
    const [a, b] = [await nmStatus(host), await nmStatus(guest)];
    ok(modes.every((m) => m === 'result') && a.result.hash === b.result.hash && !a.error && !b.error, 'P5 the lopsided 6v6 plays to the end in agreement', JSON.stringify([modes, a.error, b.error]));
    ok((await host.eval('window.__arenaOnline.state.fmt')) === '6v6' && (await guest.eval('window.__arenaOnline.nm().fmt')) === '6v6', 'P6 the guest uses the format the host chose', '');
  });
}

async function groupLayout(S) {
  await withBrowser({ port: CDP0 + 8, width: 390, height: 844, mobile: true, lock: false, args: NO_THROTTLE }, async (host) => {
    const guest = await host.openTab({ width: 390, height: 844, mobile: true });
    await openRoom(host, 'AMOBI', 'host');
    const overflow = await host.eval('document.documentElement.scrollWidth - document.documentElement.clientWidth');
    ok(overflow <= 0, 'V1 the setup panel does not overflow a 390 px phone', String(overflow));
    const sizes = await host.eval(`[...document.querySelectorAll('#online button, #online select, #online input, #online a.textbtn')].filter((n) => n.offsetParent !== null).map((n) => { const r = n.getBoundingClientRect(); return [n.id, Math.round(r.height), Math.round(r.width)]; })`);
    ok(sizes.length >= 4 && sizes.every(([id, h, w]) => h >= 44 && w >= 44), 'V2 every control in the panel is at least 44 css px', JSON.stringify(sizes.filter(([id, h, w]) => h < 44 || w < 44)));
    await shot(host, 'V_phone_setup');
    await openRoom(guest, 'AMOBI', 'guest');
    await fillAndGo(host, { name: 'Alice', fmt: '3v3' }); await host.waitFor('document.getElementById("olCode").hidden === false', { timeoutMs: 30000 }); await fillAndGo(guest, { name: 'Bob' });
    await approve(host, true);
    for (let i = 0; i < 80 && !((await phase(host)) === 'playing' && (await phase(guest)) === 'playing'); i++) await sleep(250);
    await host.waitFor('window.__arenaBattle.state === "ready"', { timeoutMs: 30000 }); await guest.waitFor('window.__arenaBattle.state === "ready"', { timeoutMs: 30000 });
    await sleep(500);
    const o2 = await guest.eval('document.documentElement.scrollWidth - document.documentElement.clientWidth');
    ok(o2 <= 0, 'V3 the battle with its status bar does not overflow a phone', String(o2));
    const nb = await guest.eval('(() => { const r = document.getElementById("netbar").getBoundingClientRect(); const c = window.__arenaBattle.canvas.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, w: r.width, canvasBottom: c.bottom }; })()');
    ok(nb.top >= nb.canvasBottom - 1 && nb.w <= 390, 'V4 the status bar sits under the picture and inside the screen', JSON.stringify(nb));
    await shot(guest, 'V_phone_battle');
  });
}

// the real lobby (multiplayer.html) -> real clicks -> the real battle page in two windows -> the host allows -> a match to the end
async function groupLobby(S) {
  ANIM = '&anim=0';
  await withBrowser({ port: CDP0 + 9, width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (host) => {
    const guest = await host.openTab({ width: 900, height: 760 });
    const LOBBY = `${ORIGIN}/multiplayer.html?net=local`;
    await host.navigate(LOBBY);
    await host.waitFor('window.__mpCatalog && document.querySelectorAll("#consoles button").length > 3', { timeoutMs: 60000 });
    const chip = await host.eval('(() => { const b = [...document.querySelectorAll("#consoles button")].find((x) => x.firstChild.textContent === "Pokemon Arena"); return b ? { disabled: b.disabled, text: b.textContent } : null; })()');
    ok(chip && chip.disabled === false && /1 game|2 players/.test(chip.text), 'B1 the lobby offers Pokemon Arena as a pressable console', JSON.stringify(chip));
    await host.eval('[...document.querySelectorAll("#consoles button")].find((x) => x.firstChild.textContent === "Pokemon Arena").click()');
    await host.eval('document.getElementById("btnHost").click()');
    await host.waitFor('/^[A-Z0-9]{5}$/.test(document.getElementById("code").textContent.trim())', { timeoutMs: 20000 });
    const code = (await host.eval('document.getElementById("code").textContent.trim()')).trim();
    ok(code.charAt(0) === 'A', 'B2 the lobby mints an Arena room code, tagged A', code);
    const invite = await host.eval('document.getElementById("invite").value');
    ok(invite.includes('np=' + code) && /sys=pokemonarena/.test(invite), 'B3 the invite link names the room and the console', invite);
    await host.eval('document.getElementById("btnGo").click()');
    await host.waitFor(`window.__arenaOnline && location.pathname === "/pokemonarena/battle.html" && document.getElementById("olGo") && !document.getElementById("olGo").disabled`, { timeoutMs: 90000 });
    const hu = new URL(await host.eval('location.href'));
    ok(hu.searchParams.get('np') === code && hu.searchParams.get('host') === '1' && hu.searchParams.get('net') === 'local', 'B4 "Start my console" lands on the battle page as the host, under the lobby code', hu.search);
    // the joiner: the code alone is enough, and it names the Arena
    await guest.navigate(LOBBY);
    await guest.waitFor('window.__mpCatalog && document.querySelectorAll("#consoles button").length > 3', { timeoutMs: 60000 });
    await guest.eval('document.getElementById("btnJoinPane").click()');
    await guest.eval(`(() => { const i = document.getElementById("codeIn"); i.value = ${JSON.stringify(code)}; i.dispatchEvent(new Event("input", { bubbles: true })); i.dispatchEvent(new Event("change", { bubbles: true })); })()`);
    await guest.waitFor('[...document.querySelectorAll("#jConsoles button[aria-pressed=true]")].some((b) => /Pokemon Arena/.test(b.textContent))', { timeoutMs: 10000 }).catch(() => {});
    await guest.waitFor('!document.getElementById("btnJoin").disabled', { timeoutMs: 10000 });
    const pressed = await guest.eval(`[...document.querySelectorAll("#jConsoles button[aria-pressed=true]")].map((b) => b.textContent.replace(/ ·.*$/, "").trim())`);
    ok(pressed.join() === 'Pokemon Arena', 'B5 a joiner who types only the code is taken to the Arena without being asked', JSON.stringify(pressed));
    await host.eval(`(() => { document.getElementById('olName').value = 'Hosty'; const t = document.getElementById('olTeam'); t.value = 'random'; t.dispatchEvent(new Event('change')); document.getElementById('olFmt').value = '3v3'; document.getElementById('olGo').click(); })()`);
    await host.waitFor('document.getElementById("olCode").hidden === false', { timeoutMs: 30000 });
    await guest.eval('document.getElementById("btnJoin").click()');
    await guest.waitFor(`window.__arenaOnline && location.pathname === "/pokemonarena/battle.html" && document.getElementById("olGo") && !document.getElementById("olGo").disabled`, { timeoutMs: 90000 });
    const gu = new URL(await guest.eval('location.href'));
    ok(gu.searchParams.get('np') === code && gu.searchParams.get('join') === '1', 'B6 "Join" lands on the battle page as the guest, under the same code', gu.search);
    ok(await guest.eval('document.getElementById("olRoom").value') === code && await guest.eval('document.getElementById("olFmt").closest("label").hidden') === true, 'B7 the guest panel has the code filled in and no format choice', '');
    await fillAndGo(guest, { name: 'Guesty', team: 'random' });
    await approve(host, true);
    for (let i = 0; i < 120 && !((await phase(host)) === 'playing' && (await phase(guest)) === 'playing'); i++) await sleep(250);
    ok((await phase(host)) === 'playing' && (await phase(guest)) === 'playing', 'B8 the two windows the lobby sent pair, and the handshake completes', JSON.stringify([await phase(host), await phase(guest)]));
    await host.waitFor('window.__arenaBattle.state === "ready"', { timeoutMs: 30000 }); await guest.waitFor('window.__arenaBattle.state === "ready"', { timeoutMs: 30000 });
    const modes = await Promise.all([drive(host), drive(guest)]);
    await sleep(400);
    const [a, b] = [await nmStatus(host), await nmStatus(guest)];
    ok(modes.every((m) => m === 'result') && a.result.hash === b.result.hash && !a.error && !b.error, 'B9 and they play the battle to the end in agreement', JSON.stringify([modes, a.error, b.error]));
    const nm = await host.eval('window.__arenaOnline.state.info.names');
    ok(nm.join('|') === 'Hosty|Guesty', 'B10 the names typed after the lobby are the names in the battle', nm.join('|'));
  });
}

async function groupHub() {
  const html = await (await fetch(`${ORIGIN}/pokemonarena/index.html`)).text();
  ok(/id="playFriend"[^>]*href="\/pokemonarena\/battle\.html\?online=1"/.test(html), 'H1 the hub links to online play', '');
  const bh = await (await fetch(BASE)).text();
  ok(/\/lib\/netplay\.js\?v=[0-9a-f]{8}/.test(bh), 'H2 battle.html loads the netplay engine with a version stamp', '');
}

/* ---------------------------------------------------------------------------------------------- main */
const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const started = await startServer();
const S = await loadStack();
const t0 = Date.now();
const groups = { hub: groupHub, lobby: groupLobby, match: groupMatch, leaving: groupLeaving, timeout: groupTimeout, refusals: groupRefusals, teams: groupTeams, layout: groupLayout };
let crashed = null;
try {
  for (const [name, fn] of Object.entries(groups)) {
    if (only.length && !only.includes(name)) continue;
    try { await fn(S); } catch (e) { fail++; failures.push(`group ${name} crashed :: ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}`); console.log('FAIL group', name, 'crashed:', e && e.message); }
  }
} finally { if (started) stopServer(); }
console.log(`\nonline page: ${pass} passed, ${fail} failed (${((Date.now() - t0) / 1000).toFixed(0)} s)  screenshots: ${OUT}`);
if (fail) { console.log('\nFAILURES:\n  ' + failures.join('\n  ')); process.exit(1); }

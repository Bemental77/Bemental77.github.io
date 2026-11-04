// tools/pokemonarena_online_page_test.mjs -- two real browser tabs play a networked Pokemon Arena battle through /pokemonarena/battle.html, paired with lib/netplay.js's
// same-browser transport (net=local), including the host's approval prompt, the handshake, the scene on both sides, rematch, leaving, timeouts and refusals.
//
//   node tools/pokemonarena_online_page_test.mjs            starts its own dev server (ARENA_PORT, default 8097) and one muted headless Chrome (ARENA_CDP, default 9283)
//   ARENA_OUT=<dir> for screenshots (judged by eye); ARENA_SKIP_SHOTS=1 to skip them
//   groups (name some to run a subset): profile hub lobby match leaving rejoin resume timeout refusals teams layout open openlayout presence presenceui onlineux; `profile --mutants`, `open --mutants`, `presenceui --mutants`
//   and `onlineux --mutants` also run a copy of the game with ONE defect at a time, each of which must fail the case it names.
//   EVERY CASE ID BELONGS TO ONE GROUP (checkCaseIds, ID1, reads this file): a failure is named by its id, and two groups sharing one made "B3 failed" mean either of two things.
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
const J = (x) => JSON.stringify(x);
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
async function openRoom(page, room, role, extra = '', base = BASE) {          // (base: a mutated copy of the game served by profileDesync's --mutants)
  await page.navigate(`${base}?np=${room}&${role === 'host' ? 'host=1' : 'join=1'}&net=local${ANIM}${extra}`);
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
    // (an online battle IS kept in a profile now: the profile group below proves that, F6 to F21. This group seeds no profile, so what it can show is the other half of the rule: with no profile
    // the page writes nothing and says so. It waits for that answer, because the write is asynchronous, and asserts the state exactly rather than "anything but saved".)
    await host.waitFor('(() => { const c = window.__arenaBattle && window.__arenaBattle.career; return !!c && c.state !== "idle" && c.state !== "pending"; })()', { timeoutMs: 15000 }).catch(() => {});
    ok(await host.eval('window.__arenaBattle.career.state') === 'none', 'M13 with no profile an online battle writes nothing and the career says so (state none)', await host.eval('window.__arenaBattle.career.state'));

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
    const ph = await pair(host, guest, 'ACLOS', { hostExtra: '&arenagrace=3000', guestExtra: '&arenagrace=3000' });
    ok(ph[0] === 'playing' && ph[1] === 'playing', 'L6 pair for the closed-page case', JSON.stringify(ph));
    await host.waitFor('window.__arenaBattle.state === "ready"', { timeoutMs: 30000 });
    await guest.waitFor('window.__arenaBattle.state === "ready"', { timeoutMs: 30000 });
    await guest.navigate('about:blank');
    // a closed page may be a RELOAD, so it is not a forfeit: the link drops, the other player is told and waits
    await host.waitFor('window.__arenaOnline.nm().status().link === "down"', { timeoutMs: 15000 }).catch(() => {});
    const st0 = await nmStatus(host);
    ok(st0.link === 'down' && st0.phase === 'playing', 'L7 a closed page is a dropped link first: the other player keeps the match open and is told', JSON.stringify([st0.link, st0.phase]));
    ok(/Connection lost|waiting for/i.test((await bar(host)).msg), 'L7b and the bar says they are waiting', (await bar(host)).msg);
    await host.waitFor('window.__arenaOnline.nm().status().phase === "over"', { timeoutMs: 20000 }).catch(() => {});
    const st = await nmStatus(host);
    ok(st.phase === 'over' && st.result && st.result.iWon && st.result.reason === 'lost-link', 'L8 when the player does not come back within the grace period, the other player wins', JSON.stringify([st.phase, st.result]));
  });
}

// A RELOAD (or a connection that drops) does not lose the battle. Real pages, real reloads (CDP Page.reload, which is what the browser reports as a reload).
async function groupRejoin(S) {
  ANIM = '&anim=0';
  const reload = async (page) => { await page.send('Page.reload', { ignoreCache: false }); };
  const progressTo = async (host, guest, n) => {       // both scenes play until the protocol is at least in round n
    await Promise.all([drive(host, 60000, true), drive(guest, 60000, true)].map((p) => p.catch(() => null))).catch(() => null);
  };
  // a battle that has run a few rounds, then is held (neither screen answers) so a reload lands mid-battle at a known place
  const playSome = async (host, guest, rounds) => {
    const AI = (p) => p.eval(`(async () => { const H = window.__arenaBattle, O = window.__arenaOnline; const side = O.state.info.mySide; const mod = await import('/pokemonarena/js/ai.js');
      if (window.__aiFor !== H.scene) { window.__aiFor = H.scene; const ai = mod.createAi({ pack: H.pack, level: 'normal', seed: 7 + side }); H.scene.S.auto = { ai, decide(req) { return ai.choose(req, H.ctl.view(side), { previewInfo: { foe: H.ctl.previewInfo[side ^ 1] } }); } }; }
      const t0 = performance.now();
      while (performance.now() - t0 < 60000 && O.nm().status().round < ${rounds} && H.scene.mode !== 'result') { H.scene.tick(); if (H.scene.mode === 'steps' && H.scene.S.cur && H.scene.S.cur.t === 'text') H.scene.press('a'); await new Promise((r) => setTimeout(r, 0)); }
      return O.nm().status().round; })()`);
    return Promise.all([AI(host), AI(guest)]);
  };
  const finish = async (host, guest, label) => {
    const modes = await Promise.all([drive(host, 120000), drive(guest, 120000)]);
    await sleep(500);
    const [a, b] = [await nmStatus(host), await nmStatus(guest)];
    ok(modes.every((m) => m === 'result') && a.phase === 'over' && b.phase === 'over' && a.result.hash === b.result.hash && !a.error && !b.error, label + ' the battle plays on to the end in agreement', JSON.stringify([modes, a.phase, b.phase, a.error, b.error]));
    return [a, b];
  };

  // ---- the guest reloads ----
  await withBrowser({ port: CDP0 + 10, width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (host) => {
    const guest = await host.openTab({ width: 900, height: 760 });
    const ph = await pair(host, guest, 'AREJG');
    ok(ph[0] === 'playing' && ph[1] === 'playing', 'J1 pair for the guest-reload case', JSON.stringify(ph));
    await host.waitFor('window.__arenaBattle.state === "ready"', { timeoutMs: 30000 }); await guest.waitFor('window.__arenaBattle.state === "ready"', { timeoutMs: 30000 });
    const rounds = await playSome(host, guest, 6);
    ok(rounds[0] >= 6 && rounds[1] >= 6, 'J2 a few rounds are played', JSON.stringify(rounds));
    const before = await guest.eval('({ turn: window.__arenaBattle.ctl.turn, hash: window.__arenaBattle.ctl.battle.hash(), seed: window.__arenaOnline.state.info.seed })');
    const url = new URL(await guest.eval('location.href'));
    ok(url.searchParams.get('np') === 'AREJG' && url.searchParams.get('join') === '1', 'J3 the address a reload comes back to names the room and the role', url.search);
    ok(await guest.eval('Object.keys(sessionStorage).some((k) => k.startsWith("arena.online:"))') === true, 'J3b the battle is recorded in the tab', '');
    await reload(guest);
    await guest.waitFor('window.__arenaOnline && window.__arenaBattle && window.__arenaBattle.state === "ready" && window.__arenaBattle.resume', { timeoutMs: 90000 });
    const after = await guest.eval('({ turn: window.__arenaBattle.ctl.turn, hash: window.__arenaBattle.ctl.battle.hash(), seed: window.__arenaOnline.state.info.seed, resumed: window.__arenaOnline.state.info.resumed, resume: window.__arenaBattle.resume })');
    ok(after.resumed === true && after.resume.restored === true, 'J4 the reloaded page picks the battle up (it did not start a new setup)', JSON.stringify(after.resume));
    ok(after.seed === before.seed && after.turn === before.turn && after.hash === before.hash, 'J5 and is in exactly the position it left', JSON.stringify([before, after]));
    await guest.waitFor('window.__arenaOnline.nm().status().link === "up"', { timeoutMs: 60000 });
    await host.waitFor('window.__arenaOnline.nm().status().link === "up"', { timeoutMs: 60000 });
    ok(true, 'J6 both sides report the link up again without anyone pressing anything', '');
    await shot(guest, 'J_guest_after_reload');
    const [a, b] = await finish(host, guest, 'J7');
    ok(host.errors.length === 0 && guest.errors.length === 0, 'J8 no page errors through the reload', JSON.stringify(host.errors.concat(guest.errors)).slice(0, 200));
    ok(await guest.eval('Object.keys(sessionStorage).every((k) => !k.startsWith("arena.online:"))') === true, 'J9 a finished battle leaves no record behind', '');
  });

  // ---- the host reloads (it has to let the guest in again) ----
  await withBrowser({ port: CDP0 + 11, width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (host) => {
    const guest = await host.openTab({ width: 900, height: 760 });
    const ph = await pair(host, guest, 'AREJH');
    ok(ph[0] === 'playing' && ph[1] === 'playing', 'J10 pair for the host-reload case', JSON.stringify(ph));
    await host.waitFor('window.__arenaBattle.state === "ready"', { timeoutMs: 30000 }); await guest.waitFor('window.__arenaBattle.state === "ready"', { timeoutMs: 30000 });
    await playSome(host, guest, 5);
    const before = await host.eval('({ turn: window.__arenaBattle.ctl.turn, hash: window.__arenaBattle.ctl.battle.hash() })');
    await reload(host);
    await host.waitFor('window.__arenaOnline && window.__arenaBattle && window.__arenaBattle.state === "ready" && window.__arenaBattle.resume', { timeoutMs: 90000 });
    const after = await host.eval('({ turn: window.__arenaBattle.ctl.turn, hash: window.__arenaBattle.ctl.battle.hash(), resumed: window.__arenaOnline.state.info.resumed })');
    ok(after.resumed === true && after.turn === before.turn && after.hash === before.hash, 'J11 the reloaded HOST is back in exactly the position it left', JSON.stringify([before, after]));
    // the new host session knows nobody: the guest knocks again by itself and the host is asked once
    await host.waitFor('document.getElementById("npApproveAllow")', { timeoutMs: 90000 });
    ok(true, 'J12 the returning guest knocks by itself and the host is asked to allow it', '');
    await host.eval('document.getElementById("npApproveAllow").click()');
    await host.waitFor('window.__arenaOnline.nm().status().link === "up"', { timeoutMs: 60000 });
    await guest.waitFor('window.__arenaOnline.nm().status().link === "up"', { timeoutMs: 60000 });
    const [a, b] = await finish(host, guest, 'J13');
    ok(host.errors.length === 0 && guest.errors.length === 0, 'J14 no page errors through the host reload', JSON.stringify(host.errors.concat(guest.errors)).slice(0, 200));
  });

  // ---- a connection that drops and comes back, nobody reloads ----
  await withBrowser({ port: CDP0 + 12, width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (host) => {
    const guest = await host.openTab({ width: 900, height: 760 });
    const ph = await pair(host, guest, 'AREJL');
    ok(ph[0] === 'playing' && ph[1] === 'playing', 'J15 pair for the dropped-link case', JSON.stringify(ph));
    await host.waitFor('window.__arenaBattle.state === "ready"', { timeoutMs: 30000 }); await guest.waitFor('window.__arenaBattle.state === "ready"', { timeoutMs: 30000 });
    await playSome(host, guest, 5);
    // cut the guest's peer connection under its feet
    await guest.eval('(() => { const s = window.__arenaOnline.session(); for (const L of s._links.values()) { try { L.dc && L.dc.close(); } catch (e) {} try { L.pc && L.pc.close(); } catch (e) {} } })()');
    await host.waitFor('window.__arenaOnline.nm().status().link === "down"', { timeoutMs: 20000 }).catch(() => {});
    ok(true, 'J16 the drop is noticed', '');
    await host.waitFor('window.__arenaOnline.nm().status().link === "up"', { timeoutMs: 90000 });
    await guest.waitFor('window.__arenaOnline.nm().status().link === "up"', { timeoutMs: 90000 });
    ok(true, 'J17 both sides report the link up again by themselves', '');
    const [a, b] = await finish(host, guest, 'J18');
    ok(host.errors.length === 0 && guest.errors.length === 0, 'J19 no page errors through the drop', JSON.stringify(host.errors.concat(guest.errors)).slice(0, 200));
  });

  // ---- opening the same address afresh does NOT resume (only a reload does) ----
  await withBrowser({ port: CDP0 + 13, width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (host) => {
    const guest = await host.openTab({ width: 900, height: 760 });
    const ph = await pair(host, guest, 'AREJF');
    ok(ph[0] === 'playing' && ph[1] === 'playing', 'J20 pair for the fresh-visit case', JSON.stringify(ph));
    await host.waitFor('window.__arenaBattle.state === "ready"', { timeoutMs: 30000 }); await guest.waitFor('window.__arenaBattle.state === "ready"', { timeoutMs: 30000 });
    await playSome(host, guest, 4);
    const url = await guest.eval('location.href');
    await guest.navigate('about:blank'); await guest.navigate(url);
    await guest.waitFor('window.__arenaOnline && document.getElementById("olGo") && !document.getElementById("olGo").disabled', { timeoutMs: 90000 });
    ok(await guest.eval('window.__arenaBattle.state') === 'online' && !(await guest.eval('window.__arenaBattle.resume')), 'J21 a fresh visit to the same address shows the setup form, it does not resume', await guest.eval('window.__arenaBattle.state'));
  });
}

// A battle that is RELOADED in the middle is recorded EXACTLY ONCE, under the id it had before the reload. The id is the seed, the format, the match number and the room (career_stats.onlineMatchId); Node proves that a rebuilt controller
// computes the same one (pokemonarena_netmatch_test.mjs case O) and that an id folded twice changes nothing (pokemonarena_career_test.mjs). This is the same claim in two real tabs, with a profile on each side:
// the HOST's page is reloaded in the middle of the match, the match is played to the end, and each career holds ONE online battle and it is that match.
async function groupResume(S) {
  ANIM = '&anim=0';
  const sum = (r) => r.w + r.l + r.dr + r.f;
  await withBrowser({ port: CDP0 + 38, width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (host) => {
    const guest = await host.openTab({ width: 900, height: 760 });
    await openRoom(host, 'ARSM1', 'host');
    const seeded = await host.eval(SEED_PROFILES_JS([['ALICE', [['Alice Squad', ['Pikachu', 'Charizard', 'Snorlax']]]], ['BOBBY', [['Bobby Squad', ['Blastoise', 'Gengar', 'Eevee']]]]]));
    const [pa, pb] = seeded.profiles;
    await openRoom(host, 'ARSM1', 'host'); await openRoom(guest, 'ARSM1', 'guest');          // the panels read the profiles' teams now
    await pickTeam(host, 'saved:' + pa.id + ':' + pa.teams[0]); await pickTeam(guest, 'saved:' + pb.id + ':' + pb.teams[0]);
    await host.eval('document.getElementById("olFmt").value = "3v3"; document.getElementById("olGo").click()');
    await host.waitFor('document.getElementById("olCode").hidden === false', { timeoutMs: 30000 });
    await guest.eval('document.getElementById("olGo").click()');
    await approve(host, true);
    for (let i = 0; i < 160 && !((await phase(host)) === 'playing' && (await phase(guest)) === 'playing'); i++) await sleep(250);
    const started = (await phase(host)) === 'playing' && (await phase(guest)) === 'playing';
    ok(seeded.profiles.length === 2 && !seeded.notSaved && started, 'RS1 (the rig) two saved profiles, one on each side, and the match has started', J({ profiles: seeded.profiles.length, notSaved: seeded.notSaved, host: await phase(host), guest: await phase(guest) }));
    if (!started) return;
    await host.waitFor('window.__arenaBattle.state === "ready"', { timeoutMs: 30000 }); await guest.waitFor('window.__arenaBattle.state === "ready"', { timeoutMs: 30000 });
    const id1 = matchIdOf(await host.eval('window.__arenaOnline.state.info'));
    const rounds = await Promise.all([aiRounds(host, 4), aiRounds(guest, 4)]);
    const [A0, B0] = [await host.eval(LOAD_PROFILE_JS(pa.id)), await host.eval(LOAD_PROFILE_JS(pb.id))];
    ok(rounds[0] >= 4 && rounds[1] >= 4 && (await host.eval('window.__arenaBattle.scene.mode')) !== 'result' && sum(A0.stats.byCpu.online) === 0 && sum(B0.stats.byCpu.online) === 0, 'RS2 the match is in the middle (at least 4 rounds played, no result screen) and nothing is in either career yet', J({ rounds, id1, a: A0.stats.byCpu.online, b: B0.stats.byCpu.online }));
    await host.send('Page.reload', { ignoreCache: false });
    const resumed = await host.waitFor('window.__arenaOnline && window.__arenaBattle && window.__arenaBattle.state === "ready" && window.__arenaBattle.resume', { timeoutMs: 90000 }).then(() => true, () => false);
    const after = resumed ? await host.eval('({ info: window.__arenaOnline.state.info, restored: window.__arenaBattle.resume.restored })') : null;
    ok(resumed && after.restored === true && after.info.resumed === true && matchIdOf(after.info) === id1, 'RS3 the reloaded HOST picks the match up (it did not start a new setup) and it is the same match: the same id as before the reload', J({ id1, after: after && matchIdOf(after.info), restored: after && after.restored }));
    if (!resumed) return;
    const allowed = await host.waitFor('document.getElementById("npApproveAllow")', { timeoutMs: 90000 }).then(() => true, () => false);
    ok(allowed, 'RS4 the returning guest knocks by itself and the host is asked once to allow it', '');
    if (!allowed) return;
    await host.eval('document.getElementById("npApproveAllow").click()');
    const linked = await Promise.all([host, guest].map((p) => p.waitFor('window.__arenaOnline.nm().status().link === "up"', { timeoutMs: 60000 }).then(() => true, () => false)));
    ok(linked[0] && linked[1], 'RS5 both sides report the link up again', J(linked));
    if (!(linked[0] && linked[1])) return;
    const modes = await finishMatch(host, guest, id1);
    ok(modes[0] === 'result' && modes[1] === 'result', 'RS6 the match plays on to the end after the reload', J(modes));
    const [ca, cb] = [await careerOf(host), await careerOf(guest)];
    ok(ca && cb && ca.state === 'saved' && cb.state === 'saved' && ca.matchId === id1 && cb.matchId === id1 && ca.profileId === pa.id && cb.profileId === pb.id, 'RS7 each page wrote the battle under the id the match had before the reload, into the profile that fought it', J([ca, cb]));
    const [A, B] = [await host.eval(LOAD_PROFILE_JS(pa.id)), await host.eval(LOAD_PROFILE_JS(pb.id))];
    ok(sum(A.stats.byCpu.online) === 1 && sum(B.stats.byCpu.online) === 1 && A.stats.recent.length === 1 && B.stats.recent.length === 1 && A.stats.recent[0].id === id1 && B.stats.recent[0].id === id1, 'RS8 EXACTLY ONE online battle is in each career, and it is that match (the same id on both sides)', J({ id1, a: A.stats.byCpu.online, b: B.stats.byCpu.online, ra: A.stats.recent.map((r) => r.id), rb: B.stats.recent.map((r) => r.id) }));
    await sleep(2000);
    const [A2, B2] = [await host.eval(LOAD_PROFILE_JS(pa.id)), await host.eval(LOAD_PROFILE_JS(pb.id))];
    ok(A2.rev === A.rev && B2.rev === B.rev && sum(A2.stats.byCpu.online) === 1 && sum(B2.stats.byCpu.online) === 1, 'RS9 and nothing is written a second time afterwards (the profiles\' revisions did not move)', J({ a: [A.rev, A2.rev], b: [B.rev, B2.rev] }));
    ok(host.errors.length === 0 && guest.errors.length === 0, 'RS10 no page errors through the reload', J(host.errors.concat(guest.errors)).slice(0, 200));
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
    // On a phone held upright the controls sit at the bottom of the screen and the picture runs edge to edge (screenfit.js), so the status bar sits ABOVE the picture, between the header and it
    // (it used to sit under it). What matters: it is inside the screen, it covers none of the picture and none of the touch buttons, and it is not hidden below the fold.
    const nb = await guest.eval('(() => { const r = document.getElementById("netbar").getBoundingClientRect(); const c = window.__arenaBattle.canvas.getBoundingClientRect(); const pads = [...document.querySelectorAll("#dpad .pbtn, #ab .pbtn")].map((e) => e.getBoundingClientRect()); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, w: r.width, canvasTop: c.top, canvasBottom: c.bottom, vh: innerHeight, onPads: pads.some((p) => p.left < r.right && p.right > r.left && p.top < r.bottom && p.bottom > r.top) }; })()');
    ok((nb.bottom <= nb.canvasTop + 1 || nb.top >= nb.canvasBottom - 1) && nb.w <= 390 && nb.left >= 0 && nb.right <= 390 && nb.top >= 0 && nb.bottom <= nb.vh && !nb.onPads, 'V4 the status bar is inside the screen and covers neither the picture nor a touch button', JSON.stringify(nb));
    ok(nb.bottom <= nb.canvasTop + 1, 'V4b held upright it sits above the picture, under the header', JSON.stringify(nb));
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


/* ---------------------------------------------------------------------------------------------- open games (js/openlobby.js + the panel in js/online.js) */
// the setup panel with the board on it (no role, no code in the address); openquick / openjoin shorten Find a battle's look-around and a silent game's patience (net=local only)
async function openPanel(page, extra = '') {
  await page.navigate(BASE + '?online=1&net=local' + ANIM + extra);
  await page.waitFor('window.__arenaOnline && document.getElementById("olGo") && !document.getElementById("olGo").disabled && !document.getElementById("olQuick").disabled && window.__arenaBattle && window.__arenaBattle.state === "online"', { timeoutMs: 90000 });
}
// (the name is set the way a player sets it: the page hears an `input` event, which is what makes it THEIR name - one the panel remembers - rather than one it filled in itself)
const setForm = (page, { name, fmt, pub = false, role }) => page.eval('(() => {' +
  'document.getElementById("olName").value = ' + JSON.stringify(name) + '; document.getElementById("olName").dispatchEvent(new Event("input", { bubbles: true }));' +
  (role ? 'document.getElementById(' + JSON.stringify(role === 'host' ? 'olHost' : 'olJoin') + ').click();' : '') +
  (fmt ? 'document.getElementById("olFmt").value = ' + JSON.stringify(fmt) + ';' : '') +
  (pub ? 'if (document.getElementById("olPublic").getAttribute("aria-pressed") !== "true") document.getElementById("olPublic").click();' : '') +
  'return true; })()');
const board = (p) => p.eval('[...document.querySelectorAll("#olOpenList li")].map((li) => ({ room: li.dataset.room, who: li.querySelector(".who").textContent, fmt: li.querySelector(".fmt").textContent, label: li.querySelector("button").getAttribute("aria-label") }))');
const boardNote = (p) => p.eval('document.getElementById("olOpenNote").textContent');
const statusText = (p) => p.eval('document.getElementById("olStatus").textContent');
const stageOf = (p) => p.eval('window.__arenaOnline.state.stage');
const clickJoin = (p, room) => p.eval('document.querySelector(\'#olOpenList li[data-room="' + room + '"] button\').click()');
const promptShown = (p) => p.eval('!!document.getElementById("npApprove")');
// a message from "some other browser" on the board (another tab of the same browser can speak on the channel the net=local board uses)
const inject = (p, o) => p.eval('(() => { const c = new BroadcastChannel("bemental-arena-open-1"); c.postMessage(' + JSON.stringify(o) + '); c.close(); return true; })()');
// the SHAPE of a one-time public key (a challenge must carry one; the maths is tools/pokemonarena_presence_test.mjs group L)
const PK_SHAPE = 'A'.repeat(43) + '.' + 'B'.repeat(43);
// every message on the board, as another tab of the same browser hears it (a blank same-origin page with a BroadcastChannel on the board's name): "the room never went on the board" is read off the wire
const spyOn = async (p) => { await p.navigate(ORIGIN + '/pokemonarena/input.css'); await p.eval('(() => { window.__spy = []; const c = new BroadcastChannel("bemental-arena-open-1"); c.onmessage = (e) => window.__spy.push(e.data); window.__spyCh = c; return true; })()'); };
const spied = (p) => p.eval('window.__spy');
// the page's own AI plays this tab until the protocol is at least in round n (both tabs at once)
const aiRounds = (p, n) => p.eval('(async () => { const H = window.__arenaBattle, O = window.__arenaOnline; const side = O.state.info.mySide; const mod = await import("/pokemonarena/js/ai.js"); if (window.__aiFor !== H.scene) { window.__aiFor = H.scene; const ai = mod.createAi({ pack: H.pack, level: "normal", seed: 7 + side }); H.scene.S.auto = { ai, decide(req) { return ai.choose(req, H.ctl.view(side), { previewInfo: { foe: H.ctl.previewInfo[side ^ 1] } }); } }; } const t0 = performance.now(); while (performance.now() - t0 < 60000 && O.nm().status().round < ' + n + ' && H.scene.mode !== "result") { H.scene.tick(); if (H.scene.mode === "steps" && H.scene.S.cur && H.scene.S.cur.t === "text") H.scene.press("a"); await new Promise((r) => setTimeout(r, 0)); } return O.nm().status().round; })()');
const identity = async (p) => ({ ...(await p.eval('window.__arenaOnline.lobbies().mine')), rs: await p.eval('import("/pokemonarena/js/rules.js").then((m) => m.DEFAULT_RULESET_ID)') });
const fake = (id, over = {}) => ({ t: 'arenaopen', v: 1, k: 'open', s: '00000000000000f1', room: 'AZZZZ', name: 'Ghost', fmt: '3v3', rom: id.rom, fp: id.fp, rs: id.rs, q: 0, ...over });
async function bothPlaying(a, b, ms = 40000, watchPrompt) {
  let prompted = false;
  for (let i = 0; i < ms / 250; i++) {
    if (watchPrompt && (await promptShown(watchPrompt))) prompted = true;
    const [x, y] = [await phase(a), await phase(b)];
    if ((x === 'playing' || x === 'failed') && (y === 'playing' || y === 'failed')) return { phases: [x, y], prompted };
    await sleep(250);
  }
  return { phases: [await phase(a), await phase(b)], prompted };
}

async function groupOpen(S) {
  ANIM = '&anim=0';
  // O: a host lists the game, another browser sees it and joins with ONE press; nobody presses Allow
  await withBrowser({ port: CDP0 + 10, width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (host) => {
    const guest = await host.openTab({ width: 900, height: 760 });
    await openPanel(host, '&openquick=500&openjoin=6000'); await openPanel(guest, '&openquick=500&openjoin=6000');
    const vis = await host.eval('({ board: !document.getElementById("olOpen").hidden, pubBox: !document.getElementById("olPublicBox").hidden, roomField: !document.getElementById("olRoom").closest("label").hidden, quick: !document.getElementById("olQuick").hidden })');
    ok(vis.board && vis.pubBox && !vis.roomField && vis.quick, 'O1 the setup panel shows the board, Find a battle and the Open-to-anyone switch (the code field only for Join)', J(vis));
    ok((await board(guest)).length === 0 && /Nobody is waiting/.test(await boardNote(guest)), 'O2 with nobody listed the board says so, and what to do', await boardNote(guest));
    await setForm(host, { name: 'Alice', fmt: '3v3', pub: true, role: 'host' });
    ok((await host.eval('document.getElementById("olPublic").getAttribute("aria-pressed")')) === 'true' && /On:/.test(await host.eval('document.getElementById("olPublicNote").textContent')), 'O3 the switch says what On means', '');
    await host.eval('document.getElementById("olGo").click()');
    await host.waitFor('document.getElementById("olCode").hidden === false', { timeoutMs: 30000 });
    const room = (await host.eval('document.getElementById("olCode").textContent')).trim();
    ok(/open: anyone can join/i.test(await statusText(host)) && room.length >= 4, 'O4 the host is told the game is open to anyone (and still has the code for a friend)', await statusText(host));
    await guest.waitFor('document.querySelectorAll("#olOpenList li").length === 1', { timeoutMs: 15000 });
    const rows = await board(guest);
    ok(rows.length === 1 && rows[0].room === room && rows[0].who === 'Alice' && rows[0].fmt === '3 v 3' && /Join Alice/.test(rows[0].label), 'O5 the other browser\'s board shows the game: who, the format and a Join button', J(rows));
    ok(/1 game is waiting/.test(await boardNote(guest)), 'O6 and counts it', await boardNote(guest));
    await shot(guest, 'O_board');
    await setForm(guest, { name: 'Bob' });
    await clickJoin(guest, room);
    const r = await bothPlaying(host, guest, 60000, host);
    ok(r.phases[0] === 'playing' && r.phases[1] === 'playing', 'O7 one press on Join and both browsers are in the battle', J(r));
    ok(!r.prompted, 'O8 the host never saw an Allow prompt: an open game answers it', '');
    const info = [await host.eval('window.__arenaOnline.state.info'), await guest.eval('window.__arenaOnline.state.info')];
    ok(info[0].names.join('|') === 'Alice|Bob' && info[1].names.join('|') === 'Alice|Bob' && info[0].fmt === '3v3' && info[1].fmt === '3v3' && info[0].seed === info[1].seed, 'O9 the names, the host\'s format and one seed', J(info));
    await host.waitFor('window.__arenaBattle.state === "ready"', { timeoutMs: 30000 }); await guest.waitFor('window.__arenaBattle.state === "ready"', { timeoutMs: 30000 });
    ok(host.errors.length === 0 && guest.errors.length === 0, 'O10 no page errors', J(host.errors.concat(guest.errors)).slice(0, 200));
    const third = await host.openTab({ width: 900, height: 760 });
    await openPanel(third, '&openquick=500');
    await sleep(1500);
    ok((await board(third)).length === 0, 'O11 once they are in a battle the game is off the board', J(await board(third)));
    ok((await host.eval('window.__arenaOnline.lobbies()')) === null && (await guest.eval('window.__arenaOnline.lobbies()')) === null, 'O12 and both pages let go of the board connection', '');
  });

  // Q: Find a battle: with nobody there it opens a game and waits; the next one finds it and joins
  await withBrowser({ port: CDP0 + 11, width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (a) => {
    const b = await a.openTab({ width: 900, height: 760 });
    await openPanel(a, '&openquick=500&openjoin=6000'); await openPanel(b, '&openquick=500&openjoin=6000');
    await setForm(a, { name: 'Ann', fmt: '6v6' });
    await a.eval('document.getElementById("olQuick").click()');
    await a.waitFor('window.__arenaOnline.state.stage === "open"', { timeoutMs: 30000 });
    const hosting = await a.eval('window.__arenaOnline.lobbies().hosting()');
    ok(hosting && hosting.q === true && hosting.fmt === '6v6' && hosting.name === 'Ann', 'Q1 with nobody waiting Find a battle opens an open game of its own, in the format chosen', J(hosting));
    ok(/Nobody was waiting/.test(await statusText(a)), 'Q2 and says so', await statusText(a));
    await b.waitFor('document.querySelectorAll("#olOpenList li").length === 1', { timeoutMs: 15000 });
    await setForm(b, { name: 'Ben' });
    await b.eval('document.getElementById("olQuick").click()');
    const r = await bothPlaying(a, b, 60000, a);
    ok(r.phases[0] === 'playing' && r.phases[1] === 'playing' && !r.prompted, 'Q3 the next Find a battle joins it and the battle starts, with no prompt', J(r));
    const roles = [await a.eval('window.__arenaOnline.state.role'), await b.eval('window.__arenaOnline.state.role')];
    ok(roles.join() === 'host,guest', 'Q4 the one who waited is the host', roles.join());
    ok((await b.eval('window.__arenaOnline.nm().fmt')) === '6v6', 'Q5 the joiner plays the host\'s format', '');
  });

  // Q2: two players press Find a battle at the same moment: both open a game, exactly one stays and the other joins it
  await withBrowser({ port: CDP0 + 12, width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (a) => {
    const b = await a.openTab({ width: 900, height: 760 });
    await openPanel(a, '&openquick=1200&openjoin=8000'); await openPanel(b, '&openquick=1200&openjoin=8000');
    await setForm(a, { name: 'Zed', fmt: '3v3' }); await setForm(b, { name: 'Yan', fmt: '3v3' });
    await Promise.all([a.eval('document.getElementById("olQuick").click()'), b.eval('document.getElementById("olQuick").click()')]);
    const r = await bothPlaying(a, b, 90000);
    ok(r.phases[0] === 'playing' && r.phases[1] === 'playing', 'Q6 two simultaneous Find a battle presses still end in ONE battle', J(r));
    const roles = [await a.eval('window.__arenaOnline.state.role'), await b.eval('window.__arenaOnline.state.role')].sort();
    ok(roles.join() === 'guest,host', 'Q7 one of them hosts and the other joined (not two hosts waiting for ever)', roles.join());
    ok((await a.eval('window.__arenaOnline.state.room')) === (await b.eval('window.__arenaOnline.state.room')), 'Q8 in the same room', '');
  });

  // X: what a stranger can put on the board
  await withBrowser({ port: CDP0 + 13, width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (a) => {
    const b = await a.openTab({ width: 900, height: 760 });
    await openPanel(a, '&openquick=300&openjoin=3000'); await openPanel(b, '&openquick=300&openjoin=3000');
    const id = await identity(a);
    // a game on another engine build is not offered; the board says how many it hid
    await inject(b, fake(id, { room: 'AOLD1', s: '00000000000000a1', fp: 'e0.old.build', name: 'Old' }));
    await a.waitFor('/different version/.test(document.getElementById("olOpenNote").textContent)', { timeoutMs: 8000 });
    ok((await board(a)).length === 0 && /1 open on a different version/.test(await boardNote(a)), 'X1 a game on another build is hidden, and the board says one was', await boardNote(a));
    // a hostile name is plain text
    await inject(b, fake(id, { room: 'AHOST', s: '00000000000000a2', name: '<img src=x onerror=window.__pwned=1>Eve' }));
    await a.waitFor('document.querySelectorAll("#olOpenList li").length === 1', { timeoutMs: 8000 });
    const hostile = await a.eval('({ who: document.querySelector("#olOpenList .who").textContent, imgs: document.querySelectorAll("#olOpenList img").length, pwned: !!window.__pwned })');
    ok(/^[A-Za-z0-9 .'_!?-]{1,10}$/.test(hostile.who) && hostile.imgs === 0 && !hostile.pwned, 'X2 a hostile name is cut to safe text and nothing in it runs', J(hostile));
    // a made-up game: pressing Join finds nobody; the joiner gives up on it in a few seconds, says so, and it stays off the board
    await inject(b, fake(id, { room: 'AGHOS', s: '00000000000000a3', name: 'Ghost' }));
    await a.waitFor('document.querySelector(\'#olOpenList li[data-room="AGHOS"]\')', { timeoutMs: 8000 });
    await setForm(a, { name: 'Ann' });
    await clickJoin(a, 'AGHOS');
    await a.waitFor('window.__arenaOnline.state.stage === "setup" && /not open any more/.test(document.getElementById("olStatus").textContent)', { timeoutMs: 25000 });
    ok(true, 'X3 a game that never answers is given up on, in words', await statusText(a));
    ok(!(await board(a)).some((g) => g.room === 'AGHOS'), 'X4 and it is off the board (muted), even though its beacon keeps arriving', J(await board(a)));
    ok((await a.eval('document.getElementById("olGo").disabled')) === false && (await a.eval('document.getElementById("olQuick").disabled')) === false, 'X5 the panel is usable again', '');
    // a game whose rules are not my team's: refused BEFORE connecting
    await inject(b, fake(id, { room: 'ARULE', s: '00000000000000a4', rs: 'some-other-ruleset', name: 'Odd' }));
    await a.waitFor('document.querySelector(\'#olOpenList li[data-room="ARULE"]\')', { timeoutMs: 8000 });
    await clickJoin(a, 'ARULE');
    await a.waitFor('/different rules/.test(document.getElementById("olStatus").textContent)', { timeoutMs: 10000 });
    ok((await stageOf(a)) === 'setup', 'X6 a game under other rules is refused in words, before any connection', await statusText(a));
    // a game that says it is gone
    await inject(b, { t: 'arenaopen', v: 1, k: 'gone', s: '00000000000000a2', room: 'AHOST' });
    await a.waitFor('!document.querySelector(\'#olOpenList li[data-room="AHOST"]\')', { timeoutMs: 8000 });
    ok(true, 'X7 a game that says it is gone leaves the board at once', '');
    // junk does not break the panel
    for (const junk of ['x', 7, null, { t: 'arenaopen' }, { t: 'arenaopen', v: 1, k: 'open', s: 'zz' }]) await inject(b, junk);
    await sleep(300);
    ok(a.errors.length === 0, 'X8 junk on the board raises no page error', J(a.errors).slice(0, 200));
  });

  // OL: leaving the page takes the game off the board at once; a private game was never on it; a lobby hand-off has no board
  await withBrowser({ port: CDP0 + 14, width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (a) => {
    const b = await a.openTab({ width: 900, height: 760 });
    await openPanel(a); await openPanel(b);
    await setForm(a, { name: 'Lea', pub: true, role: 'host' });
    await a.eval('document.getElementById("olGo").click()');
    await a.waitFor('document.getElementById("olCode").hidden === false', { timeoutMs: 30000 });
    await b.waitFor('document.querySelectorAll("#olOpenList li").length === 1', { timeoutMs: 15000 });
    await a.navigate('about:blank');
    const t0 = Date.now();
    await b.waitFor('document.querySelectorAll("#olOpenList li").length === 0', { timeoutMs: 8000 });
    ok(Date.now() - t0 < 8000, 'OL1 closing the host\'s page takes the game off the other board within seconds (not the 13 s a missing beacon would take)', String(Date.now() - t0));
    await openPanel(a);
    await setForm(a, { name: 'Pat', role: 'host' });         // the switch stays off: a private game
    await a.eval('document.getElementById("olGo").click()');
    await a.waitFor('document.getElementById("olCode").hidden === false', { timeoutMs: 30000 });
    await sleep(1800);
    ok((await board(b)).length === 0 && (await a.eval('window.__arenaOnline.lobbies()')) === null, 'OL2 a private game is never listed (and opens no connection to the board)', J(await board(b)));
    ok(/allow/i.test(await statusText(a)), 'OL3 and still waits for the host to press Allow', await statusText(a));
    await b.navigate(BASE + '?np=ABCDE&host=1&net=local' + ANIM);
    await b.waitFor('window.__arenaOnline && document.getElementById("olGo") && !document.getElementById("olGo").disabled', { timeoutMs: 60000 });
    const hv = await b.eval('({ board: !document.getElementById("olOpen").hidden, pub: !document.getElementById("olPublicBox").hidden })');
    ok(!hv.board && hv.pub, 'OL4 a lobby hand-off (a code in the address) has no board, and can still choose to be open', J(hv));
  });

  // OR: two joiners for one seat; one gets it, the other is told in words and is not stuck
  await withBrowser({ port: CDP0 + 15, width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (h) => {
    const g1 = await h.openTab({ width: 900, height: 760 }), g2 = await h.openTab({ width: 900, height: 760 });
    await openPanel(h); await openPanel(g1, '&openjoin=15000'); await openPanel(g2, '&openjoin=15000');
    await setForm(h, { name: 'Hal', pub: true, role: 'host' });
    await h.eval('document.getElementById("olGo").click()');
    await h.waitFor('document.getElementById("olCode").hidden === false', { timeoutMs: 30000 });
    const room = (await h.eval('document.getElementById("olCode").textContent')).trim();
    await g1.waitFor('document.querySelectorAll("#olOpenList li").length === 1', { timeoutMs: 15000 });
    await g2.waitFor('document.querySelectorAll("#olOpenList li").length === 1', { timeoutMs: 15000 });
    await setForm(g1, { name: 'One' }); await setForm(g2, { name: 'Two' });
    await Promise.all([clickJoin(g1, room), clickJoin(g2, room)]);
    let out = null;
    for (let i = 0; i < 200 && !out; i++) {
      const st = [await phase(g1), await phase(g2)], stage = [await stageOf(g1), await stageOf(g2)];
      if (st.some((x) => x === 'playing') && stage.some((x) => x === 'setup')) out = { st, stage };
      await sleep(250);
    }
    ok(!!out, 'OR1 of two players who press Join together, one is in the battle and the other is back at the board', J(out));
    const loser = out && out.stage[0] === 'setup' ? g1 : g2;
    const msg = await statusText(loser);
    ok(/just taken|not open any more/.test(msg), 'OR2 and is told that game is gone, in words', msg);
    ok((await board(loser)).every((g) => g.room !== room), 'OR3 and it is off their board', J(await board(loser)));
  });

  // OV: the opponent never gets as far as a battle: the game goes back on the board under a new code, and the host loses nothing
  await withBrowser({ port: CDP0 + 16, width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (h) => {
    const raw = await h.openTab({ width: 900, height: 760 }), real = await h.openTab({ width: 900, height: 760 });
    await openPanel(h); await openPanel(raw); await openPanel(real);
    await setForm(h, { name: 'Vic', fmt: '3v3', pub: true, role: 'host' });
    await h.eval('document.getElementById("olGo").click()');
    await h.waitFor('document.getElementById("olCode").hidden === false', { timeoutMs: 30000 });
    const room1 = (await h.eval('document.getElementById("olCode").textContent')).trim();
    // a bare lib/netplay.js session that is let in and then says a hello the host must refuse (a ROM that is not ours)
    await raw.eval('(async () => { const s = new Netplay.Session({ code: ' + JSON.stringify(room1) + ', host: false, portCount: 2, transport: "local" }); window.__rawS = s; const up = new Promise((res) => s.on("status", (e) => { if (e.state === "connected") res(true); })); s.start(); await up; s._send({ t: "lsarena", v: 1, mn: 1, k: "hello", rom: "0".repeat(64), fp: "x", rs: "x", name: "Mallory", team: "x", fmt: null }); return true; })()');
    await h.waitFor('window.__arenaOnline.state.room !== ' + JSON.stringify(room1) + ' && window.__arenaOnline.state.stage === "open"', { timeoutMs: 60000 });
    const room2 = (await h.eval('document.getElementById("olCode").textContent')).trim();
    ok(room2 !== room1 && (await h.eval('document.getElementById("error").hidden')), 'OV1 a joiner whose game does not match is turned away and the host is NOT shown an error: the game is open again under a new code', room1 + ' -> ' + room2);
    const hosting = await h.eval('window.__arenaOnline.lobbies().hosting()');
    ok(hosting && hosting.room === room2, 'OV2 and it is listed under the new code', J(hosting));
    await real.waitFor('document.querySelector(\'#olOpenList li[data-room="' + room2 + '"]\')', { timeoutMs: 20000 });
    ok(!(await board(real)).some((g) => g.room === room1), 'OV3 the old code is not on the board', J(await board(real)));
    await setForm(real, { name: 'Rae' });
    await clickJoin(real, room2);
    const r = await bothPlaying(h, real, 60000, h);
    ok(r.phases[0] === 'playing' && r.phases[1] === 'playing' && !r.prompted, 'OV4 and a real player can then join the same host and play', J(r));
  });
  await withBrowser({ port: CDP0 + 17, width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (h) => {
    const raw = await h.openTab({ width: 900, height: 760 });
    await openPanel(h); await openPanel(raw);
    await setForm(h, { name: 'Walt', fmt: '3v3', pub: true, role: 'host' });
    await h.eval('document.getElementById("olGo").click()');
    await h.waitFor('document.getElementById("olCode").hidden === false', { timeoutMs: 30000 });
    const room1 = (await h.eval('document.getElementById("olCode").textContent')).trim();
    // a joiner that is let in and then goes away before the handshake is over
    await raw.eval('(async () => { const s = new Netplay.Session({ code: ' + JSON.stringify(room1) + ', host: false, portCount: 2, transport: "local" }); window.__rawS = s; const up = new Promise((res) => s.on("status", (e) => { if (e.state === "connected") res(true); })); s.start(); await up; return true; })()');
    await h.waitFor('window.__arenaOnline.nm() !== null', { timeoutMs: 20000 });
    await raw.navigate('about:blank');          // the page goes away: the link dies
    await h.waitFor('window.__arenaOnline.state.room !== ' + JSON.stringify(room1) + ' && window.__arenaOnline.state.stage === "open"', { timeoutMs: 80000 });
    ok(true, 'OV5 a joiner who vanishes before the battle puts the game back on the board under a new code, without a 90 s wait', await statusText(h));
    ok(await h.eval('document.getElementById("error").hidden'), 'OV6 and the host sees no error screen', '');
  });

  // U: the moment an open game lets somebody in it comes off the board (not when the link finally comes up); if that player never gets connected the seat is free and the game is listed again
  await withBrowser({ port: CDP0 + 34, width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (h) => {
    const g = await h.openTab({ width: 900, height: 760 }), o = await h.openTab({ width: 900, height: 760 });
    await openPanel(h); await openPanel(g, '&openjoin=20000'); await openPanel(o, '&openjoin=20000');
    await setForm(h, { name: 'Uma', fmt: '3v3', pub: true, role: 'host' });
    await h.eval('document.getElementById("olGo").click()');
    await h.waitFor('document.getElementById("olCode").hidden === false', { timeoutMs: 30000 });
    const room = (await h.eval('document.getElementById("olCode").textContent')).trim();
    await g.waitFor('document.querySelectorAll("#olOpenList li").length === 1', { timeoutMs: 15000 });
    await o.waitFor('document.querySelectorAll("#olOpenList li").length === 1', { timeoutMs: 15000 });
    // the board loses every broker under a listed game: the host is told nobody can find it (it used to go on saying "your game is open"), and is told the good news again when the board is back
    const hid = await identity(h);
    const kick = (name) => inject(o, fake(hid, { room: 'AKICK', s: '00000000000000e1', fp: 'e0.other.build', name }));          // another build: on the board's books but not in anybody's list; any change makes the page look at the connection again
    await h.eval('(() => { const L = window.__arenaOnline.lobbies(); window.__realStatus = L.status; L.status = () => "down"; return true; })()');
    await kick('Kick1');
    const sawDown = await h.waitFor('/cannot be reached/.test(document.getElementById("olStatus").textContent)', { timeoutMs: 8000 }).then(() => true, () => false);
    ok(sawDown, 'U0 a listed game on a board that has lost every broker is told nobody can find it', await statusText(h));
    await h.eval('window.__arenaOnline.lobbies().status = window.__realStatus; true');
    await kick('Kick2');
    const sawUp = await h.waitFor('/anyone can join/i.test(document.getElementById("olStatus").textContent)', { timeoutMs: 8000 }).then(() => true, () => false);
    ok(sawUp, 'U0b ... and is told it is open again when the board is back', await statusText(h));
    // the library is made to sit on the admission: the knock IS let in (the page approves it) but no link is ever made, so "connected" never comes
    await h.eval('(() => { const S = window.__arenaOnline.session(); S.approve = async () => false; return true; })()');
    await setForm(g, { name: 'Gus' });
    await clickJoin(g, room);
    await h.waitFor('window.__arenaOnline.state.admitted === true', { timeoutMs: 30000 });
    const gone = await o.waitFor('document.querySelectorAll("#olOpenList li").length === 0', { timeoutMs: 4000 }).then(() => true, () => false);
    ok(gone && (await h.eval('window.__arenaOnline.nm()')) === null && (await h.eval('window.__arenaOnline.state.stage')) === 'open', 'U1 the moment the knock is let in the game is off the board (within seconds, not the 13 s a silent listing takes to age off), although nothing has connected yet', J(await board(o)));
    // the library reports that the admitted link is gone before it was ever up
    await h.eval('(() => { const S = window.__arenaOnline.session(); const p = S._pending; delete S.approve; if (p) S.deny(p.nonce, "test"); S._emit("peer-left", { peer: p ? p.nonce : "x", why: "ice-timeout", remaining: 0 }); return true; })()');
    const back = await o.waitFor('document.querySelectorAll("#olOpenList li").length === 1', { timeoutMs: 8000 }).then(() => true, () => false);
    ok(back && (await h.eval('window.__arenaOnline.state.admitted')) === false && (await h.eval('window.__arenaOnline.state.admittedId')) === null, 'U2 the player never got connected: the seat is free again and the game is back on the board', J(await board(o)));
    await setForm(o, { name: 'Ola' });
    await clickJoin(o, room);
    const r = await bothPlaying(h, o, 60000, h);
    ok(r.phases[0] === 'playing' && r.phases[1] === 'playing' && !r.prompted, 'U3 and the next player is let in and plays, with no prompt', J(r));
    ok(h.errors.length === 0 && o.errors.length === 0, 'U4 no page errors', J(h.errors.concat(o.errors)).slice(0, 200));
  });

  // OT: the tie-break cannot be turned against a waiting host by a made-up beacon. A forged q:1 beacon with a code below every real one used to make every host that pressed Find a battle leave its own game for a room nobody answers.
  await withBrowser({ port: CDP0 + 35, width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (a) => {
    const b = await a.openTab({ width: 900, height: 760 });
    await openPanel(a, '&openquick=300&openjoin=3000'); await openPanel(b, '&openquick=300&openjoin=3000');
    await setForm(a, { name: 'Tia', fmt: '3v3' });
    // a board that has lost every broker: Find a battle says so and opens nothing (it used to open a game and say it was open)
    await a.eval('(() => { const L = window.__arenaOnline.lobbies(); window.__realStatus = L.status; L.status = () => "down"; return true; })()');
    await a.eval('document.getElementById("olQuick").click()');
    const refused = await a.waitFor('/could not be reached/.test(document.getElementById("olStatus").textContent)', { timeoutMs: 15000 }).then(() => true, () => false);
    ok(refused && (await stageOf(a)) === 'setup' && (await a.eval('window.__arenaOnline.lobbies().hosting()')) === null && (await a.eval('document.getElementById("olQuick").disabled')) === false, 'OT0 with the board down Find a battle opens no game and says so, and the panel is usable again', (await stageOf(a)) + ' ' + (await statusText(a)));
    if (!refused) return;
    await a.eval('window.__arenaOnline.lobbies().status = window.__realStatus; true');
    await a.eval('document.getElementById("olQuick").click()');
    await a.waitFor('window.__arenaOnline.state.stage === "open"', { timeoutMs: 30000 });
    const mine = (await a.eval('window.__arenaOnline.lobbies().hosting()')).room;
    const id = await identity(a);
    const forged = () => fake(id, { room: '0AAAA', s: '00000000000000f9', q: 1, name: 'Ghost' });
    await inject(b, forged());
    await a.waitFor('window.__arenaOnline.lobbies().list().some((g) => g.room === "0AAAA")', { timeoutMs: 5000 });
    await sleep(4500);
    ok((await stageOf(a)) === 'open' && (await a.eval('window.__arenaOnline.lobbies().hosting().room')) === mine, 'OT1 ONE forged beacon (even heard for longer than a beacon interval) does not move a waiting Find-a-battle host out of its own game', await stageOf(a));
    await inject(b, forged());                     // heard a second time, more than a beacon interval after the first: now it counts as a game
    const moved = await a.waitFor('window.__arenaOnline.state.stage === "waiting" && window.__arenaOnline.state.room === "0AAAA"', { timeoutMs: 8000 }).then(() => true, () => false);
    ok(moved, 'OT2 heard twice, a beacon interval apart, a rival IS believed (the board is advice: the cost of being wrong is below)', await stageOf(a));
    // the ghost does not answer: the join gives up and the player's OWN game is open again, listed, not a setup form
    const rehosted = await a.waitFor('window.__arenaOnline.state.stage === "open" && window.__arenaOnline.lobbies() && !!window.__arenaOnline.lobbies().hosting()', { timeoutMs: 30000 }).then(() => true, () => false);
    ok(rehosted, 'OT3a when the rival does not answer the host is back to an open, listed game (not the setup form)', (await stageOf(a)) + ' ' + (await statusText(a)));
    if (!moved || !rehosted) return;
    const again = await a.eval('({ role: window.__arenaOnline.state.role, quick: window.__arenaOnline.state.quick, hosting: window.__arenaOnline.lobbies().hosting(), codeShown: !document.getElementById("olCode").hidden, status: document.getElementById("olStatus").textContent })');
    ok(again.role === 'host' && again.quick === true && again.hosting.q === true && again.hosting.room !== '0AAAA' && again.codeShown && /not there/.test(again.status), 'OT3 when the rival does not answer the host gets its OWN game back (open, listed, quick), with a new code, and is told why', J(again));
    const relisted = await b.waitFor('window.__arenaOnline.lobbies().list().some((g) => g.room === ' + JSON.stringify(again.hosting.room) + ')', { timeoutMs: 10000 }).then(() => true, () => false);
    ok(relisted, 'OT4 and the other browser sees it listed again', 'the other board lists ' + J(await b.eval('window.__arenaOnline.lobbies().list().map((g) => g.room)').catch(() => null)) + ', wanted ' + again.hosting.room);
    if (!relisted) return;
    // the ghost is left off the board for a good while: it can keep sending, it does not get the host a second time
    await inject(b, forged()); await sleep(4500); await inject(b, forged()); await sleep(2500);
    ok((await stageOf(a)) === 'open' && (await a.eval('window.__arenaOnline.lobbies().hosting().room')) === again.hosting.room, 'OT5 a rival whose join failed is muted: the same made-up beacon, twice, does not move the host again', await stageOf(a));
    ok(a.errors.length === 0 && b.errors.length === 0, 'OT6 no page errors', J(a.errors.concat(b.errors)).slice(0, 200));
  });

  // S: the host's Session is REBUILT in the middle of a match (online.js builds a new one under the same code when one fails): the player who is in the match is let back in with no prompt
  await withBrowser({ port: CDP0 + 36, width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (h) => {
    const g = await h.openTab({ width: 900, height: 760 });
    await openPanel(h); await openPanel(g, '&openjoin=15000');
    await setForm(h, { name: 'Sal', fmt: '3v3', pub: true, role: 'host' });
    await h.eval('document.getElementById("olGo").click()');
    await h.waitFor('document.getElementById("olCode").hidden === false', { timeoutMs: 30000 });
    const room = (await h.eval('document.getElementById("olCode").textContent')).trim();
    await g.waitFor('document.querySelectorAll("#olOpenList li").length === 1', { timeoutMs: 15000 });
    await setForm(g, { name: 'Gil' });
    await clickJoin(g, room);
    const r = await bothPlaying(h, g, 60000, h);
    ok(r.phases[0] === 'playing' && r.phases[1] === 'playing' && !r.prompted, 'S1 an open game: the joiner is let in and the match starts, with no prompt', J(r));
    await h.waitFor('window.__arenaBattle.state === "ready"', { timeoutMs: 30000 }); await g.waitFor('window.__arenaBattle.state === "ready"', { timeoutMs: 30000 });
    await h.eval('(() => { window.__oldSession = window.__arenaOnline.session(); window.__oldSession._status("failed", "test: the host session failed in the middle of the match"); return true; })()');
    await h.waitFor('window.__arenaOnline.session() !== window.__oldSession', { timeoutMs: 15000 });
    ok(true, 'S2 the host builds a NEW Session under the same code (it has forgotten who it let in)', '');
    let prompted = false;
    const up = await (async () => { for (let i = 0; i < 180; i++) { if (await promptShown(h)) prompted = true; const [a, b] = [await h.eval('window.__arenaOnline.nm() && window.__arenaOnline.nm().status().link'), await g.eval('window.__arenaOnline.nm() && window.__arenaOnline.nm().status().link')]; if (a === 'up' && b === 'up' && (await h.eval('window.__arenaOnline.session() !== window.__oldSession'))) return true; await sleep(250); } return false; })();
    ok(up, 'S3 the player in the match is let back in by the new Session: both sides report the link up again', await g.eval('document.getElementById("olStatus").textContent'));
    ok(!prompted && !(await promptShown(h)), 'S4 and nobody was asked to press Allow, and nobody was told the game is taken', '');
    ok(h.errors.length === 0 && g.errors.length === 0, 'S5 no page errors', J(h.errors.concat(g.errors)).slice(0, 200));
  });
}

/* ---------------------------------------------------------------------------------------------- the open games that a mutated copy can be run against (`open --mutants`) */
// A forger that rotates its room code, a player who is joining (and knocks again), the library re-admitting somebody by itself, and Cancel. Every session takes the origin it runs against (c.origin: the real
// server, or a copy of the game with ONE defect in it) and records through c.ok; the board is a BroadcastChannel and a channel is per origin, so every page of a session is on that one origin.
//   node tools/pokemonarena_online_page_test.mjs open             the older cases above, then these
//   node tools/pokemonarena_online_page_test.mjs open --mutants   ALSO serve a copy of the game with ONE defect at a time (tools/pokemonarena_overlay.mjs); each must fail the named case
//   ARENA_OP=forger,cancel runs only those sessions (while working on one)
// The library is made to sit on an admission the way the U cases do (an OFFER that never leaves: the knock is let in, the link never comes up) and its own ways of giving up are called by their own names
// (S._linkGone(L, 'ice-timeout') is what its connect watchdog does; a second Session with the same code in the same tab is a reloaded page: the same nonce, a new incarnation).
const OP_STALL = '(() => { const S = window.__arenaOnline.session(); const real = S._sig.send; window.__dropOffers = true; S._sig.send = function (m) { if (window.__dropOffers && m && m.t === "offer") return undefined; return real.apply(this, arguments); }; return true; })()';
const OP_COUNT_HOST = '(() => { const L = window.__arenaOnline.lobbies(); const real = L.host; window.__hostCalls = 0; L.host = function () { window.__hostCalls++; return real.apply(this, arguments); }; return true; })()';
const opGiveUp = (h, nonce) => h.eval('(() => { const S = window.__arenaOnline.session(); const L = S._links.get(' + J(nonce) + '); if (!L) return false; S._linkGone(L, "ice-timeout"); return true; })()');
const opBoardCount = (p) => p.eval('document.querySelectorAll("#olOpenList li").length');
const opKnock = (p, room) => p.eval('(async () => { const s = new Netplay.Session({ code: ' + J(room) + ', host: false, portCount: 2, transport: "local" }); window.__rawS = s; window.__rawN = s._nonce; s.start(); return s._nonce; })()');

async function groupOpenSessions(S) {
  ANIM = '&anim=0';
  const mk = (origin, okFn, treeDir) => ({ origin, ok: okFn, cdp: (k) => CDP0 + 34 + (k % 2), treeDir });
  const run = async (name, c) => { try { await OP_SESSIONS[name](c); } catch (e) { c.ok(false, 'OP ' + name + ' session crashed', e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e)); } };
  const wanted = (process.env.ARENA_OP || '').split(',').filter(Boolean);
  for (const name of Object.keys(OP_SESSIONS)) if (!wanted.length || wanted.includes(name)) await run(name, mk(ORIGIN, ok, path.join(root, 'pokemonarena')));
  if (!process.argv.includes('--mutants')) return;
  if (REMOTE) { ok(true, 'OPMUT (skipped against a deployed site)'); return; }
  const { copyTree, mutateFile, startOverlay } = await import('./pokemonarena_overlay.mjs');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-open-mut-'));
  let killed = 0, ran = 0;
  try {
    for (const mu of OPEN_MUTANTS) {
      if (wanted.length && !wanted.includes(mu.run)) continue;
      const failed = [];
      const rec = (cond, name, detail) => { if (!cond) failed.push(name + (detail ? ' :: ' + String(detail).slice(0, 160) : '')); };
      ran++;
      const dir = copyTree(path.join(root, 'pokemonarena'), path.join(tmp, mu.id));
      let ov = null;
      try {
        try { mutateFile(dir, mu.file, mu.from, mu.to); for (const x of mu.also || []) mutateFile(dir, x.file, x.from, x.to); } catch (e) { ok(false, 'OPMUT ' + mu.id + ' could not be applied', e.message); continue; }
        ov = await startOverlay({ dir, port: PORT + 20, upstream: ORIGIN });
        await run(mu.run, mk(ov.url, rec, dir));
      } finally { if (ov) ov.stop(); }
      const hit = failed.find((f) => f.startsWith(mu.fails + ' '));
      ok(!!hit, 'OPMUT ' + mu.id + ' (' + mu.what + ') fails ' + mu.fails, hit ? '' : 'it did NOT: failed cases = ' + J(failed.map((f) => f.slice(0, 60))));
      if (hit) killed++;
    }
  } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_e) { /* ignore */ } }
  console.log(`open mutants: ${killed}/${ran} killed`);
}

// ---- OP0, OP1: a FORGER THAT ROTATES ITS ROOM CODE. After a failed defection no rival at all moves the host for the cooldown; the first version remembered the failed ROOM, so every new code was believed again 4 s later
async function opForger(c) {
  const { ok } = c;
  await withBrowser({ port: c.cdp(0), width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (a) => {
    const b = await a.openTab({ width: 900, height: 760 });
    await uxPanel(c, a, '&openquick=300&openjoin=3000'); await uxPanel(c, b, '&openquick=300&openjoin=3000');
    await setForm(a, { name: 'Tia', fmt: '3v3' });
    await a.eval('document.getElementById("olQuick").click()');
    await a.waitFor('window.__arenaOnline.state.stage === "open"', { timeoutMs: 30000 });
    const id = await identity(a);
    const ghost = (i) => fake(id, { room: '0AAB' + 'CDEFGH'[i], s: '00000000000000f' + (i + 1), q: 1, name: 'Ghost' + i });
    const hostingRoom = () => a.eval('window.__arenaOnline.lobbies() && window.__arenaOnline.lobbies().hosting() && window.__arenaOnline.lobbies().hosting().room');
    // the first forged listing, heard twice a beacon interval apart, is believed: the host leaves its own game for it, nobody answers, and the host's own game is open again (the cost: one failed join)
    await inject(b, ghost(0));
    await a.waitFor('window.__arenaOnline.lobbies().list().some((g) => g.room === ' + J(ghost(0).room) + ')', { timeoutMs: 5000 }).catch(() => null);
    await sleep(4500); await inject(b, ghost(0));
    const moved = await a.waitFor('window.__arenaOnline.state.stage === "waiting" && window.__arenaOnline.state.room === ' + J(ghost(0).room), { timeoutMs: 8000 }).then(() => true, () => false);
    const back = moved && await a.waitFor('window.__arenaOnline.state.stage === "open" && window.__arenaOnline.lobbies() && !!window.__arenaOnline.lobbies().hosting()', { timeoutMs: 30000 }).then(() => true, () => false);
    ok(moved && back, 'OP0 (the rig) the first forged listing, heard twice a beacon interval apart, moves the host, nobody answers, and the host\'s own game is open again: the failed defection the cooldown remembers', 'moved=' + moved + ' back=' + back + ' ' + (await stageOf(a)));
    if (!(moved && back)) return;
    const mine = await hostingRoom();
    // a forger that ROTATES its room code and its sender id: three new listings, each heard twice, each a room the room-keyed mute has never seen
    const rows = [];
    for (let i = 1; i <= 3; i++) {
      await inject(b, ghost(i)); await sleep(4500); await inject(b, ghost(i)); await sleep(1500);
      rows.push({ i, stage: await stageOf(a), room: await hostingRoom() });
    }
    ok(rows.every((r) => r.stage === 'open' && r.room === mine), 'OP1 after a failed defection NO rival moves the host, even a forger that publishes a new room code each time: three fresh listings, each heard twice, leave the host in its own game', J({ mine, rows }));
    ok(a.errors.length === 0 && b.errors.length === 0, 'OP1b no page errors', J(a.errors.concat(b.errors)).slice(0, 200));
  });
}

// ---- OP2: a player who is JOINING. The host is told so (it used to go on saying "your game is open: anyone can join it"), and the game is not put back on the board while the library is re-admitting the player
//      who knocked again; if that player never gets a link the seat is given up
async function opJoining(c) {
  const { ok } = c;
  await withBrowser({ port: c.cdp(0), width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (h) => {
    const o = await h.openTab({ width: 900, height: 760 }), raw = await h.openTab({ width: 900, height: 760 });
    const room = await uxHost(c, h, 'Hana', '&openhold=1500');
    await uxPanel(c, o); await uxPanel(c, raw);
    await o.waitFor('document.querySelectorAll("#olOpenList li").length === 1', { timeoutMs: 15000 });
    await h.eval(OP_STALL); await h.eval(OP_COUNT_HOST);
    await h.eval('(() => { const S = window.__arenaOnline.session(); window.__left = []; S.on("peer-left", (e) => window.__left.push(e.why)); return true; })()');
    const nonce = await opKnock(raw, room);                // a bare library session: the open game lets it in, and the offer never leaves
    const admitted = await h.waitFor('window.__arenaOnline.state.admitted === true', { timeoutMs: 30000 }).then(() => true, () => false);
    const joining = await statusText(h);
    ok(admitted && /player is joining/.test(joining) && !/anyone can join it/.test(joining), 'OP2 the moment somebody is let in the host is told a player is joining, not that the game is open to anyone', joining);
    if (!admitted) return;
    await o.waitFor('document.querySelectorAll("#olOpenList li").length === 0', { timeoutMs: 6000 }).catch(() => null);
    // the same player knocks again on a new page (a second Session with the same code in that tab: same nonce, new incarnation): the library tears the old link down (peer-left) and re-admits by itself
    const knock = await raw.eval('(async () => { const n = window.__rawN, first = window.__rawS; first.close(); const s = new Netplay.Session({ code: ' + J(room) + ', host: false, portCount: 2, transport: "local" }); window.__rawS2 = s; s.start(); return { same: s._nonce === n, newInc: s._inc !== first._inc }; })()');
    const left = await h.waitFor('window.__left.length > 0', { timeoutMs: 15000 }).then(() => true, () => false);
    ok(knock.same && knock.newInc && left && (await h.eval('window.__left[0]')) === 'peer-reloaded', 'OP2r (the rig) a page that came back with the same identity makes the library emit peer-left "peer-reloaded", the reason the page keys on', J([knock, await h.eval('window.__left')]));
    let relistedDuring = false;
    for (let i = 0; i < 12; i++) { if ((await opBoardCount(o)) > 0 || (await h.eval('window.__hostCalls')) > 0) relistedDuring = true; await sleep(250); }
    const during = await h.eval('({ admitted: window.__arenaOnline.state.admitted, hostCalls: window.__hostCalls, status: document.getElementById("olStatus").textContent })');
    ok(!relistedDuring && during.admitted === true && during.hostCalls === 0 && /player is joining/.test(during.status), 'OP2b while the player who knocked again is being let back in the game is NOT put back on the board (no listing sent, none on the other board, still "a player is joining")', J({ relistedDuring, during }));
    // the library gives up on the link (its connect watchdog): now the seat IS free, the game is listed again and says it is open again
    ok(await opGiveUp(h, nonce), 'OP2g (the rig) the library holds a link for the player who was let back in (so there was something to give up on)', '');
    const again = await o.waitFor('document.querySelectorAll("#olOpenList li").length === 1', { timeoutMs: 8000 }).then(() => true, () => false);
    const words = await h.eval('({ admitted: window.__arenaOnline.state.admitted, id: window.__arenaOnline.state.admittedId, status: document.getElementById("olStatus").textContent })');
    ok(again && words.admitted === false && words.id === null && /anyone can join it/.test(words.status), 'OP2c when the library gives up on the link the seat is free again: the game is back on the board AND says it is open (not "a player is joining")', J(words));
    ok(h.errors.length === 0 && o.errors.length === 0 && raw.errors.length === 0, 'OP2d no page errors', J(h.errors.concat(o.errors, raw.errors)).slice(0, 200));
  });
  // the player who knocked again never gets a link (their page went away between the library tearing the old link down and re-admitting them): the seat is not held for ever
  await withBrowser({ port: c.cdp(1), width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (h) => {
    const o = await h.openTab({ width: 900, height: 760 }), raw = await h.openTab({ width: 900, height: 760 });
    const room = await uxHost(c, h, 'Vera', '&openhold=1200');
    await uxPanel(c, o); await uxPanel(c, raw);
    await o.waitFor('document.querySelectorAll("#olOpenList li").length === 1', { timeoutMs: 15000 });
    await h.eval(OP_STALL); await h.eval(OP_COUNT_HOST);
    await opKnock(raw, room);
    const admitted = await h.waitFor('window.__arenaOnline.state.admitted === true', { timeoutMs: 30000 }).then(() => true, () => false);
    if (!admitted) { ok(false, 'OP2f (the rig) the first knock is let in', await statusText(h)); return; }
    await raw.eval('(async () => { window.__rawS.close(); const s = new Netplay.Session({ code: ' + J(room) + ', host: false, portCount: 2, transport: "local" }); await s.start(); s.close(); return true; })()');          // the hello leaves, the page is gone before it can answer
    const freed = await o.waitFor('document.querySelectorAll("#olOpenList li").length === 1', { timeoutMs: 15000 }).then(() => true, () => false);
    const st = await h.eval('({ admitted: window.__arenaOnline.state.admitted, id: window.__arenaOnline.state.admittedId, hostCalls: window.__hostCalls })');
    ok(freed && st.admitted === false && st.id === null && st.hostCalls === 1, 'OP2e an admitted player who knocked again and never got a link does not hold the seat for ever: after the hold the game is listed again, once', J({ freed, st }));
  });
}

// ---- OP3: the record of who is in follows the LIBRARY. A player it re-admits by itself (its _known set, no join-request) is recorded, so a REBUILT Session lets them back in; a genuine third player is still told the game is taken
async function opReadmit(c) {
  const { ok } = c;
  await withBrowser({ port: c.cdp(0), width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (h) => {
    const g = await h.openTab({ width: 900, height: 760 }), o = await h.openTab({ width: 900, height: 760 }), third = await h.openTab({ width: 900, height: 760 });
    const room = await uxHost(c, h, 'Rhea', '&openhold=1500');
    await uxPanel(c, g, '&openjoin=90000'); await uxPanel(c, o); await uxPanel(c, third);
    await g.waitFor('document.querySelectorAll("#olOpenList li").length === 1', { timeoutMs: 15000 });
    await h.eval(OP_STALL); await h.eval(OP_COUNT_HOST);
    await h.eval('(() => { window.__joinReq = 0; window.__arenaOnline.session().on("join-request", () => { window.__joinReq++; }); return true; })()');
    await setForm(g, { name: 'Gus' });
    await clickJoin(g, room);
    const first = await h.waitFor('window.__arenaOnline.state.admitted === true && !!window.__arenaOnline.state.admittedId', { timeoutMs: 30000 }).then(() => true, () => false);
    const gNonce = await g.eval('window.__arenaOnline.session()._nonce');
    ok(first && (await h.eval('window.__arenaOnline.state.admittedId')) === gNonce && (await h.eval('window.__joinReq')) === 1, 'OP3r (the rig) the first knock goes through the join-request handler and is recorded under the id the guest knocked with', J(await h.eval('({ id: window.__arenaOnline.state.admittedId, req: window.__joinReq })')) + ' vs ' + gNonce);
    if (!first) return;
    // the link never comes up and the library gives up on it: the seat is free (record cleared), the game is listed again
    ok(await opGiveUp(h, gNonce), 'OP3g (the rig) the library holds the link it is about to give up on', '');
    await h.waitFor('window.__arenaOnline.state.admitted === false && window.__arenaOnline.state.admittedId === null', { timeoutMs: 8000 }).catch(() => null);
    await o.waitFor('document.querySelectorAll("#olOpenList li").length === 1', { timeoutMs: 8000 }).catch(() => null);
    // the guest knocks again with the same identity: the library re-admits it BY ITSELF, with no join-request (offers are still held back)
    const calls0 = await h.eval('window.__hostCalls');
    await g.eval('window.__arenaOnline.session()._reknock("test: knocking again")');
    const silent = await h.waitFor('window.__arenaOnline.state.admitted === true', { timeoutMs: 8000 }).then(() => true, () => false);
    await o.waitFor('document.querySelectorAll("#olOpenList li").length === 0', { timeoutMs: 5000 }).catch(() => null);
    const sv = await h.eval('({ req: window.__joinReq, calls: window.__hostCalls, status: document.getElementById("olStatus").textContent })');
    ok(silent && sv.req === 1 && (await opBoardCount(o)) === 0 && /player is joining/.test(sv.status) && sv.calls === calls0, 'OP3c a player the library re-admits by itself (no join-request) is a player who is in: the seat is taken, the game comes off the board and says a player is joining', J({ silent, sv, calls0 }));
    // it gives up again; this time the offer goes out, the guest connects and the match starts
    ok(await opGiveUp(h, gNonce), 'OP3h (the rig) the library holds the link it is about to give up on, a second time', '');
    await h.waitFor('window.__arenaOnline.state.admitted === false', { timeoutMs: 8000 }).catch(() => null);
    await h.eval('window.__dropOffers = false; true');
    await g.eval('window.__arenaOnline.session()._reknock("test: knocking again")');
    const r = await bothPlaying(h, g, 60000, h);
    const rec = await h.eval('({ admitted: window.__arenaOnline.state.admitted, id: window.__arenaOnline.state.admittedId, req: window.__joinReq })');
    ok(r.phases[0] === 'playing' && r.phases[1] === 'playing' && !r.prompted && rec.req === 1, 'OP3p (the rig) the player the library re-admitted by itself gets a link and the match starts, with no prompt and no second join-request', J({ r, rec }));
    ok(rec.admitted === true && rec.id === gNonce, 'OP3a and the page has RECORDED that player (the library said so by its peer-joined event): without that, a rebuilt Session would not know who is in', J(rec) + ' vs ' + gNonce);
    // the host's Session is rebuilt in the middle of the match while the guest is held back, so that a THIRD player can knock first
    await h.waitFor('window.__arenaBattle.state === "ready"', { timeoutMs: 30000 }); await g.waitFor('window.__arenaBattle.state === "ready"', { timeoutMs: 30000 });
    await g.eval('(() => { const S = window.__arenaOnline.session(); window.__realReknock = S._reknock; S._reknock = function () { return false; }; return true; })()');
    await h.eval('(() => { window.__oldSession = window.__arenaOnline.session(); window.__oldSession._status("failed", "test: the host session failed in the middle of the match"); return true; })()');
    const rebuilt = await h.waitFor('window.__arenaOnline.session() !== window.__oldSession', { timeoutMs: 15000 }).then(() => true, () => false);
    if (!rebuilt) { ok(false, 'OP3q (the rig) the host builds a new Session', ''); return; }
    await opKnock(third, room);
    const denied = await third.waitFor('window.__rawS.state === "failed"', { timeoutMs: 30000 }).then(() => true, () => false);
    const why = await third.eval('window.__rawS.lastError');
    ok(denied && /already has a player/.test(String(why)), 'OP3d a genuine THIRD player who knocks at the rebuilt Session is still told the game is taken', J(why) + ' denied=' + denied);
    // now the player who is in comes back
    await g.eval('(() => { const S = window.__arenaOnline.session(); S._reknock = window.__realReknock; S._reknock("test: back"); return true; })()');
    let prompted = false;
    const link = (p) => p.eval('window.__arenaOnline.nm() && window.__arenaOnline.nm().status().link');
    const up = await (async () => { for (let i = 0; i < 180; i++) { if (await promptShown(h)) prompted = true; if ((await link(h)) === 'up' && (await link(g)) === 'up') return true; await sleep(250); } return false; })();
    ok(up && !prompted, 'OP3b the player the match belongs to is let back in by the REBUILT Session: both sides report the link up again, nobody was asked to press Allow, nobody was told the game is taken', J({ up, prompted, status: await g.eval('document.getElementById("olStatus").textContent') }));
    ok(h.errors.length === 0 && g.errors.length === 0 && o.errors.length === 0, 'OP3e no page errors', J(h.errors.concat(g.errors, o.errors)).slice(0, 200));
  });
}

// ---- OP4: Cancel (and a game that never answers) puts the address of the plain Play online page back, so a reload shows the board
async function opCancel(c) {
  const { ok } = c;
  await withBrowser({ port: c.cdp(0), width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (a) => {
    const b = await a.openTab({ width: 900, height: 760 });
    await uxPanel(c, a, '&openjoin=4000');
    await uxWire(c, b);
    const id = await identity(a);
    await uxKeep(b, [fake(id, { room: 'AGHOP', s: '00000000000000c8', name: 'Ghost' })]);          // a made-up game: nobody will ever answer a knock on it
    await a.waitFor('document.querySelector(\'#olOpenList li[data-room="AGHOP"]\')', { timeoutMs: 10000 });
    await setForm(a, { name: 'Ann' });
    await clickJoin(a, 'AGHOP');
    await a.waitFor('window.__arenaOnline.state.stage === "waiting"', { timeoutMs: 15000 });
    const q = (p) => p.eval('(() => { const u = new URLSearchParams(location.search); return { np: u.get("np"), join: u.get("join"), online: u.get("online"), net: u.get("net"), anim: u.get("anim") }; })()');
    const during = await q(a);
    ok(during.np === 'AGHOP' && during.join === '1', 'OP4r (the rig) while the join waits the address names the room and join=1 (so a reload finds the room)', J(during));
    await a.eval('document.getElementById("olCancelAsk").click()');
    const cancelled = await q(a);
    ok(cancelled.np === null && cancelled.join === null && cancelled.online === '1' && cancelled.net === 'local' && cancelled.anim === '0', 'OP4a Cancel puts the plain Play online address back (no room, no join=1, online=1; net and anim kept)', J(cancelled));
    await a.send('Page.reload', { ignoreCache: false });
    await a.waitFor(UX_READY + ' && !document.getElementById("olQuick").disabled', { timeoutMs: 90000 });
    const reloaded = await a.eval('({ board: !document.getElementById("olOpen").hidden, room: document.getElementById("olRoom").value, roomField: !document.getElementById("olRoom").closest("label").hidden, stage: window.__arenaOnline.state.stage, role: window.__arenaOnline.state.role })');
    ok(reloaded.board === true && reloaded.room === '' && reloaded.roomField === false && reloaded.stage === 'setup' && reloaded.role !== 'guest', 'OP4b a reload after Cancel is the Play online page with the Open games board (not the join-by-code form with the cancelled room filled in)', J(reloaded));
    // a game that never answers is given up on after the wait: the address comes back the same way
    await a.waitFor('document.querySelector(\'#olOpenList li[data-room="AGHOP"]\')', { timeoutMs: 10000 });
    await clickJoin(a, 'AGHOP');
    await a.waitFor('window.__arenaOnline.state.stage === "setup" && /not open any more/.test(document.getElementById("olStatus").textContent)', { timeoutMs: 25000 }).catch(() => null);
    const gaveUp = await q(a);
    ok(gaveUp.np === null && gaveUp.join === null && gaveUp.online === '1', 'OP4c and so does a game that never answered and was given up on', J(gaveUp));
    ok(a.errors.length === 0, 'OP4d no page errors', J(a.errors).slice(0, 200));
  });
  // a join-by-code page (the lobby's hand-off, an address with a room) is NOT the board: Cancel there leaves its address alone
  await withBrowser({ port: c.cdp(1), width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (a) => {
    await uxRoom(c, a, 'AGHOQ', 'guest', '&openjoin=4000');
    await a.eval('document.getElementById("olGo").click()');
    await a.waitFor('window.__arenaOnline.state.stage === "waiting"', { timeoutMs: 15000 });
    await a.eval('document.getElementById("olCancelAsk").click()');
    const u = await a.eval('(() => { const q = new URLSearchParams(location.search); return { np: q.get("np"), join: q.get("join"), online: q.get("online") }; })()');
    ok(u.np === 'AGHOQ' && u.join === '1' && u.online === null, 'OP4e a join-by-code page keeps its own address after Cancel (it was never the board)', J(u));
  });
}

const OP_SESSIONS = { forger: opForger, joining: opJoining, readmit: opReadmit, cancel: opCancel };
// every defect below must fail the NAMED case; the session that holds it is run against a copy of the game with only that defect in it
const OPEN_MUTANTS = [
  { id: 'P01', what: 'a failed defection is remembered by room code only (no cooldown for every rival)', file: 'js/online.js', from: 'if (state.defecting) lobbies.muteRivals(DEFECT_MUTE_MS);', to: '', run: 'forger', fails: 'OP1' },
  { id: 'P02', what: 'the host of an open game that let somebody in is not told a player is joining', file: 'js/online.js', from: "if (first && state.open && !state.nm) { openText = ''; say('A player is joining your game. It is off the list of open games while they connect.'); }", to: '', run: 'joining', fails: 'OP2' },
  { id: 'P03', what: 'a player who knocks again (peer-reloaded) releases the seat and relists the game at once', file: 'js/online.js', from: 'if (e && REKNOCK.includes(e.why)) { holdAdmission(state.session); return; }', to: '', run: 'joining', fails: 'OP2b' },
  { id: 'P04', what: 'the seat held for a player who knocked again is never given up', file: 'js/online.js', from: 'if (links > 0) holdAdmission(session); else releaseAdmission();', to: 'holdAdmission(session);', run: 'joining', fails: 'OP2e' },
  { id: 'P05', what: 'a seat that is given up lists the game again but keeps saying a player is joining', file: 'js/online.js', from: 'try { listGame(state.room); const n = openNote(state.room); openText = n.text; say(n.text, n.bad); }', to: 'try { listGame(state.room); }', run: 'joining', fails: 'OP2c' },
  { id: 'P06', what: 'the page does not record the player the library says is in (peer-joined)', file: 'js/online.js', from: "session.on('peer-joined', (e) => { if (!closed && session === state.session && e && typeof e.peer === 'string' && e.peer) { state.admitted = true; state.admittedId = e.peer; } });", to: '', run: 'readmit', fails: 'OP3a' },
  { id: 'P07', what: 'a player the library re-admits by itself does not take the seat (no room hook)', file: 'js/online.js', from: "session.on('room', (info) => { if (!closed && session === state.session && !state.nm && !state.admitted && info && info.links > 0) noteAdmitted(null); });", to: '', run: 'readmit', fails: 'OP3c' },
  { id: 'P08', what: 'a rebuilt Session lets a third player in', file: 'js/online.js', from: "if (verdict === 'deny') { req.deny('this game already has a player'); return; }", to: '', run: 'readmit', fails: 'OP3d' },
  { id: 'P09', what: 'Cancel leaves the address as np=ROOM&join=1', file: 'js/online.js', from: "if (query.role === null && !query.room) { try { win.history.replaceState(null, '', boardAddress(win.location.href)); } catch (_e) { /* the address stays as it was */ } }", to: '', run: 'cancel', fails: 'OP4a' },
  { id: 'P10', what: 'a join-by-code page is also sent to the board address after Cancel', file: 'js/online.js', from: 'if (query.role === null && !query.room) { try { win.history.replaceState(', to: 'if (true) { try { win.history.replaceState(', run: 'cancel', fails: 'OP4e' },
];

/* ---------------------------------------------------------------------------------------------- the board on a phone */
async function groupOpenLayout(S) {
  ANIM = '&anim=0';
  await withBrowser({ port: CDP0 + 18, width: 390, height: 844, mobile: true, lock: false, args: NO_THROTTLE }, async (a) => {
    const b = await a.openTab({ width: 390, height: 844, mobile: true });
    await openPanel(a); await openPanel(b);
    await setForm(b, { name: 'Bea', pub: true, role: 'host' });
    await b.eval('document.getElementById("olGo").click()');
    await b.waitFor('document.getElementById("olCode").hidden === false', { timeoutMs: 30000 });
    await a.waitFor('document.querySelectorAll("#olOpenList li").length === 1', { timeoutMs: 15000 });
    const overflow = await a.eval('document.documentElement.scrollWidth - document.documentElement.clientWidth');
    ok(overflow <= 0, 'Y1 the setup panel with the board does not overflow a 390 px phone', String(overflow));
    const sizes = await a.eval('[...document.querySelectorAll("#online button, #online select, #online input, #online a.textbtn")].filter((n) => n.offsetParent !== null).map((n) => { const r = n.getBoundingClientRect(); return [n.id || n.getAttribute("aria-label") || n.textContent, Math.round(r.height), Math.round(r.width)]; })');
    ok(sizes.length >= 6 && sizes.every(([, h, w]) => h >= 44 && w >= 44), 'Y2 every control on the board is at least 44 css px (Find a battle, each Join, the switch, the buttons)', J(sizes.filter(([, h, w]) => h < 44 || w < 44)));
    const inside = await a.eval('(() => { const r = document.getElementById("online").getBoundingClientRect(); return { l: r.left, r: r.right, w: innerWidth }; })()');
    ok(inside.l >= 0 && inside.r <= inside.w, 'Y3 the panel stays inside the screen', J(inside));
    await shot(a, 'Y_phone_board');
  });
}


/* ---------------------------------------------------------------------------------------------- open to battles (js/presence.js + presence_boot.js): the hub lists you; a challenger asks; you answer wherever you are */
// the hub (net=local so the board is the same-browser channel); openchal=<ms> shortens how long a challenge may go unanswered
async function openHub(page, extra = '') {
  await page.navigate(ORIGIN + '/pokemonarena/?net=local' + extra);
  await page.waitFor('window.__arenaHub && window.__arenaHub.state === "ready" && window.__arenaPresence', { timeoutMs: 120000 });
}
const seedProfile = (page, trainerName) => page.eval('(async () => { const { openStore } = await import("/pokemonarena/js/store.js"); const st = await openStore(); const c = await st.createProfile({ trainerName: ' + JSON.stringify(trainerName) + ' }); await st.setActiveId(c.id); await st.close(); return c.id; })()');
const toggleState = (p) => p.eval('({ pressed: document.getElementById("openToggle").getAttribute("aria-pressed"), text: document.getElementById("openToggle").textContent, stored: localStorage.getItem("arena.open") })');
const dialogOn = (p) => p.eval('(() => { const d = document.getElementById("challenge"); return !!d && !d.hidden; })()');
const residentRow = (p) => p.eval('(() => { const li = [...document.querySelectorAll("#olOpenList li")].find((x) => /^H/.test(x.dataset.room)); return li ? { room: li.dataset.room, who: li.querySelector(".who").textContent, button: li.querySelector("button").textContent, label: li.querySelector("button").getAttribute("aria-label") } : null; })()');

async function groupPresence(S) {
  ANIM = '&anim=0';
  // A: switch on in the hub -> listed -> challenged -> Not now
  await withBrowser({ port: CDP0 + 19, width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (hub) => {
    const ch = await hub.openTab({ width: 900, height: 760 });
    await hub.navigate(ORIGIN + '/pokemonarena/?net=local');
    await seedProfile(hub, 'HUBHERO');
    await openHub(hub, '&openchal=5000');
    const t0 = await toggleState(hub);
    ok(t0.pressed === 'false' && t0.text === 'Open: off' && t0.stored === null, 'A1 the hub starts closed: the switch says Open: off and nothing is stored', J(t0));
    await hub.eval('document.getElementById("openToggle").click()');
    await hub.waitFor('window.__arenaPresence.isOn() && window.__arenaPresence.presence', { timeoutMs: 30000 });
    const t1 = await toggleState(hub);
    ok(t1.pressed === 'true' && t1.text === 'Open: on' && t1.stored === '1', 'A2 switching it on says so, and remembers it', J(t1));
    await openPanel(ch, '&openchal=5000');
    await ch.waitFor('(() => [...document.querySelectorAll("#olOpenList li")].some((x) => /^H/.test(x.dataset.room)))()', { timeoutMs: 20000 });
    const row = await residentRow(ch);
    ok(row && row.who === 'HUBHERO' && row.button === 'Challenge' && /Challenge HUBHERO/.test(row.label), 'A3 another browser\'s board lists the hub player by their PROFILE\'s trainer name, with a Challenge button (not Join)', J(row));
    await shot(ch, 'P_board_resident');
    await setForm(ch, { name: 'Chad' });
    await ch.eval('document.querySelector("#olOpenList li[data-room^=H] button").click()');
    await hub.waitFor('(() => { const d = document.getElementById("challenge"); return !!d && !d.hidden; })()', { timeoutMs: 15000 });
    const dlg = await hub.eval('({ text: document.getElementById("chText").textContent, focus: document.activeElement && document.activeElement.id, modal: document.getElementById("challenge").getAttribute("aria-modal"), role: document.getElementById("challenge").getAttribute("role"), open: window.__arenaHub.dialogOpen() })');
    ok(/^Chad.* wants to battle you\.$/.test(dlg.text) && dlg.focus === 'chDecline' && dlg.modal === 'true' && dlg.role === 'alertdialog' && dlg.open === true, 'A4 the owner gets a modal dialog naming the challenger, with NOT NOW focused (a stray press must not carry them off) and the hub paused behind it', J(dlg));
    ok(/Asked HUBHERO/.test(await statusText(ch)) && (await stageOf(ch)) === 'asking' && !(await ch.eval('document.getElementById("olCancelAsk").hidden')), 'A5 the challenger is told it asked, and can cancel', await statusText(ch));
    await shot(hub, 'P_dialog_hub');
    await hub.eval('document.getElementById("chDecline").click()');
    await ch.waitFor('window.__arenaOnline.state.stage === "setup"', { timeoutMs: 10000 });
    ok(/not available/.test(await statusText(ch)) && !(await dialogOn(hub)) && (await hub.eval('window.__arenaHub.dialogOpen()')) === false, 'A6 Not now: the challenger is told in words, the dialog closes and the hub is live again', await statusText(ch));
    await ch.waitFor('document.querySelector("#olOpenList li[data-room^=H]")', { timeoutMs: 15000 });
    // The second ask must really go out and really be answered. This case used to wait for "setup + not available" with a `.catch(() => {})` and then sleep: a challenge that never left (the old
    // wait was already true from the first No, and a timeout was swallowed) passed as "no dialog". Now the challenge is COUNTED as it goes out (the challenger's own board connection), and the case
    // needs the answer to come back after that, in words; the status says "Checking your team..." the moment the button is pressed, so "not available" can only be the second No.
    await ch.eval('(() => { const L = window.__arenaOnline.lobbies(), sig = L.signal; window.__chals = 0; L.signal = function (k, ...a) { if (k === "chal") window.__chals++; return sig.call(this, k, ...a); }; return true; })()');
    await ch.eval('document.querySelector("#olOpenList li[data-room^=H] button").click()');
    const asked2 = await ch.waitFor('window.__chals >= 1 && window.__arenaOnline.state.stage === "setup" && /not available/.test(document.getElementById("olStatus").textContent)', { timeoutMs: 15000 }).then(() => true, () => false);
    ok(asked2 && (await ch.eval('window.__chals')) === 1 && !(await dialogOn(hub)), 'A7 asking again straight after Not now: the second ask goes out (once), gets a quiet no in words, and shows the owner no dialog', 'asked+answered=' + asked2 + ' chals=' + (await ch.eval('window.__chals')) + ' ' + (await statusText(ch)));
    ok(hub.errors.length === 0 && ch.errors.length === 0, 'A8 no page errors', J(hub.errors.concat(ch.errors)).slice(0, 200));
  });

  // PB: Accept -> the hub player lands on the battle page, hosts, the challenger is told the room (SEALED: it never appears on the board) and joins; nobody presses Allow; a reload resumes; the address cannot be used again
  await withBrowser({ port: CDP0 + 20, width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (hub) => {
    const ch = await hub.openTab({ width: 900, height: 760 });
    const spy = await hub.openTab({ width: 900, height: 760 });
    await spyOn(spy);
    await hub.navigate(ORIGIN + '/pokemonarena/?net=local');
    await seedProfile(hub, 'HUBHERO');
    await openHub(hub, '&openchal=20000');
    await hub.eval('document.getElementById("openToggle").click()');
    await hub.waitFor('window.__arenaPresence.isOn() && window.__arenaPresence.presence', { timeoutMs: 30000 });
    await openPanel(ch, '&openchal=20000');
    await ch.waitFor('document.querySelector("#olOpenList li[data-room^=H]")', { timeoutMs: 20000 });
    await setForm(ch, { name: 'Chad' });          // typed in a tab of the SAME browser, so it is also what this browser remembers as "the name"
    await ch.eval('document.querySelector("#olOpenList li[data-room^=H] button").click()');
    await hub.waitFor('(() => { const d = document.getElementById("challenge"); return !!d && !d.hidden; })()', { timeoutMs: 15000 });
    await hub.eval('document.getElementById("chAccept").click()');
    await sleep(200);
    ok(await dialogOn(hub), 'PB1 Accept ignores a press in the first moments (an unannounced dialog must not be accepted by a stray A)', '');
    await sleep(700);
    await hub.eval('document.getElementById("chAccept").click()');
    await hub.waitFor('location.pathname === "/pokemonarena/battle.html"', { timeoutMs: 30000 });
    const u = new URL(await hub.eval('location.href'));
    ok(u.searchParams.get('auto') === 'host' && /^[0-9a-f]{16}$/.test(u.searchParams.get('for')) && /^[0-9a-f]{16}$/.test(u.searchParams.get('rq')) && u.searchParams.get('format') === '3v3' && u.searchParams.get('net') === 'local', 'PB2 Accept takes the hub player to the battle page as the host of an accepted challenge', u.search);
    const b3 = await ch.eval('document.getElementById("olStatus").textContent');          // it used to end in `|| true` (never failed) and look for the CHALLENGER's own name; the page says the OWNER's (online.js: g.name + ' accepted. Connecting...')
    ok(/^(HUBHERO accepted\. Connecting|Joining HUBHERO)/.test(b3), 'PB3 the challenger was told the owner accepted ("HUBHERO accepted. Connecting...", or already "Joining HUBHERO..."): not still "Asked ...", not "not available"', b3);
    const r = await bothPlaying(hub, ch, 90000, hub);
    ok(r.phases[0] === 'playing' && r.phases[1] === 'playing', 'PB4 the battle starts: the challenger was told the room by the new page and joined', J(r));
    ok(!r.prompted, 'PB5 and the hub player was never asked to Allow anything', '');
    const roles = [await hub.eval('window.__arenaOnline.state.role'), await ch.eval('window.__arenaOnline.state.role')];
    const names = await ch.eval('window.__arenaOnline.state.info.names');
    ok(roles.join() === 'host,guest' && names[1] === 'Chad' && names[0] === 'HUBHERO', 'PB6 the hub player hosts under their PROFILE\'s trainer name (not the last name typed in this browser), the challenger under their own', J([roles, names]));
    ok(await ch.eval('window.__arenaOnline.lobbies() === null'), 'PB7 and the challenger lets go of the board', '');
    await hub.waitFor('window.__arenaBattle.state === "ready"', { timeoutMs: 30000 }); await ch.waitFor('window.__arenaBattle.state === "ready"', { timeoutMs: 30000 });
    ok(hub.errors.length === 0 && ch.errors.length === 0, 'PB8 no page errors', J(hub.errors.concat(ch.errors)).slice(0, 200));
    // the room travelled sealed: every "come in" on the board has a key, an iv and a ciphertext and NO room, and the room code is nowhere in anything that was said
    const room = await hub.eval('window.__arenaOnline.state.room');
    const wire = await spied(spy), accs = wire.filter((m) => m && m.k === 'acc');
    ok(/^[A-Z0-9]{4,8}$/.test(room) && accs.length >= 1 && accs.every((m) => m.pk && m.iv && m.ct && !('room' in m)) && !J(wire).includes(room) && !J(wire).includes(room.toLowerCase()), 'PB9 the room code never went on the public board: ' + accs.length + ' "come in" messages, all sealed (key, iv, ciphertext), the code in none of the ' + wire.length + ' messages', J(accs[0] || null));
    const here = new URL(await hub.eval('location.href'));
    ok(['auto', 'for', 'rq', 'ck', 'online'].every((k) => !here.searchParams.has(k)) && here.searchParams.get('np') === room && here.searchParams.get('host') === '1', 'PB10 once the room is open the address is an ordinary host address (np=ROOM&host=1), without auto / for / rq', here.search);
    ok((await hub.eval('sessionStorage.getItem("arena.accept")')) === null, 'PB11 and the accept token was used up by the page that took it', '');
    // a RELOAD of the accepted-challenge host page picks the battle up in the same room (it used to forget the room, open a second one and let the opponent win by timeout)
    await Promise.all([aiRounds(hub, 4), aiRounds(ch, 4)]);
    const accsBefore = (await spied(spy)).filter((m) => m && m.k === 'acc').length;
    await hub.send('Page.reload', { ignoreCache: false });
    const resumed = await hub.waitFor('window.__arenaOnline && window.__arenaBattle && window.__arenaBattle.state === "ready" && window.__arenaBattle.resume', { timeoutMs: 60000 }).then(() => true, () => false);
    ok(resumed, 'PB12a the reloaded accepted-challenge page rebuilds the battle (it did not start a new setup)', await hub.eval('({ search: location.search, stage: window.__arenaOnline && window.__arenaOnline.state.stage, room: window.__arenaOnline && window.__arenaOnline.state.room })').then(J, () => ''));
    if (!resumed) return;
    const back = await hub.eval('({ room: window.__arenaOnline.state.room, role: window.__arenaOnline.state.role, resumed: window.__arenaOnline.state.info.resumed, restored: window.__arenaBattle.resume.restored })');
    ok(back.resumed === true && back.restored === true && back.room === room && back.role === 'host', 'PB12 reloading the accepted-challenge page resumes the battle in the SAME room', J(back));
    await hub.waitFor('document.getElementById("npApproveAllow")', { timeoutMs: 90000 });
    await hub.eval('document.getElementById("npApproveAllow").click()');
    await hub.waitFor('window.__arenaOnline.nm().status().link === "up"', { timeoutMs: 60000 }); await ch.waitFor('window.__arenaOnline.nm().status().link === "up"', { timeoutMs: 60000 });
    ok((await spied(spy)).filter((m) => m && m.k === 'acc').length === accsBefore, 'PB13 the reloaded host is an ordinary host (asked once to allow the returning player), the link is back up, and no second room was announced', '');
    // the Accept address is not a standing command: opened again (Back, a restored tab, a pasted link) it has no token left and hosts nothing
    await hub.navigate(u.href);
    await hub.waitFor('window.__arenaOnline && document.getElementById("olGo") && window.__arenaBattle && window.__arenaBattle.state === "online" && (!document.getElementById("olOpen").hidden || !document.getElementById("olCode").hidden || window.__arenaOnline.state.stage !== "setup")', { timeoutMs: 90000 });       // (settled, one way or the other: a page that hosted a game for the address must fail PB14, not time out)
    await sleep(2500);
    const replay = await hub.eval('({ stage: window.__arenaOnline.state.stage, room: window.__arenaOnline.state.room, hosting: window.__arenaOnline.lobbies() ? window.__arenaOnline.lobbies().hosting() : null, status: document.getElementById("olStatus").textContent, board: !document.getElementById("olOpen").hidden, codeShown: !document.getElementById("olCode").hidden })');
    ok(replay.stage === 'setup' && !replay.room && !replay.hosting && !replay.codeShown && replay.board && /ignored/.test(replay.status) && (await spied(spy)).filter((m) => m && m.k === 'acc').length === accsBefore, 'PB14 the same Accept address opened again hosts nothing, announces nothing, and shows the ordinary panel with a notice', J(replay));
  });

  // PL: a link is not an Accept. battle.html?online=1&auto=host&for=..&rq=.. from anywhere (no token written by the hub) opens no room and announces nothing, whatever it names
  await withBrowser({ port: CDP0 + 33, width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (v) => {
    const spy = await v.openTab({ width: 900, height: 760 });
    await spyOn(spy);
    const FOR = 'ab'.repeat(8), RQ = 'cd'.repeat(8);
    const craft = () => BASE + '?online=1&auto=host&for=' + FOR + '&rq=' + RQ + '&format=3v3&net=local' + ANIM;
    const panelReady = () => v.waitFor('window.__arenaOnline && document.getElementById("olGo") && window.__arenaBattle && window.__arenaBattle.state === "online" && (!document.getElementById("olOpen").hidden || !document.getElementById("olCode").hidden || window.__arenaOnline.state.stage !== "setup")', { timeoutMs: 90000 });       // (settled, one way or the other; not "enabled": a page that hosted a game for the link has its panel locked, and that must be a failed case below, not a timeout)
    const view = () => v.eval('({ stage: window.__arenaOnline.state.stage, room: window.__arenaOnline.state.room, role: window.__arenaOnline.state.role, hosting: window.__arenaOnline.lobbies() ? window.__arenaOnline.lobbies().hosting() : null, status: document.getElementById("olStatus").textContent, board: !document.getElementById("olOpen").hidden, codeShown: !document.getElementById("olCode").hidden })');
    await v.navigate(craft()); await panelReady(); await sleep(2500);
    const a = await view();
    ok(a.stage === 'setup' && !a.room && !a.hosting && !a.codeShown && a.board && /ignored/.test(a.status), 'PL1 a bare accepted-challenge link opens no room: the ordinary online panel (with the open games) and a notice', J(a));
    let heard = (await spied(spy)).filter((m) => m && (m.k === 'acc' || (m.k === 'open' && m.s !== undefined && !/^H/.test(m.room))));
    ok(heard.length === 0, 'PL2 and nothing was announced on the board for it (no room, no "come in")', J(heard));
    for (const [name, tok] of [['for another challenge', { for: 'ef'.repeat(8), rq: RQ, ck: PK_SHAPE, at: Date.now() }], ['two minutes old', { for: FOR, rq: RQ, ck: PK_SHAPE, at: Date.now() - 3 * 60000 }], ['malformed', 'junk'], ['without a key', { for: FOR, rq: RQ, at: Date.now() }]]) {
      await v.eval('sessionStorage.setItem("arena.accept", ' + J(typeof tok === 'string' ? tok : J(tok)) + ')');
      await v.navigate(craft()); await panelReady(); await sleep(1500);
      const x = await view();
      ok(x.stage === 'setup' && !x.room && !x.hosting && !x.codeShown && /ignored/.test(x.status), 'PL3 a token ' + name + ' does not make the link an Accept', J(x));
    }
    heard = (await spied(spy)).filter((m) => m && (m.k === 'acc' || (m.k === 'open' && !/^H/.test(m.room))));
    ok(heard.length === 0 && v.errors.length === 0, 'PL4 still nothing announced, and no page errors', J(heard).slice(0, 200) + J(v.errors).slice(0, 200));
  });

  // C: one at a time, and cancelling
  await withBrowser({ port: CDP0 + 21, width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (hub) => {
    const c1 = await hub.openTab({ width: 900, height: 760 }), c2 = await hub.openTab({ width: 900, height: 760 });
    await openHub(hub, '&openchal=20000');
    await hub.eval('document.getElementById("openToggle").click()');
    await hub.waitFor('window.__arenaPresence.isOn() && window.__arenaPresence.presence', { timeoutMs: 30000 });
    await openPanel(c1, '&openchal=20000'); await openPanel(c2, '&openchal=20000');
    await c1.waitFor('document.querySelector("#olOpenList li[data-room^=H]")', { timeoutMs: 20000 });
    await c2.waitFor('document.querySelector("#olOpenList li[data-room^=H]")', { timeoutMs: 20000 });
    await setForm(c1, { name: 'One' }); await setForm(c2, { name: 'Two' });
    await c1.eval('document.querySelector("#olOpenList li[data-room^=H] button").click()');
    await hub.waitFor('(() => { const d = document.getElementById("challenge"); return !!d && !d.hidden; })()', { timeoutMs: 15000 });
    await c2.eval('document.querySelector("#olOpenList li[data-room^=H] button").click()');
    await c2.waitFor('window.__arenaOnline.state.stage === "setup" && /another challenge/.test(document.getElementById("olStatus").textContent)', { timeoutMs: 15000 });
    ok(/^One/.test(await hub.eval('document.getElementById("chText").textContent')), 'C1 a second challenger is told the owner is busy, and the dialog on screen is still the first one', await statusText(c2));
    await c1.eval('document.getElementById("olCancelAsk").click()');
    await hub.waitFor('(() => { const d = document.getElementById("challenge"); return !d || d.hidden; })()', { timeoutMs: 10000 });
    ok((await stageOf(c1)) === 'setup' && /Cancelled/.test(await statusText(c1)), 'C2 cancelling closes the owner\'s dialog and puts the challenger back at the board', await statusText(c1));
    await c2.waitFor('document.querySelector("#olOpenList li[data-room^=H]")', { timeoutMs: 15000 });
    await c2.eval('document.querySelector("#olOpenList li[data-room^=H] button").click()');
    await hub.waitFor('(() => { const d = document.getElementById("challenge"); return !!d && !d.hidden; })()', { timeoutMs: 15000 });
    ok(/^Two/.test(await hub.eval('document.getElementById("chText").textContent')), 'C3 and the owner can be asked again once the dialog is free', '');
    // the challenger closes the tab while it is waiting: the challenge is withdrawn at once (the dialog does not stay up for a player who has gone, for the rest of its 20 s)
    const t0 = Date.now();
    await c2.navigate('about:blank');
    const closed = await hub.waitFor('(() => { const d = document.getElementById("challenge"); return !d || d.hidden; })()', { timeoutMs: 8000 }).then(() => true, () => false);
    ok(closed && Date.now() - t0 < 8000, 'C4 a challenger who leaves the page withdraws its challenge: the owner\'s dialog closes within seconds, not after the full wait', String(Date.now() - t0));
  });

  // D: nobody answers -> the dialog closes by itself and the challenger is told
  await withBrowser({ port: CDP0 + 22, width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (hub) => {
    const ch = await hub.openTab({ width: 900, height: 760 });
    await openHub(hub, '&openchal=1500');
    await hub.eval('document.getElementById("openToggle").click()');
    await hub.waitFor('window.__arenaPresence.isOn() && window.__arenaPresence.presence', { timeoutMs: 30000 });
    await openPanel(ch, '&openchal=1500');
    await ch.waitFor('document.querySelector("#olOpenList li[data-room^=H]")', { timeoutMs: 20000 });
    await ch.eval('document.querySelector("#olOpenList li[data-room^=H] button").click()');
    await hub.waitFor('(() => { const d = document.getElementById("challenge"); return !!d && !d.hidden; })()', { timeoutMs: 15000 });
    await hub.waitFor('(() => { const d = document.getElementById("challenge"); return !d || d.hidden; })()', { timeoutMs: 10000 });
    await ch.waitFor('window.__arenaOnline.state.stage === "setup"', { timeoutMs: 10000 });
    ok(/not available/.test(await statusText(ch)) && (await hub.eval('window.__arenaHub.dialogOpen()')) === false, 'D1 a dialog nobody answers closes by itself and counts as a no, told to the challenger', await statusText(ch));
  });

  // E: the switch is remembered, listed again after a reload, and off means gone
  await withBrowser({ port: CDP0 + 23, width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (hub) => {
    const ch = await hub.openTab({ width: 900, height: 760 });
    await openHub(hub);
    await hub.eval('document.getElementById("openToggle").click()');
    await hub.waitFor('window.__arenaPresence.isOn() && window.__arenaPresence.presence', { timeoutMs: 30000 });
    await openPanel(ch);
    await ch.waitFor('document.querySelector("#olOpenList li[data-room^=H]")', { timeoutMs: 20000 });
    await openHub(hub);
    const t = await toggleState(hub);
    ok(t.pressed === 'true' && t.stored === '1', 'E1 a reload keeps the switch on', J(t));
    await ch.waitFor('document.querySelector("#olOpenList li[data-room^=H]")', { timeoutMs: 20000 });
    ok(true, 'E2 and the hub player is on the board again', '');
    await hub.eval('document.getElementById("openToggle").click()');
    const t0 = Date.now();
    await ch.waitFor('!document.querySelector("#olOpenList li[data-room^=H]")', { timeoutMs: 8000 });
    const t2 = await toggleState(hub);
    ok(t2.pressed === 'false' && t2.stored === null && Date.now() - t0 < 8000 && (await hub.eval('window.__arenaPresence.presence === null && window.__arenaPresence.lobbies === null')), 'E3 off takes the listing down at once (not after the ttl), forgets the setting and lets go of the board', J(t2) + ' ' + (Date.now() - t0));
    await openHub(hub);
    ok((await toggleState(hub)).pressed === 'false', 'E4 and a reload stays off', '');
  });

  // PF: the player is in a battle against the CPU: the challenge reaches them there, pauses the battle, and Accept leaves it
  await withBrowser({ port: CDP0 + 24, width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (me) => {
    const ch = await me.openTab({ width: 900, height: 760 });
    await me.navigate(ORIGIN + '/pokemonarena/?net=local');
    await me.eval('localStorage.setItem("arena.open", "1")');
    await me.navigate(BASE + '?net=local&anim=0&openchal=20000');
    await me.waitFor('window.__arenaBattle && window.__arenaBattle.state === "ready" && window.__arenaPresence && window.__arenaPresence.isOn()', { timeoutMs: 120000 });
    await openPanel(ch, '&openchal=20000');
    await ch.waitFor('document.querySelector("#olOpenList li[data-room^=H]")', { timeoutMs: 20000 });
    await setForm(ch, { name: 'Cleo' });
    await ch.eval('document.querySelector("#olOpenList li[data-room^=H] button").click()');
    await me.waitFor('(() => { const d = document.getElementById("challenge"); return !!d && !d.hidden; })()', { timeoutMs: 15000 });
    const paused = await me.eval('window.__arenaBattle.controlsOpen');
    ok(paused === true, 'PF1 a challenge reaches a player in the middle of a CPU battle and pauses it like the Controls panel does', String(paused));
    await me.eval('document.getElementById("chDecline").click()');
    const handedBack = await me.waitFor('window.__arenaBattle.controlsOpen === false', { timeoutMs: 5000 }).then(() => true, () => false);
    ok(handedBack, 'PF2 Not now gives the battle back', 'controlsOpen = ' + J(await me.eval('window.__arenaBattle.controlsOpen').catch(() => null)));
    if (!handedBack) return;
    await ch.waitFor('window.__arenaOnline.state.stage === "setup"', { timeoutMs: 10000 });
    // a different challenger this time, so the quiet period does not apply
    const ch2 = await me.openTab({ width: 900, height: 760 });
    await openPanel(ch2, '&openchal=20000');
    await ch2.waitFor('document.querySelector("#olOpenList li[data-room^=H]")', { timeoutMs: 20000 });
    await ch2.eval('document.querySelector("#olOpenList li[data-room^=H] button").click()');
    await me.waitFor('(() => { const d = document.getElementById("challenge"); return !!d && !d.hidden; })()', { timeoutMs: 15000 });
    await sleep(800);
    await me.eval('document.getElementById("chAccept").click()');
    const left = await me.waitFor('location.pathname === "/pokemonarena/battle.html" && new URLSearchParams(location.search).get("auto") === "host"', { timeoutMs: 30000 }).then(() => true, () => false);
    ok(left, 'PF3 Accept leaves the CPU battle for the challenger\'s', await me.eval('location.search').catch(() => 'the page is mid-navigation'));
  });

  // G: a hostile challenger
  await withBrowser({ port: CDP0 + 25, width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (hub) => {
    const raw = await hub.openTab({ width: 900, height: 760 });
    await openHub(hub, '&openchal=20000');
    await hub.eval('document.getElementById("openToggle").click()');
    await hub.waitFor('window.__arenaPresence.isOn() && window.__arenaPresence.presence', { timeoutMs: 30000 });
    const sid = await hub.eval('window.__arenaPresence.lobbies.sid');
    await raw.navigate(BASE + '?online=1&net=local' + ANIM);
    await inject(raw, { t: 'arenaopen', v: 1, k: 'chal', s: '00000000000000b1', to: sid, r: '00000000000000b2', name: '<img src=x onerror=window.__pwn=1>Zed', pk: PK_SHAPE });
    await hub.waitFor('(() => { const d = document.getElementById("challenge"); return !!d && !d.hidden; })()', { timeoutMs: 10000 });
    const d = await hub.eval('({ text: document.getElementById("chText").textContent, imgs: document.querySelectorAll("#challenge img").length, pwn: !!window.__pwn })');
    ok(/^[A-Za-z0-9 .'_!?-]{1,10} wants to battle you\.$/.test(d.text) && d.imgs === 0 && !d.pwn, 'G1 a hostile name in a challenge is plain safe text in the dialog and nothing in it runs', J(d));
    await hub.eval('document.getElementById("chDecline").click()');
    for (const bad of [{ k: 'chal' }, { k: 'chal', to: 'nobody', name: 'x' }, { k: 'dec', why: 'rude' }, { k: 'chal', name: 'N', rec: [1, 2, 3] }]) await inject(raw, { t: 'arenaopen', v: 1, s: '00000000000000b3', to: sid, r: '00000000000000b4', ...bad });
    await sleep(500);
    ok(!(await dialogOn(hub)) && hub.errors.length === 0, 'G2 malformed challenges open nothing and raise no error', J(hub.errors).slice(0, 200));
    await inject(raw, { t: 'arenaopen', v: 1, k: 'chal', s: '00000000000000b5', to: sid, r: '00000000000000b6', name: 'NoKey' });
    await sleep(500);
    ok(!(await dialogOn(hub)) && hub.errors.length === 0, 'G3 a challenge with no one-time key (an old client, or a forger) opens no dialog: there would be no private way to answer it', J(hub.errors).slice(0, 200));
  });

  // H: the switch on a phone
  for (const [w, h] of [[320, 568], [390, 844]]) await withBrowser({ port: CDP0 + 26 + (w === 390 ? 1 : 0), width: w, height: h, mobile: true, lock: false, args: NO_THROTTLE }, async (hub) => {
    await openHub(hub);
    const m = await hub.eval('(() => { const a = document.getElementById("playFriend").getBoundingClientRect(), b = document.getElementById("openToggle").getBoundingClientRect(); return { aTop: a.top, bTop: b.top, aH: a.height, bH: b.height, bW: b.width, right: Math.max(a.right, b.right), left: Math.min(a.left, b.left), vw: innerWidth, over: document.documentElement.scrollWidth - document.documentElement.clientWidth }; })()');
    ok(Math.abs(m.aTop - m.bTop) < 2 && m.bH >= 44 && m.bW >= 44 && m.left >= 0 && m.right <= m.vw && m.over <= 0, 'H' + w + ' on a ' + w + ' px phone the switch shares the link\'s row, is at least 44 css px, and nothing overflows', J(m));
    await shot(hub, 'P_phone_' + w);
  });
}

/* ---------------------------------------------------------------------------------------------- the profile: an online battle is kept in the trainer's career */
// seeds IndexedDB from inside the page with the game's own modules (what the team builder would have saved): [[trainer, [[team name, [species names]]]]] -> [{ id, teams: [teamId] }]
const SEED_PROFILES_JS = (spec) => `(async () => {
  const S = await import('/pokemonarena/js/store.js'), P = await import('/pokemonarena/js/profile.js'), R = await import('/pokemonarena/js/rules.js'), TB = await import('/pokemonarena/js/tables.js'), RF = await import('/pokemonarena/js/romfetch.js');
  const { bytes } = await RF.loadVerifiedRom();
  const pack = TB.loadPack(bytes, { verify: 'header', dexText: false });
  const store = await S.openStore();
  const mk = (name) => { const sid = pack.species.findIndex((s) => s && s.legal && s.name === name); const rec = R.blankRec(sid, pack, R.DEFAULT_RULESET_ID); const ratio = pack.species[sid].genderRatio; return P.createMon({ species: sid, level: rec.level, nature: rec.nature, abilitySlot: rec.abilitySlot, heldItem: rec.item, moves: rec.moves, ev: rec.evs, iv: rec.ivs, gender: ratio === 255 ? '-' : ratio === 254 ? 'F' : 'M' }); };
  const out = [];
  let firstId = null;
  for (const [trainer, teams] of ${J(spec)}) {
    const created = await store.createProfile({ trainerName: trainer });
    const box = [], tms = [];
    for (const [tname, names] of teams) { const mons = names.map(mk); box.push(...mons); tms.push(P.createTeam({ name: tname, monIds: mons.map((m) => m.id) })); }
    const saved = await store.saveProfile({ ...created, box, teams: tms }, { reason: 'seed' });
    if (!firstId) firstId = saved.id;
    out.push({ id: saved.id, teams: saved.teams.map((t) => t.id) });
  }
  await store.setActiveId(firstId);
  const st = store.status;
  await store.close();
  return { profiles: out, notSaved: st.notSaved };
})()`;
const LOAD_PROFILE_JS = (id) => `(async () => { const S = await import('/pokemonarena/js/store.js'); const store = await S.openStore(); const r = await store.loadProfile(${J(id)}); await store.close(); return r.ok ? { rev: r.profile.rev, schemaVersion: r.profile.schemaVersion, name: r.profile.trainerName, stats: r.profile.stats } : { error: r.code }; })()`;
// the MODES page of the RECORD screen, as the hub builds it, for one profile
const RECORD_MODES_JS = (id) => `(async () => { const S = await import('/pokemonarena/js/store.js'), H = await import('/pokemonarena/js/hub_data.js'); const store = await S.openStore(); const d = await H.readHubData(store, window.__arenaBattle.pack, { tzMinutes: 0 }); await store.close(); const p = d.profiles.find((x) => x.id === ${J(id)}); const by = p && p.record.pages.find((x) => x.id === 'by'); const rc = p && p.record.pages.find((x) => x.id === 'recent0'); const t = (pg) => pg ? pg.lines.map((l) => l.cells.map((c) => c.t).filter((x) => x !== '').join(' | ')).join('\\n') : null; return { modes: t(by), recent: t(rc) }; })()`;
const matchIdOf = (i) => (i.seed >>> 0) + '_' + i.fmt + '_o' + i.mn + '_' + i.room;
async function pickTeam(page, key, typeName) {
  await page.eval('(() => { if (' + J(typeName || null) + ') { const n = document.getElementById("olName"); n.value = ' + J(typeName || '') + '; n.dispatchEvent(new Event("input", { bubbles: true })); } const t = document.getElementById("olTeam"); t.value = ' + J(key) + '; t.dispatchEvent(new Event("change", { bubbles: true })); return true; })()');
}
const careerOf = (p) => p.eval('(() => { const c = window.__arenaBattle && window.__arenaBattle.career; return c ? { state: c.state, matchId: c.matchId, profileId: c.profileId } : null; })()');
async function finishMatch(host, guest, wantId) {
  const modes = await Promise.all([drive(host, 240000), drive(guest, 240000)]);
  for (const pg of [host, guest]) await pg.waitFor('(() => { const c = window.__arenaBattle.career; return c && c.state === "saved" && c.matchId === ' + J(wantId) + '; })()', { timeoutMs: 30000 }).catch(() => {});
  return modes;
}

async function groupProfile(S) {
  ANIM = '&anim=0';
  // the whole path: two saved profiles, a match to the end, a rematch; each trainer's career holds exactly the battles they fought, against a PERSON
  await withBrowser({ port: CDP0 + 30, width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (host) => {
    const guest = await host.openTab({ width: 900, height: 760 });
    await openRoom(host, 'APRO1', 'host');
    const seeded = await host.eval(SEED_PROFILES_JS([['ALICE', [['Alice Squad', ['Pikachu', 'Charizard', 'Snorlax']]]], ['BOBBY', [['Bobby Squad', ['Blastoise', 'Gengar', 'Eevee']]]]]));
    ok(seeded.profiles.length === 2 && !seeded.notSaved, 'F1 two saved profiles are in this browser\'s storage', J(seeded));
    const [pa, pb] = seeded.profiles;
    await openRoom(host, 'APRO1', 'host'); await openRoom(guest, 'APRO1', 'guest');       // the panels read the profiles' teams now
    const keyA = 'saved:' + pa.id + ':' + pa.teams[0], keyB = 'saved:' + pb.id + ':' + pb.teams[0];
    await pickTeam(host, keyA);
    // (the ACTIVE profile is ALICE, so ALICE would be the default name anyway: the guest's choice of BOBBY's team is what shows the name following the team)
    await pickTeam(guest, keyB);
    ok((await guest.eval('document.getElementById("olName").value')) === 'BOBBY', 'F2 choosing a saved team fills in the name of the profile that owns it', await guest.eval('document.getElementById("olName").value'));
    await pickTeam(guest, keyB, 'Zed');
    ok((await guest.eval('document.getElementById("olName").value')) === 'Zed', 'F3 a name the player typed is kept when the team changes', await guest.eval('document.getElementById("olName").value'));
    await host.eval('document.getElementById("olFmt").value = "3v3"; document.getElementById("olGo").click()');
    await host.waitFor('document.getElementById("olCode").hidden === false', { timeoutMs: 30000 });
    await guest.eval('document.getElementById("olGo").click()');
    await approve(host, true);
    const ph = await (async () => { for (let i = 0; i < 160; i++) { const [a, b] = [await phase(host), await phase(guest)]; if (a === 'playing' && b === 'playing') return [a, b]; await sleep(250); } return [await phase(host), await phase(guest)]; })();
    ok(ph[0] === 'playing' && ph[1] === 'playing', 'F4 the match starts with saved teams', J(ph));
    ok((await host.eval('window.__arenaOnline.state.profileId')) === pa.id && (await guest.eval('window.__arenaOnline.state.profileId')) === pb.id, 'F5 each page knows which profile its team belongs to', '');
    await host.waitFor('window.__arenaBattle.state === "ready"', { timeoutMs: 30000 }); await guest.waitFor('window.__arenaBattle.state === "ready"', { timeoutMs: 30000 });
    const info1 = await host.eval('window.__arenaOnline.state.info');
    const id1 = matchIdOf(info1);
    ok(/^[A-Za-z0-9_-]{1,40}$/.test(id1), 'F6 the match has a deterministic id the career accepts', id1);
    const modes = await finishMatch(host, guest, id1);
    ok(modes[0] === 'result' && modes[1] === 'result', 'F7 both scenes play to the result screen', J(modes));
    const [ca, cb] = [await careerOf(host), await careerOf(guest)];
    ok(ca && cb && ca.state === 'saved' && cb.state === 'saved' && ca.matchId === id1 && cb.matchId === id1 && ca.profileId === pa.id && cb.profileId === pb.id, 'F8 each page wrote the battle into the profile that fought it', J([ca, cb]));
    const [A, B] = [await host.eval(LOAD_PROFILE_JS(pa.id)), await host.eval(LOAD_PROFILE_JS(pb.id))];
    const sum = (r) => r.w + r.l + r.dr + r.f;
    ok(A.schemaVersion === 4 && B.schemaVersion === 4 && sum(A.stats.byCpu.online) === 1 && sum(B.stats.byCpu.online) === 1 && sum(A.stats.byCpu.easy) + sum(A.stats.byCpu.normal) + sum(A.stats.byCpu.hard) === 0 && sum(B.stats.byCpu.easy) + sum(B.stats.byCpu.normal) + sum(B.stats.byCpu.hard) === 0, 'F9 each career holds exactly one battle, in the ONLINE row and in no CPU level', J([A.stats.byCpu, B.stats.byCpu]));
    ok(A.stats.recent.length === 1 && A.stats.recent[0].cpu === 'online' && A.stats.recent[0].opp === 'Zed' && A.stats.recent[0].id === id1 && B.stats.recent[0].opp === 'ALICE' && B.stats.recent[0].fmt === '3v3', 'F10 and names the opponent: ALICE fought Zed, Zed\'s profile saw ALICE', J([A.stats.recent, B.stats.recent]));
    const ra = A.stats.recent[0].res, rb = B.stats.recent[0].res;
    ok((ra === 'w' && rb === 'l') || (ra === 'l' && rb === 'w') || (ra === 'd' && rb === 'd') || (ra === 'w' && rb === 'f') || (ra === 'f' && rb === 'w'), 'F11 the two results are opposite (or a draw)', J([ra, rb]));
    ok(A.stats.wins + A.stats.losses + A.stats.draws + A.stats.forfeits === 1 && A.stats.totals.turns > 0 && A.stats.playMs > 0, 'F12 the overall record and the totals counted it too', J([A.stats.wins, A.stats.totals.turns, A.stats.playMs]));
    const rm = await host.eval(RECORD_MODES_JS(pa.id));
    ok(/ONLINE \| \d+ \| \d+ \| \d+ \| \d+/.test(rm.modes) && /ONLINE/.test(rm.recent) && /VS Zed/.test(rm.recent), 'F13 the Record screen shows an ONLINE row and the battle against Zed', J(rm));
    await shot(host, 'F_result_host');
    // a reload AT THE RESULT SCREEN (the finished match is gone, the setup is back) leaves the record as it was. That is all this case runs: the claim that the same match id folds once is proved in
    // Node (pokemonarena_netmatch_test.mjs case O: a page reloaded INTO a match computes the same id; pokemonarena_career_test.mjs: an id folded twice changes nothing)
    const rev1 = A.rev;
    await host.eval('setTimeout(() => location.reload(), 10); true'); await sleep(1500); await host.waitFor('window.__arenaOnline && document.getElementById("olGo")', { timeoutMs: 60000 });
    const A2 = await host.eval(LOAD_PROFILE_JS(pa.id));
    ok(sum(A2.stats.byCpu.online) === 1 && A2.stats.recent.length === 1 && A2.rev === rev1, 'F14 reloading the page does not count the battle again', J([sum(A2.stats.byCpu.online), A2.rev, rev1]));
  });
  await withBrowser({ port: CDP0 + 31, width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (host) => {
    const guest = await host.openTab({ width: 900, height: 760 });
    await openRoom(host, 'APRO2', 'host');
    const seeded = await host.eval(SEED_PROFILES_JS([['ALICE', [['Alice Squad', ['Pikachu', 'Charizard', 'Snorlax']]]], ['BOBBY', [['Bobby Squad', ['Blastoise', 'Gengar', 'Eevee']]]]]));
    const [pa, pb] = seeded.profiles;
    await openRoom(host, 'APRO2', 'host'); await openRoom(guest, 'APRO2', 'guest');
    await pickTeam(host, 'saved:' + pa.id + ':' + pa.teams[0]); await pickTeam(guest, 'saved:' + pb.id + ':' + pb.teams[0]);
    await host.eval('document.getElementById("olFmt").value = "3v3"; document.getElementById("olGo").click()');
    await host.waitFor('document.getElementById("olCode").hidden === false', { timeoutMs: 30000 });
    await guest.eval('document.getElementById("olGo").click()');
    await approve(host, true);
    for (let i = 0; i < 160 && !((await phase(host)) === 'playing' && (await phase(guest)) === 'playing'); i++) await sleep(250);
    await host.waitFor('window.__arenaBattle.state === "ready"', { timeoutMs: 30000 }); await guest.waitFor('window.__arenaBattle.state === "ready"', { timeoutMs: 30000 });
    const id1 = matchIdOf(await host.eval('window.__arenaOnline.state.info'));
    await finishMatch(host, guest, id1);
    // REMATCH: both ask; a new seed and a new match number; the career gets a second, separate battle
    await Promise.all([host.eval('window.__arenaOnline.onResult("REMATCH")'), guest.eval('window.__arenaOnline.onResult("REMATCH")')]);
    await host.waitFor('window.__arenaOnline.state.info && window.__arenaOnline.state.info.mn === 2 && window.__arenaBattle.mountCount >= 2', { timeoutMs: 60000 });
    await guest.waitFor('window.__arenaOnline.state.info && window.__arenaOnline.state.info.mn === 2 && window.__arenaBattle.mountCount >= 2', { timeoutMs: 60000 });
    const info2 = await host.eval('window.__arenaOnline.state.info');
    const id2 = matchIdOf(info2);
    ok(id2 !== id1 && info2.mn === 2, 'F15 a rematch is a new match with its own id', id1 + ' / ' + id2);
    await finishMatch(host, guest, id2);
    const [A, B] = [await host.eval(LOAD_PROFILE_JS(pa.id)), await host.eval(LOAD_PROFILE_JS(pb.id))];
    const sum = (r) => r.w + r.l + r.dr + r.f;
    ok(sum(A.stats.byCpu.online) === 2 && sum(B.stats.byCpu.online) === 2 && A.stats.recent.length === 2 && B.stats.recent.length === 2 && new Set(A.stats.recent.map((r) => r.id)).size === 2 && A.stats.recent[0].id === id2 && A.stats.recent[1].id === id1, 'F16 a rematch adds a second battle to each career, newest first, none counted twice', J([A.stats.recent.map((r) => r.id), id1, id2]));
    ok(A.stats.wins + A.stats.losses + A.stats.draws + A.stats.forfeits === 2 && A.stats.wins === B.stats.losses + B.stats.forfeits && B.stats.wins === A.stats.losses + A.stats.forfeits, 'F17 and the two careers mirror each other (every win is the other\'s loss)', J([A.stats.wins, A.stats.losses, B.stats.wins, B.stats.losses]));
    ok(host.errors.length === 0 && guest.errors.length === 0, 'F18 no page errors', J(host.errors.concat(guest.errors)).slice(0, 200));
    // the profile in the lobby: a public game shows the trainer's record beside the name
    const third = await host.openTab({ width: 900, height: 760 });
    await openPanel(third); await openPanel(host);
    await pickTeam(host, 'saved:' + pa.id + ':' + pa.teams[0]);
    await host.eval('document.getElementById("olFmt").value = "3v3"; if (document.getElementById("olPublic").getAttribute("aria-pressed") !== "true") document.getElementById("olPublic").click(); document.getElementById("olGo").click()');
    await host.waitFor('document.getElementById("olCode").hidden === false', { timeoutMs: 30000 });
    await third.waitFor('document.querySelectorAll("#olOpenList li").length === 1', { timeoutMs: 20000 });
    const want = A.stats.byCpu.online.w + '-' + (A.stats.byCpu.online.l + A.stats.byCpu.online.f);
    const row = await third.eval('(() => { const li = document.querySelector("#olOpenList li"); const r = li.querySelector(".rec"); return { who: li.querySelector(".who").textContent, rec: r ? r.textContent : null }; })()');
    ok(row.who === 'ALICE' && row.rec === want, 'F19 the open game shows the trainer\'s name and online record (' + want + ')', J(row));
  });

  // a battle that is STOPPED (a malformed or hostile message) never reaches the result screen, so it writes nothing to either career
  await withBrowser({ port: CDP0 + 32, width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (host) => {
    const guest = await host.openTab({ width: 900, height: 760 });
    await openRoom(host, 'APRO3', 'host');
    const seeded = await host.eval(SEED_PROFILES_JS([['ALICE', [['Alice Squad', ['Pikachu', 'Charizard', 'Snorlax']]]], ['BOBBY', [['Bobby Squad', ['Blastoise', 'Gengar', 'Eevee']]]]]));
    const [pa, pb] = seeded.profiles;
    await openRoom(host, 'APRO3', 'host'); await openRoom(guest, 'APRO3', 'guest');
    await pickTeam(host, 'saved:' + pa.id + ':' + pa.teams[0]); await pickTeam(guest, 'saved:' + pb.id + ':' + pb.teams[0]);
    await host.eval('document.getElementById("olFmt").value = "3v3"; document.getElementById("olGo").click()');
    await host.waitFor('document.getElementById("olCode").hidden === false', { timeoutMs: 30000 });
    await guest.eval('document.getElementById("olGo").click()');
    await approve(host, true);
    for (let i = 0; i < 160 && !((await phase(host)) === 'playing' && (await phase(guest)) === 'playing'); i++) await sleep(250);
    await host.waitFor('window.__arenaBattle.state === "ready"', { timeoutMs: 30000 }); await guest.waitFor('window.__arenaBattle.state === "ready"', { timeoutMs: 30000 });
    await guest.eval('window.__arenaOnline.session()._send({ t: "lsarena", v: 1, mn: 1, k: "bye", why: "cheat" })');
    await host.waitFor('window.__arenaOnline.state.stage === "failed"', { timeoutMs: 30000 });
    await sleep(1800);
    const sum = (r) => r.w + r.l + r.dr + r.f;
    const [A, B] = [await host.eval(LOAD_PROFILE_JS(pa.id)), await host.eval(LOAD_PROFILE_JS(pb.id))];
    ok(sum(A.stats.byCpu.online) === 0 && sum(B.stats.byCpu.online) === 0 && A.stats.wins + A.stats.losses === 0 && A.stats.recent.length === 0 && B.stats.recent.length === 0, 'F20 a stopped battle writes nothing to either career', J([A.stats.byCpu.online, B.stats.byCpu.online]));
    const c = await careerOf(host);
    ok(!c || c.state === 'idle', 'F21 and the page never started a career write', J(c));
  });

  // a match the END-OF-MATCH COMPARISON stops AFTER the engine finished it (the guard in battle_boot.js onMatchEnd: nm.countable())
  const pm = fs.readFileSync(path.join(root, 'pokemonarena', 'ONLINE.md'), 'utf8').match(/`profile --mutants` does the same for the write of a match the end-of-match comparison stopped, (\d+) of them/);
  ok(!!pm && Number(pm[1]) === PROFILE_MUTANTS.length, 'F25 pokemonarena/ONLINE.md states how many ways `profile --mutants` breaks the page (' + PROFILE_MUTANTS.length + ')', pm ? 'ONLINE.md says ' + pm[1] : 'the sentence is not in ONLINE.md');
  await profileDesync({ origin: ORIGIN, ok, cdp: CDP0 + 33 });
  if (process.argv.includes('--mutants')) await profileMutants();
}

// F22-F24. The other machine's final message names another position than this machine's engine ends in: the comparison (netmatch.js checkEnd) fails the match although it is already 'over', the
// page shows the error panel and hides the battle canvas -- but the scene underneath still plays its last turn and reaches its result screen, and THAT is where the page writes the career.
// Without the guard in onMatchEnd the page would keep a battle the protocol has just refused. The hostile peer is made the way the netmatch test makes it: a forged `end` (a made-up final
// position, why 'result') is delivered to the host's protocol instance mid-match; the first `end` is the one kept, so the real guest's genuine one changes nothing, and the host's comparison
// fails the moment its own engine finishes. The honest guest records its battle, which is the control: this rig CAN write one. c = { origin, ok, cdp }.
async function profileDesync(c) {
  const { ok } = c;
  const base = c.origin + '/pokemonarena/battle.html';
  await withBrowser({ port: c.cdp, width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (host) => {
    const guest = await host.openTab({ width: 900, height: 760 });
    await openRoom(host, 'APRO4', 'host', '', base);
    const seeded = await host.eval(SEED_PROFILES_JS([['ALICE', [['Alice Squad', ['Pikachu', 'Charizard', 'Snorlax']]]], ['BOBBY', [['Bobby Squad', ['Blastoise', 'Gengar', 'Eevee']]]]]));
    const [pa, pb] = seeded.profiles;
    await openRoom(host, 'APRO4', 'host', '', base); await openRoom(guest, 'APRO4', 'guest', '', base);
    await pickTeam(host, 'saved:' + pa.id + ':' + pa.teams[0]); await pickTeam(guest, 'saved:' + pb.id + ':' + pb.teams[0]);
    await host.eval('document.getElementById("olFmt").value = "3v3"; document.getElementById("olGo").click()');
    await host.waitFor('document.getElementById("olCode").hidden === false', { timeoutMs: 30000 });
    await guest.eval('document.getElementById("olGo").click()');
    await approve(host, true);
    for (let i = 0; i < 160 && !((await phase(host)) === 'playing' && (await phase(guest)) === 'playing'); i++) await sleep(250);
    await host.waitFor('window.__arenaBattle.state === "ready"', { timeoutMs: 30000 }); await guest.waitFor('window.__arenaBattle.state === "ready"', { timeoutMs: 30000 });
    await host.eval(`(() => { const O = window.__arenaOnline; O.nm().receive({ t: 'lsarena', v: 1, mn: O.state.info.mn, k: 'end', win: 0, h: 'forged-final-position', why: 'result' }); return true; })()`);
    const modes = await Promise.all([drive(host, 240000), drive(guest, 240000)]);
    await host.waitFor('(() => { const c = window.__arenaBattle.career; return !!c && c.state !== "idle" && c.state !== "pending"; })()', { timeoutMs: 15000 }).catch(() => {});
    await guest.waitFor('(() => { const c = window.__arenaBattle.career; return !!c && c.state === "saved"; })()', { timeoutMs: 30000 }).catch(() => {});
    await sleep(1800);                                    // a wrongly started write has had time to land
    const [sh, sg] = [await nmStatus(host), await nmStatus(guest)];
    const view = await host.eval('(() => { const B = window.__arenaBattle; return { mode: B.scene.mode, canvasHidden: document.getElementById("battle").hidden, stage: window.__arenaOnline.state.stage, sceneCareer: B.scene.S.career ? B.scene.S.career.state : null, why: B.career.why || null }; })()');
    ok(modes[0] === 'result' && sh.phase === 'failed' && sh.error && sh.error.code === 'desync' && view.stage === 'failed' && view.canvasHidden === true, 'F22 the host\'s end-of-match comparison stopped the match AFTER its engine had finished it (phase failed, desync, the error panel up, the battle canvas hidden) while its scene underneath still reached the result screen', J({ modes, phase: sh.phase, error: sh.error && sh.error.code, view }));
    const sum = (r) => r.w + r.l + r.dr + r.f;
    const [A, B] = [await host.eval(LOAD_PROFILE_JS(pa.id)), await host.eval(LOAD_PROFILE_JS(pb.id))];
    const cA = await careerOf(host);
    ok(sum(A.stats.byCpu.online) === 0 && A.stats.wins + A.stats.losses + A.stats.draws + A.stats.forfeits === 0 && A.stats.recent.length === 0 && cA && cA.state === 'none' && view.why === 'match-stopped', 'F23 and the match the protocol refused is NOT written to the host\'s profile: no online battle, no recent entry, and the page says why (career none, match-stopped), not that there was nothing to save into', J({ online: A.stats.byCpu.online, recent: A.stats.recent.length, career: cA, why: view.why }));
    const cB = await careerOf(guest);
    ok(sg.phase === 'over' && modes[1] === 'result' && cB && cB.state === 'saved' && sum(B.stats.byCpu.online) === 1 && B.stats.recent.length === 1, 'F24 control: the honest guest, whose comparison passed, DID record the same battle (so the host\'s empty record in F23 is the guard, not a rig that cannot write)', J({ phase: sg.phase, career: cB, online: B.stats.byCpu.online }));
  });
}
// every defect below must fail the NAMED case (the session is run against a copy of the game with only that defect in it; the same machinery as presenceui / onlineux --mutants)
const PROFILE_MUTANTS = [
  { id: 'P01', what: 'the battle page writes the career of a match the end-of-match comparison stopped (the nm.countable() guard in onMatchEnd is gone)', file: 'js/battle_boot.js', from: "if (st.nm && typeof st.nm.countable === 'function' && !st.nm.countable()) { career.state = 'none'; career.why = 'match-stopped'; return; }", to: '', fails: 'F23' },
  { id: 'P02', what: 'countable() ignores whether the match was stopped (it only asks for the engine\'s result)', file: 'js/netmatch.js', from: 'return !dead() && !!nm.ctl && nm.ctl.winner !== null;', to: 'return !!nm.ctl && nm.ctl.winner !== null;', fails: 'F23' },
];
async function profileMutants() {
  if (REMOTE) { ok(true, 'PMUT (skipped against a deployed site)'); return; }
  const { copyTree, mutateFile, startOverlay } = await import('./pokemonarena_overlay.mjs');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-profile-mut-'));
  let killed = 0, ran = 0;
  try {
    for (const mu of PROFILE_MUTANTS) {
      const failed = [];
      const rec = (cond, name, detail) => { if (!cond) failed.push(name + (detail ? ' :: ' + String(detail).slice(0, 160) : '')); };
      ran++;
      const dir = copyTree(path.join(root, 'pokemonarena'), path.join(tmp, mu.id));
      let ov = null;
      try {
        try { mutateFile(dir, mu.file, mu.from, mu.to); } catch (e) { ok(false, 'PMUT ' + mu.id + ' could not be applied', e.message); continue; }
        ov = await startOverlay({ dir, port: PORT + 20, upstream: ORIGIN });
        try { await profileDesync({ origin: ov.url, ok: rec, cdp: CDP0 + 33 }); } catch (e) { failed.push('session crashed :: ' + String(e && e.message ? e.message : e).slice(0, 120)); }
      } finally { if (ov) ov.stop(); }
      const hit = failed.find((f) => f.startsWith(mu.fails + ' '));
      ok(!!hit, 'PMUT ' + mu.id + ' (' + mu.what + ') fails ' + mu.fails, hit ? '' : 'it did NOT: failed cases = ' + J(failed.map((f) => f.slice(0, 60))));
      if (hit) killed++;
    }
  } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_e) { /* ignore */ } }
  console.log(`profile mutants: ${killed}/${ran} killed`);
}

/* ---------------------------------------------------------------------------------------------- presenceui: the dialogs and the switch, DRIVEN THE WAY A PLAYER DOES */
// A fake gamepad (navigator.getGamepads, as tools/pokemonarena_editor_page_test.mjs does), real key events (Input.dispatchKeyEvent), a real mouse and real touch, against the page's own
// dialogs. Every case id starts with U (UK keys, UA accept and the drift guard, US stack, UB battle, UX cross-tab, UR refresh/re-mount, UQ the record on the board, UP rapid, UD disclosure, UM mouse, UW the words and
// UN the accessible name, UT touch, UO the CPU battle's Open button (UL its layout), UH hidden switch / button).
// ARENA_UI=drift,record,words,battlebtn runs only those sessions (keys accept drift stack cross refresh record rapid disclosure words touch battlebtn hidden).
//   node tools/pokemonarena_online_page_test.mjs presenceui             the cases
//   node tools/pokemonarena_online_page_test.mjs presenceui --mutants   ALSO serve a copy of the game with ONE defect at a time (tools/pokemonarena_overlay.mjs); each must fail the named case
// A challenge is made the way group G makes a hostile one: another tab of the same browser speaks on the board's channel, addressed to the page's sid. It also LISTENS, so "the challenger was
// told Not now" and "the listing is (not) on the board" are read off the wire, not off the page under test.
const UI_PAD_INIT = `(() => {
  const pad = { id: 'Xbox 360 Controller (STANDARD GAMEPAD Vendor: 045e Product: 028e)', index: 0, connected: true, mapping: 'standard', timestamp: 0, axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })) };
  window.__pad = pad; window.__padOn = false;
  navigator.getGamepads = () => [window.__padOn ? pad : null, null, null, null];
  window.__padConnect = () => { window.__padOn = true; const e = new Event('gamepadconnected'); e.gamepad = pad; window.dispatchEvent(e); };
  window.__padTap = (i, ms) => new Promise((res) => { pad.buttons[i].pressed = true; pad.buttons[i].value = 1; setTimeout(() => { pad.buttons[i].pressed = false; pad.buttons[i].value = 0; setTimeout(res, 70); }, ms || 100); });
})()`;
// delays the first N indexedDB.open() calls made after the page sets window.__idbDelays = [ms, ...] (a slow disk): lets two begin()s finish in the opposite order to the one they started in
const UI_IDB_DELAY_INIT = `(() => {
  const orig = IDBFactory.prototype.open;
  window.__idbDelays = [];
  IDBFactory.prototype.open = function (...a) {
    const d = window.__idbDelays.length ? window.__idbDelays.shift() : 0;
    if (!d) return orig.apply(this, a);
    const self = this; let real = null;
    const fake = { onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null, get result() { return real && real.result; }, get error() { return real && real.error; } };
    setTimeout(() => { real = orig.apply(self, a); real.onsuccess = (ev) => fake.onsuccess && fake.onsuccess(ev); real.onerror = (ev) => fake.onerror && fake.onerror(ev); real.onblocked = (ev) => fake.onblocked && fake.onblocked(ev); real.onupgradeneeded = (ev) => fake.onupgradeneeded && fake.onupgradeneeded(ev); }, d);
    return fake;
  };
})()`;
// makes indexedDB.open() FAIL while window.__idbFail is true (a storage that cannot be opened right now): openStore() never throws for that, it answers with an EMPTY in-memory copy and says so (status.fellBack)
const UI_IDB_FAIL_INIT = `(() => {
  const orig = IDBFactory.prototype.open;
  window.__idbFail = false;
  IDBFactory.prototype.open = function (...a) {
    if (!window.__idbFail) return orig.apply(this, a);
    const fake = { onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null, result: null, error: new DOMException('simulated: the storage cannot be opened', 'UnknownError') };
    setTimeout(() => { if (fake.onerror) fake.onerror(new Event('error')); }, 0);
    return fake;
  };
})()`;
// the name and the pressed state CHROME computes for an element (the accessibility tree), not the attributes the page wrote
async function uiAx(p, sel) {
  const r = await p.send('Runtime.evaluate', { expression: 'document.querySelector(' + J(sel) + ')' });
  const t = await Promise.race([p.send('Accessibility.getPartialAXTree', { objectId: r.result.objectId, fetchRelatives: false }), sleep(10000).then(() => ({ nodes: [{ name: { value: 'TIMEOUT: no accessibility tree in 10 s' } }] }))]);       // a page that is not in front never produces the frame it waits for
  const n = (t.nodes || [])[0] || {};
  const prop = (k) => { const x = (n.properties || []).find((q) => q.name === k); return x && x.value ? x.value.value : undefined; };
  return { name: n.name ? n.name.value : null, role: n.role ? n.role.value : null, pressed: prop('pressed') };
}
const UI_PADI = { a: 0, b: 1, up: 12, down: 13, left: 14, right: 15 };
const UI_KEYS = { x: ['x', 'KeyX', 88], backspace: ['Backspace', 'Backspace', 8], escape: ['Escape', 'Escape', 27], z: ['z', 'KeyZ', 90], enter: ['Enter', 'Enter', 13], right: ['ArrowRight', 'ArrowRight', 39] };
const uiPad = (p, n, ms = 120) => p.eval(`window.__padTap(${UI_PADI[n]}, ${ms})`);
const uiKey = (p, n, hold = 70) => p.press(UI_KEYS[n][0], UI_KEYS[n][1], UI_KEYS[n][2], hold);
// Enter WITH its character: without `text` Chrome does not activate a focused button from a synthetic key event
const uiEnter = async (p) => { await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }); await sleep(50); await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }); };
const uiKeyEdge = (p, n, type) => p.key(type, UI_KEYS[n][0], UI_KEYS[n][1], { windowsVirtualKeyCode: UI_KEYS[n][2] });
const uiUntil = async (p, expr, ms = 8000) => { try { await p.waitFor(expr, { timeoutMs: ms, pollMs: 80 }); return true; } catch (_e) { return false; } };
const UI_DLG = (id = 'challenge') => `(() => { const d = document.getElementById(${J(id)}); return !!d && !d.hidden; })()`;
const uiDlgGone = (id = 'challenge') => `(() => { const d = document.getElementById(${J(id)}); return !d || d.hidden; })()`;
const uiCenter = (p, sel) => p.eval(`(() => { const e = document.querySelector(${J(sel)}); e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; })()`);
const uiFront = (p) => p.send('Page.bringToFront');
const uiErrs = (...ps) => ps.flatMap((p) => p.errors).filter((e) => !/favicon.ico/.test(e));          // the JSON document the watcher tab shows has no icon: that 404 is not the page's
const UI_TOP_AT = (sel) => `(() => { const b = document.querySelector(${J(sel)}).getBoundingClientRect(); const e = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return e && (e.id || e.tagName); })()`;
let uiSeq = 0;
const UI_PK = 'A'.repeat(43) + '.' + 'B'.repeat(43);
// "some other browser" asks the page's sid for a battle. Distinct sender and request ids every time (a sender told no is answered no quietly for 20 s).
async function uiChal(raw, sid, name = 'Zed') {
  uiSeq++;
  const s = '000000000000' + (0xb000 + uiSeq).toString(16), r = '000000000000' + (0xc000 + uiSeq).toString(16);
  await inject(raw, { t: 'arenaopen', v: 1, k: 'chal', s, to: sid, r, name, pk: UI_PK });          // a challenge without a one-time key is not shown (openlobby.js checkBeacon); only its SHAPE is checked there, so a made-up one opens the dialog
  return { s, r };
}
// a tab that only listens on the board's channel: __msgs = everything, __live = who is listed right now (the last beacon of each sender, dropped by its "gone")
const UI_WATCH = `(() => { window.__msgs = []; window.__live = {}; const c = new BroadcastChannel('bemental-arena-open-1'); c.onmessage = (e) => { const m = e.data; if (!m || m.t !== 'arenaopen') return; window.__msgs.push(m); if (m.k === 'open') window.__live[m.s] = { room: m.room, name: m.name, rec: m.rec || null, h: m.h || 0, at: Date.now() }; else if (m.k === 'gone') delete window.__live[m.s]; }; window.__ch = c; return true; })()`;
const uiWatcher = async (raw, origin) => { await raw.navigate(origin + '/pokemonarena/manifest.json'); await raw.eval(UI_WATCH); };
const uiLive = (raw, ms = 6000) => raw.eval(`Object.entries(window.__live).filter(([s, g]) => Date.now() - g.at < ${ms}).map(([s, g]) => ({ s, name: g.name, rec: g.rec }))`);
const uiTold = (raw, q) => raw.eval(`window.__msgs.filter((m) => m.k === 'dec' && m.r === ${J(q.r)}).map((m) => m.why)`);
const uiHubReady = (p) => p.waitFor('window.__arenaHub && window.__arenaHub.state === "ready" && window.__arenaPresence', { timeoutMs: 120000 });
// the hub with the stored switch ON (a second load: the first one is where localStorage can be written from)
async function uiHubOn(p, origin, extra = '') {
  await p.navigate(origin + '/pokemonarena/?net=local' + extra);
  await p.eval('localStorage.setItem("arena.open", "1")');
  await p.navigate(origin + '/pokemonarena/?net=local' + extra);
  await uiHubReady(p);
  await p.waitFor('window.__arenaPresence.isOn() && window.__arenaPresence.presence', { timeoutMs: 30000 });
}
const uiSid = (p) => p.eval('window.__arenaPresence.lobbies.sid');

// ---- UK: B / X / Backspace / Escape / gamepad B decline the challenge, and leave nothing held
async function uiKeys(c) {
  const { ok } = c;
  await withBrowser({ port: c.cdp(0), width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (hub) => {
    await hub.send('Page.addScriptToEvaluateOnNewDocument', { source: UI_PAD_INIT });
    const raw = await hub.openTab({ width: 900, height: 760 });
    await uiHubOn(hub, c.origin);
    await uiWatcher(raw, c.origin);
    await uiFront(hub); await hub.eval('window.__padConnect()'); await sleep(250);
    await hub.eval('(() => { window.__bPress = 0; window.__arenaHub.input.on("action", (e) => { if (e.action === "b" && e.pressed) window.__bPress++; }); })()');
    const sid = await uiSid(hub);
    const routes = [['UK1', 'gamepad B', () => uiPad(hub, 'b')], ['UK2', 'the X key', () => uiKey(hub, 'x')], ['UK3', 'Backspace', () => uiKey(hub, 'backspace')], ['UK4', 'Escape', () => uiKey(hub, 'escape')]];
    for (const [id, label, press] of routes) {
      const q = await uiChal(raw, sid);
      const shown = await uiUntil(hub, UI_DLG());
      const before = shown ? await hub.eval('({ focus: document.activeElement && document.activeElement.id, close: document.getElementById("chDecline").hasAttribute("data-nav-close"), paused: window.__arenaHub.dialogOpen() })') : null;
      await press();
      const closed = await uiUntil(hub, uiDlgGone(), 3000);
      await sleep(150);
      const after = await hub.eval('({ paused: window.__arenaHub.dialogOpen(), held: window.__arenaHub.input.isDown("b"), n: window.__bPress, canvasFocus: document.activeElement === window.__arenaHub.canvas })');
      await uiKey(hub, 'x'); await sleep(120);            // B is alive: a fresh press must still be heard (a B held for good by a stray synthetic Escape swallows every later one)
      const alive = await hub.eval('({ n: window.__bPress, held: window.__arenaHub.input.isDown("b") })');
      const told = await uiTold(raw, q);
      ok(shown && before.focus === 'chDecline' && before.close && before.paused === true && closed && after.paused === false && after.held === false && alive.n === after.n + 1 && alive.held === false && told.includes('declined'),
        id + ' ' + label + ' declines the challenge: the dialog closes, the hub is live again, the challenger is told Not now, and B is not left held', J({ before, closed, after, alive, told }));
      if (id === 'UK1') await shot(hub, 'U_keys_after_decline');
    }
    // a click on Not now (the mouse), and the module's own Escape fallback for an input layer that did not start
    const q5 = await uiChal(raw, sid);
    await uiUntil(hub, UI_DLG());
    await shot(hub, 'U_dialog_desktop');
    const p5 = await uiCenter(hub, '#chDecline');
    await hub.click(p5.x, p5.y);
    ok(await uiUntil(hub, uiDlgGone(), 3000) && (await uiTold(raw, q5)).includes('declined'), 'UK5 a mouse click on Not now declines it', J(await uiTold(raw, q5)));
    const fb = await hub.eval(`(async () => {
      const m = await import('/pokemonarena/js/presence_boot.js'); let declined = 0, closed = 0;
      const d = m.mountDialog({ doc: document, win: window, input: null, enableDomNav: null, ids: { root: 'tstDlg', title: 'tstT', text: 'tstX', sub: 'tstS', ok: 'tstOk', cancel: 'tstNo', flag: 'tstdlg' }, heading: 'T', okLabel: 'OK', cancelLabel: 'No', inertMs: 0, onCancel: () => { declined++; }, onClose: () => { closed++; } });
      d.show({ text: 'x', sub: '' });
      const focus = document.activeElement && document.activeElement.id;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: false })); document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', bubbles: true }));
      const r = { focus, declined, closed, open: d.isOpen() }; d.destroy(); return r; })()`);
    ok(fb.focus === 'tstNo' && fb.declined === 1 && fb.closed === 1 && fb.open === false, 'UK6 with no input layer the dialog still takes the safe button and Escape declines it', J(fb));
    ok(uiErrs(hub, raw).length === 0, 'UK7 no page errors', J(uiErrs(hub, raw)).slice(0, 300));
  });
}

// ---- UA: Accept is inert for 600 ms, and a button the focus only DRIFTED onto is not a decision
async function uiAccept(c) {
  const { ok } = c;
  await withBrowser({ port: c.cdp(1), width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (hub) => {
    await hub.send('Page.addScriptToEvaluateOnNewDocument', { source: UI_PAD_INIT });
    const raw = await hub.openTab({ width: 900, height: 760 });
    await uiHubOn(hub, c.origin);
    await uiWatcher(raw, c.origin);
    await uiFront(hub); await hub.eval('window.__padConnect()'); await sleep(250);
    const sid = await uiSid(hub);
    const t0 = await hub.eval('performance.now()');
    const q1 = await uiChal(raw, sid);
    await uiUntil(hub, UI_DLG());
    // inside the first 600 ms: Accept is disabled, the pad's Right cannot reach it, and a press of "click" does nothing
    const w = await hub.eval(`(async () => { const a = document.getElementById('chAccept'); const r = { disabled: a.disabled, focus0: document.activeElement.id }; await window.__padTap(15, 60); r.focus1 = document.activeElement.id; a.click(); r.open = !document.getElementById('challenge').hidden; r.elapsed = performance.now() - ${t0}; return r; })()`);
    ok(w.disabled === true && w.focus0 === 'chDecline' && w.focus1 === 'chDecline' && w.open === true && w.elapsed < 600, 'UA1 Accept is inert (disabled) for its first 600 ms: the pad cannot focus it and a click on it does nothing', J(w));
    await sleep(750);
    const woke = await hub.eval('document.getElementById("chAccept").disabled');
    ok(woke === false, 'UA2 and it wakes up after that', String(woke));
    await hub.eval('document.getElementById("chDecline").click()');
    await uiUntil(hub, uiDlgGone(), 3000);
    // a key held since BEFORE the dialog appeared keeps repeating towards Accept once it is awake: the focus drifts onto it, and neither Z nor Enter may take it
    await uiKeyEdge(hub, 'right', 'keyDown'); await sleep(250);
    const q2 = await uiChal(raw, sid);
    await uiUntil(hub, UI_DLG());
    const drifted = await uiUntil(hub, 'document.activeElement && document.activeElement.id === "chAccept"', 6000);
    await uiKey(hub, 'z'); await sleep(300); await uiEnter(hub); await sleep(400);
    const still = await hub.eval('(() => { const d = document.getElementById("challenge"); return { open: !!d && !d.hidden, path: location.pathname }; })()');
    ok(drifted && still.open && still.path === '/pokemonarena/', 'UA3 the focus drifted onto Accept by a held key repeating: Z and Enter do not accept (the rig reached the state: ' + drifted + ')', J(still));
    // let go, press Right afresh (a decision), then A: it goes
    await uiKeyEdge(hub, 'right', 'keyUp'); await sleep(200);
    await uiKey(hub, 'right'); await sleep(200);
    await uiKey(hub, 'z');
    const went = await uiUntil(hub, 'location.pathname === "/pokemonarena/battle.html"', 20000);
    const u = went ? new URL(await hub.eval('location.href')) : null;
    ok(went && u.searchParams.get('auto') === 'host' && u.searchParams.get('for') === q2.s && u.searchParams.get('rq') === q2.r, 'UA4 a fresh press on Accept and then A does accept, and takes the player to the challenger\'s battle', u ? u.search : 'no navigation');
  });
}

// ---- UA5 / UA6: the same drift guard with the challenge STACKED over another dialog. The Controls dialog and the Sound panel subscribed to the input layer before the challenge existed, so THEIR navigation
// moves the focus first, and a guard that looked at where the focus was when the press reached it saw "already on Accept" and never armed (hold Right, a challenge arrives over Controls, Z carried the player off).
async function uiDrift(c) {
  const { ok } = c;
  await withBrowser({ port: c.cdp(1), width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (hub) => {
    const raw = await hub.openTab({ width: 900, height: 760 });
    await uiWatcher(raw, c.origin);
    const stacks = [
      ['UA5', 'the Controls dialog', 'window.__arenaHub.openControls()', '!document.getElementById("controlsDialog").hidden && window.__arenaHub.dialogOpen()', 'true'],
      // the Sound panel opens with its Master SLIDER focused, and the input layer leaves arrow keys to a slider (they are its own), so Right would never be "held" there: the key goes down on a button
      ['UA6', 'the Sound panel', 'document.getElementById("soundBtn").click()', '(() => { const e = document.querySelector(".arena-snd"); return !!e && !e.hidden && window.__arenaHub.dialogOpen(); })()', 'document.querySelector(".arena-snd [data-snd=mute]").focus()'],
    ];
    for (const [id, label, open, isOpen, prep] of stacks) {
      await uiHubOn(hub, c.origin);                          // a fresh hub each time: the Accept at the end of a round leaves the page
      await uiFront(hub);
      const sid = await uiSid(hub);
      await hub.eval(open);
      const up = await uiUntil(hub, isOpen);
      await hub.eval(prep);
      await uiKeyEdge(hub, 'right', 'keyDown'); await sleep(300);          // Right is held BEFORE the challenge exists; the dialog under it is navigating with it
      const held = await hub.eval('window.__arenaHub.input.isDown("right")');
      const q = await uiChal(raw, sid, 'Stacked');
      await uiUntil(hub, UI_DLG());
      const drifted = await uiUntil(hub, 'document.activeElement && document.activeElement.id === "chAccept"', 6000);
      await uiKey(hub, 'z'); await sleep(300); await uiEnter(hub); await sleep(400);
      const still = await hub.eval('(() => { const d = document.getElementById("challenge"); return { open: !!d && !d.hidden, path: location.pathname }; })()');
      ok(up && held && drifted && still.open && still.path === '/pokemonarena/', id + ' a challenge over ' + label + ': the focus drifted onto Accept by a held key repeating, and Z and Enter do not accept (the rig reached the state: ' + J({ up, held, drifted }) + ')', J(still));
      // let go, press Right afresh (a decision), then A: it goes, so the guard that holds here is not simply "never"
      await uiKeyEdge(hub, 'right', 'keyUp'); await sleep(200);
      await uiKey(hub, 'right'); await sleep(200);
      await uiKey(hub, 'z');
      const went = await uiUntil(hub, 'location.pathname === "/pokemonarena/battle.html"', 20000);
      const u = went ? new URL(await hub.eval('location.href')) : null;
      ok(went && u.searchParams.get('rq') === q.r, id + 'b and over ' + label + ' a fresh press on Accept and then A does accept', u ? u.search : 'no navigation');
    }
  });
}

// ---- US: the challenge over the Controls dialog and over the Sound panel (the page's pause state is a SET of owners, and the challenge is the top of the stack)
async function uiStack(c) {
  const { ok } = c;
  await withBrowser({ port: c.cdp(2), width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (hub) => {
    await hub.send('Page.addScriptToEvaluateOnNewDocument', { source: UI_PAD_INIT });
    const raw = await hub.openTab({ width: 900, height: 760 });
    await uiHubOn(hub, c.origin);
    await uiWatcher(raw, c.origin);
    await uiFront(hub); await hub.eval('window.__padConnect()'); await sleep(250);
    const sid = await uiSid(hub);
    const cursor = () => hub.eval('window.__arenaHub.view().menu.cursor');
    // Controls first
    await hub.eval('window.__arenaHub.openControls()');
    await uiUntil(hub, '!document.getElementById("controlsDialog").hidden && window.__arenaHub.dialogOpen()');
    await uiChal(raw, sid);
    const shown = await uiUntil(hub, UI_DLG());
    const top1 = await hub.eval(`({ top: ${UI_TOP_AT('#chDecline')}, focus: document.activeElement && document.activeElement.id, zc: Number(getComputedStyle(document.getElementById('challenge')).zIndex), zk: Number(getComputedStyle(document.getElementById('controlsDialog')).zIndex) })`);
    ok(shown && top1.top === 'chDecline' && top1.focus === 'chDecline' && top1.zc > top1.zk, 'US1 a challenge over the open Controls dialog is on top of it and has the focus', J(top1));
    await shot(hub, 'U_challenge_over_controls');
    const c0 = await cursor();
    await uiPad(hub, 'b');
    const closed = await uiUntil(hub, uiDlgGone(), 3000); await sleep(200);
    const aft = await hub.eval('({ ctlHidden: document.getElementById("controlsDialog").hidden, paused: window.__arenaHub.dialogOpen(), canvas: document.activeElement === window.__arenaHub.canvas })');
    ok(closed && aft.ctlHidden === false && aft.paused === true && aft.canvas === false, 'US2 Not now over Controls closes only the challenge: Controls is still up, the page is still paused, the canvas did not take the focus', J(aft));
    await uiPad(hub, 'down'); await uiPad(hub, 'down');
    ok((await cursor()) === c0, 'US3 and the hub menu behind the Controls dialog did not move when the pad pressed Down', J([c0, await cursor()]));
    await uiPad(hub, 'b');
    const ctlClosed = await uiUntil(hub, 'document.getElementById("controlsDialog").hidden && !window.__arenaHub.dialogOpen()', 3000); await sleep(200);
    await uiPad(hub, 'down');
    ok(ctlClosed && (await cursor()) !== c0, 'US4 closing Controls gives the hub back (Down moves its menu again)', J([c0, await cursor()]));
    // the Sound panel, built AFTER the challenge dialog exists (the old z-index tie: the later one in the document painted on top)
    await hub.eval('document.getElementById("soundBtn").click()');
    await uiUntil(hub, '(() => { const e = document.querySelector(".arena-snd"); return !!e && !e.hidden && window.__arenaHub.dialogOpen(); })()');
    await uiChal(raw, sid);
    const shown2 = await uiUntil(hub, UI_DLG());
    const top2 = await hub.eval(`({ top: ${UI_TOP_AT('#chDecline')}, focus: document.activeElement && document.activeElement.id, zc: Number(getComputedStyle(document.getElementById('challenge')).zIndex), zs: Number(getComputedStyle(document.querySelector('.arena-snd')).zIndex), last: document.body.lastElementChild.id || document.body.lastElementChild.className })`);
    ok(shown2 && top2.top === 'chDecline' && top2.focus === 'chDecline' && top2.zc > top2.zs, 'US5 a challenge over the Sound panel (built after the dialog) is on top of it, has the focus, and the nav belongs to it', J(top2));
    await uiPad(hub, 'b');
    const closed2 = await uiUntil(hub, uiDlgGone(), 3000); await sleep(200);
    const aft2 = await hub.eval('({ snd: !document.querySelector(".arena-snd").hidden, paused: window.__arenaHub.dialogOpen() })');
    ok(closed2 && aft2.snd === true && aft2.paused === true, 'US6 Not now over the Sound panel closes only the challenge: the panel is still up and the page still paused', J(aft2));
    await uiPad(hub, 'b');
    const sndClosed = await uiUntil(hub, 'document.querySelector(".arena-snd").hidden && !window.__arenaHub.dialogOpen()', 3000);
    ok(sndClosed, 'US7 and B then closes the Sound panel and the page is live again', J(await hub.eval('({ snd: !document.querySelector(".arena-snd").hidden, paused: window.__arenaHub.dialogOpen() })')));
    ok(uiErrs(hub, raw).length === 0, 'US8 no page errors', J(uiErrs(hub, raw)).slice(0, 300));
  });
}

// ---- UB / UX: a CPU battle (paused by a challenge over its Controls dialog), and the switch followed across tabs
async function uiCross(c) {
  const { ok } = c;
  await withBrowser({ port: c.cdp(3), width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (a) => {
    await a.send('Page.addScriptToEvaluateOnNewDocument', { source: UI_PAD_INIT });
    const w = await a.openTab({ width: 900, height: 760 });
    const cpu = await a.openTab({ width: 900, height: 760 });
    const b = await a.openTab({ width: 900, height: 760 });
    await cpu.send('Page.addScriptToEvaluateOnNewDocument', { source: UI_PAD_INIT });
    await uiWatcher(w, c.origin);
    await uiHubOn(a, c.origin);                                                    // tab A: the hub, the switch on
    await cpu.navigate(c.origin + '/pokemonarena/battle.html?net=local&anim=0&openchal=20000');       // tab C: a CPU battle opened while it is on
    await cpu.waitFor('window.__arenaBattle && window.__arenaBattle.state === "ready" && window.__arenaPresence && window.__arenaPresence.isOn() && window.__arenaPresence.presence', { timeoutMs: 120000 });
    await b.navigate(c.origin + '/pokemonarena/?net=local'); await uiHubReady(b);       // tab B: a second hub, which follows the stored switch
    await b.waitFor('window.__arenaPresence.isOn() && window.__arenaPresence.presence', { timeoutMs: 30000 });
    await sleep(1500);
    const live0 = await uiLive(w);
    ok(live0.length === 3, 'UX0 (the rig) three tabs of one browser are listed: the hub, a second hub and the CPU battle', J(live0));
    // UB: Controls open in the CPU battle, a challenge arrives
    await uiFront(cpu); await cpu.eval('window.__padConnect()'); await sleep(250);
    const sidC = await uiSid(cpu);
    await cpu.eval('window.__arenaBattle.openControls(null)');
    await uiUntil(cpu, 'window.__arenaBattle.controlsOpen === true && !document.getElementById("controlsDialog").hidden');
    await uiChal(w, sidC);
    const shown = await uiUntil(cpu, UI_DLG());
    const top = await cpu.eval(`({ top: ${UI_TOP_AT('#chDecline')}, focus: document.activeElement && document.activeElement.id, zc: Number(getComputedStyle(document.getElementById('challenge')).zIndex), zk: Number(getComputedStyle(document.getElementById('controlsDialog')).zIndex) })`);
    ok(shown && top.top === 'chDecline' && top.focus === 'chDecline' && top.zc > top.zk, 'UB1 in a CPU battle a challenge over the Controls dialog is on top of it and has the focus', J(top));
    await uiPad(cpu, 'b');
    const closed = await uiUntil(cpu, uiDlgGone(), 3000); await sleep(250);
    const aft = await cpu.eval('({ paused: window.__arenaBattle.controlsOpen, ctl: !document.getElementById("controlsDialog").hidden, canvas: document.activeElement === window.__arenaBattle.canvas })');
    ok(closed && aft.paused === true && aft.ctl === true && aft.canvas === false, 'UB2 Not now closes only the challenge: the battle stays paused behind the Controls dialog and the canvas does not take the focus', J(aft));
    await uiPad(cpu, 'b');
    ok(await uiUntil(cpu, 'window.__arenaBattle.controlsOpen === false && document.getElementById("controlsDialog").hidden', 3000), 'UB3 B then closes Controls and the battle runs again', J(await cpu.eval('window.__arenaBattle.controlsOpen')));
    // UX: tab A turns the switch off; the other two tabs follow and the board loses all three
    await uiFront(a);
    await a.eval('document.getElementById("openToggle").click()');
    const gone = await uiUntil(b, '!window.__arenaPresence.isOn() && window.__arenaPresence.presence === null && window.__arenaPresence.lobbies === null', 5000)
      && await uiUntil(cpu, '!window.__arenaPresence.isOn() && window.__arenaPresence.presence === null && window.__arenaPresence.lobbies === null', 5000);
    const live1 = await uiLive(w);
    const st = [await b.eval('document.getElementById("openToggle").getAttribute("aria-pressed")'), await a.eval('localStorage.getItem("arena.open")')];
    ok(gone && live1.length === 0 && st[0] === 'false' && st[1] === null, 'UX1 switching Open off in one tab takes the listing down in the other hub tab and in the CPU battle too (and the board is empty)', J({ gone, live1, st }));
    // and on again: they follow that too
    await a.eval('document.getElementById("openToggle").click()');
    const back = await uiUntil(b, 'window.__arenaPresence.isOn() && window.__arenaPresence.presence', 8000) && await uiUntil(cpu, 'window.__arenaPresence.isOn() && window.__arenaPresence.presence', 8000);
    await sleep(800);
    ok(back && (await uiLive(w)).length === 3, 'UX2 switching it on again lists all three again', J(await uiLive(w)));
    await a.eval('document.getElementById("openToggle").click()');
    ok(await uiUntil(w, 'Object.keys(window.__live).length === 0', 5000), 'UX3 and off again empties the board', J(await uiLive(w)));
    ok(uiErrs(a, b, cpu, w).length === 0, 'UX4 no page errors', J(uiErrs(a, b, cpu, w)).slice(0, 300));
  });
}

// ---- UR: the listing follows the profile; a re-mount leaves one dialog; dispose leaves none
async function uiRefresh(c) {
  const { ok } = c;
  await withBrowser({ port: c.cdp(0), width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (hub) => {
    const w = await hub.openTab({ width: 900, height: 760 });
    await hub.navigate(c.origin + '/pokemonarena/?net=local');
    await seedProfile(hub, 'OLDNAME');
    await uiHubOn(hub, c.origin);
    await uiWatcher(w, c.origin);
    const sid = await uiSid(hub);
    ok(await uiUntil(w, `window.__live[${J(sid)}] && window.__live[${J(sid)}].name === 'OLDNAME'`, 8000), 'UR0 (the rig) the listing carries the profile\'s trainer name', J(await uiLive(w)));
    const rename = (name) => w.eval(`(async () => { const { openStore } = await import('/pokemonarena/js/store.js'); const st = await openStore(); const id = await st.getActiveId(); const r = await st.loadProfile(id); await st.saveProfile({ ...r.profile, trainerName: ${J(name)} }, { reason: 'rename' }); await st.close(); return true; })()`);
    const listedAs = (name, ms = 7000) => uiUntil(w, `window.__live[${J(sid)}] && window.__live[${J(sid)}].name === ${J(name)}`, ms);
    // the trainer is renamed elsewhere; this tab comes back to the front
    await uiFront(w); await rename('NEWNAME'); await uiFront(hub); await sleep(400);
    await hub.eval('document.dispatchEvent(new Event("visibilitychange"))');
    ok(await listedAs('NEWNAME'), 'UR1 the tab becoming visible again re-reads the trainer: the board shows the new name', J(await uiLive(w)));
    ok((await uiLive(w)).length === 1, 'UR1b and it is still ONE listing', J(await uiLive(w)));
    // a back/forward-cache restore: pagehide takes the listing down, pageshow(persisted) lists again with what the profile says NOW
    await rename('NEWER');
    await hub.eval('window.dispatchEvent(new Event("pagehide"))');
    const down = await uiUntil(w, 'Object.keys(window.__live).length === 0', 4000);
    await hub.eval('(() => { const e = new Event("pageshow"); e.persisted = true; window.dispatchEvent(e); return true; })()');
    const sid2 = await uiUntil(hub, 'window.__arenaPresence.isOn() && window.__arenaPresence.presence', 8000) ? await uiSid(hub) : null;
    ok(down && sid2 && await uiUntil(w, `window.__live[${J(sid2)}] && window.__live[${J(sid2)}].name === 'NEWER'`, 8000), 'UR2 a restore from the back/forward cache lists again under the current name', J({ down, live: await uiLive(w) }));
    // challenges across an off/on cycle and a re-mount: exactly one dialog in the document, and its aria references point at it
    const q1 = await uiChal(w, sid2, 'First');
    await uiUntil(hub, UI_DLG());
    await hub.eval('document.getElementById("chDecline").click()');
    await uiUntil(hub, uiDlgGone(), 3000);
    await hub.eval('window.__arenaPresence.setOn(false)'); await hub.eval('window.__arenaPresence.setOn(true)');
    await uiUntil(hub, 'window.__arenaPresence.presence', 8000);
    const sid3 = await uiSid(hub);
    await uiChal(w, sid3, 'Second');
    await uiUntil(hub, UI_DLG());
    const one = await hub.eval('({ roots: document.querySelectorAll("#challenge").length, texts: document.querySelectorAll("#chText").length, titles: document.querySelectorAll("#chTitle").length, says: document.getElementById(document.getElementById("challenge").getAttribute("aria-describedby")).textContent })');
    ok(one.roots === 1 && one.texts === 1 && one.titles === 1 && /^Second/.test(one.says), 'UR3 after the switch went off and on there is ONE challenge dialog, and aria-describedby reads the current challenger', J(one));
    await hub.eval('document.getElementById("chDecline").click()');
    await uiUntil(hub, uiDlgGone(), 3000);
    // mounting the module AGAIN on the same page (a second mount) disposes the first: still one dialog, not two
    const re = await hub.eval(`(async () => {
      const m = await import('/pokemonarena/js/presence_boot.js'), n = await import('/pokemonarena/js/uinav.js'), H = window.__arenaHub;
      m.mountPresence({ win: window, doc: document, pack: H.pack, input: H.input, enableDomNav: n.enableDomNav, navigate: () => {}, button: document.getElementById('openToggle') });
      return { roots: document.querySelectorAll('#challenge').length }; })()`);
    await uiUntil(hub, 'window.__arenaPresence.isOn() && window.__arenaPresence.presence', 8000);
    await uiChal(w, await uiSid(hub), 'Third');
    await uiUntil(hub, UI_DLG());
    const two = await hub.eval('({ roots: document.querySelectorAll("#challenge").length, says: document.getElementById("chText").textContent })');
    ok(re.roots <= 1 && two.roots === 1 && /^Third/.test(two.says), 'UR4 a second mount on the same page leaves ONE challenge dialog (the first mount\'s is removed with it)', J({ re, two }));
    await hub.eval('document.getElementById("chDecline").click()');
    await uiUntil(hub, uiDlgGone(), 3000);
    // dispose: no dialog, no listing, and the switch is inert again
    await hub.eval('window.__arenaPresence.dispose()');
    const d = await hub.eval('({ roots: document.querySelectorAll("#challenge").length, attr: document.getElementById("openToggle").dataset.presence || null, vis: getComputedStyle(document.getElementById("openToggle")).visibility, hook: !!window.__arenaPresence })');
    ok(d.roots === 0 && d.attr === null && d.vis === 'hidden' && d.hook === false && (await uiUntil(w, 'Object.keys(window.__live).length === 0', 4000)), 'UR5 dispose removes the dialog, takes the listing down and makes the switch inert again', J(d));
    ok(uiErrs(hub, w).length === 0, 'UR6 no page errors', J(uiErrs(hub, w)).slice(0, 300));
  });
}

// ---- UQ: the listing follows the profile's RECORD. A store that cannot be read at refresh time changes nothing (it used to flip the listing to "Player" with no record); RESET RECORD in the hub takes the record
// off the board at once; and a read that was already under way when the record was emptied does not win with the answer it read before.
const uiRename = (p, name) => p.eval(`(async () => { const { openStore } = await import('/pokemonarena/js/store.js'); const st = await openStore(); const id = await st.getActiveId(); const r = await st.loadProfile(id); await st.saveProfile({ ...r.profile, trainerName: ${J(name)} }, { reason: 'rename' }); await st.close(); return true; })()`);
// online battles written into a profile through the real store (ids <tag>0, <tag>1 ...: a second batch needs a second tag); -> the profile's online row
const UI_RECORD_JS = (id, tag, results) => `(async () => { const S = await import('/pokemonarena/js/store.js'); const store = await S.openStore(); const base = ${UX_MATCH_BASE}; const res = ${J(results)};
  for (let i = 0; i < res.length; i++) await store.recordMatch(${J(id)}, Object.assign({}, base, { id: ${J(tag)} + i, at: 1800000000000 + i * 86400000, result: res[i] }));
  const r = await store.loadProfile(${J(id)}); await store.close(); return r.ok ? r.profile.stats.byCpu.online : null; })()`;
// RESET RECORD the way a player does it, through the hub's own menu: the Record screen, to the last page, YES (the question starts on NO)
const UI_RESET_JS = `(async () => {
  const H = window.__arenaHub; H.model.goto('record');
  for (let i = 0; i < 16 && !(H.view().record && H.view().record.button && H.view().record.button.enabled); i++) H.press('right');
  const asks = !!(H.view().record && H.view().record.button && H.view().record.button.enabled);
  const before = H.recordReset | 0;
  H.press('a'); H.press('left'); H.press('a');
  const t0 = performance.now();
  while ((H.recordReset | 0) === before && performance.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 40));
  return { asks, resets: (H.recordReset | 0) - before };
})()`;
async function uiRecord(c) {
  const { ok } = c;
  await withBrowser({ port: c.cdp(0), width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (hub) => {
    await hub.send('Page.addScriptToEvaluateOnNewDocument', { source: UI_IDB_FAIL_INIT });
    const w = await hub.openTab({ width: 900, height: 760 });
    await hub.navigate(c.origin + '/pokemonarena/?net=local');
    const pid = await seedProfile(hub, 'RECHERO');
    await hub.eval(UI_RECORD_JS(pid, 'rec', ['w', 'w', 'l']));
    await uiHubOn(hub, c.origin);
    await uiWatcher(w, c.origin);
    await uiFront(hub); await sleep(800);                // the hub in front BEFORE anything below: coming to the front makes it re-read the profile (visibilitychange), which would hide a reset that forgot to tell the listing
    const sid = await uiSid(hub);
    const listed = (name, rec, ms = 8000) => uiUntil(w, `(() => { const g = window.__live[${J(sid)}]; return !!g && g.name === ${J(name)} && JSON.stringify(g.rec) === ${J(JSON.stringify(rec))}; })()`, ms);
    ok(await listed('RECHERO', [2, 1]), 'UQ0 (the rig) the listing carries the profile\'s name and its online record (2 wins, 1 loss)', J(await uiLive(w)));
    // a store that cannot be opened: the read fails, and the listing keeps what it said
    await hub.eval('window.__idbFail = true');
    const failed = await hub.eval('window.__arenaPresence.refresh()');
    await hub.eval('window.__idbFail = false');
    await sleep(1200);
    const names = await w.eval('[...new Set(window.__msgs.filter((m) => m.k === "open" && m.s === ' + J(sid) + ').map((m) => m.name))]');
    ok(failed === false && !names.includes('Player') && await listed('RECHERO', [2, 1], 2000), 'UQ2 a store that cannot be read at refresh time changes nothing: the listing keeps the name and the record (it flipped to "Player" with no record)', J({ failed, names, live: await uiLive(w) }));
    await uiRename(w, 'NEWNAME');
    const changed = await hub.eval('window.__arenaPresence.refresh()');
    ok(changed === true && await listed('NEWNAME', [2, 1]), 'UQ2b and a read that works and differs IS listed (a rename)', J({ changed, live: await uiLive(w) }));
    ok((await hub.eval('window.__arenaPresence.refresh()')) === false, 'UQ2c and one that works and does not differ lists nothing again', '');
    // RESET RECORD in the hub: the board loses the record now, not when the tab is next shown
    const rs = await hub.eval(UI_RESET_JS);
    ok(rs.asks && rs.resets === 1 && await listed('NEWNAME', null, 6000), 'UQ1 RESET RECORD in the hub takes the record off the board at once (the name stays)', J({ rs, live: await uiLive(w) }));
    // new online battles, listed again; then a read is under way (held up at its end) when the record is reset: the second look is the one that counts
    await w.eval(UI_RECORD_JS(pid, 'late', ['l', 'l', 'w']));
    await hub.eval('window.__arenaPresence.refresh()');
    ok(await listed('NEWNAME', [1, 2]), 'UQ3a (the rig) the new record (1 win, 2 losses) is listed', J(await uiLive(w)));
    await hub.eval(`(async () => { const { ArenaStore } = await import('/pokemonarena/js/store.js'); const oc = ArenaStore.prototype.close; ArenaStore.prototype.close = async function (...a) { const d = window.__closeDelay | 0; if (d) await new Promise((r) => setTimeout(r, d)); return oc.apply(this, a); };
      window.__closeDelay = 2500; window.__slowDone = false; window.__arenaPresence.refresh().then(() => { window.__slowDone = true; }); return true; })()`);
    await sleep(900);
    await hub.eval('window.__closeDelay = 0');
    const under = await hub.eval('window.__slowDone === false');
    const rs2 = await hub.eval(UI_RESET_JS);
    ok(under && rs2.asks && rs2.resets === 1 && await listed('NEWNAME', null, 9000), 'UQ3 a refresh that was under way when the record was reset does not win with the record it read before (the board still showed 1-2 after it)', J({ under, rs2, live: await uiLive(w) }));
    ok(uiErrs(hub, w).length === 0, 'UQ4 no page errors', J(uiErrs(hub, w)).slice(0, 300));
  });
}

// ---- UP: on - off - on in one breath, with the first start slower than the last, leaves ONE live listing (and off takes it down)
async function uiRapid(c) {
  const { ok } = c;
  await withBrowser({ port: c.cdp(1), width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (hub) => {
    await hub.send('Page.addScriptToEvaluateOnNewDocument', { source: UI_IDB_DELAY_INIT });
    const w = await hub.openTab({ width: 900, height: 760 });
    await hub.navigate(c.origin + '/pokemonarena/?net=local');
    await uiHubReady(hub);
    await uiWatcher(w, c.origin);
    await hub.eval('window.__idbDelays = [1500, 0, 0, 0]');
    await hub.eval('(() => { const p = window.__arenaPresence; p.setOn(true); p.setOn(false); p.setOn(true); return true; })()');
    await uiUntil(hub, 'window.__arenaPresence.presence', 10000);
    await sleep(2500);
    const live = await uiLive(w), st = await hub.eval('({ on: window.__arenaPresence.isOn(), has: !!window.__arenaPresence.presence && !!window.__arenaPresence.lobbies })');
    ok(st.on && st.has && live.length === 1, 'UP1 on-off-on in one breath, the first start the slowest: exactly one live listing, and the page holds it', J({ st, live }));
    await hub.eval('window.__arenaPresence.setOn(false)');
    await sleep(6500);
    const left = await uiLive(w);
    ok(left.length === 0 && (await hub.eval('window.__arenaPresence.presence === null && window.__arenaPresence.lobbies === null')), 'UP2 and off then takes EVERYTHING down: no listing keeps beaconing from a start that was overtaken', J(left));
  });
}

// ---- UD / UM: the first-time disclosure, and the switch not keeping the keyboard focus after a mouse click
async function uiDisclosure(c) {
  const { ok } = c;
  await withBrowser({ port: c.cdp(2), width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (hub) => {
    await hub.send('Page.addScriptToEvaluateOnNewDocument', { source: UI_PAD_INIT });
    const w = await hub.openTab({ width: 900, height: 760 });
    await hub.navigate(c.origin + '/pokemonarena/?net=local&opendisc=1');
    await uiHubReady(hub);
    await uiWatcher(w, c.origin);
    await uiFront(hub); await hub.eval('window.__padConnect()'); await sleep(250);
    const state = () => hub.eval('({ on: window.__arenaPresence.isOn(), stored: localStorage.getItem("arena.open"), seen: localStorage.getItem("arena.open.seen"), paused: window.__arenaHub.dialogOpen(), shown: !!document.getElementById("openInfo") && !document.getElementById("openInfo").hidden })');
    const pt = await uiCenter(hub, '#openToggle');
    await hub.click(pt.x, pt.y);
    const shown = await uiUntil(hub, UI_DLG('openInfo'), 3000);
    const d = shown ? await hub.eval('({ text: document.getElementById("oiText").textContent + " " + document.getElementById("oiSub").textContent, focus: document.activeElement && document.activeElement.id, ok: document.getElementById("oiOk").textContent, cancel: document.getElementById("oiCancel").textContent, role: document.getElementById("openInfo").getAttribute("role"), close: document.getElementById("oiCancel").hasAttribute("data-nav-close") })') : null;
    const s1 = await state();
    ok(shown && /trainer name/.test(d.text) && /online record/.test(d.text) && /public servers/.test(d.text) && d.focus === 'oiCancel' && d.ok === 'OK' && d.cancel === 'Cancel' && d.role === 'alertdialog' && d.close && s1.on === false && s1.stored === null && s1.paused === true,
      'UD1 the first press on the switch shows what is published (trainer name, online record, public servers) with Cancel focused, and nothing is published yet', J({ d, s1 }));
    await shot(hub, 'U_disclosure');
    await uiPad(hub, 'b');
    ok(await uiUntil(hub, uiDlgGone('openInfo'), 3000) && (await state()).on === false && (await state()).seen === null && (await state()).paused === false, 'UD2 Cancel (the pad\'s B) leaves the switch off, remembers nothing, and gives the page back', J(await state()));
    const pt2 = await uiCenter(hub, '#openToggle');
    await hub.click(pt2.x, pt2.y);
    ok(await uiUntil(hub, UI_DLG('openInfo'), 3000), 'UD3 it asks again next time (Cancel is not remembered)', '');
    const okp = await uiCenter(hub, '#oiOk');
    await hub.click(okp.x, okp.y);
    ok(await uiUntil(hub, 'window.__arenaPresence.isOn() && window.__arenaPresence.presence', 15000), 'UD4 OK switches it on', J(await state()));
    const s4 = await state();
    ok(s4.stored === '1' && s4.seen === '1' && s4.shown === false && s4.paused === false && (await uiUntil(w, 'Object.keys(window.__live).length === 1', 6000)), 'UD5 and remembers that the player was told, and the listing is on the board', J({ s4, live: await uiLive(w) }));
    // off, on: not asked again
    let pt3 = await uiCenter(hub, '#openToggle');
    await hub.click(pt3.x, pt3.y);
    await uiUntil(hub, '!window.__arenaPresence.isOn()', 5000);
    pt3 = await uiCenter(hub, '#openToggle');
    await hub.click(pt3.x, pt3.y);
    const again = await uiUntil(hub, 'window.__arenaPresence.isOn()', 5000);
    ok(again && (await state()).shown === false, 'UD6 switching it off and on again does not ask a second time', J(await state()));
    // a stored "on" that nobody was ever told about is not honoured: clear the memory of having been told, reload
    await hub.eval('localStorage.removeItem("arena.open.seen")');
    await hub.navigate(c.origin + '/pokemonarena/?net=local&opendisc=1'); await uiHubReady(hub);
    await sleep(800);
    const s7 = await state();
    ok(s7.on === false && s7.stored === null, 'UD7 a stored "on" the player was never told about does not list them: it stays off and forgets the switch', J(s7));
    ok(uiErrs(hub, w).length === 0, 'UD8 no page errors', J(uiErrs(hub, w)).slice(0, 300));
  });
  // UM: the mouse leaves nothing focused on the switch; the keyboard keeps its focus
  await withBrowser({ port: c.cdp(3), width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (hub) => {
    await hub.navigate(c.origin + '/pokemonarena/?net=local');
    await uiHubReady(hub);
    const pt = await uiCenter(hub, '#openToggle');
    await hub.click(pt.x, pt.y);
    await uiUntil(hub, 'window.__arenaPresence.isOn()', 8000);
    const af = await hub.eval('({ id: document.activeElement && document.activeElement.id, canvas: document.activeElement === window.__arenaHub.canvas })');
    await uiEnter(hub); await sleep(300);
    const pressed = await hub.eval('document.getElementById("openToggle").getAttribute("aria-pressed")');
    ok(af.id !== 'openToggle' && af.canvas && pressed === 'true', 'UM1 after a mouse click the switch does not keep the focus (the next Enter acts on the menu, it does not toggle the public listing again)', J({ af, pressed }));
    await hub.eval('document.getElementById("openToggle").focus()');
    await uiEnter(hub); await sleep(400);
    const kb = await hub.eval('({ pressed: document.getElementById("openToggle").getAttribute("aria-pressed"), focus: document.activeElement && document.activeElement.id })');
    ok(kb.pressed === 'false' && kb.focus === 'openToggle', 'UM2 a keyboard player who focused it and pressed Enter toggles it and keeps the focus there', J(kb));
  });
}

// ---- UW / UN1: what the hub's switch SAYS once the module has mounted (the static text in index.html is overwritten at mount, so a test of the static text alone is false assurance: OXT4 reads the dead title),
// and its accessible name, which is constant (the state is aria-pressed's to say; a name that also changed -- "Open: on" -- was read out twice)
async function uiWords(c) {
  const { ok } = c;
  await withBrowser({ port: c.cdp(2), width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (hub) => {
    await hub.navigate(c.origin + '/pokemonarena/?net=local');
    await uiHubReady(hub);
    const html = await (await fetch(c.origin + '/pokemonarena/index.html')).text();
    const staticTitle = (html.match(/id="openToggle"[^>]*title="([^"]*)"/) || [])[1] || '';
    const read = () => hub.eval('(() => { const b = document.getElementById("openToggle"); return { title: b.title, label: b.getAttribute("aria-label"), pressed: b.getAttribute("aria-pressed"), text: b.textContent }; })()');
    const off = await read(), axOff = await uiAx(hub, '#openToggle');
    ok(/list your trainer name and online record on public servers/.test(off.title) && /first time/.test(off.title) && !/asks you first/.test(off.title) && off.title === staticTitle,
      'UW1 after mount the switch\'s LIVE off-state tooltip names the trainer name AND the online record, says it asks the FIRST time (it asks once), and is the same text as index.html carries', J({ live: off.title, staticTitle }).slice(0, 500));
    const says = await hub.eval('(async () => { await window.__arenaPresence.setOn(true); return { live: document.getElementById("live").textContent, title: document.getElementById("openToggle").title }; })()');
    ok(/trainer name and online record/.test(says.live) && /trainer name and online record/.test(says.title), 'UW2 switching on says, in the live region and in the tooltip, that the trainer name AND the online record are listed', J(says));
    const on = await read(), axOn = await uiAx(hub, '#openToggle');
    ok(axOff.name === 'Open to battles' && axOn.name === 'Open to battles' && axOff.pressed === 'false' && axOn.pressed === 'true' && off.text !== on.text && on.label === 'Open to battles',
      'UN1 the hub switch has ONE accessible name ("Open to battles") whatever its state, and aria-pressed carries the state (the printed text still changes: ' + off.text + ' -> ' + on.text + ')', J({ axOff, axOn, off, on }));
    // brokers that cannot be reached: the name stays, the tooltip (the description) says it
    await hub.eval('(() => { window.__arenaPresence.lobbies.status = () => "down"; return window.__arenaPresence.setOn(true); })()');
    const dn = await read(), axDn = await uiAx(hub, '#openToggle');
    ok(dn.text === 'Open: on, offline' && /no public server can be reached/.test(dn.title) && axDn.name === 'Open to battles' && axDn.pressed === 'true', 'UN1b with no broker reachable the name is still the same, and the tooltip says nobody can see the listing', J({ dn, axDn }));
  });
}

// ---- UT: a phone: touch declines, Accept is inert for the first moments, the dialog fits
async function uiTouch(c) {
  const { ok } = c;
  await withBrowser({ port: c.cdp(0), width: 390, height: 844, mobile: true, lock: false, args: NO_THROTTLE }, async (hub) => {
    const w = await hub.openTab({ width: 390, height: 844, mobile: true });
    await uiHubOn(hub, c.origin);
    await uiWatcher(w, c.origin);
    await uiFront(hub);
    const sid = await uiSid(hub);
    const q1 = await uiChal(w, sid);
    await uiUntil(hub, UI_DLG());
    const lay = await hub.eval(`(() => { const r = (id) => document.getElementById(id).getBoundingClientRect(); const d = document.querySelector('#challenge .dlg').getBoundingClientRect(); return { l: d.left, r: d.right, t: d.top, b: d.bottom, vw: innerWidth, vh: innerHeight, nowH: r('chDecline').height, nowW: r('chDecline').width, accH: r('chAccept').height, accW: r('chAccept').width, over: document.documentElement.scrollWidth - document.documentElement.clientWidth }; })()`);
    ok(lay.l >= 0 && lay.r <= lay.vw && lay.t >= 0 && lay.b <= lay.vh && lay.nowH >= 44 && lay.nowW >= 44 && lay.accH >= 44 && lay.accW >= 44 && lay.over <= 0, 'UT1 on a 390 px phone the dialog fits and both buttons are at least 44 css px', J(lay));
    await shot(hub, 'U_dialog_phone');
    const acc = await uiCenter(hub, '#chAccept');
    await hub.tap(acc.x, acc.y); await sleep(150);
    const inert = await hub.eval('({ open: !document.getElementById("challenge").hidden, path: location.pathname })');
    ok(inert.open && inert.path === '/pokemonarena/', 'UT2 a tap on Accept in the first moments does nothing', J(inert));
    const no = await uiCenter(hub, '#chDecline');
    await hub.tap(no.x, no.y);
    ok(await uiUntil(hub, uiDlgGone(), 3000) && (await uiTold(w, q1)).includes('declined'), 'UT3 a tap on Not now declines it', J(await uiTold(w, q1)));
    const q2 = await uiChal(w, sid);
    await uiUntil(hub, UI_DLG()); await sleep(750);
    const acc2 = await uiCenter(hub, '#chAccept');
    await hub.tap(acc2.x, acc2.y);
    const went = await uiUntil(hub, 'location.pathname === "/pokemonarena/battle.html"', 20000);
    ok(went && new URL(await hub.eval('location.href')).searchParams.get('rq') === q2.r, 'UT4 a tap on Accept once it is awake accepts', went ? '' : 'no navigation');
  });
}

// ---- UO / UN2 / UL: the CPU battle's OPEN button (the header's last tool). A battle against the computer is where "this lobby can be open while I am playing" happens, so the page shows that the player is
// listed and has an off control; and a tab loaded with the switch OFF is mounted DORMANT, so it follows the switch going on in another tab. Phone widths (390, 320) and a desktop.
const UI_BTN_GEOM = `(() => {
  const b = document.getElementById('openBtn'), r = b.getBoundingClientRect(), cs = getComputedStyle(b);
  const vis = (e) => { const q = e.getBoundingClientRect(), s = getComputedStyle(e); return q.width > 0 && q.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const others = [...document.querySelectorAll('#top a, #top button, #top input')].filter((e) => e !== b && vis(e)).map((e) => { const q = e.getBoundingClientRect(); return { id: e.id || e.className, l: q.left, r: q.right, t: q.top, b: q.bottom }; });
  const hit = others.filter((o) => r.left < o.r - 0.5 && r.right > o.l + 0.5 && r.top < o.b - 0.5 && r.bottom > o.t + 0.5).map((o) => o.id);
  const tools = [...document.querySelectorAll('#top .tools .textbtn')].filter((e) => e !== b && vis(e)).map((e) => { const q = e.getBoundingClientRect(); return { id: e.id, w: q.width, h: q.height, right: q.right, clipped: e.scrollWidth > e.clientWidth + 1 }; });
  const menu = document.getElementById('menuBtn').getBoundingClientRect();
  return { hidden: b.hidden, display: cs.display, visibility: cs.visibility, w: r.width, h: r.height, l: r.left, r: r.right, vw: innerWidth, over: document.documentElement.scrollWidth - document.documentElement.clientWidth, hit, tools, sameRowAsMenu: Math.abs(r.top - menu.top) < 1.5,
    svg: !!b.querySelector('svg'), icon: (() => { const q = getComputedStyle(b, '::before'); return q.content !== 'none' && parseFloat(q.width) === 22 && /svg/.test(q.webkitMaskImage || q.maskImage || ''); })(), text: b.textContent.trim(), pressed: b.getAttribute('aria-pressed'), label: b.getAttribute('aria-label'), bg: cs.backgroundColor, title: b.title };
})()`;
async function uiBattleBtn(c) {
  const { ok } = c;
  const views = [['a 390 px phone', { width: 390, height: 844, mobile: true }, 0, true], ['a desktop', { width: 900, height: 760 }, 1, true], ['a 320 px phone', { width: 320, height: 640, mobile: true }, 2, false], ['a 568 x 320 phone held sideways', { width: 568, height: 320, mobile: true }, 3, false]];
  for (const [tag, vp, k, full] of views) {
    await withBrowser({ port: c.cdp(k), ...vp, lock: false, args: NO_THROTTLE }, async (a) => {
      const phone = !!vp.mobile;
      const w = await a.openTab(vp);
      await uiWatcher(w, c.origin);
      await uiFront(a);                                                                                  // the page under test is the one in front (a tab behind it renders nothing, and the accessibility tree waits for a frame)
      await a.navigate(c.origin + '/pokemonarena/battle.html?net=local&anim=0');                         // the switch is OFF (a fresh browser)
      await a.waitFor('window.__arenaBattle && window.__arenaBattle.state === "ready"', { timeoutMs: 120000 });
      const mounted = await uiUntil(a, 'window.__arenaPresence', 15000);
      const g = await a.eval(UI_BTN_GEOM);
      const dorm = mounted ? await a.eval('({ on: window.__arenaPresence.isOn(), presence: !!window.__arenaPresence.presence, lobbies: !!window.__arenaPresence.lobbies, dialogs: document.querySelectorAll("#challenge, #openInfo").length })') : null;
      ok(mounted && dorm.on === false && dorm.presence === false && dorm.lobbies === false && dorm.dialogs === 0 && !g.hidden && g.display !== 'none' && g.visibility === 'visible' && g.pressed === 'false',
        'UO1 on ' + tag + ' a CPU battle with the switch OFF mounts OPEN TO BATTLES dormant (no board connection, no dialog in the page) and shows the header\'s Open button, off', J({ mounted, dorm, g: { hidden: g.hidden, display: g.display, visibility: g.visibility, pressed: g.pressed } }));
      if (!mounted) return;
      ok(g.w >= 44 && g.w <= 48 && g.h >= 44 && g.l >= 0 && g.r <= g.vw - 15 && g.over <= 0 && g.hit.length === 0 && g.tools.length === 3 && g.tools.every((t) => t.w >= 44 && t.h <= 46 && !t.clipped && t.right <= g.vw - 15) && (!phone || g.sameRowAsMenu),
        'UL1 on ' + tag + ' the Open button is a 44 px icon inside the 16 px gutters, overlaps no other header control, and Sound, Controls and Menu still fit beside it unclipped and on ONE line each (44 px tall, none wrapped to two lines)' + (phone ? ', all on the same row' : ''), J(g));
      ok(g.icon && !g.svg && g.text === '', 'UO4 the button is an icon drawn by the stylesheet (no svg element in the page: the hostile-address test of the battle page counts them) with no printed text (the module leaves its face alone)', J({ icon: g.icon, svg: g.svg, text: g.text }));
      const ax0 = await uiAx(a, '#openBtn');
      await shot(a, 'U_battle_open_off_' + k);
      if (!full) { ok(ax0.name === 'Open to battles', 'UN2 the battle button\'s accessible name is "Open to battles" (' + tag + ')', J(ax0)); return; }
      // switched on from here: pressed, green, listed on the board, the focus back on the battle, and the NAME unchanged
      const press = async () => { const p = await uiCenter(a, '#openBtn'); if (phone) await a.tap(p.x, p.y); else await a.click(p.x, p.y); };
      await press();
      const onOk = await uiUntil(a, 'window.__arenaPresence.isOn() && window.__arenaPresence.presence', 15000);
      await sleep(600);
      const g1 = await a.eval(UI_BTN_GEOM), st = await a.eval('({ stored: localStorage.getItem("arena.open"), canvas: document.activeElement === window.__arenaBattle.canvas, paused: window.__arenaBattle.controlsOpen === true })'), ax1 = await uiAx(a, '#openBtn');
      const live1 = await uiLive(w);
      await shot(a, 'U_battle_open_on_' + k);
      ok(onOk && g1.pressed === 'true' && g1.bg === 'rgb(31, 90, 55)' && /trainer name and online record/.test(g1.title) && st.stored === '1' && st.canvas && !st.paused && live1.length === 1,
        'UO2 on ' + tag + ' a press switches it ON from the battle page: the button shows it (pressed, green), the player is on the board, the battle has the focus and is not paused', J({ onOk, g1: { pressed: g1.pressed, bg: g1.bg, title: g1.title.slice(0, 60) }, st, live1 }));
      ok(ax0.name === 'Open to battles' && ax1.name === 'Open to battles' && ax0.pressed === 'false' && ax1.pressed === 'true', 'UN2 and its accessible name is the same before and after ("Open to battles"); aria-pressed carries the state', J({ ax0, ax1 }));
      // a challenge reaches the player in the middle of the battle, and pauses it
      const sid = await uiSid(a);
      await uiChal(w, sid, 'Mid');
      const shown = await uiUntil(a, UI_DLG());
      const paused = shown ? await a.eval('window.__arenaBattle.controlsOpen === true') : null;
      ok(shown && paused === true, 'UO5 a challenge reaches the player in the middle of the battle (the dialog is up and the battle is paused behind it)', J({ shown, paused }));
      if (shown) { const no = await uiCenter(a, '#chDecline'); if (phone) await a.tap(no.x, no.y); else await a.click(no.x, no.y); await uiUntil(a, uiDlgGone(), 3000); await sleep(200); }
      // and OFF again from the same button
      await press();
      const offOk = await uiUntil(a, '!window.__arenaPresence.isOn() && window.__arenaPresence.presence === null && window.__arenaPresence.lobbies === null', 8000);
      const g2 = await a.eval(UI_BTN_GEOM), st2 = await a.eval('({ stored: localStorage.getItem("arena.open") })');
      ok(offOk && g2.pressed === 'false' && g2.bg !== 'rgb(31, 90, 55)' && st2.stored === null && await uiUntil(w, 'Object.keys(window.__live).length === 0', 5000), 'UO2b on ' + tag + ' pressing it again switches it OFF and takes the listing down', J({ offOk, g2: { pressed: g2.pressed, bg: g2.bg }, st2 }));
      const liveTxt = await a.eval('(document.getElementById("live") || { textContent: null }).textContent');
      ok(liveTxt === 'No longer open to battles.', 'UO2c on ' + tag + ' switching it off is ANNOUNCED on the battle page too (it has a live region: before, the message went nowhere and only aria-pressed changed)', J({ liveTxt }));
      if (phone) return;
      // the keyboard: Tab reaches it from Menu (it is an ordinary button of the header), Enter toggles it and the focus stays on it
      await a.eval('document.getElementById("menuBtn").focus()');
      await a.press('Tab', 'Tab', 9); await sleep(150);
      const tabbed = await a.eval('document.activeElement && document.activeElement.id');
      await uiEnter(a); await sleep(500);
      const kOn = await a.eval('({ pressed: document.getElementById("openBtn").getAttribute("aria-pressed"), focus: document.activeElement && document.activeElement.id })');
      await uiEnter(a); await sleep(500);
      const kOff = await a.eval('({ pressed: document.getElementById("openBtn").getAttribute("aria-pressed"), focus: document.activeElement && document.activeElement.id })');
      ok(tabbed === 'openBtn' && kOn.pressed === 'true' && kOn.focus === 'openBtn' && kOff.pressed === 'false' && kOff.focus === 'openBtn', 'UO7 on a desktop Tab reaches the button after Menu, Enter switches it on and off, and the focus stays on it', J({ tabbed, kOn, kOff }));
      // a tab that was loaded with the switch OFF follows it going ON in another tab (the hub's), and OFF again
      const b = await a.openTab(vp);
      await b.navigate(c.origin + '/pokemonarena/?net=local'); await uiHubReady(b);
      await b.eval('document.getElementById("openToggle").click()');
      const follow = await uiUntil(a, 'window.__arenaPresence.isOn() && window.__arenaPresence.presence', 10000);
      const fb = await a.eval('document.getElementById("openBtn").getAttribute("aria-pressed")');
      await sleep(800);
      const live3 = await uiLive(w);
      await b.eval('document.getElementById("openToggle").click()');
      const unfollow = await uiUntil(a, '!window.__arenaPresence.isOn() && window.__arenaPresence.presence === null', 8000);
      ok(follow && fb === 'true' && live3.length === 2 && unfollow, 'UO3 a CPU battle loaded with the switch OFF follows it going ON in another tab (the button, the listing: two on the board) and OFF again', J({ follow, fb, live3, unfollow }));
      // the online page and an error screen never show the button (and take no room)
      await a.navigate(c.origin + '/pokemonarena/battle.html?online=1&net=local&anim=0');
      await a.waitFor('window.__arenaBattle && window.__arenaBattle.state === "online"', { timeoutMs: 90000 });
      const onl = await a.eval('({ display: getComputedStyle(document.getElementById("openBtn")).display, mounted: !!window.__arenaPresence })');
      await a.navigate(c.origin + '/pokemonarena/battle.html?cpu=nonsense&anim=0');
      await a.waitFor('window.__arenaBattle && window.__arenaBattle.state === "error"', { timeoutMs: 60000 });
      const err = await a.eval('({ display: getComputedStyle(document.getElementById("openBtn")).display, mounted: !!window.__arenaPresence })');
      ok(onl.display === 'none' && !onl.mounted && err.display === 'none' && !err.mounted, 'UO6 the online page and an error screen never show the Open button and never mount OPEN TO BATTLES', J({ onl, err }));
      ok(uiErrs(a, w, b).length === 0, 'UO8 no page errors', J(uiErrs(a, w, b)).slice(0, 300));
    });
  }
}

// ---- UH: the switch is invisible until the module has mounted, and gone (not a dead button) when the module cannot load
async function uiHidden(c) {
  const { ok } = c;
  if (REMOTE) { ok(true, 'UH0 (skipped against a deployed site: needs a mutated copy)'); return; }
  const { copyTree, mutateFile, startOverlay } = await import('./pokemonarena_overlay.mjs');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-presenceui-'));
  const serve = async (k, mutate) => { const d = copyTree(c.treeDir, path.join(tmp, 'pokemonarena' + k)); mutate(d, mutateFile); return startOverlay({ dir: d, port: c.port(k), upstream: c.origin }); };
  // [a copy of the game whose presence_boot.js takes 3.5 s to load]
  const slow = await serve(0, (d, mf) => mf(d, 'js/presence_boot.js', "import { DEFAULT_RULESET_ID } from './rules.js';", "import { DEFAULT_RULESET_ID } from './rules.js';\nawait new Promise((r) => setTimeout(r, 3500));"));
  // [a copy where one of its imports is a 404]
  const broken = await serve(1, (d, mf) => mf(d, 'js/presence_boot.js', "from './openlobby.js';", "from './openlobby_missing.js';"));
  try {
    await withBrowser({ port: c.cdp(0), width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (hub) => {
      await hub.navigate(slow.url + '/pokemonarena/?net=local');
      await hub.waitFor('window.__arenaHub && window.__arenaHub.state === "ready"', { timeoutMs: 120000 });
      const pre = await hub.eval(`(() => { const b = document.getElementById('openToggle'); const r = b.getBoundingClientRect(); const e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { vis: getComputedStyle(b).visibility, hit: e && e.id, mounted: !!window.__arenaPresence, attr: b.dataset.presence || null }; })()`);
      ok(!pre.mounted && pre.vis === 'hidden' && pre.hit !== 'openToggle' && pre.attr === null, 'UH1 before the module has mounted the switch is invisible and cannot be hit or focused (a press then was silently dropped)', J(pre));
      await uiUntil(hub, 'window.__arenaPresence', 20000);
      const post = await hub.eval(`(() => { const b = document.getElementById('openToggle'); return { vis: getComputedStyle(b).visibility, attr: b.dataset.presence }; })()`);
      ok(post.vis === 'visible' && post.attr === 'ready', 'UH1b and once it has mounted the switch is there (negative control: the rule hides only the unmounted state)', J(post));
      // the CPU battle's Open button: its room is held from the moment the battle is up, but it is invisible, and cannot be hit, until the module has mounted and wired it
      await hub.navigate(slow.url + '/pokemonarena/battle.html?net=local&anim=0');
      await hub.waitFor('window.__arenaBattle && window.__arenaBattle.state === "ready"', { timeoutMs: 120000 });
      const BTN = `(() => { const b = document.getElementById('openBtn'); const r = b.getBoundingClientRect(); const e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { hidden: b.hidden, vis: getComputedStyle(b).visibility, w: r.width, hit: e && e.id, mounted: !!window.__arenaPresence, attr: b.dataset.presence || null }; })()`;
      const pre2 = await hub.eval(BTN);
      ok(!pre2.mounted && pre2.hidden === false && pre2.vis === 'hidden' && pre2.w >= 44 && pre2.hit !== 'openBtn' && pre2.attr === null, 'UH3 on the battle page, before the module has mounted, the Open button holds its room but is invisible and cannot be hit or focused', J(pre2));
      await uiUntil(hub, 'window.__arenaPresence', 20000);
      const post2 = await hub.eval(BTN);
      ok(post2.vis === 'visible' && post2.attr === 'ready' && post2.hit === 'openBtn', 'UH3b and once it has mounted the Open button is there and can be hit', J(post2));
    });
    await withBrowser({ port: c.cdp(1), width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (hub) => {
      await hub.navigate(broken.url + '/pokemonarena/?net=local');
      await hub.waitFor('window.__arenaHub && window.__arenaHub.state === "ready"', { timeoutMs: 120000 });
      await sleep(1500);
      const gone = await hub.eval(`(() => { const b = document.getElementById('openToggle'); return { display: getComputedStyle(b).display, hidden: b.hidden, mounted: !!window.__arenaPresence }; })()`);
      ok(gone.hidden === true && gone.display === 'none' && gone.mounted === false, 'UH2 when presence_boot.js cannot load, the switch is GONE (it used to stay on screen as a dead "Open: off": .textbtn\'s display beat [hidden])', J(gone));
      await hub.navigate(broken.url + '/pokemonarena/battle.html?net=local&anim=0');
      await hub.waitFor('window.__arenaBattle && window.__arenaBattle.state === "ready"', { timeoutMs: 120000 });
      await sleep(1500);
      const gone2 = await hub.eval(`(() => { const b = document.getElementById('openBtn'); return { display: getComputedStyle(b).display, hidden: b.hidden, mounted: !!window.__arenaPresence }; })()`);
      ok(gone2.hidden === true && gone2.display === 'none' && gone2.mounted === false, 'UH4 when presence_boot.js cannot load, the battle page\'s Open button is GONE too (no dead icon)', J(gone2));
    });
  } finally { slow.stop(); broken.stop(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_e) { /* ignore */ } }
}

// every defect below must fail the NAMED case; the session that holds it is run against a copy of the game with only that defect in it
const UI_MUTANTS = [
  { id: 'M01', what: 'Not now loses data-nav-close (B / Esc / X / Backspace no longer decline)', file: 'js/presence_boot.js', from: 'data-nav-default data-nav-close>', to: 'data-nav-default>', run: 'keys', fails: 'UK1' },
  { id: 'M02', what: 'the Escape fallback of a dialog with no input layer is gone', file: 'js/presence_boot.js', from: "if (open && e.key === 'Escape' && !nav)", to: "if (open && e.key === 'Escape' && false)", run: 'keys', fails: 'UK6' },
  { id: 'M03', what: 'Accept is not disabled for its first 600 ms', file: 'js/presence_boot.js', from: 'inert = inertMs > 0; ok.disabled = inert;', to: 'inert = inertMs > 0; ok.disabled = false;', run: 'accept', fails: 'UA1' },
  { id: 'M04', what: 'a button the focus only drifted onto accepts', file: 'js/presence_boot.js', from: 'if (viaRepeat && e.detail === 0) return;', to: '', run: 'accept', fails: 'UA3' },
  { id: 'M05', what: 'the challenge z-index drops under the other dialogs', file: 'js/presence_boot.js', from: 'inset: 0; z-index: 3100;', to: 'inset: 0; z-index: 1;', run: 'stack', fails: 'US1' },
  { id: 'M06', what: 'the challenge is not moved to the end of the document when it is shown', file: 'js/presence_boot.js', from: 'if (el.parentNode !== body || el.nextElementSibling) body.appendChild(el);', to: '', run: 'stack', fails: 'US5' },
  { id: 'M07', what: 'the hub\'s pause state is one boolean again', file: 'js/boot.js', from: 'dialogOpen = dlgOwners.size > 0;', to: 'dialogOpen = !!v;', run: 'stack', fails: 'US2' },
  { id: 'M08', what: 'the battle page\'s pause state is one boolean again', file: 'js/battle_boot.js', from: 'controlsOpen = pauseOwners.size > 0;', to: 'controlsOpen = !!v;', run: 'cross', fails: 'UB2' },
  { id: 'M09', what: 'no storage listener (another tab\'s switch is not followed)', file: 'js/presence_boot.js', from: "listen(win, 'storage', onStorage);", to: '', run: 'cross', fails: 'UX1' },
  { id: 'M10', what: 'the listing is not refreshed when the tab becomes visible', file: 'js/presence_boot.js', from: "listen(doc, 'visibilitychange', () => { if (!doc.hidden) refresh(); });", to: '', run: 'refresh', fails: 'UR1' },
  { id: 'M11', what: 'refresh() does not read the trainer again (and neither does the restore path)', file: 'js/presence_boot.js', from: 'const r = await readTrainer();', to: 'const r = { ok: true, trainer };', run: 'refresh', fails: 'UR1' },
  { id: 'M12', what: 'dispose() leaves the dialog in the document', file: 'js/presence_boot.js', from: 'dialog.destroy(); disclosure.destroy();', to: '', run: 'refresh', fails: 'UR5' },
  { id: 'M19', what: 'neither dispose() nor a new dialog removes the dialog of the previous mount (two #challenge in the document)', file: 'js/presence_boot.js', from: 'dialog.destroy(); disclosure.destroy();', to: '', also: [{ file: 'js/presence_boot.js', from: 'if (stale && stale.parentNode) stale.parentNode.removeChild(stale);', to: '' }], run: 'refresh', fails: 'UR4' },
  { id: 'M13', what: 'a start that was overtaken still builds its listing', file: 'js/presence_boot.js', from: 'if (disposed || mine !== gen) return false;', to: 'if (disposed) return false;', run: 'rapid', fails: 'UP1' },
  { id: 'M14', what: 'no disclosure on the first switch-on', file: 'js/presence_boot.js', from: 'if (!on && disclosureWanted()) {', to: 'if (false) {', run: 'disclosure', fails: 'UD1' },
  { id: 'M15', what: 'a stored "on" nobody was told about is honoured', file: 'js/presence_boot.js', from: 'if (disclosureWanted()) setOpen(storage, false); else setOn(true, { persist: false });', to: 'setOn(true, { persist: false });', run: 'disclosure', fails: 'UD7' },
  { id: 'M16', what: 'the switch keeps the focus after a mouse click', file: 'js/presence_boot.js', from: 'if (e && e.detail > 0) {', to: 'if (false) {', run: 'disclosure', fails: 'UM1' },
  { id: 'M17', what: 'a dead switch is not hidden when the module cannot load (the [hidden] rule is gone)', file: 'arena.css', from: '#openToggle[hidden] { display: none; }', to: '', run: 'hidden', fails: 'UH2' },
  { id: 'M18', what: 'the switch is visible before the module has mounted', file: 'arena.css', from: '#openToggle:not([data-presence="ready"]) { visibility: hidden; }', to: '', run: 'hidden', fails: 'UH1' },
  { id: 'M20', what: 'the hub switch\'s name changes with its state again (no constant aria-label)', file: 'js/presence_boot.js', from: "button.setAttribute('aria-label', OPEN_LABEL);", to: '', also: [{ file: 'index.html', from: ' aria-label="Open to battles" title=', to: ' title=' }], run: 'words', fails: 'UN1' },
  { id: 'M21', what: 'the battle page\'s Open button changes its name with its state again (no constant aria-label)', file: 'js/presence_boot.js', from: "button.setAttribute('aria-label', OPEN_LABEL);", to: '', also: [{ file: 'battle.html', from: ' aria-label="Open to battles" hidden title=', to: ' hidden title=' }], run: 'battlebtn', fails: 'UN2' },
  { id: 'M22', what: 'the drift guard reads the focus at the moment of the press (the old way): a dialog under the challenge has already moved it', file: 'js/presence_boot.js', from: 'function watchFocus(ev) {', to: 'function watchFocus(ev) { const had = doc.activeElement === ok;', also: [{ file: 'js/presence_boot.js', from: 'arrived = there && !wasOnOk;', to: 'arrived = there && !had;' }], run: 'drift', fails: 'UA5' },
  { id: 'M23', what: 'the off-state tooltip names only the trainer name', file: 'js/presence_boot.js', from: 'list your trainer name and online record on public servers so anyone using Play online can challenge you', to: 'list your trainer name on public servers so anyone using Play online can challenge you', run: 'words', fails: 'UW1' },
  { id: 'M24', what: 'the live-region message names only the trainer name', file: 'js/presence_boot.js', from: "const ON_SAYS = 'Open to battles. Your trainer name and online record are listed for anyone using Play online.';", to: "const ON_SAYS = 'Open to battles. Your trainer name is listed for anyone using Play online.';", run: 'words', fails: 'UW2' },
  { id: 'M25', what: 'RESET RECORD in the hub does not tell the listing', file: 'js/boot.js', from: 'if (hook.presence) hook.presence.refresh().catch(', to: 'if (false) hook.presence.refresh().catch(', run: 'record', fails: 'UQ1' },
  { id: 'M26', what: 'a store that cannot be read lists the player as "Player" with no record', file: 'js/presence_boot.js', from: 'if (r.ok && trainerKey(r.trainer) !== trainerKey(trainer))', to: 'if (trainerKey(r.ok ? r.trainer : null) !== trainerKey(trainer))', run: 'record', fails: 'UQ2' },
  { id: 'M27', what: 'a refresh asked for while a read is under way is handed the old answer', file: 'js/presence_boot.js', from: 'if (refreshing) { again = true; return refreshing; }', to: 'if (refreshing) { return refreshing; }', run: 'record', fails: 'UQ3' },
  { id: 'M28', what: 'a CPU battle loaded with the switch off does not mount OPEN TO BATTLES (the old condition)', file: 'js/battle_boot.js', from: "if (openBtn) openBtn.hidden = false;\n    import('./presence_boot.js').then((m) => {", to: "if (openBtn) openBtn.hidden = false;\n    if (window.localStorage.getItem('arena.open') === '1') import('./presence_boot.js').then((m) => {", run: 'battlebtn', fails: 'UO1' },
  { id: 'M29', what: 'the battle page never shows the Open button', file: 'js/battle_boot.js', from: 'if (openBtn) openBtn.hidden = false;', to: '', run: 'battlebtn', fails: 'UO1' },
  { id: 'M30', what: 'the module prints "Open: off" over the battle button\'s icon', file: 'js/battle_boot.js', from: 'button: openBtn, buttonText: false,', to: 'button: openBtn,', run: 'battlebtn', fails: 'UO4' },
  { id: 'M31', what: 'on a phone the Open button takes an equal share of the tools row like the text buttons', file: 'battle.css', from: '#top .tools .textbtn.iconbtn { flex: 0 0 44px; }', to: '', run: 'battlebtn', fails: 'UL1' },
  { id: 'M32', what: 'the battle page\'s Open button is visible before the module has mounted', file: 'battle.css', from: '#openBtn:not([data-presence="ready"]) { visibility: hidden; }', to: '', run: 'hidden', fails: 'UH3' },
  { id: 'M33', what: 'a dead Open button stays on the battle page when the module cannot load (the [hidden] rule is gone)', file: 'battle.css', from: '#openBtn[hidden] { display: none; }', to: '', run: 'hidden', fails: 'UH4' },
  { id: 'M34', what: 'at 320 px the Open button squeezes "Sound: on" onto two lines (the narrow-phone padding rule is gone)', file: 'battle.css', from: '@media (max-width: 359px) { #top .tools .textbtn:not(.iconbtn) { padding-left: 6px; padding-right: 6px; } }', to: '', run: 'battlebtn', fails: 'UL1' },
  { id: 'M35', what: 'a phone held sideways (568 x 320): the header with the Open icon is wider than the screen (the landscape squeeze is gone)', file: 'battle.css', from: '@media (max-width: 640px) and (max-height: 500px) {\n  #top { gap: 6px; }\n  #top .tools { gap: 6px; }\n  #top .tools .textbtn:not(.iconbtn) { padding-left: 9px; padding-right: 9px; }\n}', to: '', run: 'battlebtn', fails: 'UL1' },
  { id: 'M36', what: 'the battle page has no live region, so the Open switch messages go nowhere', file: 'battle.html', from: '<div id="live" class="sr" role="status" aria-live="polite"></div>', to: '', run: 'battlebtn', fails: 'UO2c' },
];
const UI_SESSIONS = { keys: uiKeys, accept: uiAccept, drift: uiDrift, stack: uiStack, cross: uiCross, refresh: uiRefresh, record: uiRecord, rapid: uiRapid, disclosure: uiDisclosure, words: uiWords, touch: uiTouch, battlebtn: uiBattleBtn, hidden: uiHidden };

async function groupPresenceUi(S) {
  ANIM = '&anim=0';
  const base = (k) => CDP0 + 36 + (k % 4);
  const mk = (origin, okFn, portBase, treeDir) => ({ origin, ok: okFn, cdp: base, port: (k) => portBase + k, treeDir });
  const run = async (name, c) => { try { await UI_SESSIONS[name](c); } catch (e) { c.ok(false, 'UI ' + name + ' session crashed', e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e)); } };
  const wanted = (process.env.ARENA_UI || '').split(',').filter(Boolean);          // ARENA_UI=keys,accept runs only those sessions (while working on one)
  for (const name of ['keys', 'accept', 'drift', 'stack', 'cross', 'refresh', 'record', 'rapid', 'disclosure', 'words', 'touch', 'battlebtn', 'hidden']) if (!wanted.length || wanted.includes(name)) await run(name, mk(ORIGIN, ok, PORT + 1, path.join(root, 'pokemonarena')));
  if (!process.argv.includes('--mutants')) return;
  if (REMOTE) { ok(true, 'UMUT (skipped against a deployed site)'); return; }
  const { copyTree, mutateFile, startOverlay } = await import('./pokemonarena_overlay.mjs');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-presenceui-mut-'));
  let killed = 0, ran = 0;
  try {
    for (const mu of UI_MUTANTS) {
      if (wanted.length && !wanted.includes(mu.run)) continue;
      const failed = [];
      const rec = (cond, name, detail) => { if (!cond) failed.push(name + (detail ? ' :: ' + String(detail).slice(0, 160) : '')); };
      ran++;
      const dir = copyTree(path.join(root, 'pokemonarena'), path.join(tmp, mu.id));
      let ov = null;
      try {
        try { mutateFile(dir, mu.file, mu.from, mu.to); for (const x of mu.also || []) mutateFile(dir, x.file, x.from, x.to); } catch (e) { ok(false, 'UMUT ' + mu.id + ' could not be applied', e.message); continue; }
        ov = await startOverlay({ dir, port: PORT + 3, upstream: ORIGIN });
        await run(mu.run, mk(ov.url, rec, PORT + 4, dir));
      } finally { if (ov) ov.stop(); }
      const hit = failed.find((f) => f.startsWith(mu.fails + ' ') || f.startsWith(mu.fails + 'b '));
      const crashed = failed.find((f) => /session crashed/.test(f));
      ok(!!hit, 'UMUT ' + mu.id + ' (' + mu.what + ') fails ' + mu.fails, hit ? '' : 'it did NOT: failed cases = ' + J(failed.map((f) => f.slice(0, 60))));
      if (hit) killed++;
      if (crashed && !hit) console.log('   note: ' + mu.id + ' crashed its session: ' + crashed.slice(0, 200));
    }
  } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_e) { /* ignore */ } }
  console.log(`presenceui mutants: ${killed}/${ran} killed`);
}

/* ---------------------------------------------------------------------------------------------- onlineux: the panel pressed twice, a join given up, a list under a keyboard, what the page remembers and says */
// What the setup panel does when a button is pressed twice, when a join has to be abandoned, when the board changes under a keyboard user, what it remembers about the player and what it publishes,
// and what it tells them about that. Every case id starts with OX (OXR re-entry, OXC cancel, OXF focus, OXV relist, OXN names, OXP/OXI the record and the store, OXM a reload mid-match,
// OXG a resume given up, OXT the words).
//   node tools/pokemonarena_online_page_test.mjs onlineux             the cases
//   node tools/pokemonarena_online_page_test.mjs onlineux --mutants   ALSO serve a copy of the game with ONE defect at a time (tools/pokemonarena_overlay.mjs); each must fail the named case
// Every page of a session is on ONE origin (c.origin: the real server, or a mutated copy of the game in front of it), because the board is a BroadcastChannel and a channel is per origin.
const UX_URL = (c, q) => c.origin + '/pokemonarena/battle.html?' + q;
const UX_READY = 'window.__arenaOnline && document.getElementById("olGo") && !document.getElementById("olGo").disabled && window.__arenaBattle && window.__arenaBattle.state === "online"';
const uxPanel = async (c, page, extra = '') => { await page.navigate(UX_URL(c, 'online=1&net=local&anim=0' + extra)); await page.waitFor(UX_READY + ' && !document.getElementById("olQuick").disabled', { timeoutMs: 90000 }); };
const uxRoom = async (c, page, room, role, extra = '') => { await page.navigate(UX_URL(c, 'np=' + room + '&' + (role === 'host' ? 'host=1' : 'join=1') + '&net=local&anim=0' + extra)); await page.waitFor(UX_READY, { timeoutMs: 90000 }); };
// a same-origin page with nothing in it that speaks and listens on the board's channel (the page under test hears it as "another browser"); uxKeep keeps some listings alive on it (a beacon lasts 13 s)
const uxWire = async (c, page) => { await page.navigate(c.origin + '/pokemonarena/input.css'); await page.eval('(() => { window.__spy = []; const ch = new BroadcastChannel("bemental-arena-open-1"); ch.onmessage = (e) => window.__spy.push(e.data); window.__spyCh = ch; return true; })()'); };
const uxKeep = (p, msgs) => p.eval('(() => { window.__keepMsgs = ' + J(msgs) + '; const ch = window.__keepCh || (window.__keepCh = new BroadcastChannel("bemental-arena-open-1")); for (const m of window.__keepMsgs) ch.postMessage(m); if (!window.__keepIv) window.__keepIv = setInterval(() => { for (const m of window.__keepMsgs) ch.postMessage(m); }, 2500); return true; })()');
async function uxHost(c, page, name, extra = '') {
  await uxPanel(c, page, extra);
  await setForm(page, { name, fmt: '3v3', pub: true, role: 'host' });
  await page.eval('document.getElementById("olGo").click()');
  await page.waitFor('document.getElementById("olCode").hidden === false', { timeoutMs: 30000 });
  return (await page.eval('document.getElementById("olCode").textContent')).trim();
}
// counts every Session the page starts (the page looks Netplay.Session up each time it starts one)
const UX_COUNT = '(() => { window.__sessions = 0; const S = Netplay.Session; Netplay.Session = class extends S { constructor(...a) { super(...a); window.__sessions++; } }; return Netplay.Session !== S; })()';
// counts every indexedDB.open() the page makes from now on
const UX_IDB = '(() => { window.__idb = 0; const o = IDBFactory.prototype.open; IDBFactory.prototype.open = function (...a) { window.__idb++; return o.apply(this, a); }; return true; })()';
const UX_SQUAD = ['Pikachu', 'Charizard', 'Snorlax'];
const UX_MATCH_BASE = `{ fmt: '3v3', cpu: 'online', opp: 'Zed', ruleset: 'arena-gen3-standard', turns: 9, playMs: 50000, mvp: 25, team: [25, 6, 9], species: [25, 6], moves: [[85, 3], [33, 2]], me: { kos: 2, faints: 1, dealt: 300, taken: 200, hits: 5, crits: 1, superEffective: 2, resisted: 1, noEffect: 0, misses: 1, statusInflicted: 1, healed: 20, switches: 1, koStreak: 2, biggestHit: { sp: 25, mv: 85, dmg: 120, pct: 70, vs: 6 } }, foeFaints: 3 }`;
// gives a profile an ONLINE record through the real store: one battle per result ('w' / 'l'); -> the profile's online row
const UX_RECORD_JS = (id, results) => `(async () => { const S = await import('/pokemonarena/js/store.js'); const store = await S.openStore(); const base = ${UX_MATCH_BASE}; const res = ${J(results)};
  for (let i = 0; i < res.length; i++) await store.recordMatch(${J(id)}, Object.assign({}, base, { id: 'rec' + i, at: 1800000000000 + i * 86400000, result: res[i] }));
  const r = await store.loadProfile(${J(id)}); await store.close(); return r.ok ? r.profile.stats.byCpu.online : null; })()`;

// ---- OXR: one way in at a time. A second press while the first is still reading the team must not start a second session.
async function uxJoin(c) {
  const { ok } = c;
  await withBrowser({ port: c.cdp(0), width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (host) => {
    const guest = await host.openTab({ width: 900, height: 760 });
    await uxHost(c, host, 'Hal', '&openjoin=15000');
    await uxPanel(c, guest, '&openjoin=15000');
    await guest.waitFor('document.querySelectorAll("#olOpenList li").length === 1', { timeoutMs: 15000 });
    await setForm(guest, { name: 'Gus' });
    ok((await guest.eval(UX_COUNT)) === true, 'OXR0 (the rig) the page\'s Session constructor is replaced by one that counts', '');
    await guest.eval('(() => { const b = document.querySelector("#olOpenList li button"); b.click(); b.click(); return true; })()');          // two presses in one tick: both pass the "still at the setup form" check
    await guest.waitFor('window.__arenaOnline.state.stage !== "setup"', { timeoutMs: 20000 });
    await sleep(2000);
    const n = await guest.eval('window.__sessions');
    ok(n === 1, 'OXR1 two presses on Join start ONE session (the second is ignored, not a second connection that leaks)', 'sessions started: ' + n);
    const r = await bothPlaying(host, guest, 60000, host);
    ok(r.phases[0] === 'playing' && r.phases[1] === 'playing' && !r.prompted, 'OXR1b and that one session gets into the battle, with no prompt', J(r));
    ok(host.errors.length === 0 && guest.errors.length === 0, 'OXR1c no page errors', J(host.errors.concat(guest.errors)).slice(0, 200));
  });
}
async function uxQuick(c) {
  const { ok } = c;
  await withBrowser({ port: c.cdp(0), width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (host) => {
    const guest = await host.openTab({ width: 900, height: 760 });
    await uxHost(c, host, 'Ivy', '&openquick=1500&openjoin=15000');
    await uxPanel(c, guest, '&openquick=1500&openjoin=15000');
    await guest.waitFor('document.querySelectorAll("#olOpenList li").length === 1', { timeoutMs: 15000 });
    await setForm(guest, { name: 'Jon' });
    await guest.eval(UX_COUNT);
    await guest.eval('(() => { document.getElementById("olQuick").click(); document.querySelector("#olOpenList li button").click(); return true; })()');          // Join pressed while Find a battle is still reading the team
    await guest.waitFor('window.__arenaOnline.state.stage !== "setup"', { timeoutMs: 20000 });
    await sleep(3500);
    const n = await guest.eval('window.__sessions');
    ok(n === 1, 'OXR2 Join pressed while Find a battle is looking starts ONE session, not two', 'sessions started: ' + n);
    const r = await bothPlaying(host, guest, 60000, host);
    ok(r.phases[0] === 'playing' && r.phases[1] === 'playing', 'OXR2b and that session gets into the battle', J(r));
  });
}
async function uxChallenge(c) {
  const { ok } = c;
  await withBrowser({ port: c.cdp(0), width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (ch) => {
    const wire = await ch.openTab({ width: 900, height: 760 });
    await uxPanel(c, ch, '&openchal=20000');
    await uxWire(c, wire);
    const id = await identity(ch);
    await uxKeep(wire, [fake(id, { room: 'HRESX', s: '00000000000000c1', h: 1, name: 'Resi' })]);          // a player who is in the hub: a resident game, challenged rather than joined
    await ch.waitFor('document.querySelector("#olOpenList li[data-room^=H] button")', { timeoutMs: 15000 });
    await setForm(ch, { name: 'Chad' });
    await ch.eval('(() => { const b = document.querySelector("#olOpenList li[data-room^=H] button"); b.click(); b.click(); return true; })()');
    await ch.waitFor('window.__arenaOnline.state.stage === "asking"', { timeoutMs: 15000 });
    await sleep(1500);
    const chals = (await spied(wire)).filter((m) => m && m.k === 'chal');
    const rs = [...new Set(chals.map((m) => m.r))];
    ok(chals.length >= 1 && rs.length === 1, 'OXR3 two presses on Challenge send ONE challenge (one request id on the wire, not two that the second leaves nobody able to cancel)', J(rs));
    ok(ch.errors.length === 0, 'OXR3b no page errors', J(ch.errors).slice(0, 200));
  });
}

// ---- OXC: a join can be cancelled while it waits
async function uxCancel(c) {
  const { ok } = c;
  await withBrowser({ port: c.cdp(0), width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (a) => {
    const b = await a.openTab({ width: 900, height: 760 });
    await uxPanel(c, a, '&openjoin=4000');
    await uxWire(c, b);
    const id = await identity(a);
    await uxKeep(b, [fake(id, { room: 'AGHOX', s: '00000000000000c9', name: 'Ghost' })]);          // a made-up game: nobody will ever answer a knock on it
    await a.waitFor('document.querySelector(\'#olOpenList li[data-room="AGHOX"]\')', { timeoutMs: 10000 });
    await setForm(a, { name: 'Ann' });
    await clickJoin(a, 'AGHOX');
    await a.waitFor('window.__arenaOnline.state.stage === "waiting"', { timeoutMs: 15000 });
    const w = await a.eval('({ cancel: !document.getElementById("olCancelAsk").hidden, status: document.getElementById("olStatus").textContent })');
    ok(w.cancel && /gives up after 4 seconds/.test(w.status), 'OXC1 while a listed join waits there is a Cancel, and the status says how long the wait can last', J(w));
    await a.eval('document.getElementById("olCancelAsk").click()');
    const x = await a.eval('({ stage: window.__arenaOnline.state.stage, status: document.getElementById("olStatus").textContent, noSession: window.__arenaOnline.session() === null, cancelHidden: document.getElementById("olCancelAsk").hidden, go: !document.getElementById("olGo").disabled, quick: !document.getElementById("olQuick").disabled, name: !document.getElementById("olName").disabled })');
    ok(x.stage === 'setup' && x.status === 'Cancelled.' && x.noSession && x.cancelHidden && x.go && x.quick && x.name, 'OXC2 Cancel closes the connection and puts the panel back to the board, usable', J(x));
    // the same game can be tried again, and a join nobody answers still ends in words (nothing was left stuck by the cancel)
    await a.waitFor('document.querySelector(\'#olOpenList li[data-room="AGHOX"]\')', { timeoutMs: 10000 });
    await clickJoin(a, 'AGHOX');
    await a.waitFor('window.__arenaOnline.state.stage === "setup" && /not open any more/.test(document.getElementById("olStatus").textContent)', { timeoutMs: 25000 });
    ok(true, 'OXC3 after a cancel the same game can be joined again, and when nobody answers it is given up on in words', await statusText(a));
    ok(a.errors.length === 0, 'OXC4 no page errors', J(a.errors).slice(0, 200));
  });
}

// ---- OXF: the list is updated in place
async function uxFocus(c) {
  const { ok } = c;
  await withBrowser({ port: c.cdp(0), width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (a) => {
    const b = await a.openTab({ width: 900, height: 760 });
    await uxPanel(c, a);
    await uxWire(c, b);
    const id = await identity(a);
    const G = (room, s, over = {}) => fake(id, { room, s, name: room.slice(1).replace('FOC', 'Game '), ...over });
    const g1 = G('AFOC1', '00000000000000d1'), g2 = G('AFOC2', '00000000000000d2'), g3 = G('AFOC3', '00000000000000d3');
    await uxKeep(b, [g1, g2]);
    await a.waitFor('document.querySelectorAll("#olOpenList li").length === 2', { timeoutMs: 10000 });
    ok(await a.eval('(() => { const btn = document.querySelector(\'#olOpenList li[data-room="AFOC2"] button\'); btn.focus(); btn.__mark = "two"; window.__li2 = btn.closest("li"); return document.activeElement === btn; })()'), 'OXF0 (the rig) the second Join button can hold the keyboard focus', '');
    // another game appears and the first one changes its format and shows a record: the board changes under the focused button
    const g1b = G('AFOC1', '00000000000000d1', { fmt: '6v6', rec: [3, 1] });
    await uxKeep(b, [g1b, g2, g3]);
    await a.waitFor('document.querySelectorAll("#olOpenList li").length === 3 && document.querySelector(\'#olOpenList li[data-room="AFOC1"] .fmt\').textContent === "6 v 6"', { timeoutMs: 10000 });
    const kept = await a.eval('({ mark: document.activeElement && document.activeElement.__mark, same: document.querySelector(\'#olOpenList li[data-room="AFOC2"]\') === window.__li2, rec: (document.querySelector(\'#olOpenList li[data-room="AFOC1"] .rec\') || {}).textContent })');
    ok(kept.mark === 'two' && kept.same && kept.rec === '3-1', 'OXF1 a game appearing and another changing leave the focused Join button where it was (same row, same button, still focused), and the changed row is updated in place', J(kept));
    // the focused game leaves: the focus goes to a neighbour, not to the top of the page
    await uxKeep(b, [g1b, g3]);
    await b.eval('(() => { const ch = new BroadcastChannel("bemental-arena-open-1"); ch.postMessage({ t: "arenaopen", v: 1, k: "gone", s: "00000000000000d2", room: "AFOC2" }); ch.close(); return true; })()');
    await a.waitFor('document.querySelectorAll("#olOpenList li").length === 2', { timeoutMs: 10000 });
    const heir = await a.eval('(() => { const e = document.activeElement; return { id: e && e.id, room: e && e.closest && e.closest("li") ? e.closest("li").dataset.room : null, body: e === document.body }; })()');
    ok(!heir.body && (heir.room === 'AFOC3' || heir.id === 'olQuick'), 'OXF2 when the focused game itself leaves, the focus moves to the row that took its place, not to the page body', J(heir));
    // a game on another build is hidden AND counted, with games on show too
    await uxKeep(b, [g1b, g3, G('AOLD1', '00000000000000d4', { fp: 'e0.other.build', name: 'Old' })]);
    await a.waitFor('/different version/.test(document.getElementById("olOpenNote").textContent)', { timeoutMs: 8000 }).catch(() => {});          // (a poll, not the verdict: the case below reads the note and fails by name if it never counted the game)
    const note = await boardNote(a);
    ok(/^2 games are waiting for an opponent\./.test(note) && /1 open on a different version of the Arena, hidden/.test(note), 'OXF3 with games on show, the games on another build are still counted (the note used to say so only when the list was empty)', note);
    ok(a.errors.length === 0, 'OXF4 no page errors', J(a.errors).slice(0, 200));
  });
}

// ---- OXV: a game that goes back on the board does not carry the last opponent's "Connection lost" to the next one
async function uxRelist(c) {
  const { ok } = c;
  await withBrowser({ port: c.cdp(0), width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (h) => {
    const raw = await h.openTab({ width: 900, height: 760 });
    const room1 = await uxHost(c, h, 'Walt');
    await uxPanel(c, raw);
    await raw.eval('(async () => { const s = new Netplay.Session({ code: ' + J(room1) + ', host: false, portCount: 2, transport: "local" }); window.__rawS = s; const up = new Promise((res) => s.on("status", (e) => { if (e.state === "connected") res(true); })); s.start(); await up; return true; })()');
    await h.waitFor('window.__arenaOnline.nm() !== null', { timeoutMs: 20000 });
    await raw.navigate('about:blank');          // the joiner's page goes away in the middle of the handshake: the link drops under the match
    await h.waitFor('window.__arenaOnline.state.room !== ' + J(room1) + ' && window.__arenaOnline.state.stage === "open"', { timeoutMs: 80000 });
    const flash = await h.eval('window.__arenaOnline.flashNow()');
    ok(flash === '', 'OXV1 once the game is back on the board the bar holds no notice from the match that just ended ("Connection lost..." would greet the next opponent)', J(flash));
    ok(h.errors.length === 0, 'OXV2 no page errors', J(h.errors).slice(0, 200));
  });
}

// ---- OXN: the name
async function uxNames(c) {
  const { ok } = c;
  const SPEC = [['ALICE', [['Alice Squad', UX_SQUAD]]], ['BOBBY', [['Bobby Squad', ['Blastoise', 'Gengar', 'Eevee']]]]];
  const nameBox = (p) => p.eval('document.getElementById("olName").value');
  const remembered = (p) => p.eval('localStorage.getItem("arena.online.name")');
  await withBrowser({ port: c.cdp(0), width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (p) => {
    await uxPanel(c, p);
    const seeded = await p.eval(SEED_PROFILES_JS(SPEC));
    const [pa, pb] = seeded.profiles, keyB = 'saved:' + pb.id + ':' + pb.teams[0];
    await uxPanel(c, p);
    ok((await nameBox(p)) === 'ALICE' && (await p.eval('document.getElementById("olTeam").value')).startsWith('saved:' + pa.id), 'OXN0 (the rig) the active profile\'s team is pre-selected and the name box is its trainer', await nameBox(p));
    await pickTeam(p, keyB);
    ok((await nameBox(p)) === 'BOBBY', 'OXN0b choosing the other trainer\'s team fills in that trainer', await nameBox(p));
    await p.eval('document.getElementById("olGo").click()');
    await p.waitFor('document.getElementById("olCode").hidden === false', { timeoutMs: 30000 });
    ok((await remembered(p)) === null, 'OXN1 a name the PANEL filled in is not remembered as the player\'s (only a typed one is)', J(await remembered(p)));
    await uxPanel(c, p);
    ok((await nameBox(p)) === 'ALICE', 'OXN2 the next visit starts with the trainer who owns the pre-selected team, not the owner of the team used last time', await nameBox(p));
    await setForm(p, { name: 'Zed' });
    await p.eval('document.getElementById("olGo").click()');
    await p.waitFor('document.getElementById("olCode").hidden === false', { timeoutMs: 30000 });
    ok((await remembered(p)) === 'Zed', 'OXN3 a name the player TYPED is remembered', J(await remembered(p)));
    await uxPanel(c, p);
    ok((await nameBox(p)) === 'Zed', 'OXN3a and is what the next visit starts with', await nameBox(p));
    await pickTeam(p, keyB);
    ok((await nameBox(p)) === 'Zed', 'OXN3b and stays when the team is changed (a remembered name was typed by the player, so it is theirs)', await nameBox(p));
    ok(p.errors.length === 0, 'OXN3c no page errors', J(p.errors).slice(0, 200));
  });
  // the active profile has no team to play: the pre-selected team is another trainer's, and the name is that trainer's
  await withBrowser({ port: c.cdp(1), width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (p) => {
    await uxPanel(c, p);
    const seeded = await p.eval(SEED_PROFILES_JS([['ALICE', []], SPEC[1]]));
    const pb = seeded.profiles[1];
    await uxPanel(c, p);
    const v = await p.eval('({ name: document.getElementById("olName").value, team: document.getElementById("olTeam").value })');
    ok(v.name === 'BOBBY' && v.team.startsWith('saved:' + pb.id), 'OXN4 when the active profile has no team the pre-selected team is another trainer\'s and so is the name (it used to show the active profile\'s name over it)', J(v));
  });
}

// ---- OXP / OXI: the record that goes beside the name, and the store the panel opens to find it
async function uxRec(c) {
  const { ok } = c;
  await withBrowser({ port: c.cdp(0), width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (ch) => {
    const wire = await ch.openTab({ width: 900, height: 760 });
    await uxPanel(c, ch);
    const seeded = await ch.eval(SEED_PROFILES_JS([['ALICE', [['Alice Squad', UX_SQUAD]]]]));
    const pa = seeded.profiles[0];
    const online = await ch.eval(UX_RECORD_JS(pa.id, ['w', 'w', 'l']));
    ok(online && online.w === 2 && online.l === 1, 'OXP0 (the rig) the profile has an online record of 2 wins and 1 loss', J(online));
    await uxPanel(c, ch, '&openchal=20000');
    await uxWire(c, wire);
    const id = await identity(ch);
    await uxKeep(wire, [fake(id, { room: 'HRESX', s: '00000000000000c1', h: 1, name: 'Resi' })]);
    await ch.waitFor('document.querySelector("#olOpenList li[data-room^=H] button")', { timeoutMs: 15000 });
    const one = await ch.eval(`(async () => { let n = 0; const o = IDBFactory.prototype.open; IDBFactory.prototype.open = function (...a) { n++; return o.apply(this, a); }; const S = await import('/pokemonarena/js/store.js'); const st = await S.openStore(); await st.close(); IDBFactory.prototype.open = o; return n; })()`);
    const chalsNow = async () => { const all = (await spied(wire)).filter((m) => m && m.k === 'chal'); return all; };
    // the saved team (ALICE's, pre-selected): the challenge carries ALICE's online record, and the store was opened once for it
    await ch.eval(UX_IDB);
    await ch.eval('document.querySelector("#olOpenList li[data-room^=H] button").click()');
    await ch.waitFor('window.__arenaOnline.state.stage === "asking"', { timeoutMs: 15000 });
    await sleep(500);
    const opens1 = await ch.eval('window.__idb');
    const c1 = (await chalsNow()).slice(-1)[0];
    ok(c1 && J(c1.rec) === J([2, 1]), 'OXP1 a challenge sent from the panel carries the challenger\'s online record (2-1), read before the challenge went out', J(c1));
    ok(opens1 === one, 'OXI2 and a saved team opens the store ONCE for the team and the record together', opens1 + ' opens, one openStore() = ' + one);
    await ch.eval('document.getElementById("olCancelAsk").click()');
    await ch.waitFor('window.__arenaOnline.state.stage === "setup"', { timeoutMs: 10000 });
    // a random team: no profile owns it, so no record goes beside the name, and the store is not opened at all
    await pickTeam(ch, 'random');
    await ch.eval('window.__idb = 0; document.querySelector("#olOpenList li[data-room^=H] button").click()');
    await ch.waitFor('window.__arenaOnline.state.stage === "asking"', { timeoutMs: 15000 });
    await sleep(500);
    const opens2 = await ch.eval('window.__idb');
    const all = await chalsNow(), c2 = all.slice(-1)[0];
    ok(all.length >= 2 && c2.r !== c1.r && !c2.rec, 'OXP2 a challenge made with a random team carries NO record (nothing of the active profile is published beside a name for a team that is not its own)', J(c2));
    ok(opens2 === 0, 'OXI1 and a random team opens the store not at all (it used to open IndexedDB on every press, however the team was chosen)', opens2 + ' opens');
    ok(ch.errors.length === 0, 'OXP3 no page errors', J(ch.errors).slice(0, 200));
  });
}

// ---- OXM: a reload in the middle of a match comes back to the same profile
async function uxResume(c) {
  const { ok } = c;
  await withBrowser({ port: c.cdp(0), width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (host) => {
    const guest = await host.openTab({ width: 900, height: 760 });
    await uxRoom(c, host, 'AUXR1', 'host');
    // two profiles whose teams are the SAME team code: the career's own lookup (the team's owner, the active profile first) would pick ALICE for either
    const seeded = await host.eval(SEED_PROFILES_JS([['ALICE', [['Squad', UX_SQUAD]]], ['BOBBY', [['Squad', UX_SQUAD]]]]));
    const [pa, pb] = seeded.profiles;
    await uxRoom(c, host, 'AUXR1', 'host'); await uxRoom(c, guest, 'AUXR1', 'guest');
    await pickTeam(host, 'saved:' + pa.id + ':' + pa.teams[0]); await pickTeam(guest, 'saved:' + pb.id + ':' + pb.teams[0]);
    await host.eval('document.getElementById("olFmt").value = "3v3"; document.getElementById("olGo").click()');
    await host.waitFor('document.getElementById("olCode").hidden === false', { timeoutMs: 30000 });
    await guest.eval('document.getElementById("olGo").click()');
    await approve(host, true);
    for (let i = 0; i < 160 && !((await phase(host)) === 'playing' && (await phase(guest)) === 'playing'); i++) await sleep(250);
    await host.waitFor('window.__arenaBattle.state === "ready"', { timeoutMs: 30000 }); await guest.waitFor('window.__arenaBattle.state === "ready"', { timeoutMs: 30000 });
    ok((await guest.eval('window.__arenaOnline.state.profileId')) === pb.id, 'OXM0 (the rig) the guest plays BOBBY\'s team, so its battle belongs to BOBBY', await guest.eval('window.__arenaOnline.state.profileId'));
    await Promise.all([aiRounds(host, 3), aiRounds(guest, 3)]);
    await guest.send('Page.reload', { ignoreCache: false });
    await guest.waitFor('window.__arenaOnline && window.__arenaBattle && window.__arenaBattle.state === "ready" && window.__arenaBattle.resume', { timeoutMs: 90000 });
    ok((await guest.eval('window.__arenaOnline.state.profileId')) === pb.id, 'OXM1 the page that was reloaded in the middle of the match still knows whose team it was playing', await guest.eval('window.__arenaOnline.state.profileId'));
    await guest.waitFor('window.__arenaOnline.nm().status().link === "up"', { timeoutMs: 60000 }); await host.waitFor('window.__arenaOnline.nm().status().link === "up"', { timeoutMs: 60000 });
    const id1 = matchIdOf(await host.eval('window.__arenaOnline.state.info'));
    await finishMatch(host, guest, id1);
    const [A, B] = [await host.eval(LOAD_PROFILE_JS(pa.id)), await host.eval(LOAD_PROFILE_JS(pb.id))];
    const sum = (r) => r.w + r.l + r.dr + r.f;
    ok(sum(A.stats.byCpu.online) === 1 && sum(B.stats.byCpu.online) === 1, 'OXM2 each career holds its own battle: the guest\'s, finished after a reload, went into BOBBY\'s record and not the active profile\'s', J([A.stats.byCpu.online, B.stats.byCpu.online]));
    ok((await careerOf(guest)).profileId === pb.id, 'OXM3 and the page says it wrote BOBBY\'s profile', J(await careerOf(guest)));
    ok(host.errors.length === 0 && guest.errors.length === 0, 'OXM4 no page errors', J(host.errors.concat(guest.errors)).slice(0, 200));
  });
}

// ---- OXG: a resume that is given up shows the setup form ONCE, with the reason
async function uxGiveUp(c) {
  const { ok } = c;
  await withBrowser({ port: c.cdp(0), width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (g) => {
    await uxRoom(c, g, 'AGIVU', 'guest');
    await g.eval('sessionStorage.setItem("arena.online:AGIVU:guest", JSON.stringify({ v: 1, room: "AGIVU", role: "guest", myTeam: "ARENA1.not-a-team", oppTeam: "ARENA1.not-a-team", myName: "Zed", fmt: "3v3", at: Date.now() })); true');
    await g.send('Page.reload', { ignoreCache: false });
    await g.waitFor(UX_READY, { timeoutMs: 90000 });
    await sleep(800);
    const v = await g.eval('({ opts: [...document.getElementById("olTeam").options].map((o) => o.value), status: document.getElementById("olStatus").textContent, stage: window.__arenaOnline.state.stage })');
    ok(v.stage === 'setup' && v.opts.length === new Set(v.opts).size && v.opts.filter((x) => x === 'random').length === 1 && /Start a new battle below/.test(v.status), 'OXG1 a battle that cannot be picked up again shows the setup form once (each team listed once) with the reason, not a form built twice with the reason wiped', J(v));
    ok(g.errors.length === 0, 'OXG2 no page errors', J(g.errors).slice(0, 200));
  });
}

// ---- OXT: what the page says about itself
async function uxText(c) {
  const { ok } = c;
  await withBrowser({ port: c.cdp(0), width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (p) => {
    await uxPanel(c, p);
    const t = await p.eval('({ lede: document.querySelector("#online > p").textContent, priv: (document.getElementById("olOpenPrivacy") || {}).textContent || "", privShown: !!document.getElementById("olOpenPrivacy") && document.getElementById("olOpenPrivacy").offsetParent !== null, off: document.getElementById("olPublicNote").textContent, boxShown: !document.getElementById("olPublicBox").hidden, brokers: new Set(Netplay.signalBrokers().map((b) => new URL(b.split("|")[0]).hostname)).size })');
    ok(!/straight to your friend|only your choices/.test(t.lede) && /team you play/.test(t.lede), 'OXT1 the panel does not say only choices travel "straight to your friend" (the team you play goes to the other player, and through a public relay when there is no direct path)', t.lede);
    ok(t.privShown && t.priv.includes('connects to ' + t.brokers + ' third-party MQTT brokers (') && t.brokers >= 2 && t.priv.includes('shiftr.io') && t.priv.includes('hivemq.com') && t.priv.includes('cdnjs.cloudflare.com') && /IP address/.test(t.priv) && /trainer name/.test(t.priv) && /online record/.test(t.priv) && /private game with a code is never listed/.test(t.priv), 'OXT2 the Open games list says, on screen, that opening the panel connects to public brokers and loads a script from a CDN, and what listing a game or challenging publishes (name AND online record); the number and names of the brokers are the ones the page dials', t.priv);
    ok(t.boxShown && /nothing is listed/.test(t.off) && /trainer name/.test(t.off) && /online record/.test(t.off), 'OXT3 beside the Open-to-anyone switch (visible, not a tooltip) the Off text says what On publishes: trainer name and online record', t.off);
    await p.eval('document.getElementById("olPublic").click()');
    const on = await p.eval('document.getElementById("olPublicNote").textContent');
    ok(/public servers/.test(on) && /trainer name/.test(on) && /online record/.test(on) && /anyone/.test(on), 'OXT3b and the On text says it too', on);
    // the hub's switch: its static title (before the module repaints it) names the record as well
    const html = await (await fetch(c.origin + '/pokemonarena/index.html')).text();
    const title = (html.match(/id="openToggle"[^>]*title="([^"]*)"/) || [])[1] || '';
    ok(/trainer name and online record/.test(title), 'OXT4 the hub\'s Open switch names the online record in its title as well as the name', title);
    ok(p.errors.length === 0, 'OXT5 no page errors', J(p.errors).slice(0, 200));
  });
}

// every defect below must fail the NAMED case; the session that holds it is run against a copy of the game with only that defect in it
const UX_MUTANTS = [
  { id: 'X01', what: 'Join (from the list) can be entered twice', file: 'js/online.js', from: 'const joinListed = exclusive(async function joinListed(g) {', to: 'const joinListed = (async function joinListed(g) {', run: 'join', fails: 'OXR1' },
  { id: 'X02', what: 'Find a battle can be entered while another way in is still reading the team', file: 'js/online.js', from: 'const quick = exclusive(async function quick() {', to: 'const quick = (async function quick() {', run: 'quick', fails: 'OXR2' },
  { id: 'X03', what: 'Challenge can be entered twice', file: 'js/online.js', from: 'const challengeResident = exclusive(async function challengeResident(g) {', to: 'const challengeResident = (async function challengeResident(g) {', run: 'challenge', fails: 'OXR3' },
  { id: 'X04', what: 'a join shows no Cancel', file: 'js/online.js', from: "ui.cancelAsk.hidden = role !== 'guest'; ui.cancelAsk.disabled = false;", to: 'ui.cancelAsk.hidden = true; ui.cancelAsk.disabled = false;', run: 'cancel', fails: 'OXC1' },
  { id: 'X05', what: 'Cancel does nothing for a join', file: 'js/online.js', from: "if (state.stage === 'waiting' && state.role === 'guest' && !state.nm && state.session && !closed) { reopenSetup(); say('Cancelled.'); }", to: "if (false) { reopenSetup(); say('Cancelled.'); }", run: 'cancel', fails: 'OXC2' },
  { id: 'X06', what: 'the list is rebuilt from nothing at every change', file: 'js/online.js', from: 'const list = ui.openList, have = new Map(), want = new Set(shown.map((g) => g.room));', to: 'const list = ui.openList, have = new Map(), want = new Set(shown.map((g) => g.room)); list.replaceChildren();', run: 'focus', fails: 'OXF1' },
  { id: 'X07', what: 'a focused row that leaves drops the focus to the body', file: 'js/online.js', from: "if (heir) { const t = heir === ui.quick ? heir : heir.querySelector('button'); if (t && !t.disabled) t.focus(); }", to: '', run: 'focus', fails: 'OXF2' },
  { id: 'X08', what: 'games on another build are counted only when the list is empty', file: 'js/online.js', from: "' waiting for an opponent.' + hiddenNote", to: "' waiting for an opponent.'", run: 'focus', fails: 'OXF3' },
  { id: 'X09', what: 'a game put back on the board keeps the last match\'s notice', file: 'js/online.js', from: "flashText = ''; flashUntil = 0;\n    state.stage = 'waiting'; state.roomOpen = false;", to: "state.stage = 'waiting'; state.roomOpen = false;", run: 'relist', fails: 'OXV1' },
  { id: 'X10', what: 'a name the panel filled in is remembered as the player\'s', file: 'js/online.js', from: 'if (nameTouched) { try { win.localStorage.setItem(LS_NAME, name); }', to: 'if (true) { try { win.localStorage.setItem(LS_NAME, name); }', run: 'names', fails: 'OXN1' },
  { id: 'X11', what: 'a name the player typed is not remembered', file: 'js/online.js', from: 'if (nameTouched) { try { win.localStorage.setItem(LS_NAME, name); }', to: 'if (false) { try { win.localStorage.setItem(LS_NAME, name); }', run: 'names', fails: 'OXN3' },
  { id: 'X12', what: 'a remembered name is replaced when the team changes', file: 'js/online.js', from: 'nameTouched = !!saved;', to: 'nameTouched = false;', run: 'names', fails: 'OXN3b' },
  { id: 'X13', what: 'the pre-selected team\'s owner does not name the player', file: 'js/online.js', from: 'ui.team.value = choices[0].key;\n    nameFollowsTeam();', to: 'ui.team.value = choices[0].key;', run: 'names', fails: 'OXN4' },
  { id: 'X14', what: 'a challenge from the panel carries the previous attempt\'s record (state.rec), not this one\'s', file: 'js/online.js', from: 'rec: p.rec || null, now, timing', to: 'rec: state.rec || null, now, timing', run: 'rec', fails: 'OXP1' },
  { id: 'X15', what: 'a random team reads the active profile\'s record (and opens the store for it)', file: 'js/online.js', from: 'profileId: choice.profileId || null, rec: tc.rec || null };', to: 'profileId: choice.profileId || null, rec: tc.rec || (await (async () => { const s = await openStore(); try { return await onlineRecOf(s, await s.getActiveId()); } finally { await s.close(); } })()) };', run: 'rec', fails: 'OXI1' },
  { id: 'X16', what: 'the match record keeps no profile', file: 'js/online.js', from: 'myName: state.name, profileId: state.profileId || null, at: Date.now()', to: 'myName: state.name, at: Date.now()', run: 'resume', fails: 'OXM1' },
  { id: 'X17', what: 'a resumed page forgets the profile it read', file: 'js/online.js', from: 'state.profileId = isId(rec.profileId) ? rec.profileId : null;', to: 'state.profileId = null;', run: 'resume', fails: 'OXM1' },
  { id: 'X18', what: 'a resume that is given up builds the setup form twice', file: 'js/online.js', from: "{ await resumeFlow(rec); return; }", to: '{ if (await resumeFlow(rec)) return; }', run: 'giveup', fails: 'OXG1' },
  { id: 'X19', what: 'the panel says only choices travel, straight to the friend', file: 'js/online.js', from: 'Your teams stay in your browser until a battle starts; then the team you play and your choices go to the other player, directly when your browsers can reach each other and through a public relay when they cannot.', to: 'Your teams stay in your browser; only your choices travel, straight to your friend.', run: 'text', fails: 'OXT1' },
  { id: 'X20', what: 'the Open games list says nothing about the public servers', file: 'js/online.js', from: 'el(doc, \'h3\', { id: \'olOpenTitle\', text: \'Open games\' }), ui.openPrivacy, ui.openNote', to: 'el(doc, \'h3\', { id: \'olOpenTitle\', text: \'Open games\' }), ui.openNote', run: 'text', fails: 'OXT2' },
  { id: 'X21', what: 'the Open-to-anyone text names the trainer name but not the record', file: 'js/online.js', from: 'with your trainer name and your online record (wins and losses, if you have one), readable by anyone; and', to: 'with your trainer name, readable by anyone; and', run: 'text', fails: 'OXT3b' },
  { id: 'X22', what: 'the hub\'s switch title names only the trainer name', file: 'index.html', from: 'list your trainer name and online record on public servers', to: 'list your trainer name on public servers', run: 'text', fails: 'OXT4' },
];
const UX_SESSIONS = { join: uxJoin, quick: uxQuick, challenge: uxChallenge, cancel: uxCancel, focus: uxFocus, relist: uxRelist, names: uxNames, rec: uxRec, resume: uxResume, giveup: uxGiveUp, text: uxText };

async function groupOnlineUx(S) {
  ANIM = '&anim=0';
  // the docs count the defects this group and presenceui break (a stale count is how "breaks the pages 26 ways" came to be 28)
  const doc = (f) => fs.readFileSync(path.join(root, 'pokemonarena', f), 'utf8');
  const rm = doc('README.md').match(/`onlineux --mutants` breaks it (\d+) ways/);
  const om = doc('ONLINE.md').match(/`presenceui --mutants` and `onlineux --mutants` also serve a copy of the game with one defect at a time and each must fail a named case: (\d+) and (\d+) of them/);
  ok(!!rm && Number(rm[1]) === UX_MUTANTS.length, 'OXD1 pokemonarena/README.md states how many ways `onlineux --mutants` breaks the page (' + UX_MUTANTS.length + ')', rm ? 'README says ' + rm[1] : 'the sentence is not in the README');
  ok(!!om && Number(om[1]) === UI_MUTANTS.length && Number(om[2]) === UX_MUTANTS.length, 'OXD2 pokemonarena/ONLINE.md states both counts (' + UI_MUTANTS.length + ' for presenceui, ' + UX_MUTANTS.length + ' for onlineux)', om ? om[1] + ' and ' + om[2] : 'the sentence is not in ONLINE.md');
  const mk = (origin, okFn, treeDir) => ({ origin, ok: okFn, cdp: (k) => CDP0 + 28 + (k % 2), treeDir });
  const run = async (name, c) => { try { await UX_SESSIONS[name](c); } catch (e) { c.ok(false, 'OX ' + name + ' session crashed', e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e)); } };
  const wanted = (process.env.ARENA_UX || '').split(',').filter(Boolean);          // ARENA_UX=join,cancel runs only those sessions (while working on one)
  for (const name of Object.keys(UX_SESSIONS)) if (!wanted.length || wanted.includes(name)) await run(name, mk(ORIGIN, ok, path.join(root, 'pokemonarena')));
  if (!process.argv.includes('--mutants')) return;
  if (REMOTE) { ok(true, 'OXMUT (skipped against a deployed site)'); return; }
  const { copyTree, mutateFile, startOverlay } = await import('./pokemonarena_overlay.mjs');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-onlineux-mut-'));
  let killed = 0, ran = 0;
  try {
    for (const mu of UX_MUTANTS) {
      if (wanted.length && !wanted.includes(mu.run)) continue;
      const failed = [];
      const rec = (cond, name, detail) => { if (!cond) failed.push(name + (detail ? ' :: ' + String(detail).slice(0, 160) : '')); };
      ran++;
      const dir = copyTree(path.join(root, 'pokemonarena'), path.join(tmp, mu.id));
      let ov = null;
      try {
        try { mutateFile(dir, mu.file, mu.from, mu.to); for (const x of mu.also || []) mutateFile(dir, x.file, x.from, x.to); } catch (e) { ok(false, 'OXMUT ' + mu.id + ' could not be applied', e.message); continue; }
        ov = await startOverlay({ dir, port: PORT + 10, upstream: ORIGIN });
        await run(mu.run, mk(ov.url, rec, dir));
      } finally { if (ov) ov.stop(); }
      const hit = failed.find((f) => f.startsWith(mu.fails + ' '));
      ok(!!hit, 'OXMUT ' + mu.id + ' (' + mu.what + ') fails ' + mu.fails, hit ? '' : 'it did NOT: failed cases = ' + J(failed.map((f) => f.slice(0, 60))));
      if (hit) killed++;
    }
  } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_e) { /* ignore */ } }
  console.log(`onlineux mutants: ${killed}/${ran} killed`);
}

/* ---------------------------------------------------------------------------------------------- case ids
 * A failure is named by its case id, so an id used by two groups names two different things (the open and presence groups once reused L, T, R, V, B and F, and B3 failing could mean either).
 * Every id belongs to ONE group; inside a group the same id may repeat (a loop makes one assertion for several inputs). This reads this very file, so it also holds when a subset of the groups is run. */
function checkCaseIds() {
  const lines = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n');
  const users = new Map();
  let group = null;
  for (const l of lines) {
    const f = l.match(/^(?:async )?function (group\w+|ui[A-Z]\w*|ux[A-Z]\w*)\(/);
    if (f) group = /^ui/.test(f[1]) ? 'groupPresenceUi' : /^ux/.test(f[1]) ? 'groupOnlineUx' : f[1];
    if (!group) continue;
    for (const m of l.matchAll(/(?:^|[(,\s])['"]([A-Z][A-Za-z]{0,3}\d+[a-z]?) /g)) { if (!users.has(m[1])) users.set(m[1], new Set()); users.get(m[1]).add(group); }
  }
  const dups = [...users].filter(([, g]) => g.size > 1).map(([id, g]) => id + ' (' + [...g].join(', ') + ')');
  ok(users.size > 150 && dups.length === 0, 'ID1 every case id belongs to ONE group (' + users.size + ' ids)', dups.join('; '));
}

/* ---------------------------------------------------------------------------------------------- main */
const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const started = await startServer();
const S = await loadStack();
const t0 = Date.now();
checkCaseIds();
const groups = { profile: groupProfile, hub: groupHub, lobby: groupLobby, match: groupMatch, leaving: groupLeaving, rejoin: groupRejoin, resume: groupResume, timeout: groupTimeout, refusals: groupRefusals, teams: groupTeams, layout: groupLayout, open: async (S) => { if (!process.env.ARENA_OP) await groupOpen(S); await groupOpenSessions(S); }, openlayout: groupOpenLayout, presence: groupPresence, presenceui: groupPresenceUi, onlineux: groupOnlineUx };
let crashed = null;
try {
  for (const [name, fn] of Object.entries(groups)) {
    if (only.length && !only.includes(name)) continue;
    try { await fn(S); } catch (e) { fail++; failures.push(`group ${name} crashed :: ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}`); console.log('FAIL group', name, 'crashed:', e && e.message); }
  }
} finally { if (started) stopServer(); }
console.log(`\nonline page: ${pass} passed, ${fail} failed (${((Date.now() - t0) / 1000).toFixed(0)} s)  screenshots: ${OUT}`);
if (fail) { console.log('\nFAILURES:\n  ' + failures.join('\n  ')); process.exit(1); }

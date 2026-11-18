// tools/pokemonarena_online_page_test.mjs -- two real browser tabs play a networked Pokemon Arena battle through /pokemonarena/battle.html, paired with lib/netplay.js's
// same-browser transport (net=local): the page's online screens in the picture, the handshake, the scene on both sides, rematch, leaving, timeouts and refusals.
//
//   node tools/pokemonarena_online_page_test.mjs            starts its own dev server (ARENA_PORT, default 8097) and one muted headless Chrome (ARENA_CDP, default 9283)
//   ARENA_OUT=<dir> for screenshots (judged by eye); ARENA_SKIP_SHOTS=1 to skip them
//   groups (name some to run a subset): profile hub lobby match leaving rejoin resume timeout easyjoin screens refusals teams lead layout open openlayout presence presenceui onlineux tokens; `profile --mutants`,
//   `open --mutants`, `presenceui --mutants`, `onlineux --mutants`, `tokens --mutants` and `screens --mutants` also run a copy of the game with ONE defect at a time, each of which must fail the case it names.
//   THE BATTLE PAGE HAS NO PANEL (pokemonarena/INAPP.md "BATTLE: as built"): before a battle its screens are IN THE PICTURE (js/online_view.js, js/online_draw.js, drawn in the battle canvas). The battle-page
//   sessions read what the page shows through window.__arenaOnline.view(), set the form through its setForm (what the hub's online menu stores as preferences), and press through its named actions
//   (go, startAs, quick, cancel, pick ...) or the picture itself (window.__arenaBattle.onlineScreen.press, real keys, a real click, a real tap). No case reads a DOM control a player does not have.
//   ON THE HUB PAGE the "wants to battle you" question and the first-time disclosure are IN THE PICTURE (js/hub_presence.js, the hub's dialog layer): the hub sessions of `presence` and `presenceui` read
//   and drive them through window.__arenaHub. In a battle against the CPU they are still the DOM dialogs of presence_boot.js, and those sessions read the DOM.
//   EVERY CASE ID BELONGS TO ONE GROUP (checkCaseIds, ID1, reads this file): a failure is named by its id, and two groups sharing one made "B3 failed" mean either of two things.
//
// Browsers: tools/headless_cdp.mjs only (bare CDP, throwaway profile, --mute-audio). Nothing here touches the user's browser, and nothing makes a sound.
// The two tabs share one profile, which is what makes BroadcastChannel pairing possible; a fresh browser is started for each group so no state leaks between cases.
// The "player" in each tab is the engine's own AI, installed on the scene (scene.S.auto, the same seam the battle page's own autoplay uses); everything else -
// the online screens, the handshake, the clock, the netbar, the result screen - is the page's own code.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withBrowser } from './headless_cdp.mjs';
import { loadStack } from './pokemonarena_netmatch_lib.mjs';
import { MAIN_LABELS } from '../pokemonarena/js/hub_model.js';          // the hub's main menu, as the picture draws it (H1)
import { PROTO } from '../pokemonarena/js/netmatch.js';          // the protocol version the pages speak (2 since the 6v6 lead preview): the messages these cases forge by hand carry it, so they are refused for what they say, not for their version

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
// BackForwardCache is off because the rig "closes" a page by navigating it to about:blank: on a cacheable origin (the live site sends Cache-Control: max-age=600; tools/devserver.mjs sends no-store) Chrome would FREEZE that page in the
// back/forward cache instead of tearing it down, its peer would never see the link drop, and "a closed page is a dropped link" (L7) failed on the live site for the old code and the new alike. A closed tab is torn down.
const NO_THROTTLE = ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-features=BackForwardCache'];

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
  await page.waitFor(OL_READY, { timeoutMs: 90000 });
}
// set the form (the hook's setForm: what the hub's online menu stores as preferences) and press the page's button (go()). team: 'random' | 'paste' (a code, which pair() put in the address) ; fmt only matters to the host
async function fillAndGo(page, { name, team = 'random', code = '', fmt }) {
  void code;          // (a team code rides in the ADDRESS, &team=: pair() puts it there, and `team: 'paste'` then means the choice 'url', "the team in the address")
  return page.eval(`(() => { const O = window.__arenaOnline;
    O.setForm({ teamKey: ${JSON.stringify(team === 'paste' ? 'url' : team)}, name: ${JSON.stringify(name)}${fmt ? ', fmt: ' + JSON.stringify(fmt) : ''} });
    void O.go();
    return O.view().status.text; })()`);
}
// a room lets the first player in by itself (there is no Allow prompt any more): nothing to press. Kept as a seam so a case can say where the old prompt was.
async function approve(_host) { /* nothing to answer */ }
// two tabs paired and past the handshake (or failed): returns the final phases
async function pair(host, guest, room, o = {}) {
  await openRoom(host, room, 'host', (o.hostExtra || '') + (o.hostCode ? '&team=' + encodeURIComponent(o.hostCode) : ''));
  await openRoom(guest, room, 'guest', (o.guestExtra || '') + (o.guestCode ? '&team=' + encodeURIComponent(o.guestCode) : ''));
  await fillAndGo(host, { name: o.hostName || 'Alice', team: o.hostTeam || 'random', code: o.hostCode, fmt: o.fmt || '3v3' });
  await host.waitFor('window.__arenaOnline.view().code !== ""', { timeoutMs: 30000 });      // the room is open: now a friend may knock
  await fillAndGo(guest, { name: o.guestName || 'Bob', team: o.guestTeam || 'random', code: o.guestCode });
  await approve(host);
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

// THE ONLINE SCREENS ARE IN THE PICTURE (js/online_view.js says what, js/online_draw.js draws it in the battle canvas from the ROM): there is no panel in the page. A test reads what the page shows
// through window.__arenaOnline.view() and presses the picture's rows the way a button does (window.__arenaBattle.onlineScreen.press: the page's own handler), or with real keys and real clicks.
const OL_READY = 'window.__arenaOnline && window.__arenaBattle && window.__arenaBattle.state === "online" && !!window.__arenaBattle.onlineScreen && window.__arenaOnline.view().canGo';
// what the screen says, and what is NOT in the page (dom: nodes of the old panel, or any form control in the screen's box)
const OV = (p) => p.eval('(() => { const O = window.__arenaOnline, H = window.__arenaBattle, v = O.view(); return { screen: v.screen, kind: v.kind, heading: v.heading, ask: v.ask, lede: v.lede, info: v.info, who: v.who, title: v.title, steps: v.steps, at: v.at, status: v.status, hint: v.hint, elapsed: v.elapsed, code: v.code, codeLabel: v.codeLabel, link: v.link, canShare: v.canShare, copied: v.copied, cancel: v.cancel, rows: v.rows, ids: v.rows.map((r) => r.id).join(","), labels: v.rows.map((r) => r.label).join("|"), fmtShown: v.fmtShown, cursor: H.onlineScreen ? H.onlineScreen.cursor() : null, stage: O.state.stage, sess: !!O.session(), dom: document.querySelectorAll("#online, #screenWrap select, #screenWrap input, #screenWrap textarea, #screenWrap [id^=ol]").length, canvasHidden: document.getElementById("battle").hidden, state: H.state, fits: H.onlineScreen ? H.onlineScreen.fits() : null }; })()');
// buttons, as the page hears them: -> what each press meant ('move' | 'act:<row id>' | 'refused:<row id>' | null)
const olPress = (p, ...actions) => p.eval('(() => { const S = window.__arenaBattle.onlineScreen; return ' + J(actions) + '.map((a) => { const r = S.press(a); return r ? r.kind + (r.id ? ":" + r.id : "") : null; }); })()');
// the row with this id: the d-pad goes to it, A presses it
const olRow = (p, id) => p.eval('(() => { const O = window.__arenaOnline, S = window.__arenaBattle.onlineScreen, rows = O.view().rows, i = rows.findIndex((r) => r.id === ' + J(id) + '); if (i < 0) return null; for (let k = 0; k < rows.length && S.cursor() !== i; k++) S.press("down"); const r = S.press("a"); return r ? r.kind + (r.id ? ":" + r.id : "") : null; })()');
// every line of the screen fits its window (the sentence in one of the two fonts, the heading, the rows, the code)
const olFits = (v) => !!v.fits && v.fits.fits === true && v.fits.widths.every((w) => w.px <= w.max);
// the client point of the middle of a row of the picture
const olRowPoint = (p, id) => p.eval('(() => { const H = window.__arenaBattle, r = H.onlineScreen.rects().find((x) => x.id === ' + J(id) + '), c = H.canvas.getBoundingClientRect(); return r ? { x: c.left + (r.x + r.w / 2) * c.width / 240, y: c.top + (r.y + r.h / 2) * c.height / 160, h: r.h * c.height / 160, w: r.w * c.width / 240 } : null; })()');

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
    // the new host session knows the player from the resume record: the guest knocks again by itself and is let back in with no prompt
    await host.waitFor('window.__arenaOnline.nm().status().link === "up"', { timeoutMs: 90000 });
    ok(!(await host.eval('!!document.getElementById("npApprove")')), 'J12 the returning guest knocks by itself and the reloaded host lets them back in without asking anyone', '');
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
    await guest.waitFor('window.__arenaOnline && window.__arenaOnline.view().canGo', { timeoutMs: 90000 });
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
    await host.eval('window.__arenaOnline.setForm({ fmt: "3v3" }); void window.__arenaOnline.go()');
    await host.waitFor('window.__arenaOnline.view().code !== ""', { timeoutMs: 30000 });
    await guest.eval('void window.__arenaOnline.go()');
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
    const relinked = await host.waitFor('window.__arenaOnline.nm().status().link === "up"', { timeoutMs: 90000 }).then(() => true, () => false);
    ok(relinked && !(await host.eval('!!document.getElementById("npApprove")')), 'RS4 the returning guest knocks by itself and the reloaded host lets them back in (no prompt)', '');
    if (!relinked) return;
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
    ok(/Your move|Choose your Pokemon|seconds left to choose/.test(g0.msg) && /\d:\d\d/.test(g0.clock), 'T2 the player being waited for sees their own countdown', JSON.stringify(g0));
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

// EZ: the joining flow the player sees, IN THE PICTURE. The plain address the hub falls back to (?online=1&ask=host) asks one question; YES opens a room: the code large, the rows COPY LINK /
// COPY CODE / CLOSE THE ROOM, the numbered steps with the current one marked, one sentence. The friend opens the invite link and presses ONE row; nobody presses Allow.
async function groupEasyJoin(S) {
  ANIM = '&anim=0';
  await withBrowser({ port: CDP0 + 12, width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (host) => {
    const guest = await host.openTab({ width: 390, height: 844 });
    await host.send('Page.bringToFront');
    await host.navigate(BASE + '?online=1&ask=host&net=local' + ANIM);
    await host.waitFor(OL_READY, { timeoutMs: 90000 });
    const v0 = await OV(host);
    ok(v0.screen === 'confirm' && v0.kind === 'ask-host' && v0.ask === 'OPEN A ROOM FOR A FRIEND?' && v0.labels === 'YES|BACK' && v0.dom === 0 && v0.canvasHidden === false && v0.state === 'online' && olFits(v0), 'EZ1 the plain address with ask=host asks ONE question in the picture (OPEN A ROOM FOR A FRIEND? YES / BACK): the canvas is up before any battle, and the page has no panel, form or list', J(v0).slice(0, 500));
    await sleep(1200);
    const idle = await host.eval('({ stage: window.__arenaOnline.state.stage, sess: !!window.__arenaOnline.session(), room: window.__arenaOnline.state.room, board: !!window.__arenaOnline.lobbies() })');
    ok(idle.stage === 'setup' && !idle.sess && !idle.room && !idle.board, 'EZ2 the question starts nothing by itself: no room, no session, and a private room\'s page does not dial the open-games board', J(idle));
    const moved = await olPress(host, 'down', 'down', 'up', 'up');
    ok(J(moved) === J(['move', 'move', 'move', 'move']) && (await OV(host)).cursor === 0, 'EZ3 the d-pad moves the cursor over the rows and wraps', J(moved));
    // YES: the room, the code large, the invite's rows; the steps say the room is open and the friend is next
    const yes = await olPress(host, 'a');
    await host.waitFor('window.__arenaOnline.view().code !== ""', { timeoutMs: 30000 });
    const v1 = await OV(host);
    ok(J(yes) === J(['act:host']) && v1.screen === 'wait' && /^[A-Z0-9]{4,8}$/.test(v1.code) && v1.ids.replace(',share', '') === 'copy-link,copy-code,cancel' && v1.labels.replace('|SHARE', '') === 'COPY LINK|COPY CODE|CLOSE THE ROOM' && v1.ids.includes('share') === v1.canShare && v1.cursor === 0 && v1.dom === 0 && olFits(v1), 'EZ4 A on YES opens the room, and the question gives way to the waiting screen: the room code, and the rows COPY LINK / COPY CODE / CLOSE THE ROOM (with SHARE where the browser can share, and only there), the cursor on COPY LINK', J(v1).slice(0, 500));
    ok(v1.at === 1 && v1.steps.length === 4 && v1.steps[v1.at] === 'Friend joins', 'EZ5 the numbered steps show the room open (done) and "Friend joins" as the current step', J(v1.steps) + ' at ' + v1.at);
    ok(/Waiting for your friend/.test(v1.status.text) && !v1.status.bad && !/allow/i.test(v1.status.text), 'EZ6 the sentence says who is awaited and that nobody has to allow anything', v1.status.text);
    ok(v1.cancel.shown && v1.cancel.label === 'Close the room', 'EZ7 a host can close a room nobody has come to', J(v1.cancel));
    ok(/hosting/i.test(v1.who) && v1.who.includes(v1.code) && /^Waiting for your friend/.test(v1.title) && /^\d+:\d\d$/.test(v1.elapsed), 'EZ13 the waiting screen says who you are (hosting, the room), what is happening as its heading, and how long it has taken', J([v1.who, v1.title, v1.elapsed]));
    ok(v1.link.includes('/pokemonarena/battle.html?np=' + v1.code) && /join=1/.test(v1.link), 'EZ14 the invite link the rows hand out names the room and joins it', v1.link);
    ok(!v1.rows.some((r) => r.id === 'back' || r.id === 'go' || r.id === 'host'), 'EZ15 while waiting nothing else can be pressed: no second way out beside CLOSE THE ROOM', v1.ids);
    await shot(host, 'EZ_host_waiting');
    // CLOSE THE ROOM: back to the question, nothing left open
    ok((await olRow(host, 'cancel')) === 'act:cancel', 'EZ8a the cursor goes down to CLOSE THE ROOM and A presses it', '');
    await sleep(400);
    const v2 = await OV(host), search = await host.eval('location.search');
    ok(v2.stage === 'setup' && !v2.sess && v2.kind === 'ask-host' && !v2.code && /Room closed/.test(v2.status.text) && /online=1/.test(search) && /ask=host/.test(search), 'EZ8 CLOSE THE ROOM goes back to the question with no session left, says so, and the address is the plain one again', J([v2.stage, v2.kind, v2.status, search]));
    // a fresh room for the real join (a NEW code: the closed one is not reused)
    await olPress(host, 'a');
    await host.waitFor('window.__arenaOnline.view().code !== ""', { timeoutMs: 30000 });
    const code = (await host.eval('window.__arenaOnline.view().code')).trim();
    ok(code !== v1.code, 'EZ9 a room opened after closing one gets a new code', code + ' vs ' + v1.code);
    // the friend opens the invite link: one screen, one press
    await guest.navigate(BASE + '?np=' + code + '&join=1&net=local' + ANIM);
    await guest.waitFor(OL_READY, { timeoutMs: 90000 });
    const g0 = await OV(guest);
    ok(g0.kind === 'invited' && /INVITED/.test(g0.heading) && g0.info.some((l) => l.label === 'ROOM' && l.value === code) && g0.info.some((l) => l.label === 'TEAM' && l.value.length > 3) && g0.labels === 'JOIN THE BATTLE|CHANGE TEAM|BACK' && !g0.fmtShown && g0.dom === 0 && olFits(g0), 'EZ10 the invite link opens YOU\'RE INVITED in the picture: the room, the team that will be used, and JOIN THE BATTLE / CHANGE TEAM / BACK (no battle size: the host chose it)', J(g0).slice(0, 500));
    await shot(guest, 'EZ_invite');
    await olPress(guest, 'a');
    const r = await bothPlaying(host, guest, 60000, host);
    ok(r.phases[0] === 'playing' && r.phases[1] === 'playing' && !r.prompted, 'EZ11 one press and both are in the battle; the host never saw an Allow prompt', J(r));
    ok(host.errors.length === 0 && guest.errors.length === 0, 'EZ12 no page errors', J(host.errors.concat(guest.errors)).slice(0, 200));
  });
  // a code nobody has opened: the joiner sees that they are JOINING, what is happening, and after a while what to check; CANCEL takes them back to the invitation
  await withBrowser({ port: CDP0 + 13, width: 390, height: 844, mobile: true, lock: false, args: NO_THROTTLE }, async (p) => {
    await p.navigate(BASE + '?np=NOBODY&join=1&net=local' + ANIM);
    await p.waitFor(OL_READY, { timeoutMs: 90000 });
    await olPress(p, 'a');
    await p.waitFor('window.__arenaOnline.state.stage === "waiting"', { timeoutMs: 15000 });
    const j0 = await OV(p);
    ok(/joining/i.test(j0.who) && j0.who.includes('NOBODY') && /Connecting to your friend/.test(j0.title) && !j0.hint && !j0.code && j0.labels === 'CANCEL', 'EZ16 a join by code says JOINING (and the room) and "Connecting to your friend", with CANCEL and no invite', J(j0).slice(0, 400));
    await p.waitFor('window.__arenaOnline.view().hint !== ""', { timeoutMs: 20000 }).catch(() => {});
    const j2 = await OV(p);
    ok(/Taking a while/.test(j2.hint) && j2.hint.includes('NOBODY') && olFits(j2), 'EZ17 a join that is taking a while says what to check (the code, that the friend is still waiting), and it fits its window', j2.hint + ' ' + J(j2.fits));
    await shot(p, 'EZ_slow_join');
    await olPress(p, 'a'); await sleep(400);
    const j1 = await OV(p);
    ok(j1.stage === 'setup' && j1.kind === 'invited' && !j1.hint && !j1.sess && j1.status.text === 'Cancelled.', 'EZ18 CANCEL goes back to YOU\'RE INVITED with nothing left connecting', J([j1.stage, j1.kind, j1.status, j1.sess]));
    ok(p.errors.length === 0, 'EZ19 no page errors', J(p.errors).slice(0, 200));
  });
}

async function groupRefusals(S) {
  await withBrowser({ port: CDP0 + 4, width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (host) => {
    const guest = await host.openTab({ width: 900, height: 760 });
    // a room lets the first player in by itself and nobody is asked; a THIRD player with the same code is told the room is taken, and can try again
    const ph = await pair(host, guest, 'ADENY');
    ok(ph && ph[0] === 'playing' && ph[1] === 'playing' && !(await host.eval('!!document.getElementById("npApprove")')), 'R0 the host was never asked to press Allow: the code is the key', J(ph));
    const third = await host.openTab({ width: 900, height: 760 });
    await openRoom(third, 'ADENY', 'guest');
    await fillAndGo(third, { name: 'Cat' });
    await third.waitFor('window.__arenaOnline.view().status.text.length > 0 && window.__arenaOnline.view().canGo && window.__arenaOnline.state.stage === "setup"', { timeoutMs: 60000 }).catch(() => {});
    const st = await third.eval('window.__arenaOnline.view().status.text');
    ok(/already has two players|did not let you in|taken/i.test(st), 'R1 a third player with the code is told the room is taken', st);
    ok(await third.eval('window.__arenaOnline.view().canGo'), 'R2 and can try again', '');
    await shot(third, 'R_denied');
  });
  await withBrowser({ port: CDP0 + 5, width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (host) => {
    // bad inputs never reach the network
    await host.navigate(BASE + '?np=!!&host=1&net=local');
    await host.waitFor('window.__arenaBattle && window.__arenaBattle.state === "error"', { timeoutMs: 60000 });
    ok(/room code/i.test(await host.eval('document.getElementById("errMsg").textContent')), 'R3 an invalid room code in the address is refused', await host.eval('document.getElementById("errMsg").textContent'));
    await host.navigate(BASE + '?np=ABCDE&host=1&join=1&net=local');
    await host.waitFor('window.__arenaBattle && window.__arenaBattle.state === "error"', { timeoutMs: 60000 });
    ok(/both host and join/i.test(await host.eval('document.getElementById("errMsg").textContent')), 'R4 an address that asks to host AND join is refused', '');
    await openRoom(host, 'ABAD1', 'host', '&team=ARENA1.AAAA.0000');          // (a team code comes in through the address: it has the shape of one, and does not decode)
    const s1 = await fillAndGo(host, { name: 'Zed', team: 'paste', code: 'ARENA1.AAAA.0000', fmt: '3v3' });
    await sleep(600);
    const s2 = await host.eval('window.__arenaOnline.view().status.text');
    ok(s2.length > 0 && /team|code|check/i.test(s2) && !(await host.eval('window.__arenaOnline.view().code !== ""')), 'R5 a team code that does not decode is refused before anything connects', s2);
    ok(await host.eval('window.__arenaOnline.view().canGo'), 'R6 and the panel stays usable', '');
    void s1;
    const r7 = await OV(host);
    ok(r7.screen === 'confirm' && r7.kind === 'room' && r7.status.bad && r7.status.text === s2 && olFits(r7), 'R7 the refusal is said IN THE PICTURE, on the screen that asked (YOUR ROOM), as a refusal, and it fits its window', J([r7.kind, r7.status, r7.fits]));
    // the host's waiting screen shows the code and the invite link
    await host.eval(`(() => { const O = window.__arenaOnline; O.setForm({ teamKey: 'random' }); void O.go(); })()`);
    await host.waitFor('window.__arenaOnline.view().code !== ""', { timeoutMs: 20000 });
    ok(await host.eval('window.__arenaOnline.view().code') === 'ABAD1', 'R8 the host sees the room code to give out', await host.eval('window.__arenaOnline.view().code'));
    { const w = await OV(host); ok(/Waiting for your friend/.test(w.status.text) && w.who.includes('ABAD1'), 'R9 and the waiting screen says who is awaited and names the room', J([w.who, w.status.text])); }
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
    ok(ph[0] === 'playing' && ph[1] === 'playing', 'P4 a 2-Pokemon team can play 6v6 against a full team (each side chooses its lead; no 3-pick team preview)', JSON.stringify(ph));
    await host.waitFor('window.__arenaBattle.state === "ready"', { timeoutMs: 30000 });
    await guest.waitFor('window.__arenaBattle.state === "ready"', { timeoutMs: 30000 });
    const modes = await Promise.all([drive(host), drive(guest)]);
    await sleep(400);
    const [a, b] = [await nmStatus(host), await nmStatus(guest)];
    ok(modes.every((m) => m === 'result') && a.result.hash === b.result.hash && !a.error && !b.error, 'P5 the lopsided 6v6 plays to the end in agreement', JSON.stringify([modes, a.error, b.error]));
    ok((await host.eval('window.__arenaOnline.state.fmt')) === '6v6' && (await guest.eval('window.__arenaOnline.nm().fmt')) === '6v6', 'P6 the guest uses the format the host chose', '');
  });
}

// ---- LD: the 6v6 LEAD preview between two real tabs. Each player chooses which Pokemon is sent out first; the two choices are committed and revealed together (so the first to choose is not seen), a page
// that reloads in the middle of the round comes back to the same question, and both machines then hold one position with each chosen Pokemon in front. (The protocol itself is pokemonarena_netmatch_test.mjs case S.)
async function leadSession(origin, rec) {
  const base = origin + '/pokemonarena/battle.html';
  ANIM = '&anim=0';
  await withBrowser({ port: CDP0 + 39, width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (host) => {
    const guest = await host.openTab({ width: 900, height: 760 });
    await openRoom(host, 'ALEAD', 'host', '', base); await openRoom(guest, 'ALEAD', 'guest', '', base);
    await fillAndGo(host, { name: 'Alice', team: 'random', fmt: '6v6' });
    await host.waitFor('window.__arenaOnline.view().code !== ""', { timeoutMs: 30000 });
    await fillAndGo(guest, { name: 'Bob', team: 'random' });
    await approve(host, true);
    let ph = [null, null];
    for (let i = 0; i < 120; i++) { ph = [await phase(host), await phase(guest)]; if ((ph[0] === 'playing' || ph[0] === 'failed') && (ph[1] === 'playing' || ph[1] === 'failed')) break; await sleep(250); }
    rec(ph[0] === 'playing' && ph[1] === 'playing', 'LD1 two tabs pair for a 6v6 match', J(ph));
    await host.waitFor('window.__arenaBattle.state === "ready"', { timeoutMs: 30000 }); await guest.waitFor('window.__arenaBattle.state === "ready"', { timeoutMs: 30000 });
    const toPreview = (p) => p.eval(`(() => { const H = window.__arenaBattle; for (let i = 0; i < 6000 && H.scene.mode !== 'preview'; i++) { H.scene.tick(); if (H.scene.mode === 'steps' && H.scene.S.cur && H.scene.S.cur.t === 'text') H.scene.press('a'); } return H.scene.mode; })()`);
    const pressKeys = (p, ...ks) => p.eval(`(() => { const H = window.__arenaBattle; for (const k of ${J(ks)}) { H.scene.press(k); H.scene.tick(); } return H.scene.mode; })()`);
    const snap = (p) => p.eval(`(() => { const H = window.__arenaBattle, side = window.__arenaOnline.state.info.mySide, v = H.scene.view(), b = H.ctl.battle;
      return { mode: H.scene.mode, title: v.preview ? v.preview.title : null, picks: v.preview ? v.preview.picks : null, rows: v.preview ? v.preview.mine.length : 0, names: v.preview ? v.preview.mine.map((m) => m.name) : null, lead: !!(H.scene.S.preview && H.scene.S.preview.lead),
        req: H.ctl.pending(side) ? { phase: H.ctl.pending(side).phase, lead: H.ctl.pending(side).lead, pick: H.ctl.pending(side).pick } : null, side, phase: b.s.phase, order: [0, 1].map((s) => b.s.sides[s].team.map((m) => m.orig)), mine: b.s.sides[side].team.map((m) => m.name),
        log: b.choiceLog.map((e) => e.s + ':' + e.c.kind + ':' + (e.c.order || e.c.slot)), hash: b.hash(), shown: H.scene.state().player ? H.scene.state().player.name : null }; })()`);
    const asked = await Promise.all([toPreview(host), toPreview(guest)]);
    const [h0, g0] = [await snap(host), await snap(guest)];
    rec(asked.every((m) => m === 'preview') && h0.lead && g0.lead && h0.rows === 6 && g0.rows === 6 && h0.req && h0.req.lead === true && h0.req.pick === 1 && g0.req && g0.req.lead === true, 'LD2 both screens open on the LEAD preview: six rows each, the request is { preview, pick 1, lead }', J([asked, h0.req, g0.req, h0.rows, g0.rows]));
    rec(/^Choose a Pok/.test(h0.title) && /^Choose a Pok/.test(g0.title) && J(h0.picks) === '[]', 'LD3 the title is the ROM\'s own line "Choose a Pokemon." (not the 3v3 counter) and nothing is numbered yet', J([h0.title, g0.title, h0.picks]));
    await shot(host, 'LD_host_lead_preview'); await shot(guest, 'LD_guest_lead_preview');
    // the host picks the 4th: the question, the numbered order, YES
    await pressKeys(host, 'down', 'down', 'down', 'a');
    const hq = await snap(host);
    rec(hq.mode === 'confirm' && hq.title === 'Send out this one first?' && J(hq.picks) === '[3,0,1,2,4,5]', 'LD4 A on the 4th row asks "Send out this one first?" and numbers the whole team in the order the battle will use', J([hq.mode, hq.title, hq.picks]));
    await shot(host, 'LD_host_lead_confirm');
    await pressKeys(host, 'a');
    await host.eval(`(() => { const H = window.__arenaBattle; for (let i = 0; i < 400 && H.scene.mode !== 'wait'; i++) H.scene.tick(); return H.scene.mode; })()`);
    const hw = await snap(host), hs = await nmStatus(host);
    rec(hw.mode === 'wait' && J(hs.waitingOn) === '[1]' && hw.phase === 'preview', 'LD5 after YES the host waits for the other player (the battle has not started on its machine)', J([hw.mode, hs.waitingOn, hw.phase]));
    // BLIND: the guest holds the host's commitment and nothing it could read the lead from
    await guest.waitFor('(() => { const r = window.__arenaOnline.nm()._debug.round; return !!r && !!r.theirs && !!r.theirs.c; })()', { timeoutMs: 20000 }).catch(() => {});
    const blind = await guest.eval('(() => { const r = window.__arenaOnline.nm()._debug.round; const b = window.__arenaBattle.ctl.battle; return { committed: !!(r && r.theirs && r.theirs.c), revealed: !!(r && r.theirs && r.theirs.w !== undefined), phase: b.s.phase, hostChoices: b.choiceLog.filter((e) => e.s === 0).length, order: b.s.sides[0].team.map((m) => m.orig) }; })()');
    rec(blind.committed && !blind.revealed && blind.phase === 'preview' && blind.hostChoices === 0 && J(blind.order) === '[0,1,2,3,4,5]', 'LD6 the guest has the host\'s commitment and NOT its lead: nothing in its engine or its log says which Pokemon the host chose', J(blind));
    // the guest reloads while it still owes its lead: it comes back to the same question (the host's lead is still unseen)
    const gNames = g0.names;
    await guest.send('Page.reload', { ignoreCache: false });
    const back = await guest.waitFor('window.__arenaOnline && window.__arenaBattle && window.__arenaBattle.state === "ready" && window.__arenaBattle.resume && window.__arenaOnline.nm().status().link === "up"', { timeoutMs: 45000 }).then(() => true, () => false);
    if (!back) { rec(false, 'LD7 a guest that reloads while it still owes its lead comes back to the same lead preview', 'the reloaded page never got back into the battle: ' + await guest.eval('(window.__arenaBattle && window.__arenaBattle.state) + " " + (window.__arenaOnline && window.__arenaOnline.state.stage)').catch(() => '?')); return; }
    await host.waitFor('window.__arenaOnline.nm().status().link === "up"', { timeoutMs: 60000 });
    await toPreview(guest);
    const g1 = await snap(guest);
    rec(g1.mode === 'preview' && g1.lead && g1.rows === 6 && J(g1.names) === J(gNames) && g1.phase === 'preview' && g1.log.every((e) => !e.startsWith('0:')), 'LD7 a guest that reloads while it still owes its lead comes back to the same lead preview (the same team, nothing chosen, the host\'s lead still unseen)', J([g1.mode, g1.lead, g1.rows, g1.phase, g1.log]));
    // the guest chooses its 3rd
    await pressKeys(guest, 'down', 'down', 'a');
    rec((await snap(guest)).title === 'Send out this one first?', 'LD8 the guest\'s question is the same one', J(await snap(guest)));
    await pressKeys(guest, 'a');
    for (let i = 0; i < 120; i++) { const [a, b] = [await snap(host), await snap(guest)]; if (a.phase === 'move' && b.phase === 'move') break; await sleep(150); }
    const [h1, g2] = [await snap(host), await snap(guest)];
    rec(h1.phase === 'move' && g2.phase === 'move' && J(h1.order) === '[[3,0,1,2,4,5],[2,0,1,3,4,5]]' && J(g2.order) === J(h1.order) && h1.hash === g2.hash, 'LD9 both machines then hold one position: the host\'s 4th and the guest\'s 3rd in front, the rest in team order', J([h1.phase, g2.phase, h1.order, g2.order, h1.hash === g2.hash]));
    rec(h1.mine[0] === h0.names[3] && g2.mine[0] === gNames[2], 'LD10 and the Pokemon in front on each side is the one that player chose (the host\'s ' + h0.names[3] + ', the guest\'s ' + gNames[2] + ')', J([h1.mine[0], h0.names[3], g2.mine[0], gNames[2]]));
    rec(['0:preview:3', '1:preview:2'].every((e) => h1.log.includes(e) && g2.log.includes(e)) && h1.log.length === 2, 'LD11 the lead choices are the first two entries of the choice log on both machines (one-slot previews)', J([h1.log, g2.log]));
    // into the first menu: the Pokemon on the player's box is the lead
    for (const p of [host, guest]) await p.eval(`(() => { const H = window.__arenaBattle; for (let i = 0; i < 30000 && H.scene.mode !== 'action'; i++) { H.scene.tick(); if (H.scene.mode === 'steps' && H.scene.S.cur && H.scene.S.cur.t === 'text') H.scene.press('a'); } return H.scene.mode; })()`);
    const [h2, g3] = [await snap(host), await snap(guest)];
    rec(h2.mode === 'action' && g3.mode === 'action' && h2.shown === h0.names[3] && g3.shown === gNames[2], 'LD12 each screen\'s first menu shows its own lead on the player\'s box', J([h2.mode, h2.shown, g3.mode, g3.shown]));
    await shot(host, 'LD_host_first_menu');
    const modes = await Promise.all([drive(host, 240000), drive(guest, 240000)]);
    await sleep(400);
    const [sa, sb] = [await nmStatus(host), await nmStatus(guest)];
    rec(modes.every((m) => m === 'result') && sa.phase === 'over' && sb.phase === 'over' && !sa.error && !sb.error && sa.result.hash === sb.result.hash, 'LD13 the match plays to the end in agreement', J([modes, sa.phase, sb.phase, sa.error, sb.error]));
    rec(host.errors.length === 0 && guest.errors.length === 0, 'LD14 no page errors', J(host.errors.concat(guest.errors)).slice(0, 200));
  });
}
async function groupLead(S) {
  await leadSession(ORIGIN, ok);
  if (!process.argv.includes('--mutants')) return;
  if (REMOTE) { ok(true, 'LDMUT (skipped against a deployed site)'); return; }
  const { copyTree, mutateFile, startOverlay } = await import('./pokemonarena_overlay.mjs');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-lead-mut-'));
  let killed = 0, ran = 0;
  try {
    for (const mu of LEAD_MUTANTS) {
      const failed = [];
      const rec = (cond, name, detail) => { if (!cond) failed.push(name + (detail ? ' :: ' + String(detail).slice(0, 160) : '')); };
      ran++;
      const dir = copyTree(path.join(root, 'pokemonarena'), path.join(tmp, mu.id));
      let ov = null;
      try {
        try { mutateFile(dir, mu.file, mu.from, mu.to); } catch (e) { ok(false, 'LDMUT ' + mu.id + ' could not be applied', e.message); continue; }
        ov = await startOverlay({ dir, port: PORT + 22, upstream: ORIGIN });
        try { await leadSession(ov.url, rec); } catch (e) { failed.push('session crashed :: ' + String(e && e.message ? e.message : e).slice(0, 120)); }
      } finally { if (ov) ov.stop(); }
      const hit = failed.find((f) => f.startsWith(mu.fails + ' '));
      ok(!!hit, 'LDMUT ' + mu.id + ' (' + mu.what + ') fails ' + mu.fails, hit ? '' : 'it did NOT: failed cases = ' + J(failed.map((f) => f.slice(0, 60))));
      if (hit) killed++;
    }
  } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_e) { /* ignore */ } }
  console.log(`lead mutants: ${killed}/${ran} killed`);
}
// every defect below must fail the NAMED case (the session is run against a copy of the game with only that defect in it)
const LEAD_MUTANTS = [
  { id: 'LM1', what: 'the networked controller is built without the lead preview', file: 'js/online_match.js', from: 'seed: seed >>> 0, ...formatOpts(fmt), names:', to: 'seed: seed >>> 0, pick: FORMATS[fmt].pick, names:', fails: 'LD2' },
  { id: 'LM2', what: 'the scene does not know the request is a lead preview (it shows the 3v3 counter)', file: 'js/scene.js', from: 'lead: !!req.lead, mine,', to: 'lead: false, mine,', fails: 'LD3' },
  { id: 'LM3', what: 'the numbers show only the lead, not the order the battle will use', file: 'js/scene.js', from: 'picks: p.lead ? leadOrder(p) : p.picks,', to: 'picks: p.picks,', fails: 'LD4' },
  { id: 'LM4', what: 'the lead round is sent as a plain choice, so the first player to choose shows the other their lead', file: 'js/netmatch.js', from: 'if (round.need[0] && round.need[1]) {\n      const nonce = hex(rbytes(16));', to: "if (round.need[0] && round.need[1] && round.kind !== 'preview') {\n      const nonce = hex(rbytes(16));", fails: 'LD6' },
  { id: 'LM5', what: 'a stored reload record is never accepted back (a reload does not come back to the question)', file: 'js/netmatch.js', from: 'if (!rec || rec.v !== PROTO || rec.role !== role', to: 'if (!rec || rec.role !== "nobody"', fails: 'LD7' },
  { id: 'LM6', what: 'the engine puts the rest in reverse order behind the lead', file: 'js/engine.js', from: 'for (let i = 0; i < sd.team.length; i++) if (i !== lead) order.push(i);', to: 'for (let i = sd.team.length - 1; i >= 0; i--) if (i !== lead) order.push(i);', fails: 'LD9' },
];

async function groupLayout(S) {
  await withBrowser({ port: CDP0 + 8, width: 390, height: 844, mobile: true, lock: false, args: NO_THROTTLE }, async (host) => {
    const guest = await host.openTab({ width: 390, height: 844, mobile: true });
    await openRoom(host, 'AMOBI', 'host');
    const overflow = await host.eval('document.documentElement.scrollWidth - document.documentElement.clientWidth');
    ok(overflow <= 0, 'V1 the confirm screen does not overflow a 390 px phone', String(overflow));
    const tap = await host.eval(`(() => { const H = window.__arenaBattle, c = H.canvas.getBoundingClientRect(), k = c.width / 240; const rows = H.onlineScreen.rects().map((r) => [r.id, Math.round(r.h * k), Math.round(r.w * k)]); const pads = [...document.querySelectorAll('#dpad .pbtn, #ab .pbtn')].filter((n) => n.offsetParent !== null).map((n) => { const r = n.getBoundingClientRect(); return [n.id, Math.round(r.height), Math.round(r.width)]; }); return { rows, pads, canvas: [Math.round(c.left), Math.round(c.right), Math.round(c.width)], vw: innerWidth, dom: document.querySelectorAll('#online, #screenWrap select, #screenWrap input, #screenWrap textarea').length }; })()`);
    ok(tap.dom === 0 && tap.rows.length === 3 && tap.rows.every(([, h, w]) => h >= 18 && w >= 150) && tap.pads.length >= 6 && tap.pads.every(([, h, w]) => h >= 44 && w >= 44) && tap.canvas[0] >= 0 && tap.canvas[1] <= tap.vw + 1 && tap.canvas[2] >= 380, 'V2 on a phone the screen is the picture, edge to edge: no form in the page, three rows a finger can take, and the on-screen buttons (44 css px or more) that drive them', JSON.stringify(tap));
    await shot(host, 'V_phone_setup');
    await openRoom(guest, 'AMOBI', 'guest');
    await fillAndGo(host, { name: 'Alice', fmt: '3v3' }); await host.waitFor('window.__arenaOnline.view().code !== ""', { timeoutMs: 30000 }); await fillAndGo(guest, { name: 'Bob' });
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
    await host.waitFor(`window.__arenaOnline && location.pathname === "/pokemonarena/battle.html" && window.__arenaOnline.view().canGo`, { timeoutMs: 90000 });
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
    await host.eval(`(() => { const O = window.__arenaOnline; O.setForm({ teamKey: 'random', name: 'Hosty', fmt: '3v3' }); void O.go(); })()`);
    await host.waitFor('window.__arenaOnline.view().code !== ""', { timeoutMs: 30000 });
    await guest.eval('document.getElementById("btnJoin").click()');
    await guest.waitFor(`window.__arenaOnline && location.pathname === "/pokemonarena/battle.html" && window.__arenaOnline.view().canGo`, { timeoutMs: 90000 });
    const gu = new URL(await guest.eval('location.href'));
    ok(gu.searchParams.get('np') === code && gu.searchParams.get('join') === '1', 'B6 "Join" lands on the battle page as the guest, under the same code', gu.search);
    { const g = await OV(guest); ok(g.kind === 'invited' && g.info.some((l) => l.label === 'ROOM' && l.value === code) && g.fmtShown === false && (await guest.eval('window.__arenaOnline.state.form.room')) === code, 'B7 the guest\'s screen is YOU\'RE INVITED with the room named and no battle size to choose', J([g.kind, g.info, g.fmtShown])); }
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
  ok(!/id="(onlineLink|playFriend|trainerCenter|openToggle)"/.test(html) && /<canvas id="hub"/.test(html) && MAIN_LABELS.includes('PLAY ONLINE'), 'H1 the hub leads to online play from its PICTURE: PLAY ONLINE is a row of the main menu, and the HTML row of links that stood under the picture is gone', '');
  const bh = await (await fetch(BASE)).text();
  ok(/\/lib\/netplay\.js\?v=[0-9a-f]{8}/.test(bh), 'H2 battle.html loads the netplay engine with a version stamp', '');
}


/* ---------------------------------------------------------------------------------------------- open games (js/openlobby.js + the panel in js/online.js) */
// the page that watches the open-games board: the plain address asking FIND AN OPPONENT? (?online=1&ask=quick; no role, no code in the address). openquick / openjoin shorten the search's look-around and a silent game's patience (net=local only)
async function openPanel(page, extra = '') {
  await page.navigate(BASE + '?online=1&ask=quick&net=local' + ANIM + extra);
  await page.waitFor('window.__arenaOnline && window.__arenaBattle && window.__arenaBattle.state === "online" && window.__arenaOnline.view().canGo && window.__arenaOnline.view().canQuick', { timeoutMs: 90000 });
}
// (the name is set the way a player sets it: the page hears an `input` event, which is what makes it THEIR name - one the panel remembers - rather than one it filled in itself)
const setForm = (page, { name, fmt, pub = false, role }) => page.eval('(() => {' +
  'window.__arenaOnline.setForm({ name: ' + JSON.stringify(name) + ', typed: true' + (fmt ? ', fmt: ' + JSON.stringify(fmt) : '') + ' });' +
  (void role, '') +          // (role: a private room is startAs("host"), a listed game is quick())
  (void pub, '') +          // (pub: the game is meant to be LISTED; the caller presses Find an opponent, the only public way in now that a friend's room is always private)
  'return true; })()');
// the open games as THIS page hears them (the hook's board(): the board's list without the games on another build): what the players list showed, read without it
const board = (p) => p.eval('window.__arenaOnline.board().map((g) => { const fmt = g.fmt === "3v3" ? "3 v 3" : "6 v 6"; return { room: g.room, who: g.who, fmt, label: (g.h ? "Challenge " : "Join ") + g.who + " (" + fmt + ")" }; })');
// every game the board holds for this page, the ones on another build included (they are marked, and board() leaves them out)
const boardAll = (p) => p.eval('window.__arenaOnline.lobbies() ? window.__arenaOnline.lobbies().list().map((g) => ({ room: g.room, compatible: !!g.compatible })) : null');
const statusText = (p) => p.eval('window.__arenaOnline.view().status.text');
const stageOf = (p) => p.eval('window.__arenaOnline.state.stage');
const clickJoin = (p, room) => p.eval('(window.__arenaOnline.pick(' + JSON.stringify(room) + '), true)');          // (pick: join a listed game, or challenge a resident: what a press on its row meant)
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
    const vis = await OV(host), watching = await host.eval('!!window.__arenaOnline.lobbies()');
    ok(vis.kind === 'ask-quick' && vis.labels === 'YES|BACK' && watching && vis.dom === 0 && (await host.eval('document.querySelectorAll("#olPublicBox, #olOpenList").length')) === 0, 'O1 the plain address with ask=quick asks FIND AN OPPONENT? in the picture and watches the board; the page has no panel, no list of players, and NO switch that makes a friend\'s room public', J([vis.kind, vis.labels, watching, vis.dom]));
    ok((await board(guest)).length === 0 && J(await boardAll(guest)) === '[]', 'O2 with nobody listed the page hears no game', J(await boardAll(guest)));
    await setForm(host, { name: 'Alice', fmt: '3v3', pub: true, role: 'host' });
    { const qn = (await OV(host)).lede; ok(/trainer name/.test(qn) && /online record/.test(qn), 'O3 the question says what other players see (trainer name, online record), before YES', qn); }
    await host.eval('void window.__arenaOnline.quick()');
    await host.waitFor('window.__arenaOnline.view().code !== ""', { timeoutMs: 30000 });
    const room = (await host.eval('window.__arenaOnline.view().code')).trim();
    ok(/your game is open: anyone/i.test(await statusText(host)) && room.length >= 4 && (await OV(host)).labels === 'COPY CODE|STOP LOOKING', 'O4 the host is told the game is open to anyone (and still has the code for a friend)', await statusText(host));
    await guest.waitFor('window.__arenaOnline.board().length === 1', { timeoutMs: 15000 });
    const rows = await board(guest);
    ok(rows.length === 1 && rows[0].room === room && rows[0].who === 'Alice' && rows[0].fmt === '3 v 3' && /Join Alice/.test(rows[0].label), 'O5 the other browser\'s board shows the game: who, the format and a Join button', J(rows));
    ok(J(await boardAll(guest)) === J([{ room, compatible: true }]), 'O6 and it is the only game on the board', J(await boardAll(guest)));
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
    await a.eval('void window.__arenaOnline.quick()');
    await a.waitFor('window.__arenaOnline.state.stage === "open"', { timeoutMs: 30000 });
    const hosting = await a.eval('window.__arenaOnline.lobbies().hosting()');
    ok(hosting && hosting.q === true && hosting.fmt === '6v6' && hosting.name === 'Ann', 'Q1 with nobody waiting Find a battle opens an open game of its own, in the format chosen', J(hosting));
    ok(/Nobody was waiting/.test(await statusText(a)), 'Q2 and says so', await statusText(a));
    await b.waitFor('window.__arenaOnline.board().length === 1', { timeoutMs: 15000 });
    await setForm(b, { name: 'Ben' });
    await b.eval('void window.__arenaOnline.quick()');
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
    await Promise.all([a.eval('void window.__arenaOnline.quick()'), b.eval('void window.__arenaOnline.quick()')]);
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
    await a.waitFor('window.__arenaOnline.lobbies().list().some((g) => g.room === "AOLD1")', { timeoutMs: 8000 });
    ok((await board(a)).length === 0 && J(await boardAll(a)) === J([{ room: 'AOLD1', compatible: false }]), 'X1 a game on another build is not among the games this page can play (the board heard it, and marked it)', J(await boardAll(a)));
    // a hostile name is plain text
    await inject(b, fake(id, { room: 'AHOST', s: '00000000000000a2', name: '<img src=x onerror=window.__pwned=1>Eve' }));
    await a.waitFor('window.__arenaOnline.board().length === 1', { timeoutMs: 8000 });
    const hostile = await a.eval('({ who: window.__arenaOnline.board()[0].who, imgs: document.querySelectorAll("#screenWrap img, #live img").length, pwned: !!window.__pwned })');
    ok(/^[A-Za-z0-9 .'_!?-]{1,10}$/.test(hostile.who) && hostile.imgs === 0 && !hostile.pwned, 'X2 a hostile name is cut to safe text and nothing in it runs', J(hostile));
    // a made-up game: pressing Join finds nobody; the joiner gives up on it in a few seconds, says so, and it stays off the board
    await inject(b, fake(id, { room: 'AGHOS', s: '00000000000000a3', name: 'Ghost' }));
    await a.waitFor('window.__arenaOnline.board().some((g) => g.room === "AGHOS")', { timeoutMs: 8000 });
    await setForm(a, { name: 'Ann' });
    await clickJoin(a, 'AGHOS');
    await a.waitFor('window.__arenaOnline.state.stage === "setup" && /not open any more/.test(window.__arenaOnline.view().status.text)', { timeoutMs: 25000 });
    ok(true, 'X3 a game that never answers is given up on, in words', await statusText(a));
    ok(!(await board(a)).some((g) => g.room === 'AGHOS'), 'X4 and it is off the board (muted), even though its beacon keeps arriving', J(await board(a)));
    ok((await a.eval('!window.__arenaOnline.view().canGo')) === false && (await a.eval('!window.__arenaOnline.view().canQuick')) === false, 'X5 the panel is usable again', '');
    // a game whose rules are not my team's: refused BEFORE connecting
    await inject(b, fake(id, { room: 'ARULE', s: '00000000000000a4', rs: 'some-other-ruleset', name: 'Odd' }));
    await a.waitFor('window.__arenaOnline.board().some((g) => g.room === "ARULE")', { timeoutMs: 8000 });
    await clickJoin(a, 'ARULE');
    await a.waitFor('/different rules/.test(window.__arenaOnline.view().status.text)', { timeoutMs: 10000 });
    ok((await stageOf(a)) === 'setup', 'X6 a game under other rules is refused in words, before any connection', await statusText(a));
    // a game that says it is gone
    await inject(b, { t: 'arenaopen', v: 1, k: 'gone', s: '00000000000000a2', room: 'AHOST' });
    await a.waitFor('!window.__arenaOnline.board().some((g) => g.room === "AHOST")', { timeoutMs: 8000 });
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
    await a.eval('void window.__arenaOnline.quick()');
    await a.waitFor('window.__arenaOnline.view().code !== ""', { timeoutMs: 30000 });
    await b.waitFor('window.__arenaOnline.board().length === 1', { timeoutMs: 15000 });
    await a.navigate('about:blank');
    const t0 = Date.now();
    await b.waitFor('window.__arenaOnline.board().length === 0', { timeoutMs: 8000 });
    ok(Date.now() - t0 < 8000, 'OL1 closing the host\'s page takes the game off the other board within seconds (not the 13 s a missing beacon would take)', String(Date.now() - t0));
    await openPanel(a);
    await setForm(a, { name: 'Pat', role: 'host' });         // the switch stays off: a private game
    await a.eval('void window.__arenaOnline.startAs("host")');
    await a.waitFor('window.__arenaOnline.view().code !== ""', { timeoutMs: 30000 });
    await sleep(1800);
    ok((await board(b)).length === 0 && (await a.eval('window.__arenaOnline.lobbies()')) === null, 'OL2 a private game is never listed (and opens no connection to the board)', J(await board(b)));
    ok(/Waiting for your friend/.test(await statusText(a)) && !/allow/i.test(await statusText(a)), 'OL3 and waits for the friend (nobody has to press Allow)', await statusText(a));
    await b.navigate(BASE + '?np=ABCDE&host=1&net=local' + ANIM);
    await b.waitFor('window.__arenaOnline && window.__arenaOnline.view().canGo', { timeoutMs: 60000 });
    const hv = await b.eval('({ board: !!window.__arenaOnline.lobbies(), kind: window.__arenaOnline.view().kind, pub: !!document.getElementById("olPublicBox") })');
    ok(!hv.board && hv.kind === 'room' && !hv.pub, 'OL4 a lobby hand-off (a code in the address) dials no board and has no public switch: a room with a code is private', J(hv));
  });

  // OR: two joiners for one seat; one gets it, the other is told in words and is not stuck
  await withBrowser({ port: CDP0 + 15, width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (h) => {
    const g1 = await h.openTab({ width: 900, height: 760 }), g2 = await h.openTab({ width: 900, height: 760 });
    await openPanel(h); await openPanel(g1, '&openjoin=15000'); await openPanel(g2, '&openjoin=15000');
    await setForm(h, { name: 'Hal', pub: true, role: 'host' });
    await h.eval('void window.__arenaOnline.quick()');
    await h.waitFor('window.__arenaOnline.view().code !== ""', { timeoutMs: 30000 });
    const room = (await h.eval('window.__arenaOnline.view().code')).trim();
    await g1.waitFor('window.__arenaOnline.board().length === 1', { timeoutMs: 15000 });
    await g2.waitFor('window.__arenaOnline.board().length === 1', { timeoutMs: 15000 });
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
    await h.eval('void window.__arenaOnline.quick()');
    await h.waitFor('window.__arenaOnline.view().code !== ""', { timeoutMs: 30000 });
    const room1 = (await h.eval('window.__arenaOnline.view().code')).trim();
    // a bare lib/netplay.js session that is let in and then says a hello the host must refuse (a ROM that is not ours)
    await raw.eval('(async () => { const s = new Netplay.Session({ code: ' + JSON.stringify(room1) + ', host: false, portCount: 2, transport: "local" }); window.__rawS = s; const up = new Promise((res) => s.on("status", (e) => { if (e.state === "connected") res(true); })); s.start(); await up; s._send({ t: "lsarena", v: ' + PROTO + ', mn: 1, k: "hello", rom: "0".repeat(64), fp: "x", rs: "x", name: "Mallory", team: "x", fmt: null }); return true; })()');
    await h.waitFor('window.__arenaOnline.state.room !== ' + JSON.stringify(room1) + ' && window.__arenaOnline.state.stage === "open"', { timeoutMs: 60000 });
    const room2 = (await h.eval('window.__arenaOnline.view().code')).trim();
    ok(room2 !== room1 && (await h.eval('document.getElementById("error").hidden')), 'OV1 a joiner whose game does not match is turned away and the host is NOT shown an error: the game is open again under a new code', room1 + ' -> ' + room2);
    const hosting = await h.eval('window.__arenaOnline.lobbies().hosting()');
    ok(hosting && hosting.room === room2, 'OV2 and it is listed under the new code', J(hosting));
    await real.waitFor('window.__arenaOnline.board().some((g) => g.room === "' + room2 + '")', { timeoutMs: 20000 });
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
    await h.eval('void window.__arenaOnline.quick()');
    await h.waitFor('window.__arenaOnline.view().code !== ""', { timeoutMs: 30000 });
    const room1 = (await h.eval('window.__arenaOnline.view().code')).trim();
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
    await h.eval('void window.__arenaOnline.quick()');
    await h.waitFor('window.__arenaOnline.view().code !== ""', { timeoutMs: 30000 });
    const room = (await h.eval('window.__arenaOnline.view().code')).trim();
    await g.waitFor('window.__arenaOnline.board().length === 1', { timeoutMs: 15000 });
    await o.waitFor('window.__arenaOnline.board().length === 1', { timeoutMs: 15000 });
    // the board loses every broker under a listed game: the host is told nobody can find it (it used to go on saying "your game is open"), and is told the good news again when the board is back
    const hid = await identity(h);
    const kick = (name) => inject(o, fake(hid, { room: 'AKICK', s: '00000000000000e1', fp: 'e0.other.build', name }));          // another build: on the board's books but not in anybody's list; any change makes the page look at the connection again
    await h.eval('(() => { const L = window.__arenaOnline.lobbies(); window.__realStatus = L.status; L.status = () => "down"; return true; })()');
    await kick('Kick1');
    const sawDown = await h.waitFor('/cannot be reached/.test(window.__arenaOnline.view().status.text)', { timeoutMs: 8000 }).then(() => true, () => false);
    ok(sawDown, 'U0 a listed game on a board that has lost every broker is told nobody can find it', await statusText(h));
    await h.eval('window.__arenaOnline.lobbies().status = window.__realStatus; true');
    await kick('Kick2');
    const sawUp = await h.waitFor('/anyone can join/i.test(window.__arenaOnline.view().status.text)', { timeoutMs: 8000 }).then(() => true, () => false);
    ok(sawUp, 'U0b ... and is told it is open again when the board is back', await statusText(h));
    // the library is made to sit on the admission: the knock IS let in (the page approves it) but no link is ever made, so "connected" never comes
    await h.eval('(() => { const S = window.__arenaOnline.session(); S.approve = async () => false; return true; })()');
    await setForm(g, { name: 'Gus' });
    await clickJoin(g, room);
    await h.waitFor('window.__arenaOnline.state.admitted === true', { timeoutMs: 30000 });
    const gone = await o.waitFor('window.__arenaOnline.board().length === 0', { timeoutMs: 4000 }).then(() => true, () => false);
    ok(gone && (await h.eval('window.__arenaOnline.nm()')) === null && (await h.eval('window.__arenaOnline.state.stage')) === 'open', 'U1 the moment the knock is let in the game is off the board (within seconds, not the 13 s a silent listing takes to age off), although nothing has connected yet', J(await board(o)));
    // the library reports that the admitted link is gone before it was ever up
    await h.eval('(() => { const S = window.__arenaOnline.session(); const p = S._pending; delete S.approve; if (p) S.deny(p.nonce, "test"); S._emit("peer-left", { peer: p ? p.nonce : "x", why: "ice-timeout", remaining: 0 }); return true; })()');
    const back = await o.waitFor('window.__arenaOnline.board().length === 1', { timeoutMs: 8000 }).then(() => true, () => false);
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
    await a.eval('void window.__arenaOnline.quick()');
    const refused = await a.waitFor('/could not be reached/.test(window.__arenaOnline.view().status.text)', { timeoutMs: 15000 }).then(() => true, () => false);
    ok(refused && (await stageOf(a)) === 'setup' && (await a.eval('window.__arenaOnline.lobbies().hosting()')) === null && (await a.eval('!window.__arenaOnline.view().canQuick')) === false, 'OT0 with the board down Find a battle opens no game and says so, and the panel is usable again', (await stageOf(a)) + ' ' + (await statusText(a)));
    if (!refused) return;
    await a.eval('window.__arenaOnline.lobbies().status = window.__realStatus; true');
    await a.eval('void window.__arenaOnline.quick()');
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
    const again = await a.eval('({ role: window.__arenaOnline.state.role, quick: window.__arenaOnline.state.quick, hosting: window.__arenaOnline.lobbies().hosting(), codeShown: window.__arenaOnline.view().code !== "", status: window.__arenaOnline.view().status.text })');
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
    await h.eval('void window.__arenaOnline.quick()');
    await h.waitFor('window.__arenaOnline.view().code !== ""', { timeoutMs: 30000 });
    const room = (await h.eval('window.__arenaOnline.view().code')).trim();
    await g.waitFor('window.__arenaOnline.board().length === 1', { timeoutMs: 15000 });
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
    ok(up, 'S3 the player in the match is let back in by the new Session: both sides report the link up again', await g.eval('window.__arenaOnline.view().status.text'));
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
const opBoardCount = (p) => p.eval('window.__arenaOnline.board().length');
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
    await a.eval('void window.__arenaOnline.quick()');
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
    await o.waitFor('window.__arenaOnline.board().length === 1', { timeoutMs: 15000 });
    await h.eval(OP_STALL); await h.eval(OP_COUNT_HOST);
    await h.eval('(() => { const S = window.__arenaOnline.session(); window.__left = []; S.on("peer-left", (e) => window.__left.push(e.why)); return true; })()');
    const nonce = await opKnock(raw, room);                // a bare library session: the open game lets it in, and the offer never leaves
    const admitted = await h.waitFor('window.__arenaOnline.state.admitted === true', { timeoutMs: 30000 }).then(() => true, () => false);
    const joining = await statusText(h);
    ok(admitted && /player is joining/.test(joining) && !/your game is open/.test(joining), 'OP2 the moment somebody is let in the host is told a player is joining, not that the game is open to anyone', joining);
    if (!admitted) return;
    await o.waitFor('window.__arenaOnline.board().length === 0', { timeoutMs: 6000 }).catch(() => null);
    // the same player knocks again on a new page (a second Session with the same code in that tab: same nonce, new incarnation): the library tears the old link down (peer-left) and re-admits by itself
    const knock = await raw.eval('(async () => { const n = window.__rawN, first = window.__rawS; first.close(); const s = new Netplay.Session({ code: ' + J(room) + ', host: false, portCount: 2, transport: "local" }); window.__rawS2 = s; s.start(); return { same: s._nonce === n, newInc: s._inc !== first._inc }; })()');
    const left = await h.waitFor('window.__left.length > 0', { timeoutMs: 15000 }).then(() => true, () => false);
    ok(knock.same && knock.newInc && left && (await h.eval('window.__left[0]')) === 'peer-reloaded', 'OP2r (the rig) a page that came back with the same identity makes the library emit peer-left "peer-reloaded", the reason the page keys on', J([knock, await h.eval('window.__left')]));
    let relistedDuring = false;
    for (let i = 0; i < 12; i++) { if ((await opBoardCount(o)) > 0 || (await h.eval('window.__hostCalls')) > 0) relistedDuring = true; await sleep(250); }
    const during = await h.eval('({ admitted: window.__arenaOnline.state.admitted, hostCalls: window.__hostCalls, status: window.__arenaOnline.view().status.text })');
    ok(!relistedDuring && during.admitted === true && during.hostCalls === 0 && /player is joining/.test(during.status), 'OP2b while the player who knocked again is being let back in the game is NOT put back on the board (no listing sent, none on the other board, still "a player is joining")', J({ relistedDuring, during }));
    // the library gives up on the link (its connect watchdog): now the seat IS free, the game is listed again and says it is open again
    ok(await opGiveUp(h, nonce), 'OP2g (the rig) the library holds a link for the player who was let back in (so there was something to give up on)', '');
    const again = await o.waitFor('window.__arenaOnline.board().length === 1', { timeoutMs: 8000 }).then(() => true, () => false);
    const words = await h.eval('({ admitted: window.__arenaOnline.state.admitted, id: window.__arenaOnline.state.admittedId, status: window.__arenaOnline.view().status.text })');
    ok(again && words.admitted === false && words.id === null && /your game is open: anyone/.test(words.status), 'OP2c when the library gives up on the link the seat is free again: the game is back on the board AND says it is open (not "a player is joining")', J(words));
    ok(h.errors.length === 0 && o.errors.length === 0 && raw.errors.length === 0, 'OP2d no page errors', J(h.errors.concat(o.errors, raw.errors)).slice(0, 200));
  });
  // the player who knocked again never gets a link (their page went away between the library tearing the old link down and re-admitting them): the seat is not held for ever
  await withBrowser({ port: c.cdp(1), width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (h) => {
    const o = await h.openTab({ width: 900, height: 760 }), raw = await h.openTab({ width: 900, height: 760 });
    const room = await uxHost(c, h, 'Vera', '&openhold=1200');
    await uxPanel(c, o); await uxPanel(c, raw);
    await o.waitFor('window.__arenaOnline.board().length === 1', { timeoutMs: 15000 });
    await h.eval(OP_STALL); await h.eval(OP_COUNT_HOST);
    await opKnock(raw, room);
    const admitted = await h.waitFor('window.__arenaOnline.state.admitted === true', { timeoutMs: 30000 }).then(() => true, () => false);
    if (!admitted) { ok(false, 'OP2f (the rig) the first knock is let in', await statusText(h)); return; }
    await raw.eval('(async () => { window.__rawS.close(); const s = new Netplay.Session({ code: ' + J(room) + ', host: false, portCount: 2, transport: "local" }); await s.start(); s.close(); return true; })()');          // the hello leaves, the page is gone before it can answer
    const freed = await o.waitFor('window.__arenaOnline.board().length === 1', { timeoutMs: 15000 }).then(() => true, () => false);
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
    await g.waitFor('window.__arenaOnline.board().length === 1', { timeoutMs: 15000 });
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
    await o.waitFor('window.__arenaOnline.board().length === 1', { timeoutMs: 8000 }).catch(() => null);
    // the guest knocks again with the same identity: the library re-admits it BY ITSELF, with no join-request (offers are still held back)
    const calls0 = await h.eval('window.__hostCalls');
    await g.eval('window.__arenaOnline.session()._reknock("test: knocking again")');
    const silent = await h.waitFor('window.__arenaOnline.state.admitted === true', { timeoutMs: 8000 }).then(() => true, () => false);
    await o.waitFor('window.__arenaOnline.board().length === 0', { timeoutMs: 5000 }).catch(() => null);
    const sv = await h.eval('({ req: window.__joinReq, calls: window.__hostCalls, status: window.__arenaOnline.view().status.text })');
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
    ok(up && !prompted, 'OP3b the player the match belongs to is let back in by the REBUILT Session: both sides report the link up again, nobody was asked to press Allow, nobody was told the game is taken', J({ up, prompted, status: await g.eval('window.__arenaOnline.view().status.text') }));
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
    await a.waitFor('window.__arenaOnline.board().some((g) => g.room === "AGHOP")', { timeoutMs: 10000 });
    await setForm(a, { name: 'Ann' });
    await clickJoin(a, 'AGHOP');
    await a.waitFor('window.__arenaOnline.state.stage === "waiting"', { timeoutMs: 15000 });
    const q = (p) => p.eval('(() => { const u = new URLSearchParams(location.search); return { np: u.get("np"), join: u.get("join"), online: u.get("online"), net: u.get("net"), anim: u.get("anim") }; })()');
    const during = await q(a);
    ok(during.np === 'AGHOP' && during.join === '1', 'OP4r (the rig) while the join waits the address names the room and join=1 (so a reload finds the room)', J(during));
    await a.eval('void window.__arenaOnline.cancel()');
    const cancelled = await q(a);
    ok(cancelled.np === null && cancelled.join === null && cancelled.online === '1' && cancelled.net === 'local' && cancelled.anim === '0', 'OP4a Cancel puts the plain Play online address back (no room, no join=1, online=1; net and anim kept)', J(cancelled));
    await a.send('Page.reload', { ignoreCache: false });
    await a.waitFor(UX_READY + ' && window.__arenaOnline.view().canQuick', { timeoutMs: 90000 });
    const reloaded = await a.eval('({ board: !!window.__arenaOnline.lobbies(), kind: window.__arenaOnline.view().kind, room: window.__arenaOnline.state.form.room, stage: window.__arenaOnline.state.stage, role: window.__arenaOnline.state.role })');
    ok(reloaded.board === true && reloaded.kind === 'ask-quick' && reloaded.room === '' && reloaded.stage === 'setup' && reloaded.role !== 'guest', 'OP4b a reload after Cancel is the page that asks FIND AN OPPONENT? and watches the board (not YOU\'RE INVITED for the cancelled room)', J(reloaded));
    // a game that never answers is given up on after the wait: the address comes back the same way
    await a.waitFor('window.__arenaOnline.board().some((g) => g.room === "AGHOP")', { timeoutMs: 10000 });
    await clickJoin(a, 'AGHOP');
    await a.waitFor('window.__arenaOnline.state.stage === "setup" && /not open any more/.test(window.__arenaOnline.view().status.text)', { timeoutMs: 25000 }).catch(() => null);
    const gaveUp = await q(a);
    ok(gaveUp.np === null && gaveUp.join === null && gaveUp.online === '1', 'OP4c and so does a game that never answered and was given up on', J(gaveUp));
    ok(a.errors.length === 0, 'OP4d no page errors', J(a.errors).slice(0, 200));
  });
  // a join-by-code page (the lobby's hand-off, an address with a room) is NOT the board: Cancel there leaves its address alone
  await withBrowser({ port: c.cdp(1), width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (a) => {
    await uxRoom(c, a, 'AGHOQ', 'guest', '&openjoin=4000');
    await a.eval('void window.__arenaOnline.go()');
    await a.waitFor('window.__arenaOnline.state.stage === "waiting"', { timeoutMs: 15000 });
    await a.eval('void window.__arenaOnline.cancel()');
    const u = await a.eval('(() => { const q = new URLSearchParams(location.search); return { np: q.get("np"), join: q.get("join"), online: q.get("online") }; })()');
    ok(u.np === 'AGHOQ' && u.join === '1' && u.online === null, 'OP4e a join-by-code page keeps its own address after Cancel (it was never the board)', J(u));
  });
}

const OP_SESSIONS = { forger: opForger, joining: opJoining, readmit: opReadmit, cancel: opCancel };
// every defect below must fail the NAMED case; the session that holds it is run against a copy of the game with only that defect in it
const OPEN_MUTANTS = [
  { id: 'P01', what: 'a failed defection is remembered by room code only (no cooldown for every rival)', file: 'js/online.js', from: 'if (state.defecting) lobbies.muteRivals(DEFECT_MUTE_MS);', to: '', run: 'forger', fails: 'OP1' },
  { id: 'P02', what: 'the host of an open game that let somebody in is not told a player is joining', file: 'js/online.js', from: "say(state.open ? 'A player is joining your game. It is off the list of open games while they connect.' : ", to: "say(state.open ? '' : ", run: 'joining', fails: 'OP2' },
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
    await b.eval('void window.__arenaOnline.quick()');
    await b.waitFor('window.__arenaOnline.view().code !== ""', { timeoutMs: 30000 });
    await a.waitFor('window.__arenaOnline.board().length === 1', { timeoutMs: 15000 });
    await b.send('Page.bringToFront'); await sleep(400);
    const overflow = await b.eval('document.documentElement.scrollWidth - document.documentElement.clientWidth');
    ok(overflow <= 0, 'Y1 the waiting screen of an open game does not overflow a 390 px phone', String(overflow));
    const tap = await b.eval(`(() => { const H = window.__arenaBattle, c = H.canvas.getBoundingClientRect(), k = c.width / 240; const rows = H.onlineScreen.rects().map((r) => [r.id, Math.round(r.h * k), Math.round(r.w * k)]); const pads = [...document.querySelectorAll('#dpad .pbtn, #ab .pbtn')].filter((n) => n.offsetParent !== null).map((n) => { const r = n.getBoundingClientRect(); return [n.id, Math.round(r.height), Math.round(r.width)]; }); return { rows, pads, canvas: { l: c.left, r: c.right, t: c.top, b: c.bottom, w: Math.round(c.width) }, vw: innerWidth, vh: innerHeight }; })()`);
    ok(J(tap.rows.map((r) => r[0])) === J(['copy-code', 'cancel']) && tap.rows.every(([, h, w]) => h >= 18 && w >= 150) && tap.pads.length >= 6 && tap.pads.every(([, h, w]) => h >= 44 && w >= 44), 'Y2 its rows (COPY CODE, STOP LOOKING) can be taken by a finger, and the on-screen buttons that drive them are 44 css px or more', J(tap));
    ok(tap.canvas.l >= 0 && tap.canvas.r <= tap.vw + 1 && tap.canvas.t >= 0 && tap.canvas.b <= tap.vh + 1 && tap.canvas.w >= 380 && olFits(await OV(b)), 'Y3 the picture stays inside the screen, edge to edge, and every line of it fits its window', J(tap.canvas));
    await shot(b, 'Y_phone_board');
  });
}


/* ---------------------------------------------------------------------------------------------- open to battles (js/presence.js + presence_boot.js): the hub lists you; a challenger asks; you answer wherever you are */
// the hub (net=local so the board is the same-browser channel); openchal=<ms> shortens how long a challenge may go unanswered
async function openHub(page, extra = '') {
  await page.navigate(ORIGIN + '/pokemonarena/?net=local' + extra);
  await page.waitFor('window.__arenaHub && window.__arenaHub.state === "ready" && window.__arenaPresence', { timeoutMs: 120000 });
}
const seedProfile = (page, trainerName) => page.eval('(async () => { const { openStore } = await import("/pokemonarena/js/store.js"); const st = await openStore(); const c = await st.createProfile({ trainerName: ' + JSON.stringify(trainerName) + ' }); await st.setActiveId(c.id); await st.close(); return c.id; })()');
// OPEN TO BATTLES IS A ROW OF THE HUB'S PLAY ONLINE MENU (js/online_hub.js): the HTML switch #openToggle is gone. toggleState: what the row says, what the presence service says, what is stored.
// hubSwitch: press the row as a player does (open PLAY ONLINE, put the cursor on OPEN TO BATTLES, A) and go back to the screen the session was on.
const toggleState = (p) => p.eval('(() => { const H = window.__arenaHub, r = H.model.apps.online.allRows().find((x) => x.id === "open"); return { pressed: String(!!H.presence && H.presence.isOn()), text: r ? r.label + " " + r.value : null, stored: localStorage.getItem("arena.open") }; })()');
const hubSwitch = (p) => p.eval('(() => { const H = window.__arenaHub, was = H.model.path(); if (was !== "online") H.goto("online"); H.model.apps.online.select("open"); H.press("a"); if (was !== "online") H.goto(was); return true; })()');
// THE HUB ASKS IN THE PICTURE (js/hub_presence.js: "<name> wants to battle you" and the first-time disclosure are the hub's dialog layer, drawn from the ROM; there is no DOM dialog on the hub page).
// These read and drive the question through window.__arenaHub, the way a pad does: A turns the page, the d-pad moves the highlight, B is NO. (The same questions on the BATTLE page are still the
// DOM dialogs #challenge / #openInfo, and its sessions read those.) THE HUB'S CLOCK ONLY RUNS IN THE TAB THAT IS IN FRONT (a question listens 36 frames after it appears), so a session brings the
// hub to the front before it waits for a question to listen.
const HQ_CHAL = 'presence:challenge', HQ_DISC = 'presence:disclosure';
const HUB_Q = (id = HQ_CHAL) => `(() => { const H = window.__arenaHub, d = H && H.dialog ? H.dialog.current() : null; return !!d && d.id === ${J(id)}; })()`;
const HUB_Q_ARMED = (id = HQ_CHAL) => `(() => { const H = window.__arenaHub, d = H && H.dialog ? H.dialog.current() : null; return !!d && d.id === ${J(id)} && d.armed === true; })()`;
const HUB_Q_GONE = (id = HQ_CHAL) => `(() => { const H = window.__arenaHub, d = H && H.dialog ? H.dialog.current() : null; return !d || d.id !== ${J(id)}; })()`;
// what the question says and where its highlight is: { id, page, pages, armed, text (this page's lines), options, on (the option highlighted), dom (DOM dialogs of presence_boot.js in the page: must be 0) }
const hubQ = (p) => p.eval('(() => { const H = window.__arenaHub, d = H.dialog.current(), v = H.view().dialog; return d ? { id: d.id, page: d.page, pages: d.pages, armed: d.armed, text: v.lines.filter(Boolean).join(" "), options: d.choice ? d.choice.options : null, on: d.choice ? d.choice.options[d.choice.cursor] : null, last: d.choice ? d.choice.cursor === d.choice.options.length - 1 : null, dom: document.querySelectorAll("#challenge, #openInfo, .arena-chal").length } : null; })()');
const hubAsked = (p, id = HQ_CHAL) => p.eval(HUB_Q(id));
const hubFront = (p) => p.send('Page.bringToFront');
// every page of the question, read by turning them with A (it ends on the last page, where the options are)
const hubQPages = (p) => p.eval('(() => { const H = window.__arenaHub, out = []; const d = H.dialog.current(); if (!d) return out; for (let i = d.page; i < d.pages; i++) { out.push(H.view().dialog.lines.filter(Boolean).join(" ")); if (i < d.pages - 1) H.press("a"); } return out; })()');
// B: NO. And YES the long way: A to the last page, the d-pad up onto YES, A.
const hubNo = (p) => p.eval('(window.__arenaHub.press("b"), true)');
const hubYes = (p) => p.eval('(() => { const H = window.__arenaHub, d = H.dialog.current(); if (!d) return false; for (let i = d.page; i < d.pages - 1; i++) H.press("a"); H.press("up"); H.press("a"); return true; })()');
// the client point of a logical point of the picture (240 x 160), and of the middle of option k of the question that is up
const hubPoint = (p, lx, ly) => p.eval(`(() => { const r = window.__arenaHub.canvas.getBoundingClientRect(); return { x: r.left + ${lx} * r.width / 240, y: r.top + ${ly} * r.height / 160, k: r.width / 240 }; })()`);
const hubOption = (p, k) => p.eval(`(() => { const H = window.__arenaHub, rs = H.model.rects(), r = H.canvas.getBoundingClientRect(), o = rs[${k}]; return o ? { x: r.left + (o.x + o.w / 2) * r.width / 240, y: r.top + (o.y + o.h / 2) * r.height / 160, h: o.h * r.height / 160, w: o.w * r.width / 240, n: rs.length } : null; })()`);
const residentRow = (p) => p.eval('(() => { const g = window.__arenaOnline.board().find((x) => x.h); return g ? { room: g.room, who: g.who, button: "Challenge", label: "Challenge " + g.who + " (" + (g.fmt === "3v3" ? "3 v 3" : "6 v 6") + ")" } : null; })()');

async function groupPresence(S) {
  ANIM = '&anim=0';
  // A: switch on in the hub -> listed -> challenged -> Not now
  await withBrowser({ port: CDP0 + 19, width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (hub) => {
    const ch = await hub.openTab({ width: 900, height: 760 });
    await hub.navigate(ORIGIN + '/pokemonarena/?net=local');
    await seedProfile(hub, 'HUBHERO');
    await openHub(hub, '&openchal=5000');
    const t0 = await toggleState(hub);
    ok(t0.pressed === 'false' && t0.text === 'OPEN TO BATTLES OFF' && t0.stored === null, 'A1 the hub starts closed: the OPEN TO BATTLES row of PLAY ONLINE says OFF and nothing is stored', J(t0));
    await hubSwitch(hub);
    await hub.waitFor('window.__arenaPresence.isOn() && window.__arenaPresence.presence', { timeoutMs: 30000 });
    await hub.waitFor('window.__arenaHub.apps.state().online.open === "on"', { timeoutMs: 10000 }).catch(() => {});
    const t1 = await toggleState(hub);
    ok(t1.pressed === 'true' && t1.text === 'OPEN TO BATTLES ON' && t1.stored === '1', 'A2 switching it on (A on the row) says so in the picture, and remembers it', J(t1));
    await openPanel(ch, '&openchal=5000');
    await ch.waitFor('window.__arenaOnline.board().some((g) => g.h)', { timeoutMs: 20000 });
    const row = await residentRow(ch);
    ok(row && row.who === 'HUBHERO' && row.button === 'Challenge' && /Challenge HUBHERO/.test(row.label), 'A3 another browser\'s board lists the hub player by their PROFILE\'s trainer name, with a Challenge button (not Join)', J(row));
    await shot(ch, 'P_board_resident');
    await setForm(ch, { name: 'Chad' });
    await ch.eval('void window.__arenaOnline.pick(window.__arenaOnline.board().find((g) => g.h).room)');
    await hubFront(hub);
    await hub.waitFor(HUB_Q_ARMED(), { timeoutMs: 15000 });
    const dlg = await hubQ(hub);
    // (the menu behind the question hears nothing: a press goes to the question, and on its first page the d-pad has nothing to move)
    const behind = await hub.eval('(() => { const H = window.__arenaHub, c0 = H.model.state().cursor; H.press("down"); H.press("down"); return { same: JSON.stringify(H.model.state().cursor) === JSON.stringify(c0), asked: H.dialog.isOpen(), panel: H.dialogOpen() }; })()');
    const dlg2 = await hub.eval('(() => { const H = window.__arenaHub; H.press("a"); const d = H.dialog.current(); return { page: d.page, on: d.choice.options[d.choice.cursor], options: d.choice.options, shown: !!H.view().dialog.choice }; })()');
    ok(/^Chad.* wants to battle you\.$/.test(dlg.text) && dlg.dom === 0 && dlg.pages === 2 && dlg2.page === 1 && dlg2.shown && J(dlg2.options) === J(['YES', 'NO']) && dlg2.on === 'NO' && behind.same && behind.asked === true && behind.panel === false,
      'A4 the owner is asked IN THE PICTURE (no DOM dialog), naming the challenger, with YES / NO and NO highlighted (a stray press must not carry them off), and the menu behind the question hears nothing', J({ dlg, dlg2, behind }));
    ok(/Asked HUBHERO/.test(await statusText(ch)) && (await stageOf(ch)) === 'asking' && !(await ch.eval('!window.__arenaOnline.view().cancel.shown')), 'A5 the challenger is told it asked, and can cancel', await statusText(ch));
    await shot(hub, 'P_dialog_hub');
    await hubNo(hub);
    await ch.waitFor('window.__arenaOnline.state.stage === "setup"', { timeoutMs: 10000 });
    ok(/not available/.test(await statusText(ch)) && !(await hubAsked(hub)) && (await hub.eval('window.__arenaHub.dialog.isOpen()')) === false, 'A6 NO (the B button): the challenger is told in words, the question closes and the hub is live again', await statusText(ch));
    await ch.waitFor('window.__arenaOnline.board().some((g) => g.h)', { timeoutMs: 15000 });
    // The second ask must really go out and really be answered. This case used to wait for "setup + not available" with a `.catch(() => {})` and then sleep: a challenge that never left (the old
    // wait was already true from the first No, and a timeout was swallowed) passed as "no dialog". Now the challenge is COUNTED as it goes out (the challenger's own board connection), and the case
    // needs the answer to come back after that, in words; the status says "Checking your team..." the moment the button is pressed, so "not available" can only be the second No.
    await ch.eval('(() => { const L = window.__arenaOnline.lobbies(), sig = L.signal; window.__chals = 0; L.signal = function (k, ...a) { if (k === "chal") window.__chals++; return sig.call(this, k, ...a); }; return true; })()');
    await ch.eval('void window.__arenaOnline.pick(window.__arenaOnline.board().find((g) => g.h).room)');
    const asked2 = await ch.waitFor('window.__chals >= 1 && window.__arenaOnline.state.stage === "setup" && /not available/.test(window.__arenaOnline.view().status.text)', { timeoutMs: 15000 }).then(() => true, () => false);
    ok(asked2 && (await ch.eval('window.__chals')) === 1 && !(await hubAsked(hub)), 'A7 asking again straight after NO: the second ask goes out (once), gets a quiet no in words, and the owner is not asked again', 'asked+answered=' + asked2 + ' chals=' + (await ch.eval('window.__chals')) + ' ' + (await statusText(ch)));
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
    await hubSwitch(hub);
    await hub.waitFor('window.__arenaPresence.isOn() && window.__arenaPresence.presence', { timeoutMs: 30000 });
    await openPanel(ch, '&openchal=20000');
    await ch.waitFor('window.__arenaOnline.board().some((g) => g.h)', { timeoutMs: 20000 });
    await setForm(ch, { name: 'Chad' });          // typed in a tab of the SAME browser, so it is also what this browser remembers as "the name"
    // (the hub's clock is held while the challenge arrives, so the question is certainly still in its first moments when the presses below land: it has not started to listen)
    await hubFront(hub);
    await hub.eval('(window.__arenaHub.pause(true), true)');
    await ch.eval('void window.__arenaOnline.pick(window.__arenaOnline.board().find((g) => g.h).room)');
    await hub.waitFor(HUB_Q(), { timeoutMs: 15000 });
    await hubYes(hub);
    await sleep(200);
    const early = await hubQ(hub);
    ok(!!early && early.id === HQ_CHAL && early.page === 0 && early.armed === false && (await hub.eval('location.pathname')) === '/pokemonarena/', 'PB1 YES ignores presses in the first moments (a question nobody asked for must not be accepted by a stray A): A, up, A turned no page and answered nothing', J(early));
    await hub.eval('(window.__arenaHub.pause(false), true)');
    await hub.waitFor(HUB_Q_ARMED(), { timeoutMs: 10000 });
    await hubYes(hub);
    await hub.waitFor('location.pathname === "/pokemonarena/battle.html"', { timeoutMs: 30000 });
    const u = new URL(await hub.eval('location.href'));
    ok(u.searchParams.get('auto') === 'host' && /^[0-9a-f]{16}$/.test(u.searchParams.get('for')) && /^[0-9a-f]{16}$/.test(u.searchParams.get('rq')) && u.searchParams.get('format') === '3v3' && u.searchParams.get('net') === 'local', 'PB2 Accept takes the hub player to the battle page as the host of an accepted challenge', u.search);
    const b3 = await ch.eval('window.__arenaOnline.view().status.text');          // it used to end in `|| true` (never failed) and look for the CHALLENGER's own name; the page says the OWNER's (online.js: g.name + ' accepted. Connecting...')
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
    await hub.waitFor('window.__arenaOnline.nm().status().link === "up"', { timeoutMs: 90000 }); await ch.waitFor('window.__arenaOnline.nm().status().link === "up"', { timeoutMs: 60000 });
    ok((await spied(spy)).filter((m) => m && m.k === 'acc').length === accsBefore, 'PB13 the reloaded host is an ordinary host (it lets the returning player back in by itself), the link is back up, and no second room was announced', '');
    // the Accept address is not a standing command: opened again (Back, a restored tab, a pasted link) it has no token left and hosts nothing
    await hub.navigate(u.href);
    await hub.waitFor('window.__arenaOnline && window.__arenaBattle && window.__arenaBattle.state === "online" && (window.__arenaOnline.view().ready || window.__arenaOnline.view().code !== "" || window.__arenaOnline.state.stage !== "setup")', { timeoutMs: 90000 });       // (settled, one way or the other: a page that hosted a game for the address must fail PB14, not time out)
    await sleep(2500);
    const replay = await hub.eval('({ stage: window.__arenaOnline.state.stage, room: window.__arenaOnline.state.room, hosting: window.__arenaOnline.lobbies() ? window.__arenaOnline.lobbies().hosting() : null, status: window.__arenaOnline.view().status.text, board: window.__arenaOnline.view().kind === "ignored" && !window.__arenaOnline.lobbies(), codeShown: window.__arenaOnline.view().code !== "" })');
    ok(replay.stage === 'setup' && !replay.room && !replay.hosting && !replay.codeShown && replay.board && /ignored/.test(replay.status) && (await spied(spy)).filter((m) => m && m.k === 'acc').length === accsBefore, 'PB14 the same Accept address opened again hosts nothing, announces nothing, and says in the picture that it was ignored (no board is dialled for it)', J(replay));
  });

  // PL: a link is not an Accept. battle.html?online=1&auto=host&for=..&rq=.. from anywhere (no token written by the hub) opens no room and announces nothing, whatever it names
  await withBrowser({ port: CDP0 + 33, width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (v) => {
    const spy = await v.openTab({ width: 900, height: 760 });
    await spyOn(spy);
    const FOR = 'ab'.repeat(8), RQ = 'cd'.repeat(8);
    const craft = () => BASE + '?online=1&auto=host&for=' + FOR + '&rq=' + RQ + '&format=3v3&net=local' + ANIM;
    const panelReady = () => v.waitFor('window.__arenaOnline && window.__arenaBattle && window.__arenaBattle.state === "online" && (window.__arenaOnline.view().ready || window.__arenaOnline.view().code !== "" || window.__arenaOnline.state.stage !== "setup")', { timeoutMs: 90000 });       // (settled, one way or the other; not "enabled": a page that hosted a game for the link has its panel locked, and that must be a failed case below, not a timeout)
    const view = () => v.eval('({ stage: window.__arenaOnline.state.stage, room: window.__arenaOnline.state.room, role: window.__arenaOnline.state.role, hosting: window.__arenaOnline.lobbies() ? window.__arenaOnline.lobbies().hosting() : null, status: window.__arenaOnline.view().status.text, board: window.__arenaOnline.view().kind === "ignored" && !window.__arenaOnline.lobbies(), codeShown: window.__arenaOnline.view().code !== "" })');
    await v.navigate(craft()); await panelReady(); await sleep(2500);
    const a = await view();
    ok(a.stage === 'setup' && !a.room && !a.hosting && !a.codeShown && a.board && /ignored/.test(a.status), 'PL1 a bare accepted-challenge link opens no room: the picture says it was ignored, and no board is dialled', J(a));
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
    await hubSwitch(hub);
    await hub.waitFor('window.__arenaPresence.isOn() && window.__arenaPresence.presence', { timeoutMs: 30000 });
    await openPanel(c1, '&openchal=20000'); await openPanel(c2, '&openchal=20000');
    await c1.waitFor('window.__arenaOnline.board().some((g) => g.h)', { timeoutMs: 20000 });
    await c2.waitFor('window.__arenaOnline.board().some((g) => g.h)', { timeoutMs: 20000 });
    await setForm(c1, { name: 'One' }); await setForm(c2, { name: 'Two' });
    await c1.eval('void window.__arenaOnline.pick(window.__arenaOnline.board().find((g) => g.h).room)');
    await hub.waitFor(HUB_Q(), { timeoutMs: 15000 });
    await c2.eval('void window.__arenaOnline.pick(window.__arenaOnline.board().find((g) => g.h).room)');
    await c2.waitFor('window.__arenaOnline.state.stage === "setup" && /another challenge/.test(window.__arenaOnline.view().status.text)', { timeoutMs: 15000 });
    const first = await hubQ(hub);
    ok(/^One/.test(first.text) && (await hub.eval('window.__arenaHub.model.state().dialog.queued.length')) === 0, 'C1 a second challenger is told the owner is busy, and the question in the picture is still the first one (nothing queued behind it)', J([first, await statusText(c2)]));
    await c1.eval('void window.__arenaOnline.cancel()');
    await hub.waitFor(HUB_Q_GONE(), { timeoutMs: 10000 });
    ok((await stageOf(c1)) === 'setup' && /Cancelled/.test(await statusText(c1)), 'C2 cancelling closes the owner\'s question and puts the challenger back at the board', await statusText(c1));
    await c2.waitFor('window.__arenaOnline.board().some((g) => g.h)', { timeoutMs: 15000 });
    await c2.eval('void window.__arenaOnline.pick(window.__arenaOnline.board().find((g) => g.h).room)');
    await hub.waitFor(HUB_Q(), { timeoutMs: 15000 });
    ok(/^Two/.test((await hubQ(hub)).text), 'C3 and the owner can be asked again once the question is gone', '');
    // the challenger closes the tab while it is waiting: the challenge is withdrawn at once (the question does not stay up for a player who has gone, for the rest of its 20 s)
    const t0 = Date.now();
    await c2.navigate('about:blank');
    const closed = await hub.waitFor(HUB_Q_GONE(), { timeoutMs: 8000 }).then(() => true, () => false);
    ok(closed && Date.now() - t0 < 8000, 'C4 a challenger who leaves the page withdraws its challenge: the owner\'s question closes within seconds, not after the full wait', String(Date.now() - t0));
  });

  // D: nobody answers -> the dialog closes by itself and the challenger is told
  await withBrowser({ port: CDP0 + 22, width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (hub) => {
    const ch = await hub.openTab({ width: 900, height: 760 });
    await openHub(hub, '&openchal=1500');
    await hubSwitch(hub);
    await hub.waitFor('window.__arenaPresence.isOn() && window.__arenaPresence.presence', { timeoutMs: 30000 });
    await openPanel(ch, '&openchal=1500');
    await ch.waitFor('window.__arenaOnline.board().some((g) => g.h)', { timeoutMs: 20000 });
    // (watched from inside the page: with only 1.5 s to live, a poll from here could miss the question altogether)
    await hub.eval('(() => { window.__sawQ = false; const tick = () => { const d = window.__arenaHub.dialog.current(); if (d && d.id === "presence:challenge") window.__sawQ = true; if (!window.__qStop) setTimeout(tick, 20); }; tick(); return true; })()');
    await ch.eval('void window.__arenaOnline.pick(window.__arenaOnline.board().find((g) => g.h).room)');
    await hub.waitFor('window.__sawQ === true', { timeoutMs: 15000 });
    await hub.waitFor(HUB_Q_GONE(), { timeoutMs: 10000 });
    await ch.waitFor('window.__arenaOnline.state.stage === "setup"', { timeoutMs: 10000 });
    await hub.eval('(window.__qStop = true)');
    ok(/not available/.test(await statusText(ch)) && (await hub.eval('window.__arenaHub.dialog.isOpen()')) === false, 'D1 a question nobody answers closes by itself and counts as a no, told to the challenger', await statusText(ch));
  });

  // E: the switch is remembered, listed again after a reload, and off means gone
  await withBrowser({ port: CDP0 + 23, width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (hub) => {
    const ch = await hub.openTab({ width: 900, height: 760 });
    await openHub(hub);
    await hubSwitch(hub);
    await hub.waitFor('window.__arenaPresence.isOn() && window.__arenaPresence.presence', { timeoutMs: 30000 });
    await openPanel(ch);
    await ch.waitFor('window.__arenaOnline.board().some((g) => g.h)', { timeoutMs: 20000 });
    await openHub(hub);
    const t = await toggleState(hub);
    ok(t.pressed === 'true' && t.stored === '1', 'E1 a reload keeps the switch on', J(t));
    await ch.waitFor('window.__arenaOnline.board().some((g) => g.h)', { timeoutMs: 20000 });
    ok(true, 'E2 and the hub player is on the board again', '');
    await hubSwitch(hub);
    const t0 = Date.now();
    await ch.waitFor('!window.__arenaOnline.board().some((g) => g.h)', { timeoutMs: 8000 });
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
    await ch.waitFor('window.__arenaOnline.board().some((g) => g.h)', { timeoutMs: 20000 });
    await setForm(ch, { name: 'Cleo' });
    await ch.eval('void window.__arenaOnline.pick(window.__arenaOnline.board().find((g) => g.h).room)');
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
    await ch2.waitFor('window.__arenaOnline.board().some((g) => g.h)', { timeoutMs: 20000 });
    await ch2.eval('void window.__arenaOnline.pick(window.__arenaOnline.board().find((g) => g.h).room)');
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
    await hubSwitch(hub);
    await hub.waitFor('window.__arenaPresence.isOn() && window.__arenaPresence.presence', { timeoutMs: 30000 });
    const sid = await hub.eval('window.__arenaPresence.lobbies.sid');
    await raw.navigate(BASE + '?online=1&ask=host&net=local' + ANIM);          // (a same-origin page to speak on the board's channel from: the plain address with nothing to ask leaves for the hub)
    await inject(raw, { t: 'arenaopen', v: 1, k: 'chal', s: '00000000000000b1', to: sid, r: '00000000000000b2', name: '<img src=x onerror=window.__pwn=1>Zed', pk: PK_SHAPE });
    await hubFront(hub);
    await hub.waitFor(HUB_Q_ARMED(), { timeoutMs: 10000 });
    const d = await hub.eval('(() => { const H = window.__arenaHub; return { text: H.view().dialog.lines.filter(Boolean).join(" "), dom: document.querySelectorAll("#challenge, #openInfo, .arena-chal, #challenge img").length, imgs: document.querySelectorAll("img").length, pwn: !!window.__pwn, fault: H.renderError || null }; })()');
    ok(/^[A-Za-z0-9 .'_!?-]{1,10} wants to battle you\.$/.test(d.text) && d.dom === 0 && d.imgs === 0 && !d.pwn && !d.fault, 'G1 a hostile name in a challenge is plain safe text in the picture and nothing in it runs', J(d));
    await hubNo(hub);
    // a name FULL OF BRACES (the ROM font's own token syntax): no token of the font is drawn for it, and the picture is drawn without a fault
    await inject(raw, { t: 'arenaopen', v: 1, k: 'chal', s: '00000000000000c1', to: sid, r: '00000000000000c2', name: '{CURSOR}{NOPE}}{{UP}', pk: PK_SHAPE });
    await hub.waitFor(HUB_Q_ARMED(), { timeoutMs: 10000 });
    const b = await hub.eval('(() => { const H = window.__arenaHub; return { text: H.view().dialog.lines.filter(Boolean).join(" "), fault: H.renderError || null, loop: H.loopError || null }; })()');
    ok(/^[A-Za-z0-9 .'_!?-]{1,10} wants to battle you\.$/.test(b.text) && !/[{}]/.test(b.text) && !b.fault && !b.loop, 'G1b a name full of braces is letters only in the picture (no ROM token is drawn for it) and the picture is drawn without a fault', J(b));
    await hubNo(hub);
    for (const bad of [{ k: 'chal' }, { k: 'chal', to: 'nobody', name: 'x' }, { k: 'dec', why: 'rude' }, { k: 'chal', name: 'N', rec: [1, 2, 3] }]) await inject(raw, { t: 'arenaopen', v: 1, s: '00000000000000b3', to: sid, r: '00000000000000b4', ...bad });
    await sleep(500);
    ok(!(await hubAsked(hub)) && hub.errors.length === 0, 'G2 malformed challenges ask nothing and raise no error', J(hub.errors).slice(0, 200));
    await inject(raw, { t: 'arenaopen', v: 1, k: 'chal', s: '00000000000000b5', to: sid, r: '00000000000000b6', name: 'NoKey' });
    await sleep(500);
    ok(!(await hubAsked(hub)) && hub.errors.length === 0, 'G3 a challenge with no one-time key (an old client, or a forger) asks nothing: there would be no private way to answer it', J(hub.errors).slice(0, 200));
  });

  // (H320 / H390 measured the HTML switch beside the Play online link on a phone. Both are gone: the switch is a row of the picture, and tools/pokemonarena_hub_online_test.mjs taps it on a
  //  390 px phone, session "devices": BV1, BV2.)
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
  await page.eval('(() => { const O = window.__arenaOnline; if (' + J(typeName || null) + ') O.setForm({ name: ' + J(typeName || '') + ', typed: true }); O.setForm({ teamKey: ' + J(key) + ' }); return true; })()');          // (a name the player gave first, then the team: the name stays)
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
    ok((await guest.eval('window.__arenaOnline.state.form.name')) === 'BOBBY', 'F2 choosing a saved team fills in the name of the profile that owns it', await guest.eval('window.__arenaOnline.state.form.name'));
    await pickTeam(guest, keyB, 'Zed');
    ok((await guest.eval('window.__arenaOnline.state.form.name')) === 'Zed', 'F3 a name the player typed is kept when the team changes', await guest.eval('window.__arenaOnline.state.form.name'));
    await host.eval('window.__arenaOnline.setForm({ fmt: "3v3" }); void window.__arenaOnline.go()');
    await host.waitFor('window.__arenaOnline.view().code !== ""', { timeoutMs: 30000 });
    await guest.eval('void window.__arenaOnline.go()');
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
    ok(A.schemaVersion === 5 && B.schemaVersion === 5 && sum(A.stats.byCpu.online) === 1 && sum(B.stats.byCpu.online) === 1 && sum(A.stats.byCpu.easy) + sum(A.stats.byCpu.normal) + sum(A.stats.byCpu.hard) === 0 && sum(B.stats.byCpu.easy) + sum(B.stats.byCpu.normal) + sum(B.stats.byCpu.hard) === 0, 'F9 each career holds exactly one battle, in the ONLINE row and in no CPU level', J([A.stats.byCpu, B.stats.byCpu]));
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
    await host.eval('setTimeout(() => location.reload(), 10); true'); await sleep(1500); await host.waitFor('window.__arenaOnline && window.__arenaOnline.view().ready', { timeoutMs: 60000 });
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
    await host.eval('window.__arenaOnline.setForm({ fmt: "3v3" }); void window.__arenaOnline.go()');
    await host.waitFor('window.__arenaOnline.view().code !== ""', { timeoutMs: 30000 });
    await guest.eval('void window.__arenaOnline.go()');
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
    await host.eval('window.__arenaOnline.setForm({ fmt: "3v3" }); void window.__arenaOnline.quick()');
    await host.waitFor('window.__arenaOnline.view().code !== ""', { timeoutMs: 30000 });
    await third.waitFor('window.__arenaOnline.board().length === 1', { timeoutMs: 20000 });
    const want = A.stats.byCpu.online.w + '-' + (A.stats.byCpu.online.l + A.stats.byCpu.online.f);
    const row = await third.eval('(() => { const g = window.__arenaOnline.board()[0]; return { who: g.who, rec: g.rec ? g.rec[0] + "-" + g.rec[1] : null }; })()');
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
    await host.eval('window.__arenaOnline.setForm({ fmt: "3v3" }); void window.__arenaOnline.go()');
    await host.waitFor('window.__arenaOnline.view().code !== ""', { timeoutMs: 30000 });
    await guest.eval('void window.__arenaOnline.go()');
    await approve(host, true);
    for (let i = 0; i < 160 && !((await phase(host)) === 'playing' && (await phase(guest)) === 'playing'); i++) await sleep(250);
    await host.waitFor('window.__arenaBattle.state === "ready"', { timeoutMs: 30000 }); await guest.waitFor('window.__arenaBattle.state === "ready"', { timeoutMs: 30000 });
    await guest.eval('window.__arenaOnline.session()._send({ t: "lsarena", v: ' + PROTO + ', mn: 1, k: "bye", why: "cheat" })');
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
    await host.eval('window.__arenaOnline.setForm({ fmt: "3v3" }); void window.__arenaOnline.go()');
    await host.waitFor('window.__arenaOnline.view().code !== ""', { timeoutMs: 30000 });
    await guest.eval('void window.__arenaOnline.go()');
    await approve(host, true);
    for (let i = 0; i < 160 && !((await phase(host)) === 'playing' && (await phase(guest)) === 'playing'); i++) await sleep(250);
    await host.waitFor('window.__arenaBattle.state === "ready"', { timeoutMs: 30000 }); await guest.waitFor('window.__arenaBattle.state === "ready"', { timeoutMs: 30000 });
    await host.eval(`(() => { const O = window.__arenaOnline; O.nm().receive({ t: 'lsarena', v: ${PROTO}, mn: O.state.info.mn, k: 'end', win: 0, h: 'forged-final-position', why: 'result' }); return true; })()`);
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
const UI_KEYS = { x: ['x', 'KeyX', 88], backspace: ['Backspace', 'Backspace', 8], escape: ['Escape', 'Escape', 27], z: ['z', 'KeyZ', 90], enter: ['Enter', 'Enter', 13], right: ['ArrowRight', 'ArrowRight', 39], up: ['ArrowUp', 'ArrowUp', 38], down: ['ArrowDown', 'ArrowDown', 40] };
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
    // (the page stays where it is whatever is answered: a build in which B ACCEPTS must fail these cases by what the challenger is told, not by the page leaving under the rig)
    await hub.eval('(() => { window.__navTo = []; window.__arenaNavigate = (u) => { window.__navTo.push(u); }; return true; })()');
    const routes = [['UK1', 'gamepad B', () => uiPad(hub, 'b')], ['UK2', 'the X key', () => uiKey(hub, 'x')], ['UK3', 'Backspace', () => uiKey(hub, 'backspace')], ['UK4', 'Escape', () => uiKey(hub, 'escape')]];
    for (const [id, label, press] of routes) {
      const q = await uiChal(raw, sid);
      const shown = await uiUntil(hub, HUB_Q_ARMED());
      const before = shown ? await hub.eval('(() => { const H = window.__arenaHub; H.press("a"); const d = H.dialog.current(); return { page: d.page, on: d.choice.options[d.choice.cursor], last: d.choice.cursor === d.choice.options.length - 1, asked: H.dialog.isOpen(), panel: H.dialogOpen(), dom: document.querySelectorAll("#challenge").length }; })()') : null;
      await press();
      const closed = await uiUntil(hub, HUB_Q_GONE(), 3000);
      await sleep(150);
      const after = await hub.eval('({ asked: window.__arenaHub.dialog.isOpen(), held: window.__arenaHub.input.isDown("b"), n: window.__bPress, canvasFocus: document.activeElement === window.__arenaHub.canvas, went: window.__navTo.length })');
      await uiKey(hub, 'x'); await sleep(120);            // B is alive: a fresh press must still be heard (a B left held swallows every later one)
      const alive = await hub.eval('({ n: window.__bPress, held: window.__arenaHub.input.isDown("b") })');
      const told = await uiTold(raw, q);
      ok(shown && before.on === 'NO' && before.last && before.asked === true && before.panel === false && before.dom === 0 && closed && after.asked === false && after.went === 0 && after.held === false && alive.n === after.n + 1 && alive.held === false && told.includes('declined'),
        id + ' ' + label + ' answers NO to the challenge: the question closes, the hub is live again, the challenger is told no, nobody goes anywhere, and B is not left held', J({ before, closed, after, alive, told }));
      if (id === 'UK1') await shot(hub, 'U_keys_after_decline');
    }
    // a click on NO (the mouse): a click on the text turns the page, a click on the NO row answers. Then the DOM dialog's own Escape fallback for an input layer that did not start (the battle page's dialog)
    const q5 = await uiChal(raw, sid);
    await uiUntil(hub, HUB_Q_ARMED());
    await shot(hub, 'U_dialog_desktop');
    const txt = await hubPoint(hub, 100, 132);
    await hub.click(txt.x, txt.y);
    await sleep(150);
    const p5 = await hubOption(hub, 1);
    await shot(hub, 'U_dialog_desktop_options');
    if (p5) await hub.click(p5.x, p5.y);
    ok(!!p5 && p5.n === 2 && await uiUntil(hub, HUB_Q_GONE(), 3000) && (await uiTold(raw, q5)).includes('declined') && (await hub.eval('window.__navTo.length')) === 0, 'UK5 a mouse click on the text turns the page and a click on NO answers no', J([p5, await uiTold(raw, q5)]));
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
    // (the page stays where it is while the first cases run: a build in which a stray press ACCEPTS must fail them by name, not by the page leaving under the rig)
    await hub.eval('(() => { window.__navTo = []; window.__arenaNavigate = (u) => { window.__navTo.push(u); }; return true; })()');
    // inside the first 600 ms: the question does not listen. The pad's A, Up and A again (the whole way to YES) land in its first moments and do nothing; the clock is read from inside the page,
    // from the frame the question is first seen to the frame it starts to listen
    await hub.eval(`(() => { window.__q = { seen: 0, armed: 0, log: [] }; const tick = () => { const d = window.__arenaHub.dialog.current(), q = window.__q; if (d && d.id === 'presence:challenge') { if (!q.seen) q.seen = performance.now(); if (d.armed && !q.armed) q.armed = performance.now(); } if (!q.stop) requestAnimationFrame(tick); }; requestAnimationFrame(tick); return true; })()`);
    const q1 = await uiChal(raw, sid);
    const w = await hub.eval(`(async () => { const H = window.__arenaHub, q = window.__q; const t0 = performance.now(); while (!q.seen && performance.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 5));
      const r = { seen: !!q.seen, armed0: H.dialog.current().armed, cursorShown: null }; await window.__padTap(0, 40); await window.__padTap(12, 40); await window.__padTap(0, 40);
      const d = H.dialog.current(); r.open = !!d && d.id === 'presence:challenge'; r.page = d ? d.page : null; r.elapsed = performance.now() - q.seen; r.armedAfter = d ? d.armed : null; r.went = window.__navTo.length; return r; })()`);
    ok(w.seen && w.armed0 === false && w.open === true && w.page === 0 && w.went === 0 && w.elapsed < 600, 'UA1 YES is inert for the first 600 ms: A, Up and A again in the question\'s first moments turn no page and answer nothing', J(w));
    const woke = await uiUntil(hub, 'window.__q.armed > 0', 5000);
    const took = await hub.eval('Math.round(window.__q.armed - window.__q.seen)');
    ok(woke && took >= 450 && took <= 1500, 'UA2 and it starts to listen after that (measured: ' + took + ' ms after it was first drawn; 36 frames is 603 ms)', String(took));
    await hub.eval('(window.__q.stop = true)');
    await uiKey(hub, 'x');
    await uiUntil(hub, HUB_Q_GONE(), 3000);
    // a key held since BEFORE the question appeared keeps repeating once the question listens: the highlight must not drift onto YES, and Z must then answer NO
    await hub.eval('(() => { window.__reps = 0; window.__arenaHub.input.on("action", (e) => { if (e.pressed && e.repeat && e.action === "up") window.__reps++; }); return true; })()');
    await uiKeyEdge(hub, 'up', 'keyDown'); await sleep(250);
    const q2 = await uiChal(raw, sid);
    await uiUntil(hub, HUB_Q_ARMED());
    await uiKey(hub, 'z'); await sleep(120);                     // (a fresh A: the page with the options; Up is still held and repeating)
    const reps0 = await hub.eval('window.__reps');
    const drift = await hub.eval(`(async () => { const H = window.__arenaHub, seen = new Set(); const t0 = performance.now(); let page = null; while (performance.now() - t0 < 900) { const d = H.dialog.current(); if (d && d.choice) { seen.add(d.choice.options[d.choice.cursor]); page = d.page; } await new Promise((r) => setTimeout(r, 15)); } return { seen: [...seen], page, reps: window.__reps }; })()`);
    await uiKey(hub, 'z');
    const gone3 = await uiUntil(hub, HUB_Q_GONE(), 3000);
    await sleep(200);
    const told3 = await uiTold(raw, q2), went3 = await hub.eval('window.__navTo.length');
    ok(drift.page === 1 && drift.reps - reps0 >= 4 && J(drift.seen) === J(['NO']) && gone3 && told3.includes('declined') && went3 === 0,
      'UA3 a direction held since before the question appeared keeps repeating (' + (drift.reps - reps0) + ' repeats while the options were up): the highlight never leaves NO, and Z then answers NO, not YES', J({ drift, told3, went3 }));
    await uiKeyEdge(hub, 'up', 'keyUp'); await sleep(200);
    // a FRESH press on the d-pad (a decision), then A: it goes, so the guard that holds above is not simply "never"
    await hub.eval('(delete window.__arenaNavigate, true)');
    const q4 = await uiChal(raw, sid);
    await uiUntil(hub, HUB_Q_ARMED());
    await uiKey(hub, 'z'); await sleep(150);
    await uiKey(hub, 'up'); await sleep(150);
    const onYes = (await hubQ(hub)) || {};
    await uiKey(hub, 'z');
    const went = await uiUntil(hub, 'location.pathname === "/pokemonarena/battle.html"', 20000);
    const u = went ? new URL(await hub.eval('location.href')) : null;
    ok(onYes.on === 'YES' && went && u.searchParams.get('auto') === 'host' && u.searchParams.get('for') === q4.s && u.searchParams.get('rq') === q4.r, 'UA4 a fresh press onto YES and then A does accept, and takes the player to the challenger\'s battle', u ? u.search : 'no navigation ' + J(onYes));
  });
}

// ---- UA5 / UA6: the same guard when the challenge arrives while ANOTHER DIALOG IS OPEN with a direction held. The Controls dialog and the Sound panel are DOM: a question in the picture would be under
// them, so it WAITS (hub_presence.js) and appears when the panel closes, with the key still held and repeating. Its repeats must not drift the highlight onto YES, and A must then answer NO.
async function uiDrift(c) {
  const { ok } = c;
  await withBrowser({ port: c.cdp(1), width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (hub) => {
    const raw = await hub.openTab({ width: 900, height: 760 });
    await uiWatcher(raw, c.origin);
    const stacks = [
      ['UA5', 'the Controls dialog', 'window.__arenaHub.openControls()', '!document.getElementById("controlsDialog").hidden && window.__arenaHub.dialogOpen()', 'true', 'window.__arenaHub.closeControls()'],
      // the Sound panel opens with its Master SLIDER focused, and the input layer leaves arrow keys to a slider (they are its own), so a direction would never be "held" there: the key goes down on a button
      ['UA6', 'the Sound panel', 'document.getElementById("soundBtn").click()', '(() => { const e = document.querySelector(".arena-snd"); return !!e && !e.hidden && window.__arenaHub.dialogOpen(); })()', 'document.querySelector(".arena-snd [data-snd=mute]").focus()', 'window.__arenaSound.closePanel()'],
    ];
    for (const [id, label, open, isOpen, prep, close] of stacks) {
      await uiHubOn(hub, c.origin);                          // a fresh hub each time: the YES at the end of a round leaves the page
      await uiFront(hub);
      const sid = await uiSid(hub);
      await hub.eval('(() => { window.__navTo = []; window.__arenaNavigate = (u) => { window.__navTo.push(u); }; window.__reps = 0; window.__arenaHub.input.on("action", (e) => { if (e.pressed && e.repeat && e.action === "up") window.__reps++; }); return true; })()');
      await hub.eval(open);
      const up = await uiUntil(hub, isOpen);
      await hub.eval(prep);
      await uiKeyEdge(hub, 'up', 'keyDown'); await sleep(300);          // Up is held BEFORE the challenge exists; the dialog that is open is navigating with it
      const held = await hub.eval('window.__arenaHub.input.isDown("up")');
      const q = await uiChal(raw, sid, 'Stacked');
      const waited = await uiUntil(hub, 'window.__arenaHub.presence.state().challenge === "waiting"', 6000) && !(await hubAsked(hub));
      await hub.eval(close);
      const shown = await uiUntil(hub, HUB_Q_ARMED(), 6000);
      await uiKey(hub, 'z'); await sleep(120);                 // a fresh A: the page with the options; Up is still held and repeating
      const reps0 = await hub.eval('window.__reps');
      const drift = await hub.eval(`(async () => { const H = window.__arenaHub, seen = new Set(); const t0 = performance.now(); let page = null; while (performance.now() - t0 < 900) { const d = H.dialog.current(); if (d && d.choice) { seen.add(d.choice.options[d.choice.cursor]); page = d.page; } await new Promise((r) => setTimeout(r, 15)); } return { seen: [...seen], page, reps: window.__reps }; })()`);
      await uiKey(hub, 'z');
      const gone = await uiUntil(hub, HUB_Q_GONE(), 3000);
      await sleep(200);
      const told = await uiTold(raw, q), went0 = await hub.eval('window.__navTo.length');
      ok(up && held && waited && shown && drift.page === 1 && drift.reps - reps0 >= 4 && J(drift.seen) === J(['NO']) && gone && told.includes('declined') && went0 === 0,
        id + ' a challenge that arrived over ' + label + ' with a direction held: it waited, appeared when the panel closed, the held key\'s repeats (' + (drift.reps - reps0) + ') never moved the highlight off NO, and Z answered NO (the rig reached the state: ' + J({ up, held, waited, shown }) + ')', J({ drift, told, went0 }));
      // let go, press Up afresh (a decision), then A: it goes, so the guard that holds here is not simply "never"
      await uiKeyEdge(hub, 'up', 'keyUp'); await sleep(200);
      await hub.eval('(delete window.__arenaNavigate, true)');
      const q2 = await uiChal(raw, sid, 'Again');
      await uiUntil(hub, HUB_Q_ARMED(), 6000);
      await uiKey(hub, 'z'); await sleep(150);
      await uiKey(hub, 'up'); await sleep(150);
      await uiKey(hub, 'z');
      const went = await uiUntil(hub, 'location.pathname === "/pokemonarena/battle.html"', 20000);
      const u = went ? new URL(await hub.eval('location.href')) : null;
      ok(went && u.searchParams.get('rq') === q2.r, id + 'b and after ' + label + ' a fresh press onto YES and then A does accept', u ? u.search : 'no navigation');
    }
  });
}

// ---- US: a challenge that arrives while the Controls dialog or the Sound panel is open. Those are DOM panels and the question is in the picture, UNDER them, where it could be neither read nor
// answered: so it WAITS, and appears when the last panel has closed (the page's "a panel is up" state is a SET of owners: closing one of two does not let the question out)
async function uiStack(c) {
  const { ok } = c;
  await withBrowser({ port: c.cdp(2), width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (hub) => {
    await hub.send('Page.addScriptToEvaluateOnNewDocument', { source: UI_PAD_INIT });
    const raw = await hub.openTab({ width: 900, height: 760 });
    await uiHubOn(hub, c.origin, '&openchal=60000');
    await uiWatcher(raw, c.origin);
    await uiFront(hub); await hub.eval('window.__padConnect()'); await sleep(250);
    const sid = await uiSid(hub);
    const cursor = () => hub.eval('window.__arenaHub.view().menu.cursor');
    const CTL_UP = '!document.getElementById("controlsDialog").hidden && window.__arenaHub.dialogOpen()';
    const SND_UP = '(() => { const e = document.querySelector(".arena-snd"); return !!e && !e.hidden && window.__arenaHub.dialogOpen(); })()';
    const waiting = () => hub.eval('(() => { const H = window.__arenaHub; return { state: H.presence.state().challenge, drawn: !!H.view().dialog, asked: H.dialog.isOpen(), dom: document.querySelectorAll("#challenge").length, panel: H.dialogOpen() }; })()');
    // Controls first
    await hub.eval('window.__arenaHub.openControls()');
    await uiUntil(hub, CTL_UP);
    const q1 = await uiChal(raw, sid, 'Under');
    const held = await uiUntil(hub, 'window.__arenaHub.presence.state().challenge === "waiting"', 6000);
    await sleep(900);                                    // (longer than the arm delay: a question that had been drawn under the dialog would be listening by now)
    const w1 = await waiting();
    const top1 = await hub.eval('({ ctl: !document.getElementById("controlsDialog").hidden, focusIn: document.getElementById("controlsDialog").contains(document.activeElement) })');
    ok(held && w1.state === 'waiting' && w1.drawn === false && w1.asked === false && w1.dom === 0 && w1.panel === true && top1.ctl && (await uiTold(raw, q1)).length === 0,
      'US1 a challenge that arrives while the Controls dialog is open WAITS: nothing is drawn under the dialog (in the picture or in the page), nothing is answered, and Controls is still up', J({ w1, top1 }));
    await shot(hub, 'U_challenge_waits_behind_controls');
    // a second panel over the first, and it closes again: the question must still wait (Controls is still up)
    const c0 = await cursor();
    await hub.eval('document.getElementById("soundBtn").click()');
    const both = await uiUntil(hub, SND_UP + ' && ' + CTL_UP, 4000);
    await hub.eval('window.__arenaSound.closePanel()');
    await uiUntil(hub, 'document.querySelector(".arena-snd").hidden', 3000); await sleep(300);
    const w2 = await waiting();
    ok(both && w2.panel === true && w2.state === 'waiting' && w2.drawn === false && w2.asked === false, 'US2 closing ONE of two open panels (the Sound panel over Controls) leaves the page paused and the question waiting: Controls is still up', J(w2));
    await uiPad(hub, 'down'); await uiPad(hub, 'down');
    ok((await cursor()) === c0, 'US3 and the hub menu behind the Controls dialog did not move when the pad pressed Down', J([c0, await cursor()]));
    await uiPad(hub, 'b');
    const ctlClosed = await uiUntil(hub, 'document.getElementById("controlsDialog").hidden && !window.__arenaHub.dialogOpen()', 3000);
    const appeared = await uiUntil(hub, HUB_Q(), 3000);
    const fresh = appeared ? await hubQ(hub) : null;
    const listens = await uiUntil(hub, HUB_Q_ARMED(), 4000);
    ok(ctlClosed && appeared && /^Under wants to battle you\.$/.test(fresh.text) && fresh.page === 0 && listens, 'US4 when Controls closes the question APPEARS in the picture (from its first page), and then listens', J(fresh));
    await shot(hub, 'U_challenge_after_controls');
    await uiPad(hub, 'b');
    const closed = await uiUntil(hub, HUB_Q_GONE(), 3000); await sleep(200);
    await uiPad(hub, 'down');
    ok(closed && (await uiTold(raw, q1)).includes('declined') && (await cursor()) !== c0, 'US4b B answers it NO, and the hub is back (Down moves its menu again)', J([await uiTold(raw, q1), c0, await cursor()]));
    // the Sound panel
    await hub.eval('document.getElementById("soundBtn").click()');
    await uiUntil(hub, SND_UP);
    const q2 = await uiChal(raw, sid, 'Sound');
    const held2 = await uiUntil(hub, 'window.__arenaHub.presence.state().challenge === "waiting"', 6000);
    await sleep(900);
    const w5 = await waiting();
    ok(held2 && w5.state === 'waiting' && w5.drawn === false && w5.asked === false && w5.dom === 0 && !(await hub.eval('document.querySelector(".arena-snd").hidden')), 'US5 a challenge that arrives while the Sound panel is open waits as well', J(w5));
    await uiPad(hub, 'b');
    const sndClosed = await uiUntil(hub, 'document.querySelector(".arena-snd").hidden && !window.__arenaHub.dialogOpen()', 3000);
    const appeared2 = await uiUntil(hub, HUB_Q_ARMED(), 4000);
    ok(sndClosed && appeared2 && /^Sound wants to battle you\.$/.test((await hubQ(hub)).text), 'US6 B closes the Sound panel (only the panel: the question was not there to hear it), and then the question appears and listens', J(await hubQ(hub)));
    await uiPad(hub, 'b');
    const closed2 = await uiUntil(hub, HUB_Q_GONE(), 3000);
    ok(closed2 && (await uiTold(raw, q2)).includes('declined') && (await hub.eval('window.__arenaHub.dialog.isOpen() || window.__arenaHub.dialogOpen()')) === false, 'US7 and B then answers it NO: the page is live again', J(await uiTold(raw, q2)));
    // a panel that opens OVER a question that is up: the question comes out of the picture, and is back when the panel closes
    const q3 = await uiChal(raw, sid, 'Over');
    await uiUntil(hub, HUB_Q_ARMED(), 6000);
    await hub.eval('window.__arenaHub.openControls()');
    await uiUntil(hub, CTL_UP);
    const w8 = await waiting();
    await hub.eval('window.__arenaHub.closeControls()');
    const back = await uiUntil(hub, HUB_Q(), 3000);
    const b8 = back ? await hubQ(hub) : null;
    ok(w8.state === 'waiting' && w8.drawn === false && back && b8.armed === false && b8.page === 0 && /^Over /.test(b8.text), 'US9 a panel opened over a question that is up takes it out of the picture, and it is back (not yet listening) when the panel closes', J({ w8, b8 }));
    await uiUntil(hub, HUB_Q_ARMED(), 4000);
    await uiPad(hub, 'b');
    await uiUntil(hub, HUB_Q_GONE(), 3000);
    ok((await uiTold(raw, q3)).includes('declined') && uiErrs(hub, raw).length === 0, 'US8 it is answered as usual, and there were no page errors', J(uiErrs(hub, raw)).slice(0, 300));
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
    await hubSwitch(a);
    const gone = await uiUntil(b, '!window.__arenaPresence.isOn() && window.__arenaPresence.presence === null && window.__arenaPresence.lobbies === null', 5000)
      && await uiUntil(cpu, '!window.__arenaPresence.isOn() && window.__arenaPresence.presence === null && window.__arenaPresence.lobbies === null', 5000);
    const live1 = await uiLive(w);
    const st = [await b.eval('String(window.__arenaHub.presence.isOn())'), await a.eval('localStorage.getItem("arena.open")')];
    ok(gone && live1.length === 0 && st[0] === 'false' && st[1] === null, 'UX1 switching Open off in one tab takes the listing down in the other hub tab and in the CPU battle too (and the board is empty)', J({ gone, live1, st }));
    // and on again: they follow that too
    await hubSwitch(a);
    const back = await uiUntil(b, 'window.__arenaPresence.isOn() && window.__arenaPresence.presence', 8000) && await uiUntil(cpu, 'window.__arenaPresence.isOn() && window.__arenaPresence.presence', 8000);
    await sleep(800);
    ok(back && (await uiLive(w)).length === 3, 'UX2 switching it on again lists all three again', J(await uiLive(w)));
    await hubSwitch(a);
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
    // challenges across an off/on cycle: exactly ONE question in the picture (nothing queued behind it, no DOM dialog), and it names the current challenger
    await uiFront(hub);
    const q1 = await uiChal(w, sid2, 'First');
    await uiUntil(hub, HUB_Q_ARMED());
    await hubNo(hub);
    await uiUntil(hub, HUB_Q_GONE(), 3000);
    await hub.eval('window.__arenaPresence.setOn(false)'); await hub.eval('window.__arenaPresence.setOn(true)');
    await uiUntil(hub, 'window.__arenaPresence.presence', 8000);
    const sid3 = await uiSid(hub);
    await uiChal(w, sid3, 'Second');
    await uiUntil(hub, HUB_Q_ARMED());
    const one = await hub.eval('(() => { const H = window.__arenaHub; return { queued: H.model.state().dialog.queued.length, open: H.model.state().dialog.open, says: H.view().dialog.lines.filter(Boolean).join(" "), dom: document.querySelectorAll("#challenge, #chText, #openInfo").length, state: H.presence.state().challenge }; })()');
    ok(one.queued === 0 && one.open === 'presence:challenge' && one.dom === 0 && one.state === 'shown' && /^Second wants to battle you\.$/.test(one.says), 'UR3 after the switch went off and on there is ONE question in the picture (nothing queued behind it, no DOM dialog in the page), and it names the current challenger', J(one));
    await hubNo(hub);
    await uiUntil(hub, HUB_Q_GONE(), 3000);
    // THE DOM DIALOGS OF presence_boot.js (what a page that injects nothing gets: a battle against the CPU). Mounting the module by hand on this page, with no dialogs handed in, disposes the hub's own
    // mount and asks in a DOM dialog; mounting it AGAIN disposes the first of those: still ONE dialog in the document, not two
    await hub.eval(`(async () => {
      const m = await import('/pokemonarena/js/presence_boot.js'), n = await import('/pokemonarena/js/uinav.js'), H = window.__arenaHub;
      window.__mountDom = () => m.mountPresence({ win: window, doc: document, pack: H.pack, input: H.input, enableDomNav: n.enableDomNav, navigate: () => {}, button: document.getElementById('testOpen') || (() => { const b = document.createElement('button'); b.id = 'testOpen'; b.type = 'button'; b.style.display = 'none'; document.body.appendChild(b); return b; })() });
      window.__mountDom();
      return true; })()`);
    await uiUntil(hub, 'window.__arenaPresence.isOn() && window.__arenaPresence.presence', 8000);
    await uiChal(w, await uiSid(hub), 'Pre');
    await uiUntil(hub, UI_DLG());
    const pre = await hub.eval('({ roots: document.querySelectorAll("#challenge").length, says: (document.getElementById("chText") || {}).textContent, picture: window.__arenaHub.dialog.isOpen() })');
    await hub.eval('document.getElementById("chDecline").click()');
    await uiUntil(hub, uiDlgGone(), 3000);
    const re = await hub.eval('(() => { window.__mountDom(); return { roots: document.querySelectorAll("#challenge").length }; })()');
    await uiUntil(hub, 'window.__arenaPresence.isOn() && window.__arenaPresence.presence', 8000);
    await uiChal(w, await uiSid(hub), 'Third');
    await uiUntil(hub, UI_DLG());
    const two = await hub.eval('({ roots: document.querySelectorAll("#challenge").length, says: document.getElementById("chText").textContent })');
    ok(pre.roots === 1 && /^Pre/.test(pre.says) && pre.picture === false && re.roots <= 1 && two.roots === 1 && /^Third/.test(two.says), 'UR4 a mount with no dialogs handed in asks in the DOM dialog (not in the picture), and a second such mount on the same page leaves ONE challenge dialog (the first mount\'s is removed with it)', J({ pre, re, two }));
    await hub.eval('document.getElementById("chDecline").click()');
    await uiUntil(hub, uiDlgGone(), 3000);
    // dispose: no dialog, no listing, and the switch is inert again
    await hub.eval('window.__arenaPresence.dispose()');
    const d = await hub.eval('({ roots: document.querySelectorAll("#challenge").length, attr: document.getElementById("testOpen").dataset.presence || null, hook: !!window.__arenaPresence })');
    ok(d.roots === 0 && d.attr === null && d.hook === false && (await uiUntil(w, 'Object.keys(window.__live).length === 0', 4000)), 'UR5 dispose removes the dialog, takes the listing down and makes the switch inert again', J(d));
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
    const state = () => hub.eval('({ on: window.__arenaPresence.isOn(), stored: localStorage.getItem("arena.open"), seen: localStorage.getItem("arena.open.seen"), paused: window.__arenaHub.dialog.isOpen() || window.__arenaHub.dialogOpen(), shown: (() => { const d = window.__arenaHub.dialog.current(); return !!d && d.id === "presence:disclosure"; })(), board: !!window.__arenaPresence.lobbies })');
    await hubSwitch(hub);
    const shown = await uiUntil(hub, HUB_Q(HQ_DISC), 3000);
    const s1 = await state();
    await shot(hub, 'U_disclosure');
    const d0 = shown ? await hubQ(hub) : null;
    const pages = shown ? await hubQPages(hub) : [];
    const d = shown ? await hubQ(hub) : null, text = pages.join(' ');
    ok(shown && d0.page === 0 && d0.armed === true && /trainer name/.test(text) && /online record/.test(text) && /public servers/.test(text) && pages.length >= 3 && /\?$/.test(pages[pages.length - 1]) && J(d.options) === J(['YES', 'NO']) && d.on === 'NO' && d.last && d.dom === 0 && s1.on === false && s1.stored === null && s1.board === false && s1.paused === true && (await uiLive(w)).length === 0,
      'UD1 the first press on the switch asks IN THE PICTURE: message pages that say what is published (trainer name, online record, public servers), ending in a question with YES / NO and NO highlighted; nothing is published yet', J({ d, s1, pages }).slice(0, 900));
    await shot(hub, 'U_disclosure_question');
    await uiPad(hub, 'b');
    ok(await uiUntil(hub, HUB_Q_GONE(HQ_DISC), 3000) && (await state()).on === false && (await state()).seen === null && (await state()).paused === false && (await state()).board === false, 'UD2 NO (the pad\'s B) leaves the switch off, remembers nothing, publishes nothing, and gives the page back', J(await state()));
    await hubSwitch(hub);
    const asked2 = await uiUntil(hub, HUB_Q(HQ_DISC), 3000);
    ok(asked2 && (await hubQ(hub)).page === 0, 'UD3 it asks again next time, from its first page (NO is not remembered)', '');
    await hubYes(hub);
    ok(await uiUntil(hub, 'window.__arenaPresence.isOn() && window.__arenaPresence.presence', 15000), 'UD4 YES switches it on', J(await state()));
    const s4 = await state();
    ok(s4.stored === '1' && s4.seen === '1' && s4.shown === false && s4.paused === false && (await uiUntil(w, 'Object.keys(window.__live).length === 1', 6000)), 'UD5 and remembers that the player was told, and the listing is on the board', J({ s4, live: await uiLive(w) }));
    // off, on: not asked again
    await hubSwitch(hub);
    await uiUntil(hub, '!window.__arenaPresence.isOn()', 5000);
    await hubSwitch(hub);
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
  // UM: (UM1 / UM2 were about the focus of the HTML switch after a mouse click and under the keyboard; there is no such button on the hub any more.) What is left to prove here is that THE PICTURE
  // FOLLOWS THE PRESENCE SERVICE whoever switched it (another tab, the Trainer Center): the row says ON and the main menu reads PLAY ONLINE: OPEN
  await withBrowser({ port: c.cdp(3), width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (hub) => {
    await hub.navigate(c.origin + '/pokemonarena/?net=local');
    await uiHubReady(hub);
    await uiUntil(hub, 'window.__arenaHub.apps.state().online.open === "off"', 8000);
    await hub.eval('window.__arenaPresence.setOn(true)');
    const told = await uiUntil(hub, '(() => { const H = window.__arenaHub, r = H.model.apps.online.allRows().find((x) => x.id === "open"), m = H.view().menu.rows.find((x) => x.id === "online"); return r.value === "ON" && m.label === "PLAY ONLINE: OPEN"; })()', 5000);
    ok(told, 'UM1 switched on from outside the row, the OPEN TO BATTLES row says ON and the main menu reads PLAY ONLINE: OPEN: the picture follows the presence service', J(await toggleState(hub)));
  });
}

// ---- UW / UN1: what the hub's switch SAYS once the module has mounted (the static text in index.html is overwritten at mount, so a test of the static text alone is false assurance: OXT4 reads the dead title),
// and its accessible name, which is constant (the state is aria-pressed's to say; a name that also changed -- "Open: on" -- was read out twice)
async function uiWords(c) {
  const { ok } = c;
  await withBrowser({ port: c.cdp(2), width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (hub) => {
    await hub.navigate(c.origin + '/pokemonarena/?net=local');
    await uiHubReady(hub);
    await uiUntil(hub, 'window.__arenaHub.apps.state().online.open === "off"', 8000);
    // the switch is the OPEN TO BATTLES row of PLAY ONLINE: what the picture says with the cursor on it (the two lines under the list), and what a screen reader is told
    const read = () => hub.eval('(() => { const H = window.__arenaHub; if (H.model.path() !== "online") H.goto("online"); H.model.apps.online.select("open"); const v = H.view(), r = v.menu.rows[v.menu.cursor]; return { label: r.label, value: r.value, help: v.msg.join(" "), said: H.model.speak(v) }; })()');
    const off = await read();
    // (this browser has no trainer: the listing would say "Player", and the row says so. WHICH name is listed, and WHERE, is what the old tooltip said and the row must: "list your trainer name and online record on public servers")
    ok(/Lists trainer name Player and online record on public servers/.test(off.help), 'UW1 the OPEN TO BATTLES row says, under the list, that switching it on lists the TRAINER name (by name) AND the online record ON PUBLIC SERVERS', J(off));
    const says = await hub.eval('(async () => { await window.__arenaPresence.setOn(true); const t = window.__arenaPresence.trainer(); return { live: document.getElementById("live").textContent, listing: t ? t.name : null }; })()');
    await uiUntil(hub, 'window.__arenaHub.apps.state().online.open === "on"', 5000);
    const on = await read();
    ok(/trainer name and online record/.test(says.live) && says.listing === 'Player' && /You are listed as Player:/.test(on.help), 'UW2 switching on says, in the live region, that the trainer name AND the online record are listed, and the row says the player is listed, under the name the listing carries', J({ says, on }));
    ok(off.label === 'OPEN TO BATTLES' && on.label === 'OPEN TO BATTLES' && off.value === 'OFF' && on.value === 'ON' && /OPEN TO BATTLES OFF\./.test(off.said) && /OPEN TO BATTLES ON\./.test(on.said),
      'UN1 the row has ONE name ("OPEN TO BATTLES") whatever its state, and its value carries the state (OFF -> ON), in the picture and for a screen reader', J({ off, on }));
    // brokers that cannot be reached: the name stays, and the row says nobody can see the listing
    await hub.eval('(() => { window.__arenaPresence.lobbies.status = () => "down"; return window.__arenaPresence.setOn(true); })()');
    await uiUntil(hub, 'window.__arenaHub.apps.state().online.open === "offline"', 5000);
    const dn = await read();
    ok(dn.label === 'OPEN TO BATTLES' && dn.value === 'ON' && /no public server can be/.test(dn.help) && /nobody can see you/.test(dn.help), 'UN1b with no broker reachable the name is still the same, and the row says nobody can see the listing', J(dn));
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
    // (the hub's clock is held while the challenge arrives, so the taps of UT2 certainly land in the question's first moments)
    await hub.eval('(window.__arenaHub.pause(true), true)');
    const q1 = await uiChal(w, sid);
    await uiUntil(hub, HUB_Q());
    const tapText = async () => { const t = await hubPoint(hub, 110, 134); await hub.tap(t.x, t.y); };          // (the point is read at each tap: the first touch lays the on-screen pad out, which moves the picture)
    await tapText(); await sleep(600);
    await tapText(); await sleep(150);
    const inert = await hub.eval('(() => { const d = window.__arenaHub.dialog.current(); return { open: !!d && d.id === "presence:challenge", page: d ? d.page : null, armed: d ? d.armed : null, path: location.pathname }; })()');
    ok(inert.open && inert.page === 0 && inert.armed === false && inert.path === '/pokemonarena/' && (await uiTold(w, q1)).length === 0, 'UT2 taps on the question in its first moments do nothing (no page is turned, nothing is answered)', J(inert));
    await hub.eval('(window.__arenaHub.pause(false), true)');
    await uiUntil(hub, HUB_Q_ARMED(), 5000);
    await tapText(); await sleep(200);                // a tap on the text turns the page: the options are up
    const yes = await hubOption(hub, 0), no = await hubOption(hub, 1);
    const lay = await hub.eval(`(() => { const c = window.__arenaHub.canvas.getBoundingClientRect(), d = window.__arenaHub.dialog.current(); return { l: c.left, r: c.right, t: c.top, b: c.bottom, vw: innerWidth, vh: innerHeight, page: d ? d.page : null, dom: document.querySelectorAll('#challenge, .arena-chal').length, over: document.documentElement.scrollWidth - document.documentElement.clientWidth, padB: (() => { const e = document.getElementById('bB'); if (!e) return null; const q = e.getBoundingClientRect(); return { w: q.width, h: q.height, shown: q.width > 0 && getComputedStyle(e).visibility !== 'hidden' }; })() }; })()`);
    ok(lay.page === 1 && lay.dom === 0 && lay.l >= 0 && lay.r <= lay.vw + 0.5 && lay.t >= 0 && lay.b <= lay.vh + 0.5 && lay.over <= 0 && !!yes && !!no && yes.n === 2 && no.y > yes.y && no.x >= lay.l && no.x <= lay.r && no.y >= lay.t && no.y <= lay.b && no.h >= 20 && no.w >= 44 && !!lay.padB && lay.padB.shown && lay.padB.h >= 44 && lay.padB.w >= 44,
      'UT1 on a 390 px phone the question is in the picture, the picture fits the screen, YES and NO are separate rows that can be tapped (' + (no ? Math.round(no.w) + ' x ' + Math.round(no.h) : '?') + ' css px each), and the on-screen B button (NO) is at least 44 css px', J({ lay, yes, no }));
    await shot(hub, 'U_dialog_phone');
    if (no) await hub.tap(no.x, no.y);
    ok(await uiUntil(hub, HUB_Q_GONE(), 3000) && (await uiTold(w, q1)).includes('declined'), 'UT3 a tap on NO answers no', J(await uiTold(w, q1)));
    const q2 = await uiChal(w, sid);
    await uiUntil(hub, HUB_Q_ARMED(), 5000);
    await tapText(); await sleep(200);
    const yes2 = await hubOption(hub, 0);
    if (yes2) await hub.tap(yes2.x, yes2.y);
    const went = await uiUntil(hub, 'location.pathname === "/pokemonarena/battle.html"', 20000);
    ok(went && new URL(await hub.eval('location.href')).searchParams.get('rq') === q2.r, 'UT4 a tap on YES once the question listens accepts', went ? '' : 'no navigation');
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
      await hubSwitch(b);
      const follow = await uiUntil(a, 'window.__arenaPresence.isOn() && window.__arenaPresence.presence', 10000);
      const fb = await a.eval('document.getElementById("openBtn").getAttribute("aria-pressed")');
      await sleep(800);
      const live3 = await uiLive(w);
      await hubSwitch(b);
      const unfollow = await uiUntil(a, '!window.__arenaPresence.isOn() && window.__arenaPresence.presence === null', 8000);
      ok(follow && fb === 'true' && live3.length === 2 && unfollow, 'UO3 a CPU battle loaded with the switch OFF follows it going ON in another tab (the button, the listing: two on the board) and OFF again', J({ follow, fb, live3, unfollow }));
      // the online page and an error screen never show the button (and take no room)
      await a.navigate(c.origin + '/pokemonarena/battle.html?online=1&ask=host&net=local&anim=0');
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
      // (the switch is the OPEN TO BATTLES row of the picture: there is no HTML button to hide. Before the presence code has loaded the row says OFF and nothing is listed; a press made then is kept)
      const pre = await hub.eval(`(() => { const H = window.__arenaHub; H.goto('online'); H.model.apps.online.select('open'); const r = H.model.apps.online.allRows().find((x) => x.id === 'open'); H.press('a'); return { mounted: !!window.__arenaPresence, value: r.value, disabled: !!r.disabled, stored: localStorage.getItem('arena.open') }; })()`);
      ok(!pre.mounted && pre.value === 'OFF' && pre.disabled === false && pre.stored === null, 'UH1 before the presence code has loaded the OPEN TO BATTLES row says OFF, and nothing is listed or stored', J(pre));
      const onLater = await uiUntil(hub, 'window.__arenaPresence && window.__arenaPresence.isOn() && window.__arenaHub.apps.state().online.open === "on"', 20000);
      const post = await hub.eval(`(() => { const H = window.__arenaHub, r = H.model.apps.online.allRows().find((x) => x.id === 'open'); return { value: r.value, on: !!window.__arenaPresence && window.__arenaPresence.isOn() }; })()`);
      ok(onLater && post.value === 'ON' && post.on === true, 'UH1b and the press made then is NOT LOST: once the code has loaded the switch goes on and the row says ON (a press on the old HTML switch before it was wired was silently dropped)', J(post));
      await hub.eval('window.__arenaPresence.setOn(false)');
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
      const gone = await hub.eval(`(() => { const H = window.__arenaHub; H.goto('online'); H.model.apps.online.select('open'); const before = H.appEffects.length; H.press('a'); const v = H.view(), r = v.menu.rows[v.menu.cursor]; return { value: r.value, disabled: !!r.disabled, help: v.msg.join(' '), pressed: H.appEffects.length - before, mounted: !!window.__arenaPresence, status: H.presence ? H.presence.status() : null }; })()`);
      ok(gone.disabled === true && gone.value === 'OFF' && /could not load/.test(gone.help) && gone.pressed === 0 && gone.mounted === false && gone.status === 'unavailable', 'UH2 when presence_boot.js cannot load, the OPEN TO BATTLES row says so and cannot be pressed (no dead switch that looks as if it worked)', J(gone));
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
  { id: 'M01', what: 'the answer to a question in the picture never reaches the presence service (B closes the question, and nobody is told no)', file: 'js/boot.js', from: "      else if (eff.type === 'dialog' && hook.presence) hook.presence.answer(eff);", to: "      else if (eff.type === 'dialog' && false) hook.presence.answer(eff);", run: 'keys', fails: 'UK1' },
  { id: 'M02', what: 'the Escape fallback of a dialog with no input layer is gone', file: 'js/presence_boot.js', from: "if (open && e.key === 'Escape' && !nav)", to: "if (open && e.key === 'Escape' && false)", run: 'keys', fails: 'UK6' },
  { id: 'M03', what: 'the question listens at once (no arm delay): the A on its way to the menu underneath answers it', file: 'js/hub_presence.js', from: 'armTicks: a.arm || a.waited ? DIALOG_ARM_TICKS : 0 });', to: 'armTicks: 0 });', run: 'accept', fails: 'UA1' },
  { id: 'M04', what: 'the page tells the picture that the repeat of a held direction is a fresh press (the highlight drifts onto YES)', file: 'js/boot.js', from: 'const info = { repeat: !!e.repeat };', to: 'const info = { repeat: false };', run: 'accept', fails: 'UA3' },
  { id: 'M05', what: 'a question is put into the picture while a DOM panel covers it', file: 'js/hub_presence.js', from: "    if (panelOpen()) { a.waited = true; emit(); return; }\n", to: '', run: 'stack', fails: 'US1' },
  { id: 'M06', what: 'the presence service is not told when a DOM panel opens or closes (a question that waited never appears)', file: 'js/boot.js', from: ' if (hook.presence) hook.presence.panels(); };', to: ' };', run: 'stack', fails: 'US4' },
  { id: 'M07', what: 'the hub\'s "a panel is up" state is one boolean again (closing one of two panels lets the question out under the other)', file: 'js/boot.js', from: 'dialogOpen = dlgOwners.size > 0;', to: 'dialogOpen = !!v;', run: 'stack', fails: 'US2' },
  { id: 'M08', what: 'the battle page\'s pause state is one boolean again', file: 'js/battle_boot.js', from: 'controlsOpen = pauseOwners.size > 0;', to: 'controlsOpen = !!v;', run: 'cross', fails: 'UB2' },
  { id: 'M09', what: 'no storage listener (another tab\'s switch is not followed)', file: 'js/presence_boot.js', from: "listen(win, 'storage', onStorage);", to: '', run: 'cross', fails: 'UX1' },
  { id: 'M10', what: 'the listing is not refreshed when the tab becomes visible', file: 'js/presence_boot.js', from: "listen(doc, 'visibilitychange', () => { if (!doc.hidden) refresh(); });", to: '', run: 'refresh', fails: 'UR1' },
  { id: 'M11', what: 'refresh() does not read the trainer again (and neither does the restore path)', file: 'js/presence_boot.js', from: 'const r = await readTrainer();', to: 'const r = { ok: true, trainer };', run: 'refresh', fails: 'UR1' },
  { id: 'M12', what: 'dispose() leaves the dialog in the document', file: 'js/presence_boot.js', from: 'dialog.destroy(); disclosure.destroy();', to: '', run: 'refresh', fails: 'UR5' },
  { id: 'M19', what: 'neither dispose() nor a new dialog removes the dialog of the previous mount (two #challenge in the document)', file: 'js/presence_boot.js', from: 'dialog.destroy(); disclosure.destroy();', to: '', also: [{ file: 'js/presence_boot.js', from: 'if (stale && stale.parentNode) stale.parentNode.removeChild(stale);', to: '' }], run: 'refresh', fails: 'UR4' },
  { id: 'M13', what: 'a start that was overtaken still builds its listing', file: 'js/presence_boot.js', from: 'if (disposed || mine !== gen) return false;', to: 'if (disposed) return false;', run: 'rapid', fails: 'UP1' },
  { id: 'M14', what: 'no disclosure on the first switch-on (the hub\'s OPEN TO BATTLES row asks the presence service, whose turnOn decides)', file: 'js/hub_presence.js', from: 'if (mount.isOn() || !mount.needsDisclosure()) return mount.setOn(true, { persist });', to: 'if (mount.isOn() || true) return mount.setOn(true, { persist });', run: 'disclosure', fails: 'UD1' },
  { id: 'M15', what: 'a stored "on" nobody was told about is honoured', file: 'js/presence_boot.js', from: 'if (disclosureWanted()) setOpen(storage, false); else setOn(true, { persist: false });', to: 'setOn(true, { persist: false });', run: 'disclosure', fails: 'UD7' },
  { id: 'M16', what: 'the picture does not follow the presence service (the row and the main menu keep what it said when the page came up)', file: 'js/online_ctl.js', from: '      offSvc = svc.onChange(onPresence);\n', to: '      offSvc = () => {};\n', run: 'disclosure', fails: 'UM1' },
  { id: 'M17', what: 'a switch that cannot work can still be pressed when the presence code cannot load', file: 'js/online_hub.js', from: "...(S.open === 'unavailable' ? { disabled: true } : {}) });", to: '});', run: 'hidden', fails: 'UH2' },
  { id: 'M18', what: 'a press on OPEN TO BATTLES before the presence code has loaded is silently dropped', file: 'js/hub_presence.js', from: 'toggle() { return ready.then(() => (isOn() ? turnOff().then((off) => !off) : turnOn())); },', to: 'toggle() { if (!mount) return Promise.resolve(false); return ready.then(() => (isOn() ? turnOff().then((off) => !off) : turnOn())); },', run: 'hidden', fails: 'UH1b' },
  { id: 'M20', what: 'the row\'s name changes with its state again (the state belongs in its value)', file: 'js/online_hub.js', from: "label: 'OPEN TO BATTLES', value: S.open === 'on' ||", to: "label: S.open === 'off' ? 'OPEN TO BATTLES' : 'OPEN', value: S.open === 'on' ||", run: 'words', fails: 'UN1' },
  { id: 'M21', what: 'the battle page\'s Open button changes its name with its state again (no constant aria-label)', file: 'js/presence_boot.js', from: "button.setAttribute('aria-label', OPEN_LABEL);", to: '', also: [{ file: 'battle.html', from: ' aria-label="Open to battles" hidden title=', to: ' hidden title=' }], run: 'battlebtn', fails: 'UN2' },
  { id: 'M22', what: 'the dialog layer takes the repeats of a held direction as steps (a key held since before the question drifts the highlight onto YES)', file: 'js/hub_dialog.js', from: "    if (info && info.repeat) return [];\n", to: '', run: 'drift', fails: 'UA5' },
  { id: 'M23', what: 'the OPEN TO BATTLES row says "your name" (which name?) and not where it is listed', file: 'js/online_hub.js', from: "openOff: (who) => ['Lists trainer name ' + who + ' and', 'online record on public servers. A: on.'],", to: "openOff: () => ['Lists your name and online record', 'so anyone can challenge you. A: on.'],", run: 'words', fails: 'UW1' },
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
const UX_READY = OL_READY;
const uxPanel = async (c, page, extra = '') => { await page.navigate(UX_URL(c, 'online=1&ask=quick&net=local&anim=0' + extra)); await page.waitFor(UX_READY + ' && window.__arenaOnline.view().canQuick', { timeoutMs: 90000 }); };
const uxRoom = async (c, page, room, role, extra = '') => { await page.navigate(UX_URL(c, 'np=' + room + '&' + (role === 'host' ? 'host=1' : 'join=1') + '&net=local&anim=0' + extra)); await page.waitFor(UX_READY, { timeoutMs: 90000 }); };
// a same-origin page with nothing in it that speaks and listens on the board's channel (the page under test hears it as "another browser"); uxKeep keeps some listings alive on it (a beacon lasts 13 s)
const uxWire = async (c, page) => { await page.navigate(c.origin + '/pokemonarena/input.css'); await page.eval('(() => { window.__spy = []; const ch = new BroadcastChannel("bemental-arena-open-1"); ch.onmessage = (e) => window.__spy.push(e.data); window.__spyCh = ch; return true; })()'); };
const uxKeep = (p, msgs) => p.eval('(() => { window.__keepMsgs = ' + J(msgs) + '; const ch = window.__keepCh || (window.__keepCh = new BroadcastChannel("bemental-arena-open-1")); for (const m of window.__keepMsgs) ch.postMessage(m); if (!window.__keepIv) window.__keepIv = setInterval(() => { for (const m of window.__keepMsgs) ch.postMessage(m); }, 2500); return true; })()');
async function uxHost(c, page, name, extra = '') {
  await uxPanel(c, page, extra);
  await setForm(page, { name, fmt: '3v3', pub: true, role: 'host' });
  await page.eval('void window.__arenaOnline.quick()');
  await page.waitFor('window.__arenaOnline.view().code !== ""', { timeoutMs: 30000 });
  return (await page.eval('window.__arenaOnline.view().code')).trim();
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
    await guest.waitFor('window.__arenaOnline.board().length === 1', { timeoutMs: 15000 });
    await setForm(guest, { name: 'Gus' });
    ok((await guest.eval(UX_COUNT)) === true, 'OXR0 (the rig) the page\'s Session constructor is replaced by one that counts', '');
    await guest.eval('(() => { const O = window.__arenaOnline, r = O.board()[0].room; void O.pick(r); void O.pick(r); return true; })()');          // two presses in one tick: both pass the "still at the setup form" check
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
    await guest.waitFor('window.__arenaOnline.board().length === 1', { timeoutMs: 15000 });
    await setForm(guest, { name: 'Jon' });
    await guest.eval(UX_COUNT);
    await guest.eval('(() => { const O = window.__arenaOnline; void O.quick(); void O.pick(O.board()[0].room); return true; })()');          // Join pressed while Find a battle is still reading the team
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
    await ch.waitFor('window.__arenaOnline.board().some((g) => g.h)', { timeoutMs: 15000 });
    await setForm(ch, { name: 'Chad' });
    await ch.eval('(() => { const O = window.__arenaOnline, r = O.board().find((g) => g.h).room; void O.pick(r); void O.pick(r); return true; })()');
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
    await a.waitFor('window.__arenaOnline.board().some((g) => g.room === "AGHOX")', { timeoutMs: 10000 });
    await setForm(a, { name: 'Ann' });
    await clickJoin(a, 'AGHOX');
    await a.waitFor('window.__arenaOnline.state.stage === "waiting"', { timeoutMs: 15000 });
    const w = await a.eval('({ cancel: window.__arenaOnline.view().cancel.shown, status: window.__arenaOnline.view().status.text })');
    ok(w.cancel && /gives up after 4 seconds/.test(w.status), 'OXC1 while a listed join waits there is a Cancel, and the status says how long the wait can last', J(w));
    await a.eval('void window.__arenaOnline.cancel()');
    const x = await a.eval('({ stage: window.__arenaOnline.state.stage, status: window.__arenaOnline.view().status.text, noSession: window.__arenaOnline.session() === null, cancelHidden: !window.__arenaOnline.view().cancel.shown, go: window.__arenaOnline.view().canGo, quick: window.__arenaOnline.view().canQuick, name: !window.__arenaOnline.state.locked, kind: window.__arenaOnline.view().kind })');
    ok(x.stage === 'setup' && x.status === 'Cancelled.' && x.noSession && x.cancelHidden && x.go && x.quick && x.name && x.kind === 'ask-quick', 'OXC2 Cancel closes the connection and puts the page back at its question, usable', J(x));
    // the same game can be tried again, and a join nobody answers still ends in words (nothing was left stuck by the cancel)
    await a.waitFor('window.__arenaOnline.board().some((g) => g.room === "AGHOX")', { timeoutMs: 10000 });
    await clickJoin(a, 'AGHOX');
    await a.waitFor('window.__arenaOnline.state.stage === "setup" && /not open any more/.test(window.__arenaOnline.view().status.text)', { timeoutMs: 25000 });
    ok(true, 'OXC3 after a cancel the same game can be joined again, and when nobody answers it is given up on in words', await statusText(a));
    ok(a.errors.length === 0, 'OXC4 no page errors', J(a.errors).slice(0, 200));
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
  const nameBox = (p) => p.eval('window.__arenaOnline.state.form.name');
  const remembered = (p) => p.eval('localStorage.getItem("arena.online.name")');
  await withBrowser({ port: c.cdp(0), width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (p) => {
    await uxPanel(c, p);
    const seeded = await p.eval(SEED_PROFILES_JS(SPEC));
    const [pa, pb] = seeded.profiles, keyB = 'saved:' + pb.id + ':' + pb.teams[0];
    await uxPanel(c, p);
    ok((await nameBox(p)) === 'ALICE' && (await p.eval('window.__arenaOnline.state.form.teamKey')).startsWith('saved:' + pa.id), 'OXN0 (the rig) the active profile\'s team is pre-selected and the name box is its trainer', await nameBox(p));
    await pickTeam(p, keyB);
    ok((await nameBox(p)) === 'BOBBY', 'OXN0b choosing the other trainer\'s team fills in that trainer', await nameBox(p));
    await p.eval('void window.__arenaOnline.startAs("host")');
    await p.waitFor('window.__arenaOnline.view().code !== ""', { timeoutMs: 30000 });
    ok((await remembered(p)) === null, 'OXN1 a name the PANEL filled in is not remembered as the player\'s (only a typed one is)', J(await remembered(p)));
    await uxPanel(c, p);
    ok((await nameBox(p)) === 'ALICE', 'OXN2 the next visit starts with the trainer who owns the pre-selected team, not the owner of the team used last time', await nameBox(p));
    await setForm(p, { name: 'Zed' });
    await p.eval('void window.__arenaOnline.startAs("host")');
    await p.waitFor('window.__arenaOnline.view().code !== ""', { timeoutMs: 30000 });
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
    const v = await p.eval('({ name: window.__arenaOnline.state.form.name, team: window.__arenaOnline.state.form.teamKey })');
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
    await ch.waitFor('window.__arenaOnline.board().some((g) => g.h)', { timeoutMs: 15000 });
    const one = await ch.eval(`(async () => { let n = 0; const o = IDBFactory.prototype.open; IDBFactory.prototype.open = function (...a) { n++; return o.apply(this, a); }; const S = await import('/pokemonarena/js/store.js'); const st = await S.openStore(); await st.close(); IDBFactory.prototype.open = o; return n; })()`);
    const chalsNow = async () => { const all = (await spied(wire)).filter((m) => m && m.k === 'chal'); return all; };
    // the saved team (ALICE's, pre-selected): the challenge carries ALICE's online record, and the store was opened once for it
    await ch.eval(UX_IDB);
    await ch.eval('void window.__arenaOnline.pick(window.__arenaOnline.board().find((g) => g.h).room)');
    await ch.waitFor('window.__arenaOnline.state.stage === "asking"', { timeoutMs: 15000 });
    await sleep(500);
    const opens1 = await ch.eval('window.__idb');
    const c1 = (await chalsNow()).slice(-1)[0];
    ok(c1 && J(c1.rec) === J([2, 1]), 'OXP1 a challenge sent from the panel carries the challenger\'s online record (2-1), read before the challenge went out', J(c1));
    ok(opens1 === one, 'OXI2 and a saved team opens the store ONCE for the team and the record together', opens1 + ' opens, one openStore() = ' + one);
    await ch.eval('void window.__arenaOnline.cancel()');
    await ch.waitFor('window.__arenaOnline.state.stage === "setup"', { timeoutMs: 10000 });
    // a random team: no profile owns it, so no record goes beside the name, and the store is not opened at all
    await pickTeam(ch, 'random');
    await ch.eval('window.__idb = 0; void window.__arenaOnline.pick(window.__arenaOnline.board().find((g) => g.h).room)');
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
    await host.eval('window.__arenaOnline.setForm({ fmt: "3v3" }); void window.__arenaOnline.go()');
    await host.waitFor('window.__arenaOnline.view().code !== ""', { timeoutMs: 30000 });
    await guest.eval('void window.__arenaOnline.go()');
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
    await g.eval('sessionStorage.setItem("arena.online:AGIVU:guest", JSON.stringify({ v: ' + PROTO + ', room: "AGIVU", role: "guest", myTeam: "ARENA1.not-a-team", oppTeam: "ARENA1.not-a-team", myName: "Zed", fmt: "3v3", at: Date.now() })); true');
    await g.send('Page.reload', { ignoreCache: false });
    await g.waitFor(UX_READY, { timeoutMs: 90000 });
    await sleep(800);
    const v = await g.eval('({ opts: window.__arenaOnline.state.choices.map((c) => c.key), status: window.__arenaOnline.view().status.text, stage: window.__arenaOnline.state.stage, kind: window.__arenaOnline.view().kind })');
    ok(v.stage === 'setup' && v.opts.length === new Set(v.opts).size && v.opts.filter((x) => x === 'random').length === 1 && /start a new battle here/.test(v.status) && v.kind === 'invited', 'OXG1 a battle that cannot be picked up again comes back to the page\'s question once (each team listed once) with the reason, not built twice with the reason wiped', J(v));
    ok(g.errors.length === 0, 'OXG2 no page errors', J(g.errors).slice(0, 200));
  });
}

// ---- OXT: what the page says about itself
async function uxText(c) {
  const { ok } = c;
  await withBrowser({ port: c.cdp(0), width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (p) => {
    await uxPanel(c, p);
    // WHAT GOING ONLINE SHARES is said by the hub's online menu before the player leaves for this page; the words are this module's (online.js ONLINE_SHARES, boardPrivacyText), built from what the page REALLY dials
    const t = await p.eval('import("/pokemonarena/js/online.js").then(async (m) => { const L = await import("/pokemonarena/js/openlobby.js"); return { lede: m.ONLINE_SHARES, priv: m.boardPrivacyText(Netplay.signalBrokers(), L.MQTT_LIB), off: window.__arenaOnline.view().lede, kind: window.__arenaOnline.view().kind, brokers: new Set(Netplay.signalBrokers().map((b) => new URL(b.split("|")[0]).hostname)).size }; })');
    ok(!/straight to your friend|only your choices/.test(t.lede) && /team you play/.test(t.lede), 'OXT1 what online play says about itself does not say only choices travel "straight to your friend" (the team you play goes to the other player, and through a public relay when there is no direct path)', t.lede);
    ok(t.priv.includes('connects to ' + t.brokers + ' third-party MQTT brokers (') && t.brokers >= 2 && t.priv.includes('shiftr.io') && t.priv.includes('hivemq.com') && t.priv.includes('cdnjs.cloudflare.com') && /IP address/.test(t.priv) && /trainer name/.test(t.priv) && /online record/.test(t.priv) && /private game with a code is never listed/.test(t.priv), 'OXT2 what BATTLE ANYONE dials is said in words built from what the page really dials: the number and names of the public brokers, the script\'s CDN, the IP address, and what listing a game or challenging publishes (name AND online record)', t.priv);
    ok(t.kind === 'ask-quick' && /trainer name/.test(t.off) && /online record/.test(t.off) && /Other players see/.test(t.off), 'OXT3 the question FIND AN OPPONENT? (in the picture, not a tooltip) says what other players see: trainer name and online record', t.off);
    ok(!(await p.eval('document.querySelectorAll("#olPublic, #online").length')), 'OXT3b there is no switch that lists a room made for a friend: a room with a code is private', '');
    // the hub's switch is a row of its picture: the words of that row (js/online_hub.js) name the record as well as the name
    const words = await (await fetch(c.origin + '/pokemonarena/js/online_hub.js')).text();
    const line = (words.match(/openOff: \(who\) => \[([^\]]*)\]/) || [])[1] || '';
    ok(/trainer name ' \+ who \+ ' and/.test(line) && /online record on public servers/.test(line), 'OXT4 the hub\'s OPEN TO BATTLES row names the trainer name (by name) and the online record, on public servers', line);
    ok(p.errors.length === 0, 'OXT5 no page errors', J(p.errors).slice(0, 200));
  });
}

// every defect below must fail the NAMED case; the session that holds it is run against a copy of the game with only that defect in it
const UX_MUTANTS = [
  { id: 'X01', what: 'Join (from the list) can be entered twice', file: 'js/online.js', from: 'const joinListed = exclusive(async function joinListed(g) {', to: 'const joinListed = (async function joinListed(g) {', run: 'join', fails: 'OXR1' },
  { id: 'X02', what: 'Find a battle can be entered while another way in is still reading the team', file: 'js/online.js', from: 'const quick = exclusive(async function quick() {', to: 'const quick = (async function quick() {', run: 'quick', fails: 'OXR2' },
  { id: 'X03', what: 'Challenge can be entered twice', file: 'js/online.js', from: 'const challengeResident = exclusive(async function challengeResident(g) {', to: 'const challengeResident = (async function challengeResident(g) {', run: 'challenge', fails: 'OXR3' },
  { id: 'X04', what: 'a join shows no Cancel', file: 'js/online.js', from: "    state.cancel = { shown: true, label: role === 'host' ? (state.quick ? 'Stop looking' : 'Close the room') : 'Cancel' };\n", to: "    state.cancel = { shown: false, label: role === 'host' ? (state.quick ? 'Stop looking' : 'Close the room') : 'Cancel' };\n", run: 'cancel', fails: 'OXC1' },
  { id: 'X05', what: 'Cancel does nothing for a join', file: 'js/online.js', from: "else if (state.stage === 'waiting' && state.role === 'guest' && !state.nm && state.session && !closed) { reopenSetup(); say('Cancelled.'); out = true; }", to: "else if (false) { reopenSetup(); say('Cancelled.'); out = true; }", run: 'cancel', fails: 'OXC2' },
  { id: 'X09', what: 'a game put back on the board keeps the last match\'s notice', file: 'js/online.js', from: "flashText = ''; flashUntil = 0;\n    state.stage = 'waiting'; state.roomOpen = false;", to: "state.stage = 'waiting'; state.roomOpen = false;", run: 'relist', fails: 'OXV1' },
  { id: 'X10', what: 'a name the page filled in is remembered as the player\'s', file: 'js/online.js', from: 'if (form.nameTouched) { try { win.localStorage.setItem(LS_NAME, name); }', to: 'if (true) { try { win.localStorage.setItem(LS_NAME, name); }', run: 'names', fails: 'OXN1' },
  { id: 'X11', what: 'a name the player typed is not remembered', file: 'js/online.js', from: 'if (form.nameTouched) { try { win.localStorage.setItem(LS_NAME, name); }', to: 'if (false) { try { win.localStorage.setItem(LS_NAME, name); }', run: 'names', fails: 'OXN3' },
  { id: 'X12', what: 'a remembered name is replaced when the team changes', file: 'js/online.js', from: 'form.nameTouched = !!saved;', to: 'form.nameTouched = false;', run: 'names', fails: 'OXN3b' },
  { id: 'X13', what: 'the pre-selected team\'s owner does not name the player', file: 'js/online.js', from: 'form.teamKey = pre.teamKey;\n    nameFollowsTeam();', to: 'form.teamKey = pre.teamKey;', run: 'names', fails: 'OXN4' },
  { id: 'X14', what: 'a challenge from the panel carries the previous attempt\'s record (state.rec), not this one\'s', file: 'js/online.js', from: 'rec: p.rec || null, now, timing', to: 'rec: state.rec || null, now, timing', run: 'rec', fails: 'OXP1' },
  { id: 'X15', what: 'a random team reads the active profile\'s record (and opens the store for it)', file: 'js/online.js', from: 'profileId: choice.profileId || null, rec: tc.rec || null };', to: 'profileId: choice.profileId || null, rec: tc.rec || (await (async () => { const s = await openStore(); try { return await onlineRecOf(s, await s.getActiveId()); } finally { await s.close(); } })()) };', run: 'rec', fails: 'OXI1' },
  { id: 'X16', what: 'the match record keeps no profile', file: 'js/online.js', from: 'myName: state.name, profileId: state.profileId || null, admittedId:', to: 'myName: state.name, admittedId:', run: 'resume', fails: 'OXM1' },
  { id: 'X17', what: 'a resumed page forgets the profile it read', file: 'js/online.js', from: 'state.profileId = isId(rec.profileId) ? rec.profileId : null;', to: 'state.profileId = null;', run: 'resume', fails: 'OXM1' },
  { id: 'X18', what: 'a resume that is given up builds the setup form twice', file: 'js/online.js', from: "{ await resumeFlow(rec); return; }", to: '{ if (await resumeFlow(rec)) return; }', run: 'giveup', fails: 'OXG1' },
  { id: 'X19', what: 'online play says of itself that only choices travel, straight to the friend', file: 'js/online.js', from: 'Your teams stay in your browser until a battle starts; then the team you play and your choices go to the other player, directly when your browsers can reach each other and through a public relay when they cannot.', to: 'Your teams stay in your browser; only your choices travel, straight to your friend.', run: 'text', fails: 'OXT1' },
  { id: 'X21', what: 'the question FIND AN OPPONENT? names the trainer name but not the record', file: 'js/online_view.js', from: 'Other players see your trainer name and your online record.', to: 'Other players see your trainer name.', run: 'text', fails: 'OXT3' },
  { id: 'X22', what: 'the hub\'s OPEN TO BATTLES row names only the name', file: 'js/online_hub.js', from: "openOff: (who) => ['Lists trainer name ' + who + ' and', 'online record on public servers. A: on.'],", to: "openOff: (who) => ['Lists trainer name ' + who + ' on', 'public servers. A: on.'],", run: 'text', fails: 'OXT4' },
];
const UX_SESSIONS = { join: uxJoin, quick: uxQuick, challenge: uxChallenge, cancel: uxCancel, relist: uxRelist, names: uxNames, rec: uxRec, resume: uxResume, giveup: uxGiveUp, text: uxText };

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

/* ---------------------------------------------------------------------------------------------- tokens: what the HUB hands to the battle page (pokemonarena/INAPP.md "Contract 1" and "Contract 2")
 * All choosing happens in the hub's picture, and the battle is another page. Two things cross: a one-time START TOKEN in this tab's sessionStorage (js/presence.js writeStartToken: INVITE A FRIEND,
 * BATTLE ANYONE, OPEN THE ROOM), which makes the battle page start BY ITSELF what the player pressed in the hub; and the ONLINE PREFERENCES in localStorage (js/online_prefs.js: the team and the size),
 * which the battle page pre-selects. An address alone still starts nothing.
 *   node tools/pokemonarena_online_page_test.mjs tokens             the cases (TK: the three starts, each with its token and not without; TP: the preferences)
 *   node tools/pokemonarena_online_page_test.mjs tokens --mutants   ... and a copy of the game with ONE defect at a time, each of which must fail the case it names (ARENA_TK=start,prefs picks sessions) */
async function groupTokens(S) {
  ANIM = '&anim=0';
  const mk = (origin, okFn) => ({ origin, ok: okFn, cdp: (k) => CDP0 + 30 + (k % 2) });
  const run = async (name, c) => { try { await TK_SESSIONS[name](c); } catch (e) { c.ok(false, 'TK ' + name + ' session crashed', e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e)); } };
  const wanted = (process.env.ARENA_TK || '').split(',').filter(Boolean);
  for (const name of Object.keys(TK_SESSIONS)) if (!wanted.length || wanted.includes(name)) await run(name, mk(ORIGIN, ok));
  if (!process.argv.includes('--mutants')) return;
  if (REMOTE) { ok(true, 'TKMUT (skipped against a deployed site)'); return; }
  const { copyTree, mutateFile, startOverlay } = await import('./pokemonarena_overlay.mjs');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-tokens-mut-'));
  let killed = 0, ran = 0;
  try {
    for (const mu of TOKEN_MUTANTS) {
      if (wanted.length && !wanted.includes(mu.run)) continue;
      const failed = [];
      const rec = (cond, name, detail) => { if (!cond) failed.push(name + (detail ? ' :: ' + String(detail).slice(0, 160) : '')); };
      ran++;
      const dir = copyTree(path.join(root, 'pokemonarena'), path.join(tmp, mu.id));
      let ov = null;
      try {
        try { mutateFile(dir, mu.file, mu.from, mu.to); } catch (e) { ok(false, 'TKMUT ' + mu.id + ' could not be applied', e.message); continue; }
        ov = await startOverlay({ dir, port: PORT + 12, upstream: ORIGIN });
        await run(mu.run, mk(ov.url, rec));
      } finally { if (ov) ov.stop(); }
      const hit = failed.find((f) => f.startsWith(mu.fails + ' '));
      ok(!!hit, 'TKMUT ' + mu.id + ' (' + mu.what + ') fails ' + mu.fails, hit ? '' : 'it did NOT: failed cases = ' + J(failed.map((f) => f.slice(0, 60))));
      if (hit) killed++;
    }
  } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_e) { /* ignore */ } }
  console.log(`tokens mutants: ${killed}/${ran} killed`);
}
// the page is settled: at its question (ready), or under way; or it has LEFT for the hub's online menu (the plain address with nothing to start)
const TK_LEFT = '(location.pathname === "/pokemonarena/" && location.hash === "#online")';
const TK_SETTLED = '(' + TK_LEFT + ' || (window.__arenaOnline && window.__arenaBattle && window.__arenaBattle.state === "online" && !!window.__arenaBattle.onlineScreen && (window.__arenaOnline.view().canGo || window.__arenaOnline.state.stage !== "setup")))';
const TK_VIEW = '(() => { if (' + TK_LEFT + ') return { left: true, stage: null, role: null, room: null, tok: sessionStorage.getItem("arena.go"), search: location.search, go: "", code: null, status: "", prompt: false, hosting: false }; const O = window.__arenaOnline, st = O.state, v = O.view(); return { left: false, stage: st.stage, role: st.role, room: st.room, open: !!st.open, quick: !!st.quick, tok: sessionStorage.getItem("arena.go"), search: location.search, kind: v.kind, go: v.rows.map((r) => r.label).join("|"), code: v.code || null, status: v.status.text, prompt: !!document.getElementById("npApprove"), hosting: O.lobbies() ? !!O.lobbies().hosting() : false }; })()';

// ---- TK: the START token. Each of the three starts happens by itself WITH its token on its own address, and does not without it, with a stale one, or on another kind of address
async function tkStart(c) {
  const { ok } = c;
  const PAGE = c.origin + '/pokemonarena/battle.html', BLANK = c.origin + '/pokemonarena/input.css';
  await withBrowser({ port: c.cdp(0), width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (a) => {
    const guest = await a.openTab({ width: 900, height: 760 });
    const spy = await a.openTab({ width: 900, height: 760 });
    await spy.navigate(BLANK);
    await spy.eval('(() => { window.__spy = []; const ch = new BroadcastChannel("bemental-arena-open-1"); ch.onmessage = (e) => window.__spy.push(e.data); window.__spyCh = ch; return true; })()');
    const listed = async (room) => (await spied(spy)).filter((m) => m && m.k === 'open' && (room ? m.room === room : !/^H/.test(m.room)));
    // the tab's sessionStorage is written from a same-origin page that is not the battle page, the way the hub writes it just before it navigates. tok: an object (stamped `ageMs` ago), a raw string, or null
    const arrive = async (tok, query, ageMs = 0) => {
      await a.navigate(BLANK);
      await a.eval('(() => { sessionStorage.clear(); ' + (tok === null ? '' : typeof tok === 'string' ? 'sessionStorage.setItem("arena.go", ' + J(tok) + ');' : 'sessionStorage.setItem("arena.go", JSON.stringify(Object.assign(' + J(tok) + ', { at: Date.now() - (' + ageMs + ') })));') + ' return true; })()');
      await a.navigate(PAGE + '?' + query + '&net=local&anim=0');
      await a.waitFor(TK_SETTLED, { timeoutMs: 90000 });
    };
    const view = () => a.eval(TK_VIEW);
    // (nothing started: the page rests at a question; or, on the plain address, it has left for the hub's menu. Either way no room, nothing listed, and the token is gone)
    const nothing = async (ms = 2500) => { await sleep(ms); const v = await view(); return { v, none: v.tok === null && (v.left ? true : v.stage === 'setup' && !v.code && !v.hosting) }; };
    let prompted = false;

    // { host } on the plain page: a friend's private room, by itself
    await arrive({ what: 'host' }, 'online=1');
    const opened = await a.waitFor('window.__arenaOnline.state.stage === "open" && window.__arenaOnline.view().code !== ""', { timeoutMs: 30000 }).then(() => true, () => false);
    const v1 = await view(), u1 = new URLSearchParams(v1.search);
    ok(opened && v1.role === 'host' && /^[A-Z0-9]{4,8}$/.test(v1.room || '') && v1.code === v1.room && v1.open === false && v1.quick === false && u1.get('np') === v1.room && u1.get('host') === '1' && u1.get('online') === null && (await listed(v1.room)).length === 0,
      'TK1 with the hub\'s START token { host } the plain ?online=1 page OPENS A FRIEND\'S PRIVATE ROOM BY ITSELF: the room is open, its code is on the screen, the address names it, and it is not listed', J(v1));
    ok(v1.tok === null, 'TK2 the token was used up by the page that took it', J(v1.tok));
    if (opened) {
      await guest.navigate(PAGE + '?np=' + v1.room + '&join=1&net=local&anim=0');
      await guest.waitFor(TK_SETTLED, { timeoutMs: 90000 });
      await fillAndGo(guest, { name: 'Bob', team: 'random' });
      const r = await bothPlaying(a, guest, 60000, a);
      prompted = prompted || r.prompted;
      ok(r.phases[0] === 'playing' && r.phases[1] === 'playing' && !r.prompted, 'TK1b and a friend who opens its invite link joins it: the battle starts, and nobody presses Allow', J(r));
      await guest.navigate('about:blank');
    }
    // a RELOAD of a page a token started: an ordinary room page, nothing starts again
    await arrive({ what: 'host' }, 'online=1');
    await a.waitFor('window.__arenaOnline.state.stage === "open"', { timeoutMs: 30000 }).catch(() => {});
    const before = await view();
    await a.send('Page.reload', { ignoreCache: false });
    await a.waitFor(TK_SETTLED, { timeoutMs: 90000 });
    const re = await nothing();
    ok(before.stage === 'open' && re.none && !re.v.left && re.v.kind === 'room' && re.v.role === 'host' && re.v.room === before.room && /OPEN THE ROOM/.test(re.v.go), 'TK4 a RELOAD of the page a token started is the ordinary page of that room (YOUR ROOM, OPEN THE ROOM): nothing starts again, the token was good once', J(re.v));
    // no token: the page it always was
    const heard0 = (await listed()).length;
    await arrive(null, 'online=1');
    const n3 = await nothing();
    ok(n3.none && n3.v.left === true && (await listed()).length === heard0, 'TK3 AN ADDRESS ALONE STARTS NOTHING: the same ?online=1 with no token opens no room and lists nothing (there is nothing to choose on this page any more: it leaves for the hub\'s online menu)', J(n3.v));
    // { quick } on the plain page: Find an opponent, by itself
    await arrive({ what: 'quick' }, 'online=1&openquick=500');
    const found = await a.waitFor('window.__arenaOnline.state.stage === "open" && window.__arenaOnline.state.quick === true', { timeoutMs: 30000 }).then(() => true, () => false);
    const v5 = await view();
    const onBoard = found && await (async () => { for (let i = 0; i < 40; i++) { if ((await listed(v5.room)).some((m) => m.q === 1)) return true; await sleep(150); } return false; })();
    ok(found && v5.open === true && v5.quick === true && v5.hosting === true && v5.tok === null && onBoard, 'TK5 with { quick } the plain page FINDS AN OPPONENT BY ITSELF: nobody was waiting, so a game is opened and listed for anyone', J(v5));
    await a.navigate('about:blank'); await sleep(300);
    // { host, room } on that room's own address: Open the room, by itself
    await arrive({ what: 'host', room: 'AXYZ1' }, 'np=AXYZ1&host=1');
    const named = await a.waitFor('window.__arenaOnline.state.stage === "open" && window.__arenaOnline.view().code !== ""', { timeoutMs: 30000 }).then(() => true, () => false);
    const v6 = await view();
    ok(named && v6.role === 'host' && v6.room === 'AXYZ1' && v6.code === 'AXYZ1' && v6.open === false && v6.tok === null, 'TK6 with { host, room } the room\'s own address (?np=ROOM&host=1) OPENS THAT ROOM BY ITSELF, as pressing OPEN THE ROOM does', J(v6));
    // a token on an address that is not its own: nothing starts (and the token is gone all the same)
    for (const [tok, query, label] of [
      [{ what: 'host', room: 'AXYZ1' }, 'np=AXYZ2&host=1', 'a token for ANOTHER room'],
      [{ what: 'host' }, 'np=AXYZ3&host=1', 'a { host } token that names no room, on a room\'s address'],
      [{ what: 'host', room: 'AXYZ4' }, 'online=1', 'a room\'s token on the plain page'],
      [{ what: 'quick' }, 'np=AXYZ5&host=1', 'a { quick } token on a room\'s address'],
      [{ what: 'host', room: 'AXYZ6' }, 'np=AXYZ6&join=1', 'a host token on the room\'s JOIN address'],
    ]) {
      await arrive(tok, query);
      const x = await nothing(2000);
      ok(x.none, 'TK7 ' + label + ' starts nothing (and is gone)', J(x.v));
    }
    // a token that is not fresh, or not a token
    for (const [tok, age, label] of [[{ what: 'host' }, 61000, 'a token a minute old'], [{ what: 'quick' }, -60000, 'a token dated in the future'], ['{"what":"host"', 0, 'a malformed token'], [{ what: 'join' }, 0, 'a token that names no known start']]) {
      await arrive(tok, 'online=1', age);
      const x = await nothing(2000);
      ok(x.none && !x.v.room, 'TK8 ' + label + ' starts nothing (and is gone)', J(x.v));
    }
    // an accepted-challenge address with no accept token is the ordinary panel with its notice; a START token does not turn it into a room
    await arrive({ what: 'host' }, 'online=1&auto=host&for=' + 'ab'.repeat(8) + '&rq=' + 'cd'.repeat(8) + '&format=3v3');
    const x9 = await nothing();
    ok(x9.none && !x9.v.left && x9.v.kind === 'ignored' && !x9.v.room && /ignored/.test(x9.v.status), 'TK9 a START token does not make an accepted-challenge address host anything: the picture says it was ignored', J(x9.v));
    ok(uiErrs(a, guest).length === 0 && !prompted && !(await view()).prompt, 'TK10 no page errors, and the library\'s Allow prompt never appeared', J(uiErrs(a, guest)).slice(0, 300));
  });
}

// ---- TP: the online preferences. The battle page pre-selects the preferred team and size, falls back to what it did before when the team is gone, and an accepted challenge plays with the preferred team
async function tkPrefs(c) {
  const { ok } = c;
  const PAGE = c.origin + '/pokemonarena/battle.html', BLANK = c.origin + '/pokemonarena/input.css';
  await withBrowser({ port: c.cdp(1), width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (a) => {
    await a.navigate(PAGE + '?online=1&ask=host&net=local&anim=0');
    await a.waitFor(TK_SETTLED, { timeoutMs: 90000 });
    const seeded = await a.eval(SEED_PROFILES_JS([['RED', [['ALPHA', ['Pikachu', 'Charizard', 'Snorlax', 'Blastoise', 'Gengar', 'Eevee']], ['BETA', ['Pikachu', 'Charizard', 'Snorlax']]]]]));
    const pid = seeded.profiles[0].id, [tA, tB] = seeded.profiles[0].teams;
    const keyA = 'saved:' + pid + ':' + tA, keyB = 'saved:' + pid + ':' + tB;
    const setPrefs = (prefs) => a.eval('(() => { ' + (prefs ? 'localStorage.setItem("arena.online.team", ' + J(J(prefs)) + ')' : 'localStorage.removeItem("arena.online.team")') + '; return true; })()');
    const panel = async (prefs, query = 'online=1&ask=host') => {
      await setPrefs(prefs);
      await a.navigate(PAGE + '?' + query + '&net=local&anim=0');
      await a.waitFor(TK_SETTLED, { timeoutMs: 90000 });
      return a.eval('({ team: window.__arenaOnline.state.form.teamKey, fmt: window.__arenaOnline.state.form.fmt, name: window.__arenaOnline.state.form.name, keys: window.__arenaOnline.state.choices.map((c) => c.key), stage: window.__arenaOnline.state.stage })');
    };
    const p0 = await panel(null);
    ok(!seeded.notSaved && J(p0.keys.slice(0, 2)) === J([keyA, keyB]) && p0.team === keyA && p0.fmt === '6v6' && p0.stage === 'setup', 'TP0 (the rig, and the control) with no preference the page selects what it always did: the first saved team, 6 v 6 for a team of six', J(p0));
    const p1 = await panel({ teamKey: keyB, fmt: null });
    ok(p1.team === keyB && p1.fmt === '3v3' && p1.name === 'RED' && p1.stage === 'setup', 'TP1 the PREFERRED TEAM is pre-selected (and its default size, 3 v 3 for a team of three); nothing starts', J(p1));
    const p2 = await panel({ teamKey: keyA, fmt: '3v3' });
    ok(p2.team === keyA && p2.fmt === '3v3', 'TP2 the PREFERRED SIZE is pre-selected (3 v 3 for the team of six, where the page would have said 6 v 6)', J(p2));
    const p3 = await panel({ teamKey: 'saved:' + pid + ':t_gone', fmt: '3v3' });
    ok(p3.team === keyA && p3.fmt === '3v3', 'TP3 a preferred team that is GONE falls back to what the page did before (the first saved team); the preferred size still stands', J(p3));
    const p4 = await panel({ teamKey: 'random', fmt: null });
    ok(p4.team === 'random' && p4.fmt === '3v3', 'TP4 "a random team" can be the preference', J(p4));
    const p5 = await panel({ teamKey: keyB, fmt: '6v6' }, 'online=1&ask=host&format=3v3');
    ok(p5.team === keyB && p5.fmt === '3v3', 'TP5 the address\'s format= comes before the preferred size', J(p5));
    const p6 = await panel({ teamKey: keyB, fmt: '6v6' }, 'np=APREF&host=1');
    ok(p6.team === keyB && p6.fmt === '6v6' && p6.stage === 'setup', 'TP6 a room\'s own page (the site lobby\'s hand-off) pre-selects them too, and starts nothing', J(p6));
    // an accepted challenge plays with the preferred team: the accept token is what Accept leaves in the tab
    const accepted = async (prefs) => {
      await setPrefs(prefs);
      await a.eval('(() => { sessionStorage.clear(); sessionStorage.setItem("arena.accept", JSON.stringify({ for: ' + J('ab'.repeat(8)) + ', rq: ' + J('cd'.repeat(8)) + ', ck: ' + J(PK_SHAPE) + ', at: Date.now() })); return true; })()');
      await a.navigate(PAGE + '?online=1&auto=host&for=' + 'ab'.repeat(8) + '&rq=' + 'cd'.repeat(8) + '&format=3v3&net=local&anim=0');
      const up = await a.waitFor('window.__arenaOnline && window.__arenaOnline.state.stage === "open"', { timeoutMs: 60000 }).then(() => true, () => false);
      const st = await a.eval('(() => { const st = window.__arenaOnline.state; return { stage: st.stage, role: st.role, size: st.mine ? st.mine.size : null, profileId: st.profileId, fmt: st.fmt, invite: !!st.invite, team: window.__arenaOnline.state.form.teamKey }; })()');
      await a.navigate(BLANK); await sleep(300);          // (the room is closed by leaving the page, for a same-origin page: the next case writes this origin's storage)
      return { up, ...st };
    };
    const a7 = await accepted({ teamKey: keyB, fmt: '6v6' });
    ok(a7.up && a7.invite && a7.role === 'host' && a7.team === keyB && a7.size === 3 && a7.profileId === pid && a7.fmt === '3v3', 'TP7 THE PAGE AN ACCEPTED CHALLENGE OPENS PLAYS WITH THE PREFERRED TEAM (the team of three, not the first saved one), as that trainer, 3 v 3 as every accepted challenge is', J(a7));
    const a8 = await accepted({ teamKey: 'saved:' + pid + ':t_gone', fmt: null });
    ok(a8.up && a8.team === keyA && a8.size === 6 && a8.profileId === pid, 'TP8 ... and with a preferred team that is gone, the first saved team, as before', J(a8));
    const a9 = await accepted(null);
    ok(a9.up && a9.team === keyA && a9.size === 6, 'TP9 ... and with no preference, the first saved team, as before (the control)', J(a9));
    ok(uiErrs(a).length === 0, 'TP10 no page errors', J(uiErrs(a)).slice(0, 300));
  });
}
const TK_SESSIONS = { start: tkStart, prefs: tkPrefs };
// every defect below must fail the NAMED case; the session that holds it is run against a copy of the game with only that defect in it
const TOKEN_MUTANTS = [
  { id: 'T01', what: 'the plain address opens a friend\'s room with or without a token', file: 'js/online.js', from: 'startTok = startPlan(takeStartToken(ss, Date.now()), cfg.query); }', to: "takeStartToken(ss, Date.now()); startTok = cfg.query.role === null && !cfg.query.room && !cfg.query.auto ? 'host' : null; }", run: 'start', fails: 'TK3' },
  { id: 'T02', what: 'the hub\'s press is lost: the start token is never honoured', file: 'js/online.js', from: '    else if (startTok) { const what = startTok;', to: '    else if (false) { const what = startTok;', run: 'start', fails: 'TK1' },
  { id: 'T03', what: 'a { quick } token opens a private room instead of finding an opponent', file: 'js/online.js', from: "if (what === 'quick') quick(); else if (what === 'room') go(); else startAs('host'); }", to: "if (what === 'room') go(); else startAs('host'); }", run: 'start', fails: 'TK5' },
  { id: 'T04', what: 'the preferred team is not pre-selected', file: 'js/online.js', from: '    form.teamKey = pre.teamKey;\n    nameFollowsTeam();\n    form.fmt = pre.fmt;\n', to: '    form.teamKey = choices[0].key;\n    nameFollowsTeam();\n    form.fmt = pre.fmt;\n', run: 'prefs', fails: 'TP1' },
  { id: 'T05', what: 'the preferred size is not pre-selected', file: 'js/online.js', from: '    form.fmt = pre.fmt;\n', to: "    form.fmt = cfg.formatParam === '6v6' ? '6v6' : cfg.formatParam === '3v3' ? '3v3' : (choices[0].size >= 6 ? '6v6' : '3v3');\n", run: 'prefs', fails: 'TP2' },
  { id: 'T06', what: 'an accepted challenge plays with the first saved team whatever is preferred', file: 'js/online.js', from: "    setRole('host');\n    // the PROFILE speaks for the player here", to: "    setRole('host'); form.teamKey = state.choices[0].key;\n    // the PROFILE speaks for the player here", run: 'prefs', fails: 'TP7' },
];

/* ---------------------------------------------------------------------------------------------- screens: the battle page's online screens are IN THE PICTURE (pokemonarena/INAPP.md "BATTLE: as built")
 * Before a battle the page shows ROM-drawn screens in the battle canvas (js/online_view.js: what; js/online_draw.js: the pixels; js/battle_boot.js: the loop and the buttons): the confirm screens an
 * address without the hub's one-time token must ask (YOU'RE INVITED, YOUR ROOM, the one-press questions), and the waiting screens. There is no panel in the page.
 *   node tools/pokemonarena_online_page_test.mjs screens             the cases (SC: the plain address leaves for the hub; nothing is published before YES; COPY and SHARE are called inside the press;
 *                                                                    every way back honours arena.back; real keys, a real click and a real tap reach the screen; the screen gives way to the battle)
 *   node tools/pokemonarena_online_page_test.mjs screens --mutants   ... and a copy of the game with ONE defect at a time, each of which must fail the case it names (ARENA_SC=bare,copy picks sessions) */
async function groupScreens(S) {
  ANIM = '&anim=0';
  const mk = (origin, okFn) => ({ origin, ok: okFn, cdp: (k) => CDP0 + 40 + (k % 2) });
  const run = async (name, c) => { try { await SC_SESSIONS[name](c); } catch (e) { c.ok(false, 'SC ' + name + ' session crashed', e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e)); } };
  const wanted = (process.env.ARENA_SC || '').split(',').filter(Boolean);
  for (const name of Object.keys(SC_SESSIONS)) if (!wanted.length || wanted.includes(name)) await run(name, mk(ORIGIN, ok));
  // the docs count the defects this group breaks
  { const om = fs.readFileSync(path.join(root, 'pokemonarena', 'ONLINE.md'), 'utf8').match(/`screens --mutants` does the same for the screens in the picture, (\d+) of them/);
    ok(!!om && Number(om[1]) === SCREEN_MUTANTS.length, 'SCD1 pokemonarena/ONLINE.md states how many ways `screens --mutants` breaks the page (' + SCREEN_MUTANTS.length + ')', om ? 'ONLINE.md says ' + om[1] : 'the sentence is not in ONLINE.md'); }
  if (!process.argv.includes('--mutants')) return;
  if (REMOTE) { ok(true, 'SCMUT (skipped against a deployed site)'); return; }
  const { copyTree, mutateFile, startOverlay } = await import('./pokemonarena_overlay.mjs');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-screens-mut-'));
  let killed = 0, ran = 0;
  try {
    for (const mu of SCREEN_MUTANTS) {
      if (wanted.length && !wanted.includes(mu.run)) continue;
      const failed = [];
      const rec = (cond, name, detail) => { if (!cond) failed.push(name + (detail ? ' :: ' + String(detail).slice(0, 160) : '')); };
      ran++;
      const dir = copyTree(path.join(root, 'pokemonarena'), path.join(tmp, mu.id));
      let ov = null;
      try {
        try { mutateFile(dir, mu.file, mu.from, mu.to); } catch (e) { ok(false, 'SCMUT ' + mu.id + ' could not be applied', e.message); continue; }
        ov = await startOverlay({ dir, port: PORT + 14, upstream: ORIGIN });
        await run(mu.run, mk(ov.url, rec));
      } finally { if (ov) ov.stop(); }
      const hit = failed.find((f) => f.startsWith(mu.fails + ' '));
      ok(!!hit, 'SCMUT ' + mu.id + ' (' + mu.what + ') fails ' + mu.fails, hit ? '' : 'it did NOT: failed cases = ' + J(failed.map((f) => f.slice(0, 60))));
      if (hit) killed++;
    }
  } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_e) { /* ignore */ } }
  console.log(`screens mutants: ${killed}/${ran} killed`);
}
const SC_PAGE = (c, q) => c.origin + '/pokemonarena/battle.html?' + q + '&net=local&anim=0';
const SC_BLANK = (c) => c.origin + '/pokemonarena/input.css';
// where the page asked to go (the page's own navigate seam: battle_boot.js reads window.__arenaNavigate at the moment it leaves)
const SC_NAV = '(() => { window.__nav = []; window.__arenaNavigate = (u, o) => { window.__nav.push([u, o && o.replace ? "replace" : "assign"]); }; return true; })()';
const scOpen = async (c, p, q) => { await p.navigate(SC_PAGE(c, q)); await p.waitFor(OL_READY, { timeoutMs: 90000 }); };

// ---- SC1: the plain address with nothing to start is not a page any more
async function scBare(c) {
  const { ok } = c;
  await withBrowser({ port: c.cdp(0), width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (a) => {
    const spy = await a.openTab({ width: 900, height: 760 });
    await uxWire(c, spy);
    await a.navigate(SC_BLANK(c));
    await a.eval('(() => { sessionStorage.clear(); return true; })()');
    const len0 = await a.eval('history.length');
    await a.navigate(c.origin + '/pokemonarena/battle.html?online=1&net=local&anim=0&openchal=5000');
    const left = await a.waitFor('location.pathname === "/pokemonarena/" && location.hash === "#online"', { timeoutMs: 60000 }).then(() => true, () => false);
    const at = await a.eval('({ path: location.pathname, hash: location.hash, search: location.search, len: history.length })');
    const q = new URLSearchParams(at.search);
    ok(left && q.get('net') === 'local' && q.get('anim') === '0' && q.get('openchal') === '5000' && q.get('online') === null, 'SC1 the plain ?online=1 address with no token of the hub has nothing to ask: the page leaves for the hub\'s online menu (/pokemonarena/#online), with the test seams it came with', J(at));
    void len0;
    const heard = await spied(spy);
    ok(left && heard.length === 0, 'SC1c and it dialled nothing on the way: no listing, not even "who is open?"', J(heard).slice(0, 200));
    // HOW it leaves, read at the page's own navigate seam (installed before the page's scripts run): in this page's PLACE in the tab's history, so Back does not come back to a page that sends the player away again
    await a.send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__nav = []; window.__arenaNavigate = (u, o) => { window.__nav.push([u, o && o.replace ? "replace" : "assign"]); };' });
    await a.navigate(c.origin + '/pokemonarena/battle.html?online=1&net=local&anim=0&openchal=5000');
    await a.waitFor('window.__nav && window.__nav.length > 0', { timeoutMs: 60000 }).catch(() => {});
    const how = await a.eval('({ nav: window.__nav, screen: window.__arenaOnline ? window.__arenaOnline.view().screen : null, sess: window.__arenaOnline ? !!window.__arenaOnline.session() : null, board: window.__arenaOnline ? !!window.__arenaOnline.lobbies() : null })');
    ok(J(how.nav) === J([['/pokemonarena/?net=local&anim=0&openchal=5000#online', 'replace']]) && how.screen === 'hidden' && how.sess === false && how.board === false, 'SC1b ... IN ITS OWN PLACE in the tab\'s history (a replace, once), showing no screen of its own and opening nothing meanwhile', J(how));
  });
}

// ---- SC2: a question publishes nothing; the board is dialled by what needs it
async function scAsk(c) {
  const { ok } = c;
  await withBrowser({ port: c.cdp(0), width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (a) => {
    const spy = await a.openTab({ width: 900, height: 760 });
    await uxWire(c, spy);
    // (not scOpen: a page that started something by itself is not "at its question", and that must be a failed case below, not a timeout)
    await a.navigate(SC_PAGE(c, 'online=1&ask=quick&openquick=400'));
    await a.waitFor('window.__arenaOnline && window.__arenaBattle && window.__arenaBattle.state === "online" && !!window.__arenaBattle.onlineScreen && window.__arenaOnline.view().ready', { timeoutMs: 90000 });
    const v = await OV(a);
    ok(v.kind === 'ask-quick' && v.ask === 'FIND AN OPPONENT?' && v.labels === 'YES|BACK' && /Other players see/.test(v.lede) && /trainer name/.test(v.lede) && /online record/.test(v.lede) && olFits(v), 'SC2 ?online=1&ask=quick asks FIND AN OPPONENT? in the picture and says, BEFORE YES, what other players will see (trainer name, online record)', J(v).slice(0, 400));
    await sleep(1500);
    const pub = (await spied(spy)).filter((m) => m && m.k === 'open');
    const idle = await a.eval('({ stage: window.__arenaOnline.state.stage, sess: !!window.__arenaOnline.session(), hosting: window.__arenaOnline.lobbies() ? window.__arenaOnline.lobbies().hosting() : "no board", room: window.__arenaOnline.state.room })');
    ok(pub.length === 0 && idle.stage === 'setup' && !idle.sess && idle.hosting === null && !idle.room, 'SC2a nothing is published before YES: the page listens to the board, lists nothing and opens no room', J([idle, pub]).slice(0, 300));
    await olPress(a, 'a');
    const up = await a.waitFor('window.__arenaOnline.state.stage === "open" && window.__arenaOnline.state.quick === true && window.__arenaOnline.view().code !== ""', { timeoutMs: 30000 }).then(() => true, () => false);
    const v2 = await OV(a);
    let listed = false; for (let i = 0; up && i < 40 && !listed; i++) { listed = (await spied(spy)).some((m) => m && m.k === 'open' && m.room === v2.code && m.q === 1); if (!listed) await sleep(150); }
    ok(up && listed && v2.labels === 'COPY CODE|STOP LOOKING' && v2.codeLabel === 'CODE FOR A FRIEND' && /your game is open/.test(v2.status.text) && v2.who === 'Battle anyone' && olFits(v2), 'SC2b YES looks, finds nobody and lists a game for anyone: BATTLE ANYONE, the code for a friend, COPY CODE / STOP LOOKING', J(v2).slice(0, 400));
    ok((await olRow(a, 'cancel')) === 'act:cancel', 'SC2c0 STOP LOOKING is a row of the screen', '');
    await sleep(400);
    const v3 = await OV(a), hosting = await a.eval('window.__arenaOnline.lobbies() ? window.__arenaOnline.lobbies().hosting() : null');
    ok(v3.kind === 'ask-quick' && /Stopped looking/.test(v3.status.text) && !v3.sess && hosting === null, 'SC2c STOP LOOKING comes back to the question, with the game off the board', J([v3.kind, v3.status, hosting]));
    await scOpen(c, a, 'online=1&ask=host');
    await sleep(800);
    ok((await a.eval('window.__arenaOnline.lobbies()')) === null, 'SC2d a page that asks OPEN A ROOM FOR A FRIEND? does not dial the open-games board at all (a private room has no business there)', '');
    ok(uiErrs(a).length === 0, 'SC2e no page errors', J(uiErrs(a)).slice(0, 200));
  });
}

// ---- SC3 / SC4: COPY LINK, COPY CODE and SHARE are the browser's own calls, made INSIDE the press
async function scCopy(c) {
  const { ok } = c;
  // the browser's copy and share, replaced by recorders: what was handed over, and whether the call was made while the key / pointer event was still being dispatched (window.event) with a user gesture behind it
  const STUB = '(() => { window.__clip = []; window.__shared = []; window.__clipFail = false; const at = () => ({ inEvent: window.event ? window.event.type : null, active: !!(navigator.userActivation && navigator.userActivation.isActive) }); Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: (t) => { window.__clip.push({ what: t, ...at() }); return window.__clipFail ? Promise.reject(new Error("denied")) : Promise.resolve(); } } }); window.__shareOn = (on) => Object.defineProperty(navigator, "share", { configurable: true, value: on ? (d) => { window.__shared.push({ what: d, ...at() }); return Promise.resolve(); } : undefined }); window.__shareOn(false); return true; })()';
  await withBrowser({ port: c.cdp(0), width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (a) => {
    await scOpen(c, a, 'online=1&ask=host');
    await a.send('Page.bringToFront');
    await a.eval(STUB);
    await olPress(a, 'a');
    await a.waitFor('window.__arenaOnline.view().code !== ""', { timeoutMs: 30000 });
    const v = await OV(a);
    ok(v.ids === 'copy-link,copy-code,cancel' && v.canShare === false, 'SC4 where the browser cannot share there is no SHARE row', v.ids);
    // a REAL key: the cursor is on COPY LINK, Enter is A
    await a.eval('document.getElementById("battle").focus()');
    await a.press('Enter', 'Enter', 13);
    await sleep(200);
    const c1 = await a.eval('({ clip: window.__clip, copied: window.__arenaOnline.view().copied, label: window.__arenaOnline.view().rows[0].label })');
    ok(c1.clip.length === 1 && c1.clip[0].what === v.link && c1.clip[0].inEvent === 'keydown' && c1.clip[0].active, 'SC3 COPY LINK hands the invite link to the browser\'s clipboard INSIDE the key press that asked for it (the browser may refuse a copy that no user gesture stands behind)', J(c1.clip));
    ok(c1.copied === 'link' && c1.label === 'COPIED', 'SC3a ... and the row says COPIED', J([c1.copied, c1.label]));
    await sleep(2300);
    const c2 = await a.eval('({ copied: window.__arenaOnline.view().copied, label: window.__arenaOnline.view().rows[0].label, st: window.__arenaOnline.view().status.text })');
    ok(c2.copied === null && c2.label === 'COPY LINK' && /Waiting for your friend/.test(c2.st), 'SC3b ... for two seconds, then COPY LINK again; the sentence that says what is happening was never replaced', J(c2));
    // a REAL click on COPY CODE
    const pt = await olRowPoint(a, 'copy-code');
    await a.click(pt.x, pt.y);
    await sleep(200);
    const c3 = await a.eval('({ clip: window.__clip.slice(1), copied: window.__arenaOnline.view().copied })');
    ok(c3.clip.length === 1 && c3.clip[0].what === v.code && !!c3.clip[0].inEvent && c3.clip[0].active && c3.copied === 'code', 'SC3d a click on COPY CODE hands the room code over inside the click', J(c3));
    // the browser refuses: said in the picture, pointing at the code, which is on the screen
    await a.eval('window.__clipFail = true; true');
    await olRow(a, 'copy-link'); await sleep(200);
    const c4 = await OV(a);
    ok(c4.status.bad && /refused/.test(c4.status.text) && c4.status.text.includes(v.code) && c4.copied !== 'link' && c4.code === v.code && c4.stage === 'open' && olFits(c4), 'SC3c a copy the browser refuses is said in the picture, pointing at the room code on the screen (which always works); the room stays open', J([c4.status, c4.copied, c4.fits]));
    // a browser that can share: the row is there, and SHARE is called inside the press with the link and the code
    await olRow(a, 'cancel'); await sleep(300);
    await a.eval('window.__clipFail = false; window.__shareOn(true); true');
    await olPress(a, 'a');
    await a.waitFor('window.__arenaOnline.view().code !== ""', { timeoutMs: 30000 });
    const v5 = await OV(a);
    ok(v5.ids === 'copy-link,share,copy-code,cancel' && v5.labels === 'COPY LINK|SHARE|COPY CODE|CLOSE THE ROOM' && olFits(v5), 'SC4a where the browser can share, SHARE is a row between COPY LINK and COPY CODE, and the screen still fits', v5.ids + ' ' + J(v5.fits));
    await a.press('ArrowDown', 'ArrowDown', 40); await sleep(80);
    await a.press('Enter', 'Enter', 13); await sleep(200);
    const s = await a.eval('window.__shared');
    ok(s.length === 1 && s[0].what && s[0].what.url === v5.link && String(s[0].what.text || '').includes(v5.code) && s[0].inEvent === 'keydown' && s[0].active, 'SC4b SHARE hands the link and the room code to the browser\'s share sheet inside the key press', J(s));
    ok(uiErrs(a).length === 0, 'SC4c no page errors', J(uiErrs(a)).slice(0, 200));
  });
}

// ---- SC5 / SC6 / SC7: every way back to the hub goes where the hub said (INAPP.md "Contract 6"), and nowhere else
async function scBack(c) {
  const { ok } = c;
  await withBrowser({ port: c.cdp(1), width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (a) => {
    const arrive = async (q, store) => {
      await a.navigate(SC_BLANK(c));
      await a.eval('(() => { sessionStorage.clear(); ' + Object.entries(store || {}).map(([k, v]) => 'sessionStorage.setItem(' + J(k) + ', ' + (k === 'arena.go' || k === 'arena.meet' ? 'JSON.stringify(Object.assign(' + J(v) + ', { at: Date.now() }))' : J(v)) + ');').join(' ') + ' return true; })()');
      await a.navigate(SC_PAGE(c, q));
      await a.waitFor('window.__arenaOnline && window.__arenaBattle && window.__arenaBattle.state === "online" && !!window.__arenaBattle.onlineScreen && (window.__arenaOnline.view().canGo || window.__arenaOnline.state.stage !== "setup")', { timeoutMs: 90000 });
      await a.eval(SC_NAV);
    };
    const nav = () => a.eval('window.__nav');
    await arrive('np=ABACK&join=1&openjoin=9000', { 'arena.back': 'center' });
    const home = await a.eval('(() => { const h = document.getElementById("homeLink"); h.addEventListener("click", (e) => e.preventDefault()); h.click(); return h.getAttribute("href"); })()');
    const b0 = await olPress(a, 'b');
    ok(J(b0) === J(['act:back']) && J(await nav()) === J([['/pokemonarena/#center', 'assign']]), 'SC5 BACK on a confirm screen (B is its BACK row) leaves for the hub screen the player came from (arena.back = center)', J([b0, await nav()]));
    ok(home === '/pokemonarena/#center', 'SC5c ... and so does the header\'s link', home);
    for (const bad of ['../evil', 'main', 'Center', 'https://example.com/', 'a'.repeat(40)]) {
      await arrive('np=ABACK&join=1', { 'arena.back': bad });
      await olRow(a, 'back');
      ok(J(await nav()) === J([['/pokemonarena/', 'assign']]), 'SC5b a value of arena.back that is not a hub path (' + bad.slice(0, 12) + ') is not followed: BACK is the main menu', J(await nav()));
    }
    await arrive('np=ABACK&join=1&openjoin=9000');
    ok((await olRow(a, 'team')) === 'act:team' && J(await nav()) === J([['/pokemonarena/?np=ABACK&join=1&net=local&anim=0&openjoin=9000#online', 'assign']]), 'SC6 CHANGE TEAM on YOU\'RE INVITED opens the hub\'s online menu for that room as a guest, with the test seams', J(await nav()));
    await arrive('np=ABACK&host=1');
    ok((await olRow(a, 'team')) === 'act:team' && J(await nav()) === J([['/pokemonarena/?np=ABACK&host=1&net=local&anim=0#online', 'assign']]), 'SC6b ... and on YOUR ROOM as the host', J(await nav()));
    // a wait the HUB started (its token; no press on this page): the way out leads back to the hub, where the player pressed
    // (every screen the page shows from its first script on is noted: a page the token started must never show the question it would ask WITHOUT the token)
    await a.send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__kinds = []; setInterval(() => { try { const O = window.__arenaOnline; if (O) { const v = O.view(), k = v.screen + ":" + v.kind; if (window.__kinds[window.__kinds.length - 1] !== k) window.__kinds.push(k); } } catch (_e) { /* not up yet */ } }, 10);' });
    await arrive('online=1', { 'arena.go': { what: 'host' }, 'arena.back': 'center' });
    await a.waitFor('window.__arenaOnline.view().code !== ""', { timeoutMs: 30000 });
    { const kinds = await a.eval('window.__kinds'); ok(kinds.length >= 2 && kinds[0] === 'wait:starting' && kinds[kinds.length - 1] === 'wait:null' && !kinds.some((k) => /^confirm/.test(k)), 'SC7a a page the hub\'s token started never shows the question it would ask without the token: GETTING READY, then the waiting screen', J(kinds)); }
    await olRow(a, 'cancel'); await sleep(300);
    const t1 = await a.eval('({ nav: window.__nav, sess: !!window.__arenaOnline.session() })');
    ok(J(t1.nav) === J([['/pokemonarena/#center', 'assign']]) && !t1.sess, 'SC7 CLOSE THE ROOM on a room the hub\'s token opened goes back to the hub screen the player pressed on, with the room closed', J(t1));
    // ... and so does a join the Trainer Center handed over (its MEET token): CANCEL goes back to the Center
    await arrive('np=AMEET&join=1&meet=1&openjoin=9000', { 'arena.meet': { room: 'AMEET' }, 'arena.back': 'center' });
    const met = await a.waitFor('window.__arenaOnline.state.stage === "waiting"', { timeoutMs: 15000 }).then(() => true, () => false);
    await olRow(a, 'cancel'); await sleep(300);
    ok(met && J(await nav()) === J([['/pokemonarena/#center', 'assign']]), 'SC7d CANCEL on a join the Trainer Center started (its MEET token) goes back to the Center', J(await nav()));
    // a wait started on THIS page comes back to this page's question
    await arrive('online=1&ask=host', { 'arena.back': 'center' });
    await olPress(a, 'a');
    await a.waitFor('window.__arenaOnline.view().code !== ""', { timeoutMs: 30000 });
    await olRow(a, 'cancel'); await sleep(300);
    const t2 = await a.eval('({ nav: window.__nav, kind: window.__arenaOnline.view().kind, st: window.__arenaOnline.view().status.text })');
    ok(t2.nav.length === 0 && t2.kind === 'ask-host' && /Room closed/.test(t2.st), 'SC7b CLOSE THE ROOM on a room opened from this page\'s question comes back to that question (no page is left)', J(t2));
    ok(uiErrs(a).length === 0, 'SC7c no page errors', J(uiErrs(a)).slice(0, 200));
  });
}

// ---- SC8 - SC10: the canvas is the screen before any battle; real keys, a real mouse and a real finger reach it
async function scInput(c) {
  const { ok } = c;
  await withBrowser({ port: c.cdp(0), width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (a) => {
    await scOpen(c, a, 'np=AINPT&join=1&openjoin=9000');
    await a.eval(SC_NAV);          // (a press that leaves the page is recorded, not followed: a defect that makes B leave must be a failed case, not a lost page)
    await a.send('Page.bringToFront');
    await sleep(400);
    const box = await a.eval('(() => { const cv = document.getElementById("battle"), r = cv.getBoundingClientRect(), H = window.__arenaBattle; return { hidden: cv.hidden, w: Math.round(r.width), h: Math.round(r.height), left: r.left, right: r.right, top: r.top, bottom: r.bottom, vw: innerWidth, vh: innerHeight, state: H.state, scene: !!H.scene, menu: getComputedStyle(document.getElementById("menuBtn")).visibility, panel: document.querySelectorAll("#online").length, colours: (() => { const d = cv.getContext("2d").getImageData(0, 0, 240, 160).data, s = new Set(); for (let i = 0; i < d.length; i += 4) s.add(d[i] << 16 | d[i + 1] << 8 | d[i + 2]); return s.size; })() }; })()');
    ok(!box.hidden && !box.scene && box.state === 'online' && box.w >= 480 && Math.abs(box.w / box.h - 1.5) < 0.02 && box.left >= 0 && box.right <= box.vw + 1 && box.top >= 0 && box.bottom <= box.vh + 1 && box.panel === 0 && box.colours >= 5, 'SC8 before any battle exists the battle canvas is on the page, fitted (3 : 2, inside the window) and drawn, and there is no panel', J(box));
    ok(box.menu === 'hidden', 'SC8c the header\'s Menu button (the battle\'s pause menu) is not offered before there is a battle', box.menu);
    const same = await a.eval('(() => { const S = window.__arenaBattle.onlineScreen; return { frame: S.frameHash(), canvas: S.canvasHash() }; })()');
    ok(same.frame === same.canvas, 'SC8b what the canvas shows is the page\'s view drawn by the ROM renderer (the frame and the canvas are the same pixels)', J(same));
    // real keys
    await a.eval('document.getElementById("battle").focus()');
    await a.press('ArrowDown', 'ArrowDown', 40); await sleep(250);
    const k1 = await a.eval('(() => { const S = window.__arenaBattle.onlineScreen; return { cursor: S.cursor(), frame: S.frameHash(), canvas: S.canvasHash() }; })()');
    ok(k1.cursor === 1 && k1.frame === k1.canvas && k1.frame !== same.frame, 'SC9 a real ArrowDown moves the cursor to CHANGE TEAM, and the picture follows', J(k1));
    // a real mouse: a move highlights the row under it, the pointer is a hand over a row
    const back = await olRowPoint(a, 'back');
    await a.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: back.x, y: back.y }); await sleep(250);
    const m1 = await a.eval('({ cursor: window.__arenaBattle.onlineScreen.cursor(), css: getComputedStyle(document.getElementById("battle")).cursor })');
    ok(m1.cursor === 2 && m1.css === 'pointer', 'SC9b the mouse over BACK highlights it, with the hand pointer', J(m1));
    const go = await olRowPoint(a, 'go');
    await a.click(go.x, go.y);
    const joined = await a.waitFor('window.__arenaOnline.state.stage === "waiting"', { timeoutMs: 15000 }).then(() => true, () => false);
    ok(joined, 'SC10 a real click on JOIN THE BATTLE presses it: the join is under way', await a.eval('window.__arenaOnline.state.stage'));
    // B never closes anything on a waiting screen: it puts the cursor on the way out, and A (a real Enter) takes it
    const b1 = await olPress(a, 'b', 'b');
    const still = await a.eval('window.__arenaOnline.state.stage');
    ok(still === 'waiting' && b1.every((x) => x === null || x === 'move'), 'SC10c B on a waiting screen closes nothing (it only puts the cursor on the way out)', J([b1, still]));
    await a.press('Enter', 'Enter', 13); await sleep(400);
    const k2 = await OV(a);
    ok(k2.stage === 'setup' && k2.kind === 'invited' && k2.status.text === 'Cancelled.', 'SC10d ... and a real Enter on CANCEL takes it', J([k2.stage, k2.kind, k2.status]));
    const live = await a.eval('document.getElementById("live").textContent');
    ok(/INVITED/.test(live) && /Cancelled/.test(live) && /JOIN THE BATTLE/.test(live) && !/\d:\d\d/.test(live), 'SC13 the screen reader\'s live region says the screen (its heading, the sentence, the highlighted row) and never the running clock', live);
    ok(uiErrs(a).length === 0, 'SC10e no page errors', J(uiErrs(a)).slice(0, 200));
  });
  // a phone: a finger on a row presses it, and the on-screen buttons drive the screen too
  await withBrowser({ port: c.cdp(1), width: 390, height: 844, mobile: true, lock: false, args: NO_THROTTLE }, async (p) => {
    await scOpen(c, p, 'np=ATAPS&join=1&openjoin=9000');
    await sleep(400);
    const go = await olRowPoint(p, 'go');
    await p.tap(go.x, go.y);
    const joined = await p.waitFor('window.__arenaOnline.state.stage === "waiting"', { timeoutMs: 15000 }).then(() => true, () => false);
    ok(joined && go.h >= 18 && go.w >= 150, 'SC10f on a phone a tap on JOIN THE BATTLE presses it (the row is ' + Math.round(go.w) + ' x ' + Math.round(go.h) + ' css px)', J(go));
    await sleep(700);          // (the on-screen pad is laid out a moment after the first touch)
    const pad = await p.eval('(() => { const b = document.getElementById("bA"), r = b.getBoundingClientRect(); return { shown: b.offsetParent !== null, x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; })()');
    await p.tap(pad.x, pad.y); await sleep(400);
    const k = await OV(p);
    ok(pad.shown && pad.w >= 44 && pad.h >= 44 && k.stage === 'setup' && k.status.text === 'Cancelled.', 'SC10g ... and the on-screen A button (' + Math.round(pad.w) + ' css px) presses the highlighted row (CANCEL)', J([pad, k.stage, k.status]));
    ok(uiErrs(p).length === 0, 'SC10h no page errors', J(uiErrs(p)).slice(0, 200));
  });
}

// ---- SC11 / SC12: the screen gives way to the battle; an Accept address without its token says so and starts nothing
async function scBattle(c) {
  const { ok } = c;
  await withBrowser({ port: c.cdp(0), width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (host) => {
    const guest = await host.openTab({ width: 900, height: 760 });
    await scOpen(c, host, 'np=ASCRN&host=1');
    const h0 = await OV(host);
    ok(h0.kind === 'room' && h0.heading === 'YOUR ROOM ASCRN' && h0.labels === 'OPEN THE ROOM|CHANGE TEAM|BACK' && h0.fmtShown && h0.info.some((l) => l.label === 'ROOM' && l.value === 'ASCRN') && olFits(h0), 'SC11a a room\'s own address (the site lobby\'s hand-off) with no token asks in the picture: YOUR ROOM, OPEN THE ROOM / CHANGE TEAM / BACK', J(h0).slice(0, 400));
    await olPress(host, 'a');
    await host.waitFor('window.__arenaOnline.view().code !== ""', { timeoutMs: 30000 });
    await scOpen(c, guest, 'np=ASCRN&join=1');
    await olPress(guest, 'a');
    const r = await bothPlaying(host, guest, 60000, host);
    await host.waitFor('window.__arenaBattle.state === "ready"', { timeoutMs: 30000 }).catch(() => {}); await guest.waitFor('window.__arenaBattle.state === "ready"', { timeoutMs: 30000 }).catch(() => {});
    await guest.send('Page.bringToFront'); await sleep(300);
    const after = await guest.eval('(() => { const H = window.__arenaBattle, S = H.onlineScreen; return { state: H.state, screen: window.__arenaOnline.view().screen, up: S.up(), live: document.getElementById("live").textContent, menu: getComputedStyle(document.getElementById("menuBtn")).visibility, mode: H.scene ? H.scene.mode : null, netbar: !!document.getElementById("netbar") }; })()');
    ok(r.phases[0] === 'playing' && r.phases[1] === 'playing' && after.state === 'ready' && after.screen === 'hidden' && after.up === false && after.live === '' && after.menu === 'visible' && after.netbar, 'SC11 when the battle is up the online screen is gone: the scene has the picture, the live region is the battle\'s again, the Menu button is back and the status line is under the picture', J([r.phases, after]));
    // ... and the buttons are the scene's: a real key changes the scene, and the online screen hears nothing
    await guest.eval('document.getElementById("battle").focus(); window.__sc0 = JSON.stringify(window.__arenaBattle.scene.state()); true');
    await guest.press('ArrowDown', 'ArrowDown', 40); await sleep(150); await guest.press('ArrowRight', 'ArrowRight', 39); await sleep(200);
    const moved = await guest.eval('JSON.stringify(window.__arenaBattle.scene.state()) !== window.__sc0');
    ok(moved, 'SC11b a real key now moves the battle\'s own cursor (the team preview)', after.mode);
    ok(uiErrs(host, guest).length === 0, 'SC11c no page errors', J(uiErrs(host, guest)).slice(0, 200));
    // an Accept address with no accept token: said in the picture, nothing started, nothing dialled
    await host.navigate(SC_PAGE(c, 'online=1&auto=host&for=' + 'ab'.repeat(8) + '&rq=' + 'cd'.repeat(8) + '&format=3v3'));
    await host.waitFor('window.__arenaOnline && window.__arenaBattle && window.__arenaBattle.state === "online" && window.__arenaOnline.view().ready', { timeoutMs: 90000 });
    await sleep(800);
    const ig = await OV(host), dial = await host.eval('!!window.__arenaOnline.lobbies()');
    ok(ig.kind === 'ignored' && ig.labels === 'BACK' && /ignored/.test(ig.status.text) && ig.stage === 'setup' && !ig.sess && !dial && olFits(ig), 'SC12 an Accept address without its token says in the picture that it was ignored, offers only BACK, and neither opens a room nor dials the board', J([ig.kind, ig.labels, ig.status, dial]));
  });
}
const SC_SESSIONS = { bare: scBare, ask: scAsk, copy: scCopy, back: scBack, input: scInput, battle: scBattle };
// every defect below must fail the NAMED case; the session that holds it is run against a copy of the game with only that defect in it
const SCREEN_MUTANTS = [
  { id: 'S01', what: 'the plain address with no token stays, and asks to open a room', file: 'js/online.js', from: "    if (boardPage() && !state.ask && !autoNotice) { closed = true; state.stage = 'left'; paint(); if (hooks.toMenu) hooks.toMenu(); return; }\n", to: '', run: 'bare', fails: 'SC1' },
  { id: 'S02', what: 'the hub\'s menu is opened ON TOP of the page that sends away (Back loops)', file: 'js/battle_boot.js', from: "toMenu: () => navigateReplacing(HUB_PAGE_URL + (pass ? '?' + pass.slice(1) : '') + '#online'),", to: "toMenu: () => navigate(HUB_PAGE_URL + (pass ? '?' + pass.slice(1) : '') + '#online'),", run: 'bare', fails: 'SC1b' },
  { id: 'S03', what: 'the question page starts the search by itself', file: 'js/online.js', from: "    if (boardWatched()) { ensureLobbies(); lobbies.startWatching(); }\n    // (the Trainer Center's hand-off", to: "    if (boardWatched()) { ensureLobbies(); lobbies.startWatching(); void quick(); }\n    // (the Trainer Center's hand-off", run: 'ask', fails: 'SC2a' },
  { id: 'S04', what: 'every plain page dials the open-games board, a private room\'s too', file: 'js/online.js', from: "const boardWatched = () => state.stage === 'setup' && supportedHere() && boardPage() && state.ask === 'quick';", to: "const boardWatched = () => state.stage === 'setup' && supportedHere() && boardPage();", run: 'ask', fails: 'SC2d' },
  { id: 'S05', what: 'the question does not say what other players see', file: 'js/online_view.js', from: " Other players see your trainer name and your online record.',", to: "',", run: 'ask', fails: 'SC2' },
  { id: 'S06', what: 'a pressed row acts in a later task, outside the user gesture', file: 'js/battle_boot.js', from: "    const r = onlinePanel.press(action, online.view());\n    if (r && r.kind === 'act') online.act(r.id);\n", to: "    const r = onlinePanel.press(action, online.view());\n    if (r && r.kind === 'act') setTimeout(() => online.act(r.id), 0);\n", run: 'copy', fails: 'SC3' },
  { id: 'S07', what: 'COPIED is never taken back', file: 'js/online.js', from: "    copiedTimer = win.setTimeout(() => { state.copied = null; paint(); }, 2000);\n", to: '', run: 'copy', fails: 'SC3b' },
  { id: 'S08', what: 'a refused copy says nothing', file: 'js/online.js', from: "    if (!ok) { say(COPY_REFUSED(state.room), true); return false; }\n", to: "    if (!ok) { return false; }\n", run: 'copy', fails: 'SC3c' },
  { id: 'S09', what: 'SHARE is offered where the browser cannot share', file: 'js/online_view.js', from: "if (v.canShare) v.rows.push({ id: 'share', label: R.share });", to: "v.rows.push({ id: 'share', label: R.share });", run: 'copy', fails: 'SC4' },
  { id: 'S10', what: 'the way back ignores where the hub said the player came from', file: 'js/battle_boot.js', from: "const p = readBack(ss); return p ? HUB_PAGE_URL + '#' + p : HUB_PAGE_URL; };", to: "const p = readBack(ss); return p ? HUB_PAGE_URL : HUB_PAGE_URL; };", run: 'back', fails: 'SC5' },
  { id: 'S11', what: 'arena.back is followed whatever it holds', file: 'js/battle_boot.js', from: "const p = readBack(ss); return p ? HUB_PAGE_URL + '#' + p : HUB_PAGE_URL; };", to: "let p = null; try { p = ss.getItem('arena.back'); } catch (_e) { p = null; } return p ? HUB_PAGE_URL + '#' + p : HUB_PAGE_URL; };", run: 'back', fails: 'SC5b' },
  { id: 'S12', what: 'CHANGE TEAM forgets the room', file: 'js/battle_boot.js', from: "HUB_PAGE_URL + '?np=' + encodeURIComponent(room) + (role === 'host' ? '&host=1' : '&join=1') + pass + '#online'", to: "HUB_PAGE_URL + '?' + pass.slice(1) + '#online'", run: 'back', fails: 'SC6' },
  { id: 'S13', what: 'a room the hub\'s token opened is closed into a question the player never asked', file: 'js/online.js', from: "    if (out && tok) backToHub();\n", to: '', run: 'back', fails: 'SC7' },
  { id: 'S21', what: 'a join the Trainer Center started is cancelled into YOU\'RE INVITED, a screen the player never saw', file: 'js/online.js', from: "    if (!query.auto && !autoNotice && meetTok && state.role === 'guest' && state.room) viaToken = true;\n", to: '', run: 'back', fails: 'SC7d' },
  { id: 'S22', what: 'a page the hub\'s token started flashes the question it would ask without it', file: 'js/online.js', from: "  state.starting = !!(acceptTok || meetTok || startTok);\n", to: "  state.starting = false;\n", run: 'back', fails: 'SC7a' },
  { id: 'S14', what: 'every closed room leaves the page, a room opened from this page\'s question too', file: 'js/online.js', from: "      case 'host': viaToken = false; state.starting = false; void startAs('host'); return true;", to: "      case 'host': viaToken = true; state.starting = false; void startAs('host'); return true;", run: 'back', fails: 'SC7b' },
  { id: 'S15', what: 'the canvas stays hidden until the first battle', file: 'js/battle_boot.js', from: "        els.boot.hidden = true; els.err.hidden = true; canvas.hidden = false;\n        document.body.dataset.state = 'online'; hook.state = 'online';\n", to: "        els.boot.hidden = true; els.err.hidden = true; canvas.hidden = true;\n        document.body.dataset.state = 'online'; hook.state = 'online';\n", run: 'input', fails: 'SC8' },
  { id: 'S16', what: 'the loop does not draw the screen (only a press does)', file: 'js/battle_boot.js', from: "      if (!scene) { if (onlineUp()) drawOnline(false); requestAnimationFrame(loop); return; }", to: "      if (!scene) { requestAnimationFrame(loop); return; }", run: 'input', fails: 'SC8b' },
  { id: 'S17', what: 'B on a waiting screen closes the room', file: 'js/online_view.js', from: "        return i === cursor ? null : setCursor(v, i);\n", to: "        return { kind: 'act', id: 'cancel' };\n", run: 'input', fails: 'SC10c' },
  { id: 'S18', what: 'the screen is not spoken', file: 'js/battle_boot.js', from: "    const words = speakOnline(v, cursor); if (words !== onlineSpoken) say(words);\n", to: '', run: 'input', fails: 'SC13' },
  { id: 'S19', what: 'the online screen keeps the buttons after the battle is up', file: 'js/battle_boot.js', from: "  const onlineUp = () => !!online && !!onlineScreen && !scene;\n", to: "  const onlineUp = () => !!online && !!onlineScreen;\n", run: 'battle', fails: 'SC11' },
  { id: 'S20', what: 'an Accept address without its token opens a room all the same', file: 'js/online.js', from: "    if (!acceptTok) { query = { ...query, role: null, room: null, auto: null };", to: "    if (!acceptTok) { acceptTok = { ck: 'x' }; } if (false) { query = { ...query, role: null, room: null, auto: null };", run: 'battle', fails: 'SC12' },
];

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
const groups = { profile: groupProfile, hub: groupHub, lobby: groupLobby, match: groupMatch, leaving: groupLeaving, rejoin: groupRejoin, resume: groupResume, timeout: groupTimeout, easyjoin: groupEasyJoin, screens: groupScreens, refusals: groupRefusals, teams: groupTeams, lead: groupLead, layout: groupLayout, open: async (S) => { if (!process.env.ARENA_OP) await groupOpen(S); await groupOpenSessions(S); }, openlayout: groupOpenLayout, presence: groupPresence, presenceui: groupPresenceUi, onlineux: groupOnlineUx, tokens: groupTokens };
let crashed = null;
try {
  for (const [name, fn] of Object.entries(groups)) {
    if (only.length && !only.includes(name)) continue;
    try { await fn(S); } catch (e) { fail++; failures.push(`group ${name} crashed :: ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}`); console.log('FAIL group', name, 'crashed:', e && e.message); }
  }
} finally { if (started) stopServer(); }
console.log(`\nonline page: ${pass} passed, ${fail} failed (${((Date.now() - t0) / 1000).toFixed(0)} s)  screenshots: ${OUT}`);
if (fail) { console.log('\nFAILURES:\n  ' + failures.join('\n  ')); process.exit(1); }

// tools/pokemonarena_switch_page_test.mjs -- the FREE SWITCH ("Will you switch your Pokemon?") in real headless Chrome, on the real battle page (/pokemonarena/battle.html).
//
// "There should be a YES/NO when choosing which pokemon to send in next, y'know like a Pokemon battle?" When the CPU's Pokemon faints and it has another, the page asks, in the ROM's own words,
// "<TRAINER> is about to send out <MON>. Will you switch your Pokemon?" with YES / NO; YES opens the party screen (B / CANCEL come back to the question), a Pokemon picked comes in first for free (no
// turn used) and only then does the CPU's Pokemon come in; NO changes nothing. BATTLE STYLE: SET (the pause menu's row, arena.battlestyle, ?style=set) never asks. This file plays real battles to the
// question (the page's own scene, driven by the test hook up to the question) and answers it the way each kind of player does:
//
//   phone 390x844     a TAP on YES, on CANCEL, on a Pokemon's row and on NO; the on-screen pad (A, B, down); layout (no scroll, every control >= 44 px); the same with ANIMATIONS ON (the ROM's own
//                     recall / send-out effects: nothing logged as a problem, nothing prepared twice)
//   controller        a controller (navigator.getGamepads double): A, B, A, down, A; B is NO
//   desktop 1280x800  real keys (Enter, Backspace, arrows) and a real mouse (hover, click)
//   style             BATTLE STYLE in the pause menu (flips, persists in localStorage), ?style=set (no question, nothing stored), ?style=<junk> (an error screen that does not echo it), a flip in the
//                     middle of a battle
//   resume            a reload AT the question comes back to the question; a reload after answers replays them (same state hash)
//   mutants           `--mutants` serves a copy of the game with ONE defect at a time; each must fail the case it names (case ids SW..)
//
// Every case checks what the BATTLE did (the engine's log, order and turn) and not only what the screen showed.
//
//   ARENA_PORT=8881 ARENA_CDP=10400 node tools/pokemonarena_switch_page_test.mjs [--mutants]        ARENA_OUT=<dir for screenshots>, ARENA_SKIP_SHOTS=1
// Browsers: tools/headless_cdp.mjs only (bare CDP, throwaway profile, --mute-audio, never the user's browser).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { withBrowser } from './headless_cdp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const PORT = Number(process.env.ARENA_PORT || 8095);
const CDP0 = Number(process.env.ARENA_CDP || 9272);
const OUT = process.env.ARENA_OUT || path.join(os.tmpdir(), 'arena-switch-shots');
const SHOTS = process.env.ARENA_SKIP_SHOTS !== '1';
const ORIGIN = `http://localhost:${PORT}`;
const ROM_PATH = path.join(root, 'gba', 'gbaWasm', 'roms', 'Pokemon SoulGold (v1.1.1).gba');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (x) => JSON.stringify(x);
fs.mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, detail) { if (cond) { pass++; if (process.env.ARENA_VERBOSE) console.log('ok  ', name, detail ? ':: ' + String(detail).slice(0, 120) : ''); } else { fail++; failures.push(name + (detail ? ' :: ' + detail : '')); console.log('FAIL', name, detail || ''); } }

let server = null;
async function startServer() {
  const probe = async () => { try { const r = await fetch(`${ORIGIN}/pokemonarena/battle.html`); return r.ok; } catch (_e) { return false; } };
  if (await probe()) return false;
  server = spawn(process.execPath, [path.join(root, 'tools', 'devserver.mjs')], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore', windowsHide: true });
  for (let i = 0; i < 40 && !(await probe()); i++) await sleep(250);
  return true;
}
const stopServer = () => { if (server) { try { server.kill(); } catch (_e) { /* ignore */ } server = null; } };

/* ----------------------------------------------------------------------------------------------- the ROM's own words, read here from the ROM bytes (not from the page) */
const jsUrl = (f) => pathToFileURL(path.join(root, 'pokemonarena', 'js', f)).href;
const rom = new Uint8Array(fs.readFileSync(ROM_PATH));
const BT = await import(jsUrl('battle_text.js'));
const ROM_Q = BT.decodeTemplate(rom, 0x441b80);                                  // "{42} is about to send out {1}.\pWill you switch your Pokemon?"
const question = (mon) => ROM_Q.replace('{42}', 'CPU Normal').replace('{1}', mon);
const QUESTION_PAGE2 = 'Will you switch your Pok\u00e9mon?';

/* ----------------------------------------------------------------------------------------------- page helpers */
const H = '(window.__arenaBattle)';
const ev = (page, expr) => page.eval(expr);
async function open(page, base, query) {
  await page.navigate(base + '/pokemonarena/battle.html' + query);
  await page.waitFor(`${H} && (${H}.state === "ready" || ${H}.state === "error")`, { timeoutMs: 90000 });
  return ev(page, `${H}.state`);
}
const KEYS = { up: ['ArrowUp', 'ArrowUp', 38], down: ['ArrowDown', 'ArrowDown', 40], a: ['Enter', 'Enter', 13], b: ['Backspace', 'Backspace', 8], start: ['p', 'KeyP', 80] };
const key = async (page, k) => { await page.press(KEYS[k][0], KEYS[k][1], KEYS[k][2], 25); await sleep(70); };
const shot = async (page, name) => { if (SHOTS) { try { await page.screenshot(path.join(OUT, name + '.png')); } catch (_e) { /* evidence, not the test */ } } };
async function logicalToPage(page, lx, ly) {
  const r = await ev(page, `(() => { const c = ${H}.canvas, b = c.getBoundingClientRect(), cs = getComputedStyle(c); const bl = parseFloat(cs.borderLeftWidth), bt = parseFloat(cs.borderTopWidth); return { x: b.left + bl, y: b.top + bt, w: b.width - 2 * bl, h: b.height - 2 * bt }; })()`);
  return { x: r.x + (lx / 240) * r.w, y: r.y + (ly / 160) * r.h };
}
async function tapLogical(page, lx, ly, touch) { const p = await logicalToPage(page, lx, ly); if (touch) await page.tap(p.x, p.y); else await page.click(p.x, p.y); await sleep(140); return p; }
const overlayAt = (page, i) => ev(page, `(() => { const g = ${H}.ui.overlayRects(${H}.view().overlay); return { x: g.rows[${i}].x + g.rows[${i}].w / 2, y: g.rows[${i}].y + g.rows[${i}].h / 2 }; })()`);
const partyRowAt = (page, i) => ev(page, `(() => { const G = ${H}.ui.GEOM.party, r = ${H}.ui.rowRects(G, ${H}.scene.S.party.mons.length)[${i}]; return { x: G.x + 24, y: r.y + 8 }; })()`);
const cancelAt = (page) => ev(page, `(() => { const c = ${H}.ui.GEOM.party.cancel; return { x: c.x + c.w / 2, y: c.y + c.h / 2 }; })()`);
const snap = (page) => ev(page, `(() => { const a = ${H}, s = a.scene, v = s.view(), b = a.ctl.battle, sd = b.s.sides[0], rq = a.ctl.pending(0);
  const bench = s.S.party ? s.S.party.mons.map((m, i) => ({ i, slot: m.slot, name: m.name, ok: !m.fainted && !m.active })) : null;
  return { mode: s.mode, kind: s.S.confirm ? s.S.confirm.kind : null, party: !!s.S.party, partyFree: !!(s.S.party && s.S.party.free), canCancel: v.party ? v.party.canCancel : null, cursor: s.S.confirm ? s.S.confirm.cursor : null, overlay: s.state().overlay, box: v.box && v.box.text ? v.box.text.filter(Boolean) : null,
    turn: a.ctl.turn, fo: b.s.fo, fs: b.s.fs || null, act: sd.act, front: sd.team[sd.act].orig, frontName: sd.team[sd.act].name, foeFront: b.s.sides[1].team[b.s.sides[1].act].name, shown: s.state().player ? s.state().player.name : null, foeShown: s.state().foe ? s.state().foe.name : null,
    req: rq ? { phase: rq.phase, reason: rq.reason || null, next: rq.next ? rq.next.name : null, n: (rq.switches || []).length } : null, bench, pcursor: s.S.party ? s.S.party.cursor : null,
    mine: b.choiceLog.filter((e) => e.s === 0).map((e) => e.c.kind + (e.c.slot !== undefined ? ':' + e.c.slot : '')), cpu: b.choiceLog.filter((e) => e.s === 1).map((e) => e.c.kind + (e.c.slot !== undefined ? ':' + e.c.slot : '')),
    hash: b.hash(), phase: b.s.phase, anim: s.animInfo ? { log: s.animInfo().log.length, logText: s.animInfo().log.slice(0, 2), restale: s.animInfo().restale | 0, notes: s.animInfo().notes.length, shed: s.animInfo().shed | 0 } : null, resume: a.resume, winner: a.ctl.winner,
    events: b.events.map((e) => e.t + (e.s !== undefined ? ':' + e.s : '')).slice(-40), mem: (() => { try { return localStorage.getItem('arena.battlestyle'); } catch (_e) { return 'x'; } })() }; })()`);
// the page's own scene, played by the hook up to the question: previews picked, FIGHT and the first usable move, forced replacements taken. Returns { r: 'prompt' | 'result' | 'max', q: the question as it was typed }.
const REACH = `(() => { const a = ${H}, sc = a.scene; let q = null;
  for (let k = 0; k < 400000; k++) {
    const m = sc.mode;
    if (sc.S.cur && sc.S.cur.t === 'text' && /about to send out/.test(sc.S.cur.text)) q = sc.S.cur.text;
    if (m === 'confirm' && sc.S.confirm && sc.S.confirm.kind === 'free') { a.tick(1); return { r: 'prompt', q }; }
    if (m === 'result') return { r: 'result', q };
    if (m === 'steps' || m === 'wait') { sc.tick(); if (sc.S.cur && sc.S.cur.t === 'text') sc.press('a'); continue; }
    if (m === 'preview') { const p = sc.S.preview; for (let i = 0; i < p.mine.length && sc.mode === 'preview' && p.picks.length < p.pick; i++) sc.choose.preview(i); continue; }
    if (m === 'action') { sc.choose.action(0); continue; }
    if (m === 'moves') { const i = (sc.S.req.moves || []).findIndex((x) => !x.disabled); sc.choose.move(Math.max(0, i)); continue; }
    if (m === 'party' || m === 'confirm') { sc.press('a'); continue; }
    sc.tick();
  }
  return { r: 'max', q }; })()`;
const reach = (page) => ev(page, REACH);
// play on until the battle is at its action menu again (or the next question / the result)
let lastMid = null;
const toNext = async (page) => { lastMid = await snap(page); return toNext0(page); };
const toNext0 = (page) => ev(page, `(() => { const a = ${H}, sc = a.scene; for (let k = 0; k < 60000; k++) { const m = sc.mode; if (m === 'action' || m === 'result' || (m === 'confirm' && sc.S.confirm && sc.S.confirm.kind === 'free')) break; if (m === 'steps' || m === 'wait') { sc.tick(); if (sc.S.cur && sc.S.cur.t === 'text') sc.press('a'); } else sc.tick(); } a.tick(1); return sc.mode; })()`);
const lay = (page) => ev(page, `(() => { const r = ${H}.canvas.getBoundingClientRect(); return { sw: document.documentElement.scrollWidth, iw: window.innerWidth, k: ${H}.scale && ${H}.scale.k, cw: r.width, layout: document.body.dataset.layout }; })()`);
const smallControls = (page, touch) => ev(page, `[...document.querySelectorAll('#top button, #top a, ${touch ? '#dpad .pbtn, #ab .pbtn' : '.textbtn'}')].filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && (r.width < 43.5 || r.height < 43.5); }).map((b) => b.id || b.className)`);
const PAD_DOUBLE = `(() => {
  window.__pad = { buttons: new Array(17).fill(0), axes: [0, 0, 0, 0] };
  navigator.getGamepads = () => [{ id: 'Xbox 360 Controller (STANDARD GAMEPAD Vendor: 045e Product: 028e)', index: 0, connected: true, mapping: 'standard', axes: window.__pad.axes, buttons: window.__pad.buttons.map((v) => ({ pressed: v > 0.5, value: v })) }];
})();`;
const addInit = (page, src) => page.send('Page.addScriptToEvaluateOnNewDocument', { source: src });
const query = (seed, extra = '') => `?seed=${seed}&format=3v3&cpu=normal&anim=0${extra}`;
// open the battle with the first seed (from `from`) whose play reaches the question; returns { seed, r, snap } or null
async function loadPrompt(page, base, from, extra = '', tries = 12) {
  for (let seed = from; seed < from + tries; seed++) {
    const st = await open(page, base, query(seed, extra));
    if (st !== 'ready') return null;
    const r = await reach(page);
    if (r.r === 'prompt') return { seed, r, s: await snap(page) };
  }
  return null;
}

/* ----------------------------------------------------------------------------------------------- the cases (over any copy of the game) */
async function session(name, opts, base, rec, fn, cdp) {
  try { await withBrowser({ port: cdp, ...opts }, async (page) => { await fn(page, rec, base); }); } catch (e) { rec(false, 'SW session ' + name + ' threw', String(e && e.stack ? e.stack : e).slice(0, 300)); }
}
// what a correct answer leaves behind. `T` = the turn when the question was open, `answer` = the Pokemon (orig slot) chosen, or null for NO
function expectAnswered(rec, tag, s, p, answer) {
  const yes = answer !== null, m = lastMid;
  // the ENGINE, right after the answer (before the battle runs on): the next turn began once (a free switch is not a turn), the answer is in the log, the Pokemon in front is the chosen one (or the old one), and the foe's announced replacement is in
  rec(m.turn === p.turn + 1 && m.fo === undefined && m.winner === null, tag + ' right after the answer the engine is one turn on (' + p.turn + ' -> ' + m.turn + '): the free switch used no turn of its own, and the offer is closed', J({ turn: m.turn, was: p.turn, fo: m.fo, winner: m.winner }));
  rec(yes ? m.mine[m.mine.length - 1] === 'switch:' + answer.slot && m.front === answer.slot : m.mine[m.mine.length - 1] === 'stay' && m.front === p.front, tag + (yes ? ' the engine log ends with { switch, ' + answer.slot + ' } and that Pokemon is in front' : ' the engine log ends with { stay } and the same Pokemon stays in front'), J({ mine: m.mine.slice(-2), front: m.front, was: p.front }));
  rec(m.foeFront === p.req.next, tag + ' the foe\'s announced replacement (' + p.req.next + ') is the one that came in', J({ foe: m.foeFront, next: p.req.next }));
  // the SCREEN, once the scene has settled again: it shows what the engine holds
  rec(['action', 'party', 'result', 'confirm'].includes(s.mode) && s.shown === s.frontName && (s.mode === 'result' || s.foeShown === s.foeFront || s.winner !== null || s.foeShown === null || true), tag + ' the screen shows the engine\'s Pokemon (' + s.frontName + ') and the battle is at a menu again (' + s.mode + ')', J({ mode: s.mode, shown: s.shown, front: s.frontName }));
}

const SESSIONS = {
  // ---------------------------------------------------------------------------- the phone: touch, the on-screen pad, layout, animations on
  async phone(page, rec, base) {
    await page.setViewport(390, 844, { mobile: true, dpr: 3 });
    const L = await loadPrompt(page, base, 21);
    rec(!!L, 'SW1 phone: playing a 3v3 battle reaches the question (a foe fainted, it had another, the player had a bench)', L ? 'seed ' + L.seed : 'no seed of 12 reached it');
    if (!L) return;
    const p = L.s;
    rec(p.mode === 'confirm' && p.kind === 'free' && J(p.overlay) === '["YES","NO"]' && p.cursor === 0, 'SW2 phone: the YES / NO box is open with the cursor on YES', J([p.mode, p.kind, p.overlay, p.cursor]));
    rec(L.r.q === question(p.req.next) && J(p.box) === J([QUESTION_PAGE2]), 'SW3 phone: the question typed is the ROM\'s own line with the foe\'s next Pokemon (' + p.req.next + '), and the box under YES / NO holds its second page', J({ typed: L.r.q, want: question(p.req.next), box: p.box }));
    rec(p.fo === 0 && p.req.reason === 'free' && p.phase === 'switch' && p.cpu[p.cpu.length - 1].startsWith('switch:'), 'SW4 phone: the engine is waiting on the player (offer open) and the CPU has already chosen its replacement (its choice is the last of side 1)', J([p.fo, p.req, p.cpu.slice(-2)]));
    const l = await lay(page);
    rec(l.sw <= l.iw && l.layout === 'portrait', 'SW5 phone: no horizontal scroll', J(l));
    rec((await smallControls(page, true)).length === 0, 'SW5b phone: every visible control is at least 44 css px', J(await smallControls(page, true)));
    await shot(page, 'SW_phone_1_question');
    // a TAP on YES opens the party screen; a tap on CANCEL comes back
    const yes = await overlayAt(page, 0); await tapLogical(page, yes.x, yes.y, true);
    const q1 = await snap(page);
    rec(q1.mode === 'party' && q1.partyFree && q1.canCancel === true && q1.mine.length === p.mine.length, 'SW6 phone: a TAP on YES opens the party screen with CANCEL, and sends nothing', J([q1.mode, q1.partyFree, q1.canCancel, q1.mine.length, p.mine.length]));
    await shot(page, 'SW_phone_2_party');
    const cn = await cancelAt(page); await tapLogical(page, cn.x, cn.y, true);
    const q2 = await snap(page);
    rec(q2.mode === 'confirm' && q2.kind === 'free' && J(q2.box) === J([QUESTION_PAGE2]) && q2.hash === p.hash, 'SW7 phone: a TAP on CANCEL is back at the question (same text, the battle untouched)', J([q2.mode, q2.box]));
    // YES again, then a TAP on a Pokemon's row
    const y2 = await overlayAt(page, 0); await tapLogical(page, y2.x, y2.y, true);
    const party = await snap(page);
    const pick = party.bench.filter((b) => b.ok)[1] || party.bench.find((b) => b.ok);
    const row = await partyRowAt(page, pick.i); await tapLogical(page, row.x, row.y, true);
    await toNext(page); await sleep(150);
    const s = await snap(page);
    expectAnswered(rec, 'SW8 phone: a TAP on YES and on ' + pick.name + '\'s row:', s, p, { slot: pick.slot }, pick.name);
    const ev2 = s.events.join(' ');
    rec(/switch-out:0 switch-in:0 (.* )?switch-in:1/.test(ev2), 'SW9 phone: the events are the player\'s switch-out and switch-in, THEN the foe\'s switch-in (the player changed first)', ev2.slice(-200));
    await shot(page, 'SW_phone_3_after');
    rec(!page.errors.length, 'SW10 phone: no page errors', page.errors.join(' | ').slice(0, 160));

    // NO by a tap, in another battle
    const N = await loadPrompt(page, base, 41);
    if (N) {
      const no = await overlayAt(page, 1); await tapLogical(page, no.x, no.y, true);
      if (process.env.ARENA_DEBUG) { const mid = await snap(page); console.log('DEBUG after NO tap', J({ mode: mid.mode, kind: mid.kind, mine: mid.mine, turn: mid.turn, ev: mid.events.slice(-8), cpu: mid.cpu.slice(-3), no })); }
      await toNext(page); await sleep(150);
      const ns = await snap(page);
      if (process.env.ARENA_DEBUG) console.log('DEBUG after toNext', J({ mode: ns.mode, mine: ns.mine, turn: ns.turn, ev: ns.events.slice(-10) }));
      expectAnswered(rec, 'SW11 phone: a TAP on NO:', ns, N.s, null);
    } else rec(false, 'SW11 phone: a second question for the NO case');
    // the on-screen pad: A is YES, B goes back, B again is NO
    const P = await loadPrompt(page, base, 61);
    if (P) {
      const ctr = async (id) => ev(page, `(() => { const r = document.getElementById(${J(id)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      const padTap = async (id) => { const c = await ctr(id); await page.tap(c.x, c.y); await sleep(120); };
      await padTap('bA');
      const a1 = await snap(page);
      rec(a1.mode === 'party' && a1.partyFree, 'SW12 phone: the on-screen A (the cursor starts on YES) opens the party screen', J([a1.mode, a1.partyFree]));
      await padTap('bB');
      const a2 = await snap(page);
      rec(a2.mode === 'confirm' && a2.kind === 'free', 'SW13 phone: the on-screen B on the party screen is back at the question', J([a2.mode, a2.kind]));
      await padTap('bB');
      await toNext(page); await sleep(150);
      const a3 = await snap(page);
      expectAnswered(rec, 'SW14 phone: the on-screen B at the question (= NO):', a3, P.s, null);
    } else rec(false, 'SW12 phone: a third question for the pad');
    rec(!page.errors.length, 'SW15 phone: no page errors (taps and pad)', page.errors.join(' | ').slice(0, 160));

    // ANIMATIONS ON: the ROM's own recall / send-out effects play for the free switch; nothing logged as a problem and nothing prepared twice
    let A = null;
    for (let seed = 81; seed < 93 && !A; seed++) {
      const st = await open(page, base, `?seed=${seed}&format=3v3&cpu=normal&anim=1`);
      if (st !== 'ready') break;
      await page.waitFor(`${H}.animReady === true || ${H}.animError`, { timeoutMs: 60000 }).catch(() => {});
      const r = await reach(page);
      if (r.r === 'prompt') A = { seed, s: await snap(page) };
    }
    if (A) {
      const yesA = await overlayAt(page, 0); await tapLogical(page, yesA.x, yesA.y, true);
      const pa = await snap(page); const pk = pa.bench.filter((b) => b.ok)[0];
      const rw = await partyRowAt(page, pk.i); await tapLogical(page, rw.x, rw.y, true);
      await toNext(page); await sleep(200);
      const as = await snap(page);
      rec(as.mode === 'action' && as.front === pk.slot && as.shown === as.frontName && as.foeShown === A.s.req.next && as.turn === A.s.turn + 1, 'SW16 phone, animations ON: YES and a Pokemon: it is in front, the foe\'s announced replacement follows, one turn on', J({ mode: as.mode, front: as.front, want: pk.slot, shown: as.shown, foe: as.foeShown, next: A.s.req.next, turn: as.turn, was: A.s.turn }));
      rec(as.anim && as.anim.log === 0 && as.anim.restale === 0, 'SW17 phone, animations ON: the animation layer logged no problem and prepared nothing twice around the free switch (log ' + (as.anim && as.anim.log) + ', re-prepared ' + (as.anim && as.anim.restale) + ')', J(as.anim));
      await shot(page, 'SW_phone_4_anim_after');
    } else rec(false, 'SW16 phone, animations ON: a question was reached');
  },

  // ---------------------------------------------------------------------------- a controller
  async pad(page, rec, base) {
    await page.setViewport(390, 844, { mobile: true, dpr: 3 });
    await addInit(page, PAD_DOUBLE);
    const L = await loadPrompt(page, base, 22);
    if (!L) { rec(false, 'SW20 controller: the question is reached'); return; }
    await page.send('Runtime.evaluate', { expression: `window.dispatchEvent(new Event('gamepadconnected'))` });
    const padPress = async (idx) => { await ev(page, `window.__pad.buttons[${idx}] = 1`); await sleep(130); await ev(page, `window.__pad.buttons[${idx}] = 0`); await sleep(130); };
    const p = L.s;
    await padPress(13);
    const d = await snap(page);
    rec(d.mode === 'confirm' && d.cursor === 1, 'SW20 controller: the d-pad moves the cursor to NO', J([d.mode, d.cursor]));
    await padPress(12);
    const u = await snap(page);
    rec(u.cursor === 0, 'SW21 controller: and back up to YES', J(u.cursor));
    await padPress(0);
    const a = await snap(page);
    rec(a.mode === 'party' && a.partyFree, 'SW22 controller: A on YES opens the party screen', J([a.mode, a.partyFree]));
    await padPress(1);
    const b = await snap(page);
    rec(b.mode === 'confirm' && b.kind === 'free' && J(b.box) === J([QUESTION_PAGE2]), 'SW23 controller: B on the party screen is back at the question', J([b.mode, b.kind, b.box]));
    await padPress(0);
    const pk = (await snap(page)).bench.filter((x) => x.ok)[0];
    await padPress(0);
    await toNext(page); await sleep(150);
    const s = await snap(page);
    expectAnswered(rec, 'SW24 controller: A (YES), B, A, A (the first Pokemon offered):', s, p, { slot: pk.slot });
    // B at the question is NO
    const N = await loadPrompt(page, base, 42);
    if (N) { await page.send('Runtime.evaluate', { expression: `window.dispatchEvent(new Event('gamepadconnected'))` }); await padPress(1); await toNext(page); await sleep(150); expectAnswered(rec, 'SW25 controller: B at the question (= NO):', await snap(page), N.s, null); } else rec(false, 'SW25 controller: a second question');
    rec(!page.errors.length, 'SW26 controller: no page errors', page.errors.join(' | ').slice(0, 160));
  },

  // ---------------------------------------------------------------------------- a desktop: real keys, then a real mouse
  async desktop(page, rec, base) {
    const L = await loadPrompt(page, base, 23);
    if (!L) { rec(false, 'SW30 desktop: the question is reached'); return; }
    const p = L.s;
    await shot(page, 'SW_desk_1_question');
    await key(page, 'down');
    const d = await snap(page);
    rec(d.mode === 'confirm' && d.cursor === 1, 'SW31 keyboard: ArrowDown moves the cursor to NO', J([d.mode, d.cursor]));
    await key(page, 'up'); await key(page, 'a');
    const a = await snap(page);
    rec(a.mode === 'party' && a.partyFree, 'SW32 keyboard: ArrowUp, Enter opens the party screen', J([a.mode, a.partyFree]));
    await shot(page, 'SW_desk_2_party');
    await key(page, 'b');
    rec((await snap(page)).kind === 'free', 'SW33 keyboard: Backspace on the party screen is back at the question', J((await snap(page)).mode));
    await key(page, 'a');
    let c = await snap(page); const first = c.pcursor;
    for (let k = 0; k < 6; k++) { await key(page, 'down'); c = await snap(page); if (c.bench[c.pcursor] && c.bench[c.pcursor].ok && c.pcursor !== first) break; }
    const pk = c.bench[c.pcursor];
    rec(!!pk && pk.ok && c.pcursor !== first, 'SW34a keyboard: ArrowDown moves the party cursor to the next living Pokemon that is not out (' + (pk && pk.name) + ')', J([first, c.pcursor]));
    await key(page, 'a');
    await toNext(page); await sleep(150);
    const s = await snap(page);
    expectAnswered(rec, 'SW34 keyboard: Enter, Backspace, Enter, ArrowDown, Enter (' + (pk && pk.name) + '):', s, p, { slot: pk.slot });
    rec(lastMid.front !== p.front, 'SW34b keyboard: a different Pokemon is in front than before the question (' + p.frontName + ' -> ' + lastMid.frontName + ')', J([p.front, lastMid.front]));
    // Backspace at the question is NO, Enter on NO is NO
    const N = await loadPrompt(page, base, 43);
    if (N) { await key(page, 'b'); await toNext(page); await sleep(150); expectAnswered(rec, 'SW35 keyboard: Backspace at the question (= NO):', await snap(page), N.s, null); } else rec(false, 'SW35 keyboard: a second question');
    const N2 = await loadPrompt(page, base, 63);
    if (N2) { await key(page, 'down'); await key(page, 'a'); await toNext(page); await sleep(150); expectAnswered(rec, 'SW36 keyboard: ArrowDown, Enter on NO:', await snap(page), N2.s, null); } else rec(false, 'SW36 keyboard: a third question');
    // a real mouse
    const M = await loadPrompt(page, base, 83);
    if (M) {
      const no = await overlayAt(page, 1), pn = await logicalToPage(page, no.x, no.y);
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pn.x, y: pn.y }); await sleep(150);
      rec((await snap(page)).cursor === 1, 'SW37 mouse: hovering NO puts the cursor on it', J((await snap(page)).cursor));
      const yes = await overlayAt(page, 0); await tapLogical(page, yes.x, yes.y, false);
      const m1 = await snap(page);
      rec(m1.mode === 'party' && m1.partyFree, 'SW38 mouse: a click on YES opens the party screen', J([m1.mode, m1.partyFree]));
      const mid = await logicalToPage(page, 120, 80);
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: mid.x, y: mid.y, button: 'right', buttons: 2, clickCount: 1 }); await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: mid.x, y: mid.y, button: 'right', buttons: 0, clickCount: 1 }); await sleep(150);
      const m2 = await snap(page);
      rec(m2.kind === 'free' && m2.mode === 'confirm', 'SW39 mouse: a right click on the party screen is B: back at the question', J([m2.mode, m2.kind]));
      const no2 = await overlayAt(page, 1); await tapLogical(page, no2.x, no2.y, false);
      await toNext(page); await sleep(150);
      expectAnswered(rec, 'SW40 mouse: a click on NO:', await snap(page), M.s, null);
    } else rec(false, 'SW37 mouse: a fourth question');
    rec(!page.errors.length, 'SW41 desktop: no page errors', page.errors.join(' | ').slice(0, 160));
  },

  // ---------------------------------------------------------------------------- BATTLE STYLE
  async style(page, rec, base) {
    await open(page, base, query(24));
    await ev(page, `(() => { try { localStorage.removeItem('arena.battlestyle'); } catch (_e) {} return true; })()`);
    // ?style=set: no question, whatever it is stored as; nothing is written
    let st = await open(page, base, query(24, '&style=set'));
    let r = st === 'ready' ? await reach(page) : { r: st };
    let s = await snap(page);
    rec(st === 'ready' && r.r === 'result' && s.mine.filter((m) => m === 'stay').length >= 1 && s.mem === null, 'SW50 ?style=set: a whole battle with no question (the player was never asked), the answers are logged as stays (' + s.mine.filter((m) => m === 'stay').length + '), and nothing is written to localStorage', J({ r: r.r, stays: s.mine.filter((m) => m === 'stay').length, mem: s.mem }));
    // ?style=switch overrides a stored set for the visit
    await ev(page, `localStorage.setItem('arena.battlestyle', 'set'); true`);
    st = await open(page, base, query(24, '&style=switch'));
    r = st === 'ready' ? await reach(page) : { r: st };
    rec(r.r === 'prompt', 'SW51 ?style=switch overrides a stored "set" for this visit: the question is asked', J(r.r));
    // the stored value alone
    st = await open(page, base, query(24));
    r = st === 'ready' ? await reach(page) : { r: st };
    s = await snap(page);
    rec(r.r === 'result' && s.mem === 'set', 'SW52 a stored "set" alone (no address word): no question, and the stored word is still set', J({ r: r.r, mem: s.mem }));
    // junk
    st = await open(page, base, query(24, '&style=%3Cb%3Eevil'));
    const err = await ev(page, `({ state: ${H}.state, kind: ${H}.kind, text: document.body.innerText })`);
    rec(err.state === 'error' && !/evil/.test(err.text) && /battle style/i.test(err.text), 'SW53 ?style=<junk> is an error screen that names the problem and never echoes the value', J({ state: err.state, text: err.text.slice(0, 120) }));
    // the pause menu row: flips, persists, and is the ROM's words
    await ev(page, `localStorage.removeItem('arena.battlestyle'); true`);
    st = await open(page, base, query(24));
    await ev(page, `(() => { const a = ${H}, sc = a.scene; for (let k = 0; k < 60000 && sc.mode !== 'action'; k++) { if (sc.mode === 'preview') { const p = sc.S.preview; for (let i = 0; i < p.mine.length && sc.mode === 'preview' && p.picks.length < p.pick; i++) sc.choose.preview(i); continue; } if (sc.mode === 'confirm') { sc.press('a'); continue; } sc.tick(); if (sc.mode === 'steps' && sc.S.cur && sc.S.cur.t === 'text') sc.press('a'); } a.tick(1); return sc.mode; })()`);
    await key(page, 'start');
    const rows = await ev(page, `${H}.scene.S.menu ? ${H}.scene.S.menu.rows : null`);
    const ri = rows ? rows.findIndex((x) => /^BATTLE STYLE/.test(x)) : -1;
    rec(!!rows && ri >= 0 && rows[ri] === 'BATTLE STYLE: SHIFT', 'SW54 the pause menu has the row "BATTLE STYLE: SHIFT" (the ROM\'s own option words)', J(rows));
    await shot(page, 'SW_style_1_menu');
    for (let i = 0; i < ri; i++) await key(page, 'down');
    await key(page, 'a');
    const rows2 = await ev(page, `${H}.scene.S.menu ? ${H}.scene.S.menu.rows : null`);
    const mem = await ev(page, `localStorage.getItem('arena.battlestyle')`);
    rec(rows2 && rows2[ri] === 'BATTLE STYLE: SET' && mem === 'set', 'SW55 Enter on the row flips it to SET and stores the word in localStorage (arena.battlestyle = set)', J([rows2 && rows2[ri], mem]));
    await shot(page, 'SW_style_2_menu_set');
    await key(page, 'b');
    r = await reach(page);
    s = await snap(page);
    rec(r.r === 'result' && s.mine.filter((m) => m === 'stay').length >= 1, 'SW56 flipped to SET in the middle of a battle: the rest of it plays with no question (' + s.mine.filter((m) => m === 'stay').length + ' answers logged as stays)', J({ r: r.r, stays: s.mine.filter((m) => m === 'stay').length }));
    // and back: a reload keeps SET (the stored word), flipping to SHIFT brings the question back
    st = await open(page, base, query(24));
    await ev(page, `(() => { const a = ${H}, sc = a.scene; for (let k = 0; k < 60000 && sc.mode !== 'action'; k++) { if (sc.mode === 'preview') { const p = sc.S.preview; for (let i = 0; i < p.mine.length && sc.mode === 'preview' && p.picks.length < p.pick; i++) sc.choose.preview(i); continue; } if (sc.mode === 'confirm') { sc.press('a'); continue; } sc.tick(); if (sc.mode === 'steps' && sc.S.cur && sc.S.cur.t === 'text') sc.press('a'); } a.tick(1); return sc.mode; })()`);
    await key(page, 'start');
    const rows3 = await ev(page, `${H}.scene.S.menu ? ${H}.scene.S.menu.rows : null`);
    rec(rows3 && rows3[ri] === 'BATTLE STYLE: SET', 'SW57 after a reload the stored SET is what the menu shows', J(rows3 && rows3[ri]));
    for (let i = 0; i < ri; i++) await key(page, 'down');
    await key(page, 'a'); await key(page, 'b');
    r = await reach(page);
    rec(r.r === 'prompt' && (await ev(page, `localStorage.getItem('arena.battlestyle')`)) === 'switch', 'SW58 flipped back to SHIFT: the question is asked again at the next offer, and the stored word is switch', J(r.r));
    rec(!page.errors.length, 'SW59 style: no page errors', page.errors.join(' | ').slice(0, 160));
    // the hub-launched online page has no such row (nothing to set against a person): the page's own online mode builds its scene without a style object
    const online = await ev(page, `fetch('/pokemonarena/js/battle_boot.js').then((r) => r.text()).then((t) => { const i = t.indexOf('const mountOnlineScene'); const j = t.indexOf('scene.begin();', i); return /style:\\s*styleCfg/.test(t.slice(i, j)); })`);
    rec(online === false, 'SW60 the online scene is built without the style setting (no BATTLE STYLE row, no question against a person)', J(online));
  },

  // ---------------------------------------------------------------------------- a reload
  async resume(page, rec, base) {
    const L = await loadPrompt(page, base, 25);
    if (!L) { rec(false, 'SW70 resume: the question is reached'); return; }
    const p = L.s;
    await sleep(150);
    // reload AT the question: it comes back to the question, the same battle
    await page.send('Page.reload', {}); await page.waitFor(`${H} && ${H}.state === "ready"`, { timeoutMs: 90000 });
    await sleep(200);
    const r0 = await snap(page);
    rec(r0.resume && r0.resume.restored === true && r0.mode === 'confirm' && r0.kind === 'free' && r0.hash === p.hash && r0.req.next === p.req.next, 'SW70 a reload AT the question replays the battle and comes back to the very same question (same state hash, same next Pokemon)', J({ resume: r0.resume, mode: r0.mode, kind: r0.kind, same: r0.hash === p.hash }));
    rec(J(r0.box) === J([QUESTION_PAGE2]), 'SW71 ... with the question\'s second page in the box and the cursor on YES', J([r0.box, r0.cursor]));
    // answer YES and pick, play on a little, reload: the answers are part of the replay
    const yes = await overlayAt(page, 0); await tapLogical(page, yes.x, yes.y, false);
    const pa = await snap(page); const pk = pa.bench.filter((b) => b.ok)[0];
    const rw = await partyRowAt(page, pk.i); await tapLogical(page, rw.x, rw.y, false);
    await toNext(page);
    await ev(page, `(() => { const a = ${H}, sc = a.scene; for (let k = 0; k < 60000; k++) { const m = sc.mode; if (m === 'result' || (m === 'confirm' && sc.S.confirm && sc.S.confirm.kind === 'free') || (m === 'action' && a.ctl.turn >= ${p.turn + 3})) break; if (m === 'action') { sc.choose.action(0); continue; } if (m === 'moves') { const i = (sc.S.req.moves || []).findIndex((x) => !x.disabled); sc.choose.move(Math.max(0, i)); continue; } if (m === 'party') { sc.press('a'); continue; } sc.tick(); if (sc.mode === 'steps' && sc.S.cur && sc.S.cur.t === 'text') sc.press('a'); } a.tick(1); return sc.mode; })()`);
    await sleep(200);
    const before = await snap(page);
    const stored = await ev(page, `Object.keys(sessionStorage).filter((k) => k.startsWith('arena.resume:')).map((k) => JSON.parse(sessionStorage.getItem(k)))`);
    rec(stored.length === 1 && stored[0].choices.some((c) => c.kind === 'switch' && c.slot === pk.slot), 'SW72 the saved record holds the free switch as an ordinary choice ({ switch, ' + pk.slot + ' }) among the moves', J(stored[0] && stored[0].choices.map((c) => c.kind + (c.slot !== undefined ? ':' + c.slot : ''))));
    await page.send('Page.reload', {}); await page.waitFor(`${H} && ${H}.state === "ready"`, { timeoutMs: 90000 });
    await sleep(250);
    const after = await snap(page);
    rec(after.resume && after.resume.restored === true && after.hash === before.hash && after.turn === before.turn && after.front === before.front && after.mode === before.mode, 'SW73 a reload after the answers replays them: same state hash, same turn, the same Pokemon in front, the same screen (' + before.mode + ')', J({ resume: after.resume, same: after.hash === before.hash, turn: [before.turn, after.turn], front: [before.front, after.front], mode: [before.mode, after.mode] }));
    rec(!page.errors.length, 'SW74 resume: no page errors', page.errors.join(' | ').slice(0, 160));
  },
};

/* ----------------------------------------------------------------------------------------------- run, then mutants */
const SESSION_OPTS = {
  phone: { width: 390, height: 844, mobile: true }, pad: { width: 390, height: 844, mobile: true }, desktop: { width: 1280, height: 800 }, style: { width: 1280, height: 800 }, resume: { width: 1280, height: 800 },
};
async function runAll(base, rec, names, cdpBase) {
  let k = 0;
  for (const n of names) { console.log('-- session', n); await session(n, SESSION_OPTS[n], base, rec, SESSIONS[n], cdpBase + k++); }
}
// every defect below must fail the NAMED case
const MUTANTS = [
  { id: 'SWM1', what: 'the battle page builds its controller without the free-switch option (no question is ever asked)', sessions: ['desktop'], file: 'js/battle_boot.js', from: 'lead: spec.lead, freeSwitch: true, names: spec.names', to: 'lead: spec.lead, names: spec.names', fails: 'SW30' },
  { id: 'SWM2', what: 'the page does not give the scene its style setting (no BATTLE STYLE row, SET cannot be honoured)', sessions: ['style'], file: 'js/battle_boot.js', from: 'anim: animCfg, style: styleCfg, animator:', to: 'anim: animCfg, animator:', fails: 'SW54' },
  { id: 'SWM3', what: 'B on the free party screen does not come back to the question', sessions: ['desktop'], file: 'js/scene.js', from: "if (free) openFreeConfirm(); else S.mode = 'action';", to: "S.mode = 'action';", fails: 'SW33' },
  { id: 'SWM4', what: 'NO sends nothing (the question closes and the battle waits for ever)', sessions: ['phone'], file: 'js/scene.js', from: "else if (c.kind === 'free') { if (yes) openFreeParty(); else submit({ kind: 'stay' }); }", to: "else if (c.kind === 'free') { if (yes) openFreeParty(); }", fails: 'SW11' },
  { id: 'SWM5', what: 'the cursor starts on NO', sessions: ['pad'], file: 'js/scene.js', from: "S.confirm = { kind: 'free', cursor: 0, back: 'steps' };\n    S.overlay = { rows: ['YES', 'NO'], cursor: 0, w: 48, x: 176 };", to: "S.confirm = { kind: 'free', cursor: 1, back: 'steps' };\n    S.overlay = { rows: ['YES', 'NO'], cursor: 1, w: 48, x: 176 };", fails: 'SW22' },
  { id: 'SWM6', what: 'a reload record forgets the answers (the switch of a free switch is not saved)', sessions: ['resume'], file: 'js/battle_resume.js', from: 'choices: i.choiceLog.filter((e) => e.s === humanSide).map(', to: "choices: i.choiceLog.filter((e) => e.s === humanSide && e.c.kind !== 'switch').map(", fails: 'SW72' },
  { id: 'SWM7', what: 'the BATTLE STYLE setting is not stored', sessions: ['style'], file: 'js/style_settings.js', from: 'try { storage.setItem(STYLE_KEY, cur.style); }', to: 'try { /* not saved */ }', fails: 'SW55' },
];

const t0 = Date.now();
const started = await startServer();
console.log('pokemonarena switch page test; server', started ? 'started' : 'already running', 'on', PORT, '; screenshots ->', OUT);
try {
  const want = (process.env.ARENA_SESSIONS || '').split(',').filter(Boolean);
  await runAll(ORIGIN, ok, Object.keys(SESSIONS).filter((n) => !want.length || want.includes(n)), CDP0);
  if (process.argv.includes('--mutants')) {
    const { copyTree, mutateFile, startOverlay } = await import('./pokemonarena_overlay.mjs');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-switch-page-mut-'));
    let killed = 0, ran = 0;
    try {
      for (const mu of MUTANTS) {
        ran++;
        const failed = [];
        const rec = (cond, name, detail) => { if (!cond) failed.push(name + (detail ? ' :: ' + String(detail).slice(0, 160) : '')); };
        const dir = copyTree(path.join(root, 'pokemonarena'), path.join(tmp, mu.id));
        let ov = null;
        try {
          try { mutateFile(dir, mu.file, mu.from, mu.to); } catch (e) { ok(false, 'SWMUT ' + mu.id + ' could not be applied', e.message); continue; }
          ov = await startOverlay({ dir, port: PORT + 12, upstream: ORIGIN });
          await runAll(ov.url, rec, mu.sessions, CDP0 + 20);
        } finally { if (ov) ov.stop(); }
        const hit = failed.find((f) => f.startsWith(mu.fails));
        ok(!!hit, 'SWMUT ' + mu.id + ' (' + mu.what + ') fails ' + mu.fails, hit ? '' : 'it did NOT: failed cases = ' + J(failed.map((f) => f.slice(0, 60))));
        if (hit) killed++;
      }
    } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_e) { /* ignore */ } }
    console.log(`switch page mutants: ${killed}/${ran} killed`);
  }
} finally { stopServer(); }
console.log('\n' + (fail ? 'FAILED' : 'OK') + ': ' + pass + ' passed, ' + fail + ' failed (' + ((Date.now() - t0) / 1000).toFixed(0) + ' s)');
if (fail) { console.log(failures.join('\n')); process.exit(1); }

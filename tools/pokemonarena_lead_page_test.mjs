// tools/pokemonarena_lead_page_test.mjs -- the 6v6 LEAD preview in real headless Chrome, on the real battle page (/pokemonarena/battle.html).
//
// "In a 6v6 battle you should be able to choose which Pokemon is sent out first." A 6v6 battle now opens on a preview that asks for ONE Pokemon (the ROM's own "Choose a Pokemon."), asks
// "Send out this one first?" (YES / NO) and sends that Pokemon out first, the rest following in team order. This file drives that the way each kind of player does, on the sizes that matter:
//
//   phone 390x844     a TAP on the 4th row and on YES; a tap on NO leaves nothing chosen; the on-screen pad (d-pad, A, B); layout (no scroll, every control >= 44 px)
//   landscape 844x390 the same taps in the other layout
//   controller        a controller (navigator.getGamepads double): down x3, A, B (= NO), A, A (= YES)
//   desktop 1280x800  real keys (arrows, Enter, Backspace) and a real mouse click, each on its own
//   teams             a team of TWO (two rows, the second leads) and a team of ONE (no preview: nothing to choose); the 3v3 preview exactly as it was
//   resume            the lead is part of what a reload replays (same state, same Pokemon in front); a record saved by the build before the lead preview is refused cleanly
//   mutants           `--mutants` serves a copy of the game with ONE defect at a time; each must fail the case it names (case ids LP..)
//
// Every case checks what the BATTLE did, not only what the screen showed: the Pokemon in front on the player's side is the one chosen (engine order and the player's box agree).
//
//   ARENA_PORT=8841 ARENA_CDP=10360 node tools/pokemonarena_lead_page_test.mjs [--mutants]        ARENA_OUT=<dir for screenshots>, ARENA_SKIP_SHOTS=1
// Browsers: tools/headless_cdp.mjs only (bare CDP, throwaway profile, --mute-audio, never the user's browser).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { withBrowser } from './headless_cdp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const PORT = Number(process.env.ARENA_PORT || 8094);
const CDP0 = Number(process.env.ARENA_CDP || 9271);
const OUT = process.env.ARENA_OUT || path.join(os.tmpdir(), 'arena-lead-shots');
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

/* ----------------------------------------------------------------------------------------------- team codes (a team of one and of two) */
const jsUrl = (f) => pathToFileURL(path.join(root, 'pokemonarena', 'js', f)).href;
const rom = new Uint8Array(fs.readFileSync(ROM_PATH));
const [{ loadPack }, OM] = await Promise.all([import(jsUrl('tables.js')), import(jsUrl('online_match.js'))]);
const pack = loadPack(rom, { verify: 'header', dexText: false });
const CODE1 = await OM.randomTeamCode(pack, 4711, 1), CODE2 = await OM.randomTeamCode(pack, 4712, 2);

/* ----------------------------------------------------------------------------------------------- page helpers */
const H = '(window.__arenaBattle)';
const ev = (page, expr) => page.eval(expr);
async function open(page, base, query) {
  await page.navigate(base + '/pokemonarena/battle.html' + query);
  await page.waitFor(`${H} && (${H}.state === "ready" || ${H}.state === "error")`, { timeoutMs: 90000 });
  return ev(page, `${H}.state`);
}
const mode = (page) => ev(page, `${H}.mode`);
const KEYS = { up: ['ArrowUp', 'ArrowUp', 38], down: ['ArrowDown', 'ArrowDown', 40], a: ['Enter', 'Enter', 13], b: ['Backspace', 'Backspace', 8] };
const key = async (page, k) => { await page.press(KEYS[k][0], KEYS[k][1], KEYS[k][2], 25); await sleep(60); };
const shot = async (page, name) => { if (SHOTS) { try { await page.screenshot(path.join(OUT, name + '.png')); } catch (_e) { /* evidence, not the test */ } } };
async function logicalToPage(page, lx, ly) {
  const r = await ev(page, `(() => { const c = ${H}.canvas, b = c.getBoundingClientRect(), cs = getComputedStyle(c); const bl = parseFloat(cs.borderLeftWidth), bt = parseFloat(cs.borderTopWidth); return { x: b.left + bl, y: b.top + bt, w: b.width - 2 * bl, h: b.height - 2 * bt }; })()`);
  return { x: r.x + (lx / 240) * r.w, y: r.y + (ly / 160) * r.h };
}
async function tapLogical(page, lx, ly, touch) { const p = await logicalToPage(page, lx, ly); if (touch) await page.tap(p.x, p.y); else await page.click(p.x, p.y); await sleep(120); return p; }
// the logical position of row i of the player's list, and of the YES / NO boxes while the question is up
const rowAt = (page, i) => ev(page, `(() => { const G = ${H}.ui.GEOM.preview.mine, r = ${H}.ui.rowRects(G, ${H}.scene.view().preview.mine.length)[${i}]; return { x: G.x + 24, y: r.y + 8 }; })()`);
const overlayAt = (page, i) => ev(page, `(() => { const g = ${H}.ui.overlayRects(${H}.view().overlay); return { x: g.rows[${i}].x + g.rows[${i}].w / 2, y: g.rows[${i}].y + g.rows[${i}].h / 2 }; })()`);
const snap = (page) => ev(page, `(() => { const a = ${H}, s = a.scene, v = s.view(), b = a.ctl.battle, sd = b.s.sides[0];
  return { mode: s.mode, title: v.preview ? v.preview.title : null, picks: v.preview ? v.preview.picks : null, rows: v.preview ? v.preview.mine.length : 0, names: v.preview ? v.preview.mine.map((m) => m.name) : null, lead: !!(s.S.preview && s.S.preview.lead),
    order: sd.team.map((m) => m.orig), front: sd.team[sd.act].orig, frontName: sd.team[sd.act].name, shown: s.state().player ? s.state().player.name : null, phase: b.s.phase, hash: b.hash(), turn: a.ctl.turn,
    log: b.choiceLog.map((e) => e.s + ':' + e.c.kind + ':' + (e.c.order || e.c.slot)), overlay: s.state().overlay, resume: a.resume }; })()`);
const toAction = (page) => ev(page, `(() => { const a = ${H}; for (let k = 0; k < 30000 && a.mode !== 'action' && a.mode !== 'result'; k++) { a.scene.tick(); if (a.mode === 'steps') a.press('a'); } return a.mode; })()`);
const lay = (page) => ev(page, `(() => { const r = ${H}.canvas.getBoundingClientRect(); return { sw: document.documentElement.scrollWidth, iw: window.innerWidth, k: ${H}.scale && ${H}.scale.k, cw: r.width, layout: document.body.dataset.layout }; })()`);
const smallControls = (page, touch) => ev(page, `[...document.querySelectorAll('#top button, #top a, ${touch ? '#dpad .pbtn, #ab .pbtn' : '.textbtn'}')].filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && (r.width < 43.5 || r.height < 43.5); }).map((b) => b.id || b.className)`);
const PAD_DOUBLE = `(() => {
  window.__pad = { buttons: new Array(17).fill(0), axes: [0, 0, 0, 0] };
  navigator.getGamepads = () => [{ id: 'Xbox 360 Controller (STANDARD GAMEPAD Vendor: 045e Product: 028e)', index: 0, connected: true, mapping: 'standard', axes: window.__pad.axes, buttons: window.__pad.buttons.map((v) => ({ pressed: v > 0.5, value: v })) }];
})();`;
const addInit = (page, src) => page.send('Page.addScriptToEvaluateOnNewDocument', { source: src });
const QUERY = '?seed=21&format=6v6&cpu=normal&anim=0';

/* ----------------------------------------------------------------------------------------------- the cases (over any copy of the game) */
// the 4th Pokemon leads. `how` says how the player gets there; every route ends the same way
async function expectLeadFourth(page, rec, tag, names) {
  const s = await toAction(page).then(() => snap(page));
  const want = names[3];
  rec(s.mode === 'action' && s.front === 3 && J(s.order) === '[3,0,1,2,4,5]' && s.frontName === want && s.shown === want, tag + ' the battle sends out the 4th Pokemon first (' + want + '): engine order [3,0,1,2,4,5] and the player\'s box agree', J({ mode: s.mode, front: s.front, order: s.order, frontName: s.frontName, shown: s.shown, want }));
  return s;
}

async function session(name, opts, base, rec, fn, cdp) {
  try { await withBrowser({ port: cdp, ...opts }, async (page) => { await fn(page, rec, base); }); } catch (e) { rec(false, 'LP session ' + name + ' threw', String(e && e.stack ? e.stack : e).slice(0, 300)); }
}

const SESSIONS = {
  // ---------------------------------------------------------------------------- the phone: touch, the on-screen pad, layout
  async phone(page, rec, base) {
    await page.setViewport(390, 844, { mobile: true, dpr: 3 });
    const st = await open(page, base, QUERY);
    const s0 = st === 'ready' ? await snap(page) : null;
    rec(st === 'ready' && s0.mode === 'preview' && s0.lead && s0.rows === 6 && s0.phase === 'preview', 'LP1 phone: a 6v6 battle opens on the lead preview (six rows, nothing chosen, the battle has not started)', J([st, s0 && s0.mode, s0 && s0.rows]));
    if (!s0 || s0.mode !== 'preview') return;
    rec(/^Choose a Pok/.test(s0.title) && !/^Choose 3/.test(s0.title) && J(s0.picks) === '[]', 'LP3 phone: the title is the ROM\'s "Choose a Pokemon." (not the 3v3 counter)', J([s0.title, s0.picks]));
    const cpu = s0.log;
    rec(cpu.length === 1 && /^1:preview:\d$/.test(cpu[0]), 'LP2 phone: the CPU has already chosen its own lead (one one-slot preview of side 1 in the log) before the player has chosen', J(cpu));
    const l = await lay(page);
    rec(l.sw <= l.iw && l.layout === 'portrait', 'LP2b phone: no horizontal scroll', J(l));
    rec((await smallControls(page, true)).length === 0, 'LP2c phone: every visible control is at least 44 css px', J(await smallControls(page, true)));
    await shot(page, 'LP_phone_1_lead_preview');
    // a tap on the 4th row opens the question; a tap on NO leaves nothing chosen
    const r3 = await rowAt(page, 3); await tapLogical(page, r3.x, r3.y, true);
    const q = await snap(page);
    rec(q.mode === 'confirm' && q.title === 'Send out this one first?' && J(q.picks) === '[3,0,1,2,4,5]' && J(q.overlay) === '["YES","NO"]', 'LP4 phone: a TAP on the 4th row asks "Send out this one first?" with YES / NO and numbers the team in the order the battle will use', J([q.mode, q.title, q.picks, q.overlay]));
    await shot(page, 'LP_phone_2_question');
    const no = await overlayAt(page, 1); await tapLogical(page, no.x, no.y, true);
    const n = await snap(page);
    rec(n.mode === 'preview' && J(n.picks) === '[]' && n.log.every((e) => !e.startsWith('0:')) && n.phase === 'preview', 'LP5 phone: a TAP on NO goes back with nothing chosen (the battle has not started, the log has no choice of the player)', J([n.mode, n.picks, n.log]));
    await tapLogical(page, r3.x, r3.y, true);
    const yes = await overlayAt(page, 0); await tapLogical(page, yes.x, yes.y, true);
    await expectLeadFourth(page, rec, 'LP5b phone: a TAP on the 4th row and on YES:', s0.names);
    const e = await snap(page);
    rec(e.log[0].startsWith('1:preview:') && e.log[1] === '0:preview:3', 'LP6 phone: the log holds the CPU\'s lead first and then the player\'s { preview, [3] }', J(e.log));
    await shot(page, 'LP_phone_3_first_menu');
    rec(!page.errors.length, 'LP7 phone: no page errors', page.errors.join(' | ').slice(0, 160));
    // the on-screen pad on a fresh load: d-pad down x3, A, B (NO), A, A (YES)
    await open(page, base, QUERY);
    const ctr = async (id) => ev(page, `(() => { const r = document.getElementById(${J(id)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    const padTap = async (id) => { const c = await ctr(id); await page.tap(c.x, c.y); await sleep(110); };
    for (let i = 0; i < 3; i++) await padTap('bDown');
    await padTap('bA');
    const pq = await snap(page);
    rec(pq.mode === 'confirm' && J(pq.picks) === '[3,0,1,2,4,5]', 'LP8 phone: the on-screen pad (d-pad down x3, then A) picks the 4th and asks', J([pq.mode, pq.picks]));
    await padTap('bB');
    const pb = await snap(page);
    rec(pb.mode === 'preview' && J(pb.picks) === '[]', 'LP8b phone: the on-screen B answers NO', J([pb.mode, pb.picks]));
    await padTap('bA'); await padTap('bA');
    await expectLeadFourth(page, rec, 'LP8c phone: the on-screen pad, A, B, A, A:', s0.names);
  },

  // ---------------------------------------------------------------------------- the other layout
  async landscape(page, rec, base) {
    await page.setViewport(844, 390, { mobile: true, dpr: 3 });
    const st = await open(page, base, QUERY);
    const s0 = st === 'ready' ? await snap(page) : null;
    rec(st === 'ready' && s0.mode === 'preview' && s0.lead && s0.rows === 6, 'LP10 landscape 844x390: the lead preview opens', J([st, s0 && s0.mode]));
    if (!s0 || s0.mode !== 'preview') return;
    const l = await lay(page);
    rec(l.sw <= l.iw && l.layout === 'landscape', 'LP10b landscape: no horizontal scroll, the landscape layout', J(l));
    rec((await smallControls(page, true)).length === 0, 'LP10c landscape: every visible control is at least 44 css px', J(await smallControls(page, true)));
    await shot(page, 'LP_land_1_lead_preview');
    const r3 = await rowAt(page, 3); await tapLogical(page, r3.x, r3.y, true);
    const q = await snap(page);
    rec(q.mode === 'confirm' && q.title === 'Send out this one first?', 'LP11 landscape: a tap on the 4th row asks the question', J([q.mode, q.title]));
    await shot(page, 'LP_land_2_question');
    const yes = await overlayAt(page, 0); await tapLogical(page, yes.x, yes.y, true);
    await expectLeadFourth(page, rec, 'LP12 landscape: a tap on the 4th row and on YES:', s0.names);
    rec(!page.errors.length, 'LP13 landscape: no page errors', page.errors.join(' | ').slice(0, 160));
  },

  // ---------------------------------------------------------------------------- a controller
  async pad(page, rec, base) {
    await page.setViewport(390, 844, { mobile: true, dpr: 3 });
    await addInit(page, PAD_DOUBLE);
    const st = await open(page, base, QUERY);
    const s0 = st === 'ready' ? await snap(page) : null;
    if (!s0 || s0.mode !== 'preview') { rec(false, 'LP20 controller: the lead preview opens', J([st, s0 && s0.mode])); return; }
    await page.send('Runtime.evaluate', { expression: `window.dispatchEvent(new Event('gamepadconnected'))` });
    const padPress = async (idx) => { await ev(page, `window.__pad.buttons[${idx}] = 1`); await sleep(130); await ev(page, `window.__pad.buttons[${idx}] = 0`); await sleep(130); };
    await padPress(13); await padPress(13); await padPress(13);
    rec((await ev(page, `${H}.scene.S.preview.cursor`)) === 3, 'LP20 controller: the d-pad moves the cursor down three rows', String(await ev(page, `${H}.scene.S.preview.cursor`)));
    await padPress(0);
    const q = await snap(page);
    rec(q.mode === 'confirm' && q.title === 'Send out this one first?' && J(q.picks) === '[3,0,1,2,4,5]', 'LP21 controller: A picks the 4th and asks "Send out this one first?"', J([q.mode, q.title, q.picks]));
    await padPress(1);
    const b = await snap(page);
    rec(b.mode === 'preview' && J(b.picks) === '[]' && b.log.every((e) => !e.startsWith('0:')), 'LP22 controller: B answers NO (nothing chosen)', J([b.mode, b.picks, b.log]));
    await padPress(0); await padPress(0);
    await expectLeadFourth(page, rec, 'LP23 controller: down x3, A, B, A, A:', s0.names);
    rec(!page.errors.length, 'LP24 controller: no page errors', page.errors.join(' | ').slice(0, 160));
  },

  // ---------------------------------------------------------------------------- a desktop: real keys, then a real mouse
  async desktop(page, rec, base) {
    const st = await open(page, base, QUERY);
    const s0 = st === 'ready' ? await snap(page) : null;
    rec(st === 'ready' && s0.mode === 'preview' && s0.lead && s0.rows === 6, 'LP30 desktop: the lead preview opens at 1280x800', J([st, s0 && s0.mode]));
    if (!s0 || s0.mode !== 'preview') return;
    await shot(page, 'LP_desk_1_lead_preview');
    for (let i = 0; i < 3; i++) await key(page, 'down');
    await key(page, 'a');
    const q = await snap(page);
    rec(q.mode === 'confirm' && q.title === 'Send out this one first?' && J(q.picks) === '[3,0,1,2,4,5]', 'LP31 keyboard: ArrowDown x3 and Enter pick the 4th and ask', J([q.mode, q.title, q.picks]));
    await shot(page, 'LP_desk_2_question');
    await key(page, 'b');
    const b = await snap(page);
    rec(b.mode === 'preview' && J(b.picks) === '[]' && b.log.every((e) => !e.startsWith('0:')), 'LP32 keyboard: Backspace (B) answers NO', J([b.mode, b.picks]));
    await key(page, 'a'); await key(page, 'a');
    await expectLeadFourth(page, rec, 'LP33 keyboard: ArrowDown x3, Enter, Backspace, Enter, Enter:', s0.names);
    // a real mouse: hover moves the cursor, a click on the 4th row asks, a click on YES sends
    await open(page, base, QUERY);
    const r3 = await rowAt(page, 3);
    const p3 = await logicalToPage(page, r3.x, r3.y); await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p3.x, y: p3.y }); await sleep(120);
    rec((await ev(page, `${H}.scene.S.preview.cursor`)) === 3, 'LP34 mouse: hovering the 4th row puts the cursor on it', String(await ev(page, `${H}.scene.S.preview.cursor`)));
    await tapLogical(page, r3.x, r3.y, false);
    rec((await mode(page)) === 'confirm', 'LP35 mouse: a click on the 4th row asks the question', await mode(page));
    const yes = await overlayAt(page, 0); await tapLogical(page, yes.x, yes.y, false);
    await expectLeadFourth(page, rec, 'LP36 mouse: a click on the 4th row and on YES:', s0.names);
    rec(!page.errors.length, 'LP37 desktop: no page errors', page.errors.join(' | ').slice(0, 160));
  },

  // ---------------------------------------------------------------------------- team sizes and 3v3
  async teams(page, rec, base) {
    await page.setViewport(390, 844, { mobile: true, dpr: 3 });
    // two Pokemon: two rows, the second leads
    let st = await open(page, base, '?team=' + encodeURIComponent(CODE2) + '&foe=random&seed=31&format=6v6&cpu=normal&anim=0');
    let s = st === 'ready' ? await snap(page) : null;
    rec(st === 'ready' && s.mode === 'preview' && s.lead && s.rows === 2, 'LP40 a team of two: the lead preview has two rows', J([st, s && s.mode, s && s.rows]));
    if (s && s.mode === 'preview') {
      await shot(page, 'LP_team2_lead_preview');
      const r1 = await rowAt(page, 1); await tapLogical(page, r1.x, r1.y, true);
      const q = await snap(page);
      rec(q.mode === 'confirm' && J(q.picks) === '[1,0]', 'LP41 a tap on the second row numbers the two: [1,0]', J([q.mode, q.picks]));
      const yes = await overlayAt(page, 0); await tapLogical(page, yes.x, yes.y, true);
      await toAction(page);
      s = await snap(page);
      rec(s.mode === 'action' && J(s.order) === '[1,0]' && s.shown === s.frontName, 'LP42 the second Pokemon of the two leads, the first follows', J([s.mode, s.order, s.shown, s.frontName]));
    }
    // one Pokemon: nothing to choose, so no preview at all
    st = await open(page, base, '?team=' + encodeURIComponent(CODE1) + '&foe=random&seed=32&format=6v6&cpu=normal&anim=0');
    const m1 = st === 'ready' ? await toAction(page) : st;
    s = st === 'ready' ? await snap(page) : null;
    rec(st === 'ready' && m1 === 'action' && s.order.length === 1 && s.log.every((e) => !e.startsWith('0:')) && s.shown === s.frontName, 'LP43 a team of ONE has no lead to choose: the battle goes straight to the first menu (no preview, no choice of the player in the log)', J([st, m1, s && s.order, s && s.log]));
    // 3v3 is the preview it was: the counter, three picks, "Send out this team?"
    st = await open(page, base, '?seed=33&format=3v3&cpu=normal&anim=0');
    s = st === 'ready' ? await snap(page) : null;
    rec(st === 'ready' && s.mode === 'preview' && !s.lead && s.title === 'Choose 3 (0/3)', 'LP44 3v3 still opens on "Choose 3 (0/3)" (not a lead preview)', J([st, s && s.mode, s && s.lead, s && s.title]));
    if (s && s.mode === 'preview') {
      await key(page, 'a'); await key(page, 'down'); await key(page, 'a'); await key(page, 'down'); await key(page, 'a');
      const q = await snap(page);
      rec(q.mode === 'confirm' && q.title === 'Send out this team?' && J(q.picks) === '[0,1,2]', 'LP45 3v3: three picks open "Send out this team?" with the three numbered', J([q.mode, q.title, q.picks]));
    }
    rec(!page.errors.length, 'LP46 team sizes: no page errors', page.errors.join(' | ').slice(0, 160));
  },

  // ---------------------------------------------------------------------------- a reload
  async resume(page, rec, base) {
    const st = await open(page, base, QUERY);
    const s0 = st === 'ready' ? await snap(page) : null;
    if (!s0 || s0.mode !== 'preview') { rec(false, 'LP50 resume: the lead preview opens', J([st, s0 && s0.mode])); return; }
    // reloading BEFORE the lead is chosen starts the preview again (nothing was saved)
    await page.send('Page.reload', {}); await page.waitFor(`${H} && ${H}.state === "ready"`, { timeoutMs: 90000 });
    const p = await snap(page);
    rec(p.mode === 'preview' && p.lead && p.resume && p.resume.restored === false, 'LP50 a reload before the lead is chosen shows the lead preview again (nothing to resume)', J([p.mode, p.resume]));
    for (let i = 0; i < 3; i++) await key(page, 'down');
    await key(page, 'a'); await key(page, 'a');
    await toAction(page);
    // play one turn, so the record holds the lead AND a move
    await ev(page, `(() => { const a = ${H}; a.press('a'); a.press('a'); for (let k = 0; k < 60000 && !(a.mode === 'action' && a.ctl.turn >= 2) && a.mode !== 'result'; k++) { a.scene.tick(); if (a.mode === 'steps') a.press('a'); else if (a.mode === 'party') a.press('a'); } return a.mode; })()`);
    await sleep(150);
    const before = await snap(page);
    const stored = await ev(page, `Object.keys(sessionStorage).filter((k) => k.startsWith('arena.resume:')).map((k) => JSON.parse(sessionStorage.getItem(k)))`);
    rec(before.mode === 'action' && before.turn >= 2 && stored.length === 1 && stored[0].choices[0].kind === 'preview' && J(stored[0].choices[0].order) === '[3]', 'LP51 the saved record starts with the lead choice { preview, [3] }, then the player\'s moves', J(stored[0] && stored[0].choices && stored[0].choices.slice(0, 3)));
    await page.send('Page.reload', {}); await page.waitFor(`${H} && ${H}.state === "ready"`, { timeoutMs: 90000 });
    await toAction(page);
    const after = await snap(page);
    rec(after.resume && after.resume.restored === true && after.mode === 'action' && after.turn === before.turn && after.hash === before.hash && J(after.order) === J(before.order) && after.order[0] === 3, 'LP52 a reload replays the lead with the rest: same turn, same state hash, the 4th Pokemon still in front', J([after.resume, after.turn, before.turn, after.order]));
    // a record from the build before the lead preview (its first choice is a move) is refused, cleanly, and the battle starts again at the lead preview
    const key0 = await ev(page, `Object.keys(sessionStorage).find((k) => k.startsWith('arena.resume:'))`);
    await ev(page, `sessionStorage.setItem(${J(key0)}, JSON.stringify({ v: 1, seed: 21, choices: [{ kind: 'move', slot: 0 }, { kind: 'move', slot: 1 }], hash: 'deadbeef', turn: 3 })); true`);
    await page.send('Page.reload', {}); await page.waitFor(`${H} && ${H}.state === "ready"`, { timeoutMs: 90000 });
    const old = await snap(page);
    rec(old.resume && old.resume.restored === false && /refused/.test(old.resume.reason) && old.mode === 'preview' && old.lead && J(old.picks) === '[]' && old.turn <= 1, 'LP53 a record saved before the lead preview existed (it starts with a move) is refused cleanly and the battle starts again at the lead preview', J([old.resume, old.mode, old.turn]));
    rec((await ev(page, `Object.keys(sessionStorage).filter((k) => k.startsWith('arena.resume:')).length`)) === 0, 'LP54 ... and the unusable record is cleared', '');
    rec(!page.errors.length, 'LP55 resume: no page errors', page.errors.join(' | ').slice(0, 160));
  },
};

/* ----------------------------------------------------------------------------------------------- run, then mutants */
const SESSION_OPTS = {
  phone: { width: 390, height: 844, mobile: true }, landscape: { width: 844, height: 390, mobile: true }, pad: { width: 390, height: 844, mobile: true },
  desktop: { width: 1280, height: 800 }, teams: { width: 390, height: 844, mobile: true }, resume: { width: 1280, height: 800 },
};
async function runAll(base, rec, names, cdpBase) {
  let k = 0;
  for (const n of names) { console.log('-- session', n); await session(n, SESSION_OPTS[n], base, rec, SESSIONS[n], cdpBase + k++); }
}
// every defect below must fail the NAMED case
const MUTANTS = [
  { id: 'LPM1', what: 'the battle page builds its controller without the lead option (6v6 starts with no preview, as before)', sessions: ['desktop'], file: 'js/battle_boot.js', from: 'pick: spec.pick, lead: spec.lead, freeSwitch: true, names: spec.names', to: 'pick: spec.pick, freeSwitch: true, names: spec.names', fails: 'LP30' },
  { id: 'LPM2', what: 'the scene does not know the request is a lead preview (it shows the 3v3 counter and never asks the question)', sessions: ['desktop'], file: 'js/scene.js', from: 'lead: !!req.lead, mine,', to: 'lead: false, mine,', fails: 'LP31' },
  { id: 'LPM3', what: 'a tap cannot hit the preview rows', sessions: ['phone'], file: 'js/scene.js', from: 'if (x < G.x + G.w + 4) for (let i = 0; i < rows.length; i++) if (y >= rows[i].y - 1 && y < rows[i].y + G.pitch - 1) return { kind: \'preview\', index: i };', to: '', fails: 'LP4' },
  { id: 'LPM4', what: 'NO still sends the lead', sessions: ['desktop'], file: 'js/scene.js', from: "if (yes) submit({ kind: 'preview', order: S.preview.picks.map((i) => S.preview.mine[i].slot) });", to: "if (true) submit({ kind: 'preview', order: S.preview.picks.map((i) => S.preview.mine[i].slot) });", fails: 'LP32' },
  { id: 'LPM5', what: 'the engine puts the rest of the team in reverse order behind the lead', sessions: ['desktop'], file: 'js/engine.js', from: 'for (let i = 0; i < sd.team.length; i++) if (i !== lead) order.push(i);', to: 'for (let i = sd.team.length - 1; i >= 0; i--) if (i !== lead) order.push(i);', fails: 'LP33' },
  { id: 'LPM6', what: 'a reload record forgets the lead choice (preview choices are not saved)', sessions: ['resume'], file: 'js/battle_resume.js', from: 'choices: i.choiceLog.filter((e) => e.s === humanSide).map(', to: "choices: i.choiceLog.filter((e) => e.s === humanSide && e.c.kind !== 'preview').map(", fails: 'LP52' },
  { id: 'LPM7', what: 'an old record that starts with a move is replayed anyway (the replay does not refuse it)', sessions: ['resume'], file: 'js/battle_resume.js', from: "if (!r || !r.ok) why = 'choice ' + (k + 1) + ' of ' + rec.choices.length + ' was refused' + (r && r.code ? ' (' + r.code + ')' : '');", to: '', fails: 'LP53' },
];

const t0 = Date.now();
const started = await startServer();
console.log('pokemonarena lead page test; server', started ? 'started' : 'already running', 'on', PORT, '; screenshots ->', OUT);
try {
  await runAll(ORIGIN, ok, Object.keys(SESSIONS), CDP0);
  if (process.argv.includes('--mutants')) {
    const { copyTree, mutateFile, startOverlay } = await import('./pokemonarena_overlay.mjs');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-lead-page-mut-'));
    let killed = 0;
    try {
      for (const mu of MUTANTS) {
        const failed = [];
        const rec = (cond, name, detail) => { if (!cond) failed.push(name + (detail ? ' :: ' + String(detail).slice(0, 160) : '')); };
        const dir = copyTree(path.join(root, 'pokemonarena'), path.join(tmp, mu.id));
        let ov = null;
        try {
          try { mutateFile(dir, mu.file, mu.from, mu.to); } catch (e) { ok(false, 'LPMUT ' + mu.id + ' could not be applied', e.message); continue; }
          ov = await startOverlay({ dir, port: PORT + 12, upstream: ORIGIN });
          await runAll(ov.url, rec, mu.sessions, CDP0 + 20);
        } finally { if (ov) ov.stop(); }
        const hit = failed.find((f) => f.startsWith(mu.fails));
        ok(!!hit, 'LPMUT ' + mu.id + ' (' + mu.what + ') fails ' + mu.fails, hit ? '' : 'it did NOT: failed cases = ' + J(failed.map((f) => f.slice(0, 60))));
        if (hit) killed++;
      }
    } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_e) { /* ignore */ } }
    console.log(`lead page mutants: ${killed}/${MUTANTS.length} killed`);
  }
} finally { stopServer(); }
console.log('\n' + (fail ? 'FAILED' : 'OK') + ': ' + pass + ' passed, ' + fail + ' failed (' + ((Date.now() - t0) / 1000).toFixed(0) + ' s)');
if (fail) { console.log(failures.join('\n')); process.exit(1); }

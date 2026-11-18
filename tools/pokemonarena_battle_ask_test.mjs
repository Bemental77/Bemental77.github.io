// tools/pokemonarena_battle_ask_test.mjs -- THE QUESTIONS OF A BATTLE AGAINST THE CPU, IN THE PICTURE (pokemonarena/js/battle_ask.js), in Node: no browser.
//
//   node tools/pokemonarena_battle_ask_test.mjs             the cases
//   node tools/pokemonarena_battle_ask_test.mjs --mutants   ALSO break battle_ask.js one way at a time; every break must fail the case it names
//
// NOTHING IS FAKED BELOW THE PAGE: battle_ask.js runs the real hub presence service (hub_presence.js), the real dialog layer (hub_dialog.js), the real presence_boot.js / presence.js and the real
// board (openlobby.js) over the same-browser transport (Node's own BroadcastChannel, what net=local uses in a browser), and the real ROM renderer (battle_ui.js, hub_screen.js) for the pixels.
// Doubled: window (storage, address, listeners), document, the profile store (Node has no IndexedDB: the trainer reads as "Player"), and navigation (recorded).
//
// The cases:
//   K1  dormant: nothing in the picture, no board, and the pause menu's row once the module is up (none before)
//   K2  the row switches it on and off; done() comes back when the switch shows its new state
//   K3  a challenge: drawn in the picture, NO highlighted, the page told to pause; A answers nothing for DIALOG_ARM_TICKS; B is NO (the asker is told); the page told to un-pause
//   K4  a held direction's repeat never moves the highlight; YES writes the accept token and leaves; arena.back (the hub's, read only here) is left as it was
//   K5  the Controls dialog / the Sound panel: the question WAITS, and appears (listening 0.6 s later) when the panel closes
//   K6  the disclosure in the picture: nothing published before YES, NO not remembered, YES remembered and on
//   K7  the pixels: the question over the battle's frame, the rest of the frame untouched
//   K8  a module that cannot load: no row, no question, nothing throws
//   K9  the pointer: a click on YES before the question listens answers nothing; after, it answers
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readRom } from './pokemonarena_hub_lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const SRC = path.join(root, 'pokemonarena', 'js');
const WANT_MUTANTS = process.argv.includes('--mutants');
let pass = 0, fail = 0, quiet = false;
const failures = [];
function ok(cond, name, detail) { if (cond) pass++; else { fail++; failures.push(name + (detail ? ' :: ' + String(detail).slice(0, 300) : '')); if (!quiet) console.log('FAIL', name, detail ? String(detail).slice(0, 300) : ''); } }
const J = (x) => JSON.stringify(x);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = async (cond, ms = 3000) => { const t0 = Date.now(); while (!cond() && Date.now() - t0 < ms) await sleep(5); return !!cond(); };
const PK_FAKE = 'A'.repeat(43) + '.' + 'B'.repeat(43);
const CHANNEL = 'bemental-arena-open-1';
const rom = readRom();
let seq = 0;
const hex16 = () => (0xba5e0000 + ++seq).toString(16).padStart(16, '0');
const memStorage = (init = {}) => { const store = { ...init }; return { store, getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } }; };
function makeWin(search, { local = {}, session = {} } = {}) {
  const ls = new Map();
  return {
    location: { search, origin: 'http://x', assign() {} }, localStorage: memStorage(local), sessionStorage: memStorage(session),
    performance: { now: () => performance.now() }, crypto: globalThis.crypto, BroadcastChannel: globalThis.BroadcastChannel,
    setTimeout: (...a) => setTimeout(...a), clearTimeout: (...a) => clearTimeout(...a), console: { warn() {}, error() {}, log() {} },
    addEventListener(t, f) { if (!ls.has(t)) ls.set(t, new Set()); ls.get(t).add(f); }, removeEventListener(t, f) { if (ls.has(t)) ls.get(t).delete(f); },
  };
}
const makeDoc = () => ({ hidden: false, getElementById: () => null, addEventListener() {}, removeEventListener() {} });

async function load(dir) {
  const imp = (f) => import(pathToFileURL(path.join(dir, f)).href + '?x=' + Math.random().toString(36).slice(2));
  // (battle_ask.js is loaded from `dir` -- the real file or a mutant; everything it stands on is the game's own)
  const A = await imp('battle_ask.js');
  const own = (f) => import(pathToFileURL(path.join(SRC, f)).href);
  const [HS, HD, B, OL, T, OM, R, P] = await Promise.all(['hub_screen.js', 'hub_dialog.js', 'battle_ui.js', 'openlobby.js', 'tables.js', 'online_match.js', 'rom.js', 'presence.js'].map(own));
  const ui = B.createBattleUi(rom), pack = T.loadPack(rom, { verify: 'header', dexText: false });
  return { A, HS, HD, B, OL, P, ui, pack, fp: OM.engineFingerprint(pack), romSha: R.PINNED.sha256, boot: () => own('presence_boot.js') };
}

async function suite(M) {
  const { A, HD, P, ui } = M;
  const pages = [], askers = [];
  const measure = (font, s) => ui.measure(font, ui.safeText(String(s)));
  /** One CPU battle page: a window double, the ask, what the page was told (changed: the pause), where it left for. */
  function page(search = '?net=local', o = {}) {
    const win = makeWin(search, o), w = { win, nav: [], changes: [], panel: false };
    w.ask = A.createBattleAsk({ win, doc: makeDoc(), pack: M.pack, navigate: (url) => { const ss = win.sessionStorage; w.nav.push({ url, accept: ss.getItem(P.ACCEPT_KEY), back: ss.getItem('arena.back') }); },
      measure, msgPx: ui.R.msg.w - 4, panelOpen: () => w.panel, changed: () => { w.changes.push(w.ask ? w.ask.isOpen() : null); }, loadBoot: o.loadBoot || M.boot });
    w.cur = () => w.ask.layer.current();
    w.text = () => { const v = w.ask.view(); return v ? v.lines.filter(Boolean).join(' ') : null; };
    w.sid = () => (w.ask.svc.mount && w.ask.svc.mount.lobbies ? w.ask.svc.mount.lobbies.sid : null);
    w.toggle = () => new Promise((res) => { w.ask.toggle(() => res(true)); setTimeout(() => res(false), 4000); });
    w.setPanel = (v) => { w.panel = !!v; w.ask.panels(); };
    pages.push(w);
    return w;
  }
  function asker(name = 'Zed') {
    const lob = M.OL.createOpenLobbies({ bus: M.OL.createLocalBus({ BroadcastChannel: globalThis.BroadcastChannel }), now: () => performance.now(), mine: { rom: M.romSha, fp: M.fp } });
    const a = { lob, heard: [] };
    lob.onSignal((m) => a.heard.push(m));
    a.ask = (to) => { const r = hex16(); lob.signal('chal', { to, r, name, pk: PK_FAKE }); return r; };
    a.told = (r) => a.heard.filter((m) => m.r === r).map((m) => m.why || m.k);
    askers.push(a);
    return a;
  }
  const spy = new globalThis.BroadcastChannel(CHANNEL), wire = [];
  spy.onmessage = (e) => wire.push(e.data);
  const listed = () => wire.filter((m) => m && m.k === 'open');
  const shown = (w, id) => { const c = w.cur(); return !!c && c.id === id; };
  const endAll = async () => { for (const w of pages.splice(0)) { try { w.ask.dispose(); } catch (_e) { /* ignore */ } } for (const a of askers.splice(0)) { try { a.lob.close(); } catch (_e) { /* ignore */ } } await sleep(20); };
  try {
    /* K1 / K2: dormant, the row, on and off */
    {
      const w = page();
      const before = w.ask.label();
      await w.ask.svc.ready;
      const dorm = { label: w.ask.label(), open: w.ask.isOpen(), lobbies: !!(w.ask.svc.mount && w.ask.svc.mount.lobbies), view: w.ask.view() };
      ok(before === null && dorm.label === 'OPEN TO BATTLES: OFF' && !dorm.open && !dorm.lobbies && dorm.view === null && A.openRowLabel(true) === 'OPEN TO BATTLES: ON', 'K1 a battle with the switch off is dormant: nothing in the picture, no board; the pause menu\'s row (OPEN TO BATTLES: OFF) only once the module is up', J([before, dorm]));
      const n0 = listed().length;
      const done = await w.toggle();
      const onNow = w.ask.label();
      await settle(() => listed().length > n0);
      const listedOn = listed().length > n0, storedOn = w.win.localStorage.getItem('arena.open');
      const doneOff = await w.toggle();
      ok(done && onNow === 'OPEN TO BATTLES: ON' && listedOn && storedOn === '1' && doneOff && w.ask.label() === 'OPEN TO BATTLES: OFF' && w.win.localStorage.getItem('arena.open') === null,
        'K2 the row switches it ON (listed on the board, stored) and OFF; done() comes back each time with the row\'s new state', J([done, onNow, listedOn, doneOff, w.ask.label()]));
      await endAll();
    }
    /* K3 / K4: a challenge */
    {
      const w = page('?net=local&openchal=20000', { session: { 'arena.back': 'center' } });
      await w.ask.svc.ready; await w.toggle();
      await settle(() => !!w.sid());
      const z = asker('Zed'), r = z.ask(w.sid());
      const up = await settle(() => shown(w, 'presence:challenge'));
      const c0 = w.cur();
      const told0 = w.changes.slice();
      const early = [w.ask.press('a'), w.ask.press('b')].every(Boolean);
      const stillUp = shown(w, 'presence:challenge') && w.cur().page === 0;
      ok(up && /^Zed wants to battle you\.$/.test(w.text()) && c0.choice.options.join() === 'YES,NO' && c0.choice.cursor === 1 && c0.armed === false && told0.includes(true),
        'K3 a challenge is IN THE PICTURE ("Zed wants to battle you."), NO highlighted, not yet listening; the page was told (it pauses the battle)', J([up, w.text(), c0, told0]));
      ok(early && stillUp, 'K3b before DIALOG_ARM_TICKS an A and a B answer nothing (the buttons are the question\'s all the same: nothing reaches the battle)', J(w.cur()));
      for (let i = 0; i < HD.DIALOG_ARM_TICKS; i++) w.ask.tick();
      const armed = w.cur().armed;
      w.ask.press('b');
      const gone = await settle(() => z.told(r).includes('declined'));
      ok(armed === true && gone && !w.ask.isOpen() && w.changes[w.changes.length - 1] === false && w.nav.length === 0, 'K3c after DIALOG_ARM_TICKS ticks it listens; B is NO: the asker is told "declined", the question leaves the picture and the page is told (it un-pauses)', J([armed, z.told(r), w.changes.slice(-2)]));
      // K4: a held direction's repeat, then YES
      const y = asker('Yan'), r2 = y.ask(w.sid());
      await settle(() => shown(w, 'presence:challenge'));
      for (let i = 0; i < HD.DIALOG_ARM_TICKS; i++) w.ask.tick();
      for (let p = w.cur().page; p < w.cur().pages - 1; p++) w.ask.press('a');
      w.ask.press('up', { repeat: true }); w.ask.press('down', { repeat: true }); w.ask.press('up', { repeat: true });
      const drift = w.cur().choice.cursor;
      w.ask.press('up');
      const onYes = w.cur().choice.cursor;
      w.ask.press('a');
      await settle(() => w.nav.length > 0);
      const nav = w.nav[0] || {};
      ok(drift === 1 && onYes === 0, 'K4 the repeats of a held direction never move the highlight off NO; a fresh press does', J([drift, onYes]));
      ok(w.nav.length === 1 && /battle\.html\?online=1&auto=host/.test(nav.url) && typeof nav.accept === 'string' && nav.accept.length > 0 && nav.back === 'center' && w.win.sessionStorage.getItem('arena.back') === 'center',
        'K4b YES writes the accept token, THEN leaves for the challenger\'s battle; arena.back (the hub\'s key, read only on this page) is left as it was', J([w.nav, w.win.sessionStorage.store]));
      void r2;
      await endAll();
    }
    /* K5: a DOM panel is up */
    {
      const w = page('?net=local&openchal=20000');
      await w.ask.svc.ready; await w.toggle(); await settle(() => !!w.sid());
      w.setPanel(true);
      const z = asker('Pia'); z.ask(w.sid());
      await settle(() => w.ask.svc.state().challenge !== null);
      const waiting = { st: w.ask.svc.state().challenge, open: w.ask.isOpen() };
      w.setPanel(false);
      const back = { st: w.ask.svc.state().challenge, cur: w.cur() };
      ok(waiting.st === 'waiting' && waiting.open === false && back.st === 'shown' && back.cur && back.cur.id === 'presence:challenge' && back.cur.armed === false,
        'K5 while the Controls dialog or the Sound panel is up the question WAITS (nothing in the picture); when it closes the question appears, and listens only after the arm delay', J([waiting, back]));
      await endAll();
    }
    /* K6: the disclosure */
    {
      const w = page('?net=local&opendisc=1');
      await w.ask.svc.ready;
      const n0 = listed().length;
      const p1 = w.toggle();
      await settle(() => shown(w, 'presence:disclosure'));
      const words = [];
      for (let i = 0; i < 20 && w.cur().page < w.cur().pages - 1; i++) { words.push(w.text()); w.ask.press('a'); }
      words.push(w.text());
      const lastQ = w.cur();
      w.ask.press('a');                                   // (NO is highlighted: A on the last page answers NO)
      const d1 = await p1; await sleep(60);
      const afterNo = { label: w.ask.label(), seen: w.win.localStorage.getItem('arena.open.seen'), listed: listed().length - n0 };
      ok(/public servers/.test(words.join(' ')) && /trainer name/.test(words.join(' ')) && lastQ.choice.cursor === 1 && d1 && afterNo.label === 'OPEN TO BATTLES: OFF' && afterNo.seen === null && afterNo.listed === 0,
        'K6 the row\'s first switch-on asks the disclosure IN THE PICTURE (what is published, where); its NO publishes nothing, is not remembered, and the row says OFF', J([words.slice(0, 2), afterNo]));
      const p2 = w.toggle();
      await settle(() => shown(w, 'presence:disclosure'));
      for (let i = 0; i < 20 && w.cur().page < w.cur().pages - 1; i++) w.ask.press('a');
      w.ask.press('up'); w.ask.press('a');
      const d2 = await p2;
      await settle(() => listed().length > n0);
      ok(d2 && w.ask.label() === 'OPEN TO BATTLES: ON' && w.win.localStorage.getItem('arena.open.seen') === '1' && listed().length > n0, 'K6b its YES is remembered and switches it on (listed)', J([d2, w.ask.label()]));
      await endAll();
    }
    /* K7: the pixels */
    {
      const paint = A.createAskPainter(ui, M.HS.createHubScreen);
      const under = new Uint8Array(240 * 160 * 4); for (let i = 0; i < under.length; i += 4) { under[i] = 10; under[i + 1] = 200; under[i + 2] = 30; under[i + 3] = 255; }
      const layer = M.HD.createDialogLayer({ measure });
      layer.open({ id: 'presence:challenge', pages: [['RED', 'wants to battle you.']], choice: { options: ['YES', 'NO'], cursor: 1 } });
      const out = paint(under, layer.view());
      const px = (u, x, y) => Array.from(u.slice((y * 240 + x) * 4, (y * 240 + x) * 4 + 3));
      let outside = 0, inBox = 0;
      for (let y = 0; y < 160; y++) for (let x = 0; x < 240; x++) {
        const same = J(px(out, x, y)) === J(px(under, x, y));
        if (y < 60 && !same) outside++;
        if (y >= 112 && !same) inBox++;
      }
      ok(paint(under, null) === under && out !== under && outside === 0 && inBox > 240 * 40 && J(px(under, 5, 5)) === J([10, 200, 30]), 'K7 the question is drawn OVER the battle\'s frame (the ROM message box at the bottom); the frame above it is left as it was; no question, no change', J([outside, inBox]));
    }
    /* K8: the module cannot load */
    {
      const w = page('?net=local', { loadBoot: () => Promise.reject(new Error('404')) });
      const r = await w.ask.svc.ready;
      const done = await w.toggle();
      ok(r === false && w.ask.label() === null && !w.ask.isOpen() && done === true && w.ask.press('a') === false, 'K8 when presence_boot.js cannot load there is no row and no question, the row\'s callback still comes back, and nothing throws', J([r, w.ask.label()]));
      await endAll();
    }
    /* K9: the pointer */
    {
      const w = page('?net=local&openchal=20000');
      await w.ask.svc.ready; await w.toggle(); await settle(() => !!w.sid());
      const z = asker('Ola'), r = z.ask(w.sid());
      await settle(() => shown(w, 'presence:challenge'));
      w.ask.press('a', { repeat: false });                // (not armed: no page turn)
      for (let i = 0; i < HD.DIALOG_ARM_TICKS; i++) w.ask.tick();
      for (let p = w.cur().page; p < w.cur().pages - 1; p++) w.ask.press('a');
      const z2 = asker('Ula'); z2.ask(w.sid());           // (a second asker meanwhile is told busy: one question at a time)
      const rects = w.ask.rects(), no = rects[1];
      w.ask.pointer({ kind: 'click', x: no.x + 6, y: no.y + 6 });
      const ans = await settle(() => z.told(r).includes('declined'));
      ok(rects.length === 2 && ans && (!w.ask.isOpen() || w.cur().id !== 'presence:challenge' || w.cur().page === 0), 'K9 a click on NO answers NO', J([rects, z.told(r), w.cur()]));
      const w2 = page('?net=local&openchal=20000');
      await w2.ask.svc.ready; await w2.toggle(); await settle(() => !!w2.sid());
      const q = asker('Eve'), r2 = q.ask(w2.sid());
      await settle(() => shown(w2, 'presence:challenge'));
      // a one-page question would show its options at once: walk it to its last page FIRST, but before it listens a click on an option answers nothing
      const L = w2.cur().pages;
      const early = (() => { for (let i = 0; i < L; i++) w2.ask.press('a'); return w2.cur().page; })();
      ok(early === 0 && w2.ask.rects().length === 0 && w2.ask.isOpen() && !q.told(r2).length, 'K9b before it listens the question turns no page and nothing can be clicked', J([early, w2.ask.rects()]));
      await endAll();
    }
  } finally { await endAll(); try { spy.close(); } catch (_e) { /* ignore */ } }
}

const MUTANTS = [
  { id: 'session-cleared', from: "hook: {}, session: null, button: null,", to: "hook: {}, button: null,", fails: 'K4b' },
  { id: 'answers-dropped', from: "  function run(effects) { for (const e of effects || []) if (e && e.type === 'dialog') safe(() => svc.answer(e)); changed(); }", to: "  function run(effects) { changed(); }", fails: 'K3c' },
  { id: 'arm-clock-dead', from: "    tick() { if (isOpen()) { const fx = layer.tick(); if (fx.length) run(fx); } },", to: "    tick() {},", fails: 'K3c' },
  { id: 'repeat-lost', from: "run(layer.press(action, info || { repeat: false }));", to: "run(layer.press(action, { repeat: false }));", fails: 'K4' },
  { id: 'row-never-back', from: "      Promise.resolve(svc.toggle()).then(fire, fire);", to: "      svc.toggle();", also: [{ from: "      off = svc.onChange(() => { if (svc.isOn() !== before) fire(); });", to: '' }], fails: 'K2' },
  { id: 'row-before-ready', from: "return st === 'loading' || st === 'unavailable' ? null : openRowLabel(svc.isOn());", to: "return openRowLabel(svc.isOn());", fails: 'K1' },
  { id: 'page-not-told', from: "  svc.onChange(changed);\n", to: '', also: [{ from: "measure: env.measure, msgPx: env.msgPx, panelOpen: env.panelOpen, redraw: changed,", to: "measure: env.measure, msgPx: env.msgPx, panelOpen: env.panelOpen, redraw: () => {}," }, { from: "  function run(effects) { for (const e of effects || []) if (e && e.type === 'dialog') safe(() => svc.answer(e)); changed(); }", to: "  function run(effects) { for (const e of effects || []) if (e && e.type === 'dialog') safe(() => svc.answer(e)); }" }], fails: 'K3' },
  { id: 'panel-ignored', from: "measure: env.measure, msgPx: env.msgPx, panelOpen: env.panelOpen,", to: "measure: env.measure, msgPx: env.msgPx, panelOpen: () => false,", fails: 'K5' },
  { id: 'painter-noop', from: "    try { return screen.render({ app: ASK_PATH, screen: ASK_PATH, env: 0, tick: 0, dialog }).rgba; } finally { under = null; }", to: "    under = null; return rgba;", fails: 'K7' },
  { id: 'painter-env', from: "render(f) { if (under) f.rgba.set(under); }", to: "render(f) { void f; }", fails: 'K7' },
];

const A0 = await load(SRC);
await suite(A0);
console.log(`battle ask: ${pass} passed, ${fail} failed`);
if (fail) { console.log(failures.join('\n')); process.exitCode = 1; }
if (WANT_MUTANTS && !fail) {
  const text = fs.readFileSync(path.join(SRC, 'battle_ask.js'), 'utf8');
  let killed = 0;
  for (const mu of MUTANTS) {
    let t = text, bad = '';
    for (const step of [mu, ...(mu.also || [])]) { const n = t.split(step.from).length - 1; if (n !== 1) { bad = 'PATTERN FOUND ' + n + 'x: ' + step.from.slice(0, 60); break; } t = t.replace(step.from, () => step.to); }
    if (bad) { console.log('SURVIVED', mu.id, '--', bad); continue; }
    // the mutant battle_ask.js sits beside a COPY of the game's files (it imports them by relative path); the copy is removed after
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-battleask-mut-'));
    fs.cpSync(SRC, dir, { recursive: true });
    const tmp = path.join(dir, 'battle_ask.js');
    fs.writeFileSync(tmp, t);
    const before = { pass, fail, n: failures.length };
    quiet = true;
    let threw = null;
    try { const M = await load(SRC); M.A = await import(pathToFileURL(tmp).href + '?m=' + mu.id); await suite(M); } catch (e) { threw = e; } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) { /* ignore */ } }
    quiet = false;
    const mine = failures.splice(before.n); pass = before.pass; fail = before.fail;
    const hit = mine.find((f) => f.startsWith(mu.fails + ' '));
    if (hit) killed++; else console.log('SURVIVED', mu.id, '--', threw ? 'it CRASHED: ' + String(threw.message).slice(0, 120) : 'it did NOT fail ' + mu.fails + ' (failed: ' + mine.map((f) => f.split(' ')[0]).join(',') + ')');
  }
  console.log(`mutants: ${killed}/${MUTANTS.length} killed`);
  if (killed !== MUTANTS.length) process.exitCode = 1;
}

// pokemonarena/js/center_boot.js -- the TRAINER CENTER page (center.html): a small room where every trainer who is open to battles is, and where you walk up to one and battle them.
//
//   * WHO IS IN THE ROOM. Two kinds of trainers, from two topics on the same public brokers:
//       - trainers WALKING here (this page, on another device): center_net.js, the room's own topic (name, look, tile, facing, emotes);
//       - trainers who are open SOMEWHERE ELSE in the Arena (the hub's Open switch, a CPU battle, a game listed on Play online): the open-games board (openlobby.js), shown SITTING on the
//         benches. A walker's `here` names their board listing (`b`), so a trainer who is both is drawn once, walking.
//   * BEING HERE MEANS BEING OPEN. Walking in turns Open to battles on for this page (presence_boot.js mountPresence, not remembered: leaving the Center leaves the switch as it was), so anybody
//     can challenge you, from the Center or from Play online, with the dialog every Arena page shows. A challenge accepted here goes to the battle page exactly as from the hub.
//   * CHALLENGING. Walk up to a trainer (or tap them) and press A: the challenge is presence.js createChallenge on this page's own board connection, so the room is told to you SEALED to a one-time
//     key, exactly as on Play online. When it is accepted (or when you join a game somebody listed), this page leaves a one-time MEET token in this tab and opens battle.html?np=ROOM&join=1&meet=1,
//     which presses Join by itself only against that token (online.js).
//   * Nothing is published before the player says so: the page shows the room and a card that says what walking in shares; only "Walk in" connects. A player who is already Open to battles
//     (the hub's switch), or who walked in earlier in this tab, goes straight in.
//
// Test hook: window.__arenaCenter (state, the people in the room, enter / talk / walk helpers). Test seams for the same-browser transport only (?net=local): ctrname, ctrav.

import { createInput } from './input.js';
import { enableDomNav } from './uinav.js';
import { fitPicture, createFullscreen } from './screenfit.js';
import { createLocalBus, createMqttBus, brokersFor, TIMING as BOARD_TIMING } from './openlobby.js';
import { createCenter, CENTER_TOPIC, CENTER_CHANNEL, EMOTES, EMOTE_NAMES, TIMING as CTR_TIMING } from './center_net.js';
import { SPAWN, SPAWNS, SEATS, walkable, ahead, thingAt, isExit, findPath, useSpot, VEC, TILE } from './center_map.js';
import { createPainter } from './center_draw.js';
import { parseAvatar, encodeAvatar, loadAvatar, saveAvatar, randomAvatar, stepField, FIELDS, drawFrame, describeAvatar, SPRITE_W, SPRITE_H } from './avatar.js';
import { writeMeetToken, isOpen, canSeal, createChallenge, TIMING as PRESENCE_TIMING } from './presence.js';
import { cleanName } from './netmatch.js';

export const STEP_MS = 210;           // one tile
export const TURN_MS = 120;           // a direction tapped for less than this only turns
export const IN_KEY = 'arena.center.in';          // sessionStorage: this tab walked in (a reload walks straight back in)
const HUB = '/pokemonarena/';
const PASS = ['net', 'anim', 'arenaturn', 'arenagrace', 'openchal', 'openjoin'];         // test seams the battle page also reads (only honoured there with net=local)

const $ = (id) => document.getElementById(id);
const now = () => performance.now();
const say = (t) => { const live = $('live'); if (live) live.textContent = t; };
const rnd = (n) => { const a = new Uint8Array(n); crypto.getRandomValues(a); return a; };
const ss = (() => { try { return window.sessionStorage; } catch (_e) { return null; } })();
const ls = (() => { try { return window.localStorage; } catch (_e) { return null; } })();

async function main() {
  const q = new URLSearchParams(location.search);
  const local = q.get('net') === 'local';
  const pass = () => { const p = new URLSearchParams(); for (const k of PASS) if (q.get(k) !== null) p.set(k, q.get(k)); const s = p.toString(); return s ? '&' + s : ''; };
  const battleUrl = (qs) => '/pokemonarena/battle.html?' + qs + pass();
  const hubUrl = HUB + (local ? '?net=local' : '');          // (the same-browser transport stays the same-browser transport: a test's hub must not dial the public brokers)
  const canvas = $('center');
  const painter = createPainter(canvas);
  const input = createInput();
  const status = $('ctrStatus');
  const hintEl = $('ctrHint');

  /* ---------------------------------------------------------------- who I am */
  let av = (local && parseAvatar(q.get('ctrav')) && q.get('ctrav')) || loadAvatar(ls);
  if (!av) { av = encodeAvatar(randomAvatar(rnd)); saveAvatar(ls, av); }          // a first visit gets a look of its own (the wardrobe changes it)
  const S = {
    phase: 'outside',                // outside (the card) | in | leaving
    me: { x: SPAWN.x, y: SPAWN.y, d: SPAWN.d, fx: SPAWN.x, fy: SPAWN.y, mv: null, stepN: 0, emote: null },
    path: [], after: null, dest: null,
    pressAt: {}, held: [],
    dlg: null, asking: null,
    name: (local && q.get('ctrname') && cleanName(q.get('ctrname'), 'Player')) || 'Player', rec: null,
    pack: null, packError: null,
    presence: null, boardSid: null, presenceOn: false,
    center: null,
    disp: new Map(),                 // walker s -> { fx, fy, stepN, walkUntil }
    chal: false,
  };
  const me = S.me;
  const hook = window.__arenaCenter = {
    get phase() { return S.phase; }, get me() { return { x: me.x, y: me.y, d: me.d, moving: !!me.mv }; }, get av() { return av; }, get name() { return S.name; },
    get dialog() { return S.dlg ? S.dlg.id : null; }, get presence() { return S.presence; }, get center() { return S.center; }, get boardSid() { return S.boardSid; },
    people: () => people().map((p) => ({ id: p.id, name: p.name, x: p.x, y: p.y, d: p.d, seated: !!p.seated, av: p.av, battle: p.g ? (p.g.h ? 'challenge' : 'join') : null, emote: p.emote ? EMOTES[p.emote.e] : null })),
    enter: () => enter(), talk: (id) => { const p = people().find((x) => x.id === id); if (p) approach(p); return !!p; }, walkTo: (x, y) => walkTo(x, y),
    hint: () => hintNow(), ready: false, errors: [],
  };

  /* ---------------------------------------------------------------- the trainer, the ROM (for the board) */
  const pboot = await import('./presence_boot.js');
  pboot.readTrainer().then((r) => {
    if (r.ok && r.trainer) { if (!(local && q.get('ctrname'))) S.name = r.trainer.name || 'Player'; S.rec = r.trainer.rec || null; }
    if (S.center) S.center.update();
  });
  // The board listing needs the engine's fingerprint, which needs the ROM's tables: the room itself does not, so it is up (and you can walk, and be seen) while this loads.
  const packReady = (async () => {
    const [{ loadVerifiedRom }, { loadPack }] = await Promise.all([import('./romfetch.js'), import('./tables.js')]);
    const { bytes } = await loadVerifiedRom();
    S.pack = loadPack(bytes, { verify: 'header', dexText: false });
    return S.pack;
  })().catch((e) => { S.packError = e; console.warn('[center] the game file did not load; battles cannot start from here', e); return null; });

  /* ---------------------------------------------------------------- the page around the canvas */
  const coarse = () => !!window.matchMedia && (window.matchMedia('(pointer: coarse)').matches || window.matchMedia('(hover: none)').matches);
  const touchPad = coarse();
  const fit = () => fitPicture({ doc: document, win: window, canvas, top: $('top'), padA: $('dpad'), padB: $('ab'), touchPad, hint: touchPad ? 130 : 150 });
  window.addEventListener('resize', fit); window.addEventListener('orientationchange', fit);
  createFullscreen({ doc: document, win: window, buttons: [$('fullBtn'), $('fullExit')], onChange: () => fit(), storage: ss });
  fit();
  for (const b of document.querySelectorAll('[data-btn]')) input.bindPad(b, b.dataset.btn);
  input.registerPointerTarget(canvas, { toLocal: input.mapClientToLogical(canvas, 240, 160), cursor: { actionable: (x, y) => !!tapTarget(x, y) } });
  const focusCanvas = () => { try { canvas.focus({ preventScroll: true }); } catch (_e) { /* ignore */ } };
  $('ctrLook').addEventListener('click', () => openLook());
  $('ctrEmote').addEventListener('click', () => openEmotes());
  $('ctrOnline').addEventListener('click', () => use('board'));
  $('ctrLeave').addEventListener('click', () => leaveAsk());

  /* ---------------------------------------------------------------- dialogs (one at a time; the room stops taking input while one is up) */
  const dlgEl = $('ctrDlg');
  let nav = null;
  function openDialog({ id, title, body, buttons, onClose }) {
    closeDialog(true);
    $('ctrDlgTitle').textContent = title;
    const host = $('ctrDlgBody'); host.textContent = '';
    if (typeof body === 'string') { const p = document.createElement('p'); p.id = 'ctrDlgText'; p.textContent = body; host.append(p); } else if (body) host.append(body);
    const row = $('ctrDlgBtns'); row.textContent = '';
    let cancel = null;
    for (const b of buttons) {
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'textbtn' + (b.primary ? ' primary' : ''); btn.id = b.id; btn.textContent = b.label;
      if (b.cancel) { btn.setAttribute('data-nav-close', ''); cancel = btn; }
      if (b.primary) btn.setAttribute('data-nav-default', '');
      btn.addEventListener('click', () => { if (b.onClick) b.onClick(); else closeDialog(); });
      row.append(btn);
    }
    S.dlg = { id, onClose, cancel };
    dlgEl.hidden = false; dlgEl.dataset.which = id;
    S.held = []; S.path = []; S.after = null; S.dest = null;
    try { nav = enableDomNav(dlgEl, { input, onBack: () => { if (cancel) cancel.click(); else closeDialog(); } }); nav.focusFirst(); } catch (_e) { nav = null; const f = row.querySelector('[data-nav-default]') || row.firstChild; if (f) f.focus(); }
  }
  function closeDialog(silent) {
    if (!S.dlg) return;
    const d = S.dlg; S.dlg = null;
    try { if (nav && nav.disable) nav.disable(); } catch (_e) { /* ignore */ }
    nav = null; dlgEl.hidden = true; delete dlgEl.dataset.which;
    if (d.onClose) { try { d.onClose(); } catch (_e) { /* ignore */ } }
    if (!silent) focusCanvas();
  }
  const setDialogText = (t) => { const p = $('ctrDlgText'); if (p) p.textContent = t; };
  document.addEventListener('keydown', (e) => { if (S.dlg && e.key === 'Escape' && !nav) { if (S.dlg.cancel) S.dlg.cancel.click(); else closeDialog(); } });

  /* ---------------------------------------------------------------- walking in */
  function showOutside(reason) {
    S.phase = 'outside';
    openDialog({
      id: 'entry', title: 'Trainer Center',
      body: (() => {
        const f = document.createDocumentFragment();
        const p1 = document.createElement('p'); p1.id = 'ctrDlgText'; p1.textContent = reason || 'Walk around, meet other trainers who are open to battles, and challenge them. Walk up to someone and press A, or tap them.';
        const p2 = document.createElement('p'); p2.className = 'dim'; p2.id = 'ctrEntryShares';
        p2.textContent = 'While you are inside, you are open to battles: your trainer name, your look, where you stand and your online record (wins and losses) go on public servers that anyone in the Center or on Play online can read, and anyone can challenge you. Nothing else is shared. Leaving the Center takes it all down.';
        f.append(p1, p2); return f;
      })(),
      buttons: [{ id: 'ctrBack', label: 'Back to the Arena', cancel: true, onClick: () => { location.href = hubUrl; } }, { id: 'ctrWalkIn', label: 'Walk in', primary: true, onClick: () => { closeDialog(); enter(); } }],
    });
    status.textContent = 'You are outside the Trainer Center.';
  }
  function enter() {
    if (S.phase === 'in') return;
    S.phase = 'in';
    try { if (ss) ss.setItem(IN_KEY, '1'); } catch (_e) { /* a reload asks again */ }
    const sp = SPAWNS[rnd(1)[0] % SPAWNS.length] || SPAWN;
    me.x = sp.x; me.y = sp.y; me.d = sp.d; me.fx = me.x; me.fy = me.y; me.mv = null; S.path = []; S.after = null; S.dest = null;
    const bus = local ? createLocalBus(window, CENTER_CHANNEL) : createMqttBus(window, { brokers: brokersFor(window), topic: CENTER_TOPIC, timing: { ...BOARD_TIMING, wireMax: CTR_TIMING.wireMax } });
    S.center = createCenter({ bus, me: () => ({ name: S.name || 'Player', av, x: me.x, y: me.y, d: me.d, b: S.boardSid, rec: S.rec }) });
    S.center.start();
    status.textContent = 'You walked into the Trainer Center. Getting ready to battle...';
    say('You are in the Trainer Center.');
    packReady.then(() => { if (S.phase === 'in') startPresence(); });
    focusCanvas();
  }
  async function startPresence() {
    if (!S.pack) { status.textContent = 'The game file could not be loaded, so battles cannot start from here. You can still walk around.'; return; }
    if (!S.presence) {
      S.presence = pboot.mountPresence({
        win: window, doc: document, pack: S.pack, input, enableDomNav, navigate: (u) => { leaveQuietly(); location.assign(u); }, button: null, focusHome: focusCanvas,
        onDialog: { open: () => { S.chal = true; }, close: () => { S.chal = false; setTimeout(focusCanvas, 0); } },
      });
    }
    const ok = await S.presence.setOn(true, { persist: false });
    if (!ok && S.phase === 'in') { status.textContent = 'You are in, but battles could not start from here (Open to battles did not start). Reload the page to try again.'; return; }
    S.presenceOn = true;
    tick();
    refreshStatus();
  }
  function leaveQuietly() {
    if (S.asking) { try { S.asking.cancel(); } catch (_e) { /* ignore */ } S.asking = null; }
    if (S.center) { S.center.close(); S.center = null; }
    S.disp.clear();
  }
  function leaveAsk() {
    openDialog({ id: 'leave', title: 'Leave the Trainer Center?', body: 'You go back to the Arena’s menu. Other trainers stop seeing you here.', buttons: [
      { id: 'ctrStay', label: 'Stay', cancel: true, onClick: () => closeDialog() },
      { id: 'ctrLeaveGo', label: 'Leave', primary: true, onClick: () => leave() },
    ] });
  }
  function leave() {
    closeDialog(true);
    S.phase = 'leaving';
    try { if (ss) ss.removeItem(IN_KEY); } catch (_e) { /* ignore */ }
    leaveQuietly();
    if (S.presence) { try { S.presence.dispose(); } catch (_e) { /* ignore */ } S.presence = null; }
    location.href = hubUrl;
  }
  window.addEventListener('pagehide', () => { if (S.center) { S.center.close(); S.center = null; } });
  // back from the back/forward cache: presence_boot.js took the listing down on pagehide (and, as it was on for this page only, does not put it back): walk in again, which switches it on again
  window.addEventListener('pageshow', (e) => { if (e.persisted && S.phase === 'in' && !S.center) { S.phase = 'outside'; S.presenceOn = false; enter(); } });

  /* ---------------------------------------------------------------- who is in the room (walkers, and the board's players on the benches) */
  function people() {
    const out = [];
    const walkers = S.center ? S.center.list() : [];
    const lob = S.presence && S.presence.lobbies;
    const board = lob ? lob.list() : [];
    const linked = new Set();
    for (const w of walkers) {
      // the walker's listing on the board, by the id they gave (each listing is claimed by the first walker who names it: a copycat cannot take over somebody else's)
      const g = w.b && !linked.has(w.b) ? board.find((x) => x.s === w.b) || null : null;
      if (g) linked.add(g.s);
      const d = S.disp.get(w.s);
      out.push({ id: 'w:' + w.s, name: w.name, av: w.av, x: w.x, y: w.y, d: w.d, fx: d ? d.fx : w.x, fy: d ? d.fy : w.y, step: d && d.walkUntil > now() ? 1 + (Math.floor(now() / 120) % 2) : 0, emote: w.emote, rec: w.rec, g, walker: true });
    }
    let seat = 0;
    for (const g of board) {
      if (linked.has(g.s) || seat >= SEATS.length) continue;
      if (walkers.some((w) => w.b === g.s)) continue;
      const st = SEATS[seat++];
      out.push({ id: 'g:' + g.s, name: g.name, av: parseAvatar(g.av) ? g.av : lookOf(g.s), x: st.x, y: st.y, d: st.d, fx: st.x, fy: st.y, step: 0, seated: true, rec: g.rec, g });
    }
    return out;
  }
  // a trainer whose listing carries no look (an older build) still gets one of their own, the same every time, made from their listing id
  const lookOf = (sid) => encodeAvatar(randomAvatar((n) => Uint8Array.from({ length: n }, (_x, i) => parseInt(String(sid).slice((i * 2) % 16, (i * 2) % 16 + 2), 16) || i)));
  const subOf = (p) => (p.g && !p.g.compatible ? 'other version' : p.seated ? (p.g.h ? 'in the menu' : p.g.q ? 'looking for a battle' : 'waiting for a battle') : p.g ? null : 'arriving');
  function personAt(x, y, list) { return (list || people()).filter((p) => p.x === x && p.y === y).pop() || null; }

  /* ---------------------------------------------------------------- input */
  input.on('action', (ev) => {
    if (S.dlg || S.chal || S.phase !== 'in') return;
    if (ev.native) return;
    if (VEC[ev.action]) {
      if (ev.pressed && !ev.repeat) {
        S.pressAt[ev.action] = now(); S.held = S.held.filter((d) => d !== ev.action).concat(ev.action); S.path = []; S.after = null; S.dest = null;
        // standing still, a press turns at once (a tap shorter than a frame still turns); held on, the loop walks
        if (!me.mv && me.d !== ev.action) { me.d = ev.action; me.wasWalking = false; if (S.center) S.center.moved(); }
      }
      if (!ev.pressed) S.held = S.held.filter((d) => d !== ev.action);
      return;
    }
    if (!ev.pressed) return;
    if (ev.action === 'a') act();
    else if (ev.action === 'x') openEmotes();
    else if (ev.action === 'y') openLook();
    else if (ev.action === 'b') { S.path = []; S.after = null; S.dest = null; }
  });
  input.on('pointer', (ev) => {
    if (ev.kind !== 'click' || S.dlg || S.chal || S.phase !== 'in' || ev.x === null) return;
    const t = tapTarget(ev.x, ev.y);
    if (!t) return;
    if (t.person) approach(t.person);
    else if (t.thing) { const spot = useSpot(t.thing); if (spot) route({ x: spot.x, y: spot.y }, { face: 'up', use: t.thing }); }
    else route({ x: t.x, y: t.y }, isExit(t.x, t.y) ? { exit: true } : null);
  });
  function tapTarget(lx, ly) {
    const list = people();
    // a trainer's sprite is a tile and a half tall: the head is in the tile above
    const hit = list.filter((p) => lx >= p.fx * TILE && lx < (p.fx + 1) * TILE && ly >= p.fy * TILE - 8 && ly < (p.fy + 1) * TILE).sort((a, b) => b.fy - a.fy)[0];
    if (hit) return { person: hit };
    const x = Math.floor(lx / TILE), y = Math.floor(ly / TILE);
    const th = thingAt(x, y);
    if (th) return { thing: th.kind };
    if (walkable(x, y)) return { x, y };
    return null;
  }
  function route(to, after, opts) {
    const r = findPath({ x: me.x, y: me.y }, to, opts);
    if (!r) { say('There is no way through to there.'); return false; }
    S.path = r.steps.slice(); S.after = { ...(after || {}), face: r.face || (after && after.face) || null }; S.dest = { x: to.x, y: to.y };
    if (!S.path.length && !me.mv) arrive();
    return true;
  }
  function walkTo(x, y) { return route({ x, y }, isExit(x, y) ? { exit: true } : null); }
  function approach(p) {
    // already next to them and looking at them: talk at once
    const f = ahead(me.x, me.y, me.d);
    if (!me.mv && f.x === p.x && f.y === p.y) { talk(p); return; }
    route({ x: p.x, y: p.y }, { talk: p.id }, { adjacent: true });
  }
  function arrive() {
    const a = S.after; S.after = null; S.dest = null;
    if (!a) return;
    if (a.face && a.face !== me.d) { me.d = a.face; if (S.center) S.center.moved(); }
    if (a.talk) { const p = people().find((x) => x.id === a.talk); if (p) { const f = ahead(me.x, me.y, me.d); if (f.x === p.x && f.y === p.y) talk(p); else approach(p); } }
    else if (a.use) use(a.use);
    else if (a.exit) leaveAsk();
  }
  /** A: whatever is in front of me. */
  function act() {
    if (me.mv) return;
    const f = ahead(me.x, me.y, me.d);
    const p = personAt(f.x, f.y);
    if (p) { talk(p); return; }
    const th = thingAt(f.x, f.y);
    if (th) use(th.kind);
  }
  function hintNow() {
    if (S.phase !== 'in') return '';
    if (S.asking) return 'Waiting for an answer...';
    const f = ahead(me.x, me.y, me.d);
    const p = personAt(f.x, f.y);
    const A = touchPad ? 'A' : 'Z';          // (what the key is called on this device; the canvas says it in words)
    if (p) return A + ': ' + (p.g ? (p.g.h ? 'challenge ' : 'join ') + p.name : 'talk to ' + p.name);
    const th = thingAt(f.x, f.y);
    if (th) return A + ': ' + (th.kind === 'wardrobe' ? 'change your look' : th.kind === 'board' ? 'Battle online (invite a friend, use a code)' : 'read the sign');
    const n = people().length;
    if (!n) return 'Nobody else is here yet. Trainers who are open to battles appear here.';
    return touchPad ? 'Tap a trainer to battle them' : 'Walk up to a trainer and press Z, or click them';
  }

  /* ---------------------------------------------------------------- talking, and challenging */
  function talk(p) {
    // face them, so the room sees who is being talked to
    const dx = p.x - me.x, dy = p.y - me.y;
    const want = Math.abs(dx) >= Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : (dy < 0 ? 'up' : 'down');
    if (want !== me.d && Math.abs(dx) + Math.abs(dy) === 1) { me.d = want; if (S.center) S.center.moved(); }
    const recText = p.rec ? ' (' + p.rec[0] + '-' + p.rec[1] + ' online)' : '';
    const g = p.g;
    if (!g) {
      openDialog({ id: 'talk', title: p.name, body: p.name + recText + ' is still getting ready to battle. Try again in a moment.', buttons: [{ id: 'ctrOk', label: 'OK', primary: true, cancel: true }] });
      return;
    }
    if (!g.compatible) {
      openDialog({ id: 'talk', title: p.name, body: p.name + ' is playing a different version of the Arena, so a battle with them cannot start. Reloading the page on both devices fixes it.', buttons: [{ id: 'ctrOk', label: 'OK', primary: true, cancel: true }] });
      return;
    }
    if (!S.presenceOn || !S.presence || !S.presence.lobbies) {
      openDialog({ id: 'talk', title: p.name, body: S.packError ? 'The game file could not be loaded here, so battles cannot start from this page.' : 'Getting ready to battle. Try again in a moment.', buttons: [{ id: 'ctrOk', label: 'OK', primary: true, cancel: true }] });
      return;
    }
    const where = p.walker ? ' is here in the Center.' : g.h ? ' is open to battles from the Arena’s menu.' : ' is waiting for an opponent (' + (g.fmt === '6v6' ? '6 v 6' : '3 v 3') + ').';
    const sub = g.h ? 'If they accept, the battle opens on both screens (3 v 3, with your saved team).' : 'You join their game at once (with your saved team).';
    const body = document.createDocumentFragment();
    const t1 = document.createElement('p'); t1.id = 'ctrDlgText'; t1.textContent = p.name + recText + where;
    const t2 = document.createElement('p'); t2.className = 'dim'; t2.textContent = sub;
    body.append(t1, t2);
    openDialog({ id: 'talk', title: 'Battle ' + p.name + '?', body, buttons: [
      { id: 'ctrNo', label: 'Not now', cancel: true },
      { id: 'ctrBattle', label: g.h ? 'Ask to battle' : 'Join their battle', primary: true, onClick: () => (g.h ? challenge(p) : joinListed(p)) },
    ] });
  }
  function goBattle(room) {
    if (!writeMeetToken(ss, room, Date.now())) {
      openDialog({ id: 'talk', title: 'Could not start', body: 'This browser would not keep the room for the battle page (storage is blocked). Use Play online instead.', buttons: [{ id: 'ctrOk', label: 'OK', primary: true, cancel: true }] });
      return;
    }
    closeDialog(true);
    S.phase = 'leaving';
    leaveQuietly();
    status.textContent = 'Opening the battle...';
    location.assign(battleUrl('np=' + encodeURIComponent(room) + '&join=1&meet=1'));
  }
  function joinListed(p) { goBattle(p.g.room); }
  function challenge(p) {
    const lob = S.presence && S.presence.lobbies;
    if (!lob) return;
    if (!canSeal(window.crypto)) {
      openDialog({ id: 'talk', title: 'Cannot challenge', body: 'This browser cannot send a private challenge (it needs a secure page). Use Play online with a room code instead.', buttons: [{ id: 'ctrOk', label: 'OK', primary: true, cancel: true }] });
      return;
    }
    const chalMs = Number(q.get('openchal'));
    const timing = local && Number.isInteger(chalMs) && chalMs >= 300 && chalMs <= 120000 ? { ...PRESENCE_TIMING, answerMs: chalMs, connectMs: chalMs * 2 } : PRESENCE_TIMING;
    if (S.center) { S.center.emote(4); me.emote = { e: 4, at: now() }; }                          // "Battle?" over my head while I wait
    S.asking = createChallenge({
      lobbies: lob, target: p.g, name: S.name, rec: S.rec, timing, crypto: window.crypto,
      on: {
        state: () => setDialogText(p.name + ' accepted! Opening the battle...'),
        accepted: (room) => { S.asking = null; goBattle(room); },
        failed: (code) => {
          S.asking = null;
          const text = code === 'declined' ? p.name + ' said not now.' : code === 'busy' ? p.name + ' is answering another challenge. Try again in a moment.' : code === 'unsupported' ? 'This browser cannot send a private challenge.' : p.name + ' did not answer.';
          openDialog({ id: 'answer', title: 'No battle', body: text, buttons: [{ id: 'ctrOk', label: 'OK', primary: true, cancel: true }] });
          say(text);
        },
      },
    });
    openDialog({ id: 'asking', title: 'Challenge sent', body: 'Asked ' + p.name + ' to battle. Waiting for their answer...', buttons: [
      { id: 'ctrCancelAsk', label: 'Cancel', cancel: true, onClick: () => { if (S.asking) { S.asking.cancel(); S.asking = null; } closeDialog(); say('Challenge cancelled.'); } },
    ] });
  }

  /* ---------------------------------------------------------------- furniture */
  function use(kind) {
    if (kind === 'wardrobe') openLook();
    else if (kind === 'board') {
      openDialog({ id: 'board', title: 'Battle online', body: 'The Battle online page: invite a friend with a link, join a friend’s code, or get matched with anyone. It leaves the Center.', buttons: [
        { id: 'ctrStay', label: 'Stay here', cancel: true },
        { id: 'ctrGoOnline', label: 'Go to Battle online', primary: true, onClick: () => { closeDialog(true); S.phase = 'leaving'; leaveQuietly(); location.assign(battleUrl('online=1')); } },
      ] });
    } else if (kind === 'counter') {
      openDialog({ id: 'sign', title: 'Welcome to the Trainer Center', body: 'Everyone in this room is open to battles. Walk up to a trainer and press A (or tap them) to challenge them. Trainers on the benches are open from somewhere else in the Arena. Change your look at the wardrobe; the notice board is Battle online.', buttons: [{ id: 'ctrOk', label: 'OK', primary: true, cancel: true }] });
    }
  }
  function openEmotes() {
    if (S.phase !== 'in') return;
    const grid = document.createElement('div'); grid.className = 'emotes';
    EMOTES.forEach((e, i) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'textbtn'; b.id = 'ctrEmo' + i; b.textContent = e; b.setAttribute('aria-label', EMOTE_NAMES[i]); b.title = EMOTE_NAMES[i];
      b.addEventListener('click', () => { if (S.center && S.center.emote(i)) me.emote = { e: i, at: now() }; closeDialog(); });
      grid.append(b);
    });
    openDialog({ id: 'emote', title: 'Emote', body: grid, buttons: [{ id: 'ctrEmoClose', label: 'Close', cancel: true }] });
  }
  function openLook() {
    let draft = parseAvatar(av) || randomAvatar(rnd);
    const wrap = document.createElement('div'); wrap.className = 'look';
    const pv = document.createElement('canvas'); pv.width = 4 * SPRITE_W * 4 + 3 * 16; pv.height = SPRITE_H * 4; pv.className = 'lookpv'; pv.id = 'ctrLookPreview';
    const rows = document.createElement('div'); rows.className = 'lookrows';
    const paint = () => {
      const code = encodeAvatar(draft);
      const c = pv.getContext('2d'); c.clearRect(0, 0, pv.width, pv.height);
      ['down', 'left', 'up', 'right'].forEach((d, i) => drawFrame(c, code, d, 0, i * (SPRITE_W * 4 + 16), 0, 4));
      pv.setAttribute('aria-label', describeAvatar(code));
      for (const f of FIELDS) { const v = rows.querySelector('[data-val="' + f.key + '"]'); if (v) v.textContent = f.names[draft[f.key]]; }
    };
    for (const f of FIELDS) {
      const r = document.createElement('div'); r.className = 'lookrow';
      const lab = document.createElement('span'); lab.className = 'lbl'; lab.textContent = f.label;
      const prev = document.createElement('button'); prev.type = 'button'; prev.className = 'textbtn'; prev.textContent = '◀'; prev.setAttribute('aria-label', 'Previous ' + f.label.toLowerCase()); prev.id = 'ctrPrev-' + f.key;
      const val = document.createElement('span'); val.className = 'val'; val.dataset.val = f.key;
      const next = document.createElement('button'); next.type = 'button'; next.className = 'textbtn'; next.textContent = '▶'; next.setAttribute('aria-label', 'Next ' + f.label.toLowerCase()); next.id = 'ctrNext-' + f.key;
      prev.addEventListener('click', () => { draft = stepField(draft, f.key, -1); paint(); });
      next.addEventListener('click', () => { draft = stepField(draft, f.key, 1); paint(); });
      r.append(lab, prev, val, next); rows.append(r);
    }
    wrap.append(pv, rows);
    paint();
    openDialog({ id: 'look', title: 'Your look', body: wrap, buttons: [
      { id: 'ctrLookCancel', label: 'Cancel', cancel: true },
      { id: 'ctrLookRandom', label: 'Random', onClick: () => { draft = randomAvatar(rnd); paint(); } },
      { id: 'ctrLookSave', label: 'Save', primary: true, onClick: () => {
        av = encodeAvatar(draft); saveAvatar(ls, av);
        if (S.center) S.center.update();
        if (S.presence && S.presence.presence) { try { S.presence.presence.refresh(); } catch (_e) { /* ignore */ } }          // the board listing carries the look too
        closeDialog(); say('Your new look is saved.');
      } },
    ] });
  }

  /* ---------------------------------------------------------------- the loop */
  function refreshStatus() {
    if (S.phase !== 'in') return;
    const n = people().length, st = S.center ? S.center.status() : 'down';
    const text = st === 'down' ? 'The Center’s servers cannot be reached right now, so nobody can see you. It keeps trying.'
      : st === 'connecting' ? 'Connecting to the Center...'
      : (n ? n + (n === 1 ? ' other trainer is' : ' other trainers are') + ' here.' : 'Nobody else is here yet.') + (S.presenceOn ? ' You are open to battles.' : ' Getting ready to battle...');
    if (status.textContent !== text) status.textContent = text;          // (a live region: the same words again must not be read out again)
  }
  // WHAT MUST HAPPEN EVEN WHILE THE TAB IS HIDDEN runs on a timer, not in the drawing loop (a browser stops requestAnimationFrame in a hidden tab: a phone that switched apps would otherwise never
  // tell the room which board listing is its own, and could not be challenged from the Center).
  function tick() {
    if (S.phase !== 'in') return;
    // the board connection can be rebuilt (Open switched off and on again in another tab): the room is told the new listing id
    const lob = S.presence && S.presence.lobbies;
    const sid = lob ? lob.sid : null;
    if (sid !== S.boardSid) { S.boardSid = sid; if (lob) lob.startWatching(); if (S.center) S.center.update(); }
    if (S.presenceOn && S.presence && !S.presence.isOn()) {
      S.presenceOn = false; leaveQuietly();
      showOutside('Open to battles was switched off (in another tab), so you left the Center. Walk back in to be open again.');
    }
  }
  setInterval(tick, 500);
  let last = now(), statusAt = 0;
  function frame() {
    const t = now(), dt = Math.min(100, t - last); last = t;
    if (S.phase === 'in') {
      // my own walking
      if (me.mv) {
        const k = Math.min(1, (t - me.mv.t0) / STEP_MS);
        me.fx = me.mv.fx0 + (me.x - me.mv.fx0) * k; me.fy = me.mv.fy0 + (me.y - me.mv.fy0) * k;
        if (k >= 1) {
          me.mv = null; me.fx = me.x; me.fy = me.y;
          if (isExit(me.x, me.y) && !S.path.length && !(S.after && S.after.exit)) { S.held = []; leaveAsk(); }
          else if (!S.path.length && S.after) arrive();
        }
      }
      if (!me.mv && !S.dlg && !S.chal) {
        const held = S.held.filter((d) => input.isDown(d)).pop();
        let dir = null;
        if (held) {
          // standing still, a new direction first TURNS on the spot; held a moment longer (TURN_MS), it walks. Already walking, it just goes that way.
          if (held !== me.d && !me.wasWalking) { me.d = held; if (S.center) S.center.moved(); }
          else if (me.wasWalking || t - (S.pressAt[held] || 0) >= TURN_MS) dir = held;
        } else if (S.path.length) dir = S.path.shift();
        if (dir) {
          me.d = dir;
          const n = ahead(me.x, me.y, dir);
          if (walkable(n.x, n.y)) { me.mv = { fx0: me.x, fy0: me.y, t0: t }; me.x = n.x; me.y = n.y; me.stepN++; me.wasWalking = true; if (S.center) S.center.moved(); }
          else { me.wasWalking = false; if (S.center) S.center.moved(); S.path = []; }
        } else me.wasWalking = false;
      }
      // the others: glide to where they say they are
      if (S.center) {
        const seen = new Set();
        for (const w of S.center.list()) {
          seen.add(w.s);
          let d = S.disp.get(w.s);
          if (!d) { d = { fx: w.x, fy: w.y, walkUntil: 0 }; S.disp.set(w.s, d); }
          const ex = w.x - d.fx, ey = w.y - d.fy, dist = Math.abs(ex) + Math.abs(ey);
          if (dist > 2.5) { d.fx = w.x; d.fy = w.y; }
          else if (dist > 0.001) {
            const stepLen = dt / STEP_MS;
            if (Math.abs(ex) > 0.001) d.fx += Math.sign(ex) * Math.min(Math.abs(ex), stepLen); else d.fy += Math.sign(ey) * Math.min(Math.abs(ey), stepLen);
            d.walkUntil = t + 60;
          }
        }
        for (const s of [...S.disp.keys()]) if (!seen.has(s)) S.disp.delete(s);
      }
      if (me.emote && t - me.emote.at > CTR_TIMING.emoteShowMs) me.emote = null;
      if (t - statusAt > 1000) { statusAt = t; refreshStatus(); }
    }
    const list = S.phase === 'in' ? people() : [];
    const view = list.map((p) => ({ ...p, sub: subOf(p), subBg: p.g && !p.g.compatible ? 'rgba(110, 60, 30, .9)' : p.seated ? 'rgba(50, 60, 80, .9)' : undefined, dim: p.seated || (p.g && !p.g.compatible) }));
    if (S.phase === 'in') view.push({ id: 'me', me: true, name: S.name, av, fx: me.fx, fy: me.fy, d: me.d, step: me.mv ? 1 + (me.stepN % 2) : 0, emote: me.emote });
    const f = ahead(me.x, me.y, me.d);
    const facing = S.phase === 'in' && !me.mv && (personAt(f.x, f.y, list) || thingAt(f.x, f.y)) ? f : null;
    const n = list.length;
    const cssPerPx = canvas.clientWidth / 240 || 4;
    painter.draw({ people: view, target: facing, dest: S.dest, t, title: S.phase === 'in' ? (n + 1) + (n ? ' trainers here' : ' trainer here') : 'Outside', textScale: 11 / (5.2 * cssPerPx) });
    const h = hintNow();
    if (hintEl.textContent !== h) hintEl.textContent = h;
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // straight in: this tab was already inside (a reload), or the player is already Open to battles (they agreed to be listed; the Center adds only their look and where they stand)
  let wasIn = false; try { wasIn = !!ss && ss.getItem(IN_KEY) === '1'; } catch (_e) { wasIn = false; }
  if (wasIn || isOpen(ls)) enter(); else showOutside();
  hook.ready = true;
}

if (typeof document !== 'undefined') {
  window.addEventListener('error', (e) => { if (window.__arenaCenter) window.__arenaCenter.errors.push(String(e.message)); });
  main().catch((e) => { console.error(e); const s = document.getElementById('ctrStatus'); if (s) s.textContent = 'Something went wrong: ' + (e && e.message ? e.message : e); if (window.__arenaCenter) window.__arenaCenter.errors.push(String(e && e.message)); });
}

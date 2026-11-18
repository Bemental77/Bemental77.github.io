// pokemonarena/js/center_ctl.js -- THE TRAINER CENTER's side effects: the only file of the app that reads the ROM's map, talks to a network, stores, sets a timer or leaves the page
// (pokemonarena/INAPP.md "The app interface"; center_hub.js is the pure model it drives, center_screen.js draws it).
//
//   * THE ROOM. The ROM's Pokemon Center is decoded once (center_world.js) and handed to the model (setRoom) and, as RULES, to the room's network (center_net.js roomRules): a position must be
//     a cell of that map a trainer can stand on, a look one of the ROM's trainer sprites, an emote one of the ROM's icons.
//   * WALKING IN TURNS OPEN TO BATTLES ON, FOR THIS PAGE ONLY, through the hub page's one presence service (hub_presence.js), AND NOTHING IS PUBLISHED BEFORE THE PLAYER HAS SAID YES TO WHAT
//     THE CENTER LISTS (the trainer name, the online record, THE LOOK and THE CELL). Who is asked, in the picture, before anything is switched on:
//       - a player who was never told what Open to battles lists: the service's first-time disclosure, with one more sentence (what the Center adds);
//       - a player who was told that, but never what the CENTER lists (they once answered the hub's switch; CENTER_SEEN_KEY is not set): THE CENTER'S OWN QUESTION (center_hub.js askIn):
//         the same facts in the Center's words, then "Walk in?" YES / NO, NO highlighted. Whether their switch is on or off: the look and the cell are news to both.
//     NO leaves the Center; nothing was switched on and nothing is remembered. YES is remembered (CENTER_SEEN_KEY), so it is asked once per browser. The room's own connection is opened only
//     after the switch is on. Leaving takes the room down and puts the switch back as the browser's stored switch says.
//   * WHO IS IN THE ROOM. The room's walkers (center_net.js, topic version 2) and the board's open players (the service's players()) are handed to the model, which draws the first as
//     walking trainers and the second at the spots. This page's own board id rides in its `here`, so the others know which listing is this walker's.
//   * WHAT MUST HAPPEN IN A HIDDEN TAB runs on a timer or on the service's own events, never on the picture's frames (a browser stops those in a hidden tab): telling the room the board id,
//     ageing the roster, noticing that Open to battles went off in another tab (the player is then walked out, with a line saying why).
//   * A CHALLENGE is the service's challenge() (presence.js createChallenge on the page's board connection: the room is told to this page SEALED to a one-time key). Accepted, or a listed
//     game joined: the service's goBattle('join', room) writes the one-time MEET token, remembers that the battle comes back to the Center (INAPP.md "Contract 6") and opens the battle page.
//     CANCEL, and leaving the room, WITHDRAW it (the player who was asked stops seeing the question: they must not be able to say YES to somebody who is gone).
//   * SOMEBODY ASKS THIS PLAYER ("<name> wants to battle you" is the service's question, in the hub's dialog layer, which shows ONE dialog at a time, first in first shown): the Center's own
//     dialogs make way at once (onAsked), so the question is on the screen and not behind a notice nobody is reading. ONE QUESTION AT A TIME: a player who is waiting for an answer to a
//     challenge of their own has it withdrawn, EXCEPT when the two asked EACH OTHER: then exactly one of them withdraws (the smaller board id) and answers, the other keeps waiting.
//   * SOUND. The hub's music key 'pokecenter' while the room is open (see pokemonarena/INAPP.md "CENTER: as built" for what that plays); three of the ROM's own effects by their place in the
//     ROM's song table, which the music map has no key for: the wall bump, the door, the PC.
//
// Test seams, honoured ONLY with the same-browser transport (?net=local), so that two tabs of one browser profile can be two trainers: ctrname=<name>, ctrav=<look code>. That transport
// publishes nothing anywhere, so it asks nothing first unless the address says opendisc=1 (presence_boot.js's own seam, for the same reason).
// Test hook: window.__arenaHub.center = { state(), people(), me(), sid(), wire }.

import { hubPresence } from './hub_presence.js';
import { createCenter, roomRules, CENTER_TOPIC, CENTER_CHANNEL, TIMING as CTR_TIMING } from './center_net.js';
import { createLocalBus, createMqttBus, brokersFor, TIMING as BOARD_TIMING } from './openlobby.js';
import { createGrid } from './center_room.js';
import { centerWorld } from './center_world.js';
import { isLook, loadLook, saveLook, pickLook } from './center_look.js';
import { cleanName } from './netmatch.js';
import { WORDS, DLG } from './center_hub.js';

export const BEAT_MS = 500;
/** localStorage: '1' once the player has said YES to a question that said WHAT THE CENTER LISTS (the service's disclosure with the Center's sentence, or the Center's own question). */
export const CENTER_SEEN_KEY = 'arena.center.seen';
/**
 * The room's three sounds the music map (music_map.js) has no key for. index: the effect's place in the SoulGold ROM's own song table (pokemonarena/MUSIC_MAP.md: SE-WALL-HIT, SE-EXIT, SE-PC-ON),
 * played through the sound system's door for effects by index; key: what is played when another soundtrack is in use (its table has other numbers) or that door is not there.
 */
export const ROOM_SOUNDS = Object.freeze({ bump: Object.freeze({ index: 7, key: null }), door: Object.freeze({ index: 9, key: 'se_back' }), pc: Object.freeze({ index: 4, key: 'se_select' }) });
export const ROOM_SOUNDTRACK = 'soulgold';

export function createCtl(env) {
  const win = env.win, app = env.app;
  const safe = (f, d) => { try { return f(); } catch (_e) { return d; } };
  const query = safe(() => new URLSearchParams(win.location.search), new URLSearchParams(''));
  const local = query.get('net') === 'local';
  const asksFirst = !local || query.get('opendisc') === '1';          // (the same-browser transport publishes nothing anywhere: nothing to ask about)
  const seamName = local && query.get('ctrname') ? cleanName(query.get('ctrname'), 'Player') : null;
  const svc = hubPresence(env);
  const redraw = () => safe(() => env.redraw());
  const run = (fx) => { safe(() => env.run(fx)); redraw(); };

  let room = null, rules = null, roomError = null;
  let gen = 0;                // every enter and leave starts a new one: an answer that arrives for an older one is dropped
  let inside = false;         // walked in: the room's connection is up
  let mine = false;           // Open to battles was switched on by a visit to the Center and has not been put back yet
  let leaving = false;        // on the way out (or the page is going away): the switch going off is then no news
  let center = null, offWatch = null, offSvc = null, timer = 0, boardId = null;
  let chal = null, chalTo = null, chalOk = false;          // my own challenge in flight, the board id of the player it asks, and: they said YES (their battle page is opening the room)
  let entry = null;           // the Center's own question is on the screen: what its answer settles
  let asked = null;           // the request id of the "<name> wants to battle you" the Center has made way for
  let away = 0;               // (a timer) the player is in the Team Builder they opened from the room
  const wire = { sent: 0, heard: 0 };

  function ensureRoom() {
    if (room || roomError) return !!room;
    try {
      const w = centerWorld(env.rom);
      const grid = createGrid(w.room);
      room = w.room;
      rules = roomRules({ walkable: grid.walkable, look: (c) => isLook(c, room.looks), emotes: room.emotes });
      app.setRoom(room);
    } catch (e) { roomError = e; safe(() => win.console.warn('[center] the room could not be read from the ROM', e)); }
    return !!room;
  }
  /** What the signs and the Center's own question say: what is listed, and how it ends for THIS player (a player whose stored switch is on stays listed after leaving). */
  const sharesNow = () => [...WORDS.shares, (safe(() => svc.stored(), false) ? WORDS.sharesStay : WORDS.sharesEnd)];
  /** Has this player said YES to what the Center lists? (A storage that is blocked remembers nothing: they are asked at every visit.) */
  const told = () => safe(() => !!env.storage && env.storage.getItem(CENTER_SEEN_KEY) === '1', false);
  const markTold = () => safe(() => { if (env.storage) env.storage.setItem(CENTER_SEEN_KEY, '1'); });
  /** This browser's look: the stored one when the ROM has such a sprite, else one picked now (and kept). */
  function myLook() {
    const seam = local ? query.get('ctrav') : null;
    if (seam && isLook(seam, room.looks)) return seam;
    let look = loadLook(env.storage);
    if (!look || !isLook(look, room.looks)) { look = pickLook(room.looks, env.freshSeed()); saveLook(env.storage, look); }
    return look;
  }
  /** What the room is told about this page. */
  function meNow() {
    const m = app.me(), t = svc.trainer();
    return { name: seamName || cleanName(t ? t.name : m.name, 'Player'), av: m.look, x: m.x, y: m.y, d: m.d, b: svc.boardId(), rec: t ? t.rec : m.rec };
  }
  const netOf = (s) => (s === 'up' ? 'up' : s === 'down' ? 'down' : 'connecting');
  function push() {
    if (!inside) return;
    const players = svc.players().map((p) => ({ id: p.id, name: cleanName(p.name, 'Trainer'), rec: p.rec, look: p.look, doing: p.doing, room: p.room, fmt: p.fmt, compatible: p.compatible }));
    app.setRoster({ walkers: center ? center.list() : [], players });
    app.setNet(center ? netOf(center.status()) : 'off');
    const t = svc.trainer();
    app.setMe({ name: seamName || (t ? cleanName(t.name, 'Player') : undefined), rec: t ? t.rec : null });
    app.setShares(sharesNow());
    redraw();
  }
  /** The board connection can be rebuilt (the switch went off and on): the room is told the new listing id. */
  function syncBoard() { const b = svc.boardId(); if (b !== boardId) { boardId = b; if (center) center.update(); } }
  function beat() { if (!inside) return; syncBoard(); push(); }
  const dropChal = () => { if (chal) safe(() => chal.cancel()); chal = null; chalTo = null; chalOk = false; };          // (cancel() tells the player who was asked: their question closes)
  /**
   * SOMEBODY ASKS THIS PLAYER TO BATTLE while the Center is the open screen (the service's question is in the hub's dialog layer). Called at every change the service announces.
   *   - the Center's own dialogs make way (once per question), so the question is the one on the screen: a notice nobody pressed A on must not turn the question into an automatic NO;
   *   - ONE QUESTION AT A TIME: if this player is waiting for an answer to a challenge of their own, that challenge is withdrawn (with a line saying so behind the question) ...
   *   - ... EXCEPT WHEN THE TWO ASKED EACH OTHER. Both pages see the same two board ids, so both know which of them gives way: the one with the SMALLER id withdraws its challenge and sees
   *     the other's question; the other keeps waiting for the answer (the question it was sent closes when the withdrawal arrives). One battle, never two rooms and never two automatic NOs.
   *   - A CHALLENGE OF THIS PLAYER'S THAT WAS ACCEPTED IS NOT WITHDRAWN: the player who said YES has left for the battle page and is opening the room for this one. Whoever asks now is told
   *     no at once (the service's decline), and "accepted! Opening the battle..." stays on the screen.
   * When the question is gone, what was put away for it comes back (the Center's own question).
   */
  function onAsked() {
    const p = safe(() => (svc.state().challenge && svc.mount ? svc.mount.pending() : null), null);
    if (!p) { if (asked !== null) { asked = null; if (app.resume() === false) { settleEntry(false); run(app.out()); } redraw(); } return; }
    if (asked === p.r) return;
    asked = p.r;
    if (chal && chalOk) { safe(() => svc.mount.decline()); return; }
    app.makeWay();
    if (chal) {
      const mutual = p.s === chalTo;
      const waits = mutual && String(svc.boardId()) > String(p.s);
      if (!waits) { dropChal(); app.askWithdrawn(!mutual); }
    }
    redraw();
  }
  function onService() {
    onAsked();
    if (!inside) return;
    if (!svc.isOn() && !leaving) {
      // NOT NOW: the switch also goes off in the instant the page is going away (presence_boot.js's own pagehide), which is no reason to walk anybody out. A turn later this page knows.
      win.setTimeout(() => { if (inside && !leaving && !svc.isOn()) { stopRoom(); run(app.kick('off')); } }, 0);
      return;
    }
    syncBoard(); push();
  }
  function startRoom() {
    const bus0 = local ? createLocalBus(win, CENTER_CHANNEL) : createMqttBus(win, { brokers: brokersFor(win), topic: CENTER_TOPIC, timing: { ...BOARD_TIMING, wireMax: CTR_TIMING.wireMax } });
    const bus = { ...bus0, send: (o) => { wire.sent++; return bus0.send(o); }, onMessage: (f) => bus0.onMessage((m) => { wire.heard++; f(m); }), onStatus: typeof bus0.onStatus === 'function' ? (f) => bus0.onStatus(f) : undefined, status: typeof bus0.status === 'function' ? () => bus0.status() : undefined, close: () => bus0.close() };
    center = createCenter({ bus, me: meNow, rules });
    offWatch = center.watch(push);
    boardId = svc.boardId();
    center.start();
    svc.watchPlayers(true);
    timer = win.setInterval(beat, BEAT_MS);
    inside = true;
    push();
  }
  function stopRoom() {
    inside = false;
    dropChal();                                                          // a challenge in flight is withdrawn: nobody may say YES to a player who has left
    if (timer) { win.clearInterval(timer); timer = 0; }
    if (offWatch) { safe(() => offWatch()); offWatch = null; }
    if (center) { safe(() => center.close()); center = null; }          // (says bye: the others drop this trainer at once)
    safe(() => svc.watchPlayers(false));
    boardId = null;
  }

  const centerOpen = () => safe(() => env.model.path(), '') === 'center';
  /** On for this page only: when the Center is left, the switch goes back to what the browser's stored switch says. */
  function putBack() { if (mine && !svc.stored()) svc.turnOff({ persist: false }); mine = false; }
  /** The Center's own question, in the picture. -> a promise of the answer: true = YES. NO (the model leaves the screen), a question that could not be put, and a visit that ended meanwhile are false. */
  function askIn() {
    return new Promise((res) => {
      if (entry) { const old = entry; entry = null; old(false); }
      if (!app.askIn()) { res(false); run(app.out()); return; }
      entry = res;
      redraw();
    });
  }
  const settleEntry = (v) => { if (entry) { const f = entry; entry = null; f(v); } };
  // THE CELL IS KEPT ONLY FOR THE WAY BACK. A player who left through the PC or TEAM comes back (B in the Team Builder) to where they stood. If they go on to anywhere the Center is not on the
  // way back from (Home), the next visit starts at the door. No hub event says so, so while they are away the trail is looked at on a timer.
  const stopAway = () => { if (away) { win.clearInterval(away); away = 0; } };
  function watchAway() {
    stopAway();
    if (!app.keepsPlace()) return;
    away = win.setInterval(() => { if (!safe(() => env.model.trail().includes('center'), false)) { app.forgetPlace(); stopAway(); } }, BEAT_MS);
  }

  async function enter() {
    const g = ++gen;
    leaving = false;
    stopAway();
    if (inside) stopRoom();
    safe(() => env.sound.music('pokecenter'));
    if (!ensureRoom()) { run(app.kick('noStart')); return; }
    app.setMe({ look: myLook(), name: seamName || undefined });
    app.setNet('off');
    redraw();
    await svc.ready;
    if (g !== gen) return;
    if (!offSvc) offSvc = svc.onChange(onService);                       // (from here on: a player whose switch is on can be asked to battle before they have walked in)
    app.setShares(sharesNow());
    const wasOn = svc.isOn();
    // the service's first-time disclosure is still to be asked: turnOn asks it, with the Center's sentence
    const generic = !wasOn && !!svc.mount && svc.mount.needsDisclosure();
    // THE CENTER'S OWN QUESTION, for a player who was told what Open to battles lists but never what the CENTER lists. Nothing is switched on before YES
    if (!generic && asksFirst && !told()) {
      const yes = await askIn();
      if (g !== gen || !yes) return;                                     // NO: the model has left the screen. Nothing was switched on, nothing is remembered
      markTold();
    }
    // (the first time this asks, in the picture: nothing is published before YES)
    const on = await svc.turnOn({ persist: false, also: WORDS.also });
    const mine0 = on && !wasOn;
    if (mine0) mine = true;
    // left while it was starting: put the switch back, unless the player is in the Center again already (that visit is in charge of it now)
    if (g !== gen) { if (!centerOpen()) putBack(); return; }
    // NO to the disclosure (it still has to be asked): out, without a word. Anything else: it could not start, and the picture says so
    const refused = generic && !!svc.mount && svc.mount.needsDisclosure();
    if (!on) { run(refused ? app.out() : app.kick('noStart')); return; }
    if (generic) markTold();                                             // (YES to the service's disclosure, which carried the Center's sentence)
    if (!app.walkIn(env.freshSeed())) return;
    startRoom();
  }
  function leave() {
    ++gen;
    leaving = true;
    settleEntry(false);
    if (offSvc) { safe(() => offSvc()); offSvc = null; }
    asked = null;
    stopRoom();
    safe(() => env.sound.music('hub'));
    putBack();
    watchAway();
  }

  /* ---- a battle ---- */
  function goBattle(code) {
    leaving = true;                                                      // (the page is leaving: the switch going off on the way is not "you were walked out")
    if (svc.goBattle('join', code)) return true;
    leaving = false;
    app.say('That battle is not open any more.'); redraw();
    return false;
  }
  function ask(eff) {
    const fail = (why) => { app.askFailed(why); redraw(); };
    dropChal();
    if (!svc.isOn()) return fail('off');
    const p = svc.players().find((q) => q.id === eff.id);
    if (!p) return fail('gone');
    if (!svc.canChallenge()) return fail('unsupported');
    const c = svc.challenge(p, {
      state: () => { if (chal === c) chalOk = true; app.askAccepted(); redraw(); },
      accepted: (code) => { if (chal === c) { chal = null; chalTo = null; chalOk = false; } goBattle(code); },
      failed: (why) => { if (chal === c) { chal = null; chalTo = null; chalOk = false; } fail(why); },
    });
    if (!c) return fail('off');
    chal = c; chalTo = eff.id; chalOk = false;
  }
  function roomSound(what) {
    const s = ROOM_SOUNDS[what]; if (!s) return;
    const sys = safe(() => env.sound.system(), null);
    const byIndex = safe(() => !!sys && sys.mixer.soundtrack() === ROOM_SOUNDTRACK && typeof sys.director.playEffectIndex === 'function', false);
    if (byIndex) { safe(() => sys.director.playEffectIndex(s.index, 0)); return; }
    if (s.key) safe(() => env.sound.sfx(s.key));
  }

  // the page is going away (also into the back / forward cache, where dispose() is not called): the room is told at once. Coming back from that cache walks in again.
  const onHide = () => { leaving = true; stopRoom(); };
  const onShow = (e) => { if (e && e.persisted && safe(() => env.model.path(), '') === 'center') enter(); };
  safe(() => { win.addEventListener('pagehide', onHide); win.addEventListener('pageshow', onShow); });

  if (env.hook) env.hook.center = { state: () => ({ inside, mine, leaving, seam: seamName, net: center ? center.status() : 'off', sid: center ? center.sid : null, board: boardId, asking: !!chal, entering: !!entry, told: told(), roomError: roomError ? String(roomError.message || roomError) : null }), people: () => app.people(), me: () => app.me(), sid: () => (center ? center.sid : null), wire };

  return {
    enter, leave,
    effect(eff) {
      if (!eff) return;
      if (eff.type === 'dialog') { if (eff.id === DLG.enter) settleEntry(eff.value === 0); }          // the answer to the Center's own question (YES is option 0)
      else if (eff.type === 'moved') { if (center) center.moved(); }
      else if (eff.type === 'look') { saveLook(env.storage, eff.code); if (center) center.update(); safe(() => svc.relist()); }
      else if (eff.type === 'emote') { if (center && center.emote(eff.e)) { app.myEmote(eff.e); redraw(); } }
      else if (eff.type === 'ask') ask(eff);
      else if (eff.type === 'join') goBattle(eff.room);
      else if (eff.type === 'cancel-ask') dropChal();
      else if (eff.type === 'sound') roomSound(eff.what);
    },
    dispose() {
      ++gen; leaving = true;
      settleEntry(false); stopAway();
      if (offSvc) { safe(() => offSvc()); offSvc = null; }
      stopRoom();
      safe(() => { win.removeEventListener('pagehide', onHide); win.removeEventListener('pageshow', onShow); });
    },
  };
}

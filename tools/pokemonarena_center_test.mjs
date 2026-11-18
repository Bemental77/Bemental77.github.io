// tools/pokemonarena_center_test.mjs -- THE TRAINER CENTER in the hub's picture (pokemonarena/js/center_*.js; pokemonarena/INAPP.md "CENTER: as built"): a walkable Pokemon Center drawn only
// from the ROM, with everyone who is open to battles in it.
//
//   node tools/pokemonarena_center_test.mjs                 the Node checks, then the browser sessions (CB*)
//   node tools/pokemonarena_center_test.mjs node            the Node checks only
//   node tools/pokemonarena_center_test.mjs node pure       ... only the part that needs no network double (looks, the room, the model, the renderer, the room's messages, the tokens)
//   node tools/pokemonarena_center_test.mjs --mutants       also: a copy of the code with ONE defect at a time; each must fail the case it names (Node mutants run on a copy of
//                                                           pokemonarena/js, browser mutants are served over the real files by a small overlay server). CENTER_MUT=<id> runs one.
//   node tools/pokemonarena_center_test.mjs --update        write pokemonarena/center.golden.json (hashes of the pictures only, never pixels) from what the ROM gives now
//   node tools/pokemonarena_center_test.mjs CB3 CB7         only those browser sessions (after the Node checks)
//   ARENA_PORT / ARENA_CDP (or CENTER_PORT / CENTER_CDP; defaults 8241 / 9441; the sessions use CDP+0..+4, the page mutants port+20.. and CDP+10..+50);
//   CENTER_OUT=<dir> for the pictures it writes (default: the system's temp folder)
//
// NODE (nothing is faked below the page: the real hub model, the real renderer and ROM font, the real presence service, presence_boot.js, presence.js and the board over Node's
// BroadcastChannel, which is the transport ?net=local uses in a browser; doubled: window, document, navigation, the sound door):
//   L  looks: the seven-character code of a ROM trainer sprite, old codes, the stored look
//   R  the room read from the ROM: the collision, the door, the nurse, the PC, the wall map, the signs, the spots; the pictures against hashes
//   G  the grid: what is faced from where, the shortest walk, the door mat
//   M  the model: walking in, GBA walking, the ROM's collision, taps, every interaction from the right cell and facing only (what is faced before a trainer underfoot), the menu, the
//      pickers, WHO'S HERE, the people, the words; M14: the Center's own question, its dialogs making way for "wants to battle you", notices that go by themselves
//   S  the renderer: the layers, the depth order, feet on the cell, every text against its window, no art in the source; S5: the name plates (the ROM's chip, none on another)
//   N  the room's messages and roster: version 2, the guards (a position, a look, an emote, a name), what a `here` carries, the two caps
//   T  the one-time MEET token and the battle page's address
//   K  the ctl on two and three pages: nothing published before YES, seeing each other, a step, a look, an emote, a hub player at a spot, a challenge declined and one accepted,
//      the switch going off elsewhere, the switch put back, the sounds (K1-K6); K7 THE CENTER'S OWN QUESTION (a player who once answered the hub's disclosure is still asked before
//      anything is switched on); K8 a challenge that arrives over a notice, a sign, the nurse, a question, the waiting line; two players who ask each other; K9 CANCEL and leaving
//      withdraw a challenge; K10 the public transport, on a double of the MQTT library (the room's own topic; not even a connection before YES)
// BROWSER (real Chrome through tools/headless_cdp.mjs: headless, a throwaway profile, muted; the tabs share one profile, which is what lets ?net=local pair them; everything is read and
// driven through window.__arenaHub, real keys, real taps and a scripted controller): CB0-CB14, listed where they are.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const args = process.argv.slice(2);
const MUTANTS = args.includes('--mutants');
const UPDATE = args.includes('--update');
const NODE_ONLY = args.includes('node');
const PURE_ONLY = args.includes('pure');
const PAGE_MUTANTS_ONLY = args.includes('page-mutants');          // (with --mutants: skip the browser sessions on the real tree and the Node mutants, run only the page mutants)
const ONLY = args.filter((a) => /^CB\d+/.test(a));
const ONE = process.env.CENTER_MUT || '';
const PORT = Number(process.env.CENTER_PORT || process.env.ARENA_PORT || 8241);
const CDP0 = Number(process.env.CENTER_CDP || process.env.ARENA_CDP || 9441);
const OUT = process.env.CENTER_OUT || path.join(os.tmpdir(), 'arena-center-shots');
const SRC = path.join(root, 'pokemonarena', 'js');
const GOLDEN = path.join(root, 'pokemonarena', 'center.golden.json');
const ROM_PATH = process.env.ARENA_ROM || path.join(root, 'gba', 'gbaWasm', 'roms', 'Pokemon SoulGold (v1.1.1).gba');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (x) => JSON.stringify(x);
const fnv = (u8) => { let h = 0x811c9dc5; for (let i = 0; i < u8.length; i++) h = Math.imul(h ^ u8[i], 0x01000193) >>> 0; return h.toString(16).padStart(8, '0'); };
fs.mkdirSync(OUT, { recursive: true });
const romBytes = (() => { const b = fs.readFileSync(ROM_PATH); return new Uint8Array(b.buffer, b.byteOffset, b.length); })();
const S16 = (c) => String(c).repeat(16).slice(0, 16);

/* ================================================================================================ Node checks */
// runNode(jsDir, log, parts) -> the names of the failed cases. jsDir is pokemonarena/js or a copy of it with one defect. parts: { pure, ctl }.
async function runNode(jsDir, log, parts = { pure: true, ctl: true, block: null }) {
  const failed = [];
  failed.checks = 0;
  const ok = (c, name, detail) => { failed.checks++; if (!c) { failed.push(name); if (log) console.log('FAIL', name, detail === undefined ? '' : String(detail).slice(0, 400)); } else if (log && process.env.CENTER_VERBOSE) console.log('ok  ', name); };
  const imp = (f) => import(pathToFileURL(path.join(jsDir, f)).href);
  const [K, R, N, CH, CS, CW, W, HM, HS, B, OL, P, O] = await Promise.all(['center_look.js', 'center_room.js', 'center_net.js', 'center_hub.js', 'center_screen.js', 'center_world.js', 'world_rom.js', 'hub_model.js', 'hub_screen.js', 'battle_ui.js', 'openlobby.js', 'presence.js', 'online.js'].map(imp));
  const ui = B.createBattleUi(romBytes), screen = HS.createHubScreen(ui);
  const { world, room } = CW.centerWorld(ui.rom);
  const grid = R.createGrid(room);
  const looks = room.looks, lk = (i) => K.lookCode(looks[i]);
  const CELL = R.CELL;
  const guard = async (name, fn) => { try { await fn(); } catch (e) { ok(false, name + ' (threw)', e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e); } };

  if (parts.pure) {
    /* ---------------------------------------------------------------- L looks */
    await guard('L', () => {
      ok(looks.length > 100 && looks.every((id) => { const c = K.lookCode(id); return K.LOOK_RE.test(c) && c.length === 7 && K.lookId(c) === id && K.isLook(c, looks); }), 'L1 every ROM trainer sprite a player can be has a seven-character code that reads back to it', looks.length);
      const junk = ['', 'w00000', 'w0000000', 'W000000', 'w00000Z', 'x000000', '0371a52', '5594bbb', 'w00-000', null, 7, {}, undefined];
      ok(junk.every((c) => K.lookId(c) === null && !K.isLook(c, looks)), 'L2 a code of the wrong length or characters, and a code of the hand-drawn Trainer Center, is no look at all', J(junk.filter((c) => K.lookId(c) !== null)));
      const notAvatar = [...Array(400).keys()].find((i) => !looks.includes(i));
      ok(K.lookFor(lk(5), looks) === looks[5] && K.lookFor('0371a52', looks) === looks[0] && K.lookFor(K.lookCode(notAvatar), looks) === looks[0] && K.lookFor(null, looks) === looks[0] && K.lookFor('junk', looks) === looks[0] && !K.isLook(K.lookCode(notAvatar), looks) && K.lookFor(lk(5), []) === null,
        'L3 what is drawn: the sprite the code names; the FIRST avatar for an old code, junk, nothing, or an id the ROM\'s list does not have (Contract 4)', J([K.lookFor('0371a52', looks), notAvatar]));
      const mem = new Map(), store = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)) };
      const saved = K.saveLook(store, lk(9)), bad = K.saveLook(store, '0371a52'), bad2 = K.saveLook(store, 'nope');
      ok(saved && !bad && !bad2 && K.loadLook(store) === lk(9) && K.loadLook({ getItem: () => '0371a52' }) === null && K.loadLook({ getItem: () => { throw new Error('x'); } }) === null && K.loadLook(null) === null && K.LOOK_KEY === 'arena.avatar',
        'L4 the stored look: kept when it is a look code; an old code under the same key reads as none; a storage that throws reads as none', J([saved, bad, K.loadLook(store)]));
      ok(K.pickLook(looks, 0) === lk(0) && K.pickLook(looks, looks.length + 3) === lk(3) && K.pickLook([], 5) === null && K.isLook(K.pickLook(looks, 4294967295), looks), 'L5 a first visit gets one of the ROM\'s looks, whatever the random number', '');
      ok(K.lookCode(-1) === null && K.lookCode(1.5) === null && K.lookCode(36 ** 6) === null && K.lookCode(0) === 'w000000' && K.lookCode(89) === 'w00002h', 'L6 a code is w and the graphics id in base 36, six digits', K.lookCode(89));
    });

    /* ---------------------------------------------------------------- R the room from the ROM */
    await guard('R', () => {
      const m = world.center;
      const rows = []; for (let y = 0; y < 10; y++) { let s = ''; for (let x = 0; x < 15; x++) s += m.canEnter(x, y, 3) ? '.' : '#'; rows.push(s); }
      const nurse = room.nurse, diff = [];
      for (let y = 0; y < 10; y++) for (let x = 0; x < 15; x++) if (room.rows[y][x] !== rows[y][x]) diff.push([x, y]);
      ok(room.w === 15 && room.h === 10 && diff.length === 2 && diff.every(([x, y]) => y === nurse.y && (x === nurse.x || x === nurse.x + 1)) && room.rows.every((r) => r.length === 15),
        'R1 the cells a trainer can stand on are the ROM\'s own collision; only the two cells behind the counter (open in the ROM, reachable by nobody) are closed', J(diff));
      const info = world.centerInfo(m);
      ok(room.door.x === info.doors[0].x && room.door.y === info.doors[0].y && room.door.d === 'down' && grid.isDoor(room.door.x, room.door.y) && nurse.x === info.nurse.x && nurse.talk.x === info.nurseTalk.x && nurse.talk.y === info.nurseTalk.y
        && room.pc.length === info.pc.length && room.pc.every((p, i) => p.x === info.pc[i].x && p.use.y === p.y + 1) && room.map.length === info.regionMap.length && room.signs.length === new Set(m.events.bgs.map((b) => b.x + ',' + b.y)).size && room.signs.length > 0,
        'R2 the door mat, the nurse and where she is addressed from, the PC, the wall map and the signs are where the ROM\'s map puts them', J([room.door, room.nurse, room.pc, room.map, room.signs]));
      const special = new Set([room.door, nurse.talk, ...room.pc.map((t) => t.use), ...room.map.map((t) => t.use), ...room.signs.map((t) => t.use)].map((c) => c.x + ',' + c.y));
      const standOk = (list) => list.every((s) => grid.walkable(s.x, s.y) && !special.has(s.x + ',' + s.y));
      // a name is written under a trainer's feet: two spots in neighbouring columns are at least three rows apart, and none is under the map's top layer (a plant's leaves)
      const near = []; room.spots.forEach((a, i) => room.spots.forEach((b, j) => { if (i < j && Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) < 3) near.push([a, b]); }));
      const pic = world.renderView(m, 0, 0, 240, 160);
      const covered = room.spots.filter((s) => { let n = 0; for (let y = (s.y - 1) * 16; y < (s.y + 1) * 16; y++) for (let x = s.x * 16; x < s.x * 16 + 16; x++) if (pic.over[(y * 240 + x) * 4 + 3]) n++; return n > 24; });
      ok(room.spots.length === R.SPOTS.length && room.spots.length >= 8 && standOk(room.spots) && room.spawns.length === R.SPAWNS.length && standOk(room.spawns) && !near.length && !covered.length && room.spots.every((s) => !(s.y === 8 && s.x >= 11)),
        'R3 the spots and the cells a trainer appears on are floor the ROM lets a trainer stand on, away from the door and the things; no two spots are near each other, none is under a plant or in the corner that says what B does', J([near, covered]));
      ok(room.npcs.length === 2 && room.npcs[0].gfx === W.GFX.NURSE && (room.npcs[1].gfx & W.GFX.MON) !== 0 && m.events.objects.length === 5, 'R4 of the map\'s own five people only the nurse and the Pokemon beside her are in the room', J(room.npcs));
      ok(room.emotes === world.emotes.length && room.emotes === 16 && room.looks.length === world.ow.avatars.length && room.music === m.music, 'R5 the looks, the emotes and the song number are the ROM\'s', J([room.emotes, room.looks.length, room.music]));
      const names = world.emotes.map((e) => e.name);
      ok(names[R.STATUS_EMOTE.menu] === 'pensive' && names[R.STATUS_EMOTE.looking] === 'doubleExclaim' && names[R.STATUS_EMOTE.waiting] === 'exclaim' && names[R.STATUS_EMOTE.other] === 'cross', 'R6 the icons that say what a player at a spot is doing are the ROM icons meant', J(names));
    });

    /* ---------------------------------------------------------------- G the grid */
    await guard('G', () => {
      const things = [['nurse', room.nurse.talk], ['pc', room.pc[0].use], ['map', room.map[0].use], ['sign', room.signs[0].use]];
      const wrong = [];
      for (const [kind, c] of things) {
        if (grid.facing(c.x, c.y, 'up') !== kind) wrong.push(kind + ' not from its cell');
        for (const d of ['down', 'left', 'right']) if (grid.facing(c.x, c.y, d)) wrong.push(kind + ' facing ' + d);
      }
      for (const c of grid.cells()) for (const d of R.DIRS) { const k = grid.facing(c.x, c.y, d); if (k && !things.some(([kind]) => kind === k) ) wrong.push('unknown ' + k); if (k && d !== 'up') wrong.push('not up'); }
      const uses = new Set([room.nurse.talk, ...room.pc.map((t) => t.use), ...room.map.map((t) => t.use), ...room.signs.map((t) => t.use)].map((c) => c.x + ',' + c.y));
      for (const c of grid.cells()) if (!uses.has(c.x + ',' + c.y) && grid.facing(c.x, c.y, 'up')) wrong.push('faced from ' + c.x + ',' + c.y);
      ok(!wrong.length, 'G1 a thing is used from ITS cell, facing up, and from nowhere else: the nurse across the counter, the PC, the wall map, a sign', J(wrong));
      const d0 = room.door, L = { x: d0.x - 1, y: d0.y }, Rt = { x: d0.x + 1, y: d0.y };
      const across = grid.findPath(L, Rt), onto = grid.findPath({ x: d0.x, y: d0.y - 2 }, d0), off = grid.findPath(d0, L), adj = grid.findPath({ x: d0.x, y: d0.y - 3 }, d0, { adjacent: true });
      ok(across && across.steps.length === 4 && onto && onto.steps.length === 2 && off && off.steps.length === 1 && adj && adj.steps.length === 2 && adj.face === 'down',
        'G2 a walk never crosses the door mat or ends on it, unless the mat is where it goes; a trainer on the mat can walk off it', J([across, onto, off, adj]));
      const far = grid.findPath({ x: 7, y: 7 }, { x: 2, y: 5 }), toSolid = grid.findPath({ x: 7, y: 7 }, { x: 11, y: 6 });
      ok(far && far.steps.length === 7 && toSolid && toSolid.face && grid.findPath({ x: 0, y: 0 }, { x: 7, y: 7 }) === null && grid.findPath({ x: 7, y: 7 }, { x: 0, y: 0 }) === null && grid.findPath({ x: 7, y: 7 }, { x: 7, y: 7 }).steps.length === 0,
        'G3 the walk is the shortest; a walk to something solid ends beside it, facing it; there is no walk from or into a wall', J([far, toSolid]));
      // the rule itself, on a room made up for the purpose (in the ROM's room every thing happens to sit right above its cell): not from another cell, not sideways
      const toy = R.createGrid({ w: 3, h: 4, rows: ['...', '...', '...', '...'], door: null, nurse: null, pc: [{ x: 1, y: 0, use: { x: 1, y: 2 } }], map: [{ x: 2, y: 3, use: { x: 1, y: 3 } }], signs: [{ x: 0, y: 0, use: { x: 0, y: 1 } }] });
      ok(toy.facing(1, 1, 'up') === null && toy.facing(1, 3, 'right') === null && toy.facing(0, 1, 'up') === 'sign' && toy.facing(1, 2, 'up') === null, 'G4 a thing is not used from a cell that is not its own, and not sideways, wherever a map puts it', J([toy.facing(1, 1, 'up'), toy.facing(1, 3, 'right'), toy.facing(0, 1, 'up')]));
    });

    /* ---------------------------------------------------------------- M the model (a real hub model, the real font) */
    const mk = (o = {}) => {
      const hub = HM.createHubModel({ mascot: 25, env: 0, measure: screen.measure, msgPx: screen.msgPx, measureFont: screen.measureFont });
      hub.setData({ state: 'ready', activeId: null, profiles: [] });
      const app = hub.apps.center, log = [];
      const run = (fx) => { for (const e of fx || []) log.push(e); return fx || []; };
      const w = {
        hub, app, log,
        st: () => hub.state().apps.center,
        press: (a, info) => run(hub.press(a, info)),
        tick: (n = 1, held) => { let all = []; for (let i = 0; i < n; i++) all = all.concat(run(hub.tick(held))); return all; },
        click: (x, y) => run(hub.pointer({ kind: 'click', x, y })),
        cell: (x, y) => run(hub.pointer({ kind: 'click', x: x * CELL + 8, y: y * CELL + 8 })),
        idle: (max = 900) => { let n = 0; while ((w.st().moving || w.st().walking) && n < max) { w.tick(); n++; } return n; },
        me: () => (hub.view().center.people.find((p) => p.kind === 'me') || null),
        dlg: () => hub.view().dialog || null,
        text: () => { const d = hub.view().dialog; return d ? d.lines.filter(Boolean).join(' ') : null; },
        allText: () => { const out = []; for (let i = 0; i < 20; i++) { const d = hub.view().dialog; if (!d) break; out.push(d.lines.filter(Boolean).join(' ')); if (!d.more) break; hub.press('a'); } return out.join(' '); },
        // to the last page of the dialog that is open (where its options are); and: close whatever is open (bounded: a dialog that will not close must fail a check, not hang the run)
        last: () => { for (let i = 0; i < 20 && hub.view().dialog && hub.view().dialog.more; i++) w.press('a'); return hub.view().dialog || null; },
        clear: () => { for (let i = 0; i < 30 && hub.view().dialog; i++) w.press('b'); return !hub.view().dialog; },
        sounds: () => log.filter((e) => e.app === 'center' && e.type === 'sound').map((e) => e.what),
        of: (type) => log.filter((e) => e.app === 'center' && e.type === type),
        // walk one cell with the d-pad: press, hold through the turn and the step, let go
        walk: (d, cells = 1) => { const turned = w.st().d !== d; w.press(d); w.tick((turned ? 8 : 0) + 16 * cells, [d]); w.tick(1); },
        enter: (n = 0) => { run(hub.goto('center')); return app.walkIn(n); },
      };
      if (!o.noRoom) app.setRoom(room);
      app.setMe({ name: 'CASEY', rec: [12, 3], look: lk(0) });
      if (!o.outside) w.enter(o.spawn || 0);
      return w;
    };
    const walker = (c, name, i, x, y, o = {}) => ({ s: S16(c), name, av: lk(i), x, y, d: 'down', b: null, rec: null, emote: null, ...o });
    const player = (c, name, doing, o = {}) => ({ id: S16(c), name, rec: [1, 2], look: lk(10), doing, room: doing === 'menu' ? null : 'ABCDE', fmt: '3v3', compatible: true, ...o });

    await guard('M1', () => {
      const w = mk({ outside: true });
      w.hub.goto('center');
      const v0 = w.hub.view().center;
      ok(w.st().phase === 'wait' && v0.people.length === 0 && v0.hint === CH.WORDS.starting && w.hub.trail().join() === 'online,center', 'M1a the screen is open, the player has not walked in: nobody is drawn and the picture says it is getting ready', J([w.st(), v0.hint]));
      w.press('a'); w.press('left'); w.tick(40, ['left']); w.click(100, 100);
      ok(w.st().phase === 'wait' && w.of('moved').length === 0 && w.log.every((e) => e.app !== 'center'), 'M1b nothing can be walked, said or asked before walking in', J(w.log));
      w.press('b');
      ok(w.hub.path() === 'online', 'M1c B goes back from there', w.hub.path());
      const none = mk({ noRoom: true, outside: true }); none.hub.goto('center');
      ok(none.app.walkIn(0) === false && none.st().phase === 'wait' && none.hub.view().center.hint === CH.WORDS.noRoom, 'M1d without the ROM\'s room there is nothing to walk into', J(none.st()));
      const a = mk({ spawn: 0 }), b = mk({ spawn: 3 }), c = mk({ spawn: room.spawns.length + 1 });
      ok(a.st().x === room.spawns[0].x && a.st().y === room.spawns[0].y && a.st().d === 'up' && b.st().x === room.spawns[3].x && c.st().x === room.spawns[1].x && a.st().phase === 'in' && a.me().name === 'CASEY',
        'M1e walking in puts the trainer on one of the cells inside the door, picked by the number given, facing the counter', J([a.st(), b.st()]));
      ok(a.hub.faults().length === 0 && none.hub.faults().length === 0, 'M1f nothing threw', J(a.hub.faults().concat(none.hub.faults())));
    });

    await guard('M2', () => {
      const w = mk();                                   // (7,7) facing up
      const fx = w.press('left');
      ok(w.st().d === 'left' && w.st().x === 7 && !w.st().moving && fx.some((e) => e.type === 'sfx' && e.key === null) && fx.some((e) => e.app === 'center' && e.type === 'moved'), 'M2a a direction pressed while standing turns at once, silently, and the room is told', J(fx));
      w.tick(8, ['left']);
      ok(w.st().x === 7 && !w.st().moving, 'M2b ... and for eight frames it only turns', J(w.st()));
      w.tick(1, ['left']);
      const p0 = w.me();
      ok(w.st().x === 6 && w.st().moving && p0.px === 7 * CELL && p0.step !== 0, 'M2c held on, the step begins: the trainer is on the next cell, still drawn where they stood, in a walk picture', J([w.st(), p0]));
      const seen = [p0.px]; const steps = [p0.step];
      for (let i = 0; i < 16; i++) { w.tick(1, ['left']); const p = w.me(); seen.push(p.px); steps.push(p.step); }
      const onePx = seen.slice(0, 16).every((v, i) => v === 7 * CELL - i);
      ok(onePx && seen[16] === 6 * CELL && w.st().x === 5 && w.st().moving, 'M2d a cell is sixteen frames at a pixel a frame, and a held direction keeps walking', J(seen));
      ok(steps.slice(0, 8).every((s) => s === steps[0]) && steps.slice(8, 16).every((s) => s === 0) && steps[16] !== 0 && steps[16] !== steps[0] && [1, 2].includes(steps[0]) && [1, 2].includes(steps[16]),
        'M2e the ROM\'s three-picture walk: a walk picture for the first half of a cell, standing for the second, the other foot on the next cell', J(steps));
      w.tick(16, ['left']); w.tick(40);
      ok(w.st().x === 4 && !w.st().moving && w.me().px === 4 * CELL && w.me().step === 0, 'M2f let go, the trainer finishes the cell and stands', J(w.st()));
      ok(w.of('moved').length === 4 && w.log.every((e) => !(e.type === 'sfx' && e.key)), 'M2g every step is told to the room once, and no step makes the menu\'s blip', J(w.log.map((e) => e.type)));
      // flowing: a new direction while walking is taken without the turn delay
      const f = mk();
      f.press('left'); f.tick(9, ['left']); f.tick(16, ['left']); f.press('up'); f.tick(1, ['up']);
      const at = f.st();
      f.tick(16, ['up']);
      ok(f.st().d === 'up' && f.st().y === 6 && f.st().x === 5 && f.st().moving && at.y === 7 && at.d === 'left', 'M2h a new direction while walking is walked at once at the end of the cell (no turn first)', J([at, f.st()]));
      // a tap of a direction only turns
      const t = mk();
      t.press('right'); t.tick(5, ['right']); t.tick(40);
      ok(t.st().x === 7 && t.st().d === 'right' && !t.st().moving, 'M2i a tap of a direction (shorter than the turn) only turns', J(t.st()));
      // the direction pressed last wins among several held
      const l = mk();
      l.press('left'); l.press('up'); l.tick(8 + 16, ['left', 'up']); l.tick(1);
      ok(l.st().y === 6 && l.st().x === 7, 'M2j of two directions held, the one pressed last is walked', J(l.st()));
      ok(w.hub.faults().length === 0, 'M2k nothing threw', J(w.hub.faults()));
    });

    await guard('M3', () => {
      // the ROM's collision: from every cell a trainer can stand on, in every direction, the model moves exactly when the ROM's map lets a trainer enter the next cell
      const w = mk();
      const wrong = [];
      for (const c of grid.cells()) {
        for (const d of R.DIRS) {
          if (grid.isDoor(c.x, c.y)) continue;                                                              // (the mat: M5)
          if (w.st().x !== c.x || w.st().y !== c.y) { w.cell(c.x, c.y); w.idle(); }
          if (w.st().x !== c.x || w.st().y !== c.y) { wrong.push('cannot reach ' + c.x + ',' + c.y); continue; }
          const n = R.ahead(c.x, c.y, d), want = world.center.canEnter(n.x, n.y, 3) && n.x < 15 && grid.walkable(n.x, n.y);
          if (grid.isDoor(n.x, n.y)) continue;
          const before = w.log.length;
          w.walk(d); w.idle();
          const moved = w.st().x === n.x && w.st().y === n.y, bumped = w.log.slice(before).some((e) => e.app === 'center' && e.type === 'sound' && e.what === 'bump');
          if (moved !== want || bumped === want) wrong.push([c.x, c.y, d, moved, want, bumped].join(' '));
        }
      }
      ok(!wrong.length, 'M3a walls, the counter, the table and the plants stop a trainer exactly where the ROM\'s collision does (every cell, every direction), with the bump', J(wrong.slice(0, 6)));
      const b = mk();
      b.cell(7, 4); b.idle();
      const n0 = b.sounds().length;
      b.press('up'); b.tick(70, ['up']);
      ok(b.st().y === 4 && b.sounds().slice(n0).filter((s) => s === 'bump').length === 3 && !b.st().moving, 'M3b held against the counter the trainer stays, and the bump is heard once every 32 frames, not every frame', J(b.sounds().slice(n0)));
      ok(w.hub.faults().length === 0, 'M3c nothing threw', J(w.hub.faults()));
    });

    await guard('M4', () => {
      const w = mk();
      const fx = w.cell(2, 5);
      ok(fx.some((e) => e.type === 'sfx' && e.key === null) && w.st().walking > 0, 'M4a a tap on a floor cell starts a walk there (silently)', J(fx));
      const n = w.idle();
      ok(w.st().x === 2 && w.st().y === 5 && n >= 7 * 16 && n <= 7 * 16 + 2 && w.of('moved').length === 7, 'M4b ... by the shortest way: seven cells, seven steps', J([n, w.st()]));
      // never across the mat
      w.cell(6, 8); w.idle();
      const seen = [];
      w.cell(8, 8); for (let i = 0; i < 200 && (w.st().moving || w.st().walking); i++) { w.tick(); seen.push(w.st().x + ',' + w.st().y); }
      ok(w.st().x === 8 && w.st().y === 8 && !seen.includes(room.door.x + ',' + room.door.y) && w.hub.path() === 'center', 'M4c a walk past the door goes round the mat', J([...new Set(seen)]));
      // a press of a direction, or B, stops a tapped walk
      w.cell(2, 2); w.tick(20); w.press('down'); w.tick(40);
      ok(!w.st().walking && !(w.st().x === 2 && w.st().y === 2), 'M4d a press of a direction ends a tapped walk', J(w.st()));
      w.cell(2, 2); w.tick(10);
      ok(w.hub.hit(3 * CELL + 2, 2 * CELL + 2) && w.hub.hit(1, 1) === null && w.hub.hit(7 * CELL + 2, 3 * CELL + 2) && w.hub.hit(2 * CELL, 9 * CELL + 2) === null, 'M4e the pointer takes floor cells and things; a wall is nothing', '');
      ok(w.hub.faults().length === 0, 'M4f nothing threw', J(w.hub.faults()));
    });

    await guard('M5', () => {
      const w = mk();                                   // (7,7): the mat is the cell below
      w.walk('down');
      ok(w.st().x === room.door.x && w.st().y === room.door.y && w.hub.path() === 'center', 'M5a walking onto the door mat does not leave', J(w.st()));
      w.press('left'); w.tick(4); w.press('down'); w.tick(4);
      ok(w.hub.path() === 'center' && w.st().d === 'down', 'M5b turning on the mat does not leave', w.hub.path());
      const n0 = w.log.length;
      w.tick(8, ['down']);
      const fx = w.log.slice(n0);
      ok(w.hub.path() === 'online' && fx.some((e) => e.type === 'screen') && fx.some((e) => e.app === 'center' && e.type === 'sound' && e.what === 'door') && w.st().phase === 'closed', 'M5c stepping down off the mat leaves the Center, back to where the player came from, with the door\'s sound', J(fx));
      // a tap on the mat walks there and out
      const t = mk();
      t.cell(room.door.x, room.door.y); t.tick(40);
      ok(t.hub.path() === 'online', 'M5d a tap on the mat walks onto it and out', t.hub.path());
      // the mat only leaves the way it points
      const s = mk();
      s.walk('down'); s.walk('left');
      ok(s.hub.path() === 'center' && s.st().x === room.door.x - 1, 'M5e off the mat sideways is an ordinary step', J(s.st()));
      ok(w.hub.faults().length === 0 && t.hub.faults().length === 0, 'M5f nothing threw', J(w.hub.faults()));
    });

    await guard('M6', () => {
      const w = mk();
      w.cell(7, 5); w.idle(); w.press('a');
      ok(w.dlg() === null, 'M6a A facing nothing does nothing (the nurse is two cells away)', J(w.dlg()));
      w.walk('up'); w.press('left'); w.tick(2); w.press('a');
      ok(w.dlg() === null && w.st().y === room.nurse.talk.y, 'M6b at the counter but not facing it: nothing', J(w.dlg()));
      w.press('up'); w.tick(2); w.press('a');
      const d = w.dlg();
      ok(d && d.id === 'center:nurse' && /TRAINER CENTER/.test(d.lines.join(' ')), 'M6c A across the counter: the nurse welcomes the player', J(d));
      const all = w.allText(), q = w.dlg();
      ok(/open to battles/.test(all) && /PLAY ONLINE/.test(all) && q.choice && q.choice.options.join() === 'PLAY ONLINE,STAY HERE' && q.choice.cursor === 1, 'M6d ... says how to battle someone who is not in the room, and asks, with STAY HERE highlighted', J([all, q.choice]));
      w.press('b');
      ok(w.dlg() === null && w.hub.path() === 'center', 'M6e B stays', w.hub.path());
      w.press('a'); w.allText(); w.press('up'); w.press('a');
      ok(w.hub.path() === 'online' && w.st().phase === 'closed', 'M6f PLAY ONLINE opens the PLAY ONLINE menu', w.hub.path());
      // the PC
      const p = mk();
      const use = room.pc[0].use;
      p.cell(use.x, use.y); p.idle(); p.press('left'); p.tick(2); p.press('a');
      ok(p.hub.path() === 'center', 'M6g at the PC but not facing it: nothing', p.hub.path());
      p.press('up'); p.tick(2);
      const n0 = p.log.length; p.press('a');
      const fx = p.log.slice(n0);
      ok(p.hub.path() === 'builder' && p.hub.trail().join() === 'online,center,builder' && fx.some((e) => e.app === 'center' && e.type === 'sound' && e.what === 'pc') && fx.some((e) => e.type === 'sfx' && e.key === null), 'M6h A at the PC opens the Team Builder on top of the Center, with the PC\'s sound', J([p.hub.trail(), fx]));
      p.hub.press('b');
      ok(p.hub.path() === 'center' && p.st().phase === 'wait', 'M6i B in the Team Builder comes back to the Center', J([p.hub.path(), p.st().phase]));
      p.app.walkIn(5);
      ok(p.st().x === use.x && p.st().y === use.y && p.st().d === 'up', 'M6j ... to where the player stood, at the PC', J(p.st()));
      p.hub.press('b'); p.hub.press('b'); p.hub.goto('center'); p.app.walkIn(2);
      ok(p.st().x === room.spawns[2].x && p.st().y === room.spawns[2].y, 'M6k a player who left through the menu walks in at the door again', J(p.st()));
      // a tap on a thing walks to its cell and uses it
      const t = mk();
      t.cell(room.pc[0].x, room.pc[0].y); t.tick(400);
      ok(t.hub.path() === 'builder', 'M6l a tap on the PC walks up to it and opens the Team Builder', t.hub.path());
      const n = mk();
      n.cell(room.nurse.x, room.nurse.y); n.tick(400);
      ok(n.dlg() && n.dlg().id === 'center:nurse' && n.st().d === 'up', 'M6m a tap on the nurse walks to the counter and talks to her', J(n.dlg()));
      // the wall map and the signs
      const m = mk();
      m.cell(room.map[0].x, room.map[0].y); m.tick(400);
      ok(m.st().mode === 'who', 'M6n the wall map is WHO\'S HERE', J(m.st()));
      m.press('b');
      ok(m.st().mode === 'room', 'M6o ... and B is back in the room', m.st().mode);
      m.cell(room.signs[0].x, room.signs[0].y); m.tick(400);
      const sign = m.dlg(), words = m.allText();
      ok(sign && sign.id === 'center:sign' && /trainer name, record, look and where you stand/.test(words) && /public servers/.test(words) && /challenge you/.test(words) && /takes it all down/.test(words), 'M6p a sign says what the Center shares about you: name, record, look, where you stand, where, that anyone can challenge, and how it ends', words);
      m.app.setShares('ONE TWO THREE'); m.press('a'); m.press('a');
      ok(/ONE TWO THREE/.test(m.allText()), 'M6q ... in the words the ctl hands in (the disclosure\'s)', '');
      ok([w, p, t, n, m].every((x) => x.hub.faults().length === 0), 'M6r nothing threw', J(m.hub.faults()));
    });

    await guard('M7', () => {
      const w = mk();
      const walkers = [walker('1', 'RED', 1, 6, 5, { b: S16('a'), rec: [3, 1] }), walker('2', 'COPY', 2, 3, 6, { b: S16('a') }), walker('3', 'NEW', 3, 9, 5)];
      const players = [player('a', 'RED', 'menu'), player('d', 'GOLD', 'menu', { look: lk(20) }), player('e', 'SILVER', 'looking', { look: '0371a52' }), player('f', 'KRIS', 'waiting', { look: null }), player('9', 'OLD', 'menu', { compatible: false })];
      w.app.setRoster({ walkers, players });
      const P = Object.fromEntries(w.app.people().map((p) => [p.name, p]));
      ok(P.RED.kind === 'walker' && P.RED.doing === 'here' && P.COPY.doing === 'arriving' && P.NEW.doing === 'arriving' && w.app.people().filter((p) => p.name === 'RED').length === 1,
        'M7a a walker who names their listing is drawn once, walking; a second walker naming the same listing does not get it (a copycat cannot take somebody\'s battles)', J(w.app.people().map((p) => [p.name, p.kind, p.doing])));
      ok(P.GOLD.kind === 'spot' && P.GOLD.x === room.spots[0].x && P.GOLD.y === room.spots[0].y && P.GOLD.d === room.spots[0].d && P.SILVER.x === room.spots[1].x && P.KRIS.x === room.spots[2].x,
        'M7b players who are open elsewhere stand at the spots, in order, facing the room', J([P.GOLD, P.SILVER]));
      ok(P.GOLD.emote === R.STATUS_EMOTE.menu && P.SILVER.emote === R.STATUS_EMOTE.looking && P.KRIS.emote === R.STATUS_EMOTE.waiting && P.OLD.emote === R.STATUS_EMOTE.other && P.RED.emote === null, 'M7c an icon over a spot says what its player is doing', J([P.GOLD.emote, P.SILVER.emote, P.KRIS.emote, P.OLD.emote]));
      ok(P.RED.gfx === looks[1] && P.GOLD.gfx === looks[20] && P.SILVER.gfx === looks[0] && looks.includes(P.KRIS.gfx), 'M7d a look draws the ROM sprite it names; an old code draws the first avatar; a player with no look gets one of the ROM\'s', J([P.SILVER.gfx, P.KRIS.gfx]));
      w.app.setRoster({ walkers, players: [player('f', 'KRIS', 'waiting', { look: null }), player('d', 'GOLD', 'menu')] });
      const again = Object.fromEntries(w.app.people().map((p) => [p.name, p]));
      ok(again.KRIS.x === room.spots[2].x && again.KRIS.gfx === P.KRIS.gfx && again.GOLD.x === room.spots[0].x, 'M7e a player keeps their spot (and their look) while they stay', J([again.KRIS, P.KRIS]));
      const many = []; for (let i = 0; i < room.spots.length + 3; i++) many.push(player(String.fromCharCode(97 + i), 'P' + i, 'menu'));
      w.app.setRoster({ walkers: [], players: many });
      const kinds = w.app.people().map((p) => p.kind);
      ok(kinds.filter((k) => k === 'spot').length === room.spots.length && kinds.filter((k) => k === 'list').length === 3 && w.hub.view().center.people.length === room.spots.length + 1, 'M7f more players than spots: the rest are in the list only, not in the picture', J(kinds));
      ok(new Set(w.app.people().filter((p) => p.kind === 'spot').map((p) => p.x + ',' + p.y)).size === room.spots.length, 'M7g no two players share a spot', '');
      w.app.setRoster({ walkers: [{ junk: 1 }, null], players: [null, { id: 5 }] });
      ok(w.app.people().length === 0 && w.hub.faults().length === 0, 'M7h junk in the roster puts nobody in the room and throws nothing', J(w.hub.faults()));
    });

    await guard('M8', () => {
      const w = mk();
      const walkers = [walker('1', 'RED', 1, 6, 5, { b: S16('a'), rec: [3, 1] }), walker('3', 'NEW', 3, 9, 5)];
      const players = [player('a', 'RED', 'menu', { rec: [3, 1] }), player('e', 'SILVER', 'looking'), player('9', 'OLD', 'menu', { compatible: false })];
      w.app.setRoster({ walkers, players });
      // a tap on a trainer walks up to them and talks
      w.click(6 * CELL + 8, 5 * CELL + 4); w.tick(400);
      const d = w.dlg(), d2 = w.last();
      ok(d && d.id === 'center:talk' && d.lines[0] === 'RED   3-1 online' && d.lines[1] === CH.WORDS.here && d.more && !d.choice && d2 && d2.lines.filter(Boolean).join(' ') === CH.WORDS.askDoes && /3 v 3 battle opens on both screens/.test(CH.WORDS.askDoes) && d2.choice && d2.choice.options.join() === 'ASK TO BATTLE,CANCEL' && d2.choice.cursor === 0 && Math.abs(w.st().x - 6) + Math.abs(w.st().y - 5) === 1,
        'M8a a tap on a trainer walks up to them: "<NAME>   W-L online" and where they are, then what asking does (a 3 v 3 battle on both screens if they accept) with ASK TO BATTLE / CANCEL', J([d, d2, w.st()]));
      w.press('b');
      ok(w.dlg() === null && w.of('ask').length === 0, 'M8b B is CANCEL: nothing is asked', '');
      // A facing them
      w.press('a'); w.last(); w.press('a');
      const asking = w.dlg(), ask = w.of('ask');
      ok(ask.length === 1 && ask[0].id === S16('a') && ask[0].name === 'RED' && asking && asking.id === 'center:asking' && /Asked RED to battle/.test(asking.lines[0]) && /Waiting/.test(asking.lines[1]) && asking.choice.options.join() === 'CANCEL' && w.st().asking === S16('a'),
        'M8c ASK TO BATTLE asks that player\'s listing and says so: "Asked RED to battle. Waiting for an answer..." with CANCEL', J([ask, asking]));
      w.press('a'); w.press('b');
      ok(w.dlg() && w.dlg().id === 'center:asking' && w.of('cancel-ask').length === 0, 'M8d the A that asked is not the A that cancels: for 0.6 s the waiting line answers nothing', J(w.dlg()));
      w.tick(HM.DIALOG_ARM_TICKS === undefined ? 36 : HM.DIALOG_ARM_TICKS); w.tick(36); w.press('b');
      ok(w.of('cancel-ask').length === 1 && w.text() === CH.WORDS.cancelled && w.st().asking === null, 'M8e CANCEL withdraws the challenge and says "Challenge cancelled."', w.text());
      w.press('a');
      // accepted, and every way it can end without a battle
      const reask = () => { w.clear(); w.press('a'); w.last(); w.press('a'); };
      reask(); w.app.askAccepted();
      ok(w.text() === 'RED accepted! Opening the battle...' && w.st().asking === null, 'M8f accepted: "RED accepted! Opening the battle..."', w.text());
      const said = {};
      for (const why of ['declined', 'busy', 'timeout', 'unsupported', 'gone', 'off', 'storage']) { reask(); w.app.askFailed(why); said[why] = w.allText(); }
      ok(said.declined === 'RED said not now.' && /answering another challenge/.test(said.busy) && said.timeout === 'RED did not answer.' && /cannot send a private challenge/.test(said.unsupported) && /not open to battles any more/.test(said.gone) && /not open to battles yet/.test(said.off) && /storage/.test(said.storage),
        'M8g declined, busy, no answer, a browser that cannot ask, a player who left: each is said in words', J(said));
      w.clear();
      // a listed game: JOIN THEIR BATTLE
      const sp = w.app.people().find((p) => p.name === 'SILVER');
      w.click(sp.x * CELL + 8, sp.y * CELL + 2); w.tick(600);
      const jd0 = w.dlg(), jd = w.last();
      ok(jd0 && /waiting for an opponent \(3 v 3\)/.test(jd0.lines[1]) && jd && jd.choice && jd.choice.options.join() === 'JOIN THEIR BATTLE,CANCEL' && jd.lines.filter(Boolean).join(' ') === 'You join their 3 v 3 battle at once.', 'M8h a player who hosts a listed game: what joining does, JOIN THEIR BATTLE / CANCEL', J([jd0, jd]));
      w.press('a');
      const join = w.of('join');
      ok(join.length === 1 && join[0].room === 'ABCDE' && join[0].id === S16('e') && w.of('ask').length === 9, 'M8i ... which joins their room (nothing is asked)', J(join));
      // plain lines
      w.app.setRoster({ walkers: [walker('3', 'NEW', 3, w.st().x, w.st().y - 1)], players: [player('9', 'OLD', 'menu', { compatible: false })] });
      w.press('up'); w.tick(2); w.press('a');
      const plain = w.dlg();
      ok(plain && plain.choice === null && plain.lines[1] === CH.WORDS.getting, 'M8j a trainer whose listing has not arrived: a plain line, no question', J(plain));
      w.press('a');
      const old = w.app.people().find((p) => p.name === 'OLD');
      w.click(old.x * CELL + 8, old.y * CELL + 2); w.tick(600);
      const od = w.allText();
      ok(/another version of the Arena/.test(od) && w.of('ask').length === 9 && w.of('join').length === 1, 'M8k a player on another version: a plain line, no question', od);
      ok(w.hub.faults().length === 0, 'M8l nothing threw', J(w.hub.faults()));
    });

    await guard('M9', () => {
      const w = mk();
      const open = w.press('b');
      const mv = w.hub.view().center.menu;
      ok(w.st().mode === 'menu' && open.some((e) => e.type === 'sfx' && e.key === 'se_menu_open') && mv.rows.map((r) => r.label).join() === "LOOK,EMOTE,TEAM,WHO'S HERE,EXIT" && mv.cursor === 0, 'M9a B opens the menu (with the ROM\'s window sound): LOOK, EMOTE, TEAM, WHO\'S HERE, EXIT', J(mv));
      w.tick(30, ['left']);
      ok(w.st().x === 7 && w.st().mode === 'menu', 'M9b nobody walks while the menu is open', J(w.st()));
      w.press('b');
      ok(w.st().mode === 'room', 'M9c B closes it', w.st().mode);
      w.press('start'); const m1 = w.st().mode; w.press('start');
      ok(m1 === 'menu' && w.st().mode === 'room', 'M9d START opens and closes it too', m1);
      // LOOK
      w.press('b'); w.press('a');
      const L0 = w.hub.view().center.look;
      ok(w.st().mode === 'look' && L0.items.length === 16 && L0.items[0] === looks[0] && L0.cursor === 0 && L0.page === 0 && L0.pages === Math.ceil(looks.length / 16), 'M9e LOOK: the ROM\'s trainer sprites, sixteen to a page, the highlight on the look the player has', J(L0));
      const steps = new Set(); for (let i = 0; i < 40; i++) { w.tick(); steps.add(w.hub.view().center.look.step); }
      ok(steps.has(1) && steps.has(2) && steps.has(0), 'M9f the highlighted one walks in place', J([...steps]));
      w.press('right'); w.press('down'); const c1 = w.st().cursor; w.press('up'); w.press('left'); w.press('left');
      ok(c1 === 9 && w.st().cursor === looks.length - 1 && w.hub.view().center.look.page === L0.pages - 1, 'M9g the d-pad walks the grid; left from the first runs onto the last page', J([c1, w.st().cursor]));
      w.press('r'); const pr = w.st().cursor; w.press('l'); w.press('l');
      ok(Math.floor(pr / 16) === 0 && Math.floor(w.st().cursor / 16) === L0.pages - 2, 'M9h L and R turn the page', J([pr, w.st().cursor]));
      const pick = w.st().cursor, n0 = w.log.length; w.press('a');
      const lf = w.log.slice(n0).filter((e) => e.type === 'look');
      ok(lf.length === 1 && lf[0].code === lk(pick) && w.st().mode === 'room' && w.st().look === lk(pick) && w.me().gfx === looks[pick], 'M9i A takes the look: the ctl is told its code, and the player is drawn as it at once', J([lf, w.me()]));
      w.press('b'); w.press('a'); w.press('b');
      ok(w.st().mode === 'menu' && w.st().look === lk(pick), 'M9j B in the picker changes nothing and goes back to the menu', w.st().mode);
      // a click on a sprite takes it; the arrows turn the page
      w.press('a');
      const rr = w.hub.rects(), cell3 = rr.find((r) => r.kind === 'look' && r.index % 16 === 3), next = rr.find((r) => r.kind === 'page' && r.dir === 1);
      w.click(next.x + 2, next.y + 2); const pg = w.hub.view().center.look.page;
      w.click(cell3.x + 4, cell3.y + 4);
      ok(pg === (Math.floor(pick / 16) + 1) % L0.pages && w.st().mode === 'room' && w.st().look === lk(pg * 16 + 3), 'M9k a tap on an arrow turns the page, a tap on a sprite takes that look', J([pg, w.st().look]));
      // EMOTE
      w.press('b'); w.press('down'); w.press('a');
      const E0 = w.hub.view().center.emote;
      ok(w.st().mode === 'emote' && E0.count === 16, 'M9l EMOTE: the ROM\'s sixteen icons', J(E0));
      w.press('right'); w.press('right'); w.press('down'); const ec = w.st().cursor; const n1 = w.log.length; w.press('a');
      const ef = w.log.slice(n1).filter((e) => e.type === 'emote');
      ok(ec === 10 && ef.length === 1 && ef[0].e === 10 && w.st().mode === 'room' && w.st().emote === null, 'M9m A asks the ctl to show it (the bubble appears when the room took it)', J([ec, ef]));
      w.app.myEmote(10);
      const b0 = w.me().emote; const frames = new Set(); let gone = -1;
      for (let i = 0; i < 140; i++) { w.tick(); const e = w.me().emote; if (e) frames.add(e.f); else if (gone < 0) gone = i + 1; }
      ok(b0 && b0.e === 10 && frames.has(0) && frames.has(1) && gone === CH.WALK.emote && CH.WALK.emote === 120, 'M9n the bubble is over the player\'s head for two seconds, its two pictures alternating', J([b0, [...frames], gone]));
      w.app.myEmote(99); w.app.myEmote(-1);
      ok(w.st().emote === null, 'M9o an emote the ROM does not have is not shown', '');
      // TEAM and EXIT
      w.press('b'); w.press('down'); w.press('down'); w.press('a');
      ok(w.hub.path() === 'builder', 'M9p TEAM opens the Team Builder', w.hub.path());
      w.hub.press('b'); w.app.walkIn(0);
      w.press('b'); w.press('up'); const n2 = w.log.length; w.press('a');
      ok(w.hub.path() === 'online' && w.log.slice(n2).some((e) => e.app === 'center' && e.type === 'sound' && e.what === 'door'), 'M9q EXIT leaves the Center', w.hub.path());
      // a tap beside the menu closes it; a tap on the corner opens it
      const t = mk();
      t.click(CH.CGEOM.hint.x + 10, CH.CGEOM.hint.y + 5); const o1 = t.st().mode; t.click(20, 120);
      ok(o1 === 'menu' && t.st().mode === 'room' && t.st().walking === 0, 'M9r a tap on "B: MENU" opens the menu; a tap beside the menu closes it (and walks nowhere)', J([o1, t.st()]));
      t.press('x'); const mx = t.st().mode; t.press('b'); t.press('b'); t.press('y');
      ok(mx === 'emote' && t.st().mode === 'look', 'M9s X is the emotes, Y the looks', J([mx, t.st().mode]));
      ok(w.hub.faults().length === 0 && t.hub.faults().length === 0, 'M9t nothing threw', J(w.hub.faults()));
    });

    await guard('M10', () => {
      const w = mk();
      const walkers = [walker('1', 'RED', 1, 6, 5, { b: S16('a'), rec: [3, 1] })];
      const players = [player('a', 'RED', 'menu')]; for (let i = 0; i < 9; i++) players.push(player(String.fromCharCode(100 + i), 'P' + i, i % 2 ? 'looking' : 'menu'));
      w.app.setRoster({ walkers, players });
      w.press('b'); w.press('down'); w.press('down'); w.press('down'); w.press('a');
      const v = w.hub.view().center.who;
      ok(w.st().mode === 'who' && v.total === 10 && v.rows.length === 5 && v.rows[0].name === 'RED' && v.rows[0].rec === '3-1' && v.rows[0].doing === 'HERE' && v.rows[1].doing === 'IN THE MENU' && v.rows[2].doing === 'LOOKING' && v.down && !v.up,
        'M10a WHO\'S HERE lists everyone who is open: name, record, what they are doing; the walkers first', J(v));
      for (let i = 0; i < 6; i++) w.press('down');
      const v2 = w.hub.view().center.who;
      ok(v2.top > 0 && v2.up && v2.rows[v2.cursor].name === 'P5', 'M10b the list scrolls with the cursor', J(v2));
      w.press('a');
      const d = w.dlg(), dl = w.last();
      ok(d && d.id === 'center:talk' && /^P5/.test(d.lines[0]) && dl && dl.choice && dl.choice.options[0] === 'JOIN THEIR BATTLE', 'M10c A on a row is what A is in front of that trainer (a player who is not in the picture can be battled from here)', J([d, dl]));
      w.press('b'); w.press('b');
      ok(w.st().mode === 'menu', 'M10d B goes back to the menu it was opened from', w.st().mode);
      w.press('a'); w.press('up');
      ok(w.hub.view().center.who.rows[w.hub.view().center.who.cursor].name === 'P8', 'M10e up from the first row is the last', J(w.hub.view().center.who));
      w.app.setRoster({ walkers: [], players: [] });
      const e = w.hub.view().center.who;
      ok(e.total === 0 && e.rows.length === 0 && w.press('a').length === 0, 'M10f nobody else: the list says so and A does nothing', J(e));
      ok(w.hub.faults().length === 0, 'M10g nothing threw', J(w.hub.faults()));
    });

    await guard('M11', () => {
      const w = mk();
      w.app.setRoster({ walkers: [walker('1', 'RED', 1, 6, 5), walker('2', 'BLUE', 2, 6, 6)], players: [] });
      const px0 = w.hub.view().center.people.find((p) => p.name === 'RED').px;
      w.app.setRoster({ walkers: [walker('1', 'RED', 1, 7, 5, { d: 'right' }), walker('2', 'BLUE', 2, 6, 6)], players: [] });
      const seen = [], steps = new Set();
      for (let i = 0; i < 18; i++) { w.tick(); const p = w.hub.view().center.people.find((q) => q.name === 'RED'); seen.push(p.px); steps.add(p.step); }
      ok(px0 === 6 * CELL && seen.slice(0, 16).every((v, i) => v === px0 + i + 1) && seen[17] === 7 * CELL && steps.has(0) && (steps.has(1) || steps.has(2)), 'M11a another trainer glides to the cell they say they are on, a pixel a frame, in the walk pictures', J(seen));
      w.app.setRoster({ walkers: [walker('1', 'RED', 1, 12, 8), walker('2', 'BLUE', 2, 6, 6)], players: [] });
      w.tick();
      ok(w.hub.view().center.people.find((p) => p.name === 'RED').px === 12 * CELL, 'M11b one who is far behind is simply put where they are', '');
      // depth order: top to bottom; on one row the player is last
      w.app.setRoster({ walkers: [walker('1', 'RED', 1, 7, 7), walker('2', 'BLUE', 2, 6, 6), walker('3', 'LOW', 3, 3, 8)], players: [player('d', 'GOLD', 'menu')] });
      w.tick();
      const order = w.hub.view().center.people.map((p) => p.name), ys = w.hub.view().center.people.map((p) => p.py);
      ok(ys.every((y, i) => i === 0 || y >= ys[i - 1]) && order.indexOf('RED') < order.indexOf('CASEY') && order[order.length - 1] === 'LOW', 'M11c the people are given top to bottom; on a shared cell the player is drawn last', J(order));
      // A on a trainer who stands on the player's own cell
      w.press('a');
      ok(w.dlg() && w.dlg().id === 'center:talk' && /^RED/.test(w.dlg().lines[0]), 'M11d people do not block people: a trainer on the player\'s own cell can be talked to', J(w.dlg()));
      w.press('b');
      w.walk('up'); w.walk('left');
      ok(w.st().x === 6 && w.st().y === 6 && w.app.people().some((p) => p.name === 'BLUE' && p.x === 6 && p.y === 6), 'M11e ... and a cell somebody stands on can be walked onto', J(w.st()));
      // what is FACED comes first: somebody standing on the player's own cell does not take the PC, the nurse, a sign or the wall map away
      const taken = [];
      for (const [kind, c] of [['nurse', room.nurse.talk], ['pc', room.pc[0].use], ['map', room.map[0].use], ['sign', room.signs[0].use]]) {
        const x = mk();
        x.cell(c.x, c.y); x.idle(); x.press('up'); x.tick(2);
        x.app.setRoster({ walkers: [walker('1', 'RED', 1, c.x, c.y, { b: S16('a') })], players: [player('a', 'RED', 'menu')] });
        x.press('a');
        const got = kind === 'pc' ? x.hub.path() === 'builder' : kind === 'map' ? x.st().mode === 'who' : !!x.dlg() && x.dlg().id === 'center:' + kind;
        if (!got || x.st().x !== c.x || x.st().y !== c.y) taken.push(kind + ' ' + J([x.hub.path(), x.st().mode, x.dlg() && x.dlg().id]));
      }
      ok(!taken.length, 'M11g what is FACED comes before a trainer who stands on the player\'s own cell: A at the PC, the nurse, a sign and the wall map is still the PC, the nurse, the sign, the map', J(taken));
      ok(w.hub.faults().length === 0, 'M11f nothing threw', J(w.hub.faults()));
    });

    await guard('M12', () => {
      // every text of every screen fits its window, in the real ROM font
      const w = mk();
      const cs = screen.app('center');
      const walkers = [walker('1', 'Wwwwwwwwww', 1, 6, 5, { b: S16('a'), rec: [999999, 999999] }), walker('2', "A.b'c_d!e?", 2, 3, 6)];
      const players = [player('a', 'Wwwwwwwwww', 'menu', { rec: [999999, 999999] }), player('e', 'MMMMMMMMMM', 'looking', { fmt: '6v6', rec: [999999, 999999] }), player('9', 'WWWWWWWWWW', 'menu', { compatible: false })];
      w.app.setRoster({ walkers, players });
      const over = [];
      const check = (where) => { const v = w.hub.view(); for (const m of screen.widths(v).concat(cs.widths(v))) if (m.px > m.max) over.push(where + ': ' + m.what + ' ' + m.px + ' > ' + m.max); const fr = screen.render(v); if (fr.fault) over.push(where + ' fault ' + J(fr.fault)); };
      const pages = (where) => { for (let i = 0; i < 20 && w.dlg(); i++) { check(where + ' p' + i); if (!w.dlg().more) break; w.hub.press('a'); } if (!w.clear()) over.push(where + ': a dialog that B does not close'); };
      check('room');
      for (const p of w.app.people()) { w.press('b'); w.press('down'); w.press('down'); w.press('down'); w.press('a'); const rows = w.hub.view().center.who.total; for (let i = 0; i < rows; i++) { check('who'); if (w.hub.view().center.who.rows[w.hub.view().center.who.cursor].name === p.name) break; w.press('down'); } w.press('a'); pages('talk ' + p.name); w.press('b'); w.press('b'); }
      // asking and every answer
      w.press('b'); w.press('down'); w.press('down'); w.press('down'); w.press('a'); w.press('a'); w.last(); w.press('a'); check('asking');
      w.app.askAccepted(); pages('accepted');
      for (const why of Object.keys(CH.ANSWER_WORDS)) { w.app.askFailed(why); pages('answer ' + why); }
      w.app.say(CH.WORDS.cancelled); pages('cancelled');
      while (w.st().mode !== 'room') w.press('b');
      w.cell(room.nurse.x, room.nurse.y); w.tick(400); pages('nurse');
      w.cell(room.signs[0].x, room.signs[0].y); w.tick(400); pages('sign');
      w.press('b'); check('menu'); w.press('a'); check('look'); w.press('b'); w.press('down'); w.press('a'); check('emote'); w.press('b'); w.press('b');
      const kicked = mk(); kicked.hub.goto('center'); kicked.app.walkIn(0);
      for (const why of ['off', 'noStart']) { const k = mk(); const fx = k.app.kick(why); k.hub.press('x'); const d = k.hub.view().dialog; if (!d || !fx.some((e) => e.type === 'screen')) over.push('kick ' + why + ' did not leave with a line'); for (let i = 0; i < 6 && k.hub.view().dialog; i++) { for (const m of screen.widths(k.hub.view())) if (m.px > m.max) over.push('kick ' + why + ' ' + m.what); k.hub.press('a'); } }
      ok(!over.length, 'M12a every line of every screen and question fits its window in the ROM font (the longest names, the largest records)', J(over.slice(0, 5)));
      // speak() and title()
      const sp = mk();
      sp.app.setRoster({ walkers: [walker('1', 'RED', 1, 6, 5)], players: [] });
      const s0 = sp.app.speak(sp.hub.view());
      sp.press('right'); sp.tick(9, ['right']); const mid = sp.app.speak(sp.hub.view()); sp.tick(40);
      ok(/Trainer Center/.test(s0) && /1 other trainer is here: RED\./.test(s0) && /B opens the menu/.test(s0) && mid === s0 && sp.app.speak(sp.hub.view()) === s0 && /Nobody else is here yet/.test(mk().app.speak(mk().hub.view())) && sp.app.title('center') === 'Pokemon Arena - Trainer Center',
        'M12b the screen reader\'s words name the room, who is here and the keys, and do not change with a step; the title is the screen\'s', J([s0, mid]));
      sp.cell(room.nurse.talk.x, room.nurse.talk.y); sp.idle(); sp.press('up'); sp.tick(2);
      const front = sp.app.speak(sp.hub.view());
      sp.press('b'); const sm = sp.app.speak(sp.hub.view()); sp.press('a'); const sl = sp.app.speak(sp.hub.view()); sp.press('b'); sp.press('down'); sp.press('a'); const se = sp.app.speak(sp.hub.view()); sp.press('b'); sp.press('down'); sp.press('down'); sp.press('a'); const sw = sp.app.speak(sp.hub.view());
      const wait = mk({ outside: true }); wait.hub.goto('center');
      ok(/In front of you: the nurse/.test(front) && /menu: selected LOOK, EMOTE, TEAM, WHO'S HERE, EXIT/.test(sm) && /Your look\. Trainer 1 of \d+/.test(sl) && /Emote 1 of 16/.test(se) && /Who's here: selected RED/.test(sw) && /Getting ready/.test(wait.app.speak(wait.hub.view())),
        'M12c ... and say what is faced, the menu, the pickers and the list', J([front, sm, sl, se, sw]));
      ok(w.hub.faults().length === 0 && sp.hub.faults().length === 0, 'M12d nothing threw', J(w.hub.faults().concat(sp.hub.faults())));
    });

    await guard('M13', () => {
      const w = mk();
      w.app.setRoster({ walkers: [walker('1', 'RED', 1, 7, 6, { b: S16('a') })], players: [player('a', 'RED', 'menu')] });
      w.press('a');
      const had = w.dlg() && w.dlg().id;
      w.hub.goto('main');
      ok(had === 'center:talk' && w.hub.view().dialog === undefined || w.hub.view().dialog === null, 'M13a leaving the Center closes its questions (a question about a trainer makes no sense on the main menu)', J([had, w.hub.view().dialog]));
      const k = mk();
      const fx = k.app.kick('off');
      k.hub.press('x');
      const line = (k.hub.view().dialog || { lines: [] }).lines.join(' ');
      ok(fx.some((e) => e.type === 'screen') && k.hub.path() === 'online' && /OPEN TO BATTLES was switched off/.test(line), 'M13b walked out because Open went off: back to where the player came from, with a line saying why', J([k.hub.path(), line]));
      const o = mk(); o.app.out();
      ok(o.hub.path() === 'online' && !o.hub.view().dialog, 'M13c out after NO to the disclosure: back, without a word', o.hub.path());
      const st = mk().st();
      ok(J(Object.keys(st).sort()) === J(['asking', 'cursor', 'd', 'emote', 'entering', 'look', 'mode', 'moving', 'net', 'people', 'phase', 'walking', 'x', 'y']) && J(st).length < 220, 'M13d state() is small plain JSON', J(st));
      const reg = HM.createHubModel({});
      ok(reg.apps.center.id === 'center' && reg.apps.center.paths.join() === 'center' && reg.apps.center.parent('center') === 'online' && HM.arrivalTrail('center').join() === 'online,center', 'M13e the app is the registry\'s `center`, one path, opened from PLAY ONLINE', '');
    });

    await guard('M14', () => {
      const challenge = { id: 'presence:challenge', pages: [['RED wants to battle you.', '']], choice: { options: ['YES', 'NO'], cursor: 1 }, armTicks: 36 };          // (what the presence service puts in the dialog layer)
      // THE CENTER'S OWN QUESTION
      const w = mk({ outside: true }); w.hub.goto('center');
      const put = w.app.askIn(), q0 = w.dlg();
      ok(put === true && q0 && q0.id === 'center:enter' && q0.armed === false && q0.pages === CH.WORDS.shares.length + 2 && w.st().phase === 'wait' && w.st().entering === true, 'M14a the Center\'s own question is put while the screen waits to be walked into, a page a thought (no sentence is cut in two by a page), and does not listen at once', J([put, q0, w.st()]));
      w.press('a'); w.press('b');
      ok(w.dlg() && w.dlg().id === 'center:enter' && w.dlg().page === 0 && w.hub.path() === 'center', 'M14b ... for 0.6 s neither A nor B does anything (the A that opened the Center turns no page and answers nothing)', J(w.dlg()));
      w.tick(40);
      let words = ''; for (let i = 0; i < 20 && w.dlg() && w.dlg().more; i++) { words += ' ' + w.text(); w.press('a'); }
      const lastQ = w.dlg();
      ok(/open to battles/.test(words) && /trainer name, record, look and where you stand/.test(words) && /public servers/.test(words) && /challenge you/.test(words) && /Nothing else is shared/.test(words) && /takes it all down/.test(words)
        && lastQ && lastQ.lines[0] === CH.WORDS.enterAsk && lastQ.choice && lastQ.choice.options.join() === 'YES,NO' && lastQ.choice.cursor === 1,
        'M14c it says what walking in lists (the name, the record, the look, where you stand), where, that anyone can challenge, that nothing else is shared, and how it ends; then "Walk in?" YES / NO with NO highlighted', words + ' | ' + J(lastQ));
      const n0 = w.log.length; w.press('a');
      const ans = w.log.slice(n0);
      ok(w.hub.path() === 'online' && w.st().phase === 'closed' && w.st().entering === false && !w.dlg() && ans.some((e) => e.type === 'dialog' && e.id === 'center:enter' && e.value === 1 && e.app === 'center') && ans.some((e) => e.type === 'screen'),
        'M14d NO leaves the Center without a word, and the ctl is told the answer', J(ans));
      const b = mk({ outside: true }); b.hub.goto('center'); b.app.askIn(); b.tick(40); b.press('b');
      const y = mk({ outside: true }); y.hub.goto('center'); y.app.askIn(); y.tick(40); y.last(); y.press('up');
      const n1 = y.log.length; y.press('a');
      ok(b.hub.path() === 'online' && y.hub.path() === 'center' && y.st().phase === 'wait' && y.st().entering === false && !y.dlg() && y.log.slice(n1).some((e) => e.type === 'dialog' && e.id === 'center:enter' && e.value === 0 && e.app === 'center') && !y.log.slice(n1).some((e) => e.type === 'screen'),
        'M14e B is NO from the first page; YES stays on the screen and is told to the ctl (which then switches Open to battles on and walks in)', J([b.hub.path(), y.st(), y.log.slice(n1)]));
      const inn = mk(), shut = mk({ outside: true });
      ok(inn.app.askIn() === false && !inn.dlg() && shut.app.askIn() === false && !shut.dlg(), 'M14f the question is only put on a screen that waits to be walked into (not in the room, not on a closed screen)', '');
      const l = mk({ outside: true }); l.hub.goto('center'); l.app.askIn(); l.hub.goto('main');
      ok(!l.hub.view().dialog && l.st().entering === false, 'M14g leaving the screen takes the question with it', J(l.hub.view().dialog));
      // SOMEBODY ASKS ME: what the Center has in the dialog layer makes way
      const openers = {
        note: (x) => x.app.askFailed('timeout'),
        sign: (x) => { x.cell(room.signs[0].x, room.signs[0].y); x.tick(400); },
        nurse: (x) => { x.cell(room.nurse.x, room.nurse.y); x.tick(400); },
        talk: (x) => { x.app.setRoster({ walkers: [walker('1', 'RED', 1, 7, 6, { b: S16('a') })], players: [player('a', 'RED', 'menu')] }); x.press('a'); },
      };
      const stuck = [];
      for (const [kind, open] of Object.entries(openers)) {
        const x = mk(); open(x);
        const before = x.dlg() && x.dlg().id;
        x.hub.dialog.open(challenge);
        const hidden = x.dlg() && x.dlg().id;
        x.app.makeWay();
        const now = x.dlg();
        if (before !== 'center:' + kind || hidden !== before || !now || now.id !== 'presence:challenge' || now.armed !== false || now.queued !== 0) stuck.push(kind + ': ' + before + ' > ' + (now && now.id));
      }
      ok(!stuck.length, 'M14h somebody asks me: a notice, a sign, the nurse and the question about a trainer make way, so that "wants to battle you" is the one on the screen (it listens only after its own arm delay)', J(stuck));
      // my own waiting line is the ctl's to settle
      const k = mk(); openers.talk(k); k.last(); k.press('a');
      k.hub.dialog.open(challenge); k.app.makeWay();
      const kept = k.dlg() && k.dlg().id, name = k.app.askWithdrawn(true), top = k.dlg() && k.dlg().id;
      k.tick(40); k.press('a');                                                // NO to that question (the highlighted answer)
      const line = k.text();
      const k2 = mk(); openers.talk(k2); k2.last(); k2.press('a'); k2.hub.dialog.open(challenge); const name2 = k2.app.askWithdrawn(false); k2.tick(40); k2.press('a');
      ok(kept === 'center:asking' && name === 'RED' && top === 'presence:challenge' && k.st().asking === null && line === 'Your challenge to RED was withdrawn.' && k.of('cancel-ask').length === 0 && name2 === 'RED' && !k2.dlg() && mk().app.askWithdrawn(true) === null,
        'M14i the line that waits for an answer to MY challenge is the ctl\'s to settle: askWithdrawn takes it off (no "Challenge cancelled.", no second cancel) and, when asked to, leaves a line behind the question', J([kept, name, top, line, name2, k2.dlg()]));
      // the Center's own question makes way too, and comes back
      const e = mk({ outside: true }); e.hub.goto('center'); e.app.askIn(); e.tick(40); e.press('a');
      const onPage = e.dlg().page;
      e.hub.dialog.open(challenge); e.app.makeWay();
      const over = e.dlg() && e.dlg().id;
      e.hub.dialog.close('presence:challenge'); e.app.resume(); e.app.resume();
      const back = e.dlg();
      const full = mk({ outside: true }); full.hub.goto('center'); full.app.askIn(); full.app.makeWay();
      for (let i = 0; i < 8; i++) full.hub.dialog.open({ id: 'x' + i, pages: [['.', '']], choice: null });
      const cannot = full.app.resume();
      ok(cannot === false && full.st().entering === false && mk().app.resume() === true, 'M14t a question that had to be asked again and cannot be (the dialog layer is full) is reported, so that the ctl takes it for a NO (nobody is walked in unasked)', J([cannot, full.st()]));
      ok(onPage === 1 && over === 'presence:challenge' && back && back.id === 'center:enter' && back.page === 0 && back.armed === false && back.queued === 0 && e.st().entering === true,
        'M14j the Center\'s own question makes way as well, and is asked again from its first page (listening after the arm delay) when that question is gone', J([onPage, over, back]));
      // a notice that only reports goes by itself
      const t = mk(); t.app.askFailed('declined');
      const d0 = t.hub.dialog.current();
      t.tick(CH.NOTE_TICKS - 1); const still = !!t.dlg(); t.tick(1);
      const t2 = mk(); t2.app.askAccepted(); t2.tick(CH.NOTE_TICKS * 3);
      ok(CH.NOTE_TICKS === 360 && d0 && d0.id === 'center:note' && d0.ticksLeft === CH.NOTE_TICKS && still && !t.dlg() && t2.dlg() && t2.dlg().id === 'center:note',
        'M14k a notice that reports an answer goes by itself after six seconds (nobody is left standing behind it); "accepted! Opening the battle..." stays until the battle opens', J([d0, still, t.dlg(), t2.dlg()]));
      const g = mk(), said = {};
      for (const why of ['declined', 'gone', 'timeout', 'busy']) { g.app.askFailed(why); said[why] = g.allText(); }
      g.app.askAccepted();
      ok(!/\bThey\b/.test(J(said)) && said.gone === 'That trainer is not open to battles any more.' && /^That trainer accepted!/.test(g.text()), 'M14l with nobody asked the words still read ("That trainer is not open to battles any more.")', J(said));
      // guards a reviewer's mutants walked through
      const s = mk();
      s.app.setRoster({ walkers: [walker('1', 'RED', 1, 7, 5, { b: S16('a') })], players: [player('a', 'RED', 'menu')] });
      s.tick(1, ['up']);
      const mid = s.st().moving; s.press('a');
      ok(mid === true && !s.dlg(), 'M14m A in the middle of a step does nothing (the trainer ahead is talked to when the step is over)', J([mid, s.dlg()]));
      const c = mk({ outside: true });
      const kfx = c.app.kick('off'), ofx = c.app.out(), win = c.app.walkIn(0);
      ok(kfx.length === 0 && ofx.length === 0 && win === false && !c.hub.view().dialog && c.hub.path() === 'main' && c.st().phase === 'closed', 'M14n a screen that is not open is not walked into, walked out of or left: kick, out and walkIn do nothing there', J([kfx, ofx, win]));
      const far = mk();
      far.app.setRoster({ walkers: [walker('1', 'RED', 1, 2, 5, { b: S16('a') })], players: [player('a', 'RED', 'menu')] });
      far.click(2 * CELL + 8, 5 * CELL + 4); far.tick(20);
      far.app.setRoster({ walkers: [walker('1', 'RED', 1, 12, 8, { b: S16('a') })], players: [player('a', 'RED', 'menu')] });
      far.tick(600);
      ok(!far.dlg() && !far.st().walking && !far.st().moving, 'M14o a trainer who walked away while the player was walking up to them is not talked to from across the room', J([far.dlg(), far.st()]));
      const lookWas = mk(); lookWas.app.setMe({ look: 'junk' }); lookWas.app.setMe({ look: '0371a52' }); lookWas.app.setMe({ look: 7 });
      ok(lookWas.app.me().look === lk(0), 'M14p the model takes a look only when it is a look code (junk and a code of the hand-drawn Center change nothing)', lookWas.app.me().look);
      const rp = mk(); const rfx = rp.press('left', { repeat: true });
      ok(rp.st().d === 'up' && !rfx.some((x) => x.app === 'center') && rp.of('moved').length === 0, 'M14q the synthesized repeat of a held direction neither turns nor walks (holding is read from the frame, once)', J([rp.st().d, rfx]));
      const mw = mk(); mw.cell(2, 5); mw.tick(5); mw.press('b');
      const walkingUnderMenu = mw.st().walking; mw.tick(200);
      ok(mw.st().mode === 'menu' && walkingUnderMenu === 0 && Math.abs(mw.st().x - 7) + Math.abs(mw.st().y - 7) <= 1 && !mw.st().moving, 'M14r opening the menu ends a tapped walk (nobody walks on behind an open menu)', J(mw.st()));
      ok([w, b, y, k, e, t, s, far, mw].every((x) => x.hub.faults().length === 0), 'M14s nothing threw', '');
    });

    /* ---------------------------------------------------------------- S the renderer */
    await guard('S', () => {
      const cs = screen.app('center');
      const w = mk();
      const walkers = [walker('1', 'RED', 1, 6, 5, { d: 'right', b: S16('a'), rec: [3, 1], emote: { e: 14, at: 0 } }), walker('2', 'Wwwwwwwwww', 40, 3, 6), walker('3', 'Lyra', 77, 9, 5, { d: 'left' }), walker('4', 'Bo', 120, 8, 6, { d: 'up', emote: { e: 5, at: 0 } })];
      const players = [player('a', 'RED', 'menu'), player('d', 'GOLD', 'menu'), player('e', 'Silver', 'looking', { look: lk(20) }), player('f', 'KRIS', 'waiting', { look: null }), player('9', 'OLDVER', 'menu', { compatible: false, look: lk(30) })];
      const hashes = {};
      const snap = (name) => { const fr = screen.render(w.hub.view()); hashes[name] = fnv(fr.rgba); return fr; };
      const wait = mk({ outside: true }); wait.hub.goto('center');
      hashes['room.under'] = fnv(cs.picture.under); hashes['room.over'] = fnv(cs.picture.over);
      hashes['frame.wait'] = fnv(screen.render(wait.hub.view()).rgba);
      const alone = snap('frame.alone');
      w.app.setRoster({ walkers, players });
      const eight = snap('frame.eight');
      w.press('b'); snap('frame.menu'); w.press('a'); snap('frame.look'); w.press('b'); w.press('down'); w.press('a'); w.press('right'); snap('frame.emote'); w.press('b'); w.press('down'); w.press('down'); w.press('a'); snap('frame.who'); w.press('b'); w.press('b');
      if (UPDATE && jsDir === SRC) { fs.writeFileSync(GOLDEN, JSON.stringify({ note: 'tools/pokemonarena_center_test.mjs --update: FNV-1a hashes of pictures rendered from the ROM. Hashes only, never pixels.', hashes }, null, 2) + '\n'); console.log('wrote', GOLDEN); }
      let golden = {}; try { golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8')).hashes || {}; } catch (_e) { golden = {}; }
      const off = Object.keys(hashes).filter((k) => golden[k] !== hashes[k]);
      ok(!off.length && Object.keys(golden).length === Object.keys(hashes).length, 'S1 the room, the room with eight people, the menu, the pickers and the list are the pictures the ROM gave when they were looked at (hashes)', J(off));
      // the layers: every pixel of the empty room is the map's (under, or over where the top layer has one), except where a sprite, a plate or the corner line is
      const U = cs.picture.under, O = cs.picture.over, px = (buf, x, y) => [buf[(y * 240 + x) * 4], buf[(y * 240 + x) * 4 + 1], buf[(y * 240 + x) * 4 + 2]];
      const same = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
      const fw = screen.render(wait.hub.view()).rgba;
      let strange = 0, topShown = 0, topTotal = 0;
      for (let y = 0; y < 144; y++) for (let x = 0; x < 240; x++) {
        const o = (y * 240 + x) * 4, top = O[o + 3] > 0;
        const inNpc = x >= 7 * 16 && x < 10 * 16 && y >= 0 && y < 3 * 16;
        if (top) { topTotal++; if (same(px(fw, x, y), px(O, x, y))) topShown++; }
        else if (!inNpc && !same(px(fw, x, y), px(U, x, y))) strange++;
      }
      ok(strange === 0 && topTotal > 500 && topShown === topTotal, 'S2 the room is the ROM\'s map: its lower layers, and its top layer over everything that stands in the room', J([strange, topShown, topTotal]));
      // a trainer: the ROM sprite, feet on the cell (the picture's top is one cell above), under the map's top layer
      const me = w.hub.view().center.people.find((p) => p.kind === 'me'), spr = world.ow.walker(looks[0], 'up', 0), tags = cs.tags(w.hub.view());
      const inTag = (x, y) => tags.some((t) => x >= t.x && x < t.x + t.w && y >= t.y && y < t.y + t.h);
      let match = 0, opaque = 0;
      for (let y = 0; y < 32; y++) for (let x = 0; x < 16; x++) { const s = (y * 16 + x) * 4; if (!spr.rgba[s + 3]) continue; const X = me.px + x, Y = me.py - 16 + y; if (inTag(X, Y) || O[(Y * 240 + X) * 4 + 3]) continue; opaque++; if (same(px(alone.rgba, X, Y), [spr.rgba[s], spr.rgba[s + 1], spr.rgba[s + 2]])) match++; }
      ok(opaque > 150 && match === opaque, 'S3 a trainer is the ROM\'s own sprite in its own colours, standing with its feet on its cell (its top one cell above)', J([match, opaque]));
      // depth: the lower of two trainers is drawn over the upper
      const d = mk();
      d.app.setRoster({ walkers: [walker('1', 'UP', 5, 3, 5), walker('2', 'LOW', 9, 3, 6)], players: [] });
      const fd = screen.render(d.hub.view()).rgba, low = world.ow.walker(looks[9], 'down', 0), dt = cs.tags(d.hub.view());
      let lowShown = 0, lowTotal = 0;
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const s = (y * 16 + x) * 4; if (!low.rgba[s + 3]) continue; const X = 3 * 16 + x, Y = 5 * 16 + y; if (dt.some((t) => X >= t.x && X < t.x + t.w && Y >= t.y && Y < t.y + t.h)) continue; lowTotal++; if (same(px(fd, X, Y), [low.rgba[s], low.rgba[s + 1], low.rgba[s + 2]])) lowShown++; }
      ok(lowTotal > 10 && lowShown === lowTotal, 'S4 people are drawn in depth order: the head of the trainer in front covers the trainer behind', J([lowShown, lowTotal]));
      // names and bubbles
      const tg = cs.tags(w.hub.view()), ppl = w.hub.view().center.people;
      ok(tg.length === ppl.length && tg.every((t) => t.shown && t.x >= 0 && t.y >= 0 && t.x + t.w <= 240 && t.y + t.h <= 160 && t.h <= 11 && t.w <= CS.TAG.maxPx + 2 * CS.TAG.padX) && tg.every((t, i) => t.y >= ppl[i].py + 8 && t.y <= ppl[i].py + 16),
        'S5 every trainer has a name plate at their feet, inside the picture, no taller than the letters', J(tg.slice(0, 3)));
      // NO NAME LIES ON ANOTHER NAME, wherever the trainers stand
      const lapping = (t) => { const s = t.filter((q) => q.shown), bad = []; for (let i = 0; i < s.length; i++) for (let j = i + 1; j < s.length; j++) { const a = s[i], b = s[j]; if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) bad.push(a.id + '+' + b.id); } return bad; };
      const scene = (list, name) => { const x = mk(); if (name) x.app.setMe({ name }); x.app.setRoster({ walkers: list, players: [] }); x.tick(2); const v = x.hub.view(); return { t: cs.tags(v), ppl: v.center.people, fr: screen.render(v) }; };
      // (a plate that was moved aside is still under its own trainer: at least TAG.hold of its pixels across lie under the trainer's cell)
      const held = (sc) => sc.t.every((q, i) => !q.shown || (q.x >= 0 && q.x + q.w <= 240 && Math.min(q.x + q.w, sc.ppl[i].px + 16) - Math.max(q.x, sc.ppl[i].px) >= Math.min(CS.TAG.hold, q.w)));
      const by = (sc, id) => sc.t.find((q) => q.id === id);
      const side = scene([walker('1', 'RED', 1, 6, 7), walker('2', 'Bob', 2, 8, 7)]);
      const pm = by(side, 'me'), pr = by(side, 'w:' + S16('1')), pb = by(side, 'w:' + S16('2'));
      ok(side.t.length === 3 && side.t.every((q) => q.shown) && !lapping(side.t).length && held(side) && pr.x + pr.w <= pm.x && pm.x + pm.w <= pb.x,
        'S5b a trainer on each side of the player (which is how one walks up to somebody): the three names stand side by side, none on another, each under its own trainer', J(side.t));
      const onOne = scene([walker('1', 'RED', 1, 7, 7)]);
      ok(onOne.t.every((q) => q.shown) && !lapping(onOne.t).length && held(onOne), 'S5c a trainer on the player\'s own cell: both names are written, side by side under the one cell', J(onOne.t));
      const long = scene([walker('1', 'MMMMMMMMMM', 1, 6, 7), walker('2', 'Wwwwwwwwww', 2, 8, 7)], 'CASEYCASEY');
      ok(by(long, 'me').shown && long.t.filter((q) => !q.shown).length === 1 && !lapping(long.t).length && held(long), 'S5d three names too long for three cells: one of the other two goes without a plate (never the player\'s own), none lies on another, and none is pushed away from its trainer', J(long.t));
      const cells = grid.cells().filter((c) => !grid.isDoor(c.x, c.y));
      const crowd = scene(cells.filter((c) => c.y >= 5 && c.y <= 7).slice(0, 29).map((c, i) => walker('0123456789abcdefghijklmnopqrstuv'[i], ['MMMMMMMMMM', 'Bob', 'Alexandria', 'RED', 'Lyra'][i % 5], 10 + i, c.x, c.y)));
      ok(crowd.t.length === 30 && by(crowd, 'me').shown && crowd.t.filter((q) => q.shown).length >= 8 && crowd.t.some((q) => !q.shown) && !lapping(crowd.t).length && held(crowd) && !crowd.fr.fault,
        'S5e a crowd (29 trainers shoulder to shoulder in three rows, long names among them): still no name on another name; some go without a plate, the player never does', J([crowd.t.length, crowd.t.filter((q) => q.shown).length, lapping(crowd.t).slice(0, 3), held(crowd), crowd.fr.fault]));
      const corner = scene([walker('1', 'RED', 1, 13, 8), walker('2', 'Wwwwwwwwww', 2, 11, 8)]);
      const hint = CH.CGEOM.hint, onHint = corner.t.filter((q) => q.shown && q.x < hint.x + hint.w && q.x + q.w > hint.x && q.y < hint.y + hint.h && q.y + q.h > hint.y);
      ok(corner.t.every((q) => q.shown) && !onHint.length && !lapping(corner.t).length && held(corner), 'S5f a name in the bottom right corner does not lie on the line that says what B does', J(corner.t));
      // the plate is the ROM's party-menu chip (the selected chip for the player), not a rectangle this site filled
      const chipOf = (variant, cw, chh) => { let got = null; ui.panel({ blit: (_w, _h, rgba) => { got = rgba; } }, 0, 0, cw, chh, variant, true); return got; };
      const romPlate = (fr, p, variant) => { const chip = chipOf(variant, p.w, p.h); let same2 = 0, ink = 0, other = 0; for (let yy = 0; yy < p.h; yy++) for (let xx = 0; xx < p.w; xx++) { const o = ((p.y + yy) * 240 + p.x + xx) * 4, c4 = (yy * p.w + xx) * 4; if (!chip[c4 + 3]) continue; if (fr.rgba[o] === chip[c4] && fr.rgba[o + 1] === chip[c4 + 1] && fr.rgba[o + 2] === chip[c4 + 2]) same2++; else if (fr.rgba[o] === ui.TEXT.dark[0] && fr.rgba[o + 1] === ui.TEXT.dark[1] && fr.rgba[o + 2] === ui.TEXT.dark[2]) ink++; else other++; } return { same: same2, ink, other }; };
      const mineP = romPlate(side.fr, pm, 'sel'), redP = romPlate(side.fr, pr, 'normal'), swapped = romPlate(side.fr, pm, 'normal');
      ok(mineP.other === 0 && redP.other === 0 && mineP.ink > 20 && redP.ink > 10 && mineP.same > mineP.ink && redP.same > redP.ink && swapped.other > 0,
        'S5g a name plate is the ROM\'s own party-menu chip with the name in the ROM font: the plain chip for the others, the selected chip for the player', J([mineP, redP, swapped]));
      const red = ppl.find((p) => p.name === 'RED'), icon = world.emotes[14].frames[0];
      let im = 0, it = 0; for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const s = (y * 16 + x) * 4; if (!icon[s + 3]) continue; it++; if (same(px(eight.rgba, red.px + x, red.py - 16 - CS.BUBBLE_UP + y), [icon[s], icon[s + 1], icon[s + 2]])) im++; }
      ok(it > 60 && im === it, 'S6 an emote is the ROM\'s icon, over the trainer\'s head', J([im, it]));
      // nothing in the source paints art
      const files = ['center_hub.js', 'center_screen.js', 'center_ctl.js', 'center_room.js', 'center_look.js', 'center_world.js', 'center_net.js'];
      const bad = [];
      for (const f of files) {
        const src = fs.readFileSync(path.join(jsDir, f), 'utf8');
        if (/[^\x00-\x7f]/.test(src)) bad.push(f + ': a character outside ASCII');
        if (/getContext|fillStyle|strokeStyle|createImageData|#[0-9a-fA-F]{6}\b|rgba?\(/.test(src)) bad.push(f + ': canvas drawing or a colour');
        if (/\[\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\]/.test(src)) bad.push(f + ': a colour triple');
        if (/avatar\.js|center_map\.js|center_draw\.js|center_boot\.js/.test(src)) bad.push(f + ': names a deleted file');
        if (/\.rect\(/.test(src)) bad.push(f + ': fills a rectangle of its own');
      }
      const gone = ['js/avatar.js', 'js/center_map.js', 'js/center_draw.js', 'js/center_boot.js', 'center.css', 'dev/avatar_sheet.html'].filter((f) => fs.existsSync(path.join(root, 'pokemonarena', f)));
      const importers = fs.readdirSync(SRC).filter((f) => f.endsWith('.js') && /from '\.\/(avatar|center_map|center_draw|center_boot)\.js'/.test(fs.readFileSync(path.join(SRC, f), 'utf8')));
      const html = fs.readFileSync(path.join(root, 'pokemonarena', 'center.html'), 'utf8');
      ok(!bad.length && !gone.length && !importers.length && !/<canvas|<button|<link[^>]+stylesheet|center_boot/.test(html) && /location\.replace\('\/pokemonarena\/' \+/.test(html) && /#center/.test(html),
        'S7 no art in the source (no canvas drawing, no colour, no rectangle filled by this site, no character outside ASCII); the hand-drawn Trainer Center is gone and nothing imports it; center.html is a redirect with no UI', J([bad, gone, importers]));
      ok(w.hub.faults().length === 0, 'S8 nothing threw', J(w.hub.faults()));
    });

    /* ---------------------------------------------------------------- N the room's messages */
    await guard('N', () => {
      const rules = N.roomRules({ walkable: grid.walkable, look: (c) => K.isLook(c, looks), emotes: room.emotes });
      const S1 = S16('a'), S2 = S16('b');
      const base = { t: N.KIND, v: N.VERSION, s: S1 };
      const here = { ...base, k: 'here', name: 'Alice', av: lk(3), x: 7, y: 7, d: 'up' };
      const c = (m) => N.checkCenterMsg(m, rules);
      ok(c(here).ok && c({ ...here, b: S2, rec: [3, 1] }).ok && c({ ...base, k: 'mv', x: 6, y: 8, d: 'left' }).ok && c({ ...base, k: 'emo', e: 15 }).ok && c({ ...base, k: 'ask' }).ok && c({ ...base, k: 'bye' }).ok, 'N1 every kind the room defines is accepted', '');
      const notAvatar = [...Array(400).keys()].find((i) => !looks.includes(i));
      const refused = [
        ['wrong type', { ...here, t: 'arenaopen' }], ['version 1', { ...here, v: 1 }], ['version 3', { ...here, v: 3 }], ['sender', { ...here, s: 'XYZ' }], ['kind', { ...here, k: 'chal' }],
        ['a wall', { ...here, x: 0, y: 0 }], ['the counter', { ...here, x: 7, y: 3 }], ['behind the counter', { ...here, x: room.nurse.x, y: room.nurse.y }], ['the table', { ...here, x: 11, y: 6 }], ['off the map', { ...here, x: 15, y: 5 }], ['a fraction', { ...here, x: 7.5 }], ['a negative', { ...here, x: -1 }], ['a wall step', { ...base, k: 'mv', x: 4, y: 3, d: 'up' }],
        ['direction', { ...here, d: 'north' }], ['an old look', { ...here, av: '0371a52' }], ['a look the ROM lacks', { ...here, av: K.lookCode(notAvatar) }], ['junk look', { ...here, av: 'zzzzzzz' }], ['no look', { ...here, av: undefined }],
        ['empty name', { ...here, name: '' }], ['long name', { ...here, name: 'x'.repeat(41) }], ['markup in the name', { ...here, name: '<img src=x>' }], ['a name of eleven', { ...here, name: 'ABCDEFGHIJK' }], ['a name with a bidi mark', { ...here, name: 'Al‮ice' }], ['a name that is not text', { ...here, name: 7 }],
        ['board id', { ...here, b: 'nothex' }], ['record', { ...here, rec: [1, -1] }], ['record size', { ...here, rec: [1, 2, 3] }], ['emote out of range', { ...base, k: 'emo', e: room.emotes }], ['emote negative', { ...base, k: 'emo', e: -1 }], ['emote text', { ...base, k: 'emo', e: 'hi' }],
        ['array', [here]], ['null', null],
      ];
      const leaked = refused.filter(([, m]) => c(m).ok).map(([n]) => n);
      ok(!leaked.length, 'N2 refused: a position that is not a cell of the ROM\'s room a trainer can stand on, a look that is not a ROM trainer sprite, an emote the ROM does not have, a name that is not safe text, and every other field out of shape', J(leaked));
      const none = [here, { ...base, k: 'mv', x: 7, y: 7, d: 'up' }, { ...base, k: 'emo', e: 0 }].filter((m) => N.checkCenterMsg(m).ok || N.checkCenterMsg(m, N.roomRules({})).ok || N.checkCenterMsg(m, N.roomRules({ walkable: () => { throw new Error('x'); }, look: () => 1, emotes: 1e9 })).ok && m.k !== 'emo');
      ok(!none.length && N.roomRules({ emotes: 1e9 }).emotes === 64 && N.checkCenterMsg({ ...base, k: 'ask' }).ok, 'N3 with no room handed in, every position, look and emote is refused (rules never default to "anything goes"); a rule that throws or answers something that is not `true` refuses', J(none));
      const cleaned = c({ ...here, room: 'ABCD', extra: 'x', b: S2 });
      ok(cleaned.ok && Object.keys(cleaned.b).sort().join() === 'av,b,d,k,name,rec,s,x,y' && cleaned.b.name === 'Alice', 'N4 only the fields the room defines come out', J(cleaned));
      const src = fs.readFileSync(path.join(jsDir, 'center_net.js'), 'utf8');
      ok(N.VERSION === 2 && N.CENTER_TOPIC === 'bemental/arena/center/2' && N.CENTER_CHANNEL === 'bemental-arena-center-2' && (src.match(/^import /gm) || []).length === 1 && /from '\.\/netmatch\.js'/.test(src),
        'N5 the room is version 2 (its topic, its same-browser channel, every message): a page of the first Trainer Center does not mix with this one; the module imports nothing of the ROM or the map', J([N.CENTER_TOPIC, N.CENTER_CHANNEL]));
      // the roster
      let t = 0;
      const RO = N.createRoster({ now: () => t, ttlMs: 10000, max: 3, emoteShowMs: 2000 });
      const H = (s, extra) => c({ ...here, s, ...extra }).b;
      ok(!RO.hear(c({ ...base, s: S2, k: 'mv', x: 6, y: 8, d: 'up' }).b) && RO.size() === 0, 'N6a a step from somebody who never said who they are puts nobody in the room', '');
      ok(RO.hear(H(S1)) && RO.size() === 1 && RO.get(S1).name === 'Alice', 'N6b a `here` puts a trainer in the room', '');
      t = 500; RO.hear(c({ ...base, k: 'mv', x: 6, y: 8, d: 'left' }).b);
      ok(RO.get(S1).x === 6 && RO.get(S1).d === 'left', 'N6c a step moves them', J(RO.get(S1)));
      t = 900; RO.hear(c({ ...base, k: 'emo', e: 2 }).b);
      t = 2000; RO.prune(); const e1 = RO.get(S1).emote;
      t = 3000; RO.prune(); const e2 = RO.get(S1).emote;
      ok(e1 && e1.e === 2 && e2 === null && N.TIMING.emoteShowMs === 2000, 'N6d an emote shows for two seconds, then goes', J([e1, e2]));
      RO.hear(H(S16('c'))); RO.hear(H(S16('d'))); const capped = !RO.hear(H(S16('e'))) && RO.size() === 3;
      ok(capped, 'N6e the room holds at most its cap of trainers', RO.size());
      t = 12999; RO.hear(c({ ...base, k: 'mv', x: 7, y: 8, d: 'up' }).b); t = 13500; RO.prune();
      ok(RO.get(S1) && !RO.get(S16('c')), 'N6f a trainer who has gone quiet for the ttl drops out; one who keeps stepping does not', J(RO.list().map((w) => w.s.slice(0, 2))));
      RO.hear(c({ ...base, k: 'bye' }).b);
      ok(!RO.get(S1), 'N6g a bye takes the trainer out at once', '');
      // one page in the room: fake bus, fake clock, fake timers
      const mkTimers = () => {
        let id = 0; const q = new Map();
        return {
          T: { setInterval: (f, ms) => { q.set(++id, { f, at: t + ms, every: ms }); return id; }, clearInterval: (h) => q.delete(h), setTimeout: (f, ms) => { q.set(++id, { f, at: t + ms }); return id; }, clearTimeout: (h) => q.delete(h) },
          run(to) { for (;;) { let best = null; for (const [h, e] of q) if (e.at <= to && (!best || e.at < best[1].at)) best = [h, e]; if (!best) break; const [h, e] = best; t = e.at; if (e.every) e.at += e.every; else q.delete(h); e.f(); } t = to; },
        };
      };
      t = 0;
      const sent = [], bus = { cb: null, send: (o) => sent.push(o), onMessage(f) { this.cb = f; }, close() { this.closed = true; } };
      const tm = mkTimers();
      const mine = { name: 'Bob <b>', av: lk(4), x: 7, y: 8, d: 'up', b: null, rec: null };
      let rbyte = 0;
      const C = N.createCenter({ bus, me: () => mine, rules, now: () => t, timers: tm.T, random: (n) => Uint8Array.from({ length: n }, () => (rbyte = (rbyte + 77) & 255)) });
      C.start();
      ok(sent.length === 2 && sent[0].k === 'here' && sent[1].k === 'ask' && sent.every((m) => m.s === C.sid && m.t === N.KIND && m.v === 2) && c(sent[0]).ok && sent[0].name === 'Bob b', 'N7a walking in says who we are and asks who is here; the name goes out as safe text (a page never sends what the others would refuse)', J(sent));
      mine.b = S2; mine.rec = [3, 1]; mine.team = 'SECRET'; mine.room = 'ABCDE'; C.update(); mine.b = null; mine.rec = null;
      const full = sent[sent.length - 1];
      ok(Object.keys(sent[0]).sort().join() === 'av,d,k,name,s,t,v,x,y' && full.k === 'here' && Object.keys(full).sort().join() === 'av,b,d,k,name,rec,s,t,v,x,y' && Object.keys(sent[1]).sort().join() === 'k,s,t,v',
        'N7a2 what a trainer publishes in the room is ONLY the fields the room defines: who (name, look), where (x, y, d), and the board id and the record when there are any. No team, no room, nothing else the page knows', J([Object.keys(sent[0]), Object.keys(full)]));
      tm.run(3000);
      ok(sent.filter((m) => m.k === 'here').length === 3, 'N7b ... and says it again every few seconds', sent.length);
      sent.length = 0;
      mine.x = 6; C.moved(); mine.x = 5; C.moved(); mine.x = 4; C.moved();
      const mv1 = sent.filter((m) => m.k === 'mv').length;
      tm.run(t + 100);
      const mvs = sent.filter((m) => m.k === 'mv');
      ok(mv1 === 1 && mvs.length === 2 && mvs[1].x === 4, 'N7c steps that come faster than the gap are sent once the gap is over, as the latest position', J(mvs));
      sent.length = 0;
      const e1ok = C.emote(1), e2ok = C.emote(2); tm.run(t + N.TIMING.emoteGapMs); const e3ok = C.emote(3); tm.run(t + N.TIMING.emoteGapMs); const e4ok = C.emote(room.emotes); tm.run(t + N.TIMING.emoteGapMs); const e5ok = C.emote(-1);
      ok(e1ok && !e2ok && e3ok && !e4ok && !e5ok && sent.filter((m) => m.k === 'emo').length === 2, 'N7d emotes are spaced out, and only the ROM\'s are sent', J(sent));
      tm.run(Math.ceil(t / N.TIMING.hereMs) * N.TIMING.hereMs + 50);          // (just past a heartbeat, so that the only message that can follow is the answer)
      sent.length = 0;
      bus.cb({ ...base, s: S2, k: 'ask' }); bus.cb({ ...base, s: S2, k: 'ask' });
      tm.run(t + N.TIMING.jitterMs + 5);
      ok(sent.filter((m) => m.k === 'here').length === 1, 'N7e an ask is answered once (after a little random wait), however often it is repeated', J(sent));
      sent.length = 0;
      bus.cb({ ...base, s: S2, k: 'mv', x: 6, y: 8, d: 'up' });
      ok(sent.some((m) => m.k === 'ask') && C.roster.size() === 0, 'N7f a step from somebody we have not met makes us ask who they are', J(sent));
      bus.cb({ ...here, s: S2, name: 'Eve' });
      bus.cb({ ...here, s: S16('7'), name: 'Wall', x: 0, y: 0 }); bus.cb({ ...here, s: S16('8'), name: 'Old', av: '0371a52' }); bus.cb({ ...here, s: S16('9'), name: 'V1', v: 1 });
      ok(C.list().length === 1 && C.list()[0].name === 'Eve', 'N7g their answer puts them in the room; a trainer in a wall, with a look that is no ROM sprite, or of version 1 never appears', J(C.list().map((w) => w.name)));
      bus.cb({ ...here, s: C.sid, name: 'Echo' });
      ok(C.list().length === 1, 'N7h our own messages coming back are not a second trainer', '');
      const S3 = S16('3');
      bus.cb({ ...here, s: S3, name: 'Flood', x: 3, y: 5 });
      for (let i = 0; i < 60; i++) bus.cb({ ...base, s: S3, k: 'mv', x: 3 + (i % 2), y: 5, d: 'up' });
      const fx = C.roster.get(S3).x;
      t += 1001; bus.cb({ ...base, s: S3, k: 'mv', x: 10, y: 5, d: 'up' });
      ok(fx === 3 + ((N.TIMING.perSenderMax - 2) % 2) && C.roster.get(S3).x === 10, 'N7i one sender cannot send more than its share in a second; the next second they are heard again', J([fx, C.roster.get(S3).x]));
      // one page that floods is cut off BY ITSELF: what it sends beyond its share does not count against the room
      t += 1001;
      for (let i = 0; i < 400; i++) bus.cb({ ...base, s: S3, k: 'mv', x: 3 + (i % 2), y: 5, d: 'up' });
      bus.cb({ ...base, s: S2, k: 'mv', x: 6, y: 7, d: 'left' });
      ok(C.roster.get(S2).x === 6 && C.roster.get(S2).d === 'left', 'N7l one sender that floods (400 messages in a second) does not deafen the room: another trainer\'s step is still heard in that second', J(C.roster.get(S2)));
      // the whole room: forty senders, each within its own share, 400 messages in a second
      t += 1001;
      for (let i = 0; i < 40; i++) { const sx = (i + 16).toString(16).padStart(2, '0').repeat(8); for (let j = 0; j < 10; j++) bus.cb({ ...base, s: sx, k: 'bye' }); }
      bus.cb({ ...base, s: S2, k: 'mv', x: 5, y: 7, d: 'left' });
      const deaf = C.roster.get(S2).x;
      t += 1001; bus.cb({ ...base, s: S2, k: 'mv', x: 5, y: 7, d: 'left' });
      ok(deaf === 6 && C.roster.get(S2).x === 5 && N.TIMING.totalMax === 260 && N.TIMING.perSenderMax === 14, 'N7m above the cap of the whole room (260 messages a second from everybody together) the rest of that second is dropped unread, whoever sends it; the next second the room hears again', J([deaf, C.roster.get(S2).x]));
      sent.length = 0; C.close();
      ok(sent.length === 1 && sent[0].k === 'bye' && bus.closed, 'N7j leaving says bye and lets go of the connection', J(sent));
      C.moved(); C.emote(1); C.update();
      ok(sent.length === 1, 'N7k nothing is sent after leaving', sent.length);
      // the board carries the look
      const ROM = 'f'.repeat(64);
      const open = { t: OL.BEACON, v: OL.BEACON_V, k: 'open', s: S1, room: 'H1234', name: 'Hub', fmt: '3v3', rom: ROM, fp: 'fp', rs: 'rs', h: 1 };
      const bOk = OL.checkBeacon({ ...open, av: lk(7) }), bNone = OL.checkBeacon(open), bBad = OL.checkBeacon({ ...open, av: '<script>' });
      const boot = fs.readFileSync(path.join(jsDir, 'presence_boot.js'), 'utf8');
      ok(bOk.ok && bOk.b.av === lk(7) && bNone.ok && bNone.b.av === null && !bBad.ok && /av: loadLook\(storage\)/.test(boot) && /import \{ loadLook \} from '\.\/center_look\.js';/.test(boot),
        'N8 a listing on the board carries the look code (seven characters); the page lists the stored look of this browser', J([bOk, bBad]));
    });

    /* ---------------------------------------------------------------- T the meet token and the battle page's address */
    await guard('T', () => {
      const mem = new Map(), store = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
      const w = P.writeMeetToken(store, 'afumt', 1000);
      ok(w && P.takeMeetToken(store, 'AFUMT', 2000) && !P.takeMeetToken(store, 'AFUMT', 2000), 'T1 the meet token is taken once, for its room', '');
      P.writeMeetToken(store, 'AFUMT', 1000);
      ok(!P.takeMeetToken(store, 'OTHER', 1500) && !mem.has(P.MEET_KEY), 'T2 a token for another room starts nothing (and is gone)', '');
      P.writeMeetToken(store, 'AFUMT', 1000);
      ok(!P.takeMeetToken(store, 'AFUMT', 1000 + P.MEET_MAX_AGE_MS + 1), 'T3 an old token starts nothing', '');
      mem.set(P.MEET_KEY, '{"room":"AFUMT"');
      ok(!P.takeMeetToken(store, 'AFUMT', 1000) && !P.writeMeetToken(store, 'no spaces!', 1) && !P.takeMeetToken(null, 'AFUMT', 1), 'T4 junk, a bad room or no storage starts nothing', '');
      const stuck = { getItem: () => '{"room":"AFUMT","at":1000}', removeItem() {} };
      ok(!P.takeMeetToken(stuck, 'AFUMT', 1500), 'T5 a token that will not go away is not usable (one use or no use)', '');
      const qy = O.parseOnlineQuery('?np=AFUMT&join=1&meet=1'), qh = O.parseOnlineQuery('?np=AFUMT&host=1&meet=1'), qo = O.parseOnlineQuery('?online=1&meet=1');
      ok(qy.meet === true && qh.meet === false && qo.meet === false, 'T6 only a JOIN address with a room can ask to be joined by itself', J([qy.meet, qh.meet, qo.meet]));
      const ca = O.canonicalAddress('http://x/pokemonarena/battle.html?np=AFUMT&join=1&meet=1&net=local', 'guest', 'AFUMT'), ba = O.boardAddress('http://x/pokemonarena/battle.html?np=AFUMT&join=1&meet=1');
      ok(!/meet/.test(ca) && /net=local/.test(ca) && !/meet/.test(ba), 'T7 the address a reload comes back to does not ask again', J([ca, ba]));
    });
  }

  if (parts.ctl) await runCtl(jsDir, ok, guard, { ui, screen, room, looks, lk, CH, K, P, OL, N, only: parts.block || null });
  return failed;
}

/* ================================================================================================ K: the ctl, on real pages' worth of code in Node */
const memStorage = (init = {}) => { const store = { ...init }; return { store, getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } }; };
async function runCtl(jsDir, ok, guard, M) {
  const imp = (f) => import(pathToFileURL(path.join(jsDir, f)).href);
  const [HM, T, CC, HP] = await Promise.all(['hub_model.js', 'tables.js', 'center_ctl.js', 'hub_presence.js'].map(imp));
  const { ui, screen, room, looks, lk, CH, K, P, OL, N, only } = M;
  const pack = T.loadPack(romBytes, { verify: 'header', dexText: false });
  const settle = async (cond, ms = 4000) => { const t0 = Date.now(); while (!cond() && Date.now() - t0 < ms) await sleep(10); return !!cond(); };
  const pages = [];
  /** One hub page: a window double, a real hub model, the Center's ctl and the page's presence service. Effects are carried out the way boot.js run() does. THE PICTURE'S CLOCK NEVER RUNS unless a case ticks it. */
  function page(search = '?net=local', o = {}) {
    const ls = new Map();
    const win = {
      location: { search, origin: 'http://x', assign() {} }, localStorage: memStorage(o.local), sessionStorage: memStorage(), performance: { now: () => performance.now() }, crypto: globalThis.crypto, BroadcastChannel: globalThis.BroadcastChannel,
      setTimeout: (...a) => setTimeout(...a), clearTimeout: (...a) => clearTimeout(...a), setInterval: (...a) => setInterval(...a), clearInterval: (...a) => clearInterval(...a), console: { warn() {}, error() {}, log() {} },
      addEventListener(t, f) { if (!ls.has(t)) ls.set(t, new Set()); ls.get(t).add(f); }, removeEventListener(t, f) { if (ls.has(t)) ls.get(t).delete(f); }, fire(t, e = {}) { for (const f of [...(ls.get(t) || [])]) f(e); },
    };
    if (o.mqtt) win.mqtt = o.mqtt;                              // (a double of the MQTT library: openlobby.js loadMqttLib takes window.mqtt when it is there)
    const doc = { hidden: false, getElementById: () => null, addEventListener() {}, removeEventListener() {} };
    const hub = HM.createHubModel({ mascot: 25, env: 0, measure: screen.measure, msgPx: screen.msgPx, measureFont: screen.measureFont });
    hub.setData({ state: 'ready', activeId: null, profiles: [] });
    const w = { win, hub, nav: [], sound: [], fam: false, ctl: null };
    const hook = { dialogOpen: () => false };
    const sync = () => { const now = hub.path() === 'center'; if (now && !w.fam) { w.fam = true; if (w.ctl) w.ctl.enter('center'); } else if (!now && w.fam) { w.fam = false; if (w.ctl) w.ctl.leave('center'); } };
    const run = (fx) => { for (const e of fx || []) { if (!e) continue; if (typeof e.app === 'string') { if (e.app === 'center' && w.ctl) w.ctl.effect(e); } else if (e.type === 'dialog' && hook.presence) hook.presence.answer(e); else if (e.type === 'sfx' && e.key) w.sound.push(e.key); } sync(); return fx; };
    const snap = (url) => { const ss = win.sessionStorage; return { url, back: HP.readBack(ss), accept: ss.getItem(P.ACCEPT_KEY), meet: ss.getItem(P.MEET_KEY) }; };
    w.env = { win, doc, hook, model: hub, app: hub.apps.center, pack, rom: ui.rom, ui, navigate: (u) => w.nav.push(snap(u)), input: null, storage: o.blocked ? null : win.localStorage, session: win.sessionStorage, refreshData() {}, redraw() {}, run, freshSeed: () => (o.seed === undefined ? 0 : o.seed), store: () => null, whenStore: () => Promise.resolve(null),
      sound: { sfx: (k) => { w.sound.push(k); return true; }, music: (k) => { w.sound.push('music:' + k); return true; }, system: () => o.system || null } };
    w.svc = HP.hubPresence({ ...w.env, button: null });
    w.ctl = o.noCtl ? null : CC.createCtl(w.env);
    w.hook = hook; w.run = run; w.app = hub.apps.center;
    w.st = () => hub.state().apps.center;
    w.press = (a, i) => run(hub.press(a, i));
    w.tick = (n = 1, held) => { for (let i = 0; i < n; i++) run(hub.tick(held)); };
    w.click = (x, y) => run(hub.pointer({ kind: 'click', x, y }));
    w.go = (p) => run(hub.goto(p));
    w.dlg = () => hub.view().dialog || null;
    w.text = () => { const d = hub.view().dialog; return d ? d.lines.filter(Boolean).join(' ') : null; };
    w.last = () => { for (let i = 0; i < 20 && w.dlg() && w.dlg().more; i++) w.press('a'); return w.dlg(); };
    w.clear = () => { for (let i = 0; i < 30 && w.dlg(); i++) w.press('b'); return !w.dlg(); };
    // A PLAYER IN FRONT OF THE PICTURE: frames go by while they read (a question that appears by itself listens only after its arm delay)
    w.read = (n = 40) => w.tick(n);
    w.people = () => w.app.people();
    w.end = () => { try { if (w.ctl) w.ctl.dispose(); } catch (_e) { /* ignore */ } try { w.svc.dispose(); } catch (_e) { /* ignore */ } };
    pages.push(w);
    return w;
  }
  const endAll = async () => { for (const w of pages.splice(0)) w.end(); await sleep(30); };
  const inRoom = (w) => settle(() => w.st().phase === 'in' && w.hook.center.state().inside);
  const sees = (w, name) => settle(() => w.people().some((p) => p.name === name));
  // everything said on the room's channel and on the board, as any other browser hears it
  const spy = [], chans = [N.CENTER_CHANNEL, 'bemental-arena-open-1'].map((n) => { const c = new globalThis.BroadcastChannel(n); c.onmessage = (e) => spy.push({ ch: n, m: e.data }); return c; });
  const block = async (name, fn) => { if (only && only !== name) return; try { await fn(); } catch (e) { ok(false, name + ' (threw)', e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e); } await endAll(); };

  await block('K1', async () => {
    spy.length = 0;
    const a = page('?net=local&opendisc=1&ctrname=Alice&ctrav=' + lk(6));
    a.go('center');
    await settle(() => a.dlg() && a.dlg().id === 'presence:disclosure');
    await sleep(300);
    const q = a.dlg();
    ok(q && q.id === 'presence:disclosure' && a.st().phase === 'wait' && a.hub.view().center.people.length === 0, 'K1a opening the Center the first time asks, in the picture, before anything else: the player has not walked in', J([q && q.id, a.st().phase]));
    ok(spy.length === 0 && a.hook.center.wire.sent === 0 && a.svc.isOn() === false, 'K1b nothing at all is published before YES (not on the room channel, not on the board)', J(spy.slice(0, 2)));
    let words = ''; for (let i = 0; i < 20 && a.dlg() && a.dlg().more; i++) { words += ' ' + a.text(); a.press('a'); } words += ' ' + a.text();
    const last = a.dlg();
    ok(/your look and where you stand are listed too/.test(words.replace(/\s+/g, ' ')) && /trainer name/.test(words) && last.choice && last.choice.options.join() === 'YES,NO' && last.choice.cursor === 1, 'K1c the disclosure says what the Center adds (the look, where you stand), and NO is highlighted', words.slice(-200));
    a.press('a');
    await settle(() => a.hub.path() !== 'center');
    await sleep(200);
    ok(a.hub.path() === 'online' && a.st().phase === 'closed' && spy.length === 0 && !a.svc.isOn() && a.win.localStorage.getItem('arena.open.seen') === null && a.win.localStorage.getItem('arena.open') === null && !a.dlg(),
      'K1d NO leaves the Center, without a word; nothing was published and nothing is remembered', J([a.hub.path(), spy.length, a.dlg()]));
    a.go('center');
    await settle(() => a.dlg() && a.dlg().id === 'presence:disclosure');
    for (let i = 0; i < 20 && a.dlg() && a.dlg().more; i++) a.press('a');
    a.press('up'); a.press('a');
    const went = await inRoom(a);
    await settle(() => spy.some((s) => s.ch === N.CENTER_CHANNEL && s.m.k === 'here') && spy.some((s) => s.ch !== N.CENTER_CHANNEL && s.m.k === 'open'));
    const here = spy.find((s) => s.ch === N.CENTER_CHANNEL && s.m.k === 'here'), open = spy.find((s) => s.ch !== N.CENTER_CHANNEL && s.m.k === 'open');
    ok(went && a.svc.isOn() && here && here.m.name === 'Alice' && here.m.av === lk(6) && here.m.v === 2 && open && a.win.localStorage.getItem('arena.open') === null,
      'K1e YES walks in: Open to battles is on FOR THIS PAGE ONLY (the stored switch is untouched), the room hears who walked in and the board lists them', J([went, here && here.m, a.win.localStorage.store]));
    ok(a.sound.includes('music:pokecenter') && a.hub.faults().length === 0, 'K1f the hub is told the screen is the Pokemon Center (for its music); nothing threw', J([a.sound, a.hub.faults()]));
    const heres = spy.filter((s) => s.ch === N.CENTER_CHANNEL && s.m.k === 'here'), want = ['av', 'b', 'd', 'k', 'name', 's', 't', 'v', 'x', 'y'];
    const extra = heres.map((s) => Object.keys(s.m).filter((k) => !want.includes(k) && k !== 'rec')).flat();
    ok(heres.length > 0 && !extra.length && heres.every((s) => want.every((k) => k === 'b' || k in s.m)) && spy.filter((s) => s.ch === N.CENTER_CHANNEL).every((s) => !('team' in s.m) && !('room' in s.m)),
      'K1g what a walker publishes in the room is ONLY its defined fields (t, v, s, k, name, av, x, y, d, and b / rec when there are any): no team, no room, nothing else the page knows', J([extra, heres[0] && Object.keys(heres[0].m)]));
    ok(a.win.localStorage.getItem(CC.CENTER_SEEN_KEY) === '1' && a.win.localStorage.getItem('arena.open.seen') === '1', 'K1h that YES is remembered for the Center too (the disclosure carried what the Center lists)', J(a.win.localStorage.store));
    a.go('main'); await sleep(150); spy.length = 0;
    a.go('center');
    const again = await inRoom(a);
    ok(again && !a.dlg() && a.hook.center.state().entering === false, 'K1i ... so the next visit walks straight in', J([a.st().phase, a.dlg()]));
  });

  await block('K2', async () => {
    const a = page('?net=local&ctrname=Alice&ctrav=' + lk(6), { seed: 0 }), b = page('?net=local&ctrname=Bob&ctrav=' + lk(7), { seed: 1 });
    a.go('center'); b.go('center');
    await inRoom(a); await inRoom(b);
    await sees(a, 'Bob'); await sees(b, 'Alice');
    await settle(() => a.people()[0] && a.people()[0].doing === 'here' && b.people()[0] && b.people()[0].doing === 'here');
    const ab = a.people()[0], ba = b.people()[0], am = a.app.me(), bm = b.app.me();
    ok(ab && ba && ab.x === bm.x && ab.y === bm.y && ab.d === bm.d && ba.x === am.x && ba.y === am.y && am.x === room.spawns[0].x && bm.x === room.spawns[1].x && ab.gfx === looks[7] && ba.gfx === looks[6] && ab.kind === 'walker',
      'K2a two players who walked in see each other on the same cells, each as the look the other chose', J([ab, ba, am, bm]));
    ok(ab.doing === 'here' && ba.doing === 'here', 'K2b each walker is linked to their own board listing (the message that says who they are names it), so they can be asked', J([ab.doing, ba.doing]));
    // a step
    a.press('left'); a.tick(9 + 16 * 2, ['left']); a.tick(20);
    await settle(() => b.people()[0].x === a.app.me().x && b.people()[0].d === 'left');
    ok(a.app.me().x === room.spawns[0].x - 3 && b.people()[0].x === a.app.me().x && b.people()[0].d === 'left', 'K2c a walk is seen by the other, cell by cell', J([a.app.me(), b.people()[0]]));
    // a look, an emote
    a.press('b'); a.press('a'); a.press('right'); a.press('right'); a.press('a');
    const code = a.st().look;
    await settle(() => b.people()[0].gfx === K.lookId(code), 1500);
    ok(code !== lk(6) && b.people()[0].gfx === K.lookId(code) && a.win.localStorage.getItem(K.LOOK_KEY) === code, 'K2d a new look is stored for this browser and seen by the other at once (not at the next heartbeat)', J([code, b.people()[0].gfx]));
    await settle(() => b.svc.players().some((p) => p.look === code), 1500);
    ok(b.svc.players().some((p) => p.look === code), 'K2e ... and the board listing carries it too', J(b.svc.players().map((p) => p.look)));
    a.press('b'); a.press('down'); a.press('a'); a.press('right'); a.press('a');
    await settle(() => b.people()[0].emote === 1 && a.st().emote === 1, 1500);
    ok(b.people()[0].emote === 1 && a.st().emote === 1, 'K2f an emote is over the head of the player who chose it and seen by the other', J([a.st().emote, b.people()[0].emote]));
    await settle(() => b.people()[0].emote === null, 4000);
    ok(b.people()[0].emote === null, 'K2g ... for about two seconds (the picture of the other page never ran a frame: the roster ages on a timer)', J(b.people()[0]));
    // leaving
    a.go('main');
    await settle(() => b.people().length === 0, 2000);
    ok(b.people().length === 0 && a.sound.includes('music:hub') && !a.svc.isOn() && a.win.localStorage.getItem('arena.open') === null, 'K2h leaving says bye (the other drops the trainer at once), gives the music back and puts the switch back off', J([b.people(), a.svc.status()]));
    ok(a.hub.faults().length === 0 && b.hub.faults().length === 0, 'K2i nothing threw', J(a.hub.faults().concat(b.hub.faults())));
  });

  await block('K3', async () => {
    const a = page('?net=local&ctrname=Alice&ctrav=' + lk(6)), h = page('?net=local', { noCtl: true, local: { 'arena.avatar': lk(33) } }), g = page('?net=local', { noCtl: true, local: { 'arena.avatar': '0371a52' } });
    await h.svc.turnOn(); await g.svc.turnOn();
    a.go('center');
    await inRoom(a);
    await settle(() => a.people().length === 2);
    const ps = a.people(), withLook = ps.find((p) => p.gfx === looks[33]), other = ps.find((p) => p !== withLook);
    const spots = ps.map((p) => p.x + ',' + p.y).sort().join(' '), want = [room.spots[0], room.spots[1]].map((s) => s.x + ',' + s.y).sort().join(' ');
    const listed = a.svc.players().map((p) => p.look).sort().join();
    ok(ps.length === 2 && ps.every((p) => p.kind === 'spot' && p.doing === 'menu') && spots === want && withLook && other && looks.includes(other.gfx) && listed === [lk(33), null].sort().join(),
      'K3a players who are open from the hub (not in the Center) stand at the spots, as the look they list; a stored look of the hand-drawn Center is never listed, and its player is still one of the ROM trainers', J([ps, listed]));
    // talk to one of them through WHO'S HERE and ask
    a.press('b'); a.press('down'); a.press('down'); a.press('down'); a.press('a'); a.press('a');
    const k3 = a.dlg(), k3l = a.last();
    ok(k3 && k3.id === 'center:talk' && k3.lines[1] === CH.WORDS.menu && k3l && k3l.choice && k3l.choice.options[0] === 'ASK TO BATTLE', 'K3b a player at a spot can be asked: they are "open from the Arena menu"', J([k3, k3l]));
    a.press('a');
    const target = a.st().asking, hw = [h, g].find((x) => x.svc.boardId() === target);
    await settle(() => hw.dlg() && hw.dlg().id === 'presence:challenge');
    ok(hw.dlg() && /^Player/.test(hw.dlg().lines[0]) && /wants to battle you/.test(hw.dlg().lines[1]), 'K3c the player asked sees the question in their own picture: "<the asker> wants to battle you."', J(hw.dlg()));
    hw.tick(40); for (let i = 0; i < 6 && hw.dlg() && hw.dlg().more; i++) hw.press('a'); hw.press('a');
    await settle(() => a.dlg() && a.dlg().id === 'center:note');
    ok(a.text() === 'Player said not now.' && a.st().asking === null && hw.nav.length === 0 && a.nav.length === 0, 'K3d NO: the asker is told "said not now", and nobody goes anywhere', J([a.text(), hw.nav]));
    ok(a.hub.faults().length === 0, 'K3e nothing threw', J(a.hub.faults()));
  });

  await block('K4', async () => {
    const a = page('?net=local&ctrname=Alice&ctrav=' + lk(6), { seed: 0 }), b = page('?net=local&ctrname=Bob&ctrav=' + lk(7), { seed: 1 });
    a.go('center'); b.go('center');
    await inRoom(a); await inRoom(b);
    await settle(() => a.people()[0] && a.people()[0].doing === 'here');
    // A turns to B (one cell to the left) and asks
    const bx = b.app.me().x, dir = bx < a.app.me().x ? 'left' : 'right';
    a.press(dir); a.tick(2); a.press('a');
    ok(a.dlg() && a.dlg().id === 'center:talk' && /^Bob/.test(a.dlg().lines[0]) && a.dlg().lines[1] === CH.WORDS.here, 'K4a A in front of another walker: "Bob", "is here in the TRAINER CENTER.", ASK TO BATTLE', J(a.dlg()));
    a.last(); a.press('a');
    await settle(() => b.dlg() && b.dlg().id === 'presence:challenge');
    b.tick(40); for (let i = 0; i < 6 && b.dlg() && b.dlg().more; i++) b.press('a'); b.press('up'); b.press('a');
    await settle(() => b.nav.length === 1);
    const bn = b.nav[0] || {};
    ok(/\/pokemonarena\/battle\.html\?online=1&auto=host&for=[0-9a-f]{16}&rq=[0-9a-f]{16}/.test(bn.url || '') && /net=local/.test(bn.url) && !!bn.accept && bn.back === 'center',
      'K4b YES in the Center: the one who was asked leaves for the battle page with the one-time accept token, and the battle will come back to the Center', J(bn));
    await settle(() => a.dlg() && a.dlg().id === 'center:note');
    ok(a.text() === 'Bob accepted! Opening the battle...', 'K4c the asker is told "Bob accepted! Opening the battle..."', a.text());
    // the battle page of the one who accepted says "come in" (the room, sealed to the asker's one-time key): what the real battle page does after Accept
    const tok = JSON.parse(bn.accept);
    const lob = OL.createOpenLobbies({ bus: OL.createLocalBus({ BroadcastChannel: globalThis.BroadcastChannel }), now: () => performance.now(), mine: { rom: 'x', fp: 'y' } });
    const acc = P.createAcceptor({ lobbies: lob, to: tok.for, r: tok.rq, room: 'QWERT', ck: tok.ck });
    await settle(() => a.nav.length === 1);
    acc.stop(); lob.close();
    const an = a.nav[0] || {};
    ok(/\/pokemonarena\/battle\.html\?np=QWERT&join=1&meet=1&net=local/.test(an.url || '') && an.meet && JSON.parse(an.meet).room === 'QWERT' && an.back === 'center',
      'K4d the asker is taken to that room as the one who joins, with the one-time MEET token written first, and comes back to the Center afterwards', J(an));
    ok(a.hub.path() === 'center' && a.hook.center.state().leaving === true && !/switched off/.test(a.text() || ''), 'K4e ... and is not "walked out" on the way', J(a.hook.center.state()));
    // a listed game: JOIN THEIR BATTLE goes straight there
    const c = page('?net=local&ctrname=Cara&ctrav=' + lk(8), { seed: 3 });
    c.go('center'); await inRoom(c);
    c.app.setRoster({ walkers: [], players: [{ id: S16('e'), name: 'Host', rec: null, look: null, doing: 'waiting', room: 'ZXCVB', fmt: '3v3', compatible: true }] });
    c.press('b'); c.press('down'); c.press('down'); c.press('down'); c.press('a'); c.press('a'); c.last(); c.press('a');
    const cn = c.nav[0] || {};
    ok(/\?np=ZXCVB&join=1&meet=1&net=local/.test(cn.url || '') && cn.back === 'center' && cn.meet, 'K4f JOIN THEIR BATTLE opens that room with the MEET token, and comes back to the Center', J(cn));
    const bad = page('?net=local&ctrname=Dan&ctrav=' + lk(9), { seed: 4 });
    bad.go('center'); await inRoom(bad);
    bad.app.setRoster({ walkers: [], players: [{ id: S16('f'), name: 'Odd', rec: null, look: null, doing: 'waiting', room: 'not a room!', fmt: '3v3', compatible: true }] });
    bad.press('b'); bad.press('down'); bad.press('down'); bad.press('down'); bad.press('a'); bad.press('a'); bad.last(); bad.press('a');
    ok(bad.nav.length === 0 && /not open any more/.test(bad.text() || '') && bad.hook.center.state().leaving === false, 'K4g a room that is not a room code opens nothing, and says so', J([bad.nav, bad.text()]));
    ok([a, b, c, bad].every((x) => x.hub.faults().length === 0), 'K4h nothing threw', J(a.hub.faults()));
  });

  await block('K5', async () => {
    const a = page('?net=local&ctrname=Alice&ctrav=' + lk(6), { seed: 0 }), b = page('?net=local&ctrname=Bob&ctrav=' + lk(7), { seed: 1 });
    a.go('center'); b.go('center');
    await inRoom(a); await inRoom(b); await sees(b, 'Alice');
    // Open to battles goes off in another tab of this browser: the stored switch changed, and this page follows it
    a.win.fire('storage', { key: 'arena.open', storageArea: a.win.localStorage });
    await settle(() => a.hub.path() !== 'center');
    await sleep(100);
    const line = (a.hub.view().dialog || { lines: [] }).lines.join(' ');
    ok(a.hub.path() === 'online' && /OPEN TO BATTLES was switched off/.test(line) && a.st().phase === 'closed', 'K5a Open to battles switched off elsewhere walks the player out, with a line saying why', J([a.hub.path(), line]));
    await settle(() => b.people().length === 0, 2000);
    ok(b.people().length === 0 && a.hook.center.state().inside === false, 'K5b ... and the others stop seeing them', J(b.people()));
    // a player whose stored switch is on: walking in asks nothing, and leaving leaves the switch on
    const s = page('?net=local&ctrname=Sam&ctrav=' + lk(9), { local: { 'arena.open': '1', 'arena.open.seen': '1' } });
    await s.svc.ready; await settle(() => s.svc.isOn());
    s.go('center'); await inRoom(s);
    s.go('main'); await sleep(150);
    ok(s.svc.isOn() && s.win.localStorage.getItem('arena.open') === '1' && s.hook.center.state().mine === false, 'K5c a player who was already open stays open after leaving the Center', J([s.svc.status(), s.hook.center.state()]));
    ok(s.svc.mount.lobbies.isWatching() === false, 'K5m ... and their page stops asking the board who is open (the list is the Center\'s to watch, only while the player is in it)', '');
    // on for this page only: leaving puts it back, and the stored switch was never written
    b.go('main'); await sleep(150);
    ok(!b.svc.isOn() && b.win.localStorage.getItem('arena.open') === null, 'K5d a player who was not open is not open after leaving, and the stored switch was never touched', J([b.svc.status(), b.win.localStorage.store]));
    // leaving while Open to battles is still starting leaves nothing behind
    const q = page('?net=local&ctrname=Quin&ctrav=' + lk(9));
    q.go('center'); await q.svc.ready; q.go('main');          // (the switch is on its way on when the player leaves)
    await sleep(700);
    ok(!q.svc.isOn() && q.st().phase === 'closed' && q.hook.center.state().inside === false, 'K5e leaving while it was still starting leaves nothing on and nobody in the room', J([q.svc.status(), q.hook.center.state()]));
    // ... and coming straight back in: the visit that was given up must not switch Open off under the one that followed it
    const r = page('?net=local&ctrname=Rae&ctrav=' + lk(9));
    r.go('center'); await r.svc.ready; r.go('main'); r.go('center');
    await inRoom(r); await sleep(800);
    ok(r.st().phase === 'in' && r.svc.isOn() && r.hub.path() === 'center' && !r.hub.view().dialog && r.hook.center.state().inside && r.hook.center.state().mine === true, 'K5h leaving and coming straight back while it was starting: the player is in, open, and not walked out by the visit that was given up', J([r.st().phase, r.svc.status(), r.hub.path(), r.hook.center.state()]));
    r.go('main'); await sleep(150);
    ok(!r.svc.isOn() && r.win.localStorage.getItem('arena.open') === null, 'K5i ... and when that visit ends the switch is put back', r.svc.status());
    // the stored switch went ON while the player was inside (another tab of this browser switched it on): leaving the Center then leaves it on
    const t2 = page('?net=local&ctrname=Tess&ctrav=' + lk(9), { local: { 'arena.open.seen': '1' } });
    t2.go('center'); await inRoom(t2);
    t2.win.localStorage.setItem('arena.open', '1');
    t2.go('main'); await sleep(150);
    ok(t2.svc.isOn(), 'K5j a switch that was stored ON meanwhile is not switched off by leaving the Center', t2.svc.status());
    // the page goes away: the room is told at once, and nobody is "walked out"
    const p = page('?net=local&ctrname=Pat&ctrav=' + lk(9)), o = page('?net=local&ctrname=Obs&ctrav=' + lk(8), { seed: 2 });
    p.go('center'); o.go('center'); await inRoom(p); await inRoom(o); await sees(o, 'Pat');
    p.win.fire('pagehide', {});
    await settle(() => !o.people().some((x) => x.kind === 'walker'), 2000); await sleep(50);
    ok(!o.people().some((x) => x.kind === 'walker') && p.hub.path() === 'center' && !p.hub.view().dialog, 'K5f a page that goes away says bye at once, and is not walked out with a line', J([o.people(), p.hub.path()]));
    p.win.fire('pageshow', { persisted: true });               // ... and the browser brings it back from the back / forward cache
    const backIn = await inRoom(p), seenAgain = await sees(o, 'Pat');
    ok(backIn && seenAgain && p.hub.path() === 'center' && !p.hub.view().dialog, 'K5l a page that comes back from the back / forward cache walks in again, and the others see the trainer again', J([backIn, seenAgain, p.hook.center.state()]));
    ok([a, b, s, q, r, t2, p, o].every((x) => x.hub.faults().length === 0), 'K5g nothing threw', J(a.hub.faults()));
  });

  await block('K6', async () => {
    // the sounds: the ROM effects by their place in the SoulGold song table when that soundtrack plays, a mapped key otherwise
    const played = [];
    const sys = (st) => ({ mixer: { soundtrack: () => st }, director: { playEffectIndex: (i) => played.push(i) } });
    const a = page('?net=local&ctrname=Alice&ctrav=' + lk(6), { system: sys('soulgold') });
    a.go('center'); await inRoom(a);
    a.press('left'); a.tick(8 + 16 * 8, ['left']);                        // along the row to the wall
    a.tick(40, ['left']);
    ok(played.length >= 1 && played.every((i) => i === CC.ROOM_SOUNDS.bump.index) && !a.sound.some((k) => /^se_/.test(k)) && a.app.me().x === 1, 'K6a walking is silent (no menu blip on a step); a bump is the wall-hit sound of the ROM', J([played, a.sound]));
    a.ctl.effect({ app: 'center', type: 'sound', what: 'pc' }); a.ctl.effect({ app: 'center', type: 'sound', what: 'door' }); a.ctl.effect({ app: 'center', type: 'sound', what: 'nope' });
    ok(played.slice(-2).join() === [CC.ROOM_SOUNDS.pc.index, CC.ROOM_SOUNDS.door.index].join(), 'K6b the PC and the door are sounds of the ROM too', J(played.slice(-3)));
    const u = page('?net=local&ctrname=Uma&ctrav=' + lk(7), { system: sys('ultraviolet') });
    u.go('center'); await inRoom(u);
    const n1 = played.length;
    u.ctl.effect({ app: 'center', type: 'sound', what: 'bump' }); u.ctl.effect({ app: 'center', type: 'sound', what: 'pc' }); u.ctl.effect({ app: 'center', type: 'sound', what: 'door' });
    const none = page('?net=local&ctrname=Nia&ctrav=' + lk(8));
    none.go('center'); await inRoom(none); none.ctl.effect({ app: 'center', type: 'sound', what: 'door' });
    ok(played.length === n1 && u.sound.filter((k) => /^se_/.test(k)).join() === 'se_select,se_back' && none.sound.includes('se_back'), 'K6c with another soundtrack (its table has other numbers) or no sound system, the mapped keys are played instead', J([u.sound, none.sound]));
    a.press('b');
    ok(a.sound.includes('se_menu_open'), 'K6d the menu opens with the window sound of the ROM', J(a.sound));
    // the stored look
    const o = page('?net=local', { local: { 'arena.avatar': '0371a52' }, seed: 5 });
    o.go('center'); await inRoom(o);
    const stored = o.win.localStorage.getItem(K.LOOK_KEY);
    ok(stored === lk(5) && o.st().look === stored && o.app.me().name === 'Player', 'K6e a stored look of the hand-drawn Center is replaced by one of the ROM looks, picked once and kept', stored);
    const nl = page('?ctrname=Evil&ctrav=' + lk(9), { local: { 'arena.avatar': lk(12) } });
    ok(nl.hook.center.state().seam === null && a.hook.center.state().seam === 'Alice', 'K6f the name and look seams are for the same-browser test transport only', J(nl.hook.center.state()));
    const src = fs.readFileSync(path.join(jsDir, 'center_ctl.js'), 'utf8');
    ok(!/requestAnimationFrame/.test(src) && /win\.setInterval\(beat, BEAT_MS\)/.test(src), 'K6g what the room must learn or publish runs on a timer, never on the frames of the picture', '');
    // the cell is kept ONLY for the way back from the Team Builder
    const kp = page('?net=local&ctrname=Kay&ctrav=' + lk(9));
    kp.go('center'); await inRoom(kp);
    const use = room.pc[0].use;
    kp.click(use.x * 16 + 8, use.y * 16 + 8); kp.tick(600); kp.press('up'); kp.tick(2); kp.press('a');
    const inBuilder = kp.hub.path();
    kp.press('b'); await inRoom(kp);
    const backAt = kp.app.me();
    kp.press('a');                                              // the PC again, and this time HOME from the Team Builder
    const inBuilder2 = kp.hub.path();
    kp.go('main'); await sleep(CC.BEAT_MS * 2 + 200);
    kp.go('center'); await inRoom(kp);
    const freshAt = kp.app.me();
    ok(inBuilder === 'builder' && backAt.x === use.x && backAt.y === use.y && inBuilder2 === 'builder' && freshAt.x === room.spawns[0].x && freshAt.y === room.spawns[0].y && kp.hook.center.state().inside,
      'K6i B in the Team Builder comes back to the cell the player stood on; a player who went on from the Team Builder to the main menu walks in at the door the next time', J([inBuilder, backAt, inBuilder2, freshAt]));
    ok([a, u, none, o, kp].every((x) => x.hub.faults().length === 0), 'K6h nothing threw', J(a.hub.faults()));
  });

  await block('K7', async () => {
    // a visit that was given up before the presence service was even ready publishes nothing, not for a moment
    spy.length = 0;
    const z = page('?net=local&ctrname=Zed&ctrav=' + lk(9));
    z.go('center'); z.go('main');
    await z.svc.ready; await sleep(600);
    ok(spy.length === 0 && !z.svc.isOn() && z.st().phase === 'closed' && z.hook.center.state().inside === false, 'K7j a player who left before the presence service was ready is never listed, not even for a moment', J([spy.slice(0, 2), z.svc.status()]));
    z.end();
    // THE CENTER'S OWN QUESTION: a player whose switch is OFF and who once answered the hub's disclosure (they were told about the name and the record, never about the look and the cell)
    spy.length = 0;
    const a = page('?net=local&opendisc=1&ctrname=Alice&ctrav=' + lk(6), { local: { 'arena.open.seen': '1' } });
    a.go('center');
    await settle(() => a.dlg() && a.dlg().id === 'center:enter');
    await sleep(300);
    const q = a.dlg();
    ok(q && q.id === 'center:enter' && a.st().phase === 'wait' && a.hub.view().center.people.length === 0 && a.svc.isOn() === false && a.svc.stored() === false,
      'K7a a player who is NOT open to battles but once answered the hub\'s disclosure is still asked first, in the picture, by the Center itself', J([q && q.id, a.st().phase, a.svc.status()]));
    ok(spy.length === 0 && a.hook.center.wire.sent === 0, 'K7b nothing at all is published before YES (not on the room channel, not on the board)', J(spy.slice(0, 2)));
    a.read();
    let words = ''; for (let i = 0; i < 20 && a.dlg() && a.dlg().more; i++) { words += ' ' + a.text(); a.press('a'); }
    const last = a.dlg();
    ok(/trainer name, record, look and where you stand/.test(words) && /public servers/.test(words) && /takes it all down/.test(words) && last && last.lines[0] === CH.WORDS.enterAsk && last.choice && last.choice.options.join() === 'YES,NO' && last.choice.cursor === 1,
      'K7c it says what walking in lists: the name, the record, THE LOOK and WHERE YOU STAND, on public servers, and how it ends; NO is highlighted', words.slice(0, 400));
    a.press('a');                                               // A on the highlighted NO
    await settle(() => a.hub.path() !== 'center'); await sleep(200);
    ok(a.hub.path() === 'online' && a.st().phase === 'closed' && spy.length === 0 && !a.svc.isOn() && a.win.localStorage.getItem(CC.CENTER_SEEN_KEY) === null && a.win.localStorage.getItem('arena.open') === null && !a.dlg(),
      'K7d NO leaves the Center without a word: nothing was published, nothing is remembered', J([a.hub.path(), spy.length, a.win.localStorage.store]));
    a.go('center');
    await settle(() => a.dlg() && a.dlg().id === 'center:enter'); a.read(); a.last(); a.press('up'); a.press('a');
    const went = await inRoom(a);
    await settle(() => spy.some((s) => s.ch === N.CENTER_CHANNEL && s.m.k === 'here'));
    ok(went && a.svc.isOn() && a.win.localStorage.getItem(CC.CENTER_SEEN_KEY) === '1' && a.win.localStorage.getItem('arena.open') === null && spy.some((s) => s.ch === N.CENTER_CHANNEL && s.m.k === 'here' && s.m.name === 'Alice'),
      'K7e YES walks in (open for this page only: the stored switch stays off), and is remembered', J([went, a.win.localStorage.store]));
    a.go('main'); await sleep(150);
    a.go('center');
    const again = await inRoom(a);
    ok(again && !a.dlg() && a.hook.center.state().entering === false, 'K7f the next visit asks nothing: what the Center lists was said once, and YES was the answer', J([a.st().phase, a.dlg()]));
    // a player whose switch is ON: they are listed already, but the look and the cell are news to them too. NO leaves them as they were
    const s = page('?net=local&opendisc=1&ctrname=Sam&ctrav=' + lk(9), { local: { 'arena.open': '1', 'arena.open.seen': '1' } });
    await s.svc.ready; await settle(() => s.svc.isOn());
    s.go('center');
    await settle(() => s.dlg() && s.dlg().id === 'center:enter'); await sleep(200);
    const sq = s.dlg();
    s.read();
    let sw = ''; for (let i = 0; i < 20 && s.dlg() && s.dlg().more; i++) { sw += ' ' + s.text(); s.press('a'); }
    s.press('b');                                               // B is NO
    await settle(() => s.hub.path() !== 'center'); await sleep(200);
    ok(sq && sq.id === 'center:enter' && s.hub.path() === 'online' && s.svc.isOn() && !spy.some((x) => x.ch === N.CENTER_CHANNEL && x.m.name === 'Sam') && s.win.localStorage.getItem(CC.CENTER_SEEN_KEY) === null && s.hook.center.state().inside === false,
      'K7g a player whose switch is ON is asked too (the look and the cell are news to them); NO leaves them listed as they were and puts nothing of them in the room', J([sq && sq.id, s.hub.path(), s.svc.status()]));
    ok(/stay listed/.test(sw) && /OPEN TO BATTLES is on/.test(sw) && !/takes it all down/.test(sw) && /look and where you stand/.test(sw), 'K7h ... and their question says how it ends for THEM: leaving takes them out of the room, the listing stays', sw.slice(-260));
    s.go('center'); await settle(() => s.dlg() && s.dlg().id === 'center:enter'); s.read(); s.last(); s.press('up'); s.press('a');
    const sin = await inRoom(s);
    s.go('main'); await sleep(150);
    ok(sin && s.svc.isOn() && s.win.localStorage.getItem('arena.open') === '1' && s.win.localStorage.getItem(CC.CENTER_SEEN_KEY) === '1', 'K7i YES walks them in; leaving leaves their switch on', J([sin, s.svc.status()]));
    // a browser that cannot remember (storage blocked) is asked at every visit
    const nb = page('?net=local&opendisc=1&ctrname=Nob&ctrav=' + lk(10), { local: { 'arena.open.seen': '1' }, blocked: true });
    nb.go('center'); await settle(() => nb.dlg() && nb.dlg().id === 'center:enter'); nb.read(); nb.last(); nb.press('up'); nb.press('a');
    const nb1 = await inRoom(nb);
    nb.go('main'); await sleep(150); nb.go('center');
    const nb2 = await settle(() => nb.dlg() && nb.dlg().id === 'center:enter');
    ok(nb1 && nb2 && nb.st().phase === 'wait', 'K7k a browser that cannot remember the answer asks at every visit (it never walks anybody in unasked)', J([nb1, nb2]));
    ok([a, s, nb].every((x) => x.hub.faults().length === 0), 'K7l nothing threw', J(a.hub.faults()));
  });

  // two players in the room who can ask each other (a short answer time: 3 s in place of 25)
  const QC = '?net=local&openchal=3000';
  const two = async () => {
    const a = page(QC + '&ctrname=Alice&ctrav=' + lk(6), { seed: 0 }), b = page(QC + '&ctrname=Bob&ctrav=' + lk(7), { seed: 1 });
    a.go('center'); b.go('center'); await inRoom(a); await inRoom(b);
    await settle(() => a.people().some((p) => p.name === 'Bob' && p.doing === 'here') && b.people().some((p) => p.name === 'Alice' && p.doing === 'here'));
    return [a, b];
  };
  // ask a trainer by name through WHO'S HERE (it works from anywhere in the room)
  const askName = (w, name) => { w.press('b'); w.press('down'); w.press('down'); w.press('down'); w.press('a'); const i = w.hub.view().center.who.rows.findIndex((r) => r.name === name); for (let k = 0; k < i; k++) w.press('down'); w.press('a'); w.last(); w.press('a'); };
  const questioned = (w, ms = 1000) => settle(() => w.dlg() && w.dlg().id === 'presence:challenge', ms);

  await block('K8', async () => {
    const openers = [
      ['a notice nobody pressed A on', (b) => { b.app.askFailed('timeout'); }, 'center:note'],
      ['a sign', (b) => { b.click(room.signs[0].x * 16 + 8, room.signs[0].y * 16 + 8); b.tick(400); }, 'center:sign'],
      ['the nurse', (b) => { b.click(room.nurse.x * 16 + 8, room.nurse.y * 16 + 8); b.tick(400); }, 'center:nurse'],
      ['the question about a trainer', (b) => { b.press('b'); b.press('down'); b.press('down'); b.press('down'); b.press('a'); b.press('a'); }, 'center:talk'],
    ];
    const hidden = [];
    for (const [what, open, id] of openers) {
      const [a, b] = await two();
      open(b);
      const under = b.dlg() && b.dlg().id;
      askName(a, 'Bob');
      const seen = await questioned(b);
      const d = b.dlg();
      if (under !== id || !seen || !d || !/wants to battle you/.test(d.lines[1]) || d.armed !== false || d.queued !== 0) hidden.push(what + ': ' + under + ' > ' + (d && d.id));
      b.read(); b.last(); b.press('up'); b.press('a');          // and it can be answered: YES
      await settle(() => b.nav.length === 1, 1500);
      if (b.nav.length !== 1) hidden.push(what + ': YES did not open the battle');
      await endAll();
    }
    ok(!hidden.length, 'K8a somebody asks a player who has a notice, a sign, the nurse or the question about a trainer on the screen: "wants to battle you" is the one shown within a second (nothing of the Center stands in front of it), and YES opens the battle', J(hidden));

    // ONE QUESTION AT A TIME: Cara is waiting for Bob's answer when Alice asks Cara
    {
      const [a, b] = await two();
      const c = page(QC + '&ctrname=Cara&ctrav=' + lk(8), { seed: 2 });
      c.go('center'); await inRoom(c);
      await settle(() => c.people().filter((p) => p.doing === 'here').length === 2 && a.people().some((p) => p.name === 'Cara' && p.doing === 'here'));
      askName(c, 'Bob');
      const bobAsked = await questioned(b);
      askName(a, 'Cara');
      const caraSees = await questioned(c);
      await settle(() => !b.dlg(), 1500);
      const cd = c.dlg();
      ok(bobAsked && caraSees && cd && /wants to battle you/.test(cd.lines[1]) && cd.queued <= 1 && !b.dlg() && c.st().asking === null && c.hook.center.state().asking === false,
        'K8b ONE QUESTION AT A TIME: somebody asks a player who is waiting for an answer to a challenge of their own: the question is on their screen within a second, and their own challenge is withdrawn (the player they had asked stops seeing it)', J([bobAsked, caraSees, cd, b.dlg()]));
      c.read(); c.last(); c.press('a');                         // NO (the highlighted answer)
      await settle(() => c.dlg() && c.dlg().id === 'center:note');
      await settle(() => a.dlg() && a.dlg().id === 'center:note');
      ok(c.text() === 'Your challenge to Bob was withdrawn.' && /said not now/.test(a.text() || '') && [a, b, c].every((x) => x.nav.length === 0), 'K8c after their NO a line says that their own challenge was withdrawn; the one who asked them is told "said not now"; nobody goes anywhere', J([c.text(), a.text()]));
      await endAll();
    }

    // TWO WHO ASK EACH OTHER AT ONCE
    {
      const [a, b] = await two();
      askName(a, 'Bob'); askName(b, 'Alice');                   // (in one turn: neither has heard the other)
      const small = String(a.svc.boardId()) < String(b.svc.boardId()) ? a : b, big = small === a ? b : a;
      const seen = await questioned(small);
      await sleep(400);
      const sd = small.dlg(), bd = big.dlg();
      ok(seen && sd && sd.id === 'presence:challenge' && small.st().asking === null && small.hook.center.state().asking === false && bd && bd.id === 'center:asking' && bd.queued === 0 && big.hook.center.state().asking === true,
        'K8d two players who ask EACH OTHER at once: exactly one of them (the smaller board id) withdraws and sees the question; the other keeps waiting, with nothing hidden behind the waiting line', J([seen, sd && sd.id, bd && [bd.id, bd.queued]]));
      small.read(); small.last(); small.press('up'); small.press('a');          // YES
      await settle(() => small.nav.length === 1);
      await settle(() => big.dlg() && big.dlg().id === 'center:note');
      const told = big.text();
      const sn = small.nav[0] || {}, tok = sn.accept ? JSON.parse(sn.accept) : {};
      const lob = OL.createOpenLobbies({ bus: OL.createLocalBus({ BroadcastChannel: globalThis.BroadcastChannel }), now: () => performance.now(), mine: { rom: 'x', fp: 'y' } });
      const acc = P.createAcceptor({ lobbies: lob, to: tok.for, r: tok.rq, room: 'QWERT', ck: tok.ck });          // (what the battle page of the one who said YES does)
      await settle(() => big.nav.length === 1);
      acc.stop(); lob.close();
      ok(/auto=host/.test(sn.url || '') && /accepted! Opening the battle/.test(told || '') && small.nav.length === 1 && big.nav.length === 1 && /np=QWERT&join=1&meet=1/.test((big.nav[0] || {}).url || ''),
        'K8e ... and YES ends in ONE battle: the one who answered hosts, the one who kept waiting joins (never two rooms, never two automatic NOs)', J([sn.url, told, big.nav]));
      await endAll();
    }

    // a player whose own challenge has just been ACCEPTED answers nobody else: the battle is opening. Whoever asks is told no at once, and the battle still opens
    {
      const [a, b] = await two();
      const c = page(QC + '&ctrname=Cara&ctrav=' + lk(8), { seed: 2 });
      c.go('center'); await inRoom(c);
      await settle(() => c.people().some((p) => p.name === 'Alice' && p.doing === 'here'));
      askName(a, 'Bob');
      await questioned(b);
      b.read(); b.last(); b.press('up'); b.press('a');          // Bob: YES (his page leaves for the battle page, which will open the room)
      await settle(() => a.dlg() && a.dlg().id === 'center:note' && /accepted/.test(a.text() || ''));
      askName(c, 'Alice');                                      // ... and Cara asks Alice in that moment
      await settle(() => c.dlg() && c.dlg().id === 'center:note', 2000);
      const caraTold = c.text(), aliceReads = a.text();
      const tok = JSON.parse((b.nav[0] || {}).accept || '{}');
      const lob = OL.createOpenLobbies({ bus: OL.createLocalBus({ BroadcastChannel: globalThis.BroadcastChannel }), now: () => performance.now(), mine: { rom: 'x', fp: 'y' } });
      const acc = P.createAcceptor({ lobbies: lob, to: tok.for, r: tok.rq, room: 'QWERT', ck: tok.ck });
      await settle(() => a.nav.length === 1);
      acc.stop(); lob.close();
      ok(/said not now/.test(caraTold || '') && /accepted! Opening the battle/.test(aliceReads || '') && a.nav.length === 1 && /np=QWERT&join=1&meet=1/.test((a.nav[0] || {}).url || '') && c.nav.length === 0,
        'K8g a player whose own challenge was just ACCEPTED is not interrupted: somebody else who asks is told no at once, "accepted! Opening the battle..." stays, and the battle opens', J([caraTold, aliceReads, a.nav]));
      await endAll();
    }

    // the Center's own question makes way for a challenge too (a player whose switch is on can be asked before they have walked in), and comes back
    {
      const h = page('?net=local&opendisc=1&openchal=3000&ctrname=Hal&ctrav=' + lk(9), { local: { 'arena.open': '1', 'arena.open.seen': '1' } });
      await h.svc.ready; await settle(() => h.svc.isOn());
      const [a] = await two();
      await settle(() => a.people().some((p) => p.kind === 'spot' && p.doing === 'menu'));
      h.go('center');
      await settle(() => h.dlg() && h.dlg().id === 'center:enter');
      h.read(); h.press('a');                                   // reading its second page
      // Alice asks the player who is open from the menu (Hal is at a spot in her room)
      a.press('b'); a.press('down'); a.press('down'); a.press('down'); a.press('a');
      const hi = a.hub.view().center.who.rows.findIndex((r) => r.doing === 'IN THE MENU');
      for (let k = 0; k < hi; k++) a.press('down');
      a.press('a'); a.last(); a.press('a');
      const seen = await questioned(h);
      const top = h.dlg() && h.dlg().id;
      h.read(); h.last(); h.press('a');                         // NO
      await settle(() => h.dlg() && h.dlg().id === 'center:enter', 1500);
      const back = h.dlg();
      ok(hi >= 0 && seen && top === 'presence:challenge' && back && back.id === 'center:enter' && back.page === 0 && h.st().phase === 'wait' && h.hook.center.state().entering === true,
        'K8f the Center\'s own question makes way too (a player whose switch is on can be asked before they walk in); after NO it is asked again from its first page', J([hi, seen, top, back && [back.id, back.page]]));
      await endAll();
    }
  });

  await block('K9', async () => {
    // CANCEL
    {
      const [a, b] = await two();
      askName(a, 'Bob');
      const asked = await questioned(b);
      a.read(); a.press('a');                                   // CANCEL (it listens after 0.6 s)
      const gone = await settle(() => !b.dlg(), 1500);
      const late = b.svc.mount.accept();                        // even a YES that was on its way opens nothing
      await sleep(400);
      ok(asked && gone && a.text() === CH.WORDS.cancelled && a.hook.center.state().asking === false && late === false && a.nav.length === 0 && b.nav.length === 0,
        'K9a CANCEL withdraws the challenge: the question closes on the screen of the player who was asked, and no YES can open a battle any more', J([asked, gone, a.text(), late, a.nav, b.nav]));
      await endAll();
    }
    // leaving the Center
    {
      const [a, b] = await two();
      askName(a, 'Bob');
      const asked = await questioned(b);
      a.go('online');
      const gone = await settle(() => !b.dlg(), 1500);
      const late = b.svc.mount.accept();
      await sleep(400);
      ok(asked && gone && late === false && a.nav.length === 0 && b.nav.length === 0 && a.hook.center.state().asking === false && !a.dlg(),
        'K9b leaving the Center withdraws a challenge that was waiting for its answer: the player who was asked cannot say YES to somebody who has gone', J([asked, gone, late, b.nav]));
      await endAll();
    }
    // the page goes away
    {
      const [a, b] = await two();
      askName(a, 'Bob');
      const asked = await questioned(b);
      a.win.fire('pagehide', {});
      const gone = await settle(() => !b.dlg(), 1500);
      ok(asked && gone && b.nav.length === 0, 'K9c ... and so does a page that goes away', J([asked, gone]));
      await endAll();
    }
  });

  await block('K10', async () => {
    // THE PUBLIC TRANSPORT (no ?net=local): a double of the MQTT library stands for the brokers; everything above it is the page's own code (openlobby.js createMqttBus, presence_boot.js, the ctl)
    const world = { clients: [], published: [] };
    const mq = {
      connect(url, opts) {
        const c = { url, opts, connected: false, subs: new Set(), h: {}, ended: false };
        c.on = (ev, fn) => { (c.h[ev] = c.h[ev] || []).push(fn); return c; };
        c.emit = (ev, ...args) => (c.h[ev] || []).forEach((f) => f(...args));
        c.subscribe = (t, _o, cb) => { c.subs.add(t); if (cb) cb(null); };
        c.publish = (t, p) => { world.published.push({ t, m: JSON.parse(p) }); for (const x of world.clients) if (x.url === url && x.connected && !x.ended && x.subs.has(t)) setTimeout(() => { if (!x.ended) x.emit('message', t, Buffer.from(p)); }, 0); };
        c.end = () => { c.ended = true; c.connected = false; };
        world.clients.push(c);
        setTimeout(() => { if (!c.ended) { c.connected = true; c.emit('connect'); } }, 0);
        return c;
      },
    };
    const QM = '?wsbroker=' + encodeURIComponent('wss://double:1/mqtt');
    const a = page(QM, { mqtt: mq, seed: 0 });
    a.go('center');
    await settle(() => a.dlg() && a.dlg().id === 'presence:disclosure'); await sleep(300);
    ok(a.dlg() && a.dlg().id === 'presence:disclosure' && world.clients.length === 0 && world.published.length === 0 && a.hook.center.state().seam === null,
      'K10a on the public transport the first visit asks first, and before YES not even a connection to a broker is made', J([a.dlg() && a.dlg().id, world.clients.length, world.published.length]));
    a.last(); a.press('up'); a.press('a');
    const ain = await inRoom(a);
    await settle(() => world.published.some((r) => r.m.k === 'here') && world.published.some((r) => r.m.k === 'open'), 12000);
    const roomMsgs = world.published.filter((r) => r.m.t === N.KIND), boardMsgs = world.published.filter((r) => r.m.t !== N.KIND);
    ok(ain && roomMsgs.length > 0 && roomMsgs.every((r) => r.t === N.CENTER_TOPIC) && boardMsgs.length > 0 && boardMsgs.every((r) => r.t === 'bemental/arena/open/1') && N.CENTER_TOPIC === 'bemental/arena/center/2' && world.clients.every((c) => c.url === 'wss://double:1/mqtt'),
      'K10b after YES the room speaks on ITS OWN topic (bemental/arena/center/2) and the board on the board\'s: nothing of the room is ever published on the board\'s topic', J([roomMsgs.slice(0, 1), [...new Set(world.published.map((r) => r.t))]]));
    const b = page(QM, { mqtt: mq, seed: 1, local: { 'arena.open.seen': '1', [CC.CENTER_SEEN_KEY]: '1' } });
    b.go('center');
    const bin = await inRoom(b);
    await settle(() => a.people().some((p) => p.kind === 'walker' && p.doing === 'here') && b.people().some((p) => p.kind === 'walker' && p.doing === 'here'), 15000);
    const ap = a.people(), bp = b.people();
    ok(bin && ap.length === 1 && ap[0].kind === 'walker' && ap[0].doing === 'here' && bp.length === 1 && bp[0].doing === 'here' && bp[0].x === a.app.me().x && bp[0].y === a.app.me().y && a.hook.center.state().net === 'up',
      'K10c two players on the public transport meet in the room, each linked to their own listing on the board', J([ap, bp]));
    ok([a, b].every((x) => x.hub.faults().length === 0), 'K10d nothing threw', J(a.hub.faults()));
  });
  for (const c of chans) c.close();
}

/* ================================================================================================ Node mutants */
// each: { id, file, from, to, fails (a case id prefix that must be among the failures), part: 'pure' | 'ctl' }
const NODE_MUTANTS = [
  { id: 'NL1', part: 'pure', file: 'center_look.js', from: "  if (typeof code !== 'string' || !LOOK_RE.test(code)) return null;", to: "  if (typeof code !== 'string' || code.length !== 7) return null;", fails: 'L2' },
  { id: 'NL2', part: 'pure', file: 'center_look.js', from: "  if (id !== null && list.includes(id)) return id;", to: "  if (id !== null) return id;", fails: 'L3' },
  { id: 'NL3', part: 'pure', file: 'center_look.js', from: "return typeof v === 'string' && LOOK_RE.test(v) ? v : null; }", to: "return typeof v === 'string' ? v : null; }", fails: 'L4' },
  { id: 'NR1', part: 'pure', file: 'center_room.js', from: "  const ok = (x, y) => reach.has(key(x, y));", to: "  const ok = (x, y) => open(x, y);", fails: 'R1' },
  { id: 'NR2', part: 'pure', file: 'center_room.js', from: "    return t && t.use.x === x && t.use.y === y ? t.kind : null;", to: "    return t ? t.kind : null;", fails: 'G4' },
  { id: 'NR3', part: 'pure', file: 'center_room.js', from: "    const passable = (x, y) => walkable(x, y) && (!isDoor(x, y) || (x === to.x && y === to.y && !adjacent));", to: "    const passable = (x, y) => walkable(x, y);", fails: 'G2' },
  { id: 'NR4', part: 'pure', file: 'center_room.js', from: "  return list.filter((o) => o === nurse || ((o.gfx & monFlag) !== 0 && o.y === nurse.y && Math.abs(o.x - nurse.x) === 1));", to: "  return list.slice();", fails: 'R4' },
  { id: 'NR5', part: 'pure', file: 'center_room.js', from: "    if (d !== 'up') return null;\n", to: "", fails: 'G4' },
  { id: 'NN1', part: 'pure', file: 'center_net.js', from: "  if (!isPos(rules, m.x, m.y)) return bad('position');", to: "  if (!Number.isInteger(m.x) || !Number.isInteger(m.y)) return bad('position');", fails: 'N2' },
  { id: 'NN2', part: 'pure', file: 'center_net.js', from: "  if (typeof m.av !== 'string' || !rules.look(m.av)) return bad('look');", to: "  if (typeof m.av !== 'string') return bad('look');", fails: 'N2' },
  { id: 'NN3', part: 'pure', file: 'center_net.js', from: "    if (!Number.isInteger(m.e) || m.e < 0 || m.e >= rules.emotes) return bad('emote');", to: "    if (!Number.isInteger(m.e) || m.e < 0) return bad('emote');", fails: 'N2' },
  { id: 'NN4', part: 'pure', file: 'center_net.js', from: " || cleanName(m.name, '') !== m.name) return bad('name');", to: ") return bad('name');", fails: 'N2' },
  { id: 'NN5', part: 'pure', file: 'center_net.js', from: "  if (m.v !== VERSION) return bad('version');\n", to: "", fails: 'N2' },
  { id: 'NN6', part: 'pure', file: 'center_net.js', from: "export const NO_ROOM = Object.freeze({ walkable: () => false, look: () => false, emotes: 0 });", to: "export const NO_ROOM = Object.freeze({ walkable: () => true, look: () => true, emotes: 64 });", fails: 'N3' },
  { id: 'NN7', part: 'pure', file: 'center_net.js', from: "(...a) => { try { return f(...a) === true; } catch (_e) { return false; } }", to: "(...a) => { try { return !!f(...a); } catch (_e) { return true; } }", fails: 'N3' },
  { id: 'NN8', part: 'pure', file: 'center_net.js', from: "export const CENTER_CHANNEL = 'bemental-arena-center-2';", to: "export const CENTER_CHANNEL = 'bemental-arena-center-1';", fails: 'N5' },
  { id: 'NN9', part: 'pure', file: 'center_net.js', from: "    if (++p.n > timing.perSenderMax) return;", to: "    ++p.n;", fails: 'N7i' },
  { id: 'NN10', part: 'pure', file: 'center_net.js', from: "      if (t - lastMove >= timing.moveGapMs) { T.clearTimeout(moveTimer); go(); }\n      else if (!moveTimer) moveTimer = T.setTimeout(go, timing.moveGapMs - (t - lastMove));", to: "      if (t - lastMove >= timing.moveGapMs) { T.clearTimeout(moveTimer); go(); }", fails: 'N7c' },
  { id: 'NN11', part: 'pure', file: 'center_net.js', from: "      if (started) send({ k: 'bye' });", to: "", fails: 'N7j' },
  { id: 'NN12', part: 'pure', file: 'center_net.js', from: "    if (!r.ok || r.b.s === sid) return;", to: "    if (!r.ok) return;", fails: 'N7h' },
  { id: 'NN13', part: 'pure', file: 'center_net.js', from: "    const o = { k: 'here', name: cleanName(m.name, 'Trainer'), av: m.av,", to: "    const o = { k: 'here', name: String(m.name), av: m.av,", fails: 'N7a' },
  { id: 'NN14', part: 'pure', file: 'center_net.js', from: "      if (!started || closed || !Number.isInteger(e) || e < 0 || e >= rules.emotes) return false;", to: "      if (!started || closed || !Number.isInteger(e)) return false;", fails: 'N7d' },
  { id: 'NN15', part: 'pure', file: 'presence_boot.js', from: "rs: DEFAULT_RULESET_ID, av: loadLook(storage) });", to: "rs: DEFAULT_RULESET_ID, av: null });", fails: 'N8' },
  { id: 'NT1', part: 'pure', file: 'presence.js', from: "    return t.room === room.toUpperCase() && age <= maxAgeMs && age >= -5000;", to: "    return age <= maxAgeMs && age >= -5000;", fails: 'T2' },
  { id: 'NT2', part: 'pure', file: 'presence.js', from: "    storage.removeItem(MEET_KEY);\n    if (storage.getItem(MEET_KEY) !== null) return false;", to: "    storage.removeItem(MEET_KEY);", fails: 'T5' },
  { id: 'NT3', part: 'pure', file: 'online.js', from: "meet: q.get('meet') === '1' && join && room !== null };", to: "meet: q.get('meet') === '1' };", fails: 'T6' },
  { id: 'NM1', part: 'pure', file: 'center_hub.js', from: "    if (S.grid.walkable(n.x, n.y)) { me.x = n.x; me.y = n.y; me.mv = { d: dir, t: 0 };", to: "    if (n.x >= 0 && n.y >= 0 && n.x < 15 && n.y < 10) { me.x = n.x; me.y = n.y; me.mv = { d: dir, t: 0 };", fails: 'M3a' },
  { id: 'NM2', part: 'pure', file: 'center_hub.js', from: "    if (S.grid.isDoor(me.x, me.y) && S.room.door.d === dir) { S.walk = null; fx.push(...exit()); return; }", to: "    if (S.grid.isDoor(me.x, me.y)) { S.walk = null; fx.push(...exit()); return; }", fails: 'M5e' },
  { id: 'NM3', part: 'pure', file: 'center_hub.js', from: "          if (!me.mv && me.d !== action) { me.d = action; me.turn = WALK.turn; return [SILENT, eff('moved')]; }", to: "          if (!me.mv && me.d !== action) { me.d = action; me.turn = 0; return [SILENT, eff('moved')]; }", fails: 'M2i' },
  { id: 'NM4', part: 'pure', file: 'center_hub.js', from: "      if (me.mv && ++me.mv.t >= WALK.step) { me.mv = null; flowing = true; }", to: "      if (me.mv && ++me.mv.t >= WALK.step / 2) { me.mv = null; flowing = true; }", fails: 'M2d' },
  { id: 'NM5', part: 'pure', file: 'center_hub.js', from: "      const g = w.b && !linked.has(w.b) ? byId.get(w.b) || null : null;", to: "      const g = w.b ? byId.get(w.b) || null : null;", fails: 'M7a' },
  { id: 'NM6', part: 'pure', file: 'center_hub.js', from: "    const rest = [...byId.values()].filter((p) => !linked.has(p.id) && !named.has(p.id));", to: "    const rest = [...byId.values()].filter((p) => !linked.has(p.id) || p.name === 'RED');", fails: 'M7a' },
  { id: 'NM7', part: 'pure', file: 'center_hub.js', from: "choice: { options: ['PLAY ONLINE', 'STAY HERE'], cursor: 1 } }); return []; }", to: "choice: { options: ['PLAY ONLINE', 'STAY HERE'], cursor: 0 } }); return []; }", fails: 'M6d' },
  { id: 'NM8', part: 'pure', file: 'center_hub.js', from: "choice: { options: ['CANCEL'], cursor: 0 }, armTicks: DIALOG_ARM_TICKS });", to: "choice: { options: ['CANCEL'], cursor: 0 } });", fails: 'M8d' },
  { id: 'NM9', part: 'pure', file: 'center_hub.js', from: "    leave() { closeAll(); S.phase = 'closed';", to: "    leave() { S.phase = 'closed';", fails: 'M13a' },
  { id: 'NM10', part: 'pure', file: 'center_hub.js', from: "        list.sort((a, b) => a.py - b.py || (a.kind === 'me' ? 1 : b.kind === 'me' ? -1 : 0) || a.px - b.px);", to: "        list.sort((a, b) => b.py - a.py || a.px - b.px);", fails: 'M11c' },
  { id: 'NM11', part: 'pure', file: 'center_hub.js', from: "(code === null || code === undefined) && L.length ? L[hashOf(id) % L.length] : lookFor(code, L); };", to: "L.length ? L[hashOf(id) % L.length] : lookFor(code, L); };", fails: 'M7d' },
  { id: 'NM12', part: 'pure', file: 'center_hub.js', from: "    enter() { S.phase = 'wait';", to: "    enter() { S.phase = S.grid ? 'in' : 'wait';", fails: 'M1a' },
  { id: 'NM13', part: 'pure', file: 'center_hub.js', from: "      if (me.emote && ++me.emote.t >= WALK.emote) me.emote = null;\n", to: "", fails: 'M9n' },
  { id: 'NM14', part: 'pure', file: 'center_hub.js', from: "    else if (a.kind === 'thing') { if (S.grid.facing(me.x, me.y, me.d) === a.thing) fx.push(...use(a.thing)); }", to: "    else if (a.kind === 'thing') { /* nothing */ }", fails: 'M6l' },
  { id: 'NM15', part: 'pure', file: 'center_hub.js', from: "    if (me.bump <= 0) { me.bump = WALK.bump; fx.push(eff('sound', { what: 'bump' })); }", to: "    fx.push(eff('sound', { what: 'bump' }));", fails: 'M3b' },
  { id: 'NM16', part: 'pure', file: 'center_hub.js', from: "      if (!S.spotOf.has(p.id)) { const free = spots.findIndex((_s, i) => !used.has(i)); if (free >= 0) { S.spotOf.set(p.id, free); used.add(free); } }", to: "      if (!S.spotOf.has(p.id)) { const free = spots.findIndex((_s, i) => !used.has(i)); if (free >= 0) { S.spotOf.set(p.id, free); } }", fails: 'M7g' },
  { id: 'NM17', part: 'pure', file: 'center_hub.js', from: "    if (id === DLG.asking) { if (!S.asking) return []; S.asking = null; note(WORDS.cancelled); return [eff('cancel-ask')]; }", to: "    if (id === DLG.asking) { if (!S.asking) return []; S.asking = null; note(WORDS.cancelled); return []; }", fails: 'M8e' },
  { id: 'NS1', part: 'pure', file: 'center_screen.js', from: "    f.blit(h.SCREEN_W, h.SCREEN_H, pic.over, 0, 0);\n", to: "", fails: 'S2' },
  { id: 'NS2', part: 'pure', file: 'center_screen.js', from: "list.push({ x: p.px, y: p.py + CELL - s.height, w: s.width,", to: "list.push({ x: p.px, y: p.py, w: s.width,", fails: 'S3' },
  { id: 'NS3', part: 'pure', file: 'center_screen.js', from: "    list.sort((a, b) => a.feet - b.feet || a.order - b.order);", to: "    list.sort((a, b) => b.feet - a.feet || a.order - b.order);", fails: 'S4' },
  { id: 'NC1', part: 'ctl', file: 'center_ctl.js', from: "    const on = await svc.turnOn({ persist: false, also: WORDS.also });", to: "    startRoom(); const on = await svc.turnOn({ persist: false, also: WORDS.also });", fails: 'K1b' },
  { id: 'NC2', part: 'ctl', file: 'center_ctl.js', from: "    if (!on) { run(refused ? app.out() : app.kick('noStart')); return; }", to: "    if (!on) return;", fails: 'K1d' },
  { id: 'NC3', part: 'ctl', file: 'center_ctl.js', from: "    const on = await svc.turnOn({ persist: false, also: WORDS.also });", to: "    const on = await svc.turnOn({ persist: true, also: WORDS.also });", fails: 'K1e' },
  { id: 'NC4', part: 'ctl', file: 'center_ctl.js', from: "  function putBack() { if (mine && !svc.stored()) svc.turnOff({ persist: false }); mine = false; }", to: "  function putBack() { mine = false; }", fails: 'K2h' },
  { id: 'NC5', part: 'ctl', file: 'center_ctl.js', from: "      win.setTimeout(() => { if (inside && !leaving && !svc.isOn()) { stopRoom(); run(app.kick('off')); } }, 0);", to: "", fails: 'K5a' },
  { id: 'NC6', part: 'ctl', file: 'center_ctl.js', from: "    if (center) { safe(() => center.close()); center = null; }", to: "    center = null;", fails: 'K2h' },
  { id: 'NC7', part: 'ctl', file: 'center_ctl.js', from: "x: m.x, y: m.y, d: m.d, b: svc.boardId(), rec:", to: "x: m.x, y: m.y, d: m.d, b: null, rec:", fails: 'K2b' },
  { id: 'NC8', part: 'ctl', file: 'center_ctl.js', from: "{ saveLook(env.storage, eff.code); if (center) center.update(); safe(() => svc.relist()); }", to: "{ saveLook(env.storage, eff.code); }", fails: 'K2d' },
  { id: 'NC9', part: 'ctl', file: 'center_ctl.js', from: "    if (svc.goBattle('join', code)) return true;", to: "    if (svc.goBattle('join', code, { back: null })) return true;", fails: 'K4d' },
  { id: 'NC10', part: 'ctl', file: 'center_ctl.js', from: "    center = createCenter({ bus, me: meNow, rules });", to: "    center = createCenter({ bus, me: meNow });", fails: 'K2a' },
  { id: 'NC11', part: 'ctl', file: 'center_ctl.js', from: "    const mine0 = on && !wasOn;\n", to: "    const mine0 = false;\n", fails: 'K5d' },
  { id: 'NC17', part: 'ctl', file: 'center_ctl.js', from: "    if (g !== gen) { if (!centerOpen()) putBack(); return; }", to: "    if (g !== gen) { putBack(); return; }", fails: 'K5h' },
  { id: 'NC19', part: 'ctl', file: 'center_ctl.js', from: "    if (g !== gen) { if (!centerOpen()) putBack(); return; }", to: "    if (g !== gen) return;", fails: 'K5e' },
  { id: 'NC18', part: 'ctl', file: 'center_ctl.js', from: "  function putBack() { if (mine && !svc.stored()) svc.turnOff({ persist: false }); mine = false; }", to: "  function putBack() { if (mine) svc.turnOff({ persist: false }); mine = false; }", fails: 'K5j' },
  { id: 'NC12', part: 'ctl', file: 'center_ctl.js', from: "  const onHide = () => { leaving = true; stopRoom(); };", to: "  const onHide = () => { leaving = true; };", fails: 'K5f' },
  { id: 'NC13', part: 'ctl', file: 'center_ctl.js', from: "    leaving = true;                                                      // (the page is leaving", to: "    leaving = false;                                                     // (the page is leaving", fails: 'K4e' },
  { id: 'NC14', part: 'ctl', file: 'center_ctl.js', from: "  const seamName = local && query.get('ctrname') ?", to: "  const seamName = query.get('ctrname') ?", fails: 'K6f' },
  { id: 'NC15', part: 'ctl', file: 'center_ctl.js', from: "    if (byIndex) { safe(() => sys.director.playEffectIndex(s.index, 0)); return; }", to: "    if (sys) { safe(() => sys.director.playEffectIndex(s.index, 0)); return; }", fails: 'K6c' },
  { id: 'NC16', part: 'ctl', file: 'center_ctl.js', from: "    if (!look || !isLook(look, room.looks)) { look = pickLook(room.looks, env.freshSeed()); saveLook(env.storage, look); }", to: "    if (!look || !isLook(look, room.looks)) { look = pickLook(room.looks, env.freshSeed()); }", fails: 'K6e' },
  // ---- what is faced before a trainer underfoot; the Center's own question; making way; notices; guards a review's mutants walked through
  { id: 'NM18', part: 'pure', file: 'center_hub.js', from: "    const p = personAt(f.x, f.y);\n    if (p) return talk(p);\n    const kind = S.grid.facing(me.x, me.y, me.d);\n    if (kind) return use(kind);\n    const under = personAt(me.x, me.y);\n    return under ? talk(under) : [SILENT];", to: "    const p = personAt(f.x, f.y) || personAt(me.x, me.y);\n    if (p) return talk(p);\n    const kind = S.grid.facing(me.x, me.y, me.d);\n    return kind ? use(kind) : [SILENT];", fails: 'M11g' },
  { id: 'NM19', part: 'pure', file: 'center_hub.js', from: "[WORDS.enterAsk, '']], choice: { options: ['YES', 'NO'], cursor: 1 },", to: "[WORDS.enterAsk, '']], choice: { options: ['YES', 'NO'], cursor: 0 },", fails: 'M14c' },
  { id: 'NM20', part: 'pure', file: 'center_hub.js', from: "choice: { options: ['YES', 'NO'], cursor: 1 }, armTicks: DIALOG_ARM_TICKS });", to: "choice: { options: ['YES', 'NO'], cursor: 1 } });", fails: 'M14b' },
  { id: 'NM21', part: 'pure', file: 'center_hub.js', from: "return value === 0 || S.phase !== 'wait' ? [] : ctx.back(); }", to: "return []; }", fails: 'M14d' },
  { id: 'NM22', part: 'pure', file: 'center_hub.js', from: "      for (const id of [DLG.note, DLG.sign, DLG.nurse, DLG.talk]) ctx.dialog.close(id);\n      S.talk = null;", to: "      for (const id of [DLG.sign, DLG.nurse, DLG.talk]) ctx.dialog.close(id);\n      S.talk = null;", fails: 'M14h' },
  { id: 'NM23', part: 'pure', file: 'center_hub.js', from: "choice: null, ...(stay ? {} : { ticksLeft: NOTE_TICKS * pages.length }) }); };", to: "choice: null }); };", fails: 'M14k' },
  { id: 'NM24', part: 'pure', file: 'center_hub.js', from: "if (S.entering && S.phase === 'wait') S.entering = !!openEnter(); return S.entering || S.phase !== 'wait'; },", to: "return true; },", fails: 'M14j' },
  { id: 'NM25', part: 'pure', file: 'center_hub.js', from: "if (!a) return null; S.asking = null; ctx.dialog.close(DLG.asking); if (say) note(WORDS.withdrawn(a.name)); return a.name; },", to: "if (!a) return null; S.asking = null; if (say) note(WORDS.withdrawn(a.name)); return a.name; },", fails: 'M14i' },
  { id: 'NM26', part: 'pure', file: 'center_hub.js', from: "    if (me.mv) return [SILENT];\n    const f = ahead(me.x, me.y, me.d);", to: "    const f = ahead(me.x, me.y, me.d);", fails: 'M14m' },
  { id: 'NM27', part: 'pure', file: 'center_hub.js', from: "    kick(why) { if (S.phase === 'closed') return []; ctx.notify(", to: "    kick(why) { ctx.notify(", fails: 'M14n' },
  { id: 'NM28', part: 'pure', file: 'center_hub.js', from: "      if (!S.grid || S.phase === 'closed') return false;", to: "      if (!S.grid) return false;", fails: 'M14n' },
  { id: 'NM29', part: 'pure', file: 'center_hub.js', from: "if (p && inPicture(p) && Math.abs(p.x - me.x) + Math.abs(p.y - me.y) <= 1) fx.push(...talk(p)); }", to: "if (p) fx.push(...talk(p)); }", fails: 'M14o' },
  { id: 'NM30', part: 'pure', file: 'center_hub.js', from: "if ('look' in o && (o.look === null || lookId(o.look) !== null)) me.look = o.look; },", to: "if ('look' in o) me.look = o.look; },", fails: 'M14p' },
  { id: 'NM31', part: 'pure', file: 'center_hub.js', from: "          if (repeat) return [SILENT];\n          S.lastDir = action; S.walk = null;", to: "          S.lastDir = action; S.walk = null;", fails: 'M14q' },
  { id: 'NM32', part: 'pure', file: 'center_hub.js', from: "  function openMenu() { S.mode = 'menu'; S.walk = null; menu.setCursor(0);", to: "  function openMenu() { S.mode = 'menu'; menu.setCursor(0);", fails: 'M14r' },
  { id: 'NM33', part: 'pure', file: 'center_hub.js', from: "        if (value !== 0 || !t) return [];", to: "        if (!t) return [];", fails: 'M8b' },
  { id: 'NM34', part: 'pure', file: 'center_hub.js', from: "pages: [[who, where], ...pagesOf(join ? WORDS.joinDoes(fmtText(g.fmt)) : WORDS.askDoes)],", to: "pages: [[who, where]],", fails: 'M8a' },
  // ---- the name plates
  { id: 'NS4', part: 'pure', file: 'center_screen.js', from: "    return layoutTags(raw, h.SCREEN_W).map((t) =>", to: "    return raw.map((t) => ({ ...t, shown: true })).map((t) =>", fails: 'S5b' },
  { id: 'NS5', part: 'pure', file: 'center_screen.js', from: "{ const hold = Math.min(TAG.hold, t.w); lo.push(", to: "{ const hold = -200; lo.push(", fails: 'S5d' },
  { id: 'NS6', part: 'pure', file: 'center_screen.js', from: "    if (y + hh > CGEOM.hint.y && cx + CELL / 2 - Math.min(TAG.hold, w) + w > CGEOM.hint.x) y = CGEOM.hint.y - hh;\n", to: "", fails: 'S5f' },
  { id: 'NS7', part: 'pure', file: 'center_screen.js', from: "      ui.panel(f, t.x, t.y, t.w, t.h, t.mine ? 'sel' : 'normal', true);", to: "      f.rect(t.x, t.y, t.w, t.h, t.mine ? TEXT.dark : TEXT.white);", fails: 'S5g' },
  { id: 'NS8', part: 'pure', file: 'center_screen.js', from: "      ui.panel(f, t.x, t.y, t.w, t.h, t.mine ? 'sel' : 'normal', true);", to: "      ui.panel(f, t.x, t.y, t.w, t.h, 'normal', true);", fails: 'S5g' },
  { id: 'NS9', part: 'pure', file: 'center_screen.js', from: "if (live[i].pri > worst.pri) worst = live[i];", to: "if (live[i].pri < worst.pri) worst = live[i];", fails: 'S5d' },
  // ---- the room's two caps, and what a here carries
  { id: 'NN16', part: 'pure', file: 'center_net.js', from: "    if (++p.n > timing.perSenderMax) return;\n    if (++winCount > timing.totalMax) return;\n", to: "    if (++winCount > timing.totalMax) return;\n    if (++p.n > timing.perSenderMax) return;\n", fails: 'N7l' },
  { id: 'NN17', part: 'pure', file: 'center_net.js', from: "    if (++winCount > timing.totalMax) return;\n", to: "", fails: 'N7m' },
  { id: 'NN18', part: 'pure', file: 'center_net.js', from: "    if (m.rec) o.rec = m.rec;\n    return o;", to: "    if (m.rec) o.rec = m.rec;\n    if (m.team) o.team = m.team;\n    return o;", fails: 'N7a2' },
  { id: 'NC38', part: 'ctl', file: 'center_net.js', from: "    if (m.rec) o.rec = m.rec;\n    return o;", to: "    if (m.rec) o.rec = m.rec;\n    o.team = 'SECRET';\n    return o;", fails: 'K1g' },
  // ---- nothing is published before the player has said YES to what the CENTER lists
  { id: 'NC20', part: 'ctl', file: 'center_ctl.js', from: "    if (!generic && asksFirst && !told()) {", to: "    if (false) {", fails: 'K7a' },
  { id: 'NC21', part: 'ctl', file: 'center_ctl.js', from: "      const yes = await askIn();\n", to: "      svc.turnOn({ persist: false }); const yes = await askIn();\n", fails: 'K7b' },
  { id: 'NC22', part: 'ctl', file: 'center_ctl.js', from: "      const yes = await askIn();\n", to: "      const yes = await askIn(); markTold();\n", fails: 'K7d' },
  { id: 'NC23', part: 'ctl', file: 'center_ctl.js', from: "      markTold();\n    }\n", to: "    }\n", fails: 'K7f' },
  { id: 'NC24', part: 'ctl', file: 'center_ctl.js', from: "    if (!generic && asksFirst && !told()) {", to: "    if (!generic && asksFirst && !told() && !wasOn) {", fails: 'K7g' },
  { id: 'NC25', part: 'ctl', file: 'center_ctl.js', from: "    if (generic) markTold();", to: "    if (generic && false) markTold();", fails: 'K1h' },
  { id: 'NC26', part: 'ctl', file: 'center_ctl.js', from: "    await svc.ready;\n    if (g !== gen) return;\n", to: "    await svc.ready;\n", fails: 'K7j' },
  { id: 'NC40', part: 'ctl', file: 'center_ctl.js', from: "(safe(() => svc.stored(), false) ? WORDS.sharesStay : WORDS.sharesEnd)", to: "WORDS.sharesEnd", fails: 'K7h' },
  { id: 'NC41', part: 'ctl', file: 'center_ctl.js', from: "safe(() => !!env.storage && env.storage.getItem(CENTER_SEEN_KEY) === '1', false);", to: "safe(() => !env.storage || env.storage.getItem(CENTER_SEEN_KEY) === '1', false);", fails: 'K7k' },
  // ---- somebody asks: the Center's dialogs make way; one question at a time; two who ask each other
  { id: 'NC27', part: 'ctl', file: 'center_ctl.js', from: "    app.makeWay();\n", to: "", fails: 'K8a' },
  { id: 'NC28', part: 'ctl', file: 'center_ctl.js', from: "      const waits = mutual && String(svc.boardId()) > String(p.s);", to: "      const waits = mutual;", fails: 'K8d' },
  { id: 'NC29', part: 'ctl', file: 'center_ctl.js', from: "      const waits = mutual && String(svc.boardId()) > String(p.s);", to: "      const waits = false;", fails: 'K8d' },
  { id: 'NC30', part: 'ctl', file: 'center_ctl.js', from: "      if (!waits) { dropChal(); app.askWithdrawn(!mutual); }", to: "      if (!waits && mutual) { dropChal(); app.askWithdrawn(!mutual); }", fails: 'K8b' },
  { id: 'NC31', part: 'ctl', file: 'center_ctl.js', from: "      if (!waits) { dropChal(); app.askWithdrawn(!mutual); }", to: "      if (!waits) { chal = null; chalTo = null; app.askWithdrawn(!mutual); }", fails: 'K8b' },
  { id: 'NC42', part: 'ctl', file: 'center_ctl.js', from: "    if (chal && chalOk) { safe(() => svc.mount.decline()); return; }\n", to: "", fails: 'K8g' },
  { id: 'NC39', part: 'ctl', file: 'center_ctl.js', from: "    if (!p) { if (asked !== null) { asked = null; if (app.resume() === false) { settleEntry(false); run(app.out()); } redraw(); } return; }", to: "    if (!p) { asked = null; return; }", fails: 'K8f' },
  // ---- CANCEL and leaving withdraw a challenge
  { id: 'NC32', part: 'ctl', file: 'center_ctl.js', from: "      else if (eff.type === 'cancel-ask') dropChal();", to: "      else if (eff.type === 'cancel-ask') { chal = null; chalTo = null; }", fails: 'K9a' },
  { id: 'NC33', part: 'ctl', file: 'center_ctl.js', from: "    dropChal();                                                          // a challenge in flight is withdrawn: nobody may say YES to a player who has left\n", to: "", fails: 'K9b' },
  // ---- the rest of the ctl
  { id: 'NC34', part: 'ctl', file: 'center_ctl.js', from: "  const onShow = (e) => { if (e && e.persisted && safe(() => env.model.path(), '') === 'center') enter(); };", to: "  const onShow = () => {};", fails: 'K5l' },
  { id: 'NC35', part: 'ctl', file: 'center_ctl.js', from: "    safe(() => svc.watchPlayers(false));\n", to: "", fails: 'K5m' },
  { id: 'NC36', part: 'ctl', file: 'center_ctl.js', from: "    if (!app.keepsPlace()) return;\n", to: "    return;\n", fails: 'K6i' },
  { id: 'NC37', part: 'ctl', file: 'center_ctl.js', from: "brokers: brokersFor(win), topic: CENTER_TOPIC,", to: "brokers: brokersFor(win), topic: 'bemental/arena/open/1',", fails: 'K10b' },
];
async function runNodeMutants() {
  let killed = 0, ran = 0;
  for (const m of NODE_MUTANTS) {
    if (ONE && ONE !== m.id) continue;
    ran++;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctr-mut-'));
    for (const f of fs.readdirSync(SRC)) if (f.endsWith('.js')) fs.copyFileSync(path.join(SRC, f), path.join(dir, f));
    const fp = path.join(dir, m.file);
    const body = fs.readFileSync(fp, 'utf8').replace(/\r\n/g, '\n');
    const n = body.split(m.from).length - 1;
    if (n !== 1) { console.log('MUTANT', m.id, 'snippet occurs', n, 'times in', m.file); fs.rmSync(dir, { recursive: true, force: true }); continue; }
    fs.writeFileSync(fp, body.replace(m.from, () => m.to));
    // (in a process of its own: a defect that leaves a page in the room, saying "here" for ever, must not be heard by the next mutant's pages)
    let failed = [];
    const blockOf = m.part === 'ctl' ? (m.fails.match(/^K\d+/) || [''])[0] : '';
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '__child', dir, m.part, blockOf], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 180000, windowsHide: true });
    const line = String(r.stdout || '').split('\n').find((l) => l.startsWith('CHILD_FAILED '));
    try { failed = line ? JSON.parse(line.slice('CHILD_FAILED '.length)) : ['threw: the run did not finish (' + String(r.stderr || r.error || '').slice(0, 200) + ')']; } catch (_e) { failed = ['threw: unreadable result']; }
    const hit = failed.some((f) => f.startsWith(m.fails));
    if (hit) killed++; else console.log('MUTANT SURVIVED', m.id, m.file, '(expected', m.fails, 'to fail; failed:', J(failed.map((f) => f.split(' ')[0])) + ')');
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('node mutants killed', killed + '/' + ran);
  return killed === ran;
}

/* ================================================================================================ browser sessions */
let pass = 0, fail = 0;
const failures = [];
function okB(cond, name, detail) { if (cond) { pass++; if (process.env.CENTER_VERBOSE) console.log('ok  ', name); } else { fail++; failures.push(name); console.log('FAIL', name, detail === undefined ? '' : String(detail).slice(0, 500)); } }
const NO_THROTTLE = ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-features=BackForwardCache,IntensiveWakeUpThrottling'];

let server = null;
async function startServer(port) {
  const probe = async () => { try { return (await fetch(`http://localhost:${port}/pokemonarena/center.html`)).ok; } catch (_e) { return false; } };
  if (await probe()) throw new Error('port ' + port + ' already serves something (a stale dev server would test an old tree): free it, or set ARENA_PORT');
  server = spawn(process.execPath, [path.join(root, 'tools', 'devserver.mjs')], { env: { ...process.env, PORT: String(port), WEB_ROOT: root }, cwd: root, stdio: 'ignore', windowsHide: true });
  for (let i = 0; i < 80 && !(await probe()); i++) await sleep(250);
  if (!(await probe())) throw new Error('the dev server did not come up on ' + port);
}
// The overlay server for the browser mutants: everything is the dev server's, except the files a mutant changes.
function overlay(port, upstream, files) {
  const srv = http.createServer(async (req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (files[p] !== undefined) { res.writeHead(200, { 'content-type': (p.endsWith('.html') ? 'text/html' : 'text/javascript') + '; charset=utf-8', 'cache-control': 'no-store' }); res.end(files[p]); return; }
    try {
      const headers = {}; if (req.headers.range) headers.range = req.headers.range;
      const r = await fetch(`http://localhost:${upstream}${req.url}`, { headers });
      const h = {}; r.headers.forEach((v, k) => { if (!/^(content-encoding|transfer-encoding|connection)$/.test(k)) h[k] = v; });
      res.writeHead(r.status, h); res.end(Buffer.from(await r.arrayBuffer()));
    } catch (e) { res.writeHead(502); res.end(String(e)); }
  });
  return new Promise((r) => srv.listen(port, () => r(srv)));
}

async function browserCases(origin, cdp, only) {
  const { withBrowser } = await import('./headless_cdp.mjs');
  const L = await import('./pokemonarena_hub_lib.mjs');
  const imp = (f) => import(pathToFileURL(path.join(SRC, f)).href);
  const [K, CW, R] = await Promise.all(['center_look.js', 'center_world.js', 'center_room.js'].map(imp));
  const { room } = CW.centerWorld(romBytes);
  const lk = (i) => K.lookCode(room.looks[i]);
  const CELL = R.CELL;
  // a case runs when it is the one asked for, or the group it belongs to is (want('CB2') for 'CB2c'), or it is inside a group asked for (want('CB2c') for 'CB2')
  const grp = (s) => (String(s).match(/^CB\d+/) || [''])[0];          // (CB1 is not CB10: a filter that matched by prefix alone would never judge a page mutant by its own case)
  const want = (id) => !only || !only.length || only.some((x) => grp(x) === grp(id) && (id.startsWith(x) || x.startsWith(id)));
  const ok = (cond, name, detail) => { if (want(name.split(' ')[0])) okB(cond, name, detail); };
  const H = 'window.__arenaHub';
  const HUB = (name, look, extra = '') => `${origin}/pokemonarena/?net=local&anim=0&ctrname=${name}&ctrav=${look}${extra}#center`;
  const ready = `(${H} && ${H}.state === "ready")`;
  const inside = `(${ready} && !!${H}.center && ${H}.center.state().inside && ${H}.apps.state().center.phase === "in")`;
  const st = (p) => p.eval(`${H}.apps.state().center`);
  const people = (p) => p.eval(`${H}.center.people()`);
  const me = (p) => p.eval(`${H}.center.me()`);
  const dlg = (p) => p.eval(`(() => { const d = ${H}.view().dialog; return d ? { id: d.id, lines: d.lines, more: d.more, armed: d.armed, choice: d.choice ? { options: d.choice.options, cursor: d.choice.cursor } : null } : null; })()`);
  const press = (p, a) => p.eval(`${H}.press(${J(a)})`);
  const tick = (p, n, held) => p.eval(`${H}.tick(${n}, ${J(held || [])})`);
  const front = (p) => p.send('Page.bringToFront').catch(() => {});
  const shot = async (p, n) => { try { await p.screenshot(path.join(OUT, n + '.png')); } catch (_e) { /* evidence, not the test */ } };
  const walkIn = async (p) => { await p.waitFor(inside, { timeoutMs: 90000 }); };
  const sees = (p, name, ms = 15000) => p.waitFor(`${H}.center.people().some((q) => q.name === ${J(name)})`, { timeoutMs: ms }).then(() => true, () => false);
  const until = async (fn, ms = 15000) => { const t0 = Date.now(); for (;;) { let v = null; try { v = await fn(); } catch (_e) { v = null; } if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(150); } };
  const lastPage = async (p) => { for (let i = 0; i < 20; i++) { const d = await dlg(p); if (!d || !d.more) return d; await press(p, 'a'); } return dlg(p); };
  const canvas = 'document.getElementById("hub")';
  const errs = (p) => L.errsOf(p).filter((e) => !/favicon/.test(e));

  /* ---- CB0 - CB6, CB8 - CB10: the room on three tabs ---- */
  const room1 = ['CB0', 'CB1', 'CB2', 'CB3', 'CB4', 'CB5', 'CB6', 'CB8', 'CB9', 'CB10'].some(want);
  if (room1) await withBrowser({ port: cdp, width: 1000, height: 900, lock: false, args: NO_THROTTLE }, async (a) => {
    // a spy on the room's channel and on the board: what goes out, and when
    const spy = await a.openTab({ width: 600, height: 400 });
    await spy.navigate(origin + '/pokemonarena/text_manifest.json');          // any page of the site's origin will do
    await spy.eval('window.__room = []; window.__ch = new BroadcastChannel("bemental-arena-center-2"); window.__ch.onmessage = (e) => window.__room.push(e.data); window.__board = []; window.__bc = new BroadcastChannel("bemental-arena-open-1"); window.__bc.onmessage = (e) => window.__board.push(e.data); true');
    // CB0: the old address forwards into the picture, with the test seams and nothing else
    await a.navigate(`${origin}/pokemonarena/center.html?net=local&anim=0&opendisc=1&ctrname=Alice&ctrav=${lk(6)}&np=ABCDE&join=1`);
    await a.waitFor('location.pathname === "/pokemonarena/" && location.hash === "#center"', { timeoutMs: 20000 }).catch(() => {});
    const loc = await a.eval('({ path: location.pathname, hash: location.hash, search: location.search })');
    const q0 = new URLSearchParams(loc.search);
    ok(loc.path === '/pokemonarena/' && loc.hash === '#center' && q0.get('net') === 'local' && q0.get('opendisc') === '1' && q0.get('ctrname') === 'Alice' && q0.get('ctrav') === lk(6) && q0.get('np') === null && q0.get('join') === null,
      'CB0a center.html forwards to the Trainer Center in the Arena picture, carrying the test seams (net=local stays net=local) and nothing else of the address', J(loc));
    // CB1: the disclosure, then walking in
    await a.waitFor(`${ready} && !!${H}.view().dialog && ${H}.view().dialog.id === "presence:disclosure"`, { timeoutMs: 90000 }).catch(() => {});
    await sleep(1200);
    const pre = { d: await dlg(a), st: await st(a), n: await spy.eval('window.__room.length + window.__board.length'), drawn: (await a.eval(`${H}.view().center.people.length`)) };
    ok(pre.d && pre.d.id === 'presence:disclosure' && pre.st.phase === 'wait' && pre.drawn === 0, 'CB1a opening the Center the first time asks in the picture what being open publishes, before the player walks in', J(pre));
    ok(pre.n === 0, 'CB1b nothing at all is published before YES', pre.n);
    await shot(a, 'cb1_disclosure');
    await front(a);
    await L.key(a, 'b');                                                                              // B is NO, from any page
    await a.waitFor('location.hash !== "#center"', { timeoutMs: 10000 }).catch(() => {});
    await sleep(500);
    const no = { hash: await a.eval('location.hash'), trail: await a.eval(`${H}.trail()`), n: await spy.eval('window.__room.length + window.__board.length'), seen: await a.eval('localStorage.getItem("arena.open.seen")'), d: await dlg(a) };
    ok(no.hash === '#online' && no.trail.join() === 'online' && no.n === 0 && no.seen === null && !no.d, 'CB1c NO leaves the Center (back to PLAY ONLINE): nothing was published, nothing is remembered', J(no));
    await a.eval(`${H}.goto("center")`);
    await a.waitFor(`!!${H}.view().dialog && ${H}.view().dialog.id === "presence:disclosure"`, { timeoutMs: 15000 }).catch(() => {});
    await lastPage(a); await press(a, 'up'); await press(a, 'a');
    await walkIn(a).catch(() => {});
    const heard = await until(() => spy.eval('window.__room.some((m) => m.k === "here" && m.name === "Alice") && window.__board.some((m) => m.k === "open")'), 8000);
    ok((await st(a)).phase === 'in' && !!heard && (await a.eval('localStorage.getItem("arena.open")')) === null, 'CB1d YES walks in: the room and the board hear it, and the stored switch stays off (open for this page only)', J(await st(a)));

    // CB2: two players see each other
    const b = await a.openTab({ width: 1000, height: 900 });
    await b.navigate(HUB('Bob', lk(7)));
    await walkIn(b).catch(() => {});
    const s1 = await sees(a, 'Bob'), s2 = await sees(b, 'Alice');
    await until(async () => (await people(a)).some((p) => p.name === 'Bob' && p.doing === 'here') && (await people(b)).some((p) => p.name === 'Alice' && p.doing === 'here'), 20000);
    const pa = (await people(a)).find((p) => p.name === 'Bob'), pb = (await people(b)).find((p) => p.name === 'Alice'), ma = await me(a), mb = await me(b);
    ok(s1 && s2 && pa && pb && pa.x === mb.x && pa.y === mb.y && pb.x === ma.x && pb.y === ma.y && pa.gfx === room.looks[7] && pb.gfx === room.looks[6], 'CB2a two players who walked in see each other on the same cells, each as the ROM sprite the other chose', J([pa, pb, ma, mb]));
    ok(pa && pb && pa.doing === 'here' && pb.doing === 'here', 'CB2b each is linked to their own listing on the board (they can be asked)', J([pa && pa.doing, pb && pb.doing]));
    ok(await a.eval(`!${H}.renderError && !${H}.loopError && (${H}.appFaults || []).length === 0`), 'CB2c the picture drew without a fault', await a.eval(`JSON.stringify([${H}.renderError, ${H}.loopError, ${H}.appFaults])`));

    // CB3: walking by key and by tap is seen by the other
    await front(a);
    const x0 = (await me(a)).x;
    await a.key('keyDown', 'ArrowLeft', 'ArrowLeft', { windowsVirtualKeyCode: 37 }); await sleep(900); await a.key('keyUp', 'ArrowLeft', 'ArrowLeft', { windowsVirtualKeyCode: 37 });
    await a.waitFor(`!${H}.apps.state().center.moving`, { timeoutMs: 5000 }).catch(() => {});
    const m1 = await me(a);
    const seen1 = await until(async () => { const p = (await people(b)).find((q) => q.name === 'Alice'); return p && p.x === m1.x && p.y === m1.y && p.d === 'left'; }, 5000);
    ok(m1.x < x0 && m1.d === 'left' && !!seen1, 'CB3a holding a real arrow key walks cell by cell, and the other sees the same cells', J([x0, m1, (await people(b)).find((q) => q.name === 'Alice')]));
    await L.key(a, 'up', 40); await sleep(300);
    const m2 = await me(a);
    ok(m2.d === 'up' && m2.x === m1.x && m2.y === m1.y, 'CB3b a tap of a key only turns', J(m2));
    await L.clickLogical(a, canvas, 2 * CELL + 8, 5 * CELL + 8);
    await a.waitFor(`(() => { const s = ${H}.apps.state().center; return s.x === 2 && s.y === 5 && !s.moving; })()`, { timeoutMs: 12000 }).catch(() => {});
    const m3 = await me(a);
    const seen3 = await until(async () => { const p = (await people(b)).find((q) => q.name === 'Alice'); return p && p.x === 2 && p.y === 5; }, 5000);
    ok(m3.x === 2 && m3.y === 5 && !!seen3, 'CB3c a click on a floor cell walks there, and the other sees it', J(m3));

    // CB4: a new look and an emote are seen at once
    await L.key(a, 'b'); await sleep(150);
    const menu = (await st(a)).mode;
    await L.key(a, 'a'); await sleep(150); await L.key(a, 'right'); await sleep(120); await L.key(a, 'right'); await sleep(120);
    await shot(a, 'cb4_look');
    await L.key(a, 'a'); await sleep(300);
    const look = (await st(a)).look;
    const seenLook = await until(async () => { const p = (await people(b)).find((q) => q.name === 'Alice'); return p && p.gfx === K.lookId(look); }, 2500);
    ok(menu === 'menu' && look === lk(8) && !!seenLook && (await a.eval('localStorage.getItem("arena.avatar")')) === look, 'CB4a B opens the menu, LOOK picks one of the ROM trainer sprites with real keys: it is stored and the other sees it at once', J([menu, look]));
    await press(a, 'b'); await press(a, 'down'); await press(a, 'a'); await press(a, 'right'); await press(a, 'right'); await press(a, 'a');
    const seenEmote = await until(async () => { const p = (await people(b)).find((q) => q.name === 'Alice'); return p && p.emote === 2; }, 2500);
    ok(!!seenEmote && (await st(a)).emote === 2, 'CB4b an emote is over the player and seen by the other at once', J([await st(a)]));
    await shot(a, 'cb4_emote');
    const gone = await until(async () => { const p = (await people(b)).find((q) => q.name === 'Alice'); return p && p.emote === null; }, 5000);
    ok(!!gone, 'CB4c ... and goes after about two seconds', '');

    // CB5: a player who is open from the hub's menu stands at a spot
    const c = await a.openTab({ width: 1000, height: 900 });
    await c.navigate(`${origin}/pokemonarena/?net=local&anim=0`);
    await c.waitFor(`${ready} && !!${H}.presence`, { timeoutMs: 90000 }).catch(() => {});
    await c.eval(`${H}.presence.turnOn({ persist: false })`);
    const spot = await until(async () => (await people(a)).find((p) => p.kind === 'spot'), 15000), spotB = await until(async () => (await people(b)).find((p) => p.kind === 'spot'), 15000);
    ok(spot && spotB && spot.x === room.spots[0].x && spot.y === room.spots[0].y && spot.d === room.spots[0].d && spot.doing === 'menu' && spot.emote === R.STATUS_EMOTE.menu && spotB.x === spot.x,
      'CB5a a player who is open from the hub menu (not in the Center) stands at the first spot in both pictures, with the icon that says so', J([spot, spotB]));
    await front(a); await sleep(400);
    await shot(a, 'cb5_room_three');

    // CB6: a challenge declined
    const bob = (await people(a)).find((p) => p.name === 'Bob');
    await L.clickLogical(a, canvas, bob.x * CELL + 8, bob.y * CELL + 2);
    await a.waitFor(`!!${H}.view().dialog && ${H}.view().dialog.id === "center:talk"`, { timeoutMs: 15000 }).catch(() => {});
    const talk0 = await dlg(a), near = await me(a);
    await L.key(a, 'a'); await sleep(200);                                                           // (its second page: what asking does, with the options)
    const talk = await dlg(a);
    ok(talk0 && talk0.id === 'center:talk' && /^Bob/.test(talk0.lines[0]) && talk && talk.id === 'center:talk' && /3 v 3 battle/.test(talk.lines.join(' ')) && talk.choice && talk.choice.options.join() === 'ASK TO BATTLE,CANCEL' && Math.abs(near.x - bob.x) + Math.abs(near.y - bob.y) === 1, 'CB6a a click on a trainer walks up to them and asks: who they are, what asking does, ASK TO BATTLE / CANCEL', J([talk0, talk, near]));
    await shot(a, 'cb6_talk');
    await L.key(a, 'a');
    await a.waitFor(`!!${H}.view().dialog && ${H}.view().dialog.id === "center:asking"`, { timeoutMs: 5000 }).catch(() => {});
    const asking = await dlg(a);
    await b.waitFor(`!!${H}.view().dialog && ${H}.view().dialog.id === "presence:challenge"`, { timeoutMs: 20000 }).catch(() => {});
    const asked = await dlg(b);
    ok(asking && /Asked Bob to battle/.test(asking.lines[0]) && asked && /wants to battle you/.test(asked.lines[1]), 'CB6b "Asked Bob to battle. Waiting for an answer..." on one screen, "... wants to battle you." in the picture of the other', J([asking, asked]));
    await front(b); await sleep(900);
    await shot(b, 'cb6_question');
    await L.key(b, 'b');                                                                              // NO
    await a.waitFor(`!!${H}.view().dialog && ${H}.view().dialog.id === "center:note"`, { timeoutMs: 15000 }).catch(() => {});
    const said = await dlg(a);
    ok(said && said.lines.join(' ').trim() === 'Bob said not now.' && (await a.eval('location.pathname')) === '/pokemonarena/' && (await b.eval('location.pathname')) === '/pokemonarena/', 'CB6c declined: "Bob said not now.", and both stay in the Center', J(said));
    await press(a, 'a');

    // CB9: the PC opens the Team Builder and B returns
    await front(a);
    await L.clickLogical(a, canvas, room.pc[0].x * CELL + 8, room.pc[0].y * CELL + 8);
    await a.waitFor('location.hash === "#builder"', { timeoutMs: 15000 }).catch(() => {});
    const inB = { hash: await a.eval('location.hash'), trail: await a.eval(`${H}.trail()`) };
    const leftRoom = await until(async () => !(await people(b)).some((p) => p.name === 'Alice' && p.kind === 'walker'), 4000);
    ok(inB.hash === '#builder' && inB.trail.join() === 'online,center,builder' && !!leftRoom, 'CB9a a click on the PC walks up to it and opens the Team Builder on top of the Center (the room stops showing the player meanwhile)', J(inB));
    await L.key(a, 'b');
    await a.waitFor(`location.hash === "#center" && ${inside}`, { timeoutMs: 20000 }).catch(() => {});
    const backAt = await me(a);
    ok((await a.eval('location.hash')) === '#center' && backAt.x === room.pc[0].use.x && backAt.y === room.pc[0].use.y && backAt.d === 'up' && (await sees(b, 'Alice', 8000)), 'CB9b B in the Team Builder comes back into the Center, at the PC, and the others see the player again', J(backAt));

    // CB8: the door mat leaves
    await front(b);
    await L.clickLogical(b, canvas, room.door.x * CELL + 8, room.door.y * CELL + 8);
    await b.waitFor('location.hash === "#online"', { timeoutMs: 15000 }).catch(() => {});
    const out = { hash: await b.eval('location.hash'), on: await b.eval(`${H}.presence.isOn()`), stored: await b.eval('localStorage.getItem("arena.open")') };
    const dropped = await until(async () => !(await people(a)).some((p) => p.name === 'Bob'), 4000);
    ok(out.hash === '#online' && out.on === false && out.stored === null && !!dropped, 'CB8a walking onto the door mat and off it leaves the Center: back to where the player came from, no longer open, and gone from the room of the others', J(out));

    // CB10: Open to battles switched off elsewhere walks the player out
    await c.eval('localStorage.setItem("arena.open", "1"); localStorage.removeItem("arena.open"); true');
    await a.waitFor('location.hash !== "#center"', { timeoutMs: 10000 }).catch(() => {});
    await sleep(400);
    const kicked = { hash: await a.eval('location.hash'), d: await dlg(a), inside: await a.eval(`${H}.center.state().inside`) };
    ok(kicked.hash === '#online' && kicked.d && /OPEN TO BATTLES was switched off/.test(kicked.d.lines.join(' ')) && kicked.inside === false, 'CB10a Open to battles switched off in another tab walks the player out, with a line saying why', J(kicked));
    await shot(a, 'cb10_walked_out');
    ok(!errs(a).length && !errs(b).length && !errs(c).length, 'CB10b no page errors in the three tabs', J(errs(a).concat(errs(b), errs(c))).slice(0, 400));
  });

  /* ---- CB7, CB11: a challenge accepted becomes a battle on both screens; a hidden tab still answers ---- */
  if (want('CB7') || want('CB11')) await withBrowser({ port: cdp + 1, width: 1000, height: 900, lock: false, args: NO_THROTTLE }, async (a) => {
    const phase = (p) => p.eval('(window.__arenaOnline && window.__arenaOnline.nm() ? window.__arenaOnline.nm().status().phase : null)').catch(() => null);
    // an address alone does not join: meet=1 with no token from this tab is the ordinary invite page
    await a.navigate(`${origin}/pokemonarena/battle.html?np=NOBODY&join=1&meet=1&net=local&anim=0`);
    await a.waitFor('window.__arenaOnline && window.__arenaOnline.state', { timeoutMs: 90000 }).catch(() => {});
    await sleep(1500);
    const alone = await a.eval('({ stage: window.__arenaOnline.state.stage, phase: (window.__arenaOnline.nm && window.__arenaOnline.nm()) ? window.__arenaOnline.nm().status().phase : null })').catch((e) => ({ err: String(e) }));
    ok(alone.stage === 'setup' && alone.phase === null, 'CB7a a join address with meet=1 but no token from the Center joins nothing by itself', J(alone));
    await a.navigate(HUB('Alice', lk(6)));
    await walkIn(a).catch(() => {});
    const b = await a.openTab({ width: 1000, height: 900 });
    await b.navigate(HUB('Bob', lk(7)));
    await walkIn(b).catch(() => {});
    await until(async () => (await people(b)).some((p) => p.name === 'Alice' && p.doing === 'here'), 30000);
    // CB11: Alice's tab is in the background and its picture's clock is stopped: it still answers the room and the board
    await front(b);
    await a.eval(`${H}.pause(true)`);
    const hidden = await a.eval('document.hidden');
    const t0 = Date.now();
    const alice = (await people(b)).find((p) => p.name === 'Alice');
    await L.clickLogical(b, canvas, alice.x * CELL + 8, alice.y * CELL + 2);
    await b.waitFor(`!!${H}.view().dialog && ${H}.view().dialog.id === "center:talk"`, { timeoutMs: 15000 }).catch(() => {});
    await lastPage(b);
    await L.key(b, 'a');
    const got = await until(() => a.eval(`${H}.presence.state().challenge`), 20000);
    await sleep(Math.max(0, 4000 - (Date.now() - t0)));
    const still = (await people(b)).some((p) => p.name === 'Alice' && p.kind === 'walker');
    ok(!!got && still, 'CB11a a tab in the background whose picture does not run (document.hidden: ' + hidden + ') still holds its place in the room and receives the question', J([got, still]));
    await front(a); await a.eval(`${H}.pause(false)`);
    await a.waitFor(`!!${H}.view().dialog && ${H}.view().dialog.id === "presence:challenge" && ${H}.view().dialog.armed`, { timeoutMs: 15000 }).catch(() => {});
    await shot(a, 'cb7_question');
    await lastPage(a); await press(a, 'up');
    await L.key(a, 'a');                                                                              // YES, with a real key
    await a.waitFor('location.pathname === "/pokemonarena/battle.html"', { timeoutMs: 30000 }).catch(() => {});
    await b.waitFor('location.pathname === "/pokemonarena/battle.html"', { timeoutMs: 30000 }).catch(() => {});
    const bu = new URL(await b.eval('location.href')), au = new URL(await a.eval('location.href'));
    let p1 = null, p2 = null;
    for (let i = 0; i < 480; i++) { p1 = await phase(a); p2 = await phase(b); if (p1 === 'playing' && p2 === 'playing') break; await sleep(250); }
    ok(au.searchParams.get('net') === 'local' && bu.searchParams.get('net') === 'local' && bu.pathname === '/pokemonarena/battle.html', 'CB7b YES in the Center: both leave for the battle page, still on the same-browser transport', J([au.search, bu.search]));
    ok(p1 === 'playing' && p2 === 'playing', 'CB7c the battle starts on both screens, and the one who asked did not have to press Join', J([p1, p2]));
    const roles = [await a.eval('window.__arenaOnline.state.role').catch(() => null), await b.eval('window.__arenaOnline.state.role').catch(() => null)];
    ok(roles[0] === 'host' && roles[1] === 'guest', 'CB7d the one who accepted hosts, the one who asked joins', J(roles));
    ok((await b.eval('sessionStorage.getItem("arena.meet")')) === null, 'CB7e the MEET token was used up', '');
    const backs = [await a.eval('sessionStorage.getItem("arena.back")'), await b.eval('sessionStorage.getItem("arena.back")')];
    ok(backs[0] === 'center' && backs[1] === 'center', 'CB7f both tabs remember that the battle comes back to the Center (the hub half of Contract 6)', J(backs));
    await shot(a, 'cb7_battle_host'); await shot(b, 'cb7_battle_guest');
    // the way back: the hub opened at #center walks in again, and forgets the key
    await b.navigate(HUB('Bob', lk(7)));
    await walkIn(b).catch(() => {});
    ok((await st(b)).phase === 'in' && (await b.eval('sessionStorage.getItem("arena.back")')) === null && (await b.eval('location.hash')) === '#center', 'CB7g the hub opened at #center after the battle walks the player into the Center again', J(await st(b)));
    ok(!errs(a).length && !errs(b).length, 'CB7h no page errors', J(errs(a).concat(errs(b))).slice(0, 400));
  });

  /* ---- CB12: a touch-only phone, and a controller ---- */
  if (want('CB12')) await withBrowser({ port: cdp + 2, width: 390, height: 844, mobile: true, lock: false, args: NO_THROTTLE }, async (p) => {
    await p.navigate(HUB('Phone', lk(12)));
    await walkIn(p).catch(() => {});
    await sleep(600);
    const lay = await p.eval('(() => { const c = document.getElementById("hub").getBoundingClientRect(); return { sw: document.documentElement.scrollWidth, vw: innerWidth, cw: c.width, pad: document.body.dataset.pad, b: !!document.getElementById("bB").getBoundingClientRect().width }; })()');
    ok(lay.sw <= lay.vw && lay.cw >= 300 && lay.pad === 'on' && lay.b, 'CB12a on a phone the room fills the width with the touch pad under it, and nothing scrolls sideways', J(lay));
    await shot(p, 'cb12_phone_room');
    const hold = async (sel, ms) => { const c = await L.elementCentre(p, sel); await p.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: c.x, y: c.y }] }); await sleep(ms); await p.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); };
    const m0 = await me(p);
    await hold('#bLeft', 900);
    await p.waitFor(`!${H}.apps.state().center.moving`, { timeoutMs: 5000 }).catch(() => {});
    const m1 = await me(p);
    ok(m1.x < m0.x && m1.d === 'left', 'CB12b holding the touch pad walks', J([m0, m1]));
    await L.tapSel(p, '#bB'); await sleep(250);
    const mode1 = (await st(p)).mode;
    await shot(p, 'cb12_phone_menu');
    const emoteRow = await p.eval(`(() => { const v = ${H}.view().center.menu; const i = v.rows.findIndex((r) => r.label === "EMOTE"); return { x: v.x + 30, y: v.y + i * 16 + 8 }; })()`);
    await L.tapLogical(p, canvas, emoteRow.x, emoteRow.y); await sleep(250);
    const mode2 = (await st(p)).mode;
    await L.tapLogical(p, canvas, 24 + 4 * 24 + 12, 32 + 16 + 12); await sleep(300);          // the fifth icon of the first row
    const after = await st(p);
    ok(mode1 === 'menu' && mode2 === 'emote' && after.mode === 'room' && after.emote === 4, 'CB12c the on-screen B opens the menu, a tap on EMOTE opens the icons, a tap on one shows it', J([mode1, mode2, after]));
    await L.tapSel(p, '#bB'); await sleep(200); await L.tapSel(p, '#bB'); await sleep(200);
    ok((await st(p)).mode === 'room', 'CB12d B opens the menu and B closes it', J(await st(p)));
    await L.tapLogical(p, canvas, room.nurse.x * CELL + 8, room.nurse.y * CELL + 8);
    await p.waitFor(`!!${H}.view().dialog && ${H}.view().dialog.id === "center:nurse"`, { timeoutMs: 15000 }).catch(() => {});
    const nurse = await dlg(p);
    await shot(p, 'cb12_phone_nurse');
    await L.tapSel(p, '#bB'); await sleep(250);
    ok(nurse && nurse.id === 'center:nurse' && !(await dlg(p)) && (await p.eval('location.hash')) === '#center', 'CB12e a tap on the nurse walks to the counter and talks to her; the on-screen B stays', J(nurse));
    await L.tapLogical(p, canvas, 196 + 20, 150); await sleep(250);
    const byCorner = (await st(p)).mode;
    const exitRow = await p.eval(`(() => { const v = ${H}.view().center.menu; const i = v.rows.findIndex((r) => r.label === "EXIT"); return { x: v.x + 30, y: v.y + i * 16 + 8 }; })()`);
    await L.tapLogical(p, canvas, exitRow.x, exitRow.y);
    await p.waitFor('location.hash === "#online"', { timeoutMs: 8000 }).catch(() => {});
    ok(byCorner === 'menu' && (await p.eval('location.hash')) === '#online', 'CB12f a tap on "B: MENU" opens the menu too, and EXIT leaves', J([byCorner, await p.eval('location.hash')]));
    ok(!errs(p).length, 'CB12g no page errors on the phone', J(errs(p)).slice(0, 300));

    // a controller (a scripted standard gamepad): walk, the menu with START, the looks, B back
    const g = await p.openTab({ width: 1000, height: 800 });
    await L.addInit(g, L.PAD_DOUBLE);
    await g.navigate(HUB('Pad', lk(13)));
    await walkIn(g).catch(() => {});
    await front(g);
    const PADIDX = { up: 12, down: 13, left: 14, right: 15, a: 0, b: 1, start: 9, r: 5 };
    const cv = await L.logicalToPage(g, canvas, 120, 152);
    await g.click(cv.x, cv.y); await sleep(300);                                                      // (a first act: the page reads no controller before the visitor has acted)
    while ((await st(g)).mode !== 'room') { await press(g, 'b'); }
    const g0 = await me(g);
    await g.eval(`window.__pad.buttons[${PADIDX.right}] = 1`); await sleep(1000); await g.eval(`window.__pad.buttons[${PADIDX.right}] = 0`);
    await g.waitFor(`!${H}.apps.state().center.moving`, { timeoutMs: 5000 }).catch(() => {});
    const g1 = await me(g);
    ok(g1.x > g0.x && g1.d === 'right', 'CB12h a controller: holding the d-pad walks', J([g0, g1]));
    await L.padPress(g, PADIDX.start); const gm = (await st(g)).mode;
    await L.padPress(g, PADIDX.a); const gl = (await st(g)).mode;
    await L.padPress(g, PADIDX.r); await L.padPress(g, PADIDX.a);
    const gs = await st(g);
    ok(gm === 'menu' && gl === 'look' && gs.mode === 'room' && gs.look === lk(13 + 16), 'CB12i START opens the menu, A opens LOOK, R turns the page, A takes the look', J([gm, gl, gs]));
    await L.padPress(g, PADIDX.b); const gb = (await st(g)).mode; await L.padPress(g, PADIDX.b);
    ok(gb === 'menu' && (await st(g)).mode === 'room' && !errs(g).length, 'CB12j B opens the menu and B closes it; no page errors', J([gb, errs(g)]));
  });

  /* ---- CB13: THE CENTER'S OWN QUESTION: a player whose switch is off and who once answered the hub's disclosure is asked before anything is switched on ---- */
  if (want('CB13')) await withBrowser({ port: cdp + 3, width: 1000, height: 900, lock: false, args: NO_THROTTLE }, async (a) => {
    const spy = await a.openTab({ width: 600, height: 400 });
    await spy.navigate(origin + '/pokemonarena/text_manifest.json');
    await spy.eval('window.__room = []; window.__ch = new BroadcastChannel("bemental-arena-center-2"); window.__ch.onmessage = (e) => window.__room.push(e.data); window.__board = []; window.__bc = new BroadcastChannel("bemental-arena-open-1"); window.__bc.onmessage = (e) => window.__board.push(e.data); true');
    const said = () => spy.eval('window.__room.length + window.__board.length');
    // this browser once answered the hub's disclosure (what Open to battles lists), and its switch is off
    await a.navigate(origin + '/pokemonarena/text_manifest.json');
    await a.eval('localStorage.setItem("arena.open.seen", "1"); localStorage.removeItem("arena.open"); localStorage.removeItem("arena.center.seen"); true');
    await front(a);
    await a.navigate(HUB('Alice', lk(6), '&opendisc=1'));
    await a.waitFor(ready, { timeoutMs: 90000 }).catch(() => {});
    await a.waitFor(`(!!${H}.view().dialog && ${H}.view().dialog.id === "center:enter") || ${inside}`, { timeoutMs: 30000 }).catch(() => {});
    await sleep(1200);
    const pre = { d: await dlg(a), st: await st(a), n: await said(), on: await a.eval(`${H}.presence.isOn()`), stored: await a.eval('localStorage.getItem("arena.open")'), drawn: await a.eval(`${H}.view().center.people.length`) };
    ok(pre.d && pre.d.id === 'center:enter' && pre.st.phase === 'wait' && pre.on === false && pre.stored === null && pre.drawn === 0, 'CB13a a player who is NOT open to battles (but once answered the hub\'s disclosure) is asked first by the Center itself, in the picture, before they walk in', J(pre));
    ok(pre.n === 0, 'CB13b nothing at all is published before YES', pre.n);
    await shot(a, 'cb13_question');
    let words = '';
    for (let i = 0; i < 12; i++) { const d = await dlg(a); if (!d) break; words += ' ' + d.lines.join(' '); if (!d.more) break; await press(a, 'a'); }
    const last = await dlg(a);
    ok(/trainer name, record, look and where you stand/.test(words.replace(/\s+/g, ' ')) && /public servers/.test(words) && last && last.choice && last.choice.options.join() === 'YES,NO' && last.choice.cursor === 1, 'CB13c it says what the Center lists (the name, the record, the look, where you stand, on public servers) and asks "Walk in?" with NO highlighted', words);
    await shot(a, 'cb13_walk_in');
    await L.key(a, 'b');                                                                              // B is NO
    await a.waitFor('location.hash !== "#center"', { timeoutMs: 10000 }).catch(() => {});
    await sleep(500);
    const no = { hash: await a.eval('location.hash'), n: await said(), told: await a.eval('localStorage.getItem("arena.center.seen")'), on: await a.eval(`${H}.presence.isOn()`), d: await dlg(a) };
    ok(no.hash === '#online' && no.n === 0 && no.told === null && no.on === false && !no.d, 'CB13d NO (the B key) leaves the Center: nothing was published, nothing is remembered', J(no));
    await a.eval(`${H}.goto("center")`);
    await a.waitFor(`!!${H}.view().dialog && ${H}.view().dialog.id === "center:enter" && ${H}.view().dialog.armed`, { timeoutMs: 15000 }).catch(() => {});
    await lastPage(a); await press(a, 'up');
    await L.key(a, 'a');                                                                              // YES, with a real key
    await walkIn(a).catch(() => {});
    const heard = await until(() => spy.eval('window.__room.some((m) => m.k === "here" && m.name === "Alice") && window.__board.some((m) => m.k === "open")'), 8000);
    const yes = { st: await st(a), told: await a.eval('localStorage.getItem("arena.center.seen")'), stored: await a.eval('localStorage.getItem("arena.open")') };
    ok(yes.st.phase === 'in' && !!heard && yes.told === '1' && yes.stored === null, 'CB13e YES walks in: the room and the board hear it, the answer is remembered, and the stored switch stays off (open for this page only)', J(yes));
    await a.eval(`${H}.goto("main")`); await sleep(500);
    await a.eval(`${H}.goto("center")`);
    await walkIn(a).catch(() => {});
    ok((await st(a)).phase === 'in' && !(await dlg(a)), 'CB13f the next visit walks straight in: what the Center lists was said once', J(await st(a)));
    await shot(a, 'cb13_in');
    ok(!errs(a).length, 'CB13g no page errors', J(errs(a)).slice(0, 300));
  });

  /* ---- CB14: SOMEBODY ASKS A PLAYER WHO HAS SOMETHING OF THE CENTER'S ON THE SCREEN: the question is the one shown ---- */
  if (want('CB14')) await withBrowser({ port: cdp + 4, width: 1000, height: 900, lock: false, args: NO_THROTTLE }, async (a) => {
    await a.navigate(HUB('Alice', lk(6), '&openchal=8000'));
    await walkIn(a).catch(() => {});
    const b = await a.openTab({ width: 1000, height: 900 });
    await b.navigate(HUB('Bob', lk(7), '&openchal=8000'));
    await walkIn(b).catch(() => {});
    await until(async () => (await people(a)).some((p) => p.name === 'Bob' && p.doing === 'here') && (await people(b)).some((p) => p.name === 'Alice' && p.doing === 'here'), 30000);
    // ask a trainer by name through WHO'S HERE, with the hook alone (the tab need not be in front)
    const askName = async (p, name) => {
      await press(p, 'b'); await press(p, 'down'); await press(p, 'down'); await press(p, 'down'); await press(p, 'a');
      const i = await p.eval(`${H}.view().center.who.rows.findIndex((r) => r.name === ${J(name)})`);
      for (let k = 0; k < i; k++) await press(p, 'down');
      await press(p, 'a'); await lastPage(p); await press(p, 'a');
      return i;
    };
    const shownId = (p) => p.eval(`(${H}.view().dialog || {}).id || null`);
    // Bob reads a sign (and leaves it on the screen)
    await front(b);
    await L.clickLogical(b, canvas, room.signs[0].x * CELL + 8, room.signs[0].y * CELL + 8);
    await b.waitFor(`!!${H}.view().dialog && ${H}.view().dialog.id === "center:sign"`, { timeoutMs: 15000 }).catch(() => {});
    const under = await shownId(b);
    const t0 = Date.now();
    const row = await askName(a, 'Bob');
    await b.waitFor(`!!${H}.view().dialog && ${H}.view().dialog.id === "presence:challenge"`, { timeoutMs: 5000 }).catch(() => {});
    const took = Date.now() - t0, q = await dlg(b);
    ok(under === 'center:sign' && row >= 0 && q && q.id === 'presence:challenge' && /wants to battle you/.test(q.lines[1]) && took < 3000, 'CB14a somebody asks a player who is reading a sign: "wants to battle you" is on their screen at once (' + took + ' ms), not behind the sign', J([under, row, q]));
    await b.waitFor(`!!${H}.view().dialog && ${H}.view().dialog.armed`, { timeoutMs: 5000 }).catch(() => {});
    await shot(b, 'cb14_question_over_sign');
    await L.key(b, 'b');                                                                              // NO
    await a.waitFor(`!!${H}.view().dialog && ${H}.view().dialog.id === "center:note"`, { timeoutMs: 15000 }).catch(() => {});
    const note = await dlg(a);
    ok(note && note.lines.join(' ').trim() === 'Bob said not now.' && !(await dlg(b)), 'CB14b NO: the asker reads "Bob said not now." (and the sign Bob was reading is gone with the question)', J([note, await dlg(b)]));
    // Alice leaves that answer on her screen, and Bob asks HER: the answer nobody pressed A on does not hide the question
    const row2 = await askName(b, 'Alice');
    await a.waitFor(`!!${H}.view().dialog && ${H}.view().dialog.id === "presence:challenge"`, { timeoutMs: 5000 }).catch(() => {});
    const q2 = await dlg(a);
    ok(row2 >= 0 && q2 && q2.id === 'presence:challenge' && /wants to battle you/.test(q2.lines[1]), 'CB14c a player with an answer left on the screen ("Bob said not now.") can be asked: the question takes its place', J([row2, q2]));
    await front(a);
    await a.waitFor(`!!${H}.view().dialog && ${H}.view().dialog.armed`, { timeoutMs: 5000 }).catch(() => {});
    await shot(a, 'cb14_question_over_note');
    await L.key(a, 'b');                                                                              // NO
    await b.waitFor(`!!${H}.view().dialog && ${H}.view().dialog.id === "center:note"`, { timeoutMs: 15000 }).catch(() => {});
    ok(/said not now/.test(((await dlg(b)) || { lines: [] }).lines.join(' ')) && (await a.eval('location.pathname')) === '/pokemonarena/' && (await b.eval('location.pathname')) === '/pokemonarena/', 'CB14d ... and their NO is told to the one who asked; both stay in the Center', J(await dlg(b)));
    ok(!errs(a).length && !errs(b).length, 'CB14e no page errors', J(errs(a).concat(errs(b))).slice(0, 400));
  });
}

// Browser mutants: one defect in the page at a time, served over the real files; each must fail its case.
const BROWSER_MUTANTS = [
  { id: 'BM1', file: '/pokemonarena/js/center_ctl.js', from: "    const on = await svc.turnOn({ persist: false, also: WORDS.also });", to: "    startRoom(); const on = await svc.turnOn({ persist: false, also: WORDS.also });", fails: 'CB1b' },
  { id: 'BM2', file: '/pokemonarena/js/online.js', from: "    else if (meetTok && state.role === 'guest' && state.room) { meetTok = false; startAs('guest'); }\n", to: "    else if (query.meet && state.role === 'guest' && state.room) { startAs('guest'); }\n", fails: 'CB7a' },
  { id: 'BM3', file: '/pokemonarena/center.html', from: "      for (var i = 0; i < keep.length; i++) if (from.get(keep[i]) !== null) to.set(keep[i], from.get(keep[i]));", to: "      to = from;", fails: 'CB0a' },
  { id: 'BM4', file: '/pokemonarena/js/center_hub.js', from: "    else if (a.kind === 'thing') { if (S.grid.facing(me.x, me.y, me.d) === a.thing) fx.push(...use(a.thing)); }", to: "    else if (a.kind === 'thing') { /* nothing */ }", fails: 'CB9a' },
  { id: 'BM5', file: '/pokemonarena/js/center_ctl.js', from: "      win.setTimeout(() => { if (inside && !leaving && !svc.isOn()) { stopRoom(); run(app.kick('off')); } }, 0);", to: "", fails: 'CB10a' },
  { id: 'BM6', file: '/pokemonarena/js/center_ctl.js', from: "    if (!generic && asksFirst && !told()) {", to: "    if (false) {", fails: 'CB13a' },
  { id: 'BM7', file: '/pokemonarena/js/center_ctl.js', from: "    app.makeWay();\n", to: "", fails: 'CB14a' },
];
async function runBrowserMutants() {
  let killed = 0, ran = 0;
  for (const [i, m] of BROWSER_MUTANTS.entries()) {
    if (ONE && ONE !== m.id) continue;
    ran++;
    let body = fs.readFileSync(path.join(root, m.file), 'utf8').replace(/\r\n/g, '\n');
    const n = body.split(m.from).length - 1;
    if (n !== 1) { console.log('MUTANT', m.id, 'snippet occurs', n, 'times'); continue; }
    body = body.replace(m.from, () => m.to);
    const port = PORT + 20 + i;
    const srv = await overlay(port, PORT, { [m.file]: body });
    const before = failures.length;
    try { await browserCases(`http://localhost:${port}`, CDP0 + 10 + i * 6, [m.fails]); } catch (e) { failures.push(m.fails + ' threw ' + e.message); }
    const hit = failures.slice(before).some((f) => f.startsWith(m.fails));
    failures.length = before;
    srv.close();
    if (hit) killed++; else console.log('MUTANT SURVIVED', m.id, '(expected', m.fails, 'to fail)');
  }
  console.log('browser mutants killed', killed + '/' + ran);
  return killed === ran;
}

/* ================================================================================================ main */
if (args[0] === '__child') {          // one mutant's run (runNodeMutants): the names of the failed cases, as one line
  let failed = [];
  try { failed = await runNode(args[1], false, { pure: args[2] === 'pure', ctl: args[2] === 'ctl', block: args[3] || null }); } catch (e) { failed = ['threw: ' + e.message]; }
  console.log('CHILD_FAILED ' + JSON.stringify(failed));
  process.exit(0);
}
const nodeFailed = PAGE_MUTANTS_ONLY ? [] : await runNode(SRC, true, { pure: true, ctl: !PURE_ONLY });
if (!PAGE_MUTANTS_ONLY) console.log('node checks: ' + (nodeFailed.length ? nodeFailed.length + ' failed of ' + nodeFailed.checks : 'all passed (' + nodeFailed.checks + ')'));
let mutOk = true;
if (MUTANTS && !PAGE_MUTANTS_ONLY && (!ONE || NODE_MUTANTS.some((m) => m.id === ONE))) mutOk = await runNodeMutants();
let browserOk = true;
if (!NODE_ONLY) {
  await startServer(PORT);
  try {
    if (!PAGE_MUTANTS_ONLY) {
      await browserCases(`http://localhost:${PORT}`, CDP0, ONLY);
      console.log(`browser cases: ${pass} passed, ${fail} failed`);
      browserOk = fail === 0;
    }
    if (MUTANTS && (!ONE || BROWSER_MUTANTS.some((m) => m.id === ONE))) { const real = failures.length; const bm = await runBrowserMutants(); mutOk = mutOk && bm; failures.length = real; }
  } finally { if (server) { try { if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' }); else server.kill('SIGKILL'); } catch (_e) { /* gone */ } } }
  console.log('pictures:', OUT);
}
if (failures.length) console.log('failures:\n  ' + failures.join('\n  '));
process.exit(nodeFailed.length || !browserOk || !mutOk ? 1 : 0);

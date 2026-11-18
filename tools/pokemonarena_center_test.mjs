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
//   ARENA_PORT / ARENA_CDP (or CENTER_PORT / CENTER_CDP; defaults 8241 / 9441); CENTER_OUT=<dir> for the pictures it writes (default: the system's temp folder)
//
// NODE (nothing is faked below the page: the real hub model, the real renderer and ROM font, the real presence service, presence_boot.js, presence.js and the board over Node's
// BroadcastChannel, which is the transport ?net=local uses in a browser; doubled: window, document, navigation, the sound door):
//   L  looks: the seven-character code of a ROM trainer sprite, old codes, the stored look
//   R  the room read from the ROM: the collision, the door, the nurse, the PC, the wall map, the signs, the spots; the pictures against hashes
//   G  the grid: what is faced from where, the shortest walk, the door mat
//   M  the model: walking in, GBA walking, the ROM's collision, taps, every interaction from the right cell and facing only, the menu, the pickers, WHO'S HERE, the people, the words
//   S  the renderer: the layers, the depth order, feet on the cell, every text against its window, no art in the source
//   N  the room's messages and roster: version 2, the guards (a position, a look, an emote, a name), the caps
//   T  the one-time MEET token and the battle page's address
//   K  the ctl on two and three pages: nothing published before YES, seeing each other, a step, a look, an emote, a hub player at a spot, a challenge declined and one accepted,
//      the switch going off elsewhere, the switch put back, the sounds
// BROWSER (real Chrome through tools/headless_cdp.mjs: headless, a throwaway profile, muted; the tabs share one profile, which is what lets ?net=local pair them; everything is read and
// driven through window.__arenaHub, real keys, real taps and a scripted controller): CB0-CB12, listed where they are.
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
async function runNode(jsDir, log, parts = { pure: true, ctl: true }) {
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
      ok(sign && sign.id === 'center:sign' && /trainer name/.test(words) && /your look/.test(words) && /where you stand/.test(words) && /online record/.test(words) && /public servers/.test(words) && /takes it all down/.test(words), 'M6p a sign says what the Center shares about you: name, look, where you stand, record, where, and how it ends', words);
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
      const d = w.dlg();
      ok(d && d.id === 'center:talk' && d.lines[0] === 'RED   3-1 online' && d.lines[1] === CH.WORDS.here && d.choice.options.join() === 'ASK TO BATTLE,CANCEL' && Math.abs(w.st().x - 6) + Math.abs(w.st().y - 5) === 1,
        'M8a a tap on a trainer walks up to them: "<NAME>   W-L online", where they are, ASK TO BATTLE / CANCEL', J([d, w.st()]));
      w.press('b');
      ok(w.dlg() === null && w.of('ask').length === 0, 'M8b B is CANCEL: nothing is asked', '');
      // A facing them
      w.press('a'); w.press('a');
      const asking = w.dlg(), ask = w.of('ask');
      ok(ask.length === 1 && ask[0].id === S16('a') && ask[0].name === 'RED' && asking && asking.id === 'center:asking' && /Asked RED to battle/.test(asking.lines[0]) && /Waiting/.test(asking.lines[1]) && asking.choice.options.join() === 'CANCEL' && w.st().asking === S16('a'),
        'M8c ASK TO BATTLE asks that player\'s listing and says so: "Asked RED to battle. Waiting for an answer..." with CANCEL', J([ask, asking]));
      w.press('a'); w.press('b');
      ok(w.dlg() && w.dlg().id === 'center:asking' && w.of('cancel-ask').length === 0, 'M8d the A that asked is not the A that cancels: for 0.6 s the waiting line answers nothing', J(w.dlg()));
      w.tick(HM.DIALOG_ARM_TICKS === undefined ? 36 : HM.DIALOG_ARM_TICKS); w.tick(36); w.press('b');
      ok(w.of('cancel-ask').length === 1 && w.text() === CH.WORDS.cancelled && w.st().asking === null, 'M8e CANCEL withdraws the challenge and says "Challenge cancelled."', w.text());
      w.press('a');
      // accepted, and every way it can end without a battle
      const reask = () => { while (w.dlg()) w.press('b'); w.press('a'); w.press('a'); };
      reask(); w.app.askAccepted();
      ok(w.text() === 'RED accepted! Opening the battle...' && w.st().asking === null, 'M8f accepted: "RED accepted! Opening the battle..."', w.text());
      const said = {};
      for (const why of ['declined', 'busy', 'timeout', 'unsupported', 'gone', 'off', 'storage']) { reask(); w.app.askFailed(why); said[why] = w.allText(); }
      ok(said.declined === 'RED said not now.' && /answering another challenge/.test(said.busy) && said.timeout === 'RED did not answer.' && /cannot send a private challenge/.test(said.unsupported) && /not open to battles any more/.test(said.gone) && /not open to battles yet/.test(said.off) && /storage/.test(said.storage),
        'M8g declined, busy, no answer, a browser that cannot ask, a player who left: each is said in words', J(said));
      while (w.dlg()) w.press('b');
      // a listed game: JOIN THEIR BATTLE
      const sp = w.app.people().find((p) => p.name === 'SILVER');
      w.click(sp.x * CELL + 8, sp.y * CELL + 2); w.tick(600);
      const jd = w.dlg();
      ok(jd && jd.choice && jd.choice.options.join() === 'JOIN THEIR BATTLE,CANCEL' && /waiting for an opponent \(3 v 3\)/.test(jd.lines[1]), 'M8h a player who hosts a listed game: JOIN THEIR BATTLE / CANCEL', J(jd));
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
      const d = w.dlg();
      ok(d && d.id === 'center:talk' && /^P5/.test(d.lines[0]) && d.choice.options[0] === 'JOIN THEIR BATTLE', 'M10c A on a row is what A is in front of that trainer (a player who is not in the picture can be battled from here)', J(d));
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
      const pages = (where) => { for (let i = 0; i < 20 && w.dlg(); i++) { check(where + ' p' + i); if (!w.dlg().more) break; w.hub.press('a'); } while (w.dlg()) w.hub.press('b'); };
      check('room');
      for (const p of w.app.people()) { w.press('b'); w.press('down'); w.press('down'); w.press('down'); w.press('a'); const rows = w.hub.view().center.who.total; for (let i = 0; i < rows; i++) { check('who'); if (w.hub.view().center.who.rows[w.hub.view().center.who.cursor].name === p.name) break; w.press('down'); } w.press('a'); pages('talk ' + p.name); w.press('b'); w.press('b'); }
      // asking and every answer
      w.press('b'); w.press('down'); w.press('down'); w.press('down'); w.press('a'); w.press('a'); w.press('a'); check('asking');
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
      ok(J(Object.keys(st).sort()) === J(['asking', 'cursor', 'd', 'emote', 'look', 'mode', 'moving', 'net', 'people', 'phase', 'walking', 'x', 'y']) && J(st).length < 200, 'M13d state() is small plain JSON', J(st));
      const reg = HM.createHubModel({});
      ok(reg.apps.center.id === 'center' && reg.apps.center.paths.join() === 'center' && reg.apps.center.parent('center') === 'online' && HM.arrivalTrail('center').join() === 'online,center', 'M13e the app is the registry\'s `center`, one path, opened from PLAY ONLINE', '');
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
      ok(tg.length === ppl.length && tg.every((t) => t.x >= 0 && t.y >= 0 && t.x + t.w <= 240 && t.y + t.h <= 160 && t.h <= 11 && t.w <= CS.TAG.maxPx + 2 * CS.TAG.padX) && tg.every((t, i) => t.y >= ppl[i].py + 8 && t.y <= ppl[i].py + 16),
        'S5 every trainer has a name plate at their feet, inside the picture, no taller than the letters', J(tg.slice(0, 3)));
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
      }
      const gone = ['js/avatar.js', 'js/center_map.js', 'js/center_draw.js', 'js/center_boot.js', 'center.css', 'dev/avatar_sheet.html'].filter((f) => fs.existsSync(path.join(root, 'pokemonarena', f)));
      const importers = fs.readdirSync(SRC).filter((f) => f.endsWith('.js') && /from '\.\/(avatar|center_map|center_draw|center_boot)\.js'/.test(fs.readFileSync(path.join(SRC, f), 'utf8')));
      const html = fs.readFileSync(path.join(root, 'pokemonarena', 'center.html'), 'utf8');
      ok(!bad.length && !gone.length && !importers.length && !/<canvas|<button|<link[^>]+stylesheet|center_boot/.test(html) && /location\.replace\('\/pokemonarena\/' \+/.test(html) && /#center/.test(html),
        'S7 no art in the source (no canvas drawing, no colour, no character outside ASCII); the hand-drawn Trainer Center is gone and nothing imports it; center.html is a redirect with no UI', J([bad, gone, importers]));
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
      tm.run(3000);
      ok(sent.filter((m) => m.k === 'here').length === 2, 'N7b ... and says it again every few seconds', sent.length);
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

  if (parts.ctl) await runCtl(jsDir, ok, guard, { ui, screen, room, looks, lk, CH, K, P, OL, N });
  return failed;
}

/* ================================================================================================ K: the ctl, on real pages' worth of code in Node */
const memStorage = (init = {}) => { const store = { ...init }; return { store, getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } }; };
async function runCtl(jsDir, ok, guard, M) {
  const imp = (f) => import(pathToFileURL(path.join(jsDir, f)).href);
  const [HM, T, CC, HP] = await Promise.all(['hub_model.js', 'tables.js', 'center_ctl.js', 'hub_presence.js'].map(imp));
  const { ui, screen, room, looks, lk, CH, K, P, OL, N } = M;
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
    const doc = { hidden: false, getElementById: () => null, addEventListener() {}, removeEventListener() {} };
    const hub = HM.createHubModel({ mascot: 25, env: 0, measure: screen.measure, msgPx: screen.msgPx, measureFont: screen.measureFont });
    hub.setData({ state: 'ready', activeId: null, profiles: [] });
    const w = { win, hub, nav: [], sound: [], fam: false, ctl: null };
    const hook = { dialogOpen: () => false };
    const sync = () => { const now = hub.path() === 'center'; if (now && !w.fam) { w.fam = true; if (w.ctl) w.ctl.enter('center'); } else if (!now && w.fam) { w.fam = false; if (w.ctl) w.ctl.leave('center'); } };
    const run = (fx) => { for (const e of fx || []) { if (!e) continue; if (typeof e.app === 'string') { if (e.app === 'center' && w.ctl) w.ctl.effect(e); } else if (e.type === 'dialog' && hook.presence) hook.presence.answer(e); else if (e.type === 'sfx' && e.key) w.sound.push(e.key); } sync(); return fx; };
    const snap = (url) => { const ss = win.sessionStorage; return { url, back: HP.readBack(ss), accept: ss.getItem(P.ACCEPT_KEY), meet: ss.getItem(P.MEET_KEY) }; };
    w.env = { win, doc, hook, model: hub, app: hub.apps.center, pack, rom: ui.rom, ui, navigate: (u) => w.nav.push(snap(u)), input: null, storage: win.localStorage, session: win.sessionStorage, refreshData() {}, redraw() {}, run, freshSeed: () => (o.seed === undefined ? 0 : o.seed), store: () => null, whenStore: () => Promise.resolve(null),
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
  const block = async (name, fn) => { try { await fn(); } catch (e) { ok(false, name + ' (threw)', e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e); } await endAll(); };

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
    ok(a.dlg() && a.dlg().id === 'center:talk' && a.dlg().lines[1] === CH.WORDS.menu && a.dlg().choice.options[0] === 'ASK TO BATTLE', 'K3b a player at a spot can be asked: they are "open from the Arena menu"', J(a.dlg()));
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
    a.press('a');
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
    c.press('b'); c.press('down'); c.press('down'); c.press('down'); c.press('a'); c.press('a'); c.press('a');
    const cn = c.nav[0] || {};
    ok(/\?np=ZXCVB&join=1&meet=1&net=local/.test(cn.url || '') && cn.back === 'center' && cn.meet, 'K4f JOIN THEIR BATTLE opens that room with the MEET token, and comes back to the Center', J(cn));
    const bad = page('?net=local&ctrname=Dan&ctrav=' + lk(9), { seed: 4 });
    bad.go('center'); await inRoom(bad);
    bad.app.setRoster({ walkers: [], players: [{ id: S16('f'), name: 'Odd', rec: null, look: null, doing: 'waiting', room: 'not a room!', fmt: '3v3', compatible: true }] });
    bad.press('b'); bad.press('down'); bad.press('down'); bad.press('down'); bad.press('a'); bad.press('a'); bad.press('a');
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
    ok([a, u, none, o].every((x) => x.hub.faults().length === 0), 'K6h nothing threw', J(a.hub.faults()));
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
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '__child', dir, m.part], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 180000, windowsHide: true });
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
    const talk = await dlg(a), near = await me(a);
    ok(talk && talk.id === 'center:talk' && /^Bob/.test(talk.lines[0]) && talk.choice && talk.choice.options.join() === 'ASK TO BATTLE,CANCEL' && Math.abs(near.x - bob.x) + Math.abs(near.y - bob.y) === 1, 'CB6a a click on a trainer walks up to them and asks: ASK TO BATTLE / CANCEL', J([talk, near]));
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
}

// Browser mutants: one defect in the page at a time, served over the real files; each must fail its case.
const BROWSER_MUTANTS = [
  { id: 'BM1', file: '/pokemonarena/js/center_ctl.js', from: "    const on = await svc.turnOn({ persist: false, also: WORDS.also });", to: "    startRoom(); const on = await svc.turnOn({ persist: false, also: WORDS.also });", fails: 'CB1b' },
  { id: 'BM2', file: '/pokemonarena/js/online.js', from: "    else if (meetTok && state.role === 'guest' && state.room) { meetTok = false; startAs('guest'); }\n", to: "    else if (query.meet && state.role === 'guest' && state.room) { startAs('guest'); }\n", fails: 'CB7a' },
  { id: 'BM3', file: '/pokemonarena/center.html', from: "      for (var i = 0; i < keep.length; i++) if (from.get(keep[i]) !== null) to.set(keep[i], from.get(keep[i]));", to: "      to = from;", fails: 'CB0a' },
  { id: 'BM4', file: '/pokemonarena/js/center_hub.js', from: "    else if (a.kind === 'thing') { if (S.grid.facing(me.x, me.y, me.d) === a.thing) fx.push(...use(a.thing)); }", to: "    else if (a.kind === 'thing') { /* nothing */ }", fails: 'CB9a' },
  { id: 'BM5', file: '/pokemonarena/js/center_ctl.js', from: "      win.setTimeout(() => { if (inside && !leaving && !svc.isOn()) { stopRoom(); run(app.kick('off')); } }, 0);", to: "", fails: 'CB10a' },
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
    try { await browserCases(`http://localhost:${port}`, CDP0 + 10 + i * 4, [m.fails]); } catch (e) { failures.push(m.fails + ' threw ' + e.message); }
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
  try { failed = await runNode(args[1], false, { pure: args[2] === 'pure', ctl: args[2] === 'ctl' }); } catch (e) { failed = ['threw: ' + e.message]; }
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

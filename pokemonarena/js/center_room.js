// pokemonarena/js/center_room.js -- THE ROOM of the Trainer Center as the hub app needs it: which cells of the ROM's Pokemon Center can be walked, what is where (the door mat, the counter and
// the nurse behind it, the PC, the wall map, the signs), where the players who are open somewhere else stand, and the shortest walk from one cell to another.
//
// NOTHING OF THE MAP IS WRITTEN HERE. roomFromWorld(world) reads it from the ROM at run time (world_rom.js: the map's own collision, behaviours and events) and returns a small plain object, the
// ROOM, which is what center_hub.js (the pure model), center_net.js (the room's messages: a position must be a cell of it) and the tests are handed. What IS written here is this site's own
// choice of cells on that map (SPOTS, SPAWNS): cell numbers, checked against the ROM's collision every time a room is made (a cell the ROM does not let a trainer stand on is dropped).
//
// THE ROOM (plain JSON, frozen)
//   w, h        15 x 10 cells of 16 px: the 240 x 160 picture, with a fixed camera (the map's 16th column is solid filler and is left out)
//   rows        h strings of w characters: '.' a cell a trainer can stand on AND walk to from the door, '#' everything else. THE ROM'S OWN COLLISION (map.canEnter at a trainer's elevation); the two
//               cells behind the counter, where the nurse and her Chansey stand, are open in the ROM but cannot be reached, so they are '#'
//   door        { x, y, d }   the door mat (the map's warp): stepping `d` (down) off it leaves
//   nurse       { x, y, talk: { x, y } } | null     the nurse, and the cell she is addressed from ACROSS the counter, facing up
//   pc, map, signs   [{ x, y, use: { x, y } }]      the PC, the wall map and the signs (the map's BG events): each is used from the cell below it, facing up
//   npcs        [{ gfx, x, y, d }]   the map's own people that are drawn: the nurse and the Pokemon beside her. The map's other people are not (INAPP.md, Wave 2 decision 8)
//   spots       [{ x, y, d }]        where the players who are open elsewhere stand, in the order they are given out
//   spawns      [{ x, y, d }]        where a trainer who walks in appears
//   looks       the graphics ids a player can look like (world.ow.avatars), in the ROM's order
//   emotes      how many emote icons the ROM has, and emoteFrames: how many pictures each has (1 or 2)
//   music       the map's own song number (its header)
//
// Pure ES module (browser + Node): no DOM, no clock, no storage, and NO import (center_hub.js imports this file, and the hub's first paint loads center_hub.js).

export const ROOM_W = 15, ROOM_H = 10, CELL = 16;
/** A trainer's elevation on the Center's floor (world_rom.js: every open cell of the room is at 3). */
export const TRAINER_ELEVATION = 3;
export const DIRS = Object.freeze(['down', 'up', 'left', 'right']);
export const VEC = Object.freeze({ down: Object.freeze([0, 1]), up: Object.freeze([0, -1]), left: Object.freeze([-1, 0]), right: Object.freeze([1, 0]) });
export const OPPOSITE = Object.freeze({ down: 'up', up: 'down', left: 'right', right: 'left' });
export const isDir = (d) => DIRS.includes(d);
export function ahead(x, y, d) { const v = VEC[d] || VEC.down; return { x: x + v[0], y: y + v[1] }; }

/**
 * WHERE THE PLAYERS WHO ARE OPEN SOMEWHERE ELSE STAND (the hub's switch, a battle against the computer, a game listed on Play online): this site's choice of cells on the ROM's map, out of the
 * way of the door, the counter, the PC and the wall map, each facing into the room. In the order they are given out: the seat and the cushion first (where the ROM itself puts two of the map's
 * people), then the walls, the table, the bottom row and the two ends of the counter. A cell the ROM's collision does not allow is dropped by roomFromWorld.
 * NO TWO ARE NEAR EACH OTHER: a name is written under a trainer's feet, so two spots in neighbouring columns are at least three rows apart (a name never lies on the next trainer), none is
 * under the leaves of a plant (the map's top layer would cover the trainer), and none is in the bottom right corner, where the picture says what B does. tools/pokemonarena_center_test.mjs
 * checks all of that against the ROM's map. Players beyond the last spot are in the WHO'S HERE list only.
 */
export const SPOTS = Object.freeze([
  [14, 6, 'left'], [12, 5, 'down'], [0, 5, 'right'], [14, 2, 'left'], [0, 2, 'right'], [10, 7, 'left'], [2, 8, 'up'], [5, 8, 'up'], [4, 4, 'down'], [10, 4, 'down'],
].map(([x, y, d]) => Object.freeze({ x, y, d })));
/**
 * WHICH OF THE ROM'S EMOTE ICONS SAYS WHAT A PLAYER AT A SPOT IS DOING (world_rom.js world.emotes, by number; the names are that file's): 'menu' = open from the Arena's menu or a battle
 * against the computer, the "..." icon; 'looking' = pressed BATTLE ANYONE and waits for whoever comes, "!!"; 'waiting' = hosts a listed game, "!"; 'other' = another version of the Arena
 * (cannot be battled), the cross.
 */
export const STATUS_EMOTE = Object.freeze({ menu: 10, looking: 2, waiting: 0, other: 3 });
/** Where a trainer who walks in appears: just inside the door, facing the counter (one is picked, so two who come in together do not stand on one cell). */
export const SPAWNS = Object.freeze([[7, 7], [6, 7], [8, 7], [7, 6], [5, 7], [9, 7], [6, 6], [8, 6]].map(([x, y]) => Object.freeze({ x, y, d: 'up' })));

const key = (x, y) => x + ',' + y;
const freeze = (o) => Object.freeze(o);
// the way a trainer steps OFF a warp cell to leave through it (world_rom.js MB: the four arrow warps; the Center's mat is the south one). Anything else is taken as a mat too.
const doorDir = (behavior, MB) => (behavior === MB.NORTH_ARROW_WARP ? 'up' : behavior === MB.EAST_ARROW_WARP ? 'right' : behavior === MB.WEST_ARROW_WARP ? 'left' : 'down');

/** The map's own people the room draws: the nurse, and the Pokemon standing beside her behind the counter. -> the map's object events (world.mapSprites entries have the same fields). */
export function roomNpcs(objects, nurseGfx, monFlag) {
  const list = Array.isArray(objects) ? objects : [];
  const nurse = list.find((o) => o.gfx === nurseGfx) || null;
  if (!nurse) return [];
  return list.filter((o) => o === nurse || ((o.gfx & monFlag) !== 0 && o.y === nurse.y && Math.abs(o.x - nurse.x) === 1));
}

/**
 * world (world_rom.js loadWorld(rom)) -> the ROOM (see the top of this file). consts: world_rom.js's { GFX, MB } (handed in so that this file imports nothing).
 * Throws when the map is not a room this app can use (no door, a size that is not the picture's): a different ROM, which the page has already refused by its hash.
 */
export function roomFromWorld(world, consts) {
  const m = world.center, info = world.centerInfo(m);
  if (m.height !== ROOM_H || m.width < ROOM_W) throw new Error('the Pokemon Center is ' + m.width + ' x ' + m.height + ' cells, not the ' + ROOM_W + ' x ' + ROOM_H + ' of the picture');
  const d0 = info.doors[0];
  if (!d0) throw new Error('the Pokemon Center has no door');
  const inside = (x, y) => Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < ROOM_W && y < ROOM_H;
  const open = (x, y) => inside(x, y) && m.canEnter(x, y, TRAINER_ELEVATION);
  if (!open(d0.x, d0.y)) throw new Error('the door mat of the Pokemon Center cannot be stood on');
  // every cell a trainer can walk to from the door
  const reach = new Set([key(d0.x, d0.y)]), q = [[d0.x, d0.y]];
  while (q.length) {
    const [x, y] = q.shift();
    for (const d of DIRS) { const n = ahead(x, y, d), k = key(n.x, n.y); if (!reach.has(k) && open(n.x, n.y)) { reach.add(k); q.push([n.x, n.y]); } }
  }
  const ok = (x, y) => reach.has(key(x, y));
  const rows = [];
  for (let y = 0; y < ROOM_H; y++) { let s = ''; for (let x = 0; x < ROOM_W; x++) s += ok(x, y) ? '.' : '#'; rows.push(s); }
  // a thing on the wall is used from the cell below it, facing up
  const below = (cells) => cells.filter((c) => inside(c.x, c.y) && ok(c.x, c.y + 1)).map((c) => freeze({ x: c.x, y: c.y, use: freeze({ x: c.x, y: c.y + 1 }) }));
  const signCells = [], seen = new Set();
  for (const b of m.events.bgs) { const k = key(b.x, b.y); if (!seen.has(k)) { seen.add(k); signCells.push({ x: b.x, y: b.y }); } }
  const special = new Set([key(d0.x, d0.y)]);
  const pc = below(info.pc), map = below(info.regionMap), signs = below(signCells);
  for (const t of [...pc, ...map, ...signs]) special.add(key(t.use.x, t.use.y));
  let nurse = null;
  if (info.nurse && info.nurseTalk && ok(info.nurseTalk.x, info.nurseTalk.y)) { nurse = freeze({ x: info.nurse.x, y: info.nurse.y, talk: freeze({ x: info.nurseTalk.x, y: info.nurseTalk.y }) }); special.add(key(nurse.talk.x, nurse.talk.y)); }
  const npcs = roomNpcs(m.events.objects, consts.GFX.NURSE, consts.GFX.MON).map((o) => freeze({ gfx: o.gfx, x: o.x, y: o.y, d: o.facing }));
  const stand = (list) => list.filter((s) => ok(s.x, s.y) && !special.has(key(s.x, s.y)));
  const emotes = world.emotes;
  return freeze({
    w: ROOM_W, h: ROOM_H, rows: freeze(rows),
    door: freeze({ x: d0.x, y: d0.y, d: doorDir(d0.behavior, consts.MB) }),
    nurse, pc: freeze(pc), map: freeze(map), signs: freeze(signs), npcs: freeze(npcs),
    spots: freeze(stand(SPOTS)), spawns: freeze(stand(SPAWNS)),
    looks: freeze(world.ow.avatars.slice()), emotes: emotes.length, emoteFrames: freeze(emotes.map((e) => e.frames.length)),
    music: m.music,
  });
}

/**
 * The questions the model asks of a ROOM. grid.walkable(x, y) is the ROM's collision (and reachability); grid.target(x, y) says what a cell IS for a player who taps it or faces it.
 *   walkable(x, y)   can a trainer stand there
 *   isDoor(x, y)     the door mat
 *   thingAt(x, y)    { kind: 'pc' | 'map' | 'sign' | 'nurse', use: { x, y } } for a cell that holds one (the nurse: her own cell and the counter cell in front of her), else null
 *   facing(x, y, d)  what a trainer standing on (x, y) and looking `d` can use with A: a thing's kind, or null. A thing is used from ITS use cell, facing up, and from nowhere else
 *   findPath(from, to, { adjacent })   the shortest walk; see below
 */
export function createGrid(room) {
  const R = room && Array.isArray(room.rows) ? room : { w: ROOM_W, h: ROOM_H, rows: [], door: null, nurse: null, pc: [], map: [], signs: [] };
  const w = R.w, h = R.h;
  const walkable = (x, y) => Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < w && y < h && typeof R.rows[y] === 'string' && R.rows[y][x] === '.';
  const isDoor = (x, y) => !!R.door && R.door.x === x && R.door.y === y;
  const things = new Map();
  const put = (kind, list) => { for (const t of list || []) things.set(key(t.x, t.y), freeze({ kind, use: t.use })); };
  put('pc', R.pc); put('map', R.map); put('sign', R.signs);
  if (R.nurse) {
    const use = R.nurse.talk;
    things.set(key(R.nurse.x, R.nurse.y), freeze({ kind: 'nurse', use }));
    things.set(key(R.nurse.x, R.nurse.y - 1), freeze({ kind: 'nurse', use }));          // (her head: a sprite is two cells tall, and a tap lands on it)
    for (let y = R.nurse.y + 1; y < use.y; y++) things.set(key(R.nurse.x, y), freeze({ kind: 'nurse', use }));          // the counter between her and the trainer: talking is done ACROSS it
  }
  const thingAt = (x, y) => things.get(key(x, y)) || null;
  function facing(x, y, d) {
    if (d !== 'up') return null;
    const f = ahead(x, y, d), t = thingAt(f.x, f.y);
    return t && t.use.x === x && t.use.y === y ? t.kind : null;
  }
  /**
   * The shortest walk (4-way, over cells a trainer can stand on) from `from` to `to`. -> { steps: ['up', ...], face: dir | null } | null (no way).
   * `to` may be a cell that cannot be stood on, or `adjacent` may be asked for (a trainer standing there): the walk then ends on the nearest cell NEXT to it, and `face` is the way to turn
   * to look at it. THE DOOR MAT IS ONLY EVER WALKED ONTO ON PURPOSE (stepping down off it leaves): a walk to anywhere else never crosses it or ends on it.
   */
  function findPath(from, to, { adjacent = false } = {}) {
    if (!from || !to || !walkable(from.x, from.y)) return null;
    const passable = (x, y) => walkable(x, y) && (!isDoor(x, y) || (x === to.x && y === to.y && !adjacent));
    const targets = new Map();                              // 'x,y' -> the direction to face once there (null: the target itself)
    if (passable(to.x, to.y) && !adjacent) targets.set(key(to.x, to.y), null);
    else for (const d of DIRS) { const v = VEC[d], nx = to.x - v[0], ny = to.y - v[1]; if (passable(nx, ny)) targets.set(key(nx, ny), d); }          // standing on (nx, ny) and facing d looks at `to`
    if (!targets.size) return null;
    const start = key(from.x, from.y);
    const prev = new Map([[start, null]]), queue = [[from.x, from.y]];
    while (queue.length) {
      const [x, y] = queue.shift(), k = key(x, y);
      if (targets.has(k)) {
        const steps = [];
        for (let cur = k; prev.get(cur); cur = prev.get(cur).k) steps.unshift(prev.get(cur).d);
        return { steps, face: targets.get(k) };
      }
      for (const d of DIRS) {
        const v = VEC[d], nx = x + v[0], ny = y + v[1], nk = key(nx, ny);
        // (the cell the walk starts on is always left freely: a trainer who stands on the mat can walk off it)
        if (prev.has(nk) || !passable(nx, ny)) continue;
        prev.set(nk, { k, d });
        queue.push([nx, ny]);
      }
    }
    return null;
  }
  return { w, h, walkable, isDoor, thingAt, facing, findPath, cells: () => { const out = []; for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (walkable(x, y)) out.push({ x, y }); return out; } };
}

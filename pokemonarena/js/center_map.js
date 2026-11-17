// pokemonarena/js/center_map.js -- the ROOM of the Trainer Center: which tiles can be walked on, where the furniture is, the benches where trainers who are open somewhere else
// in the Arena are shown sitting, and the shortest walk from one tile to another (a tap on the floor walks there). Pure: no DOM, no clock. center_draw.js paints it.
//
// The room is ONE screen (15 x 10 tiles of 16 px = the 240 x 160 picture of the rest of the Arena), so everybody in it is always in view: nobody is "somewhere off screen".
//
//   #  wall          w  window        M  the wardrobe (change your look)      N  the notice board (Battle online: invite a friend, join a code, battle anyone)
//                                     (both stand against the wall, two tiles tall: you use them from the floor below, facing up)
//   D  counter       X  the healing machine on the counter (it says hello)    P  plant          B  bench (a seat)
//   .  floor         r  rug (floor)                                           E  the door mat: walking onto it leaves the Center

export const TILE = 16, MAP_W = 15, MAP_H = 10;
export const ROWS = Object.freeze([
  '#w##M##w##N#w##',
  '####M#####N####',
  'P....DDXDD....P',
  '...............',
  'B...rrrrrrr...B',
  'B...rrrrrrr...B',
  'B...rrrrrrr...B',
  'B...rrrrrrr...B',
  'PBBB.......BBBP',
  '######EEE######',
]);
export const FLOOR = '.rE';
export const DIRS = Object.freeze(['down', 'up', 'left', 'right']);
export const VEC = Object.freeze({ down: [0, 1], up: [0, -1], left: [-1, 0], right: [1, 0] });
export const SPAWN = Object.freeze({ x: 7, y: 8, d: 'up' });
/** Where a trainer who walks in appears (one is picked at random, so two who come in together do not stand on one tile). */
export const SPAWNS = Object.freeze([[7, 8], [6, 8], [8, 8], [5, 8], [9, 8], [6, 7], [8, 7]].map(([x, y]) => Object.freeze({ x, y, d: 'up' })));
/** Where the trainers who are open somewhere else (the hub, a CPU battle, a listed game) sit: in this order, facing into the room. */
export const SEATS = Object.freeze([
  { x: 0, y: 4, d: 'right' }, { x: 14, y: 4, d: 'left' }, { x: 0, y: 5, d: 'right' }, { x: 14, y: 5, d: 'left' },
  { x: 0, y: 6, d: 'right' }, { x: 14, y: 6, d: 'left' }, { x: 0, y: 7, d: 'right' }, { x: 14, y: 7, d: 'left' },
  { x: 2, y: 8, d: 'up' }, { x: 12, y: 8, d: 'up' }, { x: 1, y: 8, d: 'up' }, { x: 13, y: 8, d: 'up' }, { x: 3, y: 8, d: 'up' }, { x: 11, y: 8, d: 'up' },
].map(Object.freeze));

export function tileAt(x, y) { return Number.isInteger(x) && Number.isInteger(y) && y >= 0 && y < MAP_H && x >= 0 && x < MAP_W ? ROWS[y][x] : '#'; }
export function walkable(x, y) { return FLOOR.includes(tileAt(x, y)); }
export function isExit(x, y) { return tileAt(x, y) === 'E'; }
export function ahead(x, y, d) { const v = VEC[d] || VEC.down; return { x: x + v[0], y: y + v[1] }; }
export function isDir(d) { return DIRS.includes(d); }
/** The piece of furniture on a tile: { kind: 'wardrobe' | 'board' | 'counter' } or null. (A seat is not furniture: who sits on it is the page's business.) */
export function thingAt(x, y) {
  const t = tileAt(x, y);
  if (t === 'M') return { kind: 'wardrobe' };
  if (t === 'N') return { kind: 'board' };
  if (t === 'D' || t === 'X') return { kind: 'counter' };
  return null;
}
/** The furniture is on the wall (rows 0-1) or the counter (row 2): you use it from the tile below, facing up. -> the tile in front of `kind`, or null. */
export function useSpot(kind) {
  for (let y = 0; y < MAP_H; y++) for (let x = 0; x < MAP_W; x++) {
    const th = thingAt(x, y);
    if (th && th.kind === kind) { for (let yy = y + 1; yy < MAP_H; yy++) if (walkable(x, yy)) return { x, y: yy, d: 'up' }; }
  }
  return null;
}
/** A seat at (x, y) -> its index in SEATS, or -1. */
export function seatAt(x, y) { return SEATS.findIndex((s) => s.x === x && s.y === y); }

/**
 * The shortest walk (4-way, floor only) from `from` to `to`. -> an array of directions, [] when already there, or null when there is no way.
 * `to` may be a tile that cannot be stood on (a bench, the counter), or `adjacent` may be asked for (a trainer standing on the floor): the walk then ends on the nearest floor tile NEXT to it,
 * and `face` says which way to turn to look at it.
 * -> { steps: ['up', ...], face: dir | null } | null
 */
export function findPath(from, to, { adjacent = false } = {}) {
  if (!walkable(from.x, from.y)) return null;
  // the door mat is only ever walked onto on purpose (stepping on it asks whether to leave): a walk to anywhere else never crosses it or ends on it
  const passable = (x, y) => walkable(x, y) && (!isExit(x, y) || (x === to.x && y === to.y && !adjacent));
  const targets = new Map();                              // 'x,y' -> the direction to face once there (null = none: the target itself)
  if (passable(to.x, to.y) && !adjacent) targets.set(to.x + ',' + to.y, null);
  else {
    for (const d of DIRS) {
      const v = VEC[d], nx = to.x - v[0], ny = to.y - v[1];                     // standing at (nx, ny) and facing d looks at `to`
      if (passable(nx, ny)) targets.set(nx + ',' + ny, d);
    }
  }
  if (!targets.size) return null;
  const key = (x, y) => x + ',' + y;
  const prev = new Map([[key(from.x, from.y), null]]);
  const q = [[from.x, from.y]];
  while (q.length) {
    const [x, y] = q.shift();
    const k = key(x, y);
    if (targets.has(k)) {
      const steps = [];
      let cur = k;
      while (prev.get(cur)) { const p = prev.get(cur); steps.unshift(p.d); cur = p.k; }
      return { steps, face: targets.get(k) };
    }
    for (const d of DIRS) {
      const v = VEC[d], nx = x + v[0], ny = y + v[1], nk = key(nx, ny);
      if (prev.has(nk) || !passable(nx, ny)) continue;
      prev.set(nk, { k, d });
      q.push([nx, ny]);
    }
  }
  return null;
}

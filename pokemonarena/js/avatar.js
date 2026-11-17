// pokemonarena/js/avatar.js -- the TRAINER AVATAR of the Trainer Center: what a player looks like while they walk around it, and how that look travels in seven characters.
//
// The sprites are ORIGINAL pixel art drawn here from small grids (nothing is read from the ROM): a 16 x 24 trainer seen from the front, the back and the left side (the right side is
// the left one mirrored), standing and two walking steps. The parts the player picks (skin, hair style, hair colour, hat, hat colour, top, trousers) are layered on that body:
// the hair and the hats are PAINTED BY RULE onto the head of each view (a fringe line, how far the sides come down, spikes, a tail), so a new style is a few numbers, not three new grids.
//
// THE CODE. An avatar is seven base-36 digits, one per FIELDS entry, in order ('0371a52'). That string is what the Center's messages carry (`av`), what the board's listing carries,
// and what localStorage keeps (AVATAR_KEY). parseAvatar() is the one gate: anything that is not exactly seven digits each inside its field's range is no avatar at all (null), so a
// stranger's message cannot make this module index past a palette.
//
// Pure apart from drawing: frames() returns plain pixel grids, drawFrame()/sheet() paint them on a 2D context (or an OffscreenCanvas / canvas the caller hands in). Node can run all of it
// except the painting (tools/pokemonarena_center_test.mjs does).

export const AVATAR_KEY = 'arena.avatar';
export const SPRITE_W = 16, SPRITE_H = 24;
export const DIRS = Object.freeze(['down', 'up', 'left', 'right']);

export const SKIN = Object.freeze(['#fbe0c4', '#f2c99c', '#dca676', '#bd8456', '#8f5d38', '#61402a']);
export const HAIR_COLORS = Object.freeze(['#2b2522', '#5b3a24', '#9b5b2c', '#e0b64f', '#ece4d4', '#c83c2c', '#3f63d9', '#3aa65f', '#a352c9', '#f084b2']);
// clothing and hats share one palette
export const CLOTH = Object.freeze(['#d93b3b', '#ec7d2b', '#ecc934', '#4caa4a', '#2a9d9d', '#3d6edb', '#6c4fd9', '#c64fac', '#f2f2f2', '#43434c', '#8c5c3b', '#f28fb0']);
export const CLOTH_NAMES = Object.freeze(['Red', 'Orange', 'Yellow', 'Green', 'Teal', 'Blue', 'Purple', 'Pink', 'White', 'Charcoal', 'Brown', 'Rose']);
export const HAIR_COLOR_NAMES = Object.freeze(['Black', 'Dark brown', 'Auburn', 'Blond', 'Platinum', 'Red', 'Blue', 'Green', 'Violet', 'Pink']);
export const SKIN_NAMES = Object.freeze(['Tone 1', 'Tone 2', 'Tone 3', 'Tone 4', 'Tone 5', 'Tone 6']);
export const HAIR_STYLES = Object.freeze(['Short', 'Spiky', 'Long', 'Ponytail', 'Bob', 'Buzz']);
export const HATS = Object.freeze(['No hat', 'Cap', 'Beanie', 'Bandana', 'Sun hat']);

/** The seven parts, in the order of the code. `names` is what the editor shows for each value. */
export const FIELDS = Object.freeze([
  Object.freeze({ key: 'skin', label: 'Skin', names: SKIN_NAMES }),
  Object.freeze({ key: 'hair', label: 'Hair', names: HAIR_STYLES }),
  Object.freeze({ key: 'hairColor', label: 'Hair colour', names: HAIR_COLOR_NAMES }),
  Object.freeze({ key: 'hat', label: 'Hat', names: HATS }),
  Object.freeze({ key: 'hatColor', label: 'Hat colour', names: CLOTH_NAMES }),
  Object.freeze({ key: 'top', label: 'Top', names: CLOTH_NAMES }),
  Object.freeze({ key: 'legs', label: 'Trousers', names: CLOTH_NAMES }),
]);
export const AV_RE = /^[0-9a-z]{7}$/;
export const DEFAULT_AVATAR = Object.freeze({ skin: 1, hair: 0, hairColor: 1, hat: 1, hatColor: 0, top: 5, legs: 9 });

/** '0371a52' -> { skin, hair, ... } or null. The ONE gate for an avatar from anywhere (a message, storage, the address). */
export function parseAvatar(code) {
  if (typeof code !== 'string' || !AV_RE.test(code)) return null;
  const o = {};
  for (let i = 0; i < FIELDS.length; i++) {
    const v = parseInt(code[i], 36);
    if (!(v >= 0 && v < FIELDS[i].names.length)) return null;
    o[FIELDS[i].key] = v;
  }
  return o;
}
/** { skin, hair, ... } -> '0371a52'. A value out of range is clamped into it (a caller's mistake must not produce a code nobody else will accept). */
export function encodeAvatar(av) {
  const a = av && typeof av === 'object' ? av : DEFAULT_AVATAR;
  return FIELDS.map((f) => { let v = Number.isInteger(a[f.key]) ? a[f.key] : DEFAULT_AVATAR[f.key]; v = Math.max(0, Math.min(f.names.length - 1, v)); return v.toString(36); }).join('');
}
export const DEFAULT_CODE = encodeAvatar(DEFAULT_AVATAR);
/** A random look (random(n) -> n random bytes). */
export function randomAvatar(random) {
  const u = random(FIELDS.length);
  const o = {};
  FIELDS.forEach((f, i) => { o[f.key] = u[i] % f.names.length; });
  return o;
}
/** One field stepped by +1 / -1, wrapping. */
export function stepField(av, key, by) {
  const f = FIELDS.find((x) => x.key === key);
  if (!f) return { ...av };
  const n = f.names.length;
  return { ...av, [key]: (((av[key] + by) % n) + n) % n };
}
/** The stored look of this browser: a code, or null when there is none (or it is junk). Never throws. */
export function loadAvatar(storage) {
  try { const v = storage && storage.getItem(AVATAR_KEY); return parseAvatar(v) ? v : null; } catch (_e) { return null; }
}
export function saveAvatar(storage, code) {
  try { if (!storage || !parseAvatar(code)) return false; storage.setItem(AVATAR_KEY, code); return true; } catch (_e) { return false; }
}
/** Words for an avatar, for a screen reader and a tooltip: "Blond spiky hair, red cap, blue top, charcoal trousers". */
export function describeAvatar(code) {
  const a = parseAvatar(code);
  if (!a) return 'a trainer';
  const hair = HAIR_COLOR_NAMES[a.hairColor].toLowerCase() + ' ' + HAIR_STYLES[a.hair].toLowerCase() + ' hair';
  const hat = a.hat ? ', ' + CLOTH_NAMES[a.hatColor].toLowerCase() + ' ' + HATS[a.hat].toLowerCase() : '';
  return hair.charAt(0).toUpperCase() + hair.slice(1) + hat + ', ' + CLOTH_NAMES[a.top].toLowerCase() + ' top, ' + CLOTH_NAMES[a.legs].toLowerCase() + ' trousers';
}

/* ------------------------------------------------------------------------------------------------ the body */
// k outline   s skin   S skin shade   e eye   t top   T top shade   p trousers   P trousers shade   b shoe   (hair h H and hat c C are painted by rule below)
const HEAD = {
  down: [
    '................',
    '................',
    '.....kkkkkk.....',
    '....kssssssk....',
    '...kssssssssk...',
    '...kssssssssk...',
    '...kssssssssk...',
    '...kssessessk...',
    '...kssessessk...',
    '...kSssssssSk...',
    '....kSssssSk....',
    '.....kkkkkk.....',
  ],
  up: [
    '................',
    '................',
    '.....kkkkkk.....',
    '....kssssssk....',
    '...kssssssssk...',
    '...kssssssssk...',
    '...kssssssssk...',
    '...kssssssssk...',
    '...kssssssssk...',
    '...kSssssssSk...',
    '....kSssssSk....',
    '.....kkkkkk.....',
  ],
  left: [
    '................',
    '................',
    '.....kkkkkk.....',
    '....ksssssssk...',
    '...ksssssssssk..',
    '...ksssssssssk..',
    '..kssssssssssk..',
    '..ksesssssssk...',
    '..ksesssssssk...',
    '...kSssssssSk...',
    '....kSssssSk....',
    '.....kkkkkk.....',
  ],
};
const TORSO = {
  down: [
    '....kttttttk....',
    '...kttttttttk...',
    '..kTttttttttTk..',
    '..kTttttttttTk..',
    '..ksttttttttsk..',
    '...kTTTTTTTTk...',
  ],
  up: [
    '....kttttttk....',
    '...kttttttttk...',
    '..kTttttttttTk..',
    '..kTttTttTttTk..',
    '..ksttttttttsk..',
    '...kTTTTTTTTk...',
  ],
  left: [
    '.....kttttk.....',
    '....kttttttk....',
    '....kttTTttk....',
    '....kttTTttk....',
    '....kttssttk....',
    '....kTTTTTTk....',
  ],
};
const LEGS = {
  down: [
    ['...kppppppppk...', '...kpppkkpppk...', '...kpppkkpppk...', '...kbbbkkbbbk...', '....kkk..kkk....', '................'],
    ['...kppppppppk...', '...kpppkkpppk...', '...kpppkkbbbk...', '...kbbbk.kkk....', '....kkk.........', '................'],
    ['...kppppppppk...', '...kpppkkpppk...', '...kbbbkkpppk...', '....kkk.kbbbk...', '.........kkk....', '................'],
  ],
  up: [
    ['...kppppppppk...', '...kpppkkpppk...', '...kpppkkpppk...', '...kbbbkkbbbk...', '....kkk..kkk....', '................'],
    ['...kppppppppk...', '...kpppkkpppk...', '...kpppkkbbbk...', '...kbbbk.kkk....', '....kkk.........', '................'],
    ['...kppppppppk...', '...kpppkkpppk...', '...kbbbkkpppk...', '....kkk.kbbbk...', '.........kkk....', '................'],
  ],
  left: [
    ['.....kppppk.....', '.....kppppk.....', '.....kpPPpk.....', '....kbbbbbk.....', '....kkkkkk......', '................'],
    ['....kppppppk....', '...kppk.kppk....', '..kbbbk..kppk...', '..kkkk...kbbk...', '..........kk....', '................'],
    ['....kppppppk....', '....kpk.kppk....', '...kbbk..kbbbk..', '...kkk...kkkk...', '................', '................'],
  ],
};
const HEAD_Y = 0, TORSO_Y = 12, LEGS_Y = 18;

function blank() { return Array.from({ length: SPRITE_H }, () => new Array(SPRITE_W).fill('.')); }
function stamp(g, rows, y0) { rows.forEach((r, dy) => { for (let x = 0; x < SPRITE_W; x++) if (r[x] !== '.') g[y0 + dy][x] = r[x]; }); }
const isHead = (c) => c === 's' || c === 'S' || c === 'e';

/* ------------------------------------------------------------------------------------------------ hair, by rule */
// fringe: the last row of hair across the face (front view); side: how far down the hair comes at the edges of the face (front view) and behind the ear (side view);
// back: how far down it comes from behind; wide: the hair stands one pixel out from the head below row 5; spikes, tail: extras.
const STYLE = [
  { fringe: 5, side: 7, back: 9 },                                   // Short
  { fringe: 5, side: 6, back: 9, spikes: true },                     // Spiky
  { fringe: 5, side: 13, back: 14, wide: true },                     // Long
  { fringe: 5, side: 7, back: 9, tail: true },                       // Ponytail
  { fringe: 6, side: 10, back: 10, wide: true },                     // Bob
  { fringe: 3, side: 4, back: 6 },                                   // Buzz
];
function paintHair(g, dir, style) {
  const st = STYLE[style] || STYLE[0];
  const H = (x, y, shade) => { if (y >= 0 && y < SPRITE_H && x >= 0 && x < SPRITE_W) g[y][x] = shade ? 'H' : 'h'; };
  const headCols = (y) => { const xs = []; for (let x = 0; x < SPRITE_W; x++) if (isHead(g[y][x])) xs.push(x); return xs; };
  for (let y = 2; y <= 11; y++) {
    const xs = headCols(y);
    if (!xs.length) continue;
    const lo = xs[0], hi = xs[xs.length - 1];
    for (const x of xs) {
      let hair = false;
      if (dir === 'up') hair = y <= st.back;
      else if (dir === 'down') hair = y <= st.fringe || ((st.wide ? x <= lo || x >= hi : x <= lo + 1 || x >= hi - 1) && y <= st.side);
      else hair = y <= st.fringe || (x >= hi - 3 && y <= st.side + 1);                          // facing left: the back of the head is on the right
      if (hair) H(x, y, y === (dir === 'up' ? st.back : st.fringe) && dir !== 'up');
    }
  }
  if (st.wide) {
    for (let y = 5; y <= Math.min(st.side, 14); y++) {
      if (dir === 'down' || dir === 'up') { H(2, y, y === st.side); H(3, y); H(12, y); H(13, y, y === st.side); }
      else { H(11, y); H(12, y, y === st.side); }
      if (dir === 'up') for (let x = 3; x <= 12; x++) if (y >= 11 && y <= st.back) H(x, y, y === st.back);
    }
  }
  if (st.spikes) {
    const tops = dir === 'left' ? [4, 7, 10] : [4, 7, 10];
    for (const x of tops) { H(x, 1); H(x + 1, 1); H(x + 1, 0); }
    if (dir !== 'left') { H(3, 3); H(12, 3); }
    else H(12, 3);
  }
  if (st.tail) {
    if (dir === 'up') { for (let y = 7; y <= 13; y++) { H(7, y, y === 13); H(8, y, y === 13); } }
    else if (dir === 'left') { for (let y = 5; y <= 11; y++) { H(13, y, y === 11); H(14, y, y >= 10); } }
    else { H(12, 4); H(13, 5); H(13, 6, true); }
  }
}
/* ------------------------------------------------------------------------------------------------ hats, by rule */
function paintHat(g, dir, hat) {
  if (!hat) return;
  const C = (x, y, shade) => { if (y >= 0 && y < SPRITE_H && x >= 0 && x < SPRITE_W) g[y][x] = shade ? 'C' : 'c'; };
  const W = (x, y) => { if (y >= 0 && y < SPRITE_H && x >= 0 && x < SPRITE_W) g[y][x] = 'w'; };
  const span = (y, a, b, shade) => { for (let x = a; x <= b; x++) C(x, y, shade); };
  if (hat === 1) {                                     // cap
    span(1, 5, 10); span(2, 4, 11); span(3, 3, 12); span(4, 3, 12, true);
    if (dir === 'down') { span(5, 2, 13, true); W(7, 2); W(8, 2); }
    else if (dir === 'left') { span(4, 0, 4, true); span(5, 0, 3, true); W(6, 2); }
  } else if (hat === 2) {                              // beanie with a pom
    W(7, 0); W(8, 0); span(1, 5, 10); span(2, 4, 11); span(3, 3, 12); span(4, 3, 12); span(5, 3, 12, true);
    for (let x = 4; x <= 11; x += 2) C(x, 3, true);
  } else if (hat === 3) {                              // bandana
    span(4, 3, 12); span(5, 3, 12, true);
    if (dir === 'left') { C(13, 5); C(14, 6, true); C(13, 7, true); }
    else if (dir === 'up') { C(7, 6); C(8, 6); C(7, 7, true); C(9, 7, true); }
  } else if (hat === 4) {                              // sun hat: a wide brim
    span(0, 6, 9); span(1, 5, 10); span(2, 4, 11); span(3, 4, 11, true);
    span(4, 1, 14); span(5, 2, 13, true);
    W(4, 3); W(11, 3);
    for (let x = 5; x <= 10; x++) g[3][x] = 'w';
  }
}
/* ------------------------------------------------------------------------------------------------ frames */
const cache = new Map();
/** The pixel grid of one frame: dir 'down' | 'up' | 'left' | 'right', step 0 (standing) | 1 | 2. Grid cells are palette letters ('.' = clear). Cached per (code, dir, step). */
export function frameGrid(code, dir, step) {
  const key = code + dir + step;
  if (cache.has(key)) return cache.get(key);
  const a = parseAvatar(code) || DEFAULT_AVATAR;
  const view = dir === 'right' ? 'left' : dir;
  const g = blank();
  stamp(g, HEAD[view], HEAD_Y);
  stamp(g, TORSO[view], TORSO_Y);
  stamp(g, LEGS[view][step % 3], LEGS_Y);
  if (!(a.hat === 4 || a.hat === 2) || a.hair === 2 || a.hair === 3 || a.hair === 4) paintHair(g, view, a.hair);
  else paintHair(g, view, 5);                          // a beanie or a sun hat hides all but a buzz's worth
  paintHat(g, view, a.hat);
  outline(g);
  const out = dir === 'right' ? g.map((r) => r.slice().reverse()) : g;
  if (cache.size > 2000) cache.clear();
  cache.set(key, out);
  return out;
}
/** Hair and hats that stand outside the body get an outline too: every clear cell next to a hair or hat cell becomes 'k'. */
function outline(g) {
  const add = [];
  for (let y = 0; y < SPRITE_H; y++) for (let x = 0; x < SPRITE_W; x++) {
    if (g[y][x] !== '.') continue;
    const n = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => { const c = (g[y + dy] || [])[x + dx]; return c === 'h' || c === 'H' || c === 'c' || c === 'C'; });
    if (n) add.push([x, y]);
  }
  for (const [x, y] of add) g[y][x] = 'k';
}
const shade = (hex, f) => {
  const n = parseInt(hex.slice(1), 16), r = n >> 16, gg = (n >> 8) & 255, b = n & 255;
  const m = (v) => Math.max(0, Math.min(255, Math.round(v * f)));
  return '#' + ((1 << 24) | (m(r) << 16) | (m(gg) << 8) | m(b)).toString(16).slice(1);
};
/** letter -> CSS colour for one avatar. */
export function paletteOf(code) {
  const a = parseAvatar(code) || DEFAULT_AVATAR;
  const top = CLOTH[a.top], legs = CLOTH[a.legs], hat = CLOTH[a.hatColor], hair = HAIR_COLORS[a.hairColor], skin = SKIN[a.skin];
  return { k: '#1b1820', s: skin, S: shade(skin, 0.82), e: '#1b1820', t: top, T: shade(top, 0.74), p: legs, P: shade(legs, 0.72), b: '#2c2830', h: hair, H: shade(hair, 0.7), c: hat, C: shade(hat, 0.72), w: '#f4f4f4' };
}
/** Paint one frame at (x, y) in the context's current units, `px` units per sprite pixel. */
export function drawFrame(ctx, code, dir, step, x, y, px = 1) {
  const g = frameGrid(code, dir, step), pal = paletteOf(code);
  for (let r = 0; r < SPRITE_H; r++) {
    const row = g[r];
    for (let c = 0; c < SPRITE_W; c++) {
      const ch = row[c];
      if (ch === '.') continue;
      ctx.fillStyle = pal[ch];
      ctx.fillRect(x + c * px, y + r * px, px, px);
    }
  }
}

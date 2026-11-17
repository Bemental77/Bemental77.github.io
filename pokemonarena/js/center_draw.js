// pokemonarena/js/center_draw.js -- PAINTS the Trainer Center: the room (original art, drawn here with rectangles and arcs: nothing is read from the ROM), the trainers walking in
// it, the ones sitting on the benches, their names, their emotes, and the one line at the bottom that says what A does right now.
//
// The room is 240 x 160 logical pixels (15 x 10 tiles, center_map.js), drawn at SCALE device-independent pixels per logical pixel on the canvas, so the pixel art is sharp and the
// names (real text) are readable at any size the page gives the canvas. The room itself never changes, so it is painted once into its own canvas and copied every frame; each
// trainer's frames are painted once per look into a small canvas too.

import { TILE, MAP_W, MAP_H, ROWS } from './center_map.js';
import { drawFrame, SPRITE_W, SPRITE_H } from './avatar.js';
import { EMOTES } from './center_net.js';

export const SCALE = 4;
export const VIEW_W = MAP_W * TILE, VIEW_H = MAP_H * TILE;

const C = {
  floor: '#efe5cb', floorLine: '#ddcfa9', floorDot: '#e6d9b6',
  wall: '#6eaacb', wallDark: '#4d84a6', wallTrim: '#2e4d66', wallLight: '#9cc8de',
  glass: '#bfe6f6', glassHi: '#eaf8ff', frame: '#f5f2ea',
  rug: '#b8434a', rugDark: '#933238', rugEdge: '#e8bf52', ring: '#f6e9d0',
  wood: '#a8723f', woodDark: '#7a5230', woodLight: '#c99159',
  counterTop: '#fbfbf7', counterFront: '#3e8fb1', counterDark: '#2a6380', counterStripe: '#f2f2f2',
  pot: '#b8673b', potDark: '#8a4a29', leaf: '#45a052', leafDark: '#2f7a3b', leafLight: '#7fcf6a',
  cork: '#c99a5b', corkDark: '#a87c43', paper: ['#fffdf4', '#fff3a8', '#ffd3e2', '#cfe9ff'],
  mat: '#7d6248', matDark: '#5e4834', matLight: '#a4876a',
  outline: '#1b1820', shadow: 'rgba(30, 24, 20, .22)',
};

/** Paint the room into `ctx` (logical units already scaled by the caller). */
export function paintRoom(ctx) {
  const R = (x, y, w, h, c) => { ctx.fillStyle = c; ctx.fillRect(x, y, w, h); };
  // floor everywhere first (the furniture sits on it)
  for (let ty = 0; ty < MAP_H; ty++) for (let tx = 0; tx < MAP_W; tx++) {
    const x = tx * TILE, y = ty * TILE;
    R(x, y, TILE, TILE, C.floor);
    R(x, y + TILE - 1, TILE, 1, C.floorLine); R(x + TILE - 1, y, 1, TILE, C.floorLine);
    if ((tx + ty) % 2 === 0) { R(x + 4, y + 4, 2, 2, C.floorDot); R(x + 10, y + 10, 2, 2, C.floorDot); }
  }
  // the back wall: rows 0-1
  R(0, 0, VIEW_W, 2 * TILE, C.wall);
  R(0, 0, VIEW_W, 3, C.wallTrim);
  for (let x = 0; x < VIEW_W; x += 8) R(x, 17, 1, 11, C.wallLight);
  R(0, 16, VIEW_W, 1, C.wallDark);
  R(0, 2 * TILE - 4, VIEW_W, 4, C.wallDark);
  R(0, 2 * TILE - 1, VIEW_W, 1, C.wallTrim);
  // a strip of floor shadow under the wall
  R(0, 2 * TILE, VIEW_W, 2, C.shadow);
  // the bottom wall (row 9) with the door
  R(0, 9 * TILE, VIEW_W, TILE, C.wallDark);
  R(0, 9 * TILE, VIEW_W, 3, C.wallTrim);
  R(0, 9 * TILE + 3, VIEW_W, 2, C.wallLight);
  for (let ty = 0; ty < MAP_H; ty++) for (let tx = 0; tx < MAP_W; tx++) {
    const t = ROWS[ty][tx], x = tx * TILE, y = ty * TILE;
    if (t === 'w') window_(R, x, y);
    else if (t === 'M' && ty === 0) wardrobe(R, x, y);
    else if (t === 'N' && ty === 0) board(R, x, y);
    else if (t === 'P') plant(R, x, y);
    else if (t === 'B') bench(R, x, y, ty === 8);
    else if (t === 'E') mat(R, x, y);
  }
  rug(R, ctx);
  counter(R, ctx);
  clock(R, ctx);
}
function window_(R, x, y) {
  R(x + 1, y + 4, 14, 22, C.frame);
  R(x + 3, y + 6, 10, 18, C.glass);
  R(x + 4, y + 7, 3, 8, C.glassHi); R(x + 8, y + 7, 1, 5, C.glassHi);
  R(x + 7, y + 6, 2, 18, C.frame); R(x + 3, y + 14, 10, 2, C.frame);
  R(x, y + 26, 16, 2, C.wallTrim);
}
function wardrobe(R, x, y) {
  R(x - 3, y + 1, 22, 31, C.outline);
  R(x - 2, y + 2, 20, 29, C.wood);
  R(x - 2, y + 2, 20, 3, C.woodLight);
  R(x + 1, y + 6, 14, 22, C.woodDark);
  R(x + 2, y + 7, 12, 20, '#cfeaf5');                      // the mirror
  R(x + 3, y + 8, 3, 10, '#f4fcff'); R(x + 7, y + 8, 1, 6, '#f4fcff');
  R(x + 2, y + 23, 12, 4, '#a9d3e4');
  R(x - 1, y + 30, 18, 1, C.woodDark);
}
function board(R, x, y) {
  R(x - 3, y + 4, 22, 22, C.outline);
  R(x - 2, y + 5, 20, 20, C.woodDark);
  R(x, y + 7, 16, 16, C.cork);
  for (let i = 0; i < 6; i++) R(x + ((i * 5) % 14), y + 8 + ((i * 7) % 12), 1, 1, C.corkDark);
  const notes = [[1, 8, 6, 6, 0], [9, 9, 6, 5, 1], [2, 15, 5, 6, 2], [8, 16, 7, 6, 3]];
  for (const [nx, ny, w, h, c] of notes) { R(x + nx, y + ny, w, h, C.paper[c]); R(x + nx + 1, y + ny + 2, w - 2, 1, '#9aa'); R(x + nx + 1, y + ny + 4, w - 3, 1, '#9aa'); R(x + nx + (w >> 1), y + ny, 1, 1, '#d33'); }
}
function plant(R, x, y) {
  R(x + 3, y + 9, 10, 7, C.potDark); R(x + 4, y + 9, 8, 6, C.pot); R(x + 3, y + 8, 10, 2, C.potDark);
  R(x + 2, y + 1, 12, 8, C.leafDark); R(x + 4, y - 2, 8, 5, C.leafDark);
  R(x + 3, y + 2, 10, 6, C.leaf); R(x + 5, y - 1, 6, 4, C.leaf);
  R(x + 5, y + 2, 2, 2, C.leafLight); R(x + 9, y + 4, 2, 2, C.leafLight); R(x + 7, y, 2, 2, C.leafLight);
}
function bench(R, x, y, front) {
  if (front) { R(x, y + 5, 16, 8, C.woodDark); R(x, y + 5, 16, 5, C.wood); R(x, y + 5, 16, 1, C.woodLight); R(x + 2, y + 13, 2, 3, C.woodDark); R(x + 12, y + 13, 2, 3, C.woodDark); }
  else { R(x + 2, y, 11, 16, C.woodDark); R(x + 3, y, 9, 15, C.wood); R(x + 3, y, 1, 15, C.woodLight); R(x + 3, y + 7, 9, 1, C.woodDark); }
}
function mat(R, x, y) {
  R(x, y + 3, 16, 13, C.matDark); R(x + 1, y + 4, 14, 11, C.mat);
  R(x + 7, y + 6, 2, 6, C.matLight); R(x + 5, y + 10, 6, 2, C.matLight); R(x + 6, y + 12, 4, 1, C.matLight);
}
function rug(R, ctx) {
  const x0 = 4 * TILE, y0 = 4 * TILE, w = 7 * TILE, h = 4 * TILE;
  R(x0, y0, w, h, C.rugEdge); R(x0 + 2, y0 + 2, w - 4, h - 4, C.rug); R(x0 + 4, y0 + 4, w - 8, h - 8, C.rugDark); R(x0 + 5, y0 + 5, w - 10, h - 10, C.rug);
  R(x0 + w / 2 - 1, y0 + 5, 2, h - 10, C.ring);
  ctx.strokeStyle = C.ring; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(x0 + w / 2, y0 + h / 2, 13, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = C.ring; ctx.beginPath(); ctx.arc(x0 + w / 2, y0 + h / 2, 3, 0, Math.PI * 2); ctx.fill();
}
function counter(R, ctx) {
  const x0 = 5 * TILE, y0 = 2 * TILE, w = 5 * TILE;
  R(x0 - 1, y0 - 2, w + 2, 17, C.outline);
  R(x0, y0 - 1, w, 6, C.counterTop);
  R(x0, y0 + 5, w, 9, C.counterFront);
  R(x0, y0 + 8, w, 2, C.counterStripe);
  R(x0, y0 + 13, w, 1, C.counterDark);
  R(x0 - 1, y0 + 15, w + 2, 2, C.shadow);
  // the healing machine: a rounded console with a green cross on its screen
  const mx = 7 * TILE + 1, my = y0 - 12;
  R(mx, my, 14, 13, C.outline); R(mx + 1, my + 1, 12, 11, '#d9dde2'); R(mx + 1, my + 1, 12, 2, '#f3f5f7');
  R(mx + 3, my + 4, 8, 6, '#1f3a2a'); R(mx + 6, my + 5, 2, 4, '#5df07a'); R(mx + 5, my + 6, 4, 2, '#5df07a');
  ctx.fillStyle = '#ffd34d'; ctx.fillRect(mx + 11, my + 2, 1, 1);
}
function clock(R, ctx) {
  const cx = 2 * TILE + 8, cy = 12;
  ctx.fillStyle = C.outline; ctx.beginPath(); ctx.arc(cx, cy, 7, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = C.frame; ctx.beginPath(); ctx.arc(cx, cy, 6, 0, Math.PI * 2); ctx.fill();
  R(cx, cy - 4, 1, 4, C.outline); R(cx, cy, 3, 1, C.outline);
}

/* ------------------------------------------------------------------------------------------------ the painter */

/**
 * canvas: the page's canvas (its width / height are set here: VIEW_W * SCALE by VIEW_H * SCALE).
 * -> { draw(view), hitTrainer(list, lx, ly) }
 * view = {
 *   people: [{ id, fx, fy, d, step, av, name, sub?, emote?, me?, dim?, seated? }],   fx / fy in TILES (fractions while walking)
 *   target: { x, y } | null        the tile A would act on (a corner marker is drawn there)
 *   dest:   { x, y } | null        where a tap is walking to
 *   title:  string                 the line at the top left (what A does is the page's own line under the picture: real text, readable at any size)
 *   textScale: number              >= 1: names and bubbles are drawn this much larger (a small screen: the page works it out from the size the canvas is shown at)
 *   t:      ms (for the little animations)
 * }
 */
export function createPainter(canvas, { doc = globalThis.document } = {}) {
  canvas.width = VIEW_W * SCALE; canvas.height = VIEW_H * SCALE;
  const ctx = canvas.getContext('2d');
  const mk = (w, h) => { const c = doc.createElement('canvas'); c.width = w; c.height = h; return c; };
  const room = mk(VIEW_W * SCALE, VIEW_H * SCALE);
  { const r = room.getContext('2d'); r.imageSmoothingEnabled = false; r.setTransform(SCALE, 0, 0, SCALE, 0, 0); paintRoom(r); }
  const sprites = new Map();                       // code+dir+step -> canvas
  const spriteOf = (av, d, step) => {
    const k = av + d + step;
    let c = sprites.get(k);
    if (!c) {
      if (sprites.size > 1500) sprites.clear();
      c = mk(SPRITE_W * SCALE, SPRITE_H * SCALE);
      drawFrame(c.getContext('2d'), av, d, step, 0, 0, SCALE);
      sprites.set(k, c);
    }
    return c;
  };
  const font = (px, weight = 600) => weight + ' ' + px + 'px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
  function pill(text, cx, y, { bg = 'rgba(16, 16, 22, .78)', fg = '#fff', size = 5.2 * SCALE, pad = 1.6 * SCALE } = {}) {
    ctx.font = font(size);
    const w = ctx.measureText(text).width + pad * 2, h = size + pad * 1.2;
    let x = cx - w / 2;
    x = Math.max(2, Math.min(canvas.width - w - 2, x));
    ctx.fillStyle = bg; roundRect(x, y - h, w, h, h / 2); ctx.fill();
    ctx.fillStyle = fg; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    ctx.fillText(text, x + pad, y - h / 2 + 0.5);
    return h;
  }
  function roundRect(x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
  function bubble(text, cx, y, ts = 1) {
    ctx.font = font(6.5 * SCALE * ts, 700);
    const w = Math.max(10 * SCALE * ts, ctx.measureText(text).width + 4 * SCALE * ts), h = 9 * SCALE * ts;
    const x = Math.max(2, Math.min(canvas.width - w - 2, cx - w / 2));
    ctx.fillStyle = '#fff'; ctx.strokeStyle = C.outline; ctx.lineWidth = SCALE * 0.75;
    roundRect(x, y - h, w, h, 3 * SCALE); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx - 2 * SCALE, y - 0.5); ctx.lineTo(cx, y + 2.5 * SCALE); ctx.lineTo(cx + 2 * SCALE, y - 0.5); ctx.closePath(); ctx.fill();
    ctx.fillStyle = C.outline; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, x + w / 2, y - h / 2 + 0.5);
    ctx.textAlign = 'left';
  }
  function corners(x, y, t) {
    const s = SCALE, p = (Math.sin(t / 160) + 1) * 0.5 * s, X = x * TILE * s, Y = y * TILE * s, L = 4 * s, W = TILE * s;
    ctx.fillStyle = '#ffd34d';
    for (const [ax, ay, dx, dy] of [[X - p, Y - p, 1, 1], [X + W + p, Y - p, -1, 1], [X - p, Y + W + p, 1, -1], [X + W + p, Y + W + p, -1, -1]]) {
      ctx.fillRect(dx > 0 ? ax : ax - L, dy > 0 ? ay : ay - s, L, s);
      ctx.fillRect(dx > 0 ? ax : ax - s, dy > 0 ? ay : ay - L, s, L);
    }
  }
  function draw(view) {
    const s = SCALE, t = view.t || 0, ts = Math.max(1, Math.min(2, view.textScale || 1));
    ctx.imageSmoothingEnabled = false;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(room, 0, 0);
    if (view.dest) { ctx.fillStyle = 'rgba(255, 211, 77, .55)'; ctx.beginPath(); ctx.arc((view.dest.x + 0.5) * TILE * s, (view.dest.y + 0.6) * TILE * s, 3 * s, 0, Math.PI * 2); ctx.fill(); }
    if (view.target) corners(view.target.x, view.target.y, t);
    const people = view.people.slice().sort((a, b) => a.fy - b.fy || (a.me ? 1 : 0) - (b.me ? 1 : 0));
    for (const p of people) {
      const x = Math.round(p.fx * TILE * s), y = Math.round((p.fy * TILE - (SPRITE_H - TILE)) * s) - (p.step ? s : 0);
      ctx.fillStyle = C.shadow; ctx.beginPath(); ctx.ellipse(x + 8 * s, (p.fy + 1) * TILE * s - 2 * s, 6 * s, 2 * s, 0, 0, Math.PI * 2); ctx.fill();
      if (p.dim) ctx.globalAlpha = 0.72;
      ctx.drawImage(spriteOf(p.av, p.d, p.step || 0), x, y);
      ctx.globalAlpha = 1;
    }
    // names (and what each trainer is doing) above the heads, after every sprite so no sprite covers a name
    for (const p of people) {
      const cx = Math.round((p.fx + 0.5) * TILE * s), top = Math.round((p.fy * TILE - (SPRITE_H - TILE)) * s);
      const h = pill(p.me ? p.name + ' (you)' : p.name, cx, top + s, { size: 5.2 * s * ts, pad: 1.6 * s * ts, ...(p.me ? { bg: 'rgba(40, 70, 120, .88)' } : {}) });
      let above = top + s - h - s;
      if (p.sub) { const h2 = pill(p.sub, cx, above, { size: 4.4 * s * ts, pad: 1.4 * s * ts, bg: p.subBg || 'rgba(31, 90, 55, .9)' }); above -= h2 + s; }
      if (p.emote && EMOTES[p.emote.e] !== undefined) bubble(EMOTES[p.emote.e], cx, above - s, ts);
    }
    // where you are, on the wall at the top left (the floor and the door stay clear)
    if (view.title) pill(view.title, 0, 3 * s + 6 * s * ts, { size: 5 * s * ts, pad: 2 * s * ts, bg: 'rgba(14, 18, 28, .84)', fg: '#cfe6fa' });
  }
  return { draw, ctx };
}

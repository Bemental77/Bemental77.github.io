// tools/pokemonarena_fidelity_lib.mjs -- shared helpers of the FIDELITY stage (FA1): load the ROM, build the arena's battle UI, render a view,
// diff two 240x160 RGBA frames by region, and write side-by-side contact sheets. Test/tooling only (Node); nothing in pokemonarena/js imports it.
// It holds layout rectangles, code and nothing ROM-derived: frames are made at run time from the ROM the caller points at, and every PNG goes to
// a scratch directory the caller names (ROM frames are never committed).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writePNG, scaleRGBA } from './arena_png.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');
export const ROM_PATH = process.env.ARENA_ROM || path.join(ROOT, 'gba', 'gbaWasm', 'roms', 'Pokemon SoulGold (v1.1.1).gba');
export const romAvailable = () => { try { return fs.statSync(ROM_PATH).size === 33554432; } catch (_e) { return false; } };
export function loadRom() { const b = fs.readFileSync(ROM_PATH); return new Uint8Array(b.buffer, b.byteOffset, b.length); }
export const sha1 = (...parts) => { const h = crypto.createHash('sha1'); for (const p of parts) h.update(p); return h.digest('hex'); };
export const importArena = (name) => import(pathToFileURL(path.join(ROOT, 'pokemonarena', 'js', name)).href);

export const W = 240, H = 160;
export const rect = (x, y, w, h) => ({ x, y, w, h });

// RGBA of a 240x160 frame as 0xRRGGBB ints (alpha ignored)
export const px = (f, x, y) => { const o = (y * W + x) * 4; return (f[o] << 16) | (f[o + 1] << 8) | f[o + 2]; };

// count of differing pixels inside `r` (and the bounding box of the differences). Frames are Uint8Array/Uint8ClampedArray RGBA, 240x160.
export function diffRegion(a, b, r = rect(0, 0, W, H), opts = {}) {
  const ignore = opts.ignore || [];
  let n = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
  for (let y = r.y; y < Math.min(H, r.y + r.h); y++) for (let x = r.x; x < Math.min(W, r.x + r.w); x++) {
    if (ignore.some((g) => x >= g.x && y >= g.y && x < g.x + g.w && y < g.y + g.h)) continue;
    if (px(a, x, y) !== px(b, x, y)) { n++; if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
  }
  return { count: n, total: r.w * r.h, bbox: n ? { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } : null };
}

// RGBA diff image: identical pixels dimmed, different ones magenta
export function diffImage(a, b) {
  const out = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const o = i * 4, same = a[o] === b[o] && a[o + 1] === b[o + 1] && a[o + 2] === b[o + 2];
    if (same) { out[o] = a[o] >> 2; out[o + 1] = a[o + 1] >> 2; out[o + 2] = a[o + 2] >> 2; } else { out[o] = 255; out[o + 1] = 0; out[o + 2] = 255; }
    out[o + 3] = 255;
  }
  return out;
}

// side-by-side contact sheet: [real | arena | diff] x scale, one row per entry {label, real, arena}; written to `file`. Returns the file path.
export function contactSheet(file, rows, scale = 2) {
  const cols = 3, gap = 4, cw = W * scale, ch = H * scale;
  const sw = cols * cw + (cols + 1) * gap, sh = rows.length * (ch + gap) + gap;
  const sheet = new Uint8Array(sw * sh * 4); for (let i = 0; i < sw * sh; i++) { sheet[i * 4] = 40; sheet[i * 4 + 1] = 40; sheet[i * 4 + 2] = 48; sheet[i * 4 + 3] = 255; }
  const put = (src, cx, cy) => { const s = scaleRGBA(W, H, src, scale).rgba; for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) { const o = ((cy + y) * sw + cx + x) * 4, i = (y * cw + x) * 4; sheet[o] = s[i]; sheet[o + 1] = s[i + 1]; sheet[o + 2] = s[i + 2]; sheet[o + 3] = 255; } };
  rows.forEach((r, i) => { const y = gap + i * (ch + gap); put(r.real, gap, y); put(r.arena, gap * 2 + cw, y); put(diffImage(r.real, r.arena), gap * 3 + cw * 2, y); });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writePNG(file, sw, sh, sheet);
  return file;
}
export function savePng(file, rgba, scale = 1) { fs.mkdirSync(path.dirname(file), { recursive: true }); const s = scale === 1 ? rgba : scaleRGBA(W, H, rgba, scale).rgba; writePNG(file, W * scale, H * scale, s); return file; }

// The regions of the battle screen (screen pixels). Healthbox rectangles are the bounding areas of the real game's two healthbox sprites.
export const REGIONS = {
  foeBox: rect(0, 14, 104, 36), playerBox: rect(124, 72, 116, 48), textBox: rect(0, 112, 240, 48),
  foeSprite: rect(112, 8, 96, 80), playerSprite: rect(24, 40, 96, 80), screen: rect(0, 0, W, H),
};

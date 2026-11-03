// tools/arena_png.mjs - TEST-ONLY helpers for pokemonarena: a dependency-free PNG writer plus the small
// raster helpers the asset tests use to dump contact sheets (scale, grid, blit). Node only (node:zlib/node:fs);
// nothing in pokemonarena/js imports this.
//
//   import { writePNG, encodePNG, scaleRGBA, newCanvas, blit, fillRect } from './arena_png.mjs';
//   writePNG('out.png', w, h, rgba)            // rgba: Uint8Array/Buffer of w*h*4 (straight alpha)
//
// Ported from the research scratch writer (B1b-rom-assets/png.mjs); same output, typed-array API.
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

// rgba: w*h*4 bytes -> PNG file bytes (8-bit RGBA, no interlace, filter 0).
export function encodePNG(w, h, rgba) {
  if (rgba.length !== w * h * 4) throw new Error('encodePNG: rgba length ' + rgba.length + ' != ' + w * h * 4);
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function writePNG(file, w, h, rgba) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, encodePNG(w, h, rgba));
  return file;
}

// Nearest-neighbour integer upscale.
export function scaleRGBA(w, h, rgba, k) {
  const out = new Uint8Array(w * k * h * k * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4;
      for (let dy = 0; dy < k; dy++) {
        for (let dx = 0; dx < k; dx++) {
          const d = ((y * k + dy) * w * k + x * k + dx) * 4;
          out[d] = rgba[s]; out[d + 1] = rgba[s + 1]; out[d + 2] = rgba[s + 2]; out[d + 3] = rgba[s + 3];
        }
      }
    }
  }
  return { width: w * k, height: h * k, rgba: out };
}

// A mutable RGBA canvas filled with a solid colour (default opaque mid-gray so transparent index-0 pixels
// are visibly distinct from black and white art).
export function newCanvas(w, h, bg = [96, 96, 112, 255]) {
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) { rgba[4 * i] = bg[0]; rgba[4 * i + 1] = bg[1]; rgba[4 * i + 2] = bg[2]; rgba[4 * i + 3] = bg[3]; }
  return { width: w, height: h, rgba };
}

export function fillRect(c, x0, y0, w, h, col) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
    if (x < 0 || y < 0 || x >= c.width || y >= c.height) continue;
    const o = (y * c.width + x) * 4;
    c.rgba[o] = col[0]; c.rgba[o + 1] = col[1]; c.rgba[o + 2] = col[2]; c.rgba[o + 3] = col[3] === undefined ? 255 : col[3];
  }
}

// Alpha-blit a source RGBA (sw x sh) onto the canvas at (dx, dy). Alpha 0 pixels are skipped, others replace.
export function blit(c, dx, dy, sw, sh, src) {
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const s = (y * sw + x) * 4;
      if (src[s + 3] === 0) continue;
      const X = dx + x, Y = dy + y;
      if (X < 0 || Y < 0 || X >= c.width || Y >= c.height) continue;
      const o = (Y * c.width + X) * 4;
      c.rgba[o] = src[s]; c.rgba[o + 1] = src[s + 1]; c.rgba[o + 2] = src[s + 2]; c.rgba[o + 3] = 255;
    }
  }
}

// Lay `items` ({width,height,rgba}) out in a grid `cols` wide with `pad` px gutters, each cell scaled by `k`.
export function gridSheet(items, cols, k = 1, pad = 4, bg) {
  const sc = items.map((it) => (k === 1 ? it : scaleRGBA(it.width, it.height, it.rgba, k)));
  const cw = Math.max(...sc.map((s) => s.width)), ch = Math.max(...sc.map((s) => s.height));
  const rows = Math.ceil(sc.length / cols);
  const c = newCanvas(cols * (cw + pad) + pad, rows * (ch + pad) + pad, bg);
  sc.forEach((s, i) => blit(c, pad + (i % cols) * (cw + pad), pad + Math.floor(i / cols) * (ch + pad), s.width, s.height, s.rgba));
  return c;
}

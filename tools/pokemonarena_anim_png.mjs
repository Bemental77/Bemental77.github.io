// tools/pokemonarena_anim_png.mjs -- a tiny PNG writer + labelled contact-sheet builder for the animation engine's scratch renders.
// Node only (node:zlib). Hand-written; contains no ROM data. The sheets it writes are scratch output, never committed.
//
//   import { writePng, contactSheet, drawText } from './pokemonarena_anim_png.mjs';
//   writePng('out.png', width, height, rgba);
//   const sheet = contactSheet(frames /* [{rgba, label}] of 240x160 */, { cols: 6, scale: 1 }); writePng('sheet.png', sheet.width, sheet.height, sheet.rgba);
import fs from 'node:fs';
import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0); out.write(type, 4, 'latin1'); data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
export function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}
export function writePng(path, width, height, rgba) { fs.writeFileSync(path, encodePng(width, height, rgba)); }

// 3x5 pixel font for labels (digits, upper-case letters and a few symbols); each glyph is 5 rows of 3 bits
const FONT = {
  '0': '111101101101111', '1': '010110010010111', '2': '111001111100111', '3': '111001111001111', '4': '101101111001001',
  '5': '111100111001111', '6': '111100111101111', '7': '111001001001001', '8': '111101111101111', '9': '111101111001111',
  A: '111101111101101', B: '110101110101110', C: '111100100100111', D: '110101101101110', E: '111100110100111', F: '111100110100100',
  G: '111100101101111', H: '101101111101101', I: '111010010010111', J: '001001001101111', K: '101101110101101', L: '100100100100111',
  M: '101111111101101', N: '110101101101101', O: '111101101101111', P: '111101111100100', Q: '111101101111001', R: '110101110101101',
  S: '111100111001111', T: '111010010010010', U: '101101101101111', V: '101101101101010', W: '101101111111101', X: '101101010101101',
  Y: '101101010010010', Z: '111001010100111', '-': '000000111000000', '_': '000000000000111', '.': '000000000000010', ':': '000010000010000',
  '/': '001001010100100', ' ': '000000000000000', '=': '000111000111000', '+': '000010111010000', '#': '101111101111101', '(': '010100100100010', ')': '010001001001010',
};
export function drawText(rgba, W, H, x, y, text, color = [255, 255, 255], scale = 1) {
  let cx = x;
  for (const chRaw of String(text).toUpperCase()) {
    const g = FONT[chRaw] || FONT[' '];
    for (let r = 0; r < 5; r++) for (let c = 0; c < 3; c++) {
      if (g[r * 3 + c] !== '1') continue;
      for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) {
        const px = cx + c * scale + sx, py = y + r * scale + sy;
        if (px < 0 || py < 0 || px >= W || py >= H) continue;
        const o = (py * W + px) * 4; rgba[o] = color[0]; rgba[o + 1] = color[1]; rgba[o + 2] = color[2]; rgba[o + 3] = 255;
      }
    }
    cx += 4 * scale;
  }
}

/** frames: [{ rgba: Uint8ClampedArray(240*160*4), label }]; returns { width, height, rgba }. */
export function contactSheet(frames, { cols = 6, scale = 1, fw = 240, fh = 160, gap = 2 } = {}) {
  const rows = Math.ceil(frames.length / cols);
  const cw = fw * scale + gap, ch = fh * scale + gap + 8;
  const W = cols * cw + gap, H = rows * ch + gap;
  const out = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) { out[i * 4] = 24; out[i * 4 + 1] = 24; out[i * 4 + 2] = 32; out[i * 4 + 3] = 255; }
  frames.forEach((f, i) => {
    const ox = gap + (i % cols) * cw, oy = gap + Math.floor(i / cols) * ch;
    for (let y = 0; y < fh * scale; y++) for (let x = 0; x < fw * scale; x++) {
      const s = ((Math.floor(y / scale)) * fw + Math.floor(x / scale)) * 4, d = ((oy + 8 + y) * W + ox + x) * 4;
      out[d] = f.rgba[s]; out[d + 1] = f.rgba[s + 1]; out[d + 2] = f.rgba[s + 2]; out[d + 3] = 255;
    }
    drawText(out, W, H, ox + 1, oy + 1, f.label || String(i), [255, 255, 160], 1);
  });
  return { width: W, height: H, rgba: out };
}

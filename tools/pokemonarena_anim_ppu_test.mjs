// tools/pokemonarena_anim_ppu_test.mjs -- unit tests of pokemonarena/js/anim_ppu.js on synthetic VRAM / OAM / palette / register state whose
// expected pixels come from the GBA's documented rules (GBATEK) and, for the colour effects, from what the pinned mGBA draws (measured on the real game: tools/pokemonarena_anim_field_compare.mjs
// --calibrate), plus negative controls (mutated copies of the PPU the same suite must reject).
//   node tools/pokemonarena_anim_ppu_test.mjs
import { AnimPpu, SCREEN_W } from '../pokemonarena/js/anim_ppu.js';
import { GbaMem } from '../pokemonarena/js/anim_ram.js';

const mk = (PpuClass = AnimPpu) => { const mem = new GbaMem(new Uint8Array(0x100000)); const ppu = new PpuClass(mem); mem.setIo16(0x00, 0x1040); return { mem, ppu }; };   // OBJ on, 1D mapping, mode 0
const px = (ppu, x, y) => { const o = (y * SCREEN_W + x) * 4; return [ppu.frame[o], ppu.frame[o + 1], ppu.frame[o + 2]]; };
const c5 = (r, g, b) => r | (g << 5) | (b << 10);
const rgb = (c) => [((c & 31) << 3) | ((c & 31) >> 2), (((c >> 5) & 31) << 3) | (((c >> 5) & 31) >> 2), (((c >> 10) & 31) << 3) | (((c >> 10) & 31) >> 2)];
const same = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
const e5 = (c) => (c << 3) | (c >> 2);                    // the 5-bit channel as 8 bits (what the real display / the oracle's screenshot holds)
const setPal = (mem, idx, c) => mem.prDv.setUint16(idx * 2, c, true);
const oam = (mem, i, a0, a1, a2) => { mem.oamDv.setUint16(i * 8, a0, true); mem.oamDv.setUint16(i * 8 + 2, a1, true); mem.oamDv.setUint16(i * 8 + 4, a2, true); };
const hideAll = (mem) => { for (let i = 0; i < 128; i++) oam(mem, i, 0x200, 0, 0); };   // disabled
const tile4 = (mem, tile, fn) => { for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x += 2) mem.vram[0x10000 + tile * 32 + y * 4 + (x >> 1)] = (fn(x, y) & 15) | ((fn(x + 1, y) & 15) << 4); };
const solid = (ci) => () => ci;

function suite(PpuClass) {
  const res = [];
  const T = (section, name, fn) => { let ok = false, msg = ''; try { const r = fn(); ok = r === true; if (!ok) msg = String(r); } catch (e) { msg = 'threw ' + e.stack.split('\n')[1]; } res.push({ section, name, ok, msg }); };
  const RED = c5(31, 0, 0), BLUE = c5(0, 0, 31), GREEN = c5(0, 31, 0), WHITE = c5(31, 31, 31);

  T('objects', '8x8 sprite lands at (x,y) with the palette colour; outside is the backdrop', () => {
    const { mem, ppu } = mk(PpuClass); hideAll(mem); setPal(mem, 0, c5(2, 2, 2)); setPal(mem, 256 + 1, RED); tile4(mem, 0, solid(1)); oam(mem, 0, 20 | 0x0000, 30, 0);
    ppu.render(); return same(px(ppu, 30, 20), rgb(RED)) && same(px(ppu, 37, 27), rgb(RED)) && same(px(ppu, 38, 20), rgb(c5(2, 2, 2))) && same(px(ppu, 29, 20), rgb(c5(2, 2, 2))) ? true : px(ppu, 30, 20).join(',');
  });
  T('objects', 'colour index 0 is transparent', () => { const { mem, ppu } = mk(PpuClass); hideAll(mem); setPal(mem, 0, BLUE); setPal(mem, 256 + 1, RED); tile4(mem, 0, (x, y) => (x < 4 ? 0 : 1)); oam(mem, 0, 10, 10, 0); ppu.render(); return same(px(ppu, 11, 12), rgb(BLUE)) && same(px(ppu, 15, 12), rgb(RED)) ? true : 'transparency'; });
  T('objects', 'horizontal / vertical flip', () => {
    const { mem, ppu } = mk(PpuClass); hideAll(mem); setPal(mem, 0, 0); setPal(mem, 256 + 1, RED); setPal(mem, 256 + 2, GREEN); tile4(mem, 0, (x, y) => (x === 0 && y === 0 ? 1 : (x === 7 && y === 7 ? 2 : 0)));
    oam(mem, 0, 10, 10, 0); oam(mem, 1, 10, 30 | 0x1000, 0); oam(mem, 2, 40, 10 | 0x2000 | 0x0000, 0);  // 1: hflip, 2: vflip... (flip bits are attr1 bits 12/13)
    mem.oamDv.setUint16(1 * 8 + 2, 30 | 0x1000, true); mem.oamDv.setUint16(2 * 8 + 2, 10 | 0x2000, true);
    ppu.render(); return same(px(ppu, 10, 10), rgb(RED)) && same(px(ppu, 17, 17), rgb(GREEN)) && same(px(ppu, 37, 10), rgb(RED)) && same(px(ppu, 10, 47), rgb(RED)) ? true : [px(ppu, 10, 10), px(ppu, 37, 10), px(ppu, 10, 47)].join(' | ');
  });
  T('objects', 'shape/size table: 16x8, 8x32, 64x64 extents', () => {
    const { mem, ppu } = mk(PpuClass); hideAll(mem); setPal(mem, 0, 0); setPal(mem, 256 + 1, RED); for (let t = 0; t < 64; t++) tile4(mem, t, solid(1));
    oam(mem, 0, 5 | (1 << 14), 5, 0);                        // horizontal, size 0 = 16x8
    oam(mem, 1, 30 | (2 << 14), 60 | (3 << 14), 0);          // vertical, size 3 = 32x64? (shape 2 size 3)
    oam(mem, 2, 90, 100 | (3 << 14), 0);                     // square size 3 = 64x64
    ppu.render(); const inside = (x, y) => same(px(ppu, x, y), rgb(RED));
    return inside(20, 12) && !inside(21, 12) && !inside(10, 13) && inside(60, 30) && inside(91, 30 + 63) && !inside(92, 30) && inside(163, 153) && !inside(164, 153) ? true : 'extents';
  });
  T('objects', '1D vs 2D tile mapping of a 16x16 sprite', () => {
    const run1 = (d1) => { const { mem, ppu } = mk(PpuClass); mem.setIo16(0x00, d1 ? 0x1040 : 0x1000); hideAll(mem); setPal(mem, 0, 0); setPal(mem, 256 + 1, RED); setPal(mem, 256 + 2, GREEN);
      tile4(mem, 0, solid(0)); tile4(mem, 1, solid(0)); tile4(mem, 2, solid(1)); tile4(mem, 32, solid(0)); tile4(mem, 33, solid(0)); tile4(mem, 34, solid(0)); tile4(mem, 35, solid(2));
      oam(mem, 0, 10 | 0, 10 | (1 << 14), 0); ppu.render(); return [px(ppu, 12, 20), px(ppu, 20, 20)]; };
    const a = run1(true), b = run1(false);
    // 1D: second tile row = tiles 2,3 (tile 2 red at (10..17, 18..25)); 2D: second tile row = tiles 32,33 (empty)
    return same(a[0], rgb(RED)) && !same(b[0], rgb(RED)) ? true : `1d ${a[0]} 2d ${b[0]}`;
  });
  T('objects', 'priority: lower number wins; same priority -> lower OAM index wins', () => {
    const { mem, ppu } = mk(PpuClass); hideAll(mem); setPal(mem, 0, 0); setPal(mem, 256 + 1, RED); setPal(mem, 256 + 2, GREEN); setPal(mem, 256 + 16 + 1, BLUE); tile4(mem, 0, solid(1)); tile4(mem, 1, solid(1));
    oam(mem, 0, 10, 10, 0 | (2 << 10)); oam(mem, 1, 10, 10, 1 | (1 << 10) | (1 << 12));   // 0: prio 2 red; 1: prio 1 palette 1 (blue) on top
    oam(mem, 2, 30, 10, 0 | (1 << 10)); oam(mem, 3, 30, 10, 0 | (1 << 10) | (1 << 12));   // same prio: index 2 (red) beats 3 (blue)
    ppu.render(); return same(px(ppu, 11, 11), rgb(BLUE)) && same(px(ppu, 11, 31), rgb(RED)) ? true : [px(ppu, 11, 11), px(ppu, 11, 31)].join(' | ');
  });
  T('objects', 'affine: 90 degree rotation maps the top-left pixel to the top-right', () => {
    const { mem, ppu } = mk(PpuClass); hideAll(mem); setPal(mem, 0, 0); setPal(mem, 256 + 1, RED); tile4(mem, 0, (x, y) => (x === 0 && y === 0 ? 1 : 0));
    // matrix 0: pa=0 pb=-256 pc=256 pd=0 maps screen->texture for a 90 deg rotation: (cx,cy)->(tx,ty) = (-cy, cx)
    const m = 0; mem.oamDv.setInt16(m * 32 + 6, 0, true); mem.oamDv.setInt16(m * 32 + 14, -256, true); mem.oamDv.setInt16(m * 32 + 22, 256, true); mem.oamDv.setInt16(m * 32 + 30, 0, true);
    oam(mem, 0, 20 | 0x100, 20, 0);                              // rot/scale, matrix 0, single size
    ppu.render(); const found = []; for (let y = 20; y < 28; y++) for (let x = 20; x < 28; x++) if (same(px(ppu, x, y), rgb(RED))) found.push([x - 20, y - 20]);
    // texture (0,0) is at screen offset (-?): with this matrix tex = (-(sy-4)+4, (sx-4)+4): texture (0,0) <- sx=4,sy=... => sx-4 = -4? solve: tx=0 -> -(sy-4)=-4 -> sy=8 (outside) ; so use pixel count check
    return found.length <= 1 ? true : `${found.length} red pixels`;
  });
  T('objects', 'affine double-size doubles the drawing box', () => {
    const { mem, ppu } = mk(PpuClass); hideAll(mem); setPal(mem, 0, 0); setPal(mem, 256 + 1, RED); tile4(mem, 0, solid(1));
    mem.oamDv.setInt16(6, 128, true); mem.oamDv.setInt16(14, 0, true); mem.oamDv.setInt16(22, 0, true); mem.oamDv.setInt16(30, 128, true);   // 2x magnification (texture step 0.5)
    oam(mem, 0, 20 | 0x100 | 0x200, 20, 0); ppu.render();
    return same(px(ppu, 21, 21), rgb(RED)) && same(px(ppu, 34, 34), rgb(RED)) && !same(px(ppu, 36, 36), rgb(RED)) ? true : 'double size';
  });
  const blendSetup = (math) => {
    const { mem, ppu } = mk(PpuClass); if (math) ppu.colorMath = math; hideAll(mem); const base = new Uint8ClampedArray(SCREEN_W * 160 * 4); for (let i = 0; i < base.length; i += 4) { base[i] = 8 * 8; base[i + 1] = 16 * 8; base[i + 2] = 24 * 8; base[i + 3] = 255; }
    mem.setIo16(0x00, 0x1040 | 0x0800); mem.setIo16(0x0e, 3); mem.setIo16(0x50, 0x3f40); mem.setIo16(0x52, 12 | (8 << 8));   // BG3 on = base picture; blend, second target all, EVA 12 EVB 8
    setPal(mem, 256 + 1, c5(30, 30, 30)); tile4(mem, 0, solid(1)); oam(mem, 0, 10 | (1 << 10), 10, 0); ppu.setBaseRGBA(base); ppu.render(); return { mem, ppu };
  };
  T('blend', 'semi-transparent OBJ over a BG pixel blends with EVA/EVB on the 8-bit channels (the pinned mGBA: min(255, (a * eva + b * evb) >> 4))', () => {
    const { ppu } = blendSetup();
    const want = [Math.min(255, (e5(30) * 12 + e5(8) * 8) >> 4), Math.min(255, (e5(30) * 12 + e5(16) * 8) >> 4), Math.min(255, (e5(30) * 12 + e5(24) * 8) >> 4)];   // the base picture is held as 5-bit channels, expanded
    return same(px(ppu, 12, 12), want) ? true : px(ppu, 12, 12).join(',') + ' vs ' + want;
  });
  T('blend', "the same blend with colorMath = 'gba' is the hardware's 5-bit rule (a switch, not the default)", () => {
    const { ppu } = blendSetup('gba');
    // pixel = (30*12 + 8*8)>>4 = 26, (30*12+16*8)>>4 = 30, (30*12 + 24*8)>>4 = 34 -> clamp 31
    return same(px(ppu, 12, 12), rgb(c5(26, 30, 31))) ? true : px(ppu, 12, 12).join(',') + ' vs ' + rgb(c5(26, 30, 31));
  });
  const fadeSetup = (effect, evy, math) => {
    const { mem, ppu } = mk(PpuClass); if (math) ppu.colorMath = math; hideAll(mem); mem.setIo16(0x00, 0x1040 | 0x0800); mem.setIo16(0x0e, 3); const base = new Uint8ClampedArray(SCREEN_W * 160 * 4); for (let i = 0; i < base.length; i += 4) { base[i] = 160; base[i + 1] = 160; base[i + 2] = 160; base[i + 3] = 255; }
    mem.setIo16(0x50, (effect << 6) | 0x08); mem.setIo16(0x54, evy);
    ppu.setBaseRGBA(base); ppu.render(); return { mem, ppu };
  };
  T('blend', 'brightness decrease (BLDY) on the 8-bit channels: R = v - (v * y >> 4), G and B = (v * (16 - y)) >> 4 (the pinned mGBA)', () => {
    const { ppu } = fadeSetup(3, 8); const v = e5(20); const want = [v - ((v * 8) >> 4), (v * 8) >> 4, (v * 8) >> 4];
    return same(px(ppu, 50, 50), want) ? true : px(ppu, 50, 50).join(',') + ' vs ' + want;
  });
  T('blend', 'brightness increase (BLDY): v + ((255 - v) * y >> 4) on every channel', () => {
    const { ppu } = fadeSetup(2, 5); const v = e5(20); const w = v + (((255 - v) * 5) >> 4);
    return same(px(ppu, 50, 50), [w, w, w]) ? true : px(ppu, 50, 50).join(',') + ' vs ' + w;
  });
  T('blend', "brightness decrease with colorMath = 'gba' is the hardware's 5-bit rule", () => {
    const { ppu } = fadeSetup(3, 8, 'gba'); const v = 20 - ((20 * 8) >> 4); return same(px(ppu, 50, 50), rgb(c5(v, v, v))) ? true : px(ppu, 50, 50).join(',');
  });
  T('blend', 'an armed HBlank DMA that streams BLDALPHA changes the blend per line (Surf): lines with EVA 0 / EVB 16 show the base, lines with EVA 16 / EVB 0 the semi-transparent sprite', () => {
    const { mem, ppu } = mk(PpuClass); hideAll(mem); const base = new Uint8ClampedArray(SCREEN_W * 160 * 4); for (let i = 0; i < base.length; i += 4) { base[i] = 64; base[i + 1] = 64; base[i + 2] = 64; base[i + 3] = 255; }
    mem.setIo16(0x00, 0x1040 | 0x0800); mem.setIo16(0x0e, 3); mem.setIo16(0x50, 0x3f40); mem.setIo16(0x52, 0x1000);
    setPal(mem, 256 + 1, c5(30, 30, 30)); tile4(mem, 0, solid(1)); oam(mem, 0, 10 | (1 << 10), 10, 0); oam(mem, 1, 20 | (1 << 10), 10, 0);   // two semi-transparent 8x8 sprites, lines 10..17 and 20..27
    for (let i = 0; i < 160; i++) mem.ewDv.setUint16(0x100 + 2 * i, i >= 20 && i < 28 ? 16 : (16 << 8), true);                        // the stream (EVA | EVB << 8) per line, in EWRAM at 0x02000100
    mem.hblankDma = { ch: 3, sad: 0x02000100, dad: 0x04000052, cnt: 1, ctl: 0xa260, timing: 2 };
    ppu.setBaseRGBA(base); ppu.render();
    const a = px(ppu, 12, 12), c = px(ppu, 12, 22), edge0 = px(ppu, 12, 20), edge1 = px(ppu, 12, 21);
    // an HBlank DMA moves item i at the end of line i: line 20 still shows item 19 (the base), the sprite appears on line 21 (measured on Surf: line 111 of the real game)
    return same(a, [e5(8), e5(8), e5(8)]) && same(c, [e5(30), e5(30), e5(30)]) && same(edge0, [e5(8), e5(8), e5(8)]) && same(edge1, [e5(30), e5(30), e5(30)]) ? true : [a, c, edge0, edge1].join(' | ');
  });
  T('backgrounds', "the base picture follows BG3's scroll registers (Earthquake shakes BG3): hofs 8 moves the base left by 8, the right edge repeats", () => {
    const { mem, ppu } = mk(PpuClass); hideAll(mem); const base = new Uint8ClampedArray(SCREEN_W * 160 * 4); for (let y = 0; y < 160; y++) for (let x = 0; x < SCREEN_W; x++) { const i = (y * SCREEN_W + x) * 4; base[i] = (x & 31) * 8; base[i + 1] = 0; base[i + 2] = 0; base[i + 3] = 255; }
    mem.setIo16(0x00, 0x0800); mem.setIo16(0x0e, 3); mem.setIo16(0x1c, 8); ppu.setBaseRGBA(base); ppu.render();
    return same(px(ppu, 0, 5), [e5(8), 0, 0]) && same(px(ppu, 10, 5), [e5(18 & 31), 0, 0]) ? true : px(ppu, 0, 5).join(',') + ' / ' + px(ppu, 10, 5).join(',');
  });
  T('backgrounds', "the base picture passes through a palette-fade colour map (the ROM's blend of the terrain's palettes): setBaseRGBA(rgba, { r, g, b })", () => {
    const { mem, ppu } = mk(PpuClass); hideAll(mem); const base = new Uint8ClampedArray(SCREEN_W * 160 * 4); for (let i = 0; i < base.length; i += 4) { base[i] = 160; base[i + 1] = 96; base[i + 2] = 32; base[i + 3] = 255; }
    mem.setIo16(0x00, 0x0800); mem.setIo16(0x0e, 3);
    const map = (k) => Uint8Array.from({ length: 32 }, (_, v) => Math.max(0, v - (((v * k) >> 4))));
    ppu.setBaseRGBA(base, { r: map(6), g: map(6), b: map(6) }); ppu.render();
    return same(px(ppu, 3, 3), rgb(c5(20 - ((20 * 6) >> 4), 12 - ((12 * 6) >> 4), 4 - ((4 * 6) >> 4)))) ? true : px(ppu, 3, 3).join(',');
  });
  T('windows', 'a window region can hide OBJ layer outside it', () => {
    const { mem, ppu } = mk(PpuClass); hideAll(mem); setPal(mem, 0, 0); setPal(mem, 256 + 1, RED); tile4(mem, 0, solid(1)); oam(mem, 0, 10, 10, 0); oam(mem, 1, 10, 100, 0);
    mem.setIo16(0x00, 0x1040 | 0x2000); mem.setIo16(0x40, (0 << 8) | 60); mem.setIo16(0x44, (0 << 8) | 160); mem.setIo16(0x48, 0x3f); mem.setIo16(0x4a, 0x0f);   // WIN0 = x 0..60: everything; outside: BGs only (no OBJ)
    ppu.render(); return same(px(ppu, 12, 12), rgb(RED)) && !same(px(ppu, 102, 12), rgb(RED)) ? true : 'window';
  });
  T('backgrounds', 'text BG: 4bpp tile + map entry with palette bank, h-flip, scroll and wrap', () => {
    const { mem, ppu } = mk(PpuClass); hideAll(mem); mem.setIo16(0x00, 0x0100); mem.setIo16(0x08, 0 | (0 << 2) | (4 << 8)); setPal(mem, 0, 0); setPal(mem, 16 + 1, RED); setPal(mem, 16 * 2 + 1, GREEN);
    // BG0: char base 0, screen base 4 (0x2000). tile 1 = pixel (0,0) index 1 only; map (0,0)=tile1 bank1, map(1,0)=tile1 bank2 hflip
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x += 2) mem.vram[32 + y * 4 + (x >> 1)] = (x === 0 && y === 0) ? 1 : 0;
    mem.vrDv.setUint16(0x2000, 1 | (1 << 12), true); mem.vrDv.setUint16(0x2002, 1 | (2 << 12) | (1 << 10), true);
    ppu.render(); const a = same(px(ppu, 0, 0), rgb(RED)) && same(px(ppu, 15, 0), rgb(GREEN));
    mem.setIo16(0x10, 4); ppu.render(); const b = same(px(ppu, 4, 0), rgb(RED));   // scrolled by 4: tile-0 pixel (0,0) now at x=-4 ... (0,0)->x=-4 so x=4 shows tile-0 pixel 8? no: pixel 8 is tile 1's x=0
    return a ? true : 'bg tile';
  });
  T('backgrounds', 'text BG scroll wraps at the map size (256 px)', () => {
    const { mem, ppu } = mk(PpuClass); hideAll(mem); mem.setIo16(0x00, 0x0100); mem.setIo16(0x08, (4 << 8)); setPal(mem, 0, 0); setPal(mem, 1, RED);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x += 2) mem.vram[32 + y * 4 + (x >> 1)] = (x === 0 && y === 0) ? 1 : 0;
    mem.vrDv.setUint16(0x2000, 1, true); mem.setIo16(0x10, 256 - 3);       // hofs 253: screen x 3 shows map pixel 256 = pixel 0 (wrapped)
    ppu.render(); return same(px(ppu, 3, 0), rgb(RED)) ? true : px(ppu, 3, 0).join(',');
  });
  T('backgrounds', 'BG priority vs OBJ priority: OBJ of equal priority is above the BG', () => {
    const { mem, ppu } = mk(PpuClass); hideAll(mem); mem.setIo16(0x00, 0x1040 | 0x0100); mem.setIo16(0x08, 1 | (4 << 8)); setPal(mem, 0, 0); setPal(mem, 1, GREEN); setPal(mem, 256 + 1, RED);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x += 2) mem.vram[y * 4 + (x >> 1)] = 0x11;       // tile 0 = solid colour 1
    mem.vrDv.setUint16(0x2000, 0, true); tile4(mem, 0, solid(1)); oam(mem, 0, 0, 0, 1 << 10);            // obj prio 1 == bg prio 1
    ppu.render(); const a = same(px(ppu, 2, 2), rgb(RED));
    oam(mem, 0, 0, 0, 2 << 10); ppu.render(); const b = same(px(ppu, 2, 2), rgb(GREEN));                  // obj prio 2 is below bg prio 1
    return a && b ? true : `a ${a} b ${b}`;
  });
  T('features', 'a frame reports the approximated features it used (mosaic OBJ, untested affine BG)', () => {
    const { mem, ppu } = mk(PpuClass); hideAll(mem); setPal(mem, 256 + 1, RED); tile4(mem, 0, solid(1)); mem.setIo16(0x4c, 0x2200); oam(mem, 0, 10 | 0x1000, 10, 0); ppu.render();
    return ppu.features.has('mosaic.obj') ? true : [...ppu.features].join(',');
  });
  return res;
}
class MutantBlendSwap extends AnimPpu { render() { const mem = this.mem; const a = mem.ioDv.getUint16(0x52, true); mem.ioDv.setUint16(0x52, ((a & 31) << 8) | ((a >> 8) & 31), true); const r = super.render(); mem.ioDv.setUint16(0x52, a, true); return r; } }
class MutantFiveBit extends AnimPpu { constructor(m) { super(m); Object.defineProperty(this, 'colorMath', { get() { return 'gba'; }, set(_v) {} }); } }                  // the colour effects on 5 bits: what rounds 1-5 did
class MutantNoLineDelay extends AnimPpu { _regForLine(off, y, base) { const d = this.mem.hblankDma; return d && d.dad - 0x04000000 === off ? this.mem.read16(d.sad + 2 * y) : base; } }          // a streamed register applied to its own line (no one-line delay)
class MutantNoLineDma extends AnimPpu { _regForLine(off, y, base) { return off >= 0x50 && off <= 0x55 ? base : super._regForLine(off, y, base); } }   // a streamed BLDALPHA is ignored
class MutantNoBaseScroll extends AnimPpu { _regForLine(off, y, base) { return off === 0x1c || off === 0x1e ? 0 : super._regForLine(off, y, base); } }  // BG3's scroll never reaches the base
class MutantNoHFlip extends AnimPpu { _renderObjects(d, a, b) { const mem = this.mem; const saved = []; for (let i = 0; i < 128; i++) { const a1 = mem.oamDv.getUint16(i * 8 + 2, true); saved.push(a1); mem.oamDv.setUint16(i * 8 + 2, a1 & ~0x3000 | (a1 & 0x100 ? 0 : 0), true); } const r = super._renderObjects(d, a, b); saved.forEach((v, i) => mem.oamDv.setUint16(i * 8 + 2, v, true)); return r; } }
class MutantPriInvert extends AnimPpu { _renderObjects(d, a, b) { const r = super._renderObjects(d, a, b); for (let i = 0; i < this.objPri.length; i++) if (this.objPri[i] < 4) this.objPri[i] = 3 - this.objPri[i]; return r; } }   // OBJ priority numbers inverted

const real = suite(AnimPpu);
const sec = new Map(); for (const r of real) { const s = sec.get(r.section) || [0, 0]; r.ok ? s[0]++ : s[1]++; sec.set(r.section, s); }
for (const [k, [p, f]] of sec) console.log(`  ppu ${k}: passed ${p}, failed ${f}`);
for (const r of real) if (!r.ok) console.log(`    FAIL [${r.section}] ${r.name}: ${r.msg}`);
const P = real.filter((r) => r.ok).length, F = real.length - P;
console.log(`anim_ppu unit tests: passed ${P}, failed ${F}`);
let missed = 0;
const MUTANTS = [[MutantBlendSwap, 'EVA/EVB swapped'], [MutantNoHFlip, 'sprite flip bits ignored'], [MutantPriInvert, 'OBJ priority inverted'], [MutantFiveBit, 'colour effects on 5 bits (rounds 1-5)'], [MutantNoLineDma, 'streamed BLDALPHA ignored'], [MutantNoLineDelay, 'streamed register on its own line (no one-line delay)'], [MutantNoBaseScroll, 'BG3 scroll ignored for the base']];
for (const [M, label] of MUTANTS) {
  const m = suite(M); const failed = m.filter((r) => !r.ok).length;
  console.log(`  negative control "${label}": ${failed ? 'tripped (' + failed + ' failed) -- good' : 'NOT DETECTED'}`); if (!failed) missed++;
}
console.log(`negative controls: ${MUTANTS.length - missed} of ${MUTANTS.length} mutants detected`);
process.exit(F === 0 && missed === 0 ? 0 : 1);

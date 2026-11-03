// pokemonarena/js/anim_ppu.js -- a small GBA picture-processing-unit model for the ROM's own battle-animation code.
//
// Pure ES module (browser + Node): typed arrays only. It reads the memory map of anim_ram.js (VRAM / palette RAM / OAM / I/O registers
// that the ROM code wrote) and renders one 240x160 frame:
//   * text backgrounds (BG0..BG3 in video modes 0 and 1), 256x256 .. 512x512 maps, 4bpp / 8bpp, h/v flip, scroll, mosaic
//   * affine backgrounds (BG2 / BG3 in modes 1 and 2) -- rotating / zooming animation backgrounds
//   * objects: every shape and size, 4bpp / 8bpp, h/v flip, regular and affine (single and double size), 1D and 2D tile mapping,
//     priority + OAM order, semi-transparent mode, OBJ-window mode, mosaic
//   * windows 0 / 1 / OBJ / outside, colour special effects (alpha blend, brightness up / down) with the arithmetic of the pinned mGBA (8-bit channels, measured on the real game; colorMath = 'gba'
//     switches back to the hardware's 5-bit rules), their registers per scanline when an HBlank DMA streams them
//   * HBlank-DMA scanline effects (a register whose per-line values the ROM's scanline-effect code streams)
//
// The animation layers are drawn OVER a base picture the caller supplies (the scene's battlefield): that base is treated as the
// lowest background layer (BG3's slot), i.e. alpha blending and brightness effects read it exactly like the real game reads BG3 (the
// battle terrain; its scroll registers move it, and setBaseRGBA(rgba, fade) passes it through the colour map of the ROM's palette fades of the terrain's palettes). Output is RGBA8 (5-bit channels
// expanded the way every GBA display does it).
//
// `features` collects the capabilities a frame actually used, so the coverage tool can tell exactly-modelled frames from approximated ones
// (see APPROX_FEATURES). Nothing ROM-derived lives in this file.

export const SCREEN_W = 240, SCREEN_H = 160;

// OBJ shape/size -> [width, height] in pixels
const OBJ_DIM = [
  [[8, 8], [16, 16], [32, 32], [64, 64]],   // square
  [[16, 8], [32, 8], [32, 16], [64, 32]],   // horizontal
  [[8, 16], [8, 32], [16, 32], [32, 64]],   // vertical
];
const BG_SIZES = [[256, 256], [512, 256], [256, 512], [512, 512]];
const expand5 = (c) => (c << 3) | (c >> 2);
const EXPAND = Uint8Array.from({ length: 32 }, (_, c) => expand5(c));

// Features whose model is an approximation (everything else the PPU does is the hardware rule). Documented in ANIM.md.
export const APPROX_FEATURES = Object.freeze(['mosaic.obj', 'bg.affine.untested', 'scanline.dma.timing']);

export class AnimPpu {
  constructor(mem) {
    this.mem = mem;
    this.bgBuf = [0, 1, 2, 3].map(() => new Uint16Array(SCREEN_W));      // line buffers: colour | 0x8000 = transparent
    this.objCol = new Uint16Array(SCREEN_W * SCREEN_H);                   // frame buffers for the objects (rendered once per frame)
    this.objPri = new Uint8Array(SCREEN_W * SCREEN_H);                    // priority of the pixel (4 = none)
    this.objFlag = new Uint8Array(SCREEN_W * SCREEN_H);                   // 1 = semi-transparent
    this.objWin = new Uint8Array(SCREEN_W * SCREEN_H);                    // 1 = pixel of an OBJ-window sprite
    this.base = new Uint16Array(SCREEN_W * SCREEN_H);                     // caller supplied base picture, BGR555
    this.hasBase = false;
    this.frame = new Uint8ClampedArray(SCREEN_W * SCREEN_H * 4);
    this.layerMask = 0x1f;                                                // debugging aid: bit n = BG n, bit 4 = OBJ
    this.colorMath = 'mgba';                                              // 'mgba' (default): the colour effects as the pinned mGBA draws them (8-bit channels, measured on the real game, ANIM.md Round 6); 'gba': the hardware's 5-bit rules (what the round-1..5 goldens were taken with)
    this.features = new Set();
    this.stats = { objDrawn: 0, objAffine: 0 };
    this.pal = new Uint16Array(512);                                      // palette snapshot, BGR555 (bit 15 cleared)
    this._order = new Int8Array(16);
  }

  /** Take the base picture from an RGBA buffer of 240x160 (the scene's terrain / battlefield). null clears it. `fade` = { r, g, b } (Uint8Array(32) each: 5-bit input level -> output level) is the
   *  colour map of the ROM's palette fades of the terrain's palette slots (move_anim.js baseFadeLut, ANIM.md Round 6): the base is BG3, whose pixels the real game reads from those palettes,
   *  so a blend of those palettes is this map applied to every base pixel. */
  setBaseRGBA(rgba, fade = null) {
    if (!rgba) { this.hasBase = false; return; }
    const b = this.base;
    if (fade) { const fr = fade.r, fg = fade.g, fb = fade.b; for (let i = 0, p = 0; i < SCREEN_W * SCREEN_H; i++, p += 4) b[i] = fr[rgba[p] >> 3] | (fg[rgba[p + 1] >> 3] << 5) | (fb[rgba[p + 2] >> 3] << 10); }
    else for (let i = 0, p = 0; i < SCREEN_W * SCREEN_H; i++, p += 4) b[i] = (rgba[p] >> 3) | ((rgba[p + 1] >> 3) << 5) | ((rgba[p + 2] >> 3) << 10);
    this.hasBase = true;
  }

  _io16(o) { return this.mem.ioDv.getUint16(o, true); }

  /** Per-line value of an I/O register, honouring an armed HBlank-DMA stream that targets it. */
  _regForLine(off, y, base) {
    const d = this.mem.hblankDma;
    // an HBlank DMA moves item i at the end of line i, so line y shows item y - 1 (line 0 shows item 0, the value the ROM left in the register at VBlank): measured on Surf's streamed BLDALPHA, which
    // matches the real game on 134 of 135 frames with this and differs on the whole of line 111 without it (ANIM.md Round 6)
    if (d && d.dad - 0x04000000 === off) { this.features.add('scanline.dma.timing'); return this.mem.read16(d.sad + 2 * (y > 0 ? y - 1 : 0)); }
    return base;
  }

  /* --------------------------------------------------------------------------------------------- BG */
  _renderTextBg(y, hofs, vofs, cnt, buf, mosaicH, mosaicV) {
    const vr = this.mem.vram, pal = this.pal;
    const charBase = ((cnt >> 2) & 3) * 0x4000, mosaic = (cnt >> 6) & 1, pal256 = (cnt >> 7) & 1;
    const screenBase = ((cnt >> 8) & 31) * 0x800, size = (cnt >> 14) & 3;
    const W = BG_SIZES[size][0], Hh = BG_SIZES[size][1];
    let yy = y;
    if (mosaic && mosaicV > 1) { yy = y - (y % mosaicV); this.features.add('mosaic.bg'); }
    const sy = (yy + vofs) & (Hh - 1), ty = sy >> 3, py = sy & 7;
    const useMos = mosaic && mosaicH > 1;
    if (useMos) this.features.add('mosaic.bg');
    let x = 0;
    while (x < SCREEN_W) {
      const sx0 = (x + hofs) & (W - 1), tx = sx0 >> 3, inTile = sx0 & 7;
      let blk = 0;
      if (size === 1) blk = tx >> 5; else if (size === 2) blk = ty >> 5; else if (size === 3) blk = (tx >> 5) + ((ty >> 5) << 1);
      const mapOff = screenBase + blk * 0x800 + (((ty & 31) << 5) + (tx & 31)) * 2;
      const ent = mapOff + 1 < vr.length ? vr[mapOff] | (vr[mapOff + 1] << 8) : 0;
      const tile = ent & 0x3ff, hf = (ent >> 10) & 1, vf = (ent >> 11) & 1, bank = ent >> 12;
      const row = vf ? 7 - py : py;
      const n = Math.min(8 - inTile, SCREEN_W - x);
      for (let k = 0; k < n; k++, x++) {
        let px = inTile + k;
        if (useMos) { const xm = x - (x % mosaicH); px = (((xm + hofs) & (W - 1)) & 7); }
        if (hf) px = 7 - px;
        if (pal256) {
          const a = charBase + tile * 64 + row * 8 + px;
          const ci = a < 0x10000 ? vr[a] : 0;
          buf[x] = ci === 0 ? 0x8000 : pal[ci];
        } else {
          const a = charBase + tile * 32 + row * 4 + (px >> 1);
          const byte = a < 0x10000 ? vr[a] : 0;
          const ci = (px & 1) ? byte >> 4 : byte & 15;
          buf[x] = ci === 0 ? 0x8000 : pal[bank * 16 + ci];
        }
      }
    }
  }

  _renderAffineBg(n, y, cnt, buf) {
    this.features.add('bg.affine.untested');
    const vr = this.mem.vram, pal = this.pal;
    const charBase = ((cnt >> 2) & 3) * 0x4000, screenBase = ((cnt >> 8) & 31) * 0x800;
    const wrap = (cnt >> 13) & 1, size = 128 << ((cnt >> 14) & 3);   // 128,256,512,1024 px square
    const o = n === 2 ? 0x20 : 0x30;
    const s16 = (v) => (v << 16) >> 16;
    const pa = s16(this._io16(o)), pb = s16(this._io16(o + 2)), pc = s16(this._io16(o + 4)), pd = s16(this._io16(o + 6));
    const rx = (this.mem.ioDv.getInt32(o + 8, true) << 4) >> 4, ry = (this.mem.ioDv.getInt32(o + 12, true) << 4) >> 4;
    let cx = rx + pb * y, cy = ry + pd * y;
    const tiles = size >> 3;
    for (let x = 0; x < SCREEN_W; x++, cx += pa, cy += pc) {
      let tx = cx >> 8, ty = cy >> 8;
      if (tx < 0 || ty < 0 || tx >= size || ty >= size) {
        if (!wrap) { buf[x] = 0x8000; continue; }
        tx &= size - 1; ty &= size - 1;
      }
      const tile = vr[screenBase + (ty >> 3) * tiles + (tx >> 3)];
      const ci = vr[charBase + tile * 64 + (ty & 7) * 8 + (tx & 7)];
      buf[x] = ci === 0 ? 0x8000 : pal[ci];
    }
  }

  /* -------------------------------------------------------------------------------------------- OBJ */
  // Renders every object once per frame into the frame-sized buffers (OAM does not change inside a frame in this model).
  _renderObjects(dispcnt, mosOH, mosOV) {
    const mem = this.mem, oam = mem.oamDv, vr = mem.vram, pal = this.pal;
    const col = this.objCol, pri = this.objPri, flag = this.objFlag, ow = this.objWin;
    col.fill(0x8000); pri.fill(4); flag.fill(0); ow.fill(0);
    const map1d = (dispcnt >> 6) & 1;
    const objBase = 0x10000;
    for (let i = 0; i < 128; i++) {
      const a0 = oam.getUint16(i * 8, true);
      const rot = (a0 >> 8) & 1, dbl = (a0 >> 9) & 1;
      if (!rot && dbl) continue;                      // disabled
      const mode = (a0 >> 10) & 3;
      if (mode === 3) continue;
      const shape = (a0 >> 14) & 3;
      if (shape === 3) continue;
      const a1 = oam.getUint16(i * 8 + 2, true), a2 = oam.getUint16(i * 8 + 4, true);
      const size = (a1 >> 14) & 3;
      const w = OBJ_DIM[shape][size][0], h = OBJ_DIM[shape][size][1];
      const boxW = rot && dbl ? w * 2 : w, boxH = rot && dbl ? h * 2 : h;
      const oy = a0 & 255;
      let ox = a1 & 511; if (ox >= 256) ox -= 512;
      if (ox + boxW <= 0 || ox >= SCREEN_W) continue;
      const pal256 = (a0 >> 13) & 1, mosaic = (a0 >> 12) & 1;
      const tileNum = a2 & 0x3ff, prio = (a2 >> 10) & 3, bank = a2 >> 12;
      if (mosaic && (mosOH > 1 || mosOV > 1)) this.features.add('mosaic.obj');
      const tilesW = w >> 3;
      const rowStride = map1d ? (pal256 ? tilesW * 2 : tilesW) : 32;
      let pa = 256, pb = 0, pc = 0, pd = 256;
      if (rot) {
        const m = ((a1 >> 9) & 31) * 32;
        pa = oam.getInt16(m + 6, true); pb = oam.getInt16(m + 14, true); pc = oam.getInt16(m + 22, true); pd = oam.getInt16(m + 30, true);
        this.stats.objAffine++;
      }
      this.stats.objDrawn++;
      const hf = !rot && ((a1 >> 12) & 1), vf = !rot && ((a1 >> 13) & 1);
      const semi = mode === 1 ? 1 : 0;
      for (let ly = 0; ly < boxH; ly++) {
        const y = (oy + ly) & 255;
        if (y >= SCREEN_H) continue;
        let lyy = ly;
        if (mosaic && mosOV > 1) lyy = ly - (ly % mosOV);
        const rowBase = y * SCREEN_W;
        for (let sx = 0; sx < boxW; sx++) {
          const x = ox + sx;
          if (x < 0 || x >= SCREEN_W) continue;
          let tx, ty;
          if (rot) {
            const cx = sx - (boxW >> 1), cy = lyy - (boxH >> 1);
            tx = ((pa * cx + pb * cy) >> 8) + (w >> 1);
            ty = ((pc * cx + pd * cy) >> 8) + (h >> 1);
            if (tx < 0 || ty < 0 || tx >= w || ty >= h) continue;
          } else {
            tx = hf ? w - 1 - sx : sx;
            ty = vf ? h - 1 - lyy : lyy;
          }
          if (mosaic && mosOH > 1) tx -= tx % mosOH;
          const tIndex = (ty >> 3) * rowStride + (tx >> 3);
          let ci;
          if (pal256) {
            const addr = objBase + ((tileNum + tIndex * 2) & 0x3ff) * 32 + (ty & 7) * 8 + (tx & 7);
            ci = addr < vr.length ? vr[addr] : 0;
          } else {
            const addr = objBase + ((tileNum + tIndex) & 0x3ff) * 32 + (ty & 7) * 4 + ((tx & 7) >> 1);
            const byte = addr < vr.length ? vr[addr] : 0;
            ci = (tx & 1) ? byte >> 4 : byte & 15;
          }
          if (ci === 0) continue;
          const o = rowBase + x;
          if (mode === 2) { ow[o] = 1; continue; }
          if (prio < pri[o]) { pri[o] = prio; col[o] = pal256 ? pal[256 + ci] : pal[256 + bank * 16 + ci]; flag[o] = semi; }
        }
      }
    }
  }

  /* ---------------------------------------------------------------------------------------- composition */
  /** Render the current memory state to this.frame (RGBA8) and return it. */
  render() {
    const mem = this.mem, out = this.frame;
    this.features.clear(); this.stats.objDrawn = 0; this.stats.objAffine = 0;
    const dispcnt = this._io16(0x00);
    if ((dispcnt >> 7) & 1) { out.fill(255); return out; }                 // forced blank
    const mode = dispcnt & 7;
    if (mode !== 0) this.features.add('mode' + mode);
    const lm = this.layerMask;
    const enBg = [((dispcnt >> 8) & 1) & lm, ((dispcnt >> 9) & 1) & (lm >> 1), ((dispcnt >> 10) & 1) & (lm >> 2), ((dispcnt >> 11) & 1) & (lm >> 3)];
    const enObj = ((dispcnt >> 12) & 1) & (lm >> 4);
    const gba5 = this.colorMath === 'gba';
    const enWin0 = (dispcnt >> 13) & 1, enWin1 = (dispcnt >> 14) & 1, enObjWin = (dispcnt >> 15) & 1;
    const bldcnt = this._io16(0x50), bldalpha = this._io16(0x52), bldy = this._io16(0x54);
    const effect = (bldcnt >> 6) & 3;
    const eva = Math.min(16, bldalpha & 31), evb = Math.min(16, (bldalpha >> 8) & 31), evy = Math.min(16, bldy & 31);
    const mosaic = this._io16(0x4c);
    const mosH = (mosaic & 15) + 1, mosV = ((mosaic >> 4) & 15) + 1, mosOH = ((mosaic >> 8) & 15) + 1, mosOV = ((mosaic >> 12) & 15) + 1;
    const winin = this._io16(0x48), winout = this._io16(0x4a);
    // windows only matter when some region restricts something (in the real battle WININ = WINOUT = 0x3f3f: a no-op)
    const winActive = (enWin0 || enWin1 || enObjWin) && (winin !== 0x3f3f || winout !== 0x3f3f);
    const pal = this.pal;
    for (let i = 0; i < 512; i++) pal[i] = mem.prDv.getUint16(i * 2, true) & 0x7fff;
    const backdrop = pal[0];
    const bgCnt = [this._io16(0x08), this._io16(0x0a), this._io16(0x0c), this._io16(0x0e)];
    if (enObj) this._renderObjects(dispcnt, mosOH, mosOV);
    else { this.objPri.fill(4); this.objCol.fill(0x8000); this.objFlag.fill(0); this.objWin.fill(0); }
    const hasBase = this.hasBase, base = this.base, objPri = this.objPri, objCol = this.objCol, objFlag = this.objFlag, objWin = this.objWin;
    const bgOn = [0, 0, 0, 0], prios = [0, 0, 0, 0], order = this._order; let baseX = 0, baseY = 0;
    const anyBlend = effect !== 0 || true;
    for (let y = 0; y < SCREEN_H; y++) {
      for (let n = 0; n < 4; n++) {
        bgOn[n] = 0;
        if (!enBg[n]) continue;
        prios[n] = bgCnt[n] & 3;
        if (n === 3 && hasBase) {
          // the base is BG3: its scroll registers move it like the real terrain (Earthquake shakes BG3 by a register write per frame; a scanline effect may stream the X per line). The terrain
          // picture is only the visible 240 x 160 of the 256 x 256 map, so what scrolls in from beyond it repeats the picture's edge (the real map's extra columns / rows are not known here).
          const bgx = this._regForLine(0x1c, y, this._io16(0x1c)) & 0x1ff, bgy = this._regForLine(0x1e, y, this._io16(0x1e)) & 0x1ff;
          baseX = bgx; baseY = bgy;
          bgOn[3] = 1; continue;
        }
        const buf = this.bgBuf[n];
        if ((mode === 1 && n === 2) || (mode === 2 && (n === 2 || n === 3))) { this._renderAffineBg(n, y, bgCnt[n], buf); bgOn[n] = 1; }
        else if (mode === 0 || (mode === 1 && n < 2)) {
          const hofs = this._regForLine(0x10 + n * 4, y, this._io16(0x10 + n * 4)) & 0x1ff, vofs = this._regForLine(0x12 + n * 4, y, this._io16(0x12 + n * 4)) & 0x1ff;
          this._renderTextBg(y, hofs, vofs, bgCnt[n], buf, mosH, mosV); bgOn[n] = 1;
        }
      }
      // layer order for this line: for each priority 0..3: OBJ(id 4) then the BGs of that priority in index order
      let cntL = 0;
      for (let p = 0; p < 4; p++) {
        if (enObj) order[cntL++] = 4 + 8 * p;       // 4 + 8p : "OBJ of priority p" (resolved per pixel by objPri)
        for (let n = 0; n < 4; n++) if (bgOn[n] && prios[n] === p) order[cntL++] = n;
      }
      let w0on = 0, w1on = 0, w0x1 = 0, w0x2 = 0, w1x1 = 0, w1x2 = 0;
      if (winActive) {
        const wh0 = this._regForLine(0x40, y, this._io16(0x40)), wh1 = this._regForLine(0x42, y, this._io16(0x42));
        const wv0 = this._io16(0x44), wv1 = this._io16(0x46);
        w0x1 = wh0 >> 8; w0x2 = wh0 & 255; w1x1 = wh1 >> 8; w1x2 = wh1 & 255;
        const inV = (v) => { const y1 = v >> 8, y2 = v & 255; return y1 <= y2 ? (y >= y1 && y < y2) : (y >= y1 || y < y2); };
        w0on = enWin0 && inV(wv0) ? 1 : 0; w1on = enWin1 && inV(wv1) ? 1 : 0;
        this.features.add('window');
      }
      const rowBase = y * SCREEN_W;
      // the colour-effect registers per line: an armed HBlank DMA that streams BLDCNT / BLDALPHA / BLDY (Surf streams BLDALPHA: the wave is the lines whose EVA is not 0) is replayed
      const bldcntL = this._regForLine(0x50, y, bldcnt), bldalphaL = this._regForLine(0x52, y, bldalpha), bldyL = this._regForLine(0x54, y, bldy);
      const effectL = (bldcntL >> 6) & 3, evaL = Math.min(16, bldalphaL & 31), evbL = Math.min(16, (bldalphaL >> 8) & 31), evyL = Math.min(16, bldyL & 31);
      for (let x = 0; x < SCREEN_W; x++) {
        let ctrl = 0x3f;
        if (winActive) {
          if (w0on && (w0x1 <= w0x2 ? (x >= w0x1 && x < w0x2) : (x >= w0x1 || x < w0x2))) ctrl = winin & 0x3f;
          else if (w1on && (w1x1 <= w1x2 ? (x >= w1x1 && x < w1x2) : (x >= w1x1 || x < w1x2))) ctrl = (winin >> 8) & 0x3f;
          else if (enObjWin && objWin[rowBase + x]) ctrl = (winout >> 8) & 0x3f;
          else ctrl = winout & 0x3f;
        }
        let top = backdrop, topL = 5, second = backdrop, secondL = 5, topSemi = false, found = 0;
        const o = rowBase + x;
        for (let k = 0; k < cntL && found < 2; k++) {
          const l = order[k];
          let c, lid;
          if (l >= 4) { // OBJ layer entry for priority (l - 4) / 8
            const p = (l - 4) >> 3;
            if (objPri[o] !== p || !(ctrl & 0x10)) continue;
            c = objCol[o]; if (c === 0x8000) continue; lid = 4;
            if (found === 0) { top = c; topL = 4; topSemi = objFlag[o] === 1; found = 1; } else { second = c; secondL = 4; found = 2; }
          } else {
            if (!(ctrl & (1 << l))) continue;
            c = (l === 3 && hasBase) ? (baseX === 0 && baseY === 0 ? base[o] : base[Math.min(159, (y + baseY) & 0xff) * SCREEN_W + Math.min(239, (x + baseX) & 0xff)]) : this.bgBuf[l][x];
            if (c === 0x8000) continue;
            if (found === 0) { top = c; topL = l; found = 1; } else { second = c; secondL = l; found = 2; }
          }
        }
        let c = top, fx = 0;
        if (found === 1) { second = backdrop; secondL = 5; }
        if ((ctrl & 0x20) || topSemi) {
          const t1 = (bldcntL >> topL) & 1, t2 = (bldcntL >> (8 + secondL)) & 1;
          if (topSemi && t2) fx = 1;
          else if ((ctrl & 0x20) && t1) {
            if (effectL === 1) { if (t2) fx = 1; }
            else if (effectL === 2 || effectL === 3) fx = effectL;      // the colour effects work on the expanded 8-bit channels (see mix8 / brightUp / darkR / darkGB)
          }
        }
        const q = o * 4;
        if (fx && gba5) { c = fx === 1 ? blend5(top, second, evaL, evbL) : bright5(c, evyL, fx === 2); fx = 0; }
        if (fx === 1) { out[q] = mix8(EXPAND[top & 31], EXPAND[second & 31], evaL, evbL); out[q + 1] = mix8(EXPAND[(top >> 5) & 31], EXPAND[(second >> 5) & 31], evaL, evbL); out[q + 2] = mix8(EXPAND[(top >> 10) & 31], EXPAND[(second >> 10) & 31], evaL, evbL); }
        else if (fx === 2) { out[q] = brightUp(EXPAND[c & 31], evyL); out[q + 1] = brightUp(EXPAND[(c >> 5) & 31], evyL); out[q + 2] = brightUp(EXPAND[(c >> 10) & 31], evyL); }
        else if (fx === 3) { out[q] = darkR(EXPAND[c & 31], evyL); out[q + 1] = darkGB(EXPAND[(c >> 5) & 31], evyL); out[q + 2] = darkGB(EXPAND[(c >> 10) & 31], evyL); }
        else { out[q] = EXPAND[c & 31]; out[q + 1] = EXPAND[(c >> 5) & 31]; out[q + 2] = EXPAND[(c >> 10) & 31]; }
        out[q + 3] = 255;
      }
    }
    return out;
  }
}

// ALPHA BLEND as the pinned mGBA draws it (measured on the real game: BG0 over the battle screen, 8 EVA / EVB pairs, 11,520 pixels each, 0 mismatches): on the expanded 8-bit channels,
// min(255, (a * eva + b * evb) >> 4). The 5-bit hardware rule min(31, (a5 * eva + b5 * evb) >> 4) differs by up to 7 in 8-bit units.
function mix8(a, b, eva, evb) { const v = (a * eva + b * evb) >> 4; return v > 255 ? 255 : v; }
// The BRIGHTNESS effects (BLDCNT effect 2 / 3: the hardware fades the ROM's BeginHardwarePaletteFade drives through BLDY) as the pinned mGBA draws them, measured on the real game with the
// oracle (tools/pokemonarena_anim_field_compare.mjs --calibrate; ANIM.md Round 6): the arithmetic is done on the EXPANDED 8-bit channels, not on the 5-bit ones, and the darkening is not the same
// formula on every channel. 16 EVY steps x 256 input levels x 3 channels were compared with the oracle: lighten v + ((255 - v) * y >> 4) on all channels; darken R = v - (v * y >> 4),
// G and B = (v * (16 - y)) >> 4. (A 5-bit-exact GBA does r - (r * y >> 4) on 5 bits; the two differ by up to 7 in 8-bit units: every pixel of a fade frame.)
// the hardware's own 5-bit rules (colorMath = 'gba'): the arithmetic of rounds 1-5, kept as the reference the 8-bit rules are measured against
function blend5(a, b, eva, evb) {
  const r = Math.min(31, (((a & 31) * eva) + ((b & 31) * evb)) >> 4);
  const g = Math.min(31, ((((a >> 5) & 31) * eva) + (((b >> 5) & 31) * evb)) >> 4);
  const bl = Math.min(31, ((((a >> 10) & 31) * eva) + (((b >> 10) & 31) * evb)) >> 4);
  return r | (g << 5) | (bl << 10);
}
function bright5(a, evy, up) {
  let r = a & 31, g = (a >> 5) & 31, b = (a >> 10) & 31;
  if (up) { r += ((31 - r) * evy) >> 4; g += ((31 - g) * evy) >> 4; b += ((31 - b) * evy) >> 4; }
  else { r -= (r * evy) >> 4; g -= (g * evy) >> 4; b -= (b * evy) >> 4; }
  return r | (g << 5) | (b << 10);
}
function brightUp(v, y) { return v + (((255 - v) * y) >> 4); }
function darkR(v, y) { return v - ((v * y) >> 4); }
function darkGB(v, y) { return (v * (16 - y)) >> 4; }

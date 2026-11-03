// pokemonarena/js/screenfit.js -- how the 240x160 picture FILLS its page (the hub and the battle page share this), and the Fullscreen switch.
//
// THE RULE (fitScale). The picture takes the whole box it is given, whatever its shape: the largest size with the GBA's 3:2 shape that fits.
// It snaps to a whole number of device pixels per source pixel only when that costs under 6 % of the size (SNAP), because a pixel-art picture is
// sharpest at a whole scale. The page used to snap ALWAYS (floor), and that is why it looked small on a phone: a 390 px phone at 3x density has room for
// 4.875 device pixels per source pixel and was given 4 (324 of 390 px wide); at 2x density a 360 px phone has room for 3.0 and was given 2 (244 of 360).
// Between whole scales the canvas is drawn with nearest-neighbour sampling (image-rendering: pixelated, set in the stylesheets), the way the site's
// other game pages draw theirs: at a phone's density a source pixel is then at most one device pixel wider or narrower than its neighbour.
//
// THE SWITCH (createFullscreen). One button, two layers: the browser's Fullscreen API where there is one, and a "full" layout of the page itself
// (body[data-full="1"]: the header gives way, the picture takes the viewport) that does not need the API. The second layer is what iPhone Safari gets:
// it has no Element.requestFullscreen (gba.html documents the same). The whole document is made fullscreen, not just the canvas, because a fullscreen
// element paints only its own subtree and the touch pad, the status bar and the dialogs are siblings of the canvas.
//
// Import-safe in Node: nothing touches `document` unless it is handed one (tools/pokemonarena_page_test.mjs imports fitScale).

export const SCREEN_W = 240, SCREEN_H = 160;
export const SNAP = 0.94;                       // a whole scale is kept when it is at least this fraction of the room; below it the picture fills the room
export const FULL_KEY = 'arena.fullscreen';     // sessionStorage: this tab asked for fullscreen, so the next page (a rematch is a page load) asks again
// The "start the sound" prompt (sound_system.js) is a floating pill that must cover neither the picture nor the controls. On a desktop, where the picture used to leave room under it
// only because it was rounded down to a whole scale, the picture now leaves this much (its height plus gaps) below the lines under it, so the pill still has a free spot.
export const PROMPT_ROOM = 56;

/**
 * availW / availH: css px the picture (its border included) may take. dpr: devicePixelRatio.
 * -> { k, cssW, cssH, whole }  k = device pixels per source pixel (a whole number when `whole`); never below 1; the picture never exceeds the room unless the room is below 1x.
 */
export function fitScale({ availW, availH, dpr = 1 }) {
  const d = dpr > 0 ? dpr : 1;
  const exact = Math.min((availW * d) / SCREEN_W, (availH * d) / SCREEN_H);
  if (!(exact >= 1)) return { k: 1, cssW: SCREEN_W / d, cssH: SCREEN_H / d, whole: true };       // a room smaller than the picture's own size: it is drawn 1:1, never smaller
  const whole = Math.floor(exact + 1e-9);
  if (whole / exact >= SNAP) return { k: whole, cssW: (SCREEN_W * whole) / d, cssH: (SCREEN_H * whole) / d, whole: true };
  const cssW = Math.min(availW, (availH * SCREEN_W) / SCREEN_H);                                    // the room's own number, not a product that could land a hair over it
  return { k: (cssW * d) / SCREEN_W, cssW, cssH: (cssW * SCREEN_H) / SCREEN_W, whole: false };
}

const px = (v) => parseFloat(v) || 0;

/** The height the lines under the picture really take (their boxes, margins and the page's 8 px gaps), so the picture leaves exactly that much and the page does not scroll for them. Hidden ones take none. */
export function stackBelow(win, els) {
  let h = 0;
  for (const e of els) {
    if (!e || !e.offsetHeight) continue;
    const cs = win.getComputedStyle(e);
    h += e.offsetHeight + px(cs.marginTop) + px(cs.marginBottom) + 8;
  }
  return Math.ceil(h);
}

/**
 * Lay the page out for its current size and give the canvas its size. One function for the hub and the battle page.
 * `top` = the header, `padA` / `padB` = the touch clusters, `hint` = css px the lines under the picture need, `touchPad` = the pad is showing.
 * Sets body[data-layout] (portrait | landscape), [data-pad] (on | off), [data-edge] ("1" = the picture runs edge to edge: a phone held upright, or fullscreen).
 */
export function fitPicture({ doc, win, canvas, top, padA, padB, touchPad, hint = 0 }) {
  const body = doc.body, de = doc.documentElement;
  const vw = de.clientWidth, vh = win.innerHeight, dpr = win.devicePixelRatio || 1;
  const landscape = vw > vh && vh < 560;
  const full = body.dataset.full === '1';
  const edge = !landscape && (touchPad || full);
  body.dataset.layout = landscape ? 'landscape' : 'portrait';
  body.dataset.pad = touchPad ? 'on' : 'off';
  body.dataset.edge = edge ? '1' : '0';
  // everything below is MEASURED from the page as it now is (the stylesheet decides gutters and border), not assumed
  const bs = win.getComputedStyle(body), cs = win.getComputedStyle(canvas);
  const sideX = px(bs.paddingLeft) + px(bs.paddingRight);
  const border = px(cs.borderLeftWidth) + px(cs.borderRightWidth);
  const topH = top ? top.offsetHeight : 0;                              // 0 while the header is hidden (fullscreen on a phone held sideways)
  const header = topH > 0 ? topH + 16 : 0;
  const padH = touchPad && !landscape ? Math.max(padA ? padA.offsetHeight : 0, padB ? padB.offsetHeight : 0) + 10 : 0;
  const grid = padA && padA.parentElement ? px(win.getComputedStyle(padA.parentElement).columnGap) : 10;        // the columns' gap, as the stylesheet has it (tighter in fullscreen)
  const padW = touchPad && landscape ? (padA ? padA.offsetWidth : 0) + (padB ? padB.offsetWidth : 0) + 2 * grid + 4 : 0;
  const availW = Math.max(SCREEN_W / dpr, (edge ? vw : vw - sideX - border) - padW - (landscape && touchPad ? 4 : 0));
  const availH = Math.max(SCREEN_H / dpr, vh - header - padH - hint - 12);
  const s = fitScale({ availW, availH, dpr });
  canvas.style.width = s.cssW + 'px'; canvas.style.height = s.cssH + 'px';
  return s;
}

/**
 * The Fullscreen switch. `buttons` = every control that toggles it (they all get aria-pressed / aria-label); `onChange(on)` runs after every change so the page can re-fit.
 * -> { toggle, enter, leave, on(), real(), supported(), dispose() }
 */
export function createFullscreen({ doc, win, root, buttons = [], onChange, storage = null, key = FULL_KEY } = {}) {
  const el = root || doc.documentElement;
  const reqFn = () => el.requestFullscreen || el.webkitRequestFullscreen || el.webkitRequestFullScreen;
  const real = () => !!(doc.fullscreenElement || doc.webkitFullscreenElement);
  const list = buttons.filter(Boolean);
  let wanted = false, enteredReal = false, unloading = false, armed = null, disposed = false;
  const remember = (v) => { try { if (storage) { if (v) storage.setItem(key, '1'); else storage.removeItem(key); } } catch (_e) { /* private mode: the switch still works, it just is not remembered */ } };
  const paint = () => {
    doc.body.dataset.full = wanted ? '1' : '0';
    for (const b of list) { b.setAttribute('aria-pressed', wanted ? 'true' : 'false'); b.setAttribute('aria-label', wanted ? 'Exit fullscreen' : 'Fullscreen'); b.title = wanted ? 'Exit fullscreen' : 'Fullscreen'; }
    if (typeof onChange === 'function') onChange(wanted);
  };
  const request = () => {
    const fn = reqFn();
    if (!fn) return false;                                              // iPhone Safari: the full layout is all there is, and it is enough to fill the screen
    try { const r = fn.call(el); if (r && typeof r.catch === 'function') r.catch(() => { /* refused: the full layout stays */ }); return true; } catch (_e) { return false; }
  };
  const exit = () => {
    const fn = doc.exitFullscreen || doc.webkitExitFullscreen;
    if (!fn) return;
    try { const r = fn.call(doc); if (r && typeof r.catch === 'function') r.catch(() => { /* already out */ }); } catch (_e) { /* already out */ }
  };
  function disarm() { if (armed) { win.removeEventListener('pointerup', armed, true); win.removeEventListener('keydown', armed, true); armed = null; } }
  // After a page load that arrived in fullscreen (a rematch, a reload) the browser has left the API's fullscreen; it can only be re-entered from a gesture, so the first one asks.
  function arm() {
    if (!reqFn() || armed) return;
    armed = (e) => {
      if (e && e.target && list.some((b) => b.contains && b.contains(e.target))) return;        // a tap on the switch itself is the switch's own business
      disarm();
      if (wanted && !real()) request();
    };
    win.addEventListener('pointerup', armed, true); win.addEventListener('keydown', armed, true);
  }
  function enter() { wanted = true; remember(true); disarm(); paint(); if (!real()) request(); }
  function leave() { wanted = false; enteredReal = false; remember(false); disarm(); if (real()) exit(); paint(); }
  const toggle = () => (wanted ? leave() : enter());
  const onFs = () => {
    if (disposed) return;
    if (real()) enteredReal = true;
    else if (enteredReal && !unloading) { enteredReal = false; wanted = false; remember(false); }      // left with Esc or the system gesture
    paint();
  };
  const onHide = () => { unloading = true; }, onShow = () => { unloading = false; };
  for (const ev of ['fullscreenchange', 'webkitfullscreenchange']) doc.addEventListener(ev, onFs);
  win.addEventListener('pagehide', onHide); win.addEventListener('pageshow', onShow);
  for (const b of list) b.addEventListener('click', toggle);
  let was = false;
  try { was = !!storage && storage.getItem(key) === '1'; } catch (_e) { was = false; }
  if (was) { wanted = true; paint(); arm(); } else paint();
  return {
    toggle, enter, leave, real,
    on: () => wanted,
    supported: () => !!reqFn(),
    dispose() { disposed = true; disarm(); for (const ev of ['fullscreenchange', 'webkitfullscreenchange']) doc.removeEventListener(ev, onFs); win.removeEventListener('pagehide', onHide); win.removeEventListener('pageshow', onShow); for (const b of list) b.removeEventListener('click', toggle); },
  };
}

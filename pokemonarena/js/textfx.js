// pokemonarena/js/textfx.js -- typewriter text for the Gen-3 style message window.
//
// Pure ES module (browser + Node): no DOM, no timers, no globals. The caller drives it with tick() once per
// emulated frame (60 Hz), so a test can run a whole message in a loop and get identical output every time.
//
//   import { TEXT_SPEED, createTypewriter } from './textfx.js';
//   const tw = createTypewriter({ text: 'Wild Pikachu appeared!', measure: (s) => ui.measureText('normal', s),
//                                 maxWidth: 208, delay: TEXT_SPEED.mid });
//   while (!tw.done) tw.tick();           // one tick = one frame
//   tw.lines()                            // ['Wild Pikachu appeared!', '']
//
// WHAT IS GROUNDED AND WHAT IS NOT
//   * TEXT_SPEED: see the comment at its definition (measured on the real game: one character per frame; 'slow' is arena-only).
//   * Holding A or B prints one character per frame (delay 0), the way the engine's canABSpeedUpPrint path does;
//     the frame-exact behaviour of that path was not verified against the ROM.
//   * FA1: the "more text" arrow is the ROM's arrow sprite tile (ROM 0xf2c688), drawn by battle_ui.js; it does not blink, it bobs (see battle_ui.js ARROW_BOB).
//     arrowOn() below still blinks and is no longer what the scene shows.

// FA1: measured on the real game (oracle): battle messages print ONE character per game-logic frame whatever the Text Speed option is (SLOW, MID and FAST gave
// identical frames; only the INSTANT option, value 3, prints a whole message at once). So 'mid' and 'fast' are that real pace (delay 0 = no wait between characters);
// 'slow' is an arena-only slower pace (delay 3), not a ROM setting. The old 8 / 4 / 1 were recollection of the Gen-3 decompilation and are not what this ROM does.
export const TEXT_SPEED = Object.freeze({ slow: 3, mid: 0, fast: 0 });
export const BLINK_PERIOD = 16;   // frames per half-cycle of the more-text arrow

// Split a string into display units: one per character, but {TOKEN} stays one unit so a partial reveal never cuts
// a token in half. '\n' and '\p' are control units and take no width.
export function unitsOf(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '{') {
      const j = str.indexOf('}', i);
      if (j > i) { out.push(str.slice(i, j + 1)); i = j; continue; }
    }
    if (ch === '\\' && str[i + 1] === 'p') { out.push('\\p'); i++; continue; }
    out.push(ch);
  }
  return out;
}

const isCtl = (u) => u === '\n' || u === '\\p';

// Greedy word wrap on measured pixel width. Returns an array of PAGES, each page an array of at most maxLines
// lines (a line is an array of units). A '\n' starts a new line, '\p' starts a new page. A word wider than the
// window is broken at the character that overflows.
export function paginate(units, measure, maxWidth, maxLines = 2) {
  const pages = [];
  let page = [], line = [], lineW = 0;
  const flushLine = () => { page.push(line); line = []; lineW = 0; if (page.length >= maxLines) { pages.push(page); page = []; } };
  const w = (u) => measure(u);
  let i = 0;
  while (i < units.length) {
    const u = units[i];
    if (u === '\n') { flushLine(); i++; continue; }
    if (u === '\\p') { page.push(line); line = []; lineW = 0; pages.push(page); page = []; i++; continue; }
    if (u === ' ') {
      // a space is dropped at a line start; otherwise it travels with the word that follows
      if (line.length === 0) { i++; continue; }
      let j = i + 1, word = [];
      while (j < units.length && units[j] !== ' ' && !isCtl(units[j])) { word.push(units[j]); j++; }
      const ww = word.reduce((a, x) => a + w(x), 0);
      if (lineW + w(' ') + ww > maxWidth) { flushLine(); i++; continue; }   // wrap: the space is swallowed
      line.push(' '); lineW += w(' '); i++; continue;
    }
    const cw = w(u);
    if (lineW + cw > maxWidth && line.length) flushLine();
    line.push(u); lineW += cw; i++;
  }
  if (line.length || page.length) { page.push(line); }
  if (page.length) pages.push(page);
  if (!pages.length) pages.push([[]]);
  return pages.map((pg) => { const l = pg.slice(0, maxLines); while (l.length < maxLines) l.push([]); return l; });
}

export function createTypewriter(opts) {
  const { text, measure, maxWidth = 208, maxLines = 2 } = opts;
  const baseDelay = opts.delay === undefined ? TEXT_SPEED.mid : opts.delay;
  const pages = paginate(unitsOf(text), measure, maxWidth, maxLines);
  let page = 0, shown = 0, counter = 0, frame = 0, waiting = false, finished = false;
  const pageLen = (p) => pages[p].reduce((a, l) => a + l.length, 0);
  const tw = {
    pages: pages.map((p) => p.map((l) => l.join(''))),
    get page() { return page; },
    get shown() { return shown; },
    get waiting() { return waiting; },   // current page fully printed and another page follows: needs a button
    get done() { return finished; },     // last page fully printed
    // one frame. fast = A or B held.
    tick(fast = false) {
      frame++;
      if (finished || waiting) return;
      const delay = fast ? 0 : baseDelay;
      if (counter > 0) { counter--; return; }
      // print one unit, then wait `delay` frames before the next one
      if (shown < pageLen(page)) { shown++; counter = delay; }
      if (shown >= pageLen(page)) {
        if (page + 1 < pages.length) waiting = true; else finished = true;
      }
    },
    // A/B pressed while a page is waiting: go to the next page
    next() { if (waiting) { page++; shown = 0; counter = 0; waiting = false; return true; } return false; },
    // The currently visible text as `maxLines` strings (tokens kept as {TOKEN} text).
    lines() {
      let left = shown;
      return pages[page].map((l) => { const take = Math.max(0, Math.min(l.length, left)); left -= take; return l.slice(0, take).join(''); });
    },
    // blinking more-text arrow state: true while waiting and in the "on" half of the blink
    arrowOn() { return waiting && (Math.floor(frame / BLINK_PERIOD) % 2 === 0); },
    // frames needed to print the whole text at the given delay (no waiting pages), for tests and for auto-advance
    framesToPrint(fast = false) { const d = fast ? 0 : baseDelay; let n = 0; for (let p = 0; p < pages.length; p++) n += pageLen(p) * (d + 1) - d; return Math.max(0, n); },
  };
  return tw;
}

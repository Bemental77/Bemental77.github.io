// pokemonarena/js/hints.js -- the one-line "how do I play" hint under the screen, in the words of the device the player last used.
//
//   hintFor(input, 'gamepad') -> 'Controller: D-pad or stick move - A button chooses - B button goes back - Menu opens the menu'
//   watchHints(input, el, { menu: true }) keeps el.textContent current: the first real input switches the line to that device, and a later
//   change of device (keyboard -> mouse -> controller -> touch) rewrites it; before any input the page's own static text stays.
//
// The button names come from input.glyph(), so they follow rebinding in the Controls panel and the controller family (Xbox A / Nintendo A / Cross).
// DOM text on purpose: it is a hint about the player's own device, not game content. Pure apart from the element it writes.

const DOT = ' · ';

export function hintFor(input, source, { menu = true, pad = true, battle = false } = {}) {
  const g = (a, s) => { try { return input.glyph(a, s) || ''; } catch (_e) { return ''; } };
  const parts = [];
  switch (source) {
    case 'keyboard':
      parts.push('Keyboard: arrows or WASD move', g('a', 'keyboard') + ' chooses', g('b', 'keyboard') + ' goes back');
      if (menu) parts.push(g('start', 'keyboard') + ' opens the menu');
      break;
    case 'gamepad':
      parts.push('Controller: D-pad or stick move', g('a', 'gamepad') + ' chooses', g('b', 'gamepad') + ' goes back');
      if (menu) parts.push(g('start', 'gamepad') + ' opens the menu');
      break;
    case 'mouse':
      parts.push('Mouse: point to move the cursor', 'click chooses', 'right-click goes back', 'the wheel scrolls');
      if (battle) parts.push('in the move menu, Back and Info are on the picture');
      break;
    case 'touch': {
      // W1 fix A4: say what is really on screen. The on-screen pad is shown from the first touch (any touch screen, whatever the media queries say); a tap beside an open menu goes back without it,
      // and the move menu has its own Back and Info chips on the picture.
      const padOn = typeof pad === 'function' ? !!pad() : pad !== false;
      parts.push('Touch: tap to choose', padOn ? 'tap beside a menu or use the on-screen pad to go back' : 'tap beside a menu to go back');
      if (battle) parts.push('the move menu has Back and Info on the picture');
      break;
    }
    default: return '';
  }
  return parts.join(DOT);
}

export function watchHints(input, el, opts = {}) {
  if (!input || !el || typeof input.on !== 'function') return () => {};
  const first = el.textContent;
  const paint = (src) => { const t = hintFor(input, src, opts); el.textContent = t || first; el.dataset.hintSource = t ? src : ''; };
  const off = [input.on('source', (e) => paint(e.source)), input.on('bindings', () => { if (input.sourceKnown) paint(input.lastSource); })];
  return () => { for (const o of off) o(); };
}

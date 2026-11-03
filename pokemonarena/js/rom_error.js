// pokemonarena/js/rom_error.js -- the ONE error experience for "the ROM could not be used", on the hub, the battle page and the team editor.
//
//   const info = describeRomError(e);                 // -> { kind, title, message, detail, retry, tech }
//   showRomError({ boot, err, errTitle, errMsg, errDetail, retry, quick }, info);
//
// Plain player language: what went wrong and what to do about it. The server path, the HTTP status line and the hashes are for a developer, so they
// go to the console and into the `title` attribute of the detail line (hover), never into the visible text. Every page shows the same title, the same
// message, the same explanation, and the same buttons (Try again only when trying again can help).

import { RomLoadError, romUrl } from './romfetch.js';

const NEEDS = 'This game needs Pokemon SoulGold v1.1.1, the same game file the GBA page of this site uses. Every picture is drawn from it; nothing is downloaded from anywhere else.';

export function describeRomError(e) {
  const kind = e instanceof RomLoadError ? e.kind : 'internal';
  const tech = String(e && e.message ? e.message : e);
  const status = e && e.details && e.details.status ? e.details.status : (/HTTP (\d{3})/.exec(tech) || [])[1];
  if (kind === 'missing') {
    return {
      kind, retry: true, tech: tech + (safeUrl() ? ' [' + safeUrl() + ']' : ''),
      title: 'The game file could not be loaded',
      message: /interrupted/i.test(tech)
        ? 'The download of the game file stopped part of the way. Check your connection and try again.'
        : status === '404' || status === 404
          ? 'This site did not have the game file where it looked (error 404). Try again in a moment; if it keeps happening the file may be missing from the site.'
          : 'The game file could not be fetched. Check your connection and try again.',
      detail: NEEDS,
    };
  }
  if (kind === 'hash' || kind === 'format' || kind === 'length') {
    return {
      kind, retry: false, tech,
      title: 'This is not the game file this game needs',
      message: 'The file that was loaded is not Pokemon SoulGold v1.1.1: it may be another version, a damaged download or a modified copy. Only the exact v1.1.1 file works.',
      detail: NEEDS,
    };
  }
  return { kind: 'internal', retry: false, tech, title: 'Something went wrong', message: 'The game hit a problem it could not recover from. Reloading the page may help.', detail: tech.slice(0, 160) };
}

function safeUrl() { try { return romUrl(); } catch (_e) { return ''; } }

/** Put an error on the shared error panel (the same ids on every page). Never inserts markup: text only. */
export function showRomError(els, info) {
  if (els.boot) els.boot.hidden = true;
  if (els.err) els.err.hidden = false;
  if (els.errTitle) els.errTitle.textContent = info.title;
  if (els.errMsg) els.errMsg.textContent = info.message;
  if (els.errDetail) { els.errDetail.textContent = info.detail || ''; els.errDetail.title = info.tech || ''; }
  if (els.retry) els.retry.hidden = !info.retry;
  if (els.quick) els.quick.hidden = true;               // the battle page's "Quick Battle" link belongs to a refused ADDRESS, not to a missing game file
  if (info.tech && typeof console !== 'undefined') console.warn('[rom] ' + info.kind + ': ' + info.tech);
}

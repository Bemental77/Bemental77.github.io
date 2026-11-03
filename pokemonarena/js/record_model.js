// pokemonarena/js/record_model.js -- the RECORD screen's pages, as data: a profile's battle record (profile.stats, schema 3) -> pages of text lines for the ROM renderer.
//
// Pure ES module (browser + Node): no DOM, no ROM, no clock (the caller passes the time zone offset). Same page format as recap_model.js (PAGE_W x PAGE_H, lines of
// positioned cells), drawn by page_draw.js. The hub reads the profiles from the store (hub_data.js), builds these pages with the pack's names, and hands plain JSON
// to hub_model.js, which only turns pages; nothing here touches storage.
//
//   const pages = buildRecordPages(stats, { speciesName, moveName, tzMinutes: 0, resettable: true });
//
// PAGES: OVERALL (battles, win rate, won / lost / drawn / gave up, streak, first and last battle, time played), BY FORMAT AND CPU (3v3, 6v6, EASY, NORMAL, HARD),
// FAVOURITES (the most used Pokemon and moves, most MVP awards), HIGHS (biggest hit, fastest win, longest battle, best KO streak and win streak), TOTALS (KOs, faints,
// damage, hits, crits, effectiveness, misses, status, healing), RECENT (the last 20 battles, five to a page) and RESET. A profile with no battle yet has one page that says so.

import { battleCount, winRate, favList } from './career_stats.js';

export const RECORD_RECENT_PER_PAGE = 5;
const cell = (t, x, w, a = 'l', f = 'small', tone = 'dark') => ({ t: String(t), x, w, a, f, tone });
const line = (y, ...cells) => ({ y, cells });
const RES = { w: 'WON', l: 'LOST', d: 'DRAW', f: 'QUIT' };
const RES_TONE = { w: 'good', l: 'bad', d: 'dark', f: 'bad' };
const CPU = { easy: 'EASY', normal: 'NORMAL', hard: 'HARD' };
const pad2 = (n) => String(n).padStart(2, '0');

/** 'YY-MM-DD' of a time in ms, shifted by tzMinutes (minutes WEST of UTC, as Date.getTimezoneOffset() says). */
export function dateText(ms, tzMinutes = 0) {
  const d = new Date(ms - tzMinutes * 60000);
  return pad2(d.getUTCFullYear() % 100) + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
}
/** A play time in ms as '2H 05M', '14M 30S' or '35S'. */
export function timeText(ms) {
  const s = Math.floor(ms / 1000);
  if (s >= 3600) return Math.floor(s / 3600) + 'H ' + pad2(Math.floor((s % 3600) / 60)) + 'M';
  if (s >= 60) return Math.floor(s / 60) + 'M ' + pad2(s % 60) + 'S';
  return s + 'S';
}
const num = (n) => String(n);

export function buildRecordPages(stats, ctx = {}) {
  const spName = ctx.speciesName || ((id) => 'No. ' + id);
  const mvName = ctx.moveName || ((id) => 'Move ' + id);
  const tz = ctx.tzMinutes | 0;
  const n = battleCount(stats);
  const pages = [];
  const page = (id, title) => { const p = { id, title, lines: [], icons: [] }; pages.push(p); return p; };

  /* OVERALL */
  const p1 = page('overall', 'OVERALL');
  if (n === 0) {
    p1.lines.push(line(1, cell('NO BATTLES YET', 2, 214, 'l', 'normal', 'dim')));
    p1.lines.push(line(24, cell('Every battle you finish with this trainer', 2, 214)));
    p1.lines.push(line(37, cell('is kept here: wins and losses, streaks, your', 2, 214)));
    p1.lines.push(line(50, cell('best hits, favourite Pokemon and moves, and', 2, 214)));
    p1.lines.push(line(63, cell('the last 20 battles. Giving up counts too.', 2, 214)));
    return pages;
  }
  const rate = winRate(stats);
  p1.lines.push(line(1, cell('BATTLES ' + n, 2, 100, 'l', 'normal'), cell('WIN RATE ' + rate + '%', 108, 110, 'r', 'normal', 'hi')));
  p1.lines.push(line(22, cell('WON', 2, 60, 'l', 'small', 'dim'), cell(stats.wins, 62, 30, 'r'), cell('LOST', 110, 60, 'l', 'small', 'dim'), cell(stats.losses, 170, 46, 'r')));
  p1.lines.push(line(35, cell('DRAWN', 2, 60, 'l', 'small', 'dim'), cell(stats.draws, 62, 30, 'r'), cell('GAVE UP', 110, 60, 'l', 'small', 'dim'), cell(stats.forfeits, 170, 46, 'r')));
  p1.lines.push(line(52, cell('WIN STREAK', 2, 90, 'l', 'small', 'dim'), cell(stats.streak + ' NOW, BEST ' + stats.best, 94, 124, 'r')));
  p1.lines.push(line(65, cell('FIRST BATTLE', 2, 90, 'l', 'small', 'dim'), cell(stats.firstMatchAt === null ? '-' : dateText(stats.firstMatchAt, tz), 94, 124, 'r')));
  p1.lines.push(line(78, cell('LAST BATTLE', 2, 90, 'l', 'small', 'dim'), cell(stats.lastMatchAt === null ? '-' : dateText(stats.lastMatchAt, tz), 94, 124, 'r')));
  p1.lines.push(line(91, cell('TIME PLAYED', 2, 90, 'l', 'small', 'dim'), cell(timeText(stats.playMs), 94, 124, 'r')));

  /* BY FORMAT AND CPU */
  const p2 = page('by', 'MODES');
  p2.lines.push(line(1, cell('', 2, 60), cell('WON', 62, 36, 'r', 'small', 'dim'), cell('LOST', 100, 36, 'r', 'small', 'dim'), cell('DRAWN', 138, 40, 'r', 'small', 'dim'), cell('QUIT', 180, 36, 'r', 'small', 'dim')));
  const rowOf = (y, label, r) => line(y, cell(label, 2, 58, 'l', 'small', 'dark'), cell(r.w, 62, 36, 'r'), cell(r.l, 100, 36, 'r'), cell(r.dr, 138, 40, 'r'), cell(r.f, 180, 36, 'r'));
  p2.lines.push(rowOf(16, '3V3', stats.byFormat['3v3']), rowOf(29, '6V6', stats.byFormat['6v6']));
  p2.lines.push(rowOf(48, 'EASY', stats.byCpu.easy), rowOf(61, 'NORMAL', stats.byCpu.normal), rowOf(74, 'HARD', stats.byCpu.hard));
  const sum = (r) => r.w + r.l + r.dr + r.f;
  const best = ['easy', 'normal', 'hard'].filter((k) => sum(stats.byCpu[k]) > 0).map((k) => [k, Math.floor((200 * stats.byCpu[k].w + sum(stats.byCpu[k])) / (2 * sum(stats.byCpu[k])))]);
  p2.lines.push(line(92, cell('WIN RATE', 2, 58, 'l', 'small', 'dim'), cell(best.length ? best.map(([k, r]) => CPU[k] + ' ' + r + '%').join('  ') : '-', 62, 154, 'r')));

  /* FAVOURITES */
  const p3 = page('fav', 'FAVOURITES');
  const sp = favList(stats.fav.species, 5), mv = favList(stats.fav.moves, 5), mvp = favList(stats.fav.mvps, 3);
  p3.lines.push(line(1, cell('POKEMON USED', 2, 104, 'l', 'small', 'dim'), cell('MOVES USED', 114, 104, 'l', 'small', 'dim')));
  for (let i = 0; i < 5; i++) {
    const a = sp[i], b = mv[i];
    p3.lines.push(line(14 + i * 13, a ? cell(spName(a[0]), 2, 76, 'l', 'small', i === 0 ? 'hi' : 'dark') : cell('', 2, 76), a ? cell(a[1], 80, 26, 'r') : cell('', 80, 26), b ? cell(mvName(b[0]), 114, 80, 'l', 'small', i === 0 ? 'hi' : 'dark') : cell('', 114, 80), b ? cell(b[1], 196, 22, 'r') : cell('', 196, 22)));
  }
  p3.lines.push(line(82, cell('MOST MVP AWARDS', 2, 100, 'l', 'small', 'dim')));
  { const parts = []; let chars = 0; for (const [id, c] of mvp) { const t = spName(id) + ' ' + c; if (parts.length && chars + t.length + 2 > 34) break; parts.push(t); chars += t.length + 2; }
    p3.lines.push(line(95, cell(parts.length ? parts.join(', ') : 'NONE YET', 2, 214, 'l', 'small', parts.length ? 'dark' : 'dim'))); }

  /* HIGHS */
  const p4 = page('highs', 'HIGHS');
  const b = stats.bests;
  p4.lines.push(line(1, cell('BIGGEST HIT', 2, 76, 'l', 'small', 'dim'), cell(b.hit ? spName(b.hit.sp) + ': ' + mvName(b.hit.mv) : 'NONE YET', 78, 140, 'l', 'small', b.hit ? 'dark' : 'dim')));
  if (b.hit) p4.lines.push(line(14, cell('', 2, 76), cell(b.hit.dmg + ' HP, ' + b.hit.pct + '% OF ' + spName(b.hit.vs), 78, 140)));
  p4.lines.push(line(32, cell('FASTEST WIN', 2, 90, 'l', 'small', 'dim'), cell(b.fastestWin ? b.fastestWin.turns + ' TURNS' : 'NONE YET', 94, 124, 'r', 'small', b.fastestWin ? 'dark' : 'dim')));
  p4.lines.push(line(45, cell('LONGEST BATTLE', 2, 90, 'l', 'small', 'dim'), cell(b.longest ? b.longest.turns + ' TURNS' : 'NONE YET', 94, 124, 'r', 'small', b.longest ? 'dark' : 'dim')));
  p4.lines.push(line(58, cell('BEST KO STREAK', 2, 90, 'l', 'small', 'dim'), cell(b.koStreak ? b.koStreak + ' IN A ROW' : 'NONE YET', 94, 124, 'r', 'small', b.koStreak ? 'dark' : 'dim')));
  p4.lines.push(line(71, cell('BEST WIN STREAK', 2, 90, 'l', 'small', 'dim'), cell(stats.best ? stats.best + ' WINS' : 'NONE YET', 94, 124, 'r', 'small', stats.best ? 'dark' : 'dim')));
  p4.lines.push(line(84, cell('MOST DAMAGE', 2, 90, 'l', 'small', 'dim'), cell(stats.totals.dealt + ' IN ALL', 94, 124, 'r')));

  /* TOTALS */
  const p5 = page('totals', 'TOTALS');
  const t = stats.totals;
  const left = [['BATTLE TURNS', t.turns], ['KOS SCORED', t.kos], ['TIMES FAINTED', t.faints], ['DAMAGE DEALT', t.dealt], ['DAMAGE TAKEN', t.taken], ['HP HEALED', t.healed], ['SWITCHES', t.switches]];
  const right = [['HITS LANDED', t.hits], ['CRITICAL HITS', t.crits], ['SUPER EFFECTIVE', t.superEffective], ['RESISTED HITS', t.resisted], ['NO EFFECT', t.noEffect], ['MISSES', t.misses], ['STATUS INFLICTED', t.statusInflicted]];
  for (let i = 0; i < 7; i++) p5.lines.push(line(1 + i * 13, cell(left[i][0], 2, 68, 'l', 'small', 'dim'), cell(left[i][1], 68, 40, 'r'), cell(right[i][0], 112, 74, 'l', 'small', 'dim'), cell(right[i][1], 186, 32, 'r')));

  /* RECENT */
  const recent = stats.recent;
  const nPages = Math.max(1, Math.ceil(recent.length / RECORD_RECENT_PER_PAGE));
  for (let k = 0; k < nPages; k++) {
    const p = page('recent' + k, 'RECENT');
    recent.slice(k * RECORD_RECENT_PER_PAGE, (k + 1) * RECORD_RECENT_PER_PAGE).forEach((r, i) => {
      const y = 1 + i * 21;
      p.lines.push(line(y, cell(RES[r.res], 2, 32, 'l', 'small', RES_TONE[r.res]), cell(dateText(r.at, tz), 36, 52), cell(r.fmt.toUpperCase() + ' ' + CPU[r.cpu], 92, 72), cell(r.turns + (r.res === 'f' ? ' T' : ' TURNS'), 166, 52, 'r')));
      const names = r.team.map((s) => spName(s));
      let shown = [], used = 0;
      for (const nm of names) { if (used + nm.length + 2 > 24 && shown.length) break; shown.push(nm); used += nm.length + 2; }
      const more = names.length - shown.length;
      p.lines.push(line(y + 10, cell(r.mvp ? 'MVP ' + spName(r.mvp) : 'NO MVP', 2, 92, 'l', 'small', 'dim'), { ...cell(shown.join(', ') + (more > 0 ? ' +' + more : ''), 98, 120, 'r', 'small', 'dim'), cutOk: true }));
    });
  }

  /* RESET */
  const p7 = page('reset', 'RESET');
  p7.lines.push(line(1, cell('FORGET THIS TRAINER\'S BATTLES?', 2, 214, 'l', 'normal')));
  p7.lines.push(line(22, cell('Wins, losses, streaks, highs, favourites', 2, 214)));
  p7.lines.push(line(35, cell('and the recent battles go back to zero.', 2, 214)));
  p7.lines.push(line(48, cell('Teams and Pokemon are not touched.', 2, 214)));
  p7.lines.push(line(61, cell('The old record is kept as a backup.', 2, 214)));
  p7.button = { label: ctx.resettable === false ? 'READ ONLY' : 'RESET RECORD', x: 62, y: 86, w: 96, h: 16, enabled: ctx.resettable !== false };
  return pages;
}

/** The pages for a profile that cannot show a record: kind 'none' (no profile), 'unavailable' (storage), 'loading'. */
export function buildRecordNotice(kind, trainerLine) {
  const p = { id: 'notice', title: 'RECORD', lines: [], icons: [] };
  if (kind === 'none') {
    p.lines.push(line(1, cell('NO TRAINER PROFILE YET', 2, 214, 'l', 'normal')));
    p.lines.push(line(24, cell('Your battles are kept on a trainer profile.', 2, 214)));
    p.lines.push(line(37, cell('Make one in the Team Builder, and every', 2, 214)));
    p.lines.push(line(50, cell('battle you finish is written down.', 2, 214)));
    p.lines.push(line(76, cell('Press A or click here for the Team Builder.', 2, 214, 'l', 'small', 'hi')));
    p.action = 'builder';
  } else if (kind === 'readonly') {
    p.lines.push(line(1, cell('THIS RECORD IS READ ONLY', 2, 214, 'l', 'normal', 'bad')));
    p.lines.push(line(24, cell('This profile was saved by a newer version', 2, 214)));
    p.lines.push(line(37, cell('of the Arena, so it cannot be shown or', 2, 214)));
    p.lines.push(line(50, cell('changed here.', 2, 214)));
  } else if (kind === 'unavailable') {
    p.lines.push(line(1, cell('THE RECORD CANNOT BE READ', 2, 214, 'l', 'normal', 'bad')));
    p.lines.push(line(24, cell('This browser is not keeping profiles', 2, 214)));
    p.lines.push(line(37, cell('(blocked storage or private mode), so', 2, 214)));
    p.lines.push(line(50, cell('there is no record to show.', 2, 214)));
  } else {
    p.lines.push(line(1, cell(trainerLine || 'LOOKING FOR YOUR RECORD...', 2, 214, 'l', 'normal', 'dim')));
  }
  return [p];
}

/** The page shown while RESET RECORD asks YES / NO (the hub draws YES and NO as its two chips). */
export function buildResetConfirm(name) {
  const p = { id: 'confirm', title: 'RESET RECORD', lines: [], icons: [] };
  p.lines.push(line(1, cell('RESET ' + String(name).toUpperCase() + "'S RECORD?", 2, 214, 'l', 'normal', 'bad')));
  p.lines.push(line(26, cell('Every battle, streak and high score of', 2, 214)));
  p.lines.push(line(39, cell('this trainer goes back to zero. Teams are', 2, 214)));
  p.lines.push(line(52, cell('kept, and so is a backup of the old record.', 2, 214)));
  p.lines.push(line(75, cell('NO is the safe answer.', 2, 214, 'l', 'small', 'dim')));
  return p;
}

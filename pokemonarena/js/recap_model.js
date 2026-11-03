// pokemonarena/js/recap_model.js -- the MATCH RECAP, as data: match_stats.js summary (+ what the career says about it) -> pages of text lines for the ROM renderer.
//
// Pure ES module (browser + Node): no DOM, no ROM, no clock. Nothing here is drawn; every page is a plain list of lines with absolute positions inside the
// recap window (PAGE_W x PAGE_H pixels), so a test can measure every cell with the ROM font widths and prove that it fits, and so the same pages can be
// drawn by battle_ui.js (the recap screen) and read back by the tests. The words are written by this site (the ROM has no recap), set in the ROM fonts.
//
//   const pages = buildRecapPages(summary, { moveName, speciesName, career });     // career: null | { state, profileName, callouts, stats }
//   pages[i] = { id, title, lines: [{ y, cells: [{ t, x, w, a: 'l'|'r'|'c', f: 'normal'|'small', tone }] }], icons: [{ sp, x, y }] }
//
// PAGES (always 7, in this order): SUMMARY (result, turns, MVP, biggest hit, closest call, first blood / a record), MOMENTS (first blood, biggest hit,
// last hit, closest call, KO streak, flags, weather), YOUR TEAM and THE FOE'S TEAM (damage dealt / taken, KOs, HP left, per Pokemon), MOVES (the most used
// moves of each side), COMPARE (hits, crits, effectiveness, misses, status, healing, switches of each side) and RECORD (what was written to the career, and the records
// this match set). A forfeit, a draw and a quick battle with no profile each get their own wording; nothing is left blank or invented.

export const PAGE_W = 220, PAGE_H = 106;
export const RECAP_PAGE_IDS = Object.freeze(['summary', 'moments', 'team0', 'team1', 'moves', 'compare', 'record']);
const TITLES = { summary: 'SUMMARY', moments: 'MOMENTS', team0: 'YOUR TEAM', team1: 'FOE TEAM', moves: 'MOVES', compare: 'COMPARE', record: 'RECORD' };
const WEATHER = { 1: 'RAIN', 2: 'SUN', 3: 'SAND', 4: 'HAIL', 5: 'SNOW', 6: 'HEAVY RAIN', 7: 'HARSH SUN', 8: 'WINDS' };
const TERRAIN = { grassy: 'GRASSY', electric: 'ELECTRIC', misty: 'MISTY', psychic: 'PSYCHIC', scorched: 'SCORCHED' };
const CALLOUT_TEXT = {
  'first-win': () => 'FIRST WIN!',
  streak: (n) => 'NEW BEST STREAK: ' + n + ' WINS',
  fastest: (n) => 'FASTEST WIN YET: ' + n + ' TURNS',
  hit: (n) => 'BIGGEST HIT YET: ' + n + ' HP',
  longest: (n) => 'LONGEST BATTLE YET: ' + n + ' TURNS',
  'ko-streak': (n) => 'BEST KO STREAK: ' + n,
};
export const calloutText = (c) => (CALLOUT_TEXT[c.kind] ? CALLOUT_TEXT[c.kind](c.n) : '');

const cell = (t, x, w, a = 'l', f = 'small', tone = 'dark') => ({ t: String(t), x, w, a, f, tone });
const line = (y, ...cells) => ({ y, cells });
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);

/** Everything a page needs, from a summary. ctx: { moveName(id), speciesName(sp), career, mineLabel, foeLabel } (all optional). */
export function buildRecapPages(summary, ctx = {}) {
  const moveName = ctx.moveName || ((id) => 'Move ' + id);
  const spName = ctx.speciesName || ((id) => 'No. ' + id);
  const V = summary.viewSide, F = V ^ 1;
  const me = summary.sides[V], foe = summary.sides[F];
  const mineLabel = (ctx.mineLabel || me.name || 'YOU').toUpperCase(), foeLabel = (ctx.foeLabel || foe.name || 'FOE').toUpperCase();
  const monOf = (side, slot) => summary.sides[side].mons.find((m) => m.slot === slot);
  const nameOf = (side, slot, sp) => { const m = monOf(side, slot); return (m && m.name) || spName(sp); };
  const prefix = (side) => (side === V ? '' : 'Foe ');
  const who = (r) => (r ? prefix(r.side) + nameOf(r.side, r.slot, r.sp) : '');

  const result = summary.result;
  const headText = { w: 'YOU WON!', l: 'YOU LOST.', d: 'A DRAW.', f: 'YOU GAVE UP.', none: 'NO RESULT.' }[result] || 'NO RESULT.';
  const turnsText = result === 'f' ? 'ON TURN ' + summary.turns : plural(summary.turns, 'TURN', 'TURNS');
  const career = ctx.career || null;
  const callouts = career && Array.isArray(career.callouts) ? career.callouts.map(calloutText).filter(Boolean) : [];

  /* ------------------------------------------------------------------------------------------------ 1 SUMMARY */
  const summary1 = { id: 'summary', title: TITLES.summary, lines: [], icons: [] };
  summary1.lines.push(line(1, cell(headText, 2, 130, 'l', 'normal', result === 'w' ? 'good' : result === 'l' || result === 'f' ? 'bad' : 'dark'), cell(turnsText, 112, 106, 'r', 'normal')));
  if (summary.mvp) {
    const m = summary.mvp;
    summary1.icons.push({ sp: m.sp, x: 0, y: 19 });
    summary1.lines.push(line(21, cell('MVP', 36, 40, 'l', 'small', 'dim')));
    summary1.lines.push(line(31, cell(m.name || spName(m.sp), 36, 180, 'l', 'normal', 'hi')));
    summary1.lines.push(line(48, cell(plural(m.kos, 'KO', 'KOS') + '   ' + m.dealt + ' DAMAGE (' + m.dealtPct + '%)', 36, 182)));
  } else {
    summary1.lines.push(line(21, cell('MVP', 2, 40, 'l', 'small', 'dim')));
    summary1.lines.push(line(31, cell('NONE: NOBODY SCORED', 2, 214, 'l', 'normal', 'dim')));
  }
  const bh = summary.biggestHit;
  summary1.lines.push(line(64, cell('BIGGEST HIT', 2, 70, 'l', 'small', 'dim'), cell(bh ? who(bh) + ': ' + moveName(bh.mv) : 'NO ATTACK LANDED', 74, 144)));
  summary1.lines.push(line(77, cell('CLOSEST CALL', 2, 70, 'l', 'small', 'dim'), cell(summary.closestCall ? summary.closestCall.name + ' LEFT AT ' + summary.closestCall.pct + '%' : 'NO ONE WAS HURT AND LIVED', 74, 144)));
  if (callouts.length) summary1.lines.push(line(90, cell('NEW RECORD', 2, 70, 'l', 'small', 'hi'), cell(callouts[0], 74, 144, 'l', 'small', 'hi')));
  else { const fb = summary.firstBlood; summary1.lines.push(line(90, cell('FIRST BLOOD', 2, 70, 'l', 'small', 'dim'), cell(fb ? (fb.by ? who(fb.by) + ' (TURN ' + fb.turn + ')' : who(fb.victim) + ' FAINTED (TURN ' + fb.turn + ')') : 'NOBODY FAINTED', 74, 144))); }

  /* ------------------------------------------------------------------------------------------------ 2 MOMENTS */
  const m2 = { id: 'moments', title: TITLES.moments, lines: [], icons: [] };
  { let y = 1;
    const row = (label, value, tone) => { m2.lines.push(line(y, cell(label, 2, 70, 'l', 'small', 'dim'), cell(value, 74, 144, 'l', 'small', tone || 'dark'))); y += 13; };
    const fb = summary.firstBlood;
    row('FIRST BLOOD', fb ? (fb.by ? who(fb.by) + ': ' + moveName(fb.by.mv) : who(fb.victim) + ' FAINTED') : 'NOBODY FAINTED');
    if (fb) row('', (fb.by ? 'KO ON ' + who(fb.victim) + ' ' : '') + 'TURN ' + fb.turn);
    row('BIGGEST HIT', bh ? who(bh) + ': ' + moveName(bh.mv) : 'NO ATTACK LANDED');
    if (bh) row(bh.crit ? 'CRITICAL HIT' : '', bh.dmg + ' HP, ' + bh.pct + '% OF ' + nameOf(bh.vs.side, bh.vs.slot, bh.vs.sp));
    row('LAST HIT', summary.lastHit ? who(summary.lastHit) + ': ' + moveName(summary.lastHit.mv) : result === 'f' ? 'THE BATTLE WAS GIVEN UP' : result === 'd' ? 'NO LAST HIT: A DRAW' : 'NOT AN ATTACK');
    row('KO STREAK', summary.koStreak.n > 0 ? plural(summary.koStreak.n, 'KO', 'KOS') + ' IN A ROW (' + (summary.koStreak.side === V ? 'YOU' : 'FOE') + ')' : 'NO KOS');
    const flags = []; if (summary.flags.noFaintWin) flags.push('NO FAINTS'); if (summary.flags.sweep) flags.push('ONE-MON SWEEP'); if (summary.flags.comeback) flags.push('COMEBACK'); if (summary.flags.forfeit) flags.push('GAVE UP');
    const wx = summary.weather.map((p) => (WEATHER[p[0]] || 'WEATHER') + ' ' + p[1]).join(', '), tn = summary.terrain.map((p) => (TERRAIN[p[0]] || p[0].toUpperCase()) + ' ' + p[1]).join(', ');
    row('FLAGS', flags.length ? flags.join(', ') : 'NONE', flags.length ? 'hi' : 'dim');
    row('FIELD', wx || tn ? [wx, tn].filter(Boolean).join('; ') + ' TURNS' : 'NO WEATHER OR TERRAIN', wx || tn ? 'dark' : 'dim');
  }

  /* ------------------------------------------------------------------------------------------------ 3, 4 the teams */
  const teamPage = (id, side, label) => {
    const s = summary.sides[side];
    const p = { id, title: TITLES[id], lines: [], icons: [] };
    p.lines.push(line(1, cell(label, 2, 76, 'l', 'small', 'dim'), cell('DEALT', 78, 34, 'r', 'small', 'dim'), cell('TAKEN', 114, 34, 'r', 'small', 'dim'), cell('KOS', 150, 22, 'r', 'small', 'dim'), cell('HP LEFT', 172, 46, 'r', 'small', 'dim')));
    const mv = s.mvp ? s.mvp.slot : -1;
    s.mons.slice(0, 6).forEach((m, i) => {
      p.lines.push(line(14 + i * 13, cell(m.name || spName(m.sp), 2, 76, 'l', 'small', m.slot === mv ? 'hi' : m.played ? 'dark' : 'dim'), cell(m.dealt, 78, 34, 'r'), cell(m.taken, 114, 34, 'r'), cell(m.kos, 150, 22, 'r'),
        cell(!m.played ? '-' : m.endHp <= 0 ? 'FAINTED' : m.endPct + '%', 172, 46, 'r', 'small', !m.played ? 'dim' : m.endHp <= 0 ? 'bad' : 'dark')));
    });
    p.lines.push(line(94, cell('TOTAL', 2, 76, 'l', 'small', 'dim'), cell(s.dealt, 78, 34, 'r'), cell(s.taken, 114, 34, 'r'), cell(s.kos, 150, 22, 'r'), cell(s.hpLeftPct + '%', 172, 46, 'r')));
    return p;
  };
  const t0 = teamPage('team0', V, mineLabel), t1 = teamPage('team1', F, foeLabel);

  /* ------------------------------------------------------------------------------------------------ 5 MOVES */
  const m5 = { id: 'moves', title: TITLES.moves, lines: [], icons: [] };
  m5.lines.push(line(1, cell(mineLabel, 2, 104, 'l', 'small', 'dim'), cell(foeLabel, 114, 104, 'l', 'small', 'dim')));
  for (let i = 0; i < 5; i++) {
    const a = me.moves[i], b = foe.moves[i];
    m5.lines.push(line(14 + i * 13, a ? cell(moveName(a[0]), 2, 80, 'l', 'small', i === 0 ? 'hi' : 'dark') : cell(i === 0 ? 'NO MOVES USED' : '', 2, 104, 'l', 'small', 'dim'), a ? cell('x' + a[1], 84, 22, 'r') : cell('', 84, 22),
      b ? cell(moveName(b[0]), 114, 80, 'l', 'small', i === 0 ? 'hi' : 'dark') : cell(i === 0 ? 'NO MOVES USED' : '', 114, 104, 'l', 'small', 'dim'), b ? cell('x' + b[1], 196, 22, 'r') : cell('', 196, 22)));
  }
  const sum = (arr) => arr.reduce((n, p) => n + p[1], 0);
  m5.lines.push(line(82, cell('MOVES USED', 2, 76, 'l', 'small', 'dim'), cell(sum(me.moves), 84, 22, 'r'), cell(sum(foe.moves), 196, 22, 'r')));
  m5.lines.push(line(94, cell('DIFFERENT MOVES', 2, 90, 'l', 'small', 'dim'), cell(me.moves.length, 84, 22, 'r'), cell(foe.moves.length, 196, 22, 'r')));

  /* ------------------------------------------------------------------------------------------------ 6 COMPARE */
  const m6 = { id: 'compare', title: TITLES.compare, lines: [], icons: [] };
  m6.lines.push(line(1, cell(mineLabel, 2, 58, 'r', 'small', 'dim'), cell(foeLabel, 158, 60, 'l', 'small', 'dim')));
  const rows6 = [
    ['HITS LANDED', me.hits + me.subHits, foe.hits + foe.subHits], ['CRITICAL HITS', me.crits, foe.crits], ['SUPER EFFECTIVE', me.superEffective, foe.superEffective], ['NOT VERY EFFECTIVE', me.resisted, foe.resisted],
    ['MISSES', me.misses, foe.misses], ['STATUS INFLICTED', me.statusInflicted, foe.statusInflicted], ['HP HEALED', me.healed, foe.healed], ['SWITCHES', me.switches, foe.switches],
  ];
  rows6.forEach(([label, a, b], i) => {
    const hi = a > b ? 'hi' : 'dark', hj = b > a ? 'hi' : 'dark';
    m6.lines.push(line(14 + i * 11, cell(a, 2, 58, 'r', 'small', hi), cell(label, 64, 92, 'c', 'small', 'dark'), cell(b, 158, 60, 'l', 'small', hj)));
  });

  /* ------------------------------------------------------------------------------------------------ 7 RECORD */
  const m7 = { id: 'record', title: TITLES.record, lines: [], icons: [] };
  const st = career ? career.state : 'none';
  const who7 = career && career.profileName ? career.profileName : '';
  const head7 = st === 'saved' ? 'SAVED TO ' + who7 + '\'S RECORD' : st === 'duplicate' ? 'ALREADY IN ' + who7 + '\'S RECORD' : st === 'pending' ? 'SAVING...' : st === 'error' ? 'COULD NOT SAVE THIS BATTLE' : 'NOT SAVED';
  m7.lines.push(line(1, cell(head7, 2, 214, 'l', 'normal', st === 'saved' || st === 'duplicate' ? 'good' : st === 'error' ? 'bad' : 'dark')));
  if (st === 'saved' || st === 'duplicate') {
    const s = career.stats;
    const n = s ? s.wins + s.losses + s.draws + s.forfeits : 0;
    m7.lines.push(line(21, cell('BATTLES', 2, 58, 'l', 'small', 'dim'), cell(s ? n : '', 64, 154)));
    m7.lines.push(line(34, cell('RESULTS', 2, 46, 'l', 'small', 'dim'), cell(s ? s.wins + ' WON, ' + s.losses + ' LOST' + (s.draws ? ', ' + s.draws + ' DRAWN' : '') + (s.forfeits ? ', ' + s.forfeits + ' QUIT' : '') : '', 50, 168)));
    m7.lines.push(line(47, cell('WIN STREAK', 2, 60, 'l', 'small', 'dim'), cell(s ? s.streak + ' (BEST ' + s.best + ')' : '', 64, 154)));
    callouts.slice(0, 3).forEach((c, i) => m7.lines.push(line(63 + i * 13, cell(i === 0 ? 'RECORDS' : '', 2, 58, 'l', 'small', 'hi'), cell(c, 64, 154, 'l', 'small', 'hi'))));
    if (!callouts.length) m7.lines.push(line(63, cell('RECORDS', 2, 58, 'l', 'small', 'dim'), cell('NONE BEATEN THIS TIME', 64, 154, 'l', 'small', 'dim')));
  } else if (st === 'pending') m7.lines.push(line(21, cell('The battle is being written down.', 2, 214, 'l', 'small', 'dim')));
  else if (st === 'error') { m7.lines.push(line(21, cell('The record was not changed.', 2, 214, 'l', 'small', 'dim'))); m7.lines.push(line(34, cell('Storage may be blocked or full.', 2, 214, 'l', 'small', 'dim'))); }
  else {
    const notes = career && Array.isArray(career.notes) && career.notes.length ? career.notes : ['No trainer profile is in use, so this', 'battle is not kept. Make a profile in the', 'Team Builder to keep your record.'];
    notes.slice(0, 3).forEach((t, i) => m7.lines.push(line(21 + i * 13, cell(t, 2, 214, 'l', 'small', 'dim'))));
  }

  return [summary1, m2, t0, t1, m5, m6, m7];
}

/** Every cell of every page: [{ page, y, t, x, w, f }], for the width proofs in the tests. */
export function allCells(pages) { const out = []; for (const p of pages) for (const l of p.lines) for (const c of l.cells) if (c.t !== '') out.push({ page: p.id, y: l.y, ...c }); return out; }

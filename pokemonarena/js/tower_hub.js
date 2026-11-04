// pokemonarena/js/tower_hub.js -- the TOWER's screens in the hub, as a state machine: which screen, where the cursor is, what each press does. Pure ES module: no DOM, no ROM, no clock, no storage, no randomness.
//
// hub_model.js owns the main menu and the screen history and DELEGATES every path that starts with "tower" to this module (it adds one row to the main menu and a handful of lines of glue; everything the Tower
// shows or asks is here, so another row can be added to the main menu without touching any of it). tower_screen.js draws what view() returns. Nothing here navigates, saves or fights: it returns EFFECTS and
// boot.js carries them out against the profile store (tower_session.js), so the screens stay a pure function of the data they are given:
//
//   { type: 'tower-new',    profileId, teamId | null, format }      START was chosen on NEW RUN (teamId null = a random team)
//   { type: 'tower-fight',  profileId }                              FIGHT: go and fight the floor the run is waiting for (tower_launch.js launchFloorBattle)
//   { type: 'tower-pick',   profileId, seed, id | null }             a ball was taken (id), or the offer was skipped (null)
//   { type: 'tower-giveup', profileId }                              GIVE UP was answered YES
//   { type: 'screen', path, back? }                                  (hub_model's) a screen change
//
// SCREENS   tower          the status of the climb and its menu: FIGHT / CHOOSE A BUFF, MY BUFFS, NEW RUN, LAST RUN, ACHIEVEMENTS, TRAINER, BACK
//           tower-new      TEAM (a random one, or one of the trainer's saved legal teams), FORMAT, START, BACK
//           tower-offer    the buff offer: balls in a row (the ROM's own Poke Ball sprites), the highlighted one open and described; A asks "take it?", B / the SKIP chip asks "take nothing?"
//           tower-buffs    what the run holds (BUFFS) and the synergies that are active (SYNERGIES); A on a buff reads it in full
//           tower-ach      the 51 achievements, earned or not
//           tower-last     how the last climb ended
// DATA      every profile may carry `tower`: the summary tower_session.js summarizeTower builds (record, run, last, achievements), or null while the Tower's code is still loading.
//
// Input is hub_model's vocabulary (up down left right a b x y l r start select) and pointer events (move / down / click / wheel) in logical 240x160 pixels.

export const TOWER_PATHS = Object.freeze(['tower', 'tower-new', 'tower-offer', 'tower-buffs', 'tower-ach', 'tower-last']);
export const TOWER_RULESET = 'arena-gen3-standard';
export const isTowerPath = (p) => TOWER_PATHS.includes(p);
const PARENT = Object.freeze({ tower: 'main', 'tower-new': 'tower', 'tower-offer': 'tower', 'tower-buffs': 'tower', 'tower-ach': 'tower', 'tower-last': 'tower' });
/** Where B goes from a Tower screen. */
export const towerParent = (path) => PARENT[path] || null;

export const TGEOM = Object.freeze({
  menu: Object.freeze({ x: 12, y: 10, w: 124 }),                                              // (the row pitch is the hub's: see pitchFor)
  panel: Object.freeze({ x: 148, y: 12, w: 80, h: 80 }),                                       // the climb's status window (home, new run)
  list: Object.freeze({ x: 12, y: 10, w: 216, pitch: 12, rows: 7, top: 14 }),                // the buff / achievement lists: a header line, then 7 rows at the main menu's own row pitch
  detail: Object.freeze({ x: 12, y: 12, w: 216, h: 92 }),
  balls: Object.freeze({ cy: 31, lift: 5, sheet: 32 }),
  info: Object.freeze({ x: 12, y: 54, w: 216, h: 50 }),
  skip: Object.freeze({ x: 182, y: 1, w: 50, h: 14 }),
  yes: Object.freeze({ x: 152, y: 119, w: 36, h: 16 }),
  no: Object.freeze({ x: 192, y: 119, w: 36, h: 16 }),
});
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
/** Row spacing of a menu of n rows: the same rule as hub_model.js menuPitch (a test pins that they agree; importing it would make a cycle). */
export const pitchFor = (n) => (n > 7 ? 12 : n > 6 ? 14 : 16);
const cycle = (list, cur, dir) => list[(list.indexOf(cur) + dir + list.length) % list.length];
const inR = (r, x, y) => x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;
const FORMATS = ['3v3', '6v6'];

/** The centres of n balls in a row (shared with the renderer and the hit test). */
export function ballCentres(n) {
  const sp = n <= 3 ? 64 : n === 4 ? 52 : n === 5 ? 44 : n === 6 ? 38 : 33, x0 = 120 - (sp * (n - 1)) / 2;
  return Array.from({ length: n }, (_, i) => ({ x: Math.round(x0 + i * sp), y: TGEOM.balls.cy }));
}

/**
 * env: { profiles(): [{ id, name, readOnly, teams: [{ id, name, size, legal, ruleset }], tower: summary | null }], activeId(): string | null, dataState(): 'loading' | 'ready' | 'unavailable',
 *        go(path): effects, back(): effects, towerReady(): bool }
 */
export function createTowerHub(env) {
  const S = {
    profileId: null,
    cursor: { tower: 0, 'tower-new': 0 },
    nw: { team: 'random', format: '3v3', formatTouched: false },
    offer: { cursor: 0, confirm: null },
    buffs: { tab: 0, cursor: 0, offset: 0, detail: false },
    ach: { cursor: 0, offset: 0 },
    confirm: null,                      // { kind: 'giveup', cursor } on the home screen
    hover: null, autoDone: false, flash: null,
  };

  /* ------------------------------------------------------------------------------------------ data */
  const profiles = () => env.profiles();
  const prof = () => { const ps = profiles(); return ps.find((p) => p.id === S.profileId) || ps.find((p) => p.id === env.activeId()) || ps[0] || null; };
  const tw = () => { const p = prof(); return p ? p.tower : null; };
  const run = () => { const t = tw(); return t && t.run ? t.run : null; };
  const liveRun = () => { const r = run(); return r && !r.broken ? r : null; };
  const offerBalls = () => { const r = liveRun(); return r && r.phase === 'offer' && r.offer ? r.offer.balls : []; };
  const writable = () => { const p = prof(); return !!p && !p.readOnly; };
  const teamsOf = (p) => (p ? p.teams.filter((t) => t.legal && t.ruleset === TOWER_RULESET && t.size >= 1) : []);

  function teamChoices() {
    const p = prof();
    return [{ id: 'random', name: 'RANDOM TEAM', size: 6 }].concat(teamsOf(p).map((t) => ({ id: t.id, name: t.name, size: t.size })));
  }
  function allowedFormats() { const c = teamChoices().find((t) => t.id === S.nw.team); return c && c.size < 3 ? ['6v6'] : FORMATS; }
  function normaliseNew() {
    if (!teamChoices().some((t) => t.id === S.nw.team)) S.nw.team = 'random';
    const ok = allowedFormats();
    if (!ok.includes(S.nw.format)) S.nw.format = ok[0];
  }

  /* ------------------------------------------------------------------------------------------ rows of the menu screens */
  function homeRows() {
    const p = prof(), t = tw(), r = run(), rows = [];
    if (!p) { rows.push({ id: 'new', kind: 'item', label: 'NEW RUN', disabled: env.dataState() !== 'ready' }, { id: 'back', kind: 'button', label: 'BACK' }); return rows; }
    if (r && r.broken) rows.push({ id: 'drop', kind: 'item', label: 'DROP THIS RUN' });
    else if (r && r.phase === 'offer') rows.push({ id: 'offer', kind: 'item', label: 'CHOOSE A BUFF' });
    else if (r) rows.push({ id: 'fight', kind: 'item', label: 'FIGHT: FLOOR ' + r.floor });
    if (r && !r.broken) rows.push({ id: 'buffs', kind: 'item', label: 'MY BUFFS' });
    rows.push({ id: 'new', kind: 'item', label: 'NEW RUN', disabled: !writable() || !t });
    if (t && t.last) rows.push({ id: 'last', kind: 'item', label: 'LAST RUN' });
    rows.push({ id: 'ach', kind: 'item', label: 'ACHIEVEMENTS', disabled: !t });
    if (profiles().length > 1) rows.push({ id: 'trainer', kind: 'choice', label: 'TRAINER', value: p.name });
    rows.push({ id: 'back', kind: 'button', label: 'BACK' });
    return rows;
  }
  function newRows() {
    normaliseNew();
    const c = teamChoices().find((x) => x.id === S.nw.team);
    return [
      { id: 'team', kind: 'choice', label: 'TEAM', value: c ? c.name : 'RANDOM TEAM', count: teamChoices().length },
      { id: 'format', kind: 'choice', label: 'FORMAT', value: S.nw.format },
      { id: 'start', kind: 'button', label: 'START' },
      { id: 'back', kind: 'button', label: 'BACK' },
    ];
  }
  const menuRows = (path) => (path === 'tower' ? homeRows() : path === 'tower-new' ? newRows() : []);
  function clampCursor(path) { const n = menuRows(path).length; if (n && path in S.cursor) S.cursor[path] = clamp(S.cursor[path], 0, n - 1); }

  /* ------------------------------------------------------------------------------------------ the words */
  function helpHome(row) {
    if (S.flash) return S.flash;
    const t = tw(), r = run(), p = prof();
    if (env.dataState() === 'loading' || (p && !t)) return ['Looking for your climb...', ''];
    if (env.dataState() === 'unavailable') return ['Your profile could not be read here.', 'Storage may be blocked.'];
    if (!p) return ['The Tower keeps your climb in a', 'trainer profile. A run makes one.'];
    switch (row && row.id) {
      case 'fight': if (r.fighting) return ['You left a fight unfinished.', 'Fighting again counts it as a loss.']; return r.trainer ? ['Next: ' + r.trainer.name + (r.trainer.boss ? ' (BOSS)' : ''), r.trainer.size + ' Pokemon, CPU ' + r.trainer.cpu.toUpperCase() + '. A to fight.'] : ['Floor ' + r.floor + ' is waiting.', 'A to fight.'];
      case 'offer': return ['Floor ' + (r.floor - 1) + ' is cleared!', 'Choose one buff to take along.'];
      case 'drop': return ['This run cannot be read.', 'A gives it up so you can start again.'];
      case 'buffs': return ['What you hold, and how the', 'buffs combine with each other.'];
      case 'new': return !writable() ? ['This profile is from a newer', 'version, so the Tower cannot change it.'] : r ? ['Give up this climb and start', 'another. A asks first.'] : ['Climb ' + (t.run ? t.run.floors : 30) + ' floors of trainers.', 'Take a buff after every floor.'];
      case 'last': return ['How your last climb ended', 'and what it earned.'];
      case 'ach': return [t.earned + ' of ' + t.total + ' earned.', 'Only the Tower earns them.'];
      case 'trainer': return ['Whose climb to show.', 'A or the arrows change it.'];
      default: return ['Back to the main menu.', ''];
    }
  }
  function helpNew(row) {
    if (S.flash) return S.flash;
    const c = teamChoices().find((x) => x.id === S.nw.team);
    switch (row && row.id) {
      case 'team': return S.nw.team === 'random' ? ['A random legal team of six.', 'Or pick one of your saved teams.'] : [(c ? c.name : '') + ' (' + (c ? c.size : 0) + ' Pokemon).', 'Standard rules only.'];
      case 'format': return S.nw.format === '3v3' ? ['3v3: you pick 3 of your team', 'at each floor.'] : ['6v6: your whole team fights.', 'Smaller teams play this one.'];
      case 'start': return ['A starts the climb.', 'Floor 1 is next.'];
      default: return ['Back to the Tower.', ''];
    }
  }

  /* ------------------------------------------------------------------------------------------ view */
  function panelLines() {
    const t = tw(), r = liveRun();
    if (!prof() && env.dataState() === 'ready') return ['THE TOWER', '30 FLOORS', 'A BUFF AFTER', 'EVERY ONE', 'BOSSES 10 20 30'];
    if (!t) return ['THE TOWER', '', 'loading...'];
    if (r) return ['THE TOWER', 'FLOOR ' + r.floor + '/' + r.floors, r.format + ' ' + (r.lives > 0 || r.livesUsed > 0 ? 'LIVES ' + r.lives : 'NO LIVES'), 'BUFFS ' + r.held.length, 'BEST ' + Math.max(t.record.best['3v3'], t.record.best['6v6'])];
    return ['THE TOWER', t.run && t.run.broken ? 'BROKEN RUN' : 'NO RUN YET', 'BEST 3v3 ' + t.record.best['3v3'], 'BEST 6v6 ' + t.record.best['6v6'], 'WON ' + t.record.wins + ' OF ' + t.record.runs];
  }
  const listLen = () => (S.buffs.tab === 0 ? (liveRun() ? liveRun().held.length : 0) : (liveRun() ? liveRun().synergies.length : 0));
  function windowOf(n, cursor, offset, size) {
    let off = clamp(offset, 0, Math.max(0, n - size));
    if (cursor < off) off = cursor; else if (cursor >= off + size) off = cursor - size + 1;
    return clamp(off, 0, Math.max(0, n - size));
  }

  function view(path, base) {
    clampCursor(path);
    const out = { ...base, screen: path, title: false, about: null, record: undefined, msg: null, menu: null, mascot: null, tower: null };
    delete out.record;
    const loading = env.dataState() === 'loading', ready = env.dataState() === 'ready';
    if (path === 'tower' || path === 'tower-new') {
      const rs = menuRows(path), cur = S.cursor[path], row = rs[cur];
      out.menu = { rows: rs.map(({ values, ...r }) => r), cursor: cur };
      out.msg = S.confirm && path === 'tower' ? [S.confirm.kind === 'giveup' ? 'Give up this climb?' : '', S.confirm.kind === 'giveup' ? 'The run counts as over.' : ''] : (path === 'tower' ? helpHome(row) : helpNew(row));
      out.tower = { kind: path, panel: { lines: path === 'tower' ? panelLines() : panelLines() }, confirm: S.confirm && path === 'tower' ? { cursor: S.confirm.cursor } : null, state: loading ? 'loading' : ready ? 'ready' : 'unavailable' };
      return out;
    }
    const r = liveRun();
    if (path === 'tower-offer') {
      const balls = offerBalls(), c = S.offer.cursor;
      const ball = c < balls.length ? balls[c] : null, d = S.offer.confirm;
      out.tower = {
        kind: path, state: !tw() ? 'loading' : balls.length ? 'ready' : 'empty', floor: r ? r.floor - 1 : 0, floors: r ? r.floors : 30, balls: balls.map((b) => ({ ...b })), cursor: c, canSkip: true, hover: S.hover,
        confirm: d ? { kind: d.kind, cursor: d.cursor } : null,
      };
      out.msg = d ? (d.kind === 'take' ? ['Take this buff?', ball ? ball.name : ''] : ['Take nothing this time?', 'The offer is gone for good.']) : balls.length ? ['Floor ' + (r.floor - 1) + ' cleared. Choose one.', 'A takes it. B or SKIP passes.'] : ['No buff is waiting.', 'B goes back.'];
      if (S.flash) out.msg = S.flash;
      return out;
    }
    if (path === 'tower-buffs') {
      const n = listLen(), c = clamp(S.buffs.cursor, 0, Math.max(0, n - 1)), off = windowOf(n, c, S.buffs.offset, TGEOM.list.rows);
      const items = !r ? [] : S.buffs.tab === 0 ? r.held : r.synergies;
      out.tower = { kind: path, state: r ? 'ready' : 'empty', tab: S.buffs.tab, cursor: c - off, abs: c, offset: off, total: n, rows: items.slice(off, off + TGEOM.list.rows).map((x) => ({ ...x })), detail: S.buffs.detail && items[c] ? { ...items[c] } : null, counts: r ? [r.held.length, r.synergies.length] : [0, 0] };
      const it = items[c];
      out.msg = S.buffs.detail ? ['A or B closes this.', ''] : it ? [it.text ? it.text.slice(0, 29) : '', it.text && it.text.length > 29 ? it.text.slice(29, 58) : ''] : [S.buffs.tab === 0 ? 'You hold no buffs yet.' : 'No synergy is active yet.', 'L and R switch BUFFS / SYNERGIES.'];
      return out;
    }
    if (path === 'tower-ach') {
      const t = tw(), list = t ? t.achievements : [], n = list.length, c = clamp(S.ach.cursor, 0, Math.max(0, n - 1)), off = windowOf(n, c, S.ach.offset, TGEOM.list.rows);
      out.tower = { kind: path, state: t ? 'ready' : 'loading', cursor: c - off, abs: c, offset: off, total: n, earned: t ? t.earned : 0, rows: list.slice(off, off + TGEOM.list.rows).map((x) => ({ ...x })) };
      const a = list[c];
      out.msg = a ? [a.desc.slice(0, 30), a.desc.length > 30 ? a.desc.slice(30, 60) : ''] : ['', ''];
      if (a && a.at === null) out.msg = [a.desc.slice(0, 30), a.desc.length > 30 ? a.desc.slice(30, 60) : '(not earned yet)'];
      return out;
    }
    if (path === 'tower-last') {
      const t = tw();
      out.tower = { kind: path, state: t && t.last ? 'ready' : 'empty', last: t && t.last ? JSON.parse(JSON.stringify(t.last)) : null };
      out.msg = ['A or B goes back.', ''];
      return out;
    }
    return out;
  }

  /* ------------------------------------------------------------------------------------------ transitions */
  function enter(path) {
    S.flash = null; S.confirm = null; S.hover = null;
    if (path === 'tower') { const p = prof(); S.profileId = p ? p.id : S.profileId; }
    if (path === 'tower-new') { S.nw = { team: 'random', format: '3v3', formatTouched: false }; S.cursor['tower-new'] = 0; normaliseNew(); }
    if (path === 'tower-offer') S.offer = { cursor: 0, confirm: null };
    if (path === 'tower-buffs') S.buffs = { tab: 0, cursor: 0, offset: 0, detail: false };
    if (path === 'tower-ach') S.ach = { cursor: 0, offset: 0 };
  }

  /** The data changed (the store answered, or a step was applied): keep the screen consistent with it. -> effects (a screen change, or none) */
  function onData() {
    const path = env.path();
    if (!isTowerPath(path)) return [];
    const r = liveRun(), t = tw();
    for (const p of Object.keys(S.cursor)) clampCursor(p);
    if (path === 'tower' && !S.autoDone && t && r && r.phase === 'offer' && env.arrivedByLink()) { S.autoDone = true; return env.go('tower-offer'); }
    if (path === 'tower-offer' && t && !(r && r.phase === 'offer')) { S.offer.confirm = null; return env.back(); }
    if (path === 'tower-offer') S.offer.cursor = clamp(S.offer.cursor, 0, offerBalls().length);
    if (path === 'tower-buffs' && t && !r) return env.back();
    if (path === 'tower-last' && t && !t.last) return env.back();
    if (path === 'tower-new') normaliseNew();
    return [];
  }

  function cycleProfile(dir) {
    const ps = profiles(), p = prof(); if (ps.length < 2) return;
    S.profileId = ps[(ps.findIndex((x) => x.id === p.id) + dir + ps.length) % ps.length].id; S.cursor.tower = 0; S.autoDone = true;
  }

  function activateHome(row) {
    S.flash = null;
    const p = prof(), r = run();
    switch (row.id) {
      case 'fight': return r && !r.broken ? [{ type: 'tower-fight', profileId: p.id, seed: r.seed, floor: r.floor }] : [];
      case 'offer': return env.go('tower-offer');
      case 'buffs': return env.go('tower-buffs');
      case 'drop': S.confirm = { kind: 'giveup', cursor: 1 }; return [];
      case 'new':
        if (!p) return row.disabled ? [] : env.go('tower-new');
        if (row.disabled) { S.flash = writable() ? ['The Tower is still loading.', 'Try again in a moment.'] : ['This profile is from a newer', 'version of the Arena.']; return []; }
        if (r) { S.confirm = { kind: 'giveup', cursor: 1, then: 'new' }; return []; }
        return env.go('tower-new');
      case 'last': return env.go('tower-last');
      case 'ach': if (row.disabled) return []; return env.go('tower-ach');
      case 'trainer': cycleProfile(1); return [];
      default: return env.back();
    }
  }
  function pressHome(a) {
    if (S.confirm) {
      const c = S.confirm;
      if (a === 'left' || a === 'right' || a === 'up' || a === 'down') { c.cursor ^= 1; return []; }
      if (a === 'b') { S.confirm = null; return []; }
      if (a === 'a') {
        S.confirm = null;
        if (c.cursor !== 0) return [];
        const p = prof(), r = run();
        if (c.then === 'new') return [{ type: 'tower-giveup', profileId: p.id, seed: r ? r.seed : null }].concat(env.go('tower-new'));
        return [{ type: 'tower-giveup', profileId: p.id, seed: r ? r.seed : null }];
      }
      return [];
    }
    const rs = homeRows(), cur = S.cursor.tower, row = rs[cur];
    switch (a) {
      case 'up': S.flash = null; S.cursor.tower = (cur + rs.length - 1) % rs.length; return [];
      case 'down': S.flash = null; S.cursor.tower = (cur + 1) % rs.length; return [];
      case 'left': if (row && row.id === 'trainer') cycleProfile(-1); return [];
      case 'right': if (row && row.id === 'trainer') cycleProfile(1); return [];
      case 'a': return row ? activateHome(row) : [];
      case 'b': return env.back();
      default: return [];
    }
  }
  function pressNew(a) {
    const rs = newRows(), cur = S.cursor['tower-new'], row = rs[cur];
    const change = (dir) => {
      if (!row) return [];
      if (row.id === 'team') { const ids = teamChoices().map((t) => t.id); S.nw.team = cycle(ids, S.nw.team, dir); normaliseNew(); }
      else if (row.id === 'format') { S.nw.format = cycle(allowedFormats(), S.nw.format, dir); S.nw.formatTouched = true; }
      return [];
    };
    switch (a) {
      case 'up': S.flash = null; S.cursor['tower-new'] = (cur + rs.length - 1) % rs.length; return [];
      case 'down': S.flash = null; S.cursor['tower-new'] = (cur + 1) % rs.length; return [];
      case 'left': return change(-1);
      case 'right': return change(1);
      case 'a':
        if (!row) return [];
        if (row.kind === 'choice') return change(1);
        if (row.id === 'back') return env.back();
        { const p = prof(); if (env.dataState() !== 'ready') return []; return [{ type: 'tower-new', profileId: p ? p.id : null, teamId: S.nw.team === 'random' ? null : S.nw.team, format: S.nw.format }]; }
      case 'b': return env.back();
      default: return [];
    }
  }

  function pressOffer(a) {
    const balls = offerBalls(), n = balls.length, o = S.offer;
    if (!n) return a === 'b' || a === 'a' ? env.back() : [];
    if (o.confirm) {
      if (a === 'left' || a === 'right' || a === 'up' || a === 'down') { o.confirm.cursor ^= 1; return []; }
      if (a === 'b') { o.confirm = null; return []; }
      if (a === 'a') {
        const c = o.confirm; o.confirm = null;
        if (c.cursor !== 0) return [];
        const p = prof(), r = liveRun();
        return [{ type: 'tower-pick', profileId: p.id, seed: r.seed, id: c.kind === 'take' ? balls[o.cursor].id : null }];
      }
      return [];
    }
    switch (a) {
      case 'left': case 'l': o.cursor = (o.cursor + n) % (n + 1); return [];
      case 'right': case 'r': o.cursor = (o.cursor + 1) % (n + 1); return [];
      case 'up': o.cursor = o.cursor === n ? n - 1 : o.cursor; return [];
      case 'down': o.cursor = n; return [];
      case 'a': o.confirm = { kind: o.cursor === n ? 'skip' : 'take', cursor: 1 }; return [];
      case 'b': case 'start': if (o.cursor !== n) { o.cursor = n; return []; } o.confirm = { kind: 'skip', cursor: 1 }; return [];
      default: return [];
    }
  }
  function pressBuffs(a) {
    const b = S.buffs, n = listLen();
    if (b.detail) { if (a === 'a' || a === 'b' || a === 'start') b.detail = false; return []; }
    switch (a) {
      case 'up': if (n) b.cursor = (b.cursor + n - 1) % n; return [];
      case 'down': if (n) b.cursor = (b.cursor + 1) % n; return [];
      case 'left': case 'l': case 'right': case 'r': b.tab ^= 1; b.cursor = 0; b.offset = 0; return [];
      case 'a': if (n && b.tab === 0) b.detail = true; return [];
      case 'b': return env.back();
      default: return [];
    }
  }
  function pressAch(a) {
    const n = (tw() ? tw().achievements.length : 0), s = S.ach, size = TGEOM.list.rows;
    switch (a) {
      case 'up': if (n) s.cursor = (s.cursor + n - 1) % n; return [];
      case 'down': if (n) s.cursor = (s.cursor + 1) % n; return [];
      case 'left': case 'l': s.cursor = clamp(s.cursor - size, 0, Math.max(0, n - 1)); return [];
      case 'right': case 'r': s.cursor = clamp(s.cursor + size, 0, Math.max(0, n - 1)); return [];
      case 'b': case 'a': return env.back();
      default: return [];
    }
  }

  /* ------------------------------------------------------------------------------------------ pointer */
  function hit(path, x, y) {
    if (path === 'tower' || path === 'tower-new') {
      if (path === 'tower' && S.confirm) return inR(TGEOM.yes, x, y) ? { kind: 'yes' } : inR(TGEOM.no, x, y) ? { kind: 'no' } : null;
      const rs = menuRows(path), m = TGEOM.menu, pitch = pitchFor(rs.length);
      if (x < m.x - 6 || x >= m.x + m.w + 6 || y < m.y || y >= m.y + rs.length * pitch) return null;
      const index = Math.floor((y - m.y) / pitch), row = rs[index];
      return { kind: 'row', index, zone: row && row.kind === 'choice' && x < m.x + m.w * 0.45 + 6 && x > m.x + 38 ? 'prev' : 'main' };
    }
    if (path === 'tower-offer') {
      const balls = offerBalls(), n = balls.length, o = S.offer;
      if (o.confirm) return inR(TGEOM.yes, x, y) ? { kind: 'yes' } : inR(TGEOM.no, x, y) ? { kind: 'no' } : null;
      if (!n) return null;
      if (inR(TGEOM.skip, x, y)) return { kind: 'ball', index: n };
      const cs = ballCentres(n), h = TGEOM.balls.sheet / 2 + 5;
      for (let i = 0; i < n; i++) if (Math.abs(x - cs[i].x) <= h && Math.abs(y - cs[i].y) <= h + 4) return { kind: 'ball', index: i };
      if (inR(TGEOM.info, x, y)) return { kind: 'info' };
      return null;
    }
    if (path === 'tower-buffs' || path === 'tower-ach') {
      const g = TGEOM.list, n = path === 'tower-buffs' ? listLen() : (tw() ? tw().achievements.length : 0), off = path === 'tower-buffs' ? windowOf(n, S.buffs.cursor, S.buffs.offset, g.rows) : windowOf(n, S.ach.cursor, S.ach.offset, g.rows);
      if (path === 'tower-buffs' && S.buffs.detail) return { kind: 'detail' };
      const y0 = g.y + g.top;
      if (x < g.x - 6 || x >= g.x + g.w + 6 || y < y0 - 2 || y >= y0 + Math.min(n, g.rows) * g.pitch + 2) return null;
      const index = off + clamp(Math.floor((y - y0) / g.pitch), 0, Math.min(n, g.rows) - 1);
      return n ? { kind: 'item', index } : null;
    }
    if (path === 'tower-last') return { kind: 'page' };
    return null;
  }
  function pointer(path, ev) {
    if (!ev) return [];
    if (ev.kind === 'wheel') { const n = Math.abs(ev.steps || 0); const act = (ev.steps || 0) > 0 ? 'down' : 'up'; let out = []; for (let i = 0; i < n; i++) out = out.concat(press(path, path === 'tower-offer' ? (act === 'down' ? 'right' : 'left') : act)); return out; }
    const h = ev.x === undefined || ev.x === null ? null : hit(path, ev.x, ev.y);
    if (!h) { if (ev.kind === 'move') S.hover = null; return []; }
    const moving = ev.kind === 'move' || ev.kind === 'down';
    if (path === 'tower' || path === 'tower-new') {
      if (h.kind === 'yes' || h.kind === 'no') { if (moving) { if (S.confirm) S.confirm.cursor = h.kind === 'yes' ? 0 : 1; return []; } if (S.confirm) S.confirm.cursor = h.kind === 'yes' ? 0 : 1; return press(path, 'a'); }
      if (moving) { if (S.cursor[path] !== h.index) S.flash = null; S.cursor[path] = h.index; return []; }
      if (ev.kind !== 'click') return [];
      if (S.cursor[path] !== h.index) S.flash = null;
      S.cursor[path] = h.index;
      const row = menuRows(path)[h.index];
      if (row && row.kind === 'choice' && h.zone === 'prev') return press(path, 'left');
      return press(path, 'a');
    }
    if (path === 'tower-offer') {
      const o = S.offer;
      if (h.kind === 'yes' || h.kind === 'no') { if (o.confirm) o.confirm.cursor = h.kind === 'yes' ? 0 : 1; return moving ? [] : press(path, 'a'); }
      if (h.kind === 'ball') {
        if (moving) { S.hover = h.index; if (!o.confirm) o.cursor = h.index; return []; }
        if (ev.kind === 'click' && !o.confirm) { o.cursor = h.index; return press(path, 'a'); }
        return [];
      }
      return [];
    }
    if (path === 'tower-buffs' || path === 'tower-ach') {
      if (h.kind === 'detail') return ev.kind === 'click' ? press(path, 'a') : [];
      if (h.kind === 'item') {
        if (path === 'tower-buffs') S.buffs.cursor = h.index; else S.ach.cursor = h.index;
        if (ev.kind === 'click') return press(path, path === 'tower-buffs' ? 'a' : 'none');
      }
      return [];
    }
    if (path === 'tower-last') return ev.kind === 'click' ? env.back() : [];
    return [];
  }

  function press(path, a) {
    if (path === 'tower') return pressHome(a);
    if (path === 'tower-new') return pressNew(a);
    if (path === 'tower-offer') return pressOffer(a);
    if (path === 'tower-buffs') return pressBuffs(a);
    if (path === 'tower-ach') return pressAch(a);
    if (path === 'tower-last') return a === 'a' || a === 'b' ? env.back() : [];
    return [];
  }

  function rects(path) {
    if (path === 'tower' || path === 'tower-new') { const m = TGEOM.menu, rs = menuRows(path), pitch = pitchFor(rs.length); return rs.map((_, i) => ({ x: m.x - 4, y: m.y + i * pitch, w: m.w + 8, h: pitch })); }
    if (path === 'tower-offer') { const cs = ballCentres(offerBalls().length), h = TGEOM.balls.sheet; return cs.map((c) => ({ x: c.x - h / 2, y: c.y - h / 2, w: h, h })).concat([{ ...TGEOM.skip }]); }
    return [];
  }

  return {
    paths: TOWER_PATHS, enter, onData, view, press, pointer, hit, rects, menuRows,
    state: () => JSON.parse(JSON.stringify({ profileId: prof() ? prof().id : null, cursor: S.cursor, nw: S.nw, offer: S.offer, buffs: S.buffs, ach: S.ach, confirm: S.confirm, autoDone: S.autoDone })),
    notify(lines) { S.flash = Array.isArray(lines) ? lines.slice(0, 2).map(String) : [String(lines), '']; },
    selectedProfileId: () => (prof() ? prof().id : null),
    setProfile(id) { S.profileId = id; },
    resetAuto() { S.autoDone = false; },
  };
}

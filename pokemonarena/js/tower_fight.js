// pokemonarena/js/tower_fight.js -- the battle side of a Tower floor, as a controller that owns no page: it takes a persistence place, the floor, and navigation CALLBACKS, and gives back the battle to build and
// what to do at each step (what the result buttons say, what happens when a button is chosen, what to write on the status line, what the recap's RECORD page says). battle_boot.js (battle.html?tower=1) is a thin
// wrapper over this; the hub, when it hosts the fight in its own page, calls the same thing with callbacks that mount and unmount instead of navigating.
//
//   const f = await createTowerFight({ pack, persist, floor, runId, navType, nav: { toTower(), toHub(), retry(run) }, now });
//   if (!f.ok) { /* f.status 'stale' | 'abandoned' | 'error', f.message: show it, offer f.nav.toTower */ }
//   f.spec                 -> the battle to build (tower_session.js towerFloorSpec); f.tag -> what a saved battle must agree with (battle_resume.js)
//   f.bar()                -> the status line text ("TOWER  FLOOR 7/30  Hiker Marco ...")
//   f.resultOptions(winner)-> the result buttons for a battle that ended with that winner (0 = you)
//   f.committed()          -> the player made the first choice of the fight (ctl.onLocalChoice): marks it, so leaving it from now on counts as a loss (idempotent)
//   f.onMatchEnd(info)     -> the finished battle (scene hooks.onMatchEnd): applied to the run ONCE; returns a promise
//   f.recap()              -> what the recap's RECORD page shows once the result is written ({ state: 'tower', ... })
//   f.onResult(choice)     -> a result button was chosen: waits for the write (at most 1.5 s), then navigates
//   f.onQuit()             -> the player leaves in the middle of the fight: it counts as a loss (an Extra Life is spent if held), then navigates
// NOTHING here writes the regular career, and nothing here reads an address.

import { startTowerFloor } from './tower_session.js';
import { CONFIG } from './tower_config.js';

const WAIT_MS = 1500;

/** The words for a floor that cannot be fought, in the player's language. */
function refusal(f) {
  if (f.status === 'abandoned') {
    const n = f.next && f.next.step;
    return n === 'over' ? 'You left the last fight of this floor, so it counted as a loss and the run is over.' : n === 'won' ? 'That run is already won.' : 'You left the last fight of this floor, so it counted as a loss.' + (n === 'retry' ? ' An Extra Life was spent: the floor is yours to try again.' : '');
  }
  if (f.status === 'stale') return 'The run is not waiting for this fight (it moved on, ended, or is another run). Go back to the Tower to see where it stands.';
  return 'This Tower fight could not start: ' + String(f.why || 'unknown problem') + '.';
}

export async function createTowerFight({ pack, persist, floor, runId, navType = 'navigate', nav, now = () => Date.now(), cfg = CONFIG }) {
  const f = await startTowerFloor({ pack, persist, floor, runId, navType, now, cfg });
  if (!f.ok) return { ok: false, status: f.status, why: f.why, next: f.next || null, message: refusal(f), nav };
  const spec = f.spec, lives0 = spec.tower.lives;
  const st = { ended: false, result: null, applied: null, promise: null, choice: null, marked: false };

  const fight = {
    ok: true, status: f.status, run: f.run, spec, tag: f.tag, nav, state: st,
    bar() {
      const t = spec.tower;
      return 'TOWER  FLOOR ' + t.floor + '/' + cfg.floors + (t.boss ? '  BOSS' : '') + '  ' + spec.trainer + '  BUFFS ' + t.buffs + (lives0 > 0 || t.livesUsed > 0 ? '  LIVES ' + lives0 : '');
    },
    /** The buttons of the result screen. Chosen with the winner in hand, before the write has finished, so they say what is KNOWN: a win goes on to the offer, a loss with an Extra Life retries. */
    resultOptions(winner) {
      if (winner === 0) return [spec.tower.floor >= cfg.floors ? 'TO THE TOWER' : 'PICK A BUFF', 'BACK TO HUB'];
      return [lives0 > 0 ? 'RETRY FLOOR' : 'TO THE TOWER', 'BACK TO HUB'];
    },
    /** The first choice of the fight was made: from now on leaving it is a loss. Once only. */
    committed() { if (!st.marked && f.status !== 'resume') { st.marked = true; f.markFight().catch(() => { st.marked = false; }); } },
    /** The finished match (scene hooks.onMatchEnd). Applied to the run once, however many times it is announced. */
    onMatchEnd(info) {
      if (st.promise) return st.promise;
      st.ended = true;
      const summary = info && info.summary;
      const result = summary ? { ...summary, floor: spec.tower.floor } : { floor: spec.tower.floor, result: info && info.winner === 0 ? 'w' : 'l', turns: 0, faints: 0 };
      st.promise = f.finish(result).then((r) => { st.applied = r; return r; }, (e) => { st.applied = { applied: false, why: String(e && e.message ? e.message : e).slice(0, 120), error: true }; return st.applied; });
      return st.promise;
    },
    /** What the recap's RECORD page says. Before the write: pending. */
    recap() {
      const a = st.applied;
      if (!a) return { state: 'tower', head: 'SAVING THE CLIMB...', notes: ['This battle is part of the Tower.', 'It is not in your battle record.'] };
      if (!a.applied) return { state: 'tower', head: a.error ? 'COULD NOT SAVE THE CLIMB' : 'ALREADY IN THE TOWER', notes: a.error ? ['The Tower was not changed.', 'Storage may be blocked or full.'] : ['This floor was already counted.', 'It is not in your battle record.'] };
      const lines = [];
      if (a.next.step === 'offer') lines.push('FLOOR ' + spec.tower.floor + ' CLEARED. PICK A BUFF.');
      else if (a.next.step === 'retry') lines.push('EXTRA LIFE USED. TRY THE FLOOR AGAIN.');
      else if (a.next.step === 'won') lines.push('THE TOWER IS CLEARED!');
      else lines.push('THE CLIMB ENDS ON FLOOR ' + spec.tower.floor + '.');
      if (a.newIds && a.newIds.length) lines.push(a.newIds.length + (a.newIds.length === 1 ? ' ACHIEVEMENT' : ' ACHIEVEMENTS') + ' EARNED.');
      lines.push('Not in your battle record.');
      return { state: 'tower', head: 'TOWER FLOOR ' + spec.tower.floor, notes: lines.slice(0, 3), next: a.next };
    },
    /** Wait (at most WAIT_MS) for the write, then run `go`. */
    whenSettled(go) {
      if (!st.promise || st.applied) { go(); return; }
      let done = false; const once = () => { if (!done) { done = true; go(); } };
      st.promise.then(once, once); setTimeout(once, WAIT_MS);
    },
    /** A result button was chosen. */
    onResult(choice) {
      st.choice = choice;
      fight.whenSettled(() => {
        if (choice === 'BACK TO HUB') { nav.toHub(); return; }
        const a = st.applied;
        if (choice === 'RETRY FLOOR' && a && a.applied && a.next.step === 'retry') { nav.retry(a.run); return; }
        nav.toTower(a && a.applied ? a.next.step : null);
      });
    },
    /** The player leaves in the middle of the fight (pause menu: BACK TO HUB, or the page is being left on purpose). It is a loss. */
    onQuit() {
      if (st.ended) { fight.whenSettled(() => nav.toTower(st.applied && st.applied.applied ? st.applied.next.step : null)); return; }
      st.ended = true;
      st.promise = f.finish({ floor: spec.tower.floor, result: 'f', turns: 0, faints: 0 }).then((r) => { st.applied = r; return r; }, (e) => { st.applied = { applied: false, error: true }; return st.applied; });
      fight.whenSettled(() => nav.toTower(st.applied && st.applied.applied ? st.applied.next.step : null));
    },
  };
  return fight;
}

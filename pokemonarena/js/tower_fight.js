// pokemonarena/js/tower_fight.js -- the battle side of a Tower floor, as a controller that owns no page: it takes a persistence place, the floor, and navigation CALLBACKS, and gives back the battle to build and
// what to do at each step (what the result buttons say, what happens when a button is chosen, what to write on the status line, what the recap's RECORD page says). battle_boot.js (battle.html?tower=1) is a thin
// wrapper over this; the hub, when it hosts the fight in its own page, calls the same thing with callbacks that mount and unmount instead of navigating.
//
//   const f = await createTowerFight({ pack, persist, floor, runId, navType, openedTry, nav: { toTower(), toHub(), retry(run) }, now, nonce, onDuplicate });
//   if (!f.ok) { /* f.status 'stale' | 'abandoned' | 'elsewhere' | 'error', f.message: show it, offer f.nav.toTower */ }
//                          (`openedTry`: the try of the floor the page was opened as, for a host whose pages have addresses: a history step onto the page of an EARLIER try than the one being fought is
//                          'elsewhere', and writes nothing: tower_session.js reduceBeginFloor. `f.tries` is the try this page hosts.)
//   f.spec                 -> the battle to build (tower_session.js towerFloorSpec); f.tag -> what a saved battle must agree with (battle_resume.js); f.attempt -> this page's identity for the fight (a saved battle must carry it too:
//                          a tab that is not the one that marked the fight cannot resume it)
//   f.bar()                -> the status line text ("TOWER  FLOOR 7/30  Hiker Marco  BUFFS 4  RETRIES 2/3": the retries left of the cap, on this floor or on the climb)
//   f.resultOptions(winner)-> the result buttons for a battle that ended with that winner (0 = you): after a loss with a retry (or an Extra Life) in hand, RETRY FLOOR first, then BACK TO TOWER
//   f.leaveCost(kind)      -> what leaving the fight NOW would cost ('quit' = LEAVE TOWER, 'forfeit' = FORFEIT): { cost: 'nothing' | 'life' | 'retry' | 'end', left, cap, scope }
//   f.leaveAsk(kind, where)-> the question LEAVE TOWER / FORFEIT asks, saying that cost in words ('box': the two-line message box; 'title': the short title row of the team preview)
//   f.committed()          -> the player made the first choice of the fight (ctl.onLocalChoice): marks it, so leaving it from now on counts as a loss (idempotent)
//   f.watchEngine(ctl, summarize) -> the Tower hears the match THE MOMENT THE ENGINE ENDS IT (ctl.onEnd), not when the result screen comes up: a page closed or reloaded during the end-of-battle text can no longer
//                          dodge a loss, or turn a win into one. Returns an unsubscribe function.
//   f.onMatchEnd(info)     -> the finished battle (scene hooks.onMatchEnd / watchEngine): applied to the run ONCE; returns a promise
//   f.leaveUnrestorable()  -> a reload found this floor's fight marked but nothing to resume it from: it counts as LEFT (a loss), never a free restart. -> Promise<{ message }>
//   f.recap()              -> what the recap's RECORD page shows once the result is written ({ state: 'tower', ... })
//   f.onResult(choice)     -> a result button was chosen: waits for the write (at most 1.5 s), then navigates. RETRY FLOOR opens the next try only while the run still waits for it with no fight begun
//                          (a result screen that is still about after another page began that try goes to the Tower instead: it must never leave a fight under way without a word)
//   f.onQuit()             -> the player leaves the fight (LEAVE TOWER). Before the first choice it costs nothing and NOTHING IS WRITTEN: the run waits for the fight as before. After it, it is a lost try: an
//                          Extra Life is spent if held, else a retry is counted, else the run ends. Then it navigates to the Tower.
// A LOSS NO LONGER ENDS THE CLIMB AT ONCE (TOWER.md, the decision of 2026-11-17): the run stays on the floor and the try is counted, exactly once, because every result names the try it is for.
// NOTHING here writes the regular career, and nothing here reads an address.

import { startTowerFloor } from './tower_session.js';
import { CONFIG } from './tower_config.js';

const WAIT_MS = 1500;

/** Does this config hand out retries at all? (With none, the words are the ones of the rule before retries.) */
const hasRetries = (rt) => !!rt && (rt.scope === 'none' || rt.cap > 0);
/** "2 of 3 retries are left on this floor." (or: on this climb; or nothing where there is no cap to count against). */
function leftWords(rt) {
  if (!rt || rt.scope === 'none') return '';
  return (rt.left === 0 ? 'No retry is' : rt.left + ' of ' + rt.cap + (rt.left === 1 ? ' retries is' : ' retries are')) + ' left on this ' + (rt.scope === 'run' ? 'climb' : 'floor') + '.';
}

/** The words for a floor that cannot be fought, in the player's language. */
function refusal(f) {
  if (f.status === 'abandoned') {
    const n = f.next && f.next.step, rt = f.retries || null;
    if (n === 'over') return hasRetries(rt) ? 'You left the last fight of this floor, so it counted as a loss. No retry was left, so the run is over.' : 'You left the last fight of this floor, so it counted as a loss and the run is over.';
    if (n === 'won') return 'That run is already won.';
    if (n === 'retry' && f.next.via === 'retry') return ('You left the last fight of this floor, so it counted as a loss and cost one retry. ' + leftWords(rt)).trim() + ' The climb is saved: go back to the Tower to try the floor again.';
    return 'You left the last fight of this floor, so it counted as a loss.' + (n === 'retry' ? ' An Extra Life was spent: the floor is yours to try again.' : '');
  }
  // a history step (the browser's Back, a reload) onto the page of ANOTHER try than the one being fought (the lost try's page, behind a retry): this page is not that fight's, so it neither resumes it nor counts it as left
  if (f.status === 'elsewhere') return 'This page was opened as another try of this floor (an earlier one, if your browser\'s Back brought you here). The fight you are in is open on another page: go forward in your browser, or find its tab, to carry on with it. Nothing was counted. Opening the floor again from the Tower would leave that fight; the Tower says what that costs.';
  if (f.status === 'stale') return 'The run is not waiting for this fight. If you just played it, its result is already counted; it may also have moved on, ended, or be another run. Go back to the Tower to see where it stands.';
  return 'This Tower fight could not start: ' + String(f.why || 'unknown problem') + '.';
}

export async function createTowerFight({ pack, persist, floor, runId, navType = 'navigate', nav, now = () => Date.now(), cfg = CONFIG, nonce = null, onDuplicate = null, openedTry }) {
  const f = await startTowerFloor({ pack, persist, floor, runId, navType, now, cfg, nonce, openedTry });
  if (!f.ok) return { ok: false, status: f.status, why: f.why, next: f.next || null, retries: f.retries || null, message: refusal(f), nav };
  const spec = f.spec, lives0 = spec.tower.lives, rt0 = spec.tower.retries;          // (the lives and the retries as this try began: what a loss of THIS fight will cost)
  const st = { ended: false, result: null, applied: null, promise: null, choice: null, marked: false, duplicate: false };

  const fight = {
    ok: true, status: f.status, run: f.run, spec, tag: f.tag, attempt: f.attempt, tries: f.tries, nav, state: st,          // (`attempt`: this page's identity for the fight; the battle page keeps it in its tab-local resume record, see battle_resume.js. `tries`: the try of the floor this page hosts; the battle page keeps its address on it)
    bar() {
      const t = spec.tower;
      const retries = !hasRetries(rt0) ? '' : rt0.scope === 'none' ? '  RETRIES USED ' + rt0.used : '  RETRIES ' + rt0.left + '/' + rt0.cap;
      return 'TOWER  FLOOR ' + t.floor + '/' + cfg.floors + (t.boss ? '  BOSS' : '') + '  ' + spec.trainer + '  BUFFS ' + t.buffs + retries + (lives0 > 0 || t.livesUsed > 0 ? '  LIVES ' + lives0 : '');
    },
    /** What leaving this fight NOW would cost. LEAVE TOWER ('quit') before the first choice costs nothing; FORFEIT is itself a choice, so it always costs what a lost try costs. */
    leaveCost(kind) {
      const begun = st.marked || f.status === 'resume';
      const cost = kind === 'quit' && !begun ? 'nothing' : lives0 > 0 ? 'life' : rt0.left > 0 ? 'retry' : 'end';
      return { cost, left: rt0.left, cap: rt0.cap, scope: rt0.scope };
    },
    /** The question LEAVE TOWER / FORFEIT asks, with what it costs in it. `where`: 'box' (the message box: two lines) or 'title' (the title row of the team preview: one short line). */
    leaveAsk(kind, where) {
      const c = fight.leaveCost(kind), verb = kind === 'forfeit' ? 'Give up' : 'Leave', place = c.scope === 'run' ? 'climb' : 'floor';
      if (where === 'title') return c.cost === 'nothing' ? verb + '? Costs nothing.' : c.cost === 'life' ? verb + '? Costs a life.' : c.cost === 'retry' ? verb + '? Costs 1 retry.' : verb + '? The climb ends.';
      if (c.cost === 'nothing') return verb + ' the Tower? No choice was made yet, so it costs nothing.';
      if (c.cost === 'life') return verb + '? It counts as a loss and spends your Extra Life.';
      if (c.cost === 'retry') return verb + '? It costs ' + (c.scope === 'none' ? 'a retry.' : '1 of the ' + c.left + (c.left === 1 ? ' retry' : ' retries') + ' left on this ' + place + '.');
      return verb + '? ' + (hasRetries(rt0) ? 'No retry is left on this ' + place + ': ' : 'It counts as a loss: ') + 'the climb ends here.';
    },
    /** The buttons of the result screen. Chosen with the winner in hand, before the write has finished, so they say what is KNOWN: a win goes on to the offer; a loss with a retry (or an Extra Life) in hand
     *  can try the floor again at once (RETRY FLOOR) or later (BACK TO TOWER: the climb is saved); a loss with neither ends the run, and the buttons are the ones a lost run always had. */
    resultOptions(winner) {
      if (winner === 0) return [spec.tower.floor >= cfg.floors ? 'TO THE TOWER' : 'PICK A BUFF', 'BACK TO HUB'];
      if (lives0 > 0 && !hasRetries(rt0)) return ['RETRY FLOOR', 'BACK TO HUB'];
      return lives0 > 0 || rt0.left > 0 ? ['RETRY FLOOR', 'BACK TO TOWER', 'BACK TO HUB'] : ['TO THE TOWER', 'BACK TO HUB'];
    },
    /** The first choice of the fight was made: from now on leaving it is a loss. Once only. */
    committed() {
      if (!st.marked && f.status !== 'resume') {
        st.marked = true;
        // another page already marked a fight on this floor (two tabs): this page is the duplicate. It is told, and must stop playing; the other page's fight is the one that counts.
        f.markFight().then((r) => { if (r && r.applied === false && r.taken) { st.duplicate = true; if (typeof onDuplicate === 'function') { try { onDuplicate(r); } catch (_e) { /* the page's notice must not break the fight */ } } } }, () => { st.marked = false; });
      }
    },
    /** The Tower hears the match the moment the engine ends it. `summarize(events, { viewSide, teams })` is match_stats.summarizeMatch (the page hands it in: this module imports no match code). */
    watchEngine(ctl, summarize) {
      const hear = () => {
        let summary = null;
        try { const teams = [0, 1].map((sd) => ctl.battle.s.sides[sd].team.map((m) => ({ slot: m.slot, sp: m.sp, name: m.name, level: m.level, mhp: m.mhp }))); summary = summarize(ctl.battle.events, { viewSide: 0, teams }); } catch (_e) { summary = null; }
        return fight.onMatchEnd({ summary, ticks: 0, winner: ctl.winner });
      };
      if (ctl.winner !== null && ctl.winner !== undefined) { hear(); return () => {}; }
      return ctl.onEnd(hear);
    },
    /** A reload found the fight marked but nothing to resume it from (the saved choices are gone, or no longer replay): the fight was LEFT. It counts as a lost try (an Extra Life, a retry, or the run), exactly once. -> Promise<{ message }> */
    leaveUnrestorable() {
      if (st.promise) return st.promise.then(() => ({ message: refusal({ status: 'abandoned', next: st.applied && st.applied.applied ? st.applied.next : null, retries: st.applied && st.applied.applied ? st.applied.retries : null }) }));
      st.ended = true;
      st.promise = f.finish({ floor: spec.tower.floor, result: 'f', turns: 0, faints: 0 }).then((r) => { st.applied = r; return r; }, () => { st.applied = { applied: false, error: true }; return st.applied; });
      return st.promise.then((a) => ({ message: a && a.applied ? refusal({ status: 'abandoned', next: a.next, retries: a.retries }) : refusal({ status: 'stale' }) }));
    },
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
      if (!a.applied) return { state: 'tower', head: a.error ? 'COULD NOT SAVE THE CLIMB' : a.taken ? 'ANOTHER TAB HAS THIS FIGHT' : 'ALREADY IN THE TOWER', notes: a.error ? ['The Tower was not changed.', 'Storage may be blocked or full.'] : a.taken ? ['That fight counts in the other tab.', 'This one was not saved.'] : ['This floor was already counted.', 'It is not in your battle record.'] };
      const lines = [], rt = a.retries || null;
      let head = 'TOWER FLOOR ' + spec.tower.floor;
      if (a.next.step === 'offer') lines.push('FLOOR ' + spec.tower.floor + ' CLEARED. PICK A BUFF.');
      else if (a.next.step === 'retry' && a.next.via === 'retry') {          // a retry was counted: the climb goes on from this floor, and the page says how much room is left
        head += ': RETRY COUNTED';
        lines.push('THE CLIMB IS SAVED. TRY THE FLOOR AGAIN.');
        lines.push(!rt || rt.scope === 'none' ? 'RETRIES USED ON THIS CLIMB: ' + (rt ? rt.used : 1) + '.' : (rt.left === 0 ? 'NO RETRY' : rt.left + ' OF ' + rt.cap + (rt.left === 1 ? ' RETRY' : ' RETRIES')) + ' LEFT ' + (rt.scope === 'run' ? 'IN ALL' : 'HERE') + ', ' + rt.used + ' USED.');
      } else if (a.next.step === 'retry') lines.push('EXTRA LIFE USED. TRY THE FLOOR AGAIN.');
      else if (a.next.step === 'won') lines.push('THE TOWER IS CLEARED!');
      else { if (hasRetries(rt)) head += ': NO RETRY LEFT'; lines.push('THE CLIMB ENDS ON FLOOR ' + spec.tower.floor + '.'); }          // (the loss that ends the run: the floor's retries were used up)
      if (a.newIds && a.newIds.length) lines.push(a.newIds.length + (a.newIds.length === 1 ? ' ACHIEVEMENT' : ' ACHIEVEMENTS') + ' EARNED.');
      return { state: 'tower', head, notes: lines.slice(0, 2).concat(['Not in your battle record.']), next: a.next };
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
        if (choice === 'RETRY FLOOR' && a && a.applied && a.next.step === 'retry') {
          // A RESULT SCREEN CAN OUTLIVE ITS MOMENT (it stays in the tab's history, and a browser may bring the page back whole, buttons and all). By then the try this button would open may be under way on
          // another page, or over: opening it afresh would count that fight as LEFT, with no question asked. So the button opens the try only while the run still waits for it, untouched; otherwise it
          // goes to the Tower, which shows where the climb stands (and says what a fight that was left would cost before anything is counted).
          f.stillWaiting(a.run).then((yes) => yes, () => false).then((yes) => { if (yes) nav.retry(a.run); else nav.toTower(null); });
          return;
        }
        nav.toTower(a && a.applied ? a.next.step : null);
      });
    },
    /** The player leaves the fight (pause menu: LEAVE TOWER). Before the first choice nothing was played: NOTHING IS WRITTEN and the run waits for this fight as before. After it, it is a lost try. */
    onQuit() {
      if (st.ended) { fight.whenSettled(() => nav.toTower(st.applied && st.applied.applied ? st.applied.next.step : null)); return; }
      if (!st.marked && f.status !== 'resume') { nav.toTower(null); return; }
      st.ended = true;
      st.promise = f.finish({ floor: spec.tower.floor, result: 'f', turns: 0, faints: 0 }).then((r) => { st.applied = r; return r; }, (e) => { st.applied = { applied: false, error: true }; return st.applied; });
      fight.whenSettled(() => nav.toTower(st.applied && st.applied.applied ? st.applied.next.step : null));
    },
  };
  return fight;
}

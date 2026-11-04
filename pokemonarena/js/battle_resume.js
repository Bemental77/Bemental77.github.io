// pokemonarena/js/battle_resume.js -- W1 fix D11: a battle survives a page reload.
//
// A battle is a deterministic function of its address (teams, seed, format, CPU level) and of the HUMAN side's choices: the engine draws from a seeded generator and the
// CPU answers from another, so nothing else has to be remembered. After every choice the page saves the list of the human's choices and the hash of the state they led to
// (sessionStorage: per tab, gone when the tab closes, never sent anywhere), keyed by the battle's address (which carries the seed). On a RELOAD of that address the page
// builds a fresh controller, replays the saved choices into it, proves the result is the saved state (same hash, same turn), and only then lets the scene play the
// history at speed. Any doubt (a refused choice, a different hash, junk in the store, no storage at all) discards the record and starts the battle from the preview, as
// before. A fresh visit of the same address (typing it, following a link) does NOT resume: only a reload or a back / forward step does.
//
//   const store = createResumeStore({ storage: sessionStorage, key: resumeKey(location.pathname, location.search), seed });
//   const { ctl, info } = store.restore({ ctl: startedCtl, makeCtl, navType: navigationType() });   // info.restored / info.reason
//   store.attach(ctl);        // from now on: every human choice is saved once the engine has settled; the end of the battle clears the record
//   store.clear();            // result chosen, battle left
//
// A saved battle can carry a `tag` (a Tower floor's: the run, the floor, the lives spent and every buff held): a record is only used if its tag is exactly the one the page now computes, so a Tower fight can never
// be resumed as another run's, with other buffs, or as a regular battle - and a regular battle's record (no tag) is never used by a Tower fight.
// It can also carry the `attempt` of the page that fought it (a Tower floor's identity for its fight): a record is only used by a page whose attempt is exactly that one, so a second tab that was told it is a
// duplicate (its choices are saved too, under its own number) cannot reload into the first tab's fight. A page that asks for no attempt (every regular battle) ignores the field.
//
// No DOM here: tools/pokemonarena_scene_test.mjs runs it in Node with a fake storage.

export const RESUME_VERSION = 1;
export const RESUME_MAX_CHOICES = 4000;

export const resumeKey = (pathname, search) => 'arena.resume:' + String(pathname) + String(search);

const isChoice = (c) => !!c && typeof c === 'object' && !Array.isArray(c) && typeof c.kind === 'string' && c.kind.length > 0 && c.kind.length <= 16;

/** Is `rec` a record this page could have written for this seed? (The store is the visitor's; whatever else is in it is not trusted.) */
export function validRecord(rec, seed, tag) {
  return !!rec && typeof rec === 'object' && rec.v === RESUME_VERSION && rec.seed === seed && rec.tag === tag
    && Array.isArray(rec.choices) && rec.choices.length > 0 && rec.choices.length <= RESUME_MAX_CHOICES && rec.choices.every(isChoice)
    && (typeof rec.hash === 'string' || typeof rec.hash === 'number') && String(rec.hash).length > 0
    && Number.isInteger(rec.turn) && rec.turn >= 0;
}

/** The record for a controller's present state: the human side's choices, in order, and the state hash they led to. */
export function snapshotOf(ctl, seed, humanSide = 0, tag, attempt) {
  const i = ctl.info();
  return { v: RESUME_VERSION, seed, ...(tag === undefined ? {} : { tag }), ...(attempt === undefined ? {} : { attempt }), choices: i.choiceLog.filter((e) => e.s === humanSide).map((e) => JSON.parse(JSON.stringify(e.c))), hash: i.hash, turn: i.turn };
}

/** 'navigate' | 'reload' | 'back_forward' | 'prerender' (what the browser says about how this page was reached); 'navigate' when it does not say. */
export function navigationType(perf) {
  try {
    const p = perf || (typeof performance !== 'undefined' ? performance : null);
    const e = p && typeof p.getEntriesByType === 'function' ? p.getEntriesByType('navigation')[0] : null;
    if (e && typeof e.type === 'string') return e.type;
  } catch (_e) { /* fall through */ }
  return 'navigate';
}

export function createResumeStore({ storage, key, seed, humanSide = 0, tag, attempt }) {
  let detach = null;
  const store = {
    key,
    available: !!storage,
    read() {
      if (!storage) return null;
      let raw = null;
      try { raw = storage.getItem(key); } catch (_e) { return null; }
      if (raw === null || raw === undefined) return null;
      let rec = null;
      try { rec = JSON.parse(raw); } catch (_e) { rec = null; }
      return rec === null ? { v: -1 } : rec;                     // present but unreadable: handed back as an invalid record so that restore() can say so and clear it
    },
    write(rec) { if (!storage) return false; try { storage.setItem(key, JSON.stringify(rec)); return true; } catch (_e) { return false; } },
    clear() { if (!storage) return; try { storage.removeItem(key); } catch (_e) { /* ignore */ } },

    /**
     * `ctl` is a controller that has just been started. On a reload / history step with a good record it comes back with the saved choices replayed into it; otherwise it
     * comes back untouched (or, when a replay failed half way, as a fresh `makeCtl()`, started). -> { ctl, info } with info = { navType, tried, restored, choices, turn, reason }.
     */
    restore({ ctl, makeCtl, navType }) {
      const info = { navType: navType || 'navigate', tried: false, restored: false, choices: 0, turn: 0, reason: '' };
      if (!storage) { info.reason = 'no session storage'; return { ctl, info }; }
      const rec = store.read();
      if (rec === null) { info.reason = 'nothing saved'; return { ctl, info }; }
      if (info.navType !== 'reload' && info.navType !== 'back_forward') { store.clear(); info.reason = 'opened afresh (' + info.navType + ')'; return { ctl, info }; }
      if (!validRecord(rec, seed, tag)) { store.clear(); info.reason = 'the saved record is not usable'; return { ctl, info }; }
      // a saved battle that names the page that fought it (a Tower floor's `attempt`) is resumed only by that page: a record written by another page of the same fight (a second tab) is thrown away, never taken over
      if (attempt !== undefined && rec.attempt !== attempt) { store.clear(); info.reason = 'the saved battle belongs to another page of this fight'; return { ctl, info }; }
      info.tried = true;
      let why = '';
      try {
        for (let k = 0; k < rec.choices.length && !why; k++) {
          const r = ctl.submit(humanSide, rec.choices[k]);
          if (!r || !r.ok) why = 'choice ' + (k + 1) + ' of ' + rec.choices.length + ' was refused' + (r && r.code ? ' (' + r.code + ')' : '');
        }
        if (!why && String(ctl.battle.hash()) !== String(rec.hash)) why = 'the replayed battle is not the saved one';
        if (!why && ctl.turn !== rec.turn) why = 'the replayed battle is on turn ' + ctl.turn + ', the saved one was on ' + rec.turn;
        if (!why && ctl.winner !== null) why = 'the replayed battle is already over';
      } catch (e) { why = 'the replay threw: ' + String(e && e.message ? e.message : e).slice(0, 100); }
      if (!why) { info.restored = true; info.choices = rec.choices.length; info.turn = rec.turn; return { ctl, info }; }
      store.clear();
      info.reason = why;
      const again = makeCtl(); again.start();
      return { ctl: again, info };
    },

    /** Save after every local choice (once the engine has answered it: the write waits for the end of the current task), clear when the battle ends. */
    attach(ctl) {
      if (detach) detach();
      let queued = false;
      const persist = () => {
        queued = false;
        try { if (ctl.winner !== null) store.clear(); else store.write(snapshotOf(ctl, seed, humanSide, tag, attempt)); } catch (_e) { /* ignore */ }
      };
      const offLocal = ctl.onLocalChoice(() => { if (!queued) { queued = true; Promise.resolve().then(persist); } });
      const offEnd = ctl.onEnd(() => store.clear());
      detach = () => { offLocal(); offEnd(); detach = null; };
      return detach;
    },
  };
  return store;
}

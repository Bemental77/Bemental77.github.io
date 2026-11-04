// pokemonarena/js/netmatch.js -- the NETWORKED MATCH: two browsers, one battle, nothing decided by anyone but the engine.
//
// Pure ES module (browser + Node): no DOM, no timers of its own, no network. It is handed a `send(msg)` for the outgoing wire and `receive(msg)` takes
// the incoming one, exactly as lib/netplay.js's Lockstep is transport-free, so tools/pokemonarena_netmatch_test.mjs drives two of these against each
// other in Node and injects every failure a live pair cannot produce on demand (a withheld reveal, a forged commit, a diverged engine, a dead link).
//
// THE MODEL IS THE SITE'S: EVERY MACHINE RUNS THE GAME. Both browsers hold both teams and run the same deterministic engine (engine.js); the only thing
// that crosses the wire is each player's CHOICE (a 16-bit word, engine.encodeChoice), plus the handshake and a state hash. Nothing is streamed and
// nothing is guessed: a missing choice is waited for, never invented, and a hash that disagrees STOPS the match and names the turn.
//
// WHY NOT THE FRAME-LOCKSTEP ENGINE (lib/netplay.js Lockstep). That engine exists for emulators that must run every frame at 60 Hz; a battle is TURN based. A
// frame loop would tick 30 times a second through five minutes of someone thinking, and a backgrounded tab (timers throttled to 1 Hz) would turn every
// choice into several seconds. This module is message driven, so a hidden tab costs nothing. What IS reused from lib/netplay.js is everything about
// getting two people connected: the room code, the host's approval of the joiner, ICE / relay fallback, link health (js/online.js).
//
// THE PROTOCOL (every message is { t:'lsarena', v:2, k:<kind>, mn:<match number>, ... }; mn counts rematches). Version 2 is the build in which a 6v6 battle opens with a LEAD
// preview (each player chooses which Pokemon is sent out first): a round like the 3v3 team preview, committed and revealed together, so the version moved on and a page on the
// older build is refused by name (checkMessage 'version'), where it would otherwise have waited for a choice the other build never asks for.
//   hello   both    { rom, fp, rs, name, team, fmt? }  who I am, my team code, the host's format. Refused by NAME on a different ROM, a different
//                    engine (fp = a fingerprint of a fixed battle), different rules, a team that is not legal, or a team too small for the format.
//   seedc   host    { c }   commitment to the host's half of the battle seed:  sha256(ctx|seed|a|nonce)
//   seedb   guest   { b }   the guest's half, in the clear (it was chosen without knowing a)
//   seedr   host    { a, n } the opening of the commitment. seed = mix(a, b). Neither player can steer the dice: the host is bound to a before it sees b,
//                    and the guest never sees a until b is fixed.
//   go      both    { h }   the hash of the freshly started battle; both must agree before the first turn.
//   rdy     both    { r }   "my screen can take a choice now" (a player is not clocked while their screen is still playing the last turn).
//   commit  both    { r, c, ph }  when BOTH sides choose in a round (every turn, the team preview): sha256(ctx|r|side|choice|nonce), and ph = the hash of
//                    the state this round opened on. Nobody can read the other's choice and answer it: a choice is opened only after both are committed.
//   reveal  both    { r, w, n }  the choice (w) and the nonce, sent once both commitments are in; checked against the commitment.
//   choice  both    { r, w, ph }  a round where only ONE side chooses (a replacement after a faint): nothing to hide, so no commitment.
//   bye     both    { why }   "I am leaving"  ->  the leaver forfeits.   end  { win, h, why }  the match is over; hashes are compared.
//   rematch both    { }       both asked  ->  a new seed handshake, same teams.      sync  { ph, r }  after a dropped link: "resend me from here".
//
// WHAT IT PROVES, AND WHAT IT CANNOT. The engine is deterministic, so two honest machines cannot disagree; the state hash riding on every round makes
// any disagreement (a bug, a cached older build, a tampered client) a stopped match with a turn number rather than two screens drifting apart. It
// cannot hide the other team from a hacked client: both engines need both teams to run (that is the cost of every lockstep game, and the Stadium-style
// team preview that hides the unchosen three is a presentation, not a secret).

import { sha256Hex } from './rom.js';
import { decodeChoice, encodeChoice } from './engine.js';

export const PROTO = 2;          // 1 = the build without the 6v6 lead preview; the stored reload record carries the same number (a record of another version is not resumed)
export const MSG = 'lsarena';
export const NAME_MAX = 10;
export const LIMITS = Object.freeze({ team: 1100, name: 40, str: 64, early: 64, rounds: 5000 });
export const DEFAULTS = Object.freeze({
  turnMs: 120000,     // one decision, counted from "their screen can take a choice"
  previewMs: 180000,  // the team preview takes longer to think about
  capMs: 300000,      // ... and a player whose screen never becomes ready (a hidden tab) is timed out this long after the round opened
  revealMs: 30000,    // both committed: the reveal is automatic, so a missing one is a broken or hostile client
  graceMs: 60000,     // a dropped link is waited for this long
  slackMs: 3000,      // the opponent's clock runs this much longer than the player's own, so the player's own page decides first
  helloMs: 90000,     // the handshake (judging teams, the seed) must finish
});

// Why a `bye` was sent. These STOP the match for both players (nobody wins); anything else is a player leaving, which the other side wins.
export const ABORT_WHY = Object.freeze(['desync', 'cheat', 'illegal', 'protocol', 'equivocation', 'seed', 'internal', 'length', 'start', 'version', 'rom', 'rules', 'team', 'size', 'format']);

const HEX64 = /^[0-9a-f]{64}$/, HEX32 = /^[0-9a-f]{32}$/;
const isU32 = (x) => Number.isInteger(x) && x >= 0 && x <= 0xffffffff;
const isStr = (x, n) => typeof x === 'string' && x.length >= 1 && x.length <= n;
const isInt = (x, lo, hi) => Number.isInteger(x) && x >= lo && x <= hi;

/** A trainer name safe to put in the ROM font and the DOM: ASCII letters, digits and a few marks, at most NAME_MAX, never empty. */
export function cleanName(s, fallback = 'Player') {
  let t = '';
  try { t = String(s == null ? '' : s).normalize('NFKC'); } catch (_e) { t = String(s == null ? '' : s); }
  t = t.replace(/[^A-Za-z0-9 .'_!?-]/g, '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX).trim();
  return t || fallback;
}

/** Strict shape check of ONE incoming message. -> null when fine, else a short reason. Nothing here trusts the sender. */
export function checkMessage(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return 'not an object';
  if (m.t !== MSG) return 'wrong type';
  if (m.v !== PROTO) return 'version';
  if (!isInt(m.mn, 1, 1000)) return 'match number';
  switch (m.k) {
    case 'hello':
      if (!HEX64.test(String(m.rom))) return 'rom';
      if (!isStr(m.fp, LIMITS.str) || !isStr(m.rs, LIMITS.str) || !isStr(m.name, LIMITS.name) || !isStr(m.team, LIMITS.team)) return 'hello fields';
      if (!(m.fmt === undefined || m.fmt === null || m.fmt === '6v6' || m.fmt === '3v3')) return 'format';
      return null;
    case 'seedc': return HEX64.test(String(m.c)) ? null : 'seedc';
    case 'seedb': return isU32(m.b) ? null : 'seedb';
    case 'seedr': return isU32(m.a) && HEX32.test(String(m.n)) ? null : 'seedr';
    case 'go': return isStr(m.h, LIMITS.str) ? null : 'go';
    case 'rdy': return isInt(m.r, 1, LIMITS.rounds) ? null : 'rdy';
    case 'commit': return isInt(m.r, 1, LIMITS.rounds) && HEX64.test(String(m.c)) && isStr(m.ph, LIMITS.str) ? null : 'commit';
    case 'reveal': return isInt(m.r, 1, LIMITS.rounds) && isInt(m.w, 0, 0xffff) && HEX32.test(String(m.n)) ? null : 'reveal';
    case 'choice': return isInt(m.r, 1, LIMITS.rounds) && isInt(m.w, 0, 0xffff) && isStr(m.ph, LIMITS.str) ? null : 'choice';
    case 'bye': return m.why === undefined || isStr(m.why, 24) ? null : 'bye';
    case 'end': return isInt(m.win, -1, 1) && isStr(m.h, LIMITS.str) && isStr(m.why, 24) ? null : 'end';
    case 'rematch': return null;
    case 'sync': return isInt(m.r, 0, LIMITS.rounds) && typeof m.ph === 'string' && m.ph.length <= 12 ? null : 'sync';
    default: return 'unknown kind';
  }
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const strip = (m) => { const x = { ...m }; delete x.mn; return x; };
const mixSeed = (a, b) => ((Math.imul((a ^ 0x9e3779b9) >>> 0, 0x85ebca6b) ^ Math.imul((b + 0x7f4a7c15) >>> 0, 0xc2b2ae35)) >>> 0);
const bytesOf = (s) => new TextEncoder().encode(s);
const hex = (u8) => Array.from(u8, (x) => x.toString(16).padStart(2, '0')).join('');
const u32of = (u8) => u8.reduce((s, x) => ((s << 8) | x) >>> 0, 0) >>> 0;

/**
 * opts:
 *   role         'host' | 'guest'       the host is side 0, the guest side 1, on both machines
 *   room         the room code          binds every commitment to THIS room
 *   send(msg)    -> boolean             the wire (false = the link is down; the message stays in the log and is resent after a sync)
 *   mine         { rom, fp, rs, name, team (the ARENA1 code), size (mons), fmt (host only: '6v6' | '3v3') }   my own card, already judged by the page
 *   judge(card)  -> Promise<{ ok:true, rs, size } | { ok:false, message }>   the page decodes and validates the OPPONENT's team code
 *   makeController({ seed, mySide, fmt, names, mn }) -> ctl   builds the started match controller: sides [human|remote] in the right order
 *   randomBytes(n) -> Uint8Array        crypto in the browser, a seeded stream in a test
 *   now() -> ms                         the clock (injected: a test advances it by hand)
 *   on           { phase(p, info), notice(text, kind), end(result), controller(ctl), progress() }   callbacks; all optional
 *   limits       overrides for DEFAULTS
 */
export function createNetMatch(opts) {
  const role = opts.role === 'guest' ? 'guest' : 'host';
  const isHost = role === 'host';
  const mySide = isHost ? 0 : 1, oppSide = mySide ^ 1;
  const L = { ...DEFAULTS, ...(opts.limits || {}) };
  const on = opts.on || {};
  const now = opts.now || (() => Date.now());
  const rbytes = opts.randomBytes || ((n) => { const u = new Uint8Array(n); globalThis.crypto.getRandomValues(u); return u; });
  const fire = (name, ...a) => { const f = on[name]; if (typeof f === 'function') { try { f(...a); } catch (e) { if (typeof console !== 'undefined') console.error('[netmatch] ' + name + ' listener failed', e); } } };

  const nm = {
    role, mySide, oppSide,
    phase: 'idle',            // idle | hello | judging | seed | start | playing | over | failed | closed
    mn: 1,                    // match number (rematches)
    ctl: null, error: null, result: null, link: 'up', opp: null, oppName: null, names: null, seed: undefined,
    fmt: isHost ? (opts.mine.fmt === '3v3' ? '3v3' : '6v6') : null,
  };
  let theirHello = null, helloMsg = null, helloAt = 0;
  let ctx = '';
  let seedMine = null;      // host: { a, n } / guest: { b }
  let inb = {};             // establishment messages received this match: seedc, seedb, seedr, go
  let outLog = [];          // everything I sent this match, in order: resent after a dropped link
  let early = [];           // messages for a round / match I have not reached yet
  let round = null;         // the open round
  let r = 0;
  let q = [], busy = false;
  let downAt = 0, longestDown = 0, outageThisRound = false;
  let everUp = true;        // false only for a page that was reloaded into a match and has not reached the other player yet
  let rematchMine = false, rematchTheirs = false;
  let endSent = false, endTheirs = null, endChecked = false;
  let conceded = null;      // why this match ended other than by winning: 'forfeit' | 'left' | 'timeout' | 'lost-link' | 'closed'
  let progressing = false;

  /* ------------------------------------------------------------------------------------------------ plumbing */
  const mk = (k, f) => ({ t: MSG, v: PROTO, k, mn: nm.mn, ...f });
  function emit(msg, log = true) {
    if (log) outLog.push(msg);
    try { return !!opts.send(msg); } catch (_e) { return false; }
  }
  const notice = (text, kind = 'info') => fire('notice', text, kind);
  function setPhase(p, info) { nm.phase = p; fire('phase', p, info || null); }
  const dead = () => nm.phase === 'failed' || nm.phase === 'closed';
  function fail(code, message, { tell = true } = {}) {
    if (dead()) return;
    nm.error = { code, message };
    if (tell) { try { opts.send(mk('bye', { why: String(code).slice(0, 24) })); } catch (_e) { /* the link may be gone */ } }
    setPhase('failed', nm.error);
    fire('end', { reason: code, failed: true, message });
  }

  /* ------------------------------------------------------------------------------------------------ handshake */
  nm.start = function start() {
    if (nm.phase !== 'idle') return;
    const c = opts.mine;
    helloMsg = mk('hello', { rom: c.rom, fp: c.fp, rs: c.rs, name: c.name, team: c.team });
    if (isHost) helloMsg.fmt = nm.fmt;
    helloAt = now();
    setPhase('hello');
    emit(helloMsg);
    drain();
  };

  async function onHello(m) {
    if (theirHello) { if (theirHello.resumed) return; if (!same(strip(theirHello), strip(m))) fail('equivocation', 'The other player sent two different hellos.'); return; }       // (resumed: answered before the reload)
    theirHello = m;
    const c = opts.mine;
    if (m.rom !== c.rom) return fail('rom', 'The other player is using a different game file, so the two games cannot match.');
    if (m.fp !== c.fp) return fail('version', 'The other player is on a different version of the Arena. Reload the page on both sides and try again.');
    if (isHost && m.fmt) return fail('format', 'Only the host chooses the format.');
    if (!isHost && !m.fmt) return fail('format', 'The host did not name a format.');
    if (!isHost) nm.fmt = m.fmt;
    setPhase('judging');
    let j;
    try { j = await opts.judge({ team: m.team, name: m.name, rs: m.rs }); } catch (e) { j = { ok: false, message: 'The other player\'s team could not be checked (' + (e && e.message ? e.message : e) + ').' }; }
    if (dead()) return;
    if (!j || !j.ok) return fail('team', (j && j.message) || 'The other player\'s team is not allowed here.');
    if (j.rs !== c.rs) return fail('rules', 'The two teams were built for different rules (' + c.rs + ' and ' + j.rs + ').');
    const pick = nm.fmt === '3v3' ? 3 : 0;
    if (pick && (j.size < pick || c.size < pick)) return fail('size', 'A 3v3 battle needs at least 3 Pokemon on each team.');
    // Both machines must hold identical names: they are part of the battle state, so they are part of its hash. Each side cleans the
    // other's raw name the way the other cleans its own, and a clash is settled the same way on both ends (the guest becomes "<name> 2").
    const mine = cleanName(c.name, isHost ? 'Host' : 'Guest'), theirs = cleanName(m.name, isHost ? 'Guest' : 'Host');
    let hostName = isHost ? mine : theirs, guestName = isHost ? theirs : mine;
    if (hostName === guestName) guestName = cleanName(guestName.slice(0, NAME_MAX - 2) + ' 2');
    nm.names = [hostName, guestName];
    nm.oppName = isHost ? guestName : hostName;
    nm.myName = isHost ? hostName : guestName;
    nm.opp = { name: nm.oppName, rs: j.rs, size: j.size, judged: j };
    beginSeed();
  }

  function beginSeed() {
    setPhase('seed');
    ctx = opts.room + '#' + nm.mn;
    seedMine = null;
    if (isHost) {
      const a = u32of(rbytes(4)), n = hex(rbytes(16));
      seedMine = { a, n };
      emit(mk('seedc', { c: sha256Hex(bytesOf(['arena1', 'seed', ctx, a, n].join('|'))) }));
    }
    requeueEarly();
  }
  function keep(slot, m) {
    if (inb[slot]) { if (!same(strip(inb[slot]), strip(m))) fail('equivocation', 'The other player sent two different "' + slot + '" messages.'); return false; }
    inb[slot] = m;
    return true;
  }
  function onSeedc(m) {
    if (isHost) return fail('protocol', 'The guest sent the host\'s seed commitment.');
    if (!keep('seedc', m) || seedMine) return;
    seedMine = { b: u32of(rbytes(4)) };
    emit(mk('seedb', { b: seedMine.b }));
    if (inb.seedr) onSeedr(inb.seedr);
  }
  function onSeedb(m) {
    if (!isHost) return fail('protocol', 'The host sent the guest\'s seed half.');
    if (!keep('seedb', m) || !seedMine || seedMine.opened) return;
    seedMine.opened = true;
    emit(mk('seedr', { a: seedMine.a, n: seedMine.n }));
    finishSeed(mixSeed(seedMine.a, m.b));
  }
  function onSeedr(m) {
    if (isHost) return fail('protocol', 'The guest opened the host\'s seed.');
    keep('seedr', m);
    if (!inb.seedc || !seedMine || nm.seedMn === nm.mn) return;
    if (sha256Hex(bytesOf(['arena1', 'seed', ctx, m.a, m.n].join('|'))) !== inb.seedc.c) return fail('seed', 'The host\'s seed does not match what it committed to, so the match was stopped.');
    finishSeed(mixSeed(m.a, seedMine.b));
  }
  function finishSeed(seed) {
    if (nm.seedMn === nm.mn) return;
    nm.seed = seed >>> 0; nm.seedMn = nm.mn;
    let ctl;
    try { ctl = opts.makeController({ seed: nm.seed, mySide, fmt: nm.fmt, names: nm.names.slice(), mn: nm.mn }); }
    catch (e) { return fail('start', 'The battle could not be started: ' + String(e && e.message ? e.message : e).slice(0, 120)); }
    nm.ctl = ctl;
    setPhase('start');
    ctl.onLocalChoice((ev) => { if (nm.ctl === ctl && ev.side === mySide) onLocal(ev); });
    ctl.onEvents(() => { if (nm.ctl === ctl && nm.phase === 'playing') schedule(); });
    emit(mk('go', { h: ctl.battle.hash() }));
    if (inb.go) onGo(inb.go);
  }
  function onGo(m) {
    keep('go', m);
    if (nm.phase !== 'start' || !inb.go) return;
    if (inb.go.h !== nm.ctl.battle.hash()) return fail('desync', 'The two games did not start from the same position, so the match was stopped (the other player may be on a different version).');
    r = 0; round = null; endSent = false; endTheirs = null; endChecked = false; conceded = null; nm.result = null;
    setPhase('playing');
    fire('controller', nm.ctl);
    openRound();
  }

  /* ------------------------------------------------------------------------------------------------ rounds */
  const pend = (side) => nm.ctl.pending(side);

  function openRound() {
    const ctl = nm.ctl;
    if (ctl.winner !== null) return finishMatch();
    // WHO MUST CHOOSE comes from the engine's own flag (ctl.needs), not from the open requests: a request disappears the moment a side has chosen, and a page that was
    // reloaded after answering would then see a round with one chooser fewer than the other machine saw. (Where a controller has no needs(), the requests are the fallback.)
    const needOf = (s) => (typeof ctl.needs === 'function' ? ctl.needs(s) : !!pend(s));
    const need = [needOf(0), needOf(1)];
    if (!need[0] && !need[1]) return;          // the engine is mid-resolution; its next events open the round
    r++;
    if (r > LIMITS.rounds) return fail('length', 'The match ran too long.');
    outageThisRound = nm.link === 'down';
    round = { r, need, hash: ctl.battle.hash(), kind: ctl.battle.s.phase === 'preview' ? 'preview' : 'move', openedAt: now(), mine: null, theirs: null, rdyMine: 0, rdyTheirs: 0, applied: false, revealSentAt: 0, evCount: ctl.battle.events.length };
    fire('progress');
    requeueEarly();
    progress();
  }

  function onLocal(ev) {
    if (nm.phase !== 'playing') return;
    if (ev.choice && ev.choice.kind === 'forfeit') {          // the controller already conceded; tell the other side
      if (!conceded) { conceded = 'forfeit'; emit(mk('bye', { why: 'forfeit' })); }
      return;
    }
    if (!round || round.mine || !round.need[mySide]) return;
    const w = ev.wire;
    if (round.need[0] && round.need[1]) {
      const nonce = hex(rbytes(16));
      const c = sha256Hex(bytesOf(['arena1', ctx, round.r, mySide, w, nonce].join('|')));
      round.mine = { w, nonce, c };
      emit(mk('commit', { r: round.r, c, ph: round.hash }));
    } else {
      round.mine = { w, plain: true };
      emit(mk('choice', { r: round.r, w, ph: round.hash }));
    }
    fire('progress');
    schedule();          // the reveal may be due; never run it inside the controller's own call
  }

  const desyncMsg = () => 'The two games stopped agreeing at turn ' + (nm.ctl ? nm.ctl.turn : '?') + ', so the match was stopped.';
  function onRdy() { if (!round.rdyTheirs) round.rdyTheirs = now(); fire('progress'); }
  function onCommit(m) {
    if (!(round.need[0] && round.need[1])) return fail('protocol', 'The other player committed to a choice in a round where only one player chooses.');
    if (m.ph !== round.hash) return fail('desync', desyncMsg());
    if (round.theirs && round.theirs.c) { if (round.theirs.c !== m.c) fail('equivocation', 'The other player committed to two different choices.'); return; }
    round.theirs = { c: m.c };
    fire('progress');
  }
  function onReveal(m) {
    if (!round.theirs || !round.theirs.c) return fail('protocol', 'The other player revealed a choice it never committed to.');
    if (round.theirs.w !== undefined) { if (round.theirs.w !== m.w) fail('equivocation', 'The other player revealed two different choices.'); return; }
    if (sha256Hex(bytesOf(['arena1', ctx, round.r, oppSide, m.w, m.n].join('|'))) !== round.theirs.c) return fail('cheat', 'The other player\'s revealed choice does not match what it committed to, so the match was stopped.');
    round.theirs.w = m.w;
  }
  function onChoice(m) {
    if (!(round.need[oppSide] && !round.need[mySide])) return fail('protocol', 'The other player sent a plain choice in a round where it was not the only one choosing.');
    if (m.ph !== round.hash) return fail('desync', desyncMsg());
    if (round.theirs && round.theirs.w !== undefined) { if (round.theirs.w !== m.w) fail('equivocation', 'The other player sent two different choices.'); return; }
    round.theirs = { w: m.w, plain: true };
    fire('progress');
  }

  // Everything that can move a round forward, run to quiescence. Called after every incoming message and every engine event.
  function progress() {
    if (progressing) return;
    progressing = true;
    try {
      for (let g = 0; g < 8 && nm.phase === 'playing' && round && !round.applied; g++) {
        const both = round.need[0] && round.need[1];
        let moved = false;
        if (both) {
          if (round.mine && round.theirs && round.theirs.c && !round.revealSentAt) {
            round.revealSentAt = now();
            emit(mk('reveal', { r: round.r, w: round.mine.w, n: round.mine.nonce }));
            moved = true;
          }
          if (round.revealSentAt && round.theirs && round.theirs.w !== undefined) { applyTheirs(round.theirs.w); moved = true; }
        } else if (round.need[oppSide] && round.theirs && round.theirs.w !== undefined) { applyTheirs(round.theirs.w); moved = true; }
        if (!moved) break;
      }
    } finally { progressing = false; }
  }
  function applyTheirs(w) {
    round.applied = true;
    const c = decodeChoice(w);
    if (!c) return fail('illegal', 'The other player sent a choice that is not a choice.');
    const res = nm.ctl.submitRemote(c);
    if (!res || !res.ok) return fail('illegal', 'The other player\'s game sent a choice that is not legal here (' + (res && res.code) + '), so the match was stopped.');
    afterAdvance();      // the engine advanced inside submitRemote
  }
  // Has the engine moved since the round opened? Then that round is over: open the next one, or finish the match.
  function afterAdvance() {
    if (nm.phase !== 'playing') return;
    const ctl = nm.ctl;
    if (round && ctl.battle.events.length === round.evCount && ctl.winner === null) return;
    round = null;
    if (ctl.winner !== null) return finishMatch();
    openRound();
  }
  function schedule() { Promise.resolve().then(() => { try { afterAdvance(); progress(); } catch (e) { fail('internal', 'Internal error: ' + (e && e.message ? e.message : e)); } }); }

  /** The PAGE tells us when its screen can take a choice (the scene is in a choosing mode with a request pending). Tells the other side its clock may start. */
  nm.screenReady = function screenReady() {
    if (nm.phase !== 'playing' || !round || round.rdyMine || round.mine || !round.need[mySide]) return;
    round.rdyMine = now();
    emit(mk('rdy', { r: round.r }), false);
    fire('progress');
  };

  /* ------------------------------------------------------------------------------------------------ the end */
  function finishMatch() {
    if (nm.phase !== 'playing') return;
    const ctl = nm.ctl, win = ctl.winner;
    nm.result = { winnerSide: win, iWon: win === mySide, draw: win === -1, reason: conceded || 'result', turns: ctl.turn, hash: ctl.battle.hash() };
    if (!endSent) { endSent = true; emit(mk('end', { win, h: nm.result.hash, why: nm.result.reason })); }
    setPhase('over', nm.result);
    fire('end', nm.result);
    checkEnd();
  }
  // A claim AGAINST ME ("you ran out of time", "your link was dead") is believed only when my own clock or my own link record agrees: otherwise a
  // hostile client could end any match by announcing it. A claim against THEMSELVES (a forfeit, leaving) only ever hurts the sender, so it is taken.
  // "Against me" is decided by WHO LOSES (the winner the message names), never by the label the sender chose for it: an honest peer can only ever put the
  // two reasons below on a claim against me, so every other label ('forfeit', 'left', anything up to 24 characters) is refused here (plausibleClaim -> false).
  function plausibleClaim(why) {
    const t = now();
    if (why === 'lost-link') return longestDown >= L.graceMs * 0.8;
    if (why === 'timeout') {
      if (outageThisRound) return true;                                  // my reveal or choice may genuinely have been lost with the link
      if (!round || !round.need[mySide] || round.mine) return false;     // I owed nothing, or had answered
      return t - (round.rdyMine || round.openedAt) >= (round.rdyMine ? (round.kind === 'preview' ? L.previewMs : L.turnMs) : L.capMs) - 2 * L.slackMs;
    }
    return false;
  }
  function onEnd(m) {
    if (endTheirs) return;
    endTheirs = m;
    // The other side says the match ended some way other than a normal finish and I may not have got there yet (a timeout, a lost link, a forfeit).
    if (nm.phase === 'playing' && m.why !== 'result' && nm.ctl.winner === null && m.win !== -1) {
      const loser = m.win ^ 1;
      if (loser === mySide && !plausibleClaim(m.why)) {
        endTheirs = null;
        return fail('cheat', 'The other player ended the match by announcing that you had lost it, but your game disagrees, so the match was stopped.');
      }
      conceded = m.why;
      nm.ctl.concede(loser);
      afterAdvance();
    }
    checkEnd();
  }
  function checkEnd() {
    if (nm.phase !== 'over' || !endTheirs || endChecked) return;
    endChecked = true;
    // only a normal finish on BOTH sides can be compared position for position
    if (endTheirs.why === 'result' && nm.result.reason === 'result') {
      if (endTheirs.win !== nm.result.winnerSide) fail('desync', 'The two games ended with different winners, so the result is not counted.', { tell: false });
      else if (endTheirs.h !== nm.result.hash) fail('desync', 'The two games ended in different positions, so the result is not counted.', { tell: false });
    }
  }

  /** The local player leaves (closing the page, back to the hub, a timeout of their own). The other side wins. */
  function leave(why) {
    if (dead()) return;
    why = String(why || 'left').slice(0, 24);
    if (nm.phase === 'playing' && nm.ctl && nm.ctl.winner === null) {
      if (!conceded) { conceded = why; emit(mk('bye', { why })); }
      nm.ctl.concede(mySide);
      afterAdvance();
      return;
    }
    try { opts.send(mk('bye', { why })); } catch (_e) { /* ignore */ }
    if (nm.phase !== 'over') setPhase('closed');
  }
  nm.leave = leave;
  nm.close = function close() { leave('closed'); if (!dead()) setPhase('closed'); };
  /**
   * May the match that has just ended be written to a record? Only a match the engine took to its result and that nothing has STOPPED since. The end-of-match comparison
   * (checkEnd) can fail a match that is already 'over' (the other machine's `end` named another winner or another final position): the phase turns 'failed', the page shows
   * the error, and that match is not counted, even though the scene underneath is still playing its last turn. battle_boot.js asks this before it writes a profile.
   */
  nm.countable = function countable() { return !dead() && !!nm.ctl && nm.ctl.winner !== null; };

  function onBye(m) {
    const why = m.why || 'left';
    if (ABORT_WHY.includes(why)) { if (!dead() && nm.phase !== 'over') fail('peer-stopped', 'The other player\'s game stopped the match (' + why + ').', { tell: false }); return; }
    if (nm.phase === 'playing' && nm.ctl && nm.ctl.winner === null) {
      notice('The other player left the battle.', 'warn');
      conceded = why === 'timeout' ? 'timeout' : 'left';
      nm.ctl.concede(oppSide);
      afterAdvance();
      return;
    }
    if (nm.phase === 'over') { notice('The other player left.', 'warn'); nm.oppGone = true; fire('progress'); return; }
    if (!dead()) fail('left', 'The other player left before the battle began.', { tell: false });
  }

  /* ------------------------------------------------------------------------------------------------ rematch */
  nm.requestRematch = function requestRematch() {
    if (nm.phase !== 'over' || nm.oppGone || rematchMine) return false;
    rematchMine = true;
    emit(mk('rematch', {}), false);
    maybeRematch();
    fire('progress');
    return true;
  };
  function onRematch() { rematchTheirs = true; fire('progress'); maybeRematch(); }
  function maybeRematch() {
    if (!(rematchMine && rematchTheirs && nm.phase === 'over')) return;
    rematchMine = false; rematchTheirs = false;
    nm.mn++; inb = {}; outLog = []; seedMine = null; endTheirs = null; endSent = false; endChecked = false; round = null; r = 0; conceded = null;
    beginSeed();
  }

  /* ------------------------------------------------------------------------------------------------ the link */
  /** The page reports the link going down / coming back (lib/netplay.js status events). */
  nm.linkChanged = function linkChanged(up) {
    const was = nm.link;
    nm.link = up ? 'up' : 'down';
    if (!up) { if (!downAt) downAt = now(); outageThisRound = true; if (was === 'up' && !dead() && nm.phase !== 'over') notice('Connection lost. Waiting for the other player to come back...', 'warn'); return; }
    if (downAt) longestDown = Math.max(longestDown, now() - downAt);
    downAt = 0; everUp = true;
    if (was === 'down' && !dead() && nm.phase !== 'over') notice('Connection restored.', 'ok');
    // "I am here again": say where I am so the other side resends exactly what I have not seen
    try { opts.send(mk('sync', { ph: nm.phase.slice(0, 12), r })); } catch (_e) { /* ignore */ }
  };
  function onSync(m) {
    for (const msg of outLog) if (msg.r === undefined || msg.r >= m.r) { try { opts.send(msg); } catch (_e) { /* the link flapped again */ } }
    if (nm.phase === 'over' && nm.result) { try { opts.send(mk('end', { win: nm.result.winnerSide, h: nm.result.hash, why: nm.result.reason })); } catch (_e) { /* ignore */ } }
  }

  /* ------------------------------------------------------------------------------------------------ clocks */
  /** Call a few times a second. Everything it decides goes through fail / concede / notice. */
  nm.tick = function tick() {
    const t = now();
    if (nm.phase === 'hello' || nm.phase === 'judging' || nm.phase === 'seed' || nm.phase === 'start') {
      if (helloAt && t - helloAt > L.helloMs) fail('timeout', 'The other player did not finish connecting in time.');
      return;
    }
    if (nm.phase !== 'playing' || !round || !nm.ctl) return;
    if (nm.link === 'down') {
      if (downAt) longestDown = Math.max(longestDown, t - downAt);
      if (downAt && t - downAt > L.graceMs) {
        // a page that was reloaded into this match and never got back to the other player cannot say the OTHER player left
        if (!everUp) return fail('timeout', 'Could not get back to the other player, so the battle was stopped.', { tell: false });
        notice('The other player did not come back, so you win.', 'warn'); concedeOpp('lost-link');
      }
      return;
    }
    const lim = round.kind === 'preview' ? L.previewMs : L.turnMs;
    const both = round.need[0] && round.need[1];
    // the reveal is automatic: a missing one after both commitments is a broken or hostile client
    if (both && round.revealSentAt && round.theirs && round.theirs.c && round.theirs.w === undefined && t - round.revealSentAt > L.revealMs) { notice('The other player stopped responding, so you win.', 'warn'); return concedeOpp('timeout'); }
    if (round.need[oppSide] && !(round.theirs && (round.theirs.c || round.theirs.w !== undefined))) {
      if (round.rdyTheirs ? t - round.rdyTheirs > lim + L.slackMs : t - round.openedAt > L.capMs) { notice('The other player ran out of time, so you win.', 'warn'); concedeOpp('timeout'); }
    }
  };
  function concedeOpp(why) {
    if (nm.phase !== 'playing' || nm.ctl.winner !== null) return;
    conceded = why;
    nm.ctl.concede(oppSide);
    afterAdvance();
  }
  /** The local player's own clock for the UI: ms left to choose, or null when nothing is being asked of them. */
  nm.myClock = function myClock() {
    if (nm.phase !== 'playing' || !round || !round.need[mySide] || round.mine || !round.rdyMine) return null;
    return Math.max(0, (round.kind === 'preview' ? L.previewMs : L.turnMs) - (now() - round.rdyMine));
  };
  /** Called by the page when the local clock reached zero. */
  nm.timeOutSelf = function timeOutSelf() { if (nm.phase === 'playing') leave('timeout'); };

  /* ------------------------------------------------------------------------------------------------ inbound */
  // Messages are handled strictly in order, one at a time (judging a team code is asynchronous).
  nm.receive = function receive(msg) {
    if (dead() || nm.phase === 'idle' && !msg) return;
    const bad = checkMessage(msg);
    if (bad === 'version') { if (nm.phase !== 'idle') fail('version', 'The other player is on a different version of the Arena. Reload the page on both sides and try again.'); return; }
    if (bad) { if (nm.phase !== 'idle') fail('protocol', 'The other player sent something this game does not understand (' + bad + '). One of you may be running an older cached copy of the page: reload it and try again.'); return; }
    q.push(msg);
    drain();
  };
  async function drain() {
    if (busy) return;
    busy = true;
    try {
      while (q.length && !dead()) {
        if (nm.phase === 'idle') break;            // our own hello goes first: wait for start()
        await handle(q.shift());
      }
    } catch (e) { fail('internal', 'Internal error: ' + (e && e.message ? e.message : e)); }
    finally { busy = false; }
  }
  function requeueEarly() { if (!early.length) return; const pending = early; early = []; q.push(...pending); drain(); }
  const hold = (m) => { if (early.length < LIMITS.early) early.push(m); };

  async function handle(m) {
    if (m.k === 'sync') return onSync(m);
    if (m.k === 'bye') return onBye(m);
    if (m.k === 'hello') return onHello(m);
    if (m.mn < nm.mn) return;                        // from a match that is over
    if (m.mn > nm.mn) return hold(m);                // from a rematch I have not started yet
    switch (m.k) {
      case 'seedc': case 'seedb': case 'seedr':
        if (nm.phase !== 'seed') return nm.phase === 'start' || nm.phase === 'playing' || nm.phase === 'over' ? undefined : hold(m);
        return m.k === 'seedc' ? onSeedc(m) : m.k === 'seedb' ? onSeedb(m) : onSeedr(m);
      case 'go':
        if (nm.phase === 'start') return onGo(m);
        if (nm.phase === 'hello' || nm.phase === 'judging' || nm.phase === 'seed') { keep('go', m); return; }
        return;
      case 'rdy': case 'commit': case 'reveal': case 'choice':
        if (nm.phase !== 'playing' || !round) return nm.phase === 'over' ? undefined : hold(m);
        if (m.r < round.r) return;
        if (m.r > round.r) return hold(m);
        if (m.k === 'rdy') onRdy(); else if (m.k === 'commit') onCommit(m); else if (m.k === 'reveal') onReveal(m); else onChoice(m);
        progress();
        return;
      case 'end': return onEnd(m);
      case 'rematch': return onRematch();
      default: return;
    }
  }

  /* ------------------------------------------------------------------------------------------------ reload */
  /**
   * What a page keeps (sessionStorage) so that a RELOAD does not lose the battle: the agreed seed, every choice the engine has taken so far (this machine's log, own choice first),
   * the round it is in, the choice it has committed to but not yet opened (the nonce is not recoverable from anything else), and every message it has sent this match (so the
   * other side's 'sync' after the reconnection can be answered). Null when there is nothing to resume.
   */
  nm.snapshot = function snapshot() {
    if (nm.phase !== 'playing' || !nm.ctl || !round) return null;
    return {
      v: PROTO, room: opts.room, role, mn: nm.mn, seed: nm.seed, fmt: nm.fmt, names: nm.names.slice(), r: round.r, rh: round.hash, hash: nm.ctl.battle.hash(),
      log: nm.ctl.battle.choiceLog.map((e) => ({ s: e.s, c: JSON.parse(JSON.stringify(e.c)) })),
      outLog: outLog.slice(-600), secret: round.mine && round.mine.nonce ? { r: round.r, w: round.mine.w, nonce: round.mine.nonce } : null,
    };
  };

  /**
   * Pick a battle up again from snapshot(): rebuild the controller from the agreed seed, replay the recorded choices, and refuse unless that lands on the recorded state hash.
   * The handshake is NOT run again; the link starts DOWN (the page reports it up with linkChanged(true), which sends a 'sync', and the other side resends what this page missed).
   * -> true, or false with nm.error set (a record that does not replay is a failure by name, never a guess).
   */
  nm.resume = function resume(rec) {
    if (nm.phase !== 'idle') return false;
    const bad = (why) => { fail('resume', 'The battle could not be picked up again (' + why + ').', { tell: false }); return false; };
    if (!rec || rec.v !== PROTO || rec.role !== role || rec.room !== opts.room || !isInt(rec.mn, 1, 1000) || !isU32(rec.seed) || !Array.isArray(rec.names) || rec.names.length !== 2
      || !isInt(rec.r, 1, LIMITS.rounds) || typeof rec.hash !== 'string' || !Array.isArray(rec.log) || rec.log.length > 4000 || !Array.isArray(rec.outLog) || !(rec.fmt === '6v6' || rec.fmt === '3v3')) return bad('the record is not one this page wrote');
    nm.mn = rec.mn; nm.fmt = rec.fmt; nm.names = rec.names.map((x) => cleanName(x)); nm.oppName = nm.names[oppSide]; nm.myName = nm.names[mySide];
    nm.seed = rec.seed >>> 0; nm.seedMn = nm.mn; ctx = opts.room + '#' + nm.mn;
    theirHello = { resumed: true };
    let ctl;
    try { ctl = opts.makeController({ seed: nm.seed, mySide, fmt: nm.fmt, names: nm.names.slice(), mn: nm.mn }); } catch (e) { return bad('the battle could not be rebuilt: ' + String(e && e.message ? e.message : e).slice(0, 80)); }
    for (const e of rec.log) {
      if (!e || (e.s !== 0 && e.s !== 1) || !e.c || typeof e.c !== 'object') return bad('a recorded choice is malformed');
      const res = e.s === mySide ? ctl.submit(mySide, e.c) : ctl.submitRemote(e.c);
      if (!res || !res.ok) return bad('a recorded choice was refused: ' + (res && res.code));
    }
    if (ctl.battle.hash() !== rec.hash) return bad('the replay did not reach the recorded position');
    nm.ctl = ctl;
    ctl.onLocalChoice((ev) => { if (nm.ctl === ctl && ev.side === mySide) onLocal(ev); });
    ctl.onEvents(() => { if (nm.ctl === ctl && nm.phase === 'playing') schedule(); });
    outLog = rec.outLog.filter((m) => checkMessage(m) === null && m.mn === nm.mn);
    r = rec.r - 1; round = null; endSent = false; endTheirs = null; endChecked = false; conceded = null; nm.result = null;
    nm.resumed = true; nm.link = 'down'; downAt = now(); everUp = false;
    setPhase('playing');
    fire('controller', ctl);
    openRound();
    if (dead()) return false;
    if (!round || round.r !== rec.r) return bad('the rebuilt battle is in a different round than the recorded one');
    // The hash a round opens on is what the other machine compares its own against. The engine we just rebuilt already holds the answer this machine had given, so its
    // hash is no longer that of the round's opening: the recorded one is used (it is only ever compared with the other side's, so a wrong one only stops our own match).
    if (typeof rec.rh === 'string' && rec.rh.length > 0 && rec.rh.length <= LIMITS.str) round.hash = rec.rh;
    // the choice this page had already made: it is in the engine, and only the nonce behind its commitment is needed to open it later
    if (round.need[mySide] && !ctl.pending(mySide)) {
      const sec = rec.secret && rec.secret.r === round.r ? rec.secret : null;
      const mineLog = rec.log.filter((e) => e.s === mySide).pop();
      const w = sec ? sec.w : (mineLog ? encodeChoice(mineLog.c) : -1);
      if (round.need[0] && round.need[1]) {
        if (!sec || !isInt(sec.w, 0, 0xffff) || !HEX32.test(String(sec.nonce))) return bad('the choice committed to before the reload cannot be opened');
        round.mine = { w, nonce: sec.nonce, c: sha256Hex(bytesOf(['arena1', ctx, round.r, mySide, w, sec.nonce].join('|'))) };
      } else round.mine = { w, plain: true };
    }
    fire('progress');
    progress();
    return true;
  };

  nm.status = function status() {
    const open = round && !round.applied;
    const got = (s) => (s === mySide ? round.mine : round.theirs && (round.theirs.c || round.theirs.w !== undefined));
    return {
      phase: nm.phase, role, mySide, mn: nm.mn, link: nm.link, round: round ? round.r : 0, kind: round ? round.kind : '', turn: nm.ctl ? nm.ctl.turn : 0,
      waitingOn: open ? [0, 1].filter((s) => round.need[s] && !got(s)) : [],
      opponent: nm.oppName, error: nm.error, result: nm.result, oppReady: !!(round && round.rdyTheirs), myClockMs: nm.myClock(),
      rematch: { mine: rematchMine, theirs: rematchTheirs }, oppGone: !!nm.oppGone,
    };
  };
  nm._debug = { get round() { return round; }, get r() { return r; }, get outLog() { return outLog; }, get early() { return early; } };
  return nm;
}

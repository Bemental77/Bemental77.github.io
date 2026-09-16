#!/usr/bin/env node
// ---------------------------------------------------------------------------
// WHAT THE PAGES SAY TO A PLAYER, JUDGED — TypeSafe System One (Jev).
//
// WHY A JUDGE AND NOT A REGEX.
//   Every netplay rig here asserts EXACT STRINGS. tools/netplay_invariants.mjs
//   greps for wording; dreamcast/tools/room_hud_test.mjs and
//   tools/console_room_crossdevice_test.mjs read a sentence back and compare it
//   to one they know. So a REWORDED message passes every gate in the repo, and
//   a NEW message is covered by nothing at all.
//
//   The defect class that keeps reaching the user is not a missing string, it is
//   a BAD one. From this repo's own history:
//     * 24ee7ffc "dreamcast: the page told a player their emulator had stopped
//       while it was running fine"
//     * tools/netplay_signalling_test.mjs exists because of "the frozen
//       'Waiting for someone to join...' screen a real user sat on"
//     * console_room_crossdevice's `a-stall-fail-never-shows-a-nonce` is a
//       hand-written guard against ONE leak shape — the engine embedding a
//       16-hex peer id in a sentence (n64/index.html:3247 "NEVER A NONCE").
//   None of those is decidable by pattern matching. They are judgments about
//   whether a sentence is true of the state, actionable, and written for a
//   player rather than for the person who wrote the code.
//
// WHAT IT DOES
//   Harvests every player-facing sentence the shipped pages can show, and asks
//   Jev four independent questions per sentence in ONE request (they cannot see
//   one another's answers, and none depends on another's result):
//     leaks_an_internal_identifier   - the nonce class, generalised
//     tells_the_reader_what_happens_next - the frozen-screen class
//     blames_the_player_or_their_device  - tone
//     technical_knowledge_needed         - a graded score, not a yes/no
//
//   Raw judgments are written out in full. POLICY lives in code and is
//   env-tunable, so re-tuning a threshold does NOT re-run inference — the
//   judgments are reusable data, per TypeSafe's own guidance.
//
// WHAT IT IS NOT
//   Not a truth oracle, and not a style cop. It judges the SENTENCE against the
//   reader it names; it cannot know whether the sentence is true of the state at
//   the moment it is shown. That question needs captured (state, sentence)
//   pairs, and `--pairs <xdev.json>` is where those go when a room rig has run.
//
// USAGE
//   TYPESAFE_API_KEY=... node tools/netplay_message_judge.mjs            # judge + verdict
//   node tools/netplay_message_judge.mjs --report                        # print every score, no verdict
//   node tools/netplay_message_judge.mjs --pairs /tmp/console-xdev/xdev.json
//   JUDGE_JSON=/tmp/msg-judge.json                                       # raw judgments out
//
// EXIT  0 = no sentence crosses policy. 1 = at least one does. 2 = cannot run
//       (no key, no corpus) — never a silent pass.
// ---------------------------------------------------------------------------
import { readFileSync, existsSync, writeFileSync } from 'fs';

const API_URL = process.env.TYPESAFE_API_URL || 'https://api.typesafe.ai/v1/systemone';
const MODEL = process.env.TYPESAFE_MODEL || 'jev-latest';
const CONCURRENCY = Number(process.env.JUDGE_CONCURRENCY || 6);
const OUT = process.env.JUDGE_JSON || '/tmp/netplay-message-judge.json';
const REPORT_ONLY = process.argv.includes('--report');
const PAIRS = (() => { const i = process.argv.indexOf('--pairs'); return i > 0 ? process.argv[i + 1] : null; })();

// Policy. Tuned against the printed distribution over this repo's own corpus —
// see the calibration note in the README block of the run output. Changing any
// of these is a code change, never a re-judgement.
const POLICY = {
  leak:        Number(process.env.JUDGE_LEAK        ?? 0.70),
  noNextStep:  Number(process.env.JUDGE_NO_NEXT     ?? 0.30),   // ceiling: below this is a dead end
  blame:       Number(process.env.JUDGE_BLAME       ?? 0.70),
  jargon:      Number(process.env.JUDGE_JARGON      ?? 2.40),   // 0..3 score
};

// ⚠ MEASURED, NOT GUESSED. Two runs of this file over the identical tree, 58
// paired sentences, gave |delta| max 0.110 leak / 0.060 next / 0.050 blame /
// 0.160 jargon (p90 0.030/0.030/0.030/0.100). A regression threshold below that
// is a coin flip dressed as a gate, so each of these sits clear of its own
// measured ceiling. Re-measure before tightening any of them.
const REGRESSION = {
  leak:   Number(process.env.JUDGE_D_LEAK   ?? 0.20),
  next:   Number(process.env.JUDGE_D_NEXT   ?? 0.20),
  blame:  Number(process.env.JUDGE_D_BLAME  ?? 0.20),
  jargon: Number(process.env.JUDGE_D_JARGON ?? 0.35),
};
const BASELINE_PATH = process.env.JUDGE_BASELINE || 'tools/netplay_message_baseline.json';
const WRITE_BASELINE = process.argv.includes('--baseline');

// ---- the corpus ------------------------------------------------------------
// Every call that puts words in front of a player. pageLog() is deliberately
// NOT here: it is the developer log, and the pages route raw engine text there
// on purpose.
const FILES = ['dreamcast.html', 'n64/index.html', 'gamecube.html', 'genesis.html',
               'snes.html', 'ps1.html', 'multiplayer.html', 'lib/netplay-ui.js'];
const CALL = /(?:setMsg|netStatus|setStatus|banner)\(/g;

// ⚠ THE WHOLE SENTENCE, NOT ITS FIRST LITERAL. A first cut matched one string
// literal per call and judged "Playing — everyone started together at frame",
// which no player ever sees: the rest of that sentence is concatenated on. A
// judgement of a fragment is a judgement of nothing, and it scored the dangling
// "frame" as a leaked internal value. So the argument is read to its balanced
// closing paren, every literal in it is joined, and each interpolated
// expression becomes <value> — which is what the reader gets: a sentence with a
// filled-in blank.
function argText(src, open) {
  // Returns the sentence a player sees, with each interpolated expression
  // replaced by <value N>, AND the source of those expressions.
  //
  // ⚠ THE BLANK IS NOT SELF-EXPLANATORY, AND THAT MATTERS TO THE JUDGEMENT.
  // A first cut passed only "<value>" and every message ending in ": <value>"
  // scored 0.65-0.78 for leaking an internal id — because from the sentence
  // alone there is no way to tell `p.code` (a room code the player was given)
  // from `String(err)` (a raw exception). Handing over the expression source
  // with the sentence is what lets that question be answered instead of guessed.
  let i = open, depth = 0, out = '', lit = null, esc = false, expr = '';
  const blanks = [];
  const flushExpr = () => {
    const e = expr.trim();
    expr = '';
    if (!e) return;
    blanks.push(e);
    out += `<value ${blanks.length}>`;
  };
  for (; i < src.length && i < open + 1600; i++) {
    const c = src[i];
    if (lit) {
      if (esc) { out += c === 'n' ? ' ' : c; esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === lit) { lit = null; continue; }
      out += c; continue;
    }
    if (c === '\'' || c === '"' || c === '`') { flushExpr(); lit = c; continue; }
    if (c === '(') { depth++; if (depth > 1) expr += c; continue; }
    if (c === ')') { depth--; if (depth === 0) break; expr += c; continue; }
    if (c === ',' && depth === 1) break;              // second argument: the class
    if (c === '+' && depth === 1) { flushExpr(); continue; }
    if (depth >= 1) expr += c;
  }
  flushExpr();
  return { text: out.replace(/\s+/g, ' ').trim(), blanks };
}

function corpus() {
  const seen = new Map();
  for (const f of FILES) {
    if (!existsSync(f)) continue;
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(CALL)) {
      const { text, blanks } = argText(src, m.index + m[0].length - 1);
      if (text.replace(/<value \d+>/g, '').trim().length < 26) continue;   // nothing to judge
      if (/^<value 1>/.test(text)) continue;          // a sentence built somewhere else entirely
      if (!seen.has(text)) seen.set(text, { file: f, blanks });
    }
  }
  return [...seen].map(([text, v]) => ({ text, file: v.file, blanks: v.blanks }));
}

// ---- the judgement ---------------------------------------------------------
const QUESTIONS = {
  // The nonce class. n64/index.html:3247 repairs ONE known shape by hand; this
  // asks the general question of every sentence on every page.
  leaks_an_internal_identifier: {
    type: 'noul',
    instructions:
      'Does this message put a value in front of the reader that only means something to the ' +
      'people who wrote the software - a hexadecimal id, a session nonce, a peer id, an internal ' +
      'error code, a frame number, a zero-based port index, a file path, a raw exception or a ' +
      'field name? Judge each <value N> by the code that fills it, given in ' +
      '`what_fills_each_blank`: a room code or a game title is fine, a caught exception or a URL ' +
      'is not.',
    criteria: {
      true: 'Some token in the message is meaningless to a player and identifies an internal object.',
      false: 'Every value shown is one a player can recognise: a room code they were given, a ' +
             'player or seat named the way the game names it, a game title, a percentage, a count.',
    },
  },
  // The frozen-screen class: "Waiting for someone to join..." forever.
  tells_the_reader_what_happens_next: {
    type: 'noul',
    instructions:
      'After reading this message, does the reader know what happens next - either something they ' +
      'can do, or what the software will do by itself without them?',
    criteria: {
      true: 'It names an action the reader can take, or states what the system is doing and what ' +
            'will end the wait.',
      false: 'It reports a condition and stops. The reader is left watching it with nothing to do ' +
             'and no idea what would change it.',
    },
  },
  blames_the_player_or_their_device: {
    type: 'noul',
    instructions:
      'Does this message read as though the reader, their device, or their connection is at fault?',
    criteria: {
      true: 'It attributes the problem to the reader or their equipment, or reads as a reprimand.',
      false: 'It describes the situation without assigning fault to the reader, even when their ' +
             'device genuinely cannot do the thing.',
    },
  },
  technical_knowledge_needed: {
    type: 'score',
    instructions:
      'How much technical knowledge does a reader need to understand this message? The reader is ' +
      'someone who wants to play a console game with a friend in a browser, not a programmer.',
    criteria: [
      'Plain language throughout. Anyone who plays games understands it.',
      'One term a player might not know, but the sentence still lands without it.',
      'Several terms from emulation, networking or the codebase; a player gets the gist at best.',
      'Written for whoever wrote the code: engine internals, protocol names, or field names carry the meaning.',
    ],
  },
};

// ---- ARM B: the sentence against the state it was shown in -----------------
// The corpus arm above judges a sentence on its own terms. It cannot ask the
// question that produced 24ee7ffc ("the page told a player their emulator had
// stopped while it was running fine"), because that defect is not visible in the
// sentence — only in the sentence NEXT TO the state. So this arm reads pairs a
// room rig actually captured (tools/console_room_crossdevice_test.mjs writes
// them to /tmp/console-xdev/xdev.json) and asks whether the words match the room.
//
// It also generalises ONE hand-written cell. `a-stall-fail-never-shows-a-nonce`
// greps the rendered sentence for a 16-hex peer id, because that is the leak
// shape somebody already hit (n64/index.html:3247 "NEVER A NONCE, PART TWO").
// A grep for one shape cannot see the next one; this asks whether ANYTHING the
// engine said survived into the sentence that a player cannot use.
const PAIR_QUESTIONS = {
  // ⚠ CONTRADICTION, NOT TRUTH — and the first cut got this wrong.
  // Asking "is the sentence a true description of `room_state`?" returned 0.43
  // to 0.63 on all twelve captured pairs, and a Noul near 0.5 is the model
  // saying the question is unanswerable from what it was given, not that the
  // sentences are half true. It WAS unanswerable: a seat list cannot confirm
  // "everyone started together at frame 0", and the stall pairs carry no seats
  // at all. Contradiction is decidable from the same state, and it is the half
  // that matters — 24ee7ffc was a page saying the emulator had STOPPED while it
  // was running fine, which is a contradiction the seats do show.
  sentence_contradicts_the_state: {
    type: 'noul',
    instructions:
      'Does `sentence_shown` say something that `room_state` shows to be false - a different phase ' +
      'of the room, a different number of players, a problem the state does not show, or a wait for ' +
      'somebody who is already there? Judge only what the state settles; do not treat a detail the ' +
      'state is silent about as a contradiction.',
    criteria: {
      true: 'The state settles the point and the sentence gets it wrong.',
      false: 'Nothing in the sentence is contradicted by the state, including where the state simply ' +
             'does not say.',
    },
  },
  sentence_carries_engine_text_a_player_cannot_use: {
    type: 'noul',
    instructions:
      'The engine\'s own wording is in `engine_text` when the rig captured it. Did anything survive ' +
      'into `sentence_shown` that identifies an internal object rather than something the player ' +
      'knows - a peer id, a nonce, a hex string, a protocol message name, a field name?',
    criteria: {
      true: 'Some token in the sentence is engine vocabulary or an internal identifier.',
      false: 'Everything in the sentence names something the player can see: a seat, a player, the ' +
             'room code, a game, a count.',
    },
  },
};

// The rig writes prose details. These two shapes are the ones it emits, and a
// pair that does not match them is SKIPPED rather than guessed at.
function pairsFrom(file) {
  const j = JSON.parse(readFileSync(file, 'utf8'));
  const out = [];
  for (const c of j.cells || []) {
    const d = String(c.detail || '');
    for (const m of d.matchAll(/button "([^"]+)", sentence "([^"]+)", rows \[([^\]]*)\]/g)) {
      out.push({ arm: c.arm, cell: c.name, button: m[1], sentence: m[2],
                 rows: m[3].split(',').map((x) => x.trim().replace(/^"|"$/g, '')) });
    }
    for (const m of d.matchAll(/engine "([^"]+)"[^-]*-> sentence "([^"]+)"/g)) {
      out.push({ arm: c.arm, cell: c.name, engine: m[1], sentence: m[2] });
    }
  }
  // Same sentence in the same state, captured on four arms, is one judgement.
  const seen = new Map();
  for (const p of out) {
    const k = [p.sentence, p.button || '', (p.rows || []).join('|'), p.engine || ''].join('\u0000');
    if (!seen.has(k)) seen.set(k, p);
  }
  return [...seen.values()];
}

async function ask(state, questions, apiKey) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ state, model: MODEL, questions }),
  });
  if (!res.ok) throw new Error(`http_${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
  return res.json();
}

// Bounded concurrency. Serial would be slow, unbounded would hammer the service
// and make the run's own latency meaningless.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) { const k = i++; if (k >= items.length) return; out[k] = await fn(items[k], k); }
  }));
  return out;
}

const apiKey = process.env.TYPESAFE_API_KEY;
if (!apiKey) {
  console.error('[message-judge] no TYPESAFE_API_KEY — refusing to report a pass without judging anything');
  process.exit(2);
}
const items = corpus();
if (!items.length) {
  console.error('[message-judge] harvested zero sentences — the extractor is blind, which is not a pass');
  process.exit(2);
}

console.log(`[message-judge] ${items.length} player-facing sentence(s) from ${FILES.length} file(s), model ${MODEL}\n`);

const judged = await mapLimit(items, CONCURRENCY, async (it) => {
  const state = {
    message_shown_to_the_player: it.text,
    what_fills_each_blank: it.blanks.length
      ? it.blanks.map((b, n) => `<value ${n + 1}> = the value of this code: ${b}`)
      : 'nothing — the message has no blanks',
    where_it_appears: it.file,
    product:
      'A website that runs console emulators in the browser. Several people play the same game ' +
      'together: each runs their own emulator and only controller input crosses the network. ' +
      'This message appears in that page\'s room panel or status line.',
    who_reads_it: 'A player. They came to play a game with a friend; they did not come to debug software.',
  };
  try {
    const r = await ask(state, QUESTIONS, apiKey);
    return { ...it, a: r.answers, usage: r.usage };
  } catch (e) {
    return { ...it, error: String(e.message || e) };
  }
});

const errs = judged.filter((j) => j.error);
const okJ = judged.filter((j) => !j.error);
const val = (j, k) => (j.a?.[k]?.noul ?? j.a?.[k]?.score ?? null);

// Raw judgments out FIRST, so a threshold argument never needs another run.
writeFileSync(OUT, JSON.stringify({ when: new Date().toISOString(), model: MODEL, policy: POLICY,
  judged: okJ.map((j) => ({ file: j.file, text: j.text,
    leak: val(j, 'leaks_an_internal_identifier'),
    next: val(j, 'tells_the_reader_what_happens_next'),
    blame: val(j, 'blames_the_player_or_their_device'),
    jargon: val(j, 'technical_knowledge_needed') })), errors: errs }, null, 1));

const rows = okJ.map((j) => ({
  file: j.file, text: j.text,
  leak: val(j, 'leaks_an_internal_identifier'),
  next: val(j, 'tells_the_reader_what_happens_next'),
  blame: val(j, 'blames_the_player_or_their_device'),
  jargon: val(j, 'technical_knowledge_needed'),
})).sort((a, b) => (b.leak + (1 - b.next) + b.blame + b.jargon / 3) - (a.leak + (1 - a.next) + a.blame + a.jargon / 3));

const f2 = (n) => (n == null ? ' -- ' : n.toFixed(2));
console.log('  leak  next  blame  jargon   sentence');
for (const r of rows) {
  console.log(`  ${f2(r.leak)}  ${f2(r.next)}  ${f2(r.blame)}   ${f2(r.jargon)}   ${r.text.slice(0, 96)}${r.text.length > 96 ? '…' : ''}`);
}

const flagged = rows.map((r) => {
  const why = [];
  if (r.leak != null && r.leak >= POLICY.leak) why.push(`leaks_an_internal_identifier=${f2(r.leak)} >= ${POLICY.leak}`);
  if (r.next != null && r.next <= POLICY.noNextStep) why.push(`tells_the_reader_what_happens_next=${f2(r.next)} <= ${POLICY.noNextStep}`);
  if (r.blame != null && r.blame >= POLICY.blame) why.push(`blames_the_player_or_their_device=${f2(r.blame)} >= ${POLICY.blame}`);
  if (r.jargon != null && r.jargon >= POLICY.jargon) why.push(`technical_knowledge_needed=${f2(r.jargon)} >= ${POLICY.jargon}`);
  return why.length ? { ...r, why } : null;
}).filter(Boolean);

console.log(`\n[message-judge] ${okJ.length} judged, ${errs.length} error(s), ${flagged.length} over policy · raw -> ${OUT}`);
for (const f of flagged) console.log(`\n  FLAG  ${f.file}\n        "${f.text}"\n        ${f.why.join('; ')}`);
if (errs.length) for (const e of errs) console.log(`\n  ERROR ${e.file}: ${e.error}`);

// ---- arm B runs when a rig capture is handed to it --------------------------
let pairBad = 0;
if (PAIRS) {
  if (!existsSync(PAIRS)) {
    console.log(`\n[message-judge] --pairs ${PAIRS} does not exist — run a room rig first. Not a pass.`);
    process.exit(2);
  }
  const pairs = pairsFrom(PAIRS);
  console.log(`\n[message-judge] arm B: ${pairs.length} captured (state, sentence) pair(s) from ${PAIRS}`);
  if (!pairs.length) {
    console.log('  none matched the shapes this file knows how to read — that is a blind extractor, not a pass.');
    process.exit(2);
  }
  const pj = await mapLimit(pairs, CONCURRENCY, async (pr) => {
    const state = {
      room_state: {
        party_control_label: pr.button || null,
        seats: pr.rows || null,
        engine_text: pr.engine || null,
      },
      sentence_shown: pr.sentence,
      product: 'Several people each run their own emulator of the same console game, in lockstep. ' +
               'The party panel shows one sentence describing where the room is.',
      seat_notation: 'A seat reads "<who>:<state>". "open:open" is an empty seat. "host" is the ' +
                     'player who opened the room; the others are player 2, player 3 and so on.',
    };
    try { const r = await ask(state, PAIR_QUESTIONS, apiKey); return { ...pr, a: r.answers }; }
    catch (e) { return { ...pr, error: String(e.message || e) }; }
  });
  for (const r of pj) {
    if (r.error) { console.log(`  ERROR ${r.cell}: ${r.error}`); pairBad++; continue; }
    const match = r.a.sentence_contradicts_the_state?.noul;
    const leak = r.a.sentence_carries_engine_text_a_player_cannot_use?.noul;
    const why = [];
    if (match != null && match >= 0.70) why.push(`contradicts the state (${f2(match)})`);
    if (leak != null && leak >= 0.70) why.push(`carries engine text (${f2(leak)})`);
    const tag = why.length ? 'FLAG ' : 'ok   ';
    console.log(`  ${tag} contradicts=${f2(match)} leak=${f2(leak)}  [${r.cell}] "${r.sentence.slice(0, 84)}"`);
    if (r.engine) console.log(`         engine said: "${r.engine}"`);
    if (why.length) { console.log(`         ${why.join('; ')}`); pairBad++; }
  }
}

if (REPORT_ONLY) { console.log('\n(--report: distribution printed, no verdict)'); process.exit(0); }

// ---- the gate --------------------------------------------------------------
// A repo with existing debt cannot be gated on an absolute threshold without
// printing 29 flags on day one, which trains everyone to ignore it — the exact
// failure this session already found in a permanently-red audit row. So the
// verdict is a RATCHET: today's judgements are the baseline, and what fails is
// a sentence that is NEW and over policy, or one that got WORSE than its
// recorded score by more than the measured run-to-run noise. Existing debt is
// printed every run, in rank order, and never blocks.
const snapshot = Object.fromEntries(rows.map((r) => [r.text, { file: r.file, leak: r.leak, next: r.next, blame: r.blame, jargon: r.jargon }]));
if (WRITE_BASELINE) {
  writeFileSync(BASELINE_PATH, JSON.stringify({ when: new Date().toISOString(), model: MODEL, policy: POLICY,
    regression: REGRESSION, note: 'ratchet baseline — see the header of tools/netplay_message_judge.mjs', snapshot }, null, 1) + '\n');
  console.log(`\n[message-judge] baseline written -> ${BASELINE_PATH} (${rows.length} sentences)`);
  process.exit(0);
}

if (!existsSync(BASELINE_PATH)) {
  console.log(`\n[message-judge] no baseline at ${BASELINE_PATH} — run with --baseline once to record one. Not a pass.`);
  process.exit(2);
}
const base = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')).snapshot || {};
const regressions = [];
for (const r of rows) {
  const b = base[r.text];
  if (!b) {
    const why = (flagged.find((f) => f.text === r.text) || {}).why;
    if (why) regressions.push({ ...r, kind: 'NEW', why });
    continue;
  }
  const why = [];
  if (r.leak != null && b.leak != null && r.leak - b.leak > REGRESSION.leak) why.push(`leak ${f2(b.leak)} -> ${f2(r.leak)}`);
  if (r.next != null && b.next != null && b.next - r.next > REGRESSION.next) why.push(`next-step ${f2(b.next)} -> ${f2(r.next)}`);
  if (r.blame != null && b.blame != null && r.blame - b.blame > REGRESSION.blame) why.push(`blame ${f2(b.blame)} -> ${f2(r.blame)}`);
  if (r.jargon != null && b.jargon != null && r.jargon - b.jargon > REGRESSION.jargon) why.push(`jargon ${f2(b.jargon)} -> ${f2(r.jargon)}`);
  if (why.length) regressions.push({ ...r, kind: 'WORSE', why });
}
console.log(`\n[message-judge] ratchet: ${Object.keys(base).length} baselined · ${regressions.length} new-or-worse · ${flagged.length} standing (reported, not gated)`);
for (const r of regressions) console.log(`\n  ${r.kind}  ${r.file}\n        "${r.text.slice(0, 150)}"\n        ${r.why.join('; ')}`);
process.exit(regressions.length || errs.length || pairBad ? 1 : 0);

#!/usr/bin/env node
// TypeSafe System One judge for claim discipline (CLAUDE.md gate #6).
//
// WHY THIS EXISTS
//   .claude/hooks/claim_discipline.sh states its own limit in its header:
//   "a command hook cannot judge truth ... Checks only that SOME citation or
//   hedge marker is present". Its DISCIPLINE grep is a whole-turn early-exit,
//   so ONE hedge word anywhere exempts every other claim in the response.
//   This module asks a per-claim semantic question instead.
//
// WHAT IT IS NOT
//   Not a truth oracle. It judges whether a claim is ACCOMPANIED BY evidence,
//   not whether the claim is correct. Per TypeSafe's own docs: "Typed output
//   guarantees the interface, not truth."
//
// CONTRACT  POST https://api.typesafe.ai/v1/systemone
//   Authorization: Bearer $TYPESAFE_API_KEY
// NOTE: docs/api.md specifies top-level `model: "jev-latest"`; the noul
//   primitive page's example instead shows `selectedModels: ["jev-latest"]`.
//   We send `model` per the API reference. If the service answers 422 on the
//   model field, swap MODEL_FIELD below — that is the whole fix.

const API_URL = process.env.TYPESAFE_API_URL || "https://api.typesafe.ai/v1/systemone";
const MODEL = process.env.TYPESAFE_MODEL || "jev-latest";
const MODEL_FIELD = process.env.TYPESAFE_MODEL_FIELD || "model"; // or "selectedModels"
const TIMEOUT_MS = Number(process.env.TYPESAFE_TIMEOUT_MS || 12000);

// Policy thresholds. Raw judgments stay reusable; only these change behavior,
// so retuning does NOT require re-running inference.
export const POLICY = {
  bareClaimBlock:   Number(process.env.TS_BARE_CLAIM_BLOCK   ?? 0.70),
  bareClaimReview:  Number(process.env.TS_BARE_CLAIM_REVIEW  ?? 0.45),
  perfNumberBlock:  Number(process.env.TS_PERF_NUMBER_BLOCK  ?? 0.70),
  deferralBlock:    Number(process.env.TS_DEFERRAL_BLOCK     ?? 0.70),
  severityEscalate: Number(process.env.TS_SEVERITY_ESCALATE  ?? 2.0),
};

// One request, independent questions answered in parallel. They cannot see
// one another's answers, which is fine: none depends on another's result.
export function buildPayload(assistantMessage) {
  return {
    state: {
      assistant_message: assistantMessage,
      domain:
        "A WebAssembly retro-emulator repository. Factual claims here concern " +
        "repository file contents, build/link state, emulator runtime behavior, " +
        "probe-log observations, and performance measurements.",
      what_counts_as_evidence:
        "A file:line reference, a log path plus the grep or line read from it, " +
        "verbatim tool output quoted in the message, or a named build/probe run. " +
        "Evidence must come from the conversation itself, not from recollection.",
    },
    [MODEL_FIELD]: MODEL_FIELD === "selectedModels" ? [MODEL] : MODEL,
    questions: {
      // THE CORE JUDGMENT: per-claim, not per-turn. This is the hole in the
      // regex version — there, one hedge anywhere exempts everything.
      bare_claim: {
        type: "noul",
        instructions:
          "Does the message state at least one specific factual claim about repository " +
          "contents, build state, runtime behavior, or a diagnostic conclusion as settled " +
          "fact, where that particular claim carries neither supporting evidence nor an " +
          "explicit hedge? Judge each claim on its own. Evidence or hedging attached to a " +
          "different sentence does not excuse an unsupported one.",
        criteria: {
          true:
            "At least one claim is asserted flatly and is not itself cited or hedged, even " +
            "if other claims in the same message are properly supported.",
          false:
            "Every factual claim about repo or runtime state either carries its own evidence " +
            "or is explicitly marked as unverified, uncertain, or an inference. Messages that " +
            "make no such factual claim also belong here.",
        },
      },

      // Gates #8/#10/#11/#12: a rate without provenance has repeatedly been wrong.
      uncited_measurement: {
        type: "noul",
        instructions:
          "Does the message report a performance measurement - a rate, ratio, percentage, " +
          "frame count, clock speed, or speedup factor - without identifying the run, log " +
          "file, or build binary that produced it?",
        criteria: {
          true:
            "A number describing performance appears with no named source run, log path, or " +
            "build identity a reader could go check.",
          false:
            "Every performance figure names its provenance, or the message reports no " +
            "performance figures at all.",
        },
      },

      // Semantic counterpart to no_time_no_defer.sh's deferral patterns.
      // Narrowed after calibration: the bundled version (asking / menu / announcing
      // intent / diagnose-and-stop) scored 0.87 on a neutral acknowledgement. This
      // asks ONE thing - is the decision being handed back - and separated the menu
      // case at 0.98 from every other turn at 0.04-0.11.
      defers_instead_of_acting: {
        type: "noul",
        instructions:
          "Does the message ask the user to choose, approve, or direct what happens next, " +
          "rather than continuing the work itself?",
        criteria: {
          true:
            "It poses a question about what to do, lists options for the user to pick from, " +
            "or waits for approval before proceeding.",
          false:
            "It proceeds under its own judgment, reports work already carried out, or names " +
            "a concrete blocker only the user can clear.",
        },
      },

      // Severity gates whether a borderline bare claim is worth blocking over.
      claim_severity: {
        type: "score",
        instructions:
          "If the unsupported claims in this message turned out to be wrong, how much wasted " +
          "work would follow?",
        criteria: [
            "No factual claims about repo or runtime state, or every claim is properly sourced.",
            "A minor descriptive detail is unsupported; being wrong would cost a quick re-read.",
            "A diagnostic conclusion or a measurement is unsupported; being wrong would send " +
              "the next several build-and-probe iterations down a false path.",
            "An unsupported claim contradicts a documented finding or declares a root cause, " +
              "a completion, or an impossibility; being wrong would discard correct work or " +
              "restart a solved investigation.",
        ],
      },
    },
  };
}

export async function judge(assistantMessage, { apiKey = process.env.TYPESAFE_API_KEY } = {}) {
  if (!apiKey) return { ok: false, reason: "no_api_key" };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(buildPayload(assistantMessage)),
      signal: ac.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, reason: `http_${res.status}`, detail: body.slice(0, 400) };
    }
    return { ok: true, response: await res.json() };
  } catch (err) {
    return { ok: false, reason: err.name === "AbortError" ? "timeout" : "network", detail: String(err) };
  } finally {
    clearTimeout(timer);
  }
}

// Policy layer: raw probabilities in, one verdict out. Deterministic given the
// probabilities, which is what lets the hook relay a machine verdict verbatim.
export function decide(answers) {
  const p = (k) => answers?.[k]?.noul ?? null;
  const bare = p("bare_claim");
  const perf = p("uncited_measurement");
  const defer = p("defers_instead_of_acting");
  const sev = answers?.claim_severity?.score ?? null;

  const reasons = [];
  if (bare !== null && bare >= POLICY.bareClaimBlock)
    reasons.push(`bare_claim=${bare.toFixed(2)} >= ${POLICY.bareClaimBlock}`);
  else if (bare !== null && bare >= POLICY.bareClaimReview && sev !== null && sev >= POLICY.severityEscalate)
    reasons.push(`bare_claim=${bare.toFixed(2)} >= ${POLICY.bareClaimReview} with severity=${sev} >= ${POLICY.severityEscalate}`);
  if (perf !== null && perf >= POLICY.perfNumberBlock)
    reasons.push(`uncited_measurement=${perf.toFixed(2)} >= ${POLICY.perfNumberBlock}`);
  if (defer !== null && defer >= POLICY.deferralBlock)
    reasons.push(`defers_instead_of_acting=${defer.toFixed(2)} >= ${POLICY.deferralBlock}`);

  return { block: reasons.length > 0, reasons, raw: { bare, perf, defer, sev } };
}

// ---- CLI -------------------------------------------------------------------
// stdin: raw assistant text.  stdout: JSON verdict.  Never throws.
if (import.meta.url === `file://${process.argv[1]}`) {
  const dryRun = process.argv.includes("--dry-run");
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const text = Buffer.concat(chunks).toString("utf8");

  if (dryRun) {
    console.log(JSON.stringify(buildPayload(text), null, 2));
    process.exit(0);
  }

  const out = await judge(text);
  if (!out.ok) {
    console.log(JSON.stringify({ available: false, ...out }));
    process.exit(0); // fail open, always
  }
  const verdict = decide(out.response.answers);
  console.log(JSON.stringify({ available: true, ...verdict, usage: out.response.usage }));
}

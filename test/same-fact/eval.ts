/**
 * Same-fact eval harness — measures the curation pipeline against the hand
 * labels in `docs/hand-labels.json`, on a frozen fixture DB.
 *
 *   ~/.bun/bin/bun test/same-fact/eval.ts --fixture <db> [--model m] [--votes 3] [--style sharpened] [--tag run1]
 *
 * Build the fixture first: `bun test/same-fact/make-fixture.ts --out <db>`.
 *
 * TWO AXES, DELIBERATELY SEPARATE
 *
 *   (A) PAIR-FINDER RECALL — free. Cosine over the fixture's own vectors: how
 *       many of the hand-labelled pairs does the candidate gate even SURFACE at
 *       the threshold curate.ts uses? A true pair below the threshold is not a
 *       judge error, it is a pair the pipeline never asks about, and no better
 *       model can fix it. Measuring this costs zero model calls, which is why
 *       it must not be lumped in with (B).
 *
 *   (B) JUDGE ACCURACY — the expensive axis. Claims are extracted (batched 12
 *       per call, cached), then every labelled pair is put through the real
 *       `judgePairs` from adjudicate.ts — not a reimplementation, so the
 *       numbers describe the code that actually runs.
 *
 * WHAT IS SCORED
 *
 * F1/P/R come from the 61 pairs labelled `same` or `diff`. The 11 `ambig`
 * pairs are reported as a DISTRIBUTION of what the model said — they are a
 * calibration signal (where the model and the human disagree about whether the
 * question is even settled), not a grade. Dropping them would hide exactly the
 * cases worth looking at.
 *
 * A pair the model never answered scores as no-relation, same as a DIFF verdict
 * for recall purposes — that is the real behaviour (`curate.ts` writes nothing)
 * — and the count is printed separately so a silent drop is visible.
 *
 * NOT DETERMINISTIC BY CONSTRUCTION
 *
 * The judge runs at temperature 0.2 with no seed, so two runs of the same
 * config can disagree. Run the SAME config twice before comparing two models,
 * otherwise a model difference and the noise floor are indistinguishable.
 */

import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import type { Claim } from "../../adjudicate.ts";

const argv = process.argv.slice(2);
const flag = (name: string, dflt?: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
};

// A pinned --model must mean that model or nothing. adjudicate.ts reads its
// fallback chain once at import, so the env has to be set BEFORE the import —
// hence the dynamic import below. Without this, a 402 on the pinned model
// silently answers from `auto` and the record still says the pinned model.
const PINNED = flag("model");
if (PINNED) process.env.ADJUDICATE_FALLBACK_MODELS = PINNED;
const { extractClaims, judgePairs, pairKey } = await import("../../adjudicate.ts");
const TRACE = process.env.ADJUDICATE_TRACE;
const traceStart = TRACE && existsSync(TRACE) ? readFileSync(TRACE, "utf8").split("\n").filter(Boolean).length : 0;

const HERE = import.meta.dir;
const LABEL_FILE = resolve(HERE, "../../docs/hand-labels.json");
const FIXTURE = flag("fixture") ?? resolve(HERE, "same-fact.fixture.db");
const MODEL = PINNED ?? "hyper/glm-5.3-flash";
const VOTES = Number(flag("votes", "3"));
const STYLE = flag("style", "sharpened");
const TAG = flag("tag", "run");
const THRESHOLD = Number(flag("threshold", "0.78"));
const OUT = flag("out", resolve(HERE, `../..`, `.hermes-eval/${TAG}.jsonl`))!;

// ---------- inputs ----------

const rawLabels = JSON.parse(readFileSync(LABEL_FILE, "utf8")) as {
  labels: [number, number, "same" | "diff" | "ambig"][];
};
const db = new Database(FIXTURE, { readonly: true });
const text = new Map<number, string>(
  (db.query("SELECT id, text FROM memories").all() as { id: number; text: string }[]).map((r) => [
    r.id,
    r.text,
  ]),
);
const vec = new Map<number, Float32Array>();
for (const r of db.query("SELECT memory_id, vec FROM embeddings").all() as {
  memory_id: number;
  vec: Uint8Array;
}[]) {
  vec.set(r.memory_id, new Float32Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength / 4));
}

const missing = rawLabels.labels.flatMap(([a, b]) => [a, b]).filter((id) => !text.has(id));
if (missing.length) throw new Error(`fixture is missing label ids: ${[...new Set(missing)]}`);

const cos = (a: number, b: number): number => {
  const x = vec.get(a);
  const y = vec.get(b);
  if (!x || !y) return 0;
  let d = 0;
  let nx = 0;
  let ny = 0;
  for (let i = 0; i < x.length; i++) {
    d += x[i] * y[i];
    nx += x[i] * x[i];
    ny += y[i] * y[i];
  }
  return d / (Math.sqrt(nx) * Math.sqrt(ny) || 1);
};

// ---------- (A) pair-finder recall, no model calls ----------

const byLabel = (l: string) => rawLabels.labels.filter(([, , x]) => x === l);
const sweep = [0.6, 0.7, 0.75, 0.78, 0.8, 0.85, 0.9];
const shown = byLabel("same").length;
console.log(`(A) pair finder — cosine over fixture vectors, ${rawLabels.labels.length} labelled pairs`);
console.log(`    threshold sweep (same / diff pairs with cos >= t):`);
for (const t of sweep) {
  const s = byLabel("same").filter(([a, b]) => cos(a, b) >= t).length;
  const d = byLabel("diff").filter(([a, b]) => cos(a, b) >= t).length;
  console.log(`      t=${t.toFixed(2)}  same ${s}/${shown}  diff ${d}/${byLabel("diff").length}`);
}
const blind = byLabel("same")
  .map(([a, b]) => ({ a, b, c: cos(a, b) }))
  .filter((p) => p.c < THRESHOLD)
  .sort((x, y) => x.c - y.c);
console.log(
  `    at t=${THRESHOLD} (curate.ts default): ${blind.length} of ${shown} SAME pairs are never candidates` +
    (blind.length ? ` -> ${blind.map((p) => `${p.a}:${p.b}@${p.c.toFixed(3)}`).join(", ")}` : ""),
);
const precision = byLabel("diff").filter(([a, b]) => cos(a, b) >= THRESHOLD).length;
console.log(
  `    candidate pool at t=${THRESHOLD}: ${precision + (shown - blind.length)} pairs ` +
    `(${precision} of them are labelled diff — the judge's job)`,
);

// ---------- (B) judge accuracy ----------

const ids = [...new Set(rawLabels.labels.flatMap(([a, b]) => [a, b]))];
console.log(`\n(B) judge — model ${MODEL} · style ${STYLE} · votes ${VOTES} · ${ids.length} claims`);

const claims = await extractClaims(
  ids.map((id) => ({ id, text: text.get(id) ?? "" })),
  MODEL,
);
if (!claims?.length) throw new Error("claim extraction returned nothing");
const byId = new Map<number, Claim>(claims.map((c) => [c.id, c]));
const noClaim = ids.filter((id) => !byId.has(id));
if (noClaim.length) console.log(`    note: no claim extracted for ${noClaim.length} ids: ${noClaim.join(",")}`);

// deterministic order: same input twice must build the same prompts
const pairs = [...rawLabels.labels]
  .sort(([a1, b1], [a2, b2]) => pairKey(a1, b1).localeCompare(pairKey(a2, b2)))
  .map(([a, b]) => ({ aId: a, bId: b, a: byId.get(a)!, b: byId.get(b)! }))
  .filter((p) => p.a && p.b);

const verdicts = await judgePairs(pairs, MODEL, VOTES, STYLE as never);
if (!verdicts) throw new Error("judgePairs failed (see [adjudicate] logs)");

type Outcome = "SAME" | "DIFF" | "NONE";
const outcomeOf = (a: number, b: number): Outcome => {
  const v = verdicts.get(pairKey(a, b));
  return !v ? "NONE" : v.same ? "SAME" : "DIFF";
};

let tp = 0;
let fp = 0;
let fn = 0;
let tn = 0;
const disagreements: string[] = [];
const rows: Record<string, unknown>[] = [];
for (const [a, b, label] of rawLabels.labels) {
  const got = outcomeOf(a, b);
  const c = cos(a, b);
  rows.push({ a, b, label, got, cos: Number(c.toFixed(4)), candidate: c >= THRESHOLD });
  if (label === "same") {
    if (got === "SAME") tp++;
    else fn++;
  } else if (label === "diff") {
    if (got === "SAME") fp++;
    else tn++;
  }
  if (label !== "ambig") {
    const agrees = (label === "same" && got === "SAME") || (label === "diff" && got === "DIFF");
    if (!agrees) disagreements.push(`${a}:${b} label=${label} model=${got} cos=${c.toFixed(3)}`);
  }
}
const p = tp + fp ? tp / (tp + fp) : 0;
const r = tp + fn ? tp / (tp + fn) : 0;
const f1 = p + r ? (2 * p * r) / (p + r) : 0;
const none = rawLabels.labels.filter(([a, b]) => outcomeOf(a, b) === "NONE").length;

console.log(`\n    scorable (61): TP ${tp}  FP ${fp}  FN ${fn}  TN ${tn}`);
console.log(`    precision ${(p * 100).toFixed(1)}%  recall ${(r * 100).toFixed(1)}%  F1 ${f1.toFixed(2)}`);
console.log(`    no verdict from any vote: ${none} pairs (counted as no-relation)`);
const ambigDist = (["SAME", "DIFF", "NONE"] as Outcome[]).map((o) => ({
  o,
  n: byLabel("ambig").filter(([a, b]) => outcomeOf(a, b) === o).length,
}));
console.log(
  `    ambig (11, not scored): ${ambigDist.map((d) => `${d.o} ${d.n}`).join("  ")}`,
);
for (const d of disagreements) console.log(`    disagree ${d}`);

// ---------- run record ----------

// Which models actually produced a usable reply during THIS run, from the trace.
// The record must say what answered, not what was asked for.
function answeredBy(): Record<string, number> {
  const out: Record<string, number> = {};
  if (!TRACE || !existsSync(TRACE)) return out;
  const lines = readFileSync(TRACE, "utf8").split("\n").filter(Boolean).slice(traceStart);
  for (const l of lines) {
    const r = JSON.parse(l);
    if (r.http_status === 200 && r.reply) out[r.model] = (out[r.model] ?? 0) + 1;
  }
  return out;
}

const rec = {
  tag: TAG,
  ts: new Date().toISOString(),
  fixture: FIXTURE,
  model: MODEL,
  style: STYLE,
  votes: VOTES,
  threshold: THRESHOLD,
  temperature: 0.2,
  answered_by: answeredBy(),
  verdicts: rows,
  metrics: { tp, fp, fn, tn, precision: p, recall: r, f1, none, ambig: ambigDist },
};
const prev = (() => {
  try {
    return readFileSync(OUT, "utf8");
  } catch {
    return "";
  }
})();
writeFileSync(OUT, `${prev}${JSON.stringify(rec)}\n`);
console.log(`\n    run record appended -> ${OUT}`);

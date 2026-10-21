/**
 * Semantic adjudication of "is this the same fact?".
 *
 * WHY THIS EXISTS
 *
 * The recall path used to decide "these two memories state the same thing" by
 * cosine alone. Cosine measures TOPICAL similarity, not FACTUAL IDENTITY: two
 * notes about the same project that assert different things land very close
 * together. Measured on the live corpus at the 0.78 threshold:
 *
 *     67 pairs   28 same fact (collapse is right)
 *               27 different fact (collapse was WRONG)
 *               12 borderline
 *
 * and the false pairs were not the marginal ones — the swiss-redesign
 * screenshot cluster sat at 0.90-0.96, i.e. ABOVE most of the true pairs.
 * A false collapse is not cosmetic: it deletes a distinct fact from the recall
 * of every query that would have found it.
 *
 * No lexical substitute works either. Rare-token containment, IDF-weighted
 * overlap, heading skeletons, chunk-level claim coverage and whole-document vs
 * topic-claim cosine were all measured on the same 67 hand-labelled pairs and
 * all scored F1 <= 0.77 — worse than the prior of always collapsing. The
 * question is semantic, so it is answered by a model.
 *
 * TWO STAGES
 *
 *   1. CLAIM EXTRACTION — each memory is reduced once to
 *      subject / claim / artifact / time. The result is cached in the
 *      `memory_claims` table, so this cost is paid once per memory, not once
 *      per pair.
 *   2. PAIRWISE MERGE TEST — the two reduced claims are compared with a single
 *      question: would merging them into one note keep every piece of
 *      information, or would it need two separate statements?
 *
 * The merge test is what made this work. Asking "are these the same fact?"
 * scored 56% accuracy. Asking "would the merged note be one statement or
 * two?" with the same model family scored F1 0.85 (precision 0.94).
 *
 * NEVER ON THE REQUEST PATH
 *
 * A recall must be fast and must never fail because a model is down. The
 * verdicts are computed offline (see curate.ts) and stored in the
 * `supersedes` table; the recall path only ever reads that table.
 *
 * The provider is the local 9router (:20128), which is the lab's single
 * routing layer — no API key of our own, no rate limit to design around, and
 * it stays reachable when the public gateways are throttling.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";

export type Adjudication = {
  /** true = both records state the same underlying fact */
  same: boolean;
  /** short reason, kept for audit */
  reason: string;
};

export type Claim = {
  id: number;
  subject: string;
  claim: string;
  artifact: string;
  time: string;
  is_update: boolean;
};

// ---------- provider plumbing ----------

const env = (k: string) => process.env[k]?.trim();

export const ADJUDICATE_BASE = env("ADJUDICATE_BASE_URL") ?? "http://127.0.0.1:20128/v1";

/**
 * The adjudicator's model, chosen by measurement rather than by taste. Same
 * merge prompt, same claims, same 55 hand-labelled pairs of the live corpus:
 *
 *   hyper/glm-5.3-flash        precision 0.94  recall 0.77  F1 0.85   76s
 *   hyper/qwen3.8-flash        precision 0.83  recall 0.71  F1 0.77  195s
 *   ag/gemini-3.8-flash-high   precision 0.90  recall 0.64  F1 0.75  552s
 *   auto (the router's pick)    precision 0.78  recall 0.75  F1 0.76  300s
 *
 * hyper/glm-5.3-flash wins on every axis that matters and is also the
 * fastest — seven times quicker than the route "auto" happened to pick, so
 * the better model is also the cheaper one. "auto" is kept as a fallback
 * rather than as the default: letting the router choose means the verdict
 * quality changes with whatever the router is routing to that day.
 */
export const ADJUDICATE_MODEL = env("ADJUDICATE_MODEL") ?? "hyper/glm-5.3-flash";

/**
 * Fallback chain. A model provider can run out of credits or go down — the
 * hyper provider on this lab did exactly that mid-run — and the curator must
 * not silently stop producing verdicts. Each model is tried in turn until one
 * answers.
 *
 * The order matters more than it looks. "auto" is NOT a model: on this router
 * it is a lottery, and eight consecutive calls to it were served by eight
 * different free models (mistralai, cohere, qwen), while a later run of the
 * same experiment was served by gemini-3.8-flash-low. A run that falls through
 * to "auto" therefore produces verdicts from a mixture, and the same pair can
 * get a different answer on a re-run — measured: 14 to 16 of 55 pairs flipped
 * between two identical runs. So the pinned models come first and "auto" is
 * the last resort, not the second.
 */
const FALLBACK_MODELS = (
  env("ADJUDICATE_FALLBACK_MODELS") ??
  "hyper/glm-5.3-flash,hyper/qwen3.8-flash,ag/gemini-3.8-flash-high,ag/gemini-3.8-flash-low,auto",
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/** the router's own key, so minimem needs no gateway secret of its own */
function routerKey(): string | null {
  const fromEnv = env("ADJUDICATE_API_KEY") ?? env("NINEROUTER_API_KEY");
  if (fromEnv) return fromEnv;
  for (const p of [
    `${homedir()}/.9router/api-keys/opencode.key`,
    `${homedir()}/.9router/api-keys/default.key`,
  ]) {
    try {
      const k = readFileSync(p, "utf8").trim();
      if (k) return k;
    } catch {
      /* not there */
    }
  }
  return null;
}

export type ChatReply = string | null;

/**
 * One chat completion against the router. Returns null on any failure — the
 * caller treats null as "no verdict" and leaves the pair alone.
 */
/**
 * Models that have already failed during this run. A provider that answers
 * "out of credits" or "authentication failed" will not recover in the next
 * ninety seconds, so every batch after the first one would otherwise pay the
 * same failed round trip before falling through — the run got seven times
 * slower and produced the same verdicts. A failure that might be transient
 * (a timeout, a 503) is not quarantined; only a hard refusal is.
 */
const deadModels = new Set<string>();

function looksDead(status: number, body: string): boolean {
  if (status === 401 || status === 402) return true;
  return /out of credits|authentication failed|invalid_api_key|quota exceeded/i.test(body);
}

export async function chat(
  system: string,
  prompt: string,
  opts: { model?: string; maxTokens?: number; temperature?: number } = {},
): Promise<ChatReply> {
  const key = routerKey();
  if (!key) return null;
  const wanted = opts.model ?? ADJUDICATE_MODEL;
  const chain = [wanted, ...FALLBACK_MODELS].filter((m, i, a) => a.indexOf(m) === i);
  let lastError = "";
  for (const model of chain) {
    if (deadModels.has(model)) continue;
    const reply = await chatOne(model, key, system, prompt, opts);
    if (reply !== null) return reply;
    lastError = `model ${model} failed`;
  }
  console.error(`[adjudicate] every model failed (${lastError})`);
  return null;
}

async function chatOne(
  model: string,
  key: string,
  system: string,
  prompt: string,
  opts: { maxTokens?: number; temperature?: number },
): Promise<ChatReply | null> {
  try {
    const res = await fetch(`${ADJUDICATE_BASE}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ],
        temperature: opts.temperature ?? 0,
        max_tokens: opts.maxTokens ?? 1500,
      }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 200);
      console.error(`[adjudicate] ${model}: http ${res.status}: ${body}`);
      if (looksDead(res.status, body)) {
        deadModels.add(model);
        console.error(`[adjudicate] ${model} is out of service for this run — skipping it from now on`);
      }
      return null;
    }
    const raw = await res.text();
    // the router may answer with SSE chunks depending on the model
    if (raw.trimStart().startsWith("data:")) {
      let out = "";
      for (const line of raw.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") break;
        try {
          const chunk = JSON.parse(payload);
          out += chunk?.choices?.[0]?.delta?.content ?? "";
        } catch {
          /* keep going */
        }
      }
      return out || null;
    }
    let json: any;
    try {
      json = JSON.parse(raw);
    } catch {
      // the router appends "data: [DONE]" to some responses; take the first
      // complete JSON object and ignore the tail
      const s = raw.indexOf("{");
      const e = raw.lastIndexOf("}");
      try {
        json = s >= 0 && e > s ? JSON.parse(raw.slice(s, e + 1)) : null;
      } catch {
        console.error(`[adjudicate] ${model}: unparsable body: ${raw.slice(0, 200)}`);
        return null;
      }
    }
    return json?.choices?.[0]?.message?.content ?? null;
  } catch (e) {
    console.error(`[adjudicate] ${model}: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

// ---------- prompts ----------

const CLAIM_SYSTEM = `For each note, extract:
- subject: the HEADLINE topic of the note — what the note is a note ABOUT. Usually the note's title or its first heading. If the note opens with a "this supersedes an earlier note about X" preamble, the subject is the note's own topic, NOT X. Example: a note titled "Hermes Maintenance" that opens by saying it supersedes an old provider note has subject "Hermes Maintenance".
- claim: what the note ASSERTS about that subject, in one sentence.
- artifact: the concrete thing the note points at — a file path, a screen, a field name, a commit, a command. If it points at nothing specific, say "none".
- time: the date, version or state it refers to.
- is_update: true if the note reads as a later revision, correction or updated state of some earlier statement; false if it just states a fact on its own.

Answer with JSON only, one entry per note:
{"notes":[{"id":<the id shown>,"subject":"...","claim":"...","artifact":"...","time":"...","is_update":<true|false>}]}`;

export const MERGE_SYSTEM = `Two notes from a memory system, each reduced to subject / claim / artifact / time.

THE MERGE TEST. Imagine merging the two notes into ONE note that keeps every piece of information from both.

  - If the merged note would be ONE coherent statement (the second just updates, refines, corrects or restates the first) -> SAME.
  - If the merged note would have to be TWO separate statements (each carrying information the other lacks) -> DIFFERENT.

Same tracked thing, later state -> SAME. Examples:
  "Hermes upgraded to v0.22.0" + "Hermes upgraded to v0.22.2" -> SAME (one upgrade line)
  "Clerk Core 3 migration, NOT pushed" + "Clerk Core 3 migration PUSHED" -> SAME (one migration line)
  "Logfare roster cut to 4 models" + "Logfare roster live: those 4 models" -> SAME (one roster)
  "screenshot swiss-dash.png" + "screenshot swiss-tags.png" -> DIFFERENT (two screenshots)
  "migrated to Clerk Core 3" + "E2E login VERIFIED" -> DIFFERENT (migration and its test are two facts)
  "dependency upgrade" + "migration to Clerk Core 3" -> DIFFERENT
  "branch field added to D1" + "how branch is displayed in the UI" -> DIFFERENT (schema vs display)
  "opencode crashed twice" + "how to recover opencode" -> DIFFERENT (incident vs recipe)

A note about a DIFFERENT aspect of the same project is DIFFERENT, even when both mention the project. A note that records an event and a note that records a later, separate event are DIFFERENT.

Ignore dates, wording and length. Answer with JSON only:
{"verdicts":[{"pair":<int>,"same":<true|false>,"reason":"<max 20 words>"}]}`;

// ---------- stage 1: claims ----------

/** Extract the claim of many notes in one call. Returns null on failure. */
export async function extractClaims(
  notes: { id: number; text: string }[],
  model = ADJUDICATE_MODEL,
): Promise<Claim[] | null> {
  if (!notes.length) return [];
  const out = new Map<number, Claim>();

  const ask = async (batch: { id: number; text: string }[]): Promise<void> => {
    const body = batch
      .map((n) => `#${n.id}: ${n.text.replace(/\s+/g, " ").trim().slice(0, 600)}`)
      .join("\n");
    const reply = await chat(CLAIM_SYSTEM, body, { model, maxTokens: 8000 });
    if (!reply) return;
    const parsed = parseJson(reply);
    if (!parsed) return;
    const arr = Array.isArray(parsed) ? parsed : (parsed as any).notes;
    if (!Array.isArray(arr)) return;
    const want = new Set(batch.map((n) => n.id));
    for (const c of arr) {
      // models often quote the id ("id": "587"); the id must be matched to the
      // memory it came from, so coerce it rather than dropping the note
      const id = Number(c?.id);
      if (!Number.isInteger(id) || !want.has(id) || typeof c?.claim !== "string") continue;
      out.set(id, {
        id,
        subject: String(c.subject ?? ""),
        claim: String(c.claim ?? ""),
        artifact: String(c.artifact ?? ""),
        time: String(c.time ?? ""),
        is_update: Boolean(c.is_update),
      });
    }
  };

  await ask(notes);
  // A model that answered for only some notes must not silently drop the
  // rest: ask again for the missing ones, three at a time.
  const missing = notes.filter((n) => !out.has(n.id));
  for (let i = 0; i < missing.length; i += 3) {
    await ask(missing.slice(i, i + 3));
  }
  return [...out.values()];
}

// ---------- stage 2: pairwise merge test ----------

export const claimText = (c: Claim): string =>
  `subject: ${c.subject}\nclaim: ${c.claim}\nartifact: ${c.artifact}\ntime: ${c.time}`;

/**
 * Judge a batch of pairs. The result is keyed by "a:b" (order-independent) so
 * the caller can look it up without remembering which side was "a".
 *
 * VOTES
 *
 * One call is the default, and it is enough: measured on the live corpus
 * against 55 hand-labelled pairs, the merge-test prompt scores precision 0.86
 * / recall 0.68 / F1 0.76, against F1 0.51 for the old cosine rule.
 *
 * A prompt that asks the question in a more "rigorous" way — explicitly
 * symmetric, with "the same SUBJECT and the same ATTRIBUTE" and "the shared
 * project name alone is never enough" — was tried and measured WORSE here
 * (F1 0.65): it refuses the vintage pairs whose value changed, which is
 * exactly the case the feature exists for. The merge test is kept because it
 * is what was measured, not because it reads better.
 *
 * `--votes N` takes several votes and writes a relation only when every vote
 * cast said SAME. It is off by default because it costs N times the calls for
 * a gain that was not measured on this corpus.
 */
/**
 * The alternative framing, kept selectable so the head-to-head is
 * reproducible, and NOT the default because it lost it badly.
 *
 * The idea: instead of asking whether a merged note would be one statement,
 * ask what would be LOST. "If one of the notes were deleted, would
 * information exist that is ONLY in the deleted note?"
 *
 * It is a sharp-sounding test, and on a weak model it produced no false
 * collapses at all — which is exactly what made it worth measuring. Run
 * through the real pipeline it is a disaster: F1 0.29, recall 0.18. It
 * answered DIFFERENT for 59 of 67 pairs.
 *
 * The reason is that the question is vacuously DIFFERENT for a revision. Any
 * later version adds *something* — a new value, a new timestamp, a correction
 * — so "information that is ONLY in the deleted note" is almost always
 * "yes", and the test collapses nothing at all. It misses 23 of the 28
 * genuine pairs, including every one where the value changed.
 */
const DELETION_SYSTEM = `Two notes from a memory system. Each has been reduced to its subject, its claim, the concrete artifact it points at, and a time/version.

Decide SAME or DIFFERENT.

SAME = the two notes assert the same underlying fact, so that one is a rewording, a refinement, or a later correction of the other. A reader keeping only one would not miss any information from the other.

DIFFERENT = the two notes assert different facts, so that BOTH are worth keeping. This is the case when:
  - they point at DIFFERENT artifacts (different files, different screens, different fields, different commits)
  - they record DIFFERENT events or different states, even about the same subject
  - one describes a schema/field and the other describes how it is displayed
  - they are two tasks with different purposes (how to check vs how to configure)

The single best test: if one of the notes were deleted, would information exist that is ONLY in the deleted note? If yes -> DIFFERENT. If no -> SAME.

Do not be fooled by shared subject wording. Two notes about "the Portal" that record two different events are DIFFERENT. Two notes about "the copy format" that specify two different formats are DIFFERENT.

Answer with JSON only:
{"verdicts":[{"pair":<int>,"same":<true|false>,"reason":"<max 20 words>"}]}`;

export const ADJUDICATE_STYLE = env("ADJUDICATE_STYLE") ?? "merge";

const SYSTEM_FOR = (style: string) => (style === "deletion" ? DELETION_SYSTEM : MERGE_SYSTEM);

export async function judgePairs(
  pairs: { aId: number; a: Claim; bId: number; b: Claim }[],
  model = ADJUDICATE_MODEL,
  votes = 3,
  style = ADJUDICATE_STYLE,
  systemOverride?: string,
  textFor: (c: Claim) => string = claimText,
): Promise<Map<string, Adjudication> | null> {
  if (!pairs.length) return new Map();
  const out = new Map<string, Adjudication>();
  const tally = new Map<string, { same: number; diff: number; cast: number; reason: string }>();

  const ask = async (batch: typeof pairs): Promise<Set<string>> => {
    const answered = new Set<string>();
    const body = batch
      .map(
        (p, i) =>
          `PAIR ${i + 1}\n--- A (#${p.aId})\n${textFor(p.a)}\n--- B (#${p.bId})\n${textFor(p.b)}`,
      )
      .join("\n\n");
    const reply = await chat(
      systemOverride ?? SYSTEM_FOR(style),
      `Judge each of the ${batch.length} pairs independently.\n\n${body}`,
      { model, maxTokens: 4000, temperature: 0.2 },
    );
    if (!reply) return answered;
    const parsed = parseJson(reply);
    const list = Array.isArray(parsed) ? parsed : (parsed as any)?.verdicts;
    if (!Array.isArray(list)) return answered;
    for (const v of list) {
      const idx = Number(v?.pair) - 1;
      if (!Number.isInteger(idx) || idx < 0 || idx >= batch.length) continue;
      const p = batch[idx];
      const key = pairKey(p.aId, p.bId);
      const t = tally.get(key) ?? { same: 0, diff: 0, cast: 0, reason: "" };
      if (v?.same) t.same++;
      else t.diff++;
      t.cast++;
      if (!t.reason) t.reason = String(v?.reason ?? "").slice(0, 300);
      tally.set(key, t);
      answered.add(key);
    }
    return answered;
  };

  for (let v = 0; v < votes; v++) {
    // vary the order so a residual order bias cannot decide on its own
    const batch = v % 2 === 1 ? pairs.map((p) => ({ aId: p.bId, a: p.b, bId: p.aId, b: p.a })) : pairs;
    let answered = await ask(batch);
    // a model that answered for only some of the pairs must not silently drop
    // the rest: ask again for the missing ones, four at a time
    for (let i = 0; i < batch.length; i += 4) {
      const chunk = batch.slice(i, i + 4);
      const missing = chunk.filter((p) => !answered.has(pairKey(p.aId, p.bId)));
      if (!missing.length) continue;
      const got = await ask(missing);
      for (const k of got) answered.add(k);
    }
    // Still missing? Ask about each one alone. A model that quietly omits a
    // pair from a list will usually answer it when it is the only question
    // on the table — and a pair with no verdict gets no relation, so both
    // versions keep being recalled. That is the safe direction, but it is
    // still a lost collapse, and it costs one call to try.
    for (const p of batch) {
      const key = pairKey(p.aId, p.bId);
      if (answered.has(key)) continue;
      const got = await ask([p]);
      for (const k of got) answered.add(key);
    }
  }

  const minVotes = Math.min(2, votes);
  for (const [key, t] of tally) {
    // A relation is written only when every vote that was cast said SAME, and
    // at least `minVotes` votes were cast. With more than one vote, some pairs
    // flip between calls, so a single vote is not enough. A pair that split
    // its votes, or that nobody answered, gets no relation — both memories
    // keep being recalled.
    if (t.diff > 0) {
      out.set(key, { same: false, reason: t.reason });
    } else if (t.cast >= minVotes) {
      out.set(key, { same: true, reason: t.reason });
    }
  }
  return out;
}

// ---------- helpers ----------

/** order-independent key for a pair of memory ids */
export const pairKey = (a: number, b: number): string => (a < b ? `${a}:${b}` : `${b}:${a}`);

/** pull a JSON object out of a reply that may be fenced or trailing */
export function parseJson(text: string): unknown {
  const cleaned = text.replace(/```(?:json)?/g, "").trim();
  const candidates = [cleaned];
  const first = cleaned.indexOf("{");
  const firstArr = cleaned.indexOf("[");
  if (first >= 0) candidates.push(cleaned.slice(first));
  if (firstArr >= 0) candidates.push(cleaned.slice(firstArr));
  for (const c of candidates) {
    try {
      const o = JSON.parse(c);
      if (o && typeof o === "object") return o;
    } catch {
      /* next */
    }
  }
  // salvage: pull out individual verdict objects
  const found: unknown[] = [];
  for (const m of cleaned.matchAll(/\{[^{}]*"(pair|same)"[^{}]*\}/g)) {
    try {
      found.push(JSON.parse(m[0]));
    } catch {
      /* skip */
    }
  }
  return found.length ? found : null;
}

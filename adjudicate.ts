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
export const ADJUDICATE_MODEL = env("ADJUDICATE_MODEL") ?? "auto";

/**
 * Fallback chain. A model provider can run out of credits or go down — the
 * hyper provider on this lab did exactly that mid-run — and the curator must
 * not silently stop producing verdicts. Each model is tried in turn until one
 * answers.
 */
const FALLBACK_MODELS = (
  env("ADJUDICATE_FALLBACK_MODELS") ?? "auto,ag/gemini-3.8-flash-high"
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

const MERGE_SYSTEM = `You are a memory-store deduplicator for a personal memory store. A semantic search sometimes returns two notes together. Decide whether they record the SAME underlying fact -- so that one is a STALE VINTAGE of the other and the older one should be hidden -- or DIFFERENT facts that merely share a topic, project, or date.

The question is symmetric: it does not matter which note is listed first. If EITHER note is a stale vintage of the other, the answer is SAME. If both notes add distinct facts, the answer is DIFFERENT.

Each note is given as its subject, its claim, the concrete artifact it points at, and its time.

Judge each note at the granularity of "which specific thing is this note about": a specific commit, a specific file, a specific roster, a specific session, a specific document, a specific UI measurement, a specific named decision, a specific migration.

SAME (one is a stale vintage of the other) = the two notes report the SAME specific thing at the same subject-and-attribute granularity, and one simply updates, corrects, or elaborates the other. The VALUE may have changed and that is still SAME: row height 77px then 65px; a model roster re-listed with a different set; a proposed name then the chosen name; a commit first "not pushed" then "pushed"; a doc first "not merged" then "merged"; a brief index note then a detailed version of the same index; a spec then the final wording of the same spec. Both notes must be about the same SUBJECT and the same ATTRIBUTE (e.g. both about the row height of the catalog rows; both about the contents of the Logfare roster; both about the status of commit 91dce00).

DIFFERENT (both must be kept) = the two notes track two different attributes, two different artifacts, or two different events, even when they share the same project, the same day, and the same overall topic. Specifically DIFFERENT if: the commits, file paths, rosters, documents, or attributes differ; or each note records a distinct separate step or outcome (a migration record vs. a later end-to-end verification result; a crash report vs. a recovery recipe; a dependency upgrade vs. a framework migration; two different UI layout changes; an audit batch vs. a later git-history purge); or one is a policy/overview/directory document and the other is a specific claim of a different scope.

The shared project name, product name, or date alone is NEVER enough for SAME. Ask: is there ONE specific underlying fact, at the same subject-and-attribute granularity, that both notes report?

Answer with JSON only:
{"verdicts":[{"pair":<int>,"same":<true|false>,"reason":"<one-sentence reason>"}]}`;

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
 * THREE VOTES, UNANIMITY REQUIRED
 *
 * One call is not enough. Measured on the live corpus, a single call on 55
 * hand-labelled pairs scores 0.73-0.76 accuracy, and the error is not evenly
 * spread: some pairs flip between calls. Three votes, taken with the pair in
 * both orders, and a relation written only when all three agree, scored 0.836
 * accuracy at precision 0.83 and recall 0.86 — against 0.764 for one call at
 * the same precision.
 *
 * The order matters less than it looks, because the prompt is explicitly
 * symmetric; it is varied anyway so a residual order bias cannot decide a
 * relation on its own.
 */
export async function judgePairs(
  pairs: { aId: number; a: Claim; bId: number; b: Claim }[],
  model = ADJUDICATE_MODEL,
  votes = 3,
): Promise<Map<string, Adjudication> | null> {
  if (!pairs.length) return new Map();
  const out = new Map<string, Adjudication>();
  const tally = new Map<string, { same: number; diff: number; cast: number; reason: string }>();

  const ask = async (batch: typeof pairs): Promise<Set<string>> => {
    const answered = new Set<string>();
    const body = batch
      .map(
        (p, i) =>
          `PAIR ${i + 1}\n--- A (#${p.aId})\n${claimText(p.a)}\n--- B (#${p.bId})\n${claimText(p.b)}`,
      )
      .join("\n\n");
    const reply = await chat(
      MERGE_SYSTEM,
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
  }

  for (const [key, t] of tally) {
    // A relation is written only when every vote that was cast said SAME, and
    // at least two votes were cast. One vote is not enough: some pairs flip
    // between calls. A pair that split its votes, or that nobody answered,
    // gets no relation — both memories keep being recalled.
    if (t.diff > 0) {
      out.set(key, { same: false, reason: t.reason });
    } else if (t.cast >= 2) {
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

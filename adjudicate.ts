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
export const ADJUDICATE_MODEL = env("ADJUDICATE_MODEL") ?? "hyper/glm-5.3-flash";

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
  opts: { model?: string; maxTokens?: number } = {},
): Promise<ChatReply> {
  const key = routerKey();
  if (!key) return null;
  const model = opts.model ?? ADJUDICATE_MODEL;
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
        temperature: 0,
        max_tokens: opts.maxTokens ?? 1500,
      }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok) {
      console.error(`[adjudicate] http ${res.status}: ${(await res.text()).slice(0, 200)}`);
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
        console.error(`[adjudicate] unparsable body: ${raw.slice(0, 200)}`);
        return null;
      }
    }
    return json?.choices?.[0]?.message?.content ?? null;
  } catch (e) {
    console.error("[adjudicate] call failed:", e instanceof Error ? e.message : e);
    return null;
  }
}

// ---------- prompts ----------

const CLAIM_SYSTEM = `For each note, extract:
- subject: the SPECIFIC thing the note is about (a feature, file, field, setting, task, event). "the branch field in data.mcky.space" is a subject; "data.mcky.space" alone is too vague.
- claim: what the note ASSERTS about that subject, in one sentence.
- artifact: the concrete thing the note points at — a file path, a screen, a field name, a commit, a command. If it points at nothing specific, say "none".
- time: the date, version or state it refers to.
- is_update: true if the note reads as a later revision, correction or updated state of some earlier statement; false if it just states a fact on its own.

Answer with JSON only, one entry per note, in the order given:
{"notes":[{"id":<the id shown>,"subject":"...","claim":"...","artifact":"...","time":"...","is_update":<true|false>}]}`;

const MERGE_SYSTEM = `Two notes from a memory system, each reduced to subject / claim / artifact / time.

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
 */
export async function judgePairs(
  pairs: { aId: number; a: Claim; bId: number; b: Claim }[],
  model = ADJUDICATE_MODEL,
): Promise<Map<string, Adjudication> | null> {
  if (!pairs.length) return new Map();
  const out = new Map<string, Adjudication>();
  const ask = async (batch: typeof pairs): Promise<void> => {
    const body = batch
      .map(
        (p, i) =>
          `PAIR ${i + 1}\n--- A (#${p.aId})\n${claimText(p.a)}\n--- B (#${p.bId})\n${claimText(p.b)}`,
      )
      .join("\n\n");
    const reply = await chat(
      MERGE_SYSTEM,
      `Judge each of the ${batch.length} pairs independently.\n\n${body}`,
      { model, maxTokens: 4000 },
    );
    if (!reply) return;
    const parsed = parseJson(reply);
    const list = Array.isArray(parsed) ? parsed : (parsed as any)?.verdicts;
    if (!Array.isArray(list)) return;
    for (const v of list) {
      const idx = Number(v?.pair) - 1;
      if (!Number.isInteger(idx) || idx < 0 || idx >= batch.length) continue;
      const p = batch[idx];
      out.set(pairKey(p.aId, p.bId), {
        same: Boolean(v?.same),
        reason: String(v?.reason ?? "").slice(0, 300),
      });
    }
  };

  await ask(pairs);
  // A model that answered for only some of the pairs must not silently drop
  // the rest: ask again for the missing ones, one batch of four.
  const missing = pairs.filter((p) => !out.has(pairKey(p.aId, p.bId)));
  if (missing.length) {
    for (let i = 0; i < missing.length; i += 4) {
      await ask(missing.slice(i, i + 4));
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

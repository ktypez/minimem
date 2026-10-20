// Semantic layer for minimem: embeddings + hybrid ranking.
//
// Split out of server.ts so the ranking maths can be unit-tested without
// booting a server (server.ts calls .listen() at import time).
//
// The FTS5 trigram keyword path is NOT replaced. It stays the exact-match /
// identifier path; this file adds a second signal (cosine similarity over a
// dense 1024-dim vector) plus an age decay, and blends the three into one
// deterministic score. If embeddings are off, missing, or the provider is
// down, every function here degrades to "keyword only" instead of throwing.
//
// env (all optional; nothing is committed):
//   EMBED_ENABLED           1|0   master switch (default: 1 when a token is set)
//   EMBED_PROVIDER          cloudflare            (only provider implemented)
//   EMBED_MODEL             @cf/baai/bge-m3       (1024-dim, multilingual, Thai ok)
//   EMBED_DIM               1024
//   CF_ACCOUNT_ID           Cloudflare account id
//   CF_AI_TOKEN             Cloudflare AI token  (falls back to CLOUDFLARE_AI_API_TOKEN)
//   EMBED_TIMEOUT_MS        20000
//   HYBRID_W_FTS            1.0    weight of the (calibrated) FTS5 bm25 signal
//   HYBRID_W_VEC            1.0    weight of the (calibrated) cosine signal
//   HYBRID_W_REC            0.15   recency influence among RELEVANT rows (tie-break)
//   SEM_MIN_RELEVANCE       0.50   cosine gate: at/above this a row answers the query
//   SEM_COS_NOISE_FLOOR     0.45   cosine at/below this is noise (signal -> 0)
//   SEM_COS_GOOD_CEIL       0.65   cosine at/above this is a full-strength match
//   SEM_FTS_STRONG          8      -bm25 at/above this = strong keyword match
//   SEM_HALF_LIFE_DAYS      45     age at which the recency signal halves
//   SEM_DEDUPE_THRESHOLD    0.76   cosine above which two hits are "the same fact"
//   SUPERSEDE_MARGIN_HOURS  24     younger must lead by this to shadow an older row
//   TRUST_WEIGHT_VERIFIED   1.10
//   TRUST_WEIGHT_UNVERIFIED 1.00
//   TRUST_WEIGHT_DISPUTED   0.50
//
// Env names. The DEPLOYED spelling is SEM_* and it wins; the legacy spelling is
// still accepted so an older env file keeps working:
//
//   half-life : SEM_HALF_LIFE_DAYS  >  SEM_DECAY_HALF_LIFE_DAYS  >  DECAY_HALF_LIFE_DAYS
//   near-dup  : SEM_DEDUPE_THRESHOLD >  SEM_NEAR_DUP_COS          >  NEAR_DUP_COS
//
// Every other knob also accepts the legacy SEM_* prefix (SEM_MIN_RELEVANCE,
// SEM_COS_NOISE_FLOOR, SEM_COS_GOOD_CEIL, SEM_FTS_STRONG, ...).

import { createHash } from "node:crypto";

const env = (k: string) => process.env[k];
/** env knobs accept either spelling: DECAY_HALF_LIFE_DAYS or SEM_DECAY_HALF_LIFE_DAYS */
const envAny = (...keys: string[]) => {
  for (const k of keys) {
    const v = process.env[k];
    if (v !== undefined && v !== "") return v;
  }
  return undefined;
};
const num = (k: string, d: number) => {
  const v = Number(envAny(k, `SEM_${k}`));
  return Number.isFinite(v) ? v : d;
};
const bool = (k: string, d: boolean) => {
  const raw = envAny(k, `SEM_${k}`);
  if (raw === undefined) return d;
  return !["0", "false", "no", "off"].includes(raw.trim().toLowerCase());
};

/**
 * Explicit alias list, first hit wins. Needed for the two knobs whose DEPLOYED
 * spelling is not the legacy name plus a SEM_ prefix:
 *
 *   SEM_HALF_LIFE_DAYS  is not derivable from DECAY_HALF_LIFE_DAYS by the
 *                       generic `SEM_${k}` rule, so it needs spelling out.
 *   SEM_DEDUPE_THRESHOLD is not derivable from NEAR_DUP_COS either.
 *
 * The deployed SEM_* spelling wins; the legacy spelling is still honoured.
 */
const numAny = (names: string[], d: number) => {
  for (const n of names) {
    const v = process.env[n];
    if (v === undefined || v === "") continue;
    const x = Number(v);
    if (Number.isFinite(x)) return x;
  }
  return d;
};

export const EMBED_PROVIDER = (env("EMBED_PROVIDER") ?? env("SEM_EMBED_PROVIDER") ?? "cloudflare").trim().toLowerCase();
export const EMBED_MODEL = (envAny("EMBED_MODEL", "SEM_EMBED_MODEL") ?? "@cf/baai/bge-m3").trim();
export const EMBED_DIM = num("EMBED_DIM", 1024);
export const CF_ACCOUNT_ID = (envAny("CF_ACCOUNT_ID", "SEM_CF_ACCOUNT_ID") ?? "").trim();
export const CF_AI_TOKEN = (envAny("CF_AI_TOKEN", "CLOUDFLARE_AI_API_TOKEN", "SEM_CF_AI_TOKEN") ?? "").trim();
const EMBED_TIMEOUT_MS = num("EMBED_TIMEOUT_MS", 20000);

/** default: embeddings are on iff a token is configured, so a stray EMBED_ENABLED is not needed */
export const EMBED_ENABLED = bool("EMBED_ENABLED", !!CF_AI_TOKEN);
/** true only when we can actually call the provider */
export const embedReady = (): boolean => EMBED_ENABLED && !!CF_AI_TOKEN && !!CF_ACCOUNT_ID;

export type Weights = {
  fts: number;
  vec: number;
  rec: number;
  halfLifeDays: number;
  nearDupCos: number;
  /** cosine at/above which a row counts as answering the query (relevance gate) */
  minRelevance: number;
  /** -bm25 at/above this = strong keyword match */
  ftsStrong: number;
  /** calibrated cosine floor: the measured noise ceiling */
  noiseFloor: number;
  /** calibrated cosine ceiling: the measured good-hit level */
  goodCeil: number;
  /** how much younger a row must be to supersede a near-duplicate, in hours */
  supersedeMarginHours: number;
  trust: Record<string, number>;
};

export const weights = (): Weights => ({
  fts: num("HYBRID_W_FTS", 1),
  vec: num("HYBRID_W_VEC", 1),
  rec: num("HYBRID_W_REC", 0.15),
  // DEPLOYED spelling first, legacy second, code default last.
  halfLifeDays: numAny(["SEM_HALF_LIFE_DAYS", "SEM_DECAY_HALF_LIFE_DAYS", "DECAY_HALF_LIFE_DAYS"], 45),
  // measured on this corpus: real "same fact, different version" pairs sit at
  // 0.767-0.828 and p50 top-1 neighbour is 0.702, so 0.9 shadowed nothing and
  // 0.78 missed the 0.767 pair. 0.76 separates the two populations.
  nearDupCos: numAny(["SEM_DEDUPE_THRESHOLD", "SEM_NEAR_DUP_COS", "NEAR_DUP_COS"], 0.76),
  // good semantic hits measure 0.51-0.65, background noise p50 0.28-0.44
  minRelevance: num("SEM_MIN_RELEVANCE", 0.5),
  ftsStrong: num("SEM_FTS_STRONG", 8),
  noiseFloor: num("SEM_COS_NOISE_FLOOR", 0.45),
  goodCeil: num("SEM_COS_GOOD_CEIL", 0.65),
  supersedeMarginHours: num("SUPERSEDE_MARGIN_HOURS", 24),
  trust: {
    verified: num("TRUST_WEIGHT_VERIFIED", 1.1),
    unverified: num("TRUST_WEIGHT_UNVERIFIED", 1.0),
    disputed: num("TRUST_WEIGHT_DISPUTED", 0.5),
  },
});

// ---------- vectors ----------
/** L2-normalised float32 vector -> bytes. 1024 dims = 4 KiB per memory. */
export function packVec(v: ArrayLike<number>): Uint8Array {
  const f = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) f[i] = v[i] ?? 0;
  return new Uint8Array(f.buffer.slice(0));
}

export function unpackVec(buf: Uint8Array | ArrayBuffer): Float32Array {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  // copy: the ArrayBuffer may be a slice with a non-zero byteOffset
  const out = new Float32Array(b.byteLength / 4);
  new Uint8Array(out.buffer).set(b.subarray(0, out.byteLength));
  return out;
}

/**
 * Cosine similarity. The provider already returns unit vectors, but we do not
 * trust that: a zero vector or a provider change must not produce NaN.
 */
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  if (!n) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i];
    const y = b[i];
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

/** hash that ties an embedding to the exact text+model it was made from */
export function hashText(model: string, text: string): string {
  return createHash("sha256").update(model).update("\0").update(text).digest("hex");
}

// ---------- staleness ----------
/** age in days from an sqlite "YYYY-MM-DD HH:MM:SS" (UTC) stamp or an epoch ms */
export function ageDays(stamp: string | number, nowMs = Date.now()): number {
  const t = typeof stamp === "number" ? stamp : Date.parse(stamp.replace(" ", "T") + "Z");
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, (nowMs - t) / 86400000);
}

/** exponential half-life decay -> (0, 1]. A fresh item scores 1, one half-life old 0.5. */
export function decay(age: number, halfLifeDays: number): number {
  if (!(halfLifeDays > 0)) return 1;
  return Math.pow(0.5, age / halfLifeDays);
}

// ---------- hybrid ranking ----------
/**
 * Signal calibration. bm25 and cosine are not on the same scale, so each is
 * mapped to [0,1] with an ABSOLUTE anchor instead of being min-max normalised
 * across the candidate set:
 *
 *   - min-max over candidates is query-dependent (the same row changes score
 *     depending on which losers happen to be in its pool) and it always hands
 *     1.0 to the best keyword hit even when every hit is garbage.
 *   - raw cosine (typically 0.3-0.65 here) can never compete with a 0-1 fts
 *     term, so the semantic signal got crushed by the blend.
 *
 * ftsSig saturates at `strong` (-bm25 units): a strong exact hit lands at 1.0,
 * a weak trigram hit near 0.2. cosSig maps [floor, ceil] -> [0,1] where floor
 * is the measured noise ceiling (~0.45) and ceil the measured good-hit value
 * (~0.65). Both are deterministic and tunable per env.
 */
export function ftsSig(strength: number, strong: number): number {
  if (!(strong > 0)) return strength > 0 ? 1 : 0;
  return Math.min(1, Math.max(0, strength / strong));
}

export function cosSig(cos: number | null | undefined, floor = 0.45, ceil = 0.65): number {
  if (cos === null || cos === undefined || !Number.isFinite(cos)) return 0;
  if (ceil <= floor) return cos >= ceil ? 1 : 0;
  return Math.min(1, Math.max(0, (cos - floor) / (ceil - floor)));
}

export type Cand = {
  id: number;
  text: string;
  created_at: string;
  updated_at: string;
  agent_source?: string | null;
  trust?: string | null;
  /** raw FTS5 rank (bm25, lower is better). undefined when the row was not an FTS hit. */
  fts?: number;
  /** cosine similarity against the query. undefined when the row has no embedding. */
  cos?: number;
  tags?: string[];
};

export type Scored = {
  id: number;
  text: string;
  created_at: string;
  updated_at: string;
  agent_source: string | null;
  trust: string;
  tags?: string[];
  /** raw FTS5 bm25 rank of this row, when it was a keyword hit (lower = better) */
  fts?: number;
  score: number;
  /** calibrated keyword signal in [0,1] — 0 when not a keyword hit */
  fts_norm: number;
  /** raw cosine against the query, or null when the row has no vector */
  cos: number | null;
  recency: number;
  age_days: number;
  /** relevance gate result: matched by keyword, by meaning, both, or neither */
  match: "both" | "keyword" | "semantic" | "none";
  /** newer memories this one duplicates in meaning (this row lost) — only on request */
  shadowed_by?: number;
  /** ids this row supersedes because it is the newer near-duplicate */
  supersedes?: number[];
};

/**
 * The blend. Deterministic, no randomness, no clock reads beyond `now`.
 *
 *   ftsNorm   = ftsSig(-bm25, w.ftsStrong)            absolute anchor -> [0,1]
 *   cosNorm   = cosSig(cos, w.noiseFloor, w.goodCeil) absolute anchor -> [0,1]
 *   kwHit     = ftsNorm > 0
 *   semHit    = cos != null && cos >= w.minRelevance
 *   relevant  = kwHit || semHit                       <- the GATE
 *   relevance = (w.fts*ftsNorm + w.vec*cosNorm) / (w.fts + w.vec)   for relevant rows
 *   score     = relevance * trust * ((1-w.rec) + w.rec*recency)
 *   score     = 0                                     for non-relevant rows
 *
 * Four properties, each one fixing a specific failure:
 *
 * 1. RELEVANCE IS A GATE, NOT A SIGNAL. A row that matched neither keyword
 *    nor meaning scores exactly 0 and sorts after every relevant row. Recency
 *    can no longer carry an irrelevant row: it is a bounded multiplier
 *    (at most w.rec of the score) on top of a relevance that is already 0.
 * 2. THE DENOMINATOR IS FIXED. A keyword-only hit and a semantic-only hit are
 *    directly comparable, and a row matched both ways outranks either. A row
 *    that has a vector always contributes its cosine — the signal is not
 *    dropped just because the row was not in the semantic top pool.
 * 3. BM25 AND COSINE SHARE ONE SCALE. Both are mapped to [0,1] with ABSOLUTE
 *    anchors (see ftsSig/cosSig) instead of min-max over the candidate set,
 *    so a strong semantic match is not drowned by a normalised keyword score
 *    and scores stay comparable across queries.
 * 4. RECENCY IS A TIE-BREAKER. It multiplies relevance by at most
 *    1+w.rec/w.rec... (bounded), so it can reorder near-ties among relevant
 *    rows but never promotes a row that matched nothing.
 *
 * With no vectors anywhere (`cos` null on every row) the ordering collapses to
 * fts_norm then recency, i.e. the existing ORDER BY rank behaviour.
 */
export function rankHybrid(cands: Cand[], w: Weights, nowMs = Date.now()): Scored[] {
  if (!cands.length) return [];
  const relW = w.fts + w.vec;
  const denom = relW > 0 ? relW : 1;
  const recShare = Math.max(0, Math.min(1, w.rec));

  const scored: Scored[] = cands.map((c) => {
    const strength = c.fts === undefined ? 0 : Math.max(0, -c.fts);
    const ftsNorm = ftsSig(strength, w.ftsStrong);
    // null and undefined both mean "this row has no vector signal". A row
    // that DOES have a vector always carries a number, never null.
    const cos = c.cos === undefined || c.cos === null ? null : c.cos;
    const cosNorm = cosSig(cos, w.noiseFloor, w.goodCeil);
    const kwHit = ftsNorm > 0;
    const semHit = cos !== null && cos >= w.minRelevance && cosNorm > 0;
    const relevant = kwHit || semHit;
    const age = ageDays(c.updated_at, nowMs);
    const rec = decay(age, w.halfLifeDays);
    const trust = c.trust ?? "unverified";
    const tw = w.trust[trust] ?? 1;
    const match: Scored["match"] = kwHit ? (semHit ? "both" : "keyword") : semHit ? "semantic" : "none";

    let score = 0;
    if (relevant) {
      // fixed denominator: a missing signal contributes 0, but both rows are
      // measured on the same scale, so one signal never outranks two.
      const relevance = (w.fts * ftsNorm + w.vec * cosNorm) / denom;
      // recency is a bounded tie-breaker, not a signal of its own
      const recFactor = (1 - recShare) + recShare * rec;
      score = relevance * tw * recFactor;
    }
    return {
      // explicit construction, never `...c`: a caller that accidentally carries
      // an internal field (e.g. the 1024-float vector) cannot leak it into a
      // JSON response through the spread.
      id: c.id,
      text: c.text,
      created_at: c.created_at,
      updated_at: c.updated_at,
      agent_source: c.agent_source ?? null,
      trust,
      tags: c.tags,
      fts: c.fts,
      fts_norm: round6(ftsNorm),
      cos: cos === null ? null : round6(cos),
      recency: round6(rec),
      age_days: Math.round(age * 100) / 100,
      match,
      score: round6(score),
    };
  });

  // relevant rows first, then score, then newest, then id — fully deterministic
  scored.sort(
    (a, b) =>
      Number(b.match !== "none") - Number(a.match !== "none") ||
      b.score - a.score ||
      a.age_days - b.age_days ||
      b.id - a.id,
  );
  return scored;
}

const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

/**
 * Collapse near-duplicate meanings, keeping the NEWER row.
 *
 * This is the actual complaint this feature exists to fix: "an old memory is
 * recalled as if it were current". Two rows whose texts mean the same thing
 * (cosine >= nearDupCos) are one fact with two vintages; the older one is not
 * deleted, not hidden from /memories, just not *recalled* — the newer one
 * carries `supersedes`, and the dropped older ids come back in `shadowed`.
 *
 * VINTAGE ORDER. Which of two near-identical rows is the newer one?
 *
 *   1. If one is meaningfully younger (by more than `supersedeMarginHours`),
 *      it is the newer vintage. The margin exists so that an unrelated later
 *      EDIT of the same text does not flip a pair.
 *   2. Otherwise the two are the same vintage as far as time can tell (this
 *      corpus was bulk-imported, so every row shares an import timestamp) and
 *      INSERTION ORDER decides: the higher id was inserted later, so it is the
 *      newer vintage.
 *
 * Rule 2 is what makes an imported corpus behave: without it the pair
 * #848 "Checked: Jev EXISTS ..." / #849 "Correction: the two Free promos ..."
 * (identical timestamps, cosine 0.828) would keep the OLD vintage and shadow
 * the correction — the exact bug this feature exists to fix.
 *
 * Vectors are passed in a side map, never attached to the Scored rows, so
 * 4 KB of float payload cannot leak into a JSON response.
 */
export function dedupeByMeaning(
  ranked: Scored[],
  w: Weights,
  vectors: Map<number, Float32Array> | null,
  nowMs = Date.now(),
): { kept: Scored[]; shadowed: { id: number; by: number; cos: number }[] } {
  const kept: Scored[] = [];
  const shadowed: { id: number; by: number; cos: number }[] = [];
  if (!vectors || !vectors.size) return { kept: ranked.slice(), shadowed };
  const margin = w.supersedeMarginHours / 24;
  const ageOf = (s: Scored) => ageDays(s.updated_at, nowMs);

  // true when `a` is the newer vintage of the pair (a, b)
  const isNewer = (a: Scored, b: Scored): boolean => {
    const gap = ageOf(b) - ageOf(a); // > 0 when a is younger
    if (gap > margin) return true; // a is meaningfully younger
    if (gap < -margin) return false; // b is meaningfully younger
    return a.id > b.id; // same vintage: insertion order decides
  };
  // ordering used to elect the newest record of a near-duplicate cluster:
  // younger first, and on a tie (imported corpus) the higher id first.
  const vintageOrder = (a: Scored, b: Scored): number => {
    const ageA = ageOf(a);
    const ageB = ageOf(b);
    if (Math.abs(ageA - ageB) > margin) return ageA - ageB; // younger (smaller age) first
    return b.id - a.id; // same vintage: higher id (later insert) first
  };

  for (const s of ranked) {
    const sv = vectors.get(s.id);
    if (!sv) {
      kept.push(s);
      continue;
    }
    // every kept row that means the same thing as this one
    const nearDups: { row: Scored; cos: number }[] = [];
    for (const k of kept) {
      const kv = vectors.get(k.id);
      if (!kv) continue;
      const c = cosine(sv, kv);
      if (c >= w.nearDupCos) nearDups.push({ row: k, cos: c });
    }
    if (!nearDups.length) {
      kept.push(s);
      continue;
    }
    // ELECT THE NEWEST VINTAGE, not merely the most similar row. A fact can
    // have several near-identical records in the corpus (the "Hermes Provider
    // Setup" / "Hermes Model Setup" / "current topology" trio sits at 0.77-0.80);
    // picking by cosine alone can leave the older record as the survivor and
    // attribute the shadowing to a row that is not the current version.
    const elect = nearDups
      .slice()
      .sort((a, b) => vintageOrder(a.row, b.row) || b.cos - a.cos)[0].row;

    // Between the elected row and this one, the NEWER vintage wins — that is
    // the whole point of the feature: the current fact is the one recalled.
    if (isNewer(s, elect)) {
      const idx = kept.indexOf(elect);
      kept[idx] = { ...s, supersedes: [...(elect.supersedes ?? []), elect.id] };
      shadowed.push({ id: elect.id, by: s.id, cos: Math.round(nearDups[0].cos * 1e3) / 1e3 });
    } else {
      const idx = kept.indexOf(elect);
      kept[idx] = { ...elect, supersedes: [...(elect.supersedes ?? []), s.id] };
      const cos = nearDups.find((n) => n.row.id === s.id)?.cos ?? nearDups[0].cos;
      shadowed.push({ id: s.id, by: elect.id, cos: Math.round(cos * 1e3) / 1e3 });
    }
  }
  // the winner may have a different score than the row it replaced, so restore
  // the ranking order before the caller slices the page
  kept.sort(
    (a, b) =>
      Number(b.match !== "none") - Number(a.match !== "none") ||
      b.score - a.score ||
      a.age_days - b.age_days ||
      b.id - a.id,
  );
  return { kept, shadowed };
}

// ---------- provider ----------
export type EmbedResult = { vectors: number[][]; model: string } | { error: string };

/**
 * Embed a batch of texts. Never throws: a provider failure returns {error} so
 * the caller can fall back to keyword-only instead of 500ing.
 */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  const r = await embedBatchSafe(texts);
  if ("error" in r) throw new Error(r.error);
  return r.vectors;
}

export async function embedBatchSafe(texts: string[]): Promise<EmbedResult> {
  if (!texts.length) return { vectors: [], model: EMBED_MODEL };
  if (!embedReady()) {
    return { error: `embeddings unavailable (EMBED_ENABLED=${EMBED_ENABLED ? 1 : 0}, token ${CF_AI_TOKEN ? "set" : "missing"}, account ${CF_ACCOUNT_ID ? "set" : "missing"})` };
  }
  if (EMBED_PROVIDER !== "cloudflare") return { error: `unknown EMBED_PROVIDER: ${EMBED_PROVIDER}` };

  const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/${EMBED_MODEL}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), EMBED_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${CF_AI_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text: texts }),
      signal: ctl.signal,
    });
    const json = (await res.json()) as { success?: boolean; result?: { data?: number[][] }; errors?: unknown };
    if (!res.ok || json.success === false) {
      return { error: `provider http ${res.status}: ${JSON.stringify(json.errors ?? json).slice(0, 300)}` };
    }
    const data = json.result?.data;
    if (!Array.isArray(data) || data.length !== texts.length) {
      return { error: `provider returned ${Array.isArray(data) ? data.length : "no"} vectors for ${texts.length} texts` };
    }
    return { vectors: data, model: EMBED_MODEL };
  } catch (e) {
    return { error: `provider call failed: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    clearTimeout(timer);
  }
}

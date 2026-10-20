/**
 * Curate supersede relations.
 *
 *   bun run curate.ts [--apply] [--threshold 0.78] [--model <id>] [--batch 10]
 *
 * WHAT IT DOES
 *
 * 1. Finds candidate pairs — two memories whose embeddings are close enough
 *    that they MIGHT be two vintages of one fact.
 * 2. Reduces each candidate to its claim (cached in `memory_claims`, so the
 *    cost is paid once per memory, not once per pair).
 * 3. Asks the model, per pair, whether merging the two would yield ONE
 *    statement or TWO.
 * 4. Records the SAME verdicts in the `supersedes` table. The recall path then
 *    uses that table instead of guessing from cosine.
 *
 * WHY A MODEL IS NEEDED
 *
 * Cosine measures topical similarity, not factual identity. On this corpus the
 * screenshot cluster (five DIFFERENT screenshots of the same app) sat at
 * 0.90-0.96, above most of the genuine revision pairs. Every lexical
 * substitute we measured (rare-token containment, IDF-weighted overlap,
 * heading skeletons, chunk-level claim coverage, topic-claim cosine) scored
 * F1 <= 0.77 on 67 hand-labelled pairs. The question is semantic.
 *
 * SAFE BY DEFAULT
 *
 * Without --apply it only PRINTS what it would do. With --apply it writes
 * relations, and it only ever writes a relation the model says is the same
 * fact. A model failure is skipped, never guessed. A pair the model calls
 * "different" gets NO relation, so both memories keep being recalled — that
 * is the safe direction: a redundant memory is a small cost, a missing
 * memory is a silent hole.
 *
 * It never deletes anything. Un-linking a memory removes its relations so it
 * is recalled normally again.
 */

import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { ADJUDICATE_MODEL, extractClaims, judgePairs, pairKey, type Claim } from "./adjudicate";
import { cosine, EMBED_MODEL } from "./embed";

const argv = process.argv.slice(2);
const flag = (name: string, dflt?: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
};
const has = (name: string) => argv.includes(`--${name}`);

const APPLY = has("apply");
const THRESHOLD = Number(flag("threshold", "0.78"));
const BATCH = Math.max(1, Number(flag("batch", "10")));
const VOTES = Math.max(1, Number(flag("votes", process.env.ADJUDICATE_VOTES ?? "1")));
const MODEL = flag("model", ADJUDICATE_MODEL);
const DB_PATH =
  flag("db") ??
  process.env.MINIMEM_DB_PATH ??
  resolve(import.meta.dir, "data/minimem.db");

// default constructor: readwrite, creates the file if missing
const db = new Database(DB_PATH);
db.exec(`CREATE TABLE IF NOT EXISTS supersedes (
  id_a INTEGER NOT NULL, id_b INTEGER NOT NULL, reason TEXT,
  decided_by TEXT NOT NULL DEFAULT 'model',
  decided_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (id_a, id_b));
CREATE INDEX IF NOT EXISTS supersedes_b_idx ON supersedes(id_b);
CREATE TABLE IF NOT EXISTS memory_claims (
  memory_id INTEGER PRIMARY KEY,
  subject TEXT, claim TEXT, artifact TEXT, time TEXT,
  is_update INTEGER DEFAULT 0,
  model TEXT,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);`);

const memText = (id: number): string | null =>
  (db.query("SELECT text FROM memories WHERE id = ? AND deleted_at IS NULL").get(id) as { text: string } | null)
    ?.text ?? null;

// ---------- candidate pairs ----------
type Vec = { id: number; vec: Float32Array };
const vecs: Vec[] = [];
for (const r of db.query("SELECT memory_id, dim, vec FROM embeddings WHERE model = ?").all(EMBED_MODEL) as any[]) {
  const b = r.vec as Uint8Array;
  vecs.push({ id: r.memory_id, vec: new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4) });
}

const cand: { aId: number; aText: string; bId: number; bText: string; cos: number }[] = [];
for (let i = 0; i < vecs.length; i++) {
  for (let j = i + 1; j < vecs.length; j++) {
    const c = cosine(vecs[i].vec, vecs[j].vec);
    if (c < THRESHOLD) continue;
    const aText = memText(vecs[i].id);
    const bText = memText(vecs[j].id);
    if (!aText || !bText) continue;
    cand.push({ aId: vecs[i].id, aText, bId: vecs[j].id, bText, cos: c });
  }
}
cand.sort((x, y) => y.cos - x.cos);

const known = new Set(
  (db.query("SELECT id_a, id_b FROM supersedes").all() as any[]).map((r) => pairKey(r.id_a, r.id_b)),
);
const pending = cand.filter((p) => !known.has(pairKey(p.aId, p.bId)));

console.log(
  `candidates ${cand.length} | known ${known.size} | to adjudicate ${pending.length} | threshold ${THRESHOLD} | model ${MODEL}`,
);
if (!pending.length) {
  db.close();
  process.exit(0);
}

// ---------- stage 1: claims (cached) ----------
const claimIds = [...new Set(pending.flatMap((p) => [p.aId, p.bId]))];
const cached = new Map<number, Claim>();
for (const r of db.query("SELECT * FROM memory_claims").all() as any[]) {
  cached.set(r.memory_id, {
    id: r.memory_id,
    subject: r.subject ?? "",
    claim: r.claim ?? "",
    artifact: r.artifact ?? "",
    time: r.time ?? "",
    is_update: Boolean(r.is_update),
  });
}
const need = claimIds.filter((id) => !cached.has(id));
if (need.length) {
  console.log(`extracting ${need.length} claims...`);
  for (let i = 0; i < need.length; i += 12) {
    const slice = need.slice(i, i + 12);
    const notes = slice.map((id) => ({ id, text: memText(id) ?? "" }));
    const got = await extractClaims(notes, MODEL);
    if (!got) {
      console.error(`  claim extraction failed for ${slice.length} notes, skipping`);
      continue;
    }
    for (const c of got) {
      cached.set(c.id, c);
      db.query(
        "INSERT OR REPLACE INTO memory_claims(memory_id, subject, claim, artifact, time, is_update, model) VALUES(?,?,?,?,?,?,?)",
      ).run(c.id, c.subject, c.claim, c.artifact, c.time, c.is_update ? 1 : 0, MODEL);
    }
    console.log(`  ${Math.min(i + 12, need.length)}/${need.length}`);
  }
}

// ---------- stage 2: pairwise merge test ----------
let decided = 0;
let same = 0;
for (let i = 0; i < pending.length; i += BATCH) {
  const slice = pending.slice(i, i + BATCH);
  const pairs = slice
    .map((p) => ({
      aId: p.aId,
      a: cached.get(p.aId),
      bId: p.bId,
      b: cached.get(p.bId),
    }))
    .filter((p) => p.a && p.b) as { aId: number; a: Claim; bId: number; b: Claim }[];
  if (!pairs.length) {
    console.error(`batch at ${i}: no claims available, skipped`);
    continue;
  }
  const verdicts = await judgePairs(pairs, MODEL, VOTES);
  if (!verdicts) {
    console.error(`batch at ${i}: model failed, skipped`);
    continue;
  }
  for (const p of slice) {
    const v = verdicts.get(pairKey(p.aId, p.bId));
    if (!v) {
      console.error(`no verdict for ${p.aId}/${p.bId}`);
      continue;
    }
    decided++;
    if (!v.same) {
      console.log(`  DIFF  #${p.aId} x #${p.bId}  cos=${p.cos.toFixed(3)}  — ${v.reason}`);
      continue;
    }
    same++;
    // the newer vintage wins: newer updated_at, ties broken by higher id
    const a = memMeta(p.aId);
    const b = memMeta(p.bId);
    const aIsNewer = a.updated > b.updated || (a.updated === b.updated && a.id > b.id);
    const current = aIsNewer ? p.aId : p.bId;
    const other = aIsNewer ? p.bId : p.aId;
    console.log(`  SAME  #${current} supersedes #${other}  cos=${p.cos.toFixed(3)}  — ${v.reason}`);
    if (APPLY) {
      db.query("DELETE FROM supersedes WHERE id_a = ? AND id_b = ?").run(other, current);
      db
        .query("INSERT OR REPLACE INTO supersedes(id_a, id_b, reason, decided_by) VALUES(?, ?, ?, 'model')")
        .run(current, other, v.reason);
    }
  }
}

function memMeta(id: number): { id: number; updated: string } {
  const r = db.query("SELECT id, updated_at FROM memories WHERE id = ?").get(id) as any;
  return { id, updated: r?.updated_at ?? "" };
}

console.log(`\ndecided ${decided} | same ${same} | different ${decided - same}`);
if (APPLY) console.log("relations written (--apply)");
else console.log("DRY RUN — pass --apply to write");
db.close();

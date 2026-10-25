// DB side of the semantic index: the embeddings store, the staleness scan, and
// the backfill loop. Shared by server.ts (REST/MCP) and the CLI wrapper
// backfill.sh, so there is exactly one implementation of each.
//
// Nothing here ever deletes or rewrites a memory. A stale vector is replaced;
// a memory row is never touched except for its own vector.
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { getEmbedModel, embedBatchSafe, hashText, packVec, unpackVec, setEmbedDb } from "./embed.ts";

export type Pending = { id: number; text: string };

export type EmbeddingStats = {
  model: string;
  live: number;
  embedded: number;
  stale_or_missing: number;
};

/**
 * Every live memory whose vector is missing or was built from different text.
 * Order is by id, so a repeated backfill call resumes where the last one stopped
 * and is idempotent (already-current rows are skipped).
 *
 * Soft-deleted rows are excluded here and everywhere else in this file: they are
 * not recalled, so they are not worth a paid embedding call.
 */
export function scanPending(db: Database, model = getEmbedModel()): Pending[] {
  const rows = db
    .query(
      `SELECT m.id AS id, m.text AS text, x.text_hash AS text_hash, x.model AS model
         FROM memories m LEFT JOIN embeddings x ON x.memory_id = m.id
        WHERE m.deleted_at IS NULL
        ORDER BY m.id ASC`,
    )
    .all() as { id: number; text: string; text_hash: string | null; model: string | null }[];
  const out: Pending[] = [];
  for (const r of rows) {
    // a vector from a different model is stale even when the text is identical
    if (r.text_hash === hashText(model, r.text) && r.model === model) continue;
    out.push({ id: r.id, text: r.text });
  }
  return out;
}

export function embeddingStats(db: Database, model = getEmbedModel()): EmbeddingStats {
  const live = (db.query("SELECT COUNT(*) AS n FROM memories WHERE deleted_at IS NULL").get() as { n: number }).n;
  const embedded = (db.query("SELECT COUNT(*) AS n FROM embeddings WHERE model = ?").get(model) as { n: number }).n;
  return { model, live, embedded, stale_or_missing: scanPending(db, model).length };
}

/** @returns true when the vector was stored; false when the row changed under us. */
export function storeEmbedding(db: Database, id: number, vec: number[], text: string, model = getEmbedModel()): boolean {
  const cur = db.query("SELECT id, text FROM memories WHERE id = ? AND deleted_at IS NULL").get(id) as
    | { id: number; text: string }
    | null;
  // the memory was edited or deleted while the embedding call was in flight:
  // storing it now would score stale meaning, so drop it — backfill will redo it
  if (!cur || cur.text !== text) return false;
  db.query(
    `INSERT INTO embeddings(memory_id, model, dim, vec, text_hash, embedded_at)
     VALUES(?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(memory_id) DO UPDATE SET
       model = excluded.model, dim = excluded.dim, vec = excluded.vec,
       text_hash = excluded.text_hash, embedded_at = datetime('now')`,
  ).run(id, model, vec.length, packVec(vec), hashText(model, text));
  return true;
}

export function dropEmbedding(db: Database, id: number): void {
  db.query("DELETE FROM embeddings WHERE memory_id = ?").run(id);
}

/** Every vector in the index, unpacked. ~1k rows = ~4 MB, cheap to scan in-process. */
export function loadVectors(db: Database, model = getEmbedModel()): { id: number; vec: Float32Array }[] {
  const rows = db.query("SELECT memory_id, vec FROM embeddings WHERE model = ?").all(model) as {
    memory_id: number;
    vec: Uint8Array;
  }[];
  return rows.map((r) => ({ id: r.memory_id, vec: unpackVec(r.vec) }));
}

export function getVector(db: Database, id: number, model = getEmbedModel()): Float32Array | null {
  const row = db.query("SELECT vec FROM embeddings WHERE memory_id = ? AND model = ?").get(id, model) as
    | { vec: Uint8Array }
    | null;
  return row ? unpackVec(row.vec) : null;
}

export type BackfillReport = {
  model: string;
  pending_before: number;
  embedded: number;
  failed: number;
  remaining: number;
  batches: number;
  error?: string;
  /** ids that were skipped because the memory changed mid-flight */
  skipped_changed: number;
};

/**
 * Embed up to `limit` pending memories, `batchSize` texts per provider call.
 * Idempotent and resumable: call it again to continue. Partial failure is not
 * fatal — whatever landed stays landed and `remaining` says what is left.
 */
export async function backfill(
  db: Database,
  opts: { limit?: number; batchSize?: number; model?: string; onProgress?: (msg: string) => void } = {},
): Promise<BackfillReport> {
  const model = opts.model ?? getEmbedModel();
  const limit = Math.max(1, opts.limit ?? 25);
  const batchSize = Math.max(1, Math.min(opts.batchSize ?? 16, 100));
  const report: BackfillReport = {
    model,
    pending_before: scanPending(db, model).length,
    embedded: 0,
    failed: 0,
    remaining: 0,
    batches: 0,
    skipped_changed: 0,
  };

  let done = 0;
  while (done < limit) {
    const take = Math.min(batchSize, limit - done);
    const batch = scanPending(db, model).slice(0, take);
    if (!batch.length) break;
    const res = await embedBatchSafe(batch.map((b) => b.text));
    report.batches++;
    if ("error" in res) {
      report.error = res.error;
      break;
    }
    for (let i = 0; i < batch.length; i++) {
      const ok = storeEmbedding(db, batch[i].id, res.vectors[i], batch[i].text, model);
      if (ok) report.embedded++;
      else report.skipped_changed++;
    }
    done += batch.length;
    opts.onProgress?.(`  batch ${report.batches}: ${batch.length} embedded (${report.embedded}/${limit})`);
  }

  report.remaining = scanPending(db, model).length;
  return report;
}

// ---------- CLI: bun run embedstore.ts --limit 25 ----------
if (import.meta.main) {
  const argv = process.argv.slice(2);
  const numArg = (flag: string, d: number) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : d;
  };
  const limit = numArg("--limit", 25);
  const batchSize = numArg("--batch", 16);
  const statsOnly = argv.includes("--stats");
  const dbPath = process.env.MINIMEM_DB_PATH ?? process.env.DB_PATH;
  if (!dbPath) {
    console.error("MINIMEM_DB_PATH is required (run via ./backfill.sh, which loads MINIMEM_ENV)");
    process.exit(2);
  }
  // `create:false` is not a valid bun:sqlite option (it throws SQLITE_MISUSE on
  // bun >= 1.4). Use readwrite:true so we never create a DB by accident, and
  // fail loudly if the file is missing.
  if (!existsSync(dbPath)) {
    console.error(`database not found: ${dbPath}`);
    process.exit(2);
  }
  const db = new Database(dbPath, { readwrite: true });
  setEmbedDb(db);

  // The server creates this table on boot, but the backfill script must also work
  // against a DB the server has not started yet (e.g. first-run backfill).
  db.exec(`
CREATE TABLE IF NOT EXISTS embeddings (
  memory_id   INTEGER PRIMARY KEY,
  model       TEXT NOT NULL,
  dim         INTEGER NOT NULL,
  vec         BLOB NOT NULL,
  text_hash   TEXT NOT NULL,
  embedded_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS embeddings_model_idx ON embeddings(model);
`);

  if (statsOnly) {
    console.log(JSON.stringify(embeddingStats(db), null, 2));
    process.exit(0);
  }
  const before = embeddingStats(db);
  console.log(`model ${before.model} — live ${before.live}, embedded ${before.embedded}, pending ${before.stale_or_missing}`);
  const rep = await backfill(db, {
    limit,
    batchSize,
    onProgress: (m) => console.log(m),
  });
  console.log(JSON.stringify(rep, null, 2));
  db.close();
  // a provider error is a real failure; "nothing pending" is not
  process.exit(rep.error ? 1 : 0);
}

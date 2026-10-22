/**
 * Build the same-fact eval fixture from the live memory store.
 *
 *   ~/.bun/bin/bun test/same-fact/make-fixture.ts [--out <path>]
 *
 * WHY A FIXTURE AND NOT THE LIVE DB
 *
 * The hand labels in `docs/hand-labels.json` reference memories BY ID. An eval
 * that reads the live DB therefore gives a different answer every time someone
 * writes a memory — the measurement is not reproducible, and the labels can
 * silently start pointing at rows that no longer exist. So: extract exactly the
 * rows the labels reference into a small, committed DB and score against that.
 *
 * WHAT GOES IN
 *
 * - `memories` — all label ids, INCLUDING soft-deleted rows (deleted_at set).
 *   Dropping them would turn a missing row into an eval-time resolution error
 *   instead of a measured result.
 * - `embeddings` — the vectors the candidate finder works on.
 * - `tags` — recall/tag filters use them.
 * - empty `supersedes` / `memory_claims` — the eval must produce its own
 *   verdicts, never inherit the live relation set (that would be scoring the
 *   answers it is supposed to guess).
 *
 * Read-only on the live DB: this script never writes to the live store.
 *
 * RE-RUNNABLE
 *
 * The output path is REPLACED (the old .db, -wal and -shm are removed first).
 * Without that, a second run dies on a duplicate primary key — and a fixture
 * you must remember to delete by hand is a fixture that fails intermittently.
 */

import { Database } from "bun:sqlite";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const argv = process.argv.slice(2);
const flag = (name: string, dflt: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
};

const HERE = import.meta.dir;
const LABEL_FILE = resolve(HERE, "../../docs/hand-labels.json");
const LIVE_DB = flag("live", process.env.MINIMEM_DB_PATH ?? "/home/admin/minimem-data/minimem.db");
const OUT = flag("out", resolve(HERE, "same-fact.fixture.db"));

/** Tables the eval needs, in dependency-free order. DDL is copied verbatim. */
const TABLES = ["memories", "embeddings", "tags", "supersedes", "memory_claims"];

type Row = [number, number, string];

const labels = (JSON.parse(readFileSync(LABEL_FILE, "utf8")) as { labels?: Row[] }).labels ?? [];
if (!labels.length) {
  console.error(`no labels at ${LABEL_FILE}`);
  process.exit(1);
}
const ids = [...new Set(labels.flatMap(([a, b]) => [a, b]))].sort((a, b) => a - b);
const idList = ids.join(",");

const live = new Database(LIVE_DB, { readonly: true });

// Copy the real DDL so the fixture has the schema the code expects (indexes too).
const ddl: { name: string; sql: string }[] = [];
for (const t of TABLES) {
  const row = live
    .query<{ sql: string }, [string]>("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
    .get(t);
  if (!row?.sql) throw new Error(`live DB has no table ${t}`);
  ddl.push({ name: t, sql: row.sql });
}
const indexes = live
  .query<{ name: string; sql: string; tbl: string }, []>(
    "SELECT name, sql, tbl_name AS tbl FROM sqlite_master WHERE type='index' AND sql IS NOT NULL",
  )
  .all()
  .filter((i) => TABLES.includes(i.tbl));

// Replace, do not collide: a second run on the same path would otherwise die on
// a duplicate primary key (or, worse, half-write into the old fixture).
const replaced = existsSync(OUT);
for (const f of [OUT, `${OUT}-wal`, `${OUT}-shm`]) if (existsSync(f)) rmSync(f);

const out = new Database(OUT);
out.exec("PRAGMA journal_mode = WAL");
for (const { sql } of ddl) out.exec(sql);
// The live file stamps its schema version; a fixture without it reads as
// schema 0 to anything that opens the DB directly.
const liveUserVersion = live
  .query<{ user_version: number }, []>("PRAGMA user_version")
  .get()!.user_version;
out.exec(`PRAGMA user_version = ${liveUserVersion}`);

const copy = (table: string, where?: string) => {
  const cols = live
    .query<{ name: string }, [string]>("SELECT name FROM pragma_table_info(?)")
    .all(table)
    .map((c) => c.name);
  const sel = `SELECT ${cols.join(",")} FROM ${table} ${where ?? ""}`;
  const rows = live.query(sel).all() as Record<string, unknown>[];
  if (!rows.length) return 0;
  const ins = out.prepare(
    `INSERT INTO ${table} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
  );
  out.transaction(() => {
    for (const r of rows) ins.run(...cols.map((c) => r[c] as never));
  })();
  return rows.length;
};

const nMem = copy("memories", `WHERE id IN (${idList})`);
const nEmb = copy("embeddings", `WHERE memory_id IN (${idList})`);
const nTags = copy("tags", `WHERE memory_id IN (${idList})`);
for (const { sql } of indexes) out.exec(sql);

// Verifiable fingerprint: same labels + same live rows ⇒ same digest, so a
// regenerated fixture can be diffed instead of eyeballed. It has to cover the
// VECTORS and TAGS too — a fixture whose embeddings changed while its text did
// not is a different eval, and a text-only digest would call it unchanged.
const digest = new Bun.CryptoHasher("sha256");
for (const [a, b, l] of labels) digest.update(`${a}|${b}|${l}\n`);
for (const r of live
  .query<{ id: number; text: string }, [string]>(
    `SELECT id, text FROM memories WHERE id IN (${idList}) ORDER BY id`,
  )
  .all()) {
  digest.update(`${r.id}:${r.text}\n`);
}
for (const e of live
  .query<{ memory_id: number; model: string; dim: number; vec: Uint8Array }, [string]>(
    `SELECT memory_id, model, dim, vec FROM embeddings WHERE memory_id IN (${idList}) ORDER BY memory_id`,
  )
  .all()) {
  digest.update(`${e.memory_id}:${e.model}:${e.dim}:${Buffer.from(e.vec).toString("hex")}\n`);
}
const tagRows = live
  .query<{ memory_id: number; tag: string }, [string]>(
    `SELECT memory_id, tag FROM tags WHERE memory_id IN (${idList}) ORDER BY memory_id, tag`,
  )
  .all();
for (const t of tagRows) digest.update(`t${t.memory_id}:${t.tag}\n`);

const missing = ids.filter(
  (id) =>
    !out.query<{ n: number }, [number]>("SELECT count(*) AS n FROM memories WHERE id=?").get(id)!.n,
);
const noVec = ids.filter(
  (id) =>
    !out.query<{ n: number }, [number]>("SELECT count(*) AS n FROM embeddings WHERE memory_id=?").get(id)!
      .n,
);
const softDeleted = out
  .query<{ n: number }, []>("SELECT count(*) AS n FROM memories WHERE deleted_at IS NOT NULL")
  .get()!.n;

const pairs = labels.length;
const ambiguous = labels.filter(([, , l]) => l === "ambig").length;

console.log(`fixture  ${OUT}${replaced ? " (replaced)" : ""}`);
console.log(`labels   ${pairs} pairs (${pairs - ambiguous} scorable, ${ambiguous} ambig) / ${ids.length} ids`);
console.log(`rows     memories ${nMem} (soft-deleted ${softDeleted}) · embeddings ${nEmb} · tags ${nTags}`);
console.log(`schema   user_version ${liveUserVersion}`);
console.log(`history  supersedes ${out.query<{ n: number }, []>("SELECT count(*) AS n FROM supersedes").get()!.n} (must be 0) · claims ${out.query<{ n: number }, []>("SELECT count(*) AS n FROM memory_claims").get()!.n} (must be 0)`);
console.log(`sha256   ${digest.digest("hex")}`);
if (missing.length) throw new Error(`label ids missing from fixture: ${missing.join(",")}`);
if (noVec.length) throw new Error(`label ids without an embedding: ${noVec.join(",")}`);

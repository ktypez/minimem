/**
 * minimem — small, self-hosted memory store for agents.
 * Stack: Bun + Elysia + bun:sqlite (FTS5 trigram) + Vercel AI SDK (AI Gateway)
 *
 * A single-file server. The SQLite file lives OUTSIDE the repo on purpose
 * (MINIMEM_DB_PATH) so code and personal data never travel together.
 *
 *   MINIMEM_DB_PATH  absolute path of the sqlite file
 *   MINIMEM_TOKEN    long bearer token   (required when AUTH_ENABLED=1)
 *   MINIMEM_LOCK     optional short code for the web UI
 *   AUTH_ENABLED     1|0 — set 0 to run open on a trusted network
 *   HOST / PORT      default 127.0.0.1:3100
 *   EXTRACT_MODELS   comma-separated gateway model ids, tried in order
 *
 *   bun install
 *   MINIMEM_TOKEN=$(openssl rand -hex 16) bun run server.ts
 *   bun run server.ts --check     # open the DB, print stats, exit
 *
 * Backup: run Litestream next to it, replicating MINIMEM_DB_PATH to S3/R2/another disk.
 *   litestream replicate /var/lib/minimem/minimem.db s3://bucket/minimem
 */
import { Elysia, t } from "elysia";
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { createHash, timingSafeEqual } from "node:crypto";
import { generateObject } from "ai";
import { z } from "zod";

const env = (k: string) => process.env[k];
const DB_PATH = env("MINIMEM_DB_PATH") ?? env("DB_PATH") ?? "./data/minimem.db";
// MINIMEM_TOKEN is the canonical name; MEMORY_TOKEN still works (older deployments)
const API_KEY = env("MINIMEM_TOKEN") ?? env("MEMORY_TOKEN");
const UI_CODE = env("MINIMEM_LOCK") ?? env("MEM_LOCK"); // optional short code for the web UI
// AUTH_ENABLED=0 turns the bearer/basic guard off entirely (trust the network).
// Default is on, so an unconfigured deployment is never accidentally open.
const AUTH_ENABLED = !["0", "false", "no", "off"].includes(
  (env("AUTH_ENABLED") ?? "1").trim().toLowerCase(),
);
const PORT = Number(env("PORT") ?? 3100);
const HOST = env("HOST") ?? "127.0.0.1";
const MODELS = (env("EXTRACT_MODELS") ?? "google/gemini-2.5-flash-lite")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// ---------- CLI ----------
const NAME = "minimem";
const VERSION = "1.0.0";

function usage(): string {
  return `${NAME} ${VERSION} — small memory store for agents (Bun + Elysia + SQLite FTS5)

usage: bun run server.ts [options]

env:
  MINIMEM_DB_PATH   absolute path to the sqlite file   (default ./data/minimem.db)
  MINIMEM_TOKEN     long bearer token                  (required when AUTH_ENABLED=1)
  MINIMEM_LOCK      short web-UI code                  (optional, shows in the token sheet)
  AUTH_ENABLED      1|0  turn the API guard on/off     (default 1)
  HOST, PORT        bind address                       (default 127.0.0.1:3100)
  EXTRACT_MODELS    comma-separated gateway model ids  (/extract fallback chain)
  AI_GATEWAY_API_KEY  Vercel AI Gateway key            (only needed for /extract)

options:
  -h, --help      print this
  -V, --version   print version
  --check         open the DB, print stats, exit (no server)
`;
}

const argv = process.argv.slice(2);
if (argv.includes("-h") || argv.includes("--help")) {
  console.log(usage());
  process.exit(0);
}
if (argv.includes("-V") || argv.includes("--version")) {
  console.log(`${NAME} ${VERSION}`);
  process.exit(0);
}

if (AUTH_ENABLED && !API_KEY) throw new Error("MINIMEM_TOKEN (or MEMORY_TOKEN) is required when AUTH_ENABLED=1");
if (DB_PATH.includes("://")) throw new Error(`MINIMEM_DB_PATH must be a file path, got ${DB_PATH}`);
if (!isAbsolute(DB_PATH)) throw new Error(`MINIMEM_DB_PATH must be absolute, got ${DB_PATH}`);

const okHash = API_KEY ? createHash("sha256").update(API_KEY).digest() : null;
const uiHash = UI_CODE ? createHash("sha256").update(UI_CODE).digest() : null;
const hit = (h: Buffer, target: Buffer | null) => !!target && timingSafeEqual(h, target);
const eq = (a: string): boolean => {
  const b = a.trim();
  const h = createHash("sha256").update(b).digest();
  if (hit(h, okHash)) return true;
  return hit(h, uiHash);
};
// accepts "Bearer <token>", "Basic <b64(user:password)>" (user is cosmetic), or a bare token.
// the short UI_CODE (MINIMEM_LOCK) is accepted in place of the long token.
const auth = (raw: string | undefined): boolean => {
  if (!AUTH_ENABLED) return true;
  const a = (raw || "").trim();
  if (a.startsWith("Basic ")) {
    const dec = Buffer.from(a.slice(6), "base64").toString("utf8");
    const i = dec.indexOf(":");
    if (i < 0) return false;
    const user = dec.slice(0, i);
    return user.length > 0 && eq(dec.slice(i + 1));
  }
  if (a.startsWith("Bearer ")) return eq(a.slice(7));
  return eq(a);
};

// ---------- DB ----------
const SCHEMA_VERSION = 1;
mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH, { create: true });
db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;`);
db.exec(`
CREATE TABLE IF NOT EXISTS memories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  text       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);
-- every change keeps the old text, so nothing is ever truly lost
CREATE TABLE IF NOT EXISTS history (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id INTEGER NOT NULL,
  action    TEXT NOT NULL,          -- add | update | delete
  old_text  TEXT,
  at        TEXT NOT NULL DEFAULT (datetime('now'))
);
-- trigram tokenizer = substring search, works for Thai (no word spaces)
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(text, tokenize='trigram');
-- tags (aka agentmemory "concepts"): normalized, one row per (memory, tag)
CREATE TABLE IF NOT EXISTS tags (
  memory_id INTEGER NOT NULL,
  tag       TEXT NOT NULL,
  PRIMARY KEY (memory_id, tag)
);
CREATE INDEX IF NOT EXISTS tags_tag_idx ON tags(tag);
`);
{
  const cols = db.query("PRAGMA table_info(history)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "old_tags")) db.exec("ALTER TABLE history ADD COLUMN old_tags TEXT");
}

type Mem = {
  id: number;
  text: string;
  created_at: string;
  updated_at: string;
  tags?: string[];
};

const q = {
  insert: db.query("INSERT INTO memories(text) VALUES(?) RETURNING id"),
  ftsIns: db.query("INSERT INTO memories_fts(rowid, text) VALUES(?, ?)"),
  ftsDel: db.query("DELETE FROM memories_fts WHERE rowid = ?"),
  hist: db.query("INSERT INTO history(memory_id, action, old_text, old_tags) VALUES(?, ?, ?, ?)"),
  get: db.query("SELECT id, text, updated_at FROM memories WHERE id = ? AND deleted_at IS NULL"),
  upd: db.query("UPDATE memories SET text = ?, updated_at = datetime('now') WHERE id = ?"),
  del: db.query("UPDATE memories SET deleted_at = datetime('now') WHERE id = ?"),
  list: db.query(
    "SELECT id, text, created_at, updated_at FROM memories WHERE deleted_at IS NULL ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?",
  ),
  count: db.query("SELECT COUNT(*) AS n FROM memories WHERE deleted_at IS NULL"),
  dup: db.query("SELECT id FROM memories WHERE text = ? AND deleted_at IS NULL"),
  search: db.query(
    `SELECT m.id, m.text, m.created_at, m.updated_at
       FROM memories_fts f JOIN memories m ON m.id = f.rowid
      WHERE memories_fts MATCH ? AND m.deleted_at IS NULL
      ORDER BY rank LIMIT ?`,
  ),
  deletedList: db.query(
    "SELECT id, text, created_at, updated_at, deleted_at FROM memories WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT ? OFFSET ?",
  ),
  deletedCount: db.query("SELECT COUNT(*) AS n FROM memories WHERE deleted_at IS NOT NULL"),
  histCount: db.query("SELECT COUNT(*) AS n FROM history"),
  histFor: db.query(
    "SELECT action, old_text, old_tags, at FROM history WHERE memory_id = ? ORDER BY at DESC, id DESC LIMIT 50",
  ),
  restore: db.query(
    "UPDATE memories SET deleted_at = NULL, updated_at = datetime('now') WHERE id = ? AND deleted_at IS NOT NULL RETURNING id, text",
  ),
  // tags
  tagAdd: db.query("INSERT OR IGNORE INTO tags(memory_id, tag) VALUES(?, ?)"),
  tagDel: db.query("DELETE FROM tags WHERE memory_id = ?"),
  tagOf: db.query("SELECT tag FROM tags WHERE memory_id = ? ORDER BY tag"),
  tagCounts: db.query(
    `SELECT t.tag, COUNT(*) AS n FROM tags t JOIN memories m ON m.id = t.memory_id
      WHERE m.deleted_at IS NULL GROUP BY t.tag ORDER BY n DESC, t.tag ASC LIMIT ?`,
  ),
  tagIds: db.query(
    `SELECT t.memory_id FROM tags t JOIN memories m ON m.id = t.memory_id
      WHERE t.tag = ? AND m.deleted_at IS NULL`,
  ),
  tagTotal: db.query(
    `SELECT COUNT(DISTINCT t.tag) AS n FROM tags t JOIN memories m ON m.id = t.memory_id
      WHERE m.deleted_at IS NULL`,
  ),
};

/** normalize: trim, lowercase, collapse spaces, strip leading '#', drop empties, dedupe, cap 10 tags x 40 chars */
function normTags(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out = new Set<string>();
  for (const raw of input) {
    const t = String(raw ?? "").replace(/^#+/, "").replace(/\s+/g, " ").trim().toLowerCase();
    if (!t || t.length > 40) continue;
    out.add(t);
    if (out.size >= 10) break;
  }
  return [...out];
}

const tagsOf = (id: number): string[] => (q.tagOf.all(id) as { tag: string }[]).map((r) => r.tag);

function setTags(id: number, tags: string[]): void {
  q.tagDel.run(id);
  for (const t of tags) q.tagAdd.run(id, t);
}

/** attach tags to a list of memories */
function withTags(rows: Mem[]): Mem[] {
  if (!rows.length) return rows;
  const ids = rows.map((r) => r.id);
  const map = new Map<number, string[]>();
  const stmt = db.query(
    `SELECT memory_id, tag FROM tags WHERE memory_id IN (${ids.map(() => "?").join(",")}) ORDER BY tag`,
  );
  for (const r of stmt.all(...ids) as { memory_id: number; tag: string }[]) {
    const arr = map.get(r.memory_id) ?? [];
    arr.push(r.tag);
    map.set(r.memory_id, arr);
  }
  return rows.map((r) => ({ ...r, tags: map.get(r.id) ?? [] }));
}

function addMem(text: string, tags: string[] = []): number {
  const dup = q.dup.get(text) as { id: number } | null;
  if (dup) {
    if (tags.length) setTags(dup.id, tags);
    return dup.id;
  }
  const { id } = q.insert.get(text) as { id: number };
  q.ftsIns.run(id, text);
  q.hist.run(id, "add", null, null);
  if (tags.length) setTags(id, tags);
  return id;
}

function updateMem(id: number, text: string, tags?: string[]): boolean {
  const old = q.get.get(id) as Mem | null;
  if (!old) return false;
  const oldTags = tagsOf(id);
  q.hist.run(id, "update", old.text, oldTags.length ? JSON.stringify(oldTags) : null);
  q.upd.run(text, id);
  q.ftsDel.run(id);
  q.ftsIns.run(id, text);
  if (tags) setTags(id, tags);
  return true;
}

function deleteMem(id: number): boolean {
  const old = q.get.get(id) as Mem | null;
  if (!old) return false;
  const oldTags = tagsOf(id);
  q.hist.run(id, "delete", old.text, oldTags.length ? JSON.stringify(oldTags) : null);
  q.del.run(id);
  q.ftsDel.run(id);
  return true;
}

// ---------- Search ----------
const seg = new Intl.Segmenter("th", { granularity: "word" });

function keywords(input: string, max = 8): string[] {
  const out = new Set<string>();
  for (const s of seg.segment(input)) {
    if (!s.isWordLike) continue;
    const w = s.segment.replace(/"/g, "");
    if ([...w].length >= 3) out.add(w); // trigram needs >= 3 chars
    if (out.size >= max) break;
  }
  return [...out];
}

function search(query: string, limit = 10, tag?: string): Mem[] {
  const terms = keywords(query);
  if (!terms.length) return [];
  const match = terms.map((w) => `"${w}"`).join(" OR ");
  let rows = q.search.all(match, tag ? 500 : limit) as Mem[];
  if (tag) rows = rows.filter((m) => tagsOf(m.id).includes(tag)).slice(0, limit);
  return withTags(rows);
}

/** Newest memories, optionally restricted to one tag (list view / tag browse). */
function recent(limit: number, offset: number, tag?: string): Mem[] {
  if (tag) {
    const ids = (q.tagIds.all(tag) as { memory_id: number }[]).map((r) => r.memory_id);
    if (!ids.length) return [];
    const rows = db
      .query(
        `SELECT id, text, created_at, updated_at FROM memories
          WHERE deleted_at IS NULL AND id IN (${ids.map(() => "?").join(",")})
          ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`,
      )
      .all(...ids, limit, offset) as Mem[];
    return withTags(rows);
  }
  return withTags(q.list.all(limit, offset) as Mem[]);
}

function countRecent(tag?: string): number {
  if (!tag) return (q.count.get() as { n: number }).n;
  return (q.tagIds.all(tag) as { memory_id: number }[]).length;
}

/** Memories to show the extractor so it can update/skip instead of duplicating. */
function relevant(input: string): Mem[] {
  const { n } = q.count.get() as { n: number };
  if (n <= 150) return recent(150, 0); // small store: show everything
  const byId = new Map<number, Mem>();
  for (const m of search(input, 40)) byId.set(m.id, m);
  for (const m of recent(30, 0)) byId.set(m.id, m);
  return [...byId.values()];
}

// ---------- LLM extraction ----------
const OpsSchema = z.object({
  ops: z.array(
    z.object({
      op: z.enum(["add", "update", "delete"]),
      id: z.number().int().nullable().describe("required for update/delete, null for add"),
      text: z.string().nullable().describe("required for add/update, null for delete"),
      tags: z
        .array(z.string())
        .max(6)
        .nullable()
        .describe("2-5 short topical tags, lowercase, e.g. ['truck','deploy'] — null if unchanged"),
    }),
  ),
});

const SYSTEM = `You maintain a personal memory store about the user.
Given EXISTING MEMORIES (each as [id] text) and a NEW CONVERSATION, output a list of operations.

Keep only durable facts about the user: stable preferences, decisions made, ongoing projects, tools/stack, people and relationships that matter.
Do NOT keep: temporary moods, one-off questions, things that expire soon, facts you or the assistant made up, anything the user did not say themselves.
Never store secrets: passwords, API keys, card or ID numbers.

Rules:
- Each memory is ONE self-contained sentence, written in the language the user used.
- If new info contradicts or refines an existing memory, use "update" with that id (don't add a duplicate).
- If an existing memory is clearly no longer true, use "delete".
- If something is already covered, do nothing.
- If nothing is worth remembering, return {"ops": []}.
- Give every add/update 2-5 short lowercase tags naming its topic (e.g. tool, project, or domain). Reuse tags you see on EXISTING MEMORIES instead of inventing synonyms. For delete, tags is null.
- Be conservative. Prefer fewer, higher-quality memories.`;

type Op = z.infer<typeof OpsSchema>["ops"][number];

function applyOps(ops: Op[], existing: Mem[]) {
  const valid = new Set(existing.map((m) => m.id));
  const result = { added: 0, updated: 0, deleted: 0, skipped: 0 };
  db.transaction(() => {
    for (const o of ops.slice(0, 20)) {
      const text = o.text?.trim();
      const tags = normTags(o.tags);
      if (o.op === "add" && text && text.length <= 500) {
        addMem(text, tags);
        result.added++;
      } else if (o.op === "update" && o.id != null && valid.has(o.id) && text && text.length <= 500) {
        updateMem(o.id, text, tags.length ? tags : undefined) ? result.updated++ : result.skipped++;
      } else if (o.op === "delete" && o.id != null && valid.has(o.id)) {
        deleteMem(o.id) ? result.deleted++ : result.skipped++;
      } else result.skipped++;
    }
  })();
  return result;
}

async function extract(input: string) {
  const existing = relevant(input);
  const prompt =
    `EXISTING MEMORIES:\n` +
    (existing.map((m) => `[${m.id}] ${m.text}`).join("\n") || "(none)") +
    `\n\nNEW CONVERSATION:\n${input}`;

  let lastErr: unknown;
  for (const model of MODELS) {
    try {
      // plain "provider/model" string routes through the gateway
      // (gateway key comes from the standard AI_GATEWAY env var, set by run.sh)
      const { object } = await generateObject({
        model,
        schema: OpsSchema,
        system: SYSTEM,
        prompt,
        temperature: 0,
      });
      return { model, ...applyOps(object.ops, existing) };
    } catch (e) {
      lastErr = e; // rate limit / bad JSON / model down -> try next model
      console.error(`[extract] ${model} failed:`, e instanceof Error ? e.message : e);
    }
  }
  throw lastErr ?? new Error("no extraction model configured");
}

function restoreMem(id: number): boolean {
  const row = q.restore.get(id) as { id: number; text: string } | null;
  if (!row) return false;
  q.ftsDel.run(row.id);
  q.ftsIns.run(row.id, row.text);
  const tags = tagsOf(row.id);
  q.hist.run(row.id, "restore", null, tags.length ? JSON.stringify(tags) : null);
  return true;
}

db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`); // marks the DB file itself

const stats = () => ({
  live: (q.count.get() as { n: number }).n,
  deleted: (q.deletedCount.get() as { n: number }).n,
  history: (q.histCount.get() as { n: number }).n,
  tags: (q.tagTotal.get() as { n: number }).n,
});

const INDEX_HTML = new URL("./public/index.html", import.meta.url).pathname;

if (argv.includes("--check")) {
  console.log(
    `${NAME} ${VERSION}\ndb      ${DB_PATH}\nschema  user_version=${(db.query("PRAGMA user_version").get() as { user_version: number }).user_version}\nauth    ${AUTH_ENABLED ? "on" : "off"}\nstats   ${JSON.stringify(stats())}\nintegrity ${(db.query("PRAGMA quick_check").get() as { quick_check: string }).quick_check}`,
  );
  db.close();
  process.exit(0);
}

const app = new Elysia()
  .get("/health", () => ({ ok: true, name: NAME, version: VERSION, auth: AUTH_ENABLED }))
  // web UI is public; API below the guard stays token-authed
  .get("/", () =>
    new Response(Bun.file(INDEX_HTML), {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    }),
  )
  .onBeforeHandle(({ headers, set }) => {
    // AUTH_ENABLED=0 -> this whole guard is a no-op (auth() returns true)
    if (!auth(headers.authorization)) {
      set.status = 401;
      set.headers["WWW-Authenticate"] = `Basic realm="${NAME}", charset="UTF-8"`;
      return { error: "unauthorized", hint: "send Authorization: Bearer <MINIMEM_TOKEN>" };
    }
  })
  // manual add
  .post(
    "/memories",
    ({ body }) => ({ id: addMem(body.text.trim(), normTags(body.tags)) }),
    {
      body: t.Object({
        text: t.String({ minLength: 1, maxLength: 4000 }),
        tags: t.Optional(t.Array(t.String({ maxLength: 40 }), { maxItems: 10 })),
      }),
    },
  )
  // recent list (optional ?tag= to browse one tag)
  .get("/memories", ({ query }) => {
    const limit = Math.min(Number(query.limit ?? 50), 200);
    const offset = Math.max(Number(query.offset ?? 0), 0);
    const tag = normTags([query.tag])[0];
    return { total: countRecent(tag), items: recent(limit, offset, tag) };
  })
  // recall (optional ?tag= to constrain)
  .get("/memories/search", ({ query }) =>
    search(query.q ?? "", Math.min(Number(query.limit ?? 10), 50), normTags([query.tag])[0]),
  )
  // all tags with counts (for the filter bar)
  .get("/tags", ({ query }) => ({
    total: (q.tagTotal.get() as { n: number }).n,
    tags: q.tagCounts.all(Math.min(Number(query.limit ?? 120), 400)) as { tag: string; n: number }[],
  }))
  // trash (soft-deleted, recoverable)
  .get("/memories/deleted", ({ query }) => {
    const limit = Math.min(Number(query.limit ?? 50), 200);
    const offset = Math.max(Number(query.offset ?? 0), 0);
    return {
      total: (q.deletedCount.get() as { n: number }).n,
      items: withTags(q.deletedList.all(limit, offset) as Mem[]),
    };
  })
  .post("/memories/:id/restore", ({ params, set }) => {
    if (!restoreMem(Number(params.id))) {
      set.status = 404;
      return { error: "not found" };
    }
    return { ok: true };
  })
  .get("/memories/:id/history", ({ params }) => q.histFor.all(Number(params.id)))
  .get("/stats", () => stats())
  .patch(
    "/memories/:id",
    ({ params, body, set }) => {
      const tags = body.tags === undefined ? undefined : normTags(body.tags);
      if (!updateMem(Number(params.id), body.text.trim(), tags)) {
        set.status = 404;
        return { error: "not found" };
      }
      return { ok: true };
    },
    {
      body: t.Object({
        text: t.String({ minLength: 1, maxLength: 4000 }),
        tags: t.Optional(t.Array(t.String({ maxLength: 40 }), { maxItems: 10 })),
      }),
    },
  )
  // soft delete (recoverable from history)
  .delete("/memories/:id", ({ params, set }) => {
    if (!deleteMem(Number(params.id))) {
      set.status = 404;
      return { error: "not found" };
    }
    return { ok: true };
  })
  // LLM extraction: send raw text or a conversation, store what's worth remembering
  .post("/extract", async ({ body, set }) => {
    try {
      return await extract(body.text);
    } catch (e) {
      set.status = 502;
      return { error: "extraction failed", detail: e instanceof Error ? e.message : String(e) };
    }
  }, { body: t.Object({ text: t.String({ minLength: 1, maxLength: 20000 }) }) })
  .listen({ port: PORT, hostname: HOST });

console.log(`${NAME} ${VERSION} on http://${HOST}:${PORT} — auth ${AUTH_ENABLED ? "on" : "off"} — db ${DB_PATH}`);

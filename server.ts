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
 *   MINIMEM_MCP      1|0 — set 0 to disable the POST /mcp JSON-RPC endpoint
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
// MINIMEM_MCP=0 disables the POST /mcp JSON-RPC endpoint (agents lose memory tools).
const MCP_ENABLED = !["0", "false", "no", "off"].includes(
  (env("MINIMEM_MCP") ?? "1").trim().toLowerCase(),
);
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
  MINIMEM_MCP       1|0  serve the POST /mcp endpoint    (default 1)
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
// ---------- auth attempt throttling (per IP) ----------
// A failed attempt is not just rejected: it burns a slot. Enough slots gone
// means the server stops answering 401 and starts answering 429 for that IP,
// so an online guessing attack on the short UI_CODE costs the attacker time
// instead of running open-loop. In-memory: a restart clears the slate.
type Bucket = { fails: number; windowEnd: number; lockedUntil: number };
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const FAIL_CAP = 10;
const LOCKOUT_MS = 15 * 60 * 1000;
const failBuckets = new Map<string, Bucket>();

const bucketKey = (ip: string): string => ip || "unknown";

/** Drops buckets whose window elapsed and that are not locked, so the map stays small. */
const pruneBuckets = () => {
  const now = Date.now();
  for (const [k, b] of failBuckets) if (b.lockedUntil <= now && b.windowEnd <= now) failBuckets.delete(k);
};

/** ms remaining on the lockout, or 0 when this IP is not locked out. */
function lockedFor(ip: string): number {
  const b = failBuckets.get(bucketKey(ip));
  if (!b) return 0;
  const left = b.lockedUntil - Date.now();
  return left > 0 ? left : 0;
}

/** Records a failure; @returns attempts left before lockout (0 = now locked). */
function noteFail(ip: string): number {
  pruneBuckets();
  const k = bucketKey(ip);
  const now = Date.now();
  const b = failBuckets.get(k);
  // no bucket, or the old window elapsed and no lock is active -> start over
  const b2: Bucket = !b || now >= b.windowEnd ? { fails: 0, windowEnd: 0, lockedUntil: 0 } : b;
  b2.fails++;
  b2.windowEnd = now + FAIL_WINDOW_MS;
  if (b2.fails >= FAIL_CAP) b2.lockedUntil = now + LOCKOUT_MS;
  failBuckets.set(k, b2);
  return b2.lockedUntil > now ? 0 : FAIL_CAP - b2.fails;
}

/** Clears the failure counter — a correct token is not an attack. */
function notePass(ip: string) {
  failBuckets.delete(bucketKey(ip));
}

/** Socket peer address, or "" when the runtime does not expose one. */
function requestIP(request: Request): string {
  const srv = (request as unknown as { server?: { requestIP?: (r: Request) => string | null } }).server;
  try {
    return srv?.requestIP?.(request) ?? "";
  } catch {
    return "";
  }
}

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
const SCHEMA_VERSION = 2;
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
-- ---------- v2: relay / handoff / lease / lessons / crystals / audit ----------
-- a note one agent leaves for another (or for a future session of itself)
CREATE TABLE IF NOT EXISTS handoffs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  from_agent TEXT NOT NULL,
  to_agent   TEXT NOT NULL,
  topic      TEXT,
  body       TEXT NOT NULL,
  refs       TEXT,                    -- JSON array of memory ids / urls
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  read_at    TEXT,
  acked_at   TEXT
);
CREATE INDEX IF NOT EXISTS handoffs_to_idx ON handoffs(to_agent, acked_at);
-- named lock so two agents do not edit the same thing at once
CREATE TABLE IF NOT EXISTS leases (
  name        TEXT PRIMARY KEY,
  holder      TEXT NOT NULL,
  note        TEXT,
  acquired_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL
);
-- durable "do it this way" rules learned while working
CREATE TABLE IF NOT EXISTS lessons (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  text       TEXT NOT NULL,
  scope      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);
-- merged / summarised memories (the long-term view)
CREATE TABLE IF NOT EXISTS crystals (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  text       TEXT NOT NULL,
  sources    TEXT,                    -- JSON array of memory ids
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);
-- who changed what, through REST or MCP
CREATE TABLE IF NOT EXISTS audit (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  actor  TEXT,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT,
  at     TEXT NOT NULL DEFAULT (datetime('now'))
);
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
  // hard delete: rows only, so a purge cannot resurrect FTS/tag ghosts.
  trashedText: db.query("SELECT text FROM memories WHERE id = ? AND deleted_at IS NOT NULL"),
  hardDel: db.query("DELETE FROM memories WHERE id = ? AND deleted_at IS NOT NULL RETURNING id"),
  hardDelTags: db.query("DELETE FROM tags WHERE memory_id = ?"),
  hardDelHist: db.query("DELETE FROM history WHERE memory_id = ?"),
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

// ---------- v2 queries: handoffs / leases / lessons / crystals / audit ----------
const r = {
  hoIns: db.query(
    "INSERT INTO handoffs(from_agent, to_agent, topic, body, refs) VALUES(?, ?, ?, ?, ?) RETURNING id, created_at",
  ),
  hoList: db.query(
    `SELECT id, from_agent, to_agent, topic, body, refs, created_at, read_at, acked_at
       FROM handoffs WHERE to_agent = ? AND (? IS NULL OR acked_at IS NULL)
      ORDER BY id DESC LIMIT ?`,
  ),
  hoGet: db.query("SELECT * FROM handoffs WHERE id = ?"),
  hoRead: db.query("UPDATE handoffs SET read_at = COALESCE(read_at, datetime('now')) WHERE id = ? AND to_agent = ?"),
  hoAck: db.query("UPDATE handoffs SET read_at = COALESCE(read_at, datetime('now')), acked_at = datetime('now') WHERE id = ? AND to_agent = ?"),
  hoPending: db.query("SELECT COUNT(*) AS n FROM handoffs WHERE to_agent = ? AND acked_at IS NULL"),
  leList: db.query("SELECT name, holder, note, acquired_at, expires_at FROM leases"),
  leGet: db.query("SELECT * FROM leases WHERE name = ?"),
  leUp: db.query(
    `INSERT INTO leases(name, holder, note, expires_at) VALUES(?, ?, ?, datetime('now', ?))
     ON CONFLICT(name) DO UPDATE SET holder = excluded.holder, note = excluded.note,
       acquired_at = datetime('now'), expires_at = excluded.expires_at
     RETURNING name, holder, acquired_at, expires_at`,
  ),
  leDel: db.query("DELETE FROM leases WHERE name = ? AND holder = ?"),
  lePurge: db.query("DELETE FROM leases WHERE expires_at < datetime('now')"),
  lsIns: db.query("INSERT INTO lessons(text, scope) VALUES(?, ?) RETURNING id"),
  lsList: db.query(
    "SELECT id, text, scope, created_at FROM lessons WHERE deleted_at IS NULL AND (? IS NULL OR scope = ?) ORDER BY id DESC LIMIT ?",
  ),
  lsSearch: db.query(
    "SELECT id, text, scope, created_at FROM lessons WHERE deleted_at IS NULL AND text LIKE ? ORDER BY id DESC LIMIT ?",
  ),
  crIns: db.query("INSERT INTO crystals(text, sources) VALUES(?, ?) RETURNING id"),
  crList: db.query("SELECT id, text, sources, created_at FROM crystals WHERE deleted_at IS NULL ORDER BY id DESC LIMIT ?"),
  auIns: db.query("INSERT INTO audit(actor, action, target, detail) VALUES(?, ?, ?, ?)"),
  auList: db.query("SELECT id, actor, action, target, detail, at FROM audit ORDER BY id DESC LIMIT ?"),
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

/**
 * Hard delete a trashed memory. Only rows that are already soft-deleted can be
 * purged, so a wrong id can never destroy live data. Irreversible by design —
 * that is the whole point of a purge. The caller is expected to have asked.
 * @returns the purged text (handy for an audit line), or null if not trashed.
 */
function purgeMem(id: number): string | null {
  // read first: hardDel returns the row it just removed
  const before = q.trashedText.get(id) as { text: string } | null;
  if (!before) return null;
  const row = q.hardDel.get(id) as { id: number } | null;
  if (!row) return null;
  q.ftsDel.run(row.id);
  q.hardDelTags.run(row.id);
  q.hardDelHist.run(row.id);
  audit("system", "purge", `memory:${id}`, { chars: before.text.length });
  return before.text;
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

// ---------- v2: relay / handoff / lease / lessons / crystals / audit ----------
const audit = (actor: string, action: string, target?: string, detail?: unknown) => {
  try {
    r.auIns.run(actor || "unknown", action, target ?? null, detail == null ? null : JSON.stringify(detail).slice(0, 2000));
  } catch { /* audit must never break the write it records */ }
};

const REFS = (v: unknown): string | null =>
  Array.isArray(v) && v.length ? JSON.stringify(v.slice(0, 50)) : null;
const parseRefs = (v: string | null): unknown[] => {
  if (!v) return [];
  try { const a = JSON.parse(v); return Array.isArray(a) ? a : []; } catch { return []; }
};

function handoffWrite(from: string, to: string, body: string, topic?: string, refs?: unknown) {
  const row = r.hoIns.get(from, to, topic ?? null, body, REFS(refs)) as { id: number; created_at: string };
  audit(from, "handoff_write", `handoff:${row.id}`, { to, topic });
  return row;
}

/** unacked=false returns history too; default only pending */
function handoffRead(agent: string, unackedOnly = true, limit = 20) {
  const rows = r.hoList.all(agent, unackedOnly ? 1 : null, Math.min(limit, 100)) as Record<string, unknown>[];
  return rows.map((h) => ({ ...h, refs: parseRefs(h.refs as string | null) }));
}

function handoffAck(agent: string, id: number): boolean {
  const cur = r.hoGet.get(id) as { to_agent: string } | null;
  if (!cur || cur.to_agent !== agent) return false;
  r.hoAck.run(id, agent);
  audit(agent, "handoff_ack", `handoff:${id}`);
  return true;
}

function leaseAcquire(name: string, holder: string, note?: string, ttlMinutes = 30) {
  const ttl = `+${Math.max(1, Math.min(Number(ttlMinutes) || 30, 1440))} minutes`;
  const live = r.leGet.get(name) as { holder: string; expires_at: string } | null;
  const expired = live ? Date.parse(live.expires_at.replace(" ", "T") + "Z") < Date.now() : true;
  if (live && live.holder !== holder && !expired) {
    return { ok: false as const, held_by: live.holder, expires_at: live.expires_at };
  }
  const row = r.leUp.get(name, holder, note ?? null, ttl) as Record<string, unknown>;
  audit(holder, "lease_acquire", `lease:${name}`, { ttl_minutes: ttlMinutes });
  return { ok: true as const, ...row };
}

function leaseRelease(name: string, holder: string): boolean {
  const cur = r.leGet.get(name) as { holder: string } | null;
  if (!cur || cur.holder !== holder) return false;
  r.leDel.run(name, holder);
  audit(holder, "lease_release", `lease:${name}`);
  return true;
}

function lessonSave(text: string, scope?: string) {
  const row = r.lsIns.get(text, scope ?? null) as { id: number };
  audit(scope ?? "mcp", "lesson_save", `lesson:${row.id}`);
  return row;
}
const lessonList = (scope: string | undefined, limit: number) =>
  scope
    ? (r.lsList.all(scope, scope, Math.min(limit, 200)) as Record<string, unknown>[])
    : (r.lsList.all(null, null, Math.min(limit, 200)) as Record<string, unknown>[]);

function crystalSave(text: string, sources?: unknown) {
  const row = r.crIns.get(text, REFS(sources)) as { id: number };
  audit("mcp", "crystal_save", `crystal:${row.id}`);
  return row;
}
const crystalList = (limit: number) => r.crList.all(Math.min(limit, 200)) as Record<string, unknown>[];

function relayStats() {
  r.lePurge.run();
  return {
    handoffs: (db.query("SELECT COUNT(*) AS n FROM handoffs").get() as { n: number }).n,
    leases: (db.query("SELECT COUNT(*) AS n FROM leases").get() as { n: number }).n,
    lessons: (db.query("SELECT COUNT(*) AS n FROM lessons WHERE deleted_at IS NULL").get() as { n: number }).n,
    crystals: (db.query("SELECT COUNT(*) AS n FROM crystals WHERE deleted_at IS NULL").get() as { n: number }).n,
    audit: (db.query("SELECT COUNT(*) AS n FROM audit").get() as { n: number }).n,
  };
}

// ---------- MCP: JSON-RPC 2.0 over streamable HTTP (POST /mcp) ----------
type Rpc = { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };

const toolText = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });
const toolErr = (msg: string) => ({ content: [{ type: "text" as const, text: msg }], isError: true });

const MCP_TOOLS = [
  { name: "memory_save", description: "Store one durable fact. Dedupes identical text and returns the existing id.", inputSchema: { type: "object", properties: { text: { type: "string" }, tags: { type: "array", items: { type: "string" } }, agent: { type: "string" } }, required: ["text"] } },
  { name: "memory_search", description: "Full-text (trigram) search over memories; works for Thai and substring queries.", inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" }, tag: { type: "string" } }, required: ["query"] } },
  { name: "memory_recent", description: "Newest memories, optionally filtered by tag and paged.", inputSchema: { type: "object", properties: { limit: { type: "number" }, offset: { type: "number" }, tag: { type: "string" } } } },
  { name: "memory_forget", description: "Soft-delete a memory (recoverable from /memories/deleted).", inputSchema: { type: "object", properties: { id: { type: "number" }, agent: { type: "string" } }, required: ["id"] } },
  { name: "lesson_save", description: "Record a durable 'do it this way' rule learned while working.", inputSchema: { type: "object", properties: { text: { type: "string" }, scope: { type: "string" } }, required: ["text"] } },
  { name: "lesson_list", description: "List lessons, optionally scoped to a project or tool.", inputSchema: { type: "object", properties: { scope: { type: "string" }, limit: { type: "number" } } } },
  { name: "handoff_write", description: "Leave a note for another agent (or your future self).", inputSchema: { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, topic: { type: "string" }, body: { type: "string" }, refs: { type: "array" } }, required: ["from", "to", "body"] } },
  { name: "handoff_read", description: "Read handoffs addressed to you. unacked=false includes already-acked ones.", inputSchema: { type: "object", properties: { agent: { type: "string" }, unacked: { type: "boolean" }, limit: { type: "number" } }, required: ["agent"] } },
  { name: "handoff_ack", description: "Mark a handoff as done.", inputSchema: { type: "object", properties: { agent: { type: "string" }, id: { type: "number" } }, required: ["agent", "id"] } },
  { name: "lease_acquire", description: "Take a named lock so two agents do not edit the same thing. Returns held_by if someone else has it.", inputSchema: { type: "object", properties: { name: { type: "string" }, holder: { type: "string" }, note: { type: "string" }, ttl_minutes: { type: "number" } }, required: ["name", "holder"] } },
  { name: "lease_release", description: "Release a lease you hold.", inputSchema: { type: "object", properties: { name: { type: "string" }, holder: { type: "string" } }, required: ["name", "holder"] } },
  { name: "crystal_save", description: "Store a merged/summarised memory (the long-term view).", inputSchema: { type: "object", properties: { text: { type: "string" }, sources: { type: "array" } }, required: ["text"] } },
  { name: "memory_stats", description: "Counts of memories, handoffs, leases, lessons, crystals, audit rows.", inputSchema: { type: "object", properties: {} } },
];

function mcpCall(name: string, a: Record<string, unknown>) {
  const str = (k: string) => String(a[k] ?? "").trim();
  const num = (k: string, d: number) => (Number.isFinite(Number(a[k])) ? Number(a[k]) : d);
  switch (name) {
    case "memory_save": {
      const text = str("text");
      if (!text) return toolErr("text is required");
      const before = (q.count.get() as { n: number }).n;
      const id = addMem(text.slice(0, 4000), normTags(a.tags));
      const after = (q.count.get() as { n: number }).n;
      if (after === before) return toolText({ id, status: "duplicate" });
      audit(str("agent") || "mcp", "memory_save", `memory:${id}`);
      return toolText({ id, status: "saved" });
    }
    case "memory_search": {
      const qq = str("query");
      if (!qq) return toolErr("query is required");
      const items = search(qq, Math.min(num("limit", 10), 50), normTags([a.tag])[0]);
      return toolText({ total: items.length, items });
    }
    case "memory_recent": {
      const tag = normTags([a.tag])[0];
      return toolText({ total: countRecent(tag), items: recent(Math.min(num("limit", 20), 200), Math.max(num("offset", 0), 0), tag) });
    }
    case "memory_forget": {
      const id = num("id", 0);
      if (!deleteMem(id)) return toolErr(`memory ${id} not found`);
      audit(str("agent") || "mcp", "memory_forget", `memory:${id}`);
      return toolText({ ok: true, id });
    }
    case "lesson_save": {
      const text = str("text");
      if (!text) return toolErr("text is required");
      return toolText(lessonSave(text.slice(0, 2000), a.scope ? normTags([a.scope])[0] : undefined));
    }
    case "lesson_list": return toolText({ items: lessonList(a.scope ? normTags([a.scope])[0] : undefined, num("limit", 50)) });
    case "handoff_write": {
      const from = str("from"), to = str("to"), body = str("body");
      if (!from || !to || !body) return toolErr("from, to and body are required");
      return toolText(handoffWrite(from, to, body.slice(0, 8000), a.topic ? String(a.topic).slice(0, 200) : undefined, a.refs));
    }
    case "handoff_read": {
      const agent = str("agent");
      if (!agent) return toolErr("agent is required");
      const items = handoffRead(agent, a.unacked !== false, num("limit", 20));
      return toolText({ total: items.length, items });
    }
    case "handoff_ack": {
      const agent = str("agent"), id = num("id", 0);
      if (!handoffAck(agent, id)) return toolErr(`handoff ${id} not found for ${agent}`);
      return toolText({ ok: true, id });
    }
    case "lease_acquire": {
      const lname = str("name"), holder = str("holder");
      if (!lname || !holder) return toolErr("name and holder are required");
      return toolText(leaseAcquire(lname, holder, a.note ? String(a.note) : undefined, num("ttl_minutes", 30)));
    }
    case "lease_release": {
      const lname = str("name"), holder = str("holder");
      if (!leaseRelease(lname, holder)) return toolErr(`lease ${lname} is not held by ${holder}`);
      return toolText({ ok: true, name: lname });
    }
    case "crystal_save": {
      const text = str("text");
      if (!text) return toolErr("text is required");
      return toolText(crystalSave(text.slice(0, 4000), a.sources));
    }
    case "memory_stats": return toolText({ ...stats(), relay: relayStats() });
    default: return null;
  }
}

async function handleMcp(body: Rpc): Promise<{ status: number; body: unknown }> {
  const id = body?.id ?? null;
  const method = String(body?.method ?? "");
  const params = (body?.params ?? {}) as Record<string, unknown>;
  const ok = (result: unknown) => ({ status: 200, body: { jsonrpc: "2.0", id, result } });

  // notifications carry no id and must not get a JSON-RPC response body
  if (method.startsWith("notifications/")) return { status: 202, body: null };

  switch (method) {
    case "initialize":
      return ok({
        protocolVersion: String(params.protocolVersion ?? "2024-11-05"),
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: NAME, version: VERSION },
        instructions: `Shared agent memory: ${(q.count.get() as { n: number }).n} memories. Save durable facts with memory_save; hand work between agents with handoff_write/handoff_read.`,
      });
    case "ping": return ok({});
    case "tools/list": return ok({ tools: MCP_TOOLS });
    case "tools/call": {
      const name = String(params.name ?? "");
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const res = mcpCall(name, args);
      if (!res) return { status: 200, body: { jsonrpc: "2.0", id, error: { code: -32602, message: `unknown tool: ${name}` } } };
      return ok(res);
    }
    default:
      return { status: 200, body: { jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } } };
  }
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
  .onBeforeHandle(({ headers, set, request }) => {
    // AUTH_ENABLED=0 -> the whole guard is a no-op (auth() returns true)
    if (!AUTH_ENABLED) return;
    // Caddy proxies in front of us, so the socket peer is always 127.0.0.1.
    // Prefer Caddy's X-Forwarded-For (first entry = original client).
    const xff = headers["x-forwarded-for"];
    const ip = Array.isArray(xff) ? (xff[0] ?? "").trim() : (xff || "").split(",")[0].trim();
    const key = ip || requestIP(request) || "unknown";

    // A correct token always passes, even during a lockout. Ordering matters:
    // locking out valid credentials turns the throttle into a denial-of-service
    // lever (10 wrong guesses from a shared IP locks the real user out for the
    // whole window). The throttle's job is to slow guessing, not to punish.
    const lockLeft = lockedFor(key);
    if (auth(headers.authorization)) {
      // Reset the counter only when we are NOT locked out. Inside a lockout a
      // valid token proves nothing about intent (the attacker can interleave one
      // known-good guess), so the counter survives — otherwise the throttle is
      // defeated by alternating one right guess with nine wrong ones.
      if (lockLeft === 0) notePass(key);
      return;
    }

    if (lockLeft > 0) {
      set.status = 429;
      set.headers["Retry-After"] = String(Math.ceil(lockLeft / 1000));
      return { error: "too many failed auth attempts", retry_after_s: Math.ceil(lockLeft / 1000) };
    }
    const remaining = noteFail(key);
    set.status = 401;
    set.headers["WWW-Authenticate"] = `Basic realm="${NAME}", charset="UTF-8"`;
    set.headers["X-Auth-Attempts-Left"] = String(remaining);
    return { error: "unauthorized", attempts_left: remaining, hint: "send Authorization: Bearer ***" };
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
  .get("/stats", () => ({ ...stats(), relay: relayStats() }))
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
  // hard delete — trashed rows only, irreversible. Requires an explicit confirm
  // in the query string so a stray DELETE (or a retry) cannot destroy data.
  .delete("/memories/:id/purge", ({ params, query, set }) => {
    if (query.confirm !== "yes") {
      set.status = 400;
      return { error: "confirmation required", hint: "DELETE /memories/:id/purge?confirm=yes" };
    }
    const id = Number(params.id);
    const text = purgeMem(id);
    if (text === null) {
      set.status = 404;
      return { error: "not found or not trashed", hint: "only soft-deleted memories can be purged" };
    }
    return { ok: true, purged: id, chars: text.length };
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

  // ---------- relay REST (mirrors the MCP tools) ----------
  .post(
    "/handoff",
    ({ body }) => {
      const row = handoffWrite(body.from, body.to, body.body, body.topic, body.refs);
      return { ok: true, ...row };
    },
    {
      body: t.Object({
        from: t.String({ minLength: 1, maxLength: 64 }),
        to: t.String({ minLength: 1, maxLength: 64 }),
        body: t.String({ minLength: 1, maxLength: 8000 }),
        topic: t.Optional(t.String({ maxLength: 200 })),
        refs: t.Optional(t.Array(t.Unknown())),
      }),
    },
  )
  .get("/handoff", ({ query }) => {
    const agent = String(query.agent ?? "").trim();
    if (!agent) return { total: 0, items: [], error: "agent query param required" };
    const items = handoffRead(agent, query.all !== "1", Math.min(Number(query.limit ?? 20), 100));
    return { total: items.length, items };
  })
  .post("/handoff/:id/ack", ({ params, body, set }) => {
    if (!handoffAck(body.agent, Number(params.id))) {
      set.status = 409;
      return { error: "handoff not found for that agent" };
    }
    return { ok: true };
  }, { body: t.Object({ agent: t.String({ minLength: 1, maxLength: 64 }) }) })
  .get("/leases", () => ({ items: r.leList.all() }))
  .post(
    "/leases",
    ({ body, set }) => {
      const res = leaseAcquire(body.name, body.holder, body.note, body.ttl_minutes);
      if (!res.ok) set.status = 409;
      return res;
    },
    {
      body: t.Object({
        name: t.String({ minLength: 1, maxLength: 64 }),
        holder: t.String({ minLength: 1, maxLength: 64 }),
        note: t.Optional(t.String({ maxLength: 500 })),
        ttl_minutes: t.Optional(t.Number()),
      }),
    },
  )
  .delete("/leases/:name", ({ params, query, set }) => {
    const holder = String(query.holder ?? "").trim();
    if (!holder || !leaseRelease(params.name, holder)) {
      set.status = 409;
      return { error: "lease is not held by that holder" };
    }
    return { ok: true };
  })
  .get("/lessons", ({ query }) => ({
    items: lessonList(normTags([query.scope])[0], Math.min(Number(query.limit ?? 50), 200)),
  }))
  .post(
    "/lessons",
    ({ body }) => lessonSave(body.text.trim(), body.scope ? normTags([body.scope])[0] : undefined),
    {
      body: t.Object({
        text: t.String({ minLength: 1, maxLength: 2000 }),
        scope: t.Optional(t.String({ maxLength: 40 })),
      }),
    },
  )
  .get("/crystals", ({ query }) => ({ items: crystalList(Math.min(Number(query.limit ?? 50), 200)) }))
  .post(
    "/crystals",
    ({ body }) => crystalSave(body.text.trim(), body.sources),
    {
      body: t.Object({
        text: t.String({ minLength: 1, maxLength: 4000 }),
        sources: t.Optional(t.Array(t.Unknown())),
      }),
    },
  )
  .get("/audit", ({ query }) => ({ items: r.auList.all(Math.min(Number(query.limit ?? 50), 200)) }))

  // ---------- MCP: JSON-RPC 2.0 over streamable HTTP ----------
  .get("/mcp", ({ set }) => {
    set.status = 405;
    set.headers["Allow"] = "POST";
    return { error: "method not allowed", hint: "POST JSON-RPC 2.0 to /mcp" };
  })
  .post("/mcp", async ({ body, set }) => {
    if (!MCP_ENABLED) {
      set.status = 503;
      return { jsonrpc: "2.0", id: null, error: { code: -32000, message: "MCP endpoint disabled (MINIMEM_MCP=0)" } };
    }
    const out = await handleMcp(body as Rpc);
    set.status = out.status as never;
    if (out.body === null) return new Response(null, { status: out.status });
    return out.body;
  }, { body: t.Object({ jsonrpc: t.Optional(t.String()), id: t.Optional(t.Unknown()), method: t.String(), params: t.Optional(t.Object({}, { additionalProperties: true })) }) })

  .listen({ port: PORT, hostname: HOST });

console.log(`${NAME} ${VERSION} on http://${HOST}:${PORT} — auth ${AUTH_ENABLED ? "on" : "off"} — db ${DB_PATH}`);

# AGENTS.md — minimem

Shared, persistent memory store for all lab agents (Hermes / Opencode / Pig / Crush).
One SQLite (FTS5 **trigram**) file + one Bun process + REST + web UI + MCP. No embeddings.

## This project in one line
The lab's canonical **memory** (cross-session knowledge). NOT project docs — those live in
each project's `AGENTS.md`. minimem memory and project AGENTS.md are separate; read both.

## Stack
- Bun 1.1+ + Elysia, single file `server.ts`. SQLite via `bun:sqlite`, WAL mode.
- FTS5 **trigram** tokenizer — works for Thai/Chinese/Japanese without a segmenter.
- Thai-safety: the search path uses `search_kw.ts` (two-pass: identifiers longest-first +
  segmenter words, EN/TH stopwords, cap 8→24 terms, quoted terms). **Do not** replace with
  plain `match()` — identifiers get split mid-way (fixed 2026-10-06, test in `search.test.ts`).

## Run / dev
```sh
bun install
MINIMEM_ENV=~/minimem.env ./run.sh          # read env from file, no secret in shell
MINIMEM_ENV=/etc/minimem/minimem.env bun run server.ts --check   # integrity check, no bind
bun test search.test.ts                      # search regression tests
```

## Config (env — all via MINIMEM_ENV, nothing committed)
- `MINIMEM_DB_PATH` → default `./data/minimem.db` (on this lab: `/home/admin/minimem-data/…`)
- `MINIMEM_TOKEN` — long bearer; `MINIMEM_LOCK` — short 8-char web-UI code
- `AUTH_ENABLED` (1 default), `MINIMEM_MCP` (1 default → serves `POST /mcp`)
- `HOST`/`PORT` default `127.0.0.1:3100`
- `EXTRACT_MODELS` + `AI_GATEWAY_API_KEY` — only needed by `POST /extract`
- Aliases still accepted: `MEMORY_TOKEN`, `MEM_LOCK`
- **Secret-heavy database**: `/` and `/health` are public; everything else guard-auth'd.
  Never bind `0.0.0.0` with auth off.

## Key paths (this lab, not re-derivable)
- Server: `:3100` (localhost REST + MCP + web UI)
- LAN via Caddy: web UI `https://lan.mcky.space:3444/`, MCP+relay `https://lan.mcky.space:3145/`
- Service: OpenRC `minimem` (init `/etc/init.d/minimem`, env `/etc/minimem/minimem.env`)
- Data dir: `/home/admin/minimem-data/`
- Hermes plugin: `~/.hermes/plugins/minimem/` (plugin.yaml + __init__.py, MCP tools `minimem_*`)
- Copied legacy: `~/projects/memory-service/` — the ORIGINAL minimem (same schema); **stopped/legacy, do not run it**.

## API essentials
- `GET /health` → `{ok,name,version,auth}` · `GET /stats` → `{live,deleted,history,tags}`
- `GET /memories?tag=&limit=&offset=&q=` · `POST /memories` (single object `{text,tags}`,
  exact duplicate → returns existing id with tags merged)
- `GET /memories/search?q=&tag=&limit=` — FTS5 trigram, ranked (keep base `ORDER BY rank`)
- Soft deletes: `GET /memories/deleted` · `POST /memories/:id/restore`
- `GET /memories/:id/history` — every version · `GET /tags` — tag cloud (live only)
- Relay: `/handoff` (write/read/ack), `/leases`, `/lessons`, `/crystals`, `/audit`
- `POST /mcp` — JSON-RPC 2.0 streamable HTTP (13 tools: memory_save/search/recent/forget,
  lesson_save/list, handoff_write/read/ack, lease_acquire/release, crystal_save, memory_stats)

## Durability
- Every write journaled to `history` (previous text+tags) before it lands.
- `DELETE` = soft (`deleted_at` set, row kept). WAL mode, `PRAGMA user_version` = schema version.
- Backup: `sqlite3 <db> ".backup out.db"` (online) — keep off-box, file stays <10 MB.
- OpenRC stop-then-start beats `restart` (supervise-daemon can leave a child holding the port).

## Conventions
- `--check` verifies integrity without binding the port (used in Cronie/health probes).
- Search ranking is deliberately NOT tuned with embeddings — keep it FTS5-only.

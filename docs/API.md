# minimem API reference

Full reference for the minimem HTTP API, LLM settings, and public deployment.
For a short overview and quick start see [../README.md](../README.md).
Per-client (MCP) setup lives in [INSTALL.md](INSTALL.md); the same-fact relation
model in [same-fact.md](same-fact.md).

## Base URL and content type

- Base: `http://HOST:PORT` (default `http://0.0.0.0:3100`).
- All bodies are JSON (`Content-Type: application/json`), UTF-8.
- Timestamps are UTC strings (`YYYY-MM-DD HH:MM:SS`) produced by SQLite.
- IDs are autoincrement integers.

## Authentication

When `AUTH_ENABLED=1` (default) every route except `/`, `/health`, and the static
assets (`/favicon.ico`, `/apple-touch-icon.png`, `/icon-*.png`) requires
authentication. `/settings/llm` requires auth even for reads.

Accepted credentials (any one):

- `Authorization: Bearer <MINIMEM_TOKEN>`
- `Authorization: Basic <base64(any-username:<token>)>` — username is cosmetic
- `Authorization: <token>` (bare)
- The short code `MINIMEM_LOCK` may be used in place of the long token.

On failure: `401 {error:"unauthorized", attempts_left, hint}` and an
`X-Auth-Attempts-Left` header; repeated failures from one IP return
`429 {error:"too many failed auth attempts", retry_after_s}` with `Retry-After`.

With `AUTH_ENABLED=0` the guard is a no-op; the server refuses to bind a
non-loopback `HOST` in that mode.

## Common shapes

Memory (`Mem`):

```json
{"id":1,"text":"lab server is an SD845 running postmarketOS","created_at":"2026-10-25 10:00:00","updated_at":"2026-10-25 10:00:00","agent_source":null,"trust":"unverified","tags":["lab","hardware"]}
```

Scored (recall result row):

```json
{"id":1,"text":"...","created_at":"...","updated_at":"...","agent_source":null,"trust":"unverified","tags":["lab"],"score":0.812,"fts_norm":0.64,"cos":0.73,"recency":0.91,"age_days":3.2,"match":"both","fts":4.1}
```

`match` is `both | keyword | semantic | none`. `cos` is `null` when the row has
no embedding. `shadowed_by` / `supersedes` appear only when relevant.

## Health and stats

### `GET /health` (public)

```json
{"ok":true,"name":"minimem","version":"2.0.0","auth":true}
```

### `GET /stats` (auth)

```json
{"live":352,"deleted":12,"history":1040,"tags":87,"relay":{"handoffs":4,"leases":1,"lessons":6,"crystals":2,"audit":91}}
```

## Memories

### `POST /memories` (auth)

Body (single object, not an array):

```json
{"text":"lab server is an SD845 running postmarketOS","tags":["lab","hardware"]}
```

- `text` 1..4000 chars (required)
- `tags` optional array, max 10, each <= 40 chars

Response: `{"id":42}`. An exact duplicate returns the existing id with tags
merged (no error).

### `GET /memories` (auth)

Query: `tag`, `limit` (default 50, max 200), `offset`.

Response: `{"total":352,"items":[/* Mem */]}` (newest first).

### `GET /memories/:id` (auth)

Response: `Mem` or `404 {"error":"not found"}`.

### `PATCH /memories/:id` (auth)

Body: `{"text":"...","tags":["..."]}` (text required 1..4000, tags optional).

Response: `{"ok":true}` or `404`.

### `DELETE /memories/:id` (auth)

Soft delete. Response: `{"ok":true}` or `404`.

### `GET /memories/deleted` (auth)

Query: `limit` (default 50, max 200), `offset`.

Response: `{"total":12,"items":[/* Mem + deleted_at */]}`.

### `POST /memories/:id/restore` (auth)

Response: `{"ok":true}` or `404`.

### `DELETE /memories/:id/purge?confirm=yes` (auth)

Hard delete, trashed rows only, irreversible.

Response: `{"ok":true,"purged":42,"chars":64}`.
Errors: `400 {"error":"confirmation required",...}` if `confirm != "yes"`;
`404 {"error":"not found or not trashed",...}`.

### `GET /memories/:id/history` (auth)

Response: array of up to 50 `{action, old_text, old_tags, at}` (newest first).

## Search and recall

### `GET /memories/search` (auth)

Query: `q` (required), `tag`, `limit` (default 10, max 50), `mode`
(`keyword|hybrid`, default hybrid), `trust` (`verified|unverified|disputed`),
`dedupe` (`0` disables dedupe).

Response: `Scored[]` (bare array, as the web UI expects).

### `GET /memories/recall` (auth)

Same query params. Response:

```json
{"mode":"hybrid","degraded":null,"candidates":42,"relevant":8,"fallback_used":false,"total":8,"items":[/* Scored */],"shadowed":[{"id":10,"by":42,"cos":0.88}]}
```

`degraded` is set when hybrid was requested but embeddings were unavailable
(provider down / not configured); the caller falls back to keyword visibly.
`fallback_used` is true when nothing matched and the result is the recency
fallback page.

## Embeddings

### `GET /embeddings` (auth)

```json
{"enabled":true,"ready":true,"provider":"cloudflare","model":"@cf/baai/bge-m3","account_id":"set","ai_token":"CF_AI_TOKEN","model":"@cf/baai/bge-m3","live":352,"embedded":352,"stale_or_missing":0}
```

Never returns the token, only which env var is set.

### `POST /embeddings/backfill?limit=&batch=` (auth)

`limit` 1..500 (default 25), `batch` 1..100 (default 16). Idempotent and
resumable; safe while live.

Response:

```json
{"ok":true,"model":"@cf/baai/bge-m3","pending_before":40,"embedded":25,"failed":0,"remaining":15,"batches":2,"skipped_changed":0}
```

`error` is present only when the provider failed.

## Tags

### `GET /tags?limit=` (auth)

`limit` default 120, max 400.

Response: `{"total":87,"tags":[{"tag":"lab","n":12},...]}` (live memories only).

## Supersedes (same-fact relations)

See [same-fact.md](same-fact.md).

### `GET /supersedes?memory_id=` (auth)

If `memory_id` given, relations involving that memory; otherwise all.

Response: `{"total":N,"items":[{"id_a":849,"id_b":848,"reason":"...","decided_by":"human","decided_at":"..."}]}`.
`id_a` is current, `id_b` is superseded.

### `POST /supersedes` (auth)

Body: `{"current":849,"other":848,"reason":"...","decided_by":"human"}`.

Response: `{"ok":true,"current":849,"other":848,"reason":"...","decided_by":"human"}`.
Errors: `400` if ids invalid/equal; `404` if a memory is missing.

### `DELETE /supersedes?current=&other=` (auth)

Response: `{"ok":true}`.

## Settings (LLM)

### `GET /settings/llm` (auth)

Response:

```json
{
  "llm_endpoint": "https://api.example.com/v1",
  "llm_api_key": "****abcd",
  "llm_models": "google/gemini-2.5-flash-lite",
  "endpoint": "https://api.example.com/v1",
  "api_key": "****abcd",
  "models": "google/gemini-2.5-flash-lite",
  "settings": {"llm_endpoint":"...","llm_api_key":"****abcd","llm_models":"..."}
}
```

The key is always redacted (last 4 chars only; `null`/short values pass through).

### `PUT /settings/llm` (auth)

Body (any of these aliases accepted):

```json
{"llm_endpoint":"https://...","llm_api_key":"sk-...","llm_models":["m1","m2"]}
```

Aliases: `endpoint`/`llmEndpoint`, `api_key`/`llmApiKey`/`key`,
`models`/`llmModels`. `llm_models` may be a comma string or array of strings.

Validation: endpoint must be `http:`/`https:` URL (empty clears it); key is
trimmed; an unchanged redacted key does not overwrite the real secret.

Response: same shape as GET.

### LLM settings: env vars vs database

`/extract` resolves settings with this precedence (env always wins):

1. `LLM_ENDPOINT` env var, else DB `llm_endpoint`
2. `AI_GATEWAY_API_KEY` env var, else DB `llm_api_key`
3. `EXTRACT_MODELS` env var, else DB `llm_models`, else `google/gemini-2.5-flash-lite`

So `/settings/llm` writes the database; if the corresponding env var is set it
overrides at runtime but the DB value is still stored. Model ids are a
comma-separated fallback chain (tried in order).

Related env vars: `EXTRACT_MODELS`, `AI_GATEWAY_API_KEY`.

## Extraction

### `POST /extract` (auth)

Body: `{"text":"...up to 20000 chars..."}`.

Response on success:

```json
{"model":"google/gemini-2.5-flash-lite","added":2,"updated":1,"deleted":0,"skipped":0}
```

On failure: `502 {"error":"extraction failed","detail":"..."}`. Requires an LLM
endpoint/key configured (env or DB).

## Relay

### Handoffs

- `POST /handoff` body `{from,to,body,topic?,refs?}` → `{"ok":true,"id":N,"created_at":"..."}`
- `GET /handoff?agent=&all=1&limit=` → `{"total":N,"items":[{id,from_agent,to_agent,topic,body,refs,created_at,read_at,acked_at}]}`
  (`all=1` includes acked; default pending only)
- `POST /handoff/:id/ack` body `{agent}` → `{"ok":true}` or `409 {"error":"handoff not found for that agent"}`

### Leases

- `GET /leases` → `{"items":[{name,holder,note,acquired_at,expires_at}]}`
- `POST /leases` body `{name,holder,note?,ttl_minutes?}` (ttl 1..1440, default 30)
  → `{"ok":true,...}` or `409 {"ok":false,"held_by":"...","expires_at":"..."}`
- `DELETE /leases/:name?holder=` → `{"ok":true}` or `409`

### Lessons

- `GET /lessons?scope=&limit=` → `{"items":[{id,text,scope,created_at}]}`
- `POST /lessons` body `{text,scope?}` → `{id}`

### Crystals

- `GET /crystals?limit=` → `{"items":[{id,text,sources,created_at}]}`
  (`sources` is a JSON string)
- `POST /crystals` body `{text,sources?}` → `{id}`

### Audit

- `GET /audit?limit=` (default 50, max 200) → `{"items":[{id,actor,action,target,detail,at}]}`

## MCP

### `POST /mcp` (auth)

JSON-RPC 2.0 over streamable HTTP. `GET /mcp` returns `405`. Protocol version
`2025-06-18`. Disable with `MINIMEM_MCP=0`.

Standard methods: `initialize`, `tools/list`, `tools/call`. Tool results are
returned as MCP `content` text (JSON-stringified).

The 16 tools:

| tool | purpose |
|---|---|
| `memory_save` | store one durable fact (exact duplicates dedupe) |
| `memory_search` | ranked search (hybrid by default; `mode:"keyword"`) |
| `memory_recall` | ranking with provenance |
| `memory_trust` | set trust / agent_source; never changes text |
| `memory_recent` | newest, tag-filtered, paged |
| `memory_forget` | soft delete |
| `memory_supersede` | declare same-fact relation |
| `lesson_save` / `lesson_list` | durable rules, scoped |
| `handoff_write` / `handoff_read` / `handoff_ack` | notes between agents |
| `lease_acquire` / `lease_release` | named locks |
| `crystal_save` | merged/summarised memory |
| `memory_stats` | counts |

Probe:

```sh
curl -s -X POST http://127.0.0.1:3100/mcp \
  -H "Authorization: Bearer ***" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}'
```

A JSON result with `serverInfo.name == "minimem"` means the server is up and the
token is accepted. `401` means the token is wrong or missing.

## Public deployment

### Reverse proxy

Default bind is `0.0.0.0`. For a public deployment keep `AUTH_ENABLED=1` and a
strong `MINIMEM_TOKEN`, put a reverse proxy in front for HTTPS, and firewall the
origin so only the proxy (or your VPN) reaches `:3100`.

Caddy:

```caddy
mem.example.com {
    reverse_proxy 127.0.0.1:3100
}
```

Nginx:

```nginx
server {
    listen 443 ssl;
    server_name mem.example.com;
    location / {
        proxy_pass http://127.0.0.1:3100;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

### Firewall and auth

- Never run with `AUTH_ENABLED=0` on a public interface.
- `/settings/llm` requires auth even for reads (it exposes LLM endpoint config).
- The guard is the only thing between the internet and your memory database;
  memories accumulate hostnames, IPs, tokens and config snippets — treat the DB
  as a secret.
- A useful middle ground: `HOST=127.0.0.1` plus `tailscale serve`.

### Backup

Stop the service and copy the `.db`, or use SQLite's online backup while running:

```sh
sqlite3 /path/to/minimem.db ".backup /backups/minimem-$(date +%F).db"
```

Keep backups off-box. The DB stays under ~10 MB for most users. A plain `cp`
can miss the WAL — use `.backup` or `VACUUM INTO`.

### Health check

```sh
curl -sf https://mem.example.com/health || echo "UNHEALTHY"
```

## Environment variables

Core:

| var | default | notes |
|---|---|---|
| `MINIMEM_DB_PATH` | `./data/minimem.db` | absolute path to SQLite file |
| `MINIMEM_TOKEN` | (required if auth on) | long bearer; `MEMORY_TOKEN` alias |
| `MINIMEM_LOCK` | (optional) | short 8-char web-UI code; `MEM_LOCK` alias |
| `AUTH_ENABLED` | `1` | `0` disables guard (loopback only) |
| `MINIMEM_MCP` | `1` | `0` disables `POST /mcp` |
| `HOST` / `PORT` | `0.0.0.0` / `3100` | bind address |
| `EXTRACT_MODELS` | `google/gemini-2.5-flash-lite` | comma-separated fallback chain |
| `AI_GATEWAY_API_KEY` | (none) | only needed for `/extract` |

Semantic layer (all optional; off without a token):

| var | default | notes |
|---|---|---|
| `CF_AI_TOKEN` | (none) | falls back to `CLOUDFLARE_AI_API_TOKEN` |
| `CF_ACCOUNT_ID` | (none) | |
| `EMBED_ENABLED` | on if token set | master switch |
| `EMBED_MODEL` | `@cf/baai/bge-m3` | 1024-dim multilingual |
| `EMBED_PROVIDER` | `cloudflare` | only provider implemented |
| `EMBED_DIM` | `1024` | |
| `EMBED_TIMEOUT_MS` | `20000` | |

Ranking knobs (defaults are measured; change with a reason):

`HYBRID_W_FTS=1.0`, `HYBRID_W_VEC=1.0`, `HYBRID_W_REC=0.15`,
`SEM_MIN_RELEVANCE=0.50`, `SEM_COS_NOISE_FLOOR=0.45`,
`SEM_COS_GOOD_CEIL=0.65`, `SEM_FTS_STRONG=8`, `SEM_HALF_LIFE_DAYS=45`,
`SEM_DEDUPE_THRESHOLD=0.76`, `SUPERSEDE_MARGIN_HOURS=24`,
`TRUST_WEIGHT_VERIFIED=1.10`, `TRUST_WEIGHT_UNVERIFIED=1.00`,
`TRUST_WEIGHT_DISPUTED=0.50`. Legacy `SEM_`/unprefixed spellings still
accepted; deployed `SEM_*` wins.

## Thai search note

FTS5 uses the trigram tokenizer, so Thai (and Chinese/Japanese) text is
searchable without a word segmenter: `ระบบความจำ` is findable by `ความจำ`.
The semantic layer sits on top and never replaces the keyword path, so
identifiers, error strings and exact hostnames still hit the trigram index.
ค้นหาภาษาไทยได้โดยไม่ต้องตัดคำ.

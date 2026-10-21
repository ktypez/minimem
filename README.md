# minimem

A small, self-hosted memory store for AI agents. One SQLite file, one Bun process, a REST API, an MCP endpoint, and a web UI you can actually read.

Built to answer one question: *where does an agent put a fact so it can find it again next week?*

Two layers do the finding:

- **FTS5 trigram keyword search** — always on, no model, no network. Works for Thai, Chinese, Japanese, anything without spaces.
- **An optional semantic layer** — a 1024-dim multilingual embedding (Cloudflare Workers AI, `@cf/baai/bge-m3`) blended into the same ranking. Off unless you give it a key; if the provider is down it degrades to keyword-only instead of failing.

```sh
curl -s localhost:3100/memories -H 'content-type: application/json' \
  -d '{"text":"lab server is an SD845 running postmarketOS","tags":["lab","hardware"]}'

curl -s --get --data-urlencode 'q=postmarketOS' localhost:3100/memories/search
```

## Why trigram FTS5

Most memory stores assume English. Trigram tokenization indexes overlapping three-character sequences, so `ระบบความจำ` is findable by `ความจำ` or `ระบบ` without a Thai word segmenter. It costs index size; it buys a search box that works in the languages people actually write their notes in.

The semantic layer is added **on top**, never instead. Identifiers, error strings and exact hostnames still hit the keyword path — that is what a trigram index is good at.

## Quick start

Requirements: [Bun](https://bun.sh) 1.1+ and SQLite with FTS5 (the bundled one is fine).

```sh
git clone https://github.com/ktypez/minimem.git
cd minimem
bun install

mkdir -p ~/minimem-data            # data lives OUTSIDE the repo
cat > ~/minimem.env <<EOF
MINIMEM_DB_PATH=$HOME/minimem-data/minimem.db
MINIMEM_TOKEN=$(head -c 32 /dev/urandom | base64 | tr -d '/+=')
HOST=127.0.0.1
PORT=3100
AUTH_ENABLED=1
EOF
chmod 600 ~/minimem.env

MINIMEM_ENV=~/minimem.env ./run.sh
```

Open <http://127.0.0.1:3100/> and paste the token when asked. It is kept in `sessionStorage` — closing the tab forgets it.

Inspect a database without starting a server:

```sh
MINIMEM_ENV=~/minimem.env bun run server.ts --check
```

**Want an agent to do the install for you?** See [docs/INSTALL.md](docs/INSTALL.md) — ready-to-paste config for Claude Code, Codex CLI, opencode, Crush, Gemini CLI, Cursor/Windsurf and any other MCP client, plus a self-contained prompt you can hand an AI agent so it installs and connects itself.

## Configuration

Everything is an environment variable; `MINIMEM_ENV` points `run.sh` at a file, and no secret is ever committed.

### Core

- `MINIMEM_DB_PATH` — absolute path to the SQLite file. Default `./data/minimem.db`.
- `MINIMEM_TOKEN` — long bearer token. Required when auth is on.
- `MINIMEM_LOCK` — short 8-char code; an alternative password for the web UI.
- `AUTH_ENABLED` — `1` (default) guards the API, `0` disables the guard entirely.
- `MINIMEM_MCP` — `1` (default) serves the `POST /mcp` endpoint, `0` disables it (agents lose their memory tools).
- `HOST`, `PORT` — bind address, default `127.0.0.1:3100`.
- `EXTRACT_MODELS` — comma-separated model ids for `/extract`'s fallback chain.
- `AI_GATEWAY_API_KEY` — only needed if you call `/extract`.

`MEMORY_TOKEN` and `MEM_LOCK` are still accepted as aliases for the renamed variables.

### Semantic layer (all optional)

Set a Cloudflare Workers AI token and the semantic index switches itself on. Nothing happens without one.

- `CF_AI_TOKEN` — Cloudflare AI token. Falls back to `CLOUDFLARE_AI_API_TOKEN`.
- `CF_ACCOUNT_ID` — Cloudflare account id.
- `EMBED_ENABLED` — master switch. Default: on when a token is configured.
- `EMBED_MODEL` — default `@cf/baai/bge-m3` (1024-dim, multilingual, handles Thai).
- `EMBED_PROVIDER` — `cloudflare` (the only one implemented).
- `EMBED_DIM` — `1024`.
- `EMBED_TIMEOUT_MS` — `20000`.

Then fill the index once:

```sh
MINIMEM_ENV=~/minimem.env ./backfill.sh --limit 500   # idempotent, resumable
curl -s localhost:3100/embeddings -H "Authorization: Bearer $MINIMEM_TOKEN"
# {"enabled":true,"ready":true,"live":352,"embedded":352,"stale_or_missing":0}
```

`backfill.sh` reads the same env file the server does, so no secret lands on a command line. It is safe to run while the server is live, and it never rewrites a memory — only its own vector.

### Ranking knobs

Defaults are the values measured on a real corpus; change them only if you have a reason.

- `HYBRID_W_FTS` (`1.0`) — weight of the calibrated FTS5 bm25 signal.
- `HYBRID_W_VEC` (`1.0`) — weight of the calibrated cosine signal.
- `HYBRID_W_REC` (`0.15`) — recency influence among *relevant* rows (tie-break only).
- `SEM_MIN_RELEVANCE` (`0.50`) — cosine gate: at/above this a row answers the query.
- `SEM_COS_NOISE_FLOOR` (`0.45`) — at/below this cosine is noise, so the signal is zeroed.
- `SEM_COS_GOOD_CEIL` (`0.65`) — at/above this cosine is a full-strength match.
- `SEM_FTS_STRONG` (`8`) — `-bm25` at/above this is a strong keyword match.
- `SEM_HALF_LIFE_DAYS` (`45`) — age at which the recency signal halves.
- `SEM_DEDUPE_THRESHOLD` (`0.76`) — cosine above which two hits *might* be the same fact.
- `SUPERSEDE_MARGIN_HOURS` (`24`) — how much younger a record must be to shadow an older one.
- `TRUST_WEIGHT_VERIFIED` (`1.10`) · `TRUST_WEIGHT_UNVERIFIED` (`1.00`) · `TRUST_WEIGHT_DISPUTED` (`0.50`).

Every knob also accepts the legacy `SEM_`-prefixed spelling, and the deployed spelling wins: `SEM_HALF_LIFE_DAYS` > `SEM_DECAY_HALF_LIFE_DAYS` > `DECAY_HALF_LIFE_DAYS`, and `SEM_DEDUPE_THRESHOLD` > `SEM_NEAR_DUP_COS` > `NEAR_DUP_COS`.

### About `AUTH_ENABLED=0`

Turning auth off is not a hardening measure — it hands your memory database to anyone who can reach the port. Do it only when the listener is loopback, a private VPN such as Tailscale, or a network you fully control. **Never** bind `0.0.0.0` with auth off on a shared LAN. Memories accumulate hostnames, IP addresses, tokens and config snippets; treat the database as a secret.

A useful middle ground: `HOST=127.0.0.1` plus `tailscale serve` when you want remote access without exposing a port.

## API

All routes speak JSON. With auth on, send `Authorization: Bearer ***` or basic auth with the token (or `MINIMEM_LOCK`) as the password. `/` and `/health` stay public so the UI can load and decide whether to ask for a token.

- `GET /health` → `{ok, name, version, auth}`. `auth:false` means the guard is off.
- `GET /stats` → `{live, deleted, history, tags, relay}`.
- `GET /memories?tag=&limit=&offset=&q=` → `{total, items}`.
- `POST /memories` — body is a **single object**, not an array: `{"text": "...", "tags": ["..."]}`. An exact duplicate returns the existing id with tags merged.
- `GET /memories/:id` · `PATCH /memories/:id` · `DELETE /memories/:id`.
- `GET /memories/deleted` · `POST /memories/:id/restore` — deletes are soft.
- `DELETE /memories/:id/purge?confirm=yes` — hard delete, trashed rows only, irreversible.
- `GET /memories/search?q=&tag=&limit=` — ranked search. Thai-safe.
- `GET /memories/recall?q=&limit=&tag=&mode=keyword|hybrid&trust=&dedupe=0` — the same ranking **with provenance**: which signal found each memory (`match: both|keyword|semantic|none`), how old it is (`age_days`), who said it (`agent_source`), how much to trust it (`trust`), and which older near-duplicates it shadows (`shadowed`).
- `GET /embeddings` — semantic index state. Never returns the token, only whether it is set.
- `POST /embeddings/backfill?limit=&batch=` — fill the index, capped per call, safe while live.
- `GET|POST|DELETE /supersedes` — the relations that say "these two memories state the same fact, this one is current". See [docs/same-fact.md](docs/same-fact.md).
- `GET /memories/:id/history` — every version of one memory.
- `GET /tags?limit=` → tag cloud with counts, live memories only.
- `POST /extract` — send free text, get validated memory operations back from an LLM.
- `POST /mcp` — JSON-RPC 2.0 over streamable HTTP; the endpoint agents connect to. `GET /mcp` answers `405`.

### Relay

Agents hand work to each other with three small tables.

- `POST /handoff` — `{from, to, body, topic?, refs?}`. A note one agent leaves for another.
- `GET /handoff?agent=&all=1&limit=` — pending handoffs for an agent; `all=1` includes acked ones.
- `POST /handoff/:id/ack` — `{agent}`. Marks it done. Only the addressed agent can ack; anyone else gets `409`.
- `GET /leases` · `POST /leases` — `{name, holder, note?, ttl_minutes?}`. A named lock so two agents do not edit the same thing. A rival asking for a held lease gets `409` with `held_by`. Expired leases are reused; `POST` renews.
- `DELETE /leases/:name?holder=` — release, holder must match.
- `GET /lessons` · `POST /lessons` — durable "do it this way" rules, searchable, scoped.
- `GET /crystals` · `POST /crystals` — merged/summarised memories, with `sources`.
- `GET /audit?limit=` — who changed what, through REST or MCP.

On `POST /memories`, `401` means the token is wrong and `400` carries the reason for a rejected body; an exact duplicate is not an error — you get the existing row back with tags merged.

## The MCP tools

Sixteen tools come back, with no name prefix:

| tool | what it is for |
|---|---|
| `memory_save` | store one durable fact (exact duplicates dedupe) |
| `memory_search` | ranked search — hybrid by default, `mode:"keyword"` forces the trigram path |
| `memory_recall` | the same ranking with provenance: which signal, how old, who said it, trust, what it supersedes |
| `memory_trust` | set `trust` (`verified`/`unverified`/`disputed`) and/or `agent_source`; never changes the text |
| `memory_recent` | newest memories, tag-filtered, paged |
| `memory_forget` | soft-delete (recoverable) |
| `memory_supersede` | declare that two memories state the same fact, and which is current |
| `lesson_save` / `lesson_list` | durable "do it this way" rules, scoped |
| `handoff_write` / `handoff_read` / `handoff_ack` | leave, read and close notes for another agent |
| `lease_acquire` / `lease_release` | named lock so two agents do not edit the same thing |
| `crystal_save` | store a merged/summarised memory |
| `memory_stats` | counts of everything |

The handoff pair is the point of running one shared store: an agent finishing a task leaves `handoff_write` for the next one, and the next one starts by calling `handoff_read` instead of rediscovering the state from scratch. `lease_acquire` keeps two agents off the same file.

Tags do the work concepts would in a heavier system: `auto-capture`, a project slug, a few keywords.

### Correcting yourself

When you write a corrected or updated version of something you already stored, the store cannot know the two are the same fact — nothing in the text says so. Declare it:

```jsonc
// over MCP
{ "current": 849, "other": 848, "reason": "#849 is the explicit correction of #848" }
```

```sh
# or over REST
curl -s -X POST localhost:3100/supersedes \
  -H "Authorization: Bearer ***" -H 'content-type: application/json' \
  -d '{"current":849,"other":848,"reason":"#849 is the explicit correction of #848"}'
```

After that the older record is shadowed instead of being recalled as if it were current. Undo with `DELETE /supersedes?current=849&other=848`. The reasoning, and the measurement behind it, is in [docs/same-fact.md](docs/same-fact.md).

## Agent integration

Over REST, give the agent a base URL and three calls: `POST /memories` to save, `GET /memories/search?q=` to recall, `GET /memories?tag=` to list one topic. Search returns whole memories ranked by relevance, so no client-side parsing is needed.

Over MCP, one URL and no wrapper binary:

```json
{ "mcpServers": { "minimem": { "type": "http", "url": "http://127.0.0.1:3100/mcp",
  "headers": { "Authorization": "Bearer $MINIMEM_TOKEN" } } } }
```

Per-client configuration — Claude Code, Codex CLI, opencode, Crush, Gemini CLI, Cursor, Windsurf, and anything else — is in **[docs/INSTALL.md](docs/INSTALL.md)**, together with a prompt you can hand an AI agent so it installs and connects itself.

Check the handshake before you blame the client:

```sh
curl -s -X POST http://127.0.0.1:3100/mcp \
  -H "Authorization: Bearer ***" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}'
```

A JSON result with `serverInfo.name` set to `minimem` means the server is up and the token is accepted. `401` means the token is wrong or missing.

Notes:
- `POST /mcp` is the only write path. `GET /mcp` returns `405`.
- Protocol version is `2025-06-18`.
- Only the LAN port is reachable from outside the host. There is no public tunnel for `/mcp`.

## Running as a service

```sh
./contrib/install.sh                       # OpenRC or systemd, whichever is there
./contrib/install.sh --dry-run             # print every step, change nothing
./contrib/install.sh --auth off --host 127.0.0.1
./contrib/install.sh --uninstall           # removes the service, keeps your data
```

The installer finds the privilege tool the box has (`root`, `sup`, `doas`, `sudo`), writes an env file to `/etc/minimem/minimem.env` with a fresh 43-character token, installs a launcher, registers the service, runs `bun install`, starts it, then polls `/health` until it answers. Running it twice is a no-op: an existing env file keeps its token and settings.

Defaults are `--service minimem`, `--user $USER`, `--db-dir ~/minimem-data`, `--port 3100`, `--host 127.0.0.1`, `--auth on`. Override any of them as flags or as `MINIMEM_*` environment variables.

`contrib/minimem.initd` and `contrib/minimem-server` are the raw templates the installer fills in, if you would rather place them by hand. `contrib/minimem.env.example` is a copy of the env file with the knobs documented.

Two details matter on slow ARM boards: root-owned files need a privileged copy (`sup install …`), because a plain shell redirect keeps your ownership; and stop-then-start beats `restart`, since supervise-daemon can leave a child holding the port.

## Durability

Every write is journaled to `history` with the previous text and tags before it lands. `DELETE` sets `deleted_at` rather than removing the row, so `/memories/deleted` and `/memories/:id/restore` always work; `purge` is the explicit, confirmed, irreversible one. The database runs in WAL mode, and `PRAGMA user_version` records the schema version so a migration can tell what it is looking at.

Back up by copying the file while the server is stopped, or with `sqlite3 db ".backup out.db"` while it runs.

## Production deploy

### Reverse proxy

Bind to `127.0.0.1` and put a reverse proxy in front for TLS and external access. Caddy example:

```caddy
mem.example.com {
    reverse_proxy 127.0.0.1:3100
}
```

Nginx equivalent:

```nginx
server {
    listen 443 ssl;
    server_name mem.example.com;
    # ssl_certificate / ssl_certificate_key managed by your setup
    location / {
        proxy_pass http://127.0.0.1:3100;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

### Backup

Stop the service and copy the `.db` file, or use SQLite's online backup while it runs:

```sh
sqlite3 /path/to/minimem.db ".backup /backups/minimem-$(date +%F).db"
```

Keep backups off-box. The database stays under 10 MB for most users, so daily snapshots are cheap. Automate with cron or a timer unit.

### Health check

```sh
curl -sf https://mem.example.com/health || echo "UNHEALTHY"
```

Wire this into Uptime Kuma, Healthchecks.io, Cronitor, or a cron job that alerts on failure. If `/health` stops answering, restart the service and investigate.

## Development

```sh
bun test                        # the whole suite
bun test search.test.ts         # search regression tests
bun test hybrid.test.ts         # ranking, provenance, leak checks
bun test dedupe.test.ts         # the collapse rules, including chain closure
bun test keyword-only.test.ts   # the no-embeddings configuration
```

`docs/same-fact.md` explains how "is this the same fact?" is decided, with the measurements behind each decision. `docs/prompt-ab/` holds the per-pair verdicts behind the prompt comparison, so the table can be re-scored without re-running a model.

## License

MIT — see [LICENSE](LICENSE).

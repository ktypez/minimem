# minimem

A small, self-hosted memory store for AI agents. One SQLite file, one Bun process, a REST API, and a web UI you can actually read.

Built to answer one question: *where does an agent put a fact so it can find it again next week?* No vector database, no embedding model, no cloud. Just FTS5 with a **trigram** tokenizer — which works for Thai, Chinese, Japanese, anything without spaces — plus tag filters and a history row on every write.

```sh
curl -s localhost:3100/memories -H 'content-type: application/json' \
  -d '{"text":"lab server is an SD845 running postmarketOS","tags":["lab","hardware"]}'

curl -s --get --data-urlencode 'q=postmarketOS' localhost:3100/memories/search
```

## Why trigram FTS5

Most memory stores assume English. Trigram tokenization indexes overlapping three-character sequences, so `ระบบความจำ` is findable by `ความจำ` or `ระบบ` without a Thai word segmenter. It costs index size; it buys a search box that works in the languages people actually write their notes in.

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

## Configuration

Everything is an environment variable; `MINIMEM_ENV` points `run.sh` at a file, and no secret is ever committed.

- `MINIMEM_DB_PATH` — absolute path to the SQLite file. Default `./data/minimem.db`.
- `MINIMEM_TOKEN` — long bearer token. Required when auth is on.
- `MINIMEM_LOCK` — short 8-char code; an alternative password for the web UI.
- `AUTH_ENABLED` — `1` (default) guards the API, `0` disables the guard entirely.
- `MINIMEM_MCP` — `1` (default) serves the `POST /mcp` endpoint, `0` disables it (agents lose their memory tools).
- `HOST`, `PORT` — bind address, default `127.0.0.1:3100`.
- `EXTRACT_MODELS` — comma-separated model ids for `/extract`'s fallback chain.
- `AI_GATEWAY_API_KEY` — only needed if you call `/extract`.

`MEMORY_TOKEN` and `MEM_LOCK` are still accepted as aliases for the renamed variables.

### About `AUTH_ENABLED=0`

Turning auth off is not a hardening measure — it hands your memory database to anyone who can reach the port. Do it only when the listener is loopback, a private VPN such as Tailscale, or a network you fully control. **Never** bind `0.0.0.0` with auth off on a shared LAN. Memories accumulate hostnames, IP addresses, tokens and config snippets; treat the database as a secret.

A useful middle ground: `HOST=127.0.0.1` plus `tailscale serve` when you want remote access without exposing a port.

## API

All routes speak JSON. With auth on, send `Authorization: Bearer $MINIMEM_TOKEN`, or basic auth with the token (or `MINIMEM_LOCK`) as the password. `/` and `/health` stay public so the UI can load and decide whether to ask for a token.

- `GET /health` → `{ok, name, version, auth}`. `auth:false` means the guard is off.
- `GET /stats` → `{live, deleted, history, tags}`.
- `GET /memories?tag=&limit=&offset=&q=` → `{total, items}`.
- `POST /memories` — body is a **single object**, not an array: `{"text": "...", "tags": ["..."]}`. An exact duplicate returns the existing id with tags merged.
- `GET /memories/:id` · `PATCH /memories/:id` · `DELETE /memories/:id`.
- `GET /memories/deleted` · `POST /memories/:id/restore` — deletes are soft.
- `GET /memories/search?q=&tag=&limit=` — FTS5 trigram, ranked; Thai-safe.
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

## Durability

Every write is journaled to `history` with the previous text and tags before it lands. `DELETE` sets `deleted_at` rather than removing the row, so `/memories/deleted` and `/memories/:id/restore` always work. The database runs in WAL mode, and `PRAGMA user_version` records the schema version so a migration can tell what it is looking at.

Back up by copying the file while the server is stopped, or with `sqlite3 db ".backup out.db"` while it runs.

## Running as a service

```sh
./contrib/install.sh                       # OpenRC or systemd, whichever is there
./contrib/install.sh --dry-run             # print every step, change nothing
./contrib/install.sh --auth off --host 127.0.0.1
./contrib/install.sh --uninstall           # removes the service, keeps your data
```

The installer finds the privilege tool the box has (`root`, `sup`, `doas`, `sudo`), writes an env file to `/etc/minimem/minimem.env` with a fresh 43-character token, installs a launcher, registers the service, runs `bun install`, starts it, then polls `/health` until it answers. Running it twice is a no-op: an existing env file keeps its token and settings.

Defaults are `--service minimem`, `--user $USER`, `--db-dir ~/minimem-data`, `--port 3100`, `--host 127.0.0.1`, `--auth on`. Override any of them as flags or as `MINIMEM_*` environment variables.

`contrib/minimem.initd` and `contrib/minimem-server` are the raw templates the installer fills in, if you would rather place them by hand.

Two details matter on slow ARM boards: root-owned files need a privileged copy (`sup install …`), because a plain shell redirect keeps your ownership; and stop-then-start beats `restart`, since supervise-daemon can leave a child holding the port.

## Agent integration

Two ways in. Over REST, give the agent a base URL and three calls: `POST /memories` to save,
`GET /memories/search?q=` to recall, `GET /memories?tag=` to list one topic. Search returns whole
memories ranked by relevance, so no client-side parsing is needed.

Or point the agent at the MCP endpoint — one URL, no wrapper binary:

```json
{ "mcpServers": { "minimem": { "type": "streamable-http", "url": "http://127.0.0.1:3100/mcp",
  "headers": { "Authorization": "Bearer $MINIMEM_TOKEN" } } } }
```

Thirteen tools come back: `memory_save`, `memory_search`, `memory_recent`, `memory_forget`,
`lesson_save`, `lesson_list`, `handoff_write`, `handoff_read`, `handoff_ack`, `lease_acquire`,
`lease_release`, `crystal_save`, `memory_stats`.

The handoff pair is the point of running one shared store: an agent finishing a task leaves
`handoff_write` for the next one, and the next one starts by calling `handoff_read` instead of
rediscovering the state from scratch. `lease_acquire` keeps two agents off the same file.

Tags do the work concepts would in a heavier system: `auto-capture`, a project slug, a few keywords.

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

## License

MIT — see [LICENSE](LICENSE).
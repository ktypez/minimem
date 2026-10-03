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

On `POST /memories`, `401` means the token is wrong and `400` carries the reason for a rejected body; an exact duplicate is not an error — you get the existing row back with tags merged.

## Durability

Every write is journaled to `history` with the previous text and tags before it lands. `DELETE` sets `deleted_at` rather than removing the row, so `/memories/deleted` and `/memories/:id/restore` always work. The database runs in WAL mode, and `PRAGMA user_version` records the schema version so a migration can tell what it is looking at.

Back up by copying the file while the server is stopped, or with `sqlite3 db ".backup out.db"` while it runs.

## Running as a service

`contrib/` carries an OpenRC script and launcher for Alpine and postmarketOS:

```sh
install -m 755 contrib/minimem.initd  /etc/init.d/minimem
install -m 755 contrib/minimem-server /usr/local/bin/minimem-server
install -m 600 -o "$USER" contrib/minimem.env.example /etc/minimem/minimem.env
# edit /etc/minimem/minimem.env, then
rc-update add minimem default && rc-service minimem start
```

Root-owned files need a privileged copy (`sudo install …`); a plain shell redirect would keep your ownership. Stop and start rather than `restart` — supervise-daemon can hang on restart on a slow ARM box.

## Agent integration

Give the agent a base URL and three calls: `POST /memories` to save, `GET /memories/search?q=` to recall, `GET /memories?tag=` to list one topic. Search returns whole memories ranked by relevance, so no client-side parsing is needed.

Tags do the work concepts would in a heavier system: `auto-capture`, a project slug, a few keywords.

## License

MIT — see [LICENSE](LICENSE).
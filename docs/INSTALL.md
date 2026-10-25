# Installing and connecting agents

minimem speaks MCP over streamable HTTP, so connecting a client is one URL and one header. This page has the exact config for each client, plus a prompt you can hand to an AI agent so it installs and wires itself up.

- [1. Run the server](#1-run-the-server)
- [2. Get the token](#2-get-the-token)
- [3. Connect a client](#3-connect-a-client)
- [4. Verify](#4-verify)
- [5. Troubleshooting](#5-troubleshooting)
- [6. Let an AI agent do it](#6-let-an-ai-agent-do-it)

## 1. Run the server

```sh
git clone https://github.com/ktypez/minimem.git
cd minimem
bun install

mkdir -p ~/minimem-data
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

Or install it as a service (OpenRC or systemd, whichever the box has):

```sh
./contrib/install.sh              # writes /etc/minimem/minimem.env, starts it
./contrib/install.sh --dry-run    # show every step, write nothing
```

Data always lives outside the repo, and the env file is `chmod 600` and owned by the service user. Nothing secret is ever committed.

**Remote access.** The default bind is `0.0.0.0` (all interfaces). For a public deployment keep `AUTH_ENABLED=1` and a strong `MINIMEM_TOKEN`, put a reverse proxy (Caddy/nginx) in front for HTTPS, and firewall the origin so only the proxy (or your VPN) reaches `:3100`. Do not expose `:3100` on a shared LAN without auth. The proxy must forward `POST /mcp` (that is the only write path) — `GET /mcp` answers `405` by design. `/settings/llm` requires authentication (token) even for reads.

```caddy
mem.example.com {
    reverse_proxy 127.0.0.1:3100
}
```

Firewall example (ufw): allow 443/tcp and 80/tcp, deny 3100/tcp from outside; or bind the origin to `127.0.0.1` and let the proxy terminate TLS.

## 2. Get the token

```sh
export MINIMEM_TOKEN="$(sed -n 's/^MINIMEM_TOKEN="\(.*\)"/\1/p' /etc/minimem/minimem.env)"
```

Or from your own env file: `sed -n 's/^MINIMEM_TOKEN="\(.*\)"/\1/p' ~/minimem.env`.

Keep it out of any file you commit. In a client config that supports environment expansion, reference `$MINIMEM_TOKEN` instead of pasting the literal.

## 3. Connect a client

Every client below ends up sending the same two things:

- URL — `http://127.0.0.1:3100/mcp` on the same host, or your reverse-proxy URL from another machine
- Header — `Authorization: Bearer <your token>`

### Claude Code

```sh
claude mcp add --transport http minimem http://127.0.0.1:3100/mcp \
  --header "Authorization: Bearer $MINIMEM_TOKEN"
```

Add `--scope user` to make it available in every project, `--scope project` to share it via `.mcp.json`. Check it with `claude mcp get minimem`; `claude mcp list` shows `✔ Connected` next to a healthy server.

### Claude Desktop, Cursor, Windsurf, VS Code, and other `mcpServers` clients

All of these read the same JSON shape. Put it in the client's MCP config file:

```json
{
  "mcpServers": {
    "minimem": {
      "type": "http",
      "url": "http://127.0.0.1:3100/mcp",
      "headers": { "Authorization": "Bearer YOUR_TOKEN" }
    }
  }
}
```

`"type": "streamable-http"` is accepted as an alias for `"http"`. A `url` with **no** `type` is a configuration error in Claude Code — it reads the entry as a stdio server and skips it.

### Codex CLI

`~/.codex/config.toml`:

```toml
[mcp_servers.minimem]
url = "http://127.0.0.1:3100/mcp"
bearer_token_env_var = "MINIMEM_TOKEN"
```

`bearer_token_env_var` reads the token from the environment at connect time, so the secret never lands in the config file. `http_headers` works too if you would rather set the header literally.

### opencode

`~/.config/opencode/opencode.json`:

```json
{
  "mcp": {
    "servers": {
      "minimem": {
        "type": "remote",
        "url": "http://127.0.0.1:3100/mcp",
        "headers": { "Authorization": "Bearer YOUR_TOKEN" }
      }
    }
  }
}
```

### Crush

`~/.config/crush/crush.json`:

```json
{
  "mcp": {
    "minimem": {
      "type": "http",
      "url": "http://127.0.0.1:3100/mcp",
      "enabled": true,
      "headers": { "Authorization": "Bearer YOUR_TOKEN" }
    }
  }
}
```

### Gemini CLI

`~/.gemini/settings.json` — note `httpUrl` for streamable HTTP, and `url` for SSE:

```json
{
  "mcpServers": {
    "minimem": {
      "httpUrl": "http://127.0.0.1:3100/mcp",
      "headers": { "Authorization": "Bearer YOUR_TOKEN" }
    }
  }
}
```

`gemini mcp list` shows connection errors for every configured server.

### Hermes

`~/.hermes/config.yaml`:

```yaml
mcp_servers:
  minimem:
    url: http://127.0.0.1:3100/mcp
    timeout: 120
    enabled: true
    headers:
      Authorization: Bearer ${MCP_MINIMEM_API_KEY}
```

Put the token in `~/.hermes/.env` as `MCP_MINIMEM_API_KEY=...` and restart the gateway so it picks the server up.

Hermes can also use minimem as its **memory provider** — a plugin that prefetches recall context at the start of a turn, instead of only as a tool server. A ready-to-copy plugin lives in this repo:

```sh
cp -r contrib/hermes-plugin ~/.hermes/plugins/minimem
# then set the token:
printf 'MCP_MINIMEM_API_KEY=%s\n' "$MINIMEM_TOKEN" >> ~/.hermes/.env
```

The plugin mirrors the server's tool list, so it must be re-copied when minimem gains a tool.

### Anything else

Any MCP client over streamable HTTP works. The minimum is a `POST` to `/mcp` with JSON-RPC 2.0 and the `Authorization` header. If your client only speaks SSE, put a proxy in front that terminates SSE and forwards to `/mcp`.

### REST instead of MCP

If a client cannot speak MCP, three calls are enough — save, recall, list:

```sh
curl -s -X POST http://127.0.0.1:3100/memories \
  -H "Authorization: Bearer $MINIMEM_TOKEN" -H 'content-type: application/json' \
  -d '{"text":"the API host is api.example.com","tags":["infra"]}'

curl -s --get --data-urlencode 'q=api host' http://127.0.0.1:3100/memories/search \
  -H "Authorization: Bearer $MINIMEM_TOKEN"

curl -s "http://127.0.0.1:3100/memories?tag=infra" -H "Authorization: Bearer $MINIMEM_TOKEN"
```

`POST /memories` takes a **single object**, not an array. Search returns whole memories ranked by relevance, so there is nothing to parse.

## 4. Verify

The handshake, before you blame the client:

```sh
curl -s -X POST http://127.0.0.1:3100/mcp \
  -H "Authorization: Bearer $MINIMEM_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}'
```

A JSON result with `serverInfo.name` = `minimem` means the server is up and the token was accepted.

List the tools:

```sh
curl -s -X POST http://127.0.0.1:3100/mcp \
  -H "Authorization: Bearer $MINIMEM_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
```

Sixteen tools come back: `memory_save`, `memory_search`, `memory_recall`, `memory_trust`, `memory_recent`, `memory_forget`, `memory_supersede`, `lesson_save`, `lesson_list`, `handoff_write`, `handoff_read`, `handoff_ack`, `lease_acquire`, `lease_release`, `crystal_save`, `memory_stats`.

Round-trip a fact:

```sh
curl -s -X POST http://127.0.0.1:3100/memories \
  -H "Authorization: Bearer $MINIMEM_TOKEN" -H 'content-type: application/json' \
  -d '{"text":"minimem install canary 2026-10-21","tags":["canary"]}'
```

## 5. Troubleshooting

| symptom | cause | fix |
|---|---|---|
| `401 unauthorized` | token wrong or missing | re-read it from the env file; check the header is `Bearer <token>` |
| `405` on `/mcp` | you sent `GET` | only `POST` is served, by design |
| client shows "no tools" / skips the server | a `url` entry with no `type` | add `"type": "http"` (Claude Code) or `"httpUrl"` (Gemini CLI) |
| `serverInfo.name` is not `minimem` | you hit a proxy, not minimem | check the URL and that the proxy forwards `POST /mcp` |
| tools load but every call fails | token in the config is stale | clients read the config at startup — restart the client after rotating the token |
| results look old or wrong | the semantic index is not filled | run `./backfill.sh --limit 500`; check `GET /embeddings` |
| every search returns keyword-only | no `CF_AI_TOKEN` / `CF_ACCOUNT_ID` | the semantic layer is optional; keyword search still works |

## 6. Let an AI agent do it

Two ready-made prompts. The first installs minimem and wires up the client the agent is running in. The second tells an agent how to *use* the store once it is connected.

### Install prompt

Copy this into Claude Code, Codex, opencode, Crush, Gemini CLI — any agent with shell access:

> Install the minimem memory store on this machine and connect me to it.
>
> 1. Clone https://github.com/ktypez/minimem.git into a directory of your choice and run `bun install` in it. If `bun` is missing, install it first with `curl -fsSL https://bun.sh/install | bash`.
> 2. Create a data directory `~/minimem-data` and an env file `~/minimem.env` (mode 600) containing:
>    ```
>    MINIMEM_DB_PATH=$HOME/minimem-data/minimem.db
>    MINIMEM_TOKEN=<43 random characters>
>    MINIMEM_LOCK=<8 digits>
>    HOST=127.0.0.1
>    PORT=3100
>    AUTH_ENABLED=1
>    ```
>    Generate the token with `head -c 32 /dev/urandom | base64 | tr -d '/+='`.
> 3. Start it with `MINIMEM_ENV=~/minimem.env ./run.sh` (background it, and log to a file). If this box uses OpenRC or systemd, use the repo's `./contrib/install.sh` instead so it survives a reboot.
> 4. Verify with `curl -s http://127.0.0.1:3100/health`.
> 5. Read the token back out of the env file and add minimem to **my** MCP client config as a streamable-HTTP server at `http://127.0.0.1:3100/mcp` with header `Authorization: Bearer <token>`. Use the config format your own client reads — if you are Claude Code use `claude mcp add --transport http minimem http://127.0.0.1:3100/mcp --header "Authorization: Bearer <token>"`; if you are Codex use `[mcp_servers.minimem]` with `url` and `bearer_token_env_var` in `~/.codex/config.toml`; if you are opencode or Crush use the `mcp` block in your JSON config; if you are Gemini CLI use `httpUrl` in `~/.gemini/settings.json`.
> 6. Confirm the connection with the MCP `initialize` handshake and `tools/list` — sixteen tools must come back, including `memory_save` and `memory_recall`.
> 7. Store one fact with `memory_save` and read it back with `memory_recall` to prove the round trip.
> 8. Tell me the path of the env file, the URL, and how to connect a *second* client.
>
> Do not put the token in any file that gets committed, and do not change `AUTH_ENABLED` to `0`.

### Usage prompt

For an agent that is already connected — put it in the agent's instructions file (`AGENTS.md`, `CLAUDE.md`, the client's system prompt):

> You have a shared, persistent memory store (minimem) exposed as MCP tools. Use it like this:
>
> - **Recall before you answer.** `memory_recall` for anything that depends on what you already know (the user's setup, a project's state, a decision from last week). `memory_search` if you only want a plain ranked search. `memory_recall` returns provenance — which signal found each memory, how old it is (`age_days`), who wrote it (`agent_source`) and how much to trust it (`trust`). Prefer a `verified` memory from today over an `unverified` one from last month, and say so when the store disagrees with the current conversation.
> - **Save durable facts only** with `memory_save` — a host, a port, a path, a decision, a gotcha, a preference. Not the weather, not a task list, not a transcript. One fact per memory, with tags (a project slug, a topic). Exact duplicates are merged automatically, so do not check first.
> - **When you correct or update something you already stored**, call `memory_supersede` with the new id as `current` and the old one as `other`. Nothing in the text tells the store the two are the same fact, so without this the stale version keeps being recalled as if it were current. A redundant memory costs a little; a wrong one is a silent hole.
> - **Mark confidence** with `memory_trust` — `verified` for something you confirmed, `disputed` for something you know is probably wrong. It never changes the text.
> - **Read the history first** when a memory looks wrong: `memory_search` with the same query, and check `GET /memories/:id/history`.
> - **Hand off work** with `handoff_write` when you finish something another agent should pick up, and start with `handoff_read` to see what was left for you. Use `lease_acquire` before editing something another agent may be editing.
> - **Durable rules** — "do it this way" lessons — go to `lesson_save`, scoped to the project or tool. Merged/summarised long-term views go to `crystal_save`.
> - **Never** put secrets, tokens or passwords into a memory. The database is a secret-bearing store; treat it that way.

# AGENTS.md — minimem

Shared, persistent memory store for all lab agents (Hermes / Opencode / Pig / Crush).
One SQLite (FTS5 **trigram** + optional 1024-dim semantic index) file + one Bun process +
REST + web UI + MCP.

## This project in one line
The lab's canonical **memory** (cross-session knowledge). NOT project docs — those live in
each project's `AGENTS.md`. minimem memory and project AGENTS.md are separate; read both.

## Stack
- Bun 1.1+ + Elysia, single file `server.ts`. SQLite via `bun:sqlite`, WAL mode.
- FTS5 **trigram** tokenizer — works for Thai/Chinese/Japanese without a segmenter.
- Thai-safety: the search path uses `search_kw.ts` (two-pass: identifiers longest-first +
  segmenter words, EN/TH stopwords, cap 8→24 terms, quoted terms). **Do not** replace with
  plain `match()` — identifiers get split mid-way (fixed 2026-10-06, test in `search.test.ts`).
- Semantic layer (`embed.ts`): optional. FTS5 keyword path is NOT replaced — it stays the
  exact-match/identifier path, and the embedding is a *second* signal blended in. With no
  provider key the whole thing degrades to keyword-only (test: `keyword-only.test.ts`).

## Run / dev
```sh
bun install
MINIMEM_ENV=~/minimem.env ./run.sh          # read env from file, no secret in shell
MINIMEM_ENV=/etc/minimem/minimem.env bun run server.ts --check   # integrity check, no bind
bun test                                     # whole suite
bun test search.test.ts                      # search regression tests
bun test hybrid.test.ts                      # ranking, provenance, no vector leaks
bun test dedupe.test.ts                      # collapse rules, incl. chain closure
bun test keyword-only.test.ts                # the no-embeddings configuration
```

## Config (env — all via MINIMEM_ENV, nothing committed)
- `MINIMEM_DB_PATH` → default `./data/minimem.db` (on this lab: `/home/admin/minimem-data/…`)
- `MINIMEM_TOKEN` — long bearer; `MINIMEM_LOCK` — short 8-char web-UI code
- `AUTH_ENABLED` (1 default), `MINIMEM_MCP` (1 default → serves `POST /mcp`)
- `HOST`/`PORT` default `0.0.0.0:3100`
- `EXTRACT_MODELS` + `AI_GATEWAY_API_KEY` — only needed by `POST /extract`
- Semantic: `CF_AI_TOKEN`, `CF_ACCOUNT_ID`, `EMBED_ENABLED`, `EMBED_MODEL`
  (`@cf/baai/bge-m3`), `EMBED_DIM` (1024), `EMBED_PROVIDER` (`cloudflare`)
- Ranking: `HYBRID_W_FTS`, `HYBRID_W_VEC`, `HYBRID_W_REC`, `SEM_MIN_RELEVANCE`,
  `SEM_COS_NOISE_FLOOR`, `SEM_COS_GOOD_CEIL`, `SEM_FTS_STRONG`, `SEM_HALF_LIFE_DAYS`,
  `SEM_DEDUPE_THRESHOLD`, `SUPERSEDE_MARGIN_HOURS`, `TRUST_WEIGHT_*`
- The DEPLOYED `SEM_*` spelling wins; the legacy spelling still works. `embed.ts` lists the
  full precedence chain in its header comment — change one place, not both.
- **Secret-heavy database**: `/` and `/health` are public; everything else guard-auth'd.
  Never bind `0.0.0.0` with auth off.

## Key paths (this lab, not re-derivable)
- Server: `:3100` (localhost REST + MCP + web UI)
- LAN via Caddy: `https://lan.mcky.space:3444/` — web UI, REST **and** MCP on the same
  origin (`https://lan.mcky.space:3444/mcp`). There is no second MCP port; the old
  `:3145` is gone.
- Service: OpenRC `minimem` (init `/etc/init.d/minimem`, env `/etc/minimem/minimem.env`)
- Data dir: `/home/admin/minimem-data/`
- Hermes plugin: `~/.hermes/plugins/minimem/` (plugin.yaml + __init__.py, MCP tools `minimem_*`)
- Hermes MCP entry: `~/.hermes/config.yaml` → `mcp_servers.minimem` (token in `~/.hermes/.env`
  as `MCP_MINIMEM_API_KEY`)
- Web UI: `public/index.html` — one hand-written file, no build step / no bundler; served
  `no-store` via `Bun.file`, so editing it is live without a restart. Themes: `data-theme="day|night"`.
  Brand direction and the design rules live in `DESIGN.md` (read it before touching the UI).
  Pages: Home (dashboard), Recent, Tags, Add, Extract, Trash, Relay, Docs (how to use it),
  Info (the long version: measurements, endpoint surface, escalation, latency, accuracy).
- UI checks: `sh test/ui/run.sh` — headless chromium over CDP (node ≥22, no deps), throwaway
  instances on :3311 (auth off) / :3312 (auth on), never touches :3100. See `test/ui/README.md`.
- Copied legacy: `~/projects/memory-service/` — the ORIGINAL minimem (same schema); **stopped/legacy, do not run it**.

## API essentials
- `GET /health` → `{ok,name,version,auth}` · `GET /stats` → `{live,deleted,history,tags,relay}`
- `GET /memories?tag=&limit=&offset=&q=` · `POST /memories` (single object `{text,tags}`,
  exact duplicate → returns existing id with tags merged)
- `GET /memories/search?q=&tag=&limit=` — ranked (hybrid by default, `?mode=keyword` for the
  pure FTS5 path, `?trust=` to filter)
- `GET /memories/recall?q=&limit=&tag=&mode=&trust=&dedupe=` — the same ranking **with
  provenance**: `match` (both/keyword/semantic/none), `cos`, `age_days`, `trust`,
  `agent_source`, and `shadowed` (the older vintages a current record supersedes)
- `GET /embeddings` — index state, never the token · `POST /embeddings/backfill?limit=&batch=`
- `GET|POST|DELETE /supersedes` — "same fact, this one is current" relations
- `DELETE /memories/:id/purge?confirm=yes` — hard delete, trashed rows only
- Soft deletes: `GET /memories/deleted` · `POST /memories/:id/restore`
- `GET /memories/:id/history` — every version · `GET /tags` — tag cloud (live only)
- Relay: `/handoff` (write/read/ack), `/leases`, `/lessons`, `/crystals`, `/audit`
- `POST /mcp` — JSON-RPC 2.0 streamable HTTP, **16 tools**:
  `memory_save/search/recall/trust/recent/forget/supersede`, `lesson_save/list`,
  `handoff_write/read/ack`, `lease_acquire/release`, `crystal_save`, `memory_stats`

## Same-fact relations (the important part)
Cosine measures topical similarity, not factual identity. Measured on 67 hand-labelled
pairs, 27 "different fact" pairs sat *above* most genuine revision pairs, and every lexical
substitute scored F1 ≤ 0.77. So "is this the same fact?" is answered by a **stored
relation**, produced by a model and read by the recall path — never by a threshold.

- `curate.ts` — the offline pass: find candidate pairs → extract claims → judge → write relations.
  Dry run by default; `--apply` writes.
- `adjudicate.ts` — the two stages (claim extraction, merge test) + the router client.
- `artifact.ts` — the deterministic veto: same template, different artifact ⇒ never collapse.
  Precision 1.00 on the labelled set.
- The relation is the **authority** in the collapse; a cosine score is not, and the relation
  graph is **closed** before use so a chain's root is shadowed by its live descendant.
- The hand labels in `docs/hand-labels.json` are the ground truth. When they and the model
  disagree, the labels win — and the labels get corrected, not the model.
- Full reasoning and the measurements: `docs/same-fact.md`. Prompt A/B evidence:
  `docs/prompt-ab/`.

## Durability
- Every write journaled to `history` (previous text+tags) before it lands.
- `DELETE` = soft (`deleted_at` set, row kept). WAL mode, `PRAGMA user_version` = schema version.
- Backup: `sqlite3 <db> ".backup out.db"` (online) — keep off-box, file stays <10 MB.
- OpenRC stop-then-start beats `restart` (supervise-daemon can leave a child holding the port).
- A copy of a live DB must use `VACUUM INTO` — a plain `cp` misses the WAL and gives stale vectors.

## Conventions
- `--check` verifies integrity without binding the port (used in Cronie/health probes).
- **Do not tune the ranking knobs by feel.** The defaults are measured; the corpus they were
  measured on is 67 labelled pairs, and every knob has a stated reason. Change one, re-run
  `bun test hybrid.test.ts` and `check-recall.ts`, and write down why.
- A check that can pass or fail depending on which process answers it is not a check — the
  check scripts must own their own server (find a free port, kill the child on exit).
- A model failure is skipped, never guessed. A redundant memory costs a little; a missing one
  is a silent hole. Prefer the safe direction.

## Docs
- `README.md` — what it is, how to run it, the full API.
- `docs/INSTALL.md` — per-client config (Claude Code, Codex, opencode, Crush, Gemini CLI,
  Cursor/Windsurf) + a prompt you can hand an AI agent to install and connect itself.
- `docs/same-fact.md` — how "is this the same fact?" is decided, with the measurements.
- `docs/prompt-ab/README.md` — how the prompt comparison was run, and why the first one was invalid.

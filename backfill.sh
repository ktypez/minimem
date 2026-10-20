#!/bin/sh
# Embed existing memories (backfill / top-up the semantic index).
#
#   ./backfill.sh                 embed up to 25 pending memories
#   ./backfill.sh --limit 200     more per run (idempotent, resumable)
#   ./backfill.sh --batch 32      texts per provider call
#   ./backfill.sh --stats         just print index coverage, embed nothing
#
# Env comes from the same file the server uses, so no secret is on the command
# line: MINIMEM_ENV=/etc/minimem/minimem.env (or ./env, ./.env).
set -e

BUN="${BUN:-$HOME/.bun/bin/bun}"
if [ ! -x "$BUN" ]; then BUN="$(command -v bun 2>/dev/null || true)"; fi
[ -x "$BUN" ] || { echo "bun not found (set BUN=/path/to/bun)" >&2; exit 1; }

DIR="$(cd "$(dirname "$0")" && pwd)"
ENVF="${MINIMEM_ENV:-/etc/minimem/minimem.env}"
if [ ! -r "$ENVF" ] && [ -r "$DIR/.env" ]; then ENVF="$DIR/.env"; fi
[ -r "$ENVF" ] || { echo "no env file — set MINIMEM_ENV=/path/to/minimem.env" >&2; exit 1; }

set -a
# shellcheck disable=SC1090
. "$ENVF"
set +a

[ -n "${MINIMEM_DB_PATH:-}" ] || { echo "MINIMEM_DB_PATH is not set in $ENVF" >&2; exit 1; }

cd "$DIR"
exec "$BUN" run embedstore.ts "$@"

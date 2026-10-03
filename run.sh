#!/bin/sh
# minimem launcher. Env comes from an external file (never committed):
#   MINIMEM_ENV=/etc/minimem/minimem.env   (or ./env, or ./.env)
# The AI Gateway key for /extract is taken from that file, else ~/.hermes/.env.
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

if [ -z "${AI_GATEWAY_API_KEY:-}" ] && [ -r "$HOME/.hermes/.env" ]; then
  AI_GATEWAY_API_KEY="$(grep -m1 '^AI_GATEWAY_API_KEY=' "$HOME/.hermes/.env" | cut -d= -f2-)"
  [ -n "$AI_GATEWAY_API_KEY" ] && export AI_GATEWAY_API_KEY
fi

[ -n "${EXTRACT_MODELS:-}" ] || export EXTRACT_MODELS="google/gemini-2.5-flash-lite"

cd "$DIR"
exec "$BUN" run server.ts
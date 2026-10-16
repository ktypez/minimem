#!/bin/sh
# Fresh store for the gate checks: throwaway db on :3312 with AUTH_ENABLED=1.
# Two rows so the unlocked view has a live count to assert.
set -e
. "$(dirname "$0")/lib.sh"
B=http://127.0.0.1:$AUTH_PORT
TOKEN=${MINIMEM_TOKEN:-testtoken}
stop_port "$AUTH_PORT"
sleep 1
rm -f "$UI_OUT/auth.db"*
cd "$REPO"
MINIMEM_DB_PATH="$UI_OUT/auth.db" HOST=127.0.0.1 PORT=$AUTH_PORT AUTH_ENABLED=1 \
  MINIMEM_TOKEN="$TOKEN" MINIMEM_MCP=0 nohup "$BUN" run server.ts > "$UI_OUT/auth.log" 2>&1 &
wait_health "$B"

post() { curl -s -X POST -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN" -d "$2" "$B$1" >/dev/null; }
post /memories '{"text":"gate check row one","tags":["auth"]}'
post /memories '{"text":"gate check row two","tags":["auth"]}'
curl -s "$B/health"; echo

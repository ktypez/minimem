#!/bin/sh
# Drive the web UI in a headless browser and assert what it does.
#
#   sh test/ui/run.sh            every suite
#   sh test/ui/run.sh drive      just the UI suite   (auth off, :3311)
#   sh test/ui/run.sh gate       just the gate suite  (auth on,  :3312)
#
# Starts one headless chromium, runs the suites against throwaway instances on
# :3311/:3312, and cleans up after itself. The live service on :3100 is never
# touched — screenshots and dbs land in $UI_OUT (default $TMPDIR/minimem-uicheck).
set -e
. "$(dirname "$0")/lib.sh"
guard_production

[ -n "$CHROME" ] || { echo "no chromium/chrome on PATH — set CHROME=/path/to/chromium" >&2; exit 1; }
command -v node >/dev/null || { echo "node >= 22 is needed for the CDP drivers (WebSocket is global)" >&2; exit 1; }
node -e 'process.exit(+process.versions.node.split(".")[0] >= 22 ? 0 : 1)' \
  || { echo "node $(node -v) is too old: the drivers use the global WebSocket (node >= 22)" >&2; exit 1; }

SUITES=
[ -n "$1" ] && SUITES=$1 || SUITES="drive gate"

PROFILE="$UI_OUT/chrome-profile"
CHROME_PID=
cleanup() {
  # kill the browser we started, then anything still holding its profile dir
  [ -n "$CHROME_PID" ] && kill "$CHROME_PID" 2>/dev/null || true
  for p in $(pgrep -f "user-data-dir=$PROFILE" 2>/dev/null); do kill "$p" 2>/dev/null || true; done
  stop_port "$UI_PORT"
  stop_port "$AUTH_PORT"
}
trap cleanup EXIT INT TERM

rm -rf "$PROFILE"
"$CHROME" --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage \
  --remote-debugging-port=$CDP_PORT --user-data-dir="$PROFILE" about:blank \
  >"$UI_OUT/chrome.log" 2>&1 &
CHROME_PID=$!
for _ in $(seq 1 40); do
  curl -sf "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -sf "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null || { echo "chromium never opened :$CDP_PORT" >&2; exit 1; }

rc=0
for s in $SUITES; do
  echo
  echo "── $s ──"
  case $s in
    drive)
      sh "$UI_DIR/reset.sh"
      UI_URL="http://127.0.0.1:$UI_PORT/" node "$UI_DIR/drive.mjs" || rc=1
      ;;
    gate)
      sh "$UI_DIR/reset-auth.sh"
      UI_URL="http://127.0.0.1:$AUTH_PORT/" node "$UI_DIR/gate.mjs" || rc=1
      UI_URL="http://127.0.0.1:$AUTH_PORT/" node "$UI_DIR/header.mjs" || rc=1
      ;;
    *) echo "unknown suite: $s (use drive | gate)" >&2; rc=2 ;;
  esac
done

echo
echo "screenshots + logs: $UI_OUT"
[ $rc = 0 ] && echo "UI CHECK: PASS" || echo "UI CHECK: FAIL"
exit $rc

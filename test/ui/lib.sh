# Shared config for the UI check harness. Sourced by the other scripts.
#   UI_OUT    where artefacts go (dbs, logs, screenshots)   default: $TMPDIR/minimem-uicheck
#   CDP_PORT  chromium devtools port                        default: 9222
#   BUN       bun binary                                    default: `bun` on PATH
#   CHROME    chromium binary                               default: first one on PATH
UI_DIR=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$UI_DIR/../.." && pwd)
UI_OUT=${UI_OUT:-${TMPDIR:-/tmp}/minimem-uicheck}
CDP_PORT=${CDP_PORT:-9222}
BUN=${BUN:-$(command -v bun || echo "$HOME/.bun/bin/bun")}
CHROME=${CHROME:-$(command -v chromium || command -v chromium-browser || command -v google-chrome || true)}
UI_PORT=${UI_PORT:-3311}        # auth off  (drive.mjs)
AUTH_PORT=${AUTH_PORT:-3312}    # auth on   (gate.mjs, header.mjs)
mkdir -p "$UI_OUT"

# A bun process shows no env in its cmdline, so the listening port is the only handle on it.
stop_port() {
  for p in $(ss -ltnp 2>/dev/null | sed -n "s/.*:$1 .*pid=\([0-9]*\).*/\1/p"); do kill "$p" 2>/dev/null || true; done
}
# The service under test is throwaway; the real one on :3100 is not ours to touch.
guard_production() {
  if ss -ltn 2>/dev/null | grep -q ":3100 "; then
    echo "note: the live service is on :3100 — these checks use :$UI_PORT and :$AUTH_PORT and leave it alone"
  fi
}
wait_health() {
  for _ in $(seq 1 40); do
    curl -sf "$1/health" >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  echo "instance on $1 never came up:" >&2
  tail -5 "$UI_OUT/server.log" >&2 2>/dev/null
  return 1
}

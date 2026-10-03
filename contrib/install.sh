#!/bin/sh
# minimem installer — Alpine/postmarketOS (OpenRC) and systemd hosts.
#
# Portable by design: it finds whatever privilege tool the box has (root,
# sudo, doas, sup) and either writes an OpenRC service or a systemd unit.
# Idempotent: running it twice is a no-op, not a mess.
#
#   ./contrib/install.sh                      # install, prompt-free defaults
#   ./contrib/install.sh --auth off --host 127.0.0.1
#   ./contrib/install.sh --dry-run            # show every step, write nothing
#   ./contrib/install.sh --uninstall
#
# Env knobs (flags win): MINIMEM_USER, MINIMEM_DB_DIR, MINIMEM_SERVICE,
# MINIMEM_PORT, MINIMEM_HOST, MINIMEM_AUTH.

set -eu

PREFIX_SELF="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$PREFIX_SELF/.." && pwd)"

SERVICE="${MINIMEM_SERVICE:-minimem}"
SVC_USER="${MINIMEM_USER:-$(id -un)}"
DB_DIR="${MINIMEM_DB_DIR:-$HOME/minimem-data}"
PORT="${MINIMEM_PORT:-3100}"
HOST="${MINIMEM_HOST:-127.0.0.1}"
AUTH="${MINIMEM_AUTH:-on}"
DRY=0
UNINSTALL=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)   DRY=1 ;;
    --uninstall) UNINSTALL=1 ;;
    --service)   SERVICE="$2"; shift ;;
    --user)      SVC_USER="$2"; shift ;;
    --db-dir)    DB_DIR="$2"; shift ;;
    --port)      PORT="$2"; shift ;;
    --host)      HOST="$2"; shift ;;
    --auth)      AUTH="$2"; shift ;;
    -h|--help)   sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
  shift
done

case "$AUTH" in
  on|1|true|yes)  AUTH_LINE="AUTH_ENABLED=1"; AUTH_WORD="on" ;;
  off|0|false|no) AUTH_LINE="AUTH_ENABLED=0"; AUTH_WORD="off" ;;
  *) echo "--auth takes on/off, got '$AUTH'" >&2; exit 2 ;;
esac

# --- privilege tool -----------------------------------------------------------
PRIV=""
if [ "$(id -u)" = "0" ]; then
  PRIV=""
elif command -v sup  >/dev/null 2>&1; then PRIV="sup"
elif command -v doas >/dev/null 2>&1; then PRIV="doas"
elif command -v sudo >/dev/null 2>&1; then PRIV="sudo"
else
  echo "No way to become root (checked sup, doas, sudo) and you are not root." >&2
  exit 1
fi

run() {
  if [ "$DRY" = "1" ]; then
    printf 'DRY  %s\n' "$*"
    return 0
  fi
  if [ -n "$PRIV" ]; then $PRIV "$@"; else "$@"; fi
}

# --- init system --------------------------------------------------------------
INIT=""
if command -v rc-service >/dev/null 2>&1 && [ -d /etc/init.d ]; then INIT="openrc"
elif command -v systemctl >/dev/null 2>&1; then INIT="systemd"
else
  echo "Neither OpenRC nor systemd found — install the service by hand from contrib/." >&2
  exit 1
fi

ENV_DIR=/etc/minimem
ENV_FILE="$ENV_DIR/$SERVICE.env"
UNIT="/etc/init.d/$SERVICE"
WRAP="/usr/local/bin/$SERVICE-server"

say() { printf '\n== %s\n' "$*"; }

# --- uninstall ----------------------------------------------------------------
if [ "$UNINSTALL" = "1" ]; then
  say "removing $SERVICE (data in $DB_DIR is left alone)"
  if [ "$INIT" = "openrc" ]; then
    run rc-service "$SERVICE" stop 2>/dev/null || true
    run rc-update del "$SERVICE" default 2>/dev/null || true
  else
    run systemctl disable --now "$SERVICE" 2>/dev/null || true
  fi
  run rm -f "$UNIT" "$WRAP" "/etc/systemd/system/$SERVICE.service" "$ENV_FILE"
  say "done — delete $DB_DIR yourself if you want the memories gone"
  exit 0
fi

say "minimem → $INIT, service '$SERVICE', user '$SVC_USER'"
echo "repo    $REPO_DIR"
echo "db      $DB_DIR/minimem.db"
echo "bind    $HOST:$PORT   auth: $AUTH_WORD"
[ -n "$PRIV" ] && echo "priv    $PRIV"

# --- 1. bun ------------------------------------------------------------------
BUN_BIN="$(command -v bun 2>/dev/null || true)"
[ -z "$BUN_BIN" ] && [ -x "$HOME/.bun/bin/bun" ] && BUN_BIN="$HOME/.bun/bin/bun"
if [ -z "$BUN_BIN" ]; then
  echo "" >&2
  echo "bun not found. Install it first:" >&2
  echo "  curl -fsSL https://bun.sh/install | bash" >&2
  exit 1
fi
echo "bun     $BUN_BIN"

# --- 2. data dir -------------------------------------------------------------
say "data directory"
# A root-created dir (mkdir via sup/sudo) would leave the service user unable
# to create the database inside it — own only what we just made.
DB_EXISTED=0
[ -d "$DB_DIR" ] && DB_EXISTED=1
run mkdir -p "$DB_DIR"
[ "$DB_EXISTED" = "0" ] && run chown "$SVC_USER:$SVC_USER" "$DB_DIR"
[ "$DB_EXISTED" = "1" ] && echo "exists — leaving its ownership alone"

# --- 3. env file (secrets live here, never in the repo) -----------------------
say "env file $ENV_FILE"
if [ "$DRY" = "0" ] && [ -f "$ENV_FILE" ]; then
  echo "exists — leaving the current token and settings untouched"
else
  TMP_ENV="$(mktemp)"
  TOKEN="$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | cut -c1-43)"
  LOCK="$(head -c 6 /dev/urandom | od -An -tu4 | tr -d ' \n' | cut -c1-8)"
  cat > "$TMP_ENV" <<EOF
# $SERVICE env — stays OUTSIDE the repo. chmod 600.
# MINIMEM_DB_PATH is absolute on purpose: code and data never travel together.
MINIMEM_DB_PATH="$DB_DIR/minimem.db"
MINIMEM_TOKEN="$TOKEN"
MINIMEM_LOCK="$LOCK"
$AUTH_LINE
HOST=$HOST
PORT=$PORT
EXTRACT_MODELS="google/gemini-2.5-flash-lite"
EOF
  run mkdir -p "$ENV_DIR"
  run install -m 600 -o "$SVC_USER" -g "$SVC_USER" "$TMP_ENV" "$ENV_FILE"
  rm -f "$TMP_ENV"
fi

# --- 4. launcher -------------------------------------------------------------
say "launcher $WRAP"
TMP_WRAP="$(mktemp)"
# run.sh owns env-file sourcing (and the AI Gateway key fallback), so the
# service just points it at the right file instead of exporting vars itself.
cat > "$TMP_WRAP" <<EOF
#!/bin/sh
# Generated by minimem contrib/install.sh — hands run.sh its env file.
export HOME="$(getent passwd "$SVC_USER" 2>/dev/null | cut -d: -f6)"
export PATH="\$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin"
export MINIMEM_ENV="$ENV_FILE"
export BUN="$BUN_BIN"
exec "$REPO_DIR/run.sh"
EOF
run install -m 755 "$TMP_WRAP" "$WRAP"
rm -f "$TMP_WRAP"

# --- 5. service unit ---------------------------------------------------------
if [ "$INIT" = "openrc" ]; then
  say "OpenRC unit $UNIT"
  TMP_UNIT="$(mktemp)"
  # Quoted heredoc: the body is a shell script for openrc-run and must keep its
  # own $variables intact. Our values go in via placeholders.
  cat > "$TMP_UNIT" <<'UNIT_EOF'
#!/sbin/openrc-run
# Generated by minimem contrib/install.sh

name="@@SERVICE@@"
description="minimem — self-hosted memory store for AI agents"

command="@@WRAP@@"
command_user="@@USER@@"
command_background=true
pidfile="/run/@@SERVICE@@.pid"
output_log="/var/log/@@SERVICE@@.log"
error_log="/var/log/@@SERVICE@@.log"

supervisor="supervise-daemon"
respawn_delay=5
respawn_max=0

depend() {
  need net
  after firewall
}

start_pre() {
  checkpath --file --owner "@@USER@@:@@USER@@" "$output_log"
}

stop_post() {
  # supervise-daemon can leave the child holding the port on a slow ARM box.
  port="@@PORT@@"
  if command -v ss >/dev/null 2>&1; then
    pids=$(ss -ltnp 2>/dev/null | grep ":${port} " | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u)
    for p in $pids; do
      [ "$p" = "$$" ] && continue
      kill "$p" 2>/dev/null
    done
  fi
  return 0
}
UNIT_EOF
  sed -i \
    -e "s|@@SERVICE@@|$SERVICE|g" \
    -e "s|@@WRAP@@|$WRAP|g" \
    -e "s|@@USER@@|$SVC_USER|g" \
    -e "s|@@PORT@@|$PORT|g" \
    "$TMP_UNIT"
  run install -m 755 "$TMP_UNIT" "$UNIT"
  rm -f "$TMP_UNIT"

  if [ "$DRY" = "0" ]; then
    say "enable at boot (default runlevel)"
    run rc-update add "$SERVICE" default 2>/dev/null || true
  fi
else
  say "systemd unit /etc/systemd/system/$SERVICE.service"
  TMP_UNIT="$(mktemp)"
  cat > "$TMP_UNIT" <<EOF
[Unit]
Description=minimem — self-hosted memory store for AI agents
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SVC_USER
EnvironmentFile=$ENV_FILE
ExecStart=$BUN_BIN run $REPO_DIR/server.ts
Restart=on-failure
RestartSec=5
WorkingDirectory=$REPO_DIR
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
  run install -m 644 "$TMP_UNIT" "/etc/systemd/system/$SERVICE.service"
  rm -f "$TMP_UNIT"
  [ "$DRY" = "0" ] && run systemctl daemon-reload
fi

# --- 6. dependencies + start -------------------------------------------------
say "install JS dependencies"
if [ "$DRY" = "0" ]; then
  ( cd "$REPO_DIR" && "$BUN_BIN" install )
else
  echo "DRY  bun install in $REPO_DIR"
fi

say "start $SERVICE"
if [ "$INIT" = "openrc" ]; then
  run rc-update add "$SERVICE" default 2>/dev/null || true
  # stop-then-start: restart can hang supervise-daemon here
  run rc-service "$SERVICE" stop 2>/dev/null || true
  run rc-service "$SERVICE" start
else
  run systemctl enable --now "$SERVICE"
fi

if [ "$DRY" = "0" ]; then
  say "verify"
  URL="http://127.0.0.1:$PORT/health"
  if command -v curl >/dev/null 2>&1; then
    # A slow ARM box can take several seconds to answer; poll instead of
    # declaring failure after one try.
    i=0
    while [ "$i" -lt 15 ]; do
      if curl -sS -m 3 "$URL" 2>/dev/null; then echo; break; fi
      i=$((i + 1))
      sleep 1
    done
    if [ "$i" -ge 15 ]; then
      echo "no answer from $URL after 15s — last log lines:"
      tail -20 "/var/log/$SERVICE.log" 2>/dev/null || true
    fi
  fi
  echo
  echo "UI       http://$HOST:$PORT/"
  if [ "$AUTH_WORD" = "on" ]; then
    echo "token    $ENV_FILE (mode 600) — paste it into the UI once"
  else
    echo "auth off — make sure $HOST is loopback or a private VPN, never 0.0.0.0 on a shared LAN"
  fi
fi
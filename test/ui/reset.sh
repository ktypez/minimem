#!/bin/sh
# Fresh store for the UI checks: throwaway db on :3311 with AUTH_ENABLED=0.
# Seeded to fit what drive.mjs asserts (4 live rows → nav count 4, one unacked
# handoff, a lesson, a lease, two crystals, one row to trash).
set -e
. "$(dirname "$0")/lib.sh"
B=http://127.0.0.1:$UI_PORT
stop_port "$UI_PORT"
sleep 1
rm -f "$UI_OUT/test.db"*
cd "$REPO"
MINIMEM_DB_PATH="$UI_OUT/test.db" HOST=127.0.0.1 PORT=$UI_PORT AUTH_ENABLED=0 MINIMEM_MCP=0 \
  nohup "$BUN" run server.ts > "$UI_OUT/server.log" 2>&1 &
wait_health "$B"

post() { curl -s -X POST -H 'Content-Type: application/json' -d "$2" "$B$1" >/dev/null; }
post /memories '{"text":"minimem runs on :3100 behind Caddy; the web UI is public, the API is token-guarded.","tags":["infra","ports"]}'
post /memories '{"text":"FTS5 trigram tokenizer handles Thai without a segmenter — do not swap it for plain match().","tags":["search","thai"]}'
post /memories '{"text":"OpenRC stop-then-start beats restart; supervise-daemon can leave a child holding the port.","tags":["openrc","gotcha"]}'
post /memories '{"text":"ต้องการทดสอบภาษาไทยยาวๆ กับป้ายแท็กหลายอัน เพื่อดูว่าการ์ดตัดบรรทัดสวยไหม และปุ่มต่างๆ ยังกดได้อยู่หรือเปล่าในจอมือถือ","tags":["thai","layout","mobile","test"]}'
post /handoff '{"from":"hermes","to":"crush","topic":"deploy check","body":"หลังแก้ index.html ให้รีสตาร์ท service แล้วเช็ก /health กับหน้าเว็บ"}'
post /lessons '{"text":"always stop then start the OpenRC service, never restart","scope":"minimem"}'
post /leases '{"name":"public/index.html","holder":"opencode","ttl_minutes":30,"note":"editing the guild hall design"}'
post /crystals '{"text":"UI + search constraints for minimem","sources":[1,2]}'
curl -s "$B/stats"; echo

#!/usr/bin/env bash
# API 烟测（cloudflared-manager）：覆盖鉴权 / Configs CRUD（含 token 脱敏）/
# Validate / Lifecycle / Metrics / Alerts / Logs / System / Binaries /
# Import-Export / 已删端点。
#
# 用法（需要 daemon 在 BASE 上跑、TOKEN 是其 API token）：
#   BASE=http://127.0.0.1:8101 TOKEN=dev bash scripts/api-smoke.sh
# 默认值：BASE=http://127.0.0.1:8101, TOKEN=dev
#
# 提示：Lifecycle 段需要 PATH 中存在可用的 cloudflared（或假二进制），且 token
# 长度 ∈ [100,1500] 才能真正 started；否则 start 会以 last_error 失败但仍返回
# 200 Snapshot——本脚本对此做了兼容判断。
B="${BASE:-http://127.0.0.1:8101}/api/v1"
H_AUTH="Authorization: Bearer ${TOKEN:-dev}"
H_BAD="Authorization: Bearer wrong-token"
H_JSON="Content-Type: application/json"
H_YAML="Content-Type: application/yaml"

# 一个长度合法的占位 token（≥100 base64 字符），用于 Validate / Lifecycle。
LONGTOK=$(printf 'A%.0s' $(seq 1 150))

PASS=0
FAIL=0
FAILED_TESTS=()

check() {
  local name=$1 expected=$2; shift 2
  local got
  got=$(curl -s -o /dev/null -w '%{http_code}' "$@")
  if [ "$got" = "$expected" ]; then
    printf '  ✅ %-54s [%s]\n' "$name" "$got"
    PASS=$((PASS+1))
  else
    printf '  ❌ %-54s [got=%s want=%s]\n' "$name" "$got" "$expected"
    FAIL=$((FAIL+1))
    FAILED_TESTS+=("$name (got=$got want=$expected)")
  fi
}

check_contains() {
  local name=$1 expected=$2 substr=$3; shift 3
  local resp status body
  resp=$(curl -s -w '\n%{http_code}' "$@")
  status=$(echo "$resp" | tail -1)
  body=$(echo "$resp" | sed '$d')
  if [ "$status" = "$expected" ] && echo "$body" | grep -q "$substr"; then
    printf '  ✅ %-54s [%s, contains %q]\n' "$name" "$status" "$substr"
    PASS=$((PASS+1))
  else
    printf '  ❌ %-54s [status=%s want=%s, missing %q]\n' "$name" "$status" "$expected" "$substr"
    FAIL=$((FAIL+1))
    FAILED_TESTS+=("$name")
  fi
}

check_absent() {
  # 断言响应体中 NOT 包含某子串（用于 token 脱敏）
  local name=$1 substr=$2; shift 2
  local body
  body=$(curl -s "$@")
  if echo "$body" | grep -q "$substr"; then
    printf '  ❌ %-54s [leaked %q]\n' "$name" "$substr"
    FAIL=$((FAIL+1))
    FAILED_TESTS+=("$name (leaked $substr)")
  else
    printf '  ✅ %-54s [absent %q]\n' "$name" "$substr"
    PASS=$((PASS+1))
  fi
}

section() { echo; echo "==== $1 ===="; }

section "1. 鉴权"
check "health 无鉴权 200" 200 "$B/health"
check "version 无鉴权 401" 401 "$B/version"
check "version 错 token 401" 401 -H "$H_BAD" "$B/version"
check "version 正确 token 200" 200 -H "$H_AUTH" "$B/version"

section "2. Configs CRUD（TunnelConfigV1 + token 脱敏）"
check "POST /configs 201" 201 -H "$H_AUTH" -H "$H_JSON" -X POST "$B/configs" \
  -d "{\"id\":\"srv1\",\"config\":{\"token\":\"$LONGTOK\",\"edge\":{\"protocol\":\"auto\"},\"logging\":{\"logLevel\":\"info\"}},\"cfdmgr\":{\"name\":\"smoke1\",\"manualStart\":true}}"
check "POST /configs 重复 409" 409 -H "$H_AUTH" -H "$H_JSON" -X POST "$B/configs" \
  -d '{"id":"srv1","config":{"edge":{"protocol":"auto"}},"cfdmgr":{}}'
check "POST /configs 缺 id 400" 400 -H "$H_AUTH" -H "$H_JSON" -X POST "$B/configs" -d '{"config":{"edge":{}}}'
check "POST /configs 非法 id 400" 400 -H "$H_AUTH" -H "$H_JSON" -X POST "$B/configs" \
  -d '{"id":"bad/id","config":{"edge":{}},"cfdmgr":{}}'
check "POST /configs 未知字段 400 (DisallowUnknownFields)" 400 -H "$H_AUTH" -H "$H_JSON" -X POST "$B/configs" \
  -d '{"id":"x","config":{"edge":{}},"cfdmgr":{},"hacker":true}'
check_contains "GET /configs 列表含 srv1" 200 '"id":"srv1"' -H "$H_AUTH" "$B/configs"
check_contains "GET /configs/srv1 含 protocol(嵌套)" 200 '"protocol":"auto"' -H "$H_AUTH" "$B/configs/srv1"
check_contains "GET /configs/srv1 has_token:true" 200 '"has_token":true' -H "$H_AUTH" "$B/configs/srv1"
check_absent "GET /configs/srv1 不泄漏 token 明文" "$LONGTOK" -H "$H_AUTH" "$B/configs/srv1"
check_contains "GET /configs/srv1/token 掩码" 200 '"masked"' -H "$H_AUTH" "$B/configs/srv1/token"
check "GET /configs/nonexist 404" 404 -H "$H_AUTH" "$B/configs/nonexist"
check "PUT /configs/srv1（空 token，保留原值）200" 200 -H "$H_AUTH" -H "$H_JSON" -X PUT "$B/configs/srv1" \
  -d '{"config":{"edge":{"protocol":"http2"},"reliability":{"retries":3}},"cfdmgr":{"name":"smoke1","manualStart":true}}'
check_contains "PUT 后 retries 已更新(嵌套保留)" 200 '"retries":3' -H "$H_AUTH" "$B/configs/srv1"
check "PATCH /configs/srv1 200" 200 -H "$H_AUTH" -H "$H_JSON" -X PATCH "$B/configs/srv1" \
  -d '{"logging":{"logLevel":"debug"}}'
check_contains "PATCH 后 logLevel=debug" 200 '"logLevel":"debug"' -H "$H_AUTH" "$B/configs/srv1"
check "POST /configs/srv1/duplicate 201" 201 -H "$H_AUTH" -H "$H_JSON" -X POST "$B/configs/srv1/duplicate" \
  -d '{"new_id":"srv1_copy"}'
check_contains "副本 has_token:false（不复制 token）" 200 '"has_token":false' -H "$H_AUTH" "$B/configs/srv1_copy"
check "POST /configs/reorder 204" 204 -H "$H_AUTH" -H "$H_JSON" -X POST "$B/configs/reorder" \
  -d '{"order":["srv1_copy","srv1"]}'
check_contains "GET /configs/srv1/raw 是 YAML" 200 'protocol: http2' -H "$H_AUTH" "$B/configs/srv1/raw"
check "PUT /configs/srv1/raw 合法 YAML 200" 200 -H "$H_AUTH" -H "$H_YAML" -X PUT "$B/configs/srv1/raw" \
  --data-binary "token: $LONGTOK
edge:
  protocol: auto
"
check "PUT /configs/srv1/raw 非法 YAML 400" 400 -H "$H_AUTH" -H "$H_YAML" -X PUT "$B/configs/srv1/raw" \
  --data-binary 'edge: [ this : is : broken'

section "3. Validate"
check_contains "POST /validate JSON 合法 valid:true" 200 '"valid":true' -H "$H_AUTH" -H "$H_JSON" -X POST "$B/validate" -d '{"edge":{"protocol":"quic"}}'
check_contains "POST /validate JSON 非法 protocol valid:false" 200 '"valid":false' -H "$H_AUTH" -H "$H_JSON" -X POST "$B/validate" -d '{"edge":{"protocol":"banana"}}'
check_contains "POST /validate postQuantum 跨字段 valid:false" 200 '"valid":false' -H "$H_AUTH" -H "$H_JSON" -X POST "$B/validate" -d '{"edge":{"protocol":"http2","postQuantum":true}}'
check_contains "POST /validate YAML 合法 valid:true" 200 '"valid":true' -H "$H_AUTH" -H "$H_YAML" -X POST "$B/validate" --data-binary 'logging:
  logLevel: info'

section "4. Lifecycle"
check "POST /configs/srv1/start 200" 200 -H "$H_AUTH" -X POST "$B/configs/srv1/start"
sleep 3
# 有 cloudflared(或假二进制)时应 started；无则 stopped + last_error。两者皆为 200。
STATE=$(curl -s -H "$H_AUTH" "$B/configs/srv1/status" | grep -o '"state":"[a-z]*"' | head -1)
echo "    （srv1 当前状态：$STATE）"
check "GET /configs/srv1/status 200" 200 -H "$H_AUTH" "$B/configs/srv1/status"
check "POST /configs/srv1/reload 200" 200 -H "$H_AUTH" -X POST "$B/configs/srv1/reload"
check "POST /configs/nonexist/start 404" 404 -H "$H_AUTH" -X POST "$B/configs/nonexist/start"

section "5. Metrics 历史流量"
NOW=$(date +%s)
check_contains "GET /metrics/srv1/traffic 有 points 数组" 200 '"points":' -H "$H_AUTH" "$B/metrics/srv1/traffic?to=$((NOW+10))&step=10"
check "GET /metrics/srv1/traffic 缺 to 400" 400 -H "$H_AUTH" "$B/metrics/srv1/traffic"

section "6. Alerts"
check_contains "POST /alerts 201 含 id" 201 '"id":' -H "$H_AUTH" -H "$H_JSON" -X POST "$B/alerts" \
  -d '{"name":"HA断开","enabled":true,"metric":"conns","op":"<","threshold":1,"for_seconds":0}'
check "POST /alerts 非法 metric 400" 400 -H "$H_AUTH" -H "$H_JSON" -X POST "$B/alerts" -d '{"name":"x","metric":"ha_conns","op":">=","threshold":1}'
check "POST /alerts 非法 op 400" 400 -H "$H_AUTH" -H "$H_JSON" -X POST "$B/alerts" -d '{"name":"x","metric":"conns","op":"==","threshold":1}'
check "POST /alerts 缺 metric 400" 400 -H "$H_AUTH" -H "$H_JSON" -X POST "$B/alerts" -d '{"name":"x"}'
check_contains "GET /alerts 列表" 200 '"items":' -H "$H_AUTH" "$B/alerts"
RULE_ID=$(curl -s -H "$H_AUTH" "$B/alerts" | grep -oE '"id":"rule_[a-z0-9]+"' | head -1 | sed 's/.*:"\(.*\)"/\1/')
check "GET /alerts/{id} 200" 200 -H "$H_AUTH" "$B/alerts/$RULE_ID"
check "PUT /alerts/{id} 200" 200 -H "$H_AUTH" -H "$H_JSON" -X PUT "$B/alerts/$RULE_ID" \
  -d '{"name":"改","enabled":true,"metric":"requests_rate","op":">","threshold":100,"for_seconds":30}'
check "GET /alerts/nonexist 404" 404 -H "$H_AUTH" "$B/alerts/nonexist"
check_contains "GET /alerts/events" 200 '"items":' -H "$H_AUTH" "$B/alerts/events"
check "DELETE /alerts/{id} 204" 204 -H "$H_AUTH" -X DELETE "$B/alerts/$RULE_ID"

section "7. Logs"
check_contains "GET /configs/srv1/logs lines" 200 '"lines":' -H "$H_AUTH" "$B/configs/srv1/logs"
check_contains "GET /configs/srv1/logs/files items" 200 '"items":' -H "$H_AUTH" "$B/configs/srv1/logs/files"
check "DELETE /configs/srv1/logs 204" 204 -H "$H_AUTH" -X DELETE "$B/configs/srv1/logs"
check "DELETE /configs/nonexist/logs 404" 404 -H "$H_AUTH" -X DELETE "$B/configs/nonexist/logs"

section "8. System"
check_contains "GET /system/info uptime_s" 200 '"uptime_s":' -H "$H_AUTH" "$B/system/info"
check "GET /system/cpu 200" 200 -H "$H_AUTH" "$B/system/cpu"
check "GET /system/memory 200" 200 -H "$H_AUTH" "$B/system/memory"
check "GET /system/disk 200" 200 -H "$H_AUTH" "$B/system/disk"
check "GET /system/network 200" 200 -H "$H_AUTH" "$B/system/network"
check "GET /system/connections 200" 200 -H "$H_AUTH" "$B/system/connections"
check "GET /system/process 200" 200 -H "$H_AUTH" "$B/system/process"

section "9. Binaries"
check_contains "GET /binaries 列表" 200 '"items":' -H "$H_AUTH" "$B/binaries"
check "POST /binaries/{ver}/activate 非法 version 400" 400 -H "$H_AUTH" -X POST "$B/binaries/..%2f..%2fevil/activate"
check "DELETE /binaries/nonexist 404" 404 -H "$H_AUTH" -X DELETE "$B/binaries/9999.9.9"

section "10. Import/Export"
check "GET /configs/srv1/export 200 YAML" 200 -H "$H_AUTH" "$B/configs/srv1/export"
check "GET /export/all 200 ZIP" 200 -H "$H_AUTH" "$B/export/all"
check_contains "POST /import/text 200" 200 '"id":"imported"' -H "$H_AUTH" -H "$H_JSON" -X POST "$B/import/text" \
  -d '{"id":"imported","text":"edge:\n  protocol: http2\n"}'
check "POST /import/text 缺 text 400" 400 -H "$H_AUTH" -H "$H_JSON" -X POST "$B/import/text" -d '{"id":"x"}'
check "POST /import/url 非法 scheme 400" 400 -H "$H_AUTH" -H "$H_JSON" -X POST "$B/import/url" -d '{"id":"x","url":"file:///etc/passwd"}'
check_contains "导入后 GET 字段对齐" 200 '"protocol":"http2"' -H "$H_AUTH" "$B/configs/imported"

section "11. 已删端点（frp 时代）"
check "GET /runtime/srv1/overview 404" 404 -H "$H_AUTH" "$B/runtime/srv1/overview"
check "GET /configs/srv1/proxies 404" 404 -H "$H_AUTH" "$B/configs/srv1/proxies"
# 未注册路径的 POST：chi 仅在 /* 注册了 GET，故 POST 返回 405（而非 404）。
check "POST /nathole/discover 405" 405 -H "$H_AUTH" -X POST "$B/nathole/discover"

section "12. 清理"
check "POST /configs/srv1/stop 200" 200 -H "$H_AUTH" -X POST "$B/configs/srv1/stop"
sleep 1
check_contains "stop 后 stopped" 200 '"state":"stopped"' -H "$H_AUTH" "$B/configs/srv1/status"
check "DELETE /configs/srv1 204" 204 -H "$H_AUTH" -X DELETE "$B/configs/srv1"
check "DELETE 已删的 404" 404 -H "$H_AUTH" -X DELETE "$B/configs/srv1"
check "DELETE /configs/srv1_copy 204" 204 -H "$H_AUTH" -X DELETE "$B/configs/srv1_copy"
check "DELETE /configs/imported 204" 204 -H "$H_AUTH" -X DELETE "$B/configs/imported"

echo
echo "============================================================"
echo "Summary: PASS=$PASS  FAIL=$FAIL"
if [ $FAIL -gt 0 ]; then
  echo "Failed tests:"
  for t in "${FAILED_TESTS[@]}"; do echo "  - $t"; done
fi
echo "============================================================"
exit $FAIL

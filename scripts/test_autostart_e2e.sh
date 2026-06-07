#!/usr/bin/env bash
# End-to-end test for AutoStart-via-manualStart (cloudflared model).
#
# In the cloudflared model a profile file is pure TunnelConfigV1 YAML; the
# display name + manualStart flag live in meta.json (names/manual maps), NOT
# in the profile. AutoStart skips ids whose meta.manual[id]==true and tries to
# start the rest in meta.sort order.
#
# To avoid needing a real cloudflared binary we seed profiles WITHOUT a token:
# AutoStart will ATTEMPT to start a non-manual instance and log
#   msg="auto-start failed" id=<X> err="token is required to start cloudflared"
# while a manualStart=true instance is skipped entirely (no such line). We
# assert on that intent rather than on a tunnel actually coming up.
#
# Spins up an isolated cfdmgrd on an alt port + data dir; does not touch the
# running dev environment.

set -uo pipefail

PORT=${TEST_PORT:-18080}
TOKEN=${TEST_TOKEN:-e2etest}
DATA=${TEST_DATA:-tmp/test-autostart}
BIN=${TEST_BIN:-./tmp/cfdmgrd-autotest.exe}
BASE="http://127.0.0.1:${PORT}"
PASS=0
FAIL=0

cR='\033[31m'; cG='\033[32m'; cY='\033[33m'; cB='\033[36m'; cN='\033[0m'

pass() { PASS=$((PASS+1)); printf "  ${cG}✓${cN} %s\n" "$1"; }
fail() { FAIL=$((FAIL+1)); printf "  ${cR}✗${cN} %s\n" "$1"; }
note() { printf "  ${cY}…${cN} %s\n" "$1"; }
section() { printf "\n${cB}=== %s ===${cN}\n" "$1"; }

api() { curl -s -H "Authorization: Bearer ${TOKEN}" "$@"; }

DAEMON_PID=

start_daemon() {
  local marker=$1
  : > "${DATA}/daemon.log"
  CFDM_HTTP_ADDR=":${PORT}" \
  CFDM_API_TOKEN="${TOKEN}" \
  CFDM_DATA_DIR="${DATA}" \
  CFDM_LOG_LEVEL=debug \
  "${BIN}" serve >>"${DATA}/daemon.log" 2>&1 &
  DAEMON_PID=$!
  for _ in $(seq 1 50); do
    sleep 0.1
    if curl -fsS -H "Authorization: Bearer ${TOKEN}" "${BASE}/api/v1/health" >/dev/null 2>&1; then
      note "daemon up (${marker}) pid=${DAEMON_PID}"
      return 0
    fi
  done
  echo "daemon failed to start (${marker})"
  cat "${DATA}/daemon.log"
  exit 1
}

stop_daemon() {
  if [ -n "${DAEMON_PID}" ] && kill -0 "${DAEMON_PID}" 2>/dev/null; then
    kill "${DAEMON_PID}" 2>/dev/null || true
    wait "${DAEMON_PID}" 2>/dev/null || true
  fi
  DAEMON_PID=
}

trap 'stop_daemon' EXIT

# -------- preflight: build the daemon --------
note "building daemon → ${BIN}"
mkdir -p "$(dirname "${BIN}")"
if ! go build -o "${BIN}" ./cmd/cfdmgrd; then
  echo "go build failed"; exit 1
fi

if curl -fsS "${BASE}/api/v1/health" -H "Authorization: Bearer ${TOKEN}" >/dev/null 2>&1; then
  echo "port ${PORT} already in use; aborting"
  exit 1
fi

rm -rf "${DATA}"
mkdir -p "${DATA}/profiles"

# Three fixtures (pure TunnelConfigV1 YAML, NO token → start attempt fails fast):
#   auto-on  : meta.manual unset    → AutoStart tries it
#   auto-off : meta.manual = true   → AutoStart skips it
#   default  : meta.manual unset    → AutoStart tries it
cat >"${DATA}/profiles/auto-on.yaml" <<'EOF'
edge:
  protocol: auto
logging:
  logLevel: info
EOF

cat >"${DATA}/profiles/auto-off.yaml" <<'EOF'
edge:
  protocol: auto
logging:
  logLevel: info
EOF

cat >"${DATA}/profiles/default.yaml" <<'EOF'
edge:
  protocol: auto
logging:
  logLevel: info
EOF

# Seed meta.json: manual flag drives skip; sort drives order; a stale legacy
# auto_start entry must be ignored entirely. meta.sort omits "default" to
# verify unknown ids fall back to the id-order tail.
cat >"${DATA}/meta.json" <<'EOF'
{
  "version": 1,
  "auto_start": ["should-be-ignored"],
  "sort": ["auto-off", "auto-on"],
  "names": { "auto-on": "auto-on case", "auto-off": "auto-off case", "default": "default case" },
  "manual": { "auto-off": true }
}
EOF

attempted()   { grep -q "msg=\"auto-start failed\" id=$1" "${LOG}"; }
started_ok()  { grep -q "msg=\"cloudflared instance started\" config_id=$1" "${LOG}"; }
mentions()    { grep -q "$1" "${LOG}"; }

# ============================================================
section "1) Cold boot: meta.manual drives AutoStart"
# ============================================================
start_daemon "boot1"
sleep 0.5
LOG="${DATA}/daemon.log"

if attempted auto-on; then pass "auto-on (manual unset) was AutoStart-attempted"; else fail "auto-on was NOT AutoStart-attempted"; fi
if attempted default; then pass "default (manual unset) was AutoStart-attempted"; else fail "default was NOT AutoStart-attempted"; fi
if attempted auto-off || started_ok auto-off; then
  fail "auto-off (manual=true) was AutoStarted (regression!)"
else
  pass "auto-off (manual=true) was skipped by AutoStart"
fi

# ============================================================
section "2) Legacy meta.auto_start is fully ignored"
# ============================================================
if mentions "should-be-ignored"; then
  fail "AutoStart still touches meta.auto_start (regression!)"
else
  pass "stale meta.auto_start entry 'should-be-ignored' had no effect"
fi

# ============================================================
section "3) Start/Stop no longer mutates meta.auto_start"
# ============================================================
api -X POST "${BASE}/api/v1/configs/auto-on/stop" >/dev/null
api -X POST "${BASE}/api/v1/configs/auto-on/start" >/dev/null
AUTO_START_AFTER=$(python -c "import json; d=json.load(open('${DATA}/meta.json')); print(','.join(d.get('auto_start') or []))" 2>/dev/null || echo "PYERR")
if [ "${AUTO_START_AFTER}" = "should-be-ignored" ]; then
  pass "meta.auto_start untouched by Start/Stop (still '${AUTO_START_AFTER}')"
else
  fail "meta.auto_start was mutated: '${AUTO_START_AFTER}' (expected 'should-be-ignored')"
fi

# ============================================================
section "4) Unknown config field still rejected (DisallowUnknownFields)"
# ============================================================
CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  -X PUT "${BASE}/api/v1/configs/auto-on" \
  -H "Content-Type: application/json" -H "Authorization: Bearer ${TOKEN}" \
  -d '{"config":{"edge":{"protocol":"auto"},"bogusField":true},"cfdmgr":{"name":"x","manualStart":false}}')
if [ "${CODE}" = "400" ]; then pass "PUT unknown field → 400"; else fail "PUT unknown field → ${CODE} (expected 400)"; fi

CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  -X PUT "${BASE}/api/v1/configs/auto-on" \
  -H "Content-Type: application/json" -H "Authorization: Bearer ${TOKEN}" \
  -d '{"config":{"edge":{"protocol":"http2"}},"cfdmgr":{"name":"x","manualStart":false}}')
if [ "${CODE}" = "200" ]; then pass "PUT valid nested config → 200"; else fail "PUT valid config → ${CODE} (expected 200)"; fi

# ============================================================
section "5) PUT manualStart=true persists into meta.json (not the profile)"
# ============================================================
api -X PUT "${BASE}/api/v1/configs/auto-on" \
  -H "Content-Type: application/json" \
  -d '{"config":{"edge":{"protocol":"auto"}},"cfdmgr":{"name":"flipped","manualStart":true}}' >/dev/null

MANUAL_ON=$(python -c "import json; d=json.load(open('${DATA}/meta.json')); print(d.get('manual',{}).get('auto-on'))" 2>/dev/null || echo PYERR)
if [ "${MANUAL_ON}" = "True" ]; then
  pass "meta.json manual[auto-on]=true after PUT"
else
  fail "meta.json did not persist manual[auto-on]=true (got '${MANUAL_ON}')"
fi
if grep -qi 'manualStart' "${DATA}/profiles/auto-on.yaml"; then
  fail "manualStart leaked into the profile YAML (should be meta.json only)"
else
  pass "profile YAML stays pure TunnelConfigV1 (no manualStart)"
fi

# Flip auto-off back to manual=false for the restart phase.
api -X PUT "${BASE}/api/v1/configs/auto-off" \
  -H "Content-Type: application/json" \
  -d '{"config":{"edge":{"protocol":"auto"}},"cfdmgr":{"name":"flipped-off","manualStart":false}}' >/dev/null

stop_daemon
sleep 0.3

# ============================================================
section "6) Restart honours the flipped flags"
# ============================================================
start_daemon "boot2"
sleep 0.5
LOG="${DATA}/daemon.log"

if attempted auto-on || started_ok auto-on; then
  fail "auto-on (now manual=true) was AutoStarted (flag flip not respected)"
else
  pass "auto-on (now manual=true) skipped on boot"
fi
if attempted auto-off; then pass "auto-off (now manual=false) was AutoStart-attempted"; else fail "auto-off was NOT AutoStart-attempted"; fi
if attempted default; then pass "default still AutoStart-attempted (no regression)"; else fail "default NOT AutoStart-attempted (regression!)"; fi

# ============================================================
section "7) AutoStart ordering follows meta.sort (auto-off before default)"
# ============================================================
# meta.sort = ["auto-off","auto-on"]; auto-on is skipped (manual=true), so the
# attempt order should be: auto-off (idx 0), then default (unknown → tail).
FIRST=$(grep 'msg="auto-start failed"' "${LOG}" | head -1 | sed -n 's/.*id=\([a-zA-Z0-9_-]*\).*/\1/p')
SECOND=$(grep 'msg="auto-start failed"' "${LOG}" | sed -n '2p' | sed -n 's/.*id=\([a-zA-Z0-9_-]*\).*/\1/p')
if [ "${FIRST}" = "auto-off" ]; then pass "first attempt was 'auto-off' (sort idx 0)"; else fail "first attempt was '${FIRST}' (expected auto-off)"; fi
if [ "${SECOND}" = "default" ]; then pass "second attempt was 'default' (unknown id, tail)"; else fail "second attempt was '${SECOND}' (expected default)"; fi

# ============================================================
section "8) No stale frp/auto_start symbols in production code"
# ============================================================
HITS=$(grep -RIn --include="*.go" 'markAutoStart\|setAutoStart' internal/ 2>/dev/null || true)
if [ -z "${HITS}" ]; then
  pass "no internal/ Go file references markAutoStart/setAutoStart"
else
  fail "dead-code references remain:"; printf '      %s\n' "${HITS}"
fi

stop_daemon

# ============================================================
section "Summary"
# ============================================================
printf "  ${cG}PASS=%d${cN}  ${cR}FAIL=%d${cN}\n" "${PASS}" "${FAIL}"
if [ "${FAIL}" -gt 0 ]; then
  echo; echo "Last daemon log (tail):"; tail -40 "${DATA}/daemon.log" | sed 's/^/    /'; exit 1
fi
echo; echo "  Data dir: ${DATA}  (kept for inspection; delete manually if needed)"
exit 0

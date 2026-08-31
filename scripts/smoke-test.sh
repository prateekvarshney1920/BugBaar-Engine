#!/usr/bin/env bash
# End-to-end smoke test against a running engine.
#
# Usage: BASE_URL=http://localhost:4000 API_KEY=dev-local-key scripts/smoke-test.sh
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:4000}"
API_KEY="${API_KEY:-dev-local-key}"
AGENT_ID="smoke-$$"

auth=(-H "content-type: application/json" -H "x-api-key: ${API_KEY}")
pass=0

check() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    printf '  ok   %-42s (%s)\n' "$label" "$actual"
    pass=$((pass + 1))
  else
    printf '  FAIL %-42s expected %s, got %s\n' "$label" "$expected" "$actual"
    exit 1
  fi
}

status() {
  curl -s -o /dev/null -w '%{http_code}' "$@"
}

echo "Smoke testing ${BASE_URL}"

check "health" 200 "$(status "${BASE_URL}/health")"
check "liveness" 200 "$(status "${BASE_URL}/health/live")"
check "auth required" 401 "$(status -X POST "${BASE_URL}/v1/agents" -H 'content-type: application/json' -d '{"id":"nope"}')"

check "create agent" 201 "$(status -X POST "${BASE_URL}/v1/agents" "${auth[@]}" \
  -d "{\"id\":\"${AGENT_ID}\",\"tools\":[\"calculator\"]}")"
check "duplicate rejected" 409 "$(status -X POST "${BASE_URL}/v1/agents" "${auth[@]}" \
  -d "{\"id\":\"${AGENT_ID}\"}")"
check "unknown tool rejected" 400 "$(status -X POST "${BASE_URL}/v1/agents" "${auth[@]}" \
  -d '{"id":"bad-tools","tools":["does-not-exist"]}')"
check "run agent" 200 "$(status -X POST "${BASE_URL}/v1/agents/${AGENT_ID}/run" "${auth[@]}" \
  -d '{"input":"hello"}')"
check "empty input rejected" 400 "$(status -X POST "${BASE_URL}/v1/agents/${AGENT_ID}/run" "${auth[@]}" \
  -d '{"input":""}')"

check "ingest documents" 201 "$(status -X POST "${BASE_URL}/v1/knowledge/documents" "${auth[@]}" \
  -d '{"documents":[{"id":"smoke-doc","text":"Qdrant stores vector embeddings for semantic search."}]}')"
check "search knowledge" 200 "$(status -X POST "${BASE_URL}/v1/knowledge/search" "${auth[@]}" \
  -d '{"query":"vector embeddings","topK":3}')"
check "run workflow" 200 "$(status -X POST "${BASE_URL}/v1/workflows/ingest-and-summarise/run" "${auth[@]}" \
  -d '{"input":{"id":"smoke-wf","text":"BugBaar Engine is open-source AI infrastructure."}}')"
check "unknown workflow" 404 "$(status -X POST "${BASE_URL}/v1/workflows/nope/run" "${auth[@]}" -d '{}')"

check "enqueue workflow" 202 "$(status -X POST "${BASE_URL}/v1/workflows/ingest-and-summarise/enqueue" "${auth[@]}"   -d '{"input":{"id":"smoke-queued","text":"Queued execution."}}')"
check "list schedules" 200 "$(status "${BASE_URL}/v1/schedules" "${auth[@]}")"
check "create schedule" 201 "$(status -X POST "${BASE_URL}/v1/schedules" "${auth[@]}"   -d "{\"id\":\"smoke-${AGENT_ID}\",\"workflow\":\"ingest-and-summarise\",\"every\":3600000,\"input\":{\"text\":\"x\"}}")"
check "schedule needs every or cron" 400 "$(status -X POST "${BASE_URL}/v1/schedules" "${auth[@]}"   -d '{"id":"no-interval","workflow":"ingest-and-summarise"}')"
check "cancel schedule" 204 "$(status -X DELETE "${BASE_URL}/v1/schedules/smoke-${AGENT_ID}" "${auth[@]}")"
check "cancel unknown schedule" 404 "$(status -X DELETE "${BASE_URL}/v1/schedules/never-existed" "${auth[@]}")"

check "delete document" 204 "$(status -X DELETE "${BASE_URL}/v1/knowledge/documents/smoke-doc" "${auth[@]}")"
check "delete agent" 204 "$(status -X DELETE "${BASE_URL}/v1/agents/${AGENT_ID}" "${auth[@]}")"
check "deleted agent gone" 404 "$(status "${BASE_URL}/v1/agents/${AGENT_ID}" "${auth[@]}")"

echo ""
echo "${pass} checks passed."

#!/usr/bin/env bash
# End-to-end test against a running `docker compose up` stack.
# Requires: curl, ffprobe, node + playwright (chromium).
set -euo pipefail
cd "$(dirname "$0")"

BASE=https://localhost:8443
JAR=$(mktemp)
fail() { echo "FAIL: $*" >&2; exit 1; }
json() { curl -sk -b "$JAR" -c "$JAR" -H 'Content-Type: application/json' "$@"; }

echo "--- waiting for app"
for _ in $(seq 1 60); do curl -skf "$BASE/api/state" >/dev/null && break; sleep 1; done
curl -skf "$BASE/api/state" | grep -q '"setupDone":false' || fail "fresh install should need setup"

echo "--- first-run setup"
curl -sk -o /dev/null -w '%{redirect_url}\n' "$BASE/" | grep -q '/setup' || fail "/ should redirect to /setup"
json -f -d '{"username":"admin","password":"adminpass123"}' "$BASE/api/setup" >/dev/null
code=$(json -o /dev/null -w '%{http_code}' -d '{"username":"x","password":"xxxxxxxxxx"}' "$BASE/api/setup")
[ "$code" = 409 ] || fail "second setup should be rejected, got $code"

echo "--- admin creates a stream"
json -f -d '{"name":"cam1","password":"campass123"}' "$BASE/api/streams" | tee /dev/stderr | grep -q 'rtsp://cam1:campass123@' || fail "create stream"
code=$(json -o /dev/null -w '%{http_code}' -d '{"name":"bad name","password":"campass123"}' "$BASE/api/streams")
[ "$code" = 400 ] || fail "invalid stream name should be rejected, got $code"
code=$(curl -sk -o /dev/null -w '%{http_code}' "$BASE/api/streams")
[ "$code" = 401 ] || fail "stream list must require admin, got $code"

echo "--- RTSP authentication"
rtsp() { curl -s -o /dev/null -w '%{response_code}' -X DESCRIBE "$@" || true; }
code=$(rtsp rtsp://localhost:8554/cam1);                           [ "$code" = 401 ] || fail "RTSP without credentials: $code"
code=$(rtsp -u cam1:wrongpass rtsp://localhost:8554/cam1);         [ "$code" = 401 ] || fail "RTSP wrong password: $code"
code=$(rtsp -u cam1:campass123 rtsp://localhost:8554/cam1);        [ "$code" = 404 ] || fail "RTSP valid credentials, no camera yet should be 404: $code"

echo "--- browser camera -> WHIP -> RTSP"
node e2e.js

echo "ALL TESTS PASSED"

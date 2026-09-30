#!/usr/bin/env bash
# parity 데모: 이미지 빌드 → 컨테이너 실행 → 기록 → 노이즈 탐지 → test → 요약
#   bash scripts/demo.sh
# 주의: 이름이 guestbook 인 컨테이너를 지우고 다시 만든다.
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE=guestbook:1
CONTAINER=guestbook
PORT=8080
PROXY=127.0.0.1:8081
TARGET="http://localhost:$PORT"
RECORD=records/session.jsonl
export PYTHONIOENCODING=utf-8

if [ -z "${PYTHON:-}" ]; then
  for candidate in python3 python; do
    if "$candidate" -c 'import sys; sys.exit(sys.version_info < (3, 9))' >/dev/null 2>&1; then
      PYTHON=$candidate
      break
    fi
  done
fi
: "${PYTHON:?Python 3.9 이상을 찾지 못했습니다 (PYTHON=경로 로 지정하세요)}"

echo "== [1/5] 이미지 빌드 · 컨테이너 실행 ($IMAGE → $CONTAINER, :$PORT)"
docker build -q -t "$IMAGE" ../sample-app >/dev/null
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" -p "$PORT:8080" "$IMAGE" >/dev/null

echo "== [2/5] 프록시($PROXY)로 기록하면서 simulate_usage.py 실행"
"$PYTHON" -m parity record --target "$TARGET" --listen "$PROXY" --out "$RECORD" \
  -- "$PYTHON" scripts/simulate_usage.py --base "http://$PROXY"

echo "== [3/5] 노이즈 탐지"
"$PYTHON" -m parity noise --record "$RECORD" --target "$TARGET" --container "$CONTAINER"

echo "== [4/5] test 실행 → result.json"
status=0
"$PYTHON" -m parity test --record "$RECORD" --target "$TARGET" --container "$CONTAINER" \
  --conditions none,restart --out result.json >/dev/null || status=$?
if [ "$status" -ge 2 ]; then
  echo "test 실행 오류 (exit $status)" >&2
  exit "$status"
fi

echo "== [5/5] 결과 요약"
"$PYTHON" -m parity summary result.json

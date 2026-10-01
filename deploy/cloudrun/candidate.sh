#!/usr/bin/env bash
# 새 버전을 트래픽 0%로 올리고 후보 전용 주소를 JSON 한 줄로 출력한다
# 사용: candidate.sh <저장소@sha256:digest> [revision-suffix] [run_id]
#   run_id를 주면 revision에 HIB_RUN_ID, HIB_DIGEST 환경변수를 넣고 이름에 run_id 해시 6자를 붙인다
#   (Cloud Run은 멀티 아키텍처 인덱스 digest를 amd64 digest로 바꿔 기록하므로 인덱스 digest를 따로 남긴다)
set -euo pipefail
: "${PROJECT_ID:?PROJECT_ID 필요}" "${REGION:?REGION 필요}"
SERVICE="${SERVICE:-hello}"; TAG="${TAG:-cand}"; PORT="${PORT:-8080}"
IMAGE_REF="${1:?이미지 주소(저장소@sha256:...) 필요}"
RUN_ID="${3:-}"
DIGEST="${IMAGE_REF##*@sha256:}"
ENVS=()
if [ -n "$RUN_ID" ]; then
  RH=$(printf '%s' "$RUN_ID" | sha256sum | cut -c1-6)
  SUFFIX="${2:-d${DIGEST:0:12}-${RH}}"
  ENVS=(--update-env-vars="HIB_RUN_ID=${RUN_ID},HIB_DIGEST=sha256:${DIGEST}")
else
  SUFFIX="${2:-d${DIGEST:0:12}}"
fi
REV="${SERVICE}-${SUFFIX}"
G=(--project="$PROJECT_ID" --region="$REGION" --quiet)

if gcloud run revisions describe "$REV" "${G[@]}" >/dev/null 2>&1; then
  # 같은 이름의 revision이 이미 있음(같은 실행을 다시 시도): 새로 배포하지 않고 후보 태그만 붙인다
  gcloud run services update-traffic "$SERVICE" "${G[@]}" --update-tags="$TAG=$REV" >&2
else
  gcloud run deploy "$SERVICE" "${G[@]}" --image="$IMAGE_REF" --port="$PORT" \
    --no-traffic --tag="$TAG" --revision-suffix="$SUFFIX" --binary-authorization=default \
    ${ENVS[@]+"${ENVS[@]}"} >&2
fi

URL=$(gcloud run services describe "$SERVICE" "${G[@]}" --format=json \
  | jq -r --arg t "$TAG" '.status.traffic[] | select(.tag==$t) | .url')

jq -cn --arg rev "$REV" --arg img "$IMAGE_REF" --arg url "$URL" --arg run "$RUN_ID" \
  '{target:"cloud_run", phase:"candidate", result:"ok", revision:$rev, image:$img, candidate_url:$url, run_id:$run}'

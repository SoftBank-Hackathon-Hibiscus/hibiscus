#!/usr/bin/env bash
# 새 버전을 트래픽 0%로 올리고 후보 전용 주소를 JSON 한 줄로 출력한다
# 사용: candidate.sh <저장소@sha256:digest> [revision-suffix]
set -euo pipefail
: "${PROJECT_ID:?PROJECT_ID 필요}" "${REGION:?REGION 필요}"
SERVICE="${SERVICE:-hello}"; TAG="${TAG:-cand}"; PORT="${PORT:-8080}"
IMAGE_REF="${1:?이미지 주소(저장소@sha256:...) 필요}"
DIGEST="${IMAGE_REF##*@sha256:}"
SUFFIX="${2:-d${DIGEST:0:12}}"
REV="${SERVICE}-${SUFFIX}"
G=(--project="$PROJECT_ID" --region="$REGION" --quiet)

if gcloud run revisions describe "$REV" "${G[@]}" >/dev/null 2>&1; then
  # 같은 digest를 다시 올리는 경우: 새로 배포하지 않고 기존 revision에 후보 태그만 붙인다
  gcloud run services update-traffic "$SERVICE" "${G[@]}" --update-tags="$TAG=$REV" >&2
else
  gcloud run deploy "$SERVICE" "${G[@]}" --image="$IMAGE_REF" --port="$PORT" \
    --no-traffic --tag="$TAG" --revision-suffix="$SUFFIX" --binary-authorization=default >&2
fi

URL=$(gcloud run services describe "$SERVICE" "${G[@]}" --format=json \
  | jq -r --arg t "$TAG" '.status.traffic[] | select(.tag==$t) | .url')

jq -cn --arg rev "$REV" --arg img "$IMAGE_REF" --arg url "$URL" \
  '{target:"cloud_run", phase:"candidate", result:"ok", revision:$rev, image:$img, candidate_url:$url}'

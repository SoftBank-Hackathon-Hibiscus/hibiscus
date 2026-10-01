#!/usr/bin/env bash
# 후보 태그가 붙은 revision으로 트래픽 100% 전환. 전환 전 revision을 JSON으로 출력(롤백용)
set -euo pipefail
: "${PROJECT_ID:?PROJECT_ID 필요}" "${REGION:?REGION 필요}"
SERVICE="${SERVICE:-hello}"; TAG="${TAG:-cand}"
G=(--project="$PROJECT_ID" --region="$REGION" --quiet)

STATUS=$(gcloud run services describe "$SERVICE" "${G[@]}" --format=json)
PREV=$(jq -r '[.status.traffic[] | select(.percent==100)][0].revisionName // ""' <<<"$STATUS")
NEXT=$(jq -r --arg t "$TAG" '[.status.traffic[] | select(.tag==$t)][0].revisionName // ""' <<<"$STATUS")
[ -n "$NEXT" ] || { echo "후보 태그($TAG)가 붙은 revision이 없음" >&2; exit 1; }

gcloud run services update-traffic "$SERVICE" "${G[@]}" --to-tags="$TAG=100" >&2

jq -cn --arg p "$PREV" --arg n "$NEXT" \
  '{target:"cloud_run", phase:"activate", result:"ok", previous:$p, serving:$n}'

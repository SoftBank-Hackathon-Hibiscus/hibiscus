#!/usr/bin/env bash
# 전환 전 검사 실패: 트래픽은 그대로 두고 후보 태그만 뗀다
set -euo pipefail
: "${PROJECT_ID:?PROJECT_ID 필요}" "${REGION:?REGION 필요}"
SERVICE="${SERVICE:-hello}"; TAG="${TAG:-cand}"
G=(--project="$PROJECT_ID" --region="$REGION" --quiet)

gcloud run services update-traffic "$SERVICE" "${G[@]}" --remove-tags="$TAG" >&2 || true

jq -cn '{target:"cloud_run", phase:"discard", result:"ok"}'
